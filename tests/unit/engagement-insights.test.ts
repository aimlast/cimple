/**
 * Engagement intelligence (server/engagement/insights.ts): every signal and
 * its talking point, every status, the call priority order, the headlines,
 * journey moments, the reading-model and page-role rules, the qualified-lead
 * score's intent input, and the call-list / compare builders. Pure: no
 * database, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/engagement-insights.test.ts
 */
import assert from "node:assert/strict";
import {
  type BuyerReadingFacts, type DealReadingFacts, type DocumentPage, type FactPage, type PageRole, type ReachPoint,
  type VisitFacts, DEFAULT_ENGAGEMENT_FILTERS, viewerPageKey,
} from "../../shared/analytics-v2";
import {
  INSIGHT_RULES, blockPhrase, buyerInsight, earningsBasis, isMarkedDrop, journeyMoments, pageHeadline, rankBuyers, reachHeadline, readingSummary,
  whenText, type InsightContext,
} from "../../server/engagement/insights";
import { groupReadLabel, kindMixHeadline, pageReadLabel, readLabel } from "../../shared/cim-reading-model";
import { pageRole } from "../../shared/cim-page-role";
import { calculateQualifiedLeadScore } from "../../server/scoring/buyer-score";
import { attentionMix, buildCallList, dealCompareRow } from "../../server/routes/engagement-insights";

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

// ── A small CIM ──────────────────────────────────────────────────────────
const NOW = new Date("2026-09-28T16:00:00Z"); // noon in Toronto
const H = 3_600_000;
const D = 24 * H;
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

type P = [id: string, title: string, role: PageRole, expectedMs: number, extra?: Partial<FactPage>];
const spec: P[] = [
  ["cover", "Project Atlas", "front_matter", 5_000, { layoutType: "cover_page" }],
  ["exec", "Executive Summary", "overview", 40_000],
  ["cust", "Customer Concentration", "customers", 30_000],
  ["lease", "Location & Lease", "location", 25_000],
  ["team", "Management & Staff", "employees", 30_000],
  ["growth", "Growth Opportunities", "growth", 30_000],
  ["inc", "Income Statement", "financials", 45_000, { layoutType: "financial_table" }],
  ["bridge", "Adjusted EBITDA Bridge", "normalization", 30_000, { layoutType: "waterfall_chart" }],
  ["locked", "Financial Detail", "financials", 1_500, { locked: true }],
  ["deal", "Transaction Overview", "transaction", 30_000],
  ["cim-contact", "Contact", "front_matter", 5_000],
];
const pages: FactPage[] = spec.map(([pageId, title, role, expectedMs, extra], i) => ({
  pageId, part: 0, index: i, label: String(i + 1), lineageId: pageId, title, servedTitle: null, blindTitle: title,
  layoutType: "prose_highlight", role, locked: false, expectedMs,
  blocks: [
    { key: "heading", kind: "heading", label: `Title: ${title}`, expectedMs: 500, part: 0 },
    { key: "row:0", kind: "table", label: "Row: Adjusted EBITDA", expectedMs: Math.max(0, expectedMs - 500) / 2, part: 0 },
    { key: "para:0", kind: "text", label: "Paragraph 1", expectedMs: Math.max(0, expectedMs - 500) / 2, part: 0 },
  ],
  ...extra,
}));
const pageById = new Map(pages.map((p) => [p.pageId, p]));
const idx = (id: string) => pages.findIndex((p) => p.pageId === id);

function visit(id: string, startAgo: number, minutes: number, path: Array<[number, string]> = [], extra: Partial<VisitFacts> = {}): VisitFacts {
  const start = NOW.getTime() - startAgo;
  return {
    id, renditionId: "r".repeat(32), startedAt: new Date(start).toISOString(), lastSeenAt: new Date(start + minutes * 60_000).toISOString(),
    wallMs: minutes * 60_000, activeMs: minutes * 60_000, device: "desktop", uaFamily: "Chrome/Mac",
    maxPageIndex: path.length ? Math.max(...path.map(([, p]) => idx(p))) : -1, path, legacy: false, networkKey: "n1", ...extra,
  };
}

/** Reading per page as a multiple of its expected time. */
function buyer(id: string, readMult: Record<string, number>, over: Partial<BuyerReadingFacts> = {}): BuyerReadingFacts {
  const pagesRead: BuyerReadingFacts["pages"] = {};
  const blocks: BuyerReadingFacts["blocks"] = {};
  for (const [pid, m] of Object.entries(readMult)) {
    const p = pageById.get(pid)!;
    const att = Math.round(p.expectedMs * m);
    pagesRead[viewerPageKey(pid, 0)] = { attentionMs: att, skimMs: 0, visibleMs: att, firstAt: at(2 * D), lastAt: at(D), visits: 1 };
    blocks[`${pid}|row:0`] = [Math.round(att * 0.7), 0, att, 0];
    blocks[`${pid}|para:0`] = [Math.round(att * 0.3), 0, att, 0];
  }
  return {
    accessId: id, buyerUserId: null, name: `Buyer ${id}`, company: null, email: `${id}@x.invalid`, buyerType: null,
    accessLevel: "full", mode: "blind", grantedAt: at(10 * D), firstViewedAt: at(3 * D), ndaSignedAt: at(3 * D),
    decision: "under_review", decisionAt: null, contactedAt: null, fit: null,
    visits: [visit(`${id}-v1`, D, 20, [[0, "cover"], [10, "exec"]])], pages: pagesRead, blocks, events: [], questions: [],
    ...over,
  };
}

