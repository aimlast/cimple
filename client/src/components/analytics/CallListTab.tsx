/**
 * Analytics → Who to call: the best leads across every deal (the same items
 * as "Worth a call", top 15), master–detail.
 *   ≥ lg: the ranked list on the left, the selected buyer's full card on the
 *         right (why, where they read, what to say, Email · Mark contacted ·
 *         Summarise, and "See where they read" straight to the heat map);
 *   < lg: the list only; tapping a row opens the card in a bottom sheet.
 * The selection is `?buyer=<accessId>` (the first row when absent).
 */
import { useMemo, useRef, type KeyboardEvent } from "react";
import { Link, useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { MessageSquare } from "lucide-react";
import type { CallListEntry, EngagementBuyersResponse } from "@shared/analytics-v2";
import { engagementKeys, useEngagementBuyers } from "@/hooks/useEngagement";
import { getAnalyticsJson, titleMaps, useAnalyticsCallList, useEngagementPageTitles } from "@/hooks/useAnalyticsDashboard";
import type { ExamplesMode } from "@shared/analytics-dashboard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PanelError } from "@/components/deal/PanelError";
import { BuyerCard } from "@/components/engagement/buyers/BuyerCard";
import { StatusChip, stripScale } from "@/components/engagement/buyers/parts";
import { useBuyerCardActions } from "@/components/engagement/buyers/useBuyerCardActions";
import type { EngagementNav } from "@/components/engagement/types";
import { cn } from "@/lib/utils";
import { analyticsSearch } from "./url";
import { DealChips, whenText } from "./parts";
import { TabEmpty } from "./EmptyStates";
import { useMinWidth } from "./media";

const CALL_LIST_SIZE = 15;

export const CALL_TAB_COPY = {
  description: "Best lead first, with what to talk about. Not affected by the date range.",
  info: "The order weighs how closely they read, how well they fit, how recently they were active, and whether you've called them in the last 2 days. Buyers who said no, didn't respond in time, or whose link you removed are left out.",
  emptyTitle: "No one to call right now.",
  emptyBody: "When a buyer reads one of your CIMs closely, asks a question or says they're interested, they show up here with what to talk about.",
};

type DealFlags = Map<string, { live: boolean; demo: boolean }>;

export function CallListTab({
  examples, selected, onSelect, callCount, notOpened,
}: {
  examples: ExamplesMode | null;
  selected: string | null;
  onSelect(accessId: string | null): void;
  /** "Worth a call" (uncapped), for the "everyone else" line. */
  callCount: number;
  /** CIM links never opened, for the empty state. */
  notOpened: number;
}) {
  const { data, isLoading, error, refetch } = useAnalyticsCallList(examples);
  const wide = useMinWidth(1024);
  const qc = useQueryClient();
  const listRef = useRef<HTMLOListElement>(null);
  const entries = data?.entries ?? [];
  const flags: DealFlags = useMemo(() => new Map((data?.deals ?? []).map((d) => [d.dealId, { live: d.live, demo: d.demo }])), [data]);
  const current = entries.find((e) => e.accessId === selected) ?? (wide ? entries[0] : undefined) ?? null;

  if (isLoading) {
    return (
      <div className="grid gap-5 lg:grid-cols-[400px_minmax(0,1fr)]">
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 w-full rounded-lg" />)}</div>
        <Skeleton className="hidden h-96 w-full rounded-xl lg:block" />
      </div>
    );
  }
  if (error || !data) return <PanelError what="who to call" onRetry={() => refetch()} />;
  if (entries.length === 0) {
    return (
      <TabEmpty
        testId="call-empty"
        title={CALL_TAB_COPY.emptyTitle}
        body={
          <>
            <p>{CALL_TAB_COPY.emptyBody}</p>
            {notOpened > 0 && <p className="mt-2">{notOpened} buyer{notOpened === 1 ? " hasn't" : "s haven't"} opened their link yet.</p>}
          </>
        }
        action={notOpened > 0 ? (
          <Button asChild size="sm" variant="outline"><Link href={`/broker/analytics${analyticsSearch({ tab: "buyers", status: "not_opened" })}`}>See who</Link></Button>
        ) : undefined}
      />
    );
  }

  const prefetch = (dealId: string) => {
    void qc.prefetchQuery({
      queryKey: engagementKeys.buyers(dealId, ""),
      queryFn: () => getAnalyticsJson<EngagementBuyersResponse>(`/api/deals/${dealId}/engagement/buyers`),
      staleTime: 30_000,
    });
  };
  const onKey = (e: KeyboardEvent<HTMLOListElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const i = Math.max(0, entries.findIndex((x) => x.accessId === current?.accessId));
    const next = entries[Math.min(entries.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      onSelect(next.accessId);
      listRef.current?.querySelector<HTMLElement>(`[data-access="${next.accessId}"]`)?.focus();
    }
  };

  return (
    <div className="grid gap-5 lg:grid-cols-[400px_minmax(0,1fr)]" data-testid="call-tab">
      <div className="min-w-0">
        <ol ref={listRef} className="space-y-2" onKeyDown={onKey} aria-label="Who to call" data-testid="call-list">
          {entries.map((e, i) => (
            <li key={`${e.dealId}:${e.accessId}`}>
              <CallRow
                entry={e}
                rank={i + 1}
                flags={flags.get(e.dealId)}
                selected={wide && current?.accessId === e.accessId}
                onClick={() => onSelect(e.accessId)}
                onHover={() => prefetch(e.dealId)}
              />
            </li>
          ))}
        </ol>
        {callCount > CALL_LIST_SIZE && (
          <p className="mt-3 text-xs text-muted-foreground">
            The {CALL_LIST_SIZE} best leads. Everyone else worth a call is in{" "}
            <Link href={`/broker/analytics${analyticsSearch({ tab: "buyers", kpi: { id: "to_call", range: "all" } })}`} className="font-medium text-teal hover:underline">Buyers</Link>.
          </p>
        )}
      </div>
      {wide ? (
        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start">
          {current && <CallDetail entry={current} flags={flags.get(current.dealId)} />}
        </div>
      ) : (
        <Sheet open={!!current} onOpenChange={(o) => { if (!o) onSelect(null); }}>
          <SheetContent side="bottom" className="h-[92vh] overflow-y-auto rounded-t-xl px-4 pb-8 pt-12" data-testid="call-sheet">
            <SheetHeader className="sr-only">
              <SheetTitle className="sr-only">{current?.name}</SheetTitle>
            </SheetHeader>
            {current && <CallDetail entry={current} flags={flags.get(current.dealId)} />}
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}

function CallRow({ entry: e, rank, flags, selected, onClick, onHover }: {
  entry: CallListEntry; rank: number; flags?: { live: boolean; demo: boolean }; selected: boolean; onClick(): void; onHover(): void;
}) {
  const tip = e.talkingPoints[0] ? `What to say: ${e.talkingPoints[0].text}` : undefined;
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={onHover}
      onFocus={onHover}
      title={tip}
      aria-current={selected || undefined}
      data-access={e.accessId}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border bg-card px-3.5 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-teal",
        selected ? "border-border border-l-2 border-l-teal bg-teal/10" : "border-border hover:border-teal/40",
      )}
      data-testid={`call-row-${e.accessId}`}
    >
      <span className="mt-0.5 w-5 shrink-0 font-mono text-xs tabular-nums text-teal">{rank}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 text-sm font-medium text-foreground">{e.name}</span>
          {e.company && <span className="min-w-0 truncate text-xs text-muted-foreground">{e.company}</span>}
          {e.lastSeenAt && <span className="ml-auto shrink-0 whitespace-nowrap text-2xs tabular-nums text-muted-foreground">{whenText(e.lastSeenAt)}</span>}
        </span>
        <span className="mt-1 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <StatusChip status={e.status} label={e.statusLabel} />
          <span className="min-w-0 truncate">{e.dealName}</span>
          {flags && <DealChips live={flags.live} demo={flags.demo} />}
        </span>
        <span className="mt-1.5 text-xs leading-relaxed text-foreground/85 line-clamp-2">{e.why}</span>
      </span>
    </button>
  );
}

/** The selected buyer's full card (the same card as the deal's Buyers view). */
function CallDetail({ entry, flags }: { entry: CallListEntry; flags?: { live: boolean; demo: boolean } }) {
  const [, setLocation] = useLocation();
  const dealId = entry.dealId;
  const { data, isLoading } = useEngagementBuyers(dealId, {});
  const { data: titleData } = useEngagementPageTitles(dealId);
  const actions = useBuyerCardActions(dealId);
  const { titles, blindTitles } = useMemo(() => titleMaps(titleData), [titleData]);
  const maxMs = useMemo(() => stripScale((data?.buyers ?? []).map((b) => b.pageStrip)), [data]);
  const card = data?.buyers.find((b) => b.accessId === entry.accessId) ?? null;
  const nav: EngagementNav = useMemo(() => ({
    openDocument: (opts) => {
      const p = new URLSearchParams({ view: "document" });
      p.set("buyers", opts?.accessId ?? entry.accessId);
      if (opts?.pageId) p.set("page", `${opts.pageId}#${opts.part ?? 0}`);
      setLocation(`/deal/${dealId}/engagement?${p.toString()}`);
    },
    openJourney: (accessId) => setLocation(`/deal/${dealId}/engagement?journey=${encodeURIComponent(accessId)}`),
  }), [dealId, entry.accessId, setLocation]);
  const dealHref = `/deal/${dealId}/engagement`;
  const chips = flags ? <DealChips live={flags.live} demo={flags.demo} /> : null;

  if (isLoading) return <Skeleton className="h-[26rem] w-full rounded-xl" data-testid="call-detail-loading" />;
  if (!card) {
    // The card isn't there (a race with a revoke, a new visit): what we know from the list.
    return (
      <div className="rounded-xl border border-border bg-card p-4 sm:p-5" data-testid="call-detail-fallback">
        <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-border/60 pb-2.5 text-xs">
          <Link href={dealHref} className="font-medium text-teal hover:underline">{entry.dealName} →</Link>
          {chips}
        </div>
        <p className="text-[15px] font-semibold text-foreground">{entry.name}</p>
        <p className="mt-2 text-sm text-foreground/90">{entry.why}</p>
        {entry.talkingPoints.length > 0 && (
          <ol className="mt-3 space-y-1.5">
            {entry.talkingPoints.map((t, i) => (
              <li key={i} className="flex gap-2 text-sm"><MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal" />{t.text}</li>
            ))}
          </ol>
        )}
      </div>
    );
  }
  return (
    <>
      <BuyerCard
        card={card}
        titles={titles}
        blindTitles={blindTitles}
        maxMs={maxMs}
        nav={nav}
        dealName={entry.dealName}
        dealHref={dealHref}
        dealExtra={chips}
        legend
        {...actions.propsFor(card)}
      />
      {actions.dialogs}
    </>
  );
}
