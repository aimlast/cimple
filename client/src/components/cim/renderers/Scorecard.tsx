/**
 * Scorecard renderer
 * Rows of label | progress bar | score. Optional benchmark marker.
 * Green >75, amber 50–75, red <50.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface ScorecardItem {
  label: string;
  score: number;
  benchmark?: number;
  description?: string;
}

interface ScorecardLayoutData {
  items?: ScorecardItem[];
  title?: string;
  maxScore?: number;
}

interface RendererProps {
  layoutData: ScorecardLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

function scoreColor(pct: number): string {
  if (pct >= 75) return "bg-success";
  if (pct >= 50) return "bg-amber-400";
  return "bg-destructive";
}

function scoreTextColor(pct: number): string {
  if (pct >= 75) return "text-success";
  if (pct >= 50) return "text-amber-500";
  return "text-destructive";
}

export function ScorecardRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: ScorecardLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const items = data.items || [];
  const maxScore = data.maxScore || 100;

  if (items.length === 0) {
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
      <div className="space-y-4">
        {items.map((item, i) => {
          const pct = Math.min(100, Math.max(0, (item.score / maxScore) * 100));
          const benchmarkPct = item.benchmark != null
            ? Math.min(100, Math.max(0, (item.benchmark / maxScore) * 100))
            : null;

          return (
            <div key={i} className="space-y-1.5">
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-foreground leading-snug">{item.label}</p>
                  {item.description && (
                    <p className="text-2xs text-muted-foreground mt-0.5">{item.description}</p>
                  )}
                </div>
                <span className={cn("text-sm font-semibold tabular-nums flex-shrink-0", scoreTextColor(pct))}>
                  {item.score}/{maxScore}
                </span>
              </div>

              {/* Progress bar */}
              <div className="relative h-2 bg-muted rounded-full overflow-hidden">
                <div
                  className={cn("h-full rounded-full transition-all", scoreColor(pct))}
                  style={{ width: `${pct}%` }}
                />
                {/* Benchmark marker */}
                {benchmarkPct != null && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-foreground/30 rounded-full"
                    style={{ left: `${benchmarkPct}%` }}
                    title={`Benchmark: ${item.benchmark}`}
                  />
                )}
              </div>

              {/* Benchmark label */}
              {benchmarkPct != null && item.benchmark != null && (
                <div className="relative h-3" style={{ fontSize: 0 }}>
                  <span
                    className="absolute text-2xs text-muted-foreground/60 -translate-x-1/2"
                    style={{ left: `${benchmarkPct}%`, fontSize: "0.625rem" }}
                  >
                    Benchmark: {item.benchmark}
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
