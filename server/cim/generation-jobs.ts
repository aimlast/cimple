/**
 * generation-jobs — runs CIM generation as a background job.
 *
 * "Generate CIM" used to be one multi-minute HTTP request: if the broker left
 * the page the request was dropped and the work lost, and the UI only knew
 * "pending" or "done". Now the request starts a job and returns at once; the
 * job keeps running on the server, reports section-by-section progress, and
 * persists its status on the deal (`deals.cimGeneration`) so a refresh — or
 * the global watcher in the broker layout — can pick it up.
 *
 * One job per deal at a time. Jobs live in memory while running and for a
 * short while after finishing (for the watcher's completion toast); the
 * persisted status is the durable record.
 */
import { assignLineage } from "../analytics/lineage";
import { storage } from "../storage";
import { generateCimLayout, type CimLayoutParams, type LayoutProgress } from "./layout-engine";
import type { CimDocument } from "./layout-types";
import { templateForDeal } from "./templates";
import { generationShortfall } from "./generation-shortfall";
import type { BuyerAccess, CimGenerationStatus, Deal, FinancialAnalysis } from "@shared/schema";
import { phaseIndex } from "@shared/deal-progress";
import { listedAskingPrice } from "../information/deal-mirror";
import { brokerFactsView } from "../information/facts";
import { settleResolvedFacts, currentResolvedNotes, resolvedNotes } from "./resolved-block";
import { stampSourceDetails } from "../documents/merge-policy";
import { cimFinancialsFor } from "./cim-financials";
import { keepOutFor } from "./keep-out";
import { documentSentencesDating, hasMonthYear } from "./fact-dates";
import { getFieldSources, isFactKey } from "../interview/info-merger";
import { factValueText } from "../information/cim-facts";
import { db } from "../db";
import { interviewSessions } from "@shared/schema";
import { eq } from "drizzle-orm";
import { writerFactsSnapshot } from "./cim-staleness";
import { describeAiFailure } from "../ai-retry";
import { dropPublishedSnapshot, takePublishedSnapshot } from "./published-snapshot";

export type CimGenerationMode = CimGenerationStatus["mode"];

export interface CimGenerationJob extends CimGenerationStatus {
  dealId: string;
  brokerId: string;
  businessName: string;
}

/** Thrown by startCimGeneration when the deal already has a running job. */
export class CimGenerationRunningError extends Error {
  constructor(public readonly job: CimGenerationJob) {
    super("CIM generation is already running for this deal");
    this.name = "CimGenerationRunningError";
  }
}

/** Kept after finishing so the broker layout's watcher can toast completion. */
const FINISHED_RETENTION_MS = 15 * 60 * 1000;

const jobs = new Map<string, CimGenerationJob>();

/** Swappable for tests — the real engine calls Claude for several minutes. */
type Generator = (params: CimLayoutParams, onProgress?: (p: LayoutProgress) => void) => Promise<CimDocument>;
let generator: Generator = generateCimLayout;
export function _setGeneratorForTests(g: Generator | null) {
  generator = g ?? generateCimLayout;
}

/** The status as the browser gets it (the facts snapshot stays on the server). */
function toStatus(job: CimGenerationJob): CimGenerationStatus {
  const { dealId: _d, brokerId: _b, businessName: _n, factsAt: _f, ...status } = job;
  return status;
}

/** The status as stored on the deal (the facts snapshot included). */
function storedStatus(job: CimGenerationJob): CimGenerationStatus {
  const { dealId: _d, brokerId: _b, businessName: _n, ...stored } = job;
  return stored;
}

/** Best-effort persistence — a failed status write must never kill the run. */
async function persist(job: CimGenerationJob) {
  try {
    await storage.updateDeal(job.dealId, { cimGeneration: storedStatus(job) } as any);
  } catch (err) {
    console.warn(`[cim-generation] could not persist status for deal ${job.dealId}:`, err);
  }
}

