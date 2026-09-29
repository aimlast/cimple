/**
 * Addback Verification Engine
 *
 * AI-powered system that matches addbacks to actual transactions in GL,
 * QuickBooks exports, or bank statements. Provides transaction-level
 * corroboration for every addback in the normalization schedule.
 *
 * Two workflows:
 *  A) Addbacks already provided — verify against uploaded transaction data
 *  B) Addbacks identified from scratch — discover addbacks from raw transactions
 */

import Anthropic from "@anthropic-ai/sdk";
import { parseJsonLoose } from "./shape";
import { ADDBACK_MATCH_TOLERANCE, addbackSupport, claimPeriodYears, claimWords, periodLabel, wholeYears } from "@shared/addback-support";

/** The model client (a stub in tests: _setAddbackClientForTests). */
interface AddbackClient {
  messages: { create: (params: any) => Promise<{ content: Array<{ type: string; text?: string }>; stop_reason?: string | null }> };
}
let anthropic: AddbackClient = new Anthropic({ timeout: 600_000 }) as unknown as AddbackClient;
export function _setAddbackClientForTests(client: AddbackClient): void {
  anthropic = client;
}

/** Transactions sent to the model in one call (more would overflow its context). */
export const MAX_TRANSACTIONS_PER_CALL = 2000;
/** Characters of a non-tabular source (a PDF bank statement) read per parse call — its output must fit the reply. */
export const PARSE_CHUNK_CHARS = 12_000;
/** Parse calls per source; text past them is recorded as not read. */
export const MAX_PARSE_CHUNKS = 20;

const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

/**
 * Every AI call here must return a bare JSON array, but Claude routinely wraps
 * it in ```json fences or a one-line preamble. JSON.parse on the raw text used
 * to fail silently and return [] — a clean GL export became "0 transactions"
 * and every addback "No Match". Parse loosely, and when it still is not an
 * array say so in the log with enough context to debug.
 */
function parseAiArray(content: string, what: string): any[] | null {
  try {
    const parsed = parseJsonLoose(content);
    if (Array.isArray(parsed)) return parsed;
    // Some responses wrap the array in an object ({ "transactions": [...] })
    if (parsed && typeof parsed === "object") {
      const firstArray = Object.values(parsed as Record<string, unknown>).find(Array.isArray);
      if (firstArray) return firstArray as any[];
    }
    console.error(`[addback-verifier] ${what}: AI response was JSON but not an array (got ${typeof parsed})`);
    return null;
  } catch (err: any) {
    console.error(`[addback-verifier] ${what}: could not parse AI response — ${err?.message ?? err}. First 200 chars: ${JSON.stringify((content || "").slice(0, 200))}`);
    return null;
  }
}

// ── Direct CSV / tab-delimited fast path ──

const CATEGORY_KEYWORDS: Array<[RegExp, string]> = [
  [/payroll|salary|salaries|wage|wages|cpp|ei |employer|benefit/i, "payroll"],
  [/rent|lease|occupancy/i, "rent"],
  [/hydro|electric|gas bill|water|utilit|internet|phone|telecom/i, "utilities"],
  [/insurance|wsib|premium/i, "insurance"],
  [/legal|accounting|bookkeep|consult|professional|cpa|lawyer/i, "professional_fees"],
  [/owner|shareholder|draw|dividend|management fee/i, "owner_draw"],
  [/travel|flight|hotel|airfare|mileage/i, "travel"],
  [/meal|restaurant|entertain|coffee/i, "meals"],
  [/vehicle|auto|fuel|car |truck|parking/i, "vehicle"],
  [/supplies|office|stationery|software|subscription/i, "supplies"],
  [/deprec|amortiz/i, "depreciation"],
  [/interest|loan|bank charge|finance charge/i, "interest"],
  [/tax|hst|gst|cra|irs/i, "taxes"],
  [/sales|revenue|income|deposit|invoice/i, "revenue"],
];

function guessCategory(...texts: string[]): string {
  const joined = texts.join(" ");
  for (const [re, category] of CATEGORY_KEYWORDS) {
    if (re.test(joined)) return category;
  }
  return "other";
}

