/**
 * The analytics dashboards' screens, server-rendered (no browser, no DB, no
 * AI): the KPI strip (both blocks, the period control only in its block,
 * labels / values / subs, "last on", aria-describedby), the copy, the Deals
 * table (Example, Not live, Heat map, the Teaser column only when present),
 * the Buyers tab (number chip, Fit, Nudge only on unopened rows of live
 * deals), the page's empty states and period note, the Activity list (day
 * headers, bold names, Sample tag, the pinned reading-now line), the deal's
 * grouped buyer list, the tab bar's short labels, the attention panels and
 * the Buyer pulse (never "0 reading this week").
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-ui.test.ts
 */
import "./react-global";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Router } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { BuyerEngagementCard, CallListEntry } from "../../shared/analytics-v2";
import {
  KPI_COPY,
  type ActivityItem,
  type AttentionResponse,
  type BuyerDashboardRow,
  type BuyerGroups,
  type DealDashboardRow,
  type DealKpisResponse,
  type Kpi,
  type KpiId,
} from "../../shared/analytics-dashboard";

(globalThis as any).window ??= { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), location: { origin: "http://x" } };

const { KpiStrip, KpiPopover, kpiOneLine } = await import("../../client/src/components/analytics/KpiStrip");
const { RangeControl } = await import("../../client/src/components/analytics/RangeControl");
const { RangeNote, rangeNoteContent } = await import("../../client/src/components/analytics/RangeNote");
const { DealsTable } = await import("../../client/src/components/analytics/DealsTab");
const { AllBuyersTab, BuyersTable, canNudge, kpiChipWords } = await import("../../client/src/components/analytics/AllBuyersTab");
const { AnalyticsEmpty, ANALYTICS_EMPTY_COPY, analyticsEmptyKind } = await import("../../client/src/components/analytics/EmptyStates");
const { ActivityList, ReadingNowLine, dayHeading } = await import("../../client/src/components/analytics/ActivityFeed");
const { DashboardTabBar } = await import("../../client/src/components/analytics/DashboardTabBar");
const { AttentionPanels, ATTENTION_COPY } = await import("../../client/src/components/analytics/AttentionTab");
const { HeadsUp } = await import("../../client/src/components/analytics/HeadsUp");
const { BuyerList } = await import("../../client/src/components/engagement/buyers/BuyerList");
const { BuyerListHead, OLDER_VISITS_CHIP } = await import("../../client/src/components/engagement/buyers/BuyersView");
const { PulseTop, pulseStats } = await import("../../client/src/components/engagement/BuyerPulseCard");
const { analyticsKeys } = await import("../../client/src/hooks/useAnalyticsDashboard");
const { ANALYTICS_URL_DEFAULTS } = await import("../../client/src/components/analytics/url");
const { TooltipProvider } = await import("../../client/src/components/ui/tooltip");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

const h = React.createElement;
function render(el: React.ReactElement, qc?: QueryClient): string {
  const client = qc ?? new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  return renderToStaticMarkup(
    h(QueryClientProvider, { client }, h(TooltipProvider, null, h(Router, { ssrPath: "/broker/analytics" }, el))),
  );
}
/** Visible text (tags stripped, entities decoded). */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

function kpi(id: KpiId, value: number, extra: Partial<Kpi> = {}): Kpi {
  const c = KPI_COPY[id];
  return {
    id, block: id === "to_call" || id === "waiting" ? "now" : "period", label: c.label("30d"), shortLabel: c.shortLabel,
    value, display: String(value), previous: null, lastAt: null, sub: null, explain: c.explain("30d", "broker"),
    rangeBound: !(id === "to_call" || id === "waiting"), who: [], whoMore: 0, ids: id === "waiting" ? null : [], breakdown: null, sellerPending: null,
    link: id === "waiting" ? null : { tab: "buyers", query: { kpi: `${id}:30d` } }, ...extra,
  };
}
const BROKER_KPIS: Kpi[] = [
  kpi("to_call", 9, { sub: "Best lead: Gurdeep Randhawa" }),
  kpi("waiting", 3, { sub: "2 questions · 1 asked for the CIM" }),
  kpi("reading", 0, { sub: "last on 23 Sept", lastAt: "2026-09-23T15:00:00Z" }),
  kpi("nda", 9, { sub: "3 more than the 30 days before" }),
  kpi("interested", 6, { sub: "1 in due diligence" }),
];
const noFooter = () => null;

