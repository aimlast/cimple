/**
 * The analytics dashboards' numbers (server/analytics-dashboard/kpis.ts,
 * spec §6.1): every KPI, the "never a bare 0" rule, teaser exclusion,
 * "Waiting on you" per question status, the Buyers-tab number filter,
 * consistency between the Analytics page and the deal tab, and the shared
 * range / example-deal rules. No database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-kpis.test.ts
 */
import assert from "node:assert/strict";
import { DEFAULT_ENGAGEMENT_FILTERS, type EngagementFilters } from "../../shared/analytics-v2";
import {
  BUYER_KPI_IDS,
  DASHBOARD_RANGES,
  KPI_COPY,
  applyKpiFilter,
  dayMonth,
  matchesBuyerStatus,
  hasReadCim,
  questionWaitingOn,
  resolveExamples,
  resolveRange,
  type Kpi,
  type KpiId,
} from "../../shared/analytics-dashboard";
import { buildCallList } from "../../server/routes/engagement-insights";
import { buildSummaryResponse } from "../../server/engagement/responses";
import { computeKpis, headsUp, lastActivity, linkRanOut, noticeIds } from "../../server/analytics-dashboard/kpis";
import { buyerRows } from "../../server/analytics-dashboard/buyers";
import { kpiFactsFilters } from "../../server/analytics-dashboard/load";
import { activityResponse, callListResponse, dealKpisResponse, overviewResponse } from "../../server/analytics-dashboard/responses";
import { DAY as DAY_MS, NOW, ago, dealInputsOf, factsOf, inputsOf, questionRow, type DealSpec } from "./fixtures/analytics-fixtures";

const kpi = (ks: Kpi[], id: KpiId) => {
  const k = ks.find((x) => x.id === id);
  assert.ok(k, `kpi ${id} present`);
  return k!;
};
const ids = (k: Kpi) => [...(k.ids ?? [])].sort();

// ── A live deal with every kind of buyer ──────────────────────────────────
const D1: DealSpec = {
  id: "d1", name: "Pacific Coast Logistics", live: true,
  links: [
    { id: "g1", name: "Gurdeep Randhawa", firstViewedDaysAgo: 16, ndaDaysAgo: 18, decision: "interested", decisionDaysAgo: 10, nextStep: "loi", fit: { matched: 4, total: 6 } },
    { id: "t1", name: "Travis Holmgren", ndaDaysAgo: 6, decision: "interested", decisionDaysAgo: 3, firstViewedDaysAgo: 5 },
    { id: "n1", name: "Natalie Vasconcelos", createdDaysAgo: 10 },
    { id: "q1", name: "Quinn Ashdown", decision: "not_interested", decisionDaysAgo: 2, firstViewedDaysAgo: 8 },
    { id: "r1", name: "Rex Albrecht", revokedDaysAgo: 1, firstViewedDaysAgo: 6 },
    { id: "s1", name: "Sam Ortiz", firstViewedDaysAgo: 1 },
    { id: "tz", name: "Tina Teaser", level: "teaser_only", ndaDaysAgo: 4 },
    { id: "dd", name: "Dana Diligence", level: "due_diligence", decision: "interested", decisionDaysAgo: 40, firstViewedDaysAgo: 35, ndaDaysAgo: 36 },
    { id: "l1", name: "Lou Lapsed", decision: "lapsed", decisionDaysAgo: 1, firstViewedDaysAgo: 12 },
  ],
  visits: [
    { id: "v1", access: "g1", daysAgo: 16, activeMs: 30 * 60_000 },
    { id: "v2", access: "g1", daysAgo: 10, activeMs: 20 * 60_000 },
    { id: "v3", access: "t1", daysAgo: 5, activeMs: 10 * 60_000 },
    { id: "v4", access: "q1", daysAgo: 8, activeMs: 2 * 60_000 },
    { id: "v5", access: "r1", daysAgo: 6, activeMs: 15 * 60_000 },
    { id: "v6", access: "s1", daysAgo: 1, activeMs: 2_000 },
    { id: "v7", access: "dd", daysAgo: 35, activeMs: 20 * 60_000 },
    { id: "v8", access: "l1", daysAgo: 12, activeMs: 5 * 60_000 },
  ],
  reading: [
    { visit: "v1", page: "fin", ms: 600_000, block: "row:0" }, { visit: "v1", page: "exec", ms: 300_000, block: "para:0" },
    { visit: "v2", page: "fin", ms: 400_000, block: "row:1" },
    { visit: "v3", page: "fin", ms: 200_000 }, { visit: "v3", page: "deal", ms: 100_000 },
    { visit: "v4", page: "exec", ms: 60_000 },
    { visit: "v5", page: "cust", ms: 300_000 },
    { visit: "v7", page: "fin", ms: 500_000 },
    { visit: "v8", page: "exec", ms: 200_000 },
  ],
};