const all = (m: number) => Object.fromEntries(pages.filter((p) => p.role !== "front_matter" && !p.locked).map((p) => [p.pageId, m]));

// PE buyer: studies the numbers, toggles Normalized, returns, asks about the lease.
const pe = buyer("pe", { ...all(1), inc: 3, bridge: 2.5, exec: 1.2 }, {
  fit: { criteriaMatched: 5, criteriaTotal: 6, deepCheckVerdict: "strong", deepCheckFit: 88 },
  visits: [
    visit("pe-v1", 4 * D, 30, [[0, "cover"], [5, "exec"], [60, "inc"], [400, "bridge"], [700, "deal"], [900, "cim-contact"]]),
    visit("pe-v2", 20 * H, 12, [[0, "inc"], [300, "cust"], [600, "lease"]]),
  ],
  events: [
    { seq: 1, type: "financial_view", pageId: "inc", detail: "normalized", at: at(4 * D - 5 * 60_000), visitId: "pe-v1" },
    { seq: 2, type: "financial_view", pageId: "inc", detail: "normalized", at: at(20 * H - 60_000), visitId: "pe-v2" },
  ],
  questions: [{ id: "q1", text: "Is the lease transferable to a new owner?", askedAt: at(20 * H - 5 * 60_000), pageId: "lease", status: "pending", answered: false }],
});
pe.pages[viewerPageKey("inc", 0)].visits = 2;

const skimmer = buyer("skim", { exec: 0.1, cust: 0.05 }, { visits: [visit("s-v1", 2 * D, 3, [[0, "cover"], [20, "exec"]])] });
const quiet = buyer("quiet", { ...all(1.1), inc: 2 }, { visits: [visit("q-v1", 9 * D, 40, [[0, "cover"], [10, "exec"], [2000, "deal"]])] });
const priceFirst = buyer("price", { deal: 2, exec: 0.3, inc: 0.8 }, { visits: [visit("p-v1", 5 * H, 10, [[0, "cover"], [3, "deal"], [200, "inc"]])] });
const interestedContacted = buyer("intc", { ...all(1), inc: 2.5 }, { decision: "interested", decisionAt: at(2 * D), contactedAt: at(2 * H), visits: [visit("ic-v1", 2 * D, 40, [[0, "cover"], [5, "exec"]])] });
const interestedFresh = buyer("intf", { ...all(1), inc: 2.5 }, { decision: "interested", decisionAt: at(2 * D), visits: [visit("if-v1", 2 * D, 40, [[0, "cover"], [5, "exec"]])] });
const readingNow = buyer("now", { exec: 1 }, { visits: [visit("n-v1", 5 * 60_000, 4.5, [[0, "cover"], [5, "exec"]])] });
const notOpened = buyer("none", {}, { visits: [], firstViewedAt: null, pages: {} });
const contactedYesterday = buyer("cy", { ...all(0.6), inc: 1.2 }, { contactedAt: at(D + 2 * H), visits: [visit("cy-v1", 2 * D, 25, [[0, "cover"], [5, "exec"]])] });
const locked = buyer("lock", { exec: 1, locked: 20 }, {
  accessLevel: "teaser",
  events: [
    { seq: 1, type: "locked_click", pageId: "locked", at: at(D), visitId: "lock-v1" },
    { seq: 2, type: "locked_click", pageId: "locked", at: at(D), visitId: "lock-v1" },
  ],
});
const contactClick = buyer("cc", { exec: 1, cust: 1 }, { events: [{ seq: 1, type: "contact_click", pageId: "cim-contact", detail: "phone", at: at(3 * H), visitId: "cc-v1" }] });
const multi = buyer("multi", { exec: 1 }, {
  visits: [visit("m1", 5 * D, 5, [], { networkKey: "a" }), visit("m2", 3 * D, 5, [], { networkKey: "b" }), visit("m3", D, 5, [], { networkKey: "c" })],
});
const copier = buyer("copy", { exec: 1, inc: 1 }, { events: [{ seq: 1, type: "copy", pageId: "inc", at: at(D), visitId: "copy-v1" }] });
const others = ["o1", "o2", "o3"].map((id) => buyer(id, { cust: 1, exec: 0.5 }));
const outlier = buyer("out", { cust: 6, exec: 0.5 });
const completer = buyer("done", all(0.8), { visits: [visit("d-v1", 3 * D, 50, [[0, "cover"], [5, "exec"], [2900, "deal"], [2990, "cim-contact"]])] });
const grower = buyer("grow", { growth: 3, exec: 1 });
const concerned = buyer("conc", { team: 3, exec: 1 });
const notInterested = buyer("nope", { ...all(1.5) }, { decision: "not_interested", decisionAt: at(D) });

