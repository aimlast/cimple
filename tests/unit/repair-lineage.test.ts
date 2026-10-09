/**
 * Repairing stored section lineage (server/engagement/lineage-repair.ts,
 * scripts/repair-section-lineage.ts; heat-map spec §7.1). Pure planning on
 * the Pacific demo CIM's real keys/titles/stored links (synthetic ids), and
 * the apply through an in-memory transaction seam. No DB, no AI.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled node_modules/.bin/tsx tests/unit/repair-lineage.test.ts
 */
import assert from "node:assert/strict";
import {
  applyLineageRepair, chooseEarlierVersion, patchPageIndex, planLineageRepair, repairChanges,
  type RepairKeptCopy, type RepairRendition, type RepairTx,
} from "../../server/engagement/lineage-repair";
import type { RenditionPage } from "../../shared/analytics-v2";
import { PACIFIC_NEW, PACIFIC_OLD } from "../fixtures/engagement/pacific-lineage";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed++; console.log(`  ✓ ${name}`); } catch (e) { console.error(`  ✗ ${name}`); throw e; }
}

const taken = new Date("2026-09-29T14:02:17.772Z");
const created = new Date("2026-09-29T14:02:19.610Z");
const current = PACIFIC_NEW.map((n) => ({ id: n.id, sectionKey: n.sectionKey, sectionTitle: n.sectionTitle, layoutType: n.layoutType, analyticsLineage: n.stored, createdAt: created }));
const kept: RepairKeptCopy = { takenAt: taken, sections: PACIFIC_OLD.map((o) => ({ ...o, analyticsLineage: null })) };
const titleOf = new Map(PACIFIC_OLD.map((o) => [o.id, o.sectionTitle]));

const page = (pageId: string, lineageId: string, order: number, over: Partial<RenditionPage> = {}): RenditionPage => ({
  pageId, lineageId, order, parts: 1, servedTitle: pageId, layoutType: "callout_list", locked: false, expectedMs: 1000, blockFingerprint: "f", blocks: [], ...over,
});

console.log("lineage repair");
await test("a kept copy taken in the same generation → a FULL check, exactly the 6 Pacific changes", () => {
  const e = chooseEarlierVersion({ current, kept, renditions: [], cimLayoutVersion: 2 });
  assert.ok(!("cantCheck" in e));
  if ("cantCheck" in e) return;
  assert.equal(e.check, "full");
  assert.match(e.label, /^the kept copy \(27 pages, 29 Sept?\)$/);
  const rows = planLineageRepair(current, e);
  const changed = rows.filter((r) => r.outcome !== "unchanged").map((r) => [r.title, r.stored ? titleOf.get(r.stored) : null, r.proposed ? titleOf.get(r.proposed) : null, r.outcome]);
  assert.deepEqual(changed, [
    ["Working Capital Summary", "Capital Expenditures & Fleet Replacement", null, "change"],
    ["Customer Base & Concentration", null, "Customer Diversification", "addition"],
    ["Facility Location", null, "Locations", "addition"],
    ["Team & Organizational Structure", null, "Organization & Key Personnel", "addition"],
    ["Capital Investment & Fleet Renewal", null, "Capital Expenditures & Fleet Replacement", "addition"],
    ["Legal, Regulatory & Compliance", null, "Regulatory & Operating Authorities", "addition"],
  ]);
  assert.equal(rows.filter((r) => r.outcome === "unchanged").length, 24);
  const wc = rows.find((r) => r.title === "Working Capital Summary")!;
  assert.match(wc.why, /no shared meaning: only “capital”/);
  assert.match(rows.find((r) => r.title === "Customer Base & Concentration")!.why, /^similar words 0\.62$/);
  assert.match(rows.find((r) => r.title === "Facility Location")!.why, /^similar words 0\.50, same role$/);
});

await test("a kept copy taken long before the sections → PARTIAL: no additions applied, listed as possible links", () => {
  const e = chooseEarlierVersion({ current, kept: { ...kept, takenAt: new Date("2026-09-20T00:00:00Z") }, renditions: [], cimLayoutVersion: 2 });
  if ("cantCheck" in e) throw new Error("expected a version");
  assert.equal(e.check, "partial");
  const rows = planLineageRepair(current, e);
  assert.equal(rows.filter((r) => r.outcome === "addition").length, 0);
  assert.equal(rows.filter((r) => r.outcome === "possible").length, 5);
  assert.deepEqual(repairChanges(rows).map((c) => c.id), ["n08"], "only the checked wrong link is changed");
});

await test("a stored link to a page that isn't in the earlier version is left alone", () => {
  const cur = current.map((s) => (s.id === "n02" ? { ...s, analyticsLineage: "o-gone" } : s));
  const e = chooseEarlierVersion({ current: cur, kept, renditions: [], cimLayoutVersion: 2 });
  if ("cantCheck" in e) throw new Error("expected a version");
  const row = planLineageRepair(cur, e).find((r) => r.id === "n02")!;
  assert.equal(row.outcome, "cant_check");
  assert.ok(!repairChanges(planLineageRepair(cur, e)).some((c) => c.id === "n02"));
});