const inputs = inputsOf([D1]);
const all = computeKpis(inputs, { range: "all", now: NOW, scope: "broker" }).kpis;
const d7 = computeKpis(inputs, { range: "7d", now: NOW, scope: "broker" }).kpis;
const d30 = computeKpis(inputs, { range: "30d", now: NOW, scope: "broker" }).kpis;

// ── Buyers who read ──
assert.deepEqual(ids(kpi(all, "reading")), ["dd", "g1", "l1", "q1", "r1", "t1"], "all time: every link with an active visit (≥ 3 s), revoked included; not Sam (2 s), not the teaser");
assert.deepEqual(ids(kpi(d7, "reading")), ["r1", "t1"], "7 days: the last active second is in the window");
assert.equal(kpi(d7, "reading").previous, 3, "previous window [14d, 7d): g1 (10d), q1 (8d), l1 (12d)");
assert.deepEqual(ids(kpi(d30, "reading")), ["g1", "l1", "q1", "r1", "t1"], "30 days");
assert.equal(kpi(all, "reading").sub, "of 8 given the CIM", "broker scope: of every CIM link given, removed ones included (the value counts them too)");
assert.equal(kpi(all, "reading").rangeBound, true);
assert.ok(kpi(all, "reading").who.every((w) => w.note?.endsWith(" reading")));

// ── Never a bare zero ──
{
  const OLD: DealSpec = {
    id: "old", name: "Old Deal",
    links: [{ id: "o1", name: "Olive", firstViewedDaysAgo: 16, ndaDaysAgo: 17, decision: "interested", decisionDaysAgo: 16 }],
    visits: [{ id: "ov", access: "o1", daysAgo: 16, activeMs: 600_000 }],
    reading: [{ visit: "ov", page: "exec", ms: 100_000 }],
  };
  const ks = computeKpis(inputsOf([OLD]), { range: "7d", now: NOW, scope: "broker" }).kpis;
  for (const id of ["reading", "nda", "interested"] as KpiId[]) {
    assert.equal(kpi(ks, id).value, 0, `${id} is 0 in the last 7 days`);
    assert.ok(kpi(ks, id).lastAt, `${id} knows when it last happened`);
    assert.match(kpi(ks, id).sub ?? "", /^last on \d{1,2} \w+/, `${id} says "last on …", never a bare 0`);
  }
  assert.equal(kpi(ks, "reading").sub, `last on ${dayMonth(new Date(ago(16).getTime() + 30 * 60_000))}`);
  const EMPTY: DealSpec = { id: "e", name: "Empty", links: [{ id: "e1", name: "Eve" }] };
  const ke = computeKpis(inputsOf([EMPTY]), { range: "7d", now: NOW, scope: "broker" }).kpis;
  assert.equal(kpi(ke, "reading").lastAt, null, "no older event: no 'last on'");
  assert.ok(!/last on/.test(kpi(ke, "reading").sub ?? ""));
}

