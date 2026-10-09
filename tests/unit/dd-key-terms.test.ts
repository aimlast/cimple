/**
 * D20 "From the documents": Pacific's location page lists the lease terms
 * from the warehouse lease; its customers page lists nothing (contract terms
 * came from the owner and a call); a broker-only lease lists nothing; values
 * over 140 characters are skipped.
 *   npx tsx tests/unit/dd-key-terms.test.ts
 */
import assert from "node:assert/strict";
import { conciseTerm, keyTermFamilyFor, keyTermsFor } from "../../shared/dd-key-terms";
import { fixtureRaw, run, test } from "./helpers/figure-test";

test("page roles → families", () => {
  assert.equal(keyTermFamilyFor("location", "Warehouse & Cross-Dock Facility"), "location");
  assert.equal(keyTermFamilyFor("customers", "Customer Base"), "customers");
  assert.equal(keyTermFamilyFor("operations", "Permits & Licences"), "permits");
  assert.equal(keyTermFamilyFor("financials", "Historical Financial Performance"), null);
  assert.equal(keyTermFamilyFor("other", "Legal, Regulatory & Compliance"), "permits");
});

test("Pacific location: lease expiry, renewal options and space from the warehouse lease", async () => {
  const { fx } = await fixtureRaw("pacific", { locate: false });
  const lease = fx.documents.find((d) => /^Warehouse lease/.test(d.name))!;
  const citable = (id: string) => fx.documents.some((d) => d.id === id && d.visibility !== "broker_only" && d.sourceKind === "document");
  const terms = keyTermsFor("location", fx.facts, fx.facts._fieldSources, citable);
  const byLabel = Object.fromEntries(terms.map((t) => [t.label, t]));
  assert.equal(byLabel["Lease expires"].value, "September 30, 2037");
  assert.equal(byLabel["Lease expires"].documentId, lease.id);
  assert.equal(byLabel["Renewal options"].value, "Two (2) renewal options of five (5) years each at fair market rent");
  assert.equal(byLabel["Space"].value, "110,000 square feet of rentable area");
  assert.ok(terms.length <= 6);
});

test("Pacific customers: nothing (the contract terms came from the owner and a call)", async () => {
  const { fx } = await fixtureRaw("pacific", { locate: false });
  const citable = () => true;
  assert.deepEqual(keyTermsFor("customers", fx.facts, fx.facts._fieldSources, citable), []);
});

test("a broker-only lease lists nothing", async () => {
  const { fx } = await fixtureRaw("pacific", { locate: false });
  const lease = fx.documents.find((d) => /^Warehouse lease/.test(d.name))!;
  const citable = (id: string) => id !== lease.id;
  const terms = keyTermsFor("location", fx.facts, fx.facts._fieldSources, citable);
  assert.ok(!terms.some((t) => t.documentId === lease.id));
});

test("concise values; over 140 characters skipped", () => {
  assert.equal(conciseTerm("Two (2) renewal options of five (5) years each at fair market rent; 9–12 months prior written notice"), "Two (2) renewal options of five (5) years each at fair market rent");
  assert.equal(conciseTerm("x".repeat(141)), null);
  assert.equal(conciseTerm({ a: 1 }), null);
});

test("the layer lists key terms in DD only, from citable documents", async () => {
  const { raw } = await fixtureRaw("pacific", { locate: false });
  const { figureInputsFor } = await import("../../server/cim/figures/serve");
  assert.ok(figureInputsFor(raw, { audience: "buyer", mode: "dd" })!.keyTerms.some((t) => t.label === "Lease expires"));
  assert.deepEqual(figureInputsFor(raw, { audience: "buyer", mode: "normal" })!.keyTerms, []);
  assert.deepEqual(figureInputsFor(raw, { audience: "buyer", mode: "blind" })!.keyTerms, []);
});

await run("dd-key-terms (D20)");
