/**
 * gl-api.ts — the client side of "Add-backs in the books" (server/routes/gl.ts):
 * query keys, fetchers and an upload with progress (XHR — fetch has no
 * upload progress).
 */
import type { GlLayout, GlLedgerView } from "@shared/gl-types";

export const glKeys = {
  broker: (dealId: string) => ["/api/deals", dealId, "gl"] as const,
  rows: (dealId: string, ledgerId: string, q: Record<string, unknown>) => ["/api/deals", dealId, "gl", "ledgers", ledgerId, "rows", q] as const,
  seller: (token: string) => ["/api/seller", token, "gl"] as const,
};

export interface BrokerGlData {
  fiscalYearEnd: string | null;
  ledgers: GlLedgerView[];
  unread: Array<{ documentId: string; name: string; reason: "not_read" | "pdf" }>;
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

export interface SellerGlData {
  state: "not_requested";
  fiscalYearEnd: string;
  preview: boolean;
  ledgers: SellerLedgerView[];
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
