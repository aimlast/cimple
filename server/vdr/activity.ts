/**
 * Data-room views and the activity log (vdr spec §8 tables 7–8, §9.3, §9.7).
 *
 *  - A view is one opening of a document. Its id is SERVER-issued
 *    (POST …/views/start) and its trace — the 6 characters burned into every
 *    page — is the first 30 bits of HMAC-SHA256(SESSION_SECRET, viewId) in
 *    base32, so a client can neither choose nor forge it. A leaked page's
 *    trace finds the view (and so the reader) in Activity.
 *  - Beats (POST …/views) merge with GREATEST and are clamped: active time
 *    can't exceed the wall time since the view started (+20 s), a page's
 *    time can't exceed the view's active time, ≤ 2,000 page keys; only the
 *    view's own reader (link + team member) and item may write it.
 *  - The activity log is insert-only; buyer lines carry a keyed hash of the
 *    network address, never the address.
 */
import { createHmac, randomUUID } from "crypto";
import { VDR_LIMITS, VDR_VIEW_SOURCES, deviceClassFor, type VdrAction, type VdrViewSource } from "@shared/vdr";
import type { InsertVdrActivity, VdrView } from "@shared/schema";
import { networkKey } from "../analytics/reading-ingest";
import { logVdrQuietly, type VdrStore } from "./store";
import type { VdrGate } from "./access";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function traceKey(): string {
  return process.env.SESSION_SECRET || "dev-session-secret-change-me";
}

/** The 6-character trace of a view (30 bits of a keyed hash, base32). Stable for a view, different across views. */
export function traceFor(viewId: string, key: string = traceKey()): string {
  const h = createHmac("sha256", key).update(`vdr-trace:${viewId}`).digest();
  // First 30 bits → 6 base32 characters.
  const bits = ((h[0] << 22) | (h[1] << 14) | (h[2] << 6) | (h[3] >> 2)) >>> 0;
  let out = "";
  for (let i = 5; i >= 0; i--) out += B32[(bits >>> (i * 5)) & 31];
  return out;
}

export function isTrace(v: unknown): v is string {
  return typeof v === "string" && /^[A-Z2-7]{6}$/.test(v.trim().toUpperCase());
}

export function viewSourceOf(v: unknown): VdrViewSource {
  return (VDR_VIEW_SOURCES as readonly string[]).includes(String(v)) ? (v as VdrViewSource) : "room";
}

/** Starts a view for a reader and item (the item was already checked visible). */
export async function startView(
  store: VdrStore,
  gate: VdrGate,
  item: { id: string; documentId: string | null; fileVersion: number },
  i: { source?: unknown; width?: unknown; preview?: boolean; ipHash?: string | null },
  now: Date = new Date(),
): Promise<{ viewId: string; trace: string; view: VdrView }> {
  const source = i.preview ? "preview" : viewSourceOf(i.source);
  // The id is made here (server-side) so its trace is stored with the row.
  const id = randomUUID();
  const trace = traceFor(id);
  const view = await store.insertView({
    id,
    dealId: gate.deal.id,
    buyerAccessId: gate.access.id,
    buyerEmail: gate.reader.buyerEmail,
    teamMemberId: gate.viewer.teamMemberId,
    itemId: item.id,
    documentId: item.documentId,
    fileVersion: item.fileVersion ?? 1,
    trace,
    source,
    startedAt: now,
    lastSeenAt: now,
    deviceClass: deviceClassFor(Number(i.width)),
  });
  if (!i.preview) {
    await logVdrQuietly(store, {
      dealId: gate.deal.id,
      action: "buyer_opened_item",
      actorKind: gate.viewer.kind === "team" ? "team" : "buyer",
      actorId: gate.viewer.teamMemberId ?? gate.access.id,
      itemId: item.id,
      buyerEmail: gate.reader.buyerEmail,
      detail: { source, viewId: view.id },
      ipHash: i.ipHash ?? null,
    });
  }
  return { viewId: view.id, trace, view };
}

export type ViewBeat = { viewId: string; activeMs: number; pageMs: Record<string, number>; maxPage: number | null };

