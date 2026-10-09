/**
 * Citation lookups (vdr spec §6.6, §11.1.3; INTEGRATION §2.6).
 *
 * The DD CIM's chips (`VdrCitationChip`, placed by dd) carry a document id,
 * never a title. The chip asks the room, in one batched call per page, which
 * of those documents THIS reader can open:
 *
 *   buyer  → `{ available: true, itemId, title, number, replaced? }` for a
 *            document they can open now (the room's own title and number),
 *            else `{ available: false }` — the SAME shape for broker-only,
 *            unknown, not shared, ledger not ready, due-diligence-only or no
 *            access, so the cases can't be told apart and no name leaks.
 *            A document the seller replaced follows to the new version when
 *            that one is visible (`replaced: true`, no page anchor).
 *   broker → the document's own name always, and where it is in the room.
 *
 * No AI, no writes.
 */
import type { Document, VdrItem } from "@shared/schema";
import { indexNumbers } from "@shared/vdr";
import type { ReaderItem, RoomSnapshot } from "./access";
import type { VdrStore } from "./store";

export const RESOLVE_MAX = 50;

export type ResolvedForBuyer =
  | { available: true; itemId: string; title: string; number: string | null; replaced?: true }
  | { available: false };

export type ResolvedForBroker =
  | { available: true; documentId: string; title: string; itemId: string | null; number: string | null; inRoom: boolean; brokerOnly: boolean; replaced?: true }
  | { available: false };

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/** `documentIds=a,b,c` (or repeated) → up to 50 distinct, well-formed ids; null when empty or malformed. */
export function parseDocumentIds(q: unknown): string[] | null {
  const raw = (Array.isArray(q) ? q : [q]).flatMap((v) => (typeof v === "string" ? v.split(",") : [])).map((s) => s.trim()).filter(Boolean);
  if (raw.length === 0 || raw.length > RESOLVE_MAX) return null;
  if (!raw.every((s) => ID.test(s))) return null;
  return Array.from(new Set(raw));
}

/**
 * Documents the seller replaced → the item of the new version, from the
 * `new_version` log rows (their detail names the document they replace —
 * the old item's own document id is cleared when the old file is deleted).
 */
export async function replacementsFor(store: VdrStore, dealId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const rows = await store.listActivityByActions(dealId, ["new_version"]);
    // Oldest first, so a later replacement of the same document wins.
    for (const r of rows.slice().reverse()) {
      const d = (r.detail ?? {}) as Record<string, unknown>;
      if (typeof d.replacesDocumentId === "string" && r.itemId) out.set(d.replacesDocumentId, r.itemId);
    }
  } catch {
    // No log → no replacements (the chip shows the neutral label).
  }
  return out;
}

/** Follows `replacedByItemId` to the newest version (cycle-safe). */
export function latestVersion(items: ReadonlyArray<Pick<VdrItem, "id" | "replacedByItemId" | "removedAt">>, itemId: string): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  let cur = itemId;
  const seen = new Set<string>();
  seen.add(cur);
  for (;;) {
    const next = byId.get(cur)?.replacedByItemId;
    if (!next || !byId.has(next) || seen.has(next)) break;
    seen.add(next);
    cur = next;
  }
  return cur;
}

/** What a buyer (or team member) gets for each id — see the file comment. */
export function resolveForReader(
  ids: ReadonlyArray<string>,
  snap: Pick<RoomSnapshot, "folders" | "items">,
  decided: ReadonlyArray<ReaderItem>,
  replacements: ReadonlyMap<string, string>,
): Record<string, ResolvedForBuyer> {
  const numbers = indexNumbers(snap.folders, snap.items).items;
  const visible = new Map(decided.filter((d) => d.visibility.visible).map((d) => [d.item.id, d.item]));
  const byDoc = new Map<string, VdrItem>();
  for (const it of Array.from(visible.values())) if (it.documentId) byDoc.set(it.documentId, it);
  const out: Record<string, ResolvedForBuyer> = {};
  for (const id of ids) {
    const direct = byDoc.get(id);
    if (direct) {
      out[id] = { available: true, itemId: direct.id, title: direct.title, number: numbers.get(direct.id) ?? null };
      continue;
    }
    const via = replacements.get(id);
    const newest = via ? visible.get(latestVersion(snap.items, via)) : undefined;
    out[id] = newest ? { available: true, itemId: newest.id, title: newest.title, number: numbers.get(newest.id) ?? null, replaced: true } : { available: false };
  }
  return out;
}

/** The broker's lookup: any document of this deal, by its own name, and where it sits in the room. */
export function resolveForBroker(
  ids: ReadonlyArray<string>,
  dealId: string,
  docs: ReadonlyMap<string, Document>,
  snap: Pick<RoomSnapshot, "folders" | "items">,
  replacements: ReadonlyMap<string, string>,
): Record<string, ResolvedForBroker> {
  const numbers = indexNumbers(snap.folders, snap.items).items;
  const live = snap.items.filter((i) => !i.removedAt);
  const out: Record<string, ResolvedForBroker> = {};
  for (const id of ids) {
    const doc = docs.get(id);
    if (doc && doc.dealId === dealId) {
      const item = live.find((i) => i.documentId === id) ?? null;
      out[id] = { available: true, documentId: id, title: doc.name || doc.originalName || "Document", itemId: item?.id ?? null, number: item ? numbers.get(item.id) ?? null : null, inRoom: !!item, brokerOnly: doc.visibility === "broker_only" };
      continue;
    }
    const via = replacements.get(id);
    const newest = via ? live.find((i) => i.id === latestVersion(snap.items, via)) : undefined;
    const newDoc = newest?.documentId ? docs.get(newest.documentId) : undefined;
    out[id] = newest && newDoc && newDoc.dealId === dealId
      ? { available: true, documentId: newDoc.id, title: newDoc.name || newest.title, itemId: newest.id, number: numbers.get(newest.id) ?? null, inRoom: true, brokerOnly: newDoc.visibility === "broker_only", replaced: true }
      : { available: false };
  }
  return out;
}
