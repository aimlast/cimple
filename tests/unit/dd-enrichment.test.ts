/**
 * DD enrichment guard rails (QA harvest 2026-09-26, Beacon): the DD writer
 * sees only what a DD buyer may see, can't change an approved figure,
 * invent a name or leak internal wording, and an edited section's DD
 * version is kept (stale) instead of silently dropped.
 */
import assert from "node:assert/strict";
import {
  buildDdContext,
  enrichSection,
  validateDdOverride,
  _setDdClientForTests,
} from "../../server/cim/dd-enrichment";
import { buildCimFinancials } from "../../server/cim/cim-financials";
import { buildBuyerCim } from "../../shared/cim-buyer-view";

// ── Context: no internal questions, no broker-only sources, no CRM leads, no health ──
const ctx = buildDdContext({
  extractedInfo: {
    topCustomers: "ODB (Ontario Drug Benefit) 58% of dispensing revenue; Sunnyside Retirement Residence 9%",
    reasonForSale: "Owner retiring after a 2024 heart procedure",
    competingOffers: "Two IOIs received — Rexall-backed group at $3.4M",
    _fieldSources: { competingOffers: { source: "crm", documentId: "crm1" } },
  },
  financials: buildCimFinancials({
    id: "fa", version: 1, status: "reviewed", brokerReviewedAt: new Date(),
    normalization: { metric: "sde", years: ["2024"], netIncome: { "2024": 496728 }, addbacks: [{ id: "a", label: "Owner salary", category: "owner_comp", type: "sde", approved: true, amounts: { "2024": 152163 } }] },
    clarifyingQuestions: [{ question: "Why is FY2024 EBITDA $679,312 when components sum to $660,252?" }],
  } as any),
  addbackVerification: { status: "complete", addbacks: [{ label: "Owner salary", verificationStatus: "verified", matchedTransactions: [1, 2] }] },
  documents: [
    { name: "FY2024 Financial Statements.pdf", category: "financials", visibility: "shared" },
    { name: "CRM note — LOI and competing IOIs", category: "financials", visibility: "broker_only" },
  ],
});
assert.ok(!/679,312|clarifying/i.test(ctx.context), "no analyzer questions");
assert.ok(!/competing IOIs|CRM note/i.test(ctx.context), "no broker-only document names");
assert.ok(!/Rexall|IOIs received/.test(ctx.context + ctx.knownText), "no CRM-only facts");
assert.ok(!/heart|procedure/i.test(ctx.context + ctx.knownText), "no personal health detail");
assert.match(ctx.context, /Sunnyside Retirement Residence/);
assert.match(ctx.context, /FY2024 Financial Statements\.pdf/);
assert.match(ctx.context, /SDE \(total\): 2024 \$648,891/);

// ── Validator ──
const base = {
  layoutData: {
    headers: ["", "FY2023", "FY2024"],
    rows: [{ label: "SDE", values: ["$601,220", "$648,891"] }, { label: "Customer A (institutional)", values: ["", "9%"] }],
    caption: "Institutional customer Customer A is a retirement residence.",
  },
  content: "SDE reached $648,891 in FY2024.",
};
const changed = validateDdOverride(base, {
  layoutData: { ...base.layoutData, rows: [{ label: "SDE", values: ["$601,220", "$679,312"] }, base.layoutData.rows[1]] },
  contentOverride: "SDE reached $679,312 in FY2024.",
}, ctx.knownText);
assert.ok(changed.some((p) => /648,891/.test(p)), `changed figure rejected: ${changed.join(" | ")}`);

const invented = validateDdOverride(base, {
  layoutData: base.layoutData,
  contentOverride: "SDE reached $648,891 in FY2024. [[dd]]Biohazard waste is handled by BioSafe Environmental Solutions.[[/dd]]",
}, ctx.knownText);
assert.ok(invented.some((p) => /BioSafe Environmental Solutions/.test(p)), `invented entity rejected: ${invented.join(" | ")}`);

