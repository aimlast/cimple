/**
 * The coverage headline: "87% of the CIM's information collected", the
 * critical items still open (brass, beside the percent), a stacked bar
 * (every non-zero segment at least 6 px, "to verify" hatched) and the four
 * counts — each a filter link. CIM quality is only a label, with a tooltip
 * explaining how it differs from the percent.
 */
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  COVERAGE_STATUSES,
  QUALITY_TOOLTIP,
  headline,
  type CoverageBoard,
  type CoverageFilter,
  type CoverageItemStatus,
} from "@shared/coverage-board";

const SHORT_COUNT: Record<CoverageItemStatus, string> = { on_file: "on file", partial: "partial", verify: "to verify", missing: "missing" };

export function CoverageBar({ board, className = "", height = 6 }: { board: Pick<CoverageBoard, "totals">; className?: string; height?: number }) {
  const t = board.totals;
  return (
    <div className={`flex w-full gap-[2px] overflow-hidden rounded-full bg-muted ${className}`} style={{ height }} data-testid="coverage-bar" aria-hidden>
      {COVERAGE_STATUSES.map((s) =>
        t[s] > 0 ? (
          <div key={s} className={`cov-bg-${s} cov-animate transition-[flex-grow] duration-500`} style={{ flexGrow: t[s], flexBasis: 0, minWidth: 6 }} />
        ) : null,
      )}
    </div>
  );
}

function QualityLabel({ label, className = "" }: { label: string; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className={`inline-flex items-center gap-1 text-muted-foreground hover:text-foreground ${className}`} data-testid="coverage-quality">
          Quality: <span className="text-teal font-medium">{label}</span>
          <Info className="h-3 w-3" aria-label="How quality differs from the percent" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-xs leading-relaxed">{QUALITY_TOOLTIP}</TooltipContent>
    </Tooltip>
  );
}

export function CoverageHeadline({
  board,
  variant = "strip",
  onFilter,
  sessionFiled,
  activeFilter,
}: {
  board: Pick<CoverageBoard, "totals" | "percentCollected" | "quality">;
  variant?: "strip" | "phone" | "compact";
  onFilter?: (f: CoverageFilter) => void;
  /** Live sessions: "This session: N filed". */
  sessionFiled?: number;
  activeFilter?: CoverageFilter;
}) {
  const h = headline(board);
  const countLink = (s: CoverageItemStatus, n: number, compact = false) => {
    const filter: CoverageFilter = s === "on_file" ? "all" : s;
    const content = (
      <>
        <span className={`inline-block h-2 w-2 rounded-[2px] cov-bg-${s}`} aria-hidden />
        <span className="tabular-nums font-medium text-foreground" data-testid={`coverage-count-${s}`}>{n}</span>
        <span className="text-muted-foreground">{compact && s === "verify" ? "verify" : SHORT_COUNT[s]}</span>
      </>
    );
    if (!onFilter || s === "on_file") return <span key={s} className="inline-flex items-center gap-1.5">{content}</span>;
    return (
      <button
        key={s}
        type="button"
        onClick={() => onFilter(filter)}
        className={`inline-flex items-center gap-1.5 rounded px-1 -mx-1 hover:bg-accent ${activeFilter === filter ? "bg-accent" : ""}`}
        data-testid={`coverage-filter-link-${s}`}
      >
        {content}
      </button>
    );
  };
  const critical = h.criticalOpen > 0 && onFilter ? (
    <button type="button" onClick={() => onFilter("critical")} className="text-teal font-semibold hover:underline underline-offset-2" data-testid="coverage-critical-open">
      {variant === "phone" ? h.criticalShort : `${h.critical} →`}
    </button>
  ) : (
    <span className={h.criticalOpen > 0 ? "text-teal font-semibold" : "text-success font-medium"} data-testid="coverage-critical-open">
      {variant === "phone" ? h.criticalShort : h.critical}
    </span>
  );

  if (variant === "phone") {
    return (
      <div className="space-y-2" data-testid="coverage-headline">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0"><span className="text-3xl font-semibold tabular-nums tracking-tight" data-testid="coverage-percent">{h.percent}%</span> <span className="text-sm text-muted-foreground">collected</span></p>
          <span className="text-sm shrink-0">{critical}</span>
        </div>
        <CoverageBar board={board} height={8} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px]">
          {COVERAGE_STATUSES.map((s) => countLink(s, board.totals[s], true))}
        </div>
        <QualityLabel label={board.quality.label} className="text-xs" />
      </div>
    );
  }

  if (variant === "compact") {
    return (
      <div className="space-y-2" data-testid="coverage-headline">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <span className="text-xl font-semibold tabular-nums" data-testid="coverage-percent">{h.percent}%</span>
          <span className="text-xs text-muted-foreground">collected</span>
          <span className="text-xs">·</span>
          <span className="text-xs">{critical}</span>
        </div>
        <CoverageBar board={board} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
          {COVERAGE_STATUSES.map((s) => countLink(s, board.totals[s], true))}
          <QualityLabel label={board.quality.label} className="text-[11px]" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-end gap-x-8 gap-y-3" data-testid="coverage-headline">
      <div className="min-w-0 flex-1 basis-[32rem]">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="text-4xl font-semibold tabular-nums tracking-tight" data-testid="coverage-percent">{h.percent}%</span>
          <span className="text-sm text-muted-foreground">of the CIM's information collected</span>
          <span className="text-sm">{critical}</span>
        </div>
        <CoverageBar board={board} className="mt-2.5 max-w-xl" />
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-sm">
        {COVERAGE_STATUSES.map((s) => countLink(s, board.totals[s]))}
      </div>
      <div className="ml-auto flex items-center gap-4 text-xs">
        {sessionFiled !== undefined && (
          <span className="text-muted-foreground">This session: <span className="text-foreground font-medium tabular-nums">{sessionFiled} filed</span></span>
        )}
        <QualityLabel label={board.quality.label} />
      </div>
    </div>
  );
}