console.log("KPI strip");

await test("both blocks with their headers; the period control only in the period block", () => {
  const html = render(h(KpiStrip, {
    kpis: BROKER_KPIS, range: "30d", periodTitle: "Buyers", footerFor: noFooter,
    periodControl: h(RangeControl, { value: "30d", onChange() {} }),
  }));
  const now = html.slice(html.indexOf('data-testid="kpi-block-now"'), html.indexOf('data-testid="kpi-block-period"'));
  const period = html.slice(html.indexOf('data-testid="kpi-block-period"'));
  assert.match(text(now), /Needs you now/);
  assert.doesNotMatch(now, /range-control/, "no date control on the now block");
  assert.match(period, /data-testid="range-control"/);
  assert.match(text(period), /Buyers/);
  for (const k of BROKER_KPIS) {
    assert.ok(html.includes(`data-testid="kpi-${k.id}"`), k.id);
    assert.ok(text(html).includes(k.label), `label ${k.label}`);
    assert.ok(text(html).includes(k.shortLabel), `short label ${k.shortLabel}`);
    assert.ok(html.includes(`aria-describedby="kpi-${k.id}-explain"`), `described ${k.id}`);
    assert.ok(text(html).includes(k.explain.slice(0, 40)), `explain ${k.id}`);
  }
  assert.match(text(html), /last on 23 Sept/, "a 0 with older reading says when it last happened");
  assert.match(text(html), /Best lead: Gurdeep Randhawa/);
  assert.match(html, /data-testid="kpi-reading-value"[^>]*>0</);
});

