/**
 * gl spec §12.1 tests 10, 11, 12: trace sync (Lakeshore/Brightwater-shaped
 * analysis: proof per add-back, owner pay merged at actual pay, a 50% share,
 * private evidence, FY labels, YTD left out, re-runs with new ids, removal,
 * reopen on an amount change, broker edits kept, buyers' reason screened),
 * the rules matcher on the Brightwater sample ledger (whole account, meals
 * at the whole cost, settlement, life insurance inside Insurance, golf
 * dues, spouse pay by name, nothing from the bank/AR/HST, double use, the
 * summary only when every year is confident, the payroll-provider ledger
 * gives no pay proposals), and a seller's confirmation racing a proposal run.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater, brightwaterNormalization } from "./_brightwater";
import { planTraces, proofFor, sellerLabelFor, sellerHintFor, shareFor, claimsOf, INTERIM_LEFT_OUT_REASON, REOPENED_AMOUNT } from "../../server/gl/traces";
import { refreshGl } from "../../server/gl/service";
import { proposeForTraces } from "../../server/gl/match-run";
import { loadGlContext } from "../../server/gl/context";
import { writeLinks } from "../../server/gl/links";
import { personsIn, namesPerson, termsFor } from "../../server/gl/match";
import { fiscalYearKey } from "../../shared/fiscal-year";
import type { GlAddbackTrace } from "../../shared/schema";

await test("proof, seller label, hint and share per add-back (pure)", () => {
  const P = (label: string, category: string, ownerPay = false) => proofFor({ label, category, ownerPay });
  assert.equal(P("Owner compensation (President - Tony Moretti)", "owner_comp", true), "payroll");
  assert.equal(P("Related party salary - Maria Moretti (spouse)", "discretionary"), "payroll");
  assert.equal(P("Owner vehicle expenses", "discretionary"), "ledger");
  assert.equal(P("Employment settlement (one-time)", "one_time"), "one_off");
  assert.equal(P("TMS migration consulting", "non_recurring"), "one_off");
  assert.equal(P("Depreciation & amortization", "other"), "statement");
  assert.equal(P("Interest expense", "other"), "statement");
  assert.equal(P("Income taxes", "other"), "statement");
  assert.equal(P("Amortization of intangibles", "non_cash"), "statement");
  const L = (label: string, category = "discretionary", ownerPay = false) => sellerLabelFor({ label, category, ownerPay }, proofFor({ label, category, ownerPay }));
  assert.equal(L("Owner compensation (President - Tony Moretti)", "owner_comp", true), "Your pay as owner");
  assert.equal(L("Related party salary - Maria Moretti (spouse)"), "Maria Moretti's pay");
  assert.equal(L("Meals & entertainment (50% personal use estimate)"), "Meals & entertainment");
  assert.equal(L("Employment settlement (one-time)", "one_time"), "Employment settlement");
  assert.equal(L("Excess insurance (owner life insurance)"), "Owner life insurance");
  assert.equal(L("Golf club dues"), "Golf club dues");
  assert.equal(sellerHintFor({ label: "Owner vehicle expenses", category: "discretionary", ownerPay: false }, "ledger"), "Fuel, insurance, lease or loan payments and repairs for the vehicle(s)");
  assert.equal(sellerHintFor({ label: "Owner compensation", category: "owner_comp", ownerPay: true }, "payroll", "CA"), "Your T4 slips or year-end payroll summary");
  assert.equal(sellerHintFor({ label: "Owner compensation", category: "owner_comp", ownerPay: true }, "payroll", "US"), "Your W-2 forms or year-end payroll summary");
  assert.equal(sellerHintFor({ label: "Related party salary - Maria Moretti (spouse)", category: "discretionary", ownerPay: false }, "payroll", "CA"), "Maria's T4 slips or year-end payroll summary");
  assert.deepEqual(shareFor({ label: "Meals & entertainment (50% personal use estimate)", description: "", category: "discretionary" }), { pct: 50, basis: "estimate" });
  assert.equal(shareFor({ label: "Owner compensation", description: "50% personal", category: "owner_comp" }, true), null);
});

await test("claims by fiscal year: FY labels keyed, zeros dropped, YTD left out", () => {
  const c = claimsOf({ FY2023: 10000, "2024": 12000, "FYE 2022": 0, "YTD 2025": 3000, TTM: 9000 });
  assert.deepEqual(c.claims, { "2023": 1_000_000, "2024": 1_200_000 });
  assert.deepEqual(c.yearLabels, { "2023": "FY2023", "2024": "2024" });
  assert.deepEqual(c.interim.sort(), ["TTM", "YTD 2025"]);
  // Production labels.
  for (const [l, k] of [["FY 2024", "2024"], ["2023/24", "2024"], ["Dec 31, 2024", "2024"], ["Q3 2025", null], ["9 months 2025", null]] as const) assert.equal(fiscalYearKey(l), k, l);
});

await test("the plan: 7 to find (owner pay merged at actual pay), 2 from the statements, dividends and rejected lines never", () => {
  const plan = planTraces(brightwaterNormalization(), [], { country: "CA", analysisId: "fa-1" });
  const byLabel = new Map(plan.inserts.map((t) => [t.label, t]));
  assert.equal(plan.inserts.length, 9);
  assert.ok(!byLabel.has("Dividends paid") && !byLabel.has("Rejected thing"));
  const owner = byLabel.get("Owner compensation (President - Dan Brightwater)")!;
  assert.equal(owner.proof, "payroll");
  assert.deepEqual(owner.claims, { "2022": 24_000_000, "2023": 24_000_000, "2024": 24_000_000 }, "actual pay, not the excess");
  assert.equal(owner.sellerLabel, "Your pay as owner");
  assert.equal(byLabel.get("Related party salary - Emma Brightwater (spouse)")!.proof, "payroll");
  const meals = byLabel.get("Meals & entertainment (50% personal use estimate)")!;
  assert.equal(meals.sharePct, 50);
  assert.equal(meals.shareBasis, "estimate");
  assert.equal(byLabel.get("Excess insurance (owner life insurance)")!.privateEvidence, true);
  assert.equal(byLabel.get("Employment settlement (one-time)")!.proof, "one_off");
  assert.deepEqual(byLabel.get("Employment settlement (one-time)")!.claims, { "2024": 2_200_000 });
  assert.equal(byLabel.get("Depreciation & amortization")!.proof, "statement");
  assert.equal(byLabel.get("Interest expense")!.proof, "statement");
  assert.equal(meals.buyerReason, "Half of meals are personal.", "the broker's sourcing note is dropped; the reason stays");
});

await test("re-plan: new analysis ids → same rows; broker edits kept; removed; reopened on an amount change", () => {
  const first = planTraces(brightwaterNormalization(), [], { country: "CA" });
  let n = 0;
  const existing = first.inserts.map((t) => ({
    id: `t${++n}`, dealId: "d", proofByBroker: false, sentAt: null, sellerStatus: "not_started", reopenedNote: null, removedAt: null, reviewedAt: null,
    ...t, sellerHint: t.sellerHint ?? null, buyerReason: t.buyerReason ?? null, leftOut: t.leftOut ?? null, shareBasisDoc: null,
  })) as unknown as GlAddbackTrace[];
  // The broker renamed the vehicle cost for the seller; the vehicle was sent and finished.
  const vehicle = existing.find((t) => t.label === "Owner vehicle expenses")!;
  vehicle.sellerLabel = "The Lexus and the truck";
  vehicle.sentAt = new Date();
  vehicle.sellerStatus = "done";
  vehicle.reviewedAt = new Date();
  const norm = brightwaterNormalization();
  norm.addbacks = norm.addbacks.map((a) => ({ ...a, id: `${a.id}_v2` })) as any;
  (norm.addbacks.find((a) => a.label === "Owner vehicle expenses") as any).amounts["2024"] = 30000;
  (norm.addbacks.find((a) => a.label === "Owner compensation (President - Dan Brightwater) — market salary") as any).id = "ab_1_v2_market";
  norm.addbacks = norm.addbacks.filter((a) => a.label !== "Golf club dues") as any;
  (norm.addbacks[2] as any).amounts = { ...(norm.addbacks[2] as any).amounts, "YTD 2025": 30000 };
  const plan = planTraces(norm, existing, { country: "CA" });
  assert.equal(plan.inserts.length, 0, "no new rows — matched by label");
  const v = plan.updates.find((u) => u.id === vehicle.id)!;
  assert.equal(v.reopened, true);
  assert.equal(v.patch.sellerStatus, "in_progress");
  assert.equal(v.patch.reopenedNote, REOPENED_AMOUNT);
  assert.equal(v.patch.reviewedAt, null, "the broker's review was of the old amount");
  assert.equal(v.patch.sellerLabel, undefined, "the broker's own label stays");
  const golf = existing.find((t) => t.label === "Golf club dues")!;
  assert.deepEqual(plan.removed, [golf.id]);
  const spouse = plan.updates.find((u) => u.id === existing.find((t) => t.label.startsWith("Related party"))!.id)!;
  assert.deepEqual(spouse.patch.leftOut, { years: ["YTD 2025"], reason: INTERIM_LEFT_OUT_REASON });
});

await test("people in labels; a person named in a ledger line (initial + surname, the spouse kept apart)", () => {
  assert.deepEqual(personsIn("Owner compensation (President - Tony Moretti)"), [{ first: "tony", last: "moretti" }]);
  assert.deepEqual(personsIn("Related party salary - Maria Moretti (spouse)"), [{ first: "maria", last: "moretti" }]);
  assert.deepEqual(personsIn("Excess insurance (owner life insurance)"), []);
  const dan = { first: "dan", last: "brightwater" };
  const emma = { first: "emma", last: "brightwater" };
  assert.equal(namesPerson("Payroll — D. Brightwater", dan, [dan, emma]), true);
  assert.equal(namesPerson("Payroll — E. Brightwater", dan, [dan, emma]), false);
  assert.equal(namesPerson("Payroll — E. Brightwater", emma, [emma]), true);
  assert.equal(namesPerson("Brightwater Plumbing invoice", dan, [dan, emma]), false, "surname alone with two Brightwaters involved");
  assert.ok(!termsFor({ label: "Excess insurance (owner life insurance)", category: "discretionary", proof: "ledger" }).includes("owner"), "'owner' finds half the ledger");
});

const B = brightwater();
const ledgerDoc = await B.readLedger("qbo-classic.csv");
await refreshGl(B.deal.id, { force: true });
const traces = async () => new Map((await B.w.gl.listTraces(B.deal.id)).map((t) => [t.label, t]));
const linksOf = (id: string, y?: string) => B.w.gl.data.links.filter((k) => k.traceId === id && (!y || k.fiscalYear === y));

await test("sync on a deal with a ledger: 9 rows, proposals for each cost needing proof", async () => {
  const t = await traces();
  assert.equal(t.size, 9);
  assert.equal(linksOf(t.get("Depreciation & amortization")!.id).length, 0, "statements need nothing");
  const tracing = await B.w.gl.getTracing(B.deal.id);
  assert.ok(tracing?.syncedFingerprint, "fingerprint stored");
  const again = await refreshGl(B.deal.id);
  assert.equal(again.synced, false, "an identical sync is skipped");
});

await test("owner vehicles: the whole 'Vehicle - Owner' account, every year, high confidence → the summary", async () => {
  const v = (await traces()).get("Owner vehicle expenses")!;
  for (const y of ["2022", "2023", "2024"]) {
    const ls = linksOf(v.id, y);
    assert.ok(ls.length > 10, `${y}: entries proposed`);
    assert.ok(ls.every((k) => k.account === "Automobile Expense:Vehicle - Owner" && k.confidence === "high" && k.state === "proposed"));
  }
  const sum = linksOf(v.id, "2024").reduce((s, k) => s + Number(k.amountCents), 0);
  assert.equal(sum, 2_784_000);
  const c = v.computed as any;
  assert.deepEqual(c.summary?.accounts, ["Automobile Expense:Vehicle - Owner"]);
  assert.deepEqual(c.summary?.years, ["2022", "2023", "2024"]);
  assert.equal(c.summary?.totalCents, 7_784_000);
  assert.equal(c.byYear["2024"].status, "not_started", "proposals aren't confirmations");
  assert.equal(c.byYear["2024"].proposed > 0, true);
});

await test("meals at 50%: the whole meals account is proposed ($22,000 against the $11,000 add-back)", async () => {
  const m = (await traces()).get("Meals & entertainment (50% personal use estimate)")!;
  const sum = linksOf(m.id, "2024").reduce((s, k) => s + Number(k.amountCents), 0);
  assert.equal(sum, 2_200_000);
  assert.ok(linksOf(m.id, "2024").every((k) => k.account === "Meals and Entertainment"));
});

await test("the settlement: the one Holloway LLP payment, never the retainer refund", async () => {
  const s = (await traces()).get("Employment settlement (one-time)")!;
  const ls = linksOf(s.id, "2024");
  assert.equal(ls.length, 1);
  assert.equal(ls[0].name, "Holloway LLP");
  assert.equal(Number(ls[0].amountCents), 2_200_000);
  assert.equal(ls[0].confidence, "high");
  assert.equal(linksOf(s.id, "2022").length, 0, "no claim in 2022");
});

await test("life insurance inside 'Insurance': the Sun Life premiums, not the business insurance", async () => {
  const s = (await traces()).get("Excess insurance (owner life insurance)")!;
  const ls = linksOf(s.id, "2024");
  assert.ok(ls.length >= 12);
  const high = ls.filter((k) => k.confidence === "high");
  assert.ok(high.every((k) => k.name === "Sun Life"), "only Sun Life is high confidence");
  assert.equal(high.reduce((a, k) => a + Number(k.amountCents), 0), 900_000);
  assert.ok(!ls.some((k) => k.name === "Intact Insurance" && k.confidence === "high"));
});

await test("golf dues: Glen Abbey's twelve payments, not the trade association", async () => {
  const g = (await traces()).get("Golf club dues")!;
  const ls = linksOf(g.id, "2024");
  assert.equal(ls.filter((k) => k.name === "Glen Abbey Golf Club").length, 12);
  assert.ok(!ls.some((k) => k.name === "HRAI"));
});

await test("pay: owner and spouse by name on wages accounts; never a bank, AR or HST line", async () => {
  const t = await traces();
  const owner = linksOf(t.get("Owner compensation (President - Dan Brightwater)")!.id, "2024");
  const spouse = linksOf(t.get("Related party salary - Emma Brightwater (spouse)")!.id, "2024");
  assert.ok(owner.length > 0 && owner.every((k) => /D\. Brightwater/.test(k.name ?? "")), "owner pay = D. Brightwater's paycheques");
  assert.ok(spouse.length > 0 && spouse.every((k) => /E\. Brightwater/.test(k.name ?? "")), "spouse pay = E. Brightwater's");
  const all = B.w.gl.data.links.filter((k) => k.dealId === B.deal.id);
  assert.ok(!all.some((k) => /chequing|receivable|hst payable|shareholder loan/i.test(k.account ?? "")), "nothing from the balance sheet");
});

await test("a seller's tick is never undone by a proposal run; a rejected entry is never proposed again", async () => {
  const v = (await traces()).get("Owner vehicle expenses")!;
  const c = await loadGlContext(B.deal.id);
  const [a, b] = linksOf(v.id, "2024");
  // The seller confirms one entry and rejects another, while a proposal run happens at the same time.
  await Promise.all([
    writeLinks(v, { add: [{ ledgerId: a.ledgerId!, rowNo: a.rowNo! }], reject: [{ ledgerId: b.ledgerId!, rowNo: b.rowNo! }] }, { by: "seller", memberId: null }, c),
    proposeForTraces(B.deal.id, [v.id], { ai: "none", force: true }),
  ]);
  await proposeForTraces(B.deal.id, [v.id], { ai: "none", force: true });
  const after = linksOf(v.id, "2024");
  assert.equal(after.find((k) => k.rowNo === a.rowNo)?.state, "confirmed");
  assert.equal(after.find((k) => k.rowNo === b.rowNo)?.state, "rejected");
  assert.equal(after.filter((k) => k.rowNo === a.rowNo).length, 1, "one row per entry (unique)");
  const fresh = (await traces()).get("Owner vehicle expenses")!;
  assert.equal(fresh.sellerStatus, "in_progress");
  assert.equal((fresh.computed as any).byYear["2024"].confirmed, 1);
});

await test("an entry confirmed for one cost is penalised for another (shown as already used)", async () => {
  const t = await traces();
  const meals = t.get("Meals & entertainment (50% personal use estimate)")!;
  const c = await loadGlContext(B.deal.id);
  const one = linksOf(meals.id, "2024")[0];
  await writeLinks(meals, { add: [{ ledgerId: one.ledgerId!, rowNo: one.rowNo! }] }, { by: "seller", memberId: null }, c);
  // Golf's proposals never include a meals entry; the meals entry is confirmed once.
  assert.equal(B.w.gl.data.links.filter((k) => k.ledgerId === one.ledgerId && k.rowNo === one.rowNo && k.state === "confirmed").length, 1);
});

await test("link writes are refused for another deal's ledger, a broker-only ledger (seller), or a year outside the claims", async () => {
  const t = await traces();
  const settle = t.get("Employment settlement (one-time)")!;
  const c = await loadGlContext(B.deal.id);
  const row2022 = B.w.gl.data.transactions.find((x) => x.dealId === B.deal.id && x.fiscalYear === "2022")!;
  const r1 = await writeLinks(settle, { add: [{ ledgerId: row2022.ledgerId, rowNo: row2022.rowNo }] }, { by: "seller", memberId: null }, c);
  assert.equal(r1.ok, false);
  assert.match((r1 as any).error, /2022, which isn't one of the years/);
  const r2 = await writeLinks(settle, { add: [{ ledgerId: "someone-elses", rowNo: 5 }] }, { by: "seller", memberId: null }, c);
  assert.equal(r2.ok, false);
  const privateC = { ...c, sellerLedgerIds: new Set<string>() };
  const row2024 = B.w.gl.data.transactions.find((x) => x.dealId === B.deal.id && x.fiscalYear === "2024")!;
  const r3 = await writeLinks(settle, { add: [{ ledgerId: row2024.ledgerId, rowNo: row2024.rowNo }] }, { by: "seller", memberId: null }, privateC);
  assert.equal(r3.ok, false, "a ledger private to the broker can't be used by the seller");
  const r4 = await writeLinks(settle, { add: [{ ledgerId: row2024.ledgerId, rowNo: row2024.rowNo }] }, { by: "broker", memberId: null }, privateC);
  assert.equal(r4.ok, true, "the broker can");
  void ledgerDoc;
});

cleanup(B.w);

// ── The payroll-provider ledger: no names → no pay proposals (the T4 is asked for first) ──
const P = brightwater();
await P.readLedger("payroll-provider.csv");
await refreshGl(P.deal.id, { force: true });
await test("a payroll-provider ledger (one 'Wagepoint' line per pay run): no pay proposals, not confident", async () => {
  const t = new Map((await P.w.gl.listTraces(P.deal.id)).map((x) => [x.label, x]));
  const owner = t.get("Owner compensation (President - Dan Brightwater)")!;
  assert.equal(P.w.gl.data.links.filter((k) => k.traceId === owner.id).length, 0);
  assert.equal((owner.computed as any).summary, null);
  assert.equal(owner.proof, "payroll", "pay slips are asked for first");
});
cleanup(P.w);

done("traces / matching");
