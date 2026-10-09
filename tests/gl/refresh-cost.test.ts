/**
 * Checker r2 GL-R2-10: refreshGl runs on every broker panel poll, every
 * seller GL read and the progress / gate checks. When nothing changed it
 * loads the deal and its documents ONCE (the context) — the fiscal-year
 * check reads from that, never a second load — and a broker-set fiscal-year
 * end isn't worked out at all. The fiscal-year end still follows the facts.
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { cleanup } from "./_fake-storage";
import { brightwater } from "./_brightwater";
import { refreshGl } from "../../server/gl/service";
import { storage } from "../../server/storage";

const B = brightwater({} as any);
await B.readLedger("qbo-classic.csv");
await refreshGl(B.deal.id, { force: true });

const st = storage as any;
const counts = { deal: 0, docs: 0 };
const realDeal = st.getDeal;
const realDocs = st.getDocumentsByDeal;
st.getDeal = async (id: string) => { counts.deal++; return realDeal(id); };
st.getDocumentsByDeal = async (id: string) => { counts.docs++; return realDocs(id); };

await test("nothing changed: one load of the deal and its documents per refresh", async () => {
  counts.deal = 0; counts.docs = 0;
  const r = await refreshGl(B.deal.id);
  assert.equal(r.synced, false, "fingerprint-skipped");
  assert.equal(counts.deal, 1, `getDeal ×${counts.deal}`);
  assert.equal(counts.docs, 1, `getDocumentsByDeal ×${counts.docs}`);
});

await test("a broker-set fiscal-year end: the same single load, and the end stays", async () => {
  await B.w.gl.updateTracing(B.deal.id, { fiscalYearEndByBroker: true, fiscalYearEnd: "12-31" } as any);
  counts.deal = 0; counts.docs = 0;
  await refreshGl(B.deal.id);
  assert.equal(counts.deal, 1);
  assert.equal(counts.docs, 1);
  assert.equal((await B.w.gl.getTracing(B.deal.id))?.fiscalYearEnd, "12-31");
  await B.w.gl.updateTracing(B.deal.id, { fiscalYearEndByBroker: false } as any);
});

await test("the fiscal-year end still follows the facts (read from the same load)", async () => {
  const deal = B.w.deals.get(B.deal.id)!;
  const before = deal.extractedInfo;
  deal.extractedInfo = { ...(before as object), fiscalYearEnd: "March 31" } as any;
  try {
    const r = await refreshGl(B.deal.id);
    assert.equal(r.synced, true);
    assert.equal((await B.w.gl.getTracing(B.deal.id))?.fiscalYearEnd, "03-31");
  } finally {
    deal.extractedInfo = before;
    await refreshGl(B.deal.id);
  }
  assert.equal((await B.w.gl.getTracing(B.deal.id))?.fiscalYearEnd, "12-31", "and back");
});

st.getDeal = realDeal;
st.getDocumentsByDeal = realDocs;
cleanup(B.w);
done("refresh-cost");
