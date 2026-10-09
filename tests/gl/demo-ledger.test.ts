/**
 * The demo set-up's ledger (scripts/seed-demo-gl.ts → server/gl/demo-ledger.ts;
 * founder question F2/Q15 — the script is never run by the builder): on the
 * fictional Brightwater deal (memory store, no AI) the sample ledger
 *   - ties to the statements every year (revenue and net income),
 *   - is read like any upload (detected, parsed, every entry),
 *   - makes each add-back "Adds up" from the rules' own proposals, and the
 *     T4s show owner and spouse pay (the amount seen on the document),
 *   - names no real vendor and says it's a sample.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { buildDemoLedger, SAMPLE_LINE, splitCents, type DemoTraceInput } from "../../server/gl/demo-ledger";
import { planTraces } from "../../server/gl/traces";
import { statementsByYear } from "../../server/gl/tie-out";
import { refreshGl } from "../../server/gl/service";
import { detectLayout } from "../../server/gl/detect";
import { peekRows } from "../../server/gl/read-file";
import { onGlSupportDocumentRead } from "../../server/gl/support-docs";
import { recomputeTraces } from "../../server/gl/match-run";
import { tieOutFor } from "../../server/gl/tie-out";
import { claimedYears } from "../../shared/gl-reconcile";

const B = brightwater();
const dealId = B.deal.id;
const statements = await statementsByYear(dealId);
const years = Object.keys(statements).sort();
const plan = planTraces(B.analysis.normalization, [], { info: { ownerName: "Dan Brightwater" }, country: "CA", analysisId: "fa-1" });
const traces: DemoTraceInput[] = plan.inserts.map((t) => ({
  addbackKey: t.addbackKey, label: t.label, category: t.category ?? null, proof: t.proof ?? "ledger", sharePct: t.sharePct ?? null,
  claims: (t.claims as Record<string, number>) ?? {}, person: /Emma/.test(t.label) ? "Emma Brightwater" : t.category === "owner_comp" ? "Dan Brightwater" : null,
}));
const ledger = buildDemoLedger({
  dealId, business: B.deal.businessName, fye: "12-31",
  years: years.map((y) => ({ year: y, revenueCents: statements[y].revenueCents!, netIncomeCents: statements[y].netIncomeCents! })),
  traces,
});

await test("splitting keeps the total exactly", () => {
  const r = () => 0.42;
  for (const [t, n] of [[1_234_567, 12], [100, 7], [0, 5], [5_000_000, 1]] as const) assert.equal(splitCents(t, n, r).reduce((a, b) => a + b, 0), t);
});

await test("ties to the statements every year; no problems", () => {
  assert.deepEqual(ledger.problems, []);
  for (const y of years) {
    assert.equal(ledger.check[y].revenueCents, statements[y].revenueCents, `${y} revenue`);
    assert.equal(ledger.check[y].netIncomeCents, statements[y].netIncomeCents, `${y} net income`);
  }
});

await test("plants each add-back's whole cost; pay goes through payroll runs with a T4 each", () => {
  const meals = ledger.planted.filter((p) => /meals/.test(p.addbackKey));
  assert.equal(meals.find((p) => p.year === "2024")!.cents, 2_200_000, "the whole meals cost (50% added back)");
  assert.ok(ledger.t4s.some((t) => t.person === "Dan Brightwater" && t.year === "2024" && t.cents === 24_000_000));
  assert.ok(ledger.t4s.some((t) => t.person === "Emma Brightwater" && t.cents === 8_500_000));
  assert.ok(ledger.rows.filter((r) => r.account === "Wages & Salaries").every((r) => r.name === "Payroll — Wagepoint"), "no names on payroll runs");
  assert.ok(ledger.csv.includes(SAMPLE_LINE) && ledger.t4s.every((t) => t.text.includes(SAMPLE_LINE)));
  for (const real of ["Lexus", "Petro", "Sun Life", "Glen Abbey"]) assert.ok(!ledger.csv.includes(real), real);
});

await test("read like an upload; the tie-out agrees; every add-back adds up from the rules' proposals and the T4s", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gl-demo-"));
  const file = path.join(dir, "demo.csv");
  fs.writeFileSync(file, ledger.csv);
  const det = detectLayout(await peekRows(file, "csv"));
  assert.ok(det && det.confidence >= 0.6, "the detector reads it");
  // Read it through the normal path (a document pointing at the generated file).
  const d2 = B.w.addDocument({ dealId, fileUrl: B.w.addFile(file, "demo.csv"), name: "General Ledger (sample).csv", subcategory: "general_ledger", uploadedBy: "seller" } as any);
  const { ingestDocument } = await import("../../server/documents/ingest");
  const { glQueueIdle } = await import("../../server/gl/ingest");
  await ingestDocument(d2.id);
  await glQueueIdle();
  const l = (await B.w.gl.getLedgerByDocument(d2.id))!;
  assert.equal(l.status, "ready");
  assert.equal(l.rowCount, ledger.rows.length);
  await refreshGl(dealId, { force: true });
  const tie = (await tieOutFor(dealId)) as Record<string, any>;
  for (const y of years) assert.equal(tie[y].state, "agrees", `${y}: ${JSON.stringify(tie[y])}`);
  // T4s and ticks as the script does it.
  const store = B.w.gl;
  const live = (await store.listTraces(dealId)).filter((t) => !t.removedAt);
  for (const t4 of ledger.t4s) {
    const trace = live.find((t) => t.addbackKey === t4.addbackKey)!;
    const sup = B.w.addDocument({ dealId, fileUrl: "/uploads/docs/none.txt", name: "T4", subcategory: "addback_support", status: "extracted", extractedText: t4.text } as any);
    await store.upsertDocLink({ traceId: trace.id, dealId, fiscalYear: t4.year, documentId: sup.id, amountCents: t4.cents, docAmountCheck: null, state: "confirmed", proposedBy: "seller_document", decidedBy: "seller" } as any);
    await onGlSupportDocumentRead(sup.id);
  }
  for (const t of live.filter((x) => x.proof !== "statement" && x.proof !== "payroll")) {
    const ys = claimedYears({ claims: (t.claims as Record<string, number>) ?? {} });
    const props = (await store.linksOfTrace(t.id)).filter((k) => k.state === "proposed" && ys.includes(k.fiscalYear));
    await store.decideEntryLinks(props.map((k) => ({ ...k, state: "confirmed", decidedBy: "seller" } as any)));
  }
  await recomputeTraces(dealId);
  for (const t of (await store.listTraces(dealId)).filter((x) => !x.removedAt && x.proof !== "statement")) {
    const c = t.computed as any;
    assert.ok(["found", "document"].includes(c.overall), `${t.label}: ${c.overall} ${JSON.stringify(Object.fromEntries(Object.entries(c.byYear).map(([y, v]: any) => [y, `${v.status} ${v.foundCents}/${v.targetCents}`])))}`);
  }
});

cleanup(B.w);
done("demo ledger");
