/**
 * Who sees what (D9–D12, D21) on the demo fixtures — the layer every buyer
 * path serves, built from the audience-neutral raw inputs. No DB, no AI.
 *   npx tsx tests/unit/figure-layer-serve.test.ts
 *
 *   - teaser: nothing; blind: approved blind wording only (no labels, no
 *     document ids, no checks/citations/key terms, opaque ids) and no blind
 *     leak anywhere in the layer;
 *   - DD checks only once `ddShownAt` is set (matches and worked-out
 *     regroupings without a decision; a difference only once shown);
 *   - Full / Blind never say "no reason"; suggested notes never reach a
 *     buyer — not even right after a broker preview on the same raw inputs;
 *   - a values change hides an approved note; a cited document made private
 *     drops the citation and a groundless AI note; `left_out` never reaches
 *     the payload; a blind whole-layer hit drops the layer
 *     (figureLayerDropped) and never touches `leaked`.
 */
import assert from "node:assert/strict";
import { fixtureRaw, noteRow, run, test } from "./helpers/figure-test";
import { figureInputsFor } from "../../server/cim/figures/serve";
import { buildFigureLayer, layerStrings } from "../../shared/figure-layer";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import { blindLeakTerms, findBlindLeaks } from "../../shared/blind-guard";
import { TEASER_ACCESS_LEVEL, BLIND_ACCESS_LEVEL, NAMED_ACCESS_LEVEL, DD_ACCESS_LEVEL } from "../../shared/access-levels";

const REV_NOTE = (over: Record<string, any> = {}) => noteRow({
  id: "n-rev", figureKey: "revenue|2023", kind: "movement", compareKey: "2022", origin: "computed", status: "approved",
  text: "Up $660,000 (11%) from FY2022, mostly HVAC equipment replacement & installation (+$290,000).",
  blindText: "Up $660,000 (11%) from FY2022, mostly from three revenue streams.",
  valuesSnapshot: { year: "2023", value: 6840000, fromYear: "2022", fromValue: 6180000 },
  ...over,
});
const COS_SUGGESTED = noteRow({
  id: "n-cos", figureKey: "costOfSales|2023", kind: "movement", compareKey: "2022", origin: "computed", status: "suggested",
  text: "Up $334,000 (10%) from FY2022, mostly equipment, parts & materials (+$168,000).", blindText: "Up $334,000 (10%) from FY2022, mostly from two direct costs.",
  valuesSnapshot: { year: "2023", value: 3822000, fromYear: "2022", fromValue: 3488000 },
});

async function lakeshore(opts: { notes?: any[]; ddShownAt?: Date | null; decisions?: any[]; docs?: (d: any) => any } = {}) {
  const r = await fixtureRaw("lakeshore", { notes: opts.notes ?? [REV_NOTE(), COS_SUGGESTED], ddShownAt: opts.ddShownAt ?? null, decisions: opts.decisions });
  if (opts.docs) for (const [id, meta] of Array.from(r.raw.docs.entries())) r.raw.docs.set(id, opts.docs(meta));
  return r;
}

test("the registry values behind the notes are the CIM's (sanity)", async () => {
  const { raw } = await lakeshore();
  assert.equal(raw.registry["revenue|2023"].value, 6840000);
  assert.equal(raw.registry["revenue|2022"].value, 6180000);
  assert.equal(raw.registry["costOfSales|2023"].value, 3822000);
});

test("teaser: no layer at all", async () => {
  const { fx, raw } = await lakeshore();
  const view = buildBuyerCim({ deal: { id: fx.deal.id, businessName: fx.deal.businessName, extractedInfo: fx.facts }, accessLevel: TEASER_ACCESS_LEVEL, sections: fx.sections as any, overrides: [], figures: figureInputsFor(raw, { audience: "buyer", mode: "blind" }) });
  assert.equal(view.figureLayer, null);
});

test("Full CIM: approved notes with their documents; suggested notes never; no checks; never 'no reason'", async () => {
  const { fx, raw } = await lakeshore();
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal")!;
  const figs = Object.values(layer.figures);
  assert.ok(figs.some((f) => f.why?.text.startsWith("Up $660,000")));
  assert.ok(!figs.some((f) => f.why?.text.startsWith("Up $334,000")), "a suggested note is never served");
  assert.ok(figs.every((f) => !f.checks && !f.parts));
  assert.ok(figs.every((f) => /^f_[0-9a-f]{10}$/.test(f.id)), "opaque ids");
  assert.ok(!/no reason/i.test(JSON.stringify(layer)));
  assert.ok(figs.every((f) => f.figureKey === undefined && f.hint === undefined), "no broker fields");
});

