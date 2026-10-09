/**
 * detect.ts — which column is which in a ledger export (gl spec §6.2).
 * Rules only, no AI: the column-heading row by its words, how accounts are
 * shown (a column, a column filled once per group, or headings above each
 * group), how dates are written, the software that made it (for copy only)
 * and the accounting basis. Confidence comes from a dry parse of the rows
 * that follow. Pure.
 */
import { createHash } from "node:crypto";
import type { GlAccountMode, GlAmountMode, GlBasis, GlDateOrder, GlLayout, GlRawRow, GlRole, GlSoftware } from "@shared/gl-types";
import { ACCRUAL_BASIS_RE, CASH_BASIS_RE, normHeader, parseLedgerRows, SKIP_ANYWHERE } from "./parse";
import { cellText, numericDateParts, parseLedgerDate } from "./text";

const SYNONYMS: Array<[Exclude<GlRole, "balance" | "ignore"> | "balance" | "ignore", string[]]> = [
  ["date", ["date", "transaction date", "txn date", "trans date", "posting date", "posted", "date posted", "entry date", "gl date"]],
  ["account", ["account", "account name", "distribution account", "gl account", "ledger account", "account title", "account description", "full name"]],
  ["account_number", ["account code", "account no", "account number", "acct no", "acct no.", "gl code", "code"]],
  ["account_type", ["account type", "type of account", "account class", "account category"]],
  ["name", ["name", "payee", "vendor", "vendor name", "supplier", "customer", "customer name", "contact", "customer/vendor", "paid to", "employee", "source name"]],
  ["memo", ["memo", "memo/description", "description", "transaction description", "transaction line description", "line description", "details", "narration", "comment", "particulars", "notes", "notes / memo", "description/type"]],
  ["type", ["transaction type", "type", "trans type", "journal type", "source"]],
  ["number", ["num", "no", "number", "reference", "ref", "ref no", "source no", "je no", "transaction id", "invoice number", "bill number", "cheque no", "check no", "document number"]],
  ["debit", ["debit", "debits", "debit amount", "debit amount two column approach", "dr"]],
  ["credit", ["credit", "credits", "credit amount", "credit amount two column approach", "cr"]],
  ["amount", ["amount", "net", "net amount", "amount one column", "value"]],
  ["balance", ["balance", "running balance", "ending balance"]],
  ["ignore", ["split", "split account", "adj", "gst", "hst", "tax", "tax amount", "sales tax amount", "class", "location", "account group", "gross", "total"]],
];

const NORMALISED: Array<[GlRole, string[]]> = SYNONYMS.map(([r, list]) => [r as GlRole, Array.from(new Set(list.map(normHeader)))]);
const BY_EXACT = new Map<string, GlRole>();
for (const [role, list] of NORMALISED) for (const n of list) if (!BY_EXACT.has(n)) BY_EXACT.set(n, role);
// Prefix matches, longest synonym first ("debit amount" before "debit").
const PREFIXES = NORMALISED.flatMap(([role, list]) => list.map((n) => ({ n, role }))).sort((a, b) => b.n.length - a.n.length);

/** The role a column heading names, "unknown" for an unrecognised heading, or null for a blank cell. */
export function roleOfHeader(raw: unknown): GlRole | "unknown" | null {
  const n = normHeader(raw);
  if (!n) return null;
  const exact = BY_EXACT.get(n);
  if (exact) return exact;
  for (const { n: syn, role } of PREFIXES) {
    if (syn.length >= 2 && n.startsWith(syn + " ")) {
      // "Debit (CAD)" → debit; "Type of account" was exact; never "total …" → amount.
      return role;
    }
  }
  return "unknown";
}

export interface DetectResult {
  layout: GlLayout;
  confidence: number;
  software: GlSoftware;
  basis: GlBasis | null;
  headerFingerprint: string;
  /** Distinct accounts the dry parse found. */
  accounts: number;
  /** Why confidence is below 1 (plain, for logs and the broker's column dialog). */
  shaky: string[];
  datesAmbiguous: boolean;
}

