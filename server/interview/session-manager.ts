import Anthropic from "@anthropic-ai/sdk";
import { db } from "../db";
import { storage } from "../storage";
import {
  interviewSessions,
  type InterviewSession,
  type ConversationMessage,
} from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { assembleKnowledgeBase, KNOWN_EXTRACTED_FIELDS, type KnowledgeBase, type IndustryContext } from "./knowledge-base";
import { buildInterviewSystemBlocks } from "./system-prompt";
import { callInterviewWithRecovery, governCompletion } from "./turn-guard";
import { mergeExtractedFields, updateIndustryContext, canonicalFieldName, type FieldChange } from "./info-merger";
import { agentConfig } from "./config/load-config";
import { generateSellerProfile } from "./eq-profiler";
import { runInterviewLearningLoop } from "./learning-loop";

// =====================
// Types
// =====================

export interface TurnResult {
  /** The message to display to the seller */
  message: string;
  /** Buyer-rationale for the question asked — behind "Why we ask this" */
  whyItMatters?: string;
  /** Pre-populated answer options the seller can click to respond */
  suggestedAnswers: string[];
  /** Session ID (for subsequent turns) */
  sessionId: string;
  /** Summary of what was captured this turn */
  captured: {
    /** Populated coverage-known canonical fields — same vocabulary as the
     *  CIM COVERAGE panel, so the header count can never wildly diverge
     *  from the panel again. */
    total: number;
    /** Every populated extractedInfo key, including ad-hoc document
     *  extraction keys that don't map to a CIM section. */
    rawTotal: number;
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
  let deal = await storage.getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  // Seed extractedInfo from the intake questionnaire so answers the seller
  // already typed count toward coverage and are NEVER re-asked. (Intake keys
  // like "reasonForSelling" are canonicalised to schema keys like
  // "reasonForSale" — previously they never matched, so coverage showed the
  // section as missing and the agent asked again.)
  const seeded = seedExtractedInfoFromQuestionnaire(deal);
  if (seeded) {
    await storage.updateDeal(dealId, { extractedInfo: seeded });
    deal = { ...deal, extractedInfo: seeded };
  }

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
    const messages = session.messages as ConversationMessage[];
    const userMessageCount = messages.filter((m) => m.role === "user").length;

    // If this is an abandoned session (only the AI opening, no user replies)
    // and the deal already had a prior completed conversation, discard it
    // and create a fresh session with returning-seller context.
    const hasCompletedSession = existingSessions.some((s) => s.status === "completed");
    if (userMessageCount === 0 && hasCompletedSession) {
      await db
        .update(interviewSessions)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(interviewSessions.id, session.id));
      session = undefined as any;
    } else if (messages.length > 0) {
      // Resume existing session with real conversation history
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
        captured: { ...countExtractedFields(deal), newFields: [], updatedFields: [], changes: [] },
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

  // Auto-generate Seller Communication Profile if not already present.
  // This runs in the background — we don't block the opening message on it.
  // The profile will be available for the second turn onward.
  if (!deal.sellerProfile) {
    generateSellerProfile(dealId)
      .then(async (profile) => {
        await storage.updateDeal(dealId, { sellerProfile: profile } as any);
        console.log(`[session-manager] Auto-generated seller profile for deal ${dealId}`);
      })
      .catch((err) => {
        console.error(`[session-manager] Failed to auto-generate seller profile for deal ${dealId}:`, err);
      });
  }

  // If there's a completed prior session, pass it so the AI knows this is
  // a returning seller and can welcome them back instead of starting fresh.
  const priorCompletedSession = existingSessions.find((s) => s.status === "completed") || null;

  // Assemble knowledge base for the opening message
  const kb = assembleKnowledgeBase(deal, documents, tasks, priorCompletedSession, resolvedDiscrepancies);

  // Generate the opening message
  const openingResult = await generateOpeningMessage(kb, deal.businessName);

  // Save the opening message to the session
  const aiMessage: ConversationMessage = {
    role: "ai",
    content: openingResult.message,
    timestamp: new Date().toISOString(),
  };

  // Confidence map from the most recent prior session (if any) — confirmed
  // fields stay confirmed across sessions.
  const priorSessions = await db
    .select()
    .from(interviewSessions)
    .where(eq(interviewSessions.dealId, dealId))
    .orderBy(desc(interviewSessions.lastActivityAt));
  const priorMeta = priorSessions.find((s) => s.id !== session.id)?.extractedInfo as
    | Record<string, unknown>
    | null
    | undefined;
  const priorConfidenceLevels =
    (priorMeta?._confidenceLevels as Record<string, string> | undefined) ?? {};

  await db
    .update(interviewSessions)
    .set({
      messages: [aiMessage],
      questionsAsked: 1,
      lastActivityAt: new Date(),
      extractedInfo: {
        _industryContext: openingResult.industryContext,
        _deferredTopics: [],
        // Carry seller confirmations forward from any prior session — a
        // fresh map would demote confirmed fields to "inferred" and make
        // the agent re-verify answers the seller already gave.
        _confidenceLevels: priorConfidenceLevels,
      },
    })
    .where(eq(interviewSessions.id, session.id));

  // If the AI identified industry context in the opening, update the KB
  if (openingResult.industryContext) {
    kb.industryContext = openingResult.industryContext;
  }

  return {
    message: openingResult.message,
    whyItMatters: openingResult.whyItMatters,
    suggestedAnswers: openingResult.suggestedAnswers,
    sessionId: session.id,
    captured: { ...countExtractedFields(deal), newFields: [], updatedFields: [], changes: [] },
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
  /** Optional: stream the AI message text to the caller as it's generated.
   *  Purely a display channel — the returned TurnResult is authoritative. */
  onDelta?: (chunk: string) => void,
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

  // The Anthropic API requires the first message to have role "user".
  // The opening AI message is stored without the triggering user prompt,
  // so prepend a synthetic user message if the history starts with "assistant".
  if (apiMessages.length > 0 && apiMessages[0].role === "assistant") {
    apiMessages.unshift({
      role: "user",
      content: "Please begin the interview.",
    });
  }

  // Add the new seller message
  apiMessages.push({ role: "user", content: sellerMessage });

  // Build the system prompt with current knowledge base
  const systemBlocks = await buildInterviewSystemBlocks(kb);

  // Seller turns so far, including this one — drives completion governance
  // and the wrap-up pacing nudge.
  const userTurnCount =
    existingMessages.filter((m) => m.role === "user").length + 1;

  // Past the soft ceiling, steer the agent toward wrapping up rather than
  // letting a long session run open-ended.
  if (userTurnCount >= agentConfig.interview.maxTurnsBeforeEndCheck) {
    systemBlocks.push({
      type: "text",
      text: `# PACING\nThis conversation has run ${userTurnCount} seller turns. Respect the seller's time: focus only on remaining [CRITICAL] gaps, convert everything else into broker follow-up tasks, and move toward a natural wrap-up.`,
    });
  }

  const callParams = {
    model: INTERVIEW_MODEL,
    maxTokens: agentConfig.api.maxTokens,
    temperature: agentConfig.api.temperature,
    system: systemBlocks,
    messages: apiMessages,
  };

  // Call Claude Opus — recovery-wrapped, so a malformed or truncated response
  // retries once and then degrades gracefully instead of dead-ending the seller.
  // onDelta streams the message text for display; the parsed result is still
  // authoritative (governance/merge/persist below are unchanged).
  let { response: aiResponse } = await callInterviewWithRecovery(anthropic, callParams, onDelta);

  // Merge extracted fields
  const existingExtracted = (deal.extractedInfo || {}) as Record<string, unknown>;
  let { merged, updatedConfidence, changes } = mergeExtractedFields(
    existingExtracted as Record<string, string>,
    aiResponse.extractedFields,
    confidenceLevels,
  );

  // Completion governance: the model may only end once the configured turn
  // floor is met and every critical section has at least partial coverage.
  // A seller's explicit request to stop always wins. When an end is blocked,
  // the model is re-called once with an instruction to continue into the most
  // important gap, so the seller sees a natural transition — not a dead stop.
  if (aiResponse.shouldEnd) {
    const prospectiveKb = assembleKnowledgeBase(
      { ...deal, extractedInfo: merged } as typeof deal,
      documents,
      tasks,
      session,
      resolvedDiscrepancies,
    );
    const verdict = governCompletion({
      shouldEnd: aiResponse.shouldEnd,
      endReason: aiResponse.endReason,
      sellerMessage,
      userTurnCount,
      sectionCoverage: prospectiveKb.sectionCoverage.map((s) => ({ key: s.key, status: s.status })),
      deferredTopics: aiResponse.reasoning.deferredTopics,
      minTurnsBeforeEnd: agentConfig.interview.minTurnsBeforeEnd,
    });

    if (!verdict.allowEnd) {
      console.warn(`[session-manager] Blocked premature interview end: ${verdict.blockReason}`);
      const { response: continued } = await callInterviewWithRecovery(anthropic, {
        ...callParams,
        messages: [
          ...apiMessages,
          { role: "assistant" as const, content: aiResponse.message },
          { role: "user" as const, content: verdict.continuationInstruction! },
        ],
      });
      continued.shouldEnd = false; // governance is authoritative
      aiResponse = continued;

      // Fold in anything the continuation turn extracted
      const remerge = mergeExtractedFields(merged, aiResponse.extractedFields, updatedConfidence);
      merged = remerge.merged;
      updatedConfidence = remerge.updatedConfidence;
      changes = [...changes, ...remerge.changes];
    }
  }

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

  // If the interview is ending, mark the deal and trigger learning loop
  if (aiResponse.shouldEnd) {
    await storage.updateDeal(dealId, {
      interviewCompleted: true,
      // A finished interview means platform intake is underway — move the
      // deal off phase 1 so the broker's Overview reflects reality.
      ...(deal.phase === "phase1_info_collection" ? { phase: "phase2_platform_intake" } : {}),
    });

    // Fire-and-forget: analyze the completed interview for learning insights
    runInterviewLearningLoop(dealId, sessionId).catch((err) => {
      console.error(`[session-manager] Learning loop failed for session ${sessionId}:`, err);
    });
  }

  // Rebuild coverage with the updated extracted info
  const updatedDeal = await storage.getDeal(dealId);
  const updatedKb = assembleKnowledgeBase(updatedDeal!, documents, tasks, session, resolvedDiscrepancies);

  return {
    message: aiResponse.message,
    whyItMatters: aiResponse.whyItMatters,
    suggestedAnswers: aiResponse.suggestedAnswers || [],
    sessionId,
    captured: {
      ...countExtractedFields(updatedDeal!),
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
/** Returns the dealId a session belongs to (for access checks), or null. */
export async function getSessionDealId(sessionId: string): Promise<string | null> {
  const session = await getSession(sessionId);
  return session?.dealId ?? null;
}

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
): Promise<{ message: string; whyItMatters?: string; suggestedAnswers: string[]; industryContext: IndustryContext | null }> {
  const systemBlocks = await buildInterviewSystemBlocks(kb);

  // The opening prompt varies based on what we already know
  const hasQuestionnaireData = kb.questionnaireData && Object.keys(kb.questionnaireData).length > 0;
  const hasDocuments = kb.documents.length > 0;
  const hasPriorSession = kb.priorSessionSummary !== null;

  let openingInstruction: string;

  if (hasPriorSession) {
    openingInstruction = `The seller is returning to an ongoing conversation. Welcome them back warmly. Briefly acknowledge what you already have a good picture of (don't list everything — just mention 2-3 highlights so they know you remember). Then ask if there's anything they'd like to add, update, or correct. If there are still gaps in the knowledge base, gently mention the most important one and ask if they'd like to cover it. Keep the tone casual and collaborative — this is a conversation they can come back to anytime, not a formal interview. Do not repeat any questions that were already answered.`;
  } else if (hasQuestionnaireData && hasDocuments) {
    openingInstruction = `This is the start of the interview. The seller has already completed a questionnaire and uploaded documents. Welcome them warmly, briefly acknowledge what you've already reviewed (without listing every detail), and explain that you'd like to have a conversation to fill in the details and get the full picture. Start with your first question — focus on an area where the questionnaire answers were thin or where you need more depth.`;
  } else if (hasQuestionnaireData) {
    openingInstruction = `This is the start of the interview. The seller has completed a questionnaire. Welcome them, acknowledge you've reviewed their answers, and start with a question that builds on something they already told you — or explores an area their questionnaire didn't cover well.`;
  } else {
    openingInstruction = `This is the start of the interview. You don't have much background yet. Welcome the seller warmly, briefly explain the purpose of the interview (to collect the information needed for a professional CIM/CBO document that will present their business to qualified buyers), and start with a broad opening question to understand the business — what they do, how long they've been operating, and where they're located. This will help you identify the industry and location context for industry-specific questions.`;
  }

  // Recovery-wrapped: retries a malformed/truncated opening once, then falls
  // back below — the seller never lands on an empty chat with no question.
  const { response: aiResponse, degraded } = await callInterviewWithRecovery(anthropic, {
    model: INTERVIEW_MODEL,
    maxTokens: agentConfig.api.maxTokens,
    temperature: agentConfig.api.temperature,
    system: systemBlocks,
    messages: [
      {
        role: "user",
        content: `[SYSTEM: ${openingInstruction}]\n\nGenerate your opening message to the seller. The business is "${businessName}".`,
      },
    ],
  });

  if (degraded || !aiResponse.message) {
    // The turn-guard's generic recovery copy is wrong for a first contact —
    // use a business-specific opening instead.
    return {
      message: `Hi! I'm here to learn about ${businessName} so we can put together a great CIM for your buyers. Let's start — can you tell me a bit about the business?`,
      suggestedAnswers: [],
      industryContext: null,
    };
  }

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
    whyItMatters: aiResponse.whyItMatters,
    suggestedAnswers: aiResponse.suggestedAnswers || [],
    industryContext,
  };
}

/**
 * Ends a session at the seller's explicit request (the "End Overview"
 * button). Previously this was client-side only: the session stayed
 * "active" forever, deal.interviewCompleted stayed false (so the seller's
 * progress never advanced), and the next visit dropped the seller straight
 * back into the conversation they thought they had closed.
 */
export async function endSessionManually(
  dealId: string,
  sessionId: string,
): Promise<{ ok: true }> {
  const session = await getSession(sessionId);
  if (!session || session.dealId !== dealId) {
    throw new Error("Session not found for this deal");
  }

  if (session.status !== "completed") {
    await db
      .update(interviewSessions)
      .set({ status: "completed", completedAt: new Date(), lastActivityAt: new Date() })
      .where(eq(interviewSessions.id, sessionId));
  }

  const dealRow = await storage.getDeal(dealId);
  await storage.updateDeal(dealId, {
    interviewCompleted: true,
    ...(dealRow?.phase === "phase1_info_collection" ? { phase: "phase2_platform_intake" } : {}),
  });

  // Fire-and-forget: learn from the transcript like an AI-driven ending does
  runInterviewLearningLoop(dealId, sessionId).catch((err) => {
    console.error(`[session-manager] Learning loop failed for manually-ended session ${sessionId}:`, err);
  });

  return { ok: true };
}

function countExtractedFields(deal: { extractedInfo: unknown }): { total: number; rawTotal: number } {
  const info = deal.extractedInfo as Record<string, unknown> | null;
  if (!info) return { total: 0, rawTotal: 0 };
  const populated = Object.entries(info).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  return {
    // Only coverage-known canonical fields count toward the headline number —
    // ad-hoc document keys inflated it to "207 fields captured" while the
    // coverage panel (which reads the canonical vocabulary) showed 0 covered.
    total: populated.filter(([k]) => KNOWN_EXTRACTED_FIELDS.has(k)).length,
    rawTotal: populated.length,
  };
}

/**
 * Copies intake-questionnaire answers into extractedInfo (canonicalised key
 * names, coverage-known fields only, never overwriting existing values).
 * Returns the new extractedInfo map when anything was added, else null.
 */
function seedExtractedInfoFromQuestionnaire(deal: {
  questionnaireData: unknown;
  extractedInfo: unknown;
}): Record<string, unknown> | null {
  const questionnaire = deal.questionnaireData as Record<string, unknown> | null;
  if (!questionnaire || Object.keys(questionnaire).length === 0) return null;

  const existing = (deal.extractedInfo || {}) as Record<string, unknown>;
  let added = false;
  const seeded = { ...existing };

  for (const [rawKey, rawValue] of Object.entries(questionnaire)) {
    if (typeof rawValue !== "string" || rawValue.trim() === "") continue;
    const key = canonicalFieldName(rawKey);
    if (!KNOWN_EXTRACTED_FIELDS.has(key)) continue;
    const current = seeded[key];
    if (current !== null && current !== undefined && current !== "") continue;
    seeded[key] = rawValue.trim();
    added = true;
  }

  return added ? seeded : null;
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
    coveredTopics: ctx.coveredIndustryTopics ?? [],
  };
}
