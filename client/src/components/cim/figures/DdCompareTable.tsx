/**
 * DdCompareTable — a due-diligence financial table with each CIM figure
 * beside the tax return (spec §4.2). Three layouts, chosen by the table's own
 * measured width (never the window):
 *   wide   ≥ 760 px  two columns per year: This CIM | Tax return
 *   medium 520–759   one column per year; the tax-return figure under the CIM's
 *   narrow < 520     year chips; Line | This CIM | Tax return (also 4+ years)
 * Column 1 is always "This CIM" — the table never shows a number the normal
 * CIM doesn't. The other figure appears only on rows with a comparable
 * figure; other cells stay blank (one footnote explains). Block keys stay
 * `row:i` in every layout, so reading heat is the same in all views.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { NormalizedFinancialTable } from "@shared/financial-table";
import type { FigureCheckView, FigureDocRef, FigureView } from "@shared/figure-layer";
import { COL_THIS_CIM, COMPARE_BLANK_FOOTNOTE, COMPARE_ONLY_DIFFERENCES } from "@shared/figure-copy";
import { STATE_PAINT } from "@shared/figure-states";
import { cn } from "@/lib/utils";
import { useBlockAttrs } from "../blocks";
import { FigureTrigger } from "./FigureValue";
import { FigureCitation } from "./FigureCitation";
import { asIssuedCheck, otherRecordCheck, StateIcon } from "./figurePaint";

type Layout = "wide" | "medium" | "narrow";

function useMeasuredLayout(years: number): { ref: React.RefObject<HTMLDivElement>; layout: Layout } {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setWidth(el.clientWidth || 800);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const layout: Layout = years >= 4 || width < 520 ? "narrow" : width < 760 ? "medium" : "wide";
  return { ref, layout };
}

interface Props {
  table: NormalizedFinancialTable;
  labelHeader: string;
  lookup: (block: string, cell?: number | null) => FigureView | null;
  onlyDifferences: boolean;
  onToggleOnlyDifferences: () => void;
}

/** A row "differs" when any of its checks is explained / ask. */
function rowDiffers(figs: Array<FigureView | null>): boolean {
  return figs.some((f) => (f?.checks ?? []).some((c) => c.state === "explained" || c.state === "ask"));
}

function OtherCell({ fig, check, compact }: { fig: FigureView; check: FigureCheckView; compact?: boolean }) {
  const paint = STATE_PAINT[check.state];
  const differs = check.state === "explained" || check.state === "ask";
  return (
    <FigureTrigger fig={fig} showState={false}>
      <span className={cn("inline-flex flex-col items-end", compact && "items-end")}>
        <span className="inline-flex items-center gap-1 tabular-nums">
          {check.value.replace(/^\$/, "")}
          <StateIcon state={check.state} />
        </span>
        {differs && check.difference && (
          <span className="text-[10px] tabular-nums" style={{ color: paint.ink }}>{check.difference}</span>
        )}
      </span>
    </FigureTrigger>
  );
}

function CimCell({ fig, text }: { fig: FigureView | null; text: string | null }) {
  if (text === null) return <span aria-label="not available" className="text-[hsl(var(--cim-ink-faint))]">—</span>;
  if (!fig) return <>{text}</>;
  const asIssued = asIssuedCheck(fig);
  return (
    <FigureTrigger fig={fig} showState={false}>
      <span className="inline-flex items-center gap-1 tabular-nums">
        {text}
        {asIssued && <StateIcon state={asIssued.state} />}
      </span>
    </FigureTrigger>
  );
}

const cellTint = (check: FigureCheckView | null) => {
  if (!check) return undefined;
  const p = STATE_PAINT[check.state];
  return p.tint ? { backgroundColor: p.tint, boxShadow: `inset ${p.ruleWidth}px 0 0 ${p.rule}` } : undefined;
};

