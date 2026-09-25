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
import { storage } from "../storage";
import { generateCimLayout, type CimLayoutParams, type LayoutProgress } from "./layout-engine";
import type { CimDocument } from "./layout-types";
import { templateForDeal } from "./templates";
import type { CimGenerationStatus, Deal } from "@shared/schema";
import { phaseIndex } from "@shared/deal-progress";
import { listedAskingPrice } from "../information/deal-mirror";
import { overlayResolvedFacts, resolvedNotes } from "./resolved-block";
import { stampSourceDetails } from "../documents/merge-policy";

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

function toStatus(job: CimGenerationJob): CimGenerationStatus {
  const { dealId: _d, brokerId: _b, businessName: _n, ...status } = job;
  return status;
}

/** Best-effort persistence — a failed status write must never kill the run. */
async function persist(job: CimGenerationJob) {
  try {
    await storage.updateDeal(job.dealId, { cimGeneration: toStatus(job) } as any);
  } catch (err) {
    console.warn(`[cim-generation] could not persist status for deal ${job.dealId}:`, err);
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
  const resolvedDiscrepancies = resolvedNotes(await storage.getResolvedDiscrepancies(deal.id));
  // Every source entry stamped with its row's visibility (facts1): a
  // broker-only / CRM fact or year never reaches the writer, even on facts
  // recorded before the stamp existed.
  const extractedInfo = stampSourceDetails(
    overlayResolvedFacts((deal.extractedInfo as Record<string, unknown>) || {}, resolvedDiscrepancies),
    await storage.getDocumentsByDeal(deal.id),
  );
  const [branding, insights] = await Promise.all([
    storage.getBrandingByBroker(deal.brokerId),
    deal.industry ? storage.getEngagementInsightsByIndustry(deal.industry) : Promise.resolve([]),
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
    engagementInsights:
      insights.length > 0
        ? insights.map((i) => ({
            sectionType: i.sectionType,
            layoutType: i.layoutType,
            avgTimeSpentSeconds: i.avgTimeSpentSeconds ?? 0,
            sampleCount: i.sampleCount ?? 0,
          }))
        : null,
  };
}

/**
 * Replace the deal's stored sections with the generated document. Blind/DD
 * overrides point at the old section ids, so they are cleared in both modes
 * (the old generate-content path left them dangling).
 */
async function persistDocument(deal: Deal, mode: CimGenerationMode, document: CimDocument) {
  await storage.deleteCimSectionsForDeal(deal.id);
  await storage.deleteCimSectionOverrides(deal.id, "blind");
  await storage.deleteCimSectionOverrides(deal.id, "dd");
  const cimContent: Record<string, string> = {};
  for (const section of document.sections) {
    await storage.createCimSection({
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
    await persistDocument(deal, job.mode, document);
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
  const job: CimGenerationJob = {
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
  const stored = deal.cimGeneration as CimGenerationStatus | null | undefined;
  if (!stored) return null;
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

/** Live jobs (running, or finished recently) for one broker's deals. */
export function listBrokerCimGeneration(brokerId: string): CimGenerationJob[] {
  return Array.from(jobs.values()).filter((j) => j.brokerId === brokerId);
}