await test("loading shows skeleton cells in both blocks; an error shows Couldn't load the numbers", () => {
  const loading = render(h(KpiStrip, { kpis: undefined, range: "30d", loading: true, periodTitle: "Buyers", footerFor: noFooter }));
  assert.match(loading, /kpi-block-now/);
  assert.match(loading, /animate-pulse/);
  const err = render(h(KpiStrip, { kpis: undefined, range: "30d", error: true, onRetry() {}, periodTitle: "Buyers", footerFor: noFooter }));
  assert.match(text(err), /Couldn't load the numbers/);
});

await test("the popover lists who is counted, says 'and N more', and links to exactly that set", () => {
  const who = Array.from({ length: 20 }, (_, i) => ({ kind: "buyer" as const, accessId: `a${i}`, dealId: "d1", dealName: "Pacific Coast Logistics", name: `Buyer ${i}`, company: "Co", at: "2026-09-23T15:00:00Z", note: "1 h reading", href: `/deal/d1/engagement?buyer=a${i}`, sample: i === 0 }));
  const k = kpi("reading", 21, { who, whoMore: 1, ids: who.map((w) => w.accessId!).concat("a20") });
  const html = render(h(KpiPopover, { kpi: k, strip: { range: "30d", showDeal: true, footerFor: () => ({ label: "See all 21 in Buyers", href: "/broker/analytics?tab=buyers&kpi=reading%3A30d" }) } }));
  assert.match(text(html), /Who's counted/);
  assert.match(text(html), /and 1 more/);
  assert.match(text(html), /See all 21 in Buyers/);
  assert.match(html, /href="\/broker\/analytics\?tab=buyers&amp;kpi=reading%3A30d"/);
  assert.match(html, /href="\/deal\/d1\/engagement\?buyer=a0"/);
  assert.match(html, /data-testid="sample-tag"/);
});

await test("Waiting on you: typed rows, per-deal links when the list is cut, the seller's line apart", () => {
  const who = Array.from({ length: 20 }, (_, i) => ({ kind: (i % 2 ? "question" : "cim_request") as "question" | "cim_request", accessId: null, dealId: "d1", dealName: "Pacific", name: `B${i}`, company: null, at: "2026-09-30T15:00:00Z", note: i % 2 ? "Is the truck yard available?" : "Asked for the CIM", href: "/deal/d1/qa" }));
  const k = kpi("waiting", 24, {
    who, whoMore: 4, sellerPending: 2,
    byDeal: [{ dealId: "d1", dealName: "Pacific Coast Logistics", count: 20, href: "/deal/d1/qa" }, { dealId: "d2", dealName: "Beacon Specialty Pharmacy", count: 4, href: "/deal/d2/buyers?stage=approval" }],
  });
  const t = text(render(h(KpiPopover, { kpi: k, strip: { range: "30d", showDeal: true, footerFor: () => null } })));
  assert.match(t, /What's waiting/);
  assert.match(t, /Question/);
  assert.match(t, /Asked for the CIM/);
  assert.match(t, /Pacific Coast Logistics: 20 · Beacon Specialty Pharmacy: 4/);
  assert.match(t, /Also waiting for the seller's OK: 2 answers/);
});

await test("the phone's one-line strip", () => {
  const deal = [kpi("to_call", 5), kpi("waiting", 2), kpi("opened", 13, { display: "13 of 13" }), kpi("reading", 13), kpi("nda", 12), kpi("interested", 5)];
  assert.equal(kpiOneLine(deal), "13 opened · 5 interested · 5 worth a call · 2 waiting");
});

console.log("Copy");

await test("the words are the agreed ones", () => {
  assert.equal(KPI_COPY.to_call.label("all"), "Worth a call");
  assert.equal(KPI_COPY.reading.label("all"), "Buyers who read");
  assert.equal(KPI_COPY.reading.shortLabel, "Read");
  assert.equal(KPI_COPY.interested.shortLabel, "Interested");
  assert.equal(OLDER_VISITS_CHIP, "Older visits: time per page only");
  const head = text(render(h(BuyerListHead, { readers: 13, totalMs: 31_080_000, olderVisits: true })));
  assert.match(head, /13 buyers read the CIM · 8 h 38 min in all/);
  assert.match(head, /Older visits: time per page only/);
  const tabs = text(render(h(DashboardTabBar, {
    tabs: [{ key: "attention", label: "What buyers read most", shortLabel: "Most read" }, { key: "x", label: "Which CIM version" }], value: "attention", onChange() {}, ariaLabel: "t",
  })));
  assert.match(tabs, /What buyers read most/);
});

console.log("Deals");

const dealRow = (o: Partial<DealDashboardRow>): DealDashboardRow => ({
  dealId: "d1", dealName: "Pacific Coast Logistics", live: true, demo: true, granted: 13, opened: 13, readingInRange: 4,
  medianReadingMs: 2_755_000, medianPagesReached: 25, contentPages: 27, ndaSigned: 12, interested: 5, waiting: 3, teaser: null,
  lastActivityAt: "2026-09-23T15:00:00Z", partByPart: false, ...o,
});

await test("rows carry Example, Not live and a Heat map link; Teaser shows only when a deal has teaser links", () => {
  const rows = [dealRow({}), dealRow({ dealId: "d2", dealName: "Beacon Specialty Pharmacy", live: false, demo: true })];
  const html = render(h(DealsTable, { rows, range: "30d", sort: { key: "last", dir: "desc" }, onSort() {} }));
  const t = text(html);
  assert.match(t, /Example/);
  assert.match(t, /Not live/);
  assert.match(t, /Live/);
  assert.match(html, /href="\/deal\/d1\/engagement\?view=document"/);
  assert.match(html, /href="\/deal\/d2\/engagement\?view=document"/);
  assert.match(t, /Read · 30 days/);
  assert.match(t, /25 of 27 pages/);
  assert.match(t, /12 → 5/);
  assert.doesNotMatch(t, /Teaser/, "no teaser links, no column");
  const withTeaser = text(render(h(DealsTable, { rows: [dealRow({ teaser: { sent: 5, asked: 2 } })], range: "all", sort: { key: "last", dir: "desc" }, onSort() {} })));
  assert.match(withTeaser, /Teaser/);
  assert.match(withTeaser, /5 sent · 2 asked/);
  assert.match(withTeaser, /Read it/);
});

console.log("Buyers");

const buyerRow = (o: Partial<BuyerDashboardRow>): BuyerDashboardRow => ({
  accessId: "a1", dealId: "d1", dealName: "Pacific Coast Logistics", demo: true, live: true, document: "cim",
  buyerUserId: null, name: "Gurdeep Randhawa", company: "Kinbrook Freightway", email: "g@x.invalid", buyerType: null,
  accessLevel: "named", accessLabel: "Full CIM", status: "interested", statusLabel: "Interested",
  readingMs: 7_920_000, visits: 4, pagesRead: 24, contentPages: 27, firstSeenAt: "2026-09-06T15:00:00Z", lastSeenAt: "2026-09-24T15:00:00Z",
  grantedAt: "2026-09-05T15:00:00Z", ndaSignedAt: "2026-09-06T15:00:00Z", decision: "interested", decisionAt: "2026-09-18T15:00:00Z",
  questions: 1, questionsWaiting: 0, contactedAt: null, expiresAt: null, revokedAt: null, fit: { matched: 4, total: 6 }, fitText: "4 of 6 criteria", ...o,
});

await test("Fit and Nudge: Nudge only on unopened CIM links of live deals; 'CIM not live' otherwise", () => {
  const unopened = buyerRow({ accessId: "a2", name: "Wei Zhang", firstSeenAt: null, lastSeenAt: null, readingMs: 0, pagesRead: 0, status: "not_opened", statusLabel: "Not opened yet", decision: "", fit: null, fitText: null });
  const notLive = buyerRow({ accessId: "a3", name: "Ana Ruiz", live: false, firstSeenAt: null, lastSeenAt: null, status: "not_opened", statusLabel: "Not opened yet", decision: "" });
  const teaser = buyerRow({ accessId: "a4", name: "Tom Lee", document: "teaser", accessLevel: "teaser_only", accessLabel: "Teaser", status: "teaser", statusLabel: "Has the teaser", readingMs: null, pagesRead: null, contentPages: null, firstSeenAt: null, lastSeenAt: null });
  assert.equal(canNudge(buyerRow({})), false);
  assert.equal(canNudge(unopened), true);
  assert.equal(canNudge(notLive), false);
  assert.equal(canNudge(teaser), false, "a teaser link is never nudged to open the CIM");
  const html = render(h(BuyersTable, { rows: [buyerRow({}), unopened, notLive, teaser], onNudge() {} }));
  assert.match(text(html), /4 of 6 criteria/);
  assert.match(html, /data-testid="nudge-a2"/);
  assert.doesNotMatch(html, /data-testid="nudge-a1"/);
  assert.doesNotMatch(html, /data-testid="nudge-a3"/);
  assert.doesNotMatch(html, /data-testid="nudge-a4"/);
  assert.match(text(html), /CIM not live/);
  assert.match(text(html), /Has the teaser/);
  assert.match(text(html), /Full CIM/);
  assert.match(html, /href="\/deal\/d1\/engagement\?view=teaser"/, "a teaser row opens the Teaser view");
});

await test("the number chip shows in the number's own words and restricts the rows to exactly that set", () => {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, enabled: false } } });
  const rows = [buyerRow({ accessId: "a1" }), buyerRow({ accessId: "a2", name: "Travis Holmgren" }), buyerRow({ accessId: "a3", name: "Natalie Vasconcelos" })];
  qc.setQueryData(analyticsKeys.buyers(null), { rows, partial: null });
  qc.setQueryData(analyticsKeys.overview("30d", null), { kpis: [kpi("reading", 2, { ids: ["a1", "a3"] })] });
  const html = render(h(AllBuyersTab, { examples: null, state: { ...ANALYTICS_URL_DEFAULTS, tab: "buyers", kpi: { id: "reading", range: "30d" } }, update() {} }), qc);
  const t = text(html);
  assert.match(t, /Read in the last 30 days/);
  assert.match(html, /data-testid="kpi-chip"/);
  assert.match(t, /2 of 2 buyers/);
  assert.match(t, /Gurdeep Randhawa/);
  assert.match(t, /Natalie Vasconcelos/);
  assert.doesNotMatch(t, /Travis Holmgren/);
  assert.equal(kpiChipWords("to_call", "all"), "Worth a call");
  assert.equal(kpiChipWords("nda", "all"), "Signed the NDA so far");
});

