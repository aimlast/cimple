/**
 * Reading ingest — stores what the view room's tracker sends
 * (POST /api/view/:token/reading, shared/analytics-v2.ts ReadingPayload),
 * and what the demo seeder writes (it goes through the same code, so its
 * data passes the same checks as real traffic).
 *
 *   planIngest   pure: validation, the clamp and the merge (tested offline)
 *   ingestReading  runs one send in one transaction against a ReadingStore
 *   dbReadingStore / memoryReadingStore   Postgres / in-memory (tests)
 *
 * Rules (final spec §6.1):
 *   - the rendition must be this deal's and match this buyer's version
 *     (mode + teaser/full); every page id must be one of its pages → 400;
 *   - a visit id already stored under another buyer link → 409;
 *   - counters are cumulative and merged with GREATEST, so a resend, a
 *     beacon racing a fetch or a late packet can never double count;
 *   - the CLAMP: a visit can't have more active time than the server has
 *     seen elapse since it started (+20 s slack), and its parts can't hold
 *     more reading time than its active time — anything more is scaled
 *     down and the visit is marked `clamped`;
 *   - the owning broker previewing the room is stored as a self view and
 *     excluded everywhere; it never counts as a view;
 *   - a new visit with no other visit on this link in the last 30 minutes
 *     is one more view (buyer_access.view_count) — the GET no longer counts
 *     views (it still stamps firstViewedAt, which the reminders need even
 *     when a blocker stops the tracker);
 *   - no raw IP or user agent is stored: a keyed hash of the network
 *     (per deal) and a browser family ("Chrome/Mac").
 */
import { createHash, createHmac } from "crypto";
import { sql } from "drizzle-orm";
import {
  READING_RULES,
  deviceClassOf,
  splitBlockId,
  type BlockCounters,
  type CimMode,
  type ReadingPayload,
  type RenditionPage,
} from "@shared/analytics-v2";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { variantForAccessLevel } from "./renditions";
import { viewStampFor } from "../buyers/view-access";
import type { BuyerAccess } from "@shared/schema";

// ── Rows ──────────────────────────────────────────────────────────────────

export interface RenditionRef {
  id: string;
  dealId: string;
  mode: string;
  variant: string;
  createdAt: Date;
  pageIndex: RenditionPage[];
}

export interface VisitClockRow {
  wallMs: number; activeMs: number; idleMs: number; hiddenMs: number; awayMs: number; outsideMs: number;
}

export interface VisitRow extends VisitClockRow {
  id: string;
  dealId: string;
  buyerAccessId: string;
  renditionId: string | null;
  startedAt: Date;
  lastSeenAt: Date;
  maxPageIndex: number | null;
  path: Array<[number, string]>;
  selfView: boolean;
  clamped: boolean;
}

export interface VisitWrite extends VisitRow {
  mode: CimMode;
  accessLevel: string;
  deviceClass: string;
  viewportW: number;
  viewportH: number;
  uaFamily: string | null;
  ipHash: string | null;
}

export interface RollupRow {
  pageId: string;
  blockKey: string;
  attentionMs: number;
  skimMs: number;
  visibleMs: number;
  pointerMs: number;
}

export interface RollupWrite extends RollupRow {
  visitId: string;
  dealId: string;
  buyerAccessId: string;
  renditionId: string;
  lineageId: string;
  at: Date;
}

export interface EventWrite {
  dealId: string;
  buyerAccessId: string;
  visitId: string;
  renditionId: string;
  pageId: string;
  blockKey: string | null;
  clientSeq: number;
  eventType: string;
  detail: string | null;
  clientAt: string;
  at: Date;
}

export interface IngestInput {
  deal: { id: string };
  access: { id: string; dealId: string; accessLevel: string };
  payload: ReadingPayload;
  now: Date;
  /** The owning broker previewing the room. */
  selfView: boolean;
  ipHash: string | null;
  uaFamily: string | null;
}

export type IngestPlan =
  | { ok: false; status: 400 | 409; reason: string }
  | {
      ok: true;
      newVisit: boolean;
      clamped: boolean;
      visit: VisitWrite;
      rollups: RollupWrite[];
      /** Rows must be written as given (a clamp scaled stored rows down), not GREATEST-merged. */
      exactRollups: boolean;
      events: EventWrite[];
    };

const EVENT_DETAIL_RE = /^(?:[a-z_]{1,20}(?::[A-Za-z0-9_-]{1,64})?|\d{1,7})$/;

