/**
 * editableText — which CIM layouts are edited as free text, and what text
 * that editor should show.
 *
 * FREE-TEXT LAYOUTS (edit with a textarea → `brokerEditedContent`):
 *   prose_highlight  — body prose. brokerEditedContent replaces layoutData.body.
 *   two_column       — the narrative column. brokerEditedContent replaces the
 *                      first prose column's content (the right/structured
 *                      column is untouched).
 *   unknown / legacy — sections with no registered renderer show the raw
 *                      content string, so it is edited directly.
 *
 * STRUCTURED LAYOUTS (edit with StructuredDataEditor → `layoutData`):
 *   cover_page, metric_grid, bar_chart, horizontal_bar_chart, pie_chart,
 *   donut_chart, line_chart, timeline, financial_table, comparison_table,
 *   callout_list, icon_stat_row, org_chart, location_card, stat_callout,
 *   numbered_list, scorecard, waterfall_chart, divider.
 *   These renderers draw from layoutData only; `aiDraftContent` is usually
 *   null for them and `brokerEditedContent` would never be shown — which is
 *   why the text editor is not offered for them.
 *
 * Rule: the text the broker sees in the editor is exactly the text the
 * renderer shows, and saving it changes what the renderer shows.
 */
import type { CimSection } from "@shared/schema";

export const TEXT_EDITABLE_LAYOUTS = new Set(["prose_highlight", "two_column"]);

export const STRUCTURED_LAYOUTS = new Set([
  "cover_page", "metric_grid", "bar_chart", "horizontal_bar_chart", "pie_chart",
  "donut_chart", "line_chart", "timeline", "financial_table", "comparison_table",
  "callout_list", "icon_stat_row", "org_chart", "location_card", "stat_callout",
  "numbered_list", "scorecard", "waterfall_chart", "divider",
]);

/** True when a free-text editor is the right tool for this section. */
export function isTextEditableLayout(layoutType: string | null | undefined): boolean {
  if (!layoutType) return true;
  if (TEXT_EDITABLE_LAYOUTS.has(layoutType)) return true;
  // Unregistered layouts fall back to a prose renderer — text is all there is.
  return !STRUCTURED_LAYOUTS.has(layoutType);
}

/** True when the structured (layoutData) editor should be offered. */
export function isStructuredLayout(layoutType: string | null | undefined): boolean {
  return !!layoutType && STRUCTURED_LAYOUTS.has(layoutType) && layoutType !== "divider";
}

interface ColumnLike { content?: unknown; layoutType?: string }

/** Index of the column (left=0, right=1) whose content is narrative prose, or -1. */
export function findProseColumnIndex(layoutData: Record<string, unknown> | null | undefined): number {
  if (!layoutData) return -1;
  const cols = [layoutData.left, layoutData.right] as Array<ColumnLike | undefined>;
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (!c || typeof c.content !== "string") continue;
    const type = c.layoutType || "prose";
    if (type === "prose") return i;
  }
  return -1;
}

/** The prose a prose_highlight section currently renders. */
export function resolveProseBody(section: Pick<CimSection, "brokerEditedContent" | "aiDraftContent" | "layoutData">): string {
  const data = (section.layoutData as Record<string, unknown> | null) || {};
  return section.brokerEditedContent || (typeof data.body === "string" ? data.body : "") || section.aiDraftContent || "";
}

/** The text the free-text editor should be seeded with for this section. */
export function getEditableText(section: Pick<CimSection, "layoutType" | "brokerEditedContent" | "aiDraftContent" | "layoutData">): string {
  if (section.brokerEditedContent) return section.brokerEditedContent;
  const data = (section.layoutData as Record<string, unknown> | null) || {};
  if (section.layoutType === "prose_highlight") {
    return (typeof data.body === "string" ? data.body : "") || section.aiDraftContent || "";
  }
  if (section.layoutType === "two_column") {
    const idx = findProseColumnIndex(data);
    if (idx >= 0) {
      const col = (idx === 0 ? data.left : data.right) as ColumnLike;
      return (typeof col.content === "string" ? col.content : "") || section.aiDraftContent || "";
    }
    return section.aiDraftContent || "";
  }
  return section.aiDraftContent || "";
}
