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
          "Specific interview techniques that worked well in this transcript. Examples: 'Asking about employees before financials helped the seller open up', 'Framing lease questions around buyer confidence reduced defensiveness', 'Letting the seller tell their origin story before asking structured questions built strong rapport'. Each should be specific and actionable, not generic.",
      },
      commonStickingPoints: {
        type: "array",
        items: { type: "string" },
        description:
          "Topics or questions where the seller got stuck, deflected, gave vague answers, or showed resistance. Examples: 'Seller deflected twice when asked about customer concentration', 'Financial questions about year-over-year trends produced vague responses', 'Key person dependency question triggered defensive response'. Be specific about what happened.",
      },
      recommendedQuestionOrder: {
        type: "array",
        items: { type: "string" },
        description:
          "The optimal order of CIM topics for this type of seller/industry, based on what flowed naturally in this interview. List the broad topic areas in the order that produced the best engagement. Examples: ['company_story', 'employees_and_team', 'operations', 'revenue_sources', 'financials', 'growth_potential', 'transaction_terms']",
      },
      topicsThatBuildTrust: {
        type: "array",
        items: { type: "string" },
        description:
          "Topics that visibly increased the seller's engagement or openness during the interview. These are the 'warm-up' topics that future interviews in this industry should lead with. Examples: 'Their team and employee loyalty', 'The origin story of how they started the business', 'Their competitive advantages and what makes them different'.",
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
async function analyzeTranscript(
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

Be specific — reference actual moments from the transcript, not generic advice.`;

  try {
    const response = await getClient().messages.create(
      {
        model: agentConfig.models.supportingAgents,
        max_tokens: 2048,
        system:
          "You are an M&A interview analyst. You study interview transcripts to identify patterns that make seller interviews more effective. Your insights are used to improve future interviews. Be specific, practical, and grounded in the actual transcript.",
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
): Promise<void> {
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

    // Merge string arrays: combine, dedup, cap at 10 most recent
    const mergeArrays = (oldArr: unknown, newArr: string[]): string[] => {
      const prev = Array.isArray(oldArr) ? (oldArr as string[]) : [];
      const combined = [...newArr, ...prev]; // new items first
      const deduped = [...new Set(combined)];
      return deduped.slice(0, 10);
    };

    await db
      .update(interviewInsights)
      .set({
        avgQuestionsAsked: rollingAvg(row.avgQuestionsAsked ?? 0, session.questionsAsked ?? 0),
        avgQuestionsAnswered: rollingAvg(row.avgQuestionsAnswered ?? 0, session.questionsAnswered ?? 0),
        avgSessionDurationMinutes: rollingAvg(row.avgSessionDurationMinutes ?? 0, durationMinutes),
        avgCoveragePercent: rollingAvg(row.avgCoveragePercent ?? 0, analysis.coveragePercent),
        avgDeferredTopics: rollingAvg(row.avgDeferredTopics ?? 0, ((session.extractedInfo as any)?._deferredTopics?.length ?? 0)),
        effectiveApproaches: mergeArrays(row.effectiveApproaches, analysis.effectiveApproaches),
        commonStickingPoints: mergeArrays(row.commonStickingPoints, analysis.commonStickingPoints),
        recommendedQuestionOrder: analysis.recommendedQuestionOrder, // Latest ordering wins
        topicsThatBuildTrust: mergeArrays(row.topicsThatBuildTrust, analysis.topicsThatBuildTrust),
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
      effectiveApproaches: analysis.effectiveApproaches,
      commonStickingPoints: analysis.commonStickingPoints,
      recommendedQuestionOrder: analysis.recommendedQuestionOrder,
      topicsThatBuildTrust: analysis.topicsThatBuildTrust,
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

    const sellerProfile = (deal.sellerProfile as SellerCommunicationProfile | null) || null;

    console.log(
      `[interview-learning-loop] Analyzing completed interview for "${deal.businessName}" (${deal.industry})`,
    );

    // Analyze the transcript
    const analysis = await analyzeTranscript(session, deal.industry, sellerProfile);

    console.log(
      `[interview-learning-loop] Analysis complete: ${analysis.effectiveApproaches.length} effective approaches, ${analysis.commonStickingPoints.length} sticking points, ${analysis.coveragePercent}% coverage`,
    );

    // Aggregate into insights table
    await upsertInsights(
      deal.industry,
      sellerProfile?.communicationStyle ?? null,
      sellerProfile?.sellingReason ?? null,
      session,
      analysis,
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

  const row = rows[0];
  return {
    effectiveApproaches: (row.effectiveApproaches as string[]) || [],
    commonStickingPoints: (row.commonStickingPoints as string[]) || [],
    recommendedQuestionOrder: (row.recommendedQuestionOrder as string[]) || [],
    topicsThatBuildTrust: (row.topicsThatBuildTrust as string[]) || [],
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

  lines.push("## Learned Interview Patterns");
  lines.push("");
  lines.push(
    `> Based on ${insights.sampleCount} completed interview${insights.sampleCount === 1 ? "" : "s"} in this industry.`,
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
