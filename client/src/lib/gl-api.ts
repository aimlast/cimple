/**
 * gl-api.ts — the client side of "Add-backs in the books" (server/routes/gl.ts):
 * query keys, fetchers and an upload with progress (XHR — fetch has no
 * upload progress).
 */
import type { GlCostSummary, GlLayout, GlLedgerView, GlSellerSuggestion, GlTieOutYear, GlTraceComputed, GlYearStatus } from "@shared/gl-types";
import type { GlTracingProgress } from "@shared/deal-progress";

export const glKeys = {
  broker: (dealId: string) => ["/api/deals", dealId, "gl"] as const,
  progress: (dealId: string) => ["/api/deals", dealId, "gl", "progress"] as const,
  rows: (dealId: string, ledgerId: string, q: Record<string, unknown>) => ["/api/deals", dealId, "gl", "ledgers", ledgerId, "rows", q] as const,
  brokerEntries: (dealId: string, traceId: string) => ["/api/deals", dealId, "gl", "traces", traceId, "entries"] as const,
  seller: (token: string) => ["/api/seller", token, "gl"] as const,
  sellerEntries: (token: string, traceId: string) => ["/api/seller", token, "gl", "entries", traceId] as const,
};

export type GlProofKind = "ledger" | "payroll" | "one_off" | "statement";
export type GlGateState = "not_needed" | "waived" | "done" | "not_requested" | "with_seller" | "with_broker";

export interface GlGate {
  state: GlGateState;
  toGo: number;
  total: number;
  holdsDd: boolean;
  holdsCim: boolean;
  holdAll: boolean;
  message: string | null;
}

export interface BrokerTrace {
  id: string;
  addbackKey: string;
  label: string;
  category: string | null;
  proof: GlProofKind;
  proofLabel: string;
  proofByBroker: boolean;
  sharePct: number | null;
  shareBasis: string | null;
  shareBasisDoc: string | null;
  claims: Record<string, number>;
  yearLabels: Record<string, string>;
  sellerLabel: string;
  sellerHint: string | null;
  privateEvidence: boolean;
  sentAt: string | null;
  sellerStatus: string;
  reopenedNote: string | null;
  sellerNote: string | null;
  sellerNoteShown: boolean;
  notInLedger: { reason: string; at: string; years?: string[] } | null;
  question: { text: string; askedAt: string; answer?: string; answeredAt?: string } | null;
  brokerVerdict: "found" | "partly_found" | "not_found" | null;
  reviewedAt: string | null;
  brokerNote: string | null;
  brokerNoteShown: boolean;
  buyerReason: string | null;
  leftOut: { years: string[]; reason: string } | null;
  includeInCim: boolean;
  computed: GlTraceComputed | null;
  cells: Record<string, { words: string; status: string; tone: "good" | "close" | "warn" | "muted" }>;
  proposedYears: string[];
  /** What Cimple's assistant is doing (or did) for this add-back, in words. */
  assistant?: { state: string; words: string } | null;
  /** A removed add-back whose ticked entries look like they belong here. */
  moveFrom?: { traceId: string; label: string; count: number } | null;
}

export interface GlRecipient { id: string; name: string | null; email: string; role: string; via: "members" | "seller_invite"; muted: boolean }

export interface PossibleAddback { accountKey: string; account: string; years: Record<string, number>; totalCents: number; why: string }

export interface BrokerGlData {
  fiscalYearEnd: string | null;
  /** The fiscal years to ask for (the analysis's, else the three before this one). */
  requestedYears: string[];
  ledgers: GlLedgerView[];
  unread: Array<{ documentId: string; name: string; reason: "not_read" | "pdf" }>;
  /** The add-backs couldn't load (the ledgers still show). */
  tracesError?: boolean;
  analysis?: { present: boolean };
  tracing?: {
    fiscalYearEnd: string;
    requestedAt: string | null;
    recipients: Array<{ memberId: string | null; inviteId: string | null; role: string }>;
    sellerMessage: string | null;
    lastRemindedAt: string | null;
    withdrawnAt: string | null;
    sellerDoneAt: string | null;
    sellerConfirmation: { role: "owner" | "accountant"; memberId: string | null; name: string | null; at: string } | null;
    cantGetLedger: { reason: string; note?: string; at: string } | null;
    accountantRequest: { memberId: string; name: string; email: string; at: string; sentAt?: string; declinedAt?: string } | null;
    waived: { reason: string; at: string; by: string } | null;
    reviewedAt: string | null;
    requireBeforeCim: boolean;
    publishedAt: string | null;
  };
  traces?: BrokerTrace[];
  tieOut?: { years: Array<{ year: string; state: GlTieOutYear["state"]; words: string; accepted: { note: string; at: string } | null; data: GlTieOutYear }>; summary: { tone: "good" | "warn" | "muted"; text: string } };
  gate?: GlGate;
  seller?: { name: string | null; email: string | null } | null;
  sellerLastActiveAt?: string | null;
  recipients?: GlRecipient[];
  suggestions?: GlSellerSuggestion[];
  possible?: PossibleAddback[];
  payDoc?: { slips: string; short: string; box: string | null };
  demo?: boolean;
  /** What buyers see now and what changed since the broker published. */
  buyers?: { publishedAt: string | null; versions: GlVersions | null; changes: string[] };
}

