/**
 * Financial Document Extractor
 *
 * Uses Claude (claude-sonnet-4-5) to extract structured, line-item-level
 * financial data from document text (P&L, balance sheet, cash flow, AR aging).
 *
 * Handles raw statements AND broker/valuation workbooks (multi-sheet Excel
 * exports with recast statements, commentary columns, and summary sheets) —
 * the most common real-world input is a broker's valuation workbook, not a
 * clean accountant-prepared statement.
 */

import Anthropic from "@anthropic-ai/sdk";
import { splitSourceText } from "../documents/extractor";

const anthropic = new Anthropic({ timeout: 600_000 });

// ── Types ──

export interface LineItem {
  label: string;
  amounts: Record<string, number>; // keyed by period, e.g. "2023": 150000
  category: string; // e.g. "revenue", "cogs", "operating_expenses"
  subcategory?: string;
  isSubtotal?: boolean;
  isTotal?: boolean;
  notes?: string;
}

export interface ExtractedStatement {
  statementType: "income_statement" | "balance_sheet" | "cash_flow" | "ar_aging";
  periods: string[]; // e.g. ["2021", "2022", "2023"] or ["Q1 2023", "Q2 2023"]
  lineItems: LineItem[];
  currency: string;
  basisOfAccounting?: "cash" | "accrual" | "unknown";
  sourceDocumentId: string;
  sourceDocumentName?: string;
  confidence: number; // 0-1
  notes: string[];
}

// ── Extraction ──

/** One read covers at most this much of a statement pack; a longer one is read in parts. */
export const FIN_PART_CHARS = 80_000;
/** At most this many parts are read (about 480K characters); anything beyond is noted as not read. */
export const FIN_MAX_PARTS = 6;

export async function extractFinancialData(
  documentText: string,
  documentId: string,
  documentName: string,
): Promise<ExtractedStatement[]> {
  return extractFinancialDataInParts(documentText, documentId, documentName, extractFinancialPart);
}

type PartReader = (text: string, documentId: string, documentName: string, partLabel?: string) => Promise<ExtractedStatement[]>;