/** Kinds of source that are a written record (a year they state is on file). */
const WRITTEN_KINDS: ReadonlySet<string> = new Set(["document", "email", "questionnaire"]);

/** The fact's other values and confirmations from written, non-private sources, as one text. */
export function writtenValuesFor(info: Record<string, unknown>, key: string): string {
  const out: string[] = [];
  for (const store of ["_fieldAlternates", "_fieldCorroborations"]) {
    const map = (info[store] ?? {}) as Record<string, unknown>;
    for (const [k, list] of Object.entries(map)) {
      if (k !== key && !k.startsWith(`${key}.`)) continue;
      if (!Array.isArray(list)) continue;
      for (const a of list as Array<{ value?: unknown; source?: string; brokerOnly?: boolean }>) {
        if (!a || a.brokerOnly || !WRITTEN_KINDS.has(String(a.source))) continue;
        if (typeof a.value === "string" && a.value.trim()) out.push(a.value);
      }
    }
  }
  return out.join("\n");
}

/**
 * The text of the deal's written sources — documents, emails, the
 * questionnaire — that the seller side shares (never broker-only material,
 * CRM notes, websites or spoken transcripts).
 */
export function writtenSourceTexts(docs: ReadonlyArray<{ sourceKind?: string | null; visibility?: string | null; extractedText?: string | null }>): string[] {
  return docs
    .filter((d) => d.visibility !== "broker_only" && WRITTEN_KINDS.has(d.sourceKind || "document") && typeof d.extractedText === "string" && d.extractedText.trim())
    .map((d) => d.extractedText as string);
}

/**
 * For interview facts that state a "Month YYYY": the seller's words on the
 * turn that recorded them (provenance keeps the session and seller turn), so
 * the writer's knowledge base can correct a year the seller never said.
 * Best-effort: a failed look-up just leaves the facts as they are.
 */
export async function factSourceWordsFor(
  dealId: string,
  info: Record<string, unknown>,
  /** Keys the broker settled in a resolved discrepancy: their value is the broker's, not the seller's words. */
  brokerSettled: ReadonlySet<string> = new Set(),
  /** The deal's written sources' text (writtenSourceTexts): a date one of them states is kept, whatever fact it was filed under. */
  writtenTexts: readonly string[] = [],
): Promise<Record<string, { words: string; at: string; documentWords?: string }>> {
  const sources = getFieldSources(info);
  const wanted = Object.entries(sources).filter(
    ([key, s]) => isFactKey(key) && !brokerSettled.has(key) && s?.sessionId && typeof s.turn === "number" && s.at && key in info && hasMonthYear(factValueText(info[key])),
  );
  if (wanted.length === 0) return {};
  try {
    const rows = await db.select({ id: interviewSessions.id, messages: interviewSessions.messages }).from(interviewSessions).where(eq(interviewSessions.dealId, dealId));
    const byId = new Map(rows.map((r) => [r.id, Array.isArray(r.messages) ? (r.messages as Array<{ role?: string; content?: unknown }>) : []]));
    const out: Record<string, { words: string; at: string; documentWords?: string }> = {};
    for (const [key, s] of wanted) {
      // `turn` counts the seller's messages (1-based) in that session.
      const seller = (byId.get(s.sessionId!) ?? []).filter((m) => m?.role === "user");
      const msg = seller[s.turn! - 1];
      const words = typeof msg?.content === "string" ? msg.content : "";
      // What written sources on file say for the same fact: a year one of
      // them states is never taken out (fact-dates.ts).
      const documentWords = [writtenValuesFor(info, key), documentSentencesDating(factValueText(info[key]), writtenTexts)].filter(Boolean).join("\n");
      if (words) out[key] = { words, at: s.at!, ...(documentWords ? { documentWords } : {}) };
    }
    return out;
  } catch (err) {
    console.warn(`[cim-generation] could not read interview words for deal ${dealId}:`, err);
    return {};
  }
}

