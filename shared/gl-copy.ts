/**
 * gl-copy.ts — one vocabulary for "Add-backs in the books" (gl spec §4.1):
 * the words the seller, the broker and buyers see, in one place, so every
 * surface says the same thing. Pure; used by the server and the client.
 */
import type { GlLedgerStatus, GlProblem, GlSoftware, GlYearStatus } from "./gl-types";

export const SOFTWARE_LABEL: Record<GlSoftware, string> = {
  quickbooks_online: "QuickBooks Online",
  quickbooks_desktop: "QuickBooks Desktop",
  xero: "Xero",
  sage50: "Sage 50",
  wave: "Wave",
  freshbooks: "FreshBooks",
  other: "Accounting software",
};

/** "QuickBooks Online export" / "Spreadsheet" — never a guess dressed as fact. */
export function softwareLabel(s: GlSoftware | string | null | undefined): string {
  if (!s || s === "other") return "Ledger export";
  return `${SOFTWARE_LABEL[s as GlSoftware] ?? "Accounting software"} export`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "2024-01-03" → "Jan 3, 2024". */
export function formatDay(iso: string | null | undefined): string {
  if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return "";
  return `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}, ${iso.slice(0, 4)}`;
}

/** "2022-01-01".."2024-12-31" → "Jan 2022–Dec 2024". */
export function formatPeriod(start: string | null | undefined, end: string | null | undefined): string {
  if (!start || !end) return "";
  const m = (iso: string) => `${MONTHS[+iso.slice(5, 7) - 1]} ${iso.slice(0, 4)}`;
  return m(start) === m(end) ? m(start) : `${m(start)}–${m(end)}`;
}

/** "$1,234.56" (cents in). */
export function formatCents(cents: number, opts: { whole?: boolean } = {}): string {
  const neg = cents < 0;
  const v = Math.abs(cents) / 100;
  const s = v.toLocaleString("en-US", { minimumFractionDigits: opts.whole ? 0 : 2, maximumFractionDigits: opts.whole ? 0 : 2 });
  return `${neg ? "−" : ""}$${s}`;
}

/** "48,213". */
export function formatCount(n: number): string {
  return n.toLocaleString("en-US");
}

/** A ledger's status as a short chip (broker and seller). */
export function ledgerStatusWords(status: GlLedgerStatus, rowCount: number, period: string): string {
  switch (status) {
    case "reading": return "Reading…";
    case "ready": return `Received — ${formatCount(rowCount)} ${rowCount === 1 ? "entry" : "entries"}${period ? `, ${period}` : ""}`;
    case "needs_columns": return "Needs another look";
    case "failed": return "Needs another look";
  }
}

/** The document's one-paragraph text (documents.extracted_text) — no figures, no names (gl spec §6.4 step 5). */
export function ledgerDocumentSummary(input: { software: string | null; rowCount: number; periodStart: string | null; periodEnd: string | null; accountCount: number }): string {
  const sw = input.software && input.software !== "other" ? ` (${SOFTWARE_LABEL[input.software as GlSoftware] ?? "accounting software"})` : "";
  const when = input.periodStart && input.periodEnd ? ` from ${formatDay(input.periodStart)} to ${formatDay(input.periodEnd)}` : "";
  return `General ledger export${sw}. ${formatCount(input.rowCount)} entries${when}, ${formatCount(input.accountCount)} accounts. Read by Cimple's ledger reader to find the entries behind add-backs; individual entries are in the ledger viewer.`;
}

/** Why a ledger couldn't be read, in plain words (seller and broker). */
export const LEDGER_FAILURES = {
  notLedger: "This doesn't look like a general ledger — it has no dates and amounts by account. Export the 'General Ledger' report, not a Profit and Loss.",
  pdf: "A PDF ledger can't be matched entry by entry. Please export the Excel or CSV version.",
  tooBigXlsx: (size: string) => `This file is ${size} — Excel files over 15 MB are too big to read. Save it as CSV (File → Save As → CSV) and upload that.`,
  tooBigCsv: (size: string) => `This file is ${size} — ledger files can be up to 60 MB. Export one year at a time and upload each file.`,
  unreadable: "We couldn't open this file — it may be damaged or password-protected. Export it again.",
  noCopy: "There is no copy of this file left on the server — upload it again.",
  rowsCap: "This ledger has more than 300,000 entries — export one year at a time and upload each file.",
  dealRowsCap: "This deal already has 400,000 ledger entries — upload one year at a time, or remove a file you no longer need.",
  restarted: "Cimple was restarted while reading this ledger — click Read it again.",
  unsupported: "Ledgers can be read from Excel (.xlsx, .xls) or CSV files. Export the 'General Ledger' report as Excel or CSV.",
} as const;

export const NEEDS_COLUMNS_MESSAGE =
  "We couldn't tell which column is which. The easiest fix: export the standard General Ledger report and upload that instead. Or leave it — your broker will sort it out.";

/** Plain problem lines (each with what to do). */
export function problemMessage(p: Pick<GlProblem, "kind" | "years" | "count">, ctx: { requiredYears?: string[] } = {}): string {
  const years = (p.years ?? []).join(", ").replace(/, ([^,]*)$/, " and $1");
  switch (p.kind) {
    case "missing_years":
      return `Your ledger doesn't include ${years}. Your broker also needs ${years === "" ? "the other years" : years} — export ${p.years && p.years.length > 1 ? "those years" : "that year"} and add the file.`;
    case "partial_year":
      return `${years}: the ledger covers only part of the year. Export the full year and add the file.`;
    case "cash_basis":
      return "This ledger was exported on a cash basis. Export it again with the accounting method set to Accrual.";
    case "duplicates_skipped":
      return `${formatCount(p.count ?? 0)} entries were already in your earlier file — we skipped the copies.`;
    case "rows_skipped":
      return `Some rows had no date or amount and were skipped (${formatCount(p.count ?? 0)}).`;
    case "dates_ambiguous":
      return "Every date in this ledger could be read day-first or month-first; we read them month-first. If that's wrong, export the dates as YYYY-MM-DD.";
    case "mixed_currencies":
      return "This ledger has amounts in more than one currency. Your broker will check them.";
    case "rows_cap":
      return LEDGER_FAILURES.rowsCap;
  }
}

/** Per-year status words for the seller's chip, the broker's grid cell and buyers (§4.1). */
export const YEAR_STATUS_WORDS: Record<GlYearStatus, { seller: string; broker: string; buyer: string | null }> = {
  found: { seller: "Done", broker: "Adds up", buyer: "Found in the books" },
  close: { seller: "Almost", broker: "Close", buyer: "Found in the books" },
  short: { seller: "Needs you", broker: "Short", buyer: "Partly found" },
  over: { seller: "Needs you", broker: "Over", buyer: "Partly found" },
  document: { seller: "Done — shown by a document", broker: "Shown by a document", buyer: "Shown by a document" },
  not_started: { seller: "Not started", broker: "Not started", buyer: null },
  not_in_ledger: { seller: "Not in this ledger", broker: "Not in this ledger", buyer: "Not found" },
  statement: { seller: "", broker: "From the statements", buyer: "From the financial statements" },
  left_out: { seller: "", broker: "Left out", buyer: null },
};
