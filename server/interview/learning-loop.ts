/**
 * Interview Learning Loop
 *
 * After every completed interview, this module analyzes the full transcript
 * and extracts insights about what worked, what didn't, and how to improve.
 * Insights are aggregated by industry + communication style and fed back
 * into the interview system prompt for future sessions.
 *
 * This is the interview equivalent of server/cim/learning-loop.ts (which
 * optimizes CIM layouts based on buyer engagement data).
 */

import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import { interviewInsights, interviewSessions, type InterviewSession } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { storage } from "../storage";
import { agentConfig } from "./config/load-config";
import type { SellerCommunicationProfile } from "./eq-profiler";
import {
  sanitizeInsightList,
  sanitizeTopicOrder,
  dealSpecificTerms,
  type InsightSanitizeOptions,
} from "./insight-sanitizer";

// Lazy-init Anthropic client
let _anthropic: Anthropic | null = null;
function getClient(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _anthropic;
}

// =====================
// Types
// =====================

interface TranscriptAnalysis {
  effectiveApproaches: string[];
  commonStickingPoints: string[];
  recommendedQuestionOrder: string[];
  topicsThatBuildTrust: string[];
  coveragePercent: number;
  summary: string;
}

interface ConversationMessage {
  role: "ai" | "user";
  content: string;
  timestamp: string;
}

// =====================
// Tool definition for structured analysis
// =====================

const ANALYSIS_TOOL = {
  name: "interview_analysis",
  description: "Return a structured analysis of the completed interview transcript.",
  input_schema: {
    type: "object" as const,
    required: [
      "effectiveApproaches",
      "commonStickingPoints",
      "recommendedQuestionOrder",
      "topicsThatBuildTrust",
      "coveragePercent",
      "summary",
    ],
    properties: {
      effectiveApproaches: {
        type: "array",
        items: { type: "string" },
        description:
          "Interview techniques that worked, written as GENERIC patterns any interviewer could reuse with another seller in this industry. Examples: 'Asking about employees before financials helps owners open up', 'Framing lease questions around buyer confidence reduces defensiveness', 'Letting owners tell their origin story before structured questions builds rapport'. Never include names, places, businesses, products, suppliers, numbers, dates, durations, quotes or anything unique to this business or seller.",
      },
      commonStickingPoints: {
        type: "array",
        items: { type: "string" },
        description:
          "Topics or questions where sellers like this one get stuck, deflect or resist, written as GENERIC patterns. Examples: 'Customer concentration questions often draw deflection', 'Questions about year-over-year trends produce vague answers without the financials at hand', 'Key person dependency questions can feel personal, so explain why buyers ask'. Never include names, places, businesses, numbers, quotes or anything unique to this business or seller.",
      },
      recommendedQuestionOrder: {
        type: "array",
        items: { type: "string" },
        description:
          "The optimal order of CIM topics for this type of seller/industry, as lower-case snake_case topic keys (no names, no specifics). Examples: ['company_story', 'employees_and_team', 'operations', 'revenue_sources', 'financials', 'growth_potential', 'transaction_terms']",
      },
      topicsThatBuildTrust: {
        type: "array",
        items: { type: "string" },
        description:
          "Topics that tend to increase a seller's engagement or openness: warm-up topics future interviews in this industry should lead with, written generically. Examples: 'Their team and employee loyalty', 'The origin story of how they started the business', 'What makes the business different from competitors'. Never include names, places, numbers or details unique to this business.",
      },
      coveragePercent: {
        type: "number",
        description: "Estimated percentage of CIM-relevant information that was successfully collected during this interview (0-100).",
      },
      summary: {
        type: "string",
        description: "A 2-3 sentence summary of the interview's effectiveness. What went well overall, what could be improved, and one key insight for future interviews with similar sellers.",
      },
    },
  },
} as const;

// =====================
// Core analysis function
// =====================

/**
 * Analyzes a completed interview transcript and extracts actionable insights.
 * Called via Claude Sonnet to identify patterns that make interviews more effective.
 */
