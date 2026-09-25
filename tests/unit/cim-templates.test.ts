/**
 * Unit checks for CIM templates and branding — no database, no AI, no network.
 *   npx tsx tests/unit/cim-templates.test.ts
 *
 * Covers the built-in templates, token sanitising, theme resolution
 * (template → brokerage → business, Blind never gets business branding),
 * the contrast guard, the CSS variables, the section-outline cleaner and
 * the outline instructions the layout engine gives the planner.
 */
import assert from "node:assert/strict";
import {
  BUILTIN_TEMPLATES,
  DEFAULT_TEMPLATE_ID,
  EMPTY_BROKERAGE,
  brandColorToHex,
  contrastRatio,
  ensureContrast,
  getBuiltinTemplate,
  googleFontHref,
  resolveCimTheme,
  sanitizeBusinessBranding,
  sanitizeOutline,
  sanitizeTokens,
  themeCssVars,
} from "../../shared/cim-theme";
import { outlineInstructions } from "../../server/cim/layout-engine";

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

console.log("built-in templates");
test("five distinct built-ins, Classic Paper is the default", () => {
  assert.equal(BUILTIN_TEMPLATES.length, 5);
  assert.equal(DEFAULT_TEMPLATE_ID, "classic-paper");
  const looks = new Set(BUILTIN_TEMPLATES.map((t) => `${t.tokens.coverStyle}/${t.tokens.headerStyle}/${t.tokens.headingFont}/${t.tokens.paper}`));
  assert.equal(looks.size, 5, "each built-in differs in cover, headings, fonts or paper");
  for (const t of BUILTIN_TEMPLATES) {
    assert.ok(t.tokens.chart.length >= 6, `${t.id} has ≥6 chart colours`);
    assert.deepEqual(sanitizeTokens(t.tokens), t.tokens, `${t.id} tokens are already clean`);
    assert.ok(googleFontHref(t.tokens.headingFont), `${t.id} heading font is loadable`);
  }
});
test("Classic Paper keeps today's paper palette", () => {
  const c = getBuiltinTemplate("classic-paper")!.tokens;
  assert.equal(c.paper, "#fbf8f2");
  assert.equal(c.ink, "#201d18");
  assert.equal(c.accent, "#9e752e");
  assert.equal(c.coverStyle, "dark");
  assert.equal(c.headerStyle, "plain");
  assert.equal(c.radius, 8);
});

console.log("token sanitising");
test("garbage is replaced from the base, never stored", () => {
  const t = sanitizeTokens({ accent: "red", radius: 99, headingFont: "Comic Sans", coverStyle: "neon", chart: ["#123456", "x"], headingWeight: 950, evil: "<script>" });
  const base = getBuiltinTemplate("classic-paper")!.tokens;
  assert.equal(t.accent, base.accent);
  assert.equal(t.radius, 20);
  assert.equal(t.headingFont, base.headingFont);
  assert.equal(t.coverStyle, base.coverStyle);
  assert.equal(t.chart[0], "#123456");
  assert.ok(t.chart.length >= 6);
  assert.ok(t.headingWeight <= 800, "snapped to a weight the font has");
  assert.equal((t as any).evil, undefined);
});
test("short hex and legacy HSL brand colours are understood", () => {
  assert.equal(brandColorToHex("#abc"), "#aabbcc");
  assert.equal(brandColorToHex("218 70% 47%"), "#2461cc");
  assert.equal(brandColorToHex("blue"), null);
});