// ── NDAs signed: any level, teaser included ──
assert.deepEqual(ids(kpi(d7, "nda")), ["t1", "tz"], "a teaser-only link that signed counts");
assert.deepEqual(ids(kpi(all, "nda")), ["dd", "g1", "t1", "tz"]);
assert.equal(kpi(d7, "nda").previous, 0);
assert.equal(kpi(d7, "nda").sub, "2 more than the 7 days before");

// ── Said interested ──
assert.deepEqual(ids(kpi(d7, "interested")), ["t1"], "decision in the window");
assert.deepEqual(ids(kpi(d30, "interested")), ["g1", "t1"]);
assert.deepEqual(ids(kpi(all, "interested")), ["dd", "g1", "t1"], "Quinn said no after all: not counted");
assert.equal(kpi(all, "interested").sub, "1 in due diligence", "due-diligence links not removed, all time");
assert.equal(kpi(d30, "interested").who.find((w) => w.accessId === "g1")?.note, "ready to submit an LOI", "next-step words");
{
  const MT: DealSpec = { id: "mt", name: "More Time", links: [{ id: "m1", name: "Mo", firstViewedDaysAgo: 3, decision: "interested", decisionDaysAgo: 2 }, { id: "m2", name: "Mia", firstViewedDaysAgo: 3 }],
    visits: [{ id: "mv", access: "m1", daysAgo: 3, activeMs: 100_000 }, { id: "mw", access: "m2", daysAgo: 3, activeMs: 100_000 }] };
  const i = inputsOf([MT], { decisions: [{ dealId: "mt", accessId: "m2", decision: "need_more_time", nextStep: null, at: ago(1) }] });
  assert.equal(kpi(computeKpis(i, { range: "7d", now: NOW, scope: "broker" }).kpis, "interested").sub, "1 asked for more time");
  const later = inputsOf([{ ...MT, links: [MT.links[0], { ...MT.links[1], decision: "not_interested", decisionDaysAgo: 0.5 }] }], { decisions: i.decisions });
  assert.equal(kpi(computeKpis(later, { range: "7d", now: NOW, scope: "broker" }).kpis, "interested").sub, "1 more than the 7 days before", "a later final answer supersedes 'asked for more time' (the delta shows instead)");
}

// ── Worth a call ──
{
  const r = computeKpis(inputs, { range: "7d", now: NOW, scope: "broker" });
  const list = buildCallList([{ deal: { id: "d1", businessName: D1.name }, facts: factsOf(D1) }], Number.MAX_SAFE_INTEGER);
  assert.equal(kpi(r.kpis, "to_call").value, list.length, "equals the uncapped call list");
  assert.deepEqual(r.callable, list.map((e) => e.accessId), "same order");
  for (const out of ["r1", "q1", "l1", "n1", "tz"]) assert.ok(!r.callable.includes(out), `${out} is never worth a call`);
  assert.equal(kpi(r.kpis, "to_call").sub, `Best lead: ${list[0].name}`);
  assert.equal(kpi(r.kpis, "to_call").rangeBound, false, "the period doesn't change it");
  assert.deepEqual(kpi(r.kpis, "to_call").ids, list.map((e) => e.accessId));
}

