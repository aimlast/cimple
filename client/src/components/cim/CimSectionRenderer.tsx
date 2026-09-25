/**
 * CimSectionRenderer
 *
 * Dispatches a CIM section to the correct renderer based on layoutType.
 * This is the single entry point — every section in every CIM passes through here.
 *
 * The renderer map is typed against the layout registry (shared/cim-layouts.ts):
 * adding a layout there without a renderer here is a compile error. A layout
 * type outside the registry (legacy rows) falls back to its prose, or — when
 * there is none — is hidden from buyers. Raw JSON is never shown to a buyer.
 */
import type { ComponentType } from "react";
import type { CimSection } from "@shared/schema";
import { LOCKED_LAYOUT_TYPE, type CimLayoutKey } from "@shared/cim-layouts";
import type { CimBranding } from "./CimBrandingContext";
import { useSectionNumber, useThemeStyle } from "./CimDesignContext";
import { CimSectionHeading } from "./CimSectionHeading";

import { MetricGridRenderer }         from "./renderers/MetricGrid";
import { BarChartRenderer }           from "./renderers/BarChart";
import { HorizontalBarChartRenderer } from "./renderers/HorizontalBarChart";
import { PieChartRenderer }           from "./renderers/PieChart";
import { LineChartRenderer }          from "./renderers/LineChart";
import { TimelineRenderer }           from "./renderers/Timeline";
import { FinancialTableRenderer }     from "./renderers/FinancialTable";
import { ComparisonTableRenderer }    from "./renderers/ComparisonTable";
import { CalloutListRenderer }        from "./renderers/CalloutList";
import { ProseHighlightRenderer }     from "./renderers/ProseHighlight";
import { TwoColumnRenderer }          from "./renderers/TwoColumn";
import { OrgChartRenderer }           from "./renderers/OrgChart";
import { LocationCardRenderer }       from "./renderers/LocationCard";
import { StatCalloutRenderer }        from "./renderers/StatCallout";
import { NumberedListRenderer }       from "./renderers/NumberedList";
import { ScorecardRenderer }          from "./renderers/Scorecard";
import { CoverPageRenderer }          from "./renderers/CoverPage";
import { DividerRenderer }            from "./renderers/Divider";
import { WaterfallChartRenderer }     from "./renderers/WaterfallChart";
import { TagCloudRenderer }           from "./renderers/TagCloud";
import { ImageGalleryRenderer }       from "./renderers/ImageGallery";
import { VideoRenderer }              from "./renderers/Video";
import { LocationMapRenderer }        from "./renderers/LocationMap";
import { LockedSectionBody }          from "./renderers/LockedSection";
import { ProseFallback, sanitizeLayoutData } from "./richText";

interface CimSectionRendererProps {
  section: CimSection;
  branding: CimBranding;
  /** Show broker-only UI (reasoning tooltip, layout badge, edit handles) */
  brokerMode?: boolean;
  /** Omit the heading — for previews nested under a heading (collapsed summaries). */
  hideTitle?: boolean;
}

/** One renderer per registered layout — exhaustive by type. */
const RENDERERS = {
  cover_page: CoverPageRenderer,
  divider: DividerRenderer,
  metric_grid: MetricGridRenderer,
  stat_callout: StatCalloutRenderer,
  icon_stat_row: CalloutListRenderer,
  scorecard: ScorecardRenderer,
  bar_chart: BarChartRenderer,
  horizontal_bar_chart: HorizontalBarChartRenderer,
  line_chart: LineChartRenderer,
  pie_chart: PieChartRenderer,
  donut_chart: PieChartRenderer,
  waterfall_chart: WaterfallChartRenderer,
  financial_table: FinancialTableRenderer,
  comparison_table: ComparisonTableRenderer,
  prose_highlight: ProseHighlightRenderer,
  two_column: TwoColumnRenderer,
  callout_list: CalloutListRenderer,
  numbered_list: NumberedListRenderer,
  timeline: TimelineRenderer,
  tag_cloud: TagCloudRenderer,
  org_chart: OrgChartRenderer,
  location_card: LocationCardRenderer,
  image_gallery: ImageGalleryRenderer,
  video: VideoRenderer,
  location_map: LocationMapRenderer,
} satisfies Record<CimLayoutKey, ComponentType<any>>;