export function DdCompareTable({ table, labelHeader, lookup, onlyDifferences, onToggleOnlyDifferences }: Props) {
  const { columns, rows } = table;
  const ba = useBlockAttrs();
  const { ref, layout } = useMeasuredLayout(columns.length);
  const [year, setYear] = useState(Math.max(0, columns.length - 1));

  const figsByRow = useMemo(() => rows.map((_r, i) => columns.map((_c, j) => lookup(`row:${i}`, j))), [rows, columns, lookup]);
  const otherLabel = useMemo(() => {
    for (const r of figsByRow) for (const f of r) { const c = otherRecordCheck(f); if (c) return c.kindLabel; }
    return "Tax return";
  }, [figsByRow]);

  const docs = useMemo(() => {
    const statements = new Map<string, FigureDocRef>();
    const others = new Map<string, FigureDocRef>();
    for (const r of figsByRow) for (const f of r) {
      if (!f) continue;
      for (const ref of f.citations ?? []) statements.set(ref.documentId, ref);
      for (const c of f.checks ?? []) {
        if (c.baseCitation) statements.set(c.baseCitation.documentId, c.baseCitation);
        if (c.citation && !c.kindLabel.startsWith("Financial statements")) others.set(c.citation.documentId, c.citation);
      }
    }
    const byPeriod = (a: FigureDocRef, b: FigureDocRef) => String(a.period ?? "").localeCompare(String(b.period ?? ""));
    return { statements: Array.from(statements.values()).sort(byPeriod), others: Array.from(others.values()).sort(byPeriod) };
  }, [figsByRow]);

  const visibleRow = (i: number) => !onlyDifferences || rows[i].isSectionHeader || rowDiffers(figsByRow[i]);

  const head = (
    <div className="mb-2 flex flex-wrap items-center justify-end gap-2">
      <button
        type="button"
        aria-pressed={onlyDifferences}
        onClick={onToggleOnlyDifferences}
        className={cn(
          "rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors print:hidden",
          onlyDifferences ? "border-[hsl(var(--cim-brass))] bg-[hsl(var(--cim-brass)/0.12)] text-[hsl(var(--cim-ink))]" : "border-[hsl(var(--cim-line))] text-[hsl(var(--cim-ink-soft))] hover:bg-[hsl(var(--cim-stripe))]",
        )}
      >
        {COMPARE_ONLY_DIFFERENCES}
      </button>
    </div>
  );

  const footer = (
    <div className="mt-2 space-y-1.5">
      <p className="text-2xs text-[hsl(var(--cim-ink-muted))]">{COMPARE_BLANK_FOOTNOTE}</p>
      {(docs.statements.length > 0 || docs.others.length > 0) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[hsl(var(--cim-ink-muted))]">
          {docs.statements.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1">Statements: {docs.statements.map((r) => <FigureCitation key={r.documentId} docRef={r} />)}</span>
          )}
          {docs.others.length > 0 && (
            <span className="inline-flex flex-wrap items-center gap-1">{/tax|form/i.test(otherLabel) ? "Tax returns:" : `${otherLabel}:`} {docs.others.map((r) => <FigureCitation key={r.documentId} docRef={r} />)}</span>
          )}
        </div>
      )}
    </div>
  );

  if (layout === "narrow") {
    const j = Math.min(year, columns.length - 1);
    return (
      <div ref={ref}>
        {head}
        <div role="tablist" aria-label="Year" className="mb-2 flex gap-1 overflow-x-auto pb-1">
          {columns.map((c, k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={k === j}
              onClick={() => setYear(k)}
              className={cn(
                "shrink-0 rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
                k === j ? "border-[hsl(var(--cim-ink))] bg-[hsl(var(--cim-ink))] text-[hsl(var(--cim-paper))]" : "border-[hsl(var(--cim-line))] text-[hsl(var(--cim-ink-soft))]",
              )}
            >
              {c || `Year ${k + 1}`}
            </button>
          ))}
        </div>
        <div className="overflow-hidden rounded-lg border border-card-border">
          <table className="w-full table-fixed border-collapse text-xs">
            <thead>
              <tr {...ba("head")} className="border-b border-card-border bg-muted/50">
                <th className="w-[44%] px-2 py-2 text-left font-semibold text-muted-foreground">{labelHeader || "Line"}</th>
                <th className="px-2 py-2 text-right font-semibold text-muted-foreground">{COL_THIS_CIM}</th>
                <th className="px-2 py-2 text-right font-semibold text-muted-foreground">{otherLabel}</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                if (!visibleRow(i)) return null;
                if (row.isSectionHeader) {
                  return <tr key={i} {...ba.row(i)} className="bg-muted/30"><td colSpan={3} className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">{row.label}</td></tr>;
                }
                const fig = figsByRow[i][j];
                const check = otherRecordCheck(fig);
                return (
                  <tr key={i} {...ba.row(i)} className={cn("border-b border-border/50 last:border-0", row.isTotal && "bg-muted/40 font-semibold")}>
                    <td className="break-words px-2 py-2 text-foreground/80" style={{ paddingLeft: row.indent * 10 + 8 }}>{row.label}</td>
                    <td className="px-2 py-2 text-right tabular-nums"><CimCell fig={fig} text={row.cells[j]} /></td>
                    <td className="px-2 py-2 text-right tabular-nums" style={cellTint(check)}>{fig && check ? <OtherCell fig={fig} check={check} compact /> : null}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {footer}
      </div>
    );
  }

  if (layout === "medium") {
    return (
      <div ref={ref}>
        {head}
        <div className="overflow-hidden rounded-lg border border-card-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr {...ba("head")} className="border-b border-card-border bg-muted/50">
                <th className="px-3 py-2.5 text-left text-xs font-semibold text-muted-foreground">{labelHeader}</th>
                {columns.map((c, k) => <th key={k} scope="col" className="whitespace-nowrap px-2 py-2.5 text-right text-xs font-semibold text-muted-foreground">{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                if (!visibleRow(i)) return null;
                if (row.isSectionHeader) {
                  return <tr key={i} {...ba.row(i)} className="bg-muted/30"><td colSpan={columns.length + 1} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{row.label}</td></tr>;
                }
                return (
                  <tr key={i} {...ba.row(i)} className={cn("border-b border-border/50 last:border-0", row.isTotal && "border-t border-border bg-muted/40")}>
                    <td className={cn("py-2.5 pr-2 text-xs", row.isTotal ? "font-semibold" : "text-foreground/80")} style={{ paddingLeft: row.indent * 14 + 12 }}>{row.label}</td>
                    {row.cells.map((val, j) => {
                      const fig = figsByRow[i][j];
                      const check = otherRecordCheck(fig);
                      return (
                        <td key={j} className="whitespace-nowrap px-2 py-2 text-right align-top text-xs tabular-nums" style={check && (check.state === "explained" || check.state === "ask") ? cellTint(check) : undefined}>
                          <CimCell fig={fig} text={val} />
                          {fig && check && (
                            <span className="mt-0.5 block text-[11px] text-[hsl(var(--cim-ink-muted))]">
                              <OtherCell fig={fig} check={check} />
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {footer}
      </div>
    );
  }

  // Wide: two columns per year.
  return (
    <div ref={ref}>
      {head}
      <div className="overflow-hidden rounded-lg border border-card-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr {...ba("head")} className="border-b border-card-border bg-muted/50">
              <th rowSpan={2} className="px-3 py-2 text-left align-bottom text-xs font-semibold text-muted-foreground">{labelHeader}</th>
              {columns.map((c, k) => <th key={k} colSpan={2} scope="colgroup" className="border-l border-card-border px-2 pt-2 text-center text-xs font-semibold text-muted-foreground">{c}</th>)}
            </tr>
            <tr className="border-b border-card-border bg-muted/50">
              {columns.map((_c, k) => (
                <th key={k} colSpan={2} className="border-l border-card-border p-0">
                  <span className="grid grid-cols-2 text-[10px] font-medium text-muted-foreground">
                    <span className="px-2 pb-1.5 text-right">{COL_THIS_CIM}</span>
                    <span className="px-2 pb-1.5 text-right">{otherLabel}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              if (!visibleRow(i)) return null;
              if (row.isSectionHeader) {
                return <tr key={i} {...ba.row(i)} className="bg-muted/30"><td colSpan={columns.length * 2 + 1} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{row.label}</td></tr>;
              }
              return (
                <tr key={i} {...ba.row(i)} className={cn("border-b border-border/50 last:border-0", row.isTotal && "border-t border-border bg-muted/40")}>
                  <td className={cn("py-2.5 pr-2 text-xs", row.isTotal ? "font-semibold" : "text-foreground/80")} style={{ paddingLeft: row.indent * 14 + 12 }}>{row.label}</td>
                  {row.cells.map((val, j) => {
                    const fig = figsByRow[i][j];
                    const check = otherRecordCheck(fig);
                    return [
                      <td key={`${j}c`} className="whitespace-nowrap border-l border-border/50 px-2 py-2.5 text-right text-xs tabular-nums"><CimCell fig={fig} text={val} /></td>,
                      <td key={`${j}o`} className="whitespace-nowrap px-2 py-2.5 text-right text-xs tabular-nums" style={cellTint(check)}>
                        {fig && check ? <OtherCell fig={fig} check={check} /> : null}
                      </td>,
                    ];
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {footer}
    </div>
  );
}