/**
 * Build the layout-engine params from a deal. Resolved discrepancies (both
 * modes): a row naming a real fact key overlays that key (the broker's
 * accepted value wins), and every resolved row reaches the writer in the
 * "RESOLVED — FINAL VALUES" block with the values it superseded.
 */
export async function buildLayoutParams(deal: Deal, mode: CimGenerationMode): Promise<CimLayoutParams> {
  void mode;
  // (A resolution a later edit or resolution replaced comes back marked
  // superseded — it neither overlays nor reaches the RESOLVED block.)
  // The deal's own name, industry and listed price are the broker's facts
  // (deal-mirror.ts) — never a tax return's NAICS line or a CRM note's
  // wording, even on facts saved before that rule.
  const settled = settleResolvedFacts(
    (brokerFactsView(deal).extractedInfo as Record<string, unknown>) || {},
    resolvedNotes(await storage.getResolvedDiscrepancies(deal.id)),
  );
  const resolvedDiscrepancies = currentResolvedNotes(settled.notes);
  // Every source entry stamped with its row's visibility (facts1): a
  // broker-only / CRM fact or year never reaches the writer, even on facts
  // recorded before the stamp existed.
  const docs = await storage.getDocumentsByDeal(deal.id);
  const extractedInfo = stampSourceDetails(settled.facts, docs);
  const [branding, insights, analyses, factSourceWords] = await Promise.all([
    storage.getBrandingByBroker(deal.brokerId),
    deal.industry ? storage.getEngagementInsightsByIndustry(deal.industry) : Promise.resolve([]),
    storage.getFinancialAnalysesByDeal(deal.id).catch((): FinancialAnalysis[] => []),
    // A resolved discrepancy overlays the broker's value on a key whose
    // provenance may still name the interview turn — that value's year is
    // the broker's ruling, never stripped as "not said by the seller".
    factSourceWordsFor(deal.id, extractedInfo, new Set(resolvedDiscrepancies.map((n) => n.factKey).filter((k): k is string => !!k)), writtenSourceTexts(docs)),
  ]);
  // The deal's design template may carry the brokerage's house structure
  // ("Match my existing CIM") — the planner follows it.
  const template = await templateForDeal(deal, branding ?? null).catch(() => null);
  return {
    dealId: deal.id,
    businessName: deal.businessName,
    industry: deal.industry,
    // The broker's listed price — a correction on the Information tab wins
    // over the deal column; never a seller's or document's figure.
    askingPrice: listedAskingPrice(deal),
    extractedInfo,
    resolvedDiscrepancies,
    scrapedData: (deal.scrapedData as Record<string, unknown>) || null,
    questionnaireData: (deal.questionnaireData as Record<string, unknown>) || null,
    operationalSystems: (deal.operationalSystems as Record<string, unknown>) || null,
    employeeChart: (deal.employeeChart as unknown[]) || null,
    cimContent: (deal.cimContent as Record<string, string>) || null,
    brokerBranding: branding
      ? { companyName: branding.companyName || undefined, primaryColor: branding.primaryColor }
      : null,
    sectionOutline: template?.sectionOutline ?? null,
    // The broker-reviewed financial analysis (else the latest completed one):
    // statement tables and bridges are copied from it, never rebuilt. One
    // built from a statement since deleted stops generation (cimFinancialsFor).
    financials: cimFinancialsFor(analyses, docs),
    factSourceWords,
    // Items the broker's notes or the facts say must not reach buyers (AI
    // review + rules, cached per content).
    keepOut: await keepOutFor(deal.id, extractedInfo),
    engagementInsights:
      insights.length > 0
        ? insights.map((i) => ({
            sectionType: i.sectionType,
            layoutType: i.layoutType,
            avgTimeSpentSeconds: i.avgTimeSpentSeconds ?? 0,
            sampleCount: i.sampleCount ?? 0,
            completionRate: i.completionRate ?? null,
          }))
        : null,
  };
}

