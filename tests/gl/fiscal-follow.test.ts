/**
 * Fixer round 1 (GL-R1-03, gl spec D26): the deal's fiscal-year end follows
 * the facts and statements until the broker sets it. A tracing row created
 * early (the seller opened their progress page before anything was known →
 * Dec 31) moves when the facts later say March 31: every entry and link
 * moves fiscal year, proposals come back for the new years, the tie-out is
 * worked out again. The broker's own choice sticks; "auto" hands it back.
 * A ledger read checks it first. Memory store, no AI.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { loadGlContext } from "../../server/gl/context";
import { changeFiscalYearEnd, refreshGl } from "../../server/gl/service";
import { dealFiscalYearEnd } from "../../server/gl/ingest";
import { sellerGlProgress } from "../../server/gl/progress";

const B = brightwater();
const dealId = B.deal.id;
const store = B.w.gl;
const setFacts = (facts: Record<string, unknown>) => {
  const d = B.w.deals.get(dealId)!;
  B.w.deals.set(dealId, { ...d, extractedInfo: { ...(d.extractedInfo as object), ...facts } } as any);
};
const entryOn = (date: string) => store.data.transactions.find((t) => t.dealId === dealId && t.txnDate === date);

await test("a row created by a read-only page before the facts exist starts on Dec 31 (automatic)", async () => {
  await loadGlContext(dealId); // what the seller's progress page does
  const tr = (await store.getTracing(dealId))!;
  assert.equal(tr.fiscalYearEnd, "12-31");
  assert.equal(tr.fiscalYearEndByBroker, false);
  await B.readLedger("qbo-classic.csv");
  await refreshGl(dealId, { force: true });
  const may = store.data.transactions.find((t) => t.dealId === dealId && /^2024-0[5-9]/.test(t.txnDate))!;
  assert.equal(may.fiscalYear, "2024", "calendar years while Dec 31");
});

await test("the facts then say March 31 → the next refresh moves every entry, link and proposal; the ledger's years follow", async () => {
  const may = store.data.transactions.find((t) => t.dealId === dealId && /^2024-0[5-9]/.test(t.txnDate))!;
  const feb = store.data.transactions.find((t) => t.dealId === dealId && /^2024-02/.test(t.txnDate))!;
  setFacts({ fiscalYearEnd: "March 31" });
  const r = await refreshGl(dealId);
  assert.equal(r.synced, true);
  const tr = (await store.getTracing(dealId))!;
  assert.equal(tr.fiscalYearEnd, "03-31");
  assert.equal(tr.fiscalYearEndByBroker, false, "still automatic");
  assert.equal(entryOn(may.txnDate)!.fiscalYear, "2025", "May 2024 is in the year ending March 2025");
  assert.equal(entryOn(feb.txnDate)!.fiscalYear, "2024");
  for (const k of store.data.links.filter((x) => x.dealId === dealId && x.ledgerId && x.txnDate)) {
    const e = entryOn(k.txnDate!)!;
    assert.equal(k.fiscalYear, e.fiscalYear, "links moved with their entries");
  }
  const ledger = store.data.ledgers.find((l) => l.dealId === dealId)!;
  assert.equal(ledger.fiscalYearEndUsed, "03-31");
  assert.ok(Object.keys((ledger.years as object) ?? {}).includes("2025"), "the ledger's year summary follows");
  // The seller's progress page now reads the same row (no second row, no reset).
  await sellerGlProgress({ id: "i", dealId, token: "t" } as any, []).catch(() => undefined);
  assert.equal((await store.getTracing(dealId))!.fiscalYearEnd, "03-31");
  assert.equal(store.data.tracing.filter((t) => t.dealId === dealId).length, 1);
});

await test("before a ledger read the fiscal-year end is checked too", async () => {
  setFacts({ fiscalYearEnd: "December 31" });
  assert.equal(await dealFiscalYearEnd(dealId), "12-31");
  const may = store.data.transactions.find((t) => t.dealId === dealId && /^2024-0[5-9]/.test(t.txnDate))!;
  assert.equal(may.fiscalYear, "2024", "the entries on file moved back with it");
});

await test("the broker's choice sticks against the facts; 'auto' hands it back to them", async () => {
  assert.equal(await changeFiscalYearEnd(dealId, "06-30"), "06-30");
  let tr = (await store.getTracing(dealId))!;
  assert.equal(tr.fiscalYearEndByBroker, true);
  setFacts({ fiscalYearEnd: "March 31" });
  await refreshGl(dealId, { force: true });
  assert.equal(await dealFiscalYearEnd(dealId), "06-30");
  tr = (await store.getTracing(dealId))!;
  assert.equal(tr.fiscalYearEnd, "06-30", "never overruled by the facts");
  assert.equal(await changeFiscalYearEnd(dealId, "auto"), "03-31");
  tr = (await store.getTracing(dealId))!;
  assert.equal(tr.fiscalYearEndByBroker, false);
  await assert.rejects(changeFiscalYearEnd(dealId, "13-45"), /valid fiscal year end/);
});

cleanup(B.w);
done("fiscal year end follows the facts");
