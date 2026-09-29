/**
 * Cross-deal learning never carries a deal's words: reading_benchmarks and
 * engagement_insights hold only page role × layout × block kind, the layout
 * engine prints only those generic rows (never a legacy slug such as
 * "kitchener_clinic_team"), figures need enough deals behind them, and the
 * old section_exit path writes nothing. Pure: no database, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/learning-loop-roles.test.ts
 */
import assert from "node:assert/strict";
import { PAGE_ROLES } from "../../shared/analytics-v2";
import { BLOCK_KINDS, blocksOf } from "../../shared/cim-blocks";
import { pageRole } from "../../shared/cim-page-role";
import {
  BENCHMARK_MIN_DEALS, computeBenchmarkRows, roleBenchmarks, type BenchmarkRollupRow, type IndustryBenchmarkRow,
} from "../../server/engagement/benchmarks";
import {
  LEARNING_MIN_DEALS, aggregateEngagementInsights, isGenericSectionType, learningInsightsFrom,
} from "../../server/cim/learning-loop";
import { assembleKnowledgeBase } from "../../server/cim/layout-engine";

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

// A real-looking deal with identifying titles and text in its sections.
const sections = [
  { id: "s-team", sectionKey: "kitchener_clinic_team", sectionTitle: "Kitchener Clinic Team — Dr. Amelia Harbour", layoutType: "org_chart",
    layoutData: { nodes: [{ name: "Dr. Amelia Harbour", role: "Owner" }, { name: "Priya Shah", role: "Hygienist" }] } },
  { id: "s-fin", sectionKey: "harbourline_financials", sectionTitle: "Harbourline Dental Income Statement", layoutType: "financial_table",
    layoutData: { headers: ["", "2024"], rows: [{ label: "Revenue", values: ["$2.1M"] }, { label: "Adjusted EBITDA", values: ["$640K"] }] } },
  { id: "s-cust", sectionKey: "waterloo_patients", sectionTitle: "Waterloo Patient Base", layoutType: "prose_highlight",
    layoutData: { body: "Harbourline serves 4,100 active patients in Kitchener-Waterloo.", highlights: ["Harbourline has 68% recurring hygiene revenue"] } },
];
const RID = "a".repeat(32);
const pageMeta = new Map(sections.map((s) => [s.id, {
  layoutType: s.layoutType,
  role: pageRole({ layoutType: s.layoutType, title: s.sectionTitle, sectionKey: s.sectionKey, layoutData: s.layoutData }),
  blocks: blocksOf(s),
}]));
const rollups: BenchmarkRollupRow[] = [];
for (const [acc, mult] of [["b1", 1], ["b2", 2], ["b3", 0.5]] as const) {
  for (const s of sections) {
    for (const b of blocksOf(s)) {
      if (b.virtual || b.when) continue;
      rollups.push({ renditionId: RID, pageId: s.id, blockKey: b.key, accessId: acc, attentionMs: Math.round(b.expectedMs * mult) });
    }
    rollups.push({ renditionId: RID, pageId: s.id, blockKey: "", accessId: acc, attentionMs: 2_000 });
  }
}
// A page nobody opened and a legacy (unversioned) row: neither counts.
rollups.push({ renditionId: null, pageId: "s-team", blockKey: "", accessId: "legacy", attentionMs: 50_000 });

const rows = computeBenchmarkRows(rollups, (rid, pageId) => (rid === RID ? pageMeta.get(pageId) ?? null : null));

console.log("benchmarks");
await test("rows carry only role × layout × kind — no titles, keys, names or block keys", () => {
  assert.ok(rows.length >= 5, `rows ${rows.length}`);
  const text = JSON.stringify(rows);
  for (const leak of ["Kitchener", "kitchener", "Harbour", "harbourline", "Waterloo", "Amelia", "Priya", "row:", "para:", "node:", "s-team", RID]) {
    assert.ok(!text.includes(leak), `leaked "${leak}"`);
  }
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ["attentionMs", "blockKind", "blocks", "expectedMs", "layoutType", "pageRole", "readers"]);
    assert.ok((PAGE_ROLES as readonly string[]).includes(r.pageRole));
    assert.ok((BLOCK_KINDS as readonly string[]).includes(r.blockKind));
    assert.match(r.layoutType, /^[a-z_]+$/);
  }
});
await test("roles come from the real titles; readers, blocks and study ratio add up", () => {
  const fin = rows.filter((r) => r.pageRole === "financials" && r.layoutType === "financial_table");
  assert.ok(fin.length > 0);
  const table = fin.find((r) => r.blockKind === "table")!;
  assert.equal(table.readers, 3);
  const ratio = table.attentionMs / table.expectedMs;
  assert.ok(Math.abs(ratio - (1 + 2 + 0.5) / 3) < 0.01, `ratio ${ratio}`);
  assert.ok(rows.some((r) => r.pageRole === "employees" && r.layoutType === "org_chart" && r.blockKind === "org"));
  assert.ok(rows.some((r) => r.pageRole === "customers"));
  assert.ok(!rows.some((r) => r.blockKind === "point" || r.blockKind === "column"), "virtual points and containers never double count");
});
await test("idempotent: the same rollups give the same rows", () => {
  assert.deepEqual(computeBenchmarkRows([...rollups].reverse(), (rid, id) => (rid === RID ? pageMeta.get(id) ?? null : null)), rows);
});
await test("an unsafe layout name or unknown role never reaches a row", () => {
  const odd = computeBenchmarkRows(
    [{ renditionId: RID, pageId: "x", blockKey: "heading", accessId: "b", attentionMs: 900 }],
    () => ({ layoutType: "Harbourline Custom Layout", role: "kitchener_clinic_team" as any, blocks: [{ key: "heading", kind: "heading", expectedMs: 500 }] }),
  );
  assert.deepEqual(odd.map((r) => [r.pageRole, r.layoutType]), [["other", "other"]]);
});