export interface GlVersions { dd: boolean; normal: boolean; blind: boolean }

/** GET …/gl/publish-preview — the "What buyers see about the add-backs" dialog. */
export interface GlPublishPreview {
  gate: GlGate;
  canPublish: boolean;
  blocked: string | null;
  versions: GlVersions;
  reasons: { normal: string | null; blind: string | null };
  notes: { normal: string | null; blind: string | null };
  lines: Array<{
    key: string; traceId: string; label: string; status: "found" | "partly_found" | "not_found" | "document" | "statement"; statusWords: string; defaultLeftOut: boolean; years: string[];
    /** "Why it's added back" exactly as due-diligence buyers will read it (null = none shown). */
    why: string | null;
    /** The text as saved ("" = the broker chose to show none). */
    whyText: string | null;
    /** Saved text that names someone or something held back — buyers don't see it. */
    whyHeld: boolean;
  }>;
  warnings: string[];
  published: { at: string; versions: GlVersions; leaveOut: string[] } | null;
  changes: string[];
  agreeYears: string[];
  /** The CIM's earnings bridge (its title) when it shows other add-backs or amounts — Full/Blind wait until it's regenerated. */
  bridgeMismatch: string | null;
}

export interface GlProgressData { glTracing: GlTracingProgress | null; gate?: GlGate | null }

export interface BrokerEntry {
  id: string; ledgerId: string; rowNo: number; fiscalYear: string; date: string | null; account: string | null; name: string | null; memo: string | null;
  amountCents: number; state: "proposed" | "confirmed" | "rejected" | "orphaned"; proposedBy: string | null; confidence: string | null; reason: string | null;
  decidedBy: string | null; showDetails: boolean | null; privateLedger: boolean;
  /** Ticked entries: what the rules withhold from due-diligence buyers (before the broker's choice). */
  buyerWithheld?: "personal" | "staff" | "keep_out" | null;
}
export interface BrokerEntriesData {
  entries: BrokerEntry[];
  documents: Array<{ id: string; documentId: string; fiscalYear: string; amountCents: number; check: string | null; name: string; fileUrl: string | null }>;
}

/** One cost on the seller's page (server/gl/seller-view.ts — a whitelist). */
export interface SellerCost {
  id: string;
  sellerLabel: string;
  sellerHint: string | null;
  proof: "ledger" | "payroll" | "one_off";
  shareWords: string | null;
  years: Array<{ year: string; yearLabel: string; claimedCents: number; targetCents: number; status: GlYearStatus; foundCents: number; documentCents: number; diffCents: number; chip: string; inLedger: boolean }>;
  summary: GlCostSummary | null;
  sellerStatus: string;
  reopenedNote: string | null;
  question: { text: string; askedAt: string; answer: string | null } | null;
  note: string | null;
  notInLedger: string | null;
  /** Cimple's assistant is looking for more entries right now. */
  assistantLooking?: boolean;
}

export interface SellerEntry {
  ledgerId: string; rowNo: number; fiscalYear: string; date: string; account: string; name: string | null; memo: string | null; amountCents: number;
  state?: "proposed" | "confirmed" | "rejected"; reason?: string | null; confidence?: string | null; mine?: boolean;
}
export interface SellerEntriesData {
  entries: SellerEntry[];
  documents: Array<{ documentId: string; fiscalYear: string; amountCents: number; check: string | null; name: string }>;
}

