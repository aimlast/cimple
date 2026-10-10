/**
 * scripts/seed-demo-data-room.ts (vdr spec §12) — its two locks and its
 * reading plan, pure. The script itself is never run by the vdr stream
 * (founder question Q15). No database, no AI.
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/vdr-demo-seed.test.ts
 */
import assert from "node:assert/strict";

const { refuseReason, demoReadingPlan, allDemoSelection } = await import("../../scripts/seed-demo-data-room");

assert.match(refuseReason({ id: "a", businessName: "Amlin Plumbing", demoKey: null } as any)!, /not a demo deal/);
assert.match(refuseReason({ id: "b", businessName: "SariKnotSari", demoKey: "sneaky" } as any)!, /real business/, "a real name is refused even with a demo_key");
assert.match(refuseReason({ id: "c", businessName: "180 Smoke Vape", demoKey: "x" } as any)!, /real business/);
assert.equal(refuseReason({ id: "d", businessName: "Beacon Specialty Pharmacy Inc.", demoKey: "beacon-pharmacy" } as any), null);
assert.match(refuseReason(null)!, /no such deal/);

const items = [
  { id: "i1", documentId: "d1", title: "Lease", pages: 4, financial: false },
  { id: "i2", documentId: "d2", title: "T2 2023", pages: 6, financial: true },
  { id: "i3", documentId: "d3", title: "Financial statements FY2023", pages: 8, financial: true },
];
assert.deepEqual(demoReadingPlan(0, items, "x"), [], "no CIM reading → no room reading");
const plan = demoReadingPlan(30 * 60_000, items, "buyer-1");
assert.ok(plan.length >= 1 && plan.length <= 3);
assert.ok(plan[0].itemId === "i3" || plan[0].itemId === "i2", "financial documents first");
const total = plan.reduce((s, x) => s + x.activeMs, 0);
assert.ok(total <= 45 * 60_000 + plan.length * 20_000, "capped");
for (const x of plan) {
  assert.ok(x.maxPage >= 1);
  assert.ok(Object.values(x.pageMs).reduce((s, v) => s + v, 0) <= x.activeMs + Object.keys(x.pageMs).length);
}
assert.deepEqual(demoReadingPlan(30 * 60_000, items, "buyer-1"), plan, "deterministic");

// Checker r2 (R2-2): --all-demo is broker_demo's demo deals only — never qa_cimgen's QA copies (shared by other work).
const rows = [
  { id: "p", businessName: "Pacific Coast Logistics Ltd.", demoKey: "pacific-coast-logistics", brokerId: "demo" },
  { id: "b", businessName: "Beacon Specialty Pharmacy Inc.", demoKey: "beacon-pharmacy", brokerId: "demo" },
  { id: "q1", businessName: "QA OCT — Pacific Coast Logistics Ltd.", demoKey: "pacific-coast-logistics-qa-oct", brokerId: "qa" },
  { id: "q2", businessName: "QA OCT — vdr r2 Beacon", demoKey: "copy-aecd0e18-qa-oct", brokerId: "qa" },
  { id: "q3", businessName: "QA CIMGEN — Harbourline Dental", demoKey: "qa-harbourline", brokerId: "demo" },
  { id: "q4", businessName: "Some copy", demoKey: "beacon-pharmacy-qa-oct", brokerId: "demo" },
  { id: "r", businessName: "Amlin Plumbing", demoKey: null, brokerId: "demo" },
];
const sel = allDemoSelection(rows as any, "demo");
assert.deepEqual(sel.targets.map((d: any) => d.id), ["p", "b"]);
assert.deepEqual(sel.skipped.map((s: any) => `${s.deal.id}:${s.why}`), ["q1:not a broker_demo deal", "q2:not a broker_demo deal", "q3:a QA copy", "q4:a QA copy"], "every skipped demo deal is listed with why");
assert.throws(() => allDemoSelection(rows as any, null), /broker_demo account wasn't found/);
console.log("vdr-demo-seed: 2 passed");