/** Buyer links that can open the CIM right now (not revoked, not expired). */
export function openBuyerLinks(access: Pick<BuyerAccess, "revokedAt" | "expiresAt">[], now = new Date()): number {
  return access.filter((a) => !a.revokedAt && (!a.expiresAt || new Date(a.expiresAt) > now)).length;
}

/**
 * Does replacing this deal's CIM need the broker's review before buyers see
 * it? Yes when buyers could open the old one, or it was live or approved —
 * "Regenerate all" on Pacific (live, 13 buyers) put an unreviewed AI CIM in
 * front of LOI buyers within minutes, with the approvals still showing.
 */
export function replacementNeedsReview(
  deal: Pick<Deal, "isLive" | "contentApprovedByBroker" | "contentApprovedBySeller" | "designApprovedByBroker" | "designApprovedBySeller" | "cimGeneration">,
  openLinks: number,
): boolean {
  return (
    !!deal.isLive ||
    !!deal.contentApprovedByBroker || !!deal.contentApprovedBySeller ||
    !!deal.designApprovedByBroker || !!deal.designApprovedBySeller ||
    openLinks > 0 ||
    !!(deal.cimGeneration as CimGenerationStatus | null | undefined)?.buyerHold
  );
}

/**
 * Replace the deal's stored sections with the generated document. Blind/DD
 * overrides point at the old section ids, so they are cleared in both modes
 * (the old generate-content path left them dangling).
 *
 * When buyers could open the old CIM (or it was live / approved), the new
 * one is held from every buyer until the broker publishes it again, and its
 * content and design approvals are cleared. A LIVE deal stays live: the CIM
 * buyers have — exactly what they are served, with the approved versions of
 * any unapproved changes, and its Blind and DD versions — is kept first
 * (published-snapshot.ts) and every buyer path keeps serving it until the
 * broker publishes the new one (servesPublishedSnapshot). Beacon's rebuild
 * (2026-09-28) put 12 buyers, a due-diligence buyer among them, in front of
 * "not available" until re-publishing. A deal that wasn't live has no
 * buyers reading it; it is simply held (cimHeldFromBuyers).
 * The copy is written BEFORE anything is replaced and is not best-effort:
 * if it fails the run fails and the old sections stay. The hold, the
 * section replacement and the deal's new layout version are then written in
 * ONE transaction (storage.replaceDealCim): if any part fails — a DB error,
 * a redeploy mid-write — nothing changed, the old CIM is still there, live
 * and not held (a copy taken for a write that never landed is never served:
 * only a hold with servingPublished reads it, and the next run replaces it).
 * (Written separately, a failure between the deletes and the last insert
 * left a partial CIM; the hold written only in the job's best-effort status
 * write served the unreviewed CIM to every link holder.)
 */
