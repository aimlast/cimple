/**
 * gl spec §12.1 tests 18, 24, 32 and the Q21 switch: the seller's view is a
 * whitelist (no analysis label, no treatment, nothing private, nothing
 * before the request or after it was withdrawn); the generation gate's
 * states (the DD CIM held until reviewed / left out / waived; the whole CIM
 * only with the hold switch; startCimGeneration refuses with
 * gl_trace_required); the checklist rows and next steps; the interview's
 * mention adds no MANDATORY line; the notification switch falls back.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { refreshGl } from "../../server/gl/service";
import { loadGlContext, sellerReconcileCtx } from "../../server/gl/context";
import { sellerBooksView, sellerGlState, SELLER_COST_KEYS, shareWords } from "../../server/gl/seller-view";
import { gateFrom, assertGlGate, isGlTraceRequiredError, DD_GATE_MESSAGE } from "../../server/gl/gate";
import { glExtrasFrom } from "../../server/gl/progress";
import { phaseChecklist, computeNextStep, glNextStep } from "../../shared/deal-progress";
import { GL_INTERVIEW_BLOCK } from "../../server/gl/progress";
import { glBrokerEvent, glSellerEvent, GL_NOTIFICATION_ROUTING, requestEmailCopy, brokerNoticeCopy, _setGlNotificationRoutingForTests } from "../../server/gl/notify";
import { NOTIFICATION_ROUTING, type GlAddbackTrace } from "../../shared/schema";

const B = brightwater();
await B.readLedger("qbo-classic.csv");
await refreshGl(B.deal.id, { force: true });

async function view() {
  const c = await loadGlContext(B.deal.id);
  return sellerBooksView({
    tracing: c.tracing, traces: await B.w.gl.listTraces(B.deal.id), links: await B.w.gl.linksOfDeal(B.deal.id), ctx: sellerReconcileCtx(c),
    sellerLedgerYears: c.yearsSeller, sellerLedgerIds: c.sellerLedgerIds, country: "CA",
  });
}

await test("before the broker's request: the seller sees no costs at all", async () => {
  const v = await view();
  assert.equal(v.state, "not_requested");
  assert.equal(v.costs.length, 0);
  assert.equal(v.message, null);
});

const traces = await B.w.gl.listTraces(B.deal.id);
const byLabel = new Map(traces.map((t) => [t.label, t]));
const sent = ["Owner vehicle expenses", "Meals & entertainment (50% personal use estimate)", "Owner compensation (President - Dan Brightwater)", "Employment settlement (one-time)"];
for (const l of sent) await B.w.gl.updateTrace(byLabel.get(l)!.id, { sentAt: new Date() } as Partial<GlAddbackTrace>);
await B.w.gl.updateTracing(B.deal.id, { requestedAt: new Date(), sellerMessage: "Thanks Dan" } as any);

await test("after the request: only the sent costs, as a whitelist — no label, treatment, market salary or private notes", async () => {
  const v = await view();
  assert.equal(v.state, "requested");
  assert.equal(v.total, 4);
  for (const c of v.costs) assert.deepEqual(Object.keys(c).sort(), [...SELLER_COST_KEYS].sort());
  const json = JSON.stringify(v.costs);
  assert.ok(!/market salary|sde|ebitda|add-?back|excess|personal use estimate|Owner compensation \(President/i.test(json), json.slice(0, 300));
  assert.ok(!json.includes("Excess insurance"), "an unsent cost (private evidence) never appears");
  const meals = v.costs.find((c) => c.sellerLabel === "Meals & entertainment")!;
  assert.equal(meals.shareWords, "Your broker counts half of it as personal.");
  assert.equal(meals.years.find((y) => y.year === "2024")!.targetCents, 2_200_000);
  const vehicle = v.costs.find((c) => c.sellerLabel === "Owner vehicle expenses")!;
  assert.deepEqual(vehicle.summary?.years, ["2022", "2023", "2024"], "We found these in your books…");
  assert.equal(v.costs.find((c) => c.sellerLabel === "Your pay as owner")!.proof, "payroll");
  assert.equal(v.payDoc.short, "T4");
  assert.equal(shareWords(40), "Your broker counts 40% of it as personal.");
});

await test("a ledger private to the broker is never counted in the seller's view", async () => {
  const c = await loadGlContext(B.deal.id);
  const v = sellerBooksView({
    tracing: c.tracing, traces: await B.w.gl.listTraces(B.deal.id), links: await B.w.gl.linksOfDeal(B.deal.id),
    ctx: { ...sellerReconcileCtx(c), countedLedgerIds: new Set(), ledgerYears: new Set(), hasLedger: false },
    sellerLedgerYears: new Set(), sellerLedgerIds: new Set(), country: "CA",
  });
  assert.ok(v.costs.every((x) => x.summary === null));
});

await test("withdrawn: nothing about the costs", async () => {
  await B.w.gl.updateTracing(B.deal.id, { withdrawnAt: new Date() } as any);
  const v = await view();
  assert.equal(v.state, "withdrawn");
  assert.equal(v.costs.length, 0);
  await B.w.gl.updateTracing(B.deal.id, { withdrawnAt: null } as any);
});

await test("seller states: question, reopened, waiting for the accountant, waiting for the broker, done", () => {
  const T = { requestedAt: new Date(), withdrawnAt: null, sellerDoneAt: null, accountantRequest: null, reviewedAt: null } as any;
  const c = (o: Record<string, unknown> = {}) => ({ sellerStatus: "not_started", reopenedNote: null, question: null, reviewedAt: null, ...o }) as any;
  assert.equal(sellerGlState(T, [c()], false), "requested");
  assert.equal(sellerGlState(T, [c({ sellerStatus: "in_progress" })], true), "in_progress");
  assert.equal(sellerGlState(T, [c({ question: { text: "?" } })], true), "question");
  assert.equal(sellerGlState(T, [c({ reopenedNote: "x", sellerStatus: "in_progress" })], true), "reopened");
  assert.equal(sellerGlState({ ...T, accountantRequest: { name: "Priya" } }, [c()], false), "waiting_for_accountant");
  assert.equal(sellerGlState({ ...T, sellerDoneAt: new Date() }, [c({ sellerStatus: "done" })], true), "waiting_for_broker");
  assert.equal(sellerGlState(T, [c({ reviewedAt: new Date() })], true), "done");
});

// ── The gate ──
const tr = (o: Record<string, unknown> = {}) => ({ removedAt: null, proof: "ledger", includeInCim: true, reviewedAt: null, leftOut: null, claims: { "2024": 100 }, sentAt: null, ...o }) as any;

await test("gate states: not needed, not requested, with the seller, with the broker, done, waived", () => {
  assert.equal(gateFrom(null, [tr({ proof: "statement" })]).state, "not_needed");
  const g = gateFrom(null, [tr(), tr()]);
  assert.equal(g.state, "not_requested");
  assert.equal(g.holdsDd, true);
  assert.equal(g.holdsCim, false, "the Full/Blind CIM isn't held without the switch");
  assert.equal(g.message, DD_GATE_MESSAGE(2, 2));
  assert.equal(gateFrom({ requestedAt: new Date() } as any, [tr({ sentAt: new Date() })]).state, "with_seller");
  assert.equal(gateFrom({ requestedAt: new Date(), sellerDoneAt: new Date() } as any, [tr({ sentAt: new Date() })]).state, "with_broker");
  assert.equal(gateFrom(null, [tr({ reviewedAt: new Date() }), tr({ leftOut: { years: ["2024"], reason: "x" } }), tr({ includeInCim: false })]).state, "done");
  const w = gateFrom({ waived: { reason: "No ledger kept", at: "x", by: "b" } } as any, [tr()]);
  assert.equal(w.state, "waived");
  assert.equal(w.holdsDd, false);
  const hold = gateFrom({ requireBeforeCim: true } as any, [tr()]);
  assert.equal(hold.holdsCim, true);
  assert.match(hold.message!, /You asked to hold the CIM/);
  assert.equal(gateFrom(null, [tr()], { confirmedLinks: 3 }).state, "with_broker", "entries confirmed without a request: the broker's move");
});

await test("assertGlGate: DD held; the whole CIM only with the switch; gl_trace_required", async () => {
  await assert.rejects(assertGlGate(B.deal, "dd"), (e: unknown) => isGlTraceRequiredError(e) && (e as any).gate.state === "with_seller");
  await assertGlGate(B.deal, "cim");
  await B.w.gl.updateTracing(B.deal.id, { requireBeforeCim: true } as any);
  await assert.rejects(assertGlGate(B.deal, "cim"), (e: unknown) => isGlTraceRequiredError(e) && (e as any).code === "gl_trace_required");
  const { startCimGeneration } = await import("../../server/cim/generation-jobs");
  await assert.rejects(startCimGeneration(B.deal, "content"), (e: unknown) => isGlTraceRequiredError(e), "every full generation entry point is held");
  await B.w.gl.updateTracing(B.deal.id, { requireBeforeCim: false, waived: { reason: "Seller keeps no books", at: new Date().toISOString(), by: "b" } } as any);
  const g = await assertGlGate(B.deal, "dd");
  assert.equal(g.state, "waived");
  await B.w.gl.updateTracing(B.deal.id, { waived: null } as any);
});

// ── Workflow surfaces ──
await test("checklist rows (phase 3) and next steps", () => {
  const deal = { id: "d1", phase: "phase3_content_creation", interviewCompleted: true, questionnaireData: {}, ndaSigned: true } as any;
  const items = phaseChecklist("phase3_content_creation", deal, { glTracing: { state: "with_seller", toGo: 3, needsColumns: false, accountantPending: false } });
  assert.deepEqual(items.slice(0, 2).map((i) => [i.label, i.actor, i.optional, i.done]), [
    ["Seller shows the add-backs in the books", "seller", true, false],
    ["Add-backs in the books reviewed", "broker", true, false],
  ]);
  assert.equal(phaseChecklist("phase3_content_creation", deal, {}).length, 3, "no GL rows when the step doesn't apply");
  const step = (gl: any) => computeNextStep(deal, { invited: true, interviewStarted: true, glTracing: gl });
  assert.equal(step({ state: "not_requested", toGo: 2, needsColumns: false, accountantPending: false }).label, "ask the seller to show the add-backs in their books");
  assert.equal(step({ state: "with_seller", toGo: 2, needsColumns: false, accountantPending: false }).owner, "seller");
  assert.equal(step({ state: "with_broker", toGo: 2, needsColumns: false, accountantPending: false }).label, "review the add-backs in the books");
  assert.equal(step({ state: "with_seller", toGo: 2, needsColumns: true, accountantPending: false }).label, "check the columns of the ledger");
  assert.equal(step({ state: "with_seller", toGo: 2, needsColumns: false, accountantPending: true }).label, "send the accountant their link");
  assert.equal(step({ state: "done", toGo: 0, needsColumns: false, accountantPending: false }).label, "generate the CIM");
  assert.equal(step(null).label, "generate the CIM");
  assert.equal(glNextStep("d1", { state: "with_seller", toGo: 1, needsColumns: false, accountantPending: false }, true), null, "later phases: only the broker's own moves");
  assert.equal(step({ state: "with_broker", toGo: 1, needsColumns: false, accountantPending: false }).href, "/deal/d1/financials?fin=books");
});

await test("the deal list's extras from stored rows", () => {
  assert.equal(glExtrasFrom(undefined, [], [], 0), null);
  const x = glExtrasFrom({ accountantRequest: { name: "Priya" } } as any, [tr()], [{ status: "needs_columns" }], 0)!;
  assert.deepEqual(x, { state: "not_requested", toGo: 1, total: 1, needsColumns: true, accountantPending: true });
});

await test("the interview's mention: deterministic, no MANDATORY line, never lists costs", () => {
  assert.equal((GL_INTERVIEW_BLOCK.match(/MANDATORY/g) ?? []).length, 0);
  assert.match(GL_INTERVIEW_BLOCK, /^# OPEN REQUEST FROM THE BROKER: COSTS IN THE BOOKS/);
  assert.match(GL_INTERVIEW_BLOCK, /Do not list the costs, their amounts or how they are treated, and do not discuss add-backs/);
});

await test("Q21: the two new routing keys sit behind one switch, OFF until the founder's yes — the existing events go out", () => {
  // Release review security-integration F1: CLAUDE.md — routing changes need the founder's explicit instruction.
  assert.equal(GL_NOTIFICATION_ROUTING, false, "off until the founder says yes");
  assert.deepEqual(NOTIFICATION_ROUTING.seller_gl_request, { teams: ["seller"], roles: ["owner", "accountant"] });
  assert.deepEqual(NOTIFICATION_ROUTING.gl_needs_broker, { teams: ["broker"], roles: ["lead", "associate"] });
  assert.equal(glSellerEvent(), "seller_followup_questions", "switched off → the follow-up event (owner + representative; the accountant isn't emailed)");
  assert.equal(glBrokerEvent(), "seller_followups_answered");
  // With the founder's yes (switched on): the new keys.
  _setGlNotificationRoutingForTests(true);
  assert.equal(glSellerEvent(), "seller_gl_request");
  assert.equal(glBrokerEvent(), "gl_needs_broker");
  const saved = { a: NOTIFICATION_ROUTING.seller_gl_request, b: NOTIFICATION_ROUTING.gl_needs_broker };
  delete (NOTIFICATION_ROUTING as any).seller_gl_request;
  delete (NOTIFICATION_ROUTING as any).gl_needs_broker;
  assert.equal(glSellerEvent(), "seller_followup_questions", "the routing lines removed → the follow-up events");
  assert.equal(glBrokerEvent(), "seller_followups_answered");
  (NOTIFICATION_ROUTING as any).seller_gl_request = saved.a;
  (NOTIFICATION_ROUTING as any).gl_needs_broker = saved.b;
  _setGlNotificationRoutingForTests(null);
  // No existing event's recipients changed.
  assert.deepEqual(NOTIFICATION_ROUTING.seller_followup_questions, { teams: ["seller"], roles: ["owner", "representative"] });
});

await test("email words: the two request variants; typed text escaped in the body only", () => {
  const a = requestEmailCopy({ brokerFirst: "Morgan", n: 4, ledgerOnFile: false, message: "<b>hi</b>" });
  assert.equal(a.title, "Morgan needs a few entries from your books");
  assert.match(a.body, /listed 4 costs that buyers will ask to see/);
  assert.match(a.body, /&lt;b&gt;hi&lt;\/b&gt;/);
  const b = requestEmailCopy({ brokerFirst: "", n: 1, ledgerOnFile: true });
  assert.equal(b.title, "Check a few costs we found in your books");
  const n = brokerNoticeCopy("accountant", { seller: "Dan & Co", business: "Brightwater Plumbing & Heating Ltd.", accountant: "Priya Shah" });
  assert.equal(n.title, "Dan & Co asked to bring in their accountant, Priya Shah — Brightwater Plumbing & Heating Ltd.", "titles are plain text (escaped once, by the email builder)");
  assert.match(n.body, /Dan &amp; Co/);
});

cleanup(B.w);
done("gate / progress / seller view");
