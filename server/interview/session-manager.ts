import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "crypto";
import { db } from "../db";
import { storage } from "../storage";
import {
  interviewSessions,
  type InterviewSession,
  type ConversationMessage,
} from "@shared/schema";
import { eq, desc } from "drizzle-orm";
import { assembleKnowledgeBase, sellerAnswered, type KnowledgeBase, type IndustryContext, type SectionCoverage } from "./knowledge-base";
import { questionnaireFacts } from "./questionnaire-facts";
import {
  answerHash,
  getQuestionnaireScreen,
  keywordSplit,
  needsScreen,
  screenQuestionnaireAnswers,
  scrubUnscreenedAnswer,
  splitStillValid,
  unscreenedAnswers,
  QUESTIONNAIRE_SCREEN_KEY,
  type QuestionnaireScreen,
} from "./questionnaire-privacy";
import { buildInterviewSystemBlocks } from "./system-prompt";
import type { InterviewResponse } from "./response-schema";
import {
  callInterviewWithRecovery,
  governCompletion,
  detectStopSignal,
  buildStopSignalNudge,
  CRITICAL_SECTIONS,
  VALUATION_FISHING_RE,
  containsValuationFigures,
  CHIP_FIGURE_RE,
  stripFillerPreamble,
  sellerDeclinedWrapUp,
  sellerAskedQuestion,
  leaksInternalMachinery,
  scrubInternalMachinery,
  asksQuestion,
  fallbackQuestion,
  whyItMattersFits,
  finalizeOpeningMessage,
} from "./turn-guard";
import {
  detectRetraction,
  applySellerRetractions,
  restatesWithdrawnValue,
  guessRetractedFields,
  whoHoldsTheAnswer,
  applyDateFidelityGuard,
  applyLegalGroundingGuard,
  findLegalAssertions,
  discrepanciesSettledByRetraction,
  type RetractedValue,
} from "./fact-guards";
import {
  mergeExtractedFields,
  updateIndustryContext,
  canonicalFieldName,
  applyGroundingGuard,
  applyNumericFidelityGuard,
  setFieldSource,
  getFieldSources,
  sourceAllowsOverwrite,
  recordAlternate,
  getSuppressedKeys,
  isSuppressed,
  mergeAlternateMaps,
  sourceRank,
  noteSameValue,
  displaceCorroborations,
  BROKER_SUPPRESSED_KEY,
  addPrivateNote,
  getPrivateNotes,
  privateNoteSources,
  privateNoteSourceKey,
  type FieldSource,
  type SourceKind,
  numbersMateriallyConflict,
  typedNumericValues,
  HIGH_STAKES_FIELDS,
  type FieldChange,
} from "./info-merger";
import { withDealFactsLock } from "../documents/facts-lock";
import { retireDeletedEntry } from "../information/facts";
import { sellerProfileNeedsRebuild, carryBrokerProfileEdits } from "./eq-profiler";
import {
  updateDeferralLedger,
  openDeferrals,
  agentDeferrals,
  declinedDeferrals,
  deferralTopicStrings,
  topicsMatch,
  parseLedger,
  type DeferralEntry,
} from "./deferral-ledger";
import { agentConfig } from "./config/load-config";
import { ensureSectionImportance } from "./section-importance";
import { ensureInterviewPlan } from "./interview-plan";
import { generateSellerProfile } from "./eq-profiler";
import { runInterviewLearningLoop } from "./learning-loop";
import { isDealRowFact } from "../information/deal-mirror";
import { sellerInterviewView, withHeldFacts } from "./seller-view";
import { completionBlockers, type Exchange } from "./completion-gaps";
import {
  applyReaskGuard,
  confirmFindings,
  findReasks,
  reaskCorrection,
  echoesPassage,
  priorQAFromSessions,
  MAX_REWRITES,
  type ReaskContext,
  type ReaskFinding,
} from "./reask-guard";
import { planTaskWrites, COUNSEL_TASK_PREFIX } from "./task-writes";
import { ensureSourceReview } from "./source-review";
import { screenLedgerForSeller } from "./source-privacy";
import { assertsNormalisation, stripNormalisationAssertions, NORMALISATION_CORRECTION } from "./normalisation-guard";
import { questionPart, valuesMateriallyDiffer, sourceLabel } from "./source-context";
import { getFieldAlternates } from "./info-merger";

// =====================
// Types
// =====================

/** A seller message that corrects an earlier answer (the "Edit" flow). */
export type CorrectionOf = NonNullable<ConversationMessage["correctionOf"]>;

/** Validates a client-supplied correctionOf payload; anything malformed is
 *  treated as "not a correction" rather than rejected. */
export function parseCorrectionOf(raw: unknown): CorrectionOf | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const { content, timestamp } = raw as Record<string, unknown>;
  if (typeof content !== "string" || !content.trim()) return undefined;
  return {
    content: content.slice(0, 4000),
    ...(typeof timestamp === "string" ? { timestamp } : {}),
  };
}

/** What the model sees for a seller turn. A correction is framed explicitly so
 *  the agent updates the earlier fact instead of reading the text as a fresh
 *  answer to its latest question. Guards and detectors keep the raw text. */
function modelFacingUserContent(content: string, correctionOf?: CorrectionOf): string {
  if (!correctionOf) return content;
  const prior = correctionOf.content.replace(/\s+/g, " ").trim();
  const quoted = prior.length > 240 ? `${prior.slice(0, 240)}…` : prior;
  return `[Correcting my earlier answer "${quoted}"] ${content}`;
}

export interface TurnResult {
  /** The message to display to the seller */
  message: string;
  /** Buyer-rationale for the question asked — behind "Why we ask this" */
  whyItMatters?: string;
  /** Buyer importance of the question just asked (see section-importance.ts) */
  importance?: "critical" | "important" | "helpful";
  /** CIM section the question is filling */
  targetSection?: string;
  /** Pre-populated answer options the seller can click to respond */
  suggestedAnswers: string[];
  /** The messages exactly as persisted this turn (authoritative timestamps,
   *  rationale, chips). The client adopts these so the live view matches
   *  what a reload restores. `user` is absent on the opening turn. */
  turnMessages?: { user?: ConversationMessage; ai: ConversationMessage };
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
    importance: "critical" | "important" | "helpful";
    importanceReason: string;
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
  /**
   * "completed": the interview is finished and no session was started
   * (opening the page never starts one — the caller asks with resume).
   */
  status?: "completed";
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
export type ConductedBy = "seller" | "broker_with_seller";

/** How a broker-led session is happening — decides the provenance kind of what it captures. */
export type ConductedVia = "person" | "cimple" | "zoom" | "meet" | "teams";
const CONDUCTED_VIAS: readonly ConductedVia[] = ["person", "cimple", "zoom", "meet", "teams"];

/** Validates a client-supplied conductedVia; anything else is "not given". */
export function parseConductedVia(raw: unknown): ConductedVia | undefined {
  return typeof raw === "string" && (CONDUCTED_VIAS as readonly string[]).includes(raw) ? (raw as ConductedVia) : undefined;
}

/**
 * Provenance kind for facts a session captures: the seller typing in the AI
 * interview → "interview"; a broker-led session in person → "call"; over the
 * Cimple call or Zoom / Meet / Teams → "video_call".
 */
export function sessionSourceKind(conductedBy: ConductedBy, via: ConductedVia | undefined): SourceKind {
  if (conductedBy !== "broker_with_seller") return "interview";
  return via && via !== "person" ? "video_call" : "call";
}

/** Deal-level bookkeeping keys the turn's save merges explicitly (never copied wholesale). */
const TURN_SAVE_BOOKKEEPING = new Set([
  "_fieldSources",
  "_fieldAlternates",
  "_fieldCorroborations",
  BROKER_SUPPRESSED_KEY,
  "_brokerDeleted",
  "_brokerPrivateNotes",
]);

const hasFactValue = (v: unknown) => v !== null && v !== undefined && v !== "";

/**
 * Pure: what an interview turn saves. `snapshot` is the deal's facts when the
 * turn started, `merged` the turn's result, `fresh` the deal's facts re-read
 * just before saving (a document, CRM import or broker edit may have landed
 * during the 10–30 s model call). Only keys the turn changed are applied, and
 * each is checked against the FRESH copy:
 * - the broker edited that fact meanwhile (anything outranking the turn's
 *   kind) → the broker's value stays, the seller's statement becomes an
 *   alternate;
 * - the broker deleted it meanwhile → the deletion stands, the statement is
 *   kept as an alternate;
 * - a lower source (a document) wrote it meanwhile → the seller's words win
 *   and that value is kept as an alternate.
 * A fact deleted BEFORE the turn that the seller states again comes back
 * (new information): its suppression lifts and the deleted value becomes an
 * alternate, so it isn't listed as both live and deleted.
 */
export function buildTurnSave(args: {
  snapshot: Record<string, unknown>;
  merged: Record<string, unknown>;
  fresh: Record<string, unknown>;
  /** Fact keys the turn wrote (after the in-turn broker protection). */
  changedFacts: string[];
  turnSrc: FieldSource;
}): Record<string, unknown> {
  const { snapshot, merged, fresh, changedFacts, turnSrc } = args;
  const toSave: Record<string, unknown> = { ...fresh };
  const turnSources = getFieldSources(merged);
  const freshSources = getFieldSources(fresh);
  const snapSources = getFieldSources(snapshot);
  const savedSources: Record<string, FieldSource> = { ...freshSources };
  const freshAlts = (fresh._fieldAlternates as Record<string, unknown> | undefined) || {};
  const turnAlts = (merged._fieldAlternates as Record<string, unknown> | undefined) || {};
  if (Object.keys(freshAlts).length || Object.keys(turnAlts).length) toSave._fieldAlternates = mergeAlternateMaps(freshAlts, turnAlts);

  const freshSuppressed = getSuppressedKeys(fresh);
  const snapSuppressed = getSuppressedKeys(snapshot);
  const lift = new Set<string>();
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

  for (const k of Array.from(new Set([...Object.keys(snapshot), ...Object.keys(merged)]))) {
    if (TURN_SAVE_BOOKKEEPING.has(k)) continue;
    if (same(snapshot[k], merged[k])) continue;
    if (k.startsWith("_")) {
      if (merged[k] === undefined) delete toSave[k]; else toSave[k] = merged[k];
      continue;
    }
    const touchedMeanwhile = !same(fresh[k], snapshot[k]) || !same(freshSources[k], snapSources[k]);
    const freshSrc = freshSources[k];
    const statedSrc = turnSources[k] ?? turnSrc;
    if (merged[k] === undefined) {
      if (!touchedMeanwhile) { delete toSave[k]; delete savedSources[k]; }
      continue;
    }
    if (freshSuppressed.includes(k) && !snapSuppressed.includes(k)) {
      // The broker deleted this fact while the seller was answering.
      recordAlternate(toSave, k, merged[k], statedSrc);
      continue;
    }
    if (touchedMeanwhile && hasFactValue(fresh[k]) && freshSrc && sourceRank(freshSrc.source) > sourceRank(turnSrc.source)) {
      // The broker set this fact during the turn — a broker value is final.
      if (!same(fresh[k], merged[k])) recordAlternate(toSave, k, merged[k], statedSrc);
      continue;
    }
    if (touchedMeanwhile && hasFactValue(fresh[k]) && !same(fresh[k], merged[k]) && freshSrc) {
      // A lower-ranked source wrote it meanwhile: kept as another value.
      recordAlternate(toSave, k, fresh[k], freshSrc);
    }
    toSave[k] = merged[k];
    if (turnSources[k]) savedSources[k] = turnSources[k];
    // Sources that agreed with the replaced value now differ from it.
    displaceCorroborations(toSave, k, merged[k]);
    if (changedFacts.includes(k) && freshSuppressed.includes(k)) lift.add(k);
  }
  toSave._fieldSources = savedSources;

  // Broker-private notes: everything on file now (a source deleted during the
  // turn took its notes with it — never resurrected from the stale
  // snapshot) plus what this turn recorded, added source by source.
  const snapNoteSources = new Set(
    getPrivateNotes(snapshot).flatMap((n) => privateNoteSources(n).map((s) => privateNoteSourceKey(n.note, s))),
  );
  for (const n of getPrivateNotes(merged)) {
    for (const s of privateNoteSources(n)) {
      if (!snapNoteSources.has(privateNoteSourceKey(n.note, s))) addPrivateNote(toSave, n.note, s);
    }
  }

  // A fact the broker deleted comes back only when the seller states it
  // again live — that is new information, and leaving it suppressed would
  // make the interview ask for it forever.
  const stillSuppressed = freshSuppressed.filter((k) => !lift.has(k));
  if (stillSuppressed.length > 0) toSave[BROKER_SUPPRESSED_KEY] = stillSuppressed;
  else delete toSave[BROKER_SUPPRESSED_KEY];
  for (const k of Array.from(lift)) retireDeletedEntry(toSave, k);
  return toSave;
}

/** Where a new session's opening is while the seller waits (streamed to the page by POST /start with stream: true). */
export type StartStage = "reading" | "checking_sources" | "writing";

/**
 * One start per deal at a time: a reload or retry while the opening is
 * still being written waits for that same opening instead of starting a
 * second session (and a second Opus call).
 */
const startsInFlight = new Map<string, Promise<TurnResult>>();

export function startOrResumeSession(
  dealId: string,
  opts: {
    conductedBy?: ConductedBy;
    conductedVia?: ConductedVia;
    /** The caller explicitly asked to continue a finished interview ("Continue interview"). */
    resume?: boolean;
    /** Progress while a new session's opening is prepared (display only). */
    onProgress?: (stage: StartStage) => void;
  } = {},
): Promise<TurnResult> {
  const key = `${dealId}|${opts.resume ? "resume" : "open"}`;
  const running = startsInFlight.get(key);
  if (running) return running;
  const task = startOrResumeSessionOnce(dealId, opts).finally(() => startsInFlight.delete(key));
  startsInFlight.set(key, task);
  return task;
}

async function startOrResumeSessionOnce(
  dealId: string,
  opts: {
    conductedBy?: ConductedBy;
    conductedVia?: ConductedVia;
    resume?: boolean;
    onProgress?: (stage: StartStage) => void;
  },
): Promise<TurnResult> {
  const progress = (stage: StartStage) => {
    try {
      opts.onProgress?.(stage);
    } catch {
      // display only
    }
  };
  // Load the deal and all related data
  let deal = await storage.getDeal(dealId);
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

  // A finished interview is never reopened by merely loading a page: the
  // broker's interview page used to create a fresh session (and an Opus
  // opening call that re-asked known facts) on every visit. Without an
  // explicit resume, report the finished state and create nothing.
  // (An empty session a previous visit left behind is closed.) Checked
  // before any model call — the finished page loads at once (it used to
  // run the questionnaire's privacy split first: 10–12s on first load).
  const lastCompleted = existingSessions.find((s) => s.status === "completed");
  const liveWithAnswers = session && (session.messages as ConversationMessage[]).some((m) => m.role === "user");
  if (!opts.resume && deal.interviewCompleted && lastCompleted && !liveWithAnswers) {
    if (session) {
      await db
        .update(interviewSessions)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(interviewSessions.id, session.id));
    }
    const kb = assembleKnowledgeBase(deal, documents, tasks, lastCompleted, resolvedDiscrepancies);
    const meta = (lastCompleted.extractedInfo as Record<string, unknown>) || {};
    return {
      message: "",
      suggestedAnswers: [],
      sessionId: lastCompleted.id,
      captured: { ...countExtractedFields(deal), newFields: [], updatedFields: [], changes: [] },
      sectionCoverage: kb.sectionCoverage.map(coverageForClient),
      industryContext: extractIndustryContextForFrontend((meta._industryContext as IndustryContext | undefined) ?? null),
      deferredTopics: deferralTopicStrings(screenLedgerForSeller(parseLedger(meta._deferralLedger), documents)),
      shouldEnd: true,
      status: "completed",
    };
  }

