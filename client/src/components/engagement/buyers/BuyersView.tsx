/**
 * Buyers view — master–detail instead of a stack of tall cards:
 *   left    a short ranked list in groups (BuyerList; from the KPI response,
 *           on the same reading as the cards): worth a call first
 *   right   the selected buyer's full card (why, where they read, what to say;
 *           See where they read · Their visits · Email · Mark contacted ·
 *           Summarise), sticky; below lg the card opens in a bottom sheet
 * The order is the call priority (how closely they read × fit × recency ×
 * whether you've called); the number itself is never shown. Email opens the
 * broker's own email dialog; nothing is sent automatically.
 */
import { useMemo } from "react";
import { formatReadingTime, type BuyerEngagementCard } from "@shared/analytics-v2";
import { dayMonth, extendLinkHref, linkRanOutWords, type BuyerGroups, type LinkRanOut } from "@shared/analytics-dashboard";
import { Link } from "wouter";
import { useEngagementBuyers } from "@/hooks/useEngagement";
import { titleMaps, useEngagementPageTitles } from "@/hooks/useAnalyticsDashboard";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Copy, Link2, Mail } from "lucide-react";
import { InfoDot } from "@/components/analytics/Explain";
import { useMinWidth } from "@/components/analytics/media";
import { BuyerCard } from "./BuyerCard";
import { BuyerList, defaultSelection, listOrder } from "./BuyerList";
import { stripScale } from "./parts";
import { whenText } from "@/components/analytics/parts";
import { useBuyerCardActions, type BuyerCardActions } from "./useBuyerCardActions";
import type { EngagementViewProps } from "../types";

export const READING_TIME_INFO = "Reading time is time with the CIM on screen while the buyer is active. Idle time, hidden tabs and your own previews don't count.";
export const OLDER_VISITS_CHIP = "Older visits: time per page only";
export const OLDER_VISITS_INFO = "Recorded before Cimple tracked each part of a page. We know how long these buyers spent on each page, not which parts.";

export function EmptyReading({ published = true }: { published?: boolean }) {
  return (
    <div className="flex flex-col items-center rounded-xl border border-dashed border-border px-6 py-10 text-center" data-testid="engagement-empty">
      <svg width="88" height="72" viewBox="0 0 88 72" aria-hidden="true" className="mb-4">
        <rect x="18" y="4" width="52" height="64" rx="4" fill="hsl(var(--card))" stroke="hsl(var(--border))" />
        <rect x="26" y="14" width="30" height="4" rx="2" fill="hsl(var(--muted-foreground) / 0.35)" />
        <rect x="26" y="24" width="36" height="10" rx="2" fill="hsl(var(--teal) / 0.55)" />
        <rect x="26" y="38" width="36" height="3" rx="1.5" fill="hsl(var(--muted-foreground) / 0.25)" />
        <rect x="26" y="45" width="28" height="3" rx="1.5" fill="hsl(var(--muted-foreground) / 0.25)" />
        <rect x="26" y="52" width="36" height="8" rx="2" fill="hsl(var(--teal) / 0.25)" />
      </svg>
      <p className="text-sm font-medium text-foreground">{published ? "No buyer has opened the CIM yet" : "The CIM isn't live yet"}</p>
      <p className="mt-1 max-w-sm text-xs text-muted-foreground">
        When buyers open the CIM, you'll see who to call first, which pages and numbers they study, and what to say.
      </p>
    </div>
  );
}

/** The list head: "13 buyers read the CIM · 8 h 38 min in all" (i), and the older-visits chip. */
export function BuyerListHead({ readers, totalMs, olderVisits }: { readers: number; totalMs: number; olderVisits: boolean }) {
  return (
    <div className="space-y-1.5" data-testid="buyer-list-head">
      <p className="flex items-center gap-1.5 text-sm text-foreground/90">
        <span>
          {readers} buyer{readers === 1 ? "" : "s"} read the CIM{totalMs > 0 ? ` · ${formatReadingTime(totalMs)} in all` : ""}
        </span>
        <InfoDot text={READING_TIME_INFO} />
      </p>
      {olderVisits && (
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[11px] text-muted-foreground" data-testid="older-visits-chip">
          {OLDER_VISITS_CHIP}
          <InfoDot text={OLDER_VISITS_INFO} className="h-3.5 w-3.5" />
        </span>
      )}
    </div>
  );
}

