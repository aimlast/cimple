/**
 * Round 2 of the smoke-test follow-ups (the independent check of
 * fix/smoke-followups):
 *   1 — a long source's business facts keep real sentences that merely name a
 *       list and a range ("14 trucks from 2016 to 2023 model years"). (Round 3:
 *       no fact sentence is dropped at all — row-range prose only stays out
 *       of the combined summary; see smoke-followups-r3.)
 *   2 — "Part 2 of the lease requires…" is a fact, not a part label: only the
 *       reader's own "Part N of M" is stripped.
 *   3 — a live CIM approved before the per-section rule doesn't look
 *       unapproved; a change after publishing still needs approving.
 *   4 — the deal list / dashboard next step and the Overview checklist use the
 *       same approval rule as the Overview's publish card.
 *   5 — the legacy POST /api/deals/:dealId/sections can't set approvals and
 *       goes through the same rule as the builder's "Add section".
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/smoke-followups-r2.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  combineExtractions,
  combinePartSummaries,
  isRowRangeDescription,
  stripPartLabel,
} from "../../server/documents/extractor";
import {
  PER_SECTION_APPROVAL_SINCE,
  legacyLiveApprovedIds,
  publishReadiness,
  sectionsAwaitingApproval,
} from "../../shared/cim-approvals";
import { computeNextStep, phaseChecklist, designApprovalState } from "../../shared/deal-progress";
import { CIM_FALLBACK_REASONING } from "../../shared/cim-layouts";
import { legacySectionInsert } from "../../server/cim/approvals";

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}`);
    throw err;
  }
}
const read = (p: string) => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

// ── 1 ──────────────────────────────────────────────────────────────────────
console.log("1 — real facts that name a list and a range are kept");

// The checker's sentences: real business facts (must keep).
const MUST_KEEP = [
  "Fleet list includes 14 trucks from 2016 to 2023 model years.",
  "Serves a client list of 450 households between Oakville and Burlington.",
  "The company's supplier list includes vendors from Ontario and Quebec.",
  "Maintains a register of licensed technicians ranging from apprentices to master electricians.",
  "Waiting list of 120 patients drawn from Mississauga and Brampton.",
  // Findings about records, and a count of what the records are.
  "Maintenance records from 2016 to 2023 show no major engine failures.",
  "Includes 450 customer records from 2019 to 2024.",
  "Ledger entries between 2022 and 2024 were reconciled monthly by the bookkeeper.",
];
// Recorded in S3 (Lakeshore clone, Comfort Club export read in 5 parts): must drop.
const PARTS = [
  "Part 2 of 5 of a customer membership database showing member IDs CC-10620 through CC-11280, with membership tiers (Silver/Gold), billing types (Monthly/Annual prepaid), pricing ($22.95 or $32.95), locations across Hamilton region, join dates from May 2018 through March 2021, status, and most recent activity dates through March 2025.",
  "Customer list showing Comfort Club memberships with subscription IDs, membership tiers (Silver/Gold), billing frequencies (Monthly/Annual), pricing ($22.95 Silver, $32.95 Gold), locations across Hamilton region, join dates from February 2021 through February 2023, acquisition channels (all Organic), membership statuses, and last payment dates through March 2025.",
  "Part 4 of customer membership database showing individual customer records from February 2023 through November 2023, including a large acquisition book from Pembury Furnace Services dated July 1, 2023. Records include membership ID, tier (Silver/Gold), billing type (Monthly/Annual prepaid), pricing, location, acquisition source, status, and customer age category.",
  "Part 5 of customer database showing member records from November 2023 through March 2025, including membership tier (Silver/Gold), billing frequency (Monthly/Annual prepaid), pricing, location, join date, status, and last activity dates.",
];
const MUST_DROP = [
  ...PARTS,
  "Customer membership records from February 2023 through November 2023.",
  "Member records CC-11264 through CC-11929.",
  "Rows 1 to 500 of the customer export.",
];

await test("the checker's sentences are not row-range prose; the recorded S3 ones are", () => {
  for (const s of MUST_KEEP) assert.equal(isRowRangeDescription(s), false, s);
  for (const s of MUST_DROP) assert.equal(isRowRangeDescription(s), true, s.slice(0, 70));
});

// Round 3: withoutRowRangeProse (the fact-dropping) was removed — a fact
// only loses an exact "Part N of M" label. This test used to also assert
// withoutRowRangeProse("Member records CC-11264 through CC-11929.") === ""
// (the fact-deletion behaviour); a fact is now kept as written.
await test("a fact keeps every must-keep sentence word for word (and a row-range sentence too)", () => {
  for (const s of MUST_KEEP) assert.equal(stripPartLabel(s, { total: 5, lead: false }), s);
  const joined = combineExtractions([{ summary: PARTS[0], note: MUST_KEEP.join(" ") } as any, { summary: PARTS[3] } as any]);
  assert.equal(joined.note, MUST_KEEP.join(" "));
  assert.equal(stripPartLabel("Member records CC-11264 through CC-11929.", { total: 5, lead: false }), "Member records CC-11264 through CC-11929.");
});

await test("combineExtractions keeps the facts of a multi-part source (a normal part and a row-only part)", () => {
  const facts = {
    fleetDescription: MUST_KEEP[0],
    customerBase: MUST_KEEP[1],
    supplierBase: MUST_KEEP[2],
    licensing: MUST_KEEP[3],
    patientWaitlist: MUST_KEEP[4],
    maintenanceHistory: MUST_KEEP[5],
  };
  // In a part that says what the source is.
  const a = combineExtractions([{ summary: "Fleet and customer overview as at March 31, 2025, with 2,900 active members.", ...facts } as any, { summary: PARTS[3] } as any]);
  for (const [k, v] of Object.entries(facts)) assert.equal(a[k], v, k);
  // In a row-only part: still kept (only row-range sentences are dropped there).
  const b = combineExtractions([{ summary: PARTS[0] } as any, { summary: PARTS[2], ...facts } as any]);
  for (const [k, v] of Object.entries(facts)) assert.equal(b[k], v, k);
});

await test("every part keeps its facts as written, a row-only part too (round 3)", () => {
  const sentence = "Customer membership records from February 2023 through November 2023.";
  const rowPart = combineExtractions([{ summary: PARTS[2], customerBase: `${sentence} Major customer book acquired from Pembury Furnace Services on July 1, 2023.` } as any, { summary: PARTS[3] } as any]);
  // Round 3: kept word for word. This assertion used to expect the row-range
  // sentence dropped from a row-only part's fact (the fact-deletion
  // behaviour the integrator removed).
  assert.equal(rowPart.customerBase, `${sentence} Major customer book acquired from Pembury Furnace Services on July 1, 2023.`);
  const headlinePart = combineExtractions([
    { summary: "Lakeshore Comfort Club report as at March 31, 2025: 2,900 active members, $75,835 MRR.", customerBase: sentence } as any,
    { summary: PARTS[3] } as any,
  ]);
  assert.equal(headlinePart.customerBase, sentence);
});

// ── 2 ──────────────────────────────────────────────────────────────────────
console.log("2 — only the reader's own 'Part N of M' labels are stripped");

await test("'Part N of the <thing>' in a fact or a summary is left alone", () => {
  const lease = "Part 2 of the lease requires the tenant to pay property taxes.";
  assert.equal(stripPartLabel(lease), lease);
  assert.equal(stripPartLabel(lease, { lead: true, part: 2 }), lease, "even in part 2's own summary");
  assert.equal(stripPartLabel("Part 3 of Schedule A sets out the equipment list."), "Part 3 of Schedule A sets out the equipment list.");
  // keyFacts are joined through stripPartLabel: the lease fact survives the combine.
  const c = combineExtractions([{ keyFacts: lease } as any, { keyFacts: "Landlord consent is needed to assign." } as any]);
  assert.equal(c.keyFacts, "Part 2 of the lease requires the tenant to pay property taxes; Landlord consent is needed to assign");
  const s = combineExtractions([{ summary: lease } as any, { summary: "Five-year lease from 2021." } as any]);
  assert.match(String(s.summary), /^Part 2 of the lease requires the tenant/);
});

await test("'Part N of M' labels are still stripped; a bare 'Part N of' only from that part's own row prose", () => {
  assert.equal(stripPartLabel("Part 1 of 5: Comfort Club report as at March 31, 2025."), "Comfort Club report as at March 31, 2025.");
  assert.equal(stripPartLabel("Part 2 of 5 of a customer membership database"), "Customer membership database");
  assert.equal(stripPartLabel("(Part 3/5) Revenue schedule."), "Revenue schedule.");
  // The recorded "Part 4 of customer membership database showing … records from … through …"
  assert.ok(stripPartLabel(PARTS[2], { lead: true, part: 4 }).startsWith("Customer membership database showing individual customer records"));
  assert.equal(stripPartLabel(PARTS[2], { lead: true, part: 3 }), PARTS[2], "another part's number: not its label");
  assert.equal(stripPartLabel(PARTS[2]), PARTS[2], "no part number known: left alone");
  // No part states a headline: the kept description carries no label.
  // (parts 4 and 5 of the recorded read, each at its own position).
  const combined = combineExtractions([{ revenue: "$1" } as any, {} as any, {} as any, { summary: PARTS[2] } as any, { summary: PARTS[3] } as any]);
  assert.doesNotMatch(String(combined.summary), /\bPart \d/);
  assert.ok(String(combined.summary).startsWith("Customer membership database showing individual customer records"), String(combined.summary));
  assert.ok(combinePartSummaries([{ text: PARTS[3], part: 5 }]).startsWith("Customer database showing member records"));
});

// ── 3 ──────────────────────────────────────────────────────────────────────
console.log("3 — a live CIM approved before the per-section rule");

const BEFORE = "2026-09-20T10:00:00.000Z";
const AFTER = "2026-10-02T10:00:00.000Z";
const liveDeal = () => ({
  id: "d-live",
  isLive: true,
  phase: "phase4_design_finalization",
  contentApprovedByBroker: true,
  contentApprovedBySeller: true,
  designApprovedByBroker: true,
  designApprovedBySeller: true,
});
const legacySections = () =>
  ["Cover", "Executive Summary", "Financials", "Locations"].map((t, i) => ({
    id: `s${i}`,
    sectionTitle: t,
    isVisible: true,
    brokerApproved: false,
    aiLayoutReasoning: "r",
    contentHistory: [] as unknown[],
    updatedAt: BEFORE,
  }));

// Round 3 (integrator decision C): the cutoff must not PRECEDE the deploy
// (sections the old code wrote after it would look unapproved), so it moved
// to 2026-09-29T00:00Z and this code marks every section it un-ticks. This
// assertion used to require a cutoff at or before 2026-09-28T04:00Z.
await test("the cutoff can't precede the deploy of this rule", () => {
  assert.ok(Date.parse(PER_SECTION_APPROVAL_SINCE) >= Date.parse("2026-09-29T00:00:00.000Z"));
});

await test("untouched sections of a live, fully approved CIM count as approved (nothing looks broken)", () => {
  const r = publishReadiness(liveDeal(), legacySections());
  assert.equal(r.brokerApproved, true);
  assert.deepEqual(r.awaiting, []);
  assert.equal(r.ready, true);
  assert.deepEqual(legacyLiveApprovedIds(liveDeal(), legacySections()), ["s0", "s1", "s2", "s3"]);
});

await test("a change after publishing still needs approval; not live → no treatment", () => {
  const sections = legacySections();
  sections[2].updatedAt = AFTER;
  sections[2].contentHistory = [{ at: AFTER, reason: "Regenerated with AI" }];
  const r = publishReadiness(liveDeal(), sections);
  assert.equal(r.brokerApproved, false);
  assert.deepEqual(r.awaiting, [{ id: "s2", title: "Financials", lastChange: "Regenerated with AI" }]);
  // A history entry after the cutoff counts even when updatedAt is older.
  const h = legacySections();
  h[1].contentHistory = [{ at: AFTER, reason: "Edited" }];
  assert.deepEqual(sectionsAwaitingApproval(h, liveDeal()).map((s) => s.id), ["s1"]);
  // No updatedAt on record: can't prove it untouched.
  const u = legacySections().map(({ updatedAt, ...s }) => s);
  assert.equal(sectionsAwaitingApproval(u, liveDeal()).length, 4);
  assert.equal(sectionsAwaitingApproval(legacySections(), { ...liveDeal(), isLive: false }).length, 4, "not live: the publish gate's rule");
  // Round 3 (integrator decision C): ANY live deal, whatever its design flags
  // (the demo's TrueNorth went live with neither). This assertion used to
  // expect 4 sections awaiting when the seller flag was false.
  assert.equal(sectionsAwaitingApproval(legacySections(), { ...liveDeal(), designApprovedBySeller: false }).length, 0);
  // Hidden sections and placeholders are never ticked by the treatment.
  const p = legacySections();
  p[0].isVisible = false;
  p[1].aiLayoutReasoning = CIM_FALLBACK_REASONING;
  assert.deepEqual(legacyLiveApprovedIds(liveDeal(), p), ["s2", "s3"]);
});

await test("the broker's section reads backfill the ticks once (wiring)", () => {
  const routes = read("server/routes.ts");
  const get = routes.slice(routes.indexOf('app.get("/api/deals/:dealId/cim-sections"'), routes.indexOf('app.post("/api/deals/:dealId/cim-sections/reorder"'));
  assert.match(get, /backfillLegacyLiveApprovals\(res\.locals\.deal\)/);
  const legacyGet = routes.slice(routes.indexOf('app.get("/api/deals/:dealId/sections"'), routes.indexOf('app.post("/api/deals/:dealId/sections"'));
  assert.match(legacyGet, /backfillLegacyLiveApprovals\(res\.locals\.deal\)/);
  const builder = read("server/routes/cim-builder.ts");
  assert.match(builder, /backfillLegacyLiveApprovals\(deal\)/, "the CIM builder's state");
  const approvals = read("server/cim/approvals.ts");
  // The backfill doesn't bump updatedAt (the deal list's "last activity").
  assert.match(approvals, /\.set\(\{ brokerApproved: true \}\)/);
});

// ── 4 ──────────────────────────────────────────────────────────────────────
console.log("4 — next step and checklist follow the publish rule");

const phase4 = {
  id: "d4",
  phase: "phase4_design_finalization",
  isLive: false,
  ndaSigned: true,
  ndaSentAt: null,
  sqCompleted: true,
  valuationCompleted: false,
  interviewCompleted: true,
  contentApprovedByBroker: true,
  contentApprovedBySeller: true,
  designApprovedByBroker: true,
  designApprovedBySeller: true,
  cimLayoutGeneratedAt: new Date(),
  scrapedAt: null,
  cimContent: true,
} as any;

await test("no 'Your move: publish' while sections need approval", () => {
  const step = computeNextStep(phase4, { hasCimSections: true, sectionsAwaitingApproval: 2 });
  assert.deepEqual(step, { label: "approve 2 sections", owner: "you", href: "/deal/d4/design" });
  assert.equal(computeNextStep(phase4, { hasCimSections: true, sectionsAwaitingApproval: 1 }).label, "approve 1 section");
  assert.equal(computeNextStep(phase4, { hasCimSections: true, sectionsAwaitingApproval: 0 }).label, "publish to buyers");
  assert.equal(computeNextStep({ ...phase4, designApprovedByBroker: false }, { sectionsAwaitingApproval: 3 }).label, "approve the design");
});

await test("the Overview checklist's 'Broker approved' row is the publish card's rule", () => {
  const row = (x: any) => phaseChecklist("phase4_design_finalization", phase4, x).find((i) => i.label === "Broker approved")!.done;
  assert.equal(row({ sectionsAwaitingApproval: 2 }), false);
  assert.equal(row({ sectionsAwaitingApproval: 0 }), true);
  // One rule: publishReadiness is built on designApprovalState.
  const sections = legacySections().map((s) => ({ ...s, isVisible: true }));
  const r = publishReadiness(phase4, sections);
  assert.deepEqual(
    { brokerApproved: r.brokerApproved, sellerApproved: r.sellerApproved, ready: r.ready },
    designApprovalState(phase4, r.awaiting.length),
  );
});

await test("the deal list and dashboard pass the count; the Overview passes it to the checklist (wiring)", () => {
  const list = read("server/routes/deal-list.ts");
  assert.match(list, /awaitingApproval: sql<number>`count\(\*\) filter \(where/);
  assert.match(list, /sectionsAwaitingApproval: toNum\(sec\?\.awaitingApproval\)/);
  const overview = read("client/src/pages/broker/deal/OverviewTab.tsx");
  assert.match(overview, /sectionsAwaitingApproval: checklistSections \? sectionsAwaitingApproval\(checklistSections, deal\)\.length : undefined/);
});

// ── 5 ──────────────────────────────────────────────────────────────────────
console.log("5 — the legacy section POST goes through the approval rule");

await test("body approvals and server-owned fields are ignored; a live CIM gets it hidden", () => {
  const body = {
    sectionTitle: "Growth Plan",
    sectionKey: "growth_plan",
    layoutType: "prose_highlight",
    layoutData: { body: "x" },
    brokerApproved: true,
    sellerApproved: true,
    blindStaleAt: null,
    blindTitle: "Growth",
    aiTask: { kind: "write" },
    contentHistory: [{ reason: "x" }],
    figureWarnings: [],
    ddStaleAt: null,
    aiLayoutReasoning: CIM_FALLBACK_REASONING,
    order: 0,
    dealId: "other-deal",
  };
  const r = legacySectionInsert(body, { isLive: false });
  assert.ok(r.ok);
  const f = r.fields as Record<string, unknown>;
  assert.equal(f.brokerApproved, false);
  assert.equal(f.sellerApproved, false);
  assert.ok(f.blindStaleAt instanceof Date, "held back from blind buyers until redacted");
  for (const k of ["blindTitle", "aiTask", "contentHistory", "figureWarnings", "ddStaleAt", "order", "dealId", "id"]) assert.equal(k in f, false, k);
  assert.equal(f.aiLayoutReasoning, "Added by the broker.");
  assert.equal(f.isVisible, true);
  assert.equal(f.sectionKey, "growth_plan");
  assert.equal((legacySectionInsert(body, { isLive: true }) as any).fields.isVisible, false);
  assert.equal(legacySectionInsert({ ...body, sectionTitle: " " }, { isLive: false }).ok, false);
  assert.equal(legacySectionInsert({ ...body, layoutType: "zebra" }, { isLive: false }).ok, false);
});

await test("the route inserts through insertSectionAt and withdraws the approvals (wiring)", () => {
  const routes = read("server/routes.ts");
  const post = routes.slice(routes.indexOf('app.post("/api/deals/:dealId/sections"'), routes.indexOf('app.patch("/api/sections/:id"'));
  assert.match(post, /legacySectionInsert\(req\.body, res\.locals\.deal\)/);
  assert.match(post, /insertSectionAt\(/);
  assert.match(post, /if \(created\.isVisible !== false\) await withdrawApprovalsAfterChange\(req\.params\.dealId\);/);
  assert.doesNotMatch(post, /insertCimSectionSchema|storage\.createCimSection/);
});

console.log(`\n${passed} passed`);