async function persistDocument(deal: Deal, mode: CimGenerationMode, document: CimDocument, job: CimGenerationJob): Promise<CimGenerationStatus["buyerHold"] | null> {
  // As the deal is now — it may have gone live while the run was writing.
  const current = (await storage.getDeal(deal.id)) ?? deal;
  const [access, ddBefore] = await Promise.all([
    storage.getBuyerAccessByDeal(deal.id).catch((): BuyerAccess[] => []),
    storage.getCimSectionOverrides(deal.id, "dd").catch(() => []),
  ]);
  const links = openBuyerLinks(access);
  const previousHold = (current.cimGeneration as CimGenerationStatus | null | undefined)?.buyerHold ?? null;
  // A live CIM keeps serving its buyers: the version they have is kept
  // (once — a second regeneration before publishing keeps the first copy,
  // which is still what buyers read).
  const keepServing = !!current.isLive;
  const hold: CimGenerationStatus["buyerHold"] | null = replacementNeedsReview(current, links)
    ? {
        since: previousHold?.since ?? new Date().toISOString(),
        wasLive: !!current.isLive || !!previousHold?.wasLive,
        buyers: Math.max(links, previousHold?.buyers ?? 0),
        ddCleared: ddBefore.length > 0 || !!previousHold?.ddCleared,
        ...(keepServing ? { servingPublished: true } : {}),
      }
    : null;
  // Reading analytics: each new section continues the old one it replaces
  // (same key, title or unique page role), so page history survives the new ids.
  const lineage = assignLineage(await storage.getCimSectionsByDeal(deal.id).catch(() => []), document.sections);
  // The CIM buyers read now is kept before anything is replaced (throws —
  // the run then fails and nothing changes).
  if (hold && keepServing && !previousHold?.servingPublished) await takePublishedSnapshot(current);
  const cimContent: Record<string, string> = {};
  const rows = document.sections.map((section, i) => {
    if (section.aiDraftContent) cimContent[section.sectionKey] = section.aiDraftContent;
    return {
      analyticsLineage: lineage[i],
      dealId: deal.id,
      sectionKey: section.sectionKey,
      sectionTitle: section.sectionTitle,
      order: section.order,
      layoutType: section.layoutType,
      layoutData: section.layoutData as any,
      aiLayoutReasoning: section.aiLayoutReasoning,
      tags: section.tags as any,
      aiDraftContent: section.aiDraftContent || null,
      isVisible: section.isVisible,
      brokerApproved: false,
      figureWarnings: section.figureWarnings?.length ? section.figureWarnings : null,
    };
  });
  const updates: Record<string, unknown> = {
    cimLayoutGeneratedAt: new Date(),
    cimLayoutVersion: (deal.cimLayoutVersion || 0) + 1,
  };
  if (hold) {
    Object.assign(updates, {
      cimGeneration: { ...storedStatus(job), buyerHold: hold },
      // The approvals were for the CIM that is about to be replaced. A deal
      // that wasn't live stays unpublished until the broker publishes it; a
      // live one stays live, its buyers reading the kept copy.
      ...(keepServing ? {} : { isLive: false }),
      contentApprovedByBroker: false,
      contentApprovedBySeller: false,
      designApprovedByBroker: false,
      designApprovedBySeller: false,
    });
  }
  if (mode === "content") {
    updates.cimContent = cimContent;
    // Moves an earlier deal into Content Creation; a full regenerate on a
    // Design-phase deal must not drag it back to phase 3.
    if (phaseIndex(deal.phase) < phaseIndex("phase3_content_creation")) updates.phase = "phase3_content_creation";
  }
  // (Also drops the approved versions on record — they were of the sections
  // being replaced: published-versions.ts; same transaction.)
  await storage.replaceDealCim(deal.id, rows as any, updates as any);
  // On the job only once it is on the deal: a failed write leaves the old
  // CIM in place, live, and not held.
  if (hold) job.buyerHold = hold;
  return hold;
}

/**
 * Runs before any section is written — the discrepancy gate (see
 * cim/discrepancy-check.ts ensureDiscrepancyGate): runs the check when it is
 * missing or stale and throws when a critical conflict is open.
 */
export type BeforeWriting = (onChecking: () => void) => Promise<unknown>;

