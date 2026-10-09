/**
 * gl spec §12.1 test 23 (§8.1.1, INTEGRATION §2.2): buildBuyerCim places
 * the add-back evidence itself —
 *   DD          the page "Where each add-back is in the books" right after
 *               the earnings bridge (a waterfall; else a bridge by title; else
 *               the last financial section; else before the contact page;
 *               else last), never through withCurrentFigures
 *   Full/Blind  the note on that section, before the Blind identity check —
 *               a leaking note is held back, never the section
 *   teaser      nothing (glEvidenceForBuyer gives null)
 */
import assert from "node:assert/strict";
import { test, done } from "./_harness";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import { glEvidenceAnchor, GL_EVIDENCE_LAYOUT, GL_EVIDENCE_SECTION_KEY, type GlEvidencePayload } from "../../shared/gl-evidence";
import type { CimSection, CimSectionOverride } from "../../shared/schema";

const deal = { id: "d1", businessName: "Lakeshore Home Comfort Ltd.", blindCodename: "Project Harbour", extractedInfo: { businessName: "Lakeshore Home Comfort Ltd.", city: "Mississauga", ownerName: "Tony Moretti" } };

let order = 0;
function section(p: Partial<CimSection>): CimSection {
  order++;
  return {
    id: p.id ?? `sec-${order}`, dealId: "d1", sectionKey: `k${order}`, sectionTitle: `Section ${order}`, order, layoutType: "prose_highlight", layoutData: { body: "Text." },
    aiDraftContent: "Text.", aiLayoutReasoning: null, brokerEditedContent: null, sellerEditedContent: null, finalContent: null, brokerApproved: false, sellerApproved: false,
    isVisible: true, layoutOverride: null, charts: null, images: null, accessTier: "teaser", blindStaleAt: null, blindTitle: null, aiTask: null, contentHistory: null,
    createdAt: new Date(), updatedAt: new Date(), ...p,
  } as CimSection;
}
const override = (s: CimSection, mode: string, layoutData: unknown = s.layoutData, content = "Text."): CimSectionOverride =>
  ({ id: `o_${s.id}_${mode}`, dealId: "d1", cimSectionId: s.id, mode, layoutData, contentOverride: content, createdAt: new Date() }) as CimSectionOverride;

const ddPayload: GlEvidencePayload = {
  mode: "dd", publishedAt: "2025-03-05T00:00:00.000Z", pageId: "glsec_0123456789ab",
  summary: { total: 1, found: 1, partly: 0, notFound: 0, document: 0, statement: 0 }, note: null,
  lines: [{ lineId: "aaaaaaaaaaaa", status: "found", mark: true, label: "Owner vehicles", years: [] }],
};
const note = (mode: "normal" | "blind", text = "1 of 1 add-back: the costs were found in the company's general ledger, which agrees with the financial statements for 2024. Matched by the owner and reviewed by the broker; not an audit."): GlEvidencePayload => ({
  mode, publishedAt: "2025-03-05T00:00:00.000Z", pageId: "glsec_0123456789ab",
  summary: { total: 1, found: 1, partly: 0, notFound: 0, document: 0, statement: 0 }, note: text,
  lines: [{ lineId: "aaaaaaaaaaaa", status: "found", mark: true }],
});

await test("the anchor: a waterfall; else a bridge by title; else the last financial section; else before the contact page; else last", () => {
  assert.equal(glEvidenceAnchor([{ layoutType: "prose_highlight" }, { layoutType: "waterfall_chart" }, { sectionTitle: "Financial Overview" }]), 1);
  assert.equal(glEvidenceAnchor([{ sectionTitle: "Financial Overview" }, { sectionTitle: "Normalized Earnings (SDE)" }, { sectionTitle: "Growth" }]), 1);
  assert.equal(glEvidenceAnchor([{ sectionKey: "financial_overview" }, { sectionTitle: "Growth" }]), 0);
  assert.equal(glEvidenceAnchor([{ sectionTitle: "Overview" }, { sectionTitle: "Team" }, { sectionTitle: "Contact the broker" }]), 1);
  assert.equal(glEvidenceAnchor([{ sectionTitle: "Overview" }, { sectionTitle: "Team" }]), 1);
  assert.equal(glEvidenceAnchor([]), -1);
});

await test("DD: the page goes right after the earnings bridge, with the published payload untouched", () => {
  const a = section({ sectionTitle: "Company Overview" });
  const bridge = section({ sectionTitle: "Earnings Bridge", layoutType: "waterfall_chart", layoutData: { items: [{ label: "Net income", value: 100 }] } });
  const c = section({ sectionTitle: "Growth" });
  const out = buildBuyerCim({ deal, accessLevel: "due_diligence", sections: [a, bridge, c], overrides: [], glEvidence: ddPayload });
  assert.deepEqual(out.sections.map((s) => s.layoutType), ["prose_highlight", "waterfall_chart", GL_EVIDENCE_LAYOUT, "prose_highlight"]);
  const page = out.sections[2];
  assert.equal(page.id, ddPayload.pageId);
  assert.equal(page.sectionKey, GL_EVIDENCE_SECTION_KEY);
  assert.equal(page.sectionTitle, "Where each add-back is in the books");
  assert.equal(page.layoutData, ddPayload);
  assert.equal(out.glEvidence, ddPayload);
  assert.ok(page.order > bridge.order && page.order < c.order);
});