// ── Waiting on you: one case per question status ──
{
  const statuses: Array<[string, boolean, "broker" | "seller" | "declined" | "answered"]> = [
    ["pending_ai", false, "broker"], ["pending_broker", false, "broker"], ["pending_broker", true, "answered"],
    ["pending_seller", false, "seller"], ["published", true, "answered"], ["answered", false, "answered"],
    ["approved", false, "answered"], ["declined", false, "declined"],
  ];
  for (const [s, pub, want] of statuses) assert.equal(questionWaitingOn(s, pub), want, `${s}${pub ? " + published answer" : ""}`);
  const qs = statuses.map(([s, pub], i) => questionRow("d1", { id: `q${i}`, access: "g1", text: `Question ${i} about the yard lease and the trucks?`, daysAgo: 9 - i, status: s, published: pub }));
  const i = inputsOf([D1], {
    questions: qs,
    approvals: [
      { id: "ap1", dealId: "d1", buyerName: "Ann Request", buyerCompany: null, source: "teaser_request", createdAt: ago(2), buyerAccessId: "tz" },
      { id: "ap2", dealId: "d1", buyerName: "Ben Broker", buyerCompany: "Ben Co", source: null, createdAt: ago(1), buyerAccessId: null },
    ],
  });
  const w = kpi(computeKpis(i, { range: "7d", now: NOW, scope: "broker" }).kpis, "waiting");
  assert.equal(w.value, 4, "2 questions waiting on the broker + 1 CIM request + 1 approval");
  assert.deepEqual(w.breakdown!.map((b) => b.count), [2, 1, 1]);
  assert.equal(w.sellerPending, 1, "pending_seller is shown apart, not counted");
  assert.equal(w.sub, "2 questions · 1 asked for the CIM · 1 waiting for approval");
  assert.equal(w.ids, null, "not a buyer set");
  assert.deepEqual(w.who.map((x) => x.kind), ["question", "question", "cim_request", "approval"], "oldest first, typed");
  assert.ok(w.who[0].href.endsWith("/qa") && w.who[2].href.endsWith("/buyers?stage=approval"));
  assert.ok((w.who[0].note ?? "").length <= 80);
  const onlyQ = kpi(computeKpis(inputsOf([D1], { questions: qs }), { range: "all", now: NOW, scope: "broker" }).kpis, "waiting");
  assert.equal(onlyQ.sub, `2 questions · oldest from ${dayMonth(ago(9))}`, "one kind: says how old the oldest is");
}

// ── Who lists: ≤ 20 listed, ids uncapped ──
{
  const many: DealSpec = {
    id: "many", name: "Many Readers",
    links: Array.from({ length: 25 }, (_, n) => ({ id: `m${n}`, name: `Reader ${n}`, firstViewedDaysAgo: 2 })),
    visits: Array.from({ length: 25 }, (_, n) => ({ id: `mv${n}`, access: `m${n}`, daysAgo: 2, activeMs: 60_000 + n })),
  };
  const k = kpi(computeKpis(inputsOf([many]), { range: "7d", now: NOW, scope: "broker" }).kpis, "reading");
  assert.equal(k.value, 25);
  assert.equal(k.who.length, 20);
  assert.equal(k.whoMore, 5);
  assert.equal(k.ids!.length, 25);
}

// ── Teaser exclusion ──
{
  const dk = computeKpis(dealInputsOf(D1), { range: "all", now: NOW, scope: "deal" }).kpis;
  const opened = kpi(dk, "opened");
  assert.equal(opened.display, "7 of 8", "the teaser link isn't in the denominator (8 CIM links, Natalie never opened)");
  assert.equal(opened.sub, "1 haven't yet");
  assert.deepEqual(opened.who.map((w) => w.accessId), ["n1"], "all time: who hasn't opened");
  for (const k of [kpi(dk, "reading"), kpi(dk, "to_call"), kpi(dk, "interested")]) assert.ok(!(k.ids ?? []).includes("tz"), `${k.id}: never the teaser link`);
  const hu = headsUp(inputsOf([{ ...D1, links: [...D1.links, { id: "tz2", name: "Teaser Two", level: "teaser_only", createdDaysAgo: 9 }] }]), NOW);
  assert.ok(!hu.some((h) => h.names.includes("Tina Teaser") || h.names.includes("Teaser Two")), "teaser links never in the heads-up lines");
}

// ── Opened (deal scope) in a window: first opens only ──
{
  const dk = computeKpis(dealInputsOf(D1), { range: "7d", now: NOW, scope: "deal" }).kpis;
  assert.deepEqual(ids(kpi(dk, "opened")), ["r1", "s1", "t1"], "Gurdeep first opened 16 days ago and came back 10 days ago: not counted");
  assert.equal(kpi(dk, "opened").sub, "7 of 8 so far");
}

