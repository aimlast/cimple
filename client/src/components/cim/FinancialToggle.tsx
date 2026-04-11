/**
 * FinancialToggle — "As Reported" vs "Normalized" view toggle for financial sections.
 *
 * Wraps a financial_table section. When layoutData includes both raw and
 * normalized data, renders a toggle at the top and swaps the table content.
 * Adjusted rows are visually highlighted in the normalized view.
 */
import { useState } from "react";
import type { CimSection } from "@shared/schema";
import type { CimBranding } from "./CimBrandingContext";
import { CimSectionRenderer } from "./CimSectionRenderer";

interface FinancialToggleProps {
  section: CimSection;
  branding: CimBranding;
  brokerMode?: boolean;
  onToggle?: (sectionKey: string, view: "reported" | "normalized") => void;
}

interface NormalizedRow {
  label: string;
  values: string[];
  isTotal?: boolean;
  isSectionHeader?: boolean;
  indent?: number;
  bold?: boolean;
  isAdjusted?: boolean;
  adjustmentAmount?: string;
  adjustmentNote?: string;
}

/**
 * Checks if a financial section has normalized data available.
 * The AI can provide normalizedRows alongside the standard rows.
 */
function hasNormalizedData(section: CimSection): boolean {
  const ld = (section.layoutData as any) || {};
  return !!(ld.normalizedRows && Array.isArray(ld.normalizedRows) && ld.normalizedRows.length > 0);
}

export function FinancialToggle({
  section,
  branding,
  brokerMode = false,
  onToggle,
}: FinancialToggleProps) {
  const [view, setView] = useState<"reported" | "normalized">("reported");

  // Only apply to financial_table sections with normalized data
  if (section.layoutType !== "financial_table" || !hasNormalizedData(section)) {
    return (
      <CimSectionRenderer
        section={section}
        branding={branding}
        brokerMode={brokerMode}
      />
    );
  }

  const layoutData = (section.layoutData as any) || {};
  const normalizedRows = (layoutData.normalizedRows || []) as NormalizedRow[];

  const toggle = (next: "reported" | "normalized") => {
    setView(next);
    onToggle?.(section.sectionKey, next);
  };

  // Build the section with swapped rows when normalized
  const activeSection =
    view === "normalized"
      ? {
          ...section,
          layoutData: {
            ...layoutData,
            rows: normalizedRows.map((row) => ({
              ...row,
              // Add visual indicator for adjusted rows
              label: row.isAdjusted
                ? `${row.label} ${row.adjustmentAmount ? `(${row.adjustmentAmount})` : ""}`
                : row.label,
            })),
            caption: layoutData.normalizedCaption || layoutData.caption,
            footnotes: [
              ...(layoutData.normalizedFootnotes || layoutData.footnotes || []),
              "Highlighted rows indicate adjustments from reported figures.",
            ],
          },
        }
      : section;

  return (
    <div>
      {/* Toggle bar */}
      <div className="flex items-center gap-1 mb-4 print:hidden">
        <div className="inline-flex items-center rounded-lg border border-border/60 bg-muted/30 p-0.5">
          <button
            onClick={() => toggle("reported")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              view === "reported"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            As Reported
          </button>
          <button
            onClick={() => toggle("normalized")}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              view === "normalized"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Normalized
          </button>
        </div>
        {view === "normalized" && (
          <span className="text-[10px] text-muted-foreground/60 ml-2">
            Adjusted rows highlighted
          </span>
        )}
      </div>

      {/* Render the active view */}
      <CimSectionRenderer
        section={activeSection as CimSection}
        branding={branding}
        brokerMode={brokerMode}
      />
    </div>
  );
}
