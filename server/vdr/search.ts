/**
 * Searching the room (vdr spec §6.2, §9.3): titles and the SERVED page text
 * (personal numbers covered, hidden words dropped) of the documents the
 * reader can open right now. Never a ledger (gl owns ledger search), never a
 * document the reader can't open. The term is matched literally
 * (ILIKE with %, _ and \ escaped); at most 50 hits.
 */
import { VDR_LIMITS } from "@shared/vdr";
import type { BuyerSearchHit } from "@shared/vdr-api";
import type { VdrStore } from "./store";

export function cleanQuery(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const t = q.replace(/\s+/g, " ").trim();
  if (t.length < VDR_LIMITS.searchMin || t.length > VDR_LIMITS.searchMax) return null;
  return t;
}

/** ~160 characters around the first match, split into plain and matched parts. */
export function snippet(text: string, q: string, radius = 70): Array<{ text: string; match: boolean }> {
  const flat = text.replace(/\s+/g, " ");
  const at = flat.toLowerCase().indexOf(q.toLowerCase());
  if (at < 0) return [{ text: flat.slice(0, radius * 2), match: false }];
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + q.length + radius);
  const out: Array<{ text: string; match: boolean }> = [];
  const before = (start > 0 ? "…" : "") + flat.slice(start, at);
  if (before) out.push({ text: before, match: false });
  out.push({ text: flat.slice(at, at + q.length), match: true });
  const after = flat.slice(at + q.length, end) + (end < flat.length ? "…" : "");
  if (after) out.push({ text: after, match: false });
  return out;
}

export async function searchRoom(
  store: VdrStore,
  dealId: string,
  items: ReadonlyArray<{ id: string; title: string; number: string | null; searchable: boolean }>,
  q: string,
): Promise<BuyerSearchHit[]> {
  const usable = items.filter((i) => i.searchable);
  const byId = new Map(usable.map((i) => [i.id, i]));
  const hits: BuyerSearchHit[] = [];
  const needle = q.toLowerCase();
  for (const it of usable) {
    if (it.title.toLowerCase().includes(needle)) hits.push({ itemId: it.id, number: it.number, title: it.title, page: 1, label: "Title", snippet: snippet(it.title, q) });
  }
  const rows = await store.searchPageText(dealId, usable.map((i) => i.id), q, VDR_LIMITS.searchHits);
  for (const r of rows) {
    const it = byId.get(r.itemId);
    if (!it) continue;
    hits.push({ itemId: r.itemId, number: it.number, title: it.title, page: r.page, label: r.label, snippet: snippet(r.text, q) });
    if (hits.length >= VDR_LIMITS.searchHits) break;
  }
  return hits.slice(0, VDR_LIMITS.searchHits);
}
