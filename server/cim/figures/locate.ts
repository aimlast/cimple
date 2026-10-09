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
import { labelMeansLine } from "@shared/figure-lines";
import type { FigureLocatedEntry } from "@shared/schema";
import { locatedKey } from "./sources";

export interface LocateRequest {
  documentId: string;
  updatedAt: string;
  value: number;
  /**
   * A figure the broker typed ("Cimple read it wrong"): found only where the
   * document's own label for it means this line ("Interest and bank charges"
   * for interest) — never on "Inventories" because the number happens to be
   * printed there (checker r2 R2-1).
   */
  line?: string | null;
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
    const key = locatedKey(r.documentId, r.updatedAt, r.value, r.line);
    if (known[key] || out[key]) continue;
    const line = r.line;
    const hit = locatedIn(textOf(r.documentId), r.value, line ? (h) => labelMeansLine(h.sourceLabel, line) : undefined);
    out[key] = hit ? { index: hit.index, page: hit.page, sourceLabel: hit.sourceLabel } : { missing: true };
  }
  return out;
}

/** The stored result for a value in a document version (on that line, when given), or null when it was never located (= not found). */
export function locatedEntry(located: Record<string, FigureLocatedEntry>, documentId: string, updatedAt: string, value: number, line?: string | null): { page: number | null; sourceLabel: string | null } | null {
  const e = located[locatedKey(documentId, updatedAt, value, line)];
  if (!e || "missing" in e) return null;
  return { page: e.page, sourceLabel: e.sourceLabel };
}
