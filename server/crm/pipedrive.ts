/**
 * pipedrive.ts — the one way Cimple talks to the Pipedrive v1 API.
 *
 *   - Honours PIPEDRIVE_API_BASE so everything can run against a local fake
 *     (scripts/fake-pipedrive.mjs) — never the real API in tests.
 *   - Sends the token in the `x-api-token` header, not the query string, so
 *     it never lands in a proxy or server log. (If Pipedrive ever answers 401
 *     to the header, the request is retried once with `api_token` in the
 *     query — the older documented form — and that form is used from then on.)
 *   - Retries 429s (Retry-After, else exponential back-off) and 5xx blips.
 *   - pdAll() walks every page of a list endpoint (start / limit).
 *
 * Used by the connect route, the buyer-decision stage sync (sync.ts), buyer
 * prefill (buyer-prefill.ts) and the seller-side CRM import (seller-import.ts).
 * (server/crm/buyer-sync.ts still has its own copy of these helpers.)
 */
import { storage } from "../storage";
import type { Integration } from "@shared/schema";

export const pipedriveBase = (): string => (process.env.PIPEDRIVE_API_BASE || "https://api.pipedrive.com").replace(/\/+$/, "");

export class PipedriveError extends Error {
  constructor(message: string, readonly status: number, readonly path: string) {
    super(message);
    this.name = "PipedriveError";
  }
}

type Params = Record<string, string | number | boolean | undefined | null>;

function buildUrl(path: string, params: Params = {}): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  const q = qs.toString();
  return `${pipedriveBase()}${path}${q ? (path.includes("?") ? "&" : "?") + q : ""}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Flipped to true (for this process) if the header form is ever refused but the query form works. */
let tokenInQuery = false;
const REQUEST_TIMEOUT_MS = 30_000;

/** Low-level request with retries. Returns the raw Response (ok) or throws PipedriveError. */
async function pdFetch(
  token: string,
  path: string,
  init: { method?: string; params?: Params; body?: unknown } = {},
  forceQuery = false,
): Promise<Response> {
  let queryForm = tokenInQuery || forceQuery;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 5; attempt++) {
    const url = buildUrl(path, queryForm ? { ...init.params, api_token: token } : init.params);
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method || "GET",
        headers: {
          ...(queryForm ? {} : { "x-api-token": token }),
          Accept: "application/json",
          ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err: any) {
      // Network error / timeout — retry a couple of times, then give up.
      if (attempt < 2) { await sleep(500 * 2 ** attempt); continue; }
      throw new PipedriveError(`Couldn't reach Pipedrive (${err?.name === "TimeoutError" ? "timed out" : "network error"})`, 0, path);
    }
    lastStatus = res.status;
    if (res.status === 429 || res.status >= 500) {
      if (attempt === 4) break;
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt;
      await res.body?.cancel().catch(() => {});
      await sleep(waitMs);
      continue;
    }
    if (res.status === 401 && !queryForm) {
      // Header form refused — try the query-string form once.
      await res.body?.cancel().catch(() => {});
      const retry = await pdFetch(token, path, init, true);
      tokenInQuery = true;
      return retry;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      const msg =
        res.status === 401 ? "Pipedrive rejected the API token"
        : res.status === 403 ? "Pipedrive didn't allow access to that"
        : res.status === 404 ? "Not found in Pipedrive"
        : `Pipedrive answered ${res.status}`;
      throw new PipedriveError(msg, res.status, path);
    }
    return res;
  }
  throw new PipedriveError(lastStatus === 429 ? "Pipedrive is rate-limiting requests — try again in a minute" : "Pipedrive is having trouble — try again shortly", lastStatus, path);
}

/** GET/PUT/POST a JSON endpoint; returns the parsed body ({success, data, additional_data}). */
export async function pd<T = any>(
  token: string,
  path: string,
  params: Params = {},
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const res = await pdFetch(token, path, { ...init, params });
  return (await res.json().catch(() => null)) as T;
}

/** `data` of a JSON endpoint (null when Pipedrive returns none). */
export async function pdData<T = any>(token: string, path: string, params: Params = {}): Promise<T | null> {
  const body = await pd<{ data?: T }>(token, path, params);
  return (body?.data ?? null) as T | null;
}

