/**
 * Buyers' document requests (vdr spec §5.8, §6.5, §9.1 requests.ts).
 *
 *  - A buyer (or their team member) asks for a document that isn't in the
 *    room: one at a time, or a pasted list (one row per line, ≤ 100, sharing
 *    a listId). A Blind CIM or Full CIM buyer without the room may ask for
 *    access ("room_access"). A teaser link never can (INTEGRATION C23).
 *  - The broker answers from To do › Buyer requests: share a document that is
 *    in the room, ask the seller (a checklist row, source "buyer_request" —
 *    the seller never sees who asked), or decline with a note the buyer sees.
 *  - When a file is linked to that checklist row (seller or broker upload),
 *    the request becomes "Ready to share" (onRequirementFulfilled): one click
 *    shares it with the buyer and offers the "Tell the buyer" email. Nothing
 *    is shared and nobody is emailed without the broker's click.
 */
import { randomUUID } from "crypto";
import type { BuyerAccess, DealDocumentRequirement, Document, InsertDealDocumentRequirement, InsertVdrRequest, VdrItem, VdrRequest, VdrTeamMember } from "@shared/schema";
import { accessLevelLabel } from "@shared/access-levels";
import { VDR_LIMITS, buyerKey, dataRoomLevelRule } from "@shared/vdr";
import type { BuyerRequestRow, RequestStatus, RoomRequestRow, RoomRequestsPayload } from "@shared/vdr-api";
import { presetFor } from "./auto-file";
import { dbVdrStore, logVdrQuietly, type VdrStore } from "./store";

export async function onRequirementFulfilled(requirementId: string, documentId: string, store: VdrStore = dbVdrStore): Promise<number> {
  try {
    const ready = await store.markRequestsReady(requirementId, documentId);
    for (const r of ready) {
      await logVdrQuietly(store, {
        dealId: r.dealId,
        action: "request_ready",
        actorKind: "seller",
        buyerEmail: r.buyerEmail,
        detail: { requestId: r.id, requirementId, documentId },
      });
    }
    return ready.length;
  } catch (err: any) {
    console.warn(`[vdr] couldn't mark requests ready for checklist row ${requirementId}:`, err?.message ?? err);
    return 0;
  }
}

// ── What a buyer sends ─────────────────────────────────────────────────────

export type ParsedRequest = { rows: Array<{ text: string; itemId: string | null; documentId: string | null }>; list: boolean };

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();

/**
 * A buyer's request body → rows, or a plain-words error. `{ text, itemId?,
 * documentId? }` is one request; `{ list }` is a pasted list (blank lines
 * dropped, bullets and numbering stripped, ≤ 100 lines, each ≤ 500 chars).
 */
export function parseBuyerRequest(body: unknown): ParsedRequest | { error: string } {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof b.list === "string") {
    const lines = b.list
      .split(/\r?\n/)
      .map((l) => clean(l.replace(/^\s*(?:[-*•·]+|\(?\d{1,3}[.)]|[a-z][.)])\s+/i, "")))
      .filter((l) => l.length > 0);
    if (lines.length === 0) return { error: "Paste at least one document, one per line." };
    if (lines.length > VDR_LIMITS.requestListLines) return { error: `That's ${lines.length} lines. Send up to ${VDR_LIMITS.requestListLines} at a time.` };
    return { rows: lines.map((text) => ({ text: text.slice(0, VDR_LIMITS.requestText), itemId: null, documentId: null })), list: true };
  }
  const text = typeof b.text === "string" ? clean(b.text) : "";
  if (!text) return { error: "Say which document you need." };
  if (text.length > VDR_LIMITS.requestText) return { error: `Keep it under ${VDR_LIMITS.requestText} characters.` };
  const itemId = typeof b.itemId === "string" && ID.test(b.itemId) ? b.itemId : null;
  const documentId = typeof b.documentId === "string" && ID.test(b.documentId) ? b.documentId : null;
  return { rows: [{ text, itemId, documentId }], list: false };
}

