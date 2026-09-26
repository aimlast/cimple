/**
 * merge-conflicts.ts — turns the material conflicts a fact merge saw (see
 * merge-policy.ts MergeConflict) into discrepancy rows with source "merge",
 * so a spoken "$2.3M" against the statements' "$1,820,000", or a call's
 * "about 2029" against the lease's "August 31, 2028", is put in front of the
 * broker instead of sitting silently in the alternates.
 *
 * Conventions (shared with the discrepancy engine / panel):
 *  - factKey is the extractedInfo key, factYear the year of a by-year map;
 *  - interviewValue holds the seller-side / spoken value (interview, call,
 *    video call, email, questionnaire), documentValue the document side;
 *    when neither or both sides are spoken, documentValue is the value kept
 *    on file;
 *  - sideSources records each side's kind, row and whether it is
 *    broker-only. Explanations never quote a broker-only source's title.
 * A conflict already raised (same fact, year and pair of values — any
 * status) is never raised again, so re-ingesting or reprocessing is quiet.
 */
import { storage } from "../storage";
import type { Document, InsertDiscrepancy } from "@shared/schema";
import { fieldLabel } from "../interview/interview-plan";
import { isDocumentAuthoritativeField, isPeriodFigure, periodYear, settleConflicts, HEADLINE_MAPS, type MergeConflict } from "./merge-policy";
import { numbersMateriallyConflict, typedNumericValues, type FieldSource } from "../interview/info-merger";

const SPOKEN_KINDS: ReadonlySet<string> = new Set(["interview", "call", "video_call", "email", "questionnaire"]);
const LEAD_KINDS: ReadonlySet<string> = new Set(["crm", "website", "social"]);
const HEADLINE_FIGURE = /^(annualRevenue|revenueByYear|sde|sdeByYear|ebitda|ebitdaByYear|adjustedEbitda|adjustedEbitdaByYear|netIncome|netIncomeByYear|grossProfit|grossProfitByYear)$/;

const KIND_TEXT: Record<string, string> = {
  interview: "the seller in the interview",
  call: "a call",
  video_call: "a video call",
  email: "an email",
  questionnaire: "the intake questionnaire",
  document: "a document",
  crm: "your CRM note",
  website: "the website",
  social: "social media",
  broker: "your edit",
  system: "an earlier record",
};

