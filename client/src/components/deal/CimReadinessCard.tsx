/**
 * CimReadinessCard — "how good will the CIM be with what we know?" as one
 * honest score with the gaps that are holding it down.
 *
 * `compact` renders a one-line badge (interview header, CIM preview header);
 * the full card shows the bar, the per-level tally and the top gaps.
 */
import { AlertCircle, CheckCircle2, Clock } from "lucide-react";
import { Progress } from "@/components/ui/progress";
import type { CimReadiness } from "@shared/cim-readiness";

const LABEL_CLASS: Record<CimReadiness["label"], string> = {
  "Buyer-ready": "text-success",
  Solid: "text-teal",
  Developing: "text-foreground",
  Thin: "text-muted-foreground",
};

const LEVEL_LABEL = { critical: "Critical", important: "Important", helpful: "Helpful" } as const;

export function CimReadinessBadge({ readiness, className = "" }: { readiness: CimReadiness; className?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs tabular-nums ${className}`}
      title={readiness.summary}
      data-testid="cim-readiness-badge"
    >
      <span className="text-muted-foreground">CIM quality</span>
      <span className={`font-semibold ${LABEL_CLASS[readiness.label]}`}>{readiness.label}</span>
      <span className="text-muted-foreground/70">{readiness.score}</span>
    </span>
  );
}

interface CardProps {
  readiness: CimReadiness;
  className?: string;
  /** Shown under the summary — e.g. "Continue the interview to close these gaps." */
  hint?: string;
  /** Hide the per-gap list (seller-facing surfaces keep it lighter). */
  hideGaps?: boolean;
}

export function CimReadinessCard({ readiness, className = "", hint, hideGaps = false }: CardProps) {
  const { score, label, summary, byLevel, gaps } = readiness;
  return (
    <div className={`rounded-lg border border-border/60 bg-card/50 p-4 ${className}`} data-testid="cim-readiness-card">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">CIM information quality</p>
        <p className="text-sm tabular-nums">
          <span className={`font-semibold ${LABEL_CLASS[label]}`}>{label}</span>
          <span className="text-muted-foreground/70"> · {score}/100</span>
        </p>
      </div>
      <Progress value={score} className="h-1.5 mt-2" />
      <p className="text-xs text-muted-foreground mt-2">{summary}</p>
      {hint && <p className="text-[11px] text-muted-foreground/70 mt-1">{hint}</p>}

      <div className="mt-3 grid grid-cols-3 gap-2 text-[11px]">
        {(["critical", "important", "helpful"] as const).map((level) => {
          const t = byLevel[level];
          return (
            <div key={level} className="rounded border border-border/50 px-2 py-1.5">
              <p className="text-muted-foreground">{LEVEL_LABEL[level]}</p>
              <p className="tabular-nums">
                <span className="font-medium">{t.covered}</span>
                <span className="text-muted-foreground/70">/{t.total} covered</span>
                {t.partial > 0 && <span className="text-muted-foreground/70"> · {t.partial} partial</span>}
              </p>
            </div>
          );
        })}
      </div>

      {!hideGaps && gaps.length > 0 && (
        <ul className="mt-3 space-y-1">
          {gaps.map((g) => (
            <li key={g.key} className="flex items-start gap-2 text-xs" title={g.reason || undefined}>
              {g.status === "missing" ? (
                <AlertCircle className={`h-3 w-3 mt-0.5 shrink-0 ${g.importance === "critical" ? "text-teal" : "text-muted-foreground/60"}`} />
              ) : (
                <Clock className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground/60" />
              )}
              <span className="min-w-0">
                <span className={g.importance === "critical" ? "text-foreground" : "text-muted-foreground"}>{g.title}</span>
                <span className="text-muted-foreground/60"> · {LEVEL_LABEL[g.importance]} · {g.status === "missing" ? "missing" : "partial"}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {!hideGaps && gaps.length === 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-xs text-success">
          <CheckCircle2 className="h-3 w-3" /> Every section is well covered.
        </p>
      )}
    </div>
  );
}
