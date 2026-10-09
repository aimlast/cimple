/**
 * gl-types.ts — the shapes of the general-ledger stream ("Add-backs in the
 * books", server/gl/*). Shared by the server, the client and the schema's
 * jsonb columns. Pure types plus the fiscal-year helper re-export.
 */
import type { DocumentSourceMeta } from "./schema";

export { fiscalYearKey, fiscalYearOfDate, fiscalYearRange, normaliseFiscalYearEnd } from "./fiscal-year";

/** What a spreadsheet column holds. */
export type GlRole =
  | "date" | "account" | "account_number" | "account_type" | "name" | "memo" | "type" | "number"
  | "debit" | "credit" | "amount" | "balance" | "ignore";

export type GlAccountMode = "column" | "heading_rows" | "column_fill_down";
export type GlDateOrder = "ymd" | "mdy" | "dmy";
export type GlAmountMode = "debit_credit" | "single";

/** How a ledger file is laid out — found by the detector, the assistant, or set by the broker. */
export interface GlLayout {
  /** 0-based index of the column-heading row within its sheet's non-blank rows. */
  headerRow: number;
  columns: Array<{ index: number; role: GlRole; header: string }>;
  accountMode: GlAccountMode;
  dateOrder: GlDateOrder;
  amountMode: GlAmountMode;
  /** The sheet the layout was found on (XLSX); null/undefined for CSV, or "every sheet with these headings". */
  sheet?: string | null;
}

export type GlSoftware = "quickbooks_online" | "quickbooks_desktop" | "xero" | "sage50" | "wave" | "freshbooks" | "other";
export type GlBasis = "accrual" | "cash";
export type GlLedgerStatus = "reading" | "needs_columns" | "ready" | "failed";
export type GlLedgerRole = "ledger" | "adjustments";
export type GlLayoutBy = "detector" | "ai" | "broker";

export interface GlYearSummary {
  lines: number;
  debitCents: number;
  creditCents: number;
  accounts: number;
  firstDate: string;
  lastDate: string;
}

export type GlProblemKind =
  | "missing_years" | "duplicates_skipped" | "rows_skipped" | "partial_year" | "rows_cap"
  | "dates_ambiguous" | "mixed_currencies" | "cash_basis";

export interface GlProblem {
  kind: GlProblemKind;
  message: string;
  years?: string[];
  count?: number;
}

export type GlYearStatus =
  | "found" | "close" | "short" | "over" | "document" | "not_started" | "not_in_ledger" | "statement" | "left_out";

export interface GlCostSummary {
  accounts: string[];
  years: string[];
  totalCents: number;
}

export interface GlTraceComputed {
  byYear: Record<string, {
    claimedCents: number; targetCents: number; foundCents: number; documentCents: number; diffCents: number;
    status: GlYearStatus; reason?: string; confirmed: number; proposed: number; privateOnly: boolean;
  }>;
  overall: GlYearStatus;
  suggestedVerdict: "found" | "partly_found" | "not_found";
  summary: GlCostSummary | null;
  updatedAt: string;
}

export interface GlTieOutYear {
  state: "agrees" | "differs" | "cannot_check";
  revenue?: { statements: number; ledger: number };
  netIncome?: { statements: number; ledger: number };
  differenceCents?: number;
  likelyReason?: "year_end_entries" | "partial_year" | "cash_basis" | "unclassified_accounts" | "no_statements" | null;
  unclassified?: Array<{ accountKey: string; account: string; netCents: number }>;
}

export interface GlSellerSuggestion {
  id: string;
  text: string;
  entries: Array<{ ledgerId: string; rowNo: number; txnDate: string; account: string; name: string | null; memo: string | null; amountCents: number }>;
  at: string;
  byMember: string | null;
  status: "new" | "added" | "dismissed";
}

/** gl's own keys on documents.source_meta (TS only; the column is jsonb). */
export type GlSourceMeta = DocumentSourceMeta & {
  /** The broker chose "Read it as a normal document instead" — never sniffed as a ledger again. */
  notLedger?: boolean;
  /** A support document (T4, payroll summary, invoice) uploaded for this trace. */
  glTraceId?: string;
  /** Why a file filed as a ledger can't be read entry by entry (a PDF ledger). */
  glNote?: string;
};

/** One row of a ledger file as read (before parsing): 1-based across sheets. */
export interface GlRawRow {
  sheet: string | null;
  /** 1-based line in the file (across sheets) — the citation. */
  rowNo: number;
  cells: GlCell[];
}

/** A cell as read: text, a number, or an ISO date (yyyy-mm-dd) from a date-formatted spreadsheet cell. */
export type GlCell = string | number | { date: string } | null;

/** One parsed ledger entry, ready to store. */
export interface GlParsedEntry {
  rowNo: number;
  sheet: string | null;
  txnDate: string;
  account: string;
  accountKey: string;
  accountNumber: string | null;
  accountType: string | null;
  name: string | null;
  memo: string | null;
  txnType: string | null;
  txnNumber: string | null;
  debitCents: number | null;
  creditCents: number | null;
  amountCents: number;
  currency: string | null;
}

/** What the broker (and the seller, for their own ledgers) sees about a ledger file. */
export interface GlLedgerView {
  id: string;
  documentId: string;
  fileName: string;
  role: GlLedgerRole;
  status: GlLedgerStatus;
  software: GlSoftware | null;
  basis: GlBasis | null;
  periodStart: string | null;
  periodEnd: string | null;
  years: Record<string, GlYearSummary>;
  rowCount: number;
  accountCount: number;
  duplicateCount: number;
  skippedCount: number;
  progress: { rowsRead: number; rowsSaved: number; at: string } | null;
  problems: GlProblem[];
  failure: string | null;
  uploadedBy: "broker" | "seller";
  /** "shared": the seller can see it; "broker": private to the broker (D25). */
  audience: "shared" | "broker";
  layoutBy: GlLayoutBy | null;
  showStaffNames: boolean;
  allowOriginalDownload: boolean;
  createdAt: string;
}

/** What buyers are shown about the add-backs (gl_tracing.published) — the shape lives in shared/gl-evidence.ts. */
export type { GlPublishedEvidence } from "./gl-evidence";
