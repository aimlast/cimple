/**
 * ExpandableSection — Summary/detail toggle for dense CIM sections.
 *
 * Wraps a CimSectionRenderer. When the AI marks a section as expandable
 * (via layoutData.expandable), this component shows a compact summary
 * by default and lets buyers click to reveal the full content.
 *
 * Analytics events fire on every expand/collapse.
 * In print mode, all sections auto-expand.
 */
import { useState, useEffect } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { CimSection } from "@shared/schema";
import type { CimBranding } from "./CimBrandingContext";
import { CimSectionRenderer } from "./CimSectionRenderer";

interface ExpandableSectionProps {
  section: CimSection;
  branding: CimBranding;
  brokerMode?: boolean;
  onToggle?: (sectionKey: string, expanded: boolean) => void;
}

/**
 * Determines if a section should be expandable based on its layoutData.
 * The AI can set `expandable: true` and optionally provide a `summary` string.
 */
function getExpandableConfig(section: CimSection): {
  isExpandable: boolean;
  summary: string | null;
  expandLabel: string;
  collapseLabel: string;
} {
  const layoutData = (section.layoutData as any) || {};

  // The AI sets expandable: true when the section has dense content
  if (!layoutData.expandable) {
    return {
      isExpandable: false,
      summary: null,
      expandLabel: "Show details",
      collapseLabel: "Show less",
    };
  }

  return {
    isExpandable: true,
    summary: layoutData.summary || null,
    expandLabel: layoutData.expandLabel || "Show full details",
    collapseLabel: layoutData.collapseLabel || "Show less",
  };
}

/**
 * Generates a smart summary for sections where the AI didn't provide one.
 * Uses content structure to create a meaningful preview.
 */
function autoSummary(section: CimSection): string | null {
  const layoutData = (section.layoutData as any) || {};

  switch (section.layoutType) {
    case "financial_table": {
      const rows = layoutData.rows as any[] | undefined;
      if (rows && rows.length > 5) {
        return `${rows.length} line items`;
      }
      return null;
    }
    case "callout_list":
    case "icon_stat_row": {
      const items = layoutData.items as any[] | undefined;
      if (items && items.length > 4) {
        return `${items.length} items`;
      }
      return null;
    }
    case "numbered_list": {
      const items = layoutData.items as any[] | undefined;
      if (items && items.length > 5) {
        return `${items.length} items`;
      }
      return null;
    }
    default:
      return null;
  }
}

