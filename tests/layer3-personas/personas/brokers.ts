/**
 * brokers.ts
 *
 * Three broker personas for Layer 3 E2E testing.
 * These are not used to simulate interview behavior -- they define
 * evaluation criteria that are applied AFTER each scenario completes.
 * Each broker persona represents a distinct user archetype with
 * different tolerances and priorities.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface EvaluationCriterion {
  id: string;
  label: string;
  description: string;
  weight: number; // 0-1, how much this criterion matters to this broker
  evaluate: (result: ScenarioResultForEval) => CriterionResult;
}

export interface CriterionResult {
  score: number; // 0-100
  passed: boolean;
  details: string;
  frictionPoints: string[];
}

export interface BrokerPersona {
  id: string;
  name: string;
  archetype: string;
  description: string;
  frictionThreshold: number;
  evaluationCriteria: EvaluationCriterion[];
}

/**
 * Subset of scenario results that broker evaluation criteria inspect.
 * Keeps the evaluation functions decoupled from the full ScenarioResult.
 */
export interface ScenarioResultForEval {
  interviewTurnCount: number;
  coveragePercent: number;
  coverageBySections: Record<string, number>;
  industryIdentified: boolean;
  industrySpecificQuestionsAsked: number;
  reAskedFields: string[];
  deferredTopics: string[];
  financialAnalysisCompleted: boolean;
  financialInsightsCount: number;
  cimSectionsGenerated: number;
  cimLayoutTypes: string[];
  discrepanciesFound: number;
  discrepanciesCritical: number;
  buyersMatched: number;
  errorsEncountered: string[];
  totalDurationMs: number;
  apiResponseTimesMs: number[];
}

// ─── Evaluation helpers ─────────────────────────────────────────────────────

function avgResponseTime(times: number[]): number {
  if (times.length === 0) return 0;
  return Math.round(times.reduce((a, b) => a + b, 0) / times.length);
}

function slowRequestCount(times: number[], thresholdMs: number): number {
  return times.filter((t) => t > thresholdMs).length;
}

// ─── 1. The Veteran ─────────────────────────────────────────────────────────

export const veteran: BrokerPersona = {
  id: "veteran",
  name: "Sandra Mitchell",
  archetype: "The Veteran",
  description:
    "20+ years in M&A advisory. Has seen every tool on the market. Evaluates based on output quality and intelligence depth. Has no patience for tools that re-ask questions or produce generic output.",
  frictionThreshold: 2,

  evaluationCriteria: [
    {
      id: "output_quality",
      label: "CIM Output Quality",
      description: "CIM must use varied layout types and feel visually compelling, not text-only",
      weight: 0.25,
      evaluate: (r) => {
        const uniqueLayouts = new Set(r.cimLayoutTypes).size;
        const hasCharts = r.cimLayoutTypes.some((t) =>
          ["bar_chart", "line_chart", "pie_chart", "donut_chart", "metric_grid"].includes(t),
        );
        const score = Math.min(100, uniqueLayouts * 12 + (hasCharts ? 20 : 0));
        const friction: string[] = [];
        if (uniqueLayouts < 4) friction.push("CIM uses fewer than 4 distinct layout types");
        if (!hasCharts) friction.push("CIM has no chart-based sections");
        return {
          score,
          passed: score >= 60,
          details: `${uniqueLayouts} unique layout types, charts: ${hasCharts}`,
          frictionPoints: friction,
        };
      },
    },
    {
      id: "industry_intelligence",
      label: "Industry Intelligence Depth",
      description: "Interview must ask industry-specific questions beyond generic CIM sections",
      weight: 0.25,
      evaluate: (r) => {
        const score = Math.min(100, r.industrySpecificQuestionsAsked * 15);
        const friction: string[] = [];
        if (!r.industryIdentified) friction.push("Industry not identified early in interview");
        if (r.industrySpecificQuestionsAsked < 3) friction.push("Too few industry-specific questions asked");
        return {
          score,
          passed: r.industryIdentified && r.industrySpecificQuestionsAsked >= 3,
          details: `Industry identified: ${r.industryIdentified}, industry questions: ${r.industrySpecificQuestionsAsked}`,
          frictionPoints: friction,
        };
      },
    },
    {
      id: "do_not_reask",
      label: "Do-Not-Re-Ask Compliance",
      description: "Interview must NEVER re-ask for information already provided in documents or questionnaire",
      weight: 0.3,
      evaluate: (r) => {
        const reAskCount = r.reAskedFields.length;
        const score = reAskCount === 0 ? 100 : Math.max(0, 100 - reAskCount * 30);
        const friction: string[] = [];
        if (reAskCount > 0) {
          friction.push(`Re-asked ${reAskCount} fields: ${r.reAskedFields.join(", ")}`);
        }
        return {
          score,
          passed: reAskCount === 0,
          details: `Re-asked fields: ${reAskCount}`,
          frictionPoints: friction,
        };
      },
    },
    {
      id: "coverage_completeness",
      label: "Coverage Completeness",
      description: "Interview must achieve meaningful coverage across all CIM sections",
      weight: 0.2,
      evaluate: (r) => {
        const score = Math.round(r.coveragePercent);
        const friction: string[] = [];
        if (r.coveragePercent < 50) friction.push(`Coverage only ${r.coveragePercent.toFixed(0)}%`);
        const emptySections = Object.entries(r.coverageBySections)
          .filter(([, v]) => v === 0)
          .map(([k]) => k);
        if (emptySections.length > 3) {
          friction.push(`${emptySections.length} sections with zero coverage`);
        }
        return {
          score,
          passed: r.coveragePercent >= 50,
          details: `Overall coverage: ${r.coveragePercent.toFixed(1)}%`,
          frictionPoints: friction,
        };
      },
    },
  ],
};

