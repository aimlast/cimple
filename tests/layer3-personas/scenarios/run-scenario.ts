/**
 * run-scenario.ts
 *
 * Runs a full E2E persona-driven scenario: deal creation, document upload,
 * questionnaire submission, AI interview (simulated via Claude Sonnet acting
 * as the seller), financial analysis, CIM generation, discrepancy check,
 * buyer import, and buyer matching.
 *
 * The interview simulation loop is the critical part -- Claude Sonnet
 * receives the seller persona's system prompt and the full conversation
 * history, then responds in character. That response is sent back to the
 * Cimple interview endpoint.
 */

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";

import type { ApiClient } from "../../utils/api-client.js";
import type { CostTracker } from "../../utils/cost-tracker.js";
import {
  createTestDeal,
  waitForProcessing,
  waitForAnalysis,
  sleep,
} from "../../utils/test-helpers.js";
import type { SellerPersona } from "../personas/sellers.js";
import type { BrokerPersona } from "../personas/brokers.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ScenarioConfig {
  seller: SellerPersona;
  broker: BrokerPersona;
  dealName: string;
  industry: string;
  documentsDir: string;
  buyerCsvPath: string;
  apiClient: ApiClient;
  costTracker: CostTracker;
  maxInterviewTurns: number;
}

export interface InterviewTurn {
  turnNumber: number;
  aiMessage: string;
  sellerResponse: string;
  coverageAfter: number | null;
  responseTimeMs: number;
  sellerSimTimeMs: number;
}

export interface ScenarioResult {
  scenarioName: string;
  sellerPersona: string;
  brokerPersona: string;
  dealId: number;
  sessionId: string | number | null;

  // Interview
  interviewTranscript: InterviewTurn[];
  interviewTurnCount: number;
  coveragePercent: number;
  coverageBySections: Record<string, number>;
  industryIdentified: boolean;
  industrySpecificQuestionsAsked: number;
  reAskedFields: string[];
  deferredTopics: string[];

  // Financial
  financialAnalysisCompleted: boolean;
  financialInsightsCount: number;
  financialAnalysisData: any;

  // CIM
  cimSectionsGenerated: number;
  cimLayoutTypes: string[];
  cimSections: any[];
  blindCimGenerated: boolean;

  // Discrepancies
  discrepanciesFound: number;
  discrepanciesCritical: number;
  discrepancies: any[];

  // Buyers
  buyersImported: number;
  buyersMatched: number;
  buyerMatchResults: any[];

  // Errors & timing
  errorsEncountered: string[];
  apiResponseTimesMs: number[];
  totalDurationMs: number;
  startedAt: string;
  completedAt: string;
}

// ─── Document category inference ────────────────────────────────────────────

// Map subdirectory name to the server's top-level document category.
// The server's financial analyzer filters for category === "financials",
// so we must use the parent directory name, not a subcategory value.
const SUBDIR_TO_SERVER_CATEGORY: Record<string, string> = {
  financials: "financials",
  banking: "financials",
  tax: "financials",
  legal: "legal",
  compliance: "operations",
  operations: "operations",
};

function inferCategory(subdir: string, _filename: string): string {
  return SUBDIR_TO_SERVER_CATEGORY[subdir] ?? "other";
}

// ─── Interview message analysis ─────────────────────────────────────────────

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  Construction: ["bonding", "surety", "subcontract", "lien", "holdback", "wsib", "bid", "backlog", "general contractor"],
  Restaurant: ["liquor", "food cost", "labour cost", "health inspection", "patio", "lease", "menu", "front.?of.?house"],
  Healthcare: ["patient", "chart", "emr", "phipa", "ohip", "billing", "fee.?split", "roster", "physician"],
  Manufacturing: ["cnc", "iso", "machining", "tolerance", "equipment", "quality", "capacity", "oem"],
  "Information Technology": ["mrr", "arr", "msp", "sla", "helpdesk", "managed.?service", "recurring", "churn", "cyber"],
};

function countIndustryQuestions(transcript: InterviewTurn[], industry: string): number {
  const keywords = INDUSTRY_KEYWORDS[industry] ?? [];
  if (keywords.length === 0) return 0;

  let count = 0;
  const pattern = new RegExp(keywords.join("|"), "i");
  for (const turn of transcript) {
    if (pattern.test(turn.aiMessage)) count++;
  }
  return count;
}

function checkIndustryIdentified(transcript: InterviewTurn[], industry: string): boolean {
  // Check if the AI mentions the industry in its first 5 messages
  const earlyMessages = transcript.slice(0, 5).map((t) => t.aiMessage.toLowerCase());
  const industryLower = industry.toLowerCase();
  return earlyMessages.some((msg) => msg.includes(industryLower));
}