function splitDelimited(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === delimiter && !inQuotes) {
      out.push(cur.trim());
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseMoney(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (!s || s === "-" || s === "—") return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (s.endsWith("-")) { negative = true; s = s.slice(0, -1); }
  if (s.startsWith("-")) { negative = true; s = s.slice(1); }
  s = s.replace(/^(cr|dr)\s*/i, "").replace(/[$€£,\s]/g, "").replace(/(cad|usd)$/i, "");
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function normalizeDate(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (iso) return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  const parsed = new Date(s);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  // Unparseable and no digits at all ("Total", "Opening balance") — not a date
  return /\d/.test(s) ? s : "";
}

interface ColumnMap {
  date: number;
  description: number;
  amount: number;
  debit: number;
  credit: number;
  account: number;
}

function detectColumns(headers: string[]): ColumnMap | null {
  const lower = headers.map((h) => h.toLowerCase().trim());
  const date = lower.findIndex((h) => /(^|\b)(date|posted|posting)(\b|$)/.test(h) || h === "dt");
  const description = lower.findIndex((h) => /description|memo|payee|narrative|particulars|details|^name$|vendor|merchant/.test(h));
  const debit = lower.findIndex((h) => /^debit|\bdebit\b|withdrawal|^dr$|money out|payment/.test(h));
  const credit = lower.findIndex((h) => /^credit|\bcredit\b|deposit|^cr$|money in|receipt/.test(h));
  const amount = lower.findIndex((h) => /^amount|\bamount\b|^total$|^value$|net amount/.test(h) && !/balance/.test(h));
  const account = lower.findIndex((h) => /account|category|^class$|^split$|gl code|g\/l|ledger/.test(h) && !/^account ?(no|number|#)/.test(h));
  if (date === -1 || (amount === -1 && debit === -1 && credit === -1)) return null;
  return { date, description, amount, debit, credit, account };
}

/**
 * Parse a CSV / TSV general ledger, bank export, or QuickBooks detail report
 * directly — no model call. Handles quoted fields, Debit/Credit split columns,
 * "(1,234.00)" negatives, and multi-sheet workbook text (each sheet's header
 * row is re-detected). Returns [] when no usable header row is found so the
 * caller can fall back to the AI parser.
 */
export function parseTransactionsFromCsv(
  text: string,
  sourceType: "gl" | "bank" | "quickbooks",
  documentId: string,
): ParsedTransaction[] {
  void documentId;
  const lines = (text || "").split(/\r?\n/);
  const out: ParsedTransaction[] = [];
  let columns: ColumnMap | null = null;
  let delimiter = ",";

  const pickDelimiter = (line: string) => {
    const counts: Array<[string, number]> = [
      ["\t", (line.match(/\t/g) || []).length],
      [",", (line.match(/,/g) || []).length],
      [";", (line.match(/;/g) || []).length],
      ["|", (line.match(/\|/g) || []).length],
    ];
    counts.sort((a, b) => b[1] - a[1]);
    return counts[0][1] > 0 ? counts[0][0] : ",";
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^---\s*sheet:/i.test(line)) { columns = null; continue; }

    if (!columns) {
      const d = pickDelimiter(line);
      const headers = splitDelimited(line, d);
      if (headers.length >= 2) {
        const detected = detectColumns(headers);
        if (detected) { columns = detected; delimiter = d; }
      }
      continue;
    }

    const fields = splitDelimited(line, delimiter);
    if (fields.length < 2) continue;

    let amount: number | null = null;
    if (columns.amount !== -1) amount = parseMoney(fields[columns.amount]);
    if (amount === null && (columns.debit !== -1 || columns.credit !== -1)) {
      const debit = columns.debit !== -1 ? parseMoney(fields[columns.debit]) : null;
      const credit = columns.credit !== -1 ? parseMoney(fields[columns.credit]) : null;
      if (debit !== null || credit !== null) amount = (debit ?? 0) - (credit ?? 0);
    }
    if (amount === null) continue; // header repeat, subtotal, or blank amount

    const date = normalizeDate(fields[columns.date] ?? "");
    if (!date) continue;
    const description = columns.description !== -1 ? fields[columns.description] ?? "" : "";
    const account = columns.account !== -1 ? fields[columns.account] ?? "" : "";
    out.push({
      date,
      description,
      amount,
      account,
      category: guessCategory(account, description),
      source: sourceType,
      rawLine: line.slice(0, 300),
    });
  }
  return out;
}

// ── Types ──

export interface ParsedTransaction {
  date: string;
  description: string;
  amount: number;
  account: string;
  category: string;
  source: "gl" | "bank" | "quickbooks";
  rawLine: string;
}

export interface MatchedTransaction {
  date: string;
  description: string;
  amount: number;
  account: string;
  source: "gl" | "bank" | "quickbooks";
  documentId: string;
  confidence: number; // 0–1
}

export interface MatchResult {
  addbackId: string;
  /**
   * Worked out in code from the linked transactions (addbackSupport):
   * "unverified" when the add-back's likely accounts could not all be read
   * and nothing was found in what was — never "no_match" for a ledger not read.
   */
  verificationStatus: "matched" | "no_match" | "partial_match" | "exceeds_claim" | "unverified";
  matchedTransactions: MatchedTransaction[];
  /** What the linked transactions add up to — computed in code, not the model's figure. */
  totalMatchedAmount: number;
  /** The claim that total was compared with (the annual claim over the period the ledger covers). */
  claimedAmount: number;
  aiNotes: string;
  /** Set when not every transaction that could support the add-back was checked. */
  coverageNote?: string;
}

export interface IdentifiedAddback {
  id: string;
  label: string;
  description: string;
  category: "owner_comp" | "discretionary" | "one_time" | "non_recurring" | "non_cash" | "related_party" | "other";
  annualAmount: number;
  yearAmounts: Record<string, number>;
  matchedTransactions: MatchedTransaction[];
  aiNotes: string;
  /**
   * "matched" when the amount comes from its linked transactions;
   * "exceeds_claim" for a portion of them (above-market rent out of the rent
   * paid); "partial_match" when they hold less than the amount found;
   * "unverified" when none were linked.
   */
  verificationStatus: "matched" | "exceeds_claim" | "partial_match" | "unverified";
  totalMatchedAmount: number;
  claimedAmount: number;
  coverageNote?: string;
}

export interface SellerQuestion {
  id: string;
  question: string;
  context: string;
  relatedAddbackId: string | null;
  relatedTransactions: Array<{ date: string; description: string; amount: number }>;
  answer: string | null;
  status: "pending" | "answered" | "skipped";
}

// ── 1. Parse transaction data ──

export async function parseTransactionData(
  text: string,
  sourceType: "gl" | "bank" | "quickbooks",
  documentId: string,
): Promise<ParsedTransaction[]> {
  return (await parseTransactionDataWithCoverage(text, sourceType, documentId)).transactions;
}

export interface ParseCoverage {
  transactions: ParsedTransaction[];
  /** Characters of the source that were read (all of it for a CSV / TSV export). */
  readChars: number;
  totalChars: number;
}

/** Splits text into pieces of at most `size` characters, at line ends. */
function splitAtLines(text: string, size: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size / 2) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.trim()) out.push(rest);
  return out;
}

/**
 * Parses a source's transactions and says how much of it was read. A CSV /
 * TSV export is read in full, in code. Other text (a PDF bank statement) is
 * read by the model in pieces small enough for each reply to hold every
 * line, up to MAX_PARSE_CHUNKS pieces — never silently cut at the first
 * 80,000 characters.
 */
export async function parseTransactionDataWithCoverage(
  text: string,
  sourceType: "gl" | "bank" | "quickbooks",
  documentId: string,
): Promise<ParseCoverage> {
  const totalChars = (text || "").length;
  // Fast path: CSV / TSV exports parse deterministically — no model, no
  // fence-stripping, no truncation. Fall back to the AI parser only when the
  // text has no recognisable Date/Amount header (PDF bank statements, etc.).
  const direct = parseTransactionsFromCsv(text, sourceType, documentId);
  if (direct.length >= 3) return { transactions: direct, readChars: totalChars, totalChars };

  const pieces = splitAtLines(text || "", PARSE_CHUNK_CHARS);
  const read = pieces.slice(0, MAX_PARSE_CHUNKS);
  const transactions: ParsedTransaction[] = [];
  let readChars = 0;
  for (let i = 0; i < read.length; i++) {
    const piece = read[i];
    transactions.push(...await parseTransactionChunk(piece, sourceType, `${documentId}${read.length > 1 ? ` part ${i + 1}/${pieces.length}` : ""}`));
    readChars += piece.length;
  }
  return { transactions, readChars: pieces.length > read.length ? readChars : totalChars, totalChars };
}

async function parseTransactionChunk(
  truncated: string,
  sourceType: "gl" | "bank" | "quickbooks",
  documentId: string,
): Promise<ParsedTransaction[]> {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 16000,
    temperature: 0,
    system: `You are a financial data extraction specialist. Parse the provided ${sourceType === "gl" ? "General Ledger export" : sourceType === "bank" ? "bank statement" : "QuickBooks report"} into structured transaction data.

Extract every transaction with:
- date: ISO date string (YYYY-MM-DD)
- description: the transaction description/memo
- amount: the dollar amount (positive for debits/expenses, negative for credits/income)
- account: the GL account name or category
- category: best-fit category (payroll, rent, utilities, insurance, professional_fees, owner_draw, travel, meals, vehicle, supplies, depreciation, interest, taxes, revenue, other)
- rawLine: the original line from the source

Return ONLY a valid JSON array. No markdown, no explanation. If you cannot parse the data, return an empty array [].`,
    messages: [
      {
        role: "user",
        content: `Parse these transactions:\n\n${truncated}`,
      },
    ],
  });

  // A reply cut off at its length limit is an unreadable, partial array:
  // read the piece again as two halves.
  if (response.stop_reason === "max_tokens" && truncated.length > 2_000) {
    const halves = splitAtLines(truncated, Math.ceil(truncated.length / 2));
    const out: ParsedTransaction[] = [];
    for (let i = 0; i < halves.length; i++) out.push(...await parseTransactionChunk(halves[i], sourceType, `${documentId} (piece ${i + 1}/${halves.length})`));
    return out;
  }
  const content = (response.content[0] as { type: string; text: string }).text;
  const parsed = parseAiArray(content, `parseTransactionData(${sourceType}, doc ${documentId})`);
  if (!parsed) return [];
  return parsed
    .filter((t: any) => t && typeof t === "object")
    .map((t: any) => ({
      date: t.date || "",
      description: t.description || "",
      amount: Number(t.amount) || 0,
      account: t.account || "",
      category: t.category || "other",
      source: sourceType,
      rawLine: t.rawLine || "",
    }));
}

