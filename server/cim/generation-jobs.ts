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
import type { CimGenerationStatus, Deal } from "@shared/schema";

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
 * Build the layout-engine params from a deal. Content mode overlays resolved
 * discrepancies onto extractedInfo (the broker's accepted values win);
 * layout mode uses extractedInfo as stored, matching the old endpoints.
 */
async function buildLayoutParams(deal: Deal, mode: CimGenerationMode): Promise<CimLayoutParams> {
  const extractedInfo = { ...((deal.extractedInfo as Record<string, unknown>) || {}) };
  if (mode === "content") {
    const resolved = await storage.getResolvedDiscrepancies(deal.id);
    for (const d of resolved) {
      if (d.resolvedValue && d.field) extractedInfo[d.field] = d.resolvedValue;
    }
  }
  const [branding, insights] = await Promise.all([
    storage.getBrandingByBroker(deal.brokerId),
    deal.industry ? storage.getEngagementInsightsByIndustry(deal.industry) : Promise.resolve([]),
  ]);
  return {
    dealId: deal.id,
    businessName: deal.businessName,
    industry: deal.industry,
    askingPrice: deal.askingPrice,
    extractedInfo,
    scrapedData: (deal.scrapedData as Record<string, unknown>) || null,
    questionnaireData: (deal.questionnaireData as Record<string, unknown>) || null,
    operationalSystems: (deal.operationalSystems as Record<string, unknown>) || null,
    employeeChart: (deal.employeeChart as unknown[]) || null,
    cimContent: (deal.cimContent as Record<string, string>) || null,
    brokerBranding: branding
      ? { companyName: branding.companyName || undefined, primaryColor: branding.primaryColor }
      : null,
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
    updates.phase = "phase3_content_creation";
  }
  await storage.updateDeal(deal.id, updates as any);
}

async function run(job: CimGenerationJob, deal: Deal) {
  const touch = () => { job.updatedAt = new Date().toISOString(); };
  try {
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
    console.error(`[cim-generation] deal ${job.dealId} failed:`, err);
    job.status = "failed";
    job.phase = "finished";
    job.error = err?.message || "CIM generation failed";
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
export async function startCimGeneration(deal: Deal, mode: CimGenerationMode): Promise<CimGenerationJob> {
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
  void run(job, deal);
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
