/**
 * The Activity feed (server/analytics-dashboard/activity.ts, spec §6.3):
 * visits as opened / came back, decisions (including auto-lapses the event
 * stream never saw), broker actions, questions, filters, other streams'
 * items, and stable cursor paging.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-activity.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ActivityItem } from "../../shared/analytics-dashboard";
import { NEXT_STEP_WORDS } from "../../shared/buyer-next-steps";
import { activityItems, decodeCursor, encodeCursor, pageItems, parseLimit } from "../../server/analytics-dashboard/activity";
import { NOW, ago, inputsOf, questionRow, type DealSpec } from "./fixtures/analytics-fixtures";

const DEAL: DealSpec = {
  id: "d", name: "Pacific Coast Logistics",
  links: [
    { id: "g", name: "Gurdeep Randhawa", createdDaysAgo: 20, firstViewedDaysAgo: 16, ndaDaysAgo: 17, decision: "interested", decisionDaysAgo: 10, nextStep: "seller_call", reason: "Strong fleet and a clean book of contracts." },
    { id: "m", name: "Mia Moretime", createdDaysAgo: 20, firstViewedDaysAgo: 15, decision: "lapsed", decisionDaysAgo: 3 },
    { id: "p", name: "Pre Events", createdDaysAgo: 30, firstViewedDaysAgo: 25, decision: "not_interested", decisionDaysAgo: 24, reason: "Too far from our yards." },
    { id: "o", name: "Old Tracker", createdDaysAgo: 30, firstViewedDaysAgo: 28 },
    { id: "e", name: "Ed Events", createdDaysAgo: 14, firstViewedDaysAgo: 12, expiresInDays: -1,
      events: [
        { type: "level_changed", at: ago(9).toISOString(), accessLevel: "due_diligence" },
        { type: "extended", at: ago(8).toISOString(), expiresAt: ago(1).toISOString() },
        { type: "contacted", at: ago(7).toISOString() },
      ] },
    { id: "rv", name: "Rae Revoked", createdDaysAgo: 14, revokedDaysAgo: 2, expiresInDays: -3 },
    { id: "t", name: "Tess Teaser", level: "teaser_only", createdDaysAgo: 6,
      events: [{ type: "granted", at: ago(6).toISOString(), accessLevel: "teaser_only" }, { type: "cim_requested", at: ago(2).toISOString() }] },
  ],
  visits: [
    { id: "v1", access: "g", daysAgo: 16, activeMs: 200_000, pages: ["exec", "fin", "cust"] },
    { id: "v2", access: "g", daysAgo: 12, activeMs: 100_000, pages: ["fin"], device: "phone" },
    { id: "v3", access: "g", daysAgo: 11, activeMs: 50_000, pages: ["fin", "deal"], sample: true },
    { id: "v4", access: "o", daysAgo: 28, activeMs: 300_000, legacy: true, pages: ["exec", "fin", "deal"] },
    { id: "v5", access: "e", daysAgo: 12, activeMs: 60_000 },
  ],
  questions: [
    { id: "q1", access: "g", text: "Is the truck yard available after closing?", daysAgo: 9, status: "pending_broker" },
    { id: "q2", access: "g", text: "Who are the top three customers?", daysAgo: 8, status: "pending_seller" },
    { id: "q3", access: "e", text: "Can we see the fleet list?", daysAgo: 7, status: "published", published: true },
    { id: "q4", access: "e", text: "What's the asking price in cash?", daysAgo: 6, status: "declined" },
    { id: "q5", access: "o", text: "Any pending lawsuits?", daysAgo: 5, status: "pending_ai" },
  ],
};
const decisions = [
  { dealId: "d", accessId: "g", decision: "interested", nextStep: null, at: ago(10) },
  { dealId: "d", accessId: "m", decision: "need_more_time", nextStep: null, at: ago(11) },
];
const inputs = inputsOf([DEAL], { decisions });
const items = activityItems(inputs, decisions, { range: "all", now: NOW });
const byId = (id: string) => items.find((i) => i.id === id);

// ── Visits ──
assert.equal(byId("v:v1")?.kind, "opened");
assert.equal(byId("v:v1")?.title, "Gurdeep Randhawa opened the CIM");
assert.equal(byId("v:v1")?.at, ago(16).toISOString(), "a visit's time is its start (immutable)");
assert.equal(byId("v:v1")?.detail, "3 min 20 s reading · spent time on 3 pages");
assert.equal(byId("v:v2")?.kind, "returned");
assert.equal(byId("v:v2")?.title, "Gurdeep Randhawa came back to the CIM — visit 2");
assert.equal(byId("v:v2")?.detail, "1 min 40 s reading · spent time on 1 page · on a phone");
assert.equal(byId("v:v3")?.title, "Gurdeep Randhawa came back to the CIM — visit 3");
assert.equal(byId("v:v3")?.sample, true, "example-deal sample reading is tagged");
assert.equal(byId("v:v1")?.sample, undefined);
assert.equal(byId("v:v4")?.title, "Old Tracker opened the CIM", "old-tracker visits are items too");
assert.equal(byId("v:v4")?.detail, "5 min reading · spent time on 3 pages", "page counts from the visit's path");
assert.ok(byId("v:v1")?.link?.href.endsWith("/engagement?journey=g"));
assert.ok(!items.some((i) => (i.kind as string) === "reading_now"), "reading now is never an item");
assert.ok(!items.some((i) => i.id.startsWith("v:") && i.accessId === "t"), "no CIM visits for a teaser link");

// ── Decisions ──
const decOf = (accessId: string) => items.filter((i) => i.group === "decision" && i.accessId === accessId && i.kind !== "cim_requested");
assert.deepEqual(decOf("g").map((i) => i.id), ["dec:g:0"], "an Interested event plus the matching row: one item");
assert.equal(decOf("g")[0].detail, "wants a call with the seller · “Strong fleet and a clean book of contracts.”", "next step from the row when the event had none; the reason belongs to it");
assert.deepEqual(decOf("m").map((i) => i.kind).sort(), ["lapsed", "more_time"], "Need more time, then an auto-lapse (row only): both");
assert.equal(decOf("m").find((i) => i.kind === "lapsed")?.detail, "Marked as no response after 8 days");
assert.equal(decOf("m").find((i) => i.kind === "lapsed")?.title, "Mia Moretime didn't decide in time");
assert.deepEqual(decOf("p").map((i) => i.id), ["decrow:p"], "a decision from before the event stream: one item, from the row");
assert.equal(decOf("p")[0].detail, "“Too far from our yards.”");
assert.equal(decOf("p")[0].tone, "negative");
{
  const ev = [{ dealId: "d", accessId: "g", decision: "interested", nextStep: "site_visit", at: ago(10) }];
  const it = activityItems(inputsOf([DEAL], { decisions: ev }), ev, { range: "all", now: NOW }).find((i) => i.id === "dec:g:0");
  assert.ok(it?.detail?.startsWith("wants a site visit"), "next step from the event's own data first");
}

// ── Next-step words match the buyer profile's ──
{
  const src = readFileSync(fileURLToPath(new URL("../../server/buyers/profile-view.ts", import.meta.url)), "utf8");
  const block = /const NEXT_STEP_TEXT[^{]*\{([\s\S]*?)\};/.exec(src)?.[1] ?? "";
  const words: Record<string, string> = {};
  for (const m of Array.from(block.matchAll(/(\w+):\s*"([^"]+)"/g))) words[m[1]] = m[2];
  assert.ok(Object.keys(words).length >= 6, "found the profile's next-step words");
  assert.deepEqual(NEXT_STEP_WORDS, words, "shared/buyer-next-steps.ts = profile-view.ts NEXT_STEP_TEXT");
}

// ── Broker actions ──
assert.equal(byId("grant:g")?.title, "You gave Gurdeep Randhawa the Full CIM", "level words from the registry (legacy loi → Full CIM)");
assert.equal(byId("grant:t")?.title, "You sent Tess Teaser the teaser");
assert.ok(byId("grant:t")?.link?.href.endsWith("/buyers?stage=send&list=sent"));
assert.equal(byId("ev:e:0")?.title, "You moved Ed Events to due-diligence access");
assert.equal(byId("ev:e:1")?.title, "You extended Ed Events's link");
assert.match(byId("ev:e:1")?.detail ?? "", /^Now runs out \d{1,2} \w+/);
assert.equal(byId("ev:e:2")?.title, "You marked Ed Events as contacted");
assert.equal(byId("ev:t:1")?.title, "Tess Teaser asked for the CIM");
assert.equal(byId("ev:t:1")?.kind, "cim_requested");
assert.equal(byId("ev:t:1")?.detail, "From the teaser");
assert.ok(byId("ev:t:1")?.link?.href.endsWith("/buyers?stage=approval"));
assert.equal(byId("ev:t:0"), undefined, "the granted event is the grant item, not a second one");
assert.equal(byId("exp:e")?.title, "Ed Events's link ran out");
assert.equal(byId("exp:e")?.detail, "They haven't decided. Extend it from the Buyers tab.");
assert.equal(byId("rev:rv")?.title, "You removed Rae Revoked's access");
assert.equal(byId("exp:rv"), undefined, "a removed link doesn't also 'run out'");
assert.equal(byId("nda:g")?.title, "Gurdeep Randhawa signed the NDA");

// ── Questions: every status ──
assert.equal(byId("q:q1")?.detail, "Waiting for your answer");
assert.equal(byId("q:q1")?.link?.label, "Answer");
assert.equal(byId("q:q1")?.title, "Gurdeep Randhawa asked: “Is the truck yard available after closing?”");
assert.equal(byId("q:q2")?.detail, "Waiting for the seller's OK");
assert.equal(byId("q:q3")?.detail, "Answered");
assert.equal(byId("q:q4")?.detail, "You declined it");
assert.equal(byId("q:q5")?.detail, "Waiting for your answer");
{
  // Questions only the loader saw (e.g. from a link the facts don't list).
  const extraQ = [questionRow("d", { id: "qx", access: null, text: "Anonymous?", daysAgo: 1, status: "pending_broker" })];
  const it = activityItems(inputsOf([DEAL], { questions: extraQ, decisions }), decisions, { range: "all", now: NOW }).find((i) => i.id === "q:qx");
  assert.equal(it?.title, "A buyer asked: “Anonymous?”");
}

// ── Order, filters, other streams ──
for (let i = 1; i < items.length; i++) assert.ok(Date.parse(items[i - 1].at) >= Date.parse(items[i].at), "newest first");
const week = activityItems(inputs, decisions, { range: "7d", now: NOW });
assert.ok(week.length > 0 && week.every((i) => NOW.getTime() - Date.parse(i.at) <= 7 * 86_400_000), "the period filter");
assert.ok(activityItems(inputs, decisions, { range: "all", now: NOW, kinds: "broker" }).every((i) => i.group === "broker"));
assert.ok(activityItems(inputs, decisions, { range: "all", now: NOW, kinds: "question" }).every((i) => i.kind === "question"));
assert.ok(activityItems(inputs, decisions, { range: "all", now: NOW, accessIds: ["g"] }).every((i) => i.accessId === "g"));
assert.equal(activityItems(inputs, decisions, { range: "all", now: NOW, dealId: "other" }).length, 0);
{
  const room: ActivityItem = {
    id: "vdr:1", at: ago(1).toISOString(), kind: "data_room", group: "data_room", dealId: "d", dealName: "Pacific Coast Logistics",
    accessId: "g", name: "Gurdeep Randhawa", company: null, title: "Gurdeep Randhawa opened the tax returns in the data room", detail: null, tone: "neutral", link: null,
  };
  const withRoom = activityItems(inputs, decisions, { range: "all", now: NOW, extra: [room] });
  assert.equal(withRoom[0].id, "vdr:1", "registered sources' items are merged in time order");
  assert.equal(activityItems(inputs, decisions, { range: "all", now: NOW, extra: [room], kinds: "data_room" }).length, 1);
}

// ── Paging: stable, every item once ──
{
  const at = new Date(NOW.getTime() - 3_600_000).toISOString(); // an hour ago: nothing else then
  const same: ActivityItem[] = ["a", "b", "c"].map((id) => ({ ...byId("v:v1")!, id, at }));
  const all = [...same, ...items];
  const sorted = activityItems({ ...inputs, items: [], access: [], questions: [] }, [], { range: "all", now: NOW, extra: all });
  const seen: string[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard++) {
    const page = pageItems(sorted, cursor, 2);
    seen.push(...page.items.map((i) => i.id));
    if (!page.next) break;
    cursor = page.next;
  }
  assert.deepEqual(seen, sorted.map((i) => i.id), "two at a time: every item exactly once, in order");
  assert.deepEqual(seen.slice(0, 3), ["c", "b", "a"], "same time: by id, descending");
  const later = activityItems({ ...inputs, items: [], access: [], questions: [] }, [], { range: "all", now: new Date(NOW.getTime() + 60_000), extra: all });
  assert.deepEqual(pageItems(later, encodeCursor(sorted[1]), 2).items.map((i) => i.id), pageItems(sorted, encodeCursor(sorted[1]), 2).items.map((i) => i.id),
    "a later clock gives the same pages");
  assert.deepEqual(pageItems(sorted, "not-a-cursor", 2).items.map((i) => i.id), sorted.slice(0, 2).map((i) => i.id), "an invalid cursor → the first page");
  assert.equal(decodeCursor("%%%"), null);
  assert.deepEqual(decodeCursor(encodeCursor({ at, id: "x|y" })), { at, id: "x|y" });
  assert.equal(parseLimit("10000"), 100);
  assert.equal(parseLimit("abc"), 50);
  assert.equal(parseLimit(undefined), 50);
  assert.equal(parseLimit("7"), 7);
}

console.log("analytics-activity: all assertions passed");
