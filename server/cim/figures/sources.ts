/**
 * sources — the deal's documents that state the financial figures: financial
 * statements, tax returns (T2, 1120, 1120-S, 1065) and management accounts
 * (full fiscal years only), with the per-year values their extraction found
 * (documents.extracted_data `*ByYear`). Spec D4. Pure.
 *
 * Only documents that may be cited are used (vdr's rule: a real document,
 * shared, with a file — never broker-only, email, call or CRM material), and
 * never an interim / YTD / TTM one.
 */
import { FIGURE_LINES, type StandardLineId } from "@shared/figure-lines";
import { parseShownAmount } from "@shared/figure-anchors";
import { fiscalYearKey } from "@shared/fiscal-year";
import { figureCitableDocument, type FigureDocKind, type FigureDocRef } from "@shared/figure-layer";
import { taxFormOf } from "@shared/figure-copy";

export interface SourceDoc {
  id: string;
  name: string | null;
  category: string | null;
  subcategory: string | null;
  visibility: string | null;
  sourceKind: string | null;
  fileUrl: string | null;
  updatedAt: Date | string | null;
  extractedData: Record<string, unknown> | null;
}

export type FinancialSourceKind = "statements" | "tax_return" | "management";

export interface FinancialSource {
  documentId: string;
  kind: FinancialSourceKind;
  /** "T2", "1120", "1120-S", "1065" for tax returns; null otherwise / unknown. */
  taxForm: string | null;
  /** The fiscal year the document is for. */
  year: string;
  /** line → year → value (own year + any comparatives). */
  values: Partial<Record<StandardLineId, Record<string, number>>>;
  /** ISO of the document row's last change (part of the located key). */
  updatedAt: string;
  docKind: FigureDocKind;
}

const PART_YEAR = /\binterim\b|\bytd\b|year[- ]to[- ]date|\bttm\b|\bltm\b|trailing|\b\d{1,2}[- ]months?\b|\bq[1-4]\b|quarter|half[- ]year|\bdraft\b|projected|forecast|budget/i;
const TAX = /\bT2\b|tax return|\b1120(?:-?S)?\b|\b1065\b|\bT5013\b/i;
const MANAGEMENT = /management (?:accounts|reports?|p&l|income statements?|financials)|internal (?:p&l|financials|income statements?|financial statements)/i;
const STATEMENTS = /financial statements?|compilation|compiled|review engagement|reviewed statements|audited|notice to reader|income statement and balance sheet/i;

/** What kind of financial record a document is, by its extracted type and name. */
export function sourceKindOf(doc: Pick<SourceDoc, "name" | "extractedData">): FinancialSourceKind | null {
  const type = String((doc.extractedData ?? {})._documentType ?? "");
  const text = `${type} ${doc.name ?? ""}`;
  if (PART_YEAR.test(text)) return null;
  if (TAX.test(text)) return "tax_return";
  if (MANAGEMENT.test(text)) return "management";
  if (STATEMENTS.test(text)) return "statements";
  return null;
}

function isoOf(v: Date | string | null | undefined): string {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
}

/** The year a document is for: its period end, else a year in its name, else the latest year it states. */
function yearOf(doc: SourceDoc, values: FinancialSource["values"]): string | null {
  const pe = String((doc.extractedData ?? {})._periodEnd ?? "");
  const m = pe.match(/^((?:19|20)\d{2})-\d{2}-\d{2}$/);
  if (m) return m[1];
  const fromName = String(doc.name ?? "").match(/\b(?:FY\s?)?((?:19|20)\d{2})\b/);
  if (fromName) return fiscalYearKey(fromName[1]);
  const years = Object.values(values).flatMap((v) => Object.keys(v ?? {})).sort();
  return years[years.length - 1] ?? null;
}

export function financialSources(docs: SourceDoc[], citable: (doc: SourceDoc) => boolean = figureCitableDocument): FinancialSource[] {
  const out: FinancialSource[] = [];
  for (const doc of docs) {
    if (!citable(doc)) continue;
    const kind = sourceKindOf(doc);
    if (!kind) continue;
    const ed = (doc.extractedData ?? {}) as Record<string, unknown>;
    const values: FinancialSource["values"] = {};
    for (const line of FIGURE_LINES) {
      for (const key of line.factKeys) {
        const map = ed[key];
        if (!map || typeof map !== "object" || Array.isArray(map)) continue;
        for (const [year, raw] of Object.entries(map as Record<string, unknown>)) {
          if (!/^\d{4}$/.test(year)) continue;
          const shown = parseShownAmount(raw);
          if (!shown) continue;
          const slot = (values[line.id] ??= {});
          if (slot[year] === undefined) slot[year] = line.expense ? Math.abs(shown.value) : shown.value;
        }
      }
    }
    if (Object.keys(values).length === 0) continue;
    const year = yearOf(doc, values);
    if (!year) continue;
    out.push({
      documentId: doc.id,
      kind,
      taxForm: kind === "tax_return" ? taxFormOf({ documentType: String(ed._documentType ?? ""), name: doc.name }) : null,
      year,
      values,
      updatedAt: isoOf(doc.updatedAt),
      docKind: kind === "tax_return" ? "tax_return" : "financial_statements",
    });
  }
  return out;
}

/** The document of a kind for a fiscal year (the newest when two claim it). */
export function sourceFor(sources: FinancialSource[], kind: FinancialSourceKind, year: string): FinancialSource | null {
  return sources.filter((s) => s.kind === kind && s.year === year).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0] ?? null;
}

/** The own-year value of a line in a source. */
export function ownValue(src: FinancialSource | null, line: StandardLineId): number | undefined {
  return src?.values[line]?.[src.year];
}

/** The key a located result is stored under: document version + value (a new upload is not located until refreshed). */
export function locatedKey(documentId: string, updatedAt: string, value: number): string {
  return `${documentId}@${updatedAt}#${Math.round(Math.abs(value))}`;
}

/** A citation of a source (the period as the fiscal year; the page when located). */
export function sourceRef(src: FinancialSource, opts: { page?: number | null; value?: number } = {}): FigureDocRef {
  return {
    documentId: src.documentId,
    kind: src.docKind,
    period: src.year,
    page: opts.page ?? null,
    needle: typeof opts.value === "number" ? Math.round(Math.abs(opts.value)).toLocaleString("en-US") : null,
  };
}

/** The statements-as-issued value of each line in each fiscal year (the newest statements for that year). */
export function statementValuesByYear(sources: FinancialSource[]): Record<string, Partial<Record<StandardLineId, number>>> {
  const out: Record<string, Partial<Record<StandardLineId, number>>> = {};
  const years = Array.from(new Set(sources.filter((s) => s.kind === "statements").map((s) => s.year)));
  for (const y of years) {
    const st = sourceFor(sources, "statements", y);
    if (!st) continue;
    for (const [line, byYear] of Object.entries(st.values) as Array<[StandardLineId, Record<string, number>]>) {
      if (typeof byYear?.[y] === "number") (out[y] ??= {})[line] = byYear[y];
    }
  }
  return out;
}