// ── The plan (pure) ─────────────────────────────────────────────────────

export function planIngest(
  input: IngestInput,
  rendition: RenditionRef | null,
  existing: VisitRow | null,
  existingRollups: ReadonlyArray<RollupRow>,
): IngestPlan {
  const { payload: p, access, deal, now } = input;
  const fail = (status: 400 | 409, reason: string): IngestPlan => ({ ok: false, status, reason });

  if (!rendition || rendition.dealId !== deal.id) return fail(400, "unknown rendition");
  const mode = cimModeForAccessLevel(access.accessLevel) as CimMode;
  if (rendition.mode !== mode || rendition.variant !== variantForAccessLevel(access.accessLevel)) return fail(400, "rendition does not match this buyer's version");
  if (existing && existing.buyerAccessId !== access.id) return fail(409, "visit belongs to another link");
  if (existing && existing.renditionId && existing.renditionId !== rendition.id) return fail(400, "visit is on another rendition");

  const pages = new Map(rendition.pageIndex.map((pg) => [pg.pageId, pg]));
  const blockEntries = Object.entries(p.blocks).map(([id, v]) => [splitBlockId(id), v] as [[string, string], BlockCounters]);
  for (const [[pageId]] of blockEntries) if (!pages.has(pageId)) return fail(400, "unknown page");
  for (const [, pageId] of p.path.entries) if (!pages.has(pageId)) return fail(400, "unknown page");
  for (const e of p.events) if (!pages.has(e.pageId)) return fail(400, "unknown page");

  // ── Clamp against the server's own clock ──
  const slack = READING_RULES.clampSlackMs;
  const nowMs = now.getTime();
  // The visit can't have started before this version was first served (a seeder writing the past skips the floor).
  const floor = rendition.createdAt.getTime() <= nowMs ? rendition.createdAt.getTime() : -Infinity;
  const startedAt = existing?.startedAt ?? new Date(Math.max(nowMs - Math.min(p.visit.wallMs, READING_RULES.visitMaxMs), floor));
  const limit = Math.max(0, Math.min(nowMs - startedAt.getTime() + slack, READING_RULES.visitMaxMs + slack));
  let clamped = false;
  const cap = (n: number) => {
    if (n > limit) { clamped = true; return limit; }
    return n;
  };
  const clocks: VisitClockRow = {
    wallMs: cap(p.visit.wallMs), activeMs: p.visit.activeMs, idleMs: cap(p.visit.idleMs),
    hiddenMs: cap(p.visit.hiddenMs), awayMs: cap(p.visit.awayMs), outsideMs: cap(p.visit.outsideMs),
  };
  let activeScale = 1;
  if (clocks.activeMs > limit) {
    activeScale = limit / clocks.activeMs;
    clocks.activeMs = limit;
    clamped = true;
  }
  if (clocks.outsideMs > clocks.activeMs) clocks.outsideMs = clocks.activeMs;

  // ── Merge (GREATEST) ──
  const key = (pageId: string, blockKey: string) => `${pageId}|${blockKey}`;
  const merged = new Map<string, RollupRow>();
  for (const r of existingRollups) merged.set(key(r.pageId, r.blockKey), { ...r });
  const touched = new Set<string>();
  for (const [[pageId, blockKey], v] of blockEntries) {
    const k = key(pageId, blockKey);
    const inc = {
      attentionMs: Math.floor(v[0] * activeScale), skimMs: Math.floor(v[1] * activeScale),
      visibleMs: Math.min(v[2], limit), pointerMs: Math.min(v[3], limit),
    };
    if (v[2] > limit || v[3] > limit) clamped = true;
    const prev = merged.get(k);
    if (!prev && !inc.attentionMs && !inc.skimMs && !inc.visibleMs && !inc.pointerMs) continue;
    merged.set(k, {
      pageId, blockKey,
      attentionMs: Math.max(prev?.attentionMs ?? 0, inc.attentionMs),
      skimMs: Math.max(prev?.skimMs ?? 0, inc.skimMs),
      visibleMs: Math.max(prev?.visibleMs ?? 0, inc.visibleMs),
      pointerMs: Math.max(prev?.pointerMs ?? 0, inc.pointerMs),
    });
    touched.add(k);
  }
  const mergedActive = Math.max(existing?.activeMs ?? 0, clocks.activeMs);
  let credited = 0;
  merged.forEach((r) => { credited += r.attentionMs + r.skimMs; });
  let exact = false;
  if (credited > mergedActive + slack) {
    // More reading time than active time: scale every part of the visit down.
    const f = mergedActive / credited;
    merged.forEach((r) => { r.attentionMs = Math.floor(r.attentionMs * f); r.skimMs = Math.floor(r.skimMs * f); });
    clamped = true;
    exact = true;
  }

  // ── Path (appended by absolute index) ──
  const path: Array<[number, string]> = (existing?.path ?? []).map(([t, pg]) => [t, pg]);
  p.path.entries.forEach((entry, k) => {
    const idx = p.path.from + k;
    if (idx < path.length) path[idx] = [entry[0], entry[1]];
    else path.push([entry[0], entry[1]]);
  });
  path.length = Math.min(path.length, READING_RULES.maxPathEntries);

  const maxPage = Math.max(existing?.maxPageIndex ?? -1, Math.min(p.visit.maxPageIndex, rendition.pageIndex.length - 1));
  const g = (a: number | undefined, b: number) => Math.max(a ?? 0, b);
  const visit: VisitWrite = {
    id: p.visitId,
    dealId: deal.id,
    buyerAccessId: access.id,
    renditionId: rendition.id,
    startedAt,
    lastSeenAt: existing && existing.lastSeenAt > now ? existing.lastSeenAt : now,
    wallMs: g(existing?.wallMs, clocks.wallMs),
    activeMs: mergedActive,
    idleMs: g(existing?.idleMs, clocks.idleMs),
    hiddenMs: g(existing?.hiddenMs, clocks.hiddenMs),
    awayMs: g(existing?.awayMs, clocks.awayMs),
    outsideMs: g(existing?.outsideMs, clocks.outsideMs),
    maxPageIndex: maxPage >= 0 ? maxPage : null,
    path,
    selfView: !!existing?.selfView || input.selfView,
    clamped: !!existing?.clamped || clamped,
    mode,
    accessLevel: access.accessLevel,
    deviceClass: deviceClassOf(p.device),
    viewportW: p.device.w,
    viewportH: p.device.h,
    uaFamily: input.uaFamily,
    ipHash: input.ipHash,
  };

  const rows: RollupWrite[] = [];
  merged.forEach((r, k) => {
    if (!exact && !touched.has(k)) return;
    const page = pages.get(r.pageId);
    rows.push({ ...r, visitId: p.visitId, dealId: deal.id, buyerAccessId: access.id, renditionId: rendition.id, lineageId: page?.lineageId ?? r.pageId, at: now });
  });

  const events: EventWrite[] = p.events.map((e) => ({
    dealId: deal.id,
    buyerAccessId: access.id,
    visitId: p.visitId,
    renditionId: rendition.id,
    pageId: e.pageId,
    blockKey: e.blockKey || null,
    clientSeq: e.seq,
    eventType: e.type,
    detail: e.detail && EVENT_DETAIL_RE.test(e.detail) ? e.detail : null,
    clientAt: e.at,
    at: now,
  }));

  return { ok: true, newVisit: !existing, clamped: visit.clamped, visit, rollups: rows, exactRollups: exact, events };
}

