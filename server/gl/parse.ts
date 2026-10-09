/**
 * parse.ts — ledger rows → entries, by a layout (gl spec §6.3). Pure and
 * streaming: rows are pushed one at a time (a 200,000-row file never sits in
 * memory as entries), state carries across batches and sheets.
 *
 * What a row is:
 *  - before the column headings (per sheet): a title row (company name,
 *    report name, period) — remembered, so a page break that repeats them
 *    is skipped instead of being taken for an account heading;
 *  - the column headings again (a page break): skipped;
 *  - "Opening/Beginning balance", "Balance forward", "Closing balance",
 *    "Total …", "Net movement", page numbers, print timestamps, the
 *    "Accrual basis"/"Cash basis" footer (captured as the basis): skipped,
 *    never counted as a problem;
 *  - text only, no date and no amount: an account heading (exports that
 *    group entries under the account's name — nested by how far right the
 *    name sits, "Parent:Child"), the account for the rows below in a
 *    fill-down account column, or a memo that wrapped onto its own line;
 *  - a date and an amount: an entry. Debit/credit columns give
 *    |debit| − |credit| ("(500.00)" in Credit is still a credit);
 *  - anything else that looks like data (a date but no amount, or an amount
 *    but no date) is skipped and counted.
 */
import type { GlCell, GlLayout, GlParsedEntry, GlRawRow, GlRole } from "@shared/gl-types";
import { accountKey, cellText, currencyOf, parseLedgerDate, parseMoneyToCents, splitAccountNumber } from "./text";