console.log("Empty states and the period note");

await test("each page empty state says what to do next", () => {
  for (const kind of ["no_deals", "no_buyers", "only_examples"] as const) {
    const t = text(render(h(AnalyticsEmpty, { kind })));
    assert.match(t, new RegExp(ANALYTICS_EMPTY_COPY[kind].title));
    assert.match(t, new RegExp(ANALYTICS_EMPTY_COPY[kind].button));
  }
  assert.equal(analyticsEmptyKind({ counts: { deals: 0, dealsWithBuyers: 0 }, examples: { included: true, count: 0 } }), "no_deals");
  assert.equal(analyticsEmptyKind({ counts: { deals: 3, dealsWithBuyers: 0 }, examples: { included: true, count: 0 } }), "no_buyers");
  assert.equal(analyticsEmptyKind({ counts: { deals: 3, dealsWithBuyers: 0 }, examples: { included: false, count: 2 } }), "only_examples");
  assert.equal(analyticsEmptyKind({ counts: { deals: 3, dealsWithBuyers: 1 }, examples: { included: true, count: 2 } }), null);
});

await test("the period note: automatic → all time, and an explicit empty period", () => {
  const last = { at: "2026-09-23T15:00:00Z", text: "Gurdeep Randhawa read Pacific Coast Logistics" };
  const auto = text(render(h(RangeNote, { range: "all", rangeAuto: true, anyInRange: true, lastActivity: last, onPick() {} })));
  assert.match(auto, /Nothing happened in the last 30 days, so this shows all time. Last activity: 23 Sept, Gurdeep Randhawa read Pacific Coast Logistics./);
  assert.match(auto, /Last 30 days/);
  const explicit = text(render(h(RangeNote, { range: "7d", rangeAuto: false, anyInRange: false, lastActivity: last, onPick() {} })));
  assert.match(explicit, /Nothing in the last 7 days. Last activity: 23 Sept./);
  assert.match(explicit, /Show all time/);
  assert.equal(rangeNoteContent({ range: "30d", rangeAuto: true, anyInRange: true, lastActivity: last }), null, "nothing to say");
  assert.equal(rangeNoteContent({ range: "7d", rangeAuto: false, anyInRange: true, lastActivity: last }), null);
});

