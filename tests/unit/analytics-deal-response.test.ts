/**
 * The deal Engagement tab's numbers and the Buyer pulse (dealKpisResponse,
 * spec §4.2 / §5.1): the pulse's "Call first" rows never include someone
 * who said no, lapsed or lost their link; reading words never lead with a
 * weekly 0; reading-now rows carry the page they're on; sample reading
 * is flagged (INTEGRATION C9).
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-deal-response.test.ts
 */
import assert from "node:assert/strict";
import { dealKpisResponse } from "../../server/analytics-dashboard/responses";
import { NOW, dealInputsOf, type DealSpec } from "./fixtures/analytics-fixtures";

const DEAL: DealSpec = {
  id: "p", name: "Pacific Coast Logistics", live: true,
  links: [
    { id: "gur", name: "Gurdeep Randhawa", firstViewedDaysAgo: 18, decision: "interested", decisionDaysAgo: 17 },
    { id: "tra", name: "Travis Holmgren", firstViewedDaysAgo: 17 },
    { id: "no1", name: "Said No", firstViewedDaysAgo: 18, decision: "not_interested", decisionDaysAgo: 16 },
    { id: "lap", name: "Lapsed", firstViewedDaysAgo: 18, decision: "lapsed", decisionDaysAgo: 9 },
    { id: "rev", name: "Revoked", firstViewedDaysAgo: 18, revokedDaysAgo: 5 },
    { id: "tz", name: "Teaser Reader", level: "teaser_only" },
  ],
  visits: [
    { id: "v1", access: "gur", daysAgo: 18, activeMs: 50 * 60_000, pages: ["exec", "fin", "cust"], sample: true },
    { id: "v2", access: "tra", daysAgo: 17, activeMs: 30 * 60_000, pages: ["exec", "fin"], sample: true },
    { id: "v3", access: "no1", daysAgo: 18, activeMs: 90 * 60_000, pages: ["fin"], sample: true },
    { id: "v4", access: "lap", daysAgo: 18, activeMs: 80 * 60_000, pages: ["fin"], sample: true },
    { id: "v5", access: "rev", daysAgo: 18, activeMs: 70 * 60_000, pages: ["fin"], sample: true },
  ],
  reading: [
    { visit: "v1", page: "fin", ms: 1_500_000, block: "row:0" }, { visit: "v1", page: "cust", ms: 600_000, block: "para:0" },
    { visit: "v2", page: "fin", ms: 900_000, block: "row:1" },
    { visit: "v3", page: "fin", ms: 3_000_000, block: "row:0" },
    { visit: "v4", page: "fin", ms: 2_500_000, block: "row:0" },
    { visit: "v5", page: "fin", ms: 2_000_000, block: "row:0" },
  ],
};

const r = dealKpisResponse(dealInputsOf(DEAL), [
  { accessId: "tra", dealId: "p", mode: "normal", lastSeenAt: new Date(NOW.getTime() - 15_000), name: "Travis Holmgren", email: "t@x.invalid", company: null },
  { accessId: "tz", dealId: "p", mode: "teaser", lastSeenAt: new Date(NOW.getTime() - 30_000), name: "Teaser Reader", email: "z@x.invalid", company: null },
  { accessId: "other", dealId: "elsewhere", mode: "normal", lastSeenAt: NOW, name: "Someone Else", email: "e@x.invalid", company: null },
], NOW);

assert.equal(r.published, true);
assert.equal(r.grantedCim, 5, "CIM links only");
assert.deepEqual(r.callTop.map((c) => c.accessId).sort(), ["gur", "tra"], "never someone who said no, lapsed or whose link was removed");
assert.ok(r.callTop.length <= 3);
assert.equal(r.readersAll, 5);
assert.equal(r.readersWeek, 0, "nobody this week …");
assert.ok(r.lastReadAt, "… so the pulse says when they last read instead");
const reading = r.kpis.find((k) => k.id === "reading")!;
assert.match(reading.sub ?? "", /^last on /, "the all-time card says 'last on …'");
assert.equal(r.mostStudiedPage?.title, "Income Statement");
assert.equal(r.sampleReading, true, "example-deal sample reading is flagged for the shell's chip and the pulse");
assert.equal(r.legacyOnly, false);
assert.equal(r.forText, "All time · All buyers");
assert.deepEqual(r.readingNow.map((x) => x.accessId), ["tra", "tz"], "this deal's readers only, newest first");
assert.equal(r.readingNow[0].page?.title, "Income Statement", "the page they're on (the last page of their latest visit)");
assert.equal(r.readingNow[1].document, "teaser");
assert.equal(r.readingNow[1].page, null, "a teaser reader has no CIM page");
assert.deepEqual(r.groups.declined.map((g) => g.accessId).sort(), ["lap", "no1"]);
assert.deepEqual(r.groups.revoked.map((g) => g.accessId), ["rev"]);
assert.equal(r.renditions.length, 1);

const plain = dealKpisResponse(dealInputsOf({ ...DEAL, visits: DEAL.visits!.map((v) => ({ ...v, sample: false })) }), [], NOW);
assert.equal(plain.sampleReading, false);

const interested = dealKpisResponse(dealInputsOf(DEAL, { range: "all", device: "all", buyers: [], segment: "interested", rendition: null }), [], NOW);
assert.equal(interested.forText, "All time · Interested buyers");
assert.deepEqual(interested.callTop.map((c) => c.accessId), ["gur"]);

console.log("analytics-deal-response: all assertions passed");