// ── Stores ────────────────────────────────────────────────────────────────

export interface IngestTx {
  /** The visit row, locked for this transaction. */
  getVisit(id: string): Promise<VisitRow | null>;
  getRollups(visitId: string): Promise<RollupRow[]>;
  /** Upsert (GREATEST); null when the id is taken by another buyer link. */
  writeVisit(v: VisitWrite): Promise<{ inserted: boolean } | null>;
  writeRollups(rows: RollupWrite[], exact: boolean): Promise<void>;
  /** Insert; a (visit, seq) already stored is ignored. */
  writeEvents(rows: EventWrite[]): Promise<void>;
  /** +1 view unless another (non-self) visit on this link was seen in the 30 min before `now`. */
  countView(accessId: string, visitId: string, now: Date): Promise<boolean>;
}

export interface ReadingStore {
  getRendition(id: string): Promise<RenditionRef | null>;
  transaction<T>(fn: (tx: IngestTx) => Promise<T>): Promise<T>;
}

export interface IngestResult {
  status: 204 | 400 | 409;
  reason?: string;
  newVisit?: boolean;
  clamped?: boolean;
  viewCounted?: boolean;
}

class VisitConflict extends Error {}

type Listener = (dealId: string) => void;
const listeners: Listener[] = [];
const versions = new Map<string, number>();

