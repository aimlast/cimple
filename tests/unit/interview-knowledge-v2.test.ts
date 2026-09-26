// Interview knowledge, round V r2 (QA harvest "i-knowledge") — offline checks,
// no database, no AI (model calls are replaced).
//  1. Evidence figures: spreadsheet rows read as cells ("Jan 2024,5311,8311"),
//     and a figure must match to the precision it is written (a number half a
//     percent away elsewhere in a large file is not support).
//  2. Re-ask guard: a "why / what drove" question is not a delta — its
//     candidates go to the answer check (the union vote), but it is never a
//     sure re-ask of a figure on file.
//  3. Live claims: a figure volunteered mid-answer retrieves the passage that
//     states the same measure (scrap 1.8% → the quality summary's 2.9%; "450
//     customer-owned molds" → "about 1,150 customer-owned molds"; "26 trucks"
//     → the fleet list); a money claim is offered the headline money facts —
//     never the broker's own values.
//  4. The answer check is hedged: a slow first request gets a second one and
//     the first answer wins; both failing or neither answering → no verdict.
//  5. A session opening waits for an evidence build only when it is about to land.
//  6. Coverage the seller sees is the RECORDED coverage (on-file evidence
//     steers questions but is no recorded fact).
// Run: DATABASE_URL=postgres://unused/x ANTHROPIC_API_KEY=unused npx tsx tests/unit/interview-knowledge-v2.test.ts
import assert from "node:assert/strict";
import { figuresSupported, validateEvidence, NUMBER_RE, type EvidenceTarget } from "../../server/interview/on-file-evidence";
import { findReasks, confirmFindings, sureFindings, liveConflictFindings } from "../../server/interview/reask-guard";
import { claimChunks, rankClaimPassages, claimMaterial, claimWords } from "../../server/interview/live-claims";
import { hedgedCheck, type CheckRequest } from "../../server/interview/answer-check";
import { openingEvidenceWaitMs } from "../../server/interview/session-manager";
import { assembleKnowledgeBase } from "../../server/interview/knowledge-base";
import { computeCimReadiness } from "../../shared/cim-readiness";

let n = 0;
const ok = (name: string) => { n++; console.log("✓", name); };
const doc = (o: Record<string, unknown>): any => ({
  name: "doc", visibility: "shared", sourceKind: "document", sourceMeta: null, createdAt: new Date("2026-03-03T12:00:00Z"),
  category: "other", subcategory: null, status: "processed", isProcessed: true, extractedText: null, extractedData: null, ...o,
});

