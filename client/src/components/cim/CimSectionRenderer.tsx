/**
 * CimSectionRenderer
 *
 * Dispatches a CIM section to the correct renderer based on layoutType.
 * This is the single entry point — every section in every CIM passes through here.
 *
 * The AI layout engine can produce any layoutType in the registry.
 * Unknown types fall back to a graceful raw-data view so no section is ever blank.
 */
import type { CimSection } from "@shared/schema";
import type { CimBranding } from "./CimBrandingContext";

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

interface CimSectionRendererProps {
  section: CimSection;
  branding: CimBranding;
  /** Show broker-only UI (reasoning tooltip, layout badge, edit handles) */
  brokerMode?: boolean;
}

export function CimSectionRenderer({ section, branding, brokerMode = false }: CimSectionRendererProps) {
  if (!section.isVisible && !brokerMode) return null;

  const layoutData = section.layoutData as any || {};
  const content = section.brokerEditedContent || section.aiDraftContent || "";

  const rendererProps = { layoutData, content, branding, section };

  const inner = (() => {
    switch (section.layoutType) {
      case "cover_page":             return <CoverPageRenderer {...rendererProps} />;
      case "metric_grid":            return <MetricGridRenderer {...rendererProps} />;
      case "bar_chart":              return <BarChartRenderer {...rendererProps} />;
      case "horizontal_bar_chart":   return <HorizontalBarChartRenderer {...rendererProps} />;
      case "pie_chart":
      case "donut_chart":            return <PieChartRenderer {...rendererProps} />;
      case "line_chart":             return <LineChartRenderer {...rendererProps} />;
      case "timeline":               return <TimelineRenderer {...rendererProps} />;
      case "financial_table":        return <FinancialTableRenderer {...rendererProps} />;
      case "comparison_table":       return <ComparisonTableRenderer {...rendererProps} />;
      case "callout_list":
      case "icon_stat_row":          return <CalloutListRenderer {...rendererProps} />;
      case "prose_highlight":        return <ProseHighlightRenderer {...rendererProps} />;
      case "two_column":             return <TwoColumnRenderer {...rendererProps} />;
      case "org_chart":              return <OrgChartRenderer {...rendererProps} />;
      case "location_card":          return <LocationCardRenderer {...rendererProps} />;
      case "stat_callout":           return <StatCalloutRenderer {...rendererProps} />;
      case "numbered_list":          return <NumberedListRenderer {...rendererProps} />;
      case "scorecard":              return <ScorecardRenderer {...rendererProps} />;
      case "divider":                return <DividerRenderer {...rendererProps} />;
      default:
        return <UnknownLayoutFallback section={section} content={content} />;
    }
  })();

  return (
    <div
      className={`cim-section relative ${!section.isVisible ? "opacity-40" : ""}`}
      data-section-key={section.sectionKey}
      data-layout-type={section.layoutType}
      data-track-section={section.sectionKey}
    >
      {/* Section title — not shown for cover_page or divider */}
      {section.layoutType !== "cover_page" && section.layoutType !== "divider" && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <h2
            className="text-xl font-bold tracking-tight"
            style={{ color: branding.headingColor }}
          >
            {section.sectionTitle}
          </h2>
          {brokerMode && (
            <div className="flex items-center gap-2 shrink-0 mt-0.5">
              <span className="text-[10px] font-mono text-muted-foreground/50 bg-muted px-1.5 py-0.5 rounded">
                {section.layoutType}
              </span>
              {!section.isVisible && (
                <span className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                  hidden
                </span>
              )}
            </div>
          )}
        </div>
      )}
      {inner}
    </div>
  );
}

function UnknownLayoutFallback({ section, content }: { section: CimSection; content: string }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 p-5">
      {content ? (
        <p className="text-sm leading-relaxed whitespace-pre-wrap">{content}</p>
      ) : (
        <pre className="text-xs text-muted-foreground overflow-auto">
          {JSON.stringify(section.layoutData, null, 2)}
        </pre>
      )}
    </div>
  );
}