/** A value for dedupe: its first figure to 2 significant digits ("$6.1M" = "$6,105,400" = "$6.11M"), else its words. */
function valueBucket(v: string | null | undefined): string {
  const t = (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const n = typedNumericValues(t)[0];
  return n ? `#${n.kind}:${Number(n.value.toPrecision(2))}` : t;
}

/** A figure and its by-year map are one fact for dedupe (ebitda ≡ ebitdaByYear, ownerSalary ≡ ownerSalaryByYear). */
function factFamily(factKey: string): string {
  const headline = HEADLINE_MAPS.find((p) => p.head === factKey)?.map;
  if (headline) return headline;
  return /ByYear$/.test(factKey) ? factKey : `${factKey}ByYear`;
}

function pairKey(factKey: string, factYear: string | null | undefined, a: string | null | undefined, b: string | null | undefined): string {
  const [x, y] = [valueBucket(a), valueBucket(b)].sort();
  return `${factFamily(factKey)}|${factYear ?? ""}|${x}|${y}`;
}

export interface DiscrepancyDraft extends Omit<InsertDiscrepancy, "dealId"> {}

/**
 * Pure: the discrepancy row for one conflict (without dealId). `docName`
 * resolves a documents row to its title (never used for broker-only rows).
 */
export function discrepancyForConflict(c: MergeConflict, docName: (id: string) => string | undefined): DiscrepancyDraft {
  const w = c.winner;
  const l = c.loser;
  const spokenW = SPOKEN_KINDS.has(String(w.src.source));
  const spokenL = SPOKEN_KINDS.has(String(l.src.source));
  const [interviewSide, documentSide] = spokenW && !spokenL ? [w, l] : spokenL && !spokenW ? [l, w] : [l, w];
  const sideSource = (s: FieldSource) => ({
    kind: s.source,
    ...(s.documentId ? { documentId: s.documentId } : {}),
    ...(s.brokerOnly ? { brokerOnly: true } : {}),
  });
  const describe = (s: FieldSource) => {
    const kind = KIND_TEXT[String(s.source)] ?? "a source";
    if (!s.documentId || s.brokerOnly) return kind;
    const name = docName(s.documentId);
    return name ? `${kind} ("${name}")` : kind;
  };
  const label = `${fieldLabel(c.factKey.replace(/ByYear$/, ""))}${c.factYear ? ` (${c.factYear})` : ""}`;
  const lead = LEAD_KINDS.has(String(w.src.source)) || LEAD_KINDS.has(String(l.src.source));
  // Two different kinds of document (the statements vs a tax return) often
  // define a figure differently — worth a look, rarely an error.
  const docTypes = w.src.source === "document" && l.src.source === "document" && !!w.src.specialist !== !!l.src.specialist;
  const bigGap = numbersMateriallyConflict(w.value, l.value, 0.1);
  const severity = lead || docTypes
    ? "minor"
    : HEADLINE_FIGURE.test(c.factKey) && bigGap
      ? "critical"
      : isDocumentAuthoritativeField(c.factKey) || isPeriodFigure(c.factKey)
        ? "significant"
        : "minor";
  const category = isPeriodFigure(c.factKey)
    ? "financial"
    : /lease|rent|landlord|shareholder|director|officer|incorporat|licen|permit|entityType|legalName/i.test(c.factKey)
      ? "legal"
      : /employee|staff|customer|supplier|equipment|asset|fleet|certif/i.test(c.factKey)
        ? "operational"
        : "factual";
  const why = w.src.source === l.src.source
    ? "it is the more recent of the two"
    : isDocumentAuthoritativeField(c.factKey) && w.src.source === "document"
      ? "a document is the authority on this figure"
      : w.src.specialist
        ? "it comes from the source dedicated to this"
        : "that source ranks higher";
  return {
    field: label,
    interviewValue: interviewSide.value,
    documentValue: documentSide.value,
    documentId: documentSide.src.documentId ?? null,
    documentName: documentSide.src.documentId && !documentSide.src.brokerOnly ? docName(documentSide.src.documentId) ?? null : null,
    severity,
    category,
    source: "merge",
    factKey: c.factKey,
    factYear: c.factYear ?? null,
    sideSources: { interview: sideSource(interviewSide.src), document: sideSource(documentSide.src) },
    aiExplanation: `${describe(w.src)} and ${describe(l.src)} give different values for ${label}. The value from ${describe(w.src)} is on file because ${why}; the other is kept as another value.`,
    suggestedResolution: "Confirm which value is right, or enter the correct one.",
    status: "open",
  } as DiscrepancyDraft;
}

/**
 * Persists the conflicts a merge collected as open "merge" discrepancies,
 * skipping any the deal already has (same fact, year and pair of values, in
 * any status) and duplicates within the batch. Returns how many were created.
 */
export async function recordMergeConflicts(
  dealId: string,
  collected: MergeConflict[],
  documents: Array<Pick<Document, "id" | "name">>,
  /** The facts as saved — only conflicts still standing against them are raised. */
  finalInfo?: Record<string, unknown>,
): Promise<number> {
  const conflicts = finalInfo ? settleConflicts(finalInfo, collected) : collected;
  if (conflicts.length === 0) return 0;
  const fresh = conflictsNotYetRaised(await storage.getDiscrepanciesByDeal(dealId), conflicts);
  const names = new Map(documents.map((d) => [d.id, d.name]));
  for (const c of fresh) {
    await storage.createDiscrepancy({ dealId, ...discrepancyForConflict(c, (id) => names.get(id)) } as InsertDiscrepancy);
  }
  return fresh.length;
}

/** An existing discrepancy row, as far as deduplication reads it. */
export type RaisedRow = { factKey?: string | null; factYear?: string | null; interviewValue?: string | null; documentValue?: string | null };

/**
 * Pure: the conflicts not raised yet (any status). A dispute is the same
 * fact (family) and the same two values: for one year of a map, that year; a
 * stand-alone figure's row is stored without a year, so it matches the same
 * two values whatever year its sources were for — otherwise every reprocess
 * raised it again. Duplicates within the batch collapse too.
 */
export function conflictsNotYetRaised(existingRows: RaisedRow[], conflicts: MergeConflict[]): MergeConflict[] {
  const existing = existingRows.filter((d) => d.factKey);
  const seenYear = new Set(existing.filter((d) => d.factYear).map((d) => pairKey(d.factKey!, d.factYear, d.interviewValue, d.documentValue)));
  const seenUndated = new Set(existing.filter((d) => !d.factYear).map((d) => pairKey(d.factKey!, "*", d.interviewValue, d.documentValue)));
  const seenAny = new Set(existing.map((d) => pairKey(d.factKey!, "*", d.interviewValue, d.documentValue)));
  const out: MergeConflict[] = [];
  for (const c of conflicts) {
    // A headline conflict is about its period's year (ebitda ↔ ebitdaByYear.2024).
    const year = c.factYear ?? periodYear(c.winner.src.period) ?? periodYear(c.loser.src.period);
    const key = pairKey(c.factKey, year, c.winner.value, c.loser.value);
    const anyKey = pairKey(c.factKey, "*", c.winner.value, c.loser.value);
    if (seenYear.has(key) || seenUndated.has(anyKey) || (!c.factYear && seenAny.has(anyKey))) continue;
    seenYear.add(key);
    seenAny.add(anyKey);
    if (!c.factYear) seenUndated.add(anyKey);
    out.push(c);
  }
  return out;
}