function groupBySheet(rows: GlRawRow[]): Array<{ sheet: string | null; rows: GlRawRow[] }> {
  const out: Array<{ sheet: string | null; rows: GlRawRow[] }> = [];
  for (const r of rows) {
    const last = out[out.length - 1];
    if (last && last.sheet === r.sheet) last.rows.push(r);
    else out.push({ sheet: r.sheet, rows: [r] });
  }
  return out;
}

interface HeaderCandidate { index: number; roles: Array<GlRole | "unknown" | null>; score: number }

function findHeader(rows: GlRawRow[]): HeaderCandidate | null {
  let best: HeaderCandidate | null = null;
  rows.slice(0, 60).forEach((r, index) => {
    const roles = r.cells.map(roleOfHeader);
    const known = roles.filter((x) => x && x !== "unknown") as GlRole[];
    const unknown = roles.filter((x) => x === "unknown").length;
    const hasAmount = known.includes("amount") || known.includes("debit") || known.includes("credit");
    if (known.length < 3 || !known.includes("date") || !hasAmount) return;
    const score = known.length - 0.5 * unknown;
    if (!best || score > best.score) best = { index, roles, score };
  });
  return best;
}

/** Columns from a header candidate: the first column of each role keeps it; later ones are ignored. */
function columnsFrom(header: GlRawRow, roles: Array<GlRole | "unknown" | null>): GlLayout["columns"] {
  const seen = new Set<GlRole>();
  const cols: GlLayout["columns"] = [];
  roles.forEach((role, index) => {
    const headerText = cellText(header.cells[index], 120);
    if (!role || role === "unknown") {
      if (headerText) cols.push({ index, role: "ignore", header: headerText });
      return;
    }
    // A second name or memo column (Wave: Customer and Vendor; three description columns) is read too.
    if (seen.has(role) && role !== "ignore" && role !== "balance" && role !== "name" && role !== "memo") {
      cols.push({ index, role: "ignore", header: headerText });
      return;
    }
    seen.add(role);
    cols.push({ index, role, header: headerText });
  });
  // "gross" counts as the amount only when nothing else does.
  const hasAmount = cols.some((c) => c.role === "amount" || c.role === "debit" || c.role === "credit");
  if (!hasAmount) {
    const gross = cols.find((c) => normHeader(c.header) === "gross");
    if (gross) gross.role = "amount";
  }
  return cols;
}

function colOf(cols: GlLayout["columns"], role: GlRole): number | undefined {
  return cols.find((c) => c.role === role)?.index;
}

/** Date order from the date column: a first part over 12 → day first; a second part over 12 → month first; ISO → year first. */
function dateOrderFrom(values: unknown[], groups: string[]): { order: GlDateOrder; ambiguous: boolean } {
  let dmy = false;
  let mdy = false;
  let ymd = false;
  let numeric = 0;
  for (const v of values) {
    if (typeof v !== "string") continue;
    const s = v.trim();
    if (/^\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}/.test(s)) { ymd = true; continue; }
    const p = numericDateParts(s);
    if (!p) continue;
    numeric++;
    if (p[0] > 12) dmy = true;
    if (p[1] > 12) mdy = true;
  }
  if (dmy && !mdy) return { order: "dmy", ambiguous: false };
  if (mdy && !dmy) return { order: "mdy", ambiguous: false };
  if (numeric === 0) return { order: ymd ? "ymd" : "mdy", ambiguous: false };
  // Every date fits both ways: the order with fewer steps backwards within each account group.
  const descents = (order: GlDateOrder) => {
    let n = 0;
    let prev: string | null = null;
    let prevGroup: string | null = null;
    values.forEach((v, i) => {
      const d = parseLedgerDate(v, order);
      if (!d) return;
      if (prev && prevGroup === groups[i] && d < prev) n++;
      prev = d;
      prevGroup = groups[i];
    });
    return n;
  };
  const a = descents("mdy");
  const b = descents("dmy");
  if (b < a) return { order: "dmy", ambiguous: false };
  if (a < b) return { order: "mdy", ambiguous: false };
  return { order: "mdy", ambiguous: true };
}

