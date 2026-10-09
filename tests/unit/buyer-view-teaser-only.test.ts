/**
 * buildBuyerCim — the single authority on what a buyer reads — and the new
 * access levels: a Teaser link (teaser_only) gets NO CIM in any mode (the
 * teaser is its own document); legacy teaser/full are the whole Blind CIM
 * with no locked stubs; loi/named the named CIM; due_diligence the DD layer;
 * anything unknown reads as a Teaser link (nothing). Plus the review hold:
 * a Teaser link never counts as a buyer who can open the CIM. Pure.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=disabled npx tsx tests/unit/buyer-view-teaser-only.test.ts
 */
import assert from "node:assert/strict";
import { buildBuyerCim } from "../../shared/cim-buyer-view";
import type { CimSection, CimSectionOverride } from "../../shared/schema";
import { openBuyerLinks } from "../../server/cim/generation-jobs";

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

const deal = { id: "d1", businessName: "Harbourline Dental Group", blindCodename: "Project Shoreline", extractedInfo: { companyName: "Harbourline Dental Group" }, isLive: false };
let n = 0;
function section(p: Partial<CimSection> = {}): CimSection {
  n++;
  return {
    id: `sec-${n}-0000-0000-0000-000000000000`, dealId: "d1", sectionKey: `key_${n}`, sectionTitle: `Section ${n}`, order: n,
    layoutType: "prose_highlight", layoutData: { body: `named body ${n}` }, aiLayoutReasoning: null, tags: [],
    aiDraftContent: `named draft ${n}`, brokerEditedContent: null, sellerEditedContent: null, finalContent: null,
    brokerApproved: true, sellerApproved: false, isVisible: true, layoutOverride: null, charts: null, images: null,
    accessTier: "teaser", blindStaleAt: null, blindTitle: null, aiTask: null, contentHistory: null, ddStaleAt: null,
    createdAt: new Date(), updatedAt: new Date(), ...p,
  } as CimSection;
}
const override = (s: CimSection, mode: "blind" | "dd"): CimSectionOverride => ({
  id: `o-${mode}-${s.id}`, dealId: "d1", cimSectionId: s.id, mode,
  layoutData: { body: `${mode} body ${s.id}` }, contentOverride: `${mode} text ${s.id}`, createdAt: new Date(),
} as unknown as CimSectionOverride);

const open = section({ sectionTitle: "Overview" });
const gated = section({ sectionTitle: "Financial detail", accessTier: "full", blindTitle: "Financial detail" });
const sections = [open, gated];
const blind = sections.map((s) => override(s, "blind"));
const dd = sections.map((s) => override(s, "dd"));

console.log("teaser_only");

test("a Teaser link gets nothing — whatever rows the caller passes (blind, named or DD)", () => {
  for (const overrides of [blind, dd, []]) {
    const out = buildBuyerCim({ deal, accessLevel: "teaser_only", sections, overrides });
    assert.deepEqual(out.sections, []);
    assert.equal(out.preparing, false, "never the 'preparing' state either (it would start a redaction)");
    assert.equal(out.heldBack, 0);
    assert.deepEqual(out.leaked, []);
    assert.equal(out.mode, "blind", "fail-closed second lock");
  }
});

test("unknown, empty or missing levels read as a Teaser link: nothing", () => {
  for (const level of [null, undefined, "", "admin", "LOI"]) {
    assert.deepEqual(buildBuyerCim({ deal, accessLevel: level as any, sections, overrides: blind }).sections, [], String(level));
  }
});

console.log("CIM levels");

test("legacy teaser and full, and blind: the whole Blind CIM, no locked stubs (even a section an old CIM marked full)", () => {
  for (const level of ["teaser", "full", "blind"]) {
    const out = buildBuyerCim({ deal, accessLevel: level, sections, overrides: blind });
    assert.equal(out.mode, "blind", level);
    assert.deepEqual(out.sections.map((s) => s.id), [open.id, gated.id], level);
    assert.ok(out.sections.every((s) => !s.locked && s.layoutType !== "locked"), `${level}: no stubs`);
    assert.ok(out.sections.every((s) => /^s_/.test(s.sectionKey)), `${level}: neutral keys`);
    assert.ok(!/named body|named draft/.test(JSON.stringify(out.sections)), `${level}: redacted versions only`);
  }
});

test("loi and named: the named CIM", () => {
  for (const level of ["loi", "named"]) {
    const out = buildBuyerCim({ deal, accessLevel: level, sections, overrides: [] });
    assert.equal(out.mode, "normal", level);
    assert.deepEqual(out.sections.map((s) => s.sectionKey), [open.sectionKey, gated.sectionKey]);
    assert.match(JSON.stringify(out.sections), /named draft/);
  }
});

test("due_diligence: the DD versions", () => {
  const out = buildBuyerCim({ deal, accessLevel: "due_diligence", sections, overrides: dd });
  assert.equal(out.mode, "dd");
  assert.match(JSON.stringify(out.sections), /dd text/);
});

console.log("the review hold");

test("a Teaser link isn't a buyer who can open the CIM; a row of unknown level still counts (safe side)", () => {
  const live = { revokedAt: null, expiresAt: null };
  assert.equal(openBuyerLinks([{ ...live, accessLevel: "teaser_only" }] as any), 0);
  assert.equal(openBuyerLinks([{ ...live, accessLevel: "blind" }, { ...live, accessLevel: "loi" }, { ...live, accessLevel: "teaser" }] as any), 3);
  assert.equal(openBuyerLinks([{ ...live }] as any), 1, "no level known → counted");
  assert.equal(openBuyerLinks([{ ...live, accessLevel: "junk" }] as any), 1, "unreadable → counted");
});

console.log(`\n${passed} passed`);