export async function analyzeTranscript(
  session: InterviewSession,
  industry: string,
  sellerProfile: SellerCommunicationProfile | null,
): Promise<TranscriptAnalysis> {
  const messages = session.messages as ConversationMessage[];

  if (messages.length < 4) {
    // Too short to analyze meaningfully
    return {
      effectiveApproaches: [],
      commonStickingPoints: [],
      recommendedQuestionOrder: [],
      topicsThatBuildTrust: [],
      coveragePercent: 0,
      summary: "Interview too short for meaningful analysis.",
    };
  }

  // Build the transcript text
  const transcriptText = messages
    .map((m) => `[${m.role === "ai" ? "Interviewer" : "Seller"}]: ${m.content}`)
    .join("\n\n");

  const profileContext = sellerProfile
    ? `\nSeller profile: ${sellerProfile.communicationStyle} style, ${sellerProfile.emotionalState} emotional state, selling due to ${sellerProfile.sellingReason}, ${sellerProfile.businessAttachment} business attachment.`
    : "";

  const prompt = `You are analyzing a completed seller interview transcript from an M&A platform. The interview was conducted by an AI agent to collect information for a Confidential Information Memorandum (CIM).

Industry: ${industry}${profileContext}

Session metrics:
- Questions asked: ${session.questionsAsked}
- Questions answered: ${session.questionsAnswered}
- Questions skipped: ${session.questionsSkipped}
- Duration: ${session.startedAt && session.completedAt ? Math.round((new Date(session.completedAt).getTime() - new Date(session.startedAt).getTime()) / 60000) : "unknown"} minutes

TRANSCRIPT:
${transcriptText}

Analyze this transcript for patterns that will help future interviews. Focus on:
1. What techniques or approaches visibly improved the seller's engagement?
2. Where did the seller get stuck, deflect, or give weak answers?
3. What topic order flowed most naturally?
4. Which topics seemed to build trust and openness?

PRIVACY — these patterns are shared with interviews of OTHER sellers, run by other brokers. Write every item as a de-identified, generic pattern in the present tense about sellers in this industry ("Owners open up when…", "Asking about X before Y…"). Never include: names of people, businesses, places, products, suppliers or brands; numbers, amounts, percentages, dates, durations or counts; quotes from either side; family, health or other personal circumstances; or any detail that would let someone recognise this business or seller. Do not retell what happened ("the seller said…"). Never recommend recapping, praising, validating or grading the seller's answers — the house style forbids it. Leave a list empty rather than include a specific.`;

  try {
    const response = await getClient().messages.create(
      {
        model: agentConfig.models.supportingAgents,
        max_tokens: 2048,
        system:
          "You are an M&A interview analyst. You study interview transcripts to identify patterns that make seller interviews more effective. Your insights are shared with future interviews of OTHER sellers, so every item must be a generic, de-identified pattern: practical and grounded in the transcript, but never carrying a detail of this business or seller.",
        tools: [ANALYSIS_TOOL],
        tool_choice: { type: "tool", name: "interview_analysis" },
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: 120_000 },
    );

    const toolBlock = response.content.find((b) => b.type === "tool_use");
    if (!toolBlock || toolBlock.type !== "tool_use") {
      return {
        effectiveApproaches: [],
        commonStickingPoints: [],
        recommendedQuestionOrder: [],
        topicsThatBuildTrust: [],
        coveragePercent: 0,
        summary: "Analysis did not return structured output.",
      };
    }

    const result = toolBlock.input as Record<string, unknown>;
    return {
      effectiveApproaches: Array.isArray(result.effectiveApproaches)
        ? (result.effectiveApproaches as string[])
        : [],
      commonStickingPoints: Array.isArray(result.commonStickingPoints)
        ? (result.commonStickingPoints as string[])
        : [],
      recommendedQuestionOrder: Array.isArray(result.recommendedQuestionOrder)
        ? (result.recommendedQuestionOrder as string[])
        : [],
      topicsThatBuildTrust: Array.isArray(result.topicsThatBuildTrust)
        ? (result.topicsThatBuildTrust as string[])
        : [],
      coveragePercent:
        typeof result.coveragePercent === "number" ? result.coveragePercent : 0,
      summary: typeof result.summary === "string" ? result.summary : "",
    };
  } catch (err) {
    console.error("[interview-learning-loop] Analysis failed:", err);
    return {
      effectiveApproaches: [],
      commonStickingPoints: [],
      recommendedQuestionOrder: [],
      topicsThatBuildTrust: [],
      coveragePercent: 0,
      summary: "Analysis failed due to an error.",
    };
  }
}