const internal = validateDdOverride(base, {
  layoutData: base.layoutData,
  contentOverride: "SDE reached $648,891 in FY2024. [[dd]]Concentration is higher than the 25% initially estimated in teaser materials, per confirmed facts.[[/dd]]",
}, ctx.knownText);
assert.ok(internal.some((p) => /internal wording/.test(p)), `internal wording rejected: ${internal.join(" | ")}`);
assert.ok(internal.some((p) => /25%/.test(p)), "a percentage with no source is rejected too");

const good = validateDdOverride(base, {
  layoutData: {
    ...base.layoutData,
    rows: [base.layoutData.rows[0], { label: "Sunnyside Retirement Residence (institutional)", values: ["", "9%"] }],
    caption: "Institutional customer [[dd]]Sunnyside Retirement Residence[[/dd]] is a retirement residence.",
  },
  contentOverride: "SDE reached $648,891 in FY2024. [[dd]]Owner salary add-back verified against 2 payroll transactions.[[/dd]]",
}, ctx.knownText);
assert.deepEqual(good, [], "a faithful enrichment passes");

// ── enrichSection keeps the named version when the model changes a figure ──
const section = {
  id: "s1", dealId: "d", sectionKey: "fin", sectionTitle: "Financial Summary", order: 3, layoutType: "financial_table",
  layoutData: base.layoutData, aiDraftContent: base.content, brokerEditedContent: null,
} as any;
_setDdClientForTests({
  messages: {
    create: async () => ({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "dd_section", input: { layoutData: { ...base.layoutData, rows: [{ label: "SDE", values: ["$601,220", "$679,312"] }] }, contentOverride: "SDE reached $679,312." } }],
    }),
  },
});
const kept = await enrichSection(section, ctx, { businessName: "Beacon Pharmacy" });
assert.deepEqual(kept.layoutData, base.layoutData, "base section kept");
assert.equal(kept.contentOverride, base.content);
assert.match(kept.warning ?? "", /kept as the named CIM/);

_setDdClientForTests({
  messages: {
    create: async () => ({
      stop_reason: "tool_use",
      content: [{ type: "tool_use", name: "dd_section", input: { layoutData: { ...base.layoutData, caption: "Institutional customer [[dd]]Sunnyside Retirement Residence[[/dd]] is a retirement residence." }, contentOverride: base.content } }],
    }),
  },
});
const enriched = await enrichSection(section, ctx, { businessName: "Beacon Pharmacy" });
assert.equal(enriched.warning, undefined);
assert.match(enriched.layoutData.caption, /\[\[dd\]\]Sunnyside Retirement Residence\[\[\/dd\]\]/);
_setDdClientForTests(null);

// ── A stale DD version is never served; the current named content is ──
const row = (o: Record<string, unknown>) => ({
  id: "s1", dealId: "d", sectionKey: "k", sectionTitle: "Customers", order: 1, layoutType: "prose_highlight",
  layoutData: { body: "Edited named text." }, aiDraftContent: "Edited named text.", brokerEditedContent: null, isVisible: true, aiTask: null, ...o,
}) as any;
const ddOverride = { id: "o", dealId: "d", cimSectionId: "s1", mode: "dd", layoutData: { body: "OLD text with [[dd]]names[[/dd]]." }, contentOverride: "OLD text with [[dd]]names[[/dd]]." } as any;
const fresh = buildBuyerCim({ deal: { id: "d" }, accessLevel: "due_diligence", sections: [row({ ddStaleAt: null })], overrides: [ddOverride] });
assert.match(JSON.stringify(fresh.sections[0].layoutData), /OLD text/, "fresh DD override is served");
const stale = buildBuyerCim({ deal: { id: "d" }, accessLevel: "due_diligence", sections: [row({ ddStaleAt: new Date() })], overrides: [ddOverride] });
assert.match(JSON.stringify(stale.sections[0].layoutData), /Edited named text/, "stale DD override is not served");

console.log("dd-enrichment: ok");