/** The software that made the export — for copy only ("QuickBooks Online export"). */
export function softwareFrom(headers: string[], titleText: string, accountHeadings: string[]): GlSoftware {
  const h = new Set(headers.map(normHeader).filter(Boolean));
  const has = (...names: string[]) => names.every((n) => h.has(normHeader(n)));
  if (/freshbooks/i.test(titleText)) return "freshbooks";
  if (has("transaction type", "memo/description", "split") || has("distribution account")) return "quickbooks_online";
  if (has("type", "num", "adj", "name", "memo", "split", "debit", "credit") || accountHeadings.some((a) => a.includes(" · "))) return "quickbooks_desktop";
  if (has("source", "reference", "running balance") || has("account code", "contact")) return "xero";
  if (has("source #", "je #", "comment") || has("debits", "credits")) return "sage50";
  if (has("account name", "amount one column") || has("transaction id", "account group")) return "wave";
  return "other";
}

/** A heading row's fingerprint: its normalised texts in column order (trailing blanks dropped). Same headings → same layout. */
export function headerFingerprint(headers: string[]): string {
  const norm = headers.map(normHeader);
  while (norm.length && norm[norm.length - 1] === "") norm.pop();
  return createHash("sha256").update(norm.join("|")).digest("hex").slice(0, 24);
}

/** The fingerprint of a row read from a file (any cell kinds). */
export function rowFingerprint(cells: unknown[]): string {
  return headerFingerprint(cells.map((c) => cellText(c, 120)));
}

export function basisFromTitleRows(texts: string[]): GlBasis | null {
  let basis: GlBasis | null = null;
  for (const t of texts) {
    if (CASH_BASIS_RE.test(t)) return "cash";
    if (ACCRUAL_BASIS_RE.test(t)) basis = "accrual";
  }
  return basis;
}

/**
 * The layout of a ledger from its first rows (≤60 non-blank rows per sheet).
 * Picks the sheet with the best heading row. Null when no row has at least
 * three recognised headings including a date and an amount (or debit/credit).
 */