await test("heads-up lines link to exactly those buyers", () => {
  const html = render(h(HeadsUp, { lines: [{ id: "expiring", count: 4, text: "4 buyer links run out in the next 7 days: Victoria Ashdown, Marcus Albrecht and 2 more.", names: [], link: "/broker/analytics?tab=buyers&status=expiring" }] }));
  assert.match(text(html), /4 buyer links run out in the next 7 days/);
  assert.match(text(html), /4 links run out this week/);
  assert.match(html, /href="\/broker\/analytics\?tab=buyers&amp;status=expiring"/);
});

console.log("Activity");

const item = (o: Partial<ActivityItem>): ActivityItem => ({
  id: "v:1", at: "2026-09-23T19:12:00Z", kind: "opened", group: "reading", dealId: "d1", dealName: "Pacific Coast Logistics",
  accessId: "a1", name: "Gurdeep Randhawa", company: null, title: "Gurdeep Randhawa opened the CIM", detail: "3 min 20 s reading · spent time on 9 pages",
  tone: "positive", link: { href: "/deal/d1/engagement?journey=a1", label: "See visit" }, ...o,
});

await test("day headers, bold names, the deal chip, the Sample tag", () => {
  const now = Date.parse("2026-10-09T16:00:00Z");
  const html = render(h(ActivityList, {
    items: [
      item({ id: "q:1", at: "2026-10-09T14:00:00Z", kind: "question", group: "question", title: "Travis Holmgren asked: “Is the truck yard available?”", name: "Travis Holmgren", detail: "Waiting for your answer", link: { href: "/deal/d1/qa", label: "Answer" } }),
      item({ id: "v:2", at: "2026-10-08T14:00:00Z" }),
      item({ id: "v:3", sample: true }),
    ],
    showDeal: true,
    now,
  }));
  const t = text(html);
  assert.match(t, /Today/);
  assert.match(t, /Yesterday/);
  assert.match(t, /Wed 23 Sept/);
  assert.match(html, /<strong[^>]*>Gurdeep Randhawa<\/strong> opened the CIM/);
  assert.match(html, /<strong[^>]*>Travis Holmgren<\/strong> asked/);
  assert.match(t, /Pacific Coast Logistics/);
  assert.match(html, /data-testid="sample-tag"/);
  assert.match(t, /3:12 pm/);
  assert.equal(dayHeading("2026-09-23T19:12:00Z", now), "Wed 23 Sept");
});

