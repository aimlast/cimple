/**
 * Blind-CIM / buyer-confidentiality checks — no database, no AI.
 *   npx tsx tests/unit/blind-confidentiality.test.ts
 *
 * Proves the fail-closed rules from the 2026-09-25 review:
 *   1. The identity guard (shared/blind-guard.ts) finds the business name,
 *      people, the city and street — and leaves role labels and provinces alone.
 *   2. The redactor never returns partially redacted text: a cut-off,
 *      malformed or incomplete reply, or a result that still names someone,
 *      is a failure (the section is held back), never a naive-scrub copy.
 *   3. The view-room rules (buildBuyerCim) hold back a blind section that
 *      still names something identifying, and serve only neutral keys.
 *   4. One NDA rule for every buyer path (ndaBlocksBuyer).
 *   5. Q&A answers are shared only within their scope, and never with a
 *      Blind reader when they name the business (shared/buyer-qa-scope.ts).
 */
import assert from "node:assert/strict";
import { blindLeakTerms, findBlindLeaks, honorificNames } from "../../shared/blind-guard";
import { blindSectionKey, buildBuyerCim, ndaBlocksBuyer, realSectionKeyMap } from "../../shared/cim-buyer-view";
import { askerScope, readerMaySeeRow, rowScope } from "../../shared/buyer-qa-scope";
import {
  RedactionFailedError,
  generateBlindOverrides,
  redactOneSection,
  redactionMaxTokens,
  setRedactionModelForTests,
  type RedactionModel,
} from "../../server/cim/redaction-engine";
import type { CimSection, CimSectionOverride } from "../../shared/schema";

let passed = 0;
const pending: Promise<void>[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  const run = async () => {
    try {
      await fn();
      passed++;
      console.log(`  ✓ ${name}`);
    } catch (err) {
      console.error(`  ✗ ${name}`, err);
      throw err;
    }
  };
  pending.push(pending.length ? pending[pending.length - 1].then(run) : run());
}

// The QA dental deal's facts, as the interview and documents record them.
const deal = {
  id: "d1",
  businessName: "QA CIMGEN — Harbourline Dental",
  industry: "Dental practice",
  blindCodename: "Project Atlas",
  ndaRequired: true,
  extractedInfo: {
    companyName: "Harbourline Dental Group",
    ownerName: "Dr. Patel",
    keyEmployees:
      "Dr. Anita Patel (principal dentist), Dr. Marcus Lee (associate dentist, 6 years), Sandra (office manager, since 2013)\nDr. A. Patel",
    officeManager: "Maria, 9 years tenure, runs day-to-day operations",
    hygienistDetails: "Two hygienists: Priya (7 years tenure), Sam (2 years tenure). Neither has indicated plans to leave.",
    employees: "9 people\nMultiple (associate dentist fees $425,000, hygienist & staff wages $471,000 in FY2025)",
    accountantContact: "Jennifer Walsh at Walsh & Associates CPA in Waterloo",
    leaseAddress: "Unit 4, 210 Fairway Road South, Kitchener, Ontario N2C 1X1",
    locations: "Kitchener, ON\nPlaza on Fairway Road",
    contactPhone: "519-555-0142",
    ownerSalary: "$180,000",
    keyFacts: "2,650 sq ft dental space, lease expires May 31 2029",
  },
};
const terms = blindLeakTerms(deal, { codename: deal.blindCodename });
const termText = terms.map((t) => t.text);

// ── 1. Identity guard ────────────────────────────────────────────────────
console.log("identity guard");

test("collects business names, people, city, street, postal code and phone from the facts", () => {
  for (const t of ["Harbourline Dental Group", "Harbourline Dental", "Anita Patel", "Patel", "Marcus Lee", "Sandra", "Maria", "Priya", "Jennifer Walsh", "Kitchener", "Fairway", "N2C 1X1", "519-555-0142"]) {
    assert.ok(termText.includes(t), `missing term ${t}: ${termText.join(" | ")}`);
  }
  for (const t of ["Ontario", "ON", "Multiple", "Two", "Office Manager", "Project Atlas"]) {
    assert.ok(!termText.includes(t), `must not be a term: ${t}`);
  }
});

