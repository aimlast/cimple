/**
 * section-tasks — background AI work on one CIM section.
 *
 *   write       fill a newly added section from the deal's facts
 *   regenerate  rebuild an existing section from the deal's facts
 *   rewrite     the AI writer: a proposal (instructions, tone, length) the
 *               broker previews, then applies or discards
 *   convert     move the section's content into another layout type
 *
 * Each call to Claude takes 15-60s, so the request only starts the task and
 * returns; progress lives on the section row (`ai_task`) and the builder
 * polls. A task that was running when the server restarted is reported as
 * failed (never an endless spinner). One task per section at a time.
 *
 * Every applied result pushes the previous version onto the section's undo
 * stack and invalidates its blind version.
 */
import { randomUUID } from "crypto";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { cimSections, type CimSection, type CimSectionAiTask, type Deal } from "@shared/schema";
import { normalizeLayoutType } from "@shared/cim-layouts";
import { buildLayoutParams } from "./generation-jobs";
import {
  groundLocationMap,
  convertSectionLayout,
  rewriteSectionContent,
  sectionFigureWarnings,
  writeOneSection,
  type RewriteLength,
} from "./layout-engine";
import { invalidateBlind } from "./blind-sync";
import { displayedProse, historyWith, withStaleStamps } from "./section-ops";
import { isMediaLayout } from "@shared/cim-media";
import { cleanMediaLayoutForDeal } from "./media-store";

type TaskKind = CimSectionAiTask["kind"];
export type TaskRequest = NonNullable<CimSectionAiTask["request"]>;

const live = new Map<string, string>(); // sectionId → running task id

export class SectionTaskRunningError extends Error {
  constructor() {
    super("The AI is already working on this section — wait for it to finish.");
    this.name = "SectionTaskRunningError";
  }
}

/** The task as the builder should see it (a restart-orphaned run = failed). */
export function normalizeTask(sectionId: string, task: unknown): CimSectionAiTask | null {
  const t = task as CimSectionAiTask | null | undefined;
  if (!t || typeof t !== "object") return null;
  if (t.status === "running" && live.get(sectionId) !== t.id) {
    return {
      ...t,
      status: "failed",
      error: "This was interrupted by a server restart. Please try again.",
      finishedAt: t.finishedAt ?? t.startedAt,
    };
  }
  return t;
}

export function isTaskRunning(sectionId: string): boolean {
  return live.has(sectionId);
}

async function readSection(id: string): Promise<CimSection | undefined> {
  const [row] = await db.select().from(cimSections).where(eq(cimSections.id, id));
  return row;
}

/** Still the task we started? (Deleted section / discarded task → false.) */
async function stillCurrent(sectionId: string, taskId: string): Promise<CimSection | null> {
  const row = await readSection(sectionId);
  const t = row?.aiTask as CimSectionAiTask | null | undefined;
  return row && t?.id === taskId ? row : null;
}

async function setTask(sectionId: string, task: CimSectionAiTask | null) {
  await db.update(cimSections).set({ aiTask: task }).where(eq(cimSections.id, sectionId));
}

/** Keep the legacy cimContent map (fed back into later generations) in step. */
async function syncCimContent(deal: Deal, sectionKey: string, text: string | null | undefined) {
  if (!text) return;
  const fresh = await storage.getDeal(deal.id);
  const existing = ((fresh?.cimContent ?? deal.cimContent) as Record<string, string> | null) || {};
  await storage.updateDeal(deal.id, { cimContent: { ...existing, [sectionKey]: text } } as any);
}

