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

const B = brightwater({ extractedInfo: { ownerName: "Dan Brightwater", keyEmployees: "Mei Chen (office manager), Raj Singh (lead plumber)", salesPipeline: "A bid for Harvest Lane is pending.", _brokerPrivateNotes: ["Harvest Lane bid — keep out of the CIM."] } } as any);
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

await test("an account titled with a kept-out party or an employee: folded in the list, its own key finds nothing (checker r2 GL-R2-01)", async () => {
  const data = (store as any).data as { transactions: any[] };
  const legal = data.transactions.filter((r) => r.ledgerId === ledger.id && /legal/i.test(r.account));
  assert.ok(legal.length > 0);
  for (const r of legal) { r.account = "Consulting - Harvest Lane"; r.accountKey = "consulting - harvest lane"; }
  const wages = data.transactions.filter((r) => r.ledgerId === ledger.id && r.accountKey === "wages and salaries").slice(0, 5);
  for (const r of wages) { r.account = "Wages - M. Chen"; r.accountKey = "wages m chen"; }
  try {
    const all = await ledgerRowsForBuyer(dd, doc.id, {});
    const shown = JSON.stringify(all.accounts);
    assert.ok(!/harvest/i.test(shown), `the account list names the kept-out party: ${shown}`);
    assert.ok(!/chen/i.test(shown), "the account list names an employee");
    const other = all.accounts.find((a) => a.account === "Other account");
    assert.ok(other && other.accountKey === "withheld-other" && other.lines === legal.length, "one folded entry with an opaque key");
    const staff = all.accounts.find((a) => a.account === "Employee pay account");
    assert.ok(staff && staff.accountKey === "withheld-staff" && staff.lines === wages.length);
    assert.ok(all.accounts.some((a) => a.accountKey === "wages officers" && a.account === "Wages - Officers"), "an ordinary account keeps its title and key");

    // The account's own key (as the checker guessed it) finds nothing — the same as an account that doesn't exist.
    for (const key of ["consulting - harvest lane", "wages m chen", "no such account"]) {
      const r = await ledgerRowsForBuyer(dd, doc.id, { account: key });
      assert.equal(r.total, 0, key);
      const s = await ledgerRowsForBuyer(dd, doc.id, { account: key, q: "e" });
      assert.equal(s.total, 0, `${key} (search)`);
    }
    // The opaque key opens the folded rows, every one masked.
    const folded = await ledgerRowsForBuyer(dd, doc.id, { account: "withheld-other" });
    assert.equal(folded.total, legal.length);
    assert.ok(folded.rows.every((r) => r.account === "Other account" && r.withheld === "keep_out" && r.name === null));
    const pay = await ledgerRowsForBuyer(dd, doc.id, { account: "withheld-staff" });
    assert.equal(pay.total, wages.length);
    assert.ok(pay.rows.every((r) => r.account === "Employee pay account" && r.name === null));
    // A year filter keeps the folded key working (the map is over the whole ledger).
    const y = legal[0].fiscalYear;
    const inYear = await ledgerRowsForBuyer(dd, doc.id, { account: "withheld-other", fy: y });
    assert.equal(inYear.total, legal.filter((r) => r.fiscalYear === y).length);
    // Searching the party's name finds nothing; the page's rows never carry it.
    const h = await ledgerRowsForBuyer(dd, doc.id, { q: "Harvest" });
    assert.equal(h.total, 0);
    assert.ok(!/harvest|chen/i.test(JSON.stringify((await ledgerRowsForBuyer(dd, doc.id, { page: 0 })).rows)));
    // The broker's "show staff names" brings the employee's pay account back (the kept-out party stays folded).
    await store.updateLedger(ledger.id, { showStaffNames: true } as any);
    const withNames = await ledgerRowsForBuyer(dd, doc.id, {});
    assert.ok(withNames.accounts.some((a) => a.account === "Wages - M. Chen"));
    assert.ok(!/harvest/i.test(JSON.stringify(withNames.accounts)));
  } finally {
    await store.updateLedger(ledger.id, { showStaffNames: false } as any);
    for (const r of legal) { r.account = "Legal & Professional Fees"; r.accountKey = "legal and professional fees"; }
    for (const r of wages) { r.account = "Wages & Salaries"; r.accountKey = "wages and salaries"; }
  }
});

await test("the owner's own pay account keeps its title (the add-back's party)", async () => {
  const data = (store as any).data as { transactions: any[] };
  const officers = data.transactions.filter((r) => r.ledgerId === ledger.id && r.accountKey === "wages officers");
  for (const r of officers) { r.account = "Salary - D. Brightwater"; r.accountKey = "salary d brightwater"; }
  try {
    const all = await ledgerRowsForBuyer(dd, doc.id, {});
    assert.ok(all.accounts.some((a) => a.account === "Salary - D. Brightwater" && a.accountKey === "salary d brightwater"));
    const own = await ledgerRowsForBuyer(dd, doc.id, { account: "salary d brightwater" });
    assert.ok(own.total > 0 && own.rows.every((r) => r.account === "Salary - D. Brightwater"));
  } finally {
    for (const r of officers) { r.account = "Wages - Officers"; r.accountKey = "wages officers"; }
  }
});

cleanup(B.w);
done("data-room contract");
