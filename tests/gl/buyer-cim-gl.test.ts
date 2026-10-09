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
import { glBridgeShows, glEvidenceAnchor, glEvidenceAnchorInfo, glNoteFitsAnchor, sectionFigures, sectionListsAddbacks, GL_EVIDENCE_LAYOUT, GL_EVIDENCE_SECTION_KEY, type GlEvidencePayload } from "../../shared/gl-evidence";
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

// ── Fixer round 1 ──

await test("GL-R1-12: the anchor prefers the bridge (waterfall / normalisation) and never a transaction, price, summary or closing section", () => {
  // A closing "Asking price & SDE multiple" after the bridge never takes the page.
  assert.equal(glEvidenceAnchor([{ sectionTitle: "Financial Performance" }, { layoutType: "waterfall_chart", sectionTitle: "SDE Bridge" }, { sectionTitle: "Asking price & SDE multiple" }]), 1);
  assert.equal(glEvidenceAnchor([{ sectionTitle: "Normalized Earnings (SDE)" }, { sectionTitle: "Transaction overview — adjusted EBITDA" }]), 0);
  assert.equal(glEvidenceAnchor([{ sectionKey: "executiveSummary", sectionTitle: "Executive Summary — SDE $1.3M" }, { sectionTitle: "Financial Overview" }]), 1);
  // A waterfall about the earnings first, then a normalisation section, then any waterfall.
  assert.equal(glEvidenceAnchor([{ layoutType: "waterfall_chart", sectionTitle: "Revenue walk 2022–2024" }, { sectionTitle: "Normalization Adjustments" }]), 1);
  assert.equal(glEvidenceAnchor([{ sectionTitle: "Normalization Adjustments" }, { layoutType: "waterfall_chart", sectionTitle: "Adjusted EBITDA Bridge" }, { sectionTitle: "Adjusted EBITDA by year" }]), 1);
  assert.deepEqual(glEvidenceAnchorInfo([{ sectionTitle: "Overview" }, { sectionTitle: "Financial Overview" }]), { index: 1, kind: "other" });
  assert.deepEqual(glEvidenceAnchorInfo([{ sectionKey: "sde_normalization" }]), { index: 0, kind: "bridge" });
  assert.deepEqual(glEvidenceAnchorInfo([{ sectionTitle: "Adjusted EBITDA & Margin", layoutType: "comparison_table" }]), { index: 0, kind: "earnings" });
  assert.equal(glEvidenceAnchor([{ sectionKey: "transactionOverview", sectionTitle: "Transaction Overview" }, { sectionTitle: "Contact" }]), 0, "nothing else → before the contact page");
});

// Pacific's live case: the served bridge came from an older analysis.
const stalePacificBridge = { title: "SDE Bridge", items: [
  { label: "Net income", value: 3_100_000, type: "start" },
  { label: "Non-working family salary", value: 62_000, type: "add" },
  { label: "Personal vehicle expenses", value: 38_000, type: "add" },
  { label: "Personal club dues", value: 9_800, type: "add" },
  { label: "One-time employment claim (settled)", value: 84_000, type: "add" },
  { label: "One-time TMS migration", value: 72_000, type: "add" },
  { label: "SDE", value: 3_365_800, type: "total" },
] };
const tracedChecks = [{ amounts: [18_000] }, { amounts: [15_000] }, { amounts: [55_000] }, { amounts: [72_000] }];

await test("GL-R1-05: glBridgeShows — every add-back the note counts must appear (any year), in any common money form", () => {
  assert.equal(glBridgeShows({ layoutData: stalePacificBridge }, tracedChecks), false, "vehicles $18,000 / club $15,000 / claim $55,000 aren't on the older bridge");
  assert.equal(glBridgeShows({ layoutData: stalePacificBridge }, [{ amounts: [38_000] }, { amounts: [84_000, 61_000] }]), true);
  assert.equal(glBridgeShows({ layoutData: { unit: "K", items: [{ label: "Vehicles", value: 18 }, { label: "Club", value: 15.2 }] } }, [{ amounts: [18_000] }, { amounts: [15_180] }]), true, "values in thousands");
  assert.equal(glBridgeShows({ layoutData: { rows: [["Vehicles", "$18,000", "C$17,500"]] }, aiDraftContent: "A one-time claim of $55K." }, [{ amounts: [18_000] }, { amounts: [55_200] }]), true, "table cells and text, rounded to $K");
  assert.equal(glBridgeShows({ layoutData: { rows: [["Vehicles", "$18,000"]] } }, [{ amounts: [18_900] }]), false, "a figure that differs is not the same add-back");
  assert.equal(glBridgeShows({ layoutData: { items: [] } }, []), true, "nothing to check");
  assert.equal(glBridgeShows(null, [{ amounts: [1] }]), false);
  // The note's own text is never read as the bridge's figures.
  assert.equal(sectionFigures({ layoutData: { _glNote: { text: "5 of 5 add-backs … 18,000" } } }).length, 0);
});