console.log("industry figures");
const industryRows = (deals: number): IndustryBenchmarkRow[] =>
  Array.from({ length: deals }, (_, i) => rows.map((r) => ({ dealId: `d${i}`, ...r, attentionMs: r.attentionMs * (1 + i / 10) }))).flat();
await test(`the anonymous benchmark needs ${BENCHMARK_MIN_DEALS} deals behind a figure`, () => {
  assert.deepEqual(roleBenchmarks(industryRows(BENCHMARK_MIN_DEALS - 1)), []);
  const b = roleBenchmarks(industryRows(BENCHMARK_MIN_DEALS));
  assert.ok(b.length > 0);
  assert.ok(b.every((x) => x.deals === BENCHMARK_MIN_DEALS && x.medianStudyRatio > 0));
});
await test(`layout hints need ${LEARNING_MIN_DEALS} deals and are generic role (/kind) rows`, () => {
  assert.deepEqual(learningInsightsFrom(industryRows(LEARNING_MIN_DEALS - 1)), []);
  const ins = learningInsightsFrom(industryRows(LEARNING_MIN_DEALS));
  assert.ok(ins.length > 0);
  for (const i of ins) {
    assert.ok(isGenericSectionType(i.sectionType), i.sectionType);
    assert.ok(i.completionRate >= 0 && i.completionRate <= 100);
    assert.ok(i.deals >= LEARNING_MIN_DEALS);
  }
  assert.ok(ins.some((i) => i.sectionType === "financials" && i.layoutType === "financial_table"));
  assert.ok(ins.some((i) => i.sectionType === "financials/tables"));
  assert.ok(!ins.some((i) => i.sectionType.startsWith("front_matter")));
});
await test("legacy slugs are not generic", () => {
  for (const s of ["kitchener_clinic_team", "revenue_breakdown", "financials/kitchener", "financials/tables/x", ""]) assert.ok(!isGenericSectionType(s), s);
  for (const s of ["financials", "customers/tables", "employees/lists"]) assert.ok(isGenericSectionType(s), s);
});

console.log("layout prompt");
await test("the layout engine prints only generic reading rows, never another deal's slug", () => {
  const kb = assembleKnowledgeBase({
    dealId: "d", businessName: "Maple Clinic", industry: "Healthcare", extractedInfo: { annualRevenue: "$1.2M" },
    engagementInsights: [
      { sectionType: "kitchener_clinic_team", layoutType: "org_chart", avgTimeSpentSeconds: 99, sampleCount: 40 },
      { sectionType: "financials", layoutType: "financial_table", avgTimeSpentSeconds: 95, sampleCount: 48, completionRate: 92 },
      { sectionType: "financials/tables", layoutType: "financial_table", avgTimeSpentSeconds: 70, sampleCount: 48, completionRate: 97 },
    ],
  } as any);
  assert.ok(!kb.text.includes("kitchener"), "legacy slug printed");
  assert.match(kb.text, /WHAT BUYERS READ IN THIS INDUSTRY/);
  assert.match(kb.text, /financials → financial_table: read-through 92%, 95s per reader \(n=48 readers\)/);
  assert.match(kb.text, /financials pages · tables → financial_table: read-through 97%/);
  const none = assembleKnowledgeBase({ dealId: "d", businessName: "Maple Clinic", industry: "Healthcare", extractedInfo: {},
    engagementInsights: [{ sectionType: "kitchener_clinic_team", layoutType: "org_chart", avgTimeSpentSeconds: 99, sampleCount: 40 }] } as any);
  assert.ok(!/WHAT BUYERS READ/.test(none.text), "no block when only legacy rows exist");
});

console.log("legacy path");
await test("old section_exit events write nothing (they only schedule the reading refresh)", async () => {
  const calls: unknown[] = [];
  const fake = { upsertEngagementInsight: async (...a: unknown[]) => { calls.push(a); }, getDeal: async () => ({ industry: "Healthcare" }), getCimSectionsByDeal: async () => sections } as any;
  await aggregateEngagementInsights("deal-x", [{ eventType: "section_exit", sectionKey: "kitchener_clinic_team", timeSpentSeconds: 40 }], fake);
  assert.equal(calls.length, 0);
});

console.log(`\n${passed} passed`);
process.exit(0);
