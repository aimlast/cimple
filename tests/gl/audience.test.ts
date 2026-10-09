/**
 * gl spec §12.1 test 9 (D25): broker-only and CRM ledgers are private to the
 * broker; "Share it with the seller" flips a CRM ledger; reading a ledger
 * never changes its document's visibility.
 */
import assert from "node:assert/strict";
import { test, done, fixture } from "./_harness";
import { ledgerAudience, isSellerVisibleLedger, isBuyerVisibleLedger, isGlDocument } from "../../server/gl/audience";
import { fakeWorld, fakeDeal, cleanup } from "./_fake-storage";
import { ingestDocument } from "../../server/documents/ingest";
import { _setGlIngestDepsForTests, glQueueIdle } from "../../server/gl/ingest";

await test("who may see a ledger", () => {
  assert.equal(ledgerAudience({ visibility: "shared", sourceKind: "document" }, null), "shared");
  assert.equal(ledgerAudience({ visibility: "broker_only", sourceKind: "document" }, null), "broker");
  assert.equal(ledgerAudience({ visibility: "shared", sourceKind: "crm" }, { sharedWithSellerByBroker: false }), "broker");
  assert.equal(ledgerAudience({ visibility: "shared", sourceKind: "crm" }, { sharedWithSellerByBroker: true }), "shared");
  assert.equal(ledgerAudience({ visibility: "broker_only", sourceKind: "crm" }, { sharedWithSellerByBroker: true }), "broker", "still broker-only until the document is shared");
  assert.equal(isSellerVisibleLedger({ visibility: "broker_only" }, null), false);
  assert.equal(isBuyerVisibleLedger({ visibility: "broker_only" }, null), false);
  assert.equal(isBuyerVisibleLedger({ visibility: "shared", sourceKind: "crm" }, null), false);
  assert.equal(isGlDocument({ subcategory: "general_ledger" }), true);
  assert.equal(isGlDocument({ subcategory: "pnl" }), false);
  assert.equal(isGlDocument(null), false);
});

await test("reading a ledger never changes its document's visibility", async () => {
  const w = fakeWorld();
  _setGlIngestDepsForTests({ now: () => new Date("2025-03-01T12:00:00Z") });
  const deal = fakeDeal(w);
  const priv = w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture("qbo-2024-only.csv")), name: "gl.csv", subcategory: "general_ledger", visibility: "broker_only" } as any);
  const crm = w.addDocument({ dealId: deal.id, fileUrl: w.addFile(fixture("wave.csv")), name: "wave.csv", subcategory: "general_ledger", sourceKind: "crm", visibility: "broker_only" } as any);
  await ingestDocument(priv.id);
  await ingestDocument(crm.id);
  await glQueueIdle();
  assert.equal(w.documents.get(priv.id)!.visibility, "broker_only");
  assert.equal(w.documents.get(crm.id)!.visibility, "broker_only");
  assert.equal(w.documents.get(crm.id)!.sourceKind, "crm");
  assert.equal((await w.gl.getLedgerByDocument(priv.id))!.status, "ready", "the broker can still use it");
  cleanup(w);
});

done("audience");