await test("the pinned reading-now line", () => {
  const html = render(h(ReadingNowLine, { rows: [{ accessId: "a1", dealId: "d1", dealName: "Pacific Coast Logistics", name: "Gurdeep Randhawa", company: null, document: "cim", since: "2026-10-09T15:59:00Z", page: null }], showDeal: true }));
  assert.match(text(html), /Gurdeep Randhawa is reading Pacific Coast Logistics now. Open buyer/);
});

console.log("The deal's Buyers list");

const grow = (accessId: string, name: string, o: Partial<BuyerGroups["worthACall"][number]> = {}) => ({
  accessId, name, company: null, accessLevel: "named", grantedAt: "2026-09-05T15:00:00Z", ndaSigned: true, lastSeenAt: "2026-09-23T15:00:00Z", hasCard: true, ...o,
});
const card = (accessId: string, name: string): BuyerEngagementCard => ({
  accessId, buyerUserId: null, name, company: null, buyerType: null, accessLevel: "named", mode: "normal", status: "hot", statusLabel: "Hot",
  why: "Read the financials twice.", fit: null, activeMs: 7_920_000, visits: 3, firstSeenAt: null, lastSeenAt: "2026-09-23T15:00:00Z",
  pagesReached: 24, totalPages: 27, pageStrip: [], signals: [], talkingPoints: [], questions: [], decision: "", decisionAt: null, contactedAt: null, rank: 0,
});