// ── The Buyers tab's number filter shows exactly the set counted ──
for (const scope of ["broker", "deal"] as const) {
  for (const range of DASHBOARD_RANGES) {
    const i = scope === "broker" ? inputsOf([D1]) : dealInputsOf(D1);
    const ks = computeKpis(i, { range, now: NOW, scope }).kpis;
    const rows = buyerRows(i, NOW);
    for (const id of BUYER_KPI_IDS) {
      const k = ks.find((x) => x.id === id);
      if (!k) continue;
      assert.equal(applyKpiFilter(rows, k.ids).length, k.value, `${scope} ${id}:${range} — the filtered Buyers tab has exactly that many rows`);
    }
  }
}

// ── The same numbers on both screens ──
{
  const CIM_ONLY: DealSpec = { ...D1, links: D1.links.filter((l) => l.id !== "tz") };
  const facts = factsOf(CIM_ONLY);
  const pulse = buildSummaryResponse(facts, true, CIM_ONLY.name).pulse;
  const dk = computeKpis(dealInputsOf(CIM_ONLY), { range: "all", now: NOW, scope: "deal" }).kpis;
  assert.equal(kpi(dk, "opened").value, pulse.opened, "opened = the pulse's opened");
  assert.equal(kpi(dk, "opened").display, `${pulse.opened} of ${pulse.granted}`, "of granted = the pulse's granted");
  for (const range of DASHBOARD_RANGES) {
    const b = computeKpis(inputsOf([D1]), { range, now: NOW, scope: "broker" }).kpis;
    const d = computeKpis(dealInputsOf(D1), { range, now: NOW, scope: "deal" }).kpis;
    for (const id of ["to_call", "waiting", "reading", "nda", "interested"] as KpiId[]) {
      assert.equal(kpi(b, id).value, kpi(d, id).value, `${id}:${range} same on the Analytics page and the deal tab`);
      assert.deepEqual(kpi(b, id).ids, kpi(d, id).ids, `${id}:${range} same set`);
    }
  }
  // The one reader rule (INTEGRATION C11): KPI readers = hasReadCim = the deal response's readers.
  const resp = dealKpisResponse(dealInputsOf(D1), [], NOW);
  const readers = factsOf(D1).buyers.filter((b) => hasReadCim(b) && b.accessLevel !== undefined).filter((b) => b.accessId !== "tz").length;
  assert.equal(kpi(resp.kpis, "reading").value, readers);
  assert.equal(resp.readersAll, readers);
}

// ── Device and version never change a number ──
{
  const phone: EngagementFilters = { ...DEFAULT_ENGAGEMENT_FILTERS, device: "phone", rendition: "b".repeat(32) };
  assert.deepEqual(kpiFactsFilters(phone), kpiFactsFilters(DEFAULT_ENGAGEMENT_FILTERS), "the loader normalises them away");
  const a = computeKpis(dealInputsOf(D1, phone), { range: "all", now: NOW, scope: "deal", filters: phone }).kpis;
  const b = computeKpis(dealInputsOf(D1), { range: "all", now: NOW, scope: "deal" }).kpis;
  assert.deepEqual(a.map((k) => [k.id, k.value, k.ids]), b.map((k) => [k.id, k.value, k.ids]));
}

// ── A segment filter restricts every count, questions too ──
{
  const f: EngagementFilters = { ...DEFAULT_ENGAGEMENT_FILTERS, segment: "interested" };
  const qs = [questionRow("d1", { id: "qa", access: "g1", text: "From an interested buyer?", daysAgo: 1, status: "pending_broker" }),
    questionRow("d1", { id: "qb", access: "s1", text: "From someone deciding?", daysAgo: 1, status: "pending_broker" })];
  const ks = computeKpis(dealInputsOf(D1, f, { questions: qs }), { range: "all", now: NOW, scope: "deal", filters: f }).kpis;
  assert.deepEqual(ids(kpi(ks, "reading")), ["dd", "g1", "t1"]);
  assert.deepEqual(ids(kpi(ks, "nda")), ["dd", "g1", "t1"]);
  assert.equal(kpi(ks, "waiting").value, 1, "only the interested buyer's question");
  const one: EngagementFilters = { ...DEFAULT_ENGAGEMENT_FILTERS, buyers: ["someone-elses-link"] };
  const none = computeKpis(dealInputsOf(D1, one), { range: "all", now: NOW, scope: "deal", filters: one }).kpis;
  assert.ok(none.every((k) => k.value === 0), "a foreign buyer id matches nothing");
}