export function ExpandableSection({
  section,
  branding,
  brokerMode = false,
  onToggle,
}: ExpandableSectionProps) {
  const config = getExpandableConfig(section);
  const [expanded, setExpanded] = useState(!config.isExpandable);

  // Auto-expand in print mode
  useEffect(() => {
    const mql = window.matchMedia("print");
    const handler = (e: MediaQueryListEvent | MediaQueryList) => {
      if (e.matches) setExpanded(true);
    };
    handler(mql);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // If not expandable, render normally
  if (!config.isExpandable) {
    return (
      <CimSectionRenderer
        section={section}
        branding={branding}
        brokerMode={brokerMode}
      />
    );
  }

  const toggle = () => {
    const next = !expanded;
    setExpanded(next);
    onToggle?.(section.sectionKey, next);
  };

  const summaryText = config.summary || autoSummary(section);

  return (
    <div className="cim-expandable-section">
      {/* Always render the full section (controls visibility via CSS) */}
      <div className={expanded ? "" : "hidden print:block"}>
        <CimSectionRenderer
          section={section}
          branding={branding}
          brokerMode={brokerMode}
        />
      </div>

      {/* Summary view (shown when collapsed) */}
      {!expanded && (
        <div
          className="cim-section relative"
          data-section-key={section.sectionKey}
          data-layout-type={section.layoutType}
          data-track-section={section.sectionKey}
        >
          {/* Section title */}
          {section.layoutType !== "cover_page" &&
            section.layoutType !== "divider" && (
              <div className="mb-4 flex items-start justify-between gap-4">
                <h2
                  className="text-xl font-bold tracking-tight"
                  style={{ color: branding.headingColor }}
                >
                  {section.sectionTitle}
                </h2>
              </div>
            )}

          {/* Summary content — intelligent preview */}
          <SummaryPreview
            section={section}
            branding={branding}
            summaryText={summaryText}
          />
        </div>
      )}

      {/* Expand/collapse toggle */}
      <button
        onClick={toggle}
        className="group flex items-center gap-2 mt-3 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors print:hidden"
      >
        {expanded ? (
          <>
            <ChevronUp className="h-3.5 w-3.5" />
            {config.collapseLabel}
          </>
        ) : (
          <>
            <ChevronDown className="h-3.5 w-3.5" />
            {config.expandLabel}
          </>
        )}
      </button>
    </div>
  );
}

// ── Summary Preview ─────────────────────────────────────────────────────────

/**
 * Renders an intelligent summary preview based on the section's layout type.
 * For tables: shows first few rows. For lists: shows first few items.
 * For prose: shows the first paragraph or pull quote.
 */
function SummaryPreview({
  section,
  branding,
  summaryText,
}: {
  section: CimSection;
  branding: CimBranding;
  summaryText: string | null;
}) {
  const layoutData = (section.layoutData as any) || {};

  // Financial table: show headers + first 3 rows with fade
  if (section.layoutType === "financial_table" && layoutData.rows) {
    const allRows = layoutData.rows as any[];
    const previewRows = allRows.slice(0, 3);
    const remaining = allRows.length - 3;

    return (
      <div className="relative">
        <CimSectionRenderer
          section={{
            ...section,
            layoutData: { ...layoutData, rows: previewRows },
          }}
          branding={branding}
          brokerMode={false}
        />
        {remaining > 0 && (
          <div className="absolute bottom-0 left-0 right-0 h-16 bg-gradient-to-t from-background to-transparent flex items-end justify-center pb-1">
            <span className="text-[11px] text-muted-foreground/60">
              +{remaining} more rows
            </span>
          </div>
        )}
      </div>
    );
  }

  // Callout list: show first 3 items
  if (
    (section.layoutType === "callout_list" ||
      section.layoutType === "icon_stat_row") &&
    layoutData.items
  ) {
    const allItems = layoutData.items as any[];
    const previewItems = allItems.slice(0, 3);
    const remaining = allItems.length - 3;

    return (
      <div className="relative">
        <CimSectionRenderer
          section={{
            ...section,
            layoutData: { ...layoutData, items: previewItems },
          }}
          branding={branding}
          brokerMode={false}
        />
        {remaining > 0 && (
          <div className="text-center mt-2">
            <span className="text-[11px] text-muted-foreground/60">
              +{remaining} more items
            </span>
          </div>
        )}
      </div>
    );
  }

  // Numbered list: show first 3
  if (section.layoutType === "numbered_list" && layoutData.items) {
    const allItems = layoutData.items as any[];
    const previewItems = allItems.slice(0, 3);
    const remaining = allItems.length - 3;

    return (
      <div className="relative">
        <CimSectionRenderer
          section={{
            ...section,
            layoutData: { ...layoutData, items: previewItems },
          }}
          branding={branding}
          brokerMode={false}
        />
        {remaining > 0 && (
          <div className="text-center mt-2">
            <span className="text-[11px] text-muted-foreground/60">
              +{remaining} more items
            </span>
          </div>
        )}
      </div>
    );
  }

  // Prose: show first paragraph or pull quote
  if (section.layoutType === "prose_highlight") {
    const body = layoutData.body || "";
    const pullQuote = layoutData.pullQuote;
    const firstPara = body.split("\n\n")[0] || body.slice(0, 200);

    return (
      <div>
        {pullQuote && (
          <blockquote
            className="border-l-3 pl-4 py-1 mb-4 text-sm italic text-foreground/80"
            style={{ borderColor: branding.primaryHex }}
          >
            {pullQuote}
          </blockquote>
        )}
        <p className="text-sm text-foreground/80 leading-relaxed">
          {firstPara}
          {body.length > firstPara.length && (
            <span className="text-muted-foreground/50">...</span>
          )}
        </p>
      </div>
    );
  }

  // Default: show AI-provided summary or a generic message
  if (summaryText) {
    return (
      <p className="text-sm text-muted-foreground">{summaryText}</p>
    );
  }

  // Fallback: render the section normally (no summarization possible)
  return (
    <CimSectionRenderer
      section={section}
      branding={branding}
      brokerMode={false}
    />
  );
}
