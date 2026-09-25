/**
 * Unit checks for the CIM builder's pure logic — no database, no AI.
 *   npx tsx tests/unit/cim-builder.test.ts
 *
 * Covers the layout registry and the buyer-section rules (hidden sections,
 * access tiers, blind freshness, key/title redaction) that the view room and
 * the Q&A chatbot both rely on.
 */
import assert from "node:assert/strict";
import {
  CIM_LAYOUTS,
  CIM_PRESENTATION_KEYS,
  applySectionOverride,
  cimModeForAccessLevel,
  defaultLayoutData,
  getCimLayout,
  isBuyerAccessLevel,
  layoutSpecsForPrompt,
  layoutsByCategory,
  normalizeLayoutType,
  plannerLayouts,
  sameLayoutFamily,
} from "../../shared/cim-layouts";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import { uniqueSectionKey } from "../../server/cim/section-ops-keys";
import type { CimSection, CimSectionOverride } from "../../shared/schema";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}

// ── Registry ────────────────────────────────────────────────────────────
console.log("layout registry");

test("every layout has a label, description, category and blank data", () => {
  for (const l of CIM_LAYOUTS) {
    assert.ok(l.label && l.description && l.category, l.key);
    const d = defaultLayoutData(l.key, { businessName: "Acme", title: "T" });
    assert.equal(typeof d, "object", l.key);
    assert.notEqual(d, defaultLayoutData(l.key), "fresh object every call");
  }
});

test("keys are unique and the gallery covers every layout", () => {
  const keys = CIM_LAYOUTS.map((l) => l.key);
  assert.equal(new Set(keys).size, keys.length);
  const inGallery = layoutsByCategory().flatMap((g) => g.layouts.map((l) => l.key));
  assert.deepEqual([...inGallery].sort(), [...keys].sort());
});

test("the AI prompt lists exactly the planner layouts", () => {
  const prompt = layoutSpecsForPrompt();
  for (const l of plannerLayouts()) assert.ok(prompt.includes(`${l.key}: {`), l.key);
  assert.ok(!prompt.includes("tag_cloud:"), "tag_cloud is broker-only");
  assert.equal(plannerLayouts().length, 21, "the 21 layouts the engine always had");
});

test("unknown layout types normalise to a narrative", () => {
  assert.equal(normalizeLayoutType("image_gallery_v9"), "prose_highlight");
  assert.equal(normalizeLayoutType(undefined), "prose_highlight");
  assert.equal(normalizeLayoutType("bar_chart"), "bar_chart");
  assert.equal(getCimLayout("nope"), undefined);
});

test("layout families allow instant switching only between matching shapes", () => {
  assert.ok(sameLayoutFamily("pie_chart", "donut_chart"));
  assert.ok(sameLayoutFamily("callout_list", "numbered_list"));
  assert.ok(!sameLayoutFamily("prose_highlight", "metric_grid"));
  assert.ok(!sameLayoutFamily("prose_highlight", "made_up"));
});

test("presentation keys include logo/media keys the chatbot must skip", () => {
  for (const k of ["preparedByLogo", "businessLogo", "url", "accentColor"]) assert.ok(CIM_PRESENTATION_KEYS.has(k), k);
});

test("access levels map to CIM versions", () => {
  assert.equal(cimModeForAccessLevel("teaser"), "blind");
  assert.equal(cimModeForAccessLevel("full"), "blind");
  assert.equal(cimModeForAccessLevel("loi"), "normal");
  assert.equal(cimModeForAccessLevel("due_diligence"), "dd");
  assert.equal(cimModeForAccessLevel(null), "blind");
  assert.ok(isBuyerAccessLevel("loi"));
  assert.ok(!isBuyerAccessLevel("admin"));
});

// ── Overrides ───────────────────────────────────────────────────────────
console.log("override merge");

test("blind never falls back to base text", () => {
  const merged = applySectionOverride(
    { layoutData: { body: "Harbourline" }, aiDraftContent: "Harbourline draft", brokerEditedContent: "Harbourline edit" },
    { layoutData: null, contentOverride: null },
    "blind",
  );
  assert.deepEqual(merged.layoutData, {});
  assert.equal(merged.aiDraftContent, null);
  assert.equal(merged.brokerEditedContent, null);
});