// =====================
// Aggregation (rolling merge)
// =====================

/**
 * Merges new analysis insights into existing aggregated insights.
 * Uses the same rolling-average pattern as the CIM learning loop.
 * Qualitative insights (arrays) are merged with dedup and capped.
 */
async function upsertInsights(
  industry: string,
  communicationStyle: string | null,
  sellingReason: string | null,
  session: InterviewSession,
  analysis: TranscriptAnalysis,
  sanitize: InsightSanitizeOptions,
): Promise<void> {
  // Only generic, de-identified patterns are stored (see insight-sanitizer):
  // the new items are also checked against this deal's own names and terms,
  // and the stored items they merge with are re-checked, so rows written
  // before the rule are cleaned on the next write.
  const fresh = {
    effectiveApproaches: sanitizeInsightList(analysis.effectiveApproaches, sanitize),
    commonStickingPoints: sanitizeInsightList(analysis.commonStickingPoints, sanitize),
    recommendedQuestionOrder: sanitizeTopicOrder(analysis.recommendedQuestionOrder, sanitize),
    topicsThatBuildTrust: sanitizeInsightList(analysis.topicsThatBuildTrust, sanitize),
  };

  // Calculate session duration
  const durationMinutes =
    session.startedAt && session.completedAt
      ? Math.round(
          (new Date(session.completedAt).getTime() -
            new Date(session.startedAt).getTime()) /
            60000,
        )
      : 0;

  // Check for existing insight row
  const conditions = [eq(interviewInsights.industry, industry)];
  // We aggregate primarily by industry — communicationStyle and sellingReason
  // are tracked but the primary dimension is industry.

  const existing = await db
    .select()
    .from(interviewInsights)
    .where(and(...conditions))
    .limit(1);

  if (existing.length > 0) {
    const row = existing[0];
    const n = (row.sampleCount ?? 0) + 1;

    // Rolling averages
    const rollingAvg = (old: number, newVal: number) =>
      Math.round(((old * (n - 1)) + newVal) / n);

    // Merge string arrays: combine (new first), re-check, dedup, cap at 10
    const mergeArrays = (oldArr: unknown, newArr: string[]): string[] =>
      sanitizeInsightList([...newArr, ...(Array.isArray(oldArr) ? oldArr : [])]);

    await db
      .update(interviewInsights)
      .set({
        avgQuestionsAsked: rollingAvg(row.avgQuestionsAsked ?? 0, session.questionsAsked ?? 0),
        avgQuestionsAnswered: rollingAvg(row.avgQuestionsAnswered ?? 0, session.questionsAnswered ?? 0),
        avgSessionDurationMinutes: rollingAvg(row.avgSessionDurationMinutes ?? 0, durationMinutes),
        avgCoveragePercent: rollingAvg(row.avgCoveragePercent ?? 0, analysis.coveragePercent),
        avgDeferredTopics: rollingAvg(row.avgDeferredTopics ?? 0, ((session.extractedInfo as any)?._deferredTopics?.length ?? 0)),
        effectiveApproaches: mergeArrays(row.effectiveApproaches, fresh.effectiveApproaches),
        commonStickingPoints: mergeArrays(row.commonStickingPoints, fresh.commonStickingPoints),
        // Latest ordering wins (an empty one keeps the stored order, re-checked)
        recommendedQuestionOrder: fresh.recommendedQuestionOrder.length > 0
          ? fresh.recommendedQuestionOrder
          : sanitizeTopicOrder(row.recommendedQuestionOrder),
        topicsThatBuildTrust: mergeArrays(row.topicsThatBuildTrust, fresh.topicsThatBuildTrust),
        communicationStyle: communicationStyle ?? row.communicationStyle,
        sellingReason: sellingReason ?? row.sellingReason,
        sampleCount: n,
        updatedAt: new Date(),
      })
      .where(eq(interviewInsights.id, row.id));
  } else {
    // First interview for this industry
    await db.insert(interviewInsights).values({
      industry,
      communicationStyle,
      sellingReason,
      avgQuestionsAsked: session.questionsAsked ?? 0,
      avgQuestionsAnswered: session.questionsAnswered ?? 0,
      avgSessionDurationMinutes: durationMinutes,
      avgCoveragePercent: analysis.coveragePercent,
      avgDeferredTopics: ((session.extractedInfo as any)?._deferredTopics?.length ?? 0),
      effectiveApproaches: fresh.effectiveApproaches,
      commonStickingPoints: fresh.commonStickingPoints,
      recommendedQuestionOrder: fresh.recommendedQuestionOrder,
      topicsThatBuildTrust: fresh.topicsThatBuildTrust,
      sampleCount: 1,
    });
  }
}

