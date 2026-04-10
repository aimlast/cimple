import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import { storage } from "../storage";
import {
  interviewSessions,
  type InterviewSession,
  type ConversationMessage,
} from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { assembleKnowledgeBase, type KnowledgeBase, type IndustryContext } from "./knowledge-base";
import { buildInterviewSystemPrompt } from "./system-prompt";
import { INTERVIEW_RESPONSE_TOOL, type InterviewResponse } from "./response-schema";
import { mergeExtractedFields, updateIndustryContext, type FieldChange } from "./info-merger";
import { agentConfig } from "./config/load-config";

// =====================
// Types
// =====================

export interface TurnResult {
  /** The message to display to the seller */
  message: string;
  /** Pre-populated answer options the seller can click to respond */
  suggestedAnswers: string[];
  /** Session ID (for subsequent turns) */
  sessionId: string;
  /** Summary of what was captured this turn */
  captured: {
    total: number;
    newFields: string[];
    updatedFields: string[];
    changes: FieldChange[];
  };
  /** Current section coverage snapshot */
  sectionCoverage: Array<{
    key: string;
    title: string;
    status: "well_covered" | "partial" | "missing";
  }>;
  /** Industry context (for frontend display) */
  industryContext: {
    identified: boolean;
    industry: string;
    activeTopics: string[];
    coveredTopics: string[];
  };
  /** Deferred topics the agent plans to revisit */
  deferredTopics: string[];
  /** Whether the interview should end */
  shouldEnd: boolean;
  /** End reason if applicable */
  endReason?: string;
}

// =====================
// Anthropic client
// =====================

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Model loaded from config/agent-config.json — change it there, not here
const INTERVIEW_MODEL = agentConfig.models.interviewAgent;

// =====================
// Session manager
// =====================

/**
 * Starts a new interview session or resumes an existing one.
 * Returns the opening message from the AI.
 */
export async function startOrResumeSession(dealId: string): Promise<TurnResult> {
  // Load the deal and all related data
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  const documents = await storage.getDocumentsByDeal(dealId);
  const tasks = await storage.getTasksByDeal(dealId);
  const resolvedDiscrepancies = await storage.getResolvedDiscrepancies(dealId);

  // Check for an existing active/paused session
  const existingSessions = await db
    .select()
    .from(interviewSessions)
    .where(eq(interviewSessions.dealId, dealId))
    .orderBy(desc(interviewSessions.lastActivityAt));

  let session = existingSessions.find(
    (s) => s.status === "active" || s.status === "paused",
  );

  if (session) {
    // Resume existing session
    const messages = session.messages as ConversationMessage[];
    if (messages.length > 0) {
      // Session has history — return the last AI message as the resume point
      // The frontend will display the full conversation history
      const kb = assembleKnowledgeBase(deal, documents, tasks, session, resolvedDiscrepancies);

      // Restore industry context from session metadata
      const sessionMeta = (session.extractedInfo as Record<string, unknown>) || {};
      if (sessionMeta._industryContext) {
        kb.industryContext = sessionMeta._industryContext as IndustryContext;
      }

      const lastAiMessage = [...messages].reverse().find((m) => m.role === "ai");

      return {
        message: lastAiMessage?.content || "Welcome back. Let's pick up where we left off.",
        suggestedAnswers: [],
        sessionId: session.id,
        captured: { total: countExtractedFields(deal), newFields: [], updatedFields: [], changes: [] },
        sectionCoverage: kb.sectionCoverage.map((s) => ({ key: s.key, title: s.title, status: s.status })),
        industryContext: extractIndustryContextForFrontend(kb.industryContext),
        deferredTopics: (sessionMeta._deferredTopics as string[]) || [],
        shouldEnd: false,
      };
    }
  }

  // Create a new session
  const newSession = await db
    .insert(interviewSessions)
    .values({
      dealId,
      participantId: deal.sellerId || deal.brokerId,
      messages: [],
      extractedInfo: {},
      status: "active",
      questionsAsked: 0,
      questionsAnswered: 0,
      questionsSkipped: 0,
    })
    .returning();

  session = newSession[0];

  // Assemble knowledge base for the opening message
  const kb = assembleKnowledgeBase(deal, documents, tasks, null, resolvedDiscrepancies);

  // Generate the opening message
  const openingResult = await generateOpeningMessage(kb, deal.businessName);

  // Save the opening message to the session
  const aiMessage: ConversationMessage = {
    role: "ai",
    content: openingResult.message,
    timestamp: new Date().toISOString(),
  };

  await db
    .update(interviewSessions)
    .set({
      messages: [aiMessage],
      questionsAsked: 1,
      lastActivityAt: new Date(),
      extractedInfo: {
        _industryContext: openingResult.industryContext,
        _deferredTopics: [],
        _confidenceLevels: {},
      },
    })
    .where(eq(interviewSessions.id, session.id));

  // If the AI identified industry context in the opening, update the KB
  if (openingResult.industryContext) {
    kb.industryContext = openingResult.industryContext;
  }

  return {
    message: openingResult.message,
    suggestedAnswers: openingResult.suggestedAnswers,
    sessionId: session.id,
    captured: { total: countExtractedFields(deal), newFields: [], updatedFields: [], changes: [] },
    sectionCoverage: kb.sectionCoverage.map((s) => ({ key: s.key, title: s.title, status: s.status })),
    industryContext: extractIndustryContextForFrontend(kb.industryContext),
    deferredTopics: [],
    shouldEnd: false,
  };
}