/** The buyer's own requests as they see them (never who else asked, never the seller's part). */
export function buyerRequestRows(
  requests: ReadonlyArray<VdrRequest>,
  reader: { buyerEmail: string; teamMemberId: string | null },
  itemNumber: (itemId: string) => string | null,
): BuyerRequestRow[] {
  return requests
    .filter((r) => r.buyerEmail === reader.buyerEmail && (reader.teamMemberId === null || r.teamMemberId === reader.teamMemberId))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 200)
    .map((r) => {
      const status = r.status as RequestStatus;
      let statusText = "Waiting for the broker";
      if (status === "shared") {
        const n = r.itemId ? itemNumber(r.itemId) : null;
        statusText = n ? `Shared: now in ${n}` : "Shared: it's in your data room";
      } else if (status === "declined") {
        statusText = r.brokerNote && r.brokerNote.trim() ? `The broker replied: '${r.brokerNote.trim()}'` : "The broker can't share this one";
      }
      return { id: r.id, text: r.kind === "room_access" ? "Access to the data room" : r.text, status, statusText, itemId: status === "shared" ? r.itemId ?? null : null, at: new Date(r.createdAt).toISOString() };
    });
}

/** Rows to insert for a buyer's request(s). Pure. */
export function requestRows(
  dealId: string,
  i: { accessId: string; buyerEmail: string; teamMemberId: string | null; kind: "document" | "room_access"; rows: ParsedRequest["rows"]; list: boolean },
): InsertVdrRequest[] {
  const listId = i.list && i.rows.length > 1 ? randomUUID() : null;
  return i.rows.map((r) => ({
    dealId,
    buyerAccessId: i.accessId,
    buyerEmail: i.buyerEmail,
    teamMemberId: i.teamMemberId,
    listId,
    kind: i.kind,
    itemId: r.itemId,
    documentId: r.documentId,
    text: r.text,
    status: "open",
  }));
}

// ── The broker's answers ────────────────────────────────────────────────────

/** The checklist category for a request ("financial" | "tax" | "legal" | "compliance" | "operational"). */
export function requirementCategoryFor(text: string, folderPresetKey?: string | null): string {
  const key = folderPresetKey || presetFor({ name: text }).key;
  if (key === "financial.tax") return "tax";
  if (key.startsWith("financial")) return "financial";
  if (key === "compliance") return "compliance";
  if (key.startsWith("legal")) return "legal";
  return "operational";
}