// ── 2. Match addbacks to transactions ──

interface AddbackToMatch {
  id: string;
  label: string;
  description: string;
  category: string;
  annualAmount: number;
  yearAmounts: Record<string, number>;
}

/** Words that name nothing an add-back could be found by. */
const TERM_STOP = new Set([
  "the", "and", "for", "from", "with", "that", "this", "are", "was", "were", "per", "year", "years", "annual", "annually",
  "monthly", "month", "business", "company", "expense", "expenses", "cost", "costs", "addback", "add", "back", "amount",
  "paid", "pays", "payment", "payments", "through", "run", "runs", "not", "non", "all", "any", "one", "time", "normal",
  "normalization", "adjustment", "adjust", "adjusted", "total", "part", "portion", "full", "only", "into", "out", "over",
]);

/** More words an add-back's category is found by in a ledger. */
const CATEGORY_TERMS: Record<string, string[]> = {
  owner_comp: ["owner", "shareholder", "officer", "management", "salary", "salaries", "draw", "draws", "bonus", "compensation", "dividend"],
  discretionary: ["meal", "meals", "entertainment", "travel", "vehicle", "auto", "personal", "club", "membership", "donation", "gift"],
  related_party: ["related", "management fee", "consulting", "rent", "family"],
  one_time: ["legal", "settlement", "consulting", "relocation", "moving", "severance", "repair", "one-time"],
  non_recurring: ["legal", "settlement", "consulting", "relocation", "moving", "severance", "repair"],
  non_cash: ["depreciation", "amortization", "amortisation"],
  other: [],
};

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What an add-back is looked for by in a ledger: its own words, and its category's. */
function addbackTerms(ab: AddbackToMatch): string[] {
  const own = `${ab.label} ${ab.description}`.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length >= 3 && !TERM_STOP.has(w) && !/^\d+$/.test(w));
  return Array.from(new Set([...own, ...(CATEGORY_TERMS[ab.category] ?? [])]));
}

