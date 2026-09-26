/**
 * ComparisonTable renderer
 * Label | value columns side by side. Highlighted rows get the accent tint.
 *
 * Drawn from comparisonTableView (shared/cim-chart-values.ts), which repairs
 * two shapes the writer produced: a series packed into one cell ("589 → 711
 * → 646" under "2022 → 2023 → 2024") becomes one column per year, and a left
 * column headed "Metric" (the label column's own header) is shown as a note
 * under each row's label instead of a second "Metric" column. Values never
 * wrap mid-figure; a table wider than its column scrolls inside its frame.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { comparisonTableView } from "@shared/cim-chart-values";
import { ProseFallback } from "../richText";

interface ComparisonRow {
  label: string;
  left: string;
  right: string;
  highlight?: boolean;
}

interface ComparisonTableLayoutData {
  leftLabel?: string;
  rightLabel?: string;
  rows?: ComparisonRow[];
  title?: string;
}

interface RendererProps {
  layoutData: ComparisonTableLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

export function ComparisonTableRenderer({ layoutData, content }: RendererProps) {
  const data: ComparisonTableLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const rows = data.rows || [];

  if (rows.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  const view = comparisonTableView(data);
  // Three or more value columns (a year series): tighter cells so the table
  // fits a half-width column before it has to scroll.
  const many = view.columns.length >= 3;
  const cellX = many ? "px-2.5" : "px-4";

  return (
    <div className="min-w-0">
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <div className="max-w-full overflow-x-auto rounded-lg border border-card-border">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-card-border bg-muted/50">
              <th className={cn("text-left text-xs font-semibold text-muted-foreground py-2.5", many ? "pl-3 pr-2" : "px-4", many ? "w-auto" : "w-[40%]")}>
                {view.labelHeader}
              </th>
              {view.columns.map((c, i) => (
                // A year column is as wide as its figures; the label column takes the rest.
                <th key={i} className={cn("text-right text-xs font-semibold text-muted-foreground py-2.5 whitespace-nowrap", cellX, many && "w-px")}>
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view.rows.map((row, i) => (
              <tr
                key={i}
                className={cn(
                  "border-b border-border/40 last:border-0 transition-colors",
                  row.highlight
                    ? "bg-teal-muted/40"
                    : i % 2 === 0
                    ? "bg-card"
                    : "bg-muted/20"
                )}
              >
                <td className={cn(
                  "py-2.5 text-xs align-top",
                  many ? "pl-3 pr-2" : "px-4",
                  row.highlight ? "font-semibold text-foreground" : "font-medium text-foreground/80"
                )}>
                  {row.label}
                  {row.note && <span className="block text-2xs font-normal text-muted-foreground mt-0.5">{row.note}</span>}
                </td>
                {row.cells.map((cell, j) => (
                  <td
                    key={j}
                    className={cn(
                      "py-2.5 text-right text-xs tabular-nums align-top",
                      // A figure never wraps mid-number; a phrase may wrap.
                      cell.length <= 18 && "whitespace-nowrap",
                      cellX,
                      row.highlight
                        ? "font-semibold text-foreground"
                        : j === row.cells.length - 1 && !many
                        ? "text-muted-foreground"
                        : "text-foreground/80"
                    )}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