console.log("theme resolution");
const navy = getBuiltinTemplate("executive-navy")!.tokens;
const brokerage = { ...EMPTY_BROKERAGE, firmName: "Harbour & Pine", useBrandColors: true, primaryColor: "#0b6e4f", accentColor: "#e0a458" };
const business = { logoMediaId: "11111111-1111-4111-8111-111111111111", coverPhotoMediaId: "22222222-2222-4222-8222-222222222222", useBusinessColors: true, primaryColor: "#14788c", accentColor: "#f2a65a" };
test("no branding → the template's own colours", () => {
  const t = resolveCimTheme({ tokens: navy });
  assert.equal(t.accent, navy.accent);
  assert.deepEqual(t.chart, navy.chart);
});
test("brokerage colours apply only when switched on", () => {
  assert.equal(resolveCimTheme({ tokens: navy, brokerage: { ...brokerage, useBrandColors: false } }).accent, navy.accent);
  const on = resolveCimTheme({ tokens: navy, brokerage });
  assert.equal(on.accent, "#0b6e4f");
  assert.equal(on.chart[0], "#0b6e4f");
});
test("business colours and cover photo win in named CIMs", () => {
  const t = resolveCimTheme({ tokens: navy, brokerage, business, mode: "normal", hasCoverPhoto: true });
  assert.equal(t.accent, "#14788c");
  assert.equal(t.coverStyle, "photo");
});
test("the Blind CIM never uses the business's branding", () => {
  const t = resolveCimTheme({ tokens: navy, brokerage, business, mode: "blind", hasCoverPhoto: true });
  assert.equal(t.accent, "#0b6e4f", "brokerage colour, not the business's");
  assert.notEqual(t.coverStyle, "photo");
  const photoTpl = resolveCimTheme({ tokens: { ...navy, coverStyle: "photo" }, mode: "blind", hasCoverPhoto: true });
  assert.equal(photoTpl.coverStyle, "dark", "photo template falls back to dark in Blind");
});
test("a too-light brand colour is darkened until it reads on the paper", () => {
  const t = resolveCimTheme({ tokens: navy, brokerage: { ...brokerage, primaryColor: "#ffe9a8" } });
  assert.ok(contrastRatio(t.accent, navy.paper) >= 3);
  assert.ok(contrastRatio(t.accentText, navy.paper) >= 4.5);
  assert.ok(t.adjustments.length > 0);
  assert.equal(ensureContrast("#000000", "#ffffff", 4.5).adjusted, false);
});
test("the dark cover accent is visible on the cover", () => {
  for (const tpl of BUILTIN_TEMPLATES) {
    const t = resolveCimTheme({ tokens: tpl.tokens, brokerage });
    if (t.coverStyle === "dark") assert.ok(contrastRatio(t.coverAccent, t.coverBg) >= 3, tpl.id);
    assert.ok(contrastRatio(t.coverInk, t.coverStyle === "light" ? t.paper : t.coverBg) >= 4.5, `${tpl.id} cover text`);
  }
});
test("CSS variables cover every token the paper reads", () => {
  const vars = themeCssVars(resolveCimTheme({ tokens: navy }));
  for (const k of ["--cimt-paper", "--cimt-ink", "--cimt-accent", "--cimt-accent-muted", "--cimt-accent2", "--cimt-positive", "--cimt-negative", "--cimt-font-body", "--cimt-font-heading", "--cimt-radius", "--cimt-gap", "--cimt-chart-1"]) {
    assert.ok(vars[k], k);
  }
  assert.match(vars["--cimt-paper"], /^\d+ \d+% \d+%$/);
});
test("business branding input is cleaned", () => {
  const b = sanitizeBusinessBranding({ logoMediaId: "../../etc/passwd", primaryColor: "javascript:", useBusinessColors: "yes" });
  assert.equal(b.logoMediaId, null);
  assert.equal(b.primaryColor, null);
  assert.equal(b.useBusinessColors, false);
});

console.log("section outline (Match my existing CIM)");
test("outline keeps titled sections only, capped and trimmed", () => {
  const o = sanitizeOutline({ sections: [{ title: "  Executive   Summary " }, { title: "" }, { notes: "x" }, { title: "Terms", layoutHint: "two_column" }], toneNotes: "Concise." });
  assert.deepEqual(o?.sections.map((s) => s.title), ["Executive Summary", "Terms"]);
  assert.equal(o?.toneNotes, "Concise.");
  assert.equal(sanitizeOutline({ sections: [] }), null);
});
test("the planner is told to follow it, minus the brokerage pages", () => {
  const text = outlineInstructions({ sections: [{ title: "Confidentiality Notice" }, { title: "Executive Summary" }, { title: "Terms of Sale" }, { title: "Contact" }] });
  assert.match(text, /HOUSE STRUCTURE/);
  assert.match(text, /1\. Executive Summary/);
  assert.match(text, /2\. Terms of Sale/);
  assert.doesNotMatch(text, /Confidentiality Notice|\d\. Contact/);
  assert.equal(outlineInstructions(null), "");
});

console.log(`\n${passed} checks passed`);