test("Blind CIM: blind wording only; no labels, documents, checks, citations or key terms; nothing identifying", async () => {
  const { fx, raw } = await lakeshore({ ddShownAt: new Date() });
  const layer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "blind" }), "blind")!;
  const figs = Object.values(layer.figures);
  assert.equal(figs.length, 1);
  assert.equal(figs[0].why!.text, "Up $660,000 (11%) from FY2022, mostly from three revenue streams.");
  assert.equal(figs[0].label, undefined);
  assert.deepEqual(figs[0].why!.citations, []);
  assert.ok(!figs[0].checks && !figs[0].parts && !figs[0].citations);
  assert.equal(layer.keyTerms, undefined);
  assert.equal(layer.pageSources, undefined);
  assert.ok(!JSON.stringify(layer).includes("documentId"));
  const terms = blindLeakTerms({ businessName: fx.deal.businessName, extractedInfo: fx.facts } as any, { codename: "Project Ember" });
  assert.deepEqual(findBlindLeaks(layerStrings(layer), terms), []);
  assert.ok(!/no reason/i.test(JSON.stringify(layer)));
});

test("a note with no blind wording is not shown in the Blind CIM", async () => {
  const { fx, raw } = await lakeshore({ notes: [REV_NOTE({ blindText: null })] });
  assert.equal(buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "blind" }), "blind"), null);
});

test("DD: no checks for buyers until the broker turns them on; approved notes show either way", async () => {
  const off = await lakeshore({ ddShownAt: null });
  const layerOff = buildFigureLayer(off.fx.sections as any, figureInputsFor(off.raw, { audience: "buyer", mode: "dd" }), "dd")!;
  assert.ok(Object.values(layerOff.figures).every((f) => !f.checks));
  assert.equal(layerOff.ddChecksOn, false);
  assert.equal(layerOff.sourceCheck, null);
  assert.ok(Object.values(layerOff.figures).some((f) => f.why));
  const on = await lakeshore({ ddShownAt: new Date() });
  const layerOn = buildFigureLayer(on.fx.sections as any, figureInputsFor(on.raw, { audience: "buyer", mode: "dd" }), "dd")!;
  const checks = Object.values(layerOn.figures).flatMap((f) => f.checks ?? []);
  assert.ok(checks.length > 10);
  assert.ok(checks.every((c) => c.state === "match" || c.state === "regrouped"), "only matches and worked-out regroupings without a decision");
  assert.ok(checks.some((c) => c.state === "regrouped" && /bank charges & merchant fees/.test(c.note?.text ?? "")));
  assert.ok(checks.every((c) => !c.preview), "no broker marks");
  assert.ok(layerOn.summary!.checked === checks.length || layerOn.summary!.checked > 0);
  assert.ok(layerOn.sourceCheck && layerOn.sourceCheck.lines.includes("interest"));
});

test("DD: an unexplained difference reaches buyers only once shown, and reads 'ask the broker'", async () => {
  const base = await lakeshore({ ddShownAt: new Date() });
  // Make the 2022 interest check unexplained: the T2 says something the components don't explain.
  const k = base.raw.checks.checks.find((c) => c.figureKey === "interest|2022" && c.kind === "tax_return")!;
  k.regrouped = false; k.regroupedText = null;
  let layer = buildFigureLayer(base.fx.sections as any, figureInputsFor(base.raw, { audience: "buyer", mode: "dd" }), "dd")!;
  const interestFig = () => Object.values(layer.figures).find((f) => f.label === "Interest" && f.year === "2022");
  assert.ok(!interestFig()?.checks?.some((c) => c.state === "ask"), "not shown without the broker's OK");
  k.decision = "shown";
  layer = buildFigureLayer(base.fx.sections as any, figureInputsFor(base.raw, { audience: "buyer", mode: "dd" }), "dd")!;
  const c = interestFig()!.checks!.find((x) => x.state === "ask")!;
  assert.ok(c);
  assert.equal(c.note, null);
  assert.ok(!/no reason/i.test(JSON.stringify(layer)));
  k.decision = "left_out";
  layer = buildFigureLayer(base.fx.sections as any, figureInputsFor(base.raw, { audience: "buyer", mode: "dd" }), "dd")!;
  const opaque = figureInputsFor(base.raw, { audience: "buyer", mode: "dd" })!.idFor!(k.key);
  assert.ok(!interestFig()?.checks?.some((x) => x.id === k.key || x.id === opaque), "left_out never reaches the payload");
  assert.ok(!JSON.stringify(layer).includes("left_out"));
});

test("DD buyers: check ids are opaque (a check key carries the figure key)", async () => {
  const base = await lakeshore({ ddShownAt: new Date() });
  const layer = buildFigureLayer(base.fx.sections as any, figureInputsFor(base.raw, { audience: "buyer", mode: "dd" }), "dd")!;
  const checks = Object.values(layer.figures).flatMap((f) => f.checks ?? []);
  assert.ok(checks.length > 0);
  for (const c of checks) {
    assert.match(c.id, /^f_[0-9a-f]{10}$/);
    if (c.note) assert.ok(!c.note.id.includes("|") && !c.note.id.includes("~"), c.note.id);
  }
  assert.ok(!JSON.stringify(layer).includes("~tax_return:"), "no check keys in the buyer payload");
});

