/**
 * Round 3 of the smoke-test follow-ups (the independent check of round 2,
 * with the integrator's design decisions):
 *   A — a long source's tidy-up is conservative: no business fact is dropped
 *       or blanked for its wording (the checker's 22 real-fact sentences are
 *       kept from any part, including a row-only one); row-range detection
 *       only shapes the combined summary.
 *   B — only an exact document-part label is stripped: "Part N of M" /
 *       "(Part N/M)" at the start, M = the source's real part count,
 *       1 ≤ N ≤ M; extractDocumentData passes the real part numbers (a
 *       failed part doesn't renumber the others).
 *   C — a CIM that was live before the per-section rule, whatever its design
 *       flags, counts its untouched sections as approved; the cutoff can't
 *       precede the deploy (2026-09-29T00:00Z) and every write by this code
 *       that un-ticks a section marks it, so an edit after publishing still
 *       needs approving.
 *
 *   DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/smoke-followups-r3.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  combineExtractions,
  combinePartSummaries,
  extractDocumentData,
  isRowRangeDescription,
  stripPartLabel,
  _setExtractionClientForTests,
  _setExtractionRetryDelaysForTests,
  type ExtractionClient,
} from "../../server/documents/extractor";
import {
  APPROVAL_RULE_FLAG,
  PER_SECTION_APPROVAL_SINCE,
  historySnapshots,
  legacyLiveApprovedIds,
  markedByApprovalRule,
  publishReadiness,
  sectionsAwaitingApproval,
  withApprovalRuleMark,
} from "../../shared/cim-approvals";
import { computeNextStep, phaseChecklist } from "../../shared/deal-progress";
import { historyWith, snapshotOf } from "../../server/cim/section-ops";

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

// ── A ──────────────────────────────────────────────────────────────────────
console.log("A — no business fact is lost to the tidy-up");

// The round-2 checker's 22 real-fact sentences (chk-r2f/probe-rows.ts KEEP).
const CHECKER_FACTS = [
  "Fleet list includes 14 trucks from 2016 to 2023 model years.",
  "Serves a client list of 450 households between Oakville and Burlington.",
  "The company's supplier list includes vendors from Ontario and Quebec.",
  "Maintains a register of licensed technicians ranging from apprentices to master electricians.",
  "Waiting list of 120 patients drawn from Mississauga and Brampton.",
  "Customer list spans 38 commercial accounts from Hamilton to Niagara Falls.",
  "Equipment register lists 22 excavators from 2015 through 2022.",
  "The practice has retained patient records from 2005 through 2024.",
  "The clinic digitised all patient records from 2010 to 2024.",
  "Sales transactions from 2021 through 2023 reflect strong summer seasonality.",
  "Payment records between 2022 and 2024: no late payments and no chargebacks.",
  "Inspection records from 2019 through 2024 contain zero health-code violations.",
  "Revenue grew steadily from FY-2019 to FY-2023.",
  "Occupies suite numbers 101 to 120.",
  "Warranty claim records from 2020 to 2024 total only three claims.",
  "Transactions between January 2023 and December 2023 averaged $412 per ticket.",
  "Service records from 2018 to 2024 are complete for every unit installed.",
  "Stocks models XR-500 through XR-900.",
  "Part 2 of the lease requires the tenant to pay property taxes.",
  "Donor records from 2015 through 2024 were audited annually by KPMG.",
  "Membership list between 2019 and 2024 doubled.",
  "Lot numbers 12 to 18 are included in the sale.",
];
assert.equal(CHECKER_FACTS.length, 22);

// Recorded in S3 (Lakeshore clone, Comfort Club report, 293,222 characters, 5 parts).
const S3 = {
  p1: "Lakeshore Home Comfort Ltd. Comfort Club membership report as at March 31, 2025, exported from field-service software by Denise Tran. Shows 2,900 active members generating $75,835 monthly recurring revenue ($910,020 annualized).",
  p2: "Part 2 of 5 of a customer membership database showing member IDs CC-10620 through CC-11280, with membership tiers (Silver/Gold), billing types (Monthly/Annual prepaid), pricing ($22.95 or $32.95), locations across Hamilton region, join dates from May 2018 through March 2021, status, and most recent activity dates through March 2025.",
  p3: "Customer list showing Comfort Club memberships with subscription IDs, membership tiers (Silver/Gold), billing frequencies (Monthly/Annual), pricing ($22.95 Silver, $32.95 Gold), locations across Hamilton region, join dates from February 2021 through February 2023, acquisition channels (all Organic), membership statuses, and last payment dates through March 2025.",
  p4: "Part 4 of customer membership database showing individual customer records from February 2023 through November 2023, including a large acquisition book from Pembury Furnace Services dated July 1, 2023. Records include membership ID, tier (Silver/Gold), billing type (Monthly/Annual prepaid), pricing, location, acquisition source, status, and customer age category.",
  p5: "Part 5 of customer database showing member records from November 2023 through March 2025, including membership tier (Silver/Gold), billing frequency (Monthly/Annual prepaid), pricing, location, join date, status, and last activity dates.",
};
const ROW_ONLY_SUMMARY = "Customer records from January 2022 through December 2022.";
const HEADLINE_SUMMARY = "Membership report as at March 31, 2025: 2,900 active members, $75,835 MRR.";
const factsOf = (list: string[]) => Object.fromEntries(list.map((s, i) => [`fact${i}`, s]));

await test("the checker's 22 facts survive word for word from a row-only part", () => {
  const facts = factsOf(CHECKER_FACTS);
  const c = combineExtractions([{ summary: HEADLINE_SUMMARY } as any, { summary: ROW_ONLY_SUMMARY, ...facts } as any], { parts: [1, 2], total: 2 });
  for (const [k, v] of Object.entries(facts)) assert.equal(c[k], v, v);
  assert.equal(c.summary, HEADLINE_SUMMARY);
});

await test("… and from a headline part, from the S3 row parts, and as one joined fact", () => {
  const facts = factsOf(CHECKER_FACTS);
  const a = combineExtractions([{ summary: HEADLINE_SUMMARY, ...facts } as any, { summary: S3.p5 } as any], { parts: [1, 5], total: 5 });
  for (const [k, v] of Object.entries(facts)) assert.equal(a[k], v, v);
  const b = combineExtractions([{ summary: S3.p1 } as any, { summary: S3.p4, ...facts } as any, { summary: S3.p5 } as any], { parts: [1, 4, 5], total: 5 });
  for (const [k, v] of Object.entries(facts)) assert.equal(b[k], v, v);
  const all = CHECKER_FACTS.join(" ");
  const j = combineExtractions([{ summary: S3.p4, customerBase: all } as any, { summary: S3.p5 } as any], { parts: [4, 5], total: 5 });
  assert.equal(j.customerBase, all);
});

await test("… and as key facts / red flags items (joined prose keeps every item)", () => {
  const c = combineExtractions(
    [{ keyFacts: CHECKER_FACTS.slice(0, 11).join("; ") } as any, { keyFacts: CHECKER_FACTS.slice(11).join("; "), summary: ROW_ONLY_SUMMARY } as any],
    { parts: [1, 2], total: 2 },
  );
  const items = String(c.keyFacts).split("; ");
  for (const s of CHECKER_FACTS) assert.ok(items.includes(s.replace(/[.]$/, "")), s);
});

await test("the checker's facts aren't taken for row prose in the summary either", () => {
  for (const s of CHECKER_FACTS) assert.equal(isRowRangeDescription(s), false, s);
  // A part whose summary is one of them stays in the combined summary next to the headline.
  const s = combinePartSummaries([{ text: HEADLINE_SUMMARY, part: 1 }, { text: CHECKER_FACTS[10], part: 2 }], { total: 2 });
  assert.equal(s, `${HEADLINE_SUMMARY} ${CHECKER_FACTS[10]}`);
});

await test("the recorded S3 summary still leads with the headline (real part numbers)", () => {
  const combined = combineExtractions(
    [
      { summary: S3.p1, _periodEnd: "2025-03-31", revenue: "$801,000" } as any,
      { summary: S3.p2 } as any,
      { summary: S3.p3 } as any,
      { summary: S3.p4 } as any,
      { summary: S3.p5 } as any,
    ],
    { parts: [1, 2, 3, 4, 5], total: 5 },
  );
  assert.equal(combined.summary, S3.p1);
  assert.match(String(combined.summary), /2,900 active members generating \$75,835 monthly recurring revenue/);
  assert.equal(combined.revenue, "$801,000");
});

await test("a row-only part never outranks another part's value (the order is the source's own)", () => {
  // Same period: the later part wins a single value, whatever its summary says.
  const c = combineExtractions([{ summary: HEADLINE_SUMMARY, employeeCount: "14" } as any, { summary: ROW_ONLY_SUMMARY, employeeCount: "15" } as any], { parts: [1, 2], total: 2 });
  assert.equal(c.employeeCount, "15");
});

// ── B ──────────────────────────────────────────────────────────────────────
console.log("B — only an exact document-part label is stripped");

await test("must strip: 'Part N of M' / '(Part N/M)' at the start, M = the real part count", () => {
  const cases: Array<[string, string]> = [
    ["Part 1 of 5: Comfort Club report as at March 31, 2025.", "Comfort Club report as at March 31, 2025."],
    ["Part 2 of 5 — member records with tiers and statuses.", "Member records with tiers and statuses."],
    ["Part 2 of 5 - member records with tiers.", "Member records with tiers."],
    ["Part 3 of 5, continued: payroll register.", "Continued: payroll register."],
    ["(Part 3/5) Revenue schedule.", "Revenue schedule."],
    ["(Part 3 of 5): Revenue schedule.", "Revenue schedule."],
    ["Part 3/5: Revenue schedule.", "Revenue schedule."],
    ["part 4 of 5: the lease abstract.", "The lease abstract."],
    ["This is part 2 of 5 of the member export: 612 members.", "Member export: 612 members."],
    ["Part 2 of 5 of a customer membership database showing member IDs CC-10620 through CC-11280.", "Customer membership database showing member IDs CC-10620 through CC-11280."],
    ["Part 5 of 5 of the general ledger export.", "General ledger export."],
  ];
  for (const [text, want] of cases) {
    assert.equal(stripPartLabel(text, { total: 5 }), want, text);
    assert.equal(stripPartLabel(text, { total: 5, lead: false }), want, `as a fact: ${text}`);
  }
  // Through the combine: a fact and the summary both lose it.
  const c = combineExtractions([{ summary: "Part 1 of 2: Lease abstract for 12 Main St.", leaseTerms: "Part 1 of 2: five-year term from 2021." } as any, { summary: "Part 2 of 2: renewal schedule." } as any], { parts: [1, 2], total: 2 });
  assert.equal(c.leaseTerms, "Five-year term from 2021.");
  assert.equal(c.summary, "Lease abstract for 12 Main St. Renewal schedule.");
});

await test("must not strip: a fact that starts with 'Part', a wrong count, a label elsewhere", () => {
  const same = [
    ["Part 2 of the lease requires the tenant to pay property taxes.", 5],
    ["Part 2 of the lease requires the tenant to pay property taxes.", 2],
    ["Part 2 of 2023's capital plan was deferred to 2024.", 5],
    ["Part 2 of 2023's capital plan was deferred to 2024.", 2],
    ["Part 1 of 3 of the expansion is complete; parts 2 and 3 follow in 2025.", 5],
    ["Part 1 of 3 of the expansion is complete; parts 2 and 3 follow in 2025.", 2],
    // M = the real count, but not the reader's form ("of the expansion" isn't the source).
    ["Part 1 of 3 of the expansion is complete; parts 2 and 3 follow in 2025.", 3],
    ["Part 1 of 3: overview.", 5],
    ["Part 6 of 5: overview.", 5],
    ["Part 0 of 5: overview.", 5],
    ["Part 3 of Schedule A sets out the equipment list.", 5],
    ["Part 3 of the building is sublet to a dentist.", 5],
    ["Revenue schedule (Part 3 of 5).", 5],
    ["The lease is in two parts; Part 2 of 5 covers parking.", 5],
    ["Part 2 of 5 Comfort Club memberships renew in May.", 5],
    ["(Part 3/5 Revenue schedule.", 5],
  ] as const;
  for (const [text, total] of same) {
    assert.equal(stripPartLabel(text, { total }), text, `${text} (total ${total})`);
    assert.equal(stripPartLabel(text, { total, lead: false }), text, `as a fact: ${text} (total ${total})`);
  }
  // Through the combine.
  const lease = "Part 2 of the lease requires the tenant to pay property taxes.";
  const plan = "Part 2 of 2023's capital plan was deferred to 2024.";
  const exp = "Part 1 of 3 of the expansion is complete; parts 2 and 3 follow in 2025.";
  const c = combineExtractions([{ leaseTerms: lease, capex: plan } as any, { growthPlans: exp, summary: plan } as any], { parts: [1, 2], total: 2 });
  assert.equal(c.leaseTerms, lease);
  assert.equal(c.capex, plan);
  assert.equal(c.growthPlans, exp);
  assert.equal(c.summary, plan);
});

await test("a part's own bare 'Part 4 of …' (row prose, summary only) follows its REAL number", () => {
  // Part 3 failed: parts 4 and 5 keep their numbers.
  const c = combineExtractions([{ revenue: "$1" } as any, { summary: S3.p4 } as any, { summary: S3.p5 } as any], { parts: [1, 4, 5], total: 5 });
  assert.ok(String(c.summary).startsWith("Customer membership database showing individual customer records"), String(c.summary));
  assert.doesNotMatch(String(c.summary), /\bPart \d/);
  // Renumbered (list position 2 = "part 3"), it would not be its label.
  assert.equal(combinePartSummaries([{ text: S3.p4, part: 3 }], { total: 5 }), S3.p4);
  // Never on a fact.
  const f = combineExtractions([{ customerBase: S3.p4 } as any, {} as any], { parts: [4, 5], total: 5 });
  assert.equal(f.customerBase, S3.p4);
});

await test("extractDocumentData passes the real part numbers and count (a failed part doesn't renumber)", async () => {
  _setExtractionRetryDelaysForTests([1]);
  const run = async (fails: (n: number) => boolean) => {
    const seen: Array<[number, number]> = [];
    const client: ExtractionClient = {
      messages: {
        stream(body) {
          const m = /THIS IS PART (\d+) OF (\d+)/.exec(JSON.stringify(body.messages));
          const [n, total] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
          seen.push([n, total]);
          return {
            finalMessage: async () => {
              if (fails(n)) throw Object.assign(new Error("bad request"), { status: 400 });
              const input: Record<string, unknown> =
                n === 1 ? { summary: `Part 1 of ${total}: ${HEADLINE_SUMMARY}`, keyFacts: "Part 2 of the lease requires the tenant to pay property taxes" }
                : n === 4 ? { summary: S3.p4, keyFacts: `Part 4 of ${total} — 612 memberships renewed in 2023` }
                : { summary: `Part ${n} of ${total}: customer records from January 2022 through December 2022.` };
              return { stop_reason: "tool_use", content: [{ type: "tool_use", input }] };
            },
          };
        },
      },
    };
    _setExtractionClientForTests(client);
    const text = Array.from({ length: 5 }, (_, i) => `Section ${i + 1}. ${"Member row 1,000. ".repeat(3300)}`).join("\n\f");
    const out = await extractDocumentData(text, "operations");
    return { out, total: seen[0][1] };
  };
  try {
    // Part 3 fails: the headline part leads, the lease fact is kept, part 4's labels go.
    const a = await run((n) => n === 3);
    assert.ok(a.total >= 5, `parts: ${a.total}`);
    assert.equal(a.out.summary, HEADLINE_SUMMARY, String(a.out.summary));
    assert.equal(a.out.keyFacts, "Part 2 of the lease requires the tenant to pay property taxes; 612 memberships renewed in 2023");
    assert.ok((a.out as any)._partialRead, "the failed part is recorded");
    // Only part 4 is read: it is still part 4 of the real count (its own label
    // "Part 4 of customer membership database…" and "Part 4 of N —" go).
    const b = await run((n) => n !== 4);
    assert.ok(String(b.out.summary).startsWith("Customer membership database showing individual customer records"), String(b.out.summary));
    assert.equal(b.out.keyFacts, "612 memberships renewed in 2023");
  } finally {
    _setExtractionClientForTests(null);
    _setExtractionRetryDelaysForTests(null);
  }
});

// ── C ──────────────────────────────────────────────────────────────────────
console.log("C — CIMs live before the per-section rule");

const TN_WRITTEN = "2026-07-17T20:50:41.000Z";
const IN_WINDOW = "2026-09-28T18:00:00.000Z"; // after deploy, before the cutoff
const AFTER = "2026-10-02T10:00:00.000Z";
const trueNorth = () => ({
  id: "tn",
  phase: "phase4_design_finalization",
  isLive: true,
  designApprovedByBroker: false,
  designApprovedBySeller: false,
  contentApprovedByBroker: true,
  contentApprovedBySeller: true,
  cimLayoutGeneratedAt: new Date("2026-07-17T20:50:41Z"),
  ndaSigned: true,
  sqCompleted: true,
  interviewCompleted: true,
  cimContent: {},
});
const tnSections = () =>
  Array.from({ length: 24 }, (_, i) => ({
    id: `t${i}`,
    sectionTitle: `Section ${i + 1}`,
    isVisible: true,
    brokerApproved: false,
    aiLayoutReasoning: "Chosen for the data.",
    contentHistory: null as unknown,
    updatedAt: TN_WRITTEN as string,
  }));

await test("the cutoff can't precede the deploy of this code", () => {
  assert.equal(PER_SECTION_APPROVAL_SINCE, "2026-09-29T00:00:00.000Z");
});

await test("TrueNorth shape (live, both design flags false, 24 unticked): nothing needs approval", () => {
  const deal = trueNorth();
  const r = publishReadiness(deal, tnSections());
  assert.deepEqual(r.awaiting, [], "no 'sections need approval' box");
  assert.equal(legacyLiveApprovedIds(deal, tnSections()).length, 24);
  // The Overview shows "CIM is live" for a live deal; its next step is the buyers'.
  assert.equal(deal.isLive, true);
  assert.notEqual(computeNextStep(deal as any, { sectionsAwaitingApproval: r.awaiting.length, buyersWithAccess: 0 }).label.startsWith("approve"), true);
  // One live flag, or both: the same.
  assert.deepEqual(publishReadiness({ ...deal, designApprovedByBroker: true }, tnSections()).awaiting, []);
  assert.deepEqual(publishReadiness({ ...deal, designApprovedByBroker: true, designApprovedBySeller: true }, tnSections()).awaiting, []);
  // Not live: the publish gate's rule (every shown section needs approving).
  assert.equal(sectionsAwaitingApproval(tnSections(), { ...deal, isLive: false }).length, 24);
  assert.equal(phaseChecklist("phase4_design_finalization", { ...deal, isLive: false } as any, { sectionsAwaitingApproval: 24 }).find((i) => i.label === "Broker approved")!.done, false);
});

await test("an edit after publishing still needs approval — also between the deploy and the cutoff", () => {
  const deal = trueNorth();
  const base = tnSections()[0] as any;
  const section = { ...base, layoutType: "prose_highlight", layoutData: { body: "x" }, aiDraftContent: "x", brokerEditedContent: null, figureWarnings: null };
  // A content change (PATCH, AI regenerate / rewrite / convert, layout change, photo removed): its snapshot is marked.
  assert.equal((snapshotOf(section, "Edited") as any)[APPROVAL_RULE_FLAG], true);
  const edited = { ...base, updatedAt: IN_WINDOW, contentHistory: historyWith(section, "Edited") };
  assert.deepEqual(sectionsAwaitingApproval([edited], deal).map((s) => [s.id, s.lastChange]), [["t0", "Edited"]]);
  // Showing a hidden section / the broker's own un-tick / an AI write / a legacy regenerate: marked with no new version.
  const shown = { ...base, updatedAt: IN_WINDOW, contentHistory: withApprovalRuleMark(null) };
  assert.equal(markedByApprovalRule(shown.contentHistory), true);
  assert.deepEqual(historySnapshots(shown.contentHistory), [], "the marker isn't an undo step");
  assert.deepEqual(sectionsAwaitingApproval([shown], deal), [{ id: "t0", title: "Section 1" }], "no 'latest change' from a marker");
  // An older (pre-rule) history: its latest entry carries the mark.
  const old = [{ at: "2026-08-01T00:00:00.000Z", reason: "Edited", sectionTitle: "S", layoutType: "prose_highlight", layoutData: {}, aiDraftContent: null, brokerEditedContent: null }];
  const marked = withApprovalRuleMark(old);
  assert.equal(marked.length, 1);
  assert.equal((marked[0] as any)[APPROVAL_RULE_FLAG], true);
  assert.equal((old[0] as any)[APPROVAL_RULE_FLAG], undefined, "the input isn't mutated");
  assert.deepEqual(legacyLiveApprovedIds(deal, [{ ...base, contentHistory: old }]), ["t0"], "old-code history alone: still legacy");
  assert.deepEqual(legacyLiveApprovedIds(deal, [{ ...base, updatedAt: IN_WINDOW, contentHistory: marked }]), []);
  // After the cutoff an unmarked write is newer than the rule anyway.
  assert.deepEqual(legacyLiveApprovedIds(deal, [{ ...base, updatedAt: AFTER }]), []);
  // Idempotent.
  assert.deepEqual(withApprovalRuleMark(marked), marked);
  assert.equal(withApprovalRuleMark(withApprovalRuleMark(null)).length, 1);
});

await test("every write that un-ticks a section marks it (wiring)", () => {
  const ops = read("server/cim/section-ops.ts");
  assert.match(ops, /approvalRule: true,\n  \};\n\}/, "every undo snapshot (historyWith) is marked");
  assert.match(ops, /if \(set\.brokerApproved === false && !contentChanged\) set\.contentHistory = withApprovalRuleMark\(section\.contentHistory\);/, "PATCH: show / un-tick");
  assert.match(ops, /const history = withApprovalRuleMark<CimSectionSnapshot>\(all\.filter\(\(_, i\) => i !== idx\)\);/, "undo");
  assert.match(ops, /while \(idx >= 0 && isHistoryMarker\(all\[idx\]\)\) idx--;/, "undo skips markers");
  assert.match(ops, /\.values\(\{ \.\.\.fields, contentHistory: withApprovalRuleMark\(fields\.contentHistory\), dealId, sectionKey, order: index \}/, "add / duplicate / legacy POST");
  assert.match(read("server/storage.ts"), /values\(\{ \.\.\.insertSection, contentHistory: withApprovalRuleMark\(insertSection\.contentHistory\) \}\)/, "generation");
  assert.match(read("server/cim/section-tasks.ts"), /contentHistory: task\.kind === "write" \? withApprovalRuleMark\(row\.contentHistory\) : historyWith\(row, reason\)/, "AI write");
  const routes = read("server/routes.ts");
  assert.match(routes, /brokerApproved: false,\n          \/\/ Un-ticked under the per-section approval rule \(shared\/cim-approvals\)\.\n          contentHistory: withApprovalRuleMark\(target\.contentHistory\),/, "builder-section regenerate");
  assert.match(routes, /brokerApproved: false,\n            \/\/ Un-ticked under the per-section approval rule \(shared\/cim-approvals\)\.\n            contentHistory: withApprovalRuleMark\(matchingSection\.contentHistory\),/, "legacy text-key regenerate");
  assert.match(read("server/routes/cim-builder.ts"), /const history = historySnapshots<\{ reason: string; at: string \}>\(contentHistory\);/, "builder's undo count skips markers");
  // Every brokerApproved: false write on an existing row is one of the above.
  const all = ["server/cim/section-ops.ts", "server/cim/section-tasks.ts", "server/routes.ts", "server/routes/cim-builder.ts", "server/routes/cim-media.ts"]
    .map((f) => [f, read(f)] as const);
  for (const [f, src] of all) {
    for (const m of Array.from(src.matchAll(/brokerApproved: false/g))) {
      const around = src.slice(Math.max(0, m.index! - 1600), m.index! + 400);
      assert.ok(/historyWith\(|withApprovalRuleMark(<[^>]+>)?\(|insertSectionAt\(/.test(around), `${f}: an un-tick without the mark near offset ${m.index}`);
    }
  }
});

await test("the backfill UPDATE re-checks the rule in SQL (unticked, before the cutoff, never marked)", () => {
  const src = read("server/cim/approvals.ts");
  const fn = src.slice(src.indexOf("export async function backfillLegacyLiveApprovals"), src.indexOf("export function legacySectionInsert"));
  assert.match(fn, /sql`\$\{cimSections\.brokerApproved\} is not true`/);
  assert.match(fn, /lt\(cimSections\.updatedAt, new Date\(PER_SECTION_APPROVAL_SINCE\)\)/);
  assert.match(fn, /coalesce\(\$\{cimSections\.contentHistory\}, '\[\]'::jsonb\) @> \$\{APPROVAL_RULE_MARK_JSON\}::jsonb/);
  assert.match(fn, /\.set\(\{ brokerApproved: true \}\)/, "updatedAt untouched");
  assert.match(fn, /\.returning\(\{ id: cimSections\.id \}\)/, "only rows actually ticked are reported ticked");
  assert.match(src, /const APPROVAL_RULE_MARK_JSON = JSON\.stringify\(\[\{ \[APPROVAL_RULE_FLAG\]: true \}\]\);/);
});

console.log(`\n${passed} passed`);