export interface CandidateSelection {
  /** Indices (into the full list) of the transactions sent to the model, in order. */
  indices: number[];
  /** Add-backs whose likely transactions were not all sent: candidates found vs sent. */
  incomplete: Map<string, { candidates: number; checked: number }>;
}

/**
 * The transactions worth showing the model for these add-backs, when there
 * are more than one call can hold. A general ledger sorted by account puts
 * the management-salary or vehicle accounts thousands of lines down, so the
 * first N lines are the wrong ones. Per add-back, in order of how telling
 * the evidence is:
 *   1. every transaction in an account named by the add-back's words
 *      ("Management salaries" for an owner-salary add-back — the whole
 *      account, so twelve monthly payments can be summed);
 *   2. transactions whose description names it;
 *   3. transactions in the same kind of account (vehicle, meals, payroll…);
 *   4. transactions whose amount is the claim, or a monthly / bi-weekly /
 *      weekly / quarterly share of it.
 * Tiers are filled for every add-back in turn until the limit, so one
 * add-back's huge payroll account never crowds out another's.
 */
export function selectCandidateTransactions(
  addbacks: AddbackToMatch[],
  transactions: ParsedTransaction[],
  limit: number = MAX_TRANSACTIONS_PER_CALL,
): CandidateSelection {
  if (transactions.length <= limit) return { indices: transactions.map((_, i) => i), incomplete: new Map() };
  const tiersByAddback = addbacks.map((ab) => {
    const terms = addbackTerms(ab);
    const res = terms.map((t) => new RegExp(`\\b${escapeRe(t)}`, "i"));
    const hit = (text: string) => res.some((re) => re.test(text));
    const accounts = new Set<string>();
    for (const t of transactions) if (t.account && hit(t.account)) accounts.add(t.account);
    const kind = guessCategory(ab.label, ab.description);
    const claim = Math.abs(Number(ab.annualAmount) || 0);
    const shares = claim > 0 ? [1, 2, 4, 12, 24, 26, 52].map((d) => claim / d) : [];
    const tiers: number[][] = [[], [], [], []];
    transactions.forEach((t, i) => {
      if (t.account && accounts.has(t.account)) tiers[0].push(i);
      else if (hit(t.description)) tiers[1].push(i);
      else if (kind !== "other" && t.category === kind) tiers[2].push(i);
      else if (shares.some((s) => Math.abs(Math.abs(t.amount) - s) <= 0.03 * s)) tiers[3].push(i);
    });
    return { id: ab.id, tiers };
  });
  const chosen = new Set<number>();
  for (let tier = 0; tier < 4 && chosen.size < limit; tier++) {
    // Each add-back's tier in turn, a fair share at a time, until the limit.
    let progress = true;
    const cursor = tiersByAddback.map(() => 0);
    while (progress && chosen.size < limit) {
      progress = false;
      const share = Math.max(1, Math.floor((limit - chosen.size) / Math.max(1, tiersByAddback.length)));
      tiersByAddback.forEach((a, k) => {
        const list = a.tiers[tier];
        let taken = 0;
        while (cursor[k] < list.length && taken < share && chosen.size < limit) {
          if (!chosen.has(list[cursor[k]])) { chosen.add(list[cursor[k]]); taken++; }
          cursor[k]++;
        }
        if (cursor[k] < list.length) progress = true;
      });
    }
  }
  const incomplete = new Map<string, { candidates: number; checked: number }>();
  for (const a of tiersByAddback) {
    const all = a.tiers.flat();
    const checked = all.filter((i) => chosen.has(i)).length;
    if (checked < all.length) incomplete.set(a.id, { candidates: all.length, checked });
  }
  return { indices: Array.from(chosen).sort((x, y) => x - y), incomplete };
}

function toMatched(t: ParsedTransaction, documentId: string, confidence: number): MatchedTransaction {
  return {
    date: t.date,
    description: t.description,
    amount: t.amount,
    account: t.account,
    source: t.source,
    // Transactions parsed from several uploads carry their own document id
    documentId: (t as ParsedTransaction & { documentId?: string }).documentId || documentId,
    confidence,
  };
}

/** The indices a model result cites that are real transactions (and, when given, among those it was shown). */
function citedIndices(raw: unknown, total: number, shown?: Set<number>): number[] {
  const list = Array.isArray(raw) ? raw : [];
  return Array.from(new Set(list.map((v) => Number(v)).filter((i) => Number.isInteger(i) && i >= 0 && i < total && (!shown || shown.has(i)))));
}

/**
 * Turns the model's answer for one add-back into a result whose status and
 * total come from the transactions themselves: a claimed $60,000 vehicle
 * add-back with $12,000 of vehicle charges is "partial_match" with
 * $12,000 supported, whatever the model called it.
 */