async function run(section: CimSection, deal: Deal, task: CimSectionAiTask) {
  try {
    const params = await buildLayoutParams(deal, "content");
    const current = {
      sectionKey: section.sectionKey,
      sectionTitle: section.sectionTitle,
      layoutType: section.layoutType,
      layoutData: section.layoutData,
      prose: displayedProse(section),
    };

    if (task.kind === "rewrite") {
      const req = task.request || {};
      const proposal = await rewriteSectionContent(params, current, {
        instructions: req.instructions,
        tones: req.tones,
        length: req.length as RewriteLength | undefined,
      });
      if (!(await stillCurrent(section.id, task.id))) return;
      const proposalWarnings = sectionFigureWarnings(params, { ...current, layoutData: proposal.layoutData, tags: section.tags });
      await setTask(section.id, {
        ...task,
        status: "ready",
        finishedAt: new Date().toISOString(),
        proposal: {
          layoutData: proposal.layoutData,
          aiDraftContent: proposal.aiDraftContent ?? null,
          ...(proposalWarnings.length ? { figureWarnings: proposalWarnings } : {}),
        },
      });
      return;
    }

    let result: { layoutData: Record<string, unknown>; aiDraftContent?: string };
    let layoutType = normalizeLayoutType(section.layoutType);
    // Figures/names the check couldn't trace to the deal (figure-check.ts).
    let figureWarnings: string[] = [];
    if (task.kind === "convert") {
      layoutType = normalizeLayoutType(task.request?.layoutType);
      result = await convertSectionLayout(params, current, layoutType);
      figureWarnings = sectionFigureWarnings(params, { sectionTitle: section.sectionTitle, layoutType, layoutData: result.layoutData, tags: section.tags });
    } else {
      // write / regenerate — the rest of the CIM is sibling context. A new
      // section is left out of its own sibling list so it is written fresh.
      const siblings = (await storage.getCimSectionsByDeal(deal.id))
        .filter((s) => task.kind === "regenerate" || s.id !== section.id)
        .map((s) => ({
          sectionKey: s.sectionKey,
          sectionTitle: s.sectionTitle,
          order: s.order,
          layoutType: s.layoutType,
          tags: s.tags,
          aiLayoutReasoning: s.aiLayoutReasoning,
        }));
      const written = await writeOneSection(
        params,
        siblings,
        {
          sectionKey: section.sectionKey,
          sectionTitle: section.sectionTitle,
          order: section.order,
          layoutType,
          tags: section.tags,
          aiLayoutReasoning: section.aiLayoutReasoning,
        },
        { brief: task.request?.brief },
      );
      result = { layoutData: written.layoutData as Record<string, unknown>, aiDraftContent: written.aiDraftContent };
      layoutType = normalizeLayoutType(written.layoutType);
      figureWarnings = written.figureWarnings ?? [];
    }

    // Maps only show addresses from the deal's facts; photo/video sections
    // only this deal's uploads (the AI can't add those — see cim-builder).
    if (layoutType === "location_map") result.layoutData = groundLocationMap(result.layoutData, params);
    if (isMediaLayout(layoutType)) result.layoutData = await cleanMediaLayoutForDeal(layoutType, result.layoutData, deal.id);

    const row = await stillCurrent(section.id, task.id);
    if (!row) return;
    const reason = task.kind === "convert" ? "Converted layout with AI" : task.kind === "regenerate" ? "Regenerated with AI" : "Written with AI";
    await db
      .update(cimSections)
      .set({
        layoutType,
        layoutData: result.layoutData as any,
        aiDraftContent: result.aiDraftContent ?? null,
        figureWarnings: figureWarnings.length ? figureWarnings : null,
        // The new text lives in layoutData / the AI draft now.
        brokerEditedContent: null,
        brokerApproved: false,
        ...(task.kind === "convert" && layoutType !== row.layoutType
          ? { layoutOverride: row.layoutOverride || row.layoutType }
          : {}),
        // A brand-new section has nothing worth undoing back to.
        ...(task.kind === "write" ? {} : { contentHistory: historyWith(row, reason) }),
        aiTask: null,
        updatedAt: new Date(),
      })
      .where(eq(cimSections.id, section.id));
    await invalidateBlind(deal.id, [section.id]);
    await syncCimContent(deal, section.sectionKey, result.aiDraftContent);
  } catch (err: any) {
    console.error(`[section-tasks] ${task.kind} failed for section ${section.id}:`, err);
    if (await stillCurrent(section.id, task.id)) {
      await setTask(section.id, {
        ...task,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: err?.message || "The AI couldn't finish this. Please try again.",
      });
    }
  } finally {
    if (live.get(section.id) === task.id) live.delete(section.id);
  }
}

/**
 * Start a background AI task on a section. Resolves once the task is
 * recorded on the row; the work continues after the response is sent.
 */
export async function startSectionTask(
  section: CimSection,
  deal: Deal,
  kind: TaskKind,
  request: TaskRequest = {},
): Promise<CimSectionAiTask> {
  if (live.has(section.id)) throw new SectionTaskRunningError();
  const task: CimSectionAiTask = {
    id: randomUUID(),
    kind,
    status: "running",
    startedAt: new Date().toISOString(),
    request,
  };
  live.set(section.id, task.id);
  try {
    await setTask(section.id, task);
  } catch (err) {
    live.delete(section.id);
    throw err;
  }
  void run(section, deal, task);
  return task;
}

/** Apply a ready rewrite proposal. Null when there is no proposal to apply. */
export async function applyRewrite(section: CimSection): Promise<CimSection | null> {
  const task = normalizeTask(section.id, section.aiTask);
  if (!task || task.kind !== "rewrite" || task.status !== "ready" || !task.proposal) return null;
  const [updated] = await db
    .update(cimSections)
    .set({
      layoutData: task.proposal.layoutData as any,
      aiDraftContent: task.proposal.aiDraftContent ?? null,
      figureWarnings: task.proposal.figureWarnings?.length ? task.proposal.figureWarnings : null,
      brokerEditedContent: null,
      brokerApproved: false,
      contentHistory: historyWith(section, "AI rewrite"),
      aiTask: null,
      updatedAt: new Date(),
    })
    .where(eq(cimSections.id, section.id))
    .returning();
  const at = await invalidateBlind(section.dealId, [section.id]);
  return updated ? withStaleStamps(updated, at) : null;
}

/** Drop a proposal or a failed/finished task marker (never a running one). */
export async function clearTask(section: CimSection): Promise<boolean> {
  if (live.has(section.id)) return false;
  await setTask(section.id, null);
  return true;
}