// ─── Main scenario runner ───────────────────────────────────────────────────

export async function runPersonaScenario(config: ScenarioConfig): Promise<ScenarioResult> {
  const {
    seller,
    broker,
    dealName,
    industry,
    documentsDir,
    buyerCsvPath,
    apiClient: api,
    costTracker,
    maxInterviewTurns,
  } = config;

  const startedAt = new Date();
  const errors: string[] = [];
  const responseTimes: number[] = [];

  const log = (msg: string) => {
    console.log(`  [${seller.id}] ${msg}`);
  };

  // Initialize the Anthropic client for seller simulation
  const anthropic = new Anthropic();

  // ── Step 1: Create the deal ───────────────────────────────────────────

  log("Creating deal...");
  let dealId: number;
  try {
    const deal = await createTestDeal(api, {
      businessName: dealName,
      industry,
      description: `Layer 3 persona test: ${seller.name} (${seller.businessName})`,
      phase: "phase1_info_collection",
    });
    dealId = deal.dealId;
    responseTimes.push(0); // createTestDeal tracks internally
    log(`Deal created: #${dealId}`);
  } catch (err: any) {
    throw new Error(`Failed to create deal: ${err.message}`);
  }

  // ── Step 2: Upload documents ──────────────────────────────────────────

  log("Uploading documents...");
  try {
    const subdirs = fs.readdirSync(documentsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "buyers");

    for (const subdir of subdirs) {
      const subdirPath = path.join(documentsDir, subdir.name);
      const files = fs.readdirSync(subdirPath, { withFileTypes: true })
        .filter((f) => f.isFile() && !f.name.startsWith("."));

      for (const file of files) {
        const filePath = path.join(subdirPath, file.name);
        const category = inferCategory(subdir.name, file.name);
        log(`  Uploading ${subdir.name}/${file.name} (${category})`);
        const res = await api.uploadDocument(dealId, filePath, category);
        responseTimes.push(res.responseTime);
        costTracker.trackRequest(`/api/deals/${dealId}/documents/upload`, res.responseTime);

        if (res.status !== 200 && res.status !== 201) {
          errors.push(`Document upload failed: ${file.name} (${res.status})`);
        }
      }
    }

    // Wait for document processing
    log("Waiting for document processing...");
    const processing = await waitForProcessing(api, dealId, 180_000);
    if (!processing.success) {
      errors.push("Document processing timed out (180s)");
    } else {
      const errorDocs = processing.documents.filter((d: any) => d.status === "error");
      if (errorDocs.length > 0) {
        errors.push(`${errorDocs.length} documents had extraction errors`);
      }
    }
    log(`Documents processed: ${processing.documents.length} total`);
  } catch (err: any) {
    errors.push(`Document upload phase: ${err.message}`);
    log(`Document upload error: ${err.message}`);
  }

  // ── Step 3: Submit questionnaire ──────────────────────────────────────

  log("Submitting questionnaire data...");
  try {
    const res = await api.updateDeal(dealId, {
      extractedInfo: seller.questionnaireData,
    });
    responseTimes.push(res.responseTime);
    costTracker.trackRequest(`/api/deals/${dealId}`, res.responseTime);
    if (res.status !== 200) {
      errors.push(`Questionnaire submission failed: ${res.status}`);
    }
  } catch (err: any) {
    errors.push(`Questionnaire submission: ${err.message}`);
  }

  // ── Step 4: Start the interview ───────────────────────────────────────

  log("Starting interview...");
  let sessionId: string | number | null = null;
  let firstAiMessage = "";

  try {
    const res = await api.startInterview(dealId);
    responseTimes.push(res.responseTime);
    costTracker.trackRequest(`/api/interview/${dealId}/start`, res.responseTime);

    if (res.status !== 200 && res.status !== 201) {
      errors.push(`Interview start failed: ${res.status}`);
    } else {
      sessionId = res.data?.sessionId ?? res.data?.id ?? null;
      firstAiMessage = res.data?.message ?? res.data?.response ?? "";
      log(`Interview started, session: ${sessionId}`);
    }
  } catch (err: any) {
    errors.push(`Interview start: ${err.message}`);
  }

  // ── Step 5: Interview simulation loop ─────────────────────────────────

  const transcript: InterviewTurn[] = [];
  const conversationHistory: Array<{ role: "user" | "assistant"; content: string }> = [];

  if (sessionId && firstAiMessage) {
    // The first AI message is the opening of the interview
    conversationHistory.push({ role: "assistant", content: firstAiMessage });

    log(`Running interview (max ${maxInterviewTurns} turns)...`);

    for (let turn = 1; turn <= maxInterviewTurns; turn++) {
      try {
        // Generate seller response via Claude Sonnet
        const simStart = performance.now();
        const sellerResponse = await simulateSellerResponse(
          anthropic,
          seller.systemPrompt,
          conversationHistory,
        );
        const sellerSimTimeMs = Math.round(performance.now() - simStart);

        // Track cost for the seller simulation call
        costTracker.trackRequest("seller_simulation_sonnet", sellerSimTimeMs);

        // Add seller response to conversation history
        conversationHistory.push({ role: "user", content: sellerResponse });

        // Send seller response to the interview endpoint
        const res = await api.sendInterviewMessage(dealId, sessionId, sellerResponse);
        responseTimes.push(res.responseTime);
        costTracker.trackRequest(`/api/interview/${dealId}/message`, res.responseTime);

        const aiMessage = res.data?.message ?? res.data?.response ?? "";
        const coverageAfter = res.data?.coverage ?? res.data?.coveragePercent ?? null;

        // Add AI response to conversation history
        if (aiMessage) {
          conversationHistory.push({ role: "assistant", content: aiMessage });
        }

        transcript.push({
          turnNumber: turn,
          aiMessage,
          sellerResponse,
          coverageAfter,
          responseTimeMs: res.responseTime,
          sellerSimTimeMs,
        });

        log(`  Turn ${turn}: coverage=${coverageAfter ?? "?"}, AI=${res.responseTime}ms, sim=${sellerSimTimeMs}ms`);

        // Check if the interview is complete
        if (
          res.data?.complete ||
          res.data?.status === "complete" ||
          res.data?.interviewComplete
        ) {
          log(`Interview completed at turn ${turn}`);
          break;
        }

        if (res.status !== 200) {
          errors.push(`Interview turn ${turn}: status ${res.status}`);
          if (res.status >= 500) break; // Stop on server errors
        }

        // Brief pause between turns to avoid rate limiting
        if (turn < maxInterviewTurns) {
          await sleep(1000);
        }
      } catch (err: any) {
        errors.push(`Interview turn ${turn}: ${err.message}`);
        log(`  Turn ${turn} error: ${err.message}`);
        // Continue trying unless it is a persistent failure
        if (transcript.length === 0) break; // First turn failed, stop
      }
    }
  }

  // ── Analyze interview results ─────────────────────────────────────────

  const industryQuestionsAsked = countIndustryQuestions(transcript, industry);
  const industryIdentified = checkIndustryIdentified(transcript, industry);
  const lastCoverage = transcript.length > 0
    ? transcript[transcript.length - 1].coverageAfter ?? 0
    : 0;

  // Try to get detailed coverage from the API
  let coverageBySections: Record<string, number> = {};
  let deferredTopics: string[] = [];
  let reAskedFields: string[] = [];

  try {
    if (sessionId) {
      const historyRes = await api.getInterviewHistory(sessionId);
      responseTimes.push(historyRes.responseTime);
      if (historyRes.status === 200 && historyRes.data) {
        coverageBySections = historyRes.data.coverageBySections ?? historyRes.data.sectionCoverage ?? {};
        deferredTopics = historyRes.data.deferredTopics ?? historyRes.data.deferred ?? [];
        reAskedFields = historyRes.data.reAskedFields ?? [];
      }
    }
  } catch {
    // Non-critical -- we still have the basic coverage number
  }

  // ── Step 6: Financial analysis ────────────────────────────────────────

  log("Triggering financial analysis...");
  let financialAnalysisCompleted = false;
  let financialInsightsCount = 0;
  let financialAnalysisData: any = null;

  try {
    const triggerRes = await api.triggerFinancialAnalysis(dealId);
    responseTimes.push(triggerRes.responseTime);
    costTracker.trackRequest(`/api/deals/${dealId}/financial-analysis`, triggerRes.responseTime);

    if (triggerRes.status === 200 || triggerRes.status === 201) {
      const analysis = await waitForAnalysis(api, dealId, 180_000);
      financialAnalysisCompleted = analysis.success;
      financialAnalysisData = analysis.analysis;

      if (analysis.analysis?.insights) {
        financialInsightsCount = Array.isArray(analysis.analysis.insights)
          ? analysis.analysis.insights.length
          : 0;
      }

      log(`Financial analysis: ${financialAnalysisCompleted ? "completed" : "failed"}, ${financialInsightsCount} insights`);
    } else {
      errors.push(`Financial analysis trigger failed: ${triggerRes.status}`);
    }
  } catch (err: any) {
    errors.push(`Financial analysis: ${err.message}`);
    log(`Financial analysis error: ${err.message}`);
  }

  // ── Step 7: Generate CIM layout ───────────────────────────────────────

  log("Generating CIM layout...");
  let cimSectionsGenerated = 0;
  let cimLayoutTypes: string[] = [];
  let cimSections: any[] = [];

  try {
    const layoutRes = await api.generateCimLayout(dealId);
    responseTimes.push(layoutRes.responseTime);
    costTracker.trackRequest(`/api/deals/${dealId}/generate-layout`, layoutRes.responseTime);

    if (layoutRes.status === 200) {
      // Fetch the generated sections
      const sectionsRes = await api.getCimSections(dealId);
      responseTimes.push(sectionsRes.responseTime);

      if (sectionsRes.status === 200 && Array.isArray(sectionsRes.data)) {
        cimSections = sectionsRes.data;
        cimSectionsGenerated = cimSections.length;
        cimLayoutTypes = cimSections
          .map((s: any) => s.layoutType ?? s.layout_type ?? "unknown")
          .filter((t: string) => t !== "unknown");
      }
      log(`CIM layout: ${cimSectionsGenerated} sections, ${new Set(cimLayoutTypes).size} unique layouts`);
    } else {
      errors.push(`CIM layout generation failed: ${layoutRes.status}`);
    }
  } catch (err: any) {
    errors.push(`CIM layout: ${err.message}`);
    log(`CIM layout error: ${err.message}`);
  }

  // ── Step 8: Generate blind CIM ────────────────────────────────────────

  log("Generating blind CIM...");
  let blindCimGenerated = false;

  try {
    const blindRes = await api.generateBlindCim(dealId);
    responseTimes.push(blindRes.responseTime);
    costTracker.trackRequest(`/api/deals/${dealId}/generate-blind`, blindRes.responseTime);
    blindCimGenerated = blindRes.status === 200;
    if (!blindCimGenerated) {
      errors.push(`Blind CIM generation failed: ${blindRes.status}`);
    }
    log(`Blind CIM: ${blindCimGenerated ? "generated" : "failed"}`);
  } catch (err: any) {
    errors.push(`Blind CIM: ${err.message}`);
  }

  // ── Step 9: Discrepancy check ─────────────────────────────────────────

  log("Running discrepancy check...");
  let discrepanciesFound = 0;
  let discrepanciesCritical = 0;
  let discrepancies: any[] = [];

  try {
    const discRes = await api.runDiscrepancyCheck(dealId);
    responseTimes.push(discRes.responseTime);
    costTracker.trackRequest(`/api/deals/${dealId}/run-discrepancy-check`, discRes.responseTime);

    if (discRes.status === 200) {
      const discListRes = await api.getDiscrepancies(dealId);
      responseTimes.push(discListRes.responseTime);

      if (discListRes.status === 200 && Array.isArray(discListRes.data)) {
        discrepancies = discListRes.data;
        discrepanciesFound = discrepancies.length;
        discrepanciesCritical = discrepancies.filter(
          (d: any) => d.severity === "critical",
        ).length;
      }
      log(`Discrepancies: ${discrepanciesFound} found (${discrepanciesCritical} critical)`);
    } else {
      errors.push(`Discrepancy check failed: ${discRes.status}`);
    }
  } catch (err: any) {
    errors.push(`Discrepancy check: ${err.message}`);
  }

  // ── Step 10: Import buyers from CSV ───────────────────────────────────

  log("Importing buyers...");
  let buyersImported = 0;

  try {
    if (fs.existsSync(buyerCsvPath)) {
      const importRes = await api.importBuyersCSV(buyerCsvPath);
      responseTimes.push(importRes.responseTime);
      costTracker.trackRequest("/api/broker/buyers/import-csv", importRes.responseTime);

      if (importRes.status === 200) {
        buyersImported = importRes.data?.imported ?? importRes.data?.count ?? 0;
      } else {
        errors.push(`Buyer CSV import failed: ${importRes.status}`);
      }
      log(`Buyers imported: ${buyersImported}`);
    } else {
      log(`Buyer CSV not found at ${buyerCsvPath}, skipping import`);
    }
  } catch (err: any) {
    errors.push(`Buyer import: ${err.message}`);
  }

  // ── Step 11: Run buyer matching ───────────────────────────────────────

  log("Running buyer matching...");
  let buyersMatched = 0;
  let buyerMatchResults: any[] = [];

  try {
    const matchRes = await api.matchBuyers(dealId);
    responseTimes.push(matchRes.responseTime);
    costTracker.trackRequest(`/api/deals/${dealId}/match-buyers`, matchRes.responseTime);

    if (matchRes.status === 200) {
      const suggestedRes = await api.getSuggestedBuyers(dealId);
      responseTimes.push(suggestedRes.responseTime);

      if (suggestedRes.status === 200 && Array.isArray(suggestedRes.data)) {
        buyerMatchResults = suggestedRes.data;
        buyersMatched = buyerMatchResults.length;
      }
      log(`Buyers matched: ${buyersMatched}`);
    } else {
      errors.push(`Buyer matching failed: ${matchRes.status}`);
    }
  } catch (err: any) {
    errors.push(`Buyer matching: ${err.message}`);
  }

  // ── Compile results ───────────────────────────────────────────────────

  const completedAt = new Date();
  const totalDurationMs = completedAt.getTime() - startedAt.getTime();

  log(`Scenario complete in ${(totalDurationMs / 1000).toFixed(1)}s, ${errors.length} errors`);

  return {
    scenarioName: dealName,
    sellerPersona: seller.id,
    brokerPersona: broker.id,
    dealId,
    sessionId,

    interviewTranscript: transcript,
    interviewTurnCount: transcript.length,
    coveragePercent: lastCoverage,
    coverageBySections,
    industryIdentified,
    industrySpecificQuestionsAsked: industryQuestionsAsked,
    reAskedFields,
    deferredTopics,

    financialAnalysisCompleted,
    financialInsightsCount,
    financialAnalysisData,

    cimSectionsGenerated,
    cimLayoutTypes,
    cimSections,
    blindCimGenerated,

    discrepanciesFound,
    discrepanciesCritical,
    discrepancies,

    buyersImported,
    buyersMatched,
    buyerMatchResults,

    errorsEncountered: errors,
    apiResponseTimesMs: responseTimes,
    totalDurationMs,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
  };
}

