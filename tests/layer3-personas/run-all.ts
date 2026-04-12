/**
 * run-all.ts
 *
 * Master runner for Layer 3 persona-driven E2E tests.
 * Runs 5 scenarios in sequence, evaluates results against broker
 * persona criteria, prints a comprehensive report, and saves
 * detailed results to disk.
 *
 * Usage:
 *   npx tsx tests/layer3-personas/run-all.ts [baseUrl] [maxTurns]
 *
 * Examples:
 *   npx tsx tests/layer3-personas/run-all.ts
 *   npx tsx tests/layer3-personas/run-all.ts http://localhost:5000 15
 *   npx tsx tests/layer3-personas/run-all.ts https://cimple-production.up.railway.app 25
 */

import fs from "fs";
import path from "path";

import { ApiClient } from "../utils/api-client.js";
import { CostTracker } from "../utils/cost-tracker.js";
import { cleanupDeal } from "../utils/test-helpers.js";

import {
  organizedProfessional,
  evasiveOne,
  overwhelmedFirstTimer,
  cooperativeButVague,
  overconfidentOwner,
} from "./personas/sellers.js";
import type { SellerPersona } from "./personas/sellers.js";

import {
  veteran,
  growingBroker,
  reluctantAdopter,
  evaluateScenario,
} from "./personas/brokers.js";
import type { BrokerPersona, BrokerEvaluation, ScenarioResultForEval } from "./personas/brokers.js";

import { runPersonaScenario } from "./scenarios/run-scenario.js";
import type { ScenarioResult } from "./scenarios/run-scenario.js";

// ─── Configuration ──────────────────────────────────────────────────────────

const BASE_URL = process.argv[2] || "http://localhost:5000";
const MAX_INTERVIEW_TURNS = parseInt(process.argv[3] || "25", 10);

const TEST_DATA_ROOT = path.resolve(import.meta.dirname ?? __dirname, "../test-data");
const RESULTS_DIR = path.resolve(import.meta.dirname ?? __dirname, "results");

const BROKER_USERNAME = process.env.TEST_BROKER_USERNAME || "admin";
const BROKER_PASSWORD = process.env.TEST_BROKER_PASSWORD || "admin123";

// ─── Scenario definitions ───────────────────────────────────────────────────

interface ScenarioDefinition {
  id: string;
  label: string;
  seller: SellerPersona;
  broker: BrokerPersona;
  buyerCsvPath: string;
}