  // Seed extractedInfo from the intake questionnaire so answers the seller
  // already typed count toward coverage and are NEVER re-asked. (Intake keys
  // like "reasonForSelling" are canonicalised to schema keys like
  // "reasonForSale" — previously they never matched, so coverage showed the
  // section as missing and the agent asked again.)
  // (Re-read + write under the deal's facts lock, then use the saved copy.)
  // Answers still waiting for their privacy split are seeded (and split) too.
  // It runs alongside the source-review wait below (a new session's opening
  // needs both); resuming a session doesn't wait for it at all.
  const seeding =
    seedExtractedInfoFromQuestionnaire(deal as Parameters<typeof seedExtractedInfoFromQuestionnaire>[0]) ||
    unscreenedAnswers(deal as Parameters<typeof unscreenedAnswers>[0]).length > 0
      ? seedQuestionnaireFacts(dealId).then(
          () => true,
          (err) => {
            console.error(`[session-manager] Seeding intake answers failed for deal ${dealId}:`, err);
            return false;
          },
        )
      : null;

  // Seller Communication Profile: generated when missing, and rebuilt when
  // it was built under older privacy rules or from a row the broker has
  // since made private (its free text could quote the broker's CRM notes or
  // listed price; until the rebuild lands the interview only sees its style
  // fields). Runs in the background — we don't block the opening message on
  // it; the profile is available from the second turn onward.
  if (!deal.sellerProfile || sellerProfileNeedsRebuild(deal.sellerProfile as never, documents)) {
    const prior = (deal.sellerProfile as Record<string, unknown> | null) || null;
    generateSellerProfile(dealId)
      .then(async (profile) => {
        await storage.updateDeal(dealId, { sellerProfile: carryBrokerProfileEdits(profile, prior) } as any);
        console.log(`[session-manager] ${prior ? "Rebuilt" : "Auto-generated"} seller profile for deal ${dealId}`);
      })
      .catch((err) => {
        console.error(`[session-manager] Failed to generate seller profile for deal ${dealId}:`, err);
      });
  }

  // Sources the interview reads: conflicts found by the supporting model are
  // built in the background — usually already done (the broker's Overview
  // starts it). A NEW session's opening waits for it briefly (below), since
  // the opening goes to the most important conflict.
  const sourceReviewRun = ensureSourceReview(deal, documents);
  const openDiscrepancies = (await storage.getDiscrepanciesByDeal(dealId)).filter((d) => d.status === "open");