export function detectLayout(rows: GlRawRow[]): DetectResult | null {
  let best: { sheet: string | null; rows: GlRawRow[]; header: HeaderCandidate } | null = null;
  const found: Array<{ sheet: string | null; fingerprint: string }> = [];
  for (const g of groupBySheet(rows)) {
    const header = findHeader(g.rows);
    if (header) found.push({ sheet: g.sheet, fingerprint: rowFingerprint(g.rows[header.index].cells) });
    if (header && (!best || header.score > best.header.score)) best = { ...g, header };
  }
  if (!best) return null;
  // A workbook with one sheet per year (same headings on each): read every such sheet.
  const bestFp = rowFingerprint(best.rows[best.header.index].cells);
  const sameOnOthers = found.filter((f) => f.fingerprint === bestFp).length > 1;
  const { rows: sheetRows, header } = best;
  const headerRow = sheetRows[header.index];
  const columns = columnsFrom(headerRow, header.roles);
  const dateCol = colOf(columns, "date")!;
  const accountCol = colOf(columns, "account");
  const amountMode: GlAmountMode = colOf(columns, "debit") !== undefined || colOf(columns, "credit") !== undefined ? "debit_credit" : "single";
  const data = sheetRows.slice(header.index + 1);
  const titleTexts = sheetRows.slice(0, header.index + 1).map((r) => r.cells.map((c) => cellText(c, 200)).filter(Boolean).join(" "));

  // Account mode.
  const datedRows = data.filter((r) => parseLedgerDate(r.cells[dateCol], "mdy") || parseLedgerDate(r.cells[dateCol], "dmy"));
  const textOnly = data.filter((r) => {
    const nonEmpty = r.cells.map((c) => cellText(c, 200)).filter(Boolean);
    if (nonEmpty.length === 0) return false;
    const hasDate = !!(parseLedgerDate(r.cells[dateCol], "mdy") || parseLedgerDate(r.cells[dateCol], "dmy"));
    if (hasDate) return false;
    const first = nonEmpty[0];
    if (SKIP_ANYWHERE.test(first) || CASH_BASIS_RE.test(first) || ACCRUAL_BASIS_RE.test(first)) return false;
    // Only text (a heading) — no number-like cell beyond it.
    return r.cells.every((c) => typeof c !== "number");
  });
  let accountMode: GlAccountMode;
  if (accountCol !== undefined) {
    const filled = datedRows.filter((r) => cellText(r.cells[accountCol], 200)).length;
    accountMode = datedRows.length > 0 && filled >= 0.8 * datedRows.length ? "column" : "column_fill_down";
  } else {
    // No account column: the account is the heading above each group (or there is none — a bank statement).
    accountMode = "heading_rows";
  }

  // Date order, judged within account groups.
  const groups: string[] = [];
  let group = "";
  const dateValues: unknown[] = [];
  for (const r of data) {
    const v = r.cells[dateCol];
    if (accountMode === "column" && accountCol !== undefined) group = cellText(r.cells[accountCol], 200);
    else if (!parseLedgerDate(v, "mdy") && !parseLedgerDate(v, "dmy") && r.cells.some((c) => cellText(c, 200))) group = String(r.rowNo);
    if (typeof v === "string" || typeof v === "number" || (v && typeof v === "object")) {
      dateValues.push(v);
      groups.push(group);
    }
  }
  const { order: dateOrder, ambiguous } = dateOrderFrom(dateValues, groups);

  const layout: GlLayout = {
    headerRow: header.index,
    columns,
    accountMode,
    dateOrder,
    amountMode,
    sheet: sameOnOthers ? null : best.sheet,
  };

  // Dry parse of what follows: date + amount on most non-heading rows, and some accounts.
  const sample = sheetRows.slice(0, header.index + 1 + 200);
  const { entries, stats } = parseLedgerRows(sample, layout);
  const accounts = new Set(entries.map((e) => e.accountKey).filter((k) => k && k !== "no account")).size;
  const shaky: string[] = [];
  const looked = stats.dataLike + stats.skipped;
  if (looked === 0 || stats.dataLike / looked < 0.9) shaky.push("dates or amounts missing on many rows");
  if (accounts < 3) shaky.push(accounts === 0 ? "no account names found" : "fewer than three accounts");
  if (ambiguous) shaky.push("dates could be day-first or month-first");
  if (accountMode === "column_fill_down" && accountCol !== undefined && datedRows.length > 0 && datedRows.every((r) => !cellText(r.cells[accountCol], 200))) {
    shaky.push("the account column is empty");
  }
  const confidence = entries.length === 0 ? 0 : shaky.length === 0 ? 1 : shaky.length === 1 && accounts >= 1 ? 0.6 : 0.4;
  const headers = columns.map((c) => c.header);
  const accountHeadings = textOnly.map((r) => r.cells.map((c) => cellText(c, 200)).find(Boolean) ?? "");
  const allTitle = [...titleTexts, ...data.slice(-5).map((r) => r.cells.map((c) => cellText(c, 200)).filter(Boolean).join(" "))];
  return {
    layout,
    confidence,
    software: softwareFrom(headers, allTitle.join(" "), accountHeadings),
    basis: stats.basis ?? basisFromTitleRows(allTitle),
    headerFingerprint: rowFingerprint(headerRow.cells),
    accounts,
    shaky,
    datesAmbiguous: ambiguous,
  };
}

/**
 * Is this file a general ledger? For files uploaded outside the GL screens
 * (a generic document upload): confident layout, an account dimension, and
 * at least three accounts — bank statements, P&Ls, membership lists and
 * fleet lists are not. Files uploaded through the GL screens or the GL
 * checklist row need only one account (`minAccounts: 1`).
 */
export function sniffGeneralLedger(rows: GlRawRow[], opts: { minAccounts?: number } = {}): boolean {
  const r = detectLayout(rows);
  if (!r || r.confidence < 0.6) return false;
  return r.accounts >= (opts.minAccounts ?? 3);
}
