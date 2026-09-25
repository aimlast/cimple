/**
 * Log redaction — bearer tokens must never reach logs.
 *
 * Seller links, buyer view rooms, approval pages, NDA signing and password
 * set/reset all authenticate with a token that sits in the URL path. Anyone
 * who can read the request log (Railway, Sentry) could open those pages, so
 * every log line, response body and Sentry event is scrubbed here first.
 */

// API routes whose first segment after the prefix is a bearer token.
const TOKEN_PATH_PREFIXES = [
  "invites",
  "seller",
  "view",
  "sign-nda",
  "approve",
  "buyer-access",
  "buyer-approval-review",
  "buyer-auth/set-password",
  "broker-auth/reset-password",
];

const API_TOKEN_PATH = new RegExp(
  `^(/api/(?:${TOKEN_PATH_PREFIXES.map((p) => p.replace(/[-/]/g, (c) => `\\${c}`)).join("|")}))/[^/?#]+`,
);

/** True when the path's first segment after a token prefix is a bearer token. */
export function isTokenPath(path: string): boolean {
  return API_TOKEN_PATH.test(path);
}

/** '/api/invites/abc-123/x' → '/api/invites/:token/x'. Other paths are unchanged. */
export function redactLogPath(path: string): string {
  return path.replace(API_TOKEN_PATH, "$1/:token");
}

// Client (SPA) links that carry a token, as they appear inside emails, SMS
// bodies and JSON responses (e.g. "https://app.cimple.ca/seller/<token>").
const LINK_TOKEN = new RegExp(
  "(/(?:api/)?(?:" +
    [
      "invites",
      "seller",
      "view",
      "review",
      "approve",
      "sign-nda",
      "nda",
      "buyer-access",
      "buyer-approval-review",
      "buyer/set-password",
      "buyer-auth/set-password",
      "broker/reset-password",
      "broker-auth/reset-password",
      "buyer/reset-password",
      "reset-password",
      "set-password",
    ]
      .map((p) => p.replace(/[-/]/g, (c) => `\\${c}`))
      .join("|") +
    "))/[A-Za-z0-9_\\-]{12,}",
  "g",
);
// Query-string tokens (?token=…, ?t=…).
const QUERY_TOKEN = /([?&](?:token|t|key|access_token)=)[^&\s"'#]+/gi;

/** Scrub token-bearing links and query parameters out of free text. */
export function redactLogText(text: string): string {
  return text.replace(LINK_TOKEN, "$1/:token").replace(QUERY_TOKEN, "$1[redacted]");
}

const SECRET_KEY = /token|secret|password|passwd|api[_-]?key|authorization|cookie/i;

/**
 * Deep copy of a JSON value with secret-looking keys blanked and token links
 * scrubbed from strings. Depth- and size-bounded: it only feeds a log line.
 */
export function redactLogBody(value: unknown, depth = 0): unknown {
  if (value == null) return value;
  if (typeof value === "string") return redactLogText(value);
  if (typeof value !== "object") return value;
  if (depth > 6) return "[…]";
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redactLogBody(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Counters like "maxTokens"/"tokenCount" are harmless numbers; only
    // string/object values under a secret-looking key are withheld.
    out[k] = SECRET_KEY.test(k) && v != null && typeof v !== "number" && typeof v !== "boolean"
      ? "[redacted]"
      : redactLogBody(v, depth + 1);
  }
  return out;
}

/**
 * The one-line request log. Token routes never log their response body
 * (it can echo deal or buyer data tied to the token).
 */
export function formatRequestLogLine(
  method: string,
  path: string,
  status: number,
  durationMs: number,
  body: unknown,
): string {
  let line = `${method} ${redactLogPath(path)} ${status} in ${durationMs}ms`;
  if (body !== undefined && !isTokenPath(path)) {
    let json: string | undefined;
    try {
      json = JSON.stringify(redactLogBody(body));
    } catch {
      json = undefined;
    }
    if (json) line += ` :: ${json}`;
  }
  if (line.length > 80) line = line.slice(0, 79) + "…";
  return line;
}

/** Sentry beforeSend / beforeBreadcrumb scrubber (mutates and returns the event). */
export function scrubSentryEvent<T extends Record<string, any>>(event: T): T {
  try {
    const req = (event as any).request;
    if (req) {
      if (typeof req.url === "string") req.url = redactLogText(redactUrlPath(req.url));
      if (typeof req.query_string === "string") req.query_string = "[redacted]";
      else if (req.query_string) req.query_string = "[redacted]";
      if (req.headers) {
        for (const h of Object.keys(req.headers)) {
          if (SECRET_KEY.test(h)) req.headers[h] = "[redacted]";
        }
      }
      if (req.cookies) req.cookies = "[redacted]";
      if (req.data) req.data = redactLogBody(req.data);
    }
    if (typeof (event as any).transaction === "string") {
      (event as any).transaction = redactLogText(redactUrlPath((event as any).transaction));
    }
    if (typeof (event as any).message === "string") {
      (event as any).message = redactLogText((event as any).message);
    }
    const data = (event as any).data;
    if (data && typeof data === "object") {
      for (const k of ["url", "to", "from"]) {
        if (typeof data[k] === "string") data[k] = redactLogText(redactUrlPath(data[k]));
      }
    }
    const crumbs = (event as any).breadcrumbs;
    const list = Array.isArray(crumbs) ? crumbs : Array.isArray(crumbs?.values) ? crumbs.values : null;
    if (list) for (const c of list) scrubSentryEvent(c);
  } catch {
    // never let scrubbing break error reporting
  }
  return event;
}

/** Redact the token segment in a full URL or a "GET /path" transaction name. */
function redactUrlPath(s: string): string {
  return s.replace(/(^|\s|https?:\/\/[^/\s]+)(\/api\/[^\s?#]*)/g, (_m, pre, p) => pre + redactLogPath(p));
}
