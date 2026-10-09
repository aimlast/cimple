/**
 * The vdr contract (dd spec §11.1, INTEGRATION §2.6): what the DD CIM cites
 * and the per-document checks, from the demo fixtures. No DB, no AI.
 *   npx tsx tests/unit/dd-citations-contract.test.ts
 *
 *   - ddCitedDocuments' pure core never returns a broker-only / CRM / email /
 *     call document; includes the key terms' documents (Pacific's warehouse
 *     lease on its location page) and the check page ("dd-source-check");
 *     each entry is a VdrDocRef + sectionId, deduplicated per section;
 *   - ddDocumentChecks' shape is exactly vdr's: { label, thisValue, other:
 *     { documentId } | null, otherValue, status: match|differs, explanation };
 *     a worked-out regrouping counts as a match; the T2 and the statements see
 *     the same check from their own side; nothing for a document a buyer can't
 *     open; broker audience lists checks not shown yet.
 */
import assert from "node:assert/strict";
import { fixtureRaw, run, test } from "./helpers/figure-test";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import { DD_ACCESS_LEVEL } from "../../shared/access-levels";
import { citedDocumentsOfLayer, documentChecksOf } from "../../server/cim/dd-citations";

const VDR_REF_KEYS = ["documentId", "kind", "needle", "page", "period", "sectionId"];

async function ddView(name: "pacific" | "lakeshore", opts: { ddShownAt?: Date | null; audience?: "buyer" | "broker"; docs?: (d: any) => any } = {}) {
  const { fx, raw } = await fixtureRaw(name, { ddShownAt: opts.ddShownAt === undefined ? new Date() : opts.ddShownAt });
  if (opts.docs) for (const [id, m] of Array.from(raw.docs.entries())) raw.docs.set(id, opts.docs(m));
  const deal = { id: fx.deal.id, businessName: fx.deal.businessName, extractedInfo: fx.facts };
  const sections = fx.sections.map((s) => ({ ...s, isVisible: true, blindStaleAt: null, ddStaleAt: null, aiTask: null, aiDraftContent: null, brokerEditedContent: null })) as any[];
  const inputs = figureInputsFor(raw, { audience: opts.audience ?? "buyer", mode: "dd" })!;
  const view = buildBuyerCim({ deal, accessLevel: DD_ACCESS_LEVEL, sections, overrides: [], media: [], figures: inputs });
  const citable = (id: string) => !!raw.docs.get(id)?.citable;
  return { fx, raw, inputs, layer: view.figureLayer, sections: view.sections, citable };
}

test("cited documents: VdrDocRef + sectionId, one per document and section; the check page included", async () => {
  const { layer, citable, sections } = await ddView("lakeshore");
  const cited = citedDocumentsOfLayer(layer, citable);
  assert.ok(cited.length > 0);
  for (const c of cited) {
    assert.deepEqual(Object.keys(c).sort(), VDR_REF_KEYS);
    assert.ok(citable(c.documentId));
    assert.ok(sections.some((s) => s.id === c.sectionId), `section ${c.sectionId} is served`);
  }
  const keys = cited.map((c) => `${c.documentId}@${c.sectionId}`);
  assert.equal(new Set(keys).size, keys.length, "deduplicated per section");
  assert.ok(cited.some((c) => c.sectionId === "dd-source-check"), "the check page cites its statements and tax returns");
  assert.ok(cited.some((c) => c.kind === "tax_return"));
});

test("cited documents: Pacific's location page cites the warehouse lease (key terms)", async () => {
  const { fx, layer, citable } = await ddView("pacific");
  const lease = fx.documents.find((d) => /^Warehouse lease/.test(d.name))!;
  const cited = citedDocumentsOfLayer(layer, citable);
  const leaseRefs = cited.filter((c) => c.documentId === lease.id);
  assert.ok(leaseRefs.length >= 1, "the lease is cited");
  const page = fx.sections.find((s) => s.id === leaseRefs[0].sectionId)!;
  assert.ok(page, "on a served section");
  assert.notEqual(page.layoutType, "financial_table");
});

test("cited documents: never a broker-only, CRM, email or call document", async () => {
  const { fx } = await ddView("lakeshore");
  const t2 = fx.documents.find((d) => /T2/i.test(d.name))!;
  // The serve-time rule turns them non-citable: the T2 made broker-only, every
  // non-"document" source (email / call / CRM) as it is in the fixture.
  const { layer, citable } = await ddView("lakeshore", { docs: (m) => (m.id === t2.id ? { ...m, citable: false, visibility: "broker_only" } : m) });
  const cited = citedDocumentsOfLayer(layer, citable);
  assert.ok(!cited.some((c) => c.documentId === t2.id));
  for (const c of cited) {
    const d = fx.documents.find((x) => x.id === c.documentId)!;
    assert.notEqual(d.visibility, "broker_only");
    assert.ok(d.sourceKind === null || d.sourceKind === "document", `${d.name} is a document, not ${d.sourceKind}`);
  }
  // A layer from the citable pure function alone: a citable() that refuses everything returns nothing.
  assert.deepEqual(citedDocumentsOfLayer(layer, () => false), []);
  assert.deepEqual(citedDocumentsOfLayer(null, () => true), []);
});

test("document checks: vdr's exact shape; a regrouping is a match; both sides see it", async () => {
  const { fx, layer, inputs } = await ddView("lakeshore");
  const t2 = fx.documents.find((d) => /T2/i.test(d.name) && /2022/.test(d.name))!;
  const label = (k: string) => inputs.registry[k]?.lineLabel ?? null;
  const rows = documentChecksOf(layer, inputs.checks, inputs.idFor!, t2.id, label);
  assert.ok(rows.length > 0, "the 2022 T2 is checked");
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ["explanation", "label", "other", "otherValue", "status", "thisValue"]);
    assert.ok(r.status === "match" || r.status === "differs");
    if (r.other) assert.deepEqual(Object.keys(r.other), ["documentId"]);
    assert.match(r.thisValue, /^\$[\d,]+$/);
  }
  const interest = rows.find((r) => /^Interest, FY2022$/.test(r.label))!;
  assert.ok(interest, rows.map((r) => r.label).join(" | "));
  assert.equal(interest.status, "match", "bank charges grouped in: same amounts, grouped differently");
  assert.equal(interest.thisValue, "$86,000");
  assert.equal(interest.otherValue, "$29,000");
  assert.match(interest.explanation ?? "", /bank charges/i);
  // The statements see the same check from their side.
  const st = interest.other!.documentId;
  const fromStatements = documentChecksOf(layer, inputs.checks, inputs.idFor!, st, label).find((r) => r.label === "Interest, FY2022")!;
  assert.equal(fromStatements.thisValue, "$29,000");
  assert.equal(fromStatements.other?.documentId, t2.id);
});

test("document checks: nothing for buyers before the checks are on; the broker sees every check", async () => {
  const off = await ddView("lakeshore", { ddShownAt: null });
  const t2 = off.fx.documents.find((d) => /T2/i.test(d.name) && /2022/.test(d.name))!;
  const label = (k: string) => off.inputs.registry[k]?.lineLabel ?? null;
  assert.deepEqual(documentChecksOf(off.layer, off.inputs.checks, off.inputs.idFor!, t2.id, label), []);
  const broker = await ddView("lakeshore", { ddShownAt: null, audience: "broker" });
  const rows = documentChecksOf(broker.layer, broker.inputs.checks, (k) => k, t2.id, label);
  assert.ok(rows.length > 0);
});

await run("dd-citations (vdr contract)");