// ── Shared rules ──
assert.deepEqual(resolveRange("auto", ago(16), NOW), { range: "30d", auto: true }, "activity 16 days ago → last 30 days");
assert.deepEqual(resolveRange("auto", ago(31), NOW), { range: "all", auto: true }, "nothing in 30 days → all time");
assert.deepEqual(resolveRange("auto", null, NOW), { range: "all", auto: true });
assert.deepEqual(resolveRange("7d", ago(100), NOW), { range: "7d", auto: false }, "an explicit choice is honoured");
assert.equal(resolveExamples(null, false), true, "no live real deal: example deals included");
assert.equal(resolveExamples(null, true), false, "a live real deal: left out by default");
assert.equal(resolveExamples("include", true), true);
assert.equal(resolveExamples("exclude", false), false);
assert.equal(KPI_COPY.reading.label("all"), "Buyers who read");
assert.equal(KPI_COPY.to_call.shortLabel, "Worth a call");

// ── Heads-up lines ──
{
  const HU: DealSpec = {
    id: "hu", name: "Heads Up Deal", live: true,
    links: [
      { id: "x1", name: "Victoria Ashdown", firstViewedDaysAgo: 2, expiresInDays: 3 },
      { id: "x2", name: "Marcus Albrecht", firstViewedDaysAgo: 2, expiresInDays: 5 },
      { id: "x3", name: "Third Expiring", firstViewedDaysAgo: 2, expiresInDays: 6 },
      { id: "x4", name: "Decided Already", firstViewedDaysAgo: 2, expiresInDays: 2, decision: "interested", decisionDaysAgo: 1 },
      { id: "y1", name: "Never Opened", createdDaysAgo: 5 },
      { id: "y2", name: "Too Soon", createdDaysAgo: 1 },
    ],
    visits: ["x1", "x2", "x3", "x4"].map((a, n) => ({ id: `hv${n}`, access: a, daysAgo: 2, activeMs: 100_000 })),
  };
  const lines = headsUp(inputsOf([HU]), NOW);
  assert.equal(lines[0].id, "expiring");
  assert.equal(lines[0].text, "3 buyer links run out in the next 7 days: Victoria Ashdown, Marcus Albrecht and 1 more.");
  assert.equal(lines[1].text, "1 buyer hasn't opened their link 3 days after you gave it.");
  assert.equal(headsUp(inputsOf([{ ...HU, live: false }]), NOW).length, 0, "a deal that isn't live never produces lines");
  const src = { id: "vdr", count: 1, text: "Gurdeep Randhawa is in the data room now", names: ["Gurdeep Randhawa"], link: "/deal/hu/engagement?view=data-room" };
  const withSrc = headsUp(inputsOf([HU]), NOW, [src]);
  assert.deepEqual(withSrc.map((h) => h.id), ["vdr", "expiring"], "registered sources first; at most 2 lines");
}

