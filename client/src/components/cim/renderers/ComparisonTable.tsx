/**
 * ComparisonTable renderer
 * Two-column side-by-side comparison. Highlighted rows get teal tint.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

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

export function ComparisonTableRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: ComparisonTableLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const rows = data.rows || [];

  if (rows.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <div className="overflow-x-auto rounded-lg border border-card-border">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b border-card-border bg-muted/50">
              <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-2.5 w-[40%]">
                Metric
              </th>
              <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-2.5">
                {data.leftLabel || "Current"}
              </th>
              <th className="text-right text-xs font-semibold text-muted-foreground px-4 py-2.5">
                {data.rightLabel || "Benchmark"}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
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
                  "px-4 py-2.5 text-xs",
                  row.highlight ? "font-semibold text-foreground" : "font-medium text-foreground/80"
                )}>
                  {row.label}
                </td>
                <td className={cn(
                  "px-4 py-2.5 text-right text-xs tabular-nums",
                  row.highlight ? "font-semibold text-foreground" : "text-foreground/80"
                )}>
                  {row.left}
                </td>
                <td className={cn(
                  "px-4 py-2.5 text-right text-xs tabular-nums",
                  row.highlight ? "font-semibold text-foreground" : "text-muted-foreground"
                )}>
                  {row.right}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