await test("GL-R1-05: Full — the note is held back under a bridge written from an earlier analysis, shown under one that matches", () => {
  const fin = section({ sectionTitle: "Financial Overview", layoutType: "financial_table", layoutData: { rows: [] } });
  const stale = section({ sectionTitle: "SDE Bridge", layoutType: "waterfall_chart", layoutData: stalePacificBridge });
  const payload = { ...note("normal"), bridge: tracedChecks };
  const out = buildBuyerCim({ deal, accessLevel: "loi", sections: [fin, stale], overrides: [], glEvidence: payload });
  assert.ok(out.sections.every((x) => !(x.layoutData as any)?._glNote), "no note anywhere — not moved to another section either");
  assert.equal(out.glEvidence, null);
  const fresh = section({ sectionTitle: "SDE Bridge", layoutType: "waterfall_chart", layoutData: { items: [
    { label: "Net income", value: 3_100_000 }, { label: "Personal vehicle expenses", value: 18_000 }, { label: "Personal club dues", value: 15_000 },
    { label: "One-time employment claim", value: 55_000 }, { label: "One-time TMS migration", value: 72_000 },
  ] } });
  const ok = buildBuyerCim({ deal, accessLevel: "loi", sections: [fin, fresh], overrides: [], glEvidence: payload });
  assert.ok((ok.sections[1].layoutData as any)._glNote, "the matching bridge carries it");
  // No earnings bridge in the CIM at all: nothing to contradict — the note goes on the last financial section.
  const noBridge = buildBuyerCim({ deal, accessLevel: "loi", sections: [section({ sectionTitle: "Overview" }), fin], overrides: [], glEvidence: payload });
  assert.ok((noBridge.sections.find((x) => x.id === fin.id)!.layoutData as any)._glNote);
});

await test("GL-R1-05: Blind — the same rule on the redacted bridge", () => {
  const a = section({ sectionTitle: "Overview" });
  const stale = section({ sectionTitle: "SDE Bridge", layoutType: "waterfall_chart", layoutData: stalePacificBridge });
  const payload = { ...note("blind"), bridge: tracedChecks };
  const out = buildBuyerCim({ deal, accessLevel: "blind", sections: [a, stale], overrides: [override(a, "blind"), override(stale, "blind")], glEvidence: payload });
  assert.equal(out.sections.length, 2, "the bridge itself is still served");
  assert.ok(out.sections.every((x) => !(x.layoutData as any)?._glNote));
  assert.equal(out.glEvidence, null);
  assert.deepEqual(out.leaked, []);
});

await test("GL-R1-05: an adjusted-EBITDA section that lists no add-backs can't contradict the note; one that lists them must agree", () => {
  // Pacific's current "Adjusted EBITDA & Margin": revenue, adjusted EBITDA and margins by year — no add-backs.
  const table = { layoutData: { title: "FY2023 vs FY2024", rows: [
    { label: "Revenue", left: "$29,180,000", right: "$31,020,000" }, { label: "Adjusted EBITDA", left: "$3,310,000", right: "$3,900,000" },
    { label: "Adjusted EBITDA Margin", left: "11.3%", right: "12.6%" },
  ] } };
  assert.equal(sectionListsAddbacks(table), false);
  assert.equal(glNoteFitsAnchor(table, "earnings", tracedChecks), true);
  const listing = { layoutData: { rows: [{ label: "Adjusted EBITDA", value: "$3,900,000" }, { label: "Personal vehicle expenses", value: "$38,000" }] } };
  assert.equal(sectionListsAddbacks(listing), true);
  assert.equal(glNoteFitsAnchor(listing, "earnings", tracedChecks), false);
  assert.equal(glNoteFitsAnchor({ layoutData: stalePacificBridge }, "bridge", tracedChecks), false);
  assert.equal(glNoteFitsAnchor({ layoutData: {} }, "other", tracedChecks), true, "a fallback section: nothing to contradict");
  // In the CIM: the Full note sits on the adjusted-EBITDA table.
  const fin = section({ sectionTitle: "Historical Financial Performance", layoutType: "financial_table", layoutData: { rows: [] } });
  const adj = section({ sectionTitle: "Adjusted EBITDA & Margin", layoutType: "comparison_table", layoutData: table.layoutData });
  const out = buildBuyerCim({ deal, accessLevel: "loi", sections: [fin, adj], overrides: [], glEvidence: { ...note("normal"), bridge: tracedChecks } });
  assert.ok((out.sections.find((x) => x.id === adj.id)!.layoutData as any)._glNote);
});

done("buyer CIM + GL");