const RECAST = /\b(?:recast|normali[sz]ed|adjusted|pro ?forma)\b/i;
const isRecast = (s: ExtractedStatement) => RECAST.test([...(s.notes ?? []), ...s.lineItems.map((l) => l.label)].join(" "));
const labelKey = (l: LineItem) => `${l.category}|${String(l.label ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;

/**
 * One statement from two parts of the same pack: the periods of both, each
 * line item once with every period's amount (the one already read wins a
 * period both state — the overlap between parts).
 */
function mergeStatement(a: ExtractedStatement, b: ExtractedStatement): ExtractedStatement {
  const items = a.lineItems.map((l) => ({ ...l, amounts: { ...l.amounts } }));
  const byKey = new Map(items.map((l) => [labelKey(l), l]));
  for (const l of b.lineItems) {
    const hit = byKey.get(labelKey(l));
    if (hit) {
      for (const [p, v] of Object.entries(l.amounts ?? {})) if (!(p in hit.amounts)) hit.amounts[p] = v;
    } else {
      const copy = { ...l, amounts: { ...l.amounts } };
      items.push(copy);
      byKey.set(labelKey(copy), copy);
    }
  }
  const periods = Array.from(new Set([...(a.periods ?? []), ...(b.periods ?? [])]));
  return {
    ...a,
    periods,
    lineItems: items,
    confidence: Math.min(a.confidence ?? 1, b.confidence ?? 1),
    notes: Array.from(new Set([...(a.notes ?? []), ...(b.notes ?? [])])),
  };
}

/**
 * The statements of a long pack, read part by part: the same statement read
 * in two parts (FY2022 in the first, FY2024 in the third — or a table cut at
 * a boundary) becomes one statement with every period. Raw and recast
 * versions of a statement are never merged into each other, and two
 * statements one part read stay two.
 */
export function combinePartStatements(parts: ExtractedStatement[][]): ExtractedStatement[] {
  const out: ExtractedStatement[] = [];
  for (const statements of parts) {
    const fromThisPart = new Set<number>();
    for (const s of statements) {
      const i = out.findIndex((e, k) => {
        if (fromThisPart.has(k)) return false;
        if (e.statementType !== s.statementType || (e.currency || "") !== (s.currency || "") || isRecast(e) !== isRecast(s)) return false;
        const ep = new Set(e.periods ?? []);
        const shared = (s.periods ?? []).filter((p) => ep.has(p));
        if (shared.length === 0) return true; // other years of the same statement
        // The same years again (the overlap, or a table cut in two): the same statement when their lines agree.
        const ek = new Set(e.lineItems.map(labelKey));
        const common = s.lineItems.filter((l) => ek.has(labelKey(l))).length;
        return common >= Math.min(3, s.lineItems.length) && common / Math.max(1, Math.min(e.lineItems.length, s.lineItems.length)) >= 0.5;
      });
      if (i >= 0) {
        out[i] = mergeStatement(out[i], s);
        fromThisPart.add(i);
      } else {
        out.push(s);
        fromThisPart.add(out.length - 1);
      }
    }
  }
  return out;
}

/**
 * Reads a statement document in full: up to FIN_PART_CHARS in one read, a
 * longer pack (three years of audited statements, a combined tax pack) in
 * parts at page / sheet boundaries (splitSourceText), combined per
 * statement. It used to read only the first 80,000 characters, so the
 * latest years of a chronological pack never reached the analysis. Text
 * beyond FIN_MAX_PARTS parts is noted on every statement as not read
 * (unreadFinancialText gives it to the analysis as raw text).
 */
export async function extractFinancialDataInParts(
  documentText: string,
  documentId: string,
  documentName: string,
  readPart: PartReader,
): Promise<ExtractedStatement[]> {
  if (!documentText || documentText.trim().length < 50) {
    return [];
  }
  const all = splitSourceText(documentText, FIN_PART_CHARS);
  if (all.length === 1) return readPart(documentText, documentId, documentName);
  const parts = all.slice(0, FIN_MAX_PARTS);
  const results: ExtractedStatement[][] = [];
  for (let i = 0; i < parts.length; i++) {
    try {
      results.push(await readPart(parts[i], documentId, documentName, `part ${i + 1} of ${all.length}`));
    } catch (err: any) {
      // One part failing must not lose the others.
      console.error(`Financial extraction of "${documentName}" part ${i + 1}/${all.length} failed — continuing:`, err?.message ?? err);
      results.push([]);
    }
  }
  const combined = combinePartStatements(results);
  const unread = unreadFinancialText(documentText);
  const note = unread
    ? `Read in ${parts.length} parts; the last ${all.length - parts.length} part(s) of "${documentName}" (about ${Math.round((100 * unread.length) / documentText.length)}% of the text) were not read as statements.`
    : `Read in ${parts.length} parts.`;
  return combined.map((s) => ({ ...s, notes: [...(s.notes ?? []), note] }));
}

/** The text of a statement document past what the structured read covers ("" when it read it all). */
export function unreadFinancialText(documentText: string): string {
  const all = splitSourceText(documentText || "", FIN_PART_CHARS);
  if (all.length <= FIN_MAX_PARTS) return "";
  const lastRead = all[FIN_MAX_PARTS - 1];
  const end = documentText.indexOf(lastRead) + lastRead.length;
  return end > 0 ? documentText.slice(end) : all.slice(FIN_MAX_PARTS).join("");
}

async function extractFinancialPart(
  documentText: string,
  documentId: string,
  documentName: string,
  partLabel?: string,
): Promise<ExtractedStatement[]> {

  // Streamed to keep the connection alive — these generations run for minutes
  // and idle non-streaming requests get killed by network timeouts.
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5",
    max_tokens: 16000,
    // Extraction is transcription, not judgement — the same document must
    // yield the same line items on every run.
    temperature: 0,
    messages: [
      {
        role: "user",
        content: `You are a senior M&A financial analyst. Extract structured financial data from the following document text.

DOCUMENT NAME: ${documentName}${partLabel ? `\n\nThis is ${partLabel} of a long document read in parts: extract every statement, or part of a statement, in THIS text with the periods it shows.` : ""}

DOCUMENT TEXT:
${documentText.slice(0, FIN_PART_CHARS)}

