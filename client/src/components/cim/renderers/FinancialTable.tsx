/**
 * FinancialTable renderer
 * Professional financial table with section headers, totals, indentation.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface TableRow {
  label: string;
  values: string[];
  isTotal?: boolean;
  isSectionHeader?: boolean;
  indent?: number;
  bold?: boolean;
}

interface FinancialTableLayoutData {
  headers?: string[];
  rows?: TableRow[];
  caption?: string;
  currency?: string;
  footnotes?: string[];
}

interface RendererProps {
  layoutData: FinancialTableLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

export function FinancialTableRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: FinancialTableLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const headers = data.headers || [];
  const rows = data.rows || [];

  if (rows.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const colCount = Math.max(headers.length, ...rows.map((r) => (r.values?.length || 0) + 1));
  const valueColCount = colCount - 1;

  return (
    <div>
      {data.caption && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.caption}
        </h3>
      )}
      <div className="overflow-x-auto rounded-lg border border-card-border">
        <table className="w-full text-sm border-collapse">
          {/* Header */}
          {headers.length > 0 && (
            <thead>
              <tr className="border-b border-card-border bg-muted/50">
                <th className="text-left text-xs font-semibold text-muted-foreground px-4 py-2.5 min-w-[200px]">
                  {data.currency ? `(${data.currency})` : ""}
                </th>
                {headers.map((h, i) => (
                  <th
                    key={i}
                    className="text-right text-xs font-semibold text-muted-foreground px-4 py-2.5 whitespace-nowrap"
                  >
                    {h}
                  </th>
                ))}
                {/* Pad extra columns if rows have more values than headers */}
                {Array.from({ length: Math.max(0, valueColCount - headers.length) }).map((_, i) => (
                  <th key={`pad-${i}`} className="px-4 py-2.5" />
                ))}
              </tr>
            </thead>
          )}
          <tbody>
            {rows.map((row, i) => {
              if (row.isSectionHeader) {
                return (
                  <tr key={i} className="bg-muted/30">
                    <td
                      colSpan={colCount}
                      className="px-4 py-2 text-xs font-semibold text-muted-foreground uppercase tracking-wide"
                    >
                      {row.label}
                    </td>
                  </tr>
                );
              }

              const isTotal = row.isTotal;
              const indentPx = (row.indent || 0) * 16 + 16;

              return (
                <tr
                  key={i}
                  className={cn(
                    "border-b border-border/50 last:border-0",
                    isTotal && "border-t border-border bg-muted/20",
                    !isTotal && "hover:bg-muted/20 transition-colors"
                  )}
                >
                  <td
                    className={cn(
                      "py-2.5 text-xs",
                      isTotal ? "font-semibold text-foreground" : row.bold ? "font-medium text-foreground" : "text-foreground/80"
                    )}
                    style={{ paddingLeft: indentPx }}
                  >
                    {row.label}
                  </td>
                  {(row.values || []).map((val, j) => (
                    <td
                      key={j}
                      className={cn(
                        "py-2.5 px-4 text-right tabular-nums font-mono text-sm",
                        isTotal ? "font-semibold text-foreground" : row.bold ? "font-medium text-foreground" : "text-foreground/80"
                      )}
                    >
                      {val}
                    </td>
                  ))}
                  {/* Pad missing value cells */}
                  {Array.from({ length: Math.max(0, valueColCount - (row.values?.length || 0)) }).map((_, j) => (
                    <td key={`empty-${j}`} className="py-2.5 px-4" />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Footnotes */}
      {data.footnotes && data.footnotes.length > 0 && (
        <div className="mt-3 space-y-1">
          {data.footnotes.map((fn, i) => (
            <p key={i} className="text-2xs text-muted-foreground leading-snug">
              {fn}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