/** Called after every stored send (e.g. to schedule a benchmark refresh). */
export function onReadingWritten(fn: Listener): () => void {
  listeners.push(fn);
  return () => { const i = listeners.indexOf(fn); if (i >= 0) listeners.splice(i, 1); };
}

/** Bumps on every write for the deal in this process (engagement cache key). */
export function readingVersion(dealId: string): number {
  return versions.get(dealId) ?? 0;
}

export async function ingestReading(store: ReadingStore, input: IngestInput): Promise<IngestResult> {
  const rendition = await store.getRendition(input.payload.renditionId);
  let result: IngestResult;
  try {
    result = await store.transaction(async (tx) => {
      const existing = await tx.getVisit(input.payload.visitId);
      const stored = existing ? await tx.getRollups(existing.id) : [];
      const plan = planIngest(input, rendition, existing, stored);
      if (!plan.ok) return { status: plan.status, reason: plan.reason } as IngestResult;
      const w = await tx.writeVisit(plan.visit);
      if (!w) throw new VisitConflict();
      if (plan.rollups.length) await tx.writeRollups(plan.rollups, plan.exactRollups);
      if (plan.events.length) await tx.writeEvents(plan.events);
      const viewCounted = w.inserted && !plan.visit.selfView ? await tx.countView(input.access.id, plan.visit.id, input.now) : false;
      return { status: 204, newVisit: w.inserted, clamped: plan.clamped, viewCounted } as IngestResult;
    });
  } catch (err) {
    if (err instanceof VisitConflict) return { status: 409, reason: "visit belongs to another link" };
    throw err;
  }
  if (result.status === 204) {
    versions.set(input.deal.id, readingVersion(input.deal.id) + 1);
    for (const fn of listeners) { try { fn(input.deal.id); } catch { /* a listener never breaks ingest */ } }
  }
  return result;
}

/**
 * The view room GET's stamp: lastAccessedAt always, firstViewedAt the first
 * time content is served (the reminder pipeline's anchor — it must not
 * depend on the tracker, which a blocker can stop) — but never a view
 * count: views are counted per visit by the tracker (countView above).
 */
export function viewRoomStamp(
  access: Pick<BuyerAccess, "firstViewedAt" | "lastAccessedAt" | "viewCount">,
  served: boolean,
  now: Date = new Date(),
): Partial<Pick<BuyerAccess, "firstViewedAt" | "lastAccessedAt">> {
  const { viewCount: _notCounted, ...stamp } = viewStampFor(access, served, now);
  return stamp;
}

// ── Request helpers (no raw IP or user agent is kept) ────────────────────

let hashKey: string | null = null;
function analyticsKey(): string {
  if (hashKey) return hashKey;
  const explicit = process.env.ANALYTICS_HASH_KEY;
  hashKey = explicit && explicit.length >= 16
    ? explicit
    : createHash("sha256").update(`cimple-analytics-network:${process.env.SESSION_SECRET || "dev-only"}`).digest("hex");
  return hashKey;
}

/** A keyed hash of the network address, per deal (can't be matched across deals or reversed). */
export function networkKey(dealId: string, ip: string | null | undefined): string | null {
  if (!ip) return null;
  return createHmac("sha256", analyticsKey()).update(`${dealId}|${ip}`).digest("hex").slice(0, 24);
}

/** "Chrome/Mac" — browser family and platform only, never the raw user agent. */
export function uaFamilyOf(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Other";
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X|Macintosh/.test(ua) ? "Mac"
    : /Windows/.test(ua) ? "Windows" : /Linux|CrOS/.test(ua) ? "Linux" : "Other";
  return `${browser}/${os}`;
}

// ── Postgres store ─────────────────────────────────────────────────────────

const renditionCache = new Map<string, RenditionRef>();
const RENDITION_CACHE_MAX = 200;

const num = (v: unknown) => Number(v ?? 0) || 0;
/** A timestamp column (stored in UTC, returned by the driver as zone-less text) → Date. */
export function asDate(v: unknown): Date {
  if (v instanceof Date) return v;
  const t = String(v ?? "");
  return new Date(/[zZ]|[+-]\d\d(:?\d\d)?$/.test(t) ? t : `${t.replace(" ", "T")}Z`);
}