const everyone = [pe, skimmer, quiet, priceFirst, interestedContacted, interestedFresh, readingNow, notOpened, contactedYesterday,
  locked, contactClick, multi, copier, ...others, outlier, completer, grower, concerned, notInterested];
const ctx: InsightContext = { now: NOW, pages, buyers: everyone };
const ins = (b: BuyerReadingFacts) => buyerInsight(b, ctx);
const ids = (b: BuyerReadingFacts) => ins(b).signals.map((s) => s.id);

// ── Signals ──────────────────────────────────────────────────────────────
console.log("signals");
await test("financial_deep_dive + normalized_toggle + returned + asked on the PE buyer, evidence in seconds and pages", () => {
  const i = ins(pe);
  for (const s of ["financial_deep_dive", "normalized_toggle", "returned", "asked"]) assert.ok(ids(pe).includes(s as any), s);
  const deep = i.signals.find((s) => s.id === "financial_deep_dive")!;
  assert.match(deep.evidence, /Income Statement/);
  assert.match(deep.evidence, /\d+ min( \d+ s)?|\d+ s/);
  assert.match(deep.evidence, /over 2 visits/);
  assert.match(i.signals.find((s) => s.id === "normalized_toggle")!.evidence, /Normalized 2 times/);
  assert.match(i.signals.find((s) => s.id === "returned")!.evidence, /Came back yesterday/);
  assert.match(i.signals.find((s) => s.id === "asked")!.evidence, /lease transferable.*page 4 · Location & Lease.*not answered yet/);
});
await test("talking points: the strongest three, one per topic, each quoting its evidence", () => {
  const tp = ins(pe).talkingPoints;
  assert.equal(tp.length, 3);
  assert.equal(tp[0].signalId, "asked", "an unanswered question leads");
  assert.match(tp[0].text, /Answer their question on the call: “Is the lease transferable/);
  assert.ok(tp.every((t) => t.evidence.length > 10));
  assert.equal(new Set(tp.map((t) => t.signalId)).size, 3);
  // The lease question and a lease "concern" are the same topic — never both.
  const locTopics = tp.filter((t) => t.pageRefs.some((r) => r.pageId === "lease"));
  assert.ok(locTopics.length <= 1);
  assert.ok(tp.some((t) => /add-back|adjusted EBITDA/.test(t.text)));
});
await test("price_first when the first real page is price & terms", () => {
  assert.ok(ids(priceFirst).includes("price_first"));
  assert.match(ins(priceFirst).talkingPoints.map((t) => t.text).join(" "), /Went straight to price and structure/);
  assert.ok(!ids(pe).includes("price_first"), "reading the summary first isn't price-first");
});
await test("skimmed is never said about a buyer who studied a page (straight to the numbers)", () => {
  // One short visit: 1 min 40 s in all, but the income statement studied for 39 s+.
  const focused = buyer("focus", { inc: 2.2, exec: 0.02 }, { mode: "normal", visits: [visit("f-v1", 3 * H, 2, [[0, "cover"], [3, "inc"]])] });
  // A long CIM: 107 s of reading is well under a fifth of what it needs.
  const big = pages.map((p) => (p.pageId === "exec" ? { ...p, expectedMs: 900_000 } : p));
  const i = buyerInsight(focused, { now: NOW, pages: big, buyers: [focused] });
  assert.ok(!i.signals.some((x) => x.id === "skimmed"), JSON.stringify(i.signals.map((x) => x.id)));
  assert.ok(i.signals.some((x) => x.id === "financial_deep_dive"));
  assert.ok(!/skimmed/i.test(i.why), i.why);
  assert.notEqual(i.status, "skimmed");
});