/** Every page of a v1 list endpoint, up to `cap` items. */
export async function pdAll<T = any>(token: string, path: string, params: Params = {}, cap = 2000): Promise<T[]> {
  const out: T[] = [];
  let start = 0;
  for (let guard = 0; guard < 200 && out.length < cap; guard++) {
    const body = await pd<any>(token, path, { ...params, start, limit: 500 });
    const page: T[] = Array.isArray(body?.data) ? body.data : [];
    out.push(...page);
    const pg = body?.additional_data?.pagination;
    if (!pg?.more_items_in_collection || page.length === 0) break;
    const next = Number(pg.next_start);
    start = Number.isFinite(next) && next > start ? next : start + page.length;
  }
  return out.slice(0, cap);
}

/** Downloads a binary (e.g. /v1/files/:id/download). */
export async function pdDownload(
  token: string,
  path: string,
  maxBytes: number,
): Promise<{ buffer: Buffer; contentType: string | null }> {
  const res = await pdFetch(token, path);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new PipedriveError("File is too large to import", 413, path);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > maxBytes) throw new PipedriveError("File is too large to import", 413, path);
  return { buffer, contentType: res.headers.get("content-type") };
}

/** The token owner (users/me) — used to validate a token and to build record links. */
export async function pipedriveMe(token: string): Promise<{ id: number; name: string; companyDomain: string | null } | null> {
  const me = await pdData<any>(token, "/v1/users/me");
  if (!me) return null;
  return {
    id: Number(me.id),
    name: String(me.name || ""),
    companyDomain: typeof me.company_domain === "string" && me.company_domain ? me.company_domain : null,
  };
}

/** true when Pipedrive accepts the token; throws PipedriveError on network trouble. */
export async function validatePipedriveToken(token: string): Promise<boolean> {
  try {
    const body = await pd<any>(token, "/v1/users/me");
    return !!body?.success;
  } catch (err) {
    if (err instanceof PipedriveError && (err.status === 401 || err.status === 403)) return false;
    throw err;
  }
}

/** The broker's connected Pipedrive integration (with a token), or null. */
export async function getPipedriveIntegration(brokerId: string): Promise<(Integration & { accessToken: string }) | null> {
  const integrations = await storage.getIntegrationsByBroker(brokerId);
  const row = integrations.find((i) => i.provider === "pipedrive" && i.status === "connected" && !!i.accessToken);
  return (row as Integration & { accessToken: string }) ?? null;
}

/** Web link to a record in the broker's Pipedrive account (null without a company domain). */
export function pipedriveRecordUrl(companyDomain: string | null | undefined, type: "deal" | "organization" | "person", id: string | number): string | null {
  if (!companyDomain || !/^[a-z0-9-]+$/i.test(companyDomain)) return null;
  return `https://${companyDomain}.pipedrive.com/${type}/${id}`;
}

// ── Record helpers ──────────────────────────────────────────────────────

/** The primary (else first) email of a v1 person (array of {value, primary} or a string). */
export function personEmail(p: any): string | null {
  const raw = Array.isArray(p?.email)
    ? p.email.find((x: any) => x?.primary && x?.value)?.value || p.email.find((x: any) => x?.value)?.value
    : Array.isArray(p?.emails) ? p.emails[0] : p?.primary_email || p?.email;
  const e = typeof raw === "string" ? raw.trim() : "";
  return e.includes("@") ? e.toLowerCase() : null;
}

export function personPhone(p: any): string | null {
  const raw = Array.isArray(p?.phone)
    ? p.phone.find((x: any) => x?.primary && x?.value)?.value || p.phone.find((x: any) => x?.value)?.value
    : Array.isArray(p?.phones) ? p.phones[0] : p?.phone;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

/** The numeric id inside a v1 relation field ({value, name} or a bare id). */
export function relId(v: any): string | null {
  if (v == null) return null;
  if (typeof v === "object") return v.value != null ? String(v.value) : v.id != null ? String(v.id) : null;
  return String(v);
}

/** Pipedrive note / mail HTML → readable plain text. */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return "";
  return String(html)
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
