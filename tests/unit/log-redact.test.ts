/**
 * Request-log redaction — bearer tokens never reach a log line.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/log-redact.test.ts
 */
import assert from "node:assert/strict";
import {
  formatRequestLogLine,
  redactLogBody,
  redactLogPath,
  redactLogText,
  scrubSentryEvent,
} from "../../server/log-redact";

const TOKEN = "3f2b1c9e-5a4d-4e8f-9b7a-0c1d2e3f4a5b";

// Every token-bearing API prefix.
const prefixes = [
  "/api/invites",
  "/api/seller",
  "/api/view",
  "/api/sign-nda",
  "/api/approve",
  "/api/buyer-access",
  "/api/buyer-approval-review",
  "/api/buyer-auth/set-password",
];
assert.equal(redactLogPath("/api/invites/abc-123/x"), "/api/invites/:token/x");
for (const p of prefixes) {
  assert.equal(redactLogPath(`${p}/${TOKEN}`), `${p}/:token`, p);
  assert.equal(redactLogPath(`${p}/${TOKEN}/events`), `${p}/:token/events`, p);
}
// Ordinary broker routes are untouched.
assert.equal(redactLogPath("/api/deals/123/buyers"), "/api/deals/123/buyers");
assert.equal(redactLogPath("/api/viewer/x"), "/api/viewer/x");
assert.equal(redactLogPath("/api/broker-auth/reset-password"), "/api/broker-auth/reset-password");

// Full log line: no token, no body for token routes.
for (const p of prefixes) {
  const line = formatRequestLogLine("GET", `${p}/${TOKEN}/progress`, 200, 12, { dealId: "d1", businessName: "Acme" });
  assert.ok(!line.includes(TOKEN), line);
  assert.ok(!line.includes("::"), `body logged for token route: ${line}`);
}
// Short token fragments cannot survive either (the old line fit a whole UUID).
const invLine = formatRequestLogLine("GET", `/api/invites/${TOKEN}`, 200, 3, { token: TOKEN });
assert.equal(invLine, "GET /api/invites/:token 200 in 3ms");

// Response bodies on other routes: secret fields and token links are blanked.
const bodyLine = formatRequestLogLine("POST", "/api/x", 201, 5, { token: TOKEN });
assert.ok(!bodyLine.includes(TOKEN.slice(0, 8)), bodyLine);
const body = redactLogBody({
  id: "inv1",
  token: TOKEN,
  resetToken: TOKEN,
  maxTokens: 400,
  link: `https://app.cimple.ca/seller/${TOKEN}/interview`,
  nested: [{ url: `https://app.cimple.ca/view/${TOKEN}` }, { review: `/review/${TOKEN}` }],
  note: "plain text stays",
}) as any;
assert.equal(body.token, "[redacted]");
assert.equal(body.resetToken, "[redacted]");
assert.equal(body.maxTokens, 400);
assert.equal(body.link, "https://app.cimple.ca/seller/:token/interview");
assert.equal(body.nested[0].url, "https://app.cimple.ca/view/:token");
assert.equal(body.nested[1].review, "/review/:token");
assert.equal(body.note, "plain text stays");
assert.ok(!JSON.stringify(body).includes(TOKEN));

// Free text (SMS bodies, email fallbacks) and query-string tokens.
const sms = redactLogText(`Your buyer approval is ready: https://app.cimple.ca/approve/${TOKEN} thanks`);
assert.ok(!sms.includes(TOKEN), sms);
assert.equal(redactLogText(`/api/calls/recall/webhook/?token=${TOKEN}&x=1`), "/api/calls/recall/webhook/?token=[redacted]&x=1");
assert.ok(!redactLogText(`https://app.cimple.ca/broker/reset-password/${TOKEN}`).includes(TOKEN));
assert.ok(!redactLogText(`https://app.cimple.ca/buyer/set-password/${TOKEN}`).includes(TOKEN));

// Sentry events, transactions and breadcrumbs.
const ev = scrubSentryEvent({
  transaction: `GET /api/seller/${TOKEN}/progress`,
  request: {
    url: `https://app.cimple.ca/api/view/${TOKEN}/decision?token=${TOKEN}`,
    query_string: `token=${TOKEN}`,
    headers: { "x-seller-token": TOKEN, "user-agent": "ua" },
    cookies: { sid: "x" },
  },
  breadcrumbs: [{ category: "http", data: { url: `https://app.cimple.ca/api/approve/${TOKEN}` } }],
});
assert.ok(!JSON.stringify(ev).includes(TOKEN), JSON.stringify(ev));
assert.equal(ev.request.headers["user-agent"], "ua");
assert.equal(ev.transaction, "GET /api/seller/:token/progress");

console.log("log-redact: all assertions passed");