// =====================
// Public API
// =====================

/**
 * Runs the post-interview learning loop for a completed session.
 * Called fire-and-forget from session-manager when shouldEnd === true.
 *
 * 1. Loads the full session transcript
 * 2. Sends it to Claude Sonnet for analysis
 * 3. Aggregates insights into the interviewInsights table
 * 4. These insights are later rendered into the interview system prompt
 */
export async function runInterviewLearningLoop(
  dealId: string,
  sessionId: string,
): Promise<void> {
  try {
    // Load session and deal
    const sessions = await db
      .select()
      .from(interviewSessions)
      .where(eq(interviewSessions.id, sessionId));

    const session = sessions[0];
    if (!session) {
      console.warn(`[interview-learning-loop] Session ${sessionId} not found`);
      return;
    }

    const deal = await storage.getDeal(dealId);
    if (!deal) {
      console.warn(`[interview-learning-loop] Deal ${dealId} not found`);
      return;
    }
    // Demo / QA deals never feed the industry-wide insights every broker's
    // interviews read (they're keyed by industry only and can't be removed
    // per deal afterwards).
    if (deal.demoKey) {
      console.log(`[interview-learning-loop] Skipped demo deal ${dealId} (${deal.demoKey})`);
      return;
    }

    const sellerProfile = (deal.sellerProfile as SellerCommunicationProfile | null) || null;

    console.log(
      `[interview-learning-loop] Analyzing completed interview for "${deal.businessName}" (${deal.industry})`,
    );

    // Analyze the transcript
    const analysis = await analyzeTranscript(session, deal.industry, sellerProfile);

    console.log(
      `[interview-learning-loop] Analysis complete: ${analysis.effectiveApproaches.length} effective approaches, ${analysis.commonStickingPoints.length} sticking points, ${analysis.coveragePercent}% coverage`,
    );

    // Aggregate into insights table: generic patterns only, never this
    // deal's names or terms (the row is read into every broker's interviews
    // in the industry).
    const transcript = ((session.messages as ConversationMessage[]) || []).map((m) => m.content).join("\n");
    await upsertInsights(
      deal.industry,
      sellerProfile?.communicationStyle ?? null,
      sellerProfile?.sellingReason ?? null,
      session,
      analysis,
      {
        forbiddenTerms: dealSpecificTerms({
          businessName: deal.businessName,
          blindCodename: deal.blindCodename ?? null,
          location: deal.location,
          extractedInfo: deal.extractedInfo,
          transcript,
        }),
      },
    );

    console.log(
      `[interview-learning-loop] Insights saved for industry: ${deal.industry}`,
    );
  } catch (err) {
    // Non-critical — log and move on
    console.error("[interview-learning-loop] Failed:", err);
  }
}