// ─── 2. The Growing Broker ──────────────────────────────────────────────────

export const growingBroker: BrokerPersona = {
  id: "growing-broker",
  name: "James Park",
  archetype: "The Growing Broker",
  description:
    "5 years in the business, tech-savvy, evaluates every SaaS tool carefully. Cares about intuitiveness, error handling, and whether the platform teaches him something. Tolerant but observant.",
  frictionThreshold: 5,

  evaluationCriteria: [
    {
      id: "pipeline_completion",
      label: "End-to-End Pipeline Completion",
      description: "All pipeline stages must complete without fatal errors",
      weight: 0.3,
      evaluate: (r) => {
        const stages = [
          r.interviewTurnCount > 0,
          r.financialAnalysisCompleted,
          r.cimSectionsGenerated > 0,
          r.buyersMatched > 0,
        ];
        const completed = stages.filter(Boolean).length;
        const score = Math.round((completed / stages.length) * 100);
        const friction: string[] = [];
        if (!stages[0]) friction.push("Interview did not produce any turns");
        if (!stages[1]) friction.push("Financial analysis did not complete");
        if (!stages[2]) friction.push("No CIM sections generated");
        if (!stages[3]) friction.push("Buyer matching returned zero results");
        return {
          score,
          passed: completed === stages.length,
          details: `${completed}/${stages.length} pipeline stages completed`,
          frictionPoints: friction,
        };
      },
    },
    {
      id: "error_recovery",
      label: "Error Recovery & Resilience",
      description: "Errors should be graceful, not crash the pipeline. Some errors are expected.",
      weight: 0.2,
      evaluate: (r) => {
        const errorCount = r.errorsEncountered.length;
        const score = errorCount === 0 ? 100 : Math.max(0, 100 - errorCount * 15);
        const friction: string[] = [];
        if (errorCount > 3) friction.push(`${errorCount} errors encountered during pipeline`);
        for (const err of r.errorsEncountered) {
          if (err.toLowerCase().includes("crash") || err.toLowerCase().includes("unhandled")) {
            friction.push(`Unhandled/crash error: ${err}`);
          }
        }
        return {
          score,
          passed: errorCount <= 3,
          details: `${errorCount} errors encountered`,
          frictionPoints: friction,
        };
      },
    },
    {
      id: "feature_breadth",
      label: "Feature Breadth",
      description: "The pipeline should exercise discrepancy detection, financial insights, and multiple CIM versions",
      weight: 0.25,
      evaluate: (r) => {
        let featureScore = 0;
        const friction: string[] = [];

        if (r.financialInsightsCount > 0) featureScore += 25;
        else friction.push("No financial insights generated");

        if (r.discrepanciesFound > 0) featureScore += 25;
        else friction.push("No discrepancies detected (may indicate engine not running)");

        if (r.cimSectionsGenerated >= 8) featureScore += 25;
        else friction.push(`Only ${r.cimSectionsGenerated} CIM sections (expected 8+)`);

        if (r.deferredTopics.length > 0 && r.deferredTopics.length <= 5) featureScore += 25;
        else if (r.deferredTopics.length === 0) friction.push("No deferred topics (interview may not be probing enough)");
        else friction.push(`${r.deferredTopics.length} deferred topics (too many deferrals)`);

        return {
          score: featureScore,
          passed: featureScore >= 50,
          details: `Feature breadth score: ${featureScore}/100`,
          frictionPoints: friction,
        };
      },
    },
    {
      id: "response_speed",
      label: "Response Speed",
      description: "API responses should feel snappy. Interview turns under 15s, other calls under 30s.",
      weight: 0.25,
      evaluate: (r) => {
        const avg = avgResponseTime(r.apiResponseTimesMs);
        const slowCount = slowRequestCount(r.apiResponseTimesMs, 30000);
        const score = Math.max(0, 100 - slowCount * 10 - Math.max(0, avg - 5000) / 100);
        const friction: string[] = [];
        if (avg > 10000) friction.push(`Average response time ${(avg / 1000).toFixed(1)}s (target <10s)`);
        if (slowCount > 2) friction.push(`${slowCount} requests exceeded 30s`);
        return {
          score: Math.round(score),
          passed: avg <= 15000 && slowCount <= 3,
          details: `Avg response: ${(avg / 1000).toFixed(1)}s, slow requests: ${slowCount}`,
          frictionPoints: friction,
        };
      },
    },
  ],
};