export function settleMatch(
  ab: AddbackToMatch,
  modelResult: { verificationStatus?: string; matchedTransactionIndices?: unknown; aiNotes?: string; confidence?: number } | undefined,
  transactions: ParsedTransaction[],
  documentId: string,
  opts: { shown?: Set<number>; incomplete?: { candidates: number; checked: number } } = {},
): MatchResult {
  const idx = citedIndices(modelResult?.matchedTransactionIndices, transactions.length, opts.shown);
  const matched = idx.map((i) => toMatched(transactions[i], documentId, typeof modelResult?.confidence === "number" ? modelResult.confidence : 0.7));
  // (Compared over the period the linked transactions' own upload covers:
  // three months of statements hold a quarter of a year's claim; other
  // uploads read alongside never stretch it.)
  const support = addbackSupport(ab, matched, transactions);
  let status: MatchResult["verificationStatus"] = support.status;
  // The model judged the transactions it cited implausible: never "matched" on them.
  if (modelResult?.verificationStatus === "no_match" && (status === "matched" || status === "exceeds_claim")) status = "partial_match";
  const notes: string[] = [];
  if (modelResult?.aiNotes) notes.push(String(modelResult.aiNotes));
  if (status === "partial_match") {
    notes.push(`The linked transactions add up to ${money(support.supported)} against ${claimWords(ab.annualAmount, support.claimed)}.`);
  } else if (status === "exceeds_claim") {
    notes.push(portionNote(support.supported, ab.annualAmount, support.claimed));
  }
  let coverageNote: string | undefined;
  if (opts.incomplete) {
    coverageNote = `Only ${opts.incomplete.checked.toLocaleString("en-US")} of the ${opts.incomplete.candidates.toLocaleString("en-US")} transactions that could support this add-back were checked (the ledger is too long for one pass).`;
    // Nothing found in part of the ledger is not "no match".
    if (status === "no_match") status = "unverified";
  }
  if (!modelResult) {
    notes.push("No answer came back for this add-back.");
    if (status === "no_match") status = "unverified";
  }
  return {
    addbackId: ab.id,
    verificationStatus: status,
    matchedTransactions: matched,
    totalMatchedAmount: support.supported,
    claimedAmount: support.claimed,
    aiNotes: notes.join(" "),
    ...(coverageNote ? { coverageNote } : {}),
  };
}

export async function matchAddbacksToTransactions(
  addbacks: AddbackToMatch[],
  transactions: ParsedTransaction[],
  industry: string,
  documentId: string,
): Promise<MatchResult[]> {
  if (addbacks.length === 0 || transactions.length === 0) {
    return addbacks.map((a) => ({
      addbackId: a.id,
      verificationStatus: "no_match" as const,
      matchedTransactions: [],
      totalMatchedAmount: 0,
      claimedAmount: Math.abs(Number(a.annualAmount) || 0),
      aiNotes: "No transaction data available for matching.",
    }));
  }

  // Only the transactions that could support these add-backs, when the
  // ledger is longer than one call can hold — with their real indices.
  const selection = selectCandidateTransactions(addbacks, transactions);
  const shown = new Set(selection.indices);
  const txSummary = selection.indices
    .map((i) => { const t = transactions[i]; return `[${i}] ${t.date} | ${t.description} | $${t.amount.toFixed(2)} | ${t.account} | ${t.source}`; })
    .join("\n");
  const omitted = transactions.length - selection.indices.length;

  const addbackSummary = addbacks
    .map((a) => {
      const yearStr = Object.entries(a.yearAmounts || {})
        .map(([y, amt]) => `${y}: $${Number(amt).toFixed(2)}`)
        .join(", ");
      return `- ID: ${a.id} | "${a.label}" (${a.category}) | Annual: $${Number(a.annualAmount).toFixed(2)} | ${yearStr}\n  Description: ${a.description}`;
    })
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    system: `You are an M&A financial analyst specializing in SDE/EBITDA normalization for ${industry} businesses. Your job is to match claimed addbacks to actual transactions in the financial records.

Rules for matching:
- An addback for "Owner salary" should match transactions like "Salary - J. Smith", "Owner Draw", "Management Compensation", etc.
- Fuzzy matching is essential — addback labels rarely match transaction descriptions exactly
- Group related transactions (e.g., monthly salary payments should be summed to match annual addback) and list EVERY transaction that supports the addback
- A match is "matched" if total matched transactions are within 15% of the claimed addback amount
- A match is "partial_match" if some supporting transactions exist but amounts differ significantly
- A match is "no_match" if no plausible transactions can be found
- Assign confidence 0.0–1.0 per matched transaction
- Use the transaction indices exactly as shown in [brackets]

Return ONLY a valid JSON array of results, one per addback. Each result:
{
  "addbackId": "...",
  "verificationStatus": "matched" | "partial_match" | "no_match",
  "matchedTransactionIndices": [array of transaction indices from the list],
  "totalMatchedAmount": number,
  "aiNotes": "explanation of the match logic"
}`,
    messages: [
      {
        role: "user",
        content: `ADDBACKS TO VERIFY:\n${addbackSummary}\n\nTRANSACTION DATA${omitted > 0 ? ` (the ${selection.indices.length.toLocaleString("en-US")} of ${transactions.length.toLocaleString("en-US")} transactions that could relate to these addbacks)` : ""}:\n${txSummary}`,
      },
    ],
  });

  const content = (response.content[0] as { type: string; text: string }).text;
  const results = parseAiArray(content, "matchAddbacksToTransactions");
  if (!results) {
    return addbacks.map((a) => ({
      addbackId: a.id,
      verificationStatus: "unverified" as const,
      matchedTransactions: [],
      totalMatchedAmount: 0,
      claimedAmount: Math.abs(Number(a.annualAmount) || 0),
      aiNotes: "AI matching failed — manual review required.",
    }));
  }

  // One result per add-back, in the add-backs' own order; totals and status in code.
  return addbacks.map((ab) => {
    const r = results.find((x: any) => x && String(x.addbackId) === String(ab.id));
    return settleMatch(ab, r, transactions, documentId, { shown, incomplete: selection.incomplete.get(ab.id) });
  });
}