/** Normalised header text: lower-case, "#" → "no", ()*: dropped, spaces collapsed. */
export function normHeader(raw: unknown): string {
  return cellText(raw, 200)
    .toLowerCase()
    .replace(/#/g, " no ")
    .replace(/\bno\./g, "no")
    .replace(/[()*:]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export const SKIP_ANYWHERE = /^(?:(?:beginning|opening|starting)\s+balance|balance\s+(?:forward|brought\s+forward|b\/f)|closing\s+balance|ending\s+balance)\b/i;
export const SKIP_WITHOUT_DATE = /^(?:total\b|grand\s+total\b|net\s+(?:movement|change)\b|sub-?total\b)/i;
const PAGE_RE = /^(?:page\s+\d+(?:\s+of\s+\d+)?)$|\bpage\s+\d+\s+of\s+\d+\b/i;
const TIMESTAMP_RE = /\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:am|pm)\b|\b(?:printed|run|generated)\s+(?:on|at)\b/i;
export const CASH_BASIS_RE = /\bcash\s+basis\b/i;
export const ACCRUAL_BASIS_RE = /\baccrual\s+basis\b/i;

export interface ParseOptions {
  /** Rows before the header (per sheet) are titles; with headerRow < 0 every row is data. */
  maxNameChars?: number;
}

export interface ParseStats {
  /** Rows that looked like data but had no date or no amount. */
  skipped: number;
  /** Accrual / cash, from a title or footer row. */
  basis: "accrual" | "cash" | null;
  /** Currency marks seen in amount cells. */
  currencies: Set<string>;
  /** Entries produced. */
  entries: number;
  /** Rows after the header that were neither entries nor skipped (headings, totals, footers). */
  structural: number;
  /** Rows with a date and an amount on lines that weren't headings — the "non-heading rows" of the dry parse. */
  dataLike: number;
}

interface Heading { name: string; number: string | null; depth: number }

function isBlank(c: GlCell): boolean {
  if (c === null || c === undefined) return true;
  if (typeof c === "string") return c.trim() === "";
  return false;
}

function leadingSpaces(raw: GlCell): number {
  if (typeof raw !== "string") return 0;
  const m = raw.match(/^[  ]*/);
  return m ? m[0].length : 0;
}

export class LedgerParser {
  readonly stats: ParseStats = { skipped: 0, basis: null, currencies: new Set(), entries: 0, structural: 0, dataLike: 0 };
  private readonly col: Partial<Record<GlRole, number>> = {};
  /** Every name / memo column (the first non-empty name is used; distinct memos are joined). */
  private readonly multi: Partial<Record<"name" | "memo", number[]>> = {};
  private readonly headerNorm: string[];
  private readonly roleCols: number[];
  private readonly sheetSeenHeader = new Map<string, boolean>();
  private readonly sheetRowIndex = new Map<string, number>();
  private readonly titleRows = new Set<string>();
  private stack: Heading[] = [];
  private fillAccount: string | null = null;
  private last: GlParsedEntry | null = null;
  private lastWasEntry = false;
  private out: GlParsedEntry[] = [];
  private readonly maxName: number;

  constructor(private readonly layout: GlLayout, opts: ParseOptions = {}) {
    for (const c of layout.columns) {
      if (c.role === "ignore" || c.role === "balance") continue;
      if (this.col[c.role] === undefined) this.col[c.role] = c.index;
      if (c.role === "name" || c.role === "memo") (this.multi[c.role] ??= []).push(c.index);
    }
    const width = Math.max(0, ...layout.columns.map((c) => c.index + 1));
    this.headerNorm = Array.from({ length: width }, (_, i) => normHeader(layout.columns.find((c) => c.index === i)?.header ?? ""));
    this.roleCols = layout.columns.filter((c) => c.role !== "ignore" && normHeader(c.header)).map((c) => c.index);
    this.maxName = opts.maxNameChars ?? 300;
  }

  /**
   * Entries produced since the last call. Unless `final`, the latest entry is
   * held back while the next row could still be its wrapped memo line.
   */
  take(final = false): GlParsedEntry[] {
    if (final || !this.lastWasEntry || this.out.length === 0) {
      const out = this.out;
      this.out = [];
      return out;
    }
    const out = this.out.slice(0, -1);
    this.out = this.out.slice(-1);
    return out;
  }

  private isHeaderRow(cells: GlCell[]): boolean {
    if (this.roleCols.length === 0) return false;
    let same = 0;
    for (const i of this.roleCols) if (normHeader(cells[i]) === this.headerNorm[i]) same++;
    return same >= Math.max(2, Math.ceil(this.roleCols.length * 0.8));
  }

  private rowText(cells: GlCell[]): string {
    return cells.map((c) => cellText(c, 200)).filter(Boolean).join(" | ").toLowerCase();
  }

  private captureBasis(text: string): boolean {
    if (CASH_BASIS_RE.test(text)) { this.stats.basis = "cash"; return true; }
    if (ACCRUAL_BASIS_RE.test(text)) { if (!this.stats.basis) this.stats.basis = "accrual"; return true; }
    return false;
  }

  private amountOf(cells: GlCell[]): { amount: number | null; debit: number | null; credit: number | null } {
    const note = (raw: GlCell) => {
      if (typeof raw === "string") {
        const cur = currencyOf(raw);
        if (cur) this.stats.currencies.add(cur);
      }
    };
    if (this.layout.amountMode === "debit_credit" && (this.col.debit !== undefined || this.col.credit !== undefined)) {
      const dRaw = this.col.debit !== undefined ? cells[this.col.debit] : null;
      const cRaw = this.col.credit !== undefined ? cells[this.col.credit] : null;
      note(dRaw); note(cRaw);
      const d = parseMoneyToCents(dRaw);
      const c = parseMoneyToCents(cRaw);
      if (d === null && c === null) return { amount: null, debit: null, credit: null };
      const debit = d === null ? null : Math.abs(d);
      const credit = c === null ? null : Math.abs(c);
      return { amount: (debit ?? 0) - (credit ?? 0), debit, credit };
    }
    const raw = this.col.amount !== undefined ? cells[this.col.amount] : null;
    note(raw);
    const a = parseMoneyToCents(raw);
    if (a === null) return { amount: null, debit: null, credit: null };
    return { amount: a, debit: a >= 0 ? a : null, credit: a < 0 ? -a : null };
  }

  private headingPath(): { account: string; number: string | null } {
    if (this.stack.length === 0) return { account: "", number: null };
    return { account: this.stack.map((h) => h.name).join(":"), number: this.stack[this.stack.length - 1].number };
  }

  private columnAccount(raw: string): { account: string; number: string | null } {
    // "Automobile Expense:6110 · Vehicle - Owner" — each level's number dropped, the leaf's kept.
    const parts = raw.split(":").map((p) => splitAccountNumber(p.trim()));
    return { account: parts.map((p) => p.name).filter(Boolean).join(":"), number: parts.map((p) => p.number).filter(Boolean).pop() ?? null };
  }

  /** Feeds one row. Rows of a sheet must arrive in order. */
  push(row: GlRawRow): void {
    const cells = row.cells;
    const nonEmpty: number[] = [];
    for (let i = 0; i < cells.length; i++) if (!isBlank(cells[i])) nonEmpty.push(i);
    if (nonEmpty.length === 0) return;
    const sheetKey = row.sheet ?? "";
    if (this.layout.sheet && row.sheet && row.sheet !== this.layout.sheet) return;

    // Before this sheet's column headings: titles (remembered), or the headings themselves.
    const index = this.sheetRowIndex.get(sheetKey) ?? 0;
    this.sheetRowIndex.set(sheetKey, index + 1);
    if (this.layout.headerRow >= 0 && !this.sheetSeenHeader.get(sheetKey)) {
      // Headings found by their text (any sheet, after page breaks); a layout
      // whose columns have no heading text goes by the row's position instead.
      const isHeader = this.roleCols.length >= 2 ? this.isHeaderRow(cells) : index === this.layout.headerRow;
      if (isHeader) {
        this.sheetSeenHeader.set(sheetKey, true);
        for (const i of nonEmpty) this.captureBasis(cellText(cells[i], 200));
        return;
      }
      const text = this.rowText(cells);
      this.captureBasis(text);
      this.titleRows.add(text);
      return;
    }
    const date = this.col.date !== undefined ? parseLedgerDate(cells[this.col.date], this.layout.dateOrder) : null;
    const { amount, debit, credit } = this.amountOf(cells);
    const entryLike = !!date && amount !== null;
    // The headings again (a page break), a title row repeated, a footer: never
    // with an entry's date and amount — the common row skips these checks.
    let text = "";
    if (!entryLike) {
      if (this.isHeaderRow(cells)) { this.stats.structural++; return; }
      text = this.rowText(cells);
      if (this.titleRows.has(text)) { this.stats.structural++; return; }
      // Footers: basis, page numbers, print timestamps.
      if (this.captureBasis(text) || PAGE_RE.test(text) || (TIMESTAMP_RE.test(text) && amount === null)) {
        this.stats.structural++;
        this.lastWasEntry = false;
        return;
      }
    }

    const firstIdx = nonEmpty[0];
    const firstRaw = cells[firstIdx];
    const firstText = cellText(firstRaw, 400);
    const leadTexts = nonEmpty.slice(0, 3).map((i) => cellText(cells[i], 400));
    if (leadTexts.some((t) => SKIP_ANYWHERE.test(t))) { this.stats.structural++; this.lastWasEntry = false; return; }
    if (!date && SKIP_WITHOUT_DATE.test(firstText)) {
      // "Total 6110 · Vehicle - Owner" closes that heading (and anything nested deeper).
      const depth = firstIdx * 1000 + leadingSpaces(firstRaw);
      while (this.stack.length && this.stack[this.stack.length - 1].depth >= depth) this.stack.pop();
      this.stats.structural++;
      this.lastWasEntry = false;
      return;
    }

    if (!date && amount === null) {
      this.stats.structural++;
      const memoCol = this.col.memo;
      const nameCol = this.col.name;
      const wrapped =
        this.lastWasEntry && this.last &&
        nonEmpty.length === 1 &&
        (firstIdx === memoCol || firstIdx === nameCol) &&
        firstIdx !== this.col.account && firstIdx > 0;
      if (wrapped && this.last) {
        if (firstIdx === memoCol) this.last.memo = `${this.last.memo ?? ""} ${firstText}`.trim().slice(0, this.maxName);
        else this.last.name = `${this.last.name ?? ""} ${firstText}`.trim().slice(0, this.maxName);
        return;
      }
      if (this.layout.accountMode === "heading_rows") {
        const depth = firstIdx * 1000 + leadingSpaces(firstRaw);
        while (this.stack.length && this.stack[this.stack.length - 1].depth >= depth) this.stack.pop();
        const { name, number } = splitAccountNumber(firstText);
        if (name) this.stack.push({ name, number, depth });
      } else if (this.col.account !== undefined) {
        const acct = cellText(cells[this.col.account], 300);
        if (acct) this.fillAccount = acct;
      }
      this.lastWasEntry = false;
      return;
    }
    if (!date || amount === null) {
      this.stats.skipped++;
      this.lastWasEntry = false;
      return;
    }
    this.stats.dataLike++;

    let account = "";
    let number: string | null = null;
    if (this.layout.accountMode === "heading_rows") {
      ({ account, number } = this.headingPath());
    } else if (this.col.account !== undefined) {
      const raw = cellText(cells[this.col.account], 300);
      if (raw) this.fillAccount = raw;
      const use = raw || this.fillAccount || "";
      ({ account, number } = this.columnAccount(use));
    }
    const numberCol = this.col.account_number !== undefined ? cellText(cells[this.col.account_number], 40) : "";
    if (numberCol) number = numberCol;
    if (!account && numberCol) account = numberCol;
    if (!account) account = "(No account)";
    const txt = (role: GlRole, max = this.maxName) => {
      const i = this.col[role];
      if (i === undefined) return null;
      const v = cellText(cells[i], max);
      return v || null;
    };
    const names = (this.multi.name ?? []).map((i) => cellText(cells[i], this.maxName)).filter(Boolean);
    const memos = Array.from(new Set((this.multi.memo ?? []).map((i) => cellText(cells[i], this.maxName)).filter(Boolean)));
    const entry: GlParsedEntry = {
      rowNo: row.rowNo,
      sheet: row.sheet,
      txnDate: date,
      account: account.slice(0, 300),
      accountKey: accountKey(account) || "no account",
      accountNumber: number,
      accountType: txt("account_type", 80),
      name: names[0] ?? null,
      memo: memos.length ? memos.join(" · ").slice(0, this.maxName) : null,
      txnType: txt("type", 80),
      txnNumber: txt("number", 80),
      debitCents: debit,
      creditCents: credit,
      amountCents: amount,
      currency: null,
    };
    this.out.push(entry);
    this.last = entry;
    this.lastWasEntry = true;
    this.stats.entries++;
  }
}

/** Parses a whole (small) list of rows — tests, the detector's dry parse. */
export function parseLedgerRows(rows: GlRawRow[], layout: GlLayout, opts: ParseOptions = {}): { entries: GlParsedEntry[]; stats: ParseStats } {
  const p = new LedgerParser(layout, opts);
  for (const r of rows) p.push(r);
  return { entries: p.take(true), stats: p.stats };
}