/**
 * Processes a single turn of the interview: seller message in, AI response out.
 */
export async function processTurn(
  dealId: string,
  sessionId: string,
  sellerMessage: string,
): Promise<TurnResult> {
  // Load everything
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const documents = await storage.getDocumentsByDeal(dealId);
  const tasks = await storage.getTasksByDeal(dealId);
  const resolvedDiscrepancies = await storage.getResolvedDiscrepancies(dealId);

  // Build the knowledge base
  const kb = assembleKnowledgeBase(deal, documents, tasks, session, resolvedDiscrepancies);

  // Restore persisted state from session metadata
  const sessionMeta = (session.extractedInfo as Record<string, unknown>) || {};
  if (sessionMeta._industryContext) {
    kb.industryContext = sessionMeta._industryContext as IndustryContext;
  }
  const confidenceLevels = (sessionMeta._confidenceLevels as Record<string, string>) || {};

  // Build the conversation history for the API
  const existingMessages = session.messages as ConversationMessage[];
  const apiMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of existingMessages) {
    apiMessages.push({
      role: msg.role === "ai" ? "assistant" : "user",
      content: msg.content,
    });
  }

  // Add the new seller message
  apiMessages.push({ role: "user", content: sellerMessage });

  // Build the system prompt with current knowledge base
  const systemPrompt = buildInterviewSystemPrompt(kb);

  // Call Claude Opus
  const response = await anthropic.messages.create({
    model: INTERVIEW_MODEL,
    max_tokens: agentConfig.api.maxTokens,
    system: systemPrompt,
    tools: [INTERVIEW_RESPONSE_TOOL],
    tool_choice: { type: "tool", name: "interview_response" },
    messages: apiMessages,
  });

  // Parse the structured response
  const toolUseBlock = response.content.find((block) => block.type === "tool_use");
  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    throw new Error("Interview agent did not return a structured response");
  }

  const aiResponse = toolUseBlock.input as unknown as InterviewResponse;

  // Merge extracted fields
  const existingExtracted = (deal.extractedInfo || {}) as Record<string, unknown>;
  const { merged, updatedConfidence, changes } = mergeExtractedFields(
    existingExtracted as Record<string, string>,
    aiResponse.extractedFields,
    confidenceLevels,
  );

  // Update industry context
  const updatedIndustryContext = updateIndustryContext(
    kb.industryContext,
    aiResponse.reasoning,
    kb.business.location,
  );

  // Save to deal
  await storage.updateDeal(dealId, {
    extractedInfo: merged,
  });

  // Create any tasks
  for (const task of aiResponse.newTasks) {
    await storage.createTask({
      dealId,
      createdBy: "ai_interview",
      assignedTo: deal.sellerId || null,
      type: task.type,
      title: task.title,
      description: task.description,
      relatedField: task.relatedField || null,
      status: "pending",
      priority: "medium",
      aiAttempts: 1,
      aiExplanation: task.sellerExplanation,
    });
  }

  // Update session
  const updatedMessages: ConversationMessage[] = [
    ...existingMessages,
    { role: "user", content: sellerMessage, timestamp: new Date().toISOString() },
    { role: "ai", content: aiResponse.message, timestamp: new Date().toISOString() },
  ];

  const questionsAsked = (session.questionsAsked ?? 0) + 1;
  const questionsAnswered = (session.questionsAnswered ?? 0) +
    (Object.keys(aiResponse.extractedFields).length > 0 ? 1 : 0);
  const questionsSkipped = (session.questionsSkipped ?? 0) +
    aiResponse.newTasks.filter((t) => t.type === "skipped_question").length;

  await db
    .update(interviewSessions)
    .set({
      messages: updatedMessages,
      lastActivityAt: new Date(),
      questionsAsked,
      questionsAnswered,
      questionsSkipped,
      extractedInfo: {
        _industryContext: updatedIndustryContext,
        _deferredTopics: aiResponse.reasoning.deferredTopics,
        _confidenceLevels: updatedConfidence,
      },
      ...(aiResponse.shouldEnd ? { completedAt: new Date(), status: "completed" } : {}),
    })
    .where(eq(interviewSessions.id, sessionId));

  // If the interview is ending, mark the deal
  if (aiResponse.shouldEnd) {
    await storage.updateDeal(dealId, {
      interviewCompleted: true,
    });
  }

  // Rebuild coverage with the updated extracted info
  const updatedDeal = await storage.getDeal(dealId);
  const updatedKb = assembleKnowledgeBase(updatedDeal!, documents, tasks, session, resolvedDiscrepancies);

  return {
    message: aiResponse.message,
    suggestedAnswers: aiResponse.suggestedAnswers || [],
    sessionId,
    captured: {
      total: countExtractedFields(updatedDeal!),
      newFields: changes.filter((c) => c.previousValue === null).map((c) => c.fieldName),
      updatedFields: changes.filter((c) => c.previousValue !== null).map((c) => c.fieldName),
      changes,
    },
    sectionCoverage: updatedKb.sectionCoverage.map((s) => ({ key: s.key, title: s.title, status: s.status })),
    industryContext: extractIndustryContextForFrontend(updatedIndustryContext),
    deferredTopics: aiResponse.reasoning.deferredTopics,
    shouldEnd: aiResponse.shouldEnd,
    endReason: aiResponse.endReason,
  };
}

