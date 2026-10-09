/**
 * locate — D11: a difference can be shown only if both figures are found in
 * their documents' text (with digit boundaries: "98,000" never inside
 * "1,398,000"; glued text such as "…charges86,000" is accepted). Run by the
 * refresh only; the results are stored (cim_figure_state.located, keyed by
 * the document's version + the value) and serving never reads document text.
 * A document new since the last refresh counts as not found (fail closed).
 *
 * Pure (the refresh passes the texts in). Page: vdr's locateNeedle when the
 * vdr stream is merged (INTEGRATION §2.6); until then the text's own page
 * marks (shared/figure-compare.ts pageAt).
 */
import { locatedIn } from "@shared/figure-compare";
import type { FigureLocatedEntry } from "@shared/schema";
import { locatedKey } from "./sources";

export interface LocateRequest {
  documentId: string;
  updatedAt: string;
  value: number;
}

/**
 * Locate every requested value not already in `known`. `textOf(documentId)`
 * gives the document's extracted text (null when there is none).
 */
export function locateValues(
  requests: LocateRequest[],
  textOf: (documentId: string) => string | null,
  known: Record<string, FigureLocatedEntry> = {},
): Record<string, FigureLocatedEntry> {
  const out: Record<string, FigureLocatedEntry> = {};
  for (const r of requests) {
    const key = locatedKey(r.documentId, r.updatedAt, r.value);
    if (known[key] || out[key]) continue;
    const hit = locatedIn(textOf(r.documentId), r.value);
    out[key] = hit ? { index: hit.index, page: hit.page, sourceLabel: hit.sourceLabel } : { missing: true };
  }
  return out;
}

/** The stored result for a value in a document version, or null when it was never located (= not found). */
export function locatedEntry(located: Record<string, FigureLocatedEntry>, documentId: string, updatedAt: string, value: number): { page: number | null; sourceLabel: string | null } | null {
  const e = located[locatedKey(documentId, updatedAt, value)];
  if (!e || "missing" in e) return null;
  return { page: e.page, sourceLabel: e.sourceLabel };
}