function visitFromRow(r: Record<string, unknown>): VisitRow {
  return {
    id: String(r.id),
    dealId: String(r.deal_id),
    buyerAccessId: String(r.buyer_access_id),
    renditionId: (r.rendition_id as string | null) ?? null,
    startedAt: asDate(r.started_at),
    lastSeenAt: asDate(r.last_seen_at),
    wallMs: num(r.wall_ms), activeMs: num(r.active_ms), idleMs: num(r.idle_ms),
    hiddenMs: num(r.hidden_ms), awayMs: num(r.away_ms), outsideMs: num(r.outside_ms),
    maxPageIndex: r.max_page_index == null ? null : num(r.max_page_index),
    path: Array.isArray(r.path) ? (r.path as Array<[number, string]>) : [],
    selfView: !!r.self_view,
    clamped: !!r.clamped,
  };
}

export const dbReadingStore: ReadingStore = {
  async getRendition(id) {
    const hit = renditionCache.get(id);
    if (hit) return hit;
    const { db } = await import("../db");
    const rows = (await db.execute(sql`SELECT id, deal_id, mode, variant, created_at, page_index FROM cim_renditions WHERE id = ${id} LIMIT 1`)) as unknown as Array<Record<string, unknown>>;
    const r = rows[0];
    if (!r) return null;
    const ref: RenditionRef = {
      id: String(r.id), dealId: String(r.deal_id), mode: String(r.mode), variant: String(r.variant),
      createdAt: asDate(r.created_at), pageIndex: (r.page_index as RenditionPage[]) ?? [],
    };
    renditionCache.set(id, ref);
    if (renditionCache.size > RENDITION_CACHE_MAX) renditionCache.delete(renditionCache.keys().next().value as string);
    return ref;
  },

  async transaction(fn) {
    const { db } = await import("../db");
    return db.transaction(async (tx) => {
      const exec = async (q: ReturnType<typeof sql>) => (await tx.execute(q)) as unknown as Array<Record<string, unknown>>;
      const t: IngestTx = {
        async getVisit(id) {
          const rows = await exec(sql`SELECT * FROM buyer_visits WHERE id = ${id} FOR UPDATE`);
          return rows[0] ? visitFromRow(rows[0]) : null;
        },
        async getRollups(visitId) {
          const rows = await exec(sql`SELECT page_id, block_key, attention_ms, skim_ms, visible_ms, pointer_ms FROM reading_rollups WHERE visit_id = ${visitId}`);
          return rows.map((r) => ({
            pageId: String(r.page_id), blockKey: String(r.block_key ?? ""),
            attentionMs: num(r.attention_ms), skimMs: num(r.skim_ms), visibleMs: num(r.visible_ms), pointerMs: num(r.pointer_ms),
          }));
        },
        async writeVisit(v) {
          const rows = await exec(sql`
            INSERT INTO buyer_visits (id, deal_id, buyer_access_id, rendition_id, mode, access_level, device_class, viewport_w, viewport_h,
              ua_family, ip_hash, started_at, last_seen_at, wall_ms, active_ms, idle_ms, hidden_ms, away_ms, outside_ms,
              max_page_index, path, self_view, clamped, legacy)
            VALUES (${v.id}, ${v.dealId}, ${v.buyerAccessId}, ${v.renditionId}, ${v.mode}, ${v.accessLevel}, ${v.deviceClass}, ${v.viewportW}, ${v.viewportH},
              ${v.uaFamily}, ${v.ipHash}, ${v.startedAt.toISOString()}::timestamp, ${v.lastSeenAt.toISOString()}::timestamp,
              ${v.wallMs}, ${v.activeMs}, ${v.idleMs}, ${v.hiddenMs}, ${v.awayMs}, ${v.outsideMs},
              ${v.maxPageIndex}, ${JSON.stringify(v.path)}::jsonb, ${v.selfView}, ${v.clamped}, false)
            ON CONFLICT (id) DO UPDATE SET
              last_seen_at = GREATEST(buyer_visits.last_seen_at, EXCLUDED.last_seen_at),
              wall_ms = GREATEST(buyer_visits.wall_ms, EXCLUDED.wall_ms),
              active_ms = GREATEST(buyer_visits.active_ms, EXCLUDED.active_ms),
              idle_ms = GREATEST(buyer_visits.idle_ms, EXCLUDED.idle_ms),
              hidden_ms = GREATEST(buyer_visits.hidden_ms, EXCLUDED.hidden_ms),
              away_ms = GREATEST(buyer_visits.away_ms, EXCLUDED.away_ms),
              outside_ms = GREATEST(buyer_visits.outside_ms, EXCLUDED.outside_ms),
              max_page_index = NULLIF(GREATEST(COALESCE(buyer_visits.max_page_index, -1), COALESCE(EXCLUDED.max_page_index, -1)), -1),
              path = CASE WHEN jsonb_array_length(EXCLUDED.path) >= jsonb_array_length(COALESCE(buyer_visits.path, '[]'::jsonb))
                          THEN EXCLUDED.path ELSE buyer_visits.path END,
              device_class = EXCLUDED.device_class, viewport_w = EXCLUDED.viewport_w, viewport_h = EXCLUDED.viewport_h,
              ua_family = COALESCE(EXCLUDED.ua_family, buyer_visits.ua_family),
              ip_hash = COALESCE(buyer_visits.ip_hash, EXCLUDED.ip_hash),
              self_view = buyer_visits.self_view OR EXCLUDED.self_view,
              clamped = buyer_visits.clamped OR EXCLUDED.clamped
            WHERE buyer_visits.buyer_access_id = EXCLUDED.buyer_access_id
            RETURNING (xmax = 0) AS inserted`);
          return rows[0] ? { inserted: !!rows[0].inserted } : null;
        },
        async writeRollups(rows, exact) {
          for (let i = 0; i < rows.length; i += 200) {
            const chunk = rows.slice(i, i + 200);
            const values = sql.join(chunk.map((r) => sql`(${r.visitId}, ${r.pageId}, ${r.blockKey}, ${r.dealId}, ${r.buyerAccessId}, ${r.renditionId}, ${r.lineageId},
              ${r.attentionMs}, ${r.skimMs}, ${r.visibleMs}, ${r.pointerMs}, ${r.at.toISOString()}::timestamp, ${r.at.toISOString()}::timestamp)`), sql`, `);
            await exec(exact
              ? sql`INSERT INTO reading_rollups (visit_id, page_id, block_key, deal_id, buyer_access_id, rendition_id, lineage_id,
                  attention_ms, skim_ms, visible_ms, pointer_ms, first_at, last_at) VALUES ${values}
                ON CONFLICT (visit_id, page_id, block_key) DO UPDATE SET
                  attention_ms = EXCLUDED.attention_ms, skim_ms = EXCLUDED.skim_ms,
                  visible_ms = EXCLUDED.visible_ms, pointer_ms = EXCLUDED.pointer_ms,
                  last_at = GREATEST(reading_rollups.last_at, EXCLUDED.last_at)`
              : sql`INSERT INTO reading_rollups (visit_id, page_id, block_key, deal_id, buyer_access_id, rendition_id, lineage_id,
                  attention_ms, skim_ms, visible_ms, pointer_ms, first_at, last_at) VALUES ${values}
                ON CONFLICT (visit_id, page_id, block_key) DO UPDATE SET
                  attention_ms = GREATEST(reading_rollups.attention_ms, EXCLUDED.attention_ms),
                  skim_ms = GREATEST(reading_rollups.skim_ms, EXCLUDED.skim_ms),
                  visible_ms = GREATEST(reading_rollups.visible_ms, EXCLUDED.visible_ms),
                  pointer_ms = GREATEST(reading_rollups.pointer_ms, EXCLUDED.pointer_ms),
                  last_at = GREATEST(reading_rollups.last_at, EXCLUDED.last_at)`);
          }
        },
        async writeEvents(rows) {
          const values = sql.join(rows.map((e) => sql`(${e.dealId}, ${e.buyerAccessId}, ${e.eventType},
            ${JSON.stringify({ detail: e.detail, at: e.clientAt })}::jsonb, ${e.visitId}, ${e.renditionId}, ${e.pageId}, ${e.blockKey}, ${e.clientSeq},
            ${e.at.toISOString()}::timestamp)`), sql`, `);
          await exec(sql`INSERT INTO analytics_events (deal_id, buyer_access_id, event_type, event_data, visit_id, rendition_id, page_id, block_key, client_seq, created_at)
            VALUES ${values}
            ON CONFLICT (visit_id, client_seq) WHERE visit_id IS NOT NULL DO NOTHING`);
        },
        async countView(accessId, visitId, now) {
          const rows = await exec(sql`
            UPDATE buyer_access SET view_count = COALESCE(view_count, 0) + 1
            WHERE id = ${accessId}
              AND NOT EXISTS (
                SELECT 1 FROM buyer_visits
                WHERE buyer_access_id = ${accessId} AND id <> ${visitId} AND NOT self_view
                  AND last_seen_at > ${new Date(now.getTime() - READING_RULES.visitGapMs).toISOString()}::timestamp
                  AND last_seen_at <= ${now.toISOString()}::timestamp)
            RETURNING id`);
          return rows.length > 0;
        },
      };
      return fn(t);
    });
  },
};

