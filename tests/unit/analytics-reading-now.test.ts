/**
 * "Reading now" (server/analytics-dashboard/reading-now.ts): one indexed
 * read with every exclusion, the 90 s window, teaser reads marked.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-reading-now.test.ts
 */
import assert from "node:assert/strict";
import { PgDialect } from "drizzle-orm/pg-core";
import { READING_RULES } from "../../shared/analytics-v2";
import { readingNowResponseRows, readingNowSql } from "../../server/analytics-dashboard/reading-now";

const now = new Date("2026-10-09T16:00:00Z");
const since = new Date(now.getTime() - READING_RULES.readingNowMs);
const q = new PgDialect().sqlToQuery(readingNowSql(["d1", "d2"], since, now));
const text = q.sql.replace(/\s+/g, " ");

for (const must of ["deal_id = ANY(", "NOT v.self_view", "NOT v.clamped", "NOT v.legacy", "a.revoked_at IS NULL", "v.last_seen_at >", "v.last_seen_at <=", "ORDER BY v.last_seen_at DESC", "LIMIT 50"]) {
  assert.ok(text.includes(must), `the statement has ${must}`);
}
assert.ok(text.includes("JOIN buyer_access a ON a.id = v.buyer_access_id"));
assert.deepEqual(q.params, ["d1", "d2", since.toISOString(), now.toISOString()], "deal ids and the 90 s window are parameters, never spliced");
assert.equal(READING_RULES.readingNowMs, 90_000);
assert.ok(!/access_level\s*=\s*'/.test(text), "no access-level literal");

const rows = readingNowResponseRows([
  { accessId: "a1", dealId: "d1", mode: "normal", lastSeenAt: new Date(now.getTime() - 10_000), name: "Gurdeep Randhawa", email: "g@x.invalid", company: "Kinbrook" },
  { accessId: "a1", dealId: "d1", mode: "normal", lastSeenAt: new Date(now.getTime() - 60_000), name: "Gurdeep Randhawa", email: "g@x.invalid", company: "Kinbrook" },
  { accessId: "a2", dealId: "d2", mode: "teaser", lastSeenAt: new Date(now.getTime() - 20_000), name: null, email: "t@x.invalid", company: null },
  { accessId: "a3", dealId: "d1", mode: "blind", lastSeenAt: new Date(now.getTime() - 30_000), name: "Blind Reader", email: "b@x.invalid", company: null },
], (id) => (id === "d1" ? "Pacific Coast Logistics" : "Beacon Specialty Pharmacy"));
assert.deepEqual(rows.map((r) => r.accessId), ["a1", "a2", "a3"], "one row per buyer link, newest first");
assert.equal(rows[0].since, new Date(now.getTime() - 10_000).toISOString(), "the link's latest visit");
assert.equal(rows[0].document, "cim");
assert.equal(rows[1].document, "teaser", "a teaser read is marked as such");
assert.equal(rows[1].name, "t@x.invalid", "no name: the email");
assert.equal(rows[2].document, "cim");
assert.equal(rows[0].dealName, "Pacific Coast Logistics");
assert.equal(rows[0].page, null, "pages come only with the deal's numbers");

console.log("analytics-reading-now: all assertions passed");