// ── 3. Identify addbacks from scratch (Workflow B) ──

/** Accounts and descriptions where discretionary / owner / one-time spending usually sits. */
const DISCOVERY_TERMS = /\b(?:owner|shareholder|officer|director|management|draw|bonus|dividend|related|family|personal|vehicle|auto|car|fuel|meal|meals|entertainment|travel|club|membership|donation|gift|consult|legal|settlement|relocation|moving|severance|one[- ]time|non[- ]recurring|rent|lease|insurance|life insurance|interest|depreciation|amortization|professional)\b/i;

export interface DiscoveryInput {
  /** Every account, one line each (number of transactions, total, sample descriptions). */
  accountLines: string[];
  /** Indices of the transactions listed line by line. */
  indices: number[];
}

/**
 * What the discovery call is shown. A ledger that fits is listed in full.
 * A longer one is shown as one summary line per account (so no account is
 * out of sight) plus, line by line, the transactions in the accounts where
 * add-backs usually are — never only the first N lines.
 */
export function discoveryInput(transactions: ParsedTransaction[], limit: number = MAX_TRANSACTIONS_PER_CALL): DiscoveryInput {
  const byAccount = new Map<string, number[]>();
  transactions.forEach((t, i) => {
    const a = t.account || "(no account)";
    if (!byAccount.has(a)) byAccount.set(a, []);
    byAccount.get(a)!.push(i);
  });
  const accountLines = Array.from(byAccount.entries()).map(([a, idx]) => {
    const total = idx.reduce((s, i) => s + transactions[i].amount, 0);
    const samples = Array.from(new Set(idx.map((i) => transactions[i].description).filter(Boolean))).slice(0, 3).join("; ");
    return `${a} | ${idx.length} transactions | total $${total.toFixed(2)}${samples ? ` | e.g. ${samples}` : ""}`;
  });
  if (transactions.length <= limit) return { accountLines, indices: transactions.map((_, i) => i) };
  const telling: number[] = [];
  const rest: number[] = [];
  transactions.forEach((t, i) => {
    if (DISCOVERY_TERMS.test(t.account) || DISCOVERY_TERMS.test(t.description) || ["owner_draw", "travel", "meals", "vehicle", "professional_fees"].includes(t.category)) telling.push(i);
    else rest.push(i);
  });
  // The rest, largest amounts first (one-time items stand out by size).
  rest.sort((x, y) => Math.abs(transactions[y].amount) - Math.abs(transactions[x].amount));
  const indices = [...telling, ...rest].slice(0, limit).sort((x, y) => x - y);
  return { accountLines, indices };
}

/** Words that say an add-back is a portion of what was paid (above-market rent, the personal share of a vehicle). */
const PORTION_WORDS =
  /\b(?:above[\s-]market|over[\s-]market|excess|portion|personal (?:use|share|portion|part)|share of|part of|half|non[\s-]business (?:share|portion|part)|\d{1,2}(?:\.\d+)?\s?%|\d{1,2}(?:\.\d+)?\s?percent)/i;

/** An add-back that is a portion of what the linked transactions paid, in words. */
function portionNote(paid: number, annual: number, claimed: number): string {
  return `The linked transactions add up to ${money(paid)}, more than ${claimWords(annual, claimed)}: the add-back is a portion of these payments — confirm how the portion was worked out.`;
}

/** Sum of transactions by calendar year ("2024" → 12,000). */
function sumsByYear(txs: MatchedTransaction[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of txs) {
    const y = (t.date ?? "").match(/\b((?:19|20)\d{2})\b/)?.[1];
    if (y) out[y] = Math.round(((out[y] ?? 0) + t.amount) * 100) / 100;
  }
  for (const y of Object.keys(out)) out[y] = Math.abs(out[y]);
  return out;
}

/**
 * One discovered add-back with its amount taken from its transactions: the
 * ones the model cited plus every transaction in the accounts it named.
 * A whole account named, or an amount within 15% of what the transactions
 * add up to, takes the transactions' total (the model's own, summed from a
 * list it may not have seen in full, is kept in the notes when it differs).
 * An amount well below the payments it cites — or below the account it
 * names, whose total it was shown — is a portion of them (the
 * above-market part of related-party rent, the personal half of a vehicle):
 * it stays the model's amount, "exceeds_claim". Well above them: partly
 * supported.
 */