await test("without a kept copy: a stored version exactly one CIM version back (named preferred), else can't check", () => {
  const named: RepairRendition = {
    id: "r-named", mode: "normal", cimLayoutVersion: 1, createdAt: new Date("2026-09-07T00:00:00Z"),
    pageIndex: PACIFIC_OLD.map((o, i) => page(o.id, o.id, i, { servedTitle: o.sectionTitle, layoutType: o.layoutType })),
    keys: Object.fromEntries(PACIFIC_OLD.map((o) => [o.id, o.sectionKey])),
  };
  const older = { ...named, id: "r-old", cimLayoutVersion: 0 };
  const e = chooseEarlierVersion({ current, kept: null, renditions: [older, named], cimLayoutVersion: 2 });
  if ("cantCheck" in e) throw new Error("expected a version");
  assert.equal(e.check, "partial");
  assert.match(e.label, /stored named version/);
  assert.equal(e.sections.length, 27);
  const none = chooseEarlierVersion({ current, kept: null, renditions: [older], cimLayoutVersion: 2 });
  assert.deepEqual(none, { cantCheck: "the earlier version isn't on file" });
  // A blind version only: neutral keys and titles (only the fixed-layout pass can use it).
  const blind = { ...named, id: "r-blind", mode: "blind", keys: {} };
  const b = chooseEarlierVersion({ current, kept: null, renditions: [blind], cimLayoutVersion: 2 });
  if ("cantCheck" in b) throw new Error("expected a version");
  assert.ok(b.sections.every((s) => s.sectionKey === "" && s.sectionTitle === ""));
});

await test("patches only the rows the guarded UPDATE changed; a concurrent change leaves its versions and rollups alone", async () => {
  const lineage = new Map(current.map((s) => [s.id, s.analyticsLineage as string | null]));
  // n24 was changed by someone else meanwhile.
  lineage.set("n24", "someone-else");
  const renditions = [{ id: "r1", pageIndex: [page("n08", "o18", 0), page("n24", "n24", 1), page("n09", "n09", 2)] }];
  const rollups = [
    { pageId: "n08", renditionId: "r1", lineageId: "o18" },
    { pageId: "n08", renditionId: null as string | null, lineageId: "o18" },   // old tracker: keeps its lineage
    { pageId: "n24", renditionId: "r1", lineageId: "n24" },
    { pageId: "n09", renditionId: "r1", lineageId: "n09" },
  ];
  const tx: RepairTx = {
    async updateSectionLineage(_d, id, from, to) {
      if ((lineage.get(id) ?? null) !== from) return false;
      lineage.set(id, to);
      return true;
    },
    async renditionsWithPages(_d, ids) { return renditions.filter((r) => r.pageIndex.some((p) => ids.includes(p.pageId))); },
    async setRenditionPageIndex(_d, id, pi) { renditions.find((r) => r.id === id)!.pageIndex = pi; },
    async setRollupLineage(_d, pageId, lin) {
      let n = 0;
      for (const r of rollups) if (r.pageId === pageId && r.renditionId !== null) { r.lineageId = lin; n++; }
      return n;
    },
  };
  const e = chooseEarlierVersion({ current, kept, renditions: [], cimLayoutVersion: 2 });
  if ("cantCheck" in e) throw new Error("expected a version");
  const res = await applyLineageRepair(tx, "deal", repairChanges(planLineageRepair(current, e)));
  assert.deepEqual(res.changedMeanwhile, ["n24"]);
  assert.equal(res.updated.length, 5);
  assert.equal(lineage.get("n08"), null);
  assert.equal(lineage.get("n09"), "o09");
  assert.deepEqual(renditions[0].pageIndex.map((p) => p.lineageId), ["n08", "n24", "o09"], "n24 (changed meanwhile) untouched");
  assert.deepEqual(rollups.map((r) => r.lineageId), ["n08", "o18", "n24", "o09"]);
  assert.equal(res.renditionsPatched, 1);
  assert.equal(res.rollupsPatched, 2);
});

await test("idempotent: after the repair, a re-plan reports 0 changes", () => {
  const e = chooseEarlierVersion({ current, kept, renditions: [], cimLayoutVersion: 2 });
  if ("cantCheck" in e) throw new Error("expected a version");
  const changes = repairChanges(planLineageRepair(current, e));
  const after = current.map((s) => { const c = changes.find((x) => x.id === s.id); return c ? { ...s, analyticsLineage: c.to } : s; });
  const again = planLineageRepair(after, e);
  assert.equal(repairChanges(again).length, 0);
  assert.equal(again.filter((r) => r.outcome === "unchanged").length, 30);
});

await test("patchPageIndex returns null when nothing changes", () => {
  assert.equal(patchPageIndex([page("a", "a", 0)], new Map([["a", "a"]])), null);
  assert.deepEqual(patchPageIndex([page("a", "a", 0)], new Map([["a", "o1"]]))!.map((p) => p.lineageId), ["o1"]);
});

console.log(`\n${passed} passed`);
