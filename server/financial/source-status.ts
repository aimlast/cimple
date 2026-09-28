/**
 * Which documents a financial analysis was built from, and whether they are
 * still what the deal has.
 *
 * The analysis recorded its source document ids but nothing read them, so
 * it never went stale: a P&L deleted as a mistake (another client's, a
 * draft) kept feeding the reviewed analysis — P&L, bridge, working capital —
 * into every CIM, and FY2024 statements uploaded after an FY2022–23
 * analysis left the CIM's tables at 2023 while the facts headlined 2024.
 * Nothing said a re-run was needed.
 *
 * Each source is now recorded with its role (statements, tax return,
 * other, private). A statement or tax document the analysis used that has
 * since been deleted blocks CIM generation until the analysis is re-run;
 * a statement or tax document added since is a warning (Financial Analysis
 * Center banner, CIM generation warning). Deleting any other source (a
 * photo, a transcript, a CRM note) changes nothing. Older rows recorded
 * bare ids: any deleted one is a warning. Pure.
 */

export type AnalysisSourceRole = "statements" | "tax" | "other" | "private";

export interface AnalysisSourceRef {
  id: string;
  name?: string;
  role?: AnalysisSourceRole;
}

export interface SourceDocLike {
  id: string;
  name: string;
  category: string | null;
  subcategory?: string | null;
  isProcessed?: boolean | null;
  extractedText?: string | null;
  extractedData?: unknown;
  visibility?: string | null;
  sourceKind?: string | null;
}

/** How brokers and accountants name statement files (the checklist's own aliases, plus balance sheets). */
const STATEMENT_NAME_RE =
  /\b(?:p\s*&\s*l|pnl|p\s*and\s*l|profit\s*(?:and|&)\s*loss|income\s*statements?|balance\s*sheets?|financial\s*statements?|statements?\s+of\s+(?:operations|earnings|income|financial\s+position)|trial\s+balance)\b/i;
const CORRESPONDENCE_RE = /\b(?:e-?mails?|thread|correspondence|transcript|call|meeting)\b|^\s*(?:re|fwd?)\s*:/i;

/**
 * A document that is a financial statement: filed as financials, or an
 * uncategorised upload named like one ("2024 P&L.pdf", "Profit and Loss
 * 2024.xlsx" — a seller's drop outside the checklist lands as "other").
 */
export function isFinancialStatementDoc(doc: Pick<SourceDocLike, "name" | "category">): boolean {
  if (doc.category === "financials") return true;
  const uncategorised = !doc.category || doc.category === "other";
  return uncategorised && STATEMENT_NAME_RE.test(doc.name ?? "") && !CORRESPONDENCE_RE.test(doc.name ?? "");
}

export function isTaxDocument(doc: Pick<SourceDocLike, "name" | "category" | "subcategory">): boolean {
  const s = `${doc.name} ${doc.category ?? ""} ${doc.subcategory ?? ""}`.toLowerCase();
  return /\btax\b|t2\b|t1\b|1120|1065|1040|notice of assessment|gifi/.test(s);
}

const isBrokerOnly = (d: Pick<SourceDocLike, "visibility" | "sourceKind">) => d.visibility === "broker_only" || d.sourceKind === "crm";

/** The role a document plays in the analysis. */
export function analysisSourceRole(doc: SourceDocLike): AnalysisSourceRole {
  if (isBrokerOnly(doc)) return "private";
  if (isFinancialStatementDoc(doc)) return "statements";
  if (isTaxDocument(doc)) return "tax";
  return "other";
}

/** The stored list, in either form (older rows: bare ids). */
export function readAnalysisSources(raw: unknown): AnalysisSourceRef[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((x): AnalysisSourceRef | null => {
      if (typeof x === "string" && x) return { id: x };
      if (x && typeof x === "object" && typeof (x as AnalysisSourceRef).id === "string") {
        const r = x as AnalysisSourceRef;
        return { id: r.id, ...(typeof r.name === "string" ? { name: r.name } : {}), ...(r.role ? { role: r.role } : {}) };
      }
      return null;
    })
    .filter((x): x is AnalysisSourceRef => !!x);
}

export interface AnalysisSourceStatus {
  /** Sources used that no longer exist. */
  removed: AnalysisSourceRef[];
  /** Statement / tax documents added (and read) since the analysis ran. */
  added: Array<{ id: string; name: string }>;
  /** A statement or tax document the analysis used was deleted: its figures can't go into a CIM. */
  blocking: boolean;
  /** One broker-facing sentence, or null when nothing changed. */
  message: string | null;
}

const hasContent = (d: SourceDocLike) => !!d.isProcessed && ((!!d.extractedText && d.extractedText.trim().length > 0) || !!d.extractedData);
const quote = (names: string[]) => names.map((n) => `“${n}”`).join(", ");

export function analysisSourceStatus(analysis: { sourceDocumentIds?: unknown } | null | undefined, docs: SourceDocLike[]): AnalysisSourceStatus {
  const refs = readAnalysisSources(analysis?.sourceDocumentIds);
  const none: AnalysisSourceStatus = { removed: [], added: [], blocking: false, message: null };
  if (!analysis || refs.length === 0) return none;
  const current = new Map(docs.map((d) => [d.id, d]));
  const used = new Set(refs.map((r) => r.id));
  // Only a financial source the figures came from matters: a deleted
  // photo, transcript or CRM note never makes the analysis out of date
  // (older rows recorded bare ids with no role — any of those still warns).
  const removed = refs.filter((r) => !current.has(r.id) && (!r.role || r.role === "statements" || r.role === "tax"));
  const added = docs
    .filter((d) => !used.has(d.id) && hasContent(d) && !isBrokerOnly(d) && (isFinancialStatementDoc(d) || isTaxDocument(d)))
    .map((d) => ({ id: d.id, name: d.name }));
  const blocking = removed.some((r) => r.role === "statements" || r.role === "tax");
  if (removed.length === 0 && added.length === 0) return none;
  const parts: string[] = [];
  const removedNamed = removed.filter((r) => r.name).map((r) => r.name!);
  if (removed.length > 0) {
    parts.push(
      removedNamed.length > 0
        ? `${removedNamed.length === 1 ? "a document it was built from has" : "documents it was built from have"} been deleted (${quote(removedNamed)}${removed.length > removedNamed.length ? ` and ${removed.length - removedNamed.length} more` : ""})`
        : `${removed.length === 1 ? "a document it was built from has" : `${removed.length} documents it was built from have`} been deleted`,
    );
  }
  if (added.length > 0) parts.push(`${added.length === 1 ? "a financial document was" : "financial documents were"} added since (${quote(added.map((a) => a.name))})`);
  return { removed, added, blocking, message: `The financial analysis is out of date: ${parts.join(", and ")}. Re-run it so the CIM's financials match the documents on file.` };
}