async function run(job: CimGenerationJob, deal: Deal, beforeWriting?: BeforeWriting) {
  const touch = () => { job.updatedAt = new Date().toISOString(); };
  try {
    if (beforeWriting) {
      await beforeWriting(() => {
        job.phase = "checking";
        touch();
        void persist(job);
      });
      job.phase = "planning";
      touch();
      // The check may have changed facts' discrepancies — build from the deal as it is now.
      deal = (await storage.getDeal(deal.id)) ?? deal;
    }
    const params = await buildLayoutParams(deal, job.mode);
    // What the writer is given, kept to show the broker later which sections
    // still carry a value that has since changed (cim-staleness.ts).
    const factsAt = await writerFactsSnapshot(deal).catch(() => null);
    const document = await generator(params, (p) => {
      job.phase = p.phase;
      job.total = p.total;
      job.done = p.done;
      if (p.lastTitle) job.completedTitles.push(p.lastTitle);
      touch();
      void persist(job);
    });
    // A run the AI service mostly failed never replaces the deal's CIM (the
    // broker's edits, approvals, tiers, Blind and DD versions): it fails
    // honestly and the current CIM stays (generation-shortfall.ts).
    const existing = await storage.getCimSectionsByDeal(deal.id);
    const shortfall = generationShortfall(document.sections, { hasExistingCim: existing.length > 0, aiError: document.aiError });
    if (shortfall) throw new Error(shortfall.message);
    job.phase = "saving";
    touch();
    await persist(job);
    const hold = await persistDocument(deal, job.mode, document, job);
    if (hold) {
      if (hold.ddCleared) {
        document.warnings = [
          ...(document.warnings ?? []),
          hold.servingPublished
            ? "The new CIM has no due-diligence version yet (due-diligence buyers keep the previous one until you publish). Generate it before you publish the update."
            : "The due-diligence version was cleared with the old sections. Generate it again before due-diligence buyers see enriched content.",
        ];
      }
    }
    if (factsAt) job.factsAt = factsAt;
    job.status = "done";
    job.phase = "finished";
    job.total = document.sections.length;
    job.done = document.sections.length;
    job.sectionCount = document.sections.length;
    job.warnings = document.warnings ?? [];
    job.heldPrivate = document.heldPrivate ?? [];
  } catch (err: any) {
    if (err?.name === "DiscrepancyGateError") console.log(`[cim-generation] deal ${job.dealId} stopped at the discrepancy gate: ${err.message}`);
    else console.error(`[cim-generation] deal ${job.dealId} failed:`, err);
    job.status = "failed";
    job.phase = "finished";
    // An AI service error (credits, overload, planning call failed) in the
    // broker's words — not the API's raw JSON — and only "try again in a few
    // minutes" when that can help (not for credits out or a rejected key).
    // Nothing was written.
    if (typeof err?.status === "number") {
      const why = describeAiFailure(err);
      job.error = `The AI service failed (${why.reason}) before the CIM was written. Your current CIM was not changed — ${why.advice}.`;
    } else {
      job.error = err?.message || "CIM generation failed";
    }
    if (err?.name === "DiscrepancyGateError") {
      job.stoppedBy = "discrepancies";
      job.stoppedReason = err.reason === "new" ? "new" : "critical";
      job.blockingDiscrepancies = err.blocking;
    }
  }
  job.finishedAt = new Date().toISOString();
  touch();
  await persist(job);
  setTimeout(() => {
    if (jobs.get(job.dealId) === job) jobs.delete(job.dealId);
  }, FINISHED_RETENTION_MS).unref();
}

/**
 * Start generating the deal's CIM in the background. Resolves as soon as the
 * job is registered and its "running" status persisted. Throws
 * CimGenerationRunningError if a job is already running for the deal.
 */
export async function startCimGeneration(
  deal: Deal,
  mode: CimGenerationMode,
  opts: { beforeWriting?: BeforeWriting } = {},
): Promise<CimGenerationJob> {
  const existing = jobs.get(deal.id);
  if (existing?.status === "running") throw new CimGenerationRunningError(existing);
  const now = new Date().toISOString();
  // A hold from an earlier run stays until the broker publishes, whatever
  // this run does (fails, stops at the gate); so do the facts it wrote from.
  const previous = deal.cimGeneration as CimGenerationStatus | null | undefined;
  const job: CimGenerationJob = {
    ...(previous?.buyerHold ? { buyerHold: previous.buyerHold } : {}),
    ...(previous?.factsAt ? { factsAt: previous.factsAt } : {}),
    ...(previous?.heldPrivate ? { heldPrivate: previous.heldPrivate } : {}),
    dealId: deal.id,
    brokerId: deal.brokerId,
    businessName: deal.businessName,
    status: "running",
    mode,
    phase: "planning",
    total: 0,
    done: 0,
    startedAt: now,
    updatedAt: now,
    warnings: [],
    completedTitles: [],
  };
  jobs.set(deal.id, job);
  await persist(job);
  void run(job, deal, opts.beforeWriting);
  return job;
}