test("finds identifiers in any form the text uses them", () => {
  const hit = (s: string) => findBlindLeaks(s, terms);
  const owner = hit("Founded by Dr. Anita Patel in 2011.");
  assert.ok(owner.includes("Anita Patel") && owner.includes("Patel"), owner.join(","));
  assert.ok(hit("Dr. Patel will stay for a 12-month transition.").includes("Patel"), "a variant of the owner's name");
  assert.ok(hit("The clinic in Kitchener, Ontario").includes("Kitchener"));
  assert.ok(hit("located on Fairway Rd").includes("Fairway"));
  assert.ok(hit("HARBOURLINE DENTAL GROUP's patients").length > 0, "business names match in any case");
  assert.ok(hit("call (519) 555-0142").length > 0);
  assert.ok(hit("Maria has run the front desk").includes("Maria"));
  assert.ok(hit({ nested: [{ label: "Office Manager: Sandra" }] }).includes("Sandra"), "walks layoutData");
});

test("clean blind text passes — roles, province, codename, figures", () => {
  const clean =
    "Project Atlas is a dental practice in a major metropolitan area in Ontario, Canada. The Owner (principal dentist) " +
    "works with an Associate Dentist, two hygienists and an Office Manager with 9 years' tenure. Revenue $2,013,000; " +
    "the practice operates from a suburban plaza with 12 parking spaces. We hope to find a successor. Multiple revenue streams.";
  assert.deepEqual(findBlindLeaks(clean, terms), []);
});

test("honorific names are read from a section's own text", () => {
  assert.deepEqual(honorificNames("Led by Dr. Marcus Lee and Mrs. O'Neil").sort(), ["Lee", "Marcus Lee", "O'Neil"].sort());
});

// ── 2. Redactor fails closed ─────────────────────────────────────────────
console.log("redactor");

