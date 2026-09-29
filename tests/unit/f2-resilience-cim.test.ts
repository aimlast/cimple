/**
 * R1 — an AI outage during "Regenerate all" must never replace the deal's
 * CIM with hidden placeholders (deleting the broker's edits, approvals,
 * tiers, Blind and DD versions) and toast "CIM ready".
 *
 *   - layout engine: when every section of the first batch fails (529s),
 *     the run stops instead of retrying every remaining section;
 *   - generation job: a mostly-placeholder document fails honestly and the
 *     current CIM is untouched; a small shortfall on a non-key section is
 *     saved; a first CIM is saved as long as something was written;
 *   - the replacement is one storage call (one transaction).
 * No database, no AI (stubbed client and storage).
 * Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused node_modules/.bin/tsx tests/unit/f2-resilience-cim.test.ts
 */
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { storage } from "../../server/storage";
import { generateCimLayout, _setAnthropicForTests } from "../../server/cim/layout-engine";
import { _setGeneratorForTests, getLiveCimGenerationStatus, startCimGeneration } from "../../server/cim/generation-jobs";
import { generationShortfall, isKeySection } from "../../server/cim/generation-shortfall";
import { CIM_FALLBACK_REASONING } from "../../shared/cim-layouts";
import { _setSnapshotStoreForTests, memorySnapshotStore } from "../../server/cim/published-snapshot";

// A live CIM is kept for its buyers before it is replaced (published-snapshot.ts): in memory here.
const keptCopies = memorySnapshotStore();
_setSnapshotStoreForTests(keptCopies);

let passed = 0;
const ok = (name: string) => { passed++; console.log(`  ✓ ${name}`); };

// ── layout engine: an outage after planning stops the run ──────────────────
{
  const facts = JSON.parse(fs.readFileSync(path.join(process.cwd(), "tests", "fixtures", "cim", "pacific-acc2-facts.json"), "utf8"));
  let calls = 0;
  const layouts = ["cover_page", "metric_grid", "prose_highlight", "bar_chart", "financial_table", "prose_highlight", "prose_highlight", "timeline"];
  _setAnthropicForTests({
    messages: {
      stream: (body: any) => ({
        finalMessage: async () => {
          calls++;
          if (body.tools[0].name === "cim_manifest") {
            return { stop_reason: "tool_use", content: [{ type: "tool_use", name: "cim_manifest", input: { sections: layouts.map((l, i) => ({ sectionKey: "s" + i, sectionTitle: "S" + i, order: i + 1, layoutType: l, tags: [], aiLayoutReasoning: "r", contentBrief: "b" })) } }] };
          }
          const e: any = new Error("529 overloaded_error");
          e.status = 529;
          throw e;
        },
      }),
    },
  } as any, 1);
  const origError = console.error;
  console.error = () => {};
  let threw: Error | null = null;
  try {
    await generateCimLayout({ dealId: "d", businessName: "Pacific Coast Logistics Ltd.", industry: "Transportation", askingPrice: "$18,000,000", extractedInfo: facts, today: new Date() } as any);
  } catch (err) {
    threw = err as Error;
  } finally {
    console.error = origError;
  }
  assert.ok(threw, "the run throws instead of returning 8 placeholders");
  assert.match(threw!.message, /AI service failed/);
  const perSection = (calls - 1) / 5;
  assert.ok(calls < 1 + layouts.length * perSection, `stopped after the first batch (${calls} calls)`);
  _setAnthropicForTests(null);
  ok("an outage after planning stops the run after the first batch (no retries of every section)");
}

// ── the shortfall rule ─────────────────────────────────────────────────────
const sec = (key: string, failed: boolean, tags: string[] = []) => ({
  sectionKey: key,
  sectionTitle: key.replace(/_/g, " "),
  order: 1,
  layoutType: "prose_highlight",
  layoutData: { body: "x" },
  aiLayoutReasoning: failed ? CIM_FALLBACK_REASONING : "r",
  tags,
  isVisible: !failed,
  brokerApproved: false,
});
{
  const five = (failed: number) => ["company_overview", "history", "team", "market", "growth"].map((k, i) => sec(k, i < failed));
  assert.match(generationShortfall(five(5), { hasExistingCim: true })!.message, /all 5 sections\. Your current CIM was not changed/);
  assert.match(generationShortfall(five(5), { hasExistingCim: false })!.message, /all 5 sections\. Nothing was saved/);
  assert.match(generationShortfall(five(2), { hasExistingCim: true })!.message, /2 of 5 sections\. Your current CIM was not changed/);
  assert.equal(generationShortfall(five(1), { hasExistingCim: true }), null, "one non-key section in five is a placeholder to regenerate");
  assert.equal(generationShortfall(five(2), { hasExistingCim: false }), null, "a first CIM keeps what was written");
  const keyFailed = [sec("financial_overview", true, ["financial"]), ...five(0), sec("a", false), sec("b", false)];
  assert.match(generationShortfall(keyFailed, { hasExistingCim: true })!.message, /1 of 8 sections \(including "financial overview"\)/);
  assert.ok(isKeySection({ sectionKey: "transaction_overview" }));
  assert.ok(isKeySection({ sectionKey: "x", sectionTitle: "Executive Summary" }));
  assert.ok(!isKeySection({ sectionKey: "history_milestones", tags: ["history"] }));
  assert.ok(generationShortfall([], { hasExistingCim: true }), "no sections never replaces a CIM");
  ok("mostly-placeholder or key-section-missing runs never replace an existing CIM; a first CIM keeps what was written");
}

