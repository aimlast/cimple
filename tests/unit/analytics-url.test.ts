/**
 * The analytics dashboards' URL state (client/src/components/analytics/url.ts):
 * the Analytics page's params (defaults, fallbacks, the number chip) and the
 * Engagement tab's engagementSearch (buyer only on Buyers, page only on the
 * heat map, a view's own params kept while the view stays, unregistered
 * extra views refused). Pure; no browser, no DB, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/analytics-url.test.ts
 */
import assert from "node:assert/strict";
import { DEFAULT_ENGAGEMENT_FILTERS } from "../../shared/analytics-v2";
import {
  analyticsSearch,
  ANALYTICS_URL_DEFAULTS,
  engagementSearch,
  parseAnalyticsSearch,
  parseKpiChip,
  resolveAnalyticsTab,
  resolveEngagementView,
  switchTab,
} from "../../client/src/components/analytics/url";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}
const q = (s: string) => new URLSearchParams(s.replace(/^\?/, ""));

console.log("Analytics page URL");

test("defaults: no tab, automatic range, default examples, all statuses", () => {
  const s = parseAnalyticsSearch("");
  assert.deepEqual(s, ANALYTICS_URL_DEFAULTS);
  assert.equal(s.range, null, "absent range = automatic");
  assert.equal(s.examples, null, "absent examples = the default rule");
});

test("the default tab follows the counts: Who to call when anyone is worth a call, else Deals", () => {
  assert.equal(resolveAnalyticsTab(null, 9), "call");
  assert.equal(resolveAnalyticsTab(null, 0), "deals");
  assert.equal(resolveAnalyticsTab(null, null), "deals");
  assert.equal(resolveAnalyticsTab("activity", 9), "activity", "an explicit tab wins");
});

test("unknown values fall back to the defaults", () => {
  const s = parseAnalyticsSearch("?tab=heatmap&range=90d&examples=maybe&status=nope&sort=price&kind=bogus&kpi=money:30d&buyer=a%20b&deal=x;drop");
  assert.equal(s.tab, null);
  assert.equal(s.range, null);
  assert.equal(s.examples, null);
  assert.equal(s.status, "all");
  assert.equal(s.sort, "last_active");
  assert.equal(s.kind, "all");
  assert.equal(s.kpi, null);
  assert.equal(s.buyer, null, "ids are checked");
  assert.equal(s.deal, null);
});

test("waiting is not a buyer number, so it can't be a Buyers-tab chip", () => {
  assert.equal(parseKpiChip("waiting:30d"), null);
  assert.equal(parseKpiChip("reading:forever"), null);
  assert.deepEqual(parseKpiChip("nda:7d"), { id: "nda", range: "7d" });
});

test("analyticsSearch omits defaults", () => {
  assert.equal(analyticsSearch({}), "");
  assert.equal(analyticsSearch({ tab: "buyers", status: "all", sort: "last_active", kind: "all", q: "" }), "?tab=buyers");
  assert.equal(analyticsSearch({ range: "7d", examples: "exclude" }), "?range=7d&examples=exclude");
});

test("the number chip round-trips", () => {
  for (const id of ["opened", "reading", "nda", "interested", "to_call"] as const) {
    for (const range of ["7d", "30d", "all"] as const) {
      const s = parseAnalyticsSearch(analyticsSearch({ tab: "buyers", kpi: { id, range } }));
      assert.deepEqual(s.kpi, { id, range });
      assert.equal(s.tab, "buyers");
    }
  }
  assert.equal(analyticsSearch({ tab: "buyers", kpi: { id: "reading", range: "30d" } }), "?tab=buyers&kpi=reading%3A30d");
});

test("every param round-trips", () => {
  const state = { ...ANALYTICS_URL_DEFAULTS, tab: "buyers" as const, range: "30d" as const, examples: "include" as const, buyer: "acc_1", deal: "deal-1", status: "expiring" as const, q: "kinbrook", sort: "fit" as const, kpi: { id: "interested" as const, range: "7d" as const }, kind: "nda" as const };
  assert.deepEqual(parseAnalyticsSearch(analyticsSearch(state)), state);
});

