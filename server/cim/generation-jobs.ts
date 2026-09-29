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
import type { BuyerAccess, CimGenerationStatus, Deal, FinancialAnalysis } from "@shared/schema";
import { phaseIndex } from "@shared/deal-progress";
import { listedAskingPrice } from "../information/deal-mirror";
import { brokerFactsView } from "../information/facts";
import { settleResolvedFacts, currentResolvedNotes, resolvedNotes } from "./resolved-block";
import { stampSourceDetails } from "../documents/merge-policy";
import { cimFinancialsFor } from "./cim-financials";
import { keepOutFor } from "./keep-out";
import { hasMonthYear } from "./fact-dates";
import { getFieldSources, isFactKey } from "../interview/info-merger";
import { factValueText } from "../information/cim-facts";
import { db } from "../db";
import { interviewSessions } from "@shared/schema";
import { eq } from "drizzle-orm";
import { writerFactsSnapshot } from "./cim-staleness";

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
): Promise<Record<string, { words: string; at: string }>> {
  const sources = getFieldSources(info);
  const wanted = Object.entries(sources).filter(
    ([key, s]) => isFactKey(key) && !brokerSettled.has(key) && s?.sessionId && typeof s.turn === "number" && s.at && key in info && hasMonthYear(factValueText(info[key])),
  );
  if (wanted.length === 0) return {};
  try {
    const rows = await db.select({ id: interviewSessions.id, messages: interviewSessions.messages }).from(interviewSessions).where(eq(interviewSessions.dealId, dealId));
    const byId = new Map(rows.map((r) => [r.id, Array.isArray(r.messages) ? (r.messages as Array<{ role?: string; content?: unknown }>) : []]));
    const out: Record<string, { words: string; at: string }> = {};
    for (const [key, s] of wanted) {
      // `turn` counts the seller's messages (1-based) in that session.
      const seller = (byId.get(s.sessionId!) ?? []).filter((m) => m?.role === "user");
      const msg = seller[s.turn! - 1];
      const words = typeof msg?.content === "string" ? msg.content : "";
      if (words) out[key] = { words, at: s.at! };
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
    factSourceWordsFor(deal.id, extractedInfo, new Set(resolvedDiscrepancies.map((n) => n.factKey).filter((k): k is string => !!k))),
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
 * one is held from every buyer until the broker publishes it again: the deal
 * leaves live, its content and design approvals are cleared (the view room
 * shows buyers a "being updated" state meanwhile — see cimHeldFromBuyers).
 * The hold is written with those changes BEFORE a single section is
 * replaced, and that write is not best-effort: if it fails the run fails
 * and the old sections stay. (Written only in the job's final status
 * write, which swallows errors, a failed write — or the moment before it —
 * served the unreviewed CIM to every link holder.)
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
  const hold = replacementNeedsReview(current, links)
    ? {
        since: previousHold?.since ?? new Date().toISOString(),
        wasLive: !!current.isLive || !!previousHold?.wasLive,
        buyers: Math.max(links, previousHold?.buyers ?? 0),
        ddCleared: ddBefore.length > 0 || !!previousHold?.ddCleared,
      }
    : null;
  if (hold) {
    // On the job only once it is on the deal: a failed write leaves the old
    // CIM in place, live, and not held.
    await storage.updateDeal(deal.id, {
      cimGeneration: { ...storedStatus(job), buyerHold: hold },
      // The approvals were for the CIM that is about to be replaced.
      isLive: false,
      contentApprovedByBroker: false,
      contentApprovedBySeller: false,
      designApprovedByBroker: false,
      designApprovedBySeller: false,
    } as any);
    job.buyerHold = hold;
  }
  // Reading analytics: each new section continues the old one it replaces
  // (same key, title or unique page role), so page history survives the new ids.
  const lineage = assignLineage(await storage.getCimSectionsByDeal(deal.id).catch(() => []), document.sections);
  await storage.deleteCimSectionsForDeal(deal.id);
  await storage.deleteCimSectionOverrides(deal.id, "blind");
  await storage.deleteCimSectionOverrides(deal.id, "dd");
  const cimContent: Record<string, string> = {};
  for (let i = 0; i < document.sections.length; i++) {
    const section = document.sections[i];
    await storage.createCimSection({
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
    });
    if (section.aiDraftContent) cimContent[section.sectionKey] = section.aiDraftContent;
  }
  const updates: Record<string, unknown> = {
    cimLayoutGeneratedAt: new Date(),
    cimLayoutVersion: (deal.cimLayoutVersion || 0) + 1,
  };
  if (mode === "content") {
    updates.cimContent = cimContent;
    // Moves an earlier deal into Content Creation; a full regenerate on a
    // Design-phase deal must not drag it back to phase 3.
    if (phaseIndex(deal.phase) < phaseIndex("phase3_content_creation")) updates.phase = "phase3_content_creation";
  }
  await storage.updateDeal(deal.id, updates as any);
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
    job.phase = "saving";
    touch();
    await persist(job);
    const hold = await persistDocument(deal, job.mode, document, job);
    if (hold) {
      if (hold.ddCleared) document.warnings = [...(document.warnings ?? []), "The due-diligence version was cleared with the old sections. Generate it again before due-diligence buyers see enriched content."];
    }
    if (factsAt) job.factsAt = factsAt;
    job.status = "done";
    job.phase = "finished";
    job.total = document.sections.length;
    job.done = document.sections.length;
    job.sectionCount = document.sections.length;
    job.warnings = document.warnings ?? [];
  } catch (err: any) {
    if (err?.name === "DiscrepancyGateError") console.log(`[cim-generation] deal ${job.dealId} stopped at the discrepancy gate: ${err.message}`);
    else console.error(`[cim-generation] deal ${job.dealId} failed:`, err);
    job.status = "failed";
    job.phase = "finished";
    job.error = err?.message || "CIM generation failed";
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
  // Buyers who were deciding on the replaced CIM get a fresh review window
  // on the published one (no reminder or lapse was sent while it was held).
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