await test("front matter is 'Opened', never 'Studied' (a buyer who opened it and walked away)", () => {
  const away = buyer("away", { cover: 12 }, { mode: "normal", visits: [visit("a-v1", 3 * H, 1, [[0, "cover"]])] });
  assert.equal(ins(away).pageLabels[viewerPageKey("cover", 0)], "opened");
  // Their "why": they never read past the cover — not "skimmed it (1 min)".
  assert.match(ins(away).why, /didn't read past the cover/);
  assert.doesNotMatch(ins(away).why, /1 min/);
  assert.equal(pageReadLabel("front_matter", 59_000, 5_000), "opened");
  assert.equal(pageReadLabel("front_matter", 59_000, 5_000, false), null);
  assert.equal(pageReadLabel("financials", 59_000, 5_000), "studied");
  assert.equal(groupReadLabel(["opened", "opened"]), "opened");
  assert.equal(groupReadLabel(["opened", "read", "studied"]), "read");
});

await test("the earnings wording follows the deal's basis: SDE deals never hear 'EBITDA'", () => {
  const P = (title: string, labels: string[] = []) => ({ role: "normalization" as PageRole, title, blocks: labels.map((label) => ({ key: "x", kind: "table" as const, label, expectedMs: 1, part: 0 })) });
  assert.equal(earningsBasis([P("Seller's Discretionary Earnings Build-Up", ["Row: Adjusted EBITDA"])]), "sde");
  assert.equal(earningsBasis([P("Normalization", ["Row: SDE"])]), "sde");
  assert.equal(earningsBasis([P("Adjusted EBITDA Bridge")]), "ebitda");
  assert.equal(earningsBasis([P("Adjustments", ["Row: Owner salary"])]), null);
  assert.equal(earningsBasis([{ ...P("x"), role: "financials" as PageRole }]), null);
  // The talking point on a dental (SDE) deal.
  const sdePages = pages.map((p) => (p.pageId === "bridge" ? { ...p, title: "Seller's Discretionary Earnings Build-Up", blindTitle: "Seller's Discretionary Earnings Build-Up" } : p));
  const ctx2: InsightContext = { now: NOW, pages: sdePages, buyers: [pe] };
  const tp = buyerInsight(pe, ctx2).talkingPoints.map((t) => t.text).join(" ");
  assert.ok(!/EBITDA/.test(tp), tp);
  assert.match(tp, /SDE build-up/);
});

await test("blind buyers: talking points and why lines use the title THEY saw; the real one is broker-only context", () => {
  const blindPages = pages.map((p) => (p.pageId === "cust"
    ? { ...p, title: "Harbourline Dental Group — Patients", blindTitle: "Patient Base" }
    : p.pageId === "cover" ? { ...p, title: "Harbourline Dental Group", blindTitle: "Project Atlas" } : p));
  const who = buyer("bl", { cust: 3, exec: 1 }, { mode: "blind", visits: [visit("bl-v1", 3 * H, 20, [[0, "cover"], [5, "cust"]])] });
  const i = buyerInsight(who, { now: NOW, pages: blindPages, buyers: [who] });
  const words = [i.why, ...i.signals.map((x) => x.evidence), ...i.talkingPoints.map((t) => `${t.text} ${t.evidence}`)].join(" | ");
  assert.ok(!/Harbourline/.test(words), words);
  assert.match(words, /Patient Base/);
  const ref = i.signals.flatMap((x) => x.pageRefs).find((r) => r.pageId === "cust")!;
  assert.equal(ref.servedTitle, "Patient Base");
  assert.equal(ref.title, "Harbourline Dental Group — Patients", "the real title rides along for the broker");
  // No blind title known for a page: it is "page N", never the real title.
  const unknown = blindPages.map((p) => (p.pageId === "cust" ? { ...p, blindTitle: null } : p));
  const j = buyerInsight(who, { now: NOW, pages: unknown, buyers: [who] });
  assert.ok(!/Harbourline/.test([j.why, ...j.signals.map((x) => x.evidence)].join(" ")));
  // A named buyer on the same page hears the real title.
  const named = { ...who, accessId: "nm", mode: "normal" as const };
  assert.match(buyerInsight(named, { now: NOW, pages: blindPages, buyers: [named] }).signals.map((x) => x.evidence).join(" "), /Harbourline Dental Group — Patients/);
  // Journey moments too.
  const m = journeyMoments(who.visits[0], who, { now: NOW, pages: blindPages, buyers: [who] });
  assert.ok(!/Harbourline/.test(m.map((x) => x.text).join(" ")), m.map((x) => x.text).join(" | "));
});

await test("skimmed: one visit, well under the CIM's reading time", () => {
  const s = ins(skimmer).signals.find((x) => x.id === "skimmed")!;
  assert.ok(s);
  assert.match(s.evidence, /One visit with \d+ s of reading .* the CIM takes about \d+ min/);
  assert.equal(ins(skimmer).talkingPoints[0].text, "Only skimmed. A short qualifying call may save time.");
});
await test("stalled: strong reading, then quiet for 5+ days while undecided", () => {
  assert.ok(ids(quiet).includes("stalled"));
  assert.ok(ins(quiet).talkingPoints.some((t) => t.text === "Went quiet after strong reading. Follow up now."));
  assert.ok(!ids(interestedFresh).includes("stalled"), "a decided buyer never 'went quiet'");
});
await test("concern_focus (team), growth_focus, locked_interest, contact_click, multi_network, copy_print, completed", () => {
  assert.ok(ids(concerned).includes("concern_focus"));
  assert.match(ins(concerned).talkingPoints.map((t) => t.text).join(" "), /key staff/);
  assert.ok(ids(grower).includes("growth_focus"));
  assert.match(ins(grower).talkingPoints[0].text, /growth plan/);
  assert.ok(ids(locked).includes("locked_interest"));
  assert.match(ins(locked).signals.find((s) => s.id === "locked_interest")!.evidence, /Financial Detail/);
  const cc = ins(contactClick);
  assert.equal(cc.signals[0].id, "contact_click", "a buyer reaching out outranks everything");
  assert.match(cc.talkingPoints[0].text, /missed calls/);
  assert.ok(ids(multi).includes("multi_network"));
  assert.match(ins(multi).talkingPoints.map((t) => t.text).join(" "), /partners or a lender/);
  assert.ok(ids(copier).includes("copy_print"));
  assert.ok(ids(completer).includes("completed"));
  assert.ok(!ins(completer).talkingPoints.some((t) => t.signalId === "completed"), "completed is evidence only");
});
await test("outlier_attention: 3× the other readers' median, with ≥ 3 other readers", () => {
  const s = ins(outlier).signals.find((x) => x.id === "outlier_attention")!;
  assert.ok(s, "outlier found");
  assert.match(s.evidence, /longer than other buyers on Customer Concentration \(3 min against 30 s\)/);
  const few = buyerInsight(outlier, { now: NOW, pages, buyers: [outlier, others[0]] });
  assert.ok(!few.signals.some((x) => x.id === "outlier_attention"), "needs ≥ 3 other readers");
});

// ── Status, why, priority ────────────────────────────────────────────────
console.log("status and priority");
await test("statuses, first match wins", () => {
  assert.equal(ins(readingNow).status, "reading_now");
  assert.equal(ins(pe).status, "hot");
  assert.equal(ins(quiet).status, "went_quiet");
  assert.equal(ins(skimmer).status, "skimmed");
  assert.equal(ins(notOpened).status, "not_opened");
  assert.equal(ins(interestedFresh).status, "interested");
  assert.equal(ins(notInterested).status, "not_interested");
  assert.equal(ins(contactedYesterday).status, "warming");
  const firstViewOnly = buyer("fv", {}, { visits: [], pages: {} });
  assert.equal(ins(firstViewOnly).status, "opened");
  assert.match(ins(firstViewOnly).why, /no reading time was recorded/);
});
await test("Mark contacted: 'Contacted yesterday' for 48 h (not over a decision), and a lower priority", () => {
  assert.equal(ins(contactedYesterday).statusLabel, "Contacted yesterday");
  assert.equal(ins(interestedContacted).statusLabel, "Interested");
  assert.ok(ins(interestedContacted).priority < ins(interestedFresh).priority);
  const stale = { ...contactedYesterday, contactedAt: at(3 * D) };
  assert.equal(ins(stale).statusLabel, "Warming up");
});
await test("the one-line why is built from the evidence", () => {
  assert.match(ins(pe).why, /^[A-Z].*studied the financials for .* over 2 visits.*\.$/);
  assert.match(ins(notOpened).why, /^Hasn't opened the CIM yet — access given/);
  assert.match(ins(interestedFresh).why, /^Chose Interested 2 days ago\. /);
});
await test("intent: 0–1, more serious reading scores higher", () => {
  for (const b of everyone) {
    const i = ins(b).intent;
    assert.ok(i >= 0 && i <= 1, `${b.accessId} ${i}`);
  }
  assert.ok(ins(pe).intent >= INSIGHT_RULES.hotIntent, `pe ${ins(pe).intent}`);
  assert.ok(ins(skimmer).intent < INSIGHT_RULES.warmIntent);
  assert.ok(ins(pe).intent > ins(completer).intent && ins(completer).intent > ins(skimmer).intent);
  assert.equal(ins(notOpened).intent, 0);
});
await test("call priority: intent × fit × recency × openness; not interested and unopened fall to the bottom", () => {
  const ranked = rankBuyers(everyone.map((f) => ({ facts: f, insight: ins(f) }))).map((x) => x.facts.accessId);
  assert.equal(ranked[0], "pe", ranked.join(","));
  assert.ok(ranked.indexOf("pe") < ranked.indexOf("skim"));
  assert.ok(ranked.indexOf("intf") < ranked.indexOf("intc"), "contacted today drops");
  assert.ok(ranked.indexOf("nope") > ranked.indexOf("skim"), "not interested drops below skimmers");
  assert.equal(ranked[ranked.length - 1], "none");
  assert.equal(ins(notOpened).priority, -1);
  // Fit multiplies: the same reading with a weak deep-check fit ranks lower.
  const weak = { ...pe, accessId: "weak", fit: { criteriaMatched: 1, criteriaTotal: 6, deepCheckVerdict: "unlikely" as const, deepCheckFit: 20 } };
  assert.ok(ins(weak).priority < ins(pe).priority);
});
await test("page labels per viewer page (Studied / Read / Glanced / Skipped)", () => {
  const l = ins(pe).pageLabels;
  assert.equal(l[viewerPageKey("inc", 0)], "studied");
  assert.equal(l[viewerPageKey("cust", 0)], "read");
  assert.equal(ins(skimmer).pageLabels[viewerPageKey("cust", 0)], "skipped");
});
await test("wording rules: seconds and minutes, suggestive, never percent / dwell / engagement score", () => {
  for (const b of everyone) {
    const i = ins(b);
    const text = [i.why, ...i.signals.map((s) => s.evidence), ...i.talkingPoints.map((t) => t.text)].join(" ");
    assert.ok(!/%|dwell|engagement score|heat sample/i.test(text), `${b.accessId}: ${text}`);
    assert.ok(!/\b(worried|concerned|afraid|nervous|suspicious)\b/i.test(text), `diagnostic wording: ${text}`);
  }
});

// ── Headlines ────────────────────────────────────────────────────────────
console.log("headlines");
function dp(id: string, over: Partial<DocumentPage> = {}): DocumentPage {
  const p = pageById.get(id)!;
  return {
    pageId: p.pageId, part: 0, index: p.index, label: p.label, lineageId: p.pageId, title: p.title, servedTitle: null,
    layoutType: p.layoutType, role: p.role, locked: !!p.locked, readers: 3, reachedBy: 4, attentionMs: 60_000, skimMs: 0,
    expectedMs: p.expectedMs, readLabel: "read", headline: null, blocks: [], buyers: [], interactions: {}, questions: [],
    changedSince: null, pageLevelOnly: false, ...over,
  };
}
await test("page headline templates", () => {
  const doc = [dp("exec"), dp("inc", { attentionMs: 600_000, readers: 4 }), dp("cust"), dp("deal")];
  assert.equal(pageHeadline(doc[1], { pages: doc, openedBy: 5 }), "Most studied page in the CIM — 4 of 5 buyers read it, 3 times its expected reading time.");
  assert.equal(pageHeadline(dp("locked", { interactions: { locked_click: 3 } }), { pages: doc, openedBy: 5 }), "Locked for teaser buyers — 3 clicks trying to open it.");
  const q = { id: "q", text: "?", askedAt: at(D), pageId: "cust", status: "pending", answered: false, accessId: "a", name: "A" };
  assert.equal(pageHeadline(dp("cust", { questions: [q] }), { pages: doc, openedBy: 5 }), "1 question asked on this page.");
  assert.equal(pageHeadline(dp("deal", { readers: 0, reachedBy: 0, attentionMs: 0 }), { pages: doc, openedBy: 5 }), "No buyer has reached this page yet.");
  assert.equal(pageHeadline(dp("deal", { readers: 1, reachedBy: 6, attentionMs: 5_000 }), { pages: doc, openedBy: 6 }), "6 buyers reached this page but only 1 stopped to read it.");
  assert.equal(pageHeadline(dp("cust", { readers: 2, attentionMs: 120_000, expectedMs: 30_000 }), { pages: doc, openedBy: 5 }), "Readers spend twice the expected reading time here — 1 min each on average.");
  const blocks = [
    { key: "row:0", kind: "table" as const, label: "Row: Adjusted EBITDA", attentionMs: 0, skimMs: 0, visibleMs: 0, pointerMs: 0, skimShare: 0, readers: 0, topBuyer: null, topPoint: null },
    { key: "para:0", kind: "text" as const, label: "Paragraph 1", attentionMs: 9_000, skimMs: 0, visibleMs: 0, pointerMs: 0, skimShare: 0, readers: 2, topBuyer: null, topPoint: null },
  ];
  assert.equal(pageHeadline(dp("exec", { attentionMs: 20_000, readers: 2, reachedBy: 3, blocks }), { pages: doc, openedBy: 5 }), "Nobody stopped on the row “Adjusted EBITDA”.");
  assert.equal(pageHeadline(doc[0], { pages: doc, openedBy: 0 }), null);
  assert.equal(blockPhrase('Highlight: "Recurring revenue 68%"'), "the highlight “Recurring revenue 68%”");
});
await test("reach headline: the steepest drop, or how many reached the end", () => {
  const r = (label: string, buyers: number, title = `Page ${label}`): ReachPoint => ({ index: Number(label) - 1, pageId: label, part: 0, label, title, buyers });
  assert.equal(reachHeadline([r("1", 9), r("2", 9), r("13", 9), r("14", 4, "Employees & Management"), r("15", 3)]), "Most buyers stopped around page 14 · Employees & Management (9 → 4 readers).");
  assert.equal(reachHeadline([r("1", 9), r("2", 7), r("3", 5)]), "The biggest drop is around page 2 · Page 2 (9 → 7 readers).");
  assert.equal(reachHeadline([r("1", 4), r("2", 4)]), "All 4 buyers who opened the CIM reached the last page.");
  assert.equal(reachHeadline([r("1", 1), r("2", 1)]), "The buyer who opened the CIM reached the last page.");
  // One buyer (or a view filtered to one): never "most buyers", never a one-buyer "drop".
  assert.equal(reachHeadline([r("1", 1), r("2", 1), r("10", 0, "Customers"), r("11", 0)]), "This buyer got as far as page 2 · Page 2.");
  // A one-buyer drop in a group is noise; so is a drop under 10% of the buyers.
  assert.equal(reachHeadline([r("1", 5), r("2", 4), r("3", 4)]), "4 of 5 buyers reached the last page.");
  assert.equal(reachHeadline([r("1", 30), r("2", 28), r("3", 28)]), "28 of 30 buyers reached the last page.");
  assert.equal(isMarkedDrop(1, 3), false);
  assert.equal(isMarkedDrop(2, 30), false);
  assert.equal(isMarkedDrop(3, 30), true);
  assert.equal(reachHeadline([r("1", 12), r("2", 11), r("3", 11)]), "11 of 12 buyers reached the last page.");
  assert.equal(reachHeadline([]), null);
  assert.equal(reachHeadline([r("1", 0)]), null);
});
await test("what holds attention: compared per unit of content", () => {
  assert.equal(kindMixHeadline([
    { group: "tables", label: "Tables", attentionMs: 200_000, expectedMs: 100_000 },
    { group: "text", label: "Text", attentionMs: 300_000, expectedMs: 300_000 },
  ]), "Buyers read tables most closely — twice as long as text, for the same amount of content.");
  assert.equal(kindMixHeadline([{ group: "tables", label: "Tables", attentionMs: 9_000, expectedMs: 9_000 }]), null);
  assert.match(kindMixHeadline([
    { group: "tables", label: "Tables", attentionMs: 100_000, expectedMs: 100_000 },
    { group: "text", label: "Text", attentionMs: 95_000, expectedMs: 100_000 },
  ])!, /about the same attention/);
});

// ── Journeys ─────────────────────────────────────────────────────────────
console.log("journeys");
await test("key moments of a visit", () => {
  const m1 = journeyMoments(pe.visits[0], pe, ctx).map((m) => m.text);
  assert.ok(m1.includes("Switched Income Statement to Normalized"), m1.join(" | "));
  assert.ok(m1.includes("Read to the end"), m1.join(" | "));
  assert.ok(m1.some((t) => /^Spent longest on Income Statement/.test(t)), m1.join(" | "));
  const m2 = journeyMoments(pe.visits[1], pe, ctx).map((m) => m.text);
  assert.ok(m2.some((t) => /^Came back 3 days later only for /.test(t)), m2.join(" | "));
  assert.ok(m2.some((t) => /^Asked “Is the lease transferable/.test(t)), m2.join(" | "));
  assert.ok(m2.some((t) => /^Stopped at page 7 of 10/.test(t)), m2.join(" | "));
  const mp = journeyMoments(priceFirst.visits[0], priceFirst, ctx).map((m) => m.text);
  assert.ok(mp.includes("Went straight to Transaction Overview after the cover"), mp.join(" | "));
  const decided = { ...priceFirst, decision: "interested", decisionAt: at(5 * H - 8 * 60_000) };
  assert.ok(journeyMoments(decided.visits[0], decided, ctx).some((m) => m.text === "Chose Interested"));
  const times = journeyMoments(pe.visits[1], pe, ctx).map((m) => Date.parse(m.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "in time order");
});
await test("relative days follow the broker's calendar", () => {
  assert.equal(whenText(NOW.getTime() - 2 * H, NOW), "today");
  assert.equal(whenText(NOW.getTime() - D, NOW), "yesterday");
  assert.equal(whenText(NOW.getTime() - 3 * D, NOW), "3 days ago");
  assert.equal(whenText(NOW.getTime() - 12 * D, NOW), "on 16 Sept");
});

// ── Reading model, page roles ────────────────────────────────────────────
console.log("reading model and page roles");
await test("read labels with absolute floors", () => {
  assert.equal(readLabel(0, 30_000), "skipped");
  assert.equal(readLabel(10_000, 30_000), "glanced");
  assert.equal(readLabel(30_000, 30_000), "read");
  assert.equal(readLabel(60_000, 30_000), "studied");
  assert.equal(readLabel(9_000, 4_000), "read", "1.5× a tiny page isn't studying it");
  assert.equal(readLabel(1_500, 2_000), "glanced", "a flick past a tiny page");
  assert.equal(readLabel(5_000, 5_000, false), null);
});
await test("page roles: narrow keywords win, no false word-start matches", () => {
  const r = (title: string, layoutType = "prose_highlight") => pageRole({ layoutType, title });
  assert.equal(r("Accounts Receivable Aging"), "financials");
  assert.equal(r("Key Accounts"), "customers");
  assert.equal(r("Supplier Relationships"), "operations");
  assert.equal(r("Service Offerings"), "revenue_mix");
  assert.equal(r("Owner Compensation"), "normalization");
  assert.equal(r("Reason for Sale"), "owner_transition");
  assert.equal(r("Transition & Training"), "owner_transition");
  assert.equal(r("Contractors & Subcontractors"), "employees");
  assert.equal(r("Accounting Systems"), "operations");
  assert.equal(r("Payer Mix"), "revenue_mix");
  assert.equal(r("Confidentiality & Disclaimer"), "front_matter");
  assert.equal(r("Non-Compete & Confidentiality"), "transaction");
  assert.equal(r("Seller Financing & Earn-out"), "transaction");
  assert.equal(r("Market Trends"), "market");
  assert.equal(pageRole({ layoutType: "metric_grid", title: "At a glance?" }), "overview");
  assert.equal(pageRole({ layoutType: "financial_table", title: "Zzz", layoutData: { rows: [{ label: "Revenue" }, { label: "Gross profit" }, { label: "EBITDA" }] } }), "financials");
  assert.equal(pageRole({ layoutType: "metric_grid", title: "Zzz" }), "other");
});

// ── Qualified-lead score: reading intent drives engagement ───────────────
console.log("qualified-lead score");
await test("buyer-score engagement = the reading intent when measured, the old composite otherwise", () => {
  const b = { profileCompletionPct: 50, hasProofOfFunds: false, buyerType: null, liquidFunds: null, buyerCriteria: null, targetIndustries: null } as any;
  const withIntent = calculateQualifiedLeadScore({ buyer: b, engagement: { intent: 0.72, viewCount: 1 } });
  assert.equal(withIntent.breakdown.engagement, 72);
  assert.ok(withIntent.reasons.includes("Read the CIM closely"));
  const legacy = calculateQualifiedLeadScore({ buyer: b, engagement: { viewCount: 3, totalTimeSeconds: 300, sectionsViewed: 8, questionCount: 3, ndaSigned: true } });
  assert.equal(legacy.breakdown.engagement, 100);
  assert.equal(calculateQualifiedLeadScore({ buyer: b, engagement: { intent: null, viewCount: 0 } }).breakdown.engagement, 0);
});

// ── Call list and compare (pure builders behind the global routes) ───────
console.log("call list and compare");
function factsOf(dealId: string, buyers: BuyerReadingFacts[]): DealReadingFacts {
  return {
    dealId, dealName: dealId, rendition: null, renditions: [], now: NOW.toISOString(), filters: DEFAULT_ENGAGEMENT_FILTERS,
    pages, buyers, legacyOnly: false, lastWriteAt: null,
  };
}
await test("call list: merged across deals, best first, top N, no decided-against or unopened buyers", () => {
  const list = buildCallList([
    { deal: { id: "d1", businessName: "Deal One" }, facts: factsOf("d1", [skimmer, notInterested, notOpened, completer]) },
    { deal: { id: "d2", businessName: "Deal Two" }, facts: factsOf("d2", [pe, quiet]) },
  ]);
  assert.equal(list[0].accessId, "pe");
  assert.equal(list[0].dealName, "Deal Two");
  assert.ok(!list.some((e) => e.accessId === "nope" || e.accessId === "none"));
  assert.ok(list.every((e) => e.why.length > 0 && e.statusLabel.length > 0));
  assert.equal(buildCallList([{ deal: { id: "d", businessName: "D" }, facts: factsOf("d", everyone) }], 3).length, 3);
});
await test("compare row and what holds attention", () => {
  const f = factsOf("d1", [pe, skimmer, notOpened, completer, notInterested]);
  const row = dealCompareRow({ id: "d1", businessName: "Deal One" }, f);
  assert.equal(row.granted, 5);
  assert.equal(row.opened, 4, "the buyer who never opened it is not counted");
  assert.equal(row.reachedEnd, 3);
  assert.equal(row.interested, 0);
  assert.ok(row.medianActiveMs! > 0);
  const mix = attentionMix([{ facts: f }]);
  assert.deepEqual(mix.byKind.map((k) => k.group).sort(), ["tables", "text"]);
  const tables = mix.byKind.find((k) => k.group === "tables")!;
  assert.ok(tables.attentionMs > 0 && tables.expectedMs > 0 && tables.blocks > 0);
  assert.ok(mix.byLayout.some((l) => l.layoutType === "financial_table" && l.label.length > 0));
  const sum = readingSummary(pe, pages);
  assert.equal(sum.reachedEnd, true);
  assert.ok(sum.pagesRead >= 8);
});

console.log(`\n${passed} passed`);
process.exit(0);