// ── 1. Evidence figures ──
{
  // The Beacon payer report's Monthly volumes sheet, as extracted (CSV rows).
  const payer = [
    "Monthly volumes FY2024 (prescriptions / services counted from RxNova),,,,,,",
    "Month,Community Rx,LTC & retirement Rx (strip-pack lines),Compounded Rx,Injections administered,Med reviews (MedsCheck),Minor ailment assessments",
    "Jan 2024,5311,8311,634,176,169,112",
    "Dec 2024,5623,9012,688,301,164,98",
    "TOTAL,62480,104300,7850,2910,1840,1120",
    "Avg revenue per community Rx,72.99",
    "Payer mix (community Rx),ODB 49.5%,Private drug plans 40.0%,Cash 10.5%",
  ].join("\n");
  const nums = (t: string) => (t.match(new RegExp(NUMBER_RE.source, "gi")) ?? []).map((x) => x.trim());
  assert.deepEqual(nums("Jan 2024,5311,8311,634"), ["2024", "5311", "8311", "634"], "cells, not one run of digits");
  assert.deepEqual(nums("TOTAL,62480,104300"), ["62480", "104300"]);
  assert.deepEqual(nums("about 1,150 molds and $36,058,217"), ["1,150", "36,058,217"], "real thousands groups stay whole");
  assert.ok(figuresSupported("Community Rx: 5,311 in January 2024, 5,623 in December 2024", payer));
  assert.ok(figuresSupported("104,300 LTC & retirement Rx (strip-pack lines) in FY2024", payer));
  assert.ok(figuresSupported("62,480 community Rx in FY2024", payer));
  assert.ok(figuresSupported("Private drug plans 40.0%, cash 10.5%", payer));
  assert.ok(figuresSupported("Average revenue per community Rx $72.99", payer));
  // Precision: exact for whole numbers, half a unit of the last digit written otherwise.
  assert.equal(figuresSupported("62,480 community Rx", "total 62,300 scripts"), false, "0.3% away is not the figure");
  assert.equal(figuresSupported("62,480 community Rx", "total 62,500 scripts"), false);
  assert.ok(figuresSupported("revenue $3.1M", "revenue 3,120,000"));
  assert.equal(figuresSupported("revenue $3.1M", "revenue 3,180,000"), false);
  assert.ok(figuresSupported("about $73 per Rx", "Avg revenue per community Rx,72.99"));
  assert.ok(figuresSupported("$1.12M officer compensation", "Officer compensation 1,120,000"));
  assert.ok(figuresSupported("the vote failed 61 to 39 in 2019", "The vote failed, sixty-one to thirty-nine."), "spoken, and a year is exempt");

  // End to end through validateEvidence: the payer-report answers stand.
  const targets = new Map<string, EvidenceTarget>([
    ["T1", { id: "field:monthlyRxVolume", kind: "field", key: "monthlyRxVolume", label: "Monthly prescription volume", sellerAccount: false }],
    ["T2", { id: "field:privateInsuranceShare", kind: "field", key: "privateInsuranceShare", label: "Private plan share of community Rx", sellerAccount: false }],
    ["T3", { id: "field:averageRevenuePerRx", kind: "field", key: "averageRevenuePerRx", label: "Average revenue per Rx", sellerAccount: false }],
  ]);
  const sources = new Map([["S1", { id: "S1", label: "Payer mix & monthly volumes FY2024", kind: "document", docId: "p1", text: payer }]]);
  const entries = validateEvidence(
    [
      { id: "T1", status: "yes", answer: "Community Rx 5,311 (Jan 2024) to 5,623 (Dec 2024); 62,480 for FY2024", sourceId: "S1", quote: "Jan 2024,5311,8311 ... TOTAL,62480,104300" },
      { id: "T2", status: "yes", answer: "Private drug plans 40.0% of community Rx", sourceId: "S1", quote: "Private drug plans 40.0%" },
      { id: "T3", status: "yes", answer: "$72.99 per community Rx", sourceId: "S1", quote: "Avg revenue per community Rx,72.99" },
    ],
    targets,
    sources as any,
    {},
  );
  assert.deepEqual(Object.keys(entries).sort(), ["field:averageRevenuePerRx", "field:monthlyRxVolume", "field:privateInsuranceShare"]);
  ok("evidence figures: spreadsheet rows read as cells; figures match to the precision written (Beacon's Rx volumes and payer split stand)");
}

// ── 2. Re-ask guard: reason questions ──
{
  const onFile = [{ key: "risk: 2019 union organizing drive", label: "2019 union organizing drive", answer: "The 2019 UAW vote failed 61–39; no activity since", source: "Zoom call with Diane Kline-Morrow" }];
  const draft = "On the 2019 union drive — what drove that, and how close was the vote?";
  const found = findReasks(draft, { sellerMessage: "Sure.", info: {}, documents: [], priorQA: [], onFile });
  const cand = found.filter((f) => f.kind === "fact" && /union/i.test(f.detail));
  assert.ok(cand.length > 0, "the on-file account is a candidate for the check (was skipped as a 'delta')");
  assert.ok(cand.every((f) => f.verify && !f.fallback), "never sure without the check");
  // The check confirms it → it stops the question; no verdict → it goes out.
  assert.ok((await confirmFindings(found, draft, async (_q, c) => new Set(c.filter((x) => /union/i.test(x.text)).map((x) => x.id)))).some((f) => /union/i.test(f.detail)));
  assert.equal((await confirmFindings(found, draft, async () => null)).filter((f) => f.kind === "fact").length, 0);

  // "Why" about a figure on file is a new facet — never a sure fact re-ask.
  const info: any = { scrapRate: "2.9% (2024)", _fieldSources: { scrapRate: { source: "document" } } };
  const why = findReasks("Why is your scrap rate at 2.9%?", { sellerMessage: "ok", info, documents: [], priorQA: [] });
  assert.equal(sureFindings(why).filter((f) => f.kind === "fact").length, 0);
  // …and a "why" after an earlier "what" is for the model to judge, not a sure prior re-ask.
  const priorQA = [{ question: "How many customers did you lose in 2023?", answer: "We lost three accounts that year, all small.", where: "in session 1" }];
  const whyPrior = findReasks("Why did you lose those customers in 2023?", { sellerMessage: "ok", info: {}, documents: [], priorQA });
  assert.equal(sureFindings(whyPrior).filter((f) => f.kind === "prior_question").length, 0);

  // A live conflict the draft doesn't raise is added once.
  const live = [{ kind: "conflict" as const, detail: "scrapRate: the seller just said \"1.8%\", but passage from \"Quality summary\" states \"2.9%\"", key: "scrapRate", onFileValue: "2.9%" }];
  assert.equal(liveConflictFindings(live, "What's your on-time delivery rate?").length, 1);
  assert.equal(liveConflictFindings(live, "The quality summary shows 2.9% for 2024 — which is right?").length, 0);
  assert.equal(liveConflictFindings(live, "What's your on-time delivery rate?", live).length, 0, "not twice");
  ok("re-ask guard: a 'why / what drove' question's candidates go to the check (the union vote) but never stand without it");
}

