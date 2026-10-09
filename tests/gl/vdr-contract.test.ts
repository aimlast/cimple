/**
 * gl spec §12.1 tests 22 + 33 (§8.2, §9.3, INTEGRATION §2.6): the ledger in
 * the data room, gl's side of the contract — gl's own checks don't rely on
 * the data room:
 *   - a ledger is a ledger from upload, in every status (isGlDocument);
 *   - rows only for a due-diligence buyer, only a READY ledger of THIS deal
 *     that buyers may see (never one private to the broker or from the CRM
 *     unshared) — everything else 404, whatever the data room said;
 *   - every row masked as served; a search never reveals a withheld row
 *     (an employee's name, "fertility", a kept-out party); LIKE wildcards
 *     are literal; at most 2,000 candidates;
 *   - the view is logged once per new query.
 * (vdr's pure itemVisibility / downloadDecision cases — ledger_dd_only,
 * ledger_pending — are added to this file at the vdr merge.)
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { refreshGl } from "../../server/gl/service";
import { GlLedgerNotFound, isBuyerVisibleLedger, isGlDocument, ledgerRowsForBuyer, ledgerStatusForVdr } from "../../server/gl/viewer";

const B = brightwater({ extractedInfo: { ownerName: "Dan Brightwater", keyEmployees: "Mei Chen (office manager), Raj Singh (lead plumber)", _brokerPrivateNotes: ["Harvest Lane bid — keep out of the CIM."] } } as any);
const dealId = B.deal.id;
const doc = await B.readLedger("qbo-classic.csv");
await refreshGl(dealId, { force: true });
const store = B.w.gl;
const ledger = (await store.getLedgerByDocument(doc.id))!;

const logs: any[] = [];
const dd = { deal: { id: dealId }, mode: "dd" as const, accessId: "acc-1", logView: (q: any) => { logs.push(q); } };

await test("a ledger from upload, in every status", async () => {
  assert.equal(isGlDocument({ subcategory: "general_ledger" }), true);
  assert.equal(isGlDocument({ subcategory: null }), false);
  for (const status of ["reading", "needs_columns", "failed", "ready"]) {
    await store.updateLedger(ledger.id, { status } as any);
    assert.equal((await ledgerStatusForVdr(doc.id))?.status, status);
  }
});

await test("404 unless a ready ledger of this deal, buyer-visible, for a due-diligence buyer", async () => {
  await store.updateLedger(ledger.id, { status: "reading" } as any);
  await assert.rejects(ledgerRowsForBuyer(dd, doc.id), GlLedgerNotFound, "not ready yet");
  await store.updateLedger(ledger.id, { status: "ready" } as any);
  await assert.rejects(ledgerRowsForBuyer({ ...dd, mode: "normal" }, doc.id), GlLedgerNotFound, "a Full-CIM buyer");
  await assert.rejects(ledgerRowsForBuyer({ ...dd, mode: "blind" }, doc.id), GlLedgerNotFound, "a Blind-CIM buyer");
  await assert.rejects(ledgerRowsForBuyer({ ...dd, deal: { id: "another-deal" } }, doc.id), GlLedgerNotFound, "another deal's document");
  await assert.rejects(ledgerRowsForBuyer(dd, "no-such-doc"), GlLedgerNotFound);
  B.w.documents.get(doc.id)!.visibility = "broker_only";
  await assert.rejects(ledgerRowsForBuyer(dd, doc.id), GlLedgerNotFound, "private to the broker");
  B.w.documents.get(doc.id)!.visibility = "shared";
  B.w.documents.get(doc.id)!.sourceKind = "crm";
  assert.equal(isBuyerVisibleLedger(B.w.documents.get(doc.id)!, ledger), false, "from the CRM, not shared with the seller");
  await assert.rejects(ledgerRowsForBuyer(dd, doc.id), GlLedgerNotFound);
  B.w.documents.get(doc.id)!.sourceKind = "document";
  const r = await ledgerRowsForBuyer(dd, doc.id);
  assert.equal(r.total, 2117);
  assert.equal(r.rows.length, 100);
});

await test("rows are masked as served: employees' names on wages, personal entries; the owner on his own pay is shown", async () => {
  const wages = await ledgerRowsForBuyer(dd, doc.id, { account: (await store.accountTotals(ledger.id)).find((a) => a.accountKey === "wages and salaries")!.accountKey });
  assert.ok(wages.rows.length > 0);
  assert.ok(wages.rows.every((r) => r.withheld === "staff" && r.name === null), "every employee's name on Wages & Salaries");
  const shareholder = (await store.accountTotals(ledger.id)).find((a) => /shareholder expenses/.test(a.accountKey))!;
  const personal = await ledgerRowsForBuyer(dd, doc.id, { account: shareholder.accountKey });
  assert.ok(personal.rows.length >= 3);
  assert.ok(personal.rows.every((r) => r.withheld === "personal" && !/Rexall|Shoppers|College/.test(`${r.name} ${r.memo}`)));
  assert.ok(personal.rows.every((r) => r.amountCents !== 0 && r.date), "date and amount stay");
  const officers = (await store.accountTotals(ledger.id)).find((a) => /officer/.test(a.accountKey));
  if (officers) {
    const own = await ledgerRowsForBuyer(dd, doc.id, { account: officers.accountKey });
    assert.ok(own.rows.some((r) => r.withheld === undefined && /Brightwater/.test(r.name ?? "")), "the owner on his own pay");
  }
});

await test("a search never reveals a withheld row", async () => {
  for (const q of ["Chen", "M. Chen", "Okafor", "Shoppers", "Upper Canada", "Prescription", "Tuition"]) {
    const r = await ledgerRowsForBuyer(dd, doc.id, { q });
    assert.ok(r.rows.every((x) => !x.withheld), `${q}: a withheld row came back`);
    assert.ok(!r.rows.some((x) => /Chen|Okafor|Shoppers|Upper Canada/.test(`${x.name} ${x.memo}`)), `${q}: revealed`);
  }
  const lexus = await ledgerRowsForBuyer(dd, doc.id, { q: "Lexus" });
  assert.ok(lexus.total > 0, "an ordinary vendor is found");
  const amount = await ledgerRowsForBuyer(dd, doc.id, { q: "1,150.00" });
  assert.ok(amount.rows.some((r) => r.amountCents === 115000), "by amount");
  const sal = await ledgerRowsForBuyer(dd, doc.id, { q: "Wages" });
  assert.ok(sal.rows.length > 0 && sal.rows.every((r) => r.withheld === "staff" || !/Payroll —/.test(r.name ?? "")), "account matches stay masked");
});

await test("LIKE wildcards are literal; a search over the cap says so", async () => {
  const pct = await ledgerRowsForBuyer(dd, doc.id, { q: "%" });
  assert.equal(pct.total, 0, "% is not a wildcard");
  const under = await ledgerRowsForBuyer(dd, doc.id, { q: "_" });
  assert.equal(under.total, 0, "_ is not a wildcard");
  const wide = await ledgerRowsForBuyer(dd, doc.id, { q: "e" });
  assert.ok(wide.total <= 2000);
  assert.equal(wide.capped, wide.total >= 2000 || wide.capped);
});

await test("the view is logged once per new query", async () => {
  logs.length = 0;
  await ledgerRowsForBuyer(dd, doc.id, { q: "Lexus" });
  await ledgerRowsForBuyer(dd, doc.id, { q: "Lexus", page: 1 });
  await ledgerRowsForBuyer(dd, doc.id, { q: "Petro" });
  assert.equal(logs.length, 1, "Lexus was logged in an earlier test; Petro is new");
  assert.equal(logs[0].q, "Petro");
});

cleanup(B.w);
done("data-room contract");