test("a tab switch keeps the period and the example-deals choice, and drops the old tab's filters", () => {
  const s = parseAnalyticsSearch("?tab=buyers&range=7d&examples=include&status=interested&q=bob&kpi=reading:7d&deal=d1");
  const next = switchTab(s, "activity");
  assert.equal(next.tab, "activity");
  assert.equal(next.range, "7d");
  assert.equal(next.examples, "include");
  assert.equal(next.status, "all");
  assert.equal(next.q, "");
  assert.equal(next.kpi, null);
  assert.equal(next.deal, "d1", "the Deal filter is shared by Buyers and Activity");
  assert.equal(switchTab(next, "call").deal, null);
  assert.equal(switchTab(parseAnalyticsSearch("?tab=call&buyer=a1"), "deals").buyer, null);
});

console.log("Engagement tab URL");

test("buyer is kept only on the Buyers view", () => {
  assert.equal(q(engagementSearch("?buyer=a1", {})).get("buyer"), "a1");
  assert.equal(q(engagementSearch("?buyer=a1", { view: "document" })).get("buyer"), null);
  assert.equal(q(engagementSearch("", { view: "buyers", buyer: "a2" })).get("buyer"), "a2");
  assert.equal(q(engagementSearch("?view=activity", { buyer: "a2" })).get("buyer"), null);
  assert.equal(engagementSearch("?buyer=a1", { buyer: null }), "");
});

test("page is kept only on the heat map", () => {
  assert.equal(q(engagementSearch("?view=document&page=p1%230", {})).get("page"), "p1#0");
  assert.equal(q(engagementSearch("?view=document&page=p1%230", { view: "buyers" })).get("page"), null);
  assert.equal(q(engagementSearch("?view=document&page=p1%230", { page: null })).get("page"), null);
});

test("a view's own params (the heat map's compare=) survive a filter change and go on a view switch", () => {
  const cur = "?view=document&compare=a1%2Ca2&page=p3%231";
  const sameView = q(engagementSearch(cur, { filters: { ...DEFAULT_ENGAGEMENT_FILTERS, range: "7d" } }));
  assert.equal(sameView.get("compare"), "a1,a2");
  assert.equal(sameView.get("range"), "7d");
  assert.equal(sameView.get("page"), "p3#1");
  const switched = q(engagementSearch(cur, { view: "buyers" }));
  assert.equal(switched.get("compare"), null);
  assert.equal(switched.get("view"), null, "buyers is the default view");
});

test("filters are rebuilt from state, the journey stays until closed", () => {
  const cur = "?range=30d&device=phone&journey=a9&segment=interested";
  const s = q(engagementSearch(cur, { view: "activity" }));
  assert.equal(s.get("range"), "30d");
  assert.equal(s.get("device"), "phone");
  assert.equal(s.get("segment"), "interested");
  assert.equal(s.get("journey"), "a9");
  assert.equal(q(engagementSearch(cur, { journey: null })).get("journey"), null);
  assert.equal(q(engagementSearch(cur, { filters: DEFAULT_ENGAGEMENT_FILTERS })).get("range"), null);
});

test("an unregistered extra view is refused; a registered one is kept", () => {
  assert.equal(resolveEngagementView("teaser", []), "buyers");
  assert.equal(resolveEngagementView("teaser", ["teaser"]), "teaser");
  assert.equal(resolveEngagementView("document"), "document");
  assert.equal(resolveEngagementView("activity"), "activity");
  assert.equal(resolveEngagementView("<script>"), "buyers");
  assert.equal(q(engagementSearch("", { view: "teaser" }, [])).get("view"), null);
  assert.equal(q(engagementSearch("", { view: "teaser" }, ["teaser"])).get("view"), "teaser");
  assert.equal(q(engagementSearch("?view=data-room&x=1", {}, ["data-room"])).get("x"), "1", "a registered view's own params stay");
});

console.log(`\n${passed} passed`);