/** A "needed by" date from the broker (yyyy-mm-dd or ISO), or null. Errors when it's in the past or unreadable. */
export function parseNeededBy(v: unknown, now: Date): { ok: true; at: Date | null } | { ok: false; error: string } {
  if (v === undefined || v === null || v === "") return { ok: true, at: null };
  if (typeof v !== "string" || v.length > 40) return { ok: false, error: "Choose a date." };
  const at = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T12:00:00Z` : v);
  if (Number.isNaN(at.getTime())) return { ok: false, error: "Choose a date." };
  if (at.getTime() < now.getTime() - 24 * 3600_000) return { ok: false, error: "Choose a date that hasn't passed." };
  if (at.getTime() > now.getTime() + 2 * 365 * 24 * 3600_000) return { ok: false, error: "Choose a date in the next two years." };
  return { ok: true, at };
}

export type RequestDeps = {
  store: VdrStore;
  now: () => Date;
  createRequirement: (row: InsertDealDocumentRequirement) => Promise<DealDocumentRequirement>;
  requirementsForDeal: (dealId: string) => Promise<DealDocumentRequirement[]>;
};

/**
 * "Ask the seller for it": one checklist row per request (source
 * "buyer_request", required, with the broker's note and needed-by date; the
 * buyer is never named), each request → "Asked the seller". Returns the new
 * rows (for "Email the seller now").
 */
export async function askSeller(
  deps: RequestDeps,
  dealId: string,
  requests: ReadonlyArray<VdrRequest>,
  opts: { name?: string | null; note?: string | null; neededBy?: Date | null; folderPresetKey?: string | null },
  by: string,
): Promise<DealDocumentRequirement[]> {
  const existing = await deps.requirementsForDeal(dealId).catch(() => [] as DealDocumentRequirement[]);
  let order = existing.reduce((m, r) => Math.max(m, r.sortOrder ?? 0), 0);
  const created: DealDocumentRequirement[] = [];
  for (const r of requests) {
    if (r.dealId !== dealId || r.kind !== "document") continue;
    const name = clean((requests.length === 1 && opts.name ? opts.name : r.text) || r.text).slice(0, 200);
    const req = await deps.createRequirement({
      dealId,
      documentName: name,
      category: requirementCategoryFor(name, opts.folderPresetKey),
      isRequired: true,
      source: "buyer_request",
      status: "missing",
      notes: opts.note && opts.note.trim() ? opts.note.trim().slice(0, 500) : null,
      sortOrder: ++order,
      neededBy: opts.neededBy ?? null,
    } as InsertDealDocumentRequirement);
    created.push(req);
    await deps.store.updateRequest(r.id, { status: "asked_seller", requirementId: req.id, resolvedBy: by });
  }
  await logVdrQuietly(deps.store, requests.filter((r) => r.kind === "document").map((r) => ({
    dealId, action: "request_resolved", actorKind: "broker", actorId: by, buyerEmail: r.buyerEmail,
    detail: { requestId: r.id, how: "ask_seller", text: r.text.slice(0, 120) },
  })));
  return created;
}

/** "Decline" (with a note the buyer sees). */
export async function declineRequests(deps: Pick<RequestDeps, "store" | "now">, dealId: string, requests: ReadonlyArray<VdrRequest>, note: string | null, by: string): Promise<number> {
  const at = deps.now();
  const text = note && note.trim() ? note.trim().slice(0, 500) : null;
  let n = 0;
  for (const r of requests) {
    if (r.dealId !== dealId || r.status === "shared" || r.status === "declined") continue;
    await deps.store.updateRequest(r.id, { status: "declined", brokerNote: text, resolvedAt: at, resolvedBy: by });
    n++;
  }
  await logVdrQuietly(deps.store, requests.map((r) => ({
    dealId, action: "request_resolved", actorKind: "broker", actorId: by, buyerEmail: r.buyerEmail,
    detail: { requestId: r.id, how: "declined", text: r.text.slice(0, 120) },
  })));
  return n;
}

/** Marks a request answered by sharing an item (after the share was written). */
export async function markShared(deps: Pick<RequestDeps, "store" | "now">, request: VdrRequest, itemId: string, by: string): Promise<void> {
  await deps.store.updateRequest(request.id, { status: "shared", itemId, resolvedAt: deps.now(), resolvedBy: by });
  await logVdrQuietly(deps.store, {
    dealId: request.dealId, action: "request_resolved", actorKind: "broker", actorId: by, buyerEmail: request.buyerEmail, itemId,
    detail: { requestId: request.id, how: "shared", text: request.text.slice(0, 120) },
  });
}

// ── The broker's list ──────────────────────────────────────────────────────

const ROLE: Record<string, string> = { accountant: "accountant", lawyer: "lawyer", lender: "lender", adviser: "adviser", colleague: "colleague" };

/** To do › Buyer requests (§5.8): one row per request, pasted lists grouped. */
export function brokerRequestRows(i: {
  requests: ReadonlyArray<VdrRequest>;
  groups: ReadonlyArray<{ key: string; rows: BuyerAccess[]; eligible: BuyerAccess | null; hasRoom: boolean }>;
  accessRows: ReadonlyArray<BuyerAccess>;
  items: ReadonlyArray<Pick<VdrItem, "id" | "title" | "documentId" | "removedAt">>;
  numbers: ReadonlyMap<string, string>;
  docs: ReadonlyMap<string, Pick<Document, "id" | "name">>;
  requirements: ReadonlyArray<DealDocumentRequirement>;
  team: ReadonlyArray<Pick<VdrTeamMember, "id" | "name" | "role">>;
}): RoomRequestsPayload {
  const label = (key: string) => {
    const g = i.groups.find((x) => x.key === key);
    const link = g?.eligible ?? g?.rows[0] ?? i.accessRows.find((a) => buyerKey(a.buyerEmail) === key) ?? null;
    return { link, text: (link?.buyerCompany || link?.buyerName || link?.buyerEmail || key) as string };
  };
  const rows: RoomRequestRow[] = i.requests.map((r) => {
    const g = i.groups.find((x) => x.key === r.buyerEmail);
    const { link } = label(r.buyerEmail);
    const own = i.accessRows.find((a) => a.id === r.buyerAccessId) ?? link;
    const member = r.teamMemberId ? i.team.find((t) => t.id === r.teamMemberId) : null;
    const item = r.itemId ? i.items.find((x) => x.id === r.itemId && !x.removedAt) ?? null : null;
    const req = r.requirementId ? i.requirements.find((x) => x.id === r.requirementId) ?? null : null;
    const readyItem = r.readyDocumentId ? i.items.find((x) => x.documentId === r.readyDocumentId && !x.removedAt) ?? null : null;
    const readyDoc = r.readyDocumentId ? i.docs.get(r.readyDocumentId) ?? null : null;
    const cited = r.documentId ? i.docs.get(r.documentId) ?? null : null;
    return {
      id: r.id,
      listId: r.listId ?? null,
      kind: r.kind === "room_access" ? "room_access" : "document",
      text: r.text,
      status: r.status as RequestStatus,
      buyer: {
        key: r.buyerEmail,
        accessId: (g?.eligible ?? own)?.id ?? r.buyerAccessId,
        name: own?.buyerName ?? null,
        company: own?.buyerCompany ?? null,
        email: own?.buyerEmail ?? r.buyerEmail,
        levelLabel: own ? accessLevelLabel(own.accessLevel) : "",
        hasRoom: !!g?.hasRoom,
        rule: dataRoomLevelRule(own?.accessLevel),
      },
      askedBy: member ? { name: member.name, role: ROLE[member.role] ?? "adviser" } : null,
      item: item ? { id: item.id, number: i.numbers.get(item.id) ?? null, title: item.title } : null,
      citedDocument: cited ? { id: cited.id, name: cited.name } : null,
      requirement: req ? { id: req.id, name: req.documentName, status: req.status, neededBy: req.neededBy ? new Date(req.neededBy).toISOString() : null, note: req.notes ?? null } : null,
      ready: r.readyDocumentId ? { documentId: r.readyDocumentId, name: readyItem?.title ?? readyDoc?.name ?? "The seller's upload", itemId: readyItem?.id ?? null } : null,
      brokerNote: r.brokerNote ?? null,
      createdAt: new Date(r.createdAt).toISOString(),
      resolvedAt: r.resolvedAt ? new Date(r.resolvedAt).toISOString() : null,
    };
  });
  const order: Record<string, number> = { ready_to_share: 0, open: 1, asked_seller: 2, shared: 3, declined: 4 };
  rows.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || b.createdAt.localeCompare(a.createdAt));
  const lists: RoomRequestsPayload["lists"] = [];
  for (const r of i.requests) {
    if (!r.listId || lists.some((l) => l.listId === r.listId)) continue;
    const same = i.requests.filter((x) => x.listId === r.listId);
    lists.push({ listId: r.listId, buyerKey: r.buyerEmail, buyerLabel: label(r.buyerEmail).text, count: same.length, open: same.filter((x) => x.status === "open").length, createdAt: new Date(same.reduce((m, x) => (new Date(x.createdAt) < m ? new Date(x.createdAt) : m), new Date(r.createdAt))).toISOString() });
  }
  return { requests: rows, lists };
}
