/**
 * Links into the data room for other streams (vdr spec §11.1–§11.2,
 * INTEGRATION §2.6). gl and dd import these — they never build their own
 * data-room URL, title or route.
 *
 *   vdrAvailable           the data room exists in this build
 *   vdrDocumentHref(...)   a buyer's link to one document (gl's "Open the
 *                          general ledger in the data room →"), rows capped
 *                          at 500; inside the CIM, VdrLinkProvider opens it
 *                          in the drawer instead of navigating
 *   vdrBuyerHref / vdrBrokerHref   re-exported from shared/vdr
 */
import { VDR_LIMITS, vdrBrokerHref, vdrBuyerHref } from "@shared/vdr";

export const vdrAvailable = true;

export { vdrBrokerHref, vdrBuyerHref };

export function vdrDocumentHref(i: { token: string; documentId: string; ledgerRows?: ReadonlyArray<number> | null; fy?: string | null; page?: number | null; sheet?: string | null }): string {
  const rows = (i.ledgerRows ?? []).filter((n) => Number.isInteger(n) && n > 0).slice(0, VDR_LIMITS.rowsMax);
  return vdrBuyerHref({ token: i.token, documentId: i.documentId, rows: rows.length ? rows : null, fy: i.fy ?? null, page: i.page ?? null, sheet: i.sheet ?? null });
}

/** Parses a data-room link's query (`doc`, `document`, `page`, `rows`, `sheet`, `fy`, `needle`) — the drawer and the room read the same words. */
export function parseRoomLink(search: string): { itemId: string | null; documentId: string | null; page: number | null; rows: number[] | null; sheet: string | null; fy: string | null; needle: string | null } {
  const q = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const id = (v: string | null) => (v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null);
  const page = Number(q.get("page"));
  const rows = (q.get("rows") ?? "").split(",").map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, VDR_LIMITS.rowsMax);
  const sheet = q.get("sheet");
  const fy = q.get("fy");
  const needle = q.get("needle");
  return {
    itemId: id(q.get("doc")),
    documentId: id(q.get("document")),
    page: Number.isInteger(page) && page > 0 && page < 100_000 ? page : null,
    rows: rows.length ? rows : null,
    sheet: sheet && sheet.length <= 120 ? sheet : null,
    fy: fy && /^(FY)?\d{4}(-\d{2})?$/.test(fy) ? fy : null,
    needle: needle && needle.length <= 80 ? needle : null,
  };
}