await test("callable buyers under Worth a call, declined ones folded, quiet ones with Last read", () => {
  const groups: BuyerGroups = {
    worthACall: [grow("a1", "Gurdeep Randhawa")],
    reading: [grow("a2", "Travis Holmgren")],
    quietInRange: [grow("a5", "Quiet Quinn", { lastSeenAt: "2026-09-12T15:00:00Z", hasCard: false })],
    declined: [grow("a3", "Declan No")],
    revoked: [],
    notOpened: [grow("a4", "Wei Zhang", { lastSeenAt: null, hasCard: false, ndaSigned: false })],
  };
  const props = {
    groups, cards: new Map([["a1", card("a1", "Gurdeep Randhawa")], ["a2", card("a2", "Travis Holmgren")]]),
    selected: "a1", onSelect() {}, maxMs: 1, titles: new Map(), blindTitles: new Map(), live: true, nudgeMode: () => "copy" as const, onNudge() {},
  };
  const html = render(h(BuyerList, { ...props, range: "7d" }));
  const t = text(html);
  assert.match(t, /Worth a call, from reading in the last 7 days \(1\)/);
  assert.match(html, /data-testid="list-row-a1"/);
  assert.match(t, /Still reading, not yet a lead \(1\)/);
  assert.match(t, /Said no or didn't respond \(1\)/);
  assert.doesNotMatch(html, /data-testid="list-row-a3"/, "the declined group starts folded");
  assert.match(t, /No reading in this period \(1\)/);
  assert.match(t, /Not opened yet \(1\)/);
  assert.match(t, /Access given .* NDA not signed yet/);
  assert.match(html, /data-testid="nudge-a4"/);
  const all = render(h(BuyerList, { ...props, range: "all" }));
  assert.doesNotMatch(text(all), /No reading in this period/, "only under a date filter");
  assert.match(text(all), /Worth a call \(1\)/);
});

console.log("Tab bar");

await test("short labels below 640 px", () => {
  const html = render(h(DashboardTabBar, {
    tabs: [{ key: "call", label: "Who to call", shortLabel: "Call", count: 9 }, { key: "attention", label: "What buyers read most", shortLabel: "Most read" }, { key: "deals", label: "Deals", count: "loading" }],
    value: "call", onChange() {}, ariaLabel: "Analytics views",
  }));
  assert.match(html, /<span class="sm:hidden">Call<\/span><span class="hidden sm:inline">Who to call<\/span>/);
  assert.match(html, /<span class="sm:hidden">Most read<\/span>/);
  assert.match(text(html), /Who to call 9/);
  assert.match(html, />·<\/span>/, "a loading count shows a dot");
});

console.log("What buyers read most");

await test("By kind says 'Needs part-by-part reading' when only page totals exist; topics still show", () => {
  const data: AttentionResponse = {
    partByPart: false,
    byRole: [{ role: "financials", label: "Financials", attentionMs: 15_000_000, expectedMs: 7_080_000, readers: 11, pages: 6 }],
    byKind: [], byLayout: [{ layoutType: "financial_table", label: "Financial tables", attentionMs: 9_000_000, expectedMs: 4_000_000, pages: 4, readers: 11 } as AttentionResponse["byLayout"][number]],
    benchmarks: [], basis: { buyers: 13, deals: 2, attentionMs: 31_000_000 },
  };
  const t = text(render(h(AttentionPanels, { data })));
  assert.match(t, new RegExp(ATTENTION_COPY.needsParts.slice(0, 40)));
  assert.match(t, /Buyers read your Financials pages most closely, 2.1 times the time their content needs./);
  assert.match(t, /Based on 13 buyers across 2 deals/);
});

console.log("Buyer pulse");

function pulseData(o: Partial<DealKpisResponse> = {}): DealKpisResponse {
  return {
    published: true,
    kpis: [kpi("to_call", 5), kpi("waiting", 1), kpi("opened", 13, { display: "13 of 13" }), kpi("reading", 0, { sub: "last on 23 Sept" }), kpi("nda", 12), kpi("interested", 5)],
    callTop: [{ dealId: "d1", dealName: "Pacific", accessId: "a1", name: "Gurdeep Randhawa", company: "Kinbrook Freightway", status: "interested", statusLabel: "Interested", why: "Chose Interested on 18 Sept.", talkingPoints: [], lastSeenAt: null } as CallListEntry],
    groups: { worthACall: [], reading: [], quietInRange: [], declined: [], revoked: [], notOpened: [] },
    readingNow: [], readersAll: 13, readersWeek: 0, lastReadAt: "2026-09-23T15:00:00Z", grantedCim: 13,
    mostStudiedPage: { pageId: "p1", part: 0, label: "12", title: "Organization & Key Personnel", attentionMs: 2_206_000 },
    renditions: [], legacyOnly: true, sampleReading: false, forText: "All time · All buyers", ...o,
  };
}

await test("never '0 reading this week': it says who has read it and when", () => {
  const html = render(h(PulseTop, { dealId: "d1", data: pulseData(), readingNow: [] }));
  const t = text(html);
  assert.doesNotMatch(t, /0 reading this week/);
  assert.match(t, /13 of 13 opened/);
  assert.match(t, /13 have read it, last on 23 Sept/);
  assert.match(t, /5 interested/);
  assert.match(t, /1 waiting on you/);
  assert.match(t, /Call first/);
  assert.match(t, /Gurdeep Randhawa/);
  assert.match(t, /Where they read/);
  assert.match(t, /Most studied page: Organization & Key Personnel/);
  const week = pulseStats(pulseData({ readersWeek: 2 })).map((s) => `${s.value} ${s.words}`.trim());
  assert.ok(week.includes("2 reading this week"));
  const none = pulseStats(pulseData({ readersWeek: 0, readersAll: 0, lastReadAt: null })).map((s) => s.words);
  assert.ok(none.includes("no one has read it yet"));
  const sample = text(render(h(PulseTop, { dealId: "d1", data: pulseData({ sampleReading: true }), readingNow: [] })));
  assert.match(sample, /Sample reading/);
});

console.log(`\n${passed} passed`);