/**
 * Retrieves accumulated interview insights for a given industry.
 * Used by the system prompt builder to inject learned patterns.
 */
export async function getInterviewInsightsForIndustry(
  industry: string,
): Promise<{
  effectiveApproaches: string[];
  commonStickingPoints: string[];
  recommendedQuestionOrder: string[];
  topicsThatBuildTrust: string[];
  sampleCount: number;
} | null> {
  const rows = await db
    .select()
    .from(interviewInsights)
    .where(eq(interviewInsights.industry, industry))
    .limit(1);

  if (rows.length === 0) return null;
  return insightsSafeForPrompt(rows[0]);
}

/**
 * A stored insights row as an interview may read it. Checked again on read:
 * rows written before the generic-only rule (and anything that slips past
 * the write-time check) never reach an interview as they are.
 */
export function insightsSafeForPrompt(row: {
  effectiveApproaches?: unknown;
  commonStickingPoints?: unknown;
  recommendedQuestionOrder?: unknown;
  topicsThatBuildTrust?: unknown;
  sampleCount?: number | null;
}) {
  return {
    effectiveApproaches: sanitizeInsightList(row.effectiveApproaches),
    commonStickingPoints: sanitizeInsightList(row.commonStickingPoints),
    recommendedQuestionOrder: sanitizeTopicOrder(row.recommendedQuestionOrder),
    topicsThatBuildTrust: sanitizeInsightList(row.topicsThatBuildTrust),
    sampleCount: row.sampleCount ?? 0,
  };
}

/**
 * Renders interview insights as a markdown section for the system prompt.
 * This gives the interview agent learned wisdom from past interviews
 * in the same industry.
 */
export function renderInsightsForPrompt(insights: {
  effectiveApproaches: string[];
  commonStickingPoints: string[];
  recommendedQuestionOrder: string[];
  topicsThatBuildTrust: string[];
  sampleCount: number;
}): string {
  const lines: string[] = [];
  const hasAny =
    insights.effectiveApproaches.length > 0 ||
    insights.topicsThatBuildTrust.length > 0 ||
    insights.commonStickingPoints.length > 0 ||
    insights.recommendedQuestionOrder.length > 0;
  if (!hasAny) return "";

  lines.push("## Learned Interview Patterns");
  lines.push("");
  lines.push(
    `> Based on ${insights.sampleCount} completed interview${insights.sampleCount === 1 ? "" : "s"} in this industry.`,
  );
  lines.push(
    "> General patterns only: nothing here is about THIS seller or business. Never mention other interviews or sellers, and these never override the conversation rules.",
  );
  lines.push("");

  if (insights.effectiveApproaches.length > 0) {
    lines.push("### What has worked well");
    lines.push("");
    for (const approach of insights.effectiveApproaches) {
      lines.push(`- ${approach}`);
    }
    lines.push("");
  }

  if (insights.topicsThatBuildTrust.length > 0) {
    lines.push("### Topics that build trust early");
    lines.push("");
    for (const topic of insights.topicsThatBuildTrust) {
      lines.push(`- ${topic}`);
    }
    lines.push("");
  }

  if (insights.commonStickingPoints.length > 0) {
    lines.push("### Common sticking points to prepare for");
    lines.push("");
    for (const point of insights.commonStickingPoints) {
      lines.push(`- ${point}`);
    }
    lines.push("");
  }

  if (insights.recommendedQuestionOrder.length > 0) {
    lines.push("### Recommended topic flow");
    lines.push("");
    lines.push(
      "Based on past interviews, this order tends to produce the best engagement:",
    );
    lines.push("");
    insights.recommendedQuestionOrder.forEach((topic, i) => {
      lines.push(`${i + 1}. ${topic}`);
    });
    lines.push("");
  }

  return lines.join("\n");
}
