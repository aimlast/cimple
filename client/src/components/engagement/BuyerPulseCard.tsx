/**
 * Buyer pulse — the deal Overview's engagement card.
 *
 *   placement "top"     under the published-version banner, only once the CIM
 *                       is live with CIM buyers: four mini numbers ("13 of 13
 *                       opened · 13 have read it, last on 23 Sept · 5
 *                       interested · 1 waiting on you"), who is reading now,
 *                       the first three to call (never anyone who said no),
 *                       and the most studied page
 *   placement "bottom"  at the foot of the Overview, only otherwise (the
 *                       plain "once buyers open it…" sentence)
 * Both mounts share one cached request (the deal's KPI response) plus the
 * cheap "reading now" poll. Never a weekly 0: with nobody reading this week
 * it says when they last read.
 */
import { useLocation } from "wouter";
import { ArrowRight, BookOpenText, ChevronRight, Radio } from "lucide-react";
import { DEFAULT_ENGAGEMENT_FILTERS, formatReadingTime } from "@shared/analytics-v2";
import { dayMonth, type DealKpisResponse, type ReadingNowRow } from "@shared/analytics-dashboard";
import { useDealKpis, useDealReadingNow } from "@/hooks/useAnalyticsDashboard";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { InfoDot } from "@/components/analytics/Explain";
import { KpiDisplay } from "@/components/analytics/KpiStrip";
import { Chip } from "@/components/analytics/parts";
import { cn } from "@/lib/utils";
import { StatusChip } from "./buyers/parts";

const SAMPLE_TIP = "This is an example deal: its buyers and their reading are made up.";

/** The pulse's mini numbers, in words (exported for tests; never "0 reading this week"). */
export function pulseStats(k: DealKpisResponse): Array<{ key: string; value: string; words: string; title: string }> {
  const kpi = (id: string) => k.kpis.find((x) => x.id === id);
  const opened = kpi("opened");
  const interested = kpi("interested");
  const waiting = kpi("waiting");
  const out: Array<{ key: string; value: string; words: string; title: string }> = [];
  if (opened) out.push({ key: "opened", value: opened.display, words: "opened", title: opened.explain });
  const readingTitle = kpi("reading")?.explain ?? "";
  if (k.readersWeek > 0) out.push({ key: "reading", value: String(k.readersWeek), words: "reading this week", title: readingTitle });
  else if (k.readersAll > 0) {
    out.push({
      key: "reading",
      value: String(k.readersAll),
      words: `${k.readersAll === 1 ? "has" : "have"} read it${k.lastReadAt ? `, last on ${dayMonth(k.lastReadAt)}` : ""}`,
      title: readingTitle,
    });
  } else out.push({ key: "reading", value: "", words: "no one has read it yet", title: readingTitle });
  if (interested) out.push({ key: "interested", value: String(interested.value), words: "interested", title: interested.explain });
  if (waiting && waiting.value > 0) out.push({ key: "waiting", value: String(waiting.value), words: "waiting on you", title: waiting.explain });
  return out;
}

export function BuyerPulseCard({ dealId, placement = "bottom" }: { dealId: string; placement?: "top" | "bottom" }) {
  const { data, isLoading, isError } = useDealKpis(dealId, DEFAULT_ENGAGEMENT_FILTERS);
  const reading = useDealReadingNow(dealId, data?.readingNow);
  const showTop = !!data && data.published && data.grantedCim > 0;

  if (placement === "top") {
    if (!showTop || !data) return null;
    const rows = (reading.data?.rows ?? []).map((r) => ({ ...r, page: data.readingNow.find((x) => x.accessId === r.accessId)?.page ?? null }));
    return <PulseTop dealId={dealId} data={data} readingNow={rows} />;
  }
  // Bottom: only when the top one doesn't show.
  if (showTop) return null;
  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (isError || !data) return null;
  return (
    <div data-testid="buyer-pulse">
      <p className="mb-2 font-mono text-2xs uppercase tracking-[0.16em] text-muted-foreground">Buyer pulse</p>
      <p className="text-sm text-muted-foreground">
        {data.published
          ? "No buyers have the CIM yet. Once they open it, you'll see who is reading, what they study and who to call first."
          : "Once the CIM is live and buyers open it, you'll see who is reading, what they study and who to call first."}
      </p>
    </div>
  );
}

