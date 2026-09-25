/**
 * Scorecard renderer
 * Rows of label | progress bar | score. Optional benchmark marker.
 * Green >75, amber 50–75, red <50.
 *
 * Scores must be numbers on one scale. When any isn't ("Satisfactory",
 * "PIP", "9.4%") the section is drawn as a plain list of results — never
 * "Satisfactory/100" over a full red bar, as buyers saw on Pacific's
 * compliance page. Benchmark labels stay inside the card at either end.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { numericScore, scorecardIsNumeric } from "@shared/cim-layouts";
import { ProseFallback, renderInline } from "../richText";

interface ScorecardItem {
  label: string;
  score: number | string;
  benchmark?: number | string;
  description?: string;
}

interface ScorecardLayoutData {
  items?: ScorecardItem[];
  title?: string;
  maxScore?: number | string;
}

interface RendererProps {
  layoutData: ScorecardLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

function scoreColor(pct: number): string {
  if (pct >= 75) return "bg-success";
  if (pct >= 50) return "bg-[hsl(var(--cim-caution))]";
  return "bg-destructive";
}

function scoreTextColor(pct: number): string {
  if (pct >= 75) return "text-success";
  // The template's caution colour (contrast-checked against its paper)
  if (pct >= 50) return "text-[hsl(var(--cim-caution))]";
  return "text-destructive";
}

/** Where a benchmark label sits: pinned to the edge near either end, centred elsewhere. */
export function benchmarkLabelPlacement(pct: number): { left?: string; right?: string; transform: string } {
  if (pct <= 10) return { left: "0%", transform: "none" };
  if (pct >= 90) return { right: "0%", transform: "none" };
  return { left: `${pct}%`, transform: "translateX(-50%)" };
}

const Title = ({ title }: { title?: string }) =>
  title ? <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">{title}</h3> : null;

export function ScorecardRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: ScorecardLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const items = (data.items || []).filter((it) => it && typeof it === "object");
  const maxScore = numericScore(data.maxScore) || 100;

  if (items.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  // Results that aren't scores: label, result, context — no bars, no "/100".
  if (!scorecardIsNumeric({ items })) {
    return (
      <div>
        <Title title={data.title} />
        <div className="divide-y divide-border/60 rounded-lg border border-card-border bg-card">
          {items.map((item, i) => (
            <div key={i} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-foreground leading-snug">{item.label}</p>
                {item.description && (
                  <p className="text-2xs text-muted-foreground mt-0.5 leading-snug">{renderInline(item.description, `d${i}`)}</p>
                )}
              </div>
              <div className="sm:text-right sm:max-w-[45%] flex-shrink-0">
                {item.score != null && String(item.score).trim() !== "" && (
                  <p className="text-sm font-semibold text-foreground break-words">{String(item.score)}</p>
                )}
                {item.benchmark != null && String(item.benchmark).trim() !== "" && (
                  <p className="text-2xs text-muted-foreground mt-0.5 break-words">Benchmark: {String(item.benchmark)}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div>
      <Title title={data.title} />
      <div className="space-y-4">
        {items.map((item, i) => {
          const score = numericScore(item.score) ?? 0;
          const pct = Math.min(100, Math.max(0, (score / maxScore) * 100));
          const benchmark = numericScore(item.benchmark);
          const benchmarkPct = benchmark != null ? Math.min(100, Math.max(0, (benchmark / maxScore) * 100)) : null;
          const benchmarkText = benchmark == null && item.benchmark != null && String(item.benchmark).trim() ? String(item.benchmark) : null;

          return (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground leading-snug">{item.label}</p>
                  {item.description && (
                    <p className="text-2xs text-muted-foreground mt-0.5">{renderInline(item.description, `d${i}`)}</p>
                  )}
                </div>
                <span className={cn("text-sm font-semibold tabular-nums flex-shrink-0", scoreTextColor(pct))}>
                  {score}/{maxScore}
                </span>
              </div>

              {/* Progress bar */}
              <div className="relative h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all", scoreColor(pct))}
                  style={{ width: `${pct}%` }}
                />
                {benchmarkPct != null && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-foreground/30 rounded-full"
                    style={{ left: `${benchmarkPct}%` }}
                    title={`Benchmark: ${benchmark}`}
                  />
                )}
              </div>

              {/* Benchmark label — kept inside the card at either end */}
              {benchmarkPct != null && (
                <div className="relative h-3 overflow-hidden">
                  <span
                    className="absolute top-0 whitespace-nowrap text-muted-foreground/60"
                    style={{ ...benchmarkLabelPlacement(benchmarkPct), fontSize: "0.625rem" }}
                    data-benchmark-label
                  >
                    Benchmark: {benchmark}
                  </span>
                </div>
              )}
              {benchmarkText && <p className="text-muted-foreground/60" style={{ fontSize: "0.625rem" }}>Benchmark: {benchmarkText}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