test("override text replaces the broker edit only when there was one", () => {
  const noEdit = applySectionOverride(
    { layoutData: { left: { content: "x" } }, aiDraftContent: "draft", brokerEditedContent: null },
    { layoutData: { left: { content: "red" } }, contentOverride: "redacted draft" },
    "blind",
  );
  assert.equal(noEdit.brokerEditedContent, null, "two-column prose column stays in layoutData");
  assert.equal(noEdit.aiDraftContent, "redacted draft");
  const edited = applySectionOverride(
    { layoutData: {}, aiDraftContent: "draft", brokerEditedContent: "edit" },
    { layoutData: {}, contentOverride: "redacted edit" },
    "blind",
  );
  assert.equal(edited.brokerEditedContent, "redacted edit");
});

// ── Buyer sections ──────────────────────────────────────────────────────
console.log("buyer sections");

const deal = {
  id: "d1",
  businessName: "Harbourline Dental",
  blindCodename: "Project Kestrel",
  extractedInfo: { ownerName: "Dr. Sarah Chen" },
};

let n = 0;
function section(p: Partial<CimSection>): CimSection {
  n++;
  return {
    id: `s${n}`,
    dealId: "d1",
    sectionKey: `key_${n}`,
    sectionTitle: `Section ${n}`,
    order: n,
    layoutType: "prose_highlight",
    layoutData: { body: `real body ${n} Harbourline Dental` },
    aiLayoutReasoning: "Owner Dr. Sarah Chen wants out",
    tags: [],
    aiDraftContent: `real draft ${n}`,
    brokerEditedContent: null,
    sellerEditedContent: null,
    finalContent: null,
    brokerApproved: false,
    sellerApproved: false,
    isVisible: true,
    layoutOverride: null,
    charts: null,
    images: null,
    accessTier: "teaser",
    blindStaleAt: null,
    blindTitle: null,
    aiTask: null,
    contentHistory: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...p,
  } as CimSection;
}
function override(s: CimSection, mode = "blind"): CimSectionOverride {
  return {
    id: `o_${s.id}`,
    dealId: "d1",
    cimSectionId: s.id,
    mode,
    layoutData: { body: `redacted body ${s.id}` },
    contentOverride: `redacted ${s.id}`,
    createdAt: new Date(),
  } as CimSectionOverride;
}

test("hidden and still-being-written sections never reach any buyer", () => {
  const a = section({});
  const hidden = section({ isVisible: false });
  const writing = section({ aiTask: { id: "t", kind: "write", status: "running", startedAt: "" } });
  const failedWrite = section({ aiTask: { id: "t", kind: "write", status: "failed", startedAt: "" } });
  const rewriting = section({ aiTask: { id: "t", kind: "rewrite", status: "ready", startedAt: "" } });
  const all = [a, hidden, writing, failedWrite, rewriting];
  for (const level of ["loi", "due_diligence"]) {
    const out = buildBuyerCim({ deal, accessLevel: level, sections: all, overrides: [] });
    assert.deepEqual(out.sections.map((s) => s.id), [a.id, rewriting.id], level);
  }
  const blind = buildBuyerCim({ deal, accessLevel: "full", sections: all, overrides: all.map((s) => override(s)) });
  assert.deepEqual(blind.sections.map((s) => s.id), [a.id, rewriting.id]);
});

test("normal (LOI) buyers get base content and nothing internal", () => {
  const a = section({ accessTier: "full" });
  const out = buildBuyerCim({ deal, accessLevel: "loi", sections: [a], overrides: [] });
  assert.equal(out.mode, "normal");
  const s = out.sections[0] as unknown as Record<string, unknown>;
  assert.equal(s.locked, undefined, "LOI buyers are above the full tier");
  for (const k of ["aiLayoutReasoning", "aiTask", "blindTitle", "contentHistory", "accessTier", "brokerApproved"]) {
    assert.ok(!(k in s), `${k} must not reach buyers`);
  }
});

test("blind with no overrides at all → preparing, nothing served", () => {
  const out = buildBuyerCim({ deal, accessLevel: "teaser", sections: [section({})], overrides: [] });
  assert.equal(out.preparing, true);
  assert.equal(out.sections.length, 0);
});

