/**
 * The KPI strip: two joined blocks of numbers (the dashboard's stat-cell
 * style: one block, hairline gaps, mono numerals, a brass hairline on hover).
 *
 *   NEEDS YOU NOW   Worth a call · Waiting on you     "right now"; no period
 *   <period>        [Opened the CIM] · Buyers who read · NDAs signed · Said
 *                   interested, with the period control in the block's own header
 *
 * Every cell is a button: hover (mouse) says how it's counted; a click or tap
 * opens a popover with the same sentence, who is counted (≤ 20, each a link)
 * and a footer link to exactly that set.
 */
import { useState, type ReactNode } from "react";
import { Link } from "wouter";
import { ArrowRight, ChevronDown } from "lucide-react";
import {
  dayMonth,
  plural,
  type DashboardRange,
  type Kpi,
  type KpiWho,
} from "@shared/analytics-dashboard";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelError } from "@/components/deal/PanelError";
import { cn } from "@/lib/utils";
import { InfoDot, useCanHover } from "./Explain";

export const NOW_BLOCK_EXPLAIN = "Things you can act on today. The date range doesn't change these.";
export const SAMPLE_TIP = "Sample reading: this example deal's buyers and reading are made up.";

const NOW_ORDER = ["to_call", "waiting"] as const;
const PERIOD_ORDER = ["opened", "reading", "nda", "interested"] as const;

export interface KpiFooter { label: string; href?: string; onClick?(): void }

export interface KpiStripProps {
  kpis: Kpi[] | undefined;
  /** The period these numbers follow (popover wording). */
  range: DashboardRange;
  loading?: boolean;
  error?: boolean;
  onRetry?(): void;
  /** md = the Analytics page (28 px numerals); sm = the deal tab (22 px). */
  size?: "md" | "sm";
  /** The period block's title: "Buyers" (Analytics) or the filters in words ("All time · All buyers"). */
  periodTitle: string;
  /** The period control, in the period block's header. */
  periodControl?: ReactNode;
  /** The right end of the period block's header (the example-deals caption). */
  periodAside?: ReactNode;
  /** Show the deal name on who rows (the Analytics page; never on one deal). */
  showDeal?: boolean;
  /** A who row was chosen; return true when handled in place (the deal tab selects the buyer). */
  onWho?(w: KpiWho): boolean | void;
  /** The popover's footer link. */
  footerFor(kpi: Kpi): KpiFooter | null;
  /** Below md: one tappable line instead of the blocks (the deal tab's other views). */
  collapsible?: boolean;
}

/** "13 opened · 5 interested · 5 worth a call · 2 waiting" — the strip in one line (phones, heat map view). */
export function kpiOneLine(kpis: Kpi[]): string {
  const v = (id: Kpi["id"]) => kpis.find((k) => k.id === id);
  const parts: string[] = [];
  const opened = v("opened");
  if (opened) parts.push(`${opened.value} opened`);
  else {
    const reading = v("reading");
    if (reading) parts.push(`${reading.value} read`);
  }
  const interested = v("interested");
  if (interested) parts.push(`${interested.value} interested`);
  const call = v("to_call");
  if (call) parts.push(`${call.value} worth a call`);
  const waiting = v("waiting");
  if (waiting && waiting.value > 0) parts.push(`${waiting.value} waiting`);
  return parts.join(" · ");
}

export function KpiStrip(props: KpiStripProps) {
  const { kpis, loading, error, onRetry, size = "md", collapsible } = props;
  const [expanded, setExpanded] = useState(false);
  if (error && !kpis) {
    return <PanelError what="the numbers" onRetry={() => onRetry?.()} />;
  }
  const byId = new Map((kpis ?? []).map((k) => [k.id, k]));
  const now = NOW_ORDER.map((id) => byId.get(id)).filter((k): k is Kpi => !!k);
  const period = PERIOD_ORDER.map((id) => byId.get(id)).filter((k): k is Kpi => !!k);
  const periodCount = kpis ? Math.max(period.length, 1) : size === "sm" ? 4 : 3;
  const blocks = (
    <div
      className={cn("grid gap-3", periodCount >= 4 ? "lg:grid-cols-[2fr_4fr]" : "lg:grid-cols-[2fr_3fr]")}
      data-testid="kpi-strip"
    >
      <KpiBlock
        title="Needs you now"
        info={NOW_BLOCK_EXPLAIN}
        cells={now}
        count={2}
        loading={loading && !kpis}
        size={size}
        strip={props}
        testId="kpi-block-now"
      />
      <KpiBlock
        title={props.periodTitle}
        control={props.periodControl}
        aside={props.periodAside}
        cells={period}
        count={periodCount}
        loading={loading && !kpis}
        size={size}
        strip={props}
        testId="kpi-block-period"
      />
    </div>
  );
  if (!collapsible || !kpis) return blocks;
  return (
    <div>
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-2 rounded-lg border border-border/70 bg-card px-3 py-2 text-left text-xs text-muted-foreground md:hidden"
        data-testid="kpi-oneline"
      >
        <span className="min-w-0 flex-1 truncate tabular-nums text-foreground/90">{kpiOneLine(kpis)}</span>
        <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>
      <div className={cn(expanded ? "mt-2 block" : "hidden", "md:mt-0 md:block")}>{blocks}</div>
    </div>
  );
}