/** Validates a beat body (from JSON or a text/plain beacon). Null when malformed. */
export function parseBeat(raw: unknown): ViewBeat | null {
  let body = raw;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return null; }
  }
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.viewId !== "string" || !/^[0-9a-f-]{36}$/i.test(b.viewId)) return null;
  const activeMs = Number(b.activeMs);
  if (!Number.isFinite(activeMs) || activeMs < 0) return null;
  const pageMs: Record<string, number> = {};
  if (b.pageMs && typeof b.pageMs === "object") {
    const entries = Object.entries(b.pageMs as Record<string, unknown>);
    if (entries.length > VDR_LIMITS.pageMsKeys) return null;
    for (const [k, v] of entries) {
      if (!/^(\d{1,4}|s:\d{1,3}(:\d{1,7})?)$/.test(k)) continue;
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) pageMs[k] = Math.floor(n);
    }
  }
  const maxPage = b.maxPage == null ? null : Number(b.maxPage);
  return { viewId: b.viewId, activeMs: Math.floor(activeMs), pageMs, maxPage: maxPage != null && Number.isInteger(maxPage) && maxPage > 0 && maxPage < 100_000 ? maxPage : null };
}

/** Clamps a beat to what is physically possible for this view. */
export function clampBeat(view: Pick<VdrView, "startedAt">, beat: ViewBeat, now: Date): ViewBeat {
  const wall = Math.max(0, now.getTime() - new Date(view.startedAt).getTime() + 20_000);
  const activeMs = Math.min(beat.activeMs, wall);
  const pageMs: Record<string, number> = {};
  for (const [k, v] of Object.entries(beat.pageMs)) pageMs[k] = Math.min(v, activeMs);
  return { ...beat, activeMs, pageMs };
}

/**
 * Records a beat. The view must be this reader's (link AND team member) and,
 * when given, this item's — else null (→ 404).
 */
export async function recordView(store: VdrStore, gate: VdrGate, beat: ViewBeat, now: Date = new Date()): Promise<VdrView | null> {
  const view = await store.getView(beat.viewId);
  if (!view || view.dealId !== gate.deal.id || view.buyerAccessId !== gate.access.id || (view.teamMemberId ?? null) !== (gate.viewer.teamMemberId ?? null)) return null;
  const c = clampBeat(view, beat, now);
  return store.mergeView(view.id, { activeMs: c.activeMs, pageMs: c.pageMs, maxPage: c.maxPage, lastSeenAt: now });
}

/** The view a page request names (`?v=`): this reader's, this item's. */
export async function viewForPage(store: VdrStore, gate: VdrGate, viewId: unknown, itemId: string): Promise<VdrView | null> {
  if (typeof viewId !== "string" || !/^[0-9a-f-]{36}$/i.test(viewId)) return null;
  const view = await store.getView(viewId);
  if (!view || view.dealId !== gate.deal.id || view.itemId !== itemId || view.buyerAccessId !== gate.access.id || (view.teamMemberId ?? null) !== (gate.viewer.teamMemberId ?? null)) return null;
  return view;
}

// ── Throttled log lines ───────────────────────────────────────────────────

const deniedAt = new Map<string, number>();
/** `buyer_denied` at most once per (reader, item) per hour. */
export async function logDenied(store: VdrStore, gate: VdrGate, itemId: string, ipHash: string | null): Promise<void> {
  const key = `${gate.deal.id}|${gate.reader.buyerEmail}|${gate.viewer.teamMemberId ?? ""}|${itemId}`;
  const now = Date.now();
  if ((deniedAt.get(key) ?? 0) > now - 60 * 60_000) return;
  deniedAt.set(key, now);
  if (deniedAt.size > 20_000) deniedAt.clear();
  await logVdrQuietly(store, { dealId: gate.deal.id, action: "buyer_denied", actorKind: gate.viewer.kind === "team" ? "team" : "buyer", actorId: gate.viewer.teamMemberId ?? gate.access.id, itemId: /^[0-9a-f-]{36}$/i.test(itemId) ? itemId : null, buyerEmail: gate.reader.buyerEmail, ipHash });
}

export function buyerLog(gate: VdrGate, action: VdrAction, extra: Partial<InsertVdrActivity> = {}): InsertVdrActivity {
  return { dealId: gate.deal.id, action, actorKind: gate.viewer.kind === "team" ? "team" : "buyer", actorId: gate.viewer.teamMemberId ?? gate.access.id, buyerEmail: gate.reader.buyerEmail, ...extra };
}

export function ipHashFor(dealId: string, req: { ip?: string; socket?: { remoteAddress?: string | null } }): string | null {
  return networkKey(dealId, req.ip || req.socket?.remoteAddress || null);
}