// ── "Buyers who read … of N given the CIM": the value never exceeds N (checker AN-1) ──
{
  // Three readers, two of them removed afterwards (a broker reads a buyer's interest, then removes access).
  const RV: DealSpec = {
    id: "rv", name: "Removed Readers", live: true,
    links: [1, 2, 3].map((i) => ({ id: `rv${i}`, name: `Buyer ${i}`, level: "full", revokedDaysAgo: i <= 2 ? 1 : null, firstViewedDaysAgo: 5 })),
    visits: [1, 2, 3].map((i) => ({ id: `rvv${i}`, access: `rv${i}`, daysAgo: 5, activeMs: 60_000 })),
  };
  for (const range of DASHBOARD_RANGES) {
    for (const spec of [RV, D1]) {
      const k = kpi(computeKpis(inputsOf([spec]), { range, now: NOW, scope: "broker" }).kpis, "reading");
      const m = /^of (\d+) given the CIM$/.exec(k.sub ?? "");
      if (!m) continue;
      assert.ok(k.value <= Number(m[1]), `${spec.id}:${range} — ${k.value} readers ≤ ${m[1]} given the CIM`);
    }
  }
  const k = kpi(computeKpis(inputsOf([RV]), { range: "all", now: NOW, scope: "broker" }).kpis, "reading");
  assert.equal(k.value, 3, "removed buyers' reading still counts");
  assert.equal(k.sub, "of 3 given the CIM", "…and so do their links");
  assert.match(KPI_COPY.reading.explain("all", "broker"), /including links you later removed/);
}

// ── Heads-up "See them" opens exactly the buyers the line counted (checker AN-5) ──
{
  const HU2: DealSpec = {
    id: "hu2", name: "Heads Up Two", live: true,
    links: [
      { id: "e1", name: "Runs Out Soon", firstViewedDaysAgo: 2, expiresInDays: 3 },
      { id: "e2", name: "Runs Out Later", firstViewedDaysAgo: 2, expiresInDays: 12 },
      { id: "e3", name: "Removed Runs Out", firstViewedDaysAgo: 2, expiresInDays: 2, revokedDaysAgo: 1 },
      { id: "o1", name: "Unopened Old", createdDaysAgo: 5 },
      { id: "o2", name: "Unopened New", createdDaysAgo: 1 },
      { id: "o3", name: "Unopened Removed", createdDaysAgo: 6, revokedDaysAgo: 1 },
    ],
    visits: [{ id: "hv", access: "e1", daysAgo: 2, activeMs: 60_000 }, { id: "hv2", access: "e2", daysAgo: 2, activeMs: 60_000 }, { id: "hv3", access: "e3", daysAgo: 2, activeMs: 60_000 }],
  };
  const NOT_LIVE: DealSpec = {
    id: "nl", name: "Not Live Yet", live: false,
    links: [{ id: "nl1", name: "Waiting For Publish", createdDaysAgo: 9 }, { id: "nl2", name: "Not Live Expiring", firstViewedDaysAgo: 3, expiresInDays: 2 }],
  };
  const i = inputsOf([HU2, NOT_LIVE]);
  const lines = headsUp(i, NOW);
  const sets = noticeIds(i, NOW);
  const rows = buyerRows(i, NOW);
  assert.deepEqual(sets.expiring, ["e1"], "live deals only, not removed, within 7 days");
  assert.deepEqual(sets.not_opened, ["o1"], "live deals only, not removed, 3+ days");
  for (const h of lines) {
    assert.ok(h.ids, `${h.id}: the line carries its exact set`);
    assert.equal(h.ids!.length, h.count, `${h.id}: count = ids`);
    assert.equal(applyKpiFilter(rows, h.ids!).length, h.count, `${h.id}: "See them" shows exactly ${h.count} rows`);
    assert.match(h.link, new RegExp(`notice=${h.id}$`), `${h.id}: links with the exact-set chip`);
  }
  // The general status filters stay broader (they're for browsing), which is why the line links to its exact set.
  assert.ok(rows.filter((r) => matchesBuyerStatus(r, "not_opened", NOW)).length > h1Count(lines, "not_opened"));
  // The overview carries the sets even when a registered source takes both line slots.
  const src = (n: string) => ({ id: n, count: 1, text: n, names: [], link: "/x" });
  const ov = overviewResponse(i, "all", NOW, [src("vdr"), src("teaser")]);
  assert.deepEqual(ov.headsUp.map((h) => h.id), ["vdr", "teaser"]);
  assert.deepEqual(ov.noticeIds, sets, "noticeIds are there whether or not their line is shown");
  // A removed link is "Link removed", never "Haven't opened" (the Who-to-call line's count = the filter's rows).
  assert.ok(!rows.filter((r) => matchesBuyerStatus(r, "not_opened", NOW)).some((r) => r.revokedAt));
  assert.equal(rows.filter((r) => matchesBuyerStatus(r, "not_opened", NOW)).length, ov.counts.notOpened);
}
function h1Count(lines: ReturnType<typeof headsUp>, id: string): number {
  return lines.find((h) => h.id === id)?.count ?? 0;
}