export function settleDiscovered(r: any, transactions: ParsedTransaction[], shown: Set<number>): IdentifiedAddback {
  const named = new Set((Array.isArray(r?.accounts) ? r.accounts : []).map((a: unknown) => String(a).trim().toLowerCase()).filter(Boolean));
  const idx = new Set(citedIndices(r?.matchedTransactionIndices, transactions.length, shown));
  let fromAccounts = 0;
  if (named.size > 0) transactions.forEach((t, i) => { if (named.has((t.account || "(no account)").trim().toLowerCase())) { idx.add(i); fromAccounts++; } });
  const matched = Array.from(idx).sort((a, b) => a - b).map((i) => toMatched(transactions[i], "", 0.8));
  const modelAnnual = Number(r?.annualAmount) || 0;
  const notes: string[] = [];
  if (r?.aiNotes) notes.push(String(r.aiNotes));
  const base = {
    id: r?.id || `ab_${Math.random().toString(36).slice(2, 8)}`,
    label: r?.label || "Unknown addback",
    description: r?.description || "",
    category: r?.category || "other",
  };
  if (matched.length === 0) {
    return {
      ...base, annualAmount: modelAnnual, yearAmounts: r?.yearAmounts || {}, matchedTransactions: [],
      aiNotes: [...notes, "No transactions were linked to this add-back — its amount is not yet supported."].join(" "),
      verificationStatus: "unverified", totalMatchedAmount: 0, claimedAmount: modelAnnual,
    };
  }
  const total = Math.abs(matched.reduce((s, t) => s + t.amount, 0));
  const years = sumsByYear(matched);
  const yearKeys = Object.keys(years).sort();
  // The period the linked transactions' own source covers (their GL or bank
  // statement, never the other uploads: recent statements next to a year's
  // GL don't stretch a salary paid in that GL).
  const covered = claimPeriodYears(matched, transactions) ?? 1;
  const whole = wholeYears(covered);
  const oneOff = base.category === "one_time" || base.category === "non_recurring" || matched.length < 2;
  // One amount per year: the latest year's when the transactions fall in
  // whole calendar years, else the total over the whole years covered, else
  // (three months of statements) the total scaled to a year. A one-time
  // item is its total.
  const calendar = !oneOff && whole !== null && yearKeys.length === whole;
  const perYear = oneOff ? total : calendar ? years[yearKeys[yearKeys.length - 1]] : total / (whole ?? covered);
  const linkedAnnual = Math.round(perYear * 100) / 100;
  const linkedYears = calendar ? years : (r?.yearAmounts || {});
  const settle = (annualAmount: number, yearAmounts: Record<string, number>, status?: "matched") => {
    const support = addbackSupport({ annualAmount, yearAmounts, category: base.category }, matched, transactions);
    return {
      ...base,
      annualAmount,
      yearAmounts,
      matchedTransactions: matched,
      verificationStatus: status ?? (support.status === "no_match" ? "unverified" : support.status),
      totalMatchedAmount: support.supported,
      claimedAmount: support.claimed,
    } as const;
  };
  // A whole account named as the add-back (the owner's salary account): its
  // transactions are the amount — summed in code, not the model's figure.
  // An amount close to the linked total is the same figure, summed in code.
  // An add-back that says it is a portion ("above-market rent", "personal
  // use (50%)") with an amount below the account it names is that portion
  // of it — kept as the model's amount, never inflated to the whole account.
  // Otherwise a named account is the account, summed in code (the model's
  // own figure may come from a list it didn't see in full).
  const close = modelAnnual > 0 && Math.abs(modelAnnual - linkedAnnual) <= ADDBACK_MATCH_TOLERANCE * linkedAnnual;
  const portionOfAccount = modelAnnual > 0 && !close && modelAnnual < linkedAnnual && PORTION_WORDS.test(`${base.label} ${base.description}`);
  const accountWhole = fromAccounts > 0 && !portionOfAccount;
  if (accountWhole || close || modelAnnual <= 0) {
    if (modelAnnual > 0 && Math.abs(modelAnnual - linkedAnnual) > 0.15 * linkedAnnual) {
      notes.push(`The linked transactions put it at ${money(linkedAnnual)} a year (the first estimate was ${money(modelAnnual)}).`);
    }
    if (!oneOff && whole === null) notes.push(`Scaled to a year from the ${periodLabel(Math.max(1, Math.round(covered * 12)))} the ledger covers.`);
    return { ...settle(linkedAnnual, linkedYears, "matched"), aiNotes: notes.join(" ") };
  }
  // The model's amount differs from the payments it cited: a portion of
  // them (the above-market part of the rent, the personal half of a
  // vehicle) when lower — the amount stays the model's and the payments
  // stand behind it; less than it when higher — partly supported.
  const own = settle(modelAnnual, r?.yearAmounts || {});
  if (own.verificationStatus === "exceeds_claim") notes.push(portionNote(own.totalMatchedAmount, modelAnnual, own.claimedAmount));
  else if (own.verificationStatus === "partial_match") notes.push(`The linked transactions add up to ${money(own.totalMatchedAmount)} against ${claimWords(modelAnnual, own.claimedAmount)}.`);
  return { ...own, aiNotes: notes.join(" ") };
}