test("blind holds back stale sections and sections without an override", () => {
  const fresh = section({});
  const stale = section({ blindStaleAt: new Date() });
  const missing = section({});
  const out = buildBuyerCim({
    deal,
    accessLevel: "full",
    sections: [fresh, stale, missing],
    overrides: [override(fresh), override(stale)],
  });
  assert.deepEqual(out.sections.map((s) => s.id), [fresh.id]);
  assert.equal(out.heldBack, 2);
  assert.equal(out.sections[0].aiDraftContent, `redacted ${fresh.id}`);
  assert.ok(!JSON.stringify(out).includes("real body"), "no un-redacted body");
  assert.ok(!JSON.stringify(out).includes("Harbourline"), "no business name");
});

test("teaser buyers see full-tier sections as locked stubs; full buyers see them", () => {
  const open = section({ sectionTitle: "Overview" });
  const gated = section({ sectionTitle: "Financial detail", accessTier: "full", blindTitle: "Financial detail" });
  const sections = [open, gated];
  const overrides = sections.map((s) => override(s));
  const teaser = buildBuyerCim({ deal, accessLevel: "teaser", sections, overrides });
  const stub = teaser.sections.find((s) => s.id === gated.id)!;
  assert.equal(stub.locked, true);
  assert.equal(stub.layoutType, "locked");
  assert.deepEqual(stub.layoutData, {});
  assert.equal(stub.aiDraftContent, null);
  assert.equal(stub.brokerEditedContent, null);
  assert.equal(stub.sectionTitle, "Financial detail");
  const full = buildBuyerCim({ deal, accessLevel: "full", sections, overrides });
  assert.equal(full.sections.find((s) => s.id === gated.id)!.locked, undefined);
  assert.equal(full.sections.find((s) => s.id === gated.id)!.aiDraftContent, `redacted ${gated.id}`);
});

test("blind titles use the AI-redacted title, then the name redactor", () => {
  const a = section({ sectionTitle: "About Harbourline Dental", blindTitle: null });
  const b = section({ sectionTitle: "Dr. Sarah Chen's story", blindTitle: "The Owner's Story" });
  const out = buildBuyerCim({ deal, accessLevel: "full", sections: [a, b], overrides: [override(a), override(b)] });
  assert.equal(out.sections[0].sectionTitle, "About Project Kestrel");
  assert.equal(out.sections[1].sectionTitle, "The Owner's Story");
});

test("blind section keys containing the business name are replaced, links follow", () => {
  const a = section({ sectionKey: "harbourline_dental_story" });
  const b = section({ sectionKey: "financials" });
  const hiddenTarget = section({ sectionKey: "secret", isVisible: false });
  const ob = override(b);
  ob.layoutData = { body: "x", relatedSections: ["harbourline_dental_story", "secret", "missing"] };
  const out = buildBuyerCim({ deal, accessLevel: "full", sections: [a, b, hiddenTarget], overrides: [override(a), ob] });
  const keyA = out.sections[0].sectionKey;
  assert.ok(!/harbourline/i.test(keyA), keyA);
  assert.deepEqual((out.sections[1].layoutData as any).relatedSections, [keyA]);
});

test("DD buyers get DD overrides where present, base content otherwise", () => {
  const a = section({});
  const b = section({});
  const out = buildBuyerCim({ deal, accessLevel: "due_diligence", sections: [a, b], overrides: [override(a, "dd")] });
  assert.equal(out.mode, "dd");
  assert.equal(out.sections[0].aiDraftContent, `redacted ${a.id}`);
  assert.equal(out.sections[1].aiDraftContent, b.aiDraftContent);
});

// ── Section keys ────────────────────────────────────────────────────────
console.log("section keys");

test("new section keys are unique within the deal", () => {
  assert.equal(uniqueSectionKey("Reason for Sale", []), "reason_for_sale");
  assert.equal(uniqueSectionKey("Reason for Sale", ["reason_for_sale"]), "reason_for_sale_2");
  assert.equal(uniqueSectionKey("Reason for Sale", ["reason_for_sale", "reason_for_sale_2"]), "reason_for_sale_3");
  assert.equal(uniqueSectionKey("   !!!  ", []), "section");
  assert.equal(uniqueSectionKey("Équipe & Café", []), "equipe_cafe");
});

console.log(`\n${passed} checks passed`);