// ─── 3. The Reluctant Adopter ───────────────────────────────────────────────

export const reluctantAdopter: BrokerPersona = {
  id: "reluctant-adopter",
  name: "Robert Flanagan",
  archetype: "The Reluctant Adopter",
  description:
    "30 years in the business. Uses Excel and email. Tries every new tool once and abandons it if confused. One confusing moment and he is done. Evaluates on speed, simplicity, and whether the platform delivers immediate value.",
  frictionThreshold: 1,

  evaluationCriteria: [
    {
      id: "immediate_value",
      label: "Immediate Value Demonstration",
      description: "After documents + questionnaire + a few interview turns, there must already be visible output",
      weight: 0.4,
      evaluate: (r) => {
        // By turn 10, there should be meaningful coverage
        const earlyValue = r.coveragePercent > 20 && r.interviewTurnCount <= 25;
        const score = earlyValue ? 100 : r.coveragePercent < 10 ? 20 : 60;
        const friction: string[] = [];
        if (r.coveragePercent < 20) {
          friction.push(`Only ${r.coveragePercent.toFixed(0)}% coverage after full interview -- where is the value?`);
        }
        if (r.cimSectionsGenerated === 0) {
          friction.push("No CIM sections generated -- nothing to show for the effort");
        }
        return {
          score,
          passed: earlyValue,
          details: `Coverage: ${r.coveragePercent.toFixed(1)}% in ${r.interviewTurnCount} turns`,
          frictionPoints: friction,
        };
      },
    },
    {
      id: "simplicity",
      label: "Simplicity (No Errors, No Confusion)",
      description: "Zero errors during the pipeline. Any error is a friction point.",
      weight: 0.35,
      evaluate: (r) => {
        const errorCount = r.errorsEncountered.length;
        const score = errorCount === 0 ? 100 : 0;
        const friction = r.errorsEncountered.map((e) => `Error: ${e}`);
        return {
          score,
          passed: errorCount === 0,
          details: `${errorCount} errors`,
          frictionPoints: friction,
        };
      },
    },
    {
      id: "speed",
      label: "Speed (No Waiting)",
      description: "Total pipeline time must be reasonable. Any request over 30s is a dealbreaker.",
      weight: 0.25,
      evaluate: (r) => {
        const totalMinutes = r.totalDurationMs / 60000;
        const hasTimeouts = r.apiResponseTimesMs.some((t) => t > 60000);
        const slowCount = slowRequestCount(r.apiResponseTimesMs, 30000);
        let score = 100;
        const friction: string[] = [];

        if (hasTimeouts) {
          score = 0;
          friction.push("At least one request timed out (>60s)");
        } else if (slowCount > 0) {
          score = Math.max(0, 100 - slowCount * 30);
          friction.push(`${slowCount} requests took over 30s -- feels broken`);
        }
        if (totalMinutes > 20) {
          score = Math.min(score, 40);
          friction.push(`Total pipeline took ${totalMinutes.toFixed(1)} minutes`);
        }

        return {
          score: Math.round(score),
          passed: score >= 70,
          details: `Total: ${totalMinutes.toFixed(1)}min, slow requests: ${slowCount}`,
          frictionPoints: friction,
        };
      },
    },
  ],
};

// ─── Evaluation runner ──────────────────────────────────────────────────────

export interface BrokerEvaluation {
  broker: { id: string; name: string; archetype: string };
  scenario: string;
  frictionThreshold: number;
  totalFrictionPoints: number;
  wouldAbandon: boolean;
  overallScore: number;
  criteriaResults: Array<{
    criterion: string;
    weight: number;
    score: number;
    passed: boolean;
    details: string;
    frictionPoints: string[];
  }>;
}

/**
 * Run all evaluation criteria for a broker persona against a scenario result.
 */
export function evaluateScenario(
  broker: BrokerPersona,
  scenarioName: string,
  result: ScenarioResultForEval,
): BrokerEvaluation {
  const criteriaResults = broker.evaluationCriteria.map((criterion) => {
    const evalResult = criterion.evaluate(result);
    return {
      criterion: criterion.label,
      weight: criterion.weight,
      score: evalResult.score,
      passed: evalResult.passed,
      details: evalResult.details,
      frictionPoints: evalResult.frictionPoints,
    };
  });

  const totalFriction = criteriaResults.reduce(
    (sum, cr) => sum + cr.frictionPoints.length,
    0,
  );

  const weightedScore = criteriaResults.reduce(
    (sum, cr) => sum + cr.score * cr.weight,
    0,
  );

  return {
    broker: { id: broker.id, name: broker.name, archetype: broker.archetype },
    scenario: scenarioName,
    frictionThreshold: broker.frictionThreshold,
    totalFrictionPoints: totalFriction,
    wouldAbandon: totalFriction > broker.frictionThreshold,
    overallScore: Math.round(weightedScore),
    criteriaResults,
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────

export const ALL_BROKERS: BrokerPersona[] = [
  veteran,
  growingBroker,
  reluctantAdopter,
];

export default ALL_BROKERS;