export async function identifyAddbacksFromTransactions(
  transactions: ParsedTransaction[],
  industry: string,
  dealContext: {
    businessName: string;
    askingPrice?: string;
    ownerNames?: string[];
  },
): Promise<IdentifiedAddback[]> {
  if (transactions.length === 0) return [];

  const input = discoveryInput(transactions);
  const shown = new Set(input.indices);
  const partial = input.indices.length < transactions.length;
  const txSummary = input.indices
    .map((i) => { const t = transactions[i]; return `[${i}] ${t.date} | ${t.description} | $${t.amount.toFixed(2)} | ${t.account} | ${t.category} | ${t.source}`; })
    .join("\n");

  const ownerContext = dealContext.ownerNames?.length
    ? `Known owner names: ${dealContext.ownerNames.join(", ")}`
    : "Owner names not confirmed — look for patterns suggesting owner compensation.";

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 8000,
    system: `You are an M&A financial analyst performing SDE/EBITDA normalization for a ${industry} business called "${dealContext.businessName}".

Analyze the transaction data and identify potential addbacks. Look for:
1. Owner compensation — salary, draws, bonuses, benefits paid to owners
2. Related-party transactions — payments to family members, owner-controlled entities
3. One-time expenses — lawsuit settlements, relocation costs, unusual write-offs
4. Non-recurring items — startup costs, one-time marketing campaigns, special projects
5. Discretionary spending — excessive travel, entertainment, vehicles, personal expenses run through the business
6. Non-cash charges — depreciation, amortization beyond standard
7. Above-market rent to related parties

${ownerContext}

Group related transactions (e.g., 12 monthly salary payments = one addback) and list EVERY transaction that makes up the addback. When a whole account is the addback, name it in "accounts" (exactly as written in the account summary) — its transactions are then all counted, including any not listed line by line. When the addback is only a PORTION of some payments (above-market rent to a related party, the personal share of vehicle costs), give the portion as annualAmount, cite the payments it comes from in matchedTransactionIndices, and do NOT name their account.
Use the transaction indices exactly as shown in [brackets].

Return ONLY a valid JSON array. Each item:
{
  "id": "ab_1" (sequential),
  "label": "descriptive name",
  "description": "explanation of why this is an addback",
  "category": "owner_comp" | "discretionary" | "one_time" | "non_recurring" | "non_cash" | "related_party" | "other",
  "annualAmount": number,
  "yearAmounts": { "2023": number, "2024": number },
  "matchedTransactionIndices": [indices],
  "accounts": ["account name", ...],
  "aiNotes": "reasoning"
}`,
    messages: [
      {
        role: "user",
        content: `ACCOUNT SUMMARY (every account in the records):\n${input.accountLines.join("\n")}\n\nIdentify addbacks from these transactions${partial ? ` (${input.indices.length.toLocaleString("en-US")} of ${transactions.length.toLocaleString("en-US")} are listed line by line — the accounts where addbacks usually sit and the largest of the rest; every account is in the summary above)` : ""}:\n\n${txSummary}`,
      },
    ],
  });

  const content = (response.content[0] as { type: string; text: string }).text;
  const results = parseAiArray(content, "identifyAddbacksFromTransactions");
  if (!results) return [];
  const coverageNote = partial
    ? `${input.indices.length.toLocaleString("en-US")} of ${transactions.length.toLocaleString("en-US")} transactions were read line by line; the rest were seen as account totals.`
    : undefined;
  return results
    .filter((r: any) => r && typeof r === "object")
    .map((r: any) => {
      const ab = settleDiscovered(r, transactions, shown);
      return coverageNote ? { ...ab, coverageNote } : ab;
    });
}

// ── 4. Generate seller questions ──

export async function generateSellerQuestions(
  addbacks: Array<{
    id: string;
    label: string;
    description: string;
    category: string;
    annualAmount: number;
    verificationStatus?: string;
    matchedTransactions?: MatchedTransaction[];
    aiNotes?: string;
  }>,
  transactions: ParsedTransaction[],
  gaps: string[],
): Promise<SellerQuestion[]> {
  const unmatchedAddbacks = addbacks.filter(
    (a) => a.verificationStatus === "no_match" || a.verificationStatus === "partial_match" || a.verificationStatus === "exceeds_claim",
  );

  if (unmatchedAddbacks.length === 0 && gaps.length === 0) return [];

  const addbackContext = unmatchedAddbacks
    .map((a) => {
      const txStr = (a.matchedTransactions || [])
        .slice(0, 5)
        .map((t) => `  ${t.date} | ${t.description} | $${t.amount}`)
        .join("\n");
      return `- "${a.label}" ($${a.annualAmount}) [${a.verificationStatus}]\n  AI notes: ${a.aiNotes || "none"}\n  Closest matches:\n${txStr || "  (none found)"}`;
    })
    .join("\n\n");

  const ambiguousTx = transactions
    .filter((t) => {
      const desc = t.description.toLowerCase();
      return (
        desc.includes("owner") ||
        desc.includes("personal") ||
        desc.includes("related") ||
        desc.includes("consulting") ||
        desc.includes("management fee") ||
        t.category === "other"
      );
    })
    .slice(0, 20)
    .map((t) => `${t.date} | ${t.description} | $${t.amount} | ${t.account}`)
    .join("\n");

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4000,
    system: `You are a financial analyst asking a business seller targeted questions to verify addbacks for an SDE/EBITDA normalization. Ask clear, specific questions — not generic ones. Reference actual transaction amounts and descriptions from their records so they know exactly what you are asking about.

Return ONLY a valid JSON array. Each item:
{
  "id": "q_1",
  "question": "the question to ask the seller",
  "context": "why you are asking (internal note, not shown to seller)",
  "relatedAddbackId": "addback ID or null",
  "relatedTransactions": [{ "date": "...", "description": "...", "amount": number }],
  "answer": null,
  "status": "pending"
}`,
    messages: [
      {
        role: "user",
        content: `Generate verification questions for the seller.

UNVERIFIED ADDBACKS:
${addbackContext || "(none)"}

AMBIGUOUS TRANSACTIONS:
${ambiguousTx || "(none)"}

ADDITIONAL GAPS:
${gaps.length > 0 ? gaps.join("\n") : "(none)"}`,
      },
    ],
  });

  const content = (response.content[0] as { type: string; text: string }).text;
  const results = parseAiArray(content, "generateSellerQuestions");
  if (!results) return [];
  return results
    .filter((q: any) => q && typeof q === "object" && q.question)
    .map((q: any) => ({
      id: q.id || `q_${Math.random().toString(36).slice(2, 8)}`,
      question: q.question || "",
      context: q.context || "",
      relatedAddbackId: q.relatedAddbackId || null,
      relatedTransactions: (q.relatedTransactions || []).map((t: any) => ({
        date: t.date || "",
        description: t.description || "",
        amount: Number(t.amount) || 0,
      })),
      answer: null,
      status: "pending" as const,
    }));
}