// ── In-memory store (tests; same semantics as the SQL above) ─────────────

export interface MemoryReadingStore extends ReadingStore {
  renditions: Map<string, RenditionRef>;
  visits: Map<string, VisitWrite>;
  rollups: Map<string, RollupWrite>;
  events: Map<string, EventWrite>;
  viewCounts: Map<string, number>;
}

export function memoryReadingStore(): MemoryReadingStore {
  const s: MemoryReadingStore = {
    renditions: new Map(),
    visits: new Map(),
    rollups: new Map(),
    events: new Map(),
    viewCounts: new Map(),
    async getRendition(id) {
      return s.renditions.get(id) ?? null;
    },
    async transaction(fn) {
      const t: IngestTx = {
        async getVisit(id) {
          const v = s.visits.get(id);
          return v ? { ...v, path: v.path.map(([a, b]) => [a, b] as [number, string]) } : null;
        },
        async getRollups(visitId) {
          return Array.from(s.rollups.values()).filter((r) => r.visitId === visitId).map((r) => ({ ...r }));
        },
        async writeVisit(v) {
          const prev = s.visits.get(v.id);
          if (prev && prev.buyerAccessId !== v.buyerAccessId) return null;
          if (!prev) { s.visits.set(v.id, { ...v }); return { inserted: true }; }
          const gt = (a: number, b: number) => Math.max(a, b);
          s.visits.set(v.id, {
            ...prev, ...v,
            startedAt: prev.startedAt,
            lastSeenAt: prev.lastSeenAt > v.lastSeenAt ? prev.lastSeenAt : v.lastSeenAt,
            wallMs: gt(prev.wallMs, v.wallMs), activeMs: gt(prev.activeMs, v.activeMs), idleMs: gt(prev.idleMs, v.idleMs),
            hiddenMs: gt(prev.hiddenMs, v.hiddenMs), awayMs: gt(prev.awayMs, v.awayMs), outsideMs: gt(prev.outsideMs, v.outsideMs),
            maxPageIndex: Math.max(prev.maxPageIndex ?? -1, v.maxPageIndex ?? -1) >= 0 ? Math.max(prev.maxPageIndex ?? -1, v.maxPageIndex ?? -1) : null,
            path: v.path.length >= prev.path.length ? v.path : prev.path,
            ipHash: prev.ipHash ?? v.ipHash,
            selfView: prev.selfView || v.selfView,
            clamped: prev.clamped || v.clamped,
          });
          return { inserted: false };
        },
        async writeRollups(rows, exact) {
          for (const r of rows) {
            const k = `${r.visitId}|${r.pageId}|${r.blockKey}`;
            const prev = s.rollups.get(k);
            s.rollups.set(k, !prev || exact ? { ...r } : {
              ...prev,
              attentionMs: Math.max(prev.attentionMs, r.attentionMs), skimMs: Math.max(prev.skimMs, r.skimMs),
              visibleMs: Math.max(prev.visibleMs, r.visibleMs), pointerMs: Math.max(prev.pointerMs, r.pointerMs),
              at: prev.at > r.at ? prev.at : r.at,
            });
          }
        },
        async writeEvents(rows) {
          for (const e of rows) {
            const k = `${e.visitId}|${e.clientSeq}`;
            if (!s.events.has(k)) s.events.set(k, { ...e });
          }
        },
        async countView(accessId, visitId, now) {
          const recent = Array.from(s.visits.values()).some((v) => v.buyerAccessId === accessId && v.id !== visitId && !v.selfView
            && v.lastSeenAt.getTime() > now.getTime() - READING_RULES.visitGapMs && v.lastSeenAt.getTime() <= now.getTime());
          if (recent) return false;
          s.viewCounts.set(accessId, (s.viewCounts.get(accessId) ?? 0) + 1);
          return true;
        },
      };
      return fn(t);
    },
  };
  return s;
}