/** Layouts without their own heading (they are headings themselves). */
const UNTITLED = new Set(["cover_page", "divider"]);

/** A blank narrative/two-column section — shown as a placeholder to the broker. */
function isEmptyProse(section: CimSection, layoutData: Record<string, any>, content: string): boolean {
  if (content.trim()) return false;
  if (section.layoutType === "prose_highlight") {
    return !String(layoutData.body ?? "").trim() && !layoutData.pullQuote && !(layoutData.highlights?.length > 0);
  }
  if (section.layoutType === "two_column") {
    return !String(layoutData.left?.content ?? "").trim() && !String(layoutData.right?.content ?? "").trim();
  }
  return false;
}

export function CimSectionRenderer({ section, branding, brokerMode = false, hideTitle = false }: CimSectionRendererProps) {
  // Hooks first (the early returns below must not change the hook order).
  const themeVars = useThemeStyle();
  const number = useSectionNumber(section.id);
  if (!section.isVisible && !brokerMode) return null;

  // Prose fields keep their markup (renderers run them through renderInline /
  // renderProse); every other string is flattened so a chart label or metric
  // value never shows a literal "**", "[[dd]]" or "[DD]".
  const layoutData = sanitizeLayoutData((section.layoutData as any) || {});
  // Broker edits win over the AI draft. Prose renderers also prefer this over
  // layoutData.body — see editableText.ts for the rule.
  const content = section.brokerEditedContent || section.aiDraftContent || "";

  const locked = section.layoutType === LOCKED_LAYOUT_TYPE;
  const Renderer = (RENDERERS as Record<string, ComponentType<any>>)[section.layoutType];

  // Unregistered layout: its prose if it has any; otherwise buyers don't see
  // the section at all, and the broker is told to pick a layout.
  if (!locked && !Renderer && !content && !brokerMode) return null;

  const inner = locked ? (
    <LockedSectionBody />
  ) : Renderer ? (
    brokerMode && isEmptyProse(section, layoutData, content) ? (
      <EmptySectionPlaceholder />
    ) : (
      <Renderer layoutData={layoutData} content={content} branding={branding} section={section} brokerMode={brokerMode} />
    )
  ) : content ? (
    <ProseFallback content={content} />
  ) : (
    <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center text-xs text-muted-foreground">
      This section's layout isn't available any more, so buyers don't see it. Pick a new layout for it in the CIM builder.
    </div>
  );

  return (
    <div
      // `cim-doc` locks the document to the paper palette regardless of
      // the app theme (see index.css) — the CIM must render identically
      // in dark mode, light mode, and print.
      // The template's variables are set here too, so a section rendered on
      // its own (outside a sheet) still wears the deal's template.
      className={`cim-doc cim-section relative ${!section.isVisible ? "opacity-40" : ""}`}
      style={themeVars}
      data-section-key={section.sectionKey}
      data-layout-type={section.layoutType}
      data-track-section={section.sectionKey}
    >
      {/* Section title — not shown for cover_page or divider */}
      {!hideTitle && !UNTITLED.has(section.layoutType) && (
        <CimSectionHeading
          title={section.sectionTitle}
          number={number}
          aside={brokerMode && !section.isVisible ? (
            <div className="flex items-center gap-2 shrink-0 mt-0.5">
              <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                hidden
              </span>
            </div>
          ) : undefined}
        />
      )}
      {inner}
    </div>
  );
}

function EmptySectionPlaceholder() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/50 px-4 py-8 text-center">
      <p className="text-sm text-muted-foreground">Empty section</p>
      <p className="text-xs text-muted-foreground/70 mt-1">Write it in the editor, or let the AI writer draft it.</p>
    </div>
  );
}