const SCENARIOS: ScenarioDefinition[] = [
  {
    id: "construction",
    label: "Construction -- Veteran + Organized Professional",
    seller: organizedProfessional,
    broker: veteran,
    buyerCsvPath: path.join(TEST_DATA_ROOT, "construction-ontario/buyers/buyer-list-15.csv"),
  },
  {
    id: "restaurant",
    label: "Restaurant -- Growing Broker + Evasive One",
    seller: evasiveOne,
    broker: growingBroker,
    buyerCsvPath: path.join(TEST_DATA_ROOT, "restaurant-toronto/buyers/buyer-list-10.csv"),
  },
  {
    id: "medical",
    label: "Medical -- Reluctant Adopter + Overwhelmed First-Timer",
    seller: overwhelmedFirstTimer,
    broker: reluctantAdopter,
    buyerCsvPath: path.join(TEST_DATA_ROOT, "medical-clinic-ontario/buyers/buyer-list-8.csv"),
  },
  {
    id: "manufacturing",
    label: "Manufacturing -- Veteran + Cooperative but Vague",
    seller: cooperativeButVague,
    broker: veteran,
    buyerCsvPath: path.join(TEST_DATA_ROOT, "manufacturing-alberta/buyers/buyer-list-12.csv"),
  },
  {
    id: "it-msp",
    label: "IT/MSP -- Growing Broker + Overconfident Owner",
    seller: overconfidentOwner,
    broker: growingBroker,
    buyerCsvPath: path.join(TEST_DATA_ROOT, "it-msp-bc/buyers/buyer-list-10.csv"),
  },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

function scenarioResultToEval(r: ScenarioResult): ScenarioResultForEval {
  return {
    interviewTurnCount: r.interviewTurnCount,
    coveragePercent: r.coveragePercent,
    coverageBySections: r.coverageBySections,
    industryIdentified: r.industryIdentified,
    industrySpecificQuestionsAsked: r.industrySpecificQuestionsAsked,
    reAskedFields: r.reAskedFields,
    deferredTopics: r.deferredTopics,
    financialAnalysisCompleted: r.financialAnalysisCompleted,
    financialInsightsCount: r.financialInsightsCount,
    cimSectionsGenerated: r.cimSectionsGenerated,
    cimLayoutTypes: r.cimLayoutTypes,
    discrepanciesFound: r.discrepanciesFound,
    discrepanciesCritical: r.discrepanciesCritical,
    buyersMatched: r.buyersMatched,
    errorsEncountered: r.errorsEncountered,
    totalDurationMs: r.totalDurationMs,
    apiResponseTimesMs: r.apiResponseTimesMs,
  };
}

function printDivider(char = "=", width = 72): void {
  console.log(char.repeat(width));
}

function printHeader(title: string): void {
  console.log("");
  printDivider();
  console.log(`  ${title}`);
  printDivider();
}

function printSubHeader(title: string): void {
  console.log("");
  printDivider("-", 60);
  console.log(`  ${title}`);
  printDivider("-", 60);
}

// ─── Report printer ────────────────────────────────────────────────────────

function printScenarioSummary(result: ScenarioResult): void {
  printSubHeader(`${result.scenarioName} (${result.sellerPersona})`);

  console.log(`  Deal ID:           #${result.dealId}`);
  console.log(`  Duration:          ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  console.log(`  Interview turns:   ${result.interviewTurnCount}`);
  console.log(`  Coverage:          ${result.coveragePercent.toFixed(1)}%`);
  console.log(`  Industry detected: ${result.industryIdentified ? "yes" : "NO"}`);
  console.log(`  Industry Q's:      ${result.industrySpecificQuestionsAsked}`);
  console.log(`  Deferred topics:   ${result.deferredTopics.length}`);
  console.log(`  Re-asked fields:   ${result.reAskedFields.length}`);
  console.log(`  Financial analysis:${result.financialAnalysisCompleted ? " completed" : " FAILED"}`);
  console.log(`  Financial insights:${result.financialInsightsCount}`);
  console.log(`  CIM sections:      ${result.cimSectionsGenerated}`);
  console.log(`  CIM layout types:  ${new Set(result.cimLayoutTypes).size} unique`);
  console.log(`  Blind CIM:         ${result.blindCimGenerated ? "generated" : "FAILED"}`);
  console.log(`  Discrepancies:     ${result.discrepanciesFound} (${result.discrepanciesCritical} critical)`);
  console.log(`  Buyers imported:   ${result.buyersImported}`);
  console.log(`  Buyers matched:    ${result.buyersMatched}`);
  console.log(`  Errors:            ${result.errorsEncountered.length}`);

  if (result.errorsEncountered.length > 0) {
    console.log("  Errors:");
    for (const err of result.errorsEncountered) {
      console.log(`    - ${err}`);
    }
  }
}

function printBrokerEvaluation(evaluation: BrokerEvaluation): void {
  const status = evaluation.wouldAbandon ? "WOULD ABANDON" : "WOULD KEEP USING";
  console.log(`\n  ${evaluation.broker.archetype} (${evaluation.broker.name}): ${status}`);
  console.log(`    Overall score: ${evaluation.overallScore}/100`);
  console.log(`    Friction: ${evaluation.totalFrictionPoints}/${evaluation.frictionThreshold} threshold`);

  for (const cr of evaluation.criteriaResults) {
    const mark = cr.passed ? "PASS" : "FAIL";
    console.log(`    [${mark}] ${cr.criterion} (${cr.score}/100, weight ${cr.weight})`);
    console.log(`           ${cr.details}`);
    for (const fp of cr.frictionPoints) {
      console.log(`           >> ${fp}`);
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  printHeader("CIMPLE LAYER 3 -- PERSONA-DRIVEN E2E TESTS");
  console.log(`  Server:           ${BASE_URL}`);
  console.log(`  Max turns:        ${MAX_INTERVIEW_TURNS}`);
  console.log(`  Scenarios:        ${SCENARIOS.length}`);
  console.log(`  Results dir:      ${RESULTS_DIR}`);
  console.log(`  Started:          ${new Date().toISOString()}`);

  // Ensure results directory exists
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  // Set up API client and cost tracker
  const api = new ApiClient({ baseUrl: BASE_URL, verbose: false });
  const costTracker = new CostTracker();
  costTracker.startTracking();

  // Authenticate as broker
  console.log("\nAuthenticating as broker...");
  const loginRes = await api.brokerLogin(BROKER_USERNAME, BROKER_PASSWORD);
  if (loginRes.status !== 200) {
    console.error(`Broker login failed: ${loginRes.status}`);
    console.error("Set TEST_BROKER_USERNAME and TEST_BROKER_PASSWORD environment variables.");
    process.exit(1);
  }
  console.log("Authenticated.\n");

  // Run scenarios sequentially
  const results: ScenarioResult[] = [];
  const evaluations: BrokerEvaluation[] = [];
  const dealIds: number[] = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];

    printHeader(`SCENARIO ${i + 1}/${SCENARIOS.length}: ${scenario.label}`);

    try {
      const result = await runPersonaScenario({
        seller: scenario.seller,
        broker: scenario.broker,
        dealName: `TEST_L3_${scenario.id}_${Date.now()}`,
        industry: scenario.seller.industry,
        documentsDir: scenario.seller.documentsDir,
        buyerCsvPath: scenario.buyerCsvPath,
        apiClient: api,
        costTracker,
        maxInterviewTurns: MAX_INTERVIEW_TURNS,
      });

      results.push(result);
      dealIds.push(result.dealId);

      // Print scenario summary
      printScenarioSummary(result);

      // Evaluate against the broker persona
      const evalResult = evaluateScenario(
        scenario.broker,
        scenario.label,
        scenarioResultToEval(result),
      );
      evaluations.push(evalResult);
      printBrokerEvaluation(evalResult);

      // Save individual scenario result
      const scenarioFile = path.join(RESULTS_DIR, `${scenario.id}-result.json`);
      fs.writeFileSync(scenarioFile, JSON.stringify(result, null, 2));
      console.log(`\n  Result saved: ${scenarioFile}`);

      // Save the interview transcript as readable text
      const transcriptFile = path.join(RESULTS_DIR, `${scenario.id}-transcript.txt`);
      const transcriptText = result.interviewTranscript
        .map((t) => [
          `--- Turn ${t.turnNumber} ---`,
          `[AI Interviewer]:`,
          t.aiMessage,
          ``,
          `[${scenario.seller.name}]:`,
          t.sellerResponse,
          ``,
          `Coverage: ${t.coverageAfter ?? "?"}% | AI: ${t.responseTimeMs}ms | Sim: ${t.sellerSimTimeMs}ms`,
          ``,
        ].join("\n"))
        .join("\n");
      fs.writeFileSync(transcriptFile, transcriptText);
      console.log(`  Transcript saved: ${transcriptFile}`);

    } catch (err: any) {
      console.error(`\n  SCENARIO FAILED: ${err.message}`);
      results.push({
        scenarioName: scenario.label,
        sellerPersona: scenario.seller.id,
        brokerPersona: scenario.broker.id,
        dealId: 0,
        sessionId: null,
        interviewTranscript: [],
        interviewTurnCount: 0,
        coveragePercent: 0,
        coverageBySections: {},
        industryIdentified: false,
        industrySpecificQuestionsAsked: 0,
        reAskedFields: [],
        deferredTopics: [],
        financialAnalysisCompleted: false,
        financialInsightsCount: 0,
        financialAnalysisData: null,
        cimSectionsGenerated: 0,
        cimLayoutTypes: [],
        cimSections: [],
        blindCimGenerated: false,
        discrepanciesFound: 0,
        discrepanciesCritical: 0,
        discrepancies: [],
        buyersImported: 0,
        buyersMatched: 0,
        buyerMatchResults: [],
        errorsEncountered: [`Fatal: ${err.message}`],
        apiResponseTimesMs: [],
        totalDurationMs: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      });
    }
  }

  // ── Comprehensive report ────────────────────────────────────────────

  printHeader("COMPREHENSIVE REPORT");

  // Scenario summary table
  console.log("\n  Scenario Results:");
  console.log("  " + "-".repeat(68));
  console.log(
    "  " +
    "Scenario".padEnd(20) +
    "Turns".padEnd(8) +
    "Cov%".padEnd(8) +
    "CIM".padEnd(6) +
    "Fin".padEnd(6) +
    "Disc".padEnd(6) +
    "Buyers".padEnd(8) +
    "Errors".padEnd(8),
  );
  console.log("  " + "-".repeat(68));

  for (const r of results) {
    console.log(
      "  " +
      r.sellerPersona.slice(0, 18).padEnd(20) +
      String(r.interviewTurnCount).padEnd(8) +
      `${r.coveragePercent.toFixed(0)}%`.padEnd(8) +
      String(r.cimSectionsGenerated).padEnd(6) +
      (r.financialAnalysisCompleted ? "yes" : "NO").padEnd(6) +
      String(r.discrepanciesFound).padEnd(6) +
      String(r.buyersMatched).padEnd(8) +
      String(r.errorsEncountered.length).padEnd(8),
    );
  }

  // Broker evaluation summary
  printSubHeader("Broker Persona Evaluations");

  const abandonCount = evaluations.filter((e) => e.wouldAbandon).length;
  const keepCount = evaluations.filter((e) => !e.wouldAbandon).length;

  console.log(`\n  Would keep using: ${keepCount}/${evaluations.length}`);
  console.log(`  Would abandon:    ${abandonCount}/${evaluations.length}`);

  for (const evaluation of evaluations) {
    const status = evaluation.wouldAbandon ? "ABANDON" : "KEEP";
    console.log(
      `  [${status}] ${evaluation.broker.archetype.padEnd(22)} ${evaluation.scenario.slice(0, 30).padEnd(32)} Score: ${evaluation.overallScore}/100  Friction: ${evaluation.totalFrictionPoints}/${evaluation.frictionThreshold}`,
    );
  }

  // Aggregate friction analysis
  printSubHeader("Top Friction Points (Across All Evaluations)");

  const allFriction: Record<string, number> = {};
  for (const evaluation of evaluations) {
    for (const cr of evaluation.criteriaResults) {
      for (const fp of cr.frictionPoints) {
        allFriction[fp] = (allFriction[fp] || 0) + 1;
      }
    }
  }

  const sortedFriction = Object.entries(allFriction)
    .sort(([, a], [, b]) => b - a);

  if (sortedFriction.length === 0) {
    console.log("  No friction points detected.");
  } else {
    for (const [fp, count] of sortedFriction) {
      console.log(`  (${count}x) ${fp}`);
    }
  }

  // Cost report
  printSubHeader("Cost Report");
  console.log(costTracker.formatReport());

  // Overall statistics
  printSubHeader("Overall Statistics");

  const totalTurns = results.reduce((s, r) => s + r.interviewTurnCount, 0);
  const avgCoverage = results.length > 0
    ? results.reduce((s, r) => s + r.coveragePercent, 0) / results.length
    : 0;
  const totalErrors = results.reduce((s, r) => s + r.errorsEncountered.length, 0);
  const totalDuration = results.reduce((s, r) => s + r.totalDurationMs, 0);

  console.log(`  Total interview turns:      ${totalTurns}`);
  console.log(`  Average coverage:           ${avgCoverage.toFixed(1)}%`);
  console.log(`  Total CIM sections:         ${results.reduce((s, r) => s + r.cimSectionsGenerated, 0)}`);
  console.log(`  Total discrepancies:        ${results.reduce((s, r) => s + r.discrepanciesFound, 0)}`);
  console.log(`  Total buyers matched:       ${results.reduce((s, r) => s + r.buyersMatched, 0)}`);
  console.log(`  Total errors:               ${totalErrors}`);
  console.log(`  Total duration:             ${(totalDuration / 1000).toFixed(1)}s (${(totalDuration / 60000).toFixed(1)}min)`);

  // ── Save full results ─────────────────────────────────────────────

  const fullReport = {
    meta: {
      baseUrl: BASE_URL,
      maxInterviewTurns: MAX_INTERVIEW_TURNS,
      scenarioCount: SCENARIOS.length,
      startedAt: results[0]?.startedAt ?? new Date().toISOString(),
      completedAt: results[results.length - 1]?.completedAt ?? new Date().toISOString(),
    },
    summary: {
      totalTurns,
      averageCoverage: Math.round(avgCoverage * 10) / 10,
      totalErrors,
      totalDurationMs: totalDuration,
      brokerRetention: `${keepCount}/${evaluations.length}`,
      brokerAbandonment: `${abandonCount}/${evaluations.length}`,
    },
    evaluations,
    frictionPoints: sortedFriction.map(([fp, count]) => ({ point: fp, occurrences: count })),
    costReport: costTracker.getReport(),
  };

  const reportFile = path.join(RESULTS_DIR, "full-report.json");
  fs.writeFileSync(reportFile, JSON.stringify(fullReport, null, 2));
  console.log(`\n  Full report saved: ${reportFile}`);

  // ── Cleanup test deals ────────────────────────────────────────────

  printSubHeader("Cleanup");
  console.log(`  Cleaning up ${dealIds.length} test deals...`);

  for (const dealId of dealIds) {
    if (dealId > 0) {
      await cleanupDeal(api, dealId);
      console.log(`  Deleted deal #${dealId}`);
    }
  }

  // ── Final verdict ─────────────────────────────────────────────────

  printHeader("FINAL VERDICT");

  const allScenariosRan = results.every((r) => r.interviewTurnCount > 0);
  const noCriticalFailures = results.every((r) =>
    r.errorsEncountered.filter((e) => e.startsWith("Fatal")).length === 0,
  );
  const majorityKeep = keepCount > abandonCount;

  if (allScenariosRan && noCriticalFailures && majorityKeep) {
    console.log("  PASS -- All scenarios completed. Majority of broker personas would keep using.");
  } else if (allScenariosRan && noCriticalFailures) {
    console.log("  WARN -- All scenarios completed but broker satisfaction is low.");
  } else {
    console.log("  FAIL -- Critical failures detected. Review errors above.");
  }

  console.log(`\n  Completed: ${new Date().toISOString()}\n`);

  // Exit with non-zero if there were critical failures
  if (!allScenariosRan || !noCriticalFailures) {
    process.exit(1);
  }
}

// ─── Entry point ────────────────────────────────────────────────────────────

main().catch((err) => {
  console.error("\nFatal error in test runner:", err);
  process.exit(1);
});