/**
 * Current status for a deal: the live job if there is one, else the persisted
 * record. A persisted "running" with no live job means the server restarted
 * mid-run — reported as failed so the UI never spins forever.
 */
export function getCimGenerationStatus(deal: Deal): CimGenerationStatus | null {
  const live = jobs.get(deal.id);
  if (live) return toStatus(live);
  return getStoredCimGenerationStatus(deal);
}

/** Live job status only — lets the polling endpoint skip the deal read. */
export function getLiveCimGenerationStatus(dealId: string): CimGenerationStatus | null {
  const live = jobs.get(dealId);
  return live ? toStatus(live) : null;
}

function getStoredCimGenerationStatus(deal: Deal): CimGenerationStatus | null {
  const raw = deal.cimGeneration as CimGenerationStatus | null | undefined;
  if (!raw) return null;
  const { factsAt: _f, ...stored } = raw;
  if (stored.status === "running") {
    return {
      ...stored,
      status: "failed",
      phase: "finished",
      error: "Generation was interrupted by a server restart. Start it again.",
      finishedAt: stored.finishedAt ?? stored.updatedAt,
    };
  }
  return stored;
}

/**
 * The broker published the CIM: buyers may see it again. Clears the hold on
 * the live job (so it isn't written back) and on the stored status.
 */
export async function releaseBuyerHold(dealId: string): Promise<void> {
  const live = jobs.get(dealId);
  const liveHold = live?.buyerHold ?? null;
  if (live) delete live.buyerHold;
  const deal = await storage.getDeal(dealId);
  const stored = deal?.cimGeneration as CimGenerationStatus | null | undefined;
  const hold = stored?.buyerHold ?? liveHold;
  if (!hold) return;
  if (stored?.buyerHold) {
    const { buyerHold: _h, ...rest } = stored;
    await storage.updateDeal(dealId, { cimGeneration: rest } as any);
  }
  // The version buyers kept reading meanwhile is replaced by the published one.
  await dropPublishedSnapshot(dealId).catch((err) => console.warn(`[cim-generation] could not drop the kept CIM for deal ${dealId}:`, err));
  // Buyers who kept reading the previous version were never held: their
  // review clocks run on. Buyers who were held get a fresh window on the
  // published one (no reminder or lapse was sent while it was held).
  if (hold.servingPublished) return;
  try {
    const { restartReminderClocks } = await import("../reminders/decision-reminders");
    await restartReminderClocks(dealId, hold.since);
  } catch (err) {
    console.warn(`[cim-generation] could not restart buyer review clocks for deal ${dealId}:`, err);
  }
}

/** The facts the last finished run wrote from (null before the first, or on older runs). */
export function lastGenerationFacts(deal: Deal): CimGenerationStatus["factsAt"] | null {
  const live = jobs.get(deal.id);
  if (live?.status === "done" && live.factsAt) return live.factsAt;
  return (deal.cimGeneration as CimGenerationStatus | null | undefined)?.factsAt ?? null;
}

/** Live jobs (running, or finished recently) for one broker's deals. */
export function listBrokerCimGeneration(brokerId: string): CimGenerationJob[] {
  return Array.from(jobs.values())
    .filter((j) => j.brokerId === brokerId)
    .map(({ factsAt: _f, ...j }) => j as CimGenerationJob);
}
