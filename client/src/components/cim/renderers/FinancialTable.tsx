/**
 * FinancialTable renderer
 * Professional financial table with section headers, totals, indentation.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { ProseFallback, renderInline } from "../richText";
import { financialLabelHeader, normalizeFinancialTable } from "@shared/financial-table";

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

  // One shared reading of headers vs. values (see shared/financial-table.ts):
  // the leading header names the label column, so each figure sits under its
  // own year however many years the table has.
  const table = normalizeFinancialTable(data);
  const { columns, rows } = table;

  if (rows.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  const colCount = columns.length + 1;
  const labelHeader = financialLabelHeader(table.labelHeader, data.currency);
  const showHeader = columns.some((c) => c) || !!labelHeader;

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
          {showHeader && (
            <thead>
              <tr className="border-b border-card-border bg-muted/50">
                <th className="text-left text-xs font-semibold text-muted-foreground px-3 sm:px-4 py-2.5 min-w-[132px] sm:min-w-[200px]">
                  {labelHeader}
                </th>
                {columns.map((h, i) => (
                  <th
                    key={i}
                    scope="col"
                    className="text-right text-xs font-semibold text-muted-foreground px-3 sm:px-4 py-2.5 whitespace-nowrap"
                  >
                    {h}
                  </th>
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
              const indentPx = row.indent * 14 + 12;

              return (
                <tr
                  key={i}
                  className={cn(
                    "border-b border-border/50 last:border-0",
                    isTotal && "border-t border-border bg-muted/40",
                    // Subtle zebra stripe on the paper surface — aids row scanning
                    !isTotal && i % 2 === 1 && "bg-muted/25",
                    !isTotal && "hover:bg-muted/50 transition-colors"
                  )}
                >
                  <td
                    className={cn(
                      "py-2.5 pr-4 text-xs",
                      isTotal ? "font-semibold text-foreground" : row.bold ? "font-medium text-foreground" : "text-foreground/80"
                    )}
                    style={{ paddingLeft: indentPx }}
                  >
                    {row.label}
                  </td>
                  {row.cells.map((val, j) => (
                    <td
                      key={j}
                      className={cn(
                        "py-2.5 px-3 sm:px-4 text-right tabular-nums font-mono text-xs sm:text-sm whitespace-nowrap",
                        val === null
                          ? "text-muted-foreground/60"
                          : isTotal ? "font-semibold text-foreground" : row.bold ? "font-medium text-foreground" : "text-foreground/80"
                      )}
                    >
                      {/* No figure for this column — a quiet dash, never a shifted value */}
                      {val ?? <span aria-label="not available">—</span>}
                    </td>
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
              {renderInline(fn, `fn${i}`)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