export interface BuyersViewProps extends EngagementViewProps {
  /** From the KPI response (null while it loads). */
  groups: BuyerGroups | null;
  /** "Buyers who read" under the current filters (the one reader rule). */
  readers: number;
  /** legacyOnly && !sampleReading. */
  olderVisits: boolean;
  published: boolean;
  /** The selected buyer (?buyer=); null = the first row (wide screens only). */
  selected: string | null;
  onSelect(accessId: string | null): void;
  /** From the KPI response: links that have run out (accessId → when). */
  linkRanOut?: LinkRanOut;
}

export function BuyersView(props: BuyersViewProps) {
  const { dealId, filters, nav, groups } = props;
  const wide = useMinWidth(1024);
  const { data, isLoading, error, refetch } = useEngagementBuyers(dealId, filters);
  const { data: titleData } = useEngagementPageTitles(dealId, filters.rendition);
  const { titles, blindTitles } = useMemo(() => titleMaps(titleData), [titleData]);
  const actions = useBuyerCardActions(dealId);
  const cards = useMemo(() => new Map((data?.buyers ?? []).map((c) => [c.accessId, c])), [data]);
  const maxMs = useMemo(() => stripScale((data?.buyers ?? []).map((b) => b.pageStrip)), [data]);

  if (!groups || (isLoading && !data)) {
    return (
      <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]" data-testid="engagement-buyers-loading">
        <div className="space-y-2">
          <Skeleton className="h-5 w-56" />
          {Array.from({ length: 6 }, (_, i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}
        </div>
        <Skeleton className="hidden h-[28rem] w-full rounded-xl lg:block" />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="rounded-xl border border-border p-6 text-center">
        <p className="text-sm text-muted-foreground">Couldn't load the buyers.</p>
        <Button size="sm" variant="outline" className="mt-3" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  const order = listOrder(groups, filters.range);
  const selectedId = props.selected ?? (wide ? defaultSelection(groups)?.accessId ?? null : null);
  const row = order.find((r) => r.accessId === selectedId) ?? null;
  const totalMs = data.buyers.reduce((s, b) => s + b.activeMs, 0);
  const anyOpened = order.some((r) => !groups.notOpened.includes(r));
  const lastQuiet = groups.quietInRange.reduce<string | null>((m, r) => (r.lastSeenAt && (!m || r.lastSeenAt > m) ? r.lastSeenAt : m), null);

  const detail = row ? (
    <BuyerDetail
      card={cards.get(row.accessId) ?? null}
      row={row}
      notOpened={groups.notOpened.includes(row)}
      quiet={groups.quietInRange.includes(row)}
      published={props.published}
      titles={titles}
      blindTitles={blindTitles}
      maxMs={maxMs}
      nav={nav}
      actions={actions}
      onAllTime={() => props.onFiltersChange({ ...filters, range: "all" })}
      ranOutAt={props.linkRanOut?.[row.accessId] ?? null}
      extendHref={extendLinkHref(dealId)}
    />
  ) : !anyOpened ? (
    <EmptyReading published={props.published} />
  ) : filters.range !== "all" && groups.worthACall.length + groups.reading.length === 0 ? (
    <div className="rounded-xl border border-dashed border-border bg-card px-5 py-8 text-center" data-testid="detail-quiet-period">
      <p className="text-sm font-medium text-foreground">Nobody read the CIM in the {filters.range === "7d" ? "last 7 days" : "last 30 days"}.</p>
      {lastQuiet && <p className="mt-1 text-xs text-muted-foreground">The last reading was on {dayMonth(lastQuiet)}.</p>}
      <Button size="sm" variant="outline" className="mt-4 h-8 text-xs" onClick={() => props.onFiltersChange({ ...filters, range: "all" })}>Show all time</Button>
    </div>
  ) : (
    <p className="rounded-xl border border-dashed border-border px-5 py-8 text-center text-sm text-muted-foreground">Pick a buyer on the left to see their reading.</p>
  );

  return (
    <div className="grid gap-5 lg:grid-cols-[380px_minmax(0,1fr)]" data-testid="engagement-buyers">
      <BuyerList
        groups={groups}
        cards={cards}
        range={filters.range}
        selected={selectedId}
        onSelect={(id) => props.onSelect(id)}
        maxMs={maxMs}
        titles={titles}
        blindTitles={blindTitles}
        live={props.published}
        nudgeMode={actions.nudgeMode}
        onNudge={actions.nudge}
        linkRanOut={props.linkRanOut}
        head={<BuyerListHead readers={props.readers} totalMs={totalMs} olderVisits={props.olderVisits} />}
      />
      {wide ? (
        <div className="min-w-0 lg:sticky lg:top-4 lg:self-start" data-testid="buyer-detail">{detail}</div>
      ) : (
        <Sheet open={!!row} onOpenChange={(o) => { if (!o) props.onSelect(null); }}>
          <SheetContent side="bottom" className="h-[92vh] overflow-y-auto rounded-t-xl px-4 pb-8 pt-12" data-testid="buyer-sheet">
            <SheetHeader className="sr-only"><SheetTitle>{row?.name}</SheetTitle></SheetHeader>
            {detail}
          </SheetContent>
        </Sheet>
      )}
      {actions.dialogs}
    </div>
  );
}

function BuyerDetail({ card, row, notOpened, quiet, published, titles, blindTitles, maxMs, nav, actions, onAllTime, ranOutAt, extendHref }: {
  card: BuyerEngagementCard | null;
  row: { accessId: string; name: string; grantedAt: string; lastSeenAt: string | null };
  notOpened: boolean;
  quiet: boolean;
  published: boolean;
  titles: Map<string, string>;
  blindTitles: Map<string, string>;
  maxMs: number;
  nav: EngagementViewProps["nav"];
  actions: BuyerCardActions;
  onAllTime(): void;
  ranOutAt: string | null;
  extendHref: string;
}) {
  const ranOut = ranOutAt ? (
    <p className="mt-3 text-xs text-muted-foreground" data-testid="detail-link-ran-out">
      {linkRanOutWords(ranOutAt)} <Link href={extendHref} className="font-medium text-teal hover:underline">Extend</Link>
    </p>
  ) : null;
  if (notOpened) {
    const mode = actions.nudgeMode(row.accessId);
    return (
      <div className="rounded-xl border border-dashed border-border bg-card px-5 py-8 text-center" data-testid="detail-not-opened">
        <p className="text-sm font-medium text-foreground">{row.name} hasn't opened the CIM yet.</p>
        <p className="mt-1 text-xs text-muted-foreground">Access given {whenText(row.grantedAt)}.{published ? "" : " The CIM isn't live, so they can't open it yet."}</p>
        {ranOut}
        {published && (
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            {mode && (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => actions.nudge(row.accessId)}>
                {mode === "email" ? <Mail className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}Nudge
              </Button>
            )}
            {actions.hasLink(row.accessId) && (
              <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => actions.copyLink(row.accessId)}>
                <Link2 className="mr-1.5 h-3.5 w-3.5" />Copy their link
              </Button>
            )}
          </div>
        )}
      </div>
    );
  }
  if (quiet || !card) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-card px-5 py-8 text-center" data-testid="detail-quiet">
        <p className="text-sm font-medium text-foreground">
          {quiet ? `${row.name} didn't read in this period.` : `No reading from ${row.name} with these filters.`}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {row.lastSeenAt ? `Last read ${whenText(row.lastSeenAt)}.` : "Change the filters to see their reading."}
        </p>
        {ranOut}
        {quiet && <Button size="sm" variant="outline" className="mt-4 h-8 text-xs" onClick={onAllTime}>Show all time</Button>}
      </div>
    );
  }
  return (
    <BuyerCard
      card={card}
      titles={titles}
      blindTitles={blindTitles}
      maxMs={maxMs}
      nav={nav}
      legend
      linkRanOutAt={ranOutAt}
      extendHref={extendHref}
      {...actions.propsFor(card)}
    />
  );
}
