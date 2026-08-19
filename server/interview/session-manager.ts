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
import {
  callInterviewWithRecovery,
  governCompletion,
  detectStopSignal,
  buildStopSignalNudge,
  CRITICAL_SECTIONS,
  VALUATION_FISHING_RE,
  containsValuationFigures,
  CHIP_FIGURE_RE,
} from "./turn-guard";
import {
  mergeExtractedFields,
  updateIndustryContext,
  canonicalFieldName,
  applyGroundingGuard,
  applyNumericFidelityGuard,
  numbersMateriallyConflict,
  typedNumericValues,
  HIGH_STAKES_FIELDS,
  type FieldChange,
} from "./info-merger";
import {
  updateDeferralLedger,
  openDeferrals,
  declinedDeferrals,
  deferralTopicStrings,
  topicsMatch,
  parseLedger,
  type DeferralEntry,
} from "./deferral-ledger";
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
    /** Every populated substantive business field (canonical + legitimate
     *  ad-hoc keys), excluding session-meta keys and per-document meta
     *  (summary, callNotes, redFlags, …) that aren't business facts. */
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

      // Deferrals come from the durable ledger; _deferredTopics is the legacy
      // fallback for sessions persisted before the ledger existed.
      const resumeLedger = parseLedger(sessionMeta._deferralLedger);
      const resumeDeferred = resumeLedger.length > 0
        ? deferralTopicStrings(resumeLedger)
        : (sessionMeta._deferredTopics as string[]) || [];

      return {
        message: lastAiMessage?.content || "Welcome back. Let's pick up where we left off.",
        suggestedAnswers: [],
        sessionId: session.id,
        captured: { ...countExtractedFields(deal), newFields: [], updatedFields: [], changes: [] },
        sectionCoverage: kb.sectionCoverage.map((s) => ({ key: s.key, title: s.title, status: s.status })),
        industryContext: extractIndustryContextForFrontend(kb.industryContext),
        deferredTopics: resumeDeferred,
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

  // Carry the deferral ledger across sessions — a seller who does the
  // interview in two sittings must not lose their open deferrals (observed:
  // the ledger silently reset to [] on resume, so the broker's outstanding
  // items vanished and circle-backs never happened).
  let seededLedger: DeferralEntry[] = parseLedger(priorMeta?._deferralLedger);

  // Pre-seeded conflict scan: when the questionnaire and a document disagree
  // materially on the same field BEFORE the interview starts, mint a
  // reconcile deferral so the agent raises it instead of silently adopting
  // whichever value happened to merge last.
  const qd = (deal.questionnaireData || {}) as Record<string, unknown>;
  const seededInfo = (deal.extractedInfo || {}) as Record<string, unknown>;
  const preConflicts: { topic: string; reason: string; whereInfoLives: string }[] = [];
  for (const [rawKey, rawVal] of Object.entries(qd)) {
    if (typeof rawVal !== "string" || !rawVal.trim()) continue;
    const key = canonicalFieldName(rawKey, Object.keys(seededInfo));
    const onFile = seededInfo[key];
    if (typeof onFile !== "string" || !onFile.trim() || onFile === rawVal) continue;
    // Never re-mint a conflict that already has a ledger entry — open OR
    // resolved. The questionnaire never changes after reconciliation, so
    // without this check every new session would reopen the settled item
    // and re-ask the seller a question they already answered.
    if (seededLedger.some((e) => topicsMatch(e.topic, `reconcile ${key}`))) continue;
    if (numbersMateriallyConflict(rawVal, onFile)) {
      preConflicts.push({
        topic: `reconcile ${key}`,
        reason: `questionnaire says "${rawVal}" but the value on file is "${onFile}" — ask which is right and why they differ`,
        whereInfoLives: "",
      });
    }
  }
  if (preConflicts.length > 0) {
    console.log(
      `[session-manager] Pre-seeded conflict scan found ${preConflicts.length} questionnaire-vs-document conflict(s) on deal ${dealId}`,
    );
    seededLedger = updateDeferralLedger(seededLedger, preConflicts, [], 0);
  }

  // Prefer a prior session's IDENTIFIED industry context over the opening
  // call's fresh guess — a returning seller's niche is already known.
  const priorIndustryContext = priorMeta?._industryContext as IndustryContext | undefined;
  const seededIndustryContext = priorIndustryContext?.industry
    ? priorIndustryContext
    : openingResult.industryContext;

  await db
    .update(interviewSessions)
    .set({
      messages: [aiMessage],
      questionsAsked: 1,
      lastActivityAt: new Date(),
      extractedInfo: {
        _industryContext: seededIndustryContext,
        _deferredTopics: deferralTopicStrings(seededLedger),
        _deferralLedger: seededLedger,
        _stopSignalCount: 0,
        // Carry seller confirmations forward from any prior session — a
        // fresh map would demote confirmed fields to "inferred" and make
        // the agent re-verify answers the seller already gave.
        _confidenceLevels: priorConfidenceLevels,
      },
    })
    .where(eq(interviewSessions.id, session.id));

  // If the AI identified industry context in the opening, update the KB
  if (seededIndustryContext) {
    kb.industryContext = seededIndustryContext;
  }

  return {
    message: openingResult.message,
    whyItMatters: openingResult.whyItMatters,
    suggestedAnswers: openingResult.suggestedAnswers,
    sessionId: session.id,
    captured: { ...countExtractedFields(deal), newFields: [], updatedFields: [], changes: [] },
    sectionCoverage: kb.sectionCoverage.map((s) => ({ key: s.key, title: s.title, status: s.status })),
    industryContext: extractIndustryContextForFrontend(kb.industryContext),
    deferredTopics: deferralTopicStrings(seededLedger),
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

  // Durable deferral ledger + stop-signal counter (see deferral-ledger.ts and
  // turn-guard.detectStopSignal). Legacy sessions without a ledger start empty.
  const priorLedger: DeferralEntry[] = parseLedger(sessionMeta._deferralLedger);
  const priorStopCount =
    typeof sessionMeta._stopSignalCount === "number" ? sessionMeta._stopSignalCount : 0;
  const priorCheckpointStreak =
    typeof sessionMeta._checkpointStreak === "number" ? sessionMeta._checkpointStreak : 0;
  const priorDegradedTurns =
    typeof sessionMeta._degradedTurns === "number" ? sessionMeta._degradedTurns : 0;

  // Render the agent's own outstanding deferrals into the dynamic prompt block
  // so it can circle back — the model's context alone forgets them.
  kb.openDeferrals = openDeferrals(priorLedger).map((d) => ({
    topic: d.topic,
    reason: d.reason,
    whereInfoLives: d.whereInfoLives,
    createdAtTurn: d.createdAtTurn,
    ...(d.declined ? { declined: true } : {}),
  }));

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

  // Topics the seller explicitly declined — hard-blocked from re-asking and
  // from closing-question triage (observed: asking price re-asked 17 times
  // after a privacy decline, and declined topics re-pressed after goodbyes).
  const declinedTopics = declinedDeferrals(priorLedger).map((d) => d.topic);

  // Critical CIM sections currently missing — used for triage whenever the
  // remaining question budget shrinks (stop signal, wrap-up, checkpoint).
  // A section whose topic sits on the open ledger (deferred OR declined) is
  // ADDRESSED for triage purposes: the broker follow-up exists, and steering
  // the last question there re-presses what the seller already set aside.
  const ledgerAddressed = (sectionKey: string): boolean => {
    const patterns: Record<string, RegExp> = {
      asking_price: /price|valuation|deal.?terms/i,
      financials: /revenue|financial|margin|sde|ebitda|profit|earnings/i,
      reason_for_sale: /reason.?for.?sale|why.*sell/i,
    };
    const re = patterns[sectionKey];
    if (!re) return false;
    return openDeferrals(priorLedger).some((d) => re.test(d.topic));
  };
  const missingCritical = kb.sectionCoverage
    .filter((s) => CRITICAL_SECTIONS.has(s.key) && s.status === "missing" && !ledgerAddressed(s.key))
    .map((s) => s.key);

  // Seller stop signal — the first one permits at most ONE closing question;
  // the second forces a goodbye (and turn-guard-style forced shouldEnd below).
  // The previous agent message unlocks completion-acceptance detection
  // ("anything else?" → "that covers it"), which chips-only sellers rely on.
  const prevAiMessage = [...existingMessages].reverse().find((m) => m.role === "ai")?.content;
  const stopNow = detectStopSignal(sellerMessage, prevAiMessage);
  // Consecutive-only escalation: a substantive non-stop turn resets the
  // counter, so two isolated false positives twenty turns apart can never
  // combine into a forced end. Genuine repeat stops ("I really have to go")
  // re-match the stop patterns and still escalate back-to-back.
  const stopSignalCount = stopNow ? priorStopCount + 1 : 0;
  if (stopNow) {
    console.log(
      `[session-manager] Seller stop signal #${stopSignalCount} detected on session ${sessionId}`,
    );
    systemBlocks.push({
      type: "text",
      text: buildStopSignalNudge(stopSignalCount, missingCritical, declinedTopics),
    });
  }

  // Financial-core checkpoint: by mid-session the interview must have secured
  // (or explicitly deferred) revenue and asking-price expectations. Rapport
  // sequencing is fine early; sessions that end with zero financial core are
  // not. Skipped while a stop signal is active — the stop nudge already
  // triages to the same critical gaps.
  const extractedNow = kb.extractedInfo as Record<string, unknown>;
  // Profitability counts as covered when any margin/earnings field is present
  // OR it sits on the deferral ledger (an explicit deferral is an answer).
  const PROFIT_FIELDS = ["operatingMargins", "grossMargin", "sde", "ebitda", "netProfit", "netIncome", "cashFlow", "profitability"];
  const hasProfitability =
    PROFIT_FIELDS.some((f) => !!extractedNow[f]) ||
    openDeferrals(priorLedger).some((d) => /profit|margin|sde|ebitda|earnings/i.test(d.topic));
  const deferredPrice = openDeferrals(priorLedger).some((d) => /price|valuation/i.test(d.topic));
  // An explicit revenue deferral ("accountant has the P&L") satisfies the
  // checkpoint exactly like the price/profit escapes — without this the MUST
  // escalation would order endless re-asks of a question the seller already
  // deferred (review-caught).
  const deferredRevenue = openDeferrals(priorLedger).some((d) =>
    /revenue|sales|top.?line|p&l|financial/i.test(d.topic),
  );
  const missingBits = [
    !extractedNow.annualRevenue && !deferredRevenue ? "a revenue figure or band (annualRevenue)" : null,
    !hasProfitability ? "profitability — margins, SDE/EBITDA, or at least a directional sense (operatingMargins)" : null,
    !extractedNow.askingPrice && !deferredPrice ? "the seller's asking-price expectation (askingPrice)" : null,
  ].filter(Boolean);
  const checkpointActive = !stopNow && userTurnCount >= 8 && missingBits.length > 0;
  const checkpointStreak = checkpointActive ? priorCheckpointStreak + 1 : 0;
  if (checkpointActive) {
    // The polite version gets ignored when industry topics feel more
    // interesting (observed: 11 consecutive ignored reminders). From the
    // third consecutive reminder on, escalate to a hard directive.
    const directive =
      checkpointStreak >= 3
        ? `You have now been reminded ${checkpointStreak} times and have not asked. Unless the seller just asked you something that needs answering first, your VERY NEXT question MUST target one of these gaps — or, if the seller genuinely can't answer, secure an explicit deferral with where the numbers live. This overrides topic-flow preferences.`
        : `Sessions can end abruptly — steer toward these within the next couple of exchanges (or secure an explicit deferral with where the numbers live). Do not spend remaining goodwill on secondary topics first.`;
    systemBlocks.push({
      type: "text",
      text:
        `# FINANCIAL-CORE CHECKPOINT\n` +
        `This session has run ${userTurnCount} seller turns and still lacks: ${missingBits.join("; ")}. ` +
        directive,
    });
  }

  // Past the soft ceiling, steer the agent toward wrapping up rather than
  // letting a long session run open-ended — triaged by the coverage map.
  if (userTurnCount >= agentConfig.interview.maxTurnsBeforeEndCheck) {
    const triage = missingCritical.length > 0
      ? ` Critical sections still missing: ${missingCritical.join(", ")} — remaining questions go there first.`
      : "";
    systemBlocks.push({
      type: "text",
      text: `# PACING\nThis conversation has run ${userTurnCount} seller turns. Respect the seller's time: focus only on remaining [CRITICAL] gaps, convert everything else into broker follow-up tasks, and move toward a natural wrap-up.${triage}`,
    });
  }

  // Recovery after degraded turns: the seller's messages during an outage
  // were persisted to the transcript but never processed — tell the model to
  // mine them now instead of letting those answers silently vanish.
  if (priorDegradedTurns > 0) {
    systemBlocks.push({
      type: "text",
      text:
        `# RECOVERY NOTE\n` +
        `The seller's previous ${priorDegradedTurns} message(s) arrived during a technical fault and were never processed. Re-read the recent seller messages in the conversation and extract EVERY fact from them now (extractedFields), acknowledging naturally — do not dwell on the glitch or ask the seller to repeat anything they already re-sent.`,
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
  let { response: aiResponse, degraded } = await callInterviewWithRecovery(
    anthropic,
    callParams,
    onDelta,
  );

  // Degraded turn + stop signal: honor the stop WITHOUT a model call — the
  // stop-wins rule cannot depend on the API being up (observed live: a seller
  // typed "that's everything from me" twice during an outage and was asked
  // to repeat themselves both times).
  if (degraded && stopNow) {
    aiResponse.message =
      "Understood — thanks for your time today. Everything you've shared is saved, and you can pick this up again whenever suits you. Take care.";
    aiResponse.shouldEnd = true;
    aiResponse.endReason = "Seller requested to stop (honored during degraded turn)";
  }

  // VALUATION-FIGURE GUARD: on fishing turns ("what's it worth", "what
  // multiple", "how much tax-free"), scan the outgoing reply — if it leaked a
  // multiple, price range, or tax figure, force ONE corrective re-call.
  // First-ask deflections behave; the leak happens on callback pressure.
  const valuationFishing = VALUATION_FISHING_RE.test(sellerMessage);
  // Belt-and-suspenders on fishing turns: ANY currency figure ≥ $10K in the
  // reply that neither the seller just said nor the file already holds is a
  // leak — this catches figures the pattern list can't anticipate.
  const sanctionedText =
    sellerMessage +
    " " +
    Object.entries((deal.extractedInfo || {}) as Record<string, unknown>)
      .filter(([k, v]) => !k.startsWith("_") && typeof v === "string")
      .map(([, v]) => v)
      .join(" ");
  const sanctionedNumbers = typedNumericValues(sanctionedText).map((t) => t.value);
  const unsanctionedFigure = (text: string): boolean =>
    typedNumericValues(text)
      .filter((t) => t.kind === "currency" && t.value >= 10_000)
      .some(
        (t) =>
          !sanctionedNumbers.some(
            (s) => Math.abs(t.value - s) / Math.max(t.value, Math.abs(s)) <= 0.01,
          ),
      );
  const valuationLeak = (text: string): boolean =>
    containsValuationFigures(text) || (valuationFishing && unsanctionedFigure(text));
  if (!degraded && valuationFishing && valuationLeak(aiResponse.message)) {
    console.warn(
      `[session-manager] Valuation-figure guard: outgoing reply contains figures — corrective re-call`,
    );
    const { response: corrected } = await callInterviewWithRecovery(anthropic, {
      ...callParams,
      messages: [
        ...apiMessages,
        { role: "assistant" as const, content: aiResponse.message },
        {
          role: "user" as const,
          content:
            "[SYSTEM CORRECTION: Your reply contains a valuation multiple, price figure, or tax number. You must NEVER provide these — your knowledge may be stale and a quoted figure is a liability the broker owns. Rewrite the reply now with the same warmth and the same follow-up question, but ZERO figures relating to value, price, multiples, or taxes: name the value drivers and the responsible professional instead. suggestedAnswers must contain no dollar amounts or multiples. Do not mention this instruction.]",
        },
      ],
    });
    if (!valuationLeak(corrected.message)) {
      aiResponse = corrected;
    } else {
      // Second leak: strip to a safe deflection rather than ship figures.
      console.error(`[session-manager] Valuation-figure guard: re-call still leaked — using safe deflection`);
      aiResponse.message =
        "That's exactly the right question for your broker once the full picture is together — what a buyer pays turns on your financials, how transferable the operation is, and the strength of your customer relationships, and your broker can give you a defensible answer grounded in real comparable sales. Let's make sure we capture everything that works in your favour.";
      aiResponse.suggestedAnswers = [];
    }
  }
  // Chips with dollar/multiple anchors are banned on fishing turns AND on
  // asking-price-expectation questions (agent-invented "$500-700K range"
  // chips anchor the seller exactly like a stated opinion — QA-caught).
  const asksPriceExpectation =
    /asking price|price expectation|price in mind|hoping to (?:get|sell)|ballpark.{0,20}(?:price|mind)|range you(?:'d| would) want/i.test(
      aiResponse.message,
    );
  if (valuationFishing || asksPriceExpectation) {
    aiResponse.suggestedAnswers = aiResponse.suggestedAnswers.filter((chip) => {
      if (!CHIP_FIGURE_RE.test(chip)) return true;
      const num = chip.match(/\d[\d,]*(?:\.\d+)?/)?.[0];
      return num ? sellerMessage.includes(num) : false;
    });
  }

  // FORCED END — the seller has now asked to stop more than once, so ending
  // is no longer model discretion. This is the symmetric mirror of the
  // governance shouldEnd=false override below: turn-guard can veto ends AND
  // (here) force them. Without this, a model that keeps sneaking in "one last
  // thing" leaves the seller trapped in a session only /end can close.
  const forcedEnd = stopNow && stopSignalCount >= 2;
  if (forcedEnd && !aiResponse.shouldEnd) {
    console.warn(
      `[session-manager] Forcing shouldEnd=true after ${stopSignalCount} seller stop signals (model returned shouldEnd=false)`,
    );
    aiResponse.shouldEnd = true;
    aiResponse.endReason = aiResponse.endReason || "Seller asked to stop (repeated stop signals)";
  }

  // Merge extracted fields
  const existingExtracted = (deal.extractedInfo || {}) as Record<string, unknown>;
  let { merged, updatedConfidence, changes } = mergeExtractedFields(
    existingExtracted as Record<string, string>,
    aiResponse.extractedFields,
    confidenceLevels,
  );

  // Apply this turn's deferral deltas to the durable ledger (append-only
  // until resolved — see deferral-ledger.ts).
  let ledger = updateDeferralLedger(
    priorLedger,
    aiResponse.reasoning.newDeferrals,
    aiResponse.reasoning.resolvedDeferrals,
    userTurnCount,
  );

  // Completion governance: the model may only end once the configured turn
  // floor is met and every critical section has at least partial coverage.
  // A seller's explicit request to stop always wins (and a forced end is by
  // definition a seller request — governance is skipped). When an end is
  // blocked, the model is re-called once with an instruction to continue into
  // the most important gap, so the seller sees a natural transition — not a
  // dead stop.
  if (aiResponse.shouldEnd && !forcedEnd) {
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
      // Deferred/declined critical sections count as addressed — blocking an
      // end over a topic the seller set aside orders the model to re-press
      // it, contradicting the decline ban rendered in the same prompt.
      sectionCoverage: prospectiveKb.sectionCoverage.map((s) => ({
        key: s.key,
        status:
          s.status === "missing" && ledgerAddressed(s.key) ? ("partial" as const) : s.status,
      })),
      deferredTopics: deferralTopicStrings(ledger),
      minTurnsBeforeEnd: agentConfig.interview.minTurnsBeforeEnd,
      sellerStopDetected: stopNow || priorStopCount > 0,
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

      // ...and the continuation turn's deferral deltas
      ledger = updateDeferralLedger(
        ledger,
        aiResponse.reasoning.newDeferrals,
        aiResponse.reasoning.resolvedDeferrals,
        userTurnCount,
      );
    }
  }

  // GROUNDING GUARD — mechanical backstop for the prompt-side dodge rules:
  // a high-stakes "confirmed" write whose quantity (or negative claim) does
  // not appear in the seller's actual message is downgraded to approximate
  // and queued on the deferral ledger for a proper circle-back. A fabricated
  // fact can never masquerade as seller-confirmed in the CIM pipeline.
  const groundingFlags = applyGroundingGuard(changes, updatedConfidence, sellerMessage);
  if (groundingFlags.length > 0) {
    console.warn(
      `[session-manager] Grounding guard downgraded ${groundingFlags.length} field(s): ` +
        groundingFlags.map((f) => `${f.fieldName} (${f.reason})`).join("; "),
    );
    ledger = updateDeferralLedger(
      ledger,
      groundingFlags.map((f) => ({
        topic: `verify ${f.fieldName}`,
        reason: `automatic grounding check: ${f.reason}; captured as approximate — confirm with the seller`,
        whereInfoLives: "",
      })),
      [],
      userTurnCount,
    );
  }

  // DOC-CONFLICT GUARD: when a verbal figure materially overwrites a
  // high-stakes value already on file (observed: a $2.3M GMV comment silently
  // replacing the P&L's $1.82M net revenue), keep the new value but open a
  // reconcile deferral so the agent probes the delta (gross vs net, before vs
  // after refunds) instead of the conflict disappearing. Three suppressions
  // (all review-caught): (1) a reconcile already open at turn start or
  // resolved this turn means we're mid-reconciliation — flagging the
  // corrective write would reopen the loop forever; (2) approximate/inferred
  // prior values aren't trustworthy enough to reconcile against (the old
  // number may be a downgraded model guess, not something the seller or a
  // document ever asserted); (3) non-conflicting number shapes are handled
  // inside numbersMateriallyConflict.
  const reconcileSettledTopics = [
    ...openDeferrals(priorLedger).map((d) => d.topic),
    ...aiResponse.reasoning.resolvedDeferrals,
  ];
  const conflictDeferrals = changes
    .filter(
      (c) =>
        HIGH_STAKES_FIELDS.has(c.fieldName) &&
        c.previousValue &&
        c.previousConfidence !== "approximate" &&
        c.previousConfidence !== "inferred" &&
        !reconcileSettledTopics.some((t) => topicsMatch(t, `reconcile ${c.fieldName}`)) &&
        numbersMateriallyConflict(String(c.previousValue), String(c.newValue)),
    )
    .map((c) => ({
      topic: `reconcile ${c.fieldName}`,
      reason: `seller's latest figure (${c.newValue}) differs materially from the value already on record (${c.previousValue}) — confirm which is right and why they differ (e.g. gross vs net, or an intentional update)`,
      whereInfoLives: "",
    }));
  if (conflictDeferrals.length > 0) {
    console.warn(
      `[session-manager] Doc-conflict guard opened ${conflictDeferrals.length} reconcile deferral(s): ` +
        conflictDeferrals.map((d) => d.topic).join(", "),
    );
    ledger = updateDeferralLedger(ledger, conflictDeferrals, [], userTurnCount);
  }

  // NUMERIC-FIDELITY GUARD: a "confirmed" value must not contain numbers the
  // seller never said (observed: "$6,000 to $14,000" stored as "$4,000 to
  // $18,000" confirmed). Mismatches downgrade to approximate + reconcile.
  const fidelityFlags = applyNumericFidelityGuard(changes, updatedConfidence, sellerMessage);
  if (fidelityFlags.length > 0) {
    console.warn(
      `[session-manager] Numeric-fidelity guard downgraded ${fidelityFlags.length} field(s): ` +
        fidelityFlags.map((f) => `${f.fieldName} (${f.reason})`).join("; "),
    );
    ledger = updateDeferralLedger(
      ledger,
      fidelityFlags.map((f) => ({
        topic: `verify ${f.fieldName}`,
        reason: `automatic fidelity check: ${f.reason}; re-confirm the exact figure with the seller`,
        whereInfoLives: "",
      })),
      [],
      userTurnCount,
    );
  }

  // DISCLOSURE-PERSISTENCE GUARD: if the agent told the seller it "noted" or
  // will "flag" something but this turn wrote no fields, no deferrals, no
  // private notes, and no tasks, the disclosure would vanish (observed:
  // flood-damaged inventory verbally "noted", zero trace anywhere). Mint a
  // ledger entry from the seller's own words so the broker always sees it.
  // First-person commitments only — "as you noted earlier" is the agent
  // referring to the SELLER's words, not a promise to record anything.
  const NOTED_LANGUAGE_RE =
    /(?:^|[.!?]\s+)Noted\b|\b(?:duly|that'?s) noted\b|\bI(?:'ve| have)? (?:noted|flagged|made a note|recorded)\b|\bI'?ll (?:note|flag|record|make a note)\b|\bflagg(?:ed|ing) (?:that|this|it) for\b/;
  const disclosureUnwritten =
    NOTED_LANGUAGE_RE.test(aiResponse.message) &&
    Object.keys(aiResponse.extractedFields).length === 0 &&
    changes.length === 0 &&
    aiResponse.reasoning.newDeferrals.length === 0 &&
    (aiResponse.privateNotes ?? []).length === 0 &&
    aiResponse.newTasks.length === 0;
  if (disclosureUnwritten) {
    const topic = aiResponse.reasoning.currentTopic || "seller disclosure";
    // Never let the fallback note resurrect a settled item via fuzzy match —
    // mint only when no ledger entry (open or resolved) covers the topic.
    if (!ledger.some((e) => topicsMatch(e.topic, topic))) {
      console.warn(
        `[session-manager] Disclosure-persistence guard: agent said "noted" with nothing written — ledgering "${topic}"`,
      );
      ledger = updateDeferralLedger(
        ledger,
        [
          {
            topic,
            reason: `agent committed to noting this but captured nothing — review turn ${userTurnCount} of the transcript`,
            whereInfoLives: "",
          },
        ],
        [],
        userTurnCount,
      );
    }
  }

  // Update industry context
  const updatedIndustryContext = updateIndustryContext(
    kb.industryContext,
    aiResponse.reasoning,
    kb.business.location,
  );

  // BROKER-PRIVATE NOTES: sensitive facts land in _brokerPrivateNotes on the
  // deal — visible to the broker, excluded from every CIM-feeding path (the
  // layout engine, financial analysis, and field counters all skip "_" keys).
  if ((aiResponse.privateNotes ?? []).length > 0) {
    const existing = Array.isArray((merged as Record<string, unknown>)._brokerPrivateNotes)
      ? ((merged as Record<string, unknown>)._brokerPrivateNotes as {
          note: string;
          reason: string;
          turn?: number;
        }[])
      : [];
    const fresh = (aiResponse.privateNotes ?? []).filter(
      (n) => !existing.some((e) => e.note === n.note),
    );
    if (fresh.length > 0) {
      (merged as Record<string, unknown>)._brokerPrivateNotes = [
        ...existing,
        ...fresh.map((n) => ({ ...n, turn: userTurnCount })),
      ];
      console.log(
        `[session-manager] Stored ${fresh.length} broker-private note(s) on deal ${dealId}`,
      );
    }
  }

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
        // Open ledger topics — kept for the resume path and the learning
        // loop, which read _deferredTopics; the ledger itself is durable.
        _deferredTopics: deferralTopicStrings(ledger),
        _deferralLedger: ledger,
        _stopSignalCount: stopSignalCount,
        _checkpointStreak: checkpointStreak,
        _degradedTurns: degraded ? priorDegradedTurns + 1 : 0,
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
    // Derived from the durable ledger — stable and append-only until
    // resolved, so the broker-facing panel no longer flickers or loses items.
    deferredTopics: deferralTopicStrings(ledger),
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

// Per-document meta keys the extraction prompt requests (summaries, call
// logistics) — real extractedInfo keys, but not business facts, so they don't
// belong in the "fields captured" headline.
const DOC_META_KEY_RE =
  /^(summary|keyFacts|redFlags|actionItems|keyTopics|sellerConcerns|buyerInterests|followUpNeeded|call[A-Z].*)$|Notes$/;

function countExtractedFields(deal: { extractedInfo: unknown }): { total: number; rawTotal: number } {
  const info = deal.extractedInfo as Record<string, unknown> | null;
  if (!info) return { total: 0, rawTotal: 0 };
  const populated = Object.entries(info).filter(
    ([k, v]) =>
      v !== null && v !== undefined && v !== "" && !k.startsWith("_") && !DOC_META_KEY_RE.test(k),
  );
  // The headline counts every substantive business field. It previously
  // counted only canonical-vocabulary keys, which sat frozen while real
  // industry-specific fields accumulated (observed pinned at 17 while the KB
  // grew to 43); pure junk-key sprawl is prevented upstream by key
  // canonicalisation + merge-time key reuse.
  return {
    total: populated.length,
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