// ── 3. Live claims: retrieval ──
{
  const quality = doc({
    id: "q1", name: "Quality certifications and performance summary",
    extractedText: [
      "Metric 2022 2023 2024",
      "On-time delivery94.8%96.9%97.6%",
      "Customer complaints requiring 8D1175",
      "Internal scrap rate (% of material)3.9%3.4%2.9%",
      "Cleanroom ISO Class 8 validated by ParticleWorks in 2023",
      ...Array.from({ length: 60 }, (_, i) => `Press ${i + 1} tonnage ${100 + i * 10} runs 3 shifts`),
    ].join("\n"),
  });
  const customers = doc({
    id: "c1", name: "Customer sales and concentration FY2022-2024",
    extractedText: "Customer,2022,2023,2024\nArbor Automotive,11.2%,12.0%,12.4%\nAnnual totals tie to the reviewed financial statements. Tooling on site: about 1,150 customer-owned molds (not GLPP assets).",
  });
  const lease = doc({ id: "l1", name: "Lease", extractedText: "The premises are 186,000 square feet. Rent is $62,000 per month for 10 years." });
  const crm = doc({ id: "x1", name: "CRM note", sourceKind: "crm", visibility: "broker_only", extractedText: "Scrap is really 5.5% per Tom." });
  const chunks = claimChunks([quality, customers, lease, crm]);
  assert.ok(!chunks.some((c) => /5\.5%/.test(c.text)), "broker-only and CRM material is never searched");
  const scrap = rankClaimPassages("Honestly scrap is low, we run about 1.8% plant-wide.", chunks, 3);
  assert.ok(/scrap rate .*2\.9%/.test(scrap[0]?.text ?? ""), `scrap claim → the quality summary row (got: ${scrap[0]?.text})`);
  const molds = rankClaimPassages("We've got about 450 molds on the racks and they're customer-owned.", chunks, 3);
  assert.ok(molds.some((c) => /1,150 customer-owned molds/.test(c.text)));
  assert.ok(claimWords("twenty-six trucks").has("vehicle") && claimWords("24 service vans").has("vehicle"), "trucks and vans are the same count");

  // A money claim is offered the headline money facts — never the broker's own (recast) values.
  const info: any = {
    sde: "$1,312,000 (FY2024)", annualRevenue: "$7,412,000 (FY2024)", netIncome: "$563,190 (FY2024)", businessNumber: "84731 2296",
    _fieldSources: { sde: { source: "broker" }, annualRevenue: { source: "document" }, netIncome: { source: "document" }, businessNumber: { source: "document" } },
  };
  const mat = claimMaterial({ sellerMessage: "The business clears about a million and a half for me all in.", info, documents: [] }, ["The business clears about a million and a half for me all in."]);
  const keys = mat.map((m) => m.key);
  assert.ok(keys.includes("annualRevenue") && keys.includes("netIncome"));
  assert.ok(!keys.includes("sde"), "the broker's recast is never quoted back to the seller");
  assert.ok(!keys.includes("businessNumber"), "'business' pins nothing");
  ok("live claims: a volunteered figure retrieves the passage with the same measure (scrap, customer-owned molds, trucks/vans); money claims get headline money facts, never the broker's");
}