  // An empty session (no opening saved — a start that never finished) is
  // reused for the new opening instead of adding a second active session.
  let reuseSessionId: string | null = null;
  if (session) {
    const messages = session.messages as ConversationMessage[];
    const userMessageCount = messages.filter((m) => m.role === "user").length;

    // If this is an abandoned session (only the AI opening, no user replies)
    // and the deal already had a prior completed conversation, discard it
    // and create a fresh session with returning-seller context.
    const hasCompletedSession = existingSessions.some((s) => s.status === "completed");
    if (messages.length === 0) {
      reuseSessionId = session.id;
    } else if (userMessageCount === 0 && hasCompletedSession) {
      await db
        .update(interviewSessions)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(interviewSessions.id, session.id));
      session = undefined as any;
    } else {
      // Resume existing session with real conversation history
      const kb = assembleKnowledgeBase(deal, documents, tasks, session, resolvedDiscrepancies, {
        sessions: existingSessions,
        currentSessionId: session.id,
        openDiscrepancies,
      });

      // Restore industry context from session metadata
      const sessionMeta = (session.extractedInfo as Record<string, unknown>) || {};
      if (sessionMeta._industryContext) {
        kb.industryContext = sessionMeta._industryContext as IndustryContext;
      }

      const lastAiMessage = [...messages].reverse().find((m) => m.role === "ai");
      // The question is still pending when the transcript ends on the AI's
      // turn — restore its chips (and rationale) instead of dropping them.
      // `_lastChips` is the fallback for sessions persisted before chips were
      // stored on the message itself.
      const pendingQuestion =
        messages[messages.length - 1]?.role === "ai" ? messages[messages.length - 1] : undefined;
      const pendingChips =
        pendingQuestion?.suggestedAnswers ??
        (Array.isArray(sessionMeta._lastChips) ? (sessionMeta._lastChips as string[]) : []);

      // Deferrals come from the durable ledger; _deferredTopics is the legacy
      // fallback for sessions persisted before the ledger existed.
      const resumeLedger = screenLedgerForSeller(parseLedger(sessionMeta._deferralLedger), documents);
      const resumeDeferred = resumeLedger.length > 0
        ? deferralTopicStrings(resumeLedger)
        : (sessionMeta._deferredTopics as string[]) || [];

      return {
        message: lastAiMessage?.content || "Welcome back. Let's pick up where we left off.",
        whyItMatters: pendingQuestion?.whyItMatters,
        importance: pendingQuestion?.importance,
        targetSection: pendingQuestion?.targetSection,
        suggestedAnswers: pendingChips,
        sessionId: session.id,
        captured: { ...countExtractedFields(deal), newFields: [], updatedFields: [], changes: [] },
        sectionCoverage: kb.sectionCoverage.map(coverageForClient),
        industryContext: extractIndustryContextForFrontend(kb.industryContext),
        deferredTopics: resumeDeferred,
        shouldEnd: false,
      };
    }
  }

  // A new session. Its row is written once the opening exists (below) —
  // never left empty while the opening is prepared (a reload in that window
  // used to find the empty row and start a second session).
  const sessionId = reuseSessionId ?? randomUUID();

  // If there's a completed prior session, pass it so the AI knows this is
  // a returning seller and can welcome them back instead of starting fresh.
  const priorCompletedSession = existingSessions.find((s) => s.status === "completed") || null;

  // The source review still running: give it up to SOURCE_REVIEW_WAIT_MS so
  // the opening can raise a conflict it finds (it keeps running either way,
  // and later turns pick it up). The intake answers are seeded meanwhile.
  const reviewWait = sourceReviewRun
    ? Promise.race([
        sourceReviewRun.catch(() => null),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), SOURCE_REVIEW_WAIT_MS)),
      ])
    : null;
  if (seeding) {
    progress("reading");
    if (await seeding) deal = (await storage.getDeal(dealId)) ?? deal;
  }
  if (reviewWait) {
    progress("checking_sources");
    const review = await reviewWait;
    if (review) deal = { ...deal, interviewSourceReview: review } as typeof deal;
  }
  progress("writing");

  // Assemble knowledge base for the opening message — with every earlier
  // session's questions and answers, so a returning seller is never asked
  // them again.
  const kb = assembleKnowledgeBase(deal, documents, tasks, priorCompletedSession, resolvedDiscrepancies, {
    sessions: existingSessions,
    currentSessionId: sessionId,
    openDiscrepancies,
  });

  // Confidence map, ledger, conduct mode and industry from the most recent
  // prior session (if any) — confirmed fields stay confirmed across sessions.
  const priorMeta = existingSessions.find((s) => s.id !== sessionId)?.extractedInfo as
    | Record<string, unknown>
    | null
    | undefined;
  const priorConfidenceLevels =
    (priorMeta?._confidenceLevels as Record<string, string> | undefined) ?? {};

  // The prior session's ledger (carried over — see below) and the items the
  // sources put on the agenda (conflicts, flagged risks), so the opening can
  // go straight to the most important open item. (Re-checked against the
  // current sources: nothing minted from a source since made broker-only.)
  const carriedMeta = (priorCompletedSession?.extractedInfo as Record<string, unknown> | null | undefined) ?? null;
  const openingLedger = mintSourceItems(
    screenLedgerForSeller(parseLedger(carriedMeta?._deferralLedger), documents).map((e) => ({ ...e, earlierSession: true })),
    kb,
    0,
  );
  applyLedgerToKb(kb, openingLedger);
  kb.wrapUpBlockers = completionBlockers({
    sectionCoverage: kb.sectionCoverage,
    criticalSections: criticalSectionSet(kb),
    info: kb.extractedInfo as Record<string, unknown>,
    ledger: openingLedger,
    exchanges: (kb.priorExchanges ?? []).map((x) => ({ question: x.question, answer: x.answer })),
    conflicts: kb.sourceConflicts,
    risks: kb.flaggedRisks,
  });

  // Generate the opening message
  const openingResult = await generateOpeningMessage(kb, deal.businessName, {
    sellerMessage: "",
    info: kb.extractedInfo as Record<string, unknown>,
    documents,
    priorQA: priorQAFromSessions(existingSessions, sessionId),
    openDeferralTopics: [],
    conflictKeys: (kb.sourceConflicts ?? []).map((c) => c.key),
  });

  // Save the opening message to the session
  const aiMessage: ConversationMessage = {
    role: "ai",
    content: openingResult.message,
    timestamp: new Date().toISOString(),
    ...(openingResult.whyItMatters ? { whyItMatters: openingResult.whyItMatters } : {}),
    ...questionLabels(kb, openingResult.importance, openingResult.targetSection),
    suggestedAnswers: openingResult.suggestedAnswers || [],
  };

  // Carry the deferral ledger across sessions — a seller who does the
  // interview in two sittings must not lose their open deferrals (observed:
  // the ledger silently reset to [] on resume, so the broker's outstanding
  // items vanished and circle-backs never happened).
  // (Entries keep their turn numbers from that sitting — marked as from an
  // earlier session so the agent never calls them "earlier in this interview".)
  let seededLedger: DeferralEntry[] = mintSourceItems(
    screenLedgerForSeller(parseLedger(priorMeta?._deferralLedger), documents).map((e) => ({ ...e, earlierSession: true })),
    kb,
    0,
  );

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

  const sessionState = {
    messages: [aiMessage],
    questionsAsked: 1,
    lastActivityAt: new Date(),
    extractedInfo: {
      _conductedBy: opts.conductedBy ?? (priorMeta?._conductedBy as ConductedBy | undefined) ?? "seller",
      ...(opts.conductedVia ? { _conductedVia: opts.conductedVia } : {}),
      _industryContext: seededIndustryContext,
      _deferredTopics: deferralTopicStrings(seededLedger),
      _deferralLedger: seededLedger,
      _stopSignalCount: 0,
      // Carry seller confirmations forward from any prior session — a
      // fresh map would demote confirmed fields to "inferred" and make
      // the agent re-verify answers the seller already gave.
      _confidenceLevels: priorConfidenceLevels,
    },
  };
  if (reuseSessionId) {
    await db.update(interviewSessions).set(sessionState).where(eq(interviewSessions.id, sessionId));
  } else {
    // Another server process may have opened a session meanwhile — resume
    // that one rather than add a second active session.
    const raced = (await db.select().from(interviewSessions).where(eq(interviewSessions.dealId, dealId))).find(
      (s) => (s.status === "active" || s.status === "paused") && !existingSessions.some((e) => e.id === s.id),
    );
    if (raced) return startOrResumeSessionOnce(dealId, { ...opts, onProgress: undefined });
    await db.insert(interviewSessions).values({
      id: sessionId,
      dealId,
      participantId: deal.sellerId || deal.brokerId,
      status: "active",
      questionsAnswered: 0,
      questionsSkipped: 0,
      ...sessionState,
    });
  }

  // If the AI identified industry context in the opening, update the KB
  if (seededIndustryContext) {
    kb.industryContext = seededIndustryContext;
  }
  // Rank section importance for this industry in the background (no-op when
  // the deal already has a ranking for its industry).
  ensureSectionImportance(deal, importanceContext(seededIndustryContext));
  ensureInterviewPlan(deal, { subIndustry: seededIndustryContext?.subIndustry ?? null });

  return {
    message: openingResult.message,
    whyItMatters: openingResult.whyItMatters,
    importance: aiMessage.importance,
    targetSection: aiMessage.targetSection,
    suggestedAnswers: openingResult.suggestedAnswers,
    turnMessages: { ai: aiMessage },
    sessionId,
    captured: { ...countExtractedFields(deal), newFields: [], updatedFields: [], changes: [] },
    sectionCoverage: kb.sectionCoverage.map(coverageForClient),
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
  opts: {
    /** Set when the seller is correcting an earlier answer via "Edit". */
    correctionOf?: CorrectionOf;
    /** Broker-led ("Interview together"): the broker reads questions aloud and
     *  the seller's spoken answers are captured. Changes phrasing rules. */
    conductedBy?: ConductedBy;
    /** How a broker-led session is happening (in person / Cimple call / Zoom…). */
    conductedVia?: ConductedVia;
  } = {},
): Promise<TurnResult> {
  // The seller's message is timestamped when it arrives, not when the AI
  // finishes replying — otherwise a reload shifts every answer later by the
  // model's thinking time.
  const receivedAt = new Date().toISOString();
  const { correctionOf } = opts;

  // Load everything
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  const session = await getSession(sessionId);
  if (!session) throw new Error(`Session ${sessionId} not found`);

  const documents = await storage.getDocumentsByDeal(dealId);
  const tasks = await storage.getTasksByDeal(dealId);
  const resolvedDiscrepancies = await storage.getResolvedDiscrepancies(dealId);
  const openDiscrepancies = (await storage.getDiscrepanciesByDeal(dealId)).filter((d) => d.status === "open");
  const dealSessions = await db.select().from(interviewSessions).where(eq(interviewSessions.dealId, dealId));
  const kbExtras = { sessions: dealSessions, currentSessionId: sessionId, openDiscrepancies };
  // A source added mid-interview gets its conflicts reviewed for later turns.
  ensureSourceReview(deal, documents);

  // Build the knowledge base
  const kb = assembleKnowledgeBase(deal, documents, tasks, session, resolvedDiscrepancies, kbExtras);

  // Restore persisted state from session metadata
  const sessionMeta = (session.extractedInfo as Record<string, unknown>) || {};
  if (sessionMeta._industryContext) {
    kb.industryContext = sessionMeta._industryContext as IndustryContext;
  }
  // The caller's mode wins over what the session was started with — a broker
  // can pick up a seller-started session and run the rest together.
  const conductedBy: ConductedBy = opts.conductedBy ?? (sessionMeta._conductedBy as ConductedBy | undefined) ?? "seller";
  kb.conductedBy = conductedBy;
  const conductedVia: ConductedVia | undefined = opts.conductedVia ?? parseConductedVia(sessionMeta._conductedVia);
  const confidenceLevels = (sessionMeta._confidenceLevels as Record<string, string>) || {};

  // Durable deferral ledger + stop-signal counter (see deferral-ledger.ts and
  // turn-guard.detectStopSignal). Legacy sessions without a ledger start empty.
  // Conflicts and flagged risks the sources raise join the ledger (as
  // "source" items) the first time they appear, so the agent can resolve
  // them and governance can tell what is still open.
  // (Re-checked against the current sources first: an item minted while a
  // source was shared must not keep quoting it once it is broker-only.)
  const priorLedger: DeferralEntry[] = mintSourceItems(
    screenLedgerForSeller(parseLedger(sessionMeta._deferralLedger), documents),
    kb,
    (session.messages as ConversationMessage[]).filter((m) => m.role === "user").length,
  );
  applyLedgerToKb(kb, priorLedger);
  kb.droppedDocRequests = Array.isArray(sessionMeta._droppedDocRequests) ? (sessionMeta._droppedDocRequests as string[]).slice(-8) : [];
  const priorStopCount =
    typeof sessionMeta._stopSignalCount === "number" ? sessionMeta._stopSignalCount : 0;
  const priorCheckpointStreak =
    typeof sessionMeta._checkpointStreak === "number" ? sessionMeta._checkpointStreak : 0;
  const priorDegradedTurns =
    typeof sessionMeta._degradedTurns === "number" ? sessionMeta._degradedTurns : 0;
  // Values the seller withdrew earlier in this session (see fact-guards.ts) —
  // they must never be recorded again from the conversation history.
  const priorRetracted: RetractedValue[] = Array.isArray(sessionMeta._retracted)
    ? (sessionMeta._retracted as RetractedValue[]).filter((r) => r && typeof r.key === "string" && typeof r.value === "string")
    : [];

  // Render the agent's own outstanding deferrals into the dynamic prompt block
  // so it can circle back — the model's context alone forgets them.
  kb.openDeferrals = openDeferrals(priorLedger).map((d) => ({
    topic: d.topic,
    reason: d.reason,
    whereInfoLives: d.whereInfoLives,
    createdAtTurn: d.createdAtTurn,
    ...(d.declined ? { declined: true } : {}),
    ...(d.earlierSession ? { earlierSession: true } : {}),
  }));

  // Build the conversation history for the API
  const existingMessages = session.messages as ConversationMessage[];
  const apiMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

  for (const msg of existingMessages) {
    apiMessages.push({
      role: msg.role === "ai" ? "assistant" : "user",
      content: msg.role === "user" ? modelFacingUserContent(msg.content, msg.correctionOf) : msg.content,
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
  apiMessages.push({ role: "user", content: modelFacingUserContent(sellerMessage, correctionOf) });

  // Every question → answer so far: earlier sessions, this transcript, and
  // this turn (the question just answered). Feeds the wrap-up checklist and
  // the re-ask guard.
  const thisSessionQA = exchangesOf([...existingMessages, { role: "user", content: sellerMessage, timestamp: receivedAt }]);
  const allExchanges: Exchange[] = [
    ...(kb.priorExchanges ?? []).map((x) => ({ question: x.question, answer: x.answer })),
    ...thisSessionQA,
  ];
  kb.wrapUpBlockers = completionBlockers({
    sectionCoverage: kb.sectionCoverage,
    criticalSections: criticalSectionSet(kb),
    info: kb.extractedInfo as Record<string, unknown>,
    ledger: priorLedger,
    exchanges: allExchanges,
    conflicts: kb.sourceConflicts,
    risks: kb.flaggedRisks,
  });

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
  // (Only real deferrals: an item the server put on the agenda from the
  // sources — a flagged risk mentioning revenue — was never discussed.)
  const ledgerAddressed = (sectionKey: string): boolean => sectionDeferred(sectionKey, priorLedger);
  const missingCritical = kb.sectionCoverage
    .filter((s) => (CRITICAL_SECTIONS.has(s.key) || s.importance === "critical") && s.status === "missing" && !ledgerAddressed(s.key))
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
      // The one closing question (if any) goes to the most critical gap: a
      // missing critical section, else the top open wrap-up item.
      text: buildStopSignalNudge(
        stopSignalCount,
        missingCritical.length > 0 ? missingCritical : (kb.wrapUpBlockers ?? []).slice(0, 3),
        declinedTopics,
      ),
    });
  }

  // Financial-core checkpoint: by mid-session the interview must have secured
  // (or explicitly deferred) revenue and asking-price expectations. Rapport
  // sequencing is fine early; sessions that end with zero financial core are
  // not. Skipped while a stop signal is active — the stop nudge already
  // triages to the same critical gaps.
  const missingBits = financialCoreGaps(kb.extractedInfo as Record<string, unknown>, priorLedger);
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
      : (kb.wrapUpBlockers ?? []).length > 0
        ? ` Before you can wrap up: ${kb.wrapUpBlockers!.slice(0, 4).join("; ")} — remaining questions go there first.`
        : "";
    systemBlocks.push({
      type: "text",
      text: `# PACING\nThis conversation has run ${userTurnCount} seller turns. Respect the seller's time: focus only on remaining [CRITICAL] gaps, convert everything else into broker follow-up tasks, and move toward a natural wrap-up.${triage}`,
    });
  }

  // A figure the seller gave LAST turn that contradicts a document on file
  // (the doc-conflict guard put it on the ledger): this turn reconciles it.
  // On the streamed path the reply to that turn was already on screen when
  // the conflict was detected, so this is where it gets raised.
  const freshReconciles = agentDeferrals(priorLedger).filter(
    (e) => /^reconcile\s/i.test(e.topic) && !e.earlierSession && e.createdAtTurn === userTurnCount - 1,
  );
  if (freshReconciles.length > 0 && !stopNow) {
    systemBlocks.push({
      type: "text",
      text:
        `# RECONCILE NOW\n` +
        `Last turn the seller gave a figure that differs from what is on file — ${freshReconciles.map((e) => `${e.topic.replace(/^reconcile\s+/i, "")}: ${e.reason}`).join("; ")}. ` +
        `Unless the seller just asked you something, your question this turn reconciles it: name both figures neutrally, attribute each only to its real source (never "your documents show" for a figure the seller said), and ask which is right and what explains the difference. When it's settled, list "reconcile <key>" in reasoning.resolvedDeferrals.`,
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

  // Statements the seller withdrew earlier this session are still in the
  // transcript — name them so the agent neither records nor repeats them.
  if (priorRetracted.length > 0) {
    systemBlocks.push({
      type: "text",
      text:
        `# WITHDRAWN BY THE SELLER\n` +
        `The seller took these back earlier in this conversation. They are NOT facts: never record them again, never repeat them back, and don't ask the seller to re-guess — the real answer comes from the person or document they named.\n` +
        priorRetracted.map((r) => `- ${r.key}: "${r.value.slice(0, 160)}" (withdrawn at turn ${r.turn})`).join("\n"),
    });
  }

  const callParams = {
    model: INTERVIEW_MODEL,
    maxTokens: agentConfig.api.maxTokens,
    temperature: agentConfig.api.temperature,
    system: systemBlocks,
    messages: apiMessages,
  };

  // RE-ASK GUARD context: every earlier question the seller answered (all
  // sessions, in full, plus this transcript), the facts on file as the agent
  // sees them, and the seller-visible sources.
  const existingExtracted = (deal.extractedInfo || {}) as Record<string, unknown>;
  const sellerView = sellerInterviewView(existingExtracted, documents);
  const reaskCtx: ReaskContext = {
    sellerMessage,
    // (A fact the broker settled is on file even where its value is held.)
    info: withHeldFacts(sellerView as Record<string, unknown>),
    documents,
    priorQA: [
      ...priorQAFromSessions(dealSessions, sessionId),
      ...thisSessionQA.map((x) => ({ ...x, where: "earlier in this session" })),
    ],
    openDeferralTopics: agentDeferrals(priorLedger).map((d) => d.topic),
    conflictKeys: (kb.sourceConflicts ?? []).map((c) => c.key),
  };

  // VALUATION-FIGURE GUARD: on fishing turns ("what's it worth", "what
  // multiple", "how much tax-free"), scan the outgoing reply — if it leaked a
  // multiple, price range, or tax figure, force ONE corrective re-call.
  // First-ask deflections behave; the leak happens on callback pressure.
  const valuationFishing = VALUATION_FISHING_RE.test(sellerMessage);
  // Belt-and-suspenders on fishing turns: ANY currency figure ≥ $10K in the
  // reply that neither the seller just said nor the file already holds is a
  // leak — this catches figures the pattern list can't anticipate. (Only
  // the file as the interview sees it: the broker's listed price from the
  // deal row and figures from broker-only sources are not on the seller's
  // file, so quoting one to the seller counts as a leak too.)
  const sanctionedText =
    sellerMessage +
    " " +
    Object.entries(sellerView)
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
  // A seller withdrawing something this turn ("take those numbers back") —
  // the retraction backstop below may rewrite the reply.
  const retractionInMessage = detectRetraction(sellerMessage);

  // Call Claude Opus — recovery-wrapped, so a malformed or truncated response
  // retries once and then degrades gracefully instead of dead-ending the seller.
  // Streaming: the message is checked the moment it is complete, BEFORE the
  // seller sees it and before the rest of the response is generated — a
  // question that re-asks something on file is stopped there and rewritten
  // (the seller never watches a re-asked question appear and get replaced,
  // and the rewrite doesn't wait for the discarded draft to finish). A
  // message with no question (a goodbye, an answer) is held until the turn
  // is final, so a governance override never swaps it on screen either.
  // The parsed result stays authoritative (governance/merge/persist below).
  const shown = createMessageRelease(onDelta);
  let reaskAttempt = 0;
  let pendingFindings: ReaskFinding[] = [];
  const earlyFindings: ReaskFinding[] = [];
  const checkMessage = async (text: string): Promise<boolean> => {
    if (stopNow || !/\?/.test(text)) return true; // shown when the turn is final
    // A draft a later guard will rewrite is held too (shown, fixed, when the
    // turn is final) — never released and then swapped on screen: a
    // valuation leak, the agent's machinery or a legal claim stated as fact
    // (see OUTPUT GUARDS), or a turn where the seller withdrew something.
    if (heldForLaterGuards(text, { retractionInMessage, valuationLeak: valuationFishing && valuationLeak(text) })) return true;
    let found = findReasks(text, reaskCtx);
    // After a rewrite only the sure findings count (a word-overlap candidate
    // never forces a second rewrite); on the first draft a candidate stops
    // the question only once the supporting model confirms it is answered.
    // (The seller is waiting on this check: past STREAM_CHECK_TIMEOUT_MS the
    // question goes out — the prompt's own rules still apply.)
    found = reaskAttempt > 0 ? found.filter((f) => !f.verify) : await confirmFindings(found, text, undefined, STREAM_CHECK_TIMEOUT_MS);
    // …plus a rewrite that parrots a quoted passage in the seller's or a
    // transcript's voice.
    const echoed = earlyFindings.find((f) => f.quote && echoesPassage(text, f.quote));
    if (echoed) found.push({ kind: "echo", detail: `«${echoed.quote!.slice(0, 160)}»` });
    if (found.length > 0 && reaskAttempt < MAX_REWRITES) {
      pendingFindings = found;
      return false;
    }
    shown.release(stripFillerPreamble(text, { sellerMessage }));
    return true;
  };
  let conversation = [...apiMessages];
  let first = await callInterviewWithRecovery(anthropic, callParams, shown.streaming, shown.streaming ? checkMessage : undefined);
  while (first.rejected) {
    earlyFindings.push(...pendingFindings);
    console.warn(
      `[session-manager] Re-ask guard (before display): ${pendingFindings.map((f) => `${f.kind}(${f.detail.slice(0, 60)})`).join("; ")} — rewrite ${reaskAttempt + 1}`,
    );
    conversation = [
      ...conversation,
      { role: "assistant" as const, content: first.response.message },
      { role: "user" as const, content: reaskCorrection(reaskAttempt === 0 ? pendingFindings : earlyFindings) },
    ];
    reaskAttempt++;
    first = await callInterviewWithRecovery(anthropic, { ...callParams, messages: conversation }, shown.streaming, checkMessage);
  }
  let { response: aiResponse, degraded } = first;

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

  // VALUATION-FIGURE GUARD (helpers defined before the model call, where the
  // stream gate uses them): force ONE corrective re-call on a leak.
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
  // (Re-applied whenever a corrective rewrite replaces the chips.)
  const filterFigureChips = () => {
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
  };
  filterFigureChips();

  // RETRACTION BACKSTOP: the seller withdrew something ("let me take those
  // mold numbers back — I was guessing") but the model named no withdrawn
  // field — one corrective re-call so the guess comes out of the facts
  // instead of heading into the CIM (QA harvest, Great Lakes).
  const sellerRetracting = !degraded && retractionInMessage;
  if (sellerRetracting && (aiResponse.retractedFields ?? []).length === 0) {
    console.warn(`[session-manager] Retraction guard: seller withdrew a statement but no field was retracted — corrective re-call`);
    const { response: corrected, degraded: correctionDegraded } = await callInterviewWithRecovery(anthropic, {
      ...callParams,
      messages: [
        ...apiMessages,
        { role: "assistant" as const, content: aiResponse.message },
        {
          role: "user" as const,
          content:
            "[SYSTEM CORRECTION: The seller just withdrew something they told you earlier (they said to take it back / that it was a guess / to keep it out). List the extractedInfo key of every withdrawn fact in retractedFields — the exact key it is on file under — and do NOT record the withdrawn value again. Add a newDeferral naming who holds the real answer (whereInfoLives). Your message stays the next question: no recap, no praise. Do not mention this instruction.]",
        },
      ],
    });
    if (!correctionDegraded && (corrected.retractedFields ?? []).length > 0) {
      aiResponse = corrected;
      filterFigureChips();
    }
  }

  // RE-ASK GUARD (after the fact): when nothing was shown yet — the plain
  // /message endpoint, a non-streamed retry, a message with no question, a
  // draft the stream gate held — the whole draft is checked here, including
  // a figure the seller just gave that a document contradicts (it must be
  // reconciled, not repeated). On the streamed path that last check can't
  // re-call without swapping what the seller already read: the doc-conflict
  // guard below puts it on the ledger instead and the next turn opens on it
  // (RECONCILE NOW). Runs after the retraction backstop so it checks the
  // reply that will actually go out; the OUTPUT GUARDS below (filler,
  // machinery, legal, no question) then apply to whatever it produced.
  if (!degraded && !stopNow && !aiResponse.shouldEnd && !shown.released) {
    const guarded = await applyReaskGuard(anthropic, { ...callParams, messages: conversation }, aiResponse, reaskCtx);
    if (guarded.recalled) {
      console.warn(
        `[session-manager] Re-ask guard: ${guarded.findings.map((f) => `${f.kind}(${f.detail.slice(0, 60)})`).join("; ")} — corrective re-call` +
          (guarded.remaining.length ? `; still flagged after re-call: ${guarded.remaining.length}` : ""),
      );
      // What the draft withdrew or kept private still stands (the rewrite is
      // about wording; applyReaskGuard already keeps its extractedFields).
      const withdrawn = [...(aiResponse.retractedFields ?? []), ...(guarded.response.retractedFields ?? [])];
      guarded.response.retractedFields = withdrawn.filter((r, i) => withdrawn.findIndex((x) => x.field === r.field) === i);
      guarded.response.privateNotes = [...(aiResponse.privateNotes ?? []), ...(guarded.response.privateNotes ?? [])];
      aiResponse = guarded.response;
      filterFigureChips();
    }
  }

  // NORMALISATION GUARD (normalisation-guard.ts): the reply never tells the
  // seller what is added back or what SDE / adjusted earnings come to — the
  // broker's call, and the broker's private working. Held on the stream (see
  // heldForLaterGuards); ONE corrective re-call, then the asserting
  // sentences give way to the hand-off.
  if (!degraded && assertsNormalisation(aiResponse.message)) {
    console.warn(`[session-manager] Normalisation guard: reply asserts add-back treatment or a normalised figure — corrective re-call`);
    const { response: corrected, degraded: correctionDegraded } = await callInterviewWithRecovery(anthropic, {
      ...callParams,
      messages: [
        ...conversation,
        { role: "assistant" as const, content: aiResponse.message },
        { role: "user" as const, content: NORMALISATION_CORRECTION },
      ],
    });
    if (!correctionDegraded && corrected.message && !assertsNormalisation(corrected.message)) {
      // The rewrite is about wording: what the draft recorded, withdrew or
      // kept private still stands.
      if (Object.keys(corrected.extractedFields ?? {}).length === 0) corrected.extractedFields = aiResponse.extractedFields;
      corrected.retractedFields = aiResponse.retractedFields;
      corrected.privateNotes = [...(aiResponse.privateNotes ?? []), ...(corrected.privateNotes ?? [])];
      aiResponse = corrected;
      filterFigureChips();
    } else {
      console.error(`[session-manager] Normalisation guard: re-call still asserted — handing off`);
      aiResponse.message = stripNormalisationAssertions(aiResponse.message);
    }
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
  // A forced goodbye asks nothing — a question the model slipped in would be
  // left hanging on an ended interview.
  if (forcedEnd && asksQuestion(aiResponse.message)) {
    const kept = aiResponse.message.split(/(?<=[.!?])\s+/).filter((s) => !s.includes("?")).join(" ").trim();
    aiResponse.message = kept.length >= 12 ? kept : "Thanks for your time — everything you've shared is saved, and you can pick this up whenever suits you.";
    if (!/\bsaved\b/i.test(aiResponse.message)) aiResponse.message += " Everything you've shared is saved, and you can pick this up whenever suits you.";
    aiResponse.suggestedAnswers = [];
  }

  // Merge extracted fields — against the facts exactly as the agent was
  // shown them (sellerInterviewView), so "already on file" and "a change"
  // mean the same thing to the model and to the guards below. Merging
  // against the raw facts made the model's repeat of the seller's own price
  // (shown in place of the broker's hidden deal-row price) count as a
  // change, which the grounding guard then turned into a "verify" re-ask.
  // The turn's changes are applied to the deal's REAL facts afterwards
  // (applyTurn), where the provenance rules below decide what is kept.
  let { merged: viewMerged, updatedConfidence, changes } = mergeExtractedFields(
    sellerView as Record<string, string>,
    aiResponse.extractedFields,
    confidenceLevels,
  );
  /** The deal's real facts with this turn's changes applied (last write wins). */
  const applyTurn = (): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...existingExtracted };
    for (const c of changes) out[c.fieldName] = c.newValue;
    return out;
  };

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
    // A seller answer to a field that holds the broker's deal-row price is
    // kept beside it (see the provenance block below) — count it here too.
    // A seller answer replacing a broker-only source's value becomes the
    // seller's own (as the provenance block below records it), so the
    // interview's view counts it.
    const prospectiveInfo: Record<string, unknown> = applyTurn();
    const priorSourcesNow = getFieldSources(existingExtracted);
    for (const c of changes) {
      if (isDealRowFact(existingExtracted, c.fieldName)) {
        recordAlternate(prospectiveInfo, c.fieldName, c.newValue, { source: "interview", at: new Date().toISOString() });
      } else if (priorSourcesNow[c.fieldName]?.source !== "broker") {
        setFieldSource(prospectiveInfo, c.fieldName, { source: "interview", at: new Date().toISOString() });
      }
    }
    const prospectiveKb = assembleKnowledgeBase(
      { ...deal, extractedInfo: prospectiveInfo } as typeof deal,
      documents,
      tasks,
      session,
      resolvedDiscrepancies,
      kbExtras,
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
      // Only a stop THIS turn — or the answer to the one closing question a
      // stop on the previous turn allowed — permits an early end. A seller
      // who then says they'd rather keep going ("let's continue", "I've got
      // a few more minutes") has withdrawn it; an older stop never counts
      // (QA harvest: Clearwater ended at 6 of 10 turns on a stale one).
      sellerStopDetected: stopNow || (priorStopCount > 0 && !sellerDeclinedWrapUp(prevAiMessage, sellerMessage)),
      // Critical checklist items, seller-only topics, critical conflicts and
      // flagged risks not yet discussed or deferred. (A very long interview
      // is no longer held open for them — the seller's patience wins.)
      blockingItems: userTurnCount < MAX_TURNS_HELD_OPEN
        ? completionBlockers({
            sectionCoverage: prospectiveKb.sectionCoverage,
            criticalSections: criticalSectionSet(prospectiveKb),
            info: prospectiveKb.extractedInfo as Record<string, unknown>,
            ledger,
            exchanges: allExchanges,
            conflicts: kb.sourceConflicts,
            risks: kb.flaggedRisks,
            // A deferral or "resolved" the agent records in this very turn
            // counts only if this turn's exchange was about it — parking
            // every open item in the goodbye message is not covering it.
            now: { turn: userTurnCount, lastQuestion: prevAiMessage ? questionPart(prevAiMessage) : undefined, sellerMessage },
          })
        : [],
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
      // What the first reply withdrew or kept private still stands.
      continued.retractedFields = [...(aiResponse.retractedFields ?? []), ...(continued.retractedFields ?? [])];
      continued.privateNotes = [...(aiResponse.privateNotes ?? []), ...(continued.privateNotes ?? [])];
      aiResponse = continued;

      // Fold in anything the continuation turn extracted
      const remerge = mergeExtractedFields(viewMerged, aiResponse.extractedFields, updatedConfidence);
      viewMerged = remerge.merged;
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

  // ── OUTPUT GUARDS — run after governance, so a continuation reply is held
  // to the same rules as the first one. ──
  if (!degraded) {
    // FILLER GUARD: sellers read dozens of replies in a sitting — a recap or
    // grade of their last answer ("That's a realistic read —", "Good — a
    // clean Phase I removes a major due diligence risk for buyers.") in front
    // of every question is exhausting and nobody talks that way. The prompt
    // forbids it; this strips it mechanically, leaving the question.
    // Clarifications, reconciliations, empathy, privacy promises and document
    // requests are kept (see stripFillerPreamble). When the seller asked
    // something, the opening may be the answer and is never stripped. A
    // goodbye keeps its recap and loses its praise.
    const applyFiller = (msg: string) => stripFillerPreamble(msg, { sellerMessage, closing: aiResponse.shouldEnd });
    const stripped = applyFiller(aiResponse.message);
    if (stripped !== aiResponse.message) {
      console.log(
        `[session-manager] Filler guard trimmed a recap/praise sentence on session ${sessionId}: "${aiResponse.message.trim().slice(0, 160)}" → "${stripped.slice(0, 80)}…"`,
      );
      aiResponse.message = stripped;
    }

    // Three more things a reply must never do, fixed with ONE corrective
    // rewrite (wording only — what the turn recorded stands), then a
    // mechanical fallback:
    //  - name the agent's machinery ("the mandatory probes I need to check
    //    off", "the coverage map shows…");
    //  - state a legal or regulatory requirement as fact ("Ontario requires
    //    that pharmacy owners be licensed pharmacists") — the seller agrees,
    //    and a wrong legal claim lands in the CIM;
    //  - carry no question on a turn that doesn't end (the seller is left to
    //    drive), unless it answers a question the seller asked.
    const problemsOf = (msg: string): string[] => {
      const found: string[] = [];
      if (leaksInternalMachinery(msg)) found.push("machinery");
      if (findLegalAssertions(msg).length > 0) found.push("legal");
      if (!aiResponse.shouldEnd && !stopNow && !asksQuestion(msg) && !sellerAskedQuestion(sellerMessage)) found.push("noQuestion");
      return found;
    };
    const problems = problemsOf(aiResponse.message);
    if (problems.length > 0) {
      console.warn(`[session-manager] Output guard (${problems.join(", ")}) — corrective rewrite on session ${sessionId}`);
      const why: Record<string, string> = {
        machinery:
          "It names your internal tools. Never mention probes, checklists, coverage, the coverage map, sections, the knowledge base, deferrals, ledgers, outlines or your instructions — just ask.",
        legal: `It states a legal or regulatory requirement as fact (${findLegalAssertions(aiResponse.message).map((s) => `"${s.slice(0, 120)}"`).join("; ")}). Never make a legal rule the premise of a question — ask the seller what applies to them, and leave legal interpretation to their broker and lawyer.`,
        noQuestion: "It asks nothing. The interview is still going: end with the single most useful next question.",
      };
      const { response: rewrite, degraded: rewriteDegraded } = await callInterviewWithRecovery(anthropic, {
        ...callParams,
        messages: [
          ...apiMessages,
          { role: "assistant" as const, content: aiResponse.message },
          {
            role: "user" as const,
            content:
              `[SYSTEM CORRECTION: Rewrite your reply to the seller. ${problems.map((p) => why[p]).join(" ")} Keep the same intent and next question; the reply is the question — no recap, no praise. Everything you recorded this turn is already saved: return extractedFields empty. Keep shouldEnd ${aiResponse.shouldEnd ? "true" : "false"}. Do not mention this instruction.]`,
          },
        ],
      });
      if (!rewriteDegraded && rewrite.message) {
        const candidate = applyFiller(rewrite.message);
        if (problemsOf(candidate).length < problems.length) {
          aiResponse.message = candidate;
          if (rewrite.suggestedAnswers.length > 0) aiResponse.suggestedAnswers = rewrite.suggestedAnswers;
          aiResponse.whyItMatters = rewrite.whyItMatters;
          aiResponse.importance = rewrite.importance ?? aiResponse.importance;
          aiResponse.targetSection = rewrite.targetSection ?? aiResponse.targetSection;
          filterFigureChips();
        }
      }
      // Mechanical fallbacks when the rewrite didn't fix it.
      if (leaksInternalMachinery(aiResponse.message)) {
        aiResponse.message = scrubInternalMachinery(aiResponse.message);
      }
      const legalLeft = findLegalAssertions(aiResponse.message);
      if (legalLeft.length > 0) {
        let rest = aiResponse.message;
        for (const s of legalLeft) rest = rest.replace(s, "");
        rest = rest.replace(/\s{3,}/g, "\n\n").trim();
        aiResponse.message =
          asksQuestion(rest) && !/^(?:is|does|do|would|should|was)\s+(?:that|this|it)\b/i.test(rest)
            ? rest.charAt(0).toUpperCase() + rest.slice(1)
            : "Are there any licensing or ownership rules that would affect who can buy the business or how it transfers? Your broker will confirm the specifics with a lawyer.";
      }
      if (!aiResponse.shouldEnd && !stopNow && !asksQuestion(aiResponse.message) && !sellerAskedQuestion(sellerMessage)) {
        const q = fallbackQuestion(aiResponse.reasoning.nextIntent, aiResponse.reasoning.currentTopic);
        aiResponse.message = applyFiller(`${aiResponse.message.trim()}\n\n${q}`.trim());
        console.warn(`[session-manager] Output guard: appended the planned question — "${q}"`);
      }
    }
  }

  // GROUNDING GUARD — mechanical backstop for the prompt-side dodge rules:
  // a high-stakes "confirmed" write whose quantity (or negative claim) does
  // not appear in the seller's actual message is downgraded to approximate
  // and queued on the deferral ledger for a proper circle-back. A fabricated
  // fact can never masquerade as seller-confirmed in the CIM pipeline.
  const groundingResult = applyGroundingGuard(changes, updatedConfidence, sellerMessage);
  // The model restating a figure that is already on file (the seller said no
  // number this turn) is not new information and not a fabrication: nothing
  // is recorded, the file keeps its value and confidence, and no "verify"
  // circle-back is opened — that would re-ask something already answered.
  const restated = new Set(groundingResult.filter((f) => f.restatement).map((f) => f.change));
  if (restated.size > 0) {
    console.log(
      `[session-manager] Grounding guard: ${restated.size} restated figure(s) already on file left unchanged: ` +
        Array.from(restated).map((c) => c?.fieldName).join(", "),
    );
    changes = changes.filter((c) => !restated.has(c));
    for (const c of Array.from(restated)) {
      if (!c || changes.some((k) => k.fieldName === c.fieldName)) continue;
      if (confidenceLevels[c.fieldName] !== undefined) updatedConfidence[c.fieldName] = confidenceLevels[c.fieldName];
      else delete updatedConfidence[c.fieldName];
    }
  }
  const groundingFlags = groundingResult.filter((f) => !f.restatement);
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
  // "The value on record" is the one the agent was shown (the turn merged
  // against sellerInterviewView): never the broker's deal-row price or a
  // broker-only source's figure, which the seller must not hear about.
  const onRecord = (c: FieldChange): unknown => c.previousValue;
  // Beyond the high-stakes fields: any fact whose value on record came from
  // a document or email, or that has a document's value among its
  // alternates (26 trucks said vs the fleet list's 24 vans + 2 owner cars).
  const viewSources = getFieldSources(sellerView as Record<string, unknown>);
  const docById = new Map(documents.map((d) => [d.id, d]));
  const viewAlternates = getFieldAlternates(sellerView as Record<string, unknown>);
  const documentBacked = (key: string) =>
    ["document", "email"].includes(String(viewSources[key]?.source ?? "")) ||
    (viewAlternates[key] ?? []).some((a) => a?.source === "document");
  const materiallyDiffers = (c: FieldChange) =>
    numbersMateriallyConflict(String(onRecord(c)), String(c.newValue)) ||
    valuesMateriallyDiffer(c.fieldName, String(onRecord(c)), String(c.newValue));
  const conflictDeferrals = changes
    .filter(
      (c) =>
        (HIGH_STAKES_FIELDS.has(c.fieldName) || documentBacked(c.fieldName)) &&
        onRecord(c) &&
        c.previousConfidence !== "approximate" &&
        c.previousConfidence !== "inferred" &&
        !reconcileSettledTopics.some((t) => topicsMatch(t, `reconcile ${c.fieldName}`)) &&
        materiallyDiffers(c),
    )
    .map((c) => ({
      topic: `reconcile ${c.fieldName}`,
      reason: `seller's latest figure (${c.newValue}) differs materially from the value already on record (${String(onRecord(c))}, ${sourceLabel(viewSources[c.fieldName], docById)}) — confirm which is right and why they differ (e.g. gross vs net, or an intentional update)`,
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
  const priorChips = Array.isArray(sessionMeta._lastChips)
    ? (sessionMeta._lastChips as string[])
    : [];
  const fidelityFlags = applyNumericFidelityGuard(
    changes,
    updatedConfidence,
    sellerMessage,
    priorChips,
  );
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

  // WITHDRAWN VALUES stay withdrawn: the guess is still in the transcript, so
  // a later turn re-recording it (same figures, same words — and the seller
  // didn't just say them again) is dropped.
  if (priorRetracted.length > 0) {
    const reRecorded = changes.filter((c) =>
      priorRetracted.some((r) => r.key === c.fieldName && restatesWithdrawnValue(c.newValue, r.value, sellerMessage)),
    );
    if (reRecorded.length > 0) {
      console.warn(`[session-manager] Retraction guard: dropped a re-recorded withdrawn value: ${reRecorded.map((c) => c.fieldName).join(", ")}`);
      changes = changes.filter((c) => !reRecorded.includes(c));
      for (const c of reRecorded) {
        if (confidenceLevels[c.fieldName] !== undefined) updatedConfidence[c.fieldName] = confidenceLevels[c.fieldName];
        else delete updatedConfidence[c.fieldName];
      }
    }
  }

  // RETRACTIONS this turn — the fields the model named, or (backstop) the
  // facts the seller's previous answer wrote that this withdrawal talks
  // about. Applied to the saved facts under the lock below; nothing this turn
  // re-records them, and the broker gets a deferral naming who holds the
  // real answer.
  let retractions = (aiResponse.retractedFields ?? []).map((r) => ({
    field: canonicalFieldName(r.field, Object.keys(existingExtracted)),
    reason: r.reason,
  }));
  if (sellerRetracting && retractions.length === 0) {
    retractions = guessRetractedFields(existingExtracted, sellerMessage, { sessionId, turn: userTurnCount }).map((field) => ({
      field,
      reason: "the seller withdrew their previous answer",
    }));
    if (retractions.length > 0) {
      console.warn(`[session-manager] Retraction guard: model named no field — withdrawing ${retractions.map((r) => r.field).join(", ")} from the seller's previous answer`);
    }
  }
  if (retractions.length > 0) {
    const keys = new Set(retractions.map((r) => r.field));
    changes = changes.filter((c) => !keys.has(c.fieldName));
    for (const k of Array.from(keys)) delete updatedConfidence[k];
    const holder = whoHoldsTheAnswer(sellerMessage);
    const keyWords = (k: string) => new Set(k.replace(/([A-Z])/g, " $1").toLowerCase().split(/\s+/).filter((w) => w.length > 3).map((w) => w.slice(0, 5)));
    const missing = Array.from(keys).filter((k) => {
      const kw = keyWords(k);
      return !aiResponse.reasoning.newDeferrals.some((d) =>
        `${d.topic} ${d.whereInfoLives}`.toLowerCase().split(/[^a-z]+/).some((w) => w.length > 3 && kw.has(w.slice(0, 5))),
      );
    });
    if (missing.length > 0) {
      ledger = updateDeferralLedger(
        ledger,
        missing.map((k) => ({
          topic: `${k} (the seller withdrew an estimate)`,
          reason: `the seller took back what they said ("${sellerMessage.replace(/\s+/g, " ").slice(0, 140)}") — get the real answer, don't ask them to re-guess`,
          whereInfoLives: holder,
        })),
        [],
        userTurnCount,
      );
    }
  }

  // DATE-FIDELITY GUARD: a year the seller never said is resolved from
  // today's date and their tense ("got the raise in October" → the most
  // recent October), or downgraded with a verify deferral — never stored as
  // the seller's confirmed word (QA harvest: "October 2024" for a raise in
  // October 2025).
  const onFileText = Object.entries(sellerView)
    .filter(([k, v]) => !k.startsWith("_") && typeof v === "string")
    .map(([, v]) => v as string)
    .join(" ");
  const dateFlags = applyDateFidelityGuard(changes, updatedConfidence, {
    sellerMessage,
    sessionSellerText: existingMessages.filter((m) => m.role === "user").map((m) => m.content).join("\n"),
    prevAiMessage,
    onFileText,
  });
  if (dateFlags.length > 0) {
    console.warn(
      `[session-manager] Date-fidelity guard: ${dateFlags.map((f) => `${f.fieldName} (${f.reason})`).join("; ")}`,
    );
    const toVerify = dateFlags.filter((f) => f.needsVerification);
    if (toVerify.length > 0) {
      ledger = updateDeferralLedger(
        ledger,
        toVerify.map((f) => ({
          topic: `verify ${f.fieldName} date`,
          reason: `automatic date check: ${f.reason}; captured as approximate — confirm when it happened`,
          whereInfoLives: "",
        })),
        [],
        userTurnCount,
      );
    }
  }

  // LEGAL CLAIMS THE AGENT INTRODUCED: the seller's "yes" to the agent's own
  // legal assertion is not a verified fact — capped at inferred, and the
  // broker gets a verify-with-counsel task (created with the turn's tasks).
  const legalFlags = applyLegalGroundingGuard(changes, updatedConfidence, prevAiMessage);
  if (legalFlags.length > 0) {
    console.warn(`[session-manager] Legal-grounding guard: ${legalFlags.map((f) => `${f.fieldName} (${f.reason})`).join("; ")}`);
  }

  // From here on: the deal's real facts with this turn's changes applied.
  const merged = applyTurn();

  // Update industry context
  const updatedIndustryContext = updateIndustryContext(
    kb.industryContext,
    aiResponse.reasoning,
    kb.business.location,
  );

  // BROKER-PRIVATE NOTES: sensitive facts land in _brokerPrivateNotes on the
  // deal — visible to the broker, excluded from every CIM-feeding path (the
  // layout engine, financial analysis, and field counters all skip "_" keys).
  // A note a document (a CRM note, an email) already holds gains the
  // session as another source: the seller has now said it themselves, so
  // deleting that document later must not take the note with it.
  {
    let added = 0;
    for (const n of aiResponse.privateNotes ?? []) {
      if (!n?.note) continue;
      if (addPrivateNote(merged as Record<string, unknown>, n.note, { reason: n.reason, turn: userTurnCount })) added++;
    }
    if (added > 0) {
      console.log(
        `[session-manager] Stored ${added} broker-private note(s) on deal ${dealId}`,
      );
    }
  }

  // Provenance: everything this turn wrote is the seller's own word — typed
  // in the interview, or spoken on a broker-led call / video call. Recorded
  // with the session and turn so the broker can open the exact exchange.
  // Two rules around it:
  // - A value the BROKER set (edit or discrepancy resolution) is final: the
  //   seller's differing statement is kept as an alternate for the broker to
  //   adopt, never written over the broker's value.
  // - The value this turn displaced from another source (a document, the
  //   questionnaire, an email…) is kept as an alternate, never lost.
  {
    const mergedInfo = merged as Record<string, unknown>;
    const kind = sessionSourceKind(conductedBy, conductedVia);
    const at = new Date().toISOString();
    const turnSrc: FieldSource = { source: kind, sessionId, turn: userTurnCount, at };
    const priorSources = getFieldSources(existingExtracted);
    const kept: FieldChange[] = [];
    for (const c of changes) {
      // The value really on file before the turn — not the interview's view
      // of it (the broker's deal-row price and broker-only facts are hidden
      // there, so the change's previousValue may be another value or none).
      const prev = priorSources[c.fieldName];
      const priorValue = existingExtracted[c.fieldName];
      const hadValue = priorValue !== null && priorValue !== undefined && priorValue !== "";
      if (prev?.source === "broker" && hadValue) {
        mergedInfo[c.fieldName] = priorValue;
        // The broker's deal-row price is hidden from the interview, which
        // sees this seller answer in its place (interviewFactView) — so the
        // interview keeps the seller's confidence in it, as before.
        if (!isDealRowFact(existingExtracted, c.fieldName)) {
          if (confidenceLevels[c.fieldName] !== undefined) updatedConfidence[c.fieldName] = confidenceLevels[c.fieldName];
          else delete updatedConfidence[c.fieldName];
        }
        recordAlternate(mergedInfo, c.fieldName, c.newValue, turnSrc);
        continue;
      }
      // The value this turn replaced (a document's, a CRM note's…) stays as
      // another value — unless the seller said the very same thing.
      if (prev && hadValue && (prev.source !== kind || prev.documentId) && String(priorValue) !== String(c.newValue)) {
        recordAlternate(mergedInfo, c.fieldName, priorValue, prev);
      }
      setFieldSource(mergedInfo, c.fieldName, turnSrc);
      kept.push(c);
    }
    changes = kept;
  }

  // A conflict the seller has now spoken to (they stated the fact this turn)
  // is reconciled — the new value and the old one are both on file for the
  // broker. The agent can also resolve it explicitly (resolvedDeferrals).
  {
    const spokenKeys = new Set(changes.map((c) => c.fieldName.toLowerCase()));
    const settled = ledger
      .filter((e) => e.status === "open" && e.origin === "source" && /^reconcile\s/i.test(e.topic))
      .filter((e) => spokenKeys.has(e.topic.replace(/^reconcile\s+/i, "").trim().toLowerCase()))
      .map((e) => e.topic);
    if (settled.length > 0) ledger = updateDeferralLedger(ledger, [], settled, userTurnCount);
  }

  // Save to deal — re-read first, under the deal's facts lock (the same
  // queue broker edits and document ingestion use). A document can finish
  // parsing, or the broker can edit a fact, during the 10–30 s model call;
  // writing our stale snapshot back would erase it. Apply only what THIS
  // turn changed, and check each changed fact against the FRESH copy.
  const snapshot = (deal.extractedInfo as Record<string, unknown>) || {};
  const mergedRec = merged as Record<string, unknown>;
  let withdrawnNow: RetractedValue[] = [];
  await withDealFactsLock(dealId, async () => {
    const freshDeal = await storage.getDeal(dealId);
    const freshInfo = (freshDeal?.extractedInfo as Record<string, unknown>) || snapshot;
    const toSave = buildTurnSave({
      snapshot,
      merged: mergedRec,
      fresh: freshInfo,
      changedFacts: changes.map((c) => c.fieldName),
      turnSrc: {
        source: sessionSourceKind(conductedBy, conductedVia),
        sessionId,
        turn: userTurnCount,
        at: new Date().toISOString(),
      },
    });
    // Withdrawn statements come out of the facts as they are NOW (the fresh
    // copy): only a value that is still the seller's own words is removed.
    if (retractions.length > 0) {
      const r = applySellerRetractions(toSave, retractions, { turn: userTurnCount });
      withdrawnNow = r.withdrawn;
      console.log(
        `[session-manager] Seller retraction on deal ${dealId}: removed ${r.removed.join(", ") || "—"}; document value restored for ${r.restoredFromDocument.join(", ") || "—"}; left alone (not the seller's words) ${r.skipped.join(", ") || "—"}`,
      );
    }
    await storage.updateDeal(dealId, { extractedInfo: toSave });
  });
  // A conflict whose seller side the seller just withdrew no longer stands:
  // left open it would block the CIM, and "accept the interview value" would
  // write the guess back. (Settled rows are the broker's decision — untouched.)
  if (withdrawnNow.length > 0) {
    try {
      const rows = await storage.getDiscrepanciesByDeal(dealId);
      for (const id of discrepanciesSettledByRetraction(rows, withdrawnNow)) {
        const row = rows.find((d) => d.id === id);
        const note = `The seller withdrew this value in the interview (turn ${userTurnCount}).`;
        await storage.updateDiscrepancy(id, {
          status: "superseded",
          brokerNotes: row?.brokerNotes ? `${row.brokerNotes}\n${note}` : note,
        });
      }
    } catch (err) {
      console.error(`[session-manager] Couldn't settle discrepancies for withdrawn values on deal ${dealId}:`, err);
    }
  }

  // Tasks: no duplicates of an open follow-up, no request for a document
  // already on file, an offered document becomes an upload request, and a
  // follow-up the seller has now answered (or the agent resolved) closes.
  // Facts the seller stated this turn (a follow-up on one of them is done).
  const answeredKeys = new Set(
    changes.map((c) => c.fieldName).filter((k) => sellerAnswered(merged as Record<string, unknown>, k)),
  );
  const taskPlan = planTaskWrites({
    newTasks: aiResponse.newTasks,
    existing: tasks,
    documents: documents.filter((d) => d.visibility !== "broker_only"),
    answeredKeys,
    resolvedTopics: aiResponse.reasoning.resolvedDeferrals,
    sellerMessage,
  });
  for (const task of taskPlan.create) {
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
  for (const u of taskPlan.update) await storage.updateTask(u.id, { description: u.description });
  for (const id of taskPlan.close) await storage.updateTask(id, { status: "completed", completedAt: new Date() } as any);
  for (const id of taskPlan.remove) await storage.deleteTask(id);
  if (taskPlan.dropped.length > 0 || taskPlan.close.length > 0 || taskPlan.remove.length > 0) {
    console.log(
      `[session-manager] Tasks on deal ${dealId}: ${taskPlan.create.length} created, ${taskPlan.update.length} merged into existing, ${taskPlan.close.length} closed, ${taskPlan.remove.length} duplicate(s) removed, ${taskPlan.dropped.length} request(s) dropped (already on file)`,
    );
  }
  const droppedDocRequests = [
    ...(kb.droppedDocRequests ?? []),
    ...taskPlan.dropped.map((d) => `${d.title} → "${d.documentName}"`),
  ].slice(-8);
  // A legal point the interviewer introduced and the seller agreed to: the
  // broker confirms it with counsel before it reaches the CIM (one task per
  // fact — never duplicated across turns).
  for (const f of legalFlags) {
    const title = `${COUNSEL_TASK_PREFIX}${f.fieldName}`;
    if (tasks.some((t) => t.title === title)) continue;
    const value = changes.find((c) => c.fieldName === f.fieldName)?.newValue ?? "";
    await storage.createTask({
      dealId,
      createdBy: "ai_interview",
      assignedTo: null,
      type: "follow_up",
      title,
      description: `The interviewer raised a legal point ("${f.introducedBy.slice(0, 200)}") and the seller agreed: "${value.slice(0, 300)}". It is recorded as unverified — confirm the rule with the seller's lawyer before it appears in the CIM.`,
      relatedField: f.fieldName,
      status: "pending",
      priority: "medium",
      aiAttempts: 1,
      aiExplanation: "",
    });
  }

  // "Why we ask this" must belong to the question actually asked — never on
  // a goodbye or a wrap-up offer, never a rationale for a different topic —
  // and, like the message, never states a legal rule as fact.
  if (aiResponse.whyItMatters && !whyItMattersFits(aiResponse.message, aiResponse.whyItMatters, aiResponse.shouldEnd, prevAiMessage)) {
    console.log(`[session-manager] Dropped a whyItMatters that doesn't match the question on session ${sessionId}`);
    aiResponse.whyItMatters = undefined;
  }
  if (aiResponse.whyItMatters && findLegalAssertions(aiResponse.whyItMatters).length > 0) {
    console.log(`[session-manager] Dropped a whyItMatters that states a legal rule as fact on session ${sessionId}`);
    aiResponse.whyItMatters = undefined;
  }

  // Update session
  const storedUserMessage: ConversationMessage = {
    role: "user",
    content: sellerMessage,
    timestamp: receivedAt,
    ...(correctionOf ? { correctionOf } : {}),
  };
  const storedAiMessage: ConversationMessage = {
    role: "ai",
    content: aiResponse.message,
    timestamp: new Date().toISOString(),
    ...(aiResponse.whyItMatters ? { whyItMatters: aiResponse.whyItMatters } : {}),
    ...questionLabels(kb, aiResponse.importance, aiResponse.targetSection),
    suggestedAnswers: aiResponse.suggestedAnswers || [],
  };
  const updatedMessages: ConversationMessage[] = [
    ...existingMessages,
    storedUserMessage,
    storedAiMessage,
  ];

  const questionsAsked = (session.questionsAsked ?? 0) + 1;
  const questionsAnswered = (session.questionsAnswered ?? 0) +
    (Object.keys(aiResponse.extractedFields).length > 0 ? 1 : 0);
  const questionsSkipped = (session.questionsSkipped ?? 0) +
    taskPlan.create.filter((t) => t.type === "skipped_question").length;

  await db
    .update(interviewSessions)
    .set({
      messages: updatedMessages,
      lastActivityAt: new Date(),
      questionsAsked,
      questionsAnswered,
      questionsSkipped,
      extractedInfo: {
        _conductedBy: conductedBy,
        ...(conductedVia ? { _conductedVia: conductedVia } : {}),
        _industryContext: updatedIndustryContext,
        // Open ledger topics — kept for the resume path and the learning
        // loop, which read _deferredTopics; the ledger itself is durable.
        _deferredTopics: deferralTopicStrings(ledger),
        _deferralLedger: ledger,
        _stopSignalCount: stopSignalCount,
        _checkpointStreak: checkpointStreak,
        _degradedTurns: degraded ? priorDegradedTurns + 1 : 0,
        _lastChips: aiResponse.suggestedAnswers,
        _confidenceLevels: updatedConfidence,
        ...(priorRetracted.length + withdrawnNow.length > 0 ? { _retracted: [...priorRetracted, ...withdrawnNow] } : {}),
        ...(droppedDocRequests.length ? { _droppedDocRequests: droppedDocRequests } : {}),
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

    // Close the loop on discrepancies the broker routed to this interview
    // (status ask_seller): they were on the agent's agenda, so hand them back
    // to the broker as seller_responded. generate-content's critical gate
    // ignores ask_seller but blocks on seller_responded, so a routed critical
    // re-locks the CIM until the broker reviews the transcript and resolves —
    // nothing is silently accepted, and nothing stays "with the seller" forever.
    await markRoutedDiscrepanciesRaised(dealId).catch((err) => {
      console.error(`[session-manager] Could not hand routed discrepancies back for deal ${dealId}:`, err);
    });

    // Fire-and-forget: analyze the completed interview for learning insights
    runInterviewLearningLoop(dealId, sessionId).catch((err) => {
      console.error(`[session-manager] Learning loop failed for session ${sessionId}:`, err);
    });
  }

  // Rebuild coverage with the updated extracted info
  const updatedDeal = await storage.getDeal(dealId);
  const updatedKb = assembleKnowledgeBase(updatedDeal!, documents, tasks, session, resolvedDiscrepancies, kbExtras);
  ensureSectionImportance(updatedDeal!, importanceContext(updatedIndustryContext));
  ensureInterviewPlan(updatedDeal!, { subIndustry: updatedIndustryContext?.subIndustry ?? null });

  // A message held back (no question, or never streamed) is shown now, final.
  await shown.finish(aiResponse.message);

  return {
    message: aiResponse.message,
    whyItMatters: aiResponse.whyItMatters,
    importance: storedAiMessage.importance,
    targetSection: storedAiMessage.targetSection,
    suggestedAnswers: aiResponse.suggestedAnswers || [],
    turnMessages: { user: storedUserMessage, ai: storedAiMessage },
    sessionId,
    captured: {
      ...countExtractedFields(updatedDeal!),
      newFields: changes.filter((c) => c.previousValue === null).map((c) => c.fieldName),
      updatedFields: changes.filter((c) => c.previousValue !== null).map((c) => c.fieldName),
      changes,
    },
    sectionCoverage: updatedKb.sectionCoverage.map(coverageForClient),
    industryContext: extractIndustryContextForFrontend(updatedIndustryContext),
    // Derived from the durable ledger — stable and append-only until
    // resolved, so the broker-facing panel no longer flickers or loses items.
    deferredTopics: deferralTopicStrings(ledger),
    shouldEnd: aiResponse.shouldEnd,
    endReason: aiResponse.endReason,
  };
}

/**
 * Flips every ask_seller discrepancy on the deal to seller_responded with a
 * note pointing the broker at the transcript. Called when an interview ends.
 * Returns the number of rows updated.
 */
async function markRoutedDiscrepanciesRaised(dealId: string): Promise<number> {
  const routed = (await storage.getDiscrepanciesByDeal(dealId)).filter((d) => d.status === "ask_seller");
  if (routed.length === 0) return 0;
  const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
  const sellerResponse = `Raised with the seller in the AI interview on ${date} — review the transcript and resolve`;
  for (const d of routed) {
    await storage.updateDiscrepancy(d.id, { status: "seller_responded", sellerResponse });
  }
  console.log(`[session-manager] Handed ${routed.length} routed discrepanc${routed.length === 1 ? "y" : "ies"} back to the broker for deal ${dealId}`);
  return routed.length;
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
  /** The re-ask guard's context: an opening never asks what the sources or an earlier session already answered. */
  reask?: ReaskContext,
): Promise<{ message: string; whyItMatters?: string; importance?: InterviewResponse["importance"]; targetSection?: string; suggestedAnswers: string[]; industryContext: IndustryContext | null }> {
  const systemBlocks = await buildInterviewSystemBlocks(kb);

  // The opening prompt varies based on what we already know
  const hasQuestionnaireData = kb.questionnaireData && Object.keys(kb.questionnaireData).length > 0;
  const hasDocuments = kb.documents.length > 0;
  const hasPriorSession = kb.priorSessionSummary !== null;

  let openingInstruction: string;

  // The first question goes where it matters most: a conflict or flagged
  // risk in what's on file, else a critical section that is still thin —
  // never a mid-priority topic (QA harvest: openings went straight to a
  // permits question with no greeting).
  const criticalGaps = kb.sectionCoverage
    .filter((s) => (CRITICAL_SECTIONS.has(s.key) || s.importance === "critical") && s.status !== "well_covered")
    .map((s) => `${s.title} (${s.key})`);
  const aimAt =
    ` Aim the first question at the single most important open item: a conflict between sources or a buyer risk flagged in the materials if there is one, otherwise a CRITICAL section that is still thin` +
    (criticalGaps.length > 0 ? ` — currently: ${criticalGaps.slice(0, 6).join(", ")}` : "") +
    `. Set importance and targetSection for it.`;
  const noFiller = ` No inventory of what the materials contain, no praise, no explanation of the process.`;

  if (hasPriorSession) {
    openingInstruction = `The seller is returning to an ongoing conversation. One short welcome-back sentence, then go straight to the most important open gap or deferral as a question. Do not list what you already have. Do not repeat any question already answered. Three sentences maximum.`;
  } else if (hasQuestionnaireData && hasDocuments) {
    openingInstruction = `This is the start of the interview and your first contact with the seller. Open with one short, warm welcome sentence that says what this conversation is for (building the document buyers will read about their business) and that you've already read their questionnaire and documents. Then ask your first question.${aimAt}${noFiller} Three sentences maximum.`;
  } else if (hasQuestionnaireData) {
    openingInstruction = `This is the start of the interview and your first contact with the seller. Open with one short, warm welcome sentence that says what this conversation is for (building the document buyers will read about their business) and that you've already read their questionnaire — do not restate its figures or names. Then ask your first question.${aimAt}${noFiller} Three sentences maximum.`;
  } else if (hasDocuments) {
    openingInstruction = `This is the start of the interview and your first contact with the seller. Open with one short, warm welcome sentence that says what this conversation is for (building the document buyers will read about their business) and that you've already read the materials on file. Then ask your first question.${aimAt}${noFiller} Three sentences maximum.`;
  } else {
    openingInstruction = `This is the start of the interview and you have little background. One sentence of welcome that says what this is for (the document buyers will read about their business), then one broad opening question: what the business does, how long it has operated, and where. Three sentences maximum.`;
  }

  // The most important open item goes first: a conflict between sources,
  // then a risk the sources flag, then a critical gap.
  openingInstruction += openingPriorityHint(kb);

  // Recovery-wrapped: retries a malformed/truncated opening once, then falls
  // back below — the seller never lands on an empty chat with no question.
  const openingMessages: Array<{ role: "user" | "assistant"; content: string }> = [
    {
      role: "user",
      content: `[SYSTEM: ${openingInstruction}]\n\nGenerate your opening message to the seller. The business is "${businessName}".`,
    },
  ];
  const openingParams = {
    model: INTERVIEW_MODEL,
    maxTokens: agentConfig.api.maxTokens,
    temperature: agentConfig.api.temperature,
    system: systemBlocks,
    messages: openingMessages,
  };
  let { response: aiResponse, degraded } = await callInterviewWithRecovery(anthropic, openingParams);

  // A first question aimed at a non-critical topic while critical sections
  // are thin gets one redirect (first sessions only — a returning seller
  // resumes where the ledger says). When the sources put a conflict or a
  // flagged risk on the agenda, the opening is steered there (see
  // openingPriorityHint) and such a question is often labelled "important"
  // — only a "helpful" one is redirected then.
  const agendaFirst = (kb.sourceConflicts ?? []).length + (kb.flaggedRisks ?? []).length > 0;
  const targetIsCritical =
    aiResponse.importance === "critical" ||
    (agendaFirst && aiResponse.importance !== "helpful") ||
    (!!aiResponse.targetSection &&
      kb.sectionCoverage.some((s) => s.key === aiResponse.targetSection && (CRITICAL_SECTIONS.has(s.key) || s.importance === "critical")));
  if (!degraded && !hasPriorSession && (hasQuestionnaireData || hasDocuments) && criticalGaps.length > 0 && !targetIsCritical) {
    console.warn(`[session-manager] Opening aimed at ${aiResponse.targetSection ?? "an unlabelled topic"} while critical sections are thin — redirecting`);
    const redirected = await callInterviewWithRecovery(anthropic, {
      ...openingParams,
      messages: [
        ...openingMessages,
        { role: "assistant", content: aiResponse.message },
        {
          role: "user",
          content: `[SYSTEM CORRECTION: Your first question goes to a helpful/important topic while critical sections are still thin (${criticalGaps.slice(0, 6).join(", ")}). Rewrite the opening: the same one-sentence welcome, then a question on the most important of those (or on a conflict or flagged risk in the materials). Set importance "critical" and the matching targetSection. Do not mention this instruction.]`,
        },
      ],
    });
    if (!redirected.degraded && redirected.response.message) aiResponse = redirected.response;
  }

  // A returning seller's opening re-asked what the org chart already says
  // ("You have 22 setup technicians — how are they split?") — the same guard
  // as every turn, on the opening that will actually go out.
  if (!degraded && reask && aiResponse.message) {
    const guarded = await applyReaskGuard(anthropic, openingParams, aiResponse, reask);
    if (guarded.recalled) {
      console.warn(`[session-manager] Re-ask guard on the opening: ${guarded.findings.map((f) => `${f.kind}(${f.detail.slice(0, 60)})`).join("; ")}`);
      aiResponse = guarded.response;
    }
  }

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

  const message = finalizeOpeningMessage(aiResponse.message);
  return {
    message,
    whyItMatters: whyItMattersFits(message, aiResponse.whyItMatters, false) ? aiResponse.whyItMatters : undefined,
    importance: aiResponse.importance,
    targetSection: aiResponse.targetSection,
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

/**
 * Broker action: a finished interview goes back to "in progress" (the QA
 * harvest found an interview completed at 6 of 10 turns with no way back).
 * The deal's interviewCompleted flag clears and the finished sessions are
 * marked reopened (so the seller's progress stops counting them as done);
 * the next start opens a new session that picks up from everything on file,
 * and the interview counts as complete again when it next ends.
 */
export async function reopenInterview(dealId: string): Promise<void> {
  const sessions = await db.select().from(interviewSessions).where(eq(interviewSessions.dealId, dealId));
  const at = new Date().toISOString();
  for (const s of sessions) {
    if (s.status !== "completed") continue;
    const meta = (s.extractedInfo as Record<string, unknown> | null) ?? {};
    if (meta._reopenedAt) continue;
    await db
      .update(interviewSessions)
      .set({ extractedInfo: { ...meta, _reopenedAt: at } })
      .where(eq(interviewSessions.id, s.id));
  }
  await storage.updateDeal(dealId, { interviewCompleted: false });
  console.log(`[session-manager] Interview reopened by the broker on deal ${dealId}`);
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
 * Copies intake answers into extractedInfo with provenance
 * {source:"questionnaire"}. The seller's own typed answer replaces a value
 * that only a model read from a lower-ranked source (document, CRM note,
 * website) — the displaced value is kept as an alternate — but never the
 * seller's interview words, a broker edit, an untracked legacy value, a
 * same-rank source (an email) or a fact the broker deleted.
 * Returns the new extractedInfo map when anything changed, else null.
 */
export function seedExtractedInfoFromQuestionnaire(
  deal: {
    questionnaireData?: unknown;
    operationalSystems?: unknown;
    employeeChart?: unknown;
    extractedInfo: unknown;
  },
  /** Fresh model splits of intake answers (see screenQuestionnaireAnswers), cached on the deal. */
  freshScreen: QuestionnaireScreen = {},
): Record<string, unknown> | null {
  const facts = questionnaireFacts(deal);
  if (facts.length === 0) return null;

  const existing = (deal.extractedInfo || {}) as Record<string, unknown>;
  let added = false;
  const seeded = { ...existing };
  const at = new Date().toISOString();

  // Answers that could carry a personal matter are split first
  // (questionnaire-privacy.ts): only the public part becomes the fact, the
  // personal detail becomes a broker-private note. Without a model split on
  // file the keyword backstop decides.
  const screen: QuestionnaireScreen = { ...getQuestionnaireScreen(existing), ...freshScreen };
  if (Object.keys(freshScreen).length > 0) {
    seeded[QUESTIONNAIRE_SCREEN_KEY] = screen;
    added = true;
  }

  for (const [key, answer] of facts) {
    let value = answer;
    if (needsScreen(key, answer)) {
      const onFile = screen[key]?.hash === answerHash(answer) ? screen[key] : null;
      // A split recorded before today's checks that fails them (a figure the
      // answer never states) is not used, and the value it seeded goes.
      const cached = onFile && splitStillValid(answer, onFile) ? onFile : null;
      const split = cached ?? keywordSplit(answer);
      const stale = getQuestionnaireScreen(existing)[key];
      if (
        stale && stale.hash === answerHash(answer) && stale.publicValue && stale.publicValue !== split.publicValue &&
        !splitStillValid(answer, stale) && scrubUnscreenedAnswer(seeded, key, stale.publicValue)
      ) added = true;
      for (const note of split.privateNotes) {
        if (addPrivateNote(seeded, note, { questionnaire: true, reason: "From the intake questionnaire" })) added = true;
      }
      if (split.publicValue !== answer.trim() && scrubUnscreenedAnswer(seeded, key, answer)) added = true;
      if (!split.publicValue) continue;
      value = split.publicValue;
    }
    const current = seeded[key];
    const empty = current === null || current === undefined || current === "";
    // The seller's own typed answer outranks anything a model read from a
    // document (observed: a transcript's "Dr. Lee" blocked the intake's
    // "Dr. Rao" for the whole deal) — but never the seller's interview words.
    if (!empty) {
      if (String(current) === value) {
        // The seller typed what a document already says: remembered as a
        // source of that fact (the questionnaire outranks a document), so
        // deleting the document can't take the seller's own answer away.
        const before = JSON.stringify([seeded._fieldSources ?? null, seeded._fieldCorroborations ?? null]);
        if (!isSuppressed(seeded, key)) noteSameValue(seeded, key, { source: "questionnaire", at });
        if (JSON.stringify([seeded._fieldSources ?? null, seeded._fieldCorroborations ?? null]) !== before) added = true;
        continue;
      }
      const cur = getFieldSources(seeded)[key];
      const outranked =
        !sourceAllowsOverwrite(seeded, key, "questionnaire") ||
        (!!cur && cur.source !== "questionnaire" && sourceRank(cur.source) >= sourceRank("questionnaire"));
      if (outranked) {
        // Keep the intake answer visible to the broker as another value.
        if (!isSuppressed(seeded, key)) {
          const before = JSON.stringify(seeded._fieldAlternates ?? null);
          recordAlternate(seeded, key, value, { source: "questionnaire", at });
          if (JSON.stringify(seeded._fieldAlternates ?? null) !== before) added = true;
        }
        continue;
      }
      recordAlternate(seeded, key, current, cur ?? { source: "document" });
    } else if (isSuppressed(seeded, key)) {
      continue; // the broker deleted this fact
    }
    seeded[key] = value;
    setFieldSource(seeded, key, { source: "questionnaire", at });
    if (!empty) displaceCorroborations(seeded, key, value);
    added = true;
  }

  return added ? seeded : null;
}

/**
 * Seeds intake answers onto the deal right after the seller submits the
 * intake (not only when the interview starts), so the broker's Information
 * tab and the readiness score reflect them at once. Re-reads the deal and
 * writes only the keys it changed.
 */
export async function seedQuestionnaireFacts(dealId: string): Promise<string[]> {
  // The privacy split runs before taking the facts lock (a model call must
  // not hold up interview turns or document merges).
  const pre = await storage.getDeal(dealId);
  if (!pre) return [];
  const fresh = await screenQuestionnaireAnswers(pre);
  return withDealFactsLock(dealId, async () => {
    const deal = await storage.getDeal(dealId);
    if (!deal) return [];
    const before = (deal.extractedInfo || {}) as Record<string, unknown>;
    const seeded = seedExtractedInfoFromQuestionnaire(deal, fresh);
    if (!seeded) return [];
    // Saved whenever seeding changed anything — an intake answer that only
    // became another value (an alternate) or a corroboration is still news
    // for the broker's Information tab. The return value lists the changed
    // facts only.
    await storage.updateDeal(dealId, { extractedInfo: seeded });
    return Object.keys(seeded).filter((k) => !k.startsWith("_") && JSON.stringify(seeded[k]) !== JSON.stringify(before[k]));
  });
}

/**
 * Labels stored with an AI question. The model's own importance wins; when it
 * only named the section, the level comes from the deal's ranking; when it
 * named neither, no label is shown (better than a wrong one).
 */
function questionLabels(
  kb: KnowledgeBase,
  importance: InterviewResponse["importance"],
  targetSection: string | undefined,
): Pick<ConversationMessage, "importance" | "targetSection"> {
  const section = targetSection && kb.sectionImportance.sections[targetSection] ? targetSection : undefined;
  const level = importance ?? (section ? kb.sectionImportance.sections[section].level : undefined);
  return {
    ...(level ? { importance: level } : {}),
    ...(section ? { targetSection: section } : {}),
  };
}

function importanceContext(ctx: IndustryContext | null | undefined) {
  if (!ctx?.industry) return undefined;
  const loc = ctx.location as { city?: string; province?: string; state?: string; country?: string } | null;
  const location = loc ? [loc.city, loc.province ?? loc.state, loc.country].filter(Boolean).join(", ") : null;
  return { subIndustry: ctx.subIndustry, location, industrySpecificAreas: ctx.industrySpecificAreas };
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

// =====================
// Source items, wrap-up checklist, client coverage
// =====================

/**
 * What the seller sees of a streamed turn. The message is released once —
 * when the re-ask guard approves it (typed out in small chunks so it still
 * reads like live text) or, for a held message, when the turn is final.
 * Without a stream (the plain /message endpoint) everything is a no-op.
 */
export function createMessageRelease(onDelta?: (chunk: string) => void) {
  let released = false;
  let typing: Promise<void> = Promise.resolve();
  const typeOut = (text: string) => {
    if (!onDelta || !text) return;
    const chunks = text.match(/\S+\s*/g) ?? [text];
    typing = (async () => {
      for (let i = 0; i < chunks.length; i += 3) {
        onDelta(chunks.slice(i, i + 3).join(""));
        if (i + 3 < chunks.length) await new Promise((r) => setTimeout(r, RELEASE_CHUNK_MS));
      }
    })();
  };
  return {
    /** The delta sink to stream into (a no-op: text is released whole, once approved). */
    streaming: onDelta ? (_chunk: string) => {} : undefined,
    get released() {
      return released;
    },
    release(text: string) {
      if (released) return;
      released = true;
      typeOut(text);
    },
    /** End of turn: shows the final message if nothing was shown yet; waits for the typing to finish. */
    async finish(finalMessage: string) {
      if (!released) {
        released = true;
        typeOut(finalMessage);
      }
      await typing;
    },
  };
}
/**
 * The stream gate: a streamed draft that a guard after the model call will
 * rewrite is held (shown, fixed, when the turn is final) instead of being
 * released and then swapped on the seller's screen — a valuation figure on
 * a fishing turn, the agent's machinery or a legal claim stated as fact (the
 * OUTPUT GUARDS), or any draft on a turn where the seller withdrew something
 * (the retraction backstop may re-call).
 */
export function heldForLaterGuards(text: string, ctx: { retractionInMessage: boolean; valuationLeak: boolean }): boolean {
  return ctx.retractionInMessage || ctx.valuationLeak || leaksInternalMachinery(text) || findLegalAssertions(text).length > 0 || assertsNormalisation(text);
}
/** How long a streamed question waits for the answer check before it is shown anyway. */
const STREAM_CHECK_TIMEOUT_MS = 4_000;
/** Pause between released chunks of ~3 words (a 40-word question types out in ~0.4s). */
const RELEASE_CHUNK_MS = 30;

/**
 * A critical section the seller explicitly set aside (deferred or declined)
 * counts as addressed for triage. Only REAL deferrals count: an item the
 * server put on the agenda from the sources ("risk: COVID 2020 sales
 * dropped") was never discussed, so it can't stand in for revenue.
 */
export function sectionDeferred(sectionKey: string, ledger: DeferralEntry[]): boolean {
  const patterns: Record<string, RegExp> = {
    asking_price: /price|valuation|deal.?terms/i,
    financials: /revenue|financial|margin|sde|ebitda|profit|earnings/i,
    reason_for_sale: /reason.?for.?sale|why.*sell/i,
  };
  const re = patterns[sectionKey];
  if (!re) return false;
  return agentDeferrals(ledger).some((d) => re.test(d.topic));
}

/**
 * What the financial-core checkpoint still lacks: a revenue figure, some
 * profitability, the seller's price expectation — each satisfied by a value
 * on file or an explicit deferral by the seller (never by a source-minted
 * agenda item). Without the deferral escape the MUST escalation would order
 * endless re-asks of a question the seller already deferred (review-caught).
 */
export function financialCoreGaps(extractedNow: Record<string, unknown>, ledger: DeferralEntry[]): string[] {
  const deferrals = agentDeferrals(ledger);
  const PROFIT_FIELDS = ["operatingMargins", "grossMargin", "sde", "ebitda", "netProfit", "netIncome", "cashFlow", "profitability"];
  const hasProfitability =
    PROFIT_FIELDS.some((f) => !!extractedNow[f]) || deferrals.some((d) => /profit|margin|sde|ebitda|earnings/i.test(d.topic));
  const deferredPrice = deferrals.some((d) => /price|valuation/i.test(d.topic));
  const deferredRevenue = deferrals.some((d) => /revenue|sales|top.?line|p&l|financial/i.test(d.topic));
  return [
    !extractedNow.annualRevenue && !deferredRevenue ? "a revenue figure or band (annualRevenue)" : null,
    !hasProfitability ? "profitability — margins, SDE/EBITDA, or at least a directional sense (operatingMargins)" : null,
    !extractedNow.askingPrice && !deferredPrice ? "the seller's asking-price expectation (askingPrice)" : null,
  ].filter((x): x is string => !!x);
}

/**
 * How long a new session's opening waits for a source review still being
 * built. Short: the seller is looking at a loading screen, and the review
 * usually finished long before (the broker's Overview starts it); when it
 * hasn't, the opening goes to the mechanical conflicts and later turns
 * pick the review up. (Was 25s — openings took 39–49s.)
 */
const SOURCE_REVIEW_WAIT_MS = 8_000;
/** Past this many seller turns, flagged items no longer hold the interview open on their own. */
const MAX_TURNS_HELD_OPEN = 40;
/** How many flagged risks go on the agenda (most-flagged first). */
const RISK_AGENDA_LIMIT = 6;

/**
 * Adds the conflicts and flagged risks the sources raise to the ledger as
 * "source" items (on the agenda, not yet raised) the first time they
 * appear. Never re-mints one that already has an entry, open or resolved.
 */
export function mintSourceItems(ledger: DeferralEntry[], kb: Pick<KnowledgeBase, "sourceConflicts" | "flaggedRisks">, turn: number): DeferralEntry[] {
  const fresh: { topic: string; reason: string }[] = [];
  const known = (topic: string) => ledger.some((e) => e.topic.toLowerCase() === topic.toLowerCase());
  for (const c of kb.sourceConflicts ?? []) {
    const topic = `reconcile ${c.key}`;
    if (!known(topic) && !fresh.some((f) => f.topic === topic)) {
      fresh.push({ topic, reason: `sources disagree: ${c.values.map((v) => `"${v.value}" (${v.source})`).join(" vs ")}` });
    }
  }
  for (const r of (kb.flaggedRisks ?? []).slice(0, RISK_AGENDA_LIMIT)) {
    const topic = `risk: ${r.label}`;
    if (!known(topic) && !fresh.some((f) => f.topic === topic)) fresh.push({ topic, reason: `flagged in ${r.sources[0]}` });
  }
  if (fresh.length === 0) return ledger;
  // Appended as their own entries — never merged into an agent deferral
  // whose label happens to contain the same words (the ledger's fuzzy
  // matching would overwrite that deferral's reason and hide the item).
  const ids = new Set(ledger.map((e) => e.id));
  const added: DeferralEntry[] = fresh.map((f, i) => {
    const base = `src_${f.topic.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 60)}_t${turn}`;
    const id = ids.has(base) ? `${base}_${i}` : base;
    ids.add(id);
    return { id, topic: f.topic, reason: f.reason, whereInfoLives: "", status: "open" as const, createdAtTurn: turn, origin: "source" as const };
  });
  return [...ledger.map((e) => ({ ...e })), ...added];
}

/**
 * Shows only conflicts and risks still on the agenda (open source items);
 * ones the agent resolved drop out, ones it deferred move to the deferral
 * list. Risks beyond the agenda limit stay visible as context.
 */
export function applyLedgerToKb(kb: KnowledgeBase, ledger: DeferralEntry[]): void {
  const state = (topic: string) => ledger.find((e) => e.topic.toLowerCase() === topic.toLowerCase());
  const onAgenda = (topic: string) => {
    const e = state(topic);
    return !e || (e.status === "open" && e.origin === "source");
  };
  kb.sourceConflicts = (kb.sourceConflicts ?? []).filter((c) => onAgenda(`reconcile ${c.key}`));
  kb.flaggedRisks = (kb.flaggedRisks ?? []).filter((r) => onAgenda(`risk: ${r.label}`));
}

/** Critical sections for this deal: the base floor plus the industry ranking. */
function criticalSectionSet(kb: Pick<KnowledgeBase, "sectionCoverage">): Set<string> {
  const out = new Set<string>(Array.from(CRITICAL_SECTIONS));
  for (const s of kb.sectionCoverage) if (s.importance === "critical") out.add(s.key);
  return out;
}

/** Question → answer pairs in one transcript (the AI's question, the seller's next message). */
export function exchangesOf(messages: Pick<ConversationMessage, "role" | "content">[]): Exchange[] {
  const out: Exchange[] = [];
  for (let i = 0; i < messages.length - 1; i++) {
    if (messages[i].role !== "ai" || messages[i + 1].role !== "user") continue;
    out.push({ question: questionPart(messages[i].content), answer: messages[i + 1].content });
  }
  return out;
}

/** Section coverage as the client reads it (status, importance and item counts). */
function coverageForClient(s: SectionCoverage) {
  return {
    key: s.key,
    title: s.title,
    status: s.status,
    importance: s.importance,
    importanceReason: s.importanceReason,
    totalItems: s.totalItems,
    openItems: s.openItems,
    openCriticalItems: s.openCriticalItems,
    unverifiedItems: s.unverifiedItems,
    sellerSourcedItems: s.sellerSourcedItems,
    documentedItems: s.documentedItems,
  };
}

/** One sentence steering the opening question to the most important open item. */
function openingPriorityHint(kb: KnowledgeBase): string {
  const conflict = (kb.sourceConflicts ?? [])[0];
  if (conflict) return ` Your question should go to the most important open item: the conflict on ${conflict.key} (see CONFLICTS TO RECONCILE) — ask about it neutrally.`;
  const risk = (kb.flaggedRisks ?? [])[0];
  if (risk) return ` Your question should go to the most important open item: the flagged risk "${risk.label}" (see RISKS FLAGGED IN THE SOURCES) — ask what happened and where it stands.`;
  const blocker = (kb.wrapUpBlockers ?? [])[0];
  if (blocker) return ` Your question should go to the most important open item: ${blocker}.`;
  return "";
}