function KpiBlock({
  title, info, control, aside, cells, count, loading, size, strip, testId,
}: {
  title: string;
  info?: string;
  control?: ReactNode;
  aside?: ReactNode;
  cells: Kpi[];
  count: number;
  loading?: boolean;
  size: "md" | "sm";
  strip: KpiStripProps;
  testId: string;
}) {
  const n = loading ? count : cells.length;
  return (
    <section className="min-w-0 overflow-hidden rounded-xl border border-border/70 bg-card" data-testid={testId} aria-label={title}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/70 px-4 py-2">
        <h2 className="order-1 flex min-w-0 items-center gap-1.5 font-mono text-2xs font-medium uppercase tracking-[0.14em] text-muted-foreground">
          <span className="truncate">{title}</span>
          {info && <InfoDot text={info} />}
        </h2>
        {aside && <div className="order-2 ml-auto flex items-center sm:order-3 sm:ml-0">{aside}</div>}
        {control && <div className="order-3 flex w-full items-center sm:order-2 sm:ml-auto sm:w-auto">{control}</div>}
      </header>
      <div className={cn("grid grid-cols-2 gap-px bg-border/70", n === 3 ? "sm:grid-cols-3" : n >= 4 ? "sm:grid-cols-4" : "")}>
        {loading
          ? Array.from({ length: count }, (_, i) => (
              <div key={i} className={cn("bg-card px-4 py-3", count % 2 === 1 && i === count - 1 && "col-span-2 sm:col-span-1")}>
                <Skeleton className="h-2.5 w-20" />
                <Skeleton className={cn("mt-3", size === "sm" ? "h-5 w-10" : "h-7 w-12")} />
                <Skeleton className="mt-2 h-2.5 w-24" />
              </div>
            ))
          : cells.map((k, i) => (
              <KpiCell
                key={k.id}
                kpi={k}
                size={size}
                strip={strip}
                wide={cells.length % 2 === 1 && i === cells.length - 1}
              />
            ))}
      </div>
    </section>
  );
}

function KpiCell({ kpi, size, strip, wide }: { kpi: Kpi; size: "md" | "sm"; strip: KpiStripProps; wide: boolean }) {
  const canHover = useCanHover();
  const [open, setOpen] = useState(false);
  const [tip, setTip] = useState(false);
  const descId = `kpi-${kpi.id}-explain`;
  const alert = kpi.id === "waiting" && kpi.value > 0;
  const button = (
    <button
      type="button"
      aria-describedby={descId}
      className={cn(
        "group relative flex h-full w-full flex-col items-start bg-card text-left transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-teal",
        size === "sm" ? "px-3.5 py-2.5 sm:px-4" : "px-3.5 py-2.5 sm:px-4 sm:py-3.5",
        wide && "col-span-2 sm:col-span-1",
        open && "bg-muted/20",
      )}
      data-testid={`kpi-${kpi.id}`}
    >
      <span className="w-full truncate text-2xs font-medium uppercase tracking-[0.12em] text-muted-foreground/80">
        <span className="sm:hidden">{kpi.shortLabel}</span>
        <span className="hidden sm:inline">{kpi.label}</span>
      </span>
      <span
        className={cn(
          "mt-1.5 font-mono font-medium leading-none tabular-nums",
          size === "sm" ? "text-[22px]" : "text-[22px] sm:text-[28px]",
          alert ? "text-teal" : "text-foreground",
        )}
        data-testid={`kpi-${kpi.id}-value`}
      >
        <KpiDisplay text={kpi.display} />
      </span>
      <span className="mt-1.5 line-clamp-2 min-h-[1rem] text-[11px] leading-snug text-muted-foreground sm:text-xs" data-testid={`kpi-${kpi.id}-sub`}>
        {kpi.sub ?? " "}
      </span>
      <span id={descId} className="sr-only">{kpi.explain}</span>
      <span className="absolute bottom-0 left-4 right-4 h-px bg-teal/0 transition-colors group-hover:bg-teal/40" aria-hidden />
    </button>
  );
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setTip(false); }}>
      {canHover ? (
        <Tooltip open={tip && !open} onOpenChange={setTip} delayDuration={300}>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>{button}</PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs text-xs leading-relaxed">{kpi.explain}</TooltipContent>
        </Tooltip>
      ) : (
        <PopoverTrigger asChild>{button}</PopoverTrigger>
      )}
      <PopoverContent align="start" className="w-[22rem] max-w-[calc(100vw-2rem)] p-0" data-testid={`kpi-popover-${kpi.id}`}>
        <KpiPopover kpi={kpi} strip={strip} onDone={() => setOpen(false)} />
      </PopoverContent>
    </Popover>
  );
}

