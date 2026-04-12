/**
 * cost-tracker.ts
 *
 * Tracks estimated Anthropic API costs during test runs.
 * Each tracked request is mapped to an endpoint category with known
 * cost ranges based on typical token usage.
 *
 * Run standalone to see the cost model: npx tsx tests/utils/cost-tracker.ts
 */

// ─── Cost model ──────────────────────────────────────────────────────────────

/**
 * Estimated cost per AI-backed endpoint category.
 * Min/max in USD per call. Non-AI endpoints cost $0.
 */
interface CostRange {
  min: number;
  max: number;
  model: string;
  description: string;
}

const COST_MODEL: Record<string, CostRange> = {
  interview_turn: {
    min: 0.20,
    max: 0.40,
    model: "claude-opus-4-5",
    description: "Interview agent turn (adaptive multi-turn)",
  },
  financial_analysis: {
    min: 0.10,
    max: 0.20,
    model: "claude-sonnet-4-5",
    description: "Financial reclassification + addback detection",
  },
  cim_layout: {
    min: 0.08,
    max: 0.15,
    model: "claude-sonnet-4-5",
    description: "CIM layout generation (21 layout types)",
  },
  cim_content: {
    min: 0.08,
    max: 0.15,
    model: "claude-sonnet-4-5",
    description: "CIM section content generation",
  },
  cim_blind: {
    min: 0.05,
    max: 0.10,
    model: "claude-sonnet-4-5",
    description: "Blind CIM redaction pass",
  },
  cim_dd: {
    min: 0.05,
    max: 0.10,
    model: "claude-sonnet-4-5",
    description: "DD CIM enrichment pass",
  },
  document_extraction: {
    min: 0.03,
    max: 0.05,
    model: "claude-sonnet-4-5",
    description: "Document text extraction to structured fields",
  },
  buyer_matching_ai: {
    min: 0.02,
    max: 0.04,
    model: "claude-sonnet-4-5",
    description: "Buyer matching AI qualitative phase (40%)",
  },
  web_scrape: {
    min: 0.02,
    max: 0.03,
    model: "claude-sonnet-4-5",
    description: "Web scrape data extraction",
  },
  discrepancy_check: {
    min: 0.03,
    max: 0.06,
    model: "claude-sonnet-4-5",
    description: "Cross-reference interview vs. document data",
  },
  addback_analysis: {
    min: 0.04,
    max: 0.08,
    model: "claude-sonnet-4-5",
    description: "Addback verification analysis",
  },
  qa_answer: {
    min: 0.02,
    max: 0.04,
    model: "claude-sonnet-4-5",
    description: "Buyer Q&A chatbot answer generation",
  },
  outreach_draft: {
    min: 0.02,
    max: 0.04,
    model: "claude-sonnet-4-5",
    description: "Draft outreach email to buyer",
  },
  teaser: {
    min: 0.03,
    max: 0.06,
    model: "claude-sonnet-4-5",
    description: "Teaser/blind profile generation",
  },
  free: {
    min: 0,
    max: 0,
    model: "none",
    description: "No AI cost (CRUD, reads, static)",
  },
};

/**
 * Map an API endpoint path to a cost category.
 * Patterns are checked in order; first match wins.
 */
function classifyEndpoint(endpoint: string): string {
  // Interview
  if (/\/interview\/.*\/message/.test(endpoint)) return "interview_turn";
  if (/\/interview\/.*\/start/.test(endpoint)) return "interview_turn";

  // Financial
  if (/\/financial-analysis$/.test(endpoint) && !/GET/.test(endpoint)) return "financial_analysis";
  if (/\/financial-analysis\/.*\/rerun/.test(endpoint)) return "financial_analysis";
  if (/\/addback-verification\/.*\/analyze/.test(endpoint)) return "addback_analysis";

  // CIM
  if (/\/generate-layout/.test(endpoint)) return "cim_layout";
  if (/\/generate-content/.test(endpoint)) return "cim_content";
  if (/\/generate-blind/.test(endpoint)) return "cim_blind";
  if (/\/generate-dd/.test(endpoint)) return "cim_dd";
  if (/\/generate-teaser/.test(endpoint)) return "teaser";

  // Documents
  if (/\/documents\/.*\/parse/.test(endpoint)) return "document_extraction";
  if (/\/documents\/upload/.test(endpoint)) return "free"; // Upload itself is free; parse is separate

  // Buyer matching
  if (/\/match-buyers/.test(endpoint)) return "buyer_matching_ai";

  // Scraping
  if (/\/scrape/.test(endpoint)) return "web_scrape";

  // Discrepancies
  if (/\/run-discrepancy-check/.test(endpoint)) return "discrepancy_check";

  // Q&A
  if (/\/questions$/.test(endpoint)) return "qa_answer";

  // Outreach
  if (/\/draft-outreach/.test(endpoint)) return "outreach_draft";

  // Everything else is free (CRUD operations, reads)
  return "free";
}

// ─── Tracker ─────────────────────────────────────────────────────────────────

interface TrackedRequest {
  endpoint: string;
  category: string;
  responseTimeMs: number;
  timestamp: number;
}

export interface CostReport {
  totalRequests: number;
  aiRequests: number;
  freeRequests: number;
  requestsByCategory: Record<string, number>;
  estimatedCost: {
    min: number;
    max: number;
    mid: number;
  };
  costBreakdown: Array<{
    category: string;
    description: string;
    model: string;
    count: number;
    costMin: number;
    costMax: number;
    costMid: number;
  }>;
  totalTimeMs: number;
  avgResponseTimeMs: number;
  startedAt: string;
  endedAt: string;
  durationMs: number;
}

