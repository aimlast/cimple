/**
 * DdSourceCheck — "How the figures check out" (due diligence only; spec §4.7).
 * Its layoutData is structure only ({ v, lines, years }); the values, states
 * and reasons come from the figure layer, so every cell opens the same popover
 * as the figure elsewhere in the CIM. Wide: a line × year grid; under 520 px:
 * one card per line with a row per year. Block keys: intro, summary, row:i.
 * Without a figure layer (the heat map's page canvas) it draws the structure.
 */
import { useEffect, useRef, useState } from "react";
import type { CimSection } from "@shared/schema";
import { SOURCE_CHECK_INTRO, SOURCE_CHECK_TABLE, sourceCheckSummary } from "@shared/figure-copy";
import { sourceCheckRowLabel, type FigureDocRef, type FigureView } from "@shared/figure-layer";
import { STATE_PAINT, STATE_WORDS } from "@shared/figure-states";
import { useBlockAttrs } from "../blocks";
import { useFigureLayer, useFigureLookup } from "../figures/FigureLayerContext";
import { FigureTrigger } from "../figures/FigureValue";
import { FigureCitation } from "../figures/FigureCitation";
import { otherRecordCheck, StateIcon } from "../figures/figurePaint";

interface Props {
  layoutData: { v?: number; lines?: string[]; years?: string[] };
  section: CimSection;
}

function Cell({ fig }: { fig: FigureView | null }) {
  const check = otherRecordCheck(fig) ?? fig?.checks?.[0] ?? null;
  if (!fig || !check) return <span className="text-[hsl(var(--cim-ink-faint))]" aria-label="Not compared"> </span>;
  const differs = check.state !== "match";
  return (
    <FigureTrigger fig={fig} showState={false}>
      <span className="inline-flex items-center gap-1 tabular-nums" title={STATE_WORDS[check.state]}>
        <StateIcon state={check.state} />
        {differs && check.difference && <span className="text-[11px]" style={{ color: STATE_PAINT[check.state].ink }}>{check.difference}</span>}
      </span>
    </FigureTrigger>
  );
}

export function DdSourceCheckRenderer({ layoutData }: Props) {
  const ba = useBlockAttrs();
  const ctx = useFigureLayer();
  const lookup = useFigureLookup();
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => setNarrow((el.clientWidth || 800) < 520));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const lines = Array.isArray(layoutData?.lines) ? layoutData.lines : [];
  const years = Array.isArray(layoutData?.years) ? layoutData.years : [];
  if (lines.length === 0) return null;
  const summary = ctx?.layer.summary;
  const grid = lines.map((_l, i) => years.map((_y, j) => lookup(`row:${i}`, j)));
  const statements = new Map<string, FigureDocRef>();
  const others = new Map<string, FigureDocRef>();
  for (const row of grid) for (const f of row) {
    for (const c of f?.checks ?? []) {
      if (c.baseCitation) statements.set(c.baseCitation.documentId, c.baseCitation);
      if (c.citation && !c.kindLabel.startsWith("Financial statements")) others.set(c.citation.documentId, c.citation);
    }
  }
  const byPeriod = (a: FigureDocRef, b: FigureDocRef) => String(a.period ?? "").localeCompare(String(b.period ?? ""));

  return (
    <div ref={ref}>
      <p {...ba("intro")} className="mb-3 max-w-prose text-sm leading-relaxed text-[hsl(var(--cim-ink-soft))]">{SOURCE_CHECK_INTRO}</p>
      <p {...ba("summary")} className="mb-4 text-sm font-medium text-[hsl(var(--cim-ink))]">{summary ? sourceCheckSummary(summary) : " "}</p>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-[hsl(var(--cim-ink-muted))]">{SOURCE_CHECK_TABLE}</p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[hsl(var(--cim-ink-muted))]">
          {statements.size > 0 && <span className="inline-flex flex-wrap items-center gap-1">Statements: {Array.from(statements.values()).sort(byPeriod).map((r) => <FigureCitation key={r.documentId} docRef={r} />)}</span>}
          {others.size > 0 && <span className="inline-flex flex-wrap items-center gap-1">Tax returns: {Array.from(others.values()).sort(byPeriod).map((r) => <FigureCitation key={r.documentId} docRef={r} />)}</span>}
        </div>
      </div>
      {narrow ? (
        <div className="space-y-2">
          {lines.map((line, i) => (
            <div key={line} {...ba(`row:${i}`)} className="rounded-lg border border-card-border bg-card px-3 py-2">
              <p className="mb-1 text-xs font-semibold text-[hsl(var(--cim-ink))]">{sourceCheckRowLabel(line)}</p>
              <ul className="space-y-1">
                {years.map((y, j) => (
                  <li key={y} className="flex items-center justify-between text-xs">
                    <span className="text-[hsl(var(--cim-ink-muted))]">FY{y}</span>
                    <Cell fig={grid[i][j]} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-card-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-card-border bg-muted/50">
                <th className="px-3 py-2 text-left text-xs font-semibold text-muted-foreground"> </th>
                {years.map((y) => <th key={y} scope="col" className="px-3 py-2 text-right text-xs font-semibold text-muted-foreground">FY{y}</th>)}
              </tr>
            </thead>
            <tbody>
              {lines.map((line, i) => (
                <tr key={line} {...ba(`row:${i}`)} className="border-b border-border/50 last:border-0">
                  <td className="px-3 py-2 text-xs text-foreground/80">{sourceCheckRowLabel(line)}</td>
                  {years.map((y, j) => (
                    <td key={y} className="px-3 py-2 text-right text-xs" style={(() => { const c = otherRecordCheck(grid[i][j]); const p = c ? STATE_PAINT[c.state] : null; return p?.tint ? { backgroundColor: p.tint, boxShadow: `inset ${p.ruleWidth}px 0 0 ${p.rule}` } : undefined; })()}>
                      <Cell fig={grid[i][j]} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