// ── the job: failed honestly, nothing touched ──────────────────────────────
{
  const dealId = "deal-resil-r1";
  const deal: any = {
    id: dealId, brokerId: "b1", businessName: "Pacific Coast Logistics (QA)", industry: "Transportation",
    askingPrice: "$18,000,000", extractedInfo: { annualRevenue: "$31,020,000" },
    isLive: true, contentApprovedByBroker: true, contentApprovedBySeller: true, designApprovedByBroker: true, designApprovedBySeller: true,
    phase: "phase4_design_finalization", cimLayoutVersion: 3, cimGeneration: null,
  };
  const existing = [{ id: "old1", sectionKey: "overview", brokerEditedContent: "Broker's own words" }];
  const replaced: any[][] = [];
  const s = storage as any;
  s.getDeal = async (id: string) => (id === dealId ? structuredClone(deal) : undefined);
  s.updateDeal = async (_id: string, u: any) => Object.assign(deal, structuredClone(u));
  s.getDocumentsByDeal = async () => [];
  s.getResolvedDiscrepancies = async () => [];
  s.getBrandingByBroker = async () => undefined;
  s.getEngagementInsightsByIndustry = async () => [];
  s.getFinancialAnalysesByDeal = async () => [];
  s.getBuyerAccessByDeal = async () => [{ id: "a1", revokedAt: null, expiresAt: null }];
  s.getCimSectionOverrides = async () => [];
  s.getCimSectionsByDeal = async () => existing;
  s.deleteCimSectionsForDeal = async () => { throw new Error("must not delete piecemeal"); };
  s.createCimSection = async () => { throw new Error("must not insert piecemeal"); };
  s.replaceDealCim = async (_id: string, rows: any[], u: any) => { replaced.push(rows); Object.assign(deal, structuredClone(u)); };
  const waitDone = async () => {
    for (let i = 0; i < 300 && getLiveCimGenerationStatus(dealId)?.status === "running"; i++) await new Promise((r) => setTimeout(r, 10));
  };
  const origError = console.error;
  console.error = () => {};

  _setGeneratorForTests(async () => ({
    dealId, generatedAt: new Date().toISOString(), version: 1,
    sections: ["overview", "history", "team", "market", "financial_overview"].map((k) => sec(k, true)),
    warnings: ["Section \"x\" could not be generated. It was saved as a hidden placeholder — regenerate it, write it yourself or delete it in the CIM builder before publishing."],
  }) as any);
  await startCimGeneration(structuredClone(deal), "layout");
  await waitDone();
  let job = getLiveCimGenerationStatus(dealId)!;
  assert.equal(job.status, "failed", "never 'done' → no 'CIM ready' toast");
  assert.match(job.error!, /AI service failed while writing all 5 sections\. Your current CIM was not changed/);
  assert.equal(replaced.length, 0, "the old sections, edits and overrides were not touched");
  assert.equal(deal.isLive, true, "still live");
  assert.equal(deal.designApprovedByBroker, true, "approvals kept");
  assert.equal(deal.cimLayoutVersion, 3);
  assert.equal(job.buyerHold, undefined, "not held from buyers");
  ok("an all-placeholder run fails honestly; the live CIM, its approvals and edits are untouched");

  // 3 of 5 written is still too many holes for a CIM that exists.
  _setGeneratorForTests(async () => ({
    dealId, generatedAt: new Date().toISOString(), version: 1,
    sections: ["overview", "history", "team", "market", "growth"].map((k, i) => sec(k, i < 2)), warnings: [],
  }) as any);
  await startCimGeneration(structuredClone(deal), "layout");
  await waitDone();
  job = getLiveCimGenerationStatus(dealId)!;
  assert.equal(job.status, "failed");
  assert.equal(replaced.length, 0);
  ok("2 of 5 placeholders on an existing CIM: not saved");

  // One non-key placeholder of five: saved (in one replace call), held for review.
  _setGeneratorForTests(async () => ({
    dealId, generatedAt: new Date().toISOString(), version: 1,
    sections: ["overview", "history", "team", "market", "growth"].map((k, i) => sec(k, i === 1)), warnings: [],
  }) as any);
  await startCimGeneration(structuredClone(deal), "layout");
  await waitDone();
  job = getLiveCimGenerationStatus(dealId)!;
  assert.equal(job.status, "done");
  assert.equal(replaced.length, 1);
  assert.equal(replaced[0].length, 5);
  // A live deal stays live: its buyers keep the kept copy while the new CIM is reviewed.
  assert.equal(deal.isLive, true, "still live");
  assert.equal(deal.designApprovedByBroker, false, "approvals cleared, in the same write");
  assert.ok(job.buyerHold?.servingPublished);
  assert.ok(keptCopies.rows.has(dealId), "the published CIM was kept first");
  assert.equal(replaced.length, 1);
  ok("a small non-key shortfall is saved in one transaction with the hold");

  console.error = origError;
  _setGeneratorForTests(null);
}

console.log(`f2-resilience-cim: ${passed} passed`);
process.exit(0);