/** "13 of 13": the numbers in mono, the word in the text face (mono spacing makes " of " look odd). */
export function KpiDisplay({ text }: { text: string }) {
  const m = /^(\S+) of (\S+)$/.exec(text);
  if (!m) return <>{text}</>;
  return (
    <>
      {m[1]}
      <span className="mx-1 font-sans text-[0.55em] font-normal text-muted-foreground">of</span>
      {m[2]}
    </>
  );
}

const WHO_KIND: Record<KpiWho["kind"], string> = {
  buyer: "",
  question: "Question",
  cim_request: "Asked for the CIM",
  approval: "Waiting for your approval",
};

function whoHeading(kpi: Kpi, range: DashboardRange): string {
  if (kpi.id === "waiting") return "What's waiting";
  if (kpi.id === "opened" && range === "all") return "Haven't opened yet";
  return "Who's counted";
}

/** The popover body (exported for tests). */
export function KpiPopover({ kpi, strip, onDone }: { kpi: Kpi; strip: Pick<KpiStripProps, "range" | "showDeal" | "onWho" | "footerFor">; onDone?(): void }) {
  const footer = strip.footerFor(kpi);
  const pick = (w: KpiWho, e: React.MouseEvent) => {
    if (strip.onWho?.(w)) {
      e.preventDefault();
      onDone?.();
    } else onDone?.();
  };
  return (
    <div className="text-sm">
      <p className="border-b border-border/70 px-4 py-3 text-xs leading-relaxed text-muted-foreground">{kpi.explain}</p>
      {kpi.who.length > 0 ? (
        <div className="px-2 py-2">
          <p className="px-2 pb-1 font-mono text-2xs uppercase tracking-[0.14em] text-muted-foreground/80">{whoHeading(kpi, strip.range)}</p>
          <ul className="max-h-64 overflow-y-auto" data-testid="kpi-who">
            {kpi.who.map((w, i) => (
              <li key={`${w.kind}:${w.accessId ?? ""}:${i}`}>
                <Link
                  href={w.href}
                  onClick={(e: React.MouseEvent) => pick(w, e)}
                  className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline gap-x-1.5">
                      {WHO_KIND[w.kind] && <span className="text-2xs font-medium uppercase tracking-wide text-teal">{WHO_KIND[w.kind]}</span>}
                      <span className="font-medium text-foreground">{w.name}</span>
                      {w.company && <span className="truncate text-xs text-muted-foreground">{w.company}</span>}
                      {w.sample && <SampleTag />}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[strip.showDeal ? w.dealName : null, w.kind === "buyer" || w.kind === "question" ? w.note : null].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                  {w.at && <span className="shrink-0 pt-0.5 text-2xs tabular-nums text-muted-foreground">{dayMonth(w.at)}</span>}
                </Link>
              </li>
            ))}
          </ul>
          {kpi.whoMore > 0 && <p className="px-2 pt-1 text-xs text-muted-foreground">and {kpi.whoMore} more</p>}
        </div>
      ) : (
        <p className="px-4 py-3 text-xs text-muted-foreground">{kpi.id === "waiting" ? "Nothing is waiting on you." : "Nobody yet."}</p>
      )}
      {kpi.id === "waiting" && kpi.whoMore > 0 && kpi.byDeal && kpi.byDeal.length > 0 && (
        <p className="border-t border-border/70 px-4 py-2 text-xs text-muted-foreground" data-testid="kpi-by-deal">
          {kpi.byDeal.map((d, i) => (
            <span key={d.dealId}>
              {i > 0 && " · "}
              <Link href={d.href} onClick={onDone} className="text-teal hover:underline">{d.dealName}: {d.count}</Link>
            </span>
          ))}
        </p>
      )}
      {kpi.id === "waiting" && (kpi.sellerPending ?? 0) > 0 && (
        <p className="border-t border-border/70 px-4 py-2 text-xs text-muted-foreground">
          Also waiting for the seller's OK: {plural(kpi.sellerPending ?? 0, "answer")}
        </p>
      )}
      {footer && (
        <div className="border-t border-border/70 px-4 py-2.5">
          {footer.href ? (
            <Link href={footer.href} onClick={onDone} className="inline-flex items-center gap-1 text-xs font-medium text-teal hover:underline" data-testid="kpi-footer">
              {footer.label} <ArrowRight className="h-3 w-3" />
            </Link>
          ) : (
            <button type="button" onClick={() => { footer.onClick?.(); onDone?.(); }} className="inline-flex items-center gap-1 text-xs font-medium text-teal hover:underline" data-testid="kpi-footer">
              {footer.label} <ArrowRight className="h-3 w-3" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** The small "Sample" tag on example-deal sample reading. */
export function SampleTag({ className }: { className?: string }) {
  return (
    <span
      title={SAMPLE_TIP}
      className={cn("inline-flex items-center rounded border border-dashed border-border px-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground", className)}
      data-testid="sample-tag"
    >
      Sample
    </span>
  );
}
