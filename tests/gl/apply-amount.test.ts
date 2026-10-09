/**
 * gl spec §12.1 test 25: "Use what the ledger shows" — the dry run's figures
 * (the add-back old → new at the share, adjusted EBITDA and SDE before →
 * after, the CIM pages showing a figure that changes, live buyers keep the
 * copy); saving goes through the analysis PATCH's own code
 * (saveBrokerAnalysisEdit → applyBrokerAnalysisEdit), never for owner pay.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { refreshGl } from "../../server/gl/service";
import { loadGlContext } from "../../server/gl/context";
import { writeLinks } from "../../server/gl/links";
import { ledgerAmountImpact, saveBrokerAnalysisEdit, LedgerAmountError } from "../../server/gl/analysis-edit";
import { storage } from "../../server/storage";

const B = brightwater({ isLive: true } as any);
await B.readLedger("qbo-classic.csv");
await refreshGl(B.deal.id, { force: true });
const s = storage as any;
s.getCimSectionsByDeal = async () => [
  { id: "s1", sectionTitle: "Earnings Bridge", isVisible: true, layoutData: { rows: [{ label: "Meals & entertainment", values: { "2024": 11000 } }] } },
  { id: "s2", sectionTitle: "Company Overview", isVisible: true, layoutData: { text: "Founded in 1998 with 36 staff." } },
  { id: "s3", sectionTitle: "Hidden", isVisible: false, layoutData: { v: 11000 } },
];
let saved: any = null;
s.updateFinancialAnalysis = async (id: string, updates: any) => { saved = { id, updates }; return { id, ...updates }; };

const traces = new Map((await B.w.gl.listTraces(B.deal.id)).map((t) => [t.label, t]));
const meals = traces.get("Meals & entertainment (50% personal use estimate)")!;
const c = await loadGlContext(B.deal.id);
const proposals = B.w.gl.data.links.filter((k) => k.traceId === meals.id && k.fiscalYear === "2024" && k.state === "proposed");
const half = proposals.slice(0, Math.floor(proposals.length / 2));
await writeLinks(meals, { add: half.map((k) => ({ ledgerId: k.ledgerId!, rowNo: k.rowNo! })) }, { by: "broker", memberId: null }, c);
const ticked = half.reduce((x, k) => x + Number(k.amountCents), 0);
const fresh = (await B.w.gl.getTrace(meals.id))!;

await test("dry run: the add-back at its share of what's ticked, EBITDA and SDE move, the pages that show it", async () => {
  const r = await ledgerAmountImpact(B.deal.id, fresh, "2024");
  assert.equal(r.impact.addback.from, 11000);
  assert.equal(r.impact.addback.to, Math.round(ticked / 100 / 2), "half of the meals entries ticked");
  assert.ok(r.impact.adjustedEbitda.from !== null && r.impact.adjustedEbitda.to !== null);
  assert.equal(Math.round(r.impact.adjustedEbitda.from! - r.impact.adjustedEbitda.to!), 11000 - r.impact.addback.to);
  assert.equal(Math.round(r.impact.sde.from! - r.impact.sde.to!), 11000 - r.impact.addback.to);
  assert.deepEqual(r.impact.sections.map((x) => x.title), ["Earnings Bridge"], "only visible pages that show a changing figure");
  assert.equal(r.impact.liveBuyersKeepCopy, true);
  assert.equal(saved, null, "a dry run writes nothing");
});

await test("saving goes through the analysis PATCH's code: the new amount, earnings recomputed and dated", async () => {
  const r = await ledgerAmountImpact(B.deal.id, fresh, "2024");
  await saveBrokerAnalysisEdit(r.analysis, { normalization: r.normalization });
  assert.equal(saved.id, "fa-1");
  const ab = saved.updates.normalization.addbacks.find((x: any) => x.label.startsWith("Meals"));
  assert.equal(ab.amounts["2024"], r.impact.addback.to);
  assert.equal(saved.updates.normalization.computed.adjustedEbitda["2024"], Math.round(r.impact.adjustedEbitda.to!));
  assert.ok(saved.updates.normalization.earningsChangedAt, "the change is dated (CIM staleness reads it)");
});

await test("never for owner pay; nothing ticked → refused", async () => {
  const owner = traces.get("Owner compensation (President - Dan Brightwater)")!;
  await assert.rejects(ledgerAmountImpact(B.deal.id, owner, "2024"), (e: unknown) => e instanceof LedgerAmountError && /Normalization tab/.test((e as Error).message));
  const golf = traces.get("Golf club dues")!;
  await assert.rejects(ledgerAmountImpact(B.deal.id, golf, "2024"), (e: unknown) => e instanceof LedgerAmountError && /Nothing is ticked/.test((e as Error).message));
});

cleanup(B.w);
done("apply ledger amount");