export function PulseTop({ dealId, data, readingNow }: { dealId: string; data: DealKpisResponse; readingNow: ReadingNowRow[] }) {
  const [, setLocation] = useLocation();
  const open = (qs = "") => setLocation(`/deal/${dealId}/engagement${qs}`);
  const stats = pulseStats(data);
  const olderVisits = data.legacyOnly && !data.sampleReading;
  return (
    <section className="rounded-xl border border-border bg-card px-4 py-3.5" data-testid="buyer-pulse">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="font-mono text-2xs uppercase tracking-[0.16em] text-muted-foreground">Buyer pulse</p>
        {data.sampleReading && (
          <Tooltip>
            <TooltipTrigger asChild><span><Chip tone="example" testId="pulse-sample">Sample reading</Chip></span></TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">{SAMPLE_TIP}</TooltipContent>
          </Tooltip>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs">
          <button type="button" onClick={() => open("?view=document")} className="inline-flex items-center gap-1 text-teal hover:underline" data-testid="pulse-where">
            Where they read <ArrowRight className="h-3 w-3" />
          </button>
          <button type="button" onClick={() => open()} className="hidden items-center gap-1 text-teal hover:underline sm:inline-flex" data-testid="link-engagement">
            Open Engagement <ArrowRight className="h-3 w-3" />
          </button>
        </div>
      </div>

      {/* The numbers: one line at md+, a 2×2 grid on a phone */}
      <div className="mt-2 grid grid-cols-2 gap-px overflow-hidden rounded-lg border border-border/70 bg-border/70 md:flex md:flex-wrap md:gap-x-2 md:gap-y-1 md:overflow-visible md:rounded-none md:border-0 md:bg-transparent" data-testid="pulse-stats">
        {stats.map((s, i) => (
          <button
            key={s.key}
            type="button"
            title={s.title}
            onClick={() => open()}
            className={cn(
              "bg-card px-3 py-2 text-left text-xs text-muted-foreground hover:text-foreground md:bg-transparent md:p-0 md:text-sm",
              stats.length % 2 === 1 && i === stats.length - 1 && "col-span-2 md:col-span-1",
            )}
            data-testid={`pulse-${s.key}`}
          >
            {s.value && <span className={cn("mr-1 font-mono tabular-nums text-foreground", s.key === "waiting" && "text-teal")}><KpiDisplay text={s.value} /></span>}
            <span>{s.words}</span>
            {i < stats.length - 1 && <span className="ml-2 hidden text-muted-foreground/60 md:inline">·</span>}
          </button>
        ))}
      </div>

      {readingNow.length > 0 && (
        <div className="mt-2 space-y-1">
          {readingNow.slice(0, 3).map((r) => (
            <p key={r.accessId} className="flex items-start gap-2 text-xs text-success-muted-foreground">
              <Radio className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">
                <span className="font-medium">{r.name}</span>
                {r.document === "teaser" ? " is reading the teaser now" : ` is reading now${r.page ? ` — page ${r.page.label}, ${r.page.title}` : ""}`}
              </span>
            </p>
          ))}
        </div>
      )}

      {data.callTop.length > 0 && (
        <div className="mt-3">
          <p className="mb-1 font-mono text-2xs uppercase tracking-[0.14em] text-muted-foreground">Call first</p>
          <ol className="divide-y divide-border/60">
            {data.callTop.map((e, i) => (
              <li key={e.accessId}>
                <button
                  type="button"
                  onClick={() => open(`?buyer=${encodeURIComponent(e.accessId)}`)}
                  className="group flex w-full items-start gap-3 py-2 text-left"
                  data-testid={`pulse-top-${i}`}
                >
                  <span className="mt-0.5 w-3 shrink-0 font-mono text-xs tabular-nums text-teal">{i + 1}</span>
                  <span className="min-w-0 flex-1 md:flex md:items-center md:gap-2">
                    <span className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-medium text-foreground">{e.name}</span>
                      {e.company && <span className="text-xs text-muted-foreground">{e.company}</span>}
                      <StatusChip status={e.status} label={e.statusLabel} />
                    </span>
                    <span className="mt-0.5 min-w-0 text-xs leading-relaxed text-muted-foreground line-clamp-2 md:mt-0 md:line-clamp-1">{e.why}</span>
                  </span>
                  <ChevronRight className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/60 group-hover:text-teal" />
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {data.mostStudiedPage && (
        <div className="mt-2 flex items-center gap-1.5 border-t border-border/60 pt-2.5">
          <button
            type="button"
            onClick={() => open(`?view=document&page=${encodeURIComponent(`${data.mostStudiedPage!.pageId}#${data.mostStudiedPage!.part}`)}`)}
            className="flex min-w-0 items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
            data-testid="pulse-most-studied"
          >
            <BookOpenText className="h-3.5 w-3.5 shrink-0 text-teal" />
            <span className="truncate">
              Most studied page: <span className="text-foreground">{data.mostStudiedPage.title}</span> · {formatReadingTime(data.mostStudiedPage.attentionMs)}
            </span>
          </button>
          {olderVisits && <InfoDot text="Older visits: time per page only." />}
        </div>
      )}
    </section>
  );
}