// ── The deal Activity view's empty state names only the filtered buyers (checker AN-6) ──
{
  const f: EngagementFilters = { ...DEFAULT_ENGAGEMENT_FILTERS, range: "7d", buyers: ["someone-elses-link"] };
  const di = dealInputsOf(D1, f);
  const r = activityResponse(di, { range: "7d", now: NOW, kinds: "all", dealId: "d1", accessIds: [], extra: [] });
  assert.equal(r.items.length, 0);
  assert.equal(r.lastActivity, null, "a Buyers filter that matches nobody: no 'last activity' naming someone else");
  const one: EngagementFilters = { ...DEFAULT_ENGAGEMENT_FILTERS, range: "7d", buyers: ["g1"] };
  const r1 = activityResponse(dealInputsOf(D1, one), { range: "7d", now: NOW, kinds: "all", dealId: "d1", accessIds: ["g1"], extra: [] });
  assert.ok(r1.lastActivity, "the filtered buyer's own last activity");
  assert.match(r1.lastActivity!.text, /^Gurdeep Randhawa /, "names the filtered buyer, never another");
  assert.equal(lastActivity(inputsOf([D1]), new Set(["g1"]))!.text.startsWith("Gurdeep Randhawa"), true);
  const everyone = lastActivity(inputsOf([D1]));
  assert.ok(everyone && !everyone.text.startsWith("Gurdeep Randhawa"), "without the filter, someone more recent is named (so the filter really changed it)");
}

// ── Links that ran out stay listed, with "Link ran out" (checker AN-9) ──
{
  const EX: DealSpec = {
    id: "ex", name: "Expired Links", live: true,
    links: [
      { id: "k1", name: "Kept Reading", firstViewedDaysAgo: 9, expiresInDays: -2, ndaDaysAgo: 9 },
      { id: "k2", name: "Still Valid", firstViewedDaysAgo: 9, expiresInDays: 20 },
      { id: "k3", name: "Said No", firstViewedDaysAgo: 9, expiresInDays: -2, decision: "not_interested", decisionDaysAgo: 3 },
      { id: "k4", name: "Removed", firstViewedDaysAgo: 9, expiresInDays: -2, revokedDaysAgo: 1 },
      { id: "k5", name: "Teaser Holder", level: "teaser_only", expiresInDays: -2 },
    ],
    visits: ["k1", "k2", "k3", "k4"].map((a, n) => ({ id: `kv${n}`, access: a, daysAgo: 9 - n, activeMs: 25 * 60_000 })),
    reading: ["kv0", "kv1", "kv2", "kv3"].map((v) => ({ visit: v, page: "fin", ms: 20 * 60_000 })),
  };
  const ro = linkRanOut(inputsOf([EX]).access, NOW);
  assert.deepEqual(Object.keys(ro), ["k1"], "CIM links past expiry; not removed, not a buyer who said no, never a teaser link");
  assert.equal(ro.k1, new Date(NOW.getTime() - 2 * DAY_MS).toISOString());
  const cl = callListResponse(inputsOf([EX]), 15, NOW);
  assert.ok(cl.entries.some((e) => e.accessId === "k1"), "still worth a call");
  assert.deepEqual(Object.keys(cl.linkRanOut), ["k1"], "the call list marks them");
  const dr = dealKpisResponse(dealInputsOf(EX), [], NOW);
  assert.deepEqual(Object.keys(dr.linkRanOut), ["k1"], "the deal tab and the pulse mark them");
  assert.ok(dr.callTop.some((e) => e.accessId === "k1"), "the pulse keeps them in Call first");
}

console.log("analytics-kpis: all assertions passed");