// ─── Seller simulation via Claude Sonnet ────────────────────────────────────

async function simulateSellerResponse(
  client: Anthropic,
  sellerSystemPrompt: string,
  conversationHistory: Array<{ role: "user" | "assistant"; content: string }>,
): Promise<string> {
  // Build the messages for Sonnet. From Sonnet's perspective:
  //   - "assistant" messages are the AI interviewer's messages (what the seller reads)
  //   - "user" messages are the seller's previous responses (what Sonnet generated)
  //
  // We need to flip roles: in the Cimple interview, the AI interviewer is
  // "assistant" and the seller is "user". But for Sonnet simulating the seller,
  // the interviewer's messages are the "user" input and the seller's responses
  // are the "assistant" output.

  const sonnetMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of conversationHistory) {
    if (msg.role === "assistant") {
      // AI interviewer message -> Sonnet sees this as "user" input
      sonnetMessages.push({ role: "user", content: msg.content });
    } else {
      // Seller response -> Sonnet sees this as its own "assistant" output
      sonnetMessages.push({ role: "assistant", content: msg.content });
    }
  }

  // Ensure we start with a "user" message (the AI interviewer's opening)
  if (sonnetMessages.length === 0 || sonnetMessages[0].role !== "user") {
    throw new Error("Conversation history must start with an AI interviewer message");
  }

  // Ensure messages alternate correctly. If two same-role messages appear
  // in sequence, merge them.
  const cleanedMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const msg of sonnetMessages) {
    const last = cleanedMessages[cleanedMessages.length - 1];
    if (last && last.role === msg.role) {
      last.content += "\n\n" + msg.content;
    } else {
      cleanedMessages.push({ ...msg });
    }
  }

  // The last message must be "user" (an AI question for the seller to respond to)
  if (cleanedMessages[cleanedMessages.length - 1].role !== "user") {
    // The last seller response was already added but no new AI question followed.
    // This should not happen in normal flow, but guard against it.
    return "(No response needed -- waiting for next question)";
  }

  const response = await client.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 500,
    system: sellerSystemPrompt + `\n\nIMPORTANT INSTRUCTIONS FOR SIMULATION:
- Respond as the seller would in a real conversation. Stay fully in character.
- Keep responses natural and conversational -- 2-5 sentences typical, occasionally longer for detailed topics.
- Do NOT break character. Do NOT add meta-commentary. Do NOT explain what you are doing.
- If the interviewer asks multiple questions, address the most important one first and briefly touch on others.
- React naturally to the interviewer's tone and approach.`,
    messages: cleanedMessages,
  });

  // Extract text from the response
  const textBlock = response.content.find((block) => block.type === "text");
  return textBlock?.text ?? "(No response generated)";
}