function section(p: Partial<CimSection>): CimSection {
  return {
    id: p.id ?? `s_${Math.random().toString(36).slice(2, 10)}`,
    dealId: "d1",
    sectionKey: "reason_for_sale",
    sectionTitle: "Reason for Sale",
    order: 1,
    layoutType: "prose_highlight",
    layoutData: {},
    aiDraftContent: "Dr. Anita Patel is retiring from the Kitchener practice at 210 Fairway Road South.",
    aiLayoutReasoning: null,
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
const reply = (obj: unknown, stopReason = "end_turn") => ({ text: typeof obj === "string" ? obj : JSON.stringify(obj), stopReason });
function scripted(...replies: Array<ReturnType<typeof reply>>): { model: RedactionModel; calls: Array<{ prompt: string; maxTokens: number }> } {
  const calls: Array<{ prompt: string; maxTokens: number }> = [];
  let i = 0;
  return {
    calls,
    model: async (prompt, maxTokens) => {
      calls.push({ prompt, maxTokens });
      return replies[Math.min(i++, replies.length - 1)];
    },
  };
}
const CLEAN = { sectionTitle: "Reason for Sale", layoutData: {}, contentOverride: "The Owner is retiring after 14 years." };

async function rejects(p: Promise<unknown>, re: RegExp) {
  await assert.rejects(p, (err: unknown) => err instanceof RedactionFailedError && re.test((err as Error).message));
}

test("a reply cut off at the token limit is a failure, never a naive scrub", async () => {
  const cut = scripted(reply('{"sectionTitle":"Reason for Sale","layoutData":{},"contentOverride":"The Owner is ret', "max_tokens"));
  setRedactionModelForTests(cut.model);
  await rejects(redactOneSection(section({}), deal, "Project Atlas"), /too long/);
  assert.equal(cut.calls.length, 2, "retried once with a bigger budget");
  assert.ok(cut.calls[1].maxTokens > cut.calls[0].maxTokens);
});

test("malformed JSON or no JSON is a failure", async () => {
  setRedactionModelForTests(scripted(reply("Sure! Here is the redacted section: {not json}")).model);
  await rejects(redactOneSection(section({}), deal, "Project Atlas"), /not valid JSON/);
  setRedactionModelForTests(scripted(reply("I can't do that.")).model);
  await rejects(redactOneSection(section({}), deal, "Project Atlas"), /no JSON/);
});

test("a reply missing the section text is a failure (never the raw text)", async () => {
  setRedactionModelForTests(scripted(reply({ sectionTitle: "Reason for Sale", layoutData: {} })).model);
  await rejects(redactOneSection(section({}), deal, "Project Atlas"), /left out the section text/);
});

test("a result that still names the owner, city or street is rejected after one corrective retry", async () => {
  const leaky = { ...CLEAN, contentOverride: "Dr. Anita Patel is retiring from the practice in Kitchener." };
  const run = scripted(reply(leaky), reply(leaky));
  setRedactionModelForTests(run.model);
  await rejects(redactOneSection(section({}), deal, "Project Atlas"), /still named/);
  assert.equal(run.calls.length, 2);
  assert.match(run.calls[1].prompt, /previous attempt was rejected[\s\S]*Kitchener/);
});

test("a corrected second attempt is accepted", async () => {
  const run = scripted(reply({ ...CLEAN, contentOverride: "Maria will stay on." }), reply(CLEAN));
  setRedactionModelForTests(run.model);
  const r = await redactOneSection(section({}), deal, "Project Atlas");
  assert.equal(r.contentOverride, CLEAN.contentOverride);
});

test("a narrative's body is sent once, and restored from the redacted text", async () => {
  const body = "Dr. Anita Patel founded the practice. ".repeat(40);
  const s = section({ aiDraftContent: null, layoutData: { body, pullQuote: "Care first" } });
  const run = scripted(reply({ sectionTitle: "Our Story", layoutData: { body: "[[SAME AS CONTENT TEXT]]", pullQuote: "Care first" }, contentOverride: "The Owner founded the practice." }));
  setRedactionModelForTests(run.model);
  const r = await redactOneSection(s, deal, "Project Atlas");
  assert.equal(run.calls[0].prompt.split("Dr. Anita Patel founded the practice.").length - 1, 40, "prose appears once, not twice");
  assert.equal(r.layoutData.body, "The Owner founded the practice.");
  assert.equal(r.layoutData.pullQuote, "Care first");
});

test("the output budget grows with the section", () => {
  assert.equal(redactionMaxTokens(1000), 4096);
  assert.ok(redactionMaxTokens(60_000) >= 20_000);
  assert.equal(redactionMaxTokens(10_000_000), 32_000);
});

test("whole-CIM generation keeps going past a failed section and reports it", async () => {
  const good = section({ id: "good" });
  const bad = section({ id: "bad", aiDraftContent: "Sandra runs the desk." });
  setRedactionModelForTests(async (prompt) =>
    prompt.includes("Sandra runs the desk") ? reply("{oops", "end_turn") : reply(CLEAN));
  const out = await generateBlindOverrides([good, bad], deal, { codename: "Project Atlas" });
  assert.deepEqual(out.overrides.map((o) => o.cimSectionId), ["good"]);
  assert.deepEqual(out.failures.map((f) => f.cimSectionId), ["bad"]);
  setRedactionModelForTests(null);
});

// ── 3. View-room rules ───────────────────────────────────────────────────
console.log("view room");

function override(s: CimSection, contentOverride: string, layoutData: unknown = {}): CimSectionOverride {
  return { id: `o_${s.id}`, dealId: "d1", cimSectionId: s.id, mode: "blind", layoutData, contentOverride, createdAt: new Date() } as CimSectionOverride;
}

test("a blind section whose redaction still names someone is held back and reported", () => {
  const ok = section({ id: "ok-1", sectionKey: "overview" });
  const leak = section({ id: "leak-1", sectionKey: "team" });
  const cityInData = section({ id: "leak-2", sectionKey: "location", layoutType: "metric_grid" });
  const out = buildBuyerCim({
    deal,
    accessLevel: "teaser",
    sections: [ok, leak, cityInData],
    overrides: [
      override(ok, "The Owner is retiring."),
      override(leak, "Dr. Marcus Lee will stay on."),
      override(cityInData, "", { metrics: [{ label: "City", value: "Kitchener" }] }),
    ],
  });
  assert.deepEqual(out.sections.map((s) => s.id), ["ok-1"]);
  assert.deepEqual(out.leaked.sort(), ["leak-1", "leak-2"]);
  assert.equal(out.heldBack, 2);
  assert.ok(!/Lee|Kitchener/.test(JSON.stringify(out.sections)));
});

test("blind keys are always neutral — never the title slug — and map back for analytics", () => {
  const a = section({ id: "aaaaaaaa-1111-2222-3333-444444444444", sectionKey: "kitchener_clinic_team", sectionTitle: "Kitchener Clinic Team", blindTitle: "Clinic Team" });
  const b = section({ id: "bbbbbbbb-1111-2222-3333-444444444444", sectionKey: "our_kitchener_clinic_photos", accessTier: "full", blindTitle: "Clinic Photos" });
  const c = section({ id: "cccccccc-1111-2222-3333-444444444444", sectionKey: "overview" });
  const out = buildBuyerCim({
    deal,
    accessLevel: "teaser",
    sections: [a, b, c],
    overrides: [override(a, "The team."), override(b, "Photos."), override(c, "Overview.", { relatedSections: ["kitchener_clinic_team", "our_kitchener_clinic_photos"] })],
  });
  assert.deepEqual(out.sections.map((s) => s.sectionKey), [blindSectionKey(a.id), blindSectionKey(b.id), blindSectionKey(c.id)]);
  // Per-section locks are retired: a legacy "teaser" link is a Blind CIM link
  // and gets every section — even one an old CIM marked "Full access only".
  assert.ok(!out.sections[1].locked, "no locked stub any more");
  assert.equal(out.sections[1].layoutType, b.layoutType);
  assert.ok(!/kitchener/i.test(JSON.stringify(out)), "no city anywhere in the payload");
  assert.deepEqual((out.sections[2].layoutData as any).relatedSections, [blindSectionKey(a.id), blindSectionKey(b.id)], "links follow (both targets are served)");
  const back = realSectionKeyMap([a, b, c]);
  assert.equal(back.get(out.sections[0].sectionKey), "kitchener_clinic_team");
});

test("Full CIM (named; legacy loi) buyers keep real keys and content", () => {
  const a = section({ sectionKey: "reason_for_sale" });
  for (const level of ["loi", "named"]) {
    const out = buildBuyerCim({ deal, accessLevel: level, sections: [a], overrides: [] });
    assert.equal(out.mode, "normal");
    assert.equal(out.sections[0].sectionKey, "reason_for_sale");
    assert.deepEqual(out.leaked, []);
  }
});

test("a Teaser link (teaser_only) gets no CIM section at all", () => {
  const a = section({ sectionKey: "reason_for_sale" });
  const out = buildBuyerCim({ deal, accessLevel: "teaser_only", sections: [a], overrides: [override(a, "The Owner is retiring.")] });
  assert.deepEqual(out.sections, []);
  assert.equal(out.preparing, false);
});

// ── 4. NDA ───────────────────────────────────────────────────────────────
console.log("NDA");

test("one NDA rule: required + unsigned blocks, anything else passes", () => {
  assert.equal(ndaBlocksBuyer({ ndaRequired: true }, { ndaSigned: false }), true);
  assert.equal(ndaBlocksBuyer({ ndaRequired: true }, { ndaSigned: null }), true);
  assert.equal(ndaBlocksBuyer({ ndaRequired: true }, { ndaSigned: true }), false);
  assert.equal(ndaBlocksBuyer({ ndaRequired: false }, { ndaSigned: false }), false);
});

// ── 5. Q&A scope ─────────────────────────────────────────────────────────
console.log("Q&A scope");

// Legacy keys on purpose: "teaser" and "full" are Blind CIM links, "loi" a Full CIM link.
const teaser = { id: "t1", accessLevel: "teaser" };
const full = { id: "f1", accessLevel: "full" };
const loi = { id: "l1", accessLevel: "loi" };
const teaserOnly = { id: "s1", accessLevel: "teaser_only" };
const qa = (p: Record<string, unknown>) => ({ buyerAccessId: "x", question: "How many vans?", aiAnswer: "14 vans.", publishedAnswer: "14 vans.", ...p });

test("answer scope follows the asker's level", () => {
  assert.equal(askerScope("teaser"), "all", "legacy teaser = Blind CIM");
  assert.equal(askerScope("full"), "all", "legacy full = Blind CIM (no section was ever locked)");
  assert.equal(askerScope("blind"), "all");
  assert.equal(askerScope("loi"), "private");
  assert.equal(askerScope("named"), "private");
  assert.equal(askerScope("due_diligence"), "private");
  assert.equal(askerScope("teaser_only"), "private", "a Teaser link never asks; narrowest if judged");
  assert.equal(askerScope(null), "private", "unknown = Teaser = narrowest");
});

test("an answer nobody approved is the asker's alone — whatever its scope", () => {
  const row = qa({ answerScope: "all", buyerAccessId: "t2", question: "We're Apex Mechanical — how many contracts?" });
  assert.equal(readerMaySeeRow(row, "all", teaser, terms), false);
  assert.equal(readerMaySeeRow(row, "all", full, terms), false);
  assert.equal(readerMaySeeRow(row, "all", loi, terms), false);
  assert.equal(readerMaySeeRow(row, "all", { id: "t2", accessLevel: "teaser" }, terms), true, "the asker");
  assert.equal(readerMaySeeRow({ ...row, brokerDraft: "14 vans." }, "all", teaser, terms), true, "broker adopted it");
  assert.equal(readerMaySeeRow({ ...row, sellerApproved: true }, "all", teaser, terms), true, "seller approved it");
  assert.equal(readerMaySeeRow({ ...row, sellerApproved: true }, "all", teaserOnly, terms), false, "a Teaser link reads no Q&A");
  assert.equal(readerMaySeeRow({ ...row, buyerAccessId: "s1" }, "all", teaserOnly, terms), false, "not even its own (it quotes the CIM)");
});

test("a historical full-scope answer reaches every CIM buyer (no section was ever locked), never a Teaser link", () => {
  const row = qa({ answerScope: "full", buyerAccessId: "f2", brokerDraft: "14 vans." });
  assert.equal(readerMaySeeRow(row, rowScope(row, "full"), teaser, terms), true, "legacy teaser = Blind CIM");
  assert.equal(readerMaySeeRow(row, rowScope(row, "full"), full, terms), true);
  assert.equal(readerMaySeeRow(row, rowScope(row, "full"), loi, terms), true);
  assert.equal(readerMaySeeRow(row, rowScope(row, "full"), teaserOnly, terms), false);
});

test("a named-CIM answer is only ever the asker's", () => {
  const row = qa({ answerScope: "private", buyerAccessId: "l2" });
  assert.equal(readerMaySeeRow(row, "private", loi, terms), false);
  assert.equal(readerMaySeeRow(row, "private", { id: "l2", accessLevel: "loi" }, terms), true);
});

test("a Blind reader never gets a question or answer that names the business — even a broker-published one", () => {
  const row = qa({ answerScope: "all", question: "What is the revenue of Harbourline Dental Group in Kitchener?", sellerApproved: true });
  assert.equal(readerMaySeeRow(row, "all", teaser, terms), false);
  assert.equal(readerMaySeeRow(row, "all", full, terms), false);
  assert.equal(readerMaySeeRow(row, "all", loi, terms), true, "named buyers already know the name");
});

test("rows from before scopes existed are judged conservatively", () => {
  assert.equal(rowScope(qa({ answerScope: null }), "teaser"), "all");
  assert.equal(rowScope(qa({ answerScope: null }), "full"), "all");
  assert.equal(rowScope(qa({ answerScope: null }), "loi"), "private");
  assert.equal(rowScope(qa({ answerScope: null }), false), "full", "unknown asker → CIM buyers only (never a Teaser link)");
  assert.equal(rowScope(qa({ answerScope: null, sellerApproved: true }), "loi"), "all", "broker/seller-published");
});

Promise.all(pending).then(
  () => console.log(`\n${passed} checks passed`),
  () => process.exit(1),
);