export class CostTracker {
  private requests: TrackedRequest[] = [];
  private startTime: number = 0;

  startTracking(): void {
    this.requests = [];
    this.startTime = Date.now();
  }

  trackRequest(endpoint: string, responseTimeMs: number): void {
    const category = classifyEndpoint(endpoint);
    this.requests.push({
      endpoint,
      category,
      responseTimeMs,
      timestamp: Date.now(),
    });
  }

  getReport(): CostReport {
    const endTime = Date.now();
    const byCategory: Record<string, number> = {};

    for (const req of this.requests) {
      byCategory[req.category] = (byCategory[req.category] || 0) + 1;
    }

    let totalMin = 0;
    let totalMax = 0;
    const breakdown: CostReport["costBreakdown"] = [];

    for (const [category, count] of Object.entries(byCategory)) {
      const model = COST_MODEL[category] || COST_MODEL.free;
      const costMin = model.min * count;
      const costMax = model.max * count;
      totalMin += costMin;
      totalMax += costMax;

      breakdown.push({
        category,
        description: model.description,
        model: model.model,
        count,
        costMin: round(costMin),
        costMax: round(costMax),
        costMid: round((costMin + costMax) / 2),
      });
    }

    // Sort breakdown by mid cost descending (most expensive first)
    breakdown.sort((a, b) => b.costMid - a.costMid);

    const totalTime = this.requests.reduce((sum, r) => sum + r.responseTimeMs, 0);
    const aiRequests = this.requests.filter((r) => r.category !== "free").length;

    return {
      totalRequests: this.requests.length,
      aiRequests,
      freeRequests: this.requests.length - aiRequests,
      requestsByCategory: byCategory,
      estimatedCost: {
        min: round(totalMin),
        max: round(totalMax),
        mid: round((totalMin + totalMax) / 2),
      },
      costBreakdown: breakdown,
      totalTimeMs: totalTime,
      avgResponseTimeMs: this.requests.length > 0 ? Math.round(totalTime / this.requests.length) : 0,
      startedAt: new Date(this.startTime).toISOString(),
      endedAt: new Date(endTime).toISOString(),
      durationMs: endTime - this.startTime,
    };
  }

  /**
   * Format the report as a human-readable string for console output.
   */
  formatReport(): string {
    const r = this.getReport();
    const lines: string[] = [];

    lines.push("=== Cost Tracker Report ===");
    lines.push(`Duration: ${(r.durationMs / 1000).toFixed(1)}s`);
    lines.push(`Total requests: ${r.totalRequests} (${r.aiRequests} AI, ${r.freeRequests} free)`);
    lines.push(`Total response time: ${(r.totalTimeMs / 1000).toFixed(1)}s (avg ${r.avgResponseTimeMs}ms)`);
    lines.push("");
    lines.push(`Estimated API cost: $${r.estimatedCost.min.toFixed(2)} - $${r.estimatedCost.max.toFixed(2)} (mid $${r.estimatedCost.mid.toFixed(2)})`);
    lines.push("");

    if (r.costBreakdown.length > 0) {
      lines.push("Breakdown:");
      const maxDescLen = Math.max(...r.costBreakdown.map((b) => b.description.length));
      for (const b of r.costBreakdown) {
        if (b.category === "free") continue;
        const desc = b.description.padEnd(maxDescLen);
        lines.push(`  ${desc}  x${b.count}  $${b.costMin.toFixed(2)}-$${b.costMax.toFixed(2)}  (${b.model})`);
      }
    }

    lines.push("");
    lines.push(`Started: ${r.startedAt}`);
    lines.push(`Ended:   ${r.endedAt}`);

    return lines.join("\n");
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

// ─── Standalone: print cost model ────────────────────────────────────────────

if (process.argv[1] && process.argv[1].endsWith("cost-tracker.ts")) {
  console.log("Cimple Test Suite — Cost Model\n");
  console.log("Category".padEnd(22), "Model".padEnd(20), "Min".padEnd(8), "Max".padEnd(8), "Description");
  console.log("-".repeat(100));

  for (const [key, val] of Object.entries(COST_MODEL)) {
    if (key === "free") continue;
    console.log(
      key.padEnd(22),
      val.model.padEnd(20),
      `$${val.min.toFixed(2)}`.padEnd(8),
      `$${val.max.toFixed(2)}`.padEnd(8),
      val.description,
    );
  }

  // Example: simulate a full pipeline test
  console.log("\n--- Example: Full Pipeline Run ---\n");
  const tracker = new CostTracker();
  tracker.startTracking();

  // Simulate typical calls
  const simulated: Array<[string, number]> = [
    ["/api/deals", 50],
    ["/api/deals/1/documents/upload", 200],
    ["/api/documents/1/parse", 3000],
    ["/api/documents/2/parse", 2800],
    ["/api/interview/1/start", 4000],
    ["/api/interview/1/message", 5000],
    ["/api/interview/1/message", 4500],
    ["/api/interview/1/message", 5200],
    ["/api/interview/1/message", 4800],
    ["/api/interview/1/message", 5100],
    ["/api/deals/1/financial-analysis", 8000],
    ["/api/deals/1/generate-layout", 6000],
    ["/api/deals/1/generate-content", 12000],
    ["/api/deals/1/generate-blind", 5000],
    ["/api/deals/1/match-buyers", 3000],
    ["/api/deals/1/run-discrepancy-check", 4000],
    ["/api/deals/1/scrape", 3000],
  ];

  for (const [ep, ms] of simulated) {
    tracker.trackRequest(ep, ms);
  }

  console.log(tracker.formatReport());
}