INSTRUCTIONS:
1. Identify every financial statement present. This includes:
   - Clean statements: income statement / P&L, balance sheet, cash flow statement, AR aging schedule
   - VALUATION / RECAST WORKBOOKS: broker workbooks are multi-sheet Excel exports (sheets marked like "--- Sheet: 1-IS ---"). They contain historical income statements, recast/normalized P&Ls, SDE schedules, and balance sheets — often as CSV-like rows with commentary in trailing columns. Treat a recast income statement sheet as an income_statement; treat a balance sheet sheet as a balance_sheet. Ignore commentary/notes columns when reading amounts, but the commentary may clarify what a line item is.
2. For each statement, extract EVERY line item with its label, period amounts, and category. Numbers may be formatted like " 898,079 " or "(71,712)" — parentheses mean negative.
3. Preserve the original line-item labels exactly as they appear (without commentary text).
4. Map each line item to a standard category:
   - Income statement: revenue, cogs, gross_profit, operating_expenses, depreciation_amortization, interest, taxes, other_income, other_expense, net_income
   - Balance sheet: current_assets, fixed_assets, other_assets, current_liabilities, long_term_liabilities, equity
   - Cash flow: operating, investing, financing
   - AR aging: current, 30_days, 60_days, 90_days, over_90_days
5. Identify periods (years or quarters). If a workbook mixes sources per column (e.g. "2025 Internal Statements, 2024 Tax Return"), keep the period keys simple ("2025", "2024") and record the source mix in notes.
6. Detect currency (default USD if unclear; Canadian businesses are usually CAD).
7. Note the basis of accounting if detectable (cash vs accrual).
8. Provide a confidence score (0-1) for the extraction quality.
9. Include any notes about anomalies, missing data, source mix per column, or assumptions.
10. If the same statement appears twice (e.g. raw and recast), extract both and note which is which.

Respond with valid JSON only — an array of extracted statements. Each element:
{
  "statementType": "income_statement" | "balance_sheet" | "cash_flow" | "ar_aging",
  "periods": ["2021", "2022", "2023"],
  "lineItems": [
    {
      "label": "Gross Revenue",
      "amounts": { "2021": 500000, "2022": 600000, "2023": 720000 },
      "category": "revenue",
      "subcategory": "gross_revenue",
      "isSubtotal": false,
      "isTotal": false,
      "notes": ""
    }
  ],
  "currency": "USD",
  "basisOfAccounting": "accrual",
  "confidence": 0.92,
  "notes": ["2025 column is from internal statements; 2022-2024 from tax returns"]
}

If no financial statements are found, return an empty array [].`,
      },
    ],
  });
  const response = await stream.finalMessage();

  if (response.stop_reason === "max_tokens") {
    console.warn(
      `Financial extraction for "${documentName}" hit the output token limit — result may be truncated.`,
    );
  }

  try {
    const text =
      response.content[0].type === "text" ? response.content[0].text : "";
    const { parseJsonLoose } = await import("./shape");
    // Only an answer shaped like one: an array of statements (or none), a
    // lone statement, or { statements: [...] } — never an example object
    // quoted in prose before the real "[]".
    const isStatement = (x: unknown) => !!x && typeof x === "object" && !Array.isArray(x) && Array.isArray((x as { lineItems?: unknown }).lineItems);
    const raw = parseJsonLoose<unknown>(text, (v) =>
      Array.isArray(v)
        ? v.every(isStatement)
        : isStatement(v) || (!!v && typeof v === "object" && Array.isArray((v as { statements?: unknown }).statements)),
    );
    // An array of statements as asked; a lone statement object, or one
    // wrapped as { statements: [...] }, is the same answer.
    const parsed: ExtractedStatement[] | null = Array.isArray(raw)
      ? raw
      : raw && typeof raw === "object" && Array.isArray((raw as { statements?: unknown }).statements)
        ? (raw as { statements: ExtractedStatement[] }).statements
        : raw && typeof raw === "object" && Array.isArray((raw as { lineItems?: unknown }).lineItems)
          ? [raw as ExtractedStatement]
          : null;
    if (!Array.isArray(parsed)) return [];

    // Attach source document ID + name, drop empty statements
    return parsed
      .filter((stmt) => stmt && Array.isArray(stmt.lineItems) && stmt.lineItems.length > 0)
      .map((stmt) => ({
        ...stmt,
        sourceDocumentId: documentId,
        sourceDocumentName: documentName,
      }));
  } catch (err) {
    console.error(`Failed to parse financial extraction response for "${documentName}":`, err);
    return [];
  }
}
