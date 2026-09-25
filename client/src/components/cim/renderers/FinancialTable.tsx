/**
 * FinancialTable renderer
 * Professional financial table with section headers, totals, indentation.
 */
import { useCallback, useEffect, useRef, useState } from "react";
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

/**
 * Whether a horizontal scroller hides columns to its right (a phone showing a
 * 4-year table). Drives the edge fade + "more years" cue, so a buyer never
 * misses the latest year off-screen.
 */
function useHiddenRight() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [hidden, setHidden] = useState(false);
  const check = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setHidden(el.scrollWidth - el.clientWidth - el.scrollLeft > 4);
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    check();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [check]);
  return { ref, hidden, onScroll: check };
}

export function FinancialTableRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: FinancialTableLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const scroller = useHiddenRight();

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
      <div className="relative">
      <div
        ref={scroller.ref}
        onScroll={scroller.onScroll}
        className="overflow-x-auto rounded-lg border border-card-border"
      >
        <table className="w-full text-sm border-collapse">
          {/* Header */}
          {showHeader && (
            <thead>
              <tr className="border-b border-card-border bg-muted/50">
                <th className="text-left text-xs font-semibold text-muted-foreground px-3 sm:px-4 py-2.5 min-w-[88px] sm:min-w-[200px]">
                  {labelHeader}
                </th>
                {columns.map((h, i) => (
                  <th
                    key={i}
                    scope="col"
                    className="text-right text-xs font-semibold text-muted-foreground px-1.5 sm:px-4 py-2.5 whitespace-nowrap"
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
                      "py-2.5 pr-2 sm:pr-4 text-xs",
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
                        "py-2.5 px-1.5 sm:px-4 text-right tabular-nums sm:font-mono text-[11px] sm:text-sm whitespace-nowrap",
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
        {scroller.hidden && (
          // Columns hidden to the right (narrow screens): fade the edge so it
          // reads as "more to see", not as the end of the table.
          <div
            aria-hidden
            className="pointer-events-none absolute inset-y-px right-px w-10 rounded-r-lg bg-gradient-to-l from-background to-transparent"
          />
        )}
      </div>
      {scroller.hidden && (
        <p className="mt-1.5 text-right text-2xs text-muted-foreground">
          {columns.length > 1 ? `Swipe for ${columns[columns.length - 1] || "more"} →` : "Swipe for more →"}
        </p>
      )}

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