test("a broker preview followed by a buyer view on the same raw inputs serves no suggested note", async () => {
  const { fx, raw } = await lakeshore();
  const broker = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "broker", mode: "normal" }), "normal")!;
  assert.ok(Object.values(broker.figures).some((f) => f.why?.suggested));
  const buyer = buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal")!;
  assert.ok(!Object.values(buyer.figures).some((f) => f.why?.text.startsWith("Up $334,000")));
  assert.ok(!JSON.stringify(buyer).includes("suggested"));
});

test("a values change hides an approved note (D10)", async () => {
  const { fx, raw } = await lakeshore({ notes: [REV_NOTE({ valuesSnapshot: { year: "2023", value: 6800000, fromYear: "2022", fromValue: 6180000 } })] });
  assert.equal(buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal"), null);
});

test("a cited document made broker-only drops its citation; an AI note left with nothing is not served", async () => {
  const fxDocs = (await lakeshore()).fx.documents;
  const club = fxDocs.find((d) => /Comfort Club membership report/.test(d.name))!;
  const aiNote = REV_NOTE({ id: "n-ai", origin: "ai", sources: [{ kind: "document", documentId: club.id, quote: "Active members grew from 2,150 to 2,520." }] });
  const shared = await lakeshore({ notes: [aiNote] });
  const l1 = buildFigureLayer(shared.fx.sections as any, figureInputsFor(shared.raw, { audience: "buyer", mode: "normal" }), "normal")!;
  assert.equal(Object.values(l1.figures)[0].why!.citations[0].documentId, club.id);
  const priv = await lakeshore({ notes: [aiNote], docs: (m) => (m.id === club.id ? { ...m, citable: false } : m) });
  assert.equal(buildFigureLayer(priv.fx.sections as any, figureInputsFor(priv.raw, { audience: "buyer", mode: "normal" }), "normal"), null);
});

test("a seller's flag hides the note at once (stale_reason)", async () => {
  const { fx, raw } = await lakeshore({ notes: [REV_NOTE({ staleReason: "seller_flagged" })] });
  assert.equal(buildFigureLayer(fx.sections as any, figureInputsFor(raw, { audience: "buyer", mode: "normal" }), "normal"), null);
});

test("buildBuyerCim: a blind layer that names the business is dropped; leaked is untouched", async () => {
  const { fx, raw } = await lakeshore({ notes: [REV_NOTE({ blindText: "Up because Lakeshore Home Comfort grew." })] });
  const fin = fx.sections.find((s) => s.sectionKey === "financial_performance")!;
  const deal = { id: fx.deal.id, businessName: fx.deal.businessName, extractedInfo: fx.facts, blindCodename: "Project Ember" };
  const section = { ...fin, isVisible: true, blindStaleAt: null, ddStaleAt: null, aiTask: null, aiDraftContent: null, brokerEditedContent: null } as any;
  const override = { id: "o1", dealId: fx.deal.id, cimSectionId: fin.id, mode: "blind", layoutData: fin.layoutData, contentOverride: null, createdAt: new Date() } as any;
  const view = buildBuyerCim({ deal, accessLevel: BLIND_ACCESS_LEVEL, sections: [section], overrides: [override], media: [], figures: figureInputsFor(raw, { audience: "buyer", mode: "blind" }) });
  assert.equal(view.sections.length, 1, "the section itself is served");
  assert.equal(view.figureLayer, null);
  assert.match(view.figureLayerDropped ?? "", /named/);
  assert.deepEqual(view.leaked, []);
  assert.deepEqual(view.leakReasons, {});
  // The same with a clean blind note serves the layer.
  const ok = await lakeshore();
  const view2 = buildBuyerCim({ deal, accessLevel: BLIND_ACCESS_LEVEL, sections: [section], overrides: [override], media: [], figures: figureInputsFor(ok.raw, { audience: "buyer", mode: "blind" }) });
  assert.ok(view2.figureLayer);
  assert.equal(view2.figureLayerDropped, null);
});

test("buildBuyerCim: DD inserts 'How the figures check out' after the financial table; never in normal or blind", async () => {
  const { fx, raw } = await lakeshore({ ddShownAt: new Date() });
  const deal = { id: fx.deal.id, businessName: fx.deal.businessName, extractedInfo: fx.facts };
  const sections = fx.sections.map((s) => ({ ...s, isVisible: true, blindStaleAt: null, ddStaleAt: null, aiTask: null, aiDraftContent: null, brokerEditedContent: null })) as any[];
  const dd = buildBuyerCim({ deal, accessLevel: DD_ACCESS_LEVEL, sections, overrides: [], media: [], figures: figureInputsFor(raw, { audience: "buyer", mode: "dd" }) });
  const i = dd.sections.findIndex((s) => s.id === "dd-source-check");
  assert.ok(i > 0);
  assert.equal(dd.sections[i].layoutType, "dd_source_check");
  assert.equal(dd.sections[i - 1].sectionKey, "financial_performance");
  const named = buildBuyerCim({ deal, accessLevel: NAMED_ACCESS_LEVEL, sections, overrides: [], media: [], figures: figureInputsFor(raw, { audience: "buyer", mode: "normal" }) });
  assert.ok(!named.sections.some((s) => s.id === "dd-source-check"));
});

await run("figure-layer-serve (who sees what)");