/**
 * Gets the conversation history for a session (for frontend display on resume).
 */
export async function getSessionHistory(sessionId: string): Promise<{
  messages: ConversationMessage[];
  status: string;
}> {
  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  return {
    messages: session.messages as ConversationMessage[],
    status: session.status,
  };
}

// =====================
// Internal helpers
// =====================

async function getSession(sessionId: string): Promise<InterviewSession | null> {
  const results = await db
    .select()
    .from(interviewSessions)
    .where(eq(interviewSessions.id, sessionId));
  return results[0] || null;
}

async function generateOpeningMessage(
  kb: KnowledgeBase,
  businessName: string,
): Promise<{ message: string; suggestedAnswers: string[]; industryContext: IndustryContext | null }> {
  const systemPrompt = buildInterviewSystemPrompt(kb);

  // The opening prompt varies based on what we already know
  const hasQuestionnaireData = kb.questionnaireData && Object.keys(kb.questionnaireData).length > 0;
  const hasDocuments = kb.documents.length > 0;
  const hasPriorSession = kb.priorSessionSummary !== null;

  let openingInstruction: string;

  if (hasPriorSession) {
    openingInstruction = `The seller is returning to continue a previous interview session. Welcome them back warmly, briefly summarize what you've already covered, and explain what areas you'd like to explore next. Do not repeat any questions that were already answered.`;
  } else if (hasQuestionnaireData && hasDocuments) {
    openingInstruction = `This is the start of the interview. The seller has already completed a questionnaire and uploaded documents. Welcome them warmly, briefly acknowledge what you've already reviewed (without listing every detail), and explain that you'd like to have a conversation to fill in the details and get the full picture. Start with your first question — focus on an area where the questionnaire answers were thin or where you need more depth.`;
  } else if (hasQuestionnaireData) {
    openingInstruction = `This is the start of the interview. The seller has completed a questionnaire. Welcome them, acknowledge you've reviewed their answers, and start with a question that builds on something they already told you — or explores an area their questionnaire didn't cover well.`;
  } else {
    openingInstruction = `This is the start of the interview. You don't have much background yet. Welcome the seller warmly, briefly explain the purpose of the interview (to collect the information needed for a professional CIM/CBO document that will present their business to qualified buyers), and start with a broad opening question to understand the business — what they do, how long they've been operating, and where they're located. This will help you identify the industry and location context for industry-specific questions.`;
  }

  const response = await anthropic.messages.create({
    model: INTERVIEW_MODEL,
    max_tokens: agentConfig.api.maxTokens,
    system: systemPrompt,
    tools: [INTERVIEW_RESPONSE_TOOL],
    tool_choice: { type: "tool", name: "interview_response" },
    messages: [
      {
        role: "user",
        content: `[SYSTEM: ${openingInstruction}]\n\nGenerate your opening message to the seller. The business is "${businessName}".`,
      },
    ],
  });

  const toolUseBlock = response.content.find((block) => block.type === "tool_use");
  if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
    // Fallback if the model doesn't use the tool
    const textBlock = response.content.find((block) => block.type === "text");
    return {
      message: textBlock && textBlock.type === "text"
        ? textBlock.text
        : `Hi! I'm here to learn about ${businessName} so we can put together a great CIM for your buyers. Let's start — can you tell me a bit about the business?`,
      suggestedAnswers: [],
      industryContext: null,
    };
  }

  const aiResponse = toolUseBlock.input as unknown as InterviewResponse;

  // Extract industry context if the AI identified it from questionnaire data
  let industryContext: IndustryContext | null = null;
  if (aiResponse.reasoning.industryContext.identified) {
    industryContext = {
      industry: aiResponse.reasoning.industryContext.industry,
      subIndustry: aiResponse.reasoning.industryContext.subIndustry || null,
      location: kb.business.location,
      industrySpecificAreas: aiResponse.reasoning.industryContext.activeIndustryTopics,
      regulatoryNotes: aiResponse.reasoning.industryContext.regulatoryNotes,
    };
  }

  return {
    message: aiResponse.message,
    suggestedAnswers: aiResponse.suggestedAnswers || [],
    industryContext,
  };
}

function countExtractedFields(deal: { extractedInfo: unknown }): number {
  const info = deal.extractedInfo as Record<string, unknown> | null;
  if (!info) return 0;
  return Object.values(info).filter(
    (v) => v !== null && v !== undefined && v !== "",
  ).length;
}

function extractIndustryContextForFrontend(
  ctx: IndustryContext | null,
): TurnResult["industryContext"] {
  if (!ctx) {
    return {
      identified: false,
      industry: "",
      activeTopics: [],
      coveredTopics: [],
    };
  }
  return {
    identified: true,
    industry: ctx.industry + (ctx.subIndustry ? ` — ${ctx.subIndustry}` : ""),
    activeTopics: ctx.industrySpecificAreas,
    coveredTopics: [], // Computed from the diff of initial vs active
  };
}
