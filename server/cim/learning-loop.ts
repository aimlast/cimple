/**
 * learning-loop.ts
 *
 * Aggregates buyer engagement events into the engagementInsights table.
 * Called asynchronously after each analytics batch is saved.
 *
 * For each section_exit event:
 *   - Looks up the CimSection to get its layoutType
 *   - Looks up the deal to get its industry
 *   - Upserts an EngagementInsight row with a rolling weighted average
 *
 * This feeds back into the layout engine at generation time, so the AI
 * progressively learns which layouts perform best per industry + section type.
 */
import type { IStorage } from "../storage.js";

interface AnalyticsEventLike {
  eventType: string;
  sectionKey?: string | null;
  timeSpentSeconds?: number | null;
  scrollDepthPercent?: number | null;
}

export async function aggregateEngagementInsights(
  dealId: string,
  events: AnalyticsEventLike[],
  storage: IStorage
): Promise<void> {
  // Only process section_exit events that have timing data
  const exitEvents = events.filter(
    e => e.eventType === "section_exit" && e.sectionKey && e.timeSpentSeconds
  );

  if (exitEvents.length === 0) return;

  // Fetch deal + sections once (shared across all events in this batch)
  const [deal, sections] = await Promise.all([
    storage.getDeal(dealId),
    storage.getCimSectionsByDeal(dealId),
  ]);

  if (!deal?.industry) return;

  const industry = deal.industry;

  // Build a sectionKey → layoutType lookup
  const layoutByKey: Record<string, string> = {};
  for (const s of sections) {
    if (s.sectionKey && s.layoutType) {
      layoutByKey[s.sectionKey] = s.layoutType;
    }
  }

  // Process each exit event — fire-and-forget errors so one bad row can't
  // block the rest of the batch
  const promises = exitEvents.map(async e => {
    const sectionKey = e.sectionKey!;
    const layoutType = layoutByKey[sectionKey];
    if (!layoutType) return; // section not found or no layout yet

    try {
      await storage.upsertEngagementInsight(industry, sectionKey, layoutType, {
        timeSeconds: e.timeSpentSeconds!,
        scrollDepth: e.scrollDepthPercent ?? undefined,
      });
    } catch (err) {
      // Non-critical — log but don't throw
      console.warn(`[learning-loop] Failed to upsert insight for ${industry}/${sectionKey}/${layoutType}:`, err);
    }
  });

  await Promise.allSettled(promises);
}