await test("DD: no page for a payload of another mode or with no lines; no page and no note in other modes", () => {
  const s = [section({ sectionTitle: "Earnings Bridge", layoutType: "waterfall_chart", layoutData: { items: [] } })];
  assert.equal(buildBuyerCim({ deal, accessLevel: "due_diligence", sections: s, overrides: [], glEvidence: { ...ddPayload, lines: [] } }).sections.length, 1);
  assert.equal(buildBuyerCim({ deal, accessLevel: "due_diligence", sections: s, overrides: [], glEvidence: note("normal") }).sections.length, 1);
  const normal = buildBuyerCim({ deal, accessLevel: "loi", sections: s, overrides: [], glEvidence: ddPayload });
  assert.equal(normal.sections.length, 1);
  assert.equal((normal.sections[0].layoutData as any)._glNote, undefined);
  assert.equal(normal.glEvidence, null);
});

await test("Full: the note on the earnings bridge", () => {
  const a = section({ sectionTitle: "Financial Overview", layoutType: "financial_table", layoutData: { rows: [] } });
  const bridge = section({ sectionTitle: "Adjusted EBITDA", layoutType: "prose_highlight" });
  const out = buildBuyerCim({ deal, accessLevel: "loi", sections: [a, bridge], overrides: [], glEvidence: note("normal") });
  const n = (out.sections[1].layoutData as any)._glNote;
  assert.ok(n && /found in the company's general ledger/.test(n.text));
  assert.deepEqual(n.lineIds, ["aaaaaaaaaaaa"], "the marked lines");
  assert.equal((out.sections[0].layoutData as any)._glNote, undefined);
  assert.ok(out.glEvidence);
});

await test("Blind: the note is on the bridge and passes the identity check with it", () => {
  const a = section({ sectionTitle: "Overview" });
  const bridge = section({ sectionTitle: "Earnings Bridge", layoutType: "waterfall_chart", layoutData: { items: [{ label: "Net income", value: 1 }] } });
  const out = buildBuyerCim({ deal, accessLevel: "blind", sections: [a, bridge], overrides: [override(a, "blind"), override(bridge, "blind")], glEvidence: note("blind") });
  assert.equal(out.sections.length, 2);
  assert.ok((out.sections[1].layoutData as any)._glNote, "attached");
  assert.equal(out.leaked.length, 0);
  assert.ok(out.glEvidence);
});

await test("Blind: a note that names the business is held back — the section is still served", () => {
  const bridge = section({ sectionTitle: "Earnings Bridge", layoutType: "waterfall_chart", layoutData: { items: [{ label: "Net income", value: 1 }] } });
  const out = buildBuyerCim({ deal, accessLevel: "full", sections: [bridge], overrides: [override(bridge, "blind")], glEvidence: note("blind", "Lakeshore Home Comfort's add-backs were found in its ledger.") });
  assert.equal(out.sections.length, 1, "the section is served");
  assert.equal((out.sections[0].layoutData as any)._glNote, undefined, "without the note");
  assert.deepEqual(out.leaked, [], "not reported as a leaked section (no re-redaction)");
  assert.equal(out.glEvidence, null);
  assert.ok(!JSON.stringify(out.sections).includes("Lakeshore"));
});

await test("Blind: a section that leaks on its own is still held back (the note doesn't save it)", () => {
  const bridge = section({ sectionTitle: "Earnings Bridge", layoutType: "waterfall_chart", layoutData: { items: [{ label: "Net income", value: 1 }] } });
  const out = buildBuyerCim({ deal, accessLevel: "full", sections: [bridge], overrides: [override(bridge, "blind", bridge.layoutData, "Tony Moretti runs it.")], glEvidence: note("blind") });
  assert.equal(out.sections.length, 0);
  assert.deepEqual(out.leaked, [bridge.id]);
});

await test("nothing given → nothing added (the teaser gets null from glEvidenceForBuyer)", () => {
  const s = [section({ sectionTitle: "Earnings Bridge", layoutType: "waterfall_chart", layoutData: { items: [] } })];
  const out = buildBuyerCim({ deal, accessLevel: "due_diligence", sections: s, overrides: [], glEvidence: null });
  assert.equal(out.sections.length, 1);
  assert.equal(out.glEvidence, null);
});

done("buyer CIM + GL");