/** What the seller's link sees about their ledgers. */
export interface SellerLedgerView {
  id: string;
  fileName: string;
  role: "ledger" | "adjustments";
  status: GlLedgerView["status"];
  periodStart: string | null;
  periodEnd: string | null;
  rowCount: number;
  years: string[];
  progress: { rowsRead: number } | null;
  problems: Array<{ kind: string; message: string; years: string[]; count: number | null }>;
  failure: string | null;
}

export type SellerGlState = "not_requested" | "requested" | "in_progress" | "question" | "reopened" | "waiting_for_accountant" | "waiting_for_broker" | "withdrawn" | "done";

export interface SellerGlData {
  state: SellerGlState;
  fiscalYearEnd: string;
  requestedYears: string[];
  preview: boolean;
  ledgers: SellerLedgerView[];
  businessName?: string | null;
  total?: number;
  done?: number;
  message?: string | null;
  costs?: SellerCost[];
  confirmation?: { at: string; name: string | null } | null;
  accountant?: { name: string; status: "pending" | "sent" | "declined" } | null;
  cantGetLedger?: { reason: string } | null;
  otherCosts?: Array<{ id: string; text: string; at: string; entries: number }>;
  payDoc?: { slips: string; short: string; box: string | null };
}

export interface LedgerRowsResponse {
  ledger: GlLedgerView;
  years: string[];
  accounts: Array<{ accountKey: string; account: string; lines: number; netCents: number }>;
  page: number;
  pageSize: number;
  total: number;
  rows: Array<{
    rowNo: number; sheet: string | null; date: string; fiscalYear: string; account: string; accountKey: string; accountNumber: string | null;
    name: string | null; memo: string | null; type: string | null; number: string | null; amountCents: number; duplicate: boolean; hint: string | null;
  }>;
}

export interface LedgerSample {
  sheet: string | null;
  rows: Array<{ rowNo: number; cells: string[] }>;
  guess: GlLayout | null;
}

/** The server's own error message from a failed response. */
export async function errorText(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json();
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* not JSON */
  }
  return fallback;
}

export async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const r = await fetch(url, { credentials: "include", ...init });
  if (!r.ok) {
    const err = new Error(await errorText(r, "Something went wrong — try again.")) as Error & { status?: number };
    err.status = r.status;
    throw err;
  }
  return r.json() as Promise<T>;
}

export async function sendJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(await errorText(r, "Something went wrong — try again."));
  return r.json() as Promise<T>;
}

/** Uploads one file with progress (0–1). Resolves with the JSON reply; rejects with the server's plain message. */
export function uploadWithProgress<T>(url: string, file: File, fields: Record<string, string>, onProgress: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: any = null;
      try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(body as T);
      else reject(new Error(body?.error || (xhr.status === 413 ? "Ledger files can be up to 60 MB as CSV or 15 MB as Excel." : "The upload didn't go through — try again.")));
    };
    xhr.onerror = () => reject(new Error("The upload didn't go through — check your connection and try again."));
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    fd.append("file", file, file.name);
    xhr.send(fd);
  });
}

/** Files the ledger reader takes, and its sizes. */
export const LEDGER_ACCEPT = ".xlsx,.xls,.csv,.tsv,.txt";
export const LEDGER_CSV_MAX = 60 * 1024 * 1024;
export const LEDGER_XLSX_MAX = 15 * 1024 * 1024;

/** A file the browser can refuse before uploading (wrong type, too big), with the plain reason. */
export function checkLedgerFile(file: File): string | null {
  const ext = (file.name.match(/\.[^.]+$/)?.[0] ?? "").toLowerCase();
  if (ext === ".pdf") return "A PDF ledger can't be matched entry by entry. Please export the Excel or CSV version.";
  if (![".xlsx", ".xls", ".csv", ".tsv", ".txt"].includes(ext)) return "Ledgers can be uploaded as Excel (.xlsx, .xls) or CSV files. Export the 'General Ledger' report as Excel or CSV.";
  const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(0)} MB`;
  if ((ext === ".xlsx" || ext === ".xls") && file.size > LEDGER_XLSX_MAX) return `This file is ${mb(file.size)} — Excel files over 15 MB are too big to read. Save it as CSV (File → Save As → CSV) and upload that.`;
  if (file.size > LEDGER_CSV_MAX) return `This file is ${mb(file.size)} — ledger files can be up to 60 MB. Export one year at a time and upload each file.`;
  return null;
}