// ── 4. The answer check is hedged ──
{
  const reply = (ids: string[]): any => ({ content: [{ type: "tool_use", input: { mainAsk: "x", answeredBy: ids } }] });
  const delay = <T,>(ms: number, v: T, fail = false) => new Promise<T>((res, rej) => setTimeout(() => (fail ? rej(new Error("overloaded")) : res(v)), ms));
  // Slow first request, fast hedge → the hedge's answer.
  let calls = 0;
  const slowThenFast: CheckRequest = () => (++calls === 1 ? delay(400, reply(["1"])) : delay(20, reply(["2"])));
  const a = await hedgedCheck("q", [{ id: "1", text: "x" }], 1000, slowThenFast, 50);
  assert.equal(a?.hedge, true);
  assert.equal(calls, 2);
  // Fast first request → no hedge sent.
  calls = 0;
  const fast: CheckRequest = () => { calls++; return delay(10, reply(["1"])); };
  const b = await hedgedCheck("q", [{ id: "1", text: "x" }], 1000, fast, 50);
  assert.equal(b?.hedge, false);
  await delay(80, null);
  assert.equal(calls, 1, "no hedge after an answer");
  // A fast failure sends the hedge at once.
  calls = 0;
  const failThenOk: CheckRequest = () => (++calls === 1 ? delay(5, reply([]), true) : delay(10, reply(["1"])));
  const c = await hedgedCheck("q", [{ id: "1", text: "x" }], 1000, failThenOk, 500);
  assert.equal(c?.hedge, true);
  // Both fail → null; neither answers in time → null.
  assert.equal(await hedgedCheck("q", [{ id: "1", text: "x" }], 1000, () => delay(5, reply([]), true), 50), null);
  assert.equal(await hedgedCheck("q", [{ id: "1", text: "x" }], 120, () => delay(1000, reply(["1"])), 30), null);
  ok("answer check: a slow request gets a hedge and the first answer wins; failures and timeouts give no verdict");
}

// ── 5. Opening wait ──
{
  assert.equal(openingEvidenceWaitMs(null, false), 0, "nothing running → no wait");
  assert.equal(openingEvidenceWaitMs(5_000, false), 8_000, "about to land → wait for it");
  assert.equal(openingEvidenceWaitMs(25_000, false), 28_000);
  assert.equal(openingEvidenceWaitMs(60_000, false), 0, "a long way off → don't hold the opening");
  assert.equal(openingEvidenceWaitMs(5_000, true), 8_000);
  assert.equal(openingEvidenceWaitMs(20_000, true), 0, "an earlier build is on file → only a short wait");
  ok("opening: waits for an evidence build only when it is about to land");
}

// ── 6. The seller's coverage is the recorded coverage ──
{
  const deal: any = {
    id: "d1", brokerId: "b1", businessName: "Great Lakes Plastics", industry: "Manufacturing", subIndustry: "Injection molding", location: "Toledo, OH",
    description: null, questionnaireData: null, operationalSystems: null, employeeChart: null, scrapedData: null, scrapeSource: null,
    sellerProfile: null, sectionImportance: null, interviewOutline: null, askingPrice: null, interviewSourceReview: null,
    extractedInfo: { annualRevenue: "$58M", yearFounded: "1978" },
    interviewPlan: {
      industry: "Manufacturing", subIndustry: "Injection molding", rulesVersion: 2, computedAt: "2026-09-01T00:00:00Z", status: "ready",
      items: [
        { key: "robotAutomationLevel", label: "Robot count", sectionKey: "operations", critical: true, answeredByKey: null },
        { key: "scrapAndRegrindRate", label: "Scrap rate", sectionKey: "operations", critical: false, answeredByKey: null },
      ],
    },
  };
  const q = doc({ id: "q1", name: "Quality summary", extractedText: "Internal scrap rate 3.9% 3.4% 2.9%" });
  const evidence = {
    version: 1, fingerprint: "x", computedAt: "2026-09-26T00:00:00Z", status: "ready", checked: [],
    entries: {
      "field:scrapAndRegrindRate": { answer: "3.9% / 3.4% / 2.9%", source: "Quality summary", sourceKind: "document", sourceId: "q1", quote: "Internal scrap rate 3.9% 3.4% 2.9%" },
      "field:robotAutomationLevel": { answer: "21 of 38 presses have robots", source: "Quality summary", sourceKind: "document", sourceId: "q1", quote: "x" },
    },
  };
  const kb = assembleKnowledgeBase({ ...deal, interviewEvidence: evidence }, [q], [], null, []);
  const recorded = kb.recordedCoverage ?? kb.sectionCoverage;
  const withEvidence = kb.sectionCoverage;
  const onFileCount = (cov: typeof recorded) => cov.flatMap((s) => s.fields).filter((f) => f.value !== null).length;
  assert.ok(onFileCount(withEvidence) > onFileCount(recorded), "evidence steers the agent's coverage…");
  // …but the seller progress page (routes.ts) reads recordedCoverage, so its label matches the interview header.
  const plain = assembleKnowledgeBase(deal, [q], [], null, []);
  assert.equal(computeCimReadiness(recorded).score, computeCimReadiness(plain.recordedCoverage ?? plain.sectionCoverage).score);
  ok("coverage: the seller's progress reads recorded coverage (on-file evidence doesn't inflate the label)");
}

console.log(`\n${n} groups passed`);
