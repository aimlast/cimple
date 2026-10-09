/**
 * What buyers did, newest first, grouped by day: every visit (opened / came
 * back), teaser reads, NDAs, decisions and requests, questions, and your own
 * actions. One component for the Analytics page (scope "broker", with the
 * deal chip and a Deal filter), the deal's Engagement tab (scope "deal") and
 * the Team tab (compact, last 10). "Reading now" is a pinned live line above
 * the list, never an item, so paging never shifts.
 */
import { useMemo, useState } from "react";
import { Link } from "wouter";
import {
  BookOpen, FileSignature, Flag, FolderOpen, MessageSquare, SlidersHorizontal, UserCog,
} from "lucide-react";
import {
  ACTIVITY_KIND_FILTERS,
  brokerDayKey,
  brokerZoneLabel,
  dayHeading,
  dayMonth,
  rangeLabel,
  timeOfDay,
  viewerTimeOfDay,
  type ActivityGroup,
  type ActivityItem,
  type ActivityKindFilter,
  type DashboardRange,
  type ExamplesMode,
  type RangeRequest,
  type ReadingNowRow,
} from "@shared/analytics-dashboard";
import type { EngagementFilters } from "@shared/analytics-v2";
import {
  useAnalyticsActivity,
  useAnalyticsDeals,
  useAnalyticsReadingNow,
  useDealReadingNow,
} from "@/hooks/useAnalyticsDashboard";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PanelError } from "@/components/deal/PanelError";
import { cn } from "@/lib/utils";
import { SampleTag } from "./KpiStrip";
import { OptionGroup } from "./parts";
import { TabEmpty } from "./EmptyStates";

const GROUP_ICON: Record<ActivityGroup, typeof BookOpen> = {
  reading: BookOpen, nda: FileSignature, decision: Flag, question: MessageSquare, broker: UserCog, data_room: FolderOpen,
};
const TONE: Record<ActivityItem["tone"], string> = {
  positive: "text-success",
  negative: "text-muted-foreground",
  neutral: "text-foreground/80",
};

// Dates and times: the broker's calendar (Toronto), one rule with every
// other engagement and analytics screen (shared/analytics-dashboard.ts).
export { dayHeading, timeOfDay };

/** Items grouped by day, newest first (exported for tests). */
export function groupByDay(items: ActivityItem[], now: number = Date.now()): Array<{ key: string; heading: string; items: ActivityItem[] }> {
  const out: Array<{ key: string; heading: string; items: ActivityItem[] }> = [];
  for (const it of items) {
    const key = brokerDayKey(it.at);
    const last = out[out.length - 1];
    if (last && last.key === key) last.items.push(it);
    else out.push({ key, heading: dayHeading(it.at, now), items: [it] });
  }
  return out;
}

/** "{Name} opened the CIM" → the name in bold (the first occurrence). */
function TitleWithName({ title, name }: { title: string; name: string | null }) {
  if (!name) return <>{title}</>;
  const i = title.indexOf(name);
  if (i < 0) return <>{title}</>;
  return (
    <>
      {title.slice(0, i)}
      <strong className="font-semibold text-foreground">{name}</strong>
      {title.slice(i + name.length)}
    </>
  );
}

/** The zone label's tooltip (it speaks to the broker, who is the one reading it). */
export const ZONE_TIP = "Times are Toronto time. Hover a time to see it on your own clock.";

/**
 * The list itself (presentational; exported for tests). Times are Toronto's;
 * when the viewer's own clock differs, the FIRST day header says "Toronto
 * time" once (not every day: it would repeat down the screen) and each
 * time's tooltip gives the viewer's own clock. `zoneLabel` is for tests
 * (default: worked out from this browser).
 */
export function ActivityList({ items, showDeal, compact, now, zoneLabel }: {
  items: ActivityItem[];
  showDeal: boolean;
  compact?: boolean;
  now?: number;
  zoneLabel?: string | null;
}) {
  const days = groupByDay(items, now);
  const zone = zoneLabel !== undefined ? zoneLabel : brokerZoneLabel(now);
  return (
    <div className="space-y-4" data-testid="activity-list">
      {days.map((d, di) => (
        <section key={d.key}>
          <h3 className={cn("z-10 flex items-baseline gap-2 bg-background/95 py-1 font-mono text-2xs uppercase tracking-[0.14em] text-muted-foreground backdrop-blur", !compact && "sticky top-0")} data-testid="activity-day">
            <span>{d.heading}</span>
            {zone && di === 0 && (
              <span className="ml-auto font-sans text-[11px] normal-case tracking-normal text-muted-foreground/80" title={ZONE_TIP} data-testid="activity-zone">
                {zone}
              </span>
            )}
          </h3>
          <ol className="mt-1 divide-y divide-border/60 rounded-xl border border-border bg-card">
            {d.items.map((it) => {
              const Icon = GROUP_ICON[it.group];
              return (
                <li key={it.id} className="flex gap-3 px-3.5 py-2.5 sm:px-4" data-testid="activity-item">
                  <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", TONE[it.tone])} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm leading-snug text-foreground/90">
                      <span
                        className="mr-2 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
                        title={zone ? `${viewerTimeOfDay(it.at)} your time` : undefined}
                        data-testid="activity-time"
                      >
                        {timeOfDay(it.at)}
                      </span>
                      <TitleWithName title={it.title} name={it.name} />
                      {it.sample && <SampleTag className="ml-1.5 align-middle" />}
                    </p>
                    {(it.detail || showDeal) && (
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        {showDeal && <span className="max-w-[16rem] truncate rounded bg-muted/50 px-1.5 py-px text-[11px] text-foreground/80">{it.dealName}</span>}
                        {it.detail && <span className="min-w-0">{it.detail}</span>}
                      </p>
                    )}
                  </div>
                  {it.link && (
                    <Link href={it.link.href} className="shrink-0 self-center whitespace-nowrap text-xs font-medium text-teal hover:underline">
                      {it.link.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
        </section>
      ))}
    </div>
  );
}

/** The pinned "is reading now" line(s) above the feed. */
export function ReadingNowLine({ rows, showDeal }: { rows: ReadingNowRow[]; showDeal: boolean }) {
  if (rows.length === 0) return null;
  return (
    <div className="space-y-1" data-testid="activity-reading-now">
      {rows.slice(0, 3).map((r) => (
        <p key={r.accessId} className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/5 px-3 py-2 text-sm">
          <LiveDot />
          <span className="min-w-0 flex-1 truncate">
            <strong className="font-semibold">{r.name}</strong>{" "}
            {r.document === "teaser"
              ? showDeal ? `is reading the teaser of ${r.dealName} now.` : "is reading the teaser now."
              : showDeal ? `is reading ${r.dealName} now.` : `is reading the CIM now${r.page ? `, page ${r.page.label}` : ""}.`}
          </span>
          <Link
            href={r.document === "teaser" ? `/deal/${r.dealId}/engagement?view=teaser` : `/deal/${r.dealId}/engagement?buyer=${encodeURIComponent(r.accessId)}`}
            className="shrink-0 text-xs font-medium text-teal hover:underline"
          >
            Open buyer
          </Link>
        </p>
      ))}
    </div>
  );
}

export function LiveDot() {
  return (
    <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
      <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
    </span>
  );
}

export interface ActivityFeedProps {
  scope: "broker" | "deal";
  dealId?: string;
  /** Broker scope: the page's period. */
  range?: RangeRequest;
  /** Broker scope: the resolved period (for the empty-state words). */
  resolvedRange?: DashboardRange;
  examples?: ExamplesMode | null;
  /** Broker scope: the Deal filter (URL state). */
  deal?: string | null;
  onDealChange?(deal: string | null): void;
  /** The kind chips (URL state on Analytics; local on a deal). */
  kind?: ActivityKindFilter;
  onKindChange?(kind: ActivityKindFilter): void;
  /** Deal scope: the Engagement tab's filters (When and Buyers apply). */
  filters?: EngagementFilters;
  /** "Show all time" in the empty state. */
  onShowAllTime?(): void;
  limit?: number;
  /** The Team tab: the last few items, no filters, a link to the full feed. */
  compact?: boolean;
}

export function ActivityFeed(props: ActivityFeedProps) {
  const { scope, dealId, compact } = props;
  const [localKind, setLocalKind] = useState<ActivityKindFilter>("all");
  const kind = props.kind ?? localKind;
  const setKind = props.onKindChange ?? setLocalKind;
  const [sheet, setSheet] = useState(false);
  const limit = props.limit ?? 50;
  const q = useAnalyticsActivity({
    scope, dealId, range: props.range, deal: props.deal ?? null, kind, examples: props.examples ?? null, filters: props.filters, limit,
  });
  const brokerNow = useAnalyticsReadingNow(props.examples ?? null, scope === "broker" && !compact);
  const dealNow = useDealReadingNow(scope === "deal" && !compact ? dealId : undefined);
  const nowRows = (scope === "broker" ? brokerNow.data?.rows : dealNow.data?.rows) ?? [];
  const dealsQ = useAnalyticsDeals(props.range ?? "auto", props.examples ?? null, scope === "broker" && !compact);
  const dealOptions = scope === "broker" && !compact ? (dealsQ.data?.rows ?? []).map((r) => ({ id: r.dealId, name: r.dealName })) : [];

  const pages = q.data?.pages ?? [];
  const items = useMemo(() => pages.flatMap((p) => p.items), [pages]);
  const first = pages[0];
  const dataRoom = pages.some((p) => p.dataRoom);
  const kinds = ACTIVITY_KIND_FILTERS.filter((k) => k.key !== "data_room" || dataRoom || kind === "data_room");
  const range: DashboardRange = scope === "deal" ? props.filters?.range ?? "all" : props.resolvedRange ?? "all";

  const filterRow = !compact && (
    <>
      <div className="hidden flex-wrap items-center gap-2 md:flex" data-testid="activity-filters">
        {scope === "broker" && (
          <Select value={props.deal ?? "all"} onValueChange={(v) => props.onDealChange?.(v === "all" ? null : v)}>
            <SelectTrigger className="h-8 w-52 text-xs" data-testid="activity-deal"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All deals</SelectItem>
              {dealOptions.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
        )}
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Kind">
          {kinds.map((k) => (
            <button
              key={k.key}
              type="button"
              role="radio"
              aria-checked={kind === k.key}
              onClick={() => setKind(k.key)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition-colors",
                kind === k.key ? "border-teal/40 bg-teal/10 text-teal" : "border-border text-muted-foreground hover:text-foreground",
              )}
              data-testid={`activity-kind-${k.key}`}
            >
              {k.label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex items-center gap-2 md:hidden">
        <Button size="sm" variant="outline" className={cn("h-8 gap-1.5 text-xs", (kind !== "all" || props.deal) && "border-teal/40 text-teal")} onClick={() => setSheet(true)} data-testid="activity-filters-open">
          {/* On a deal the shell already has a "Filters" button (Buyers, When): this one is only the kind. */}
          <SlidersHorizontal className="h-3.5 w-3.5" /> {scope === "deal" ? "What happened" : "Filters"}{(kind !== "all" ? 1 : 0) + (props.deal ? 1 : 0) ? ` · ${(kind !== "all" ? 1 : 0) + (props.deal ? 1 : 0)}` : ""}
        </Button>
        <span className="truncate text-xs text-muted-foreground">
          {[props.deal ? dealOptions.find((d) => d.id === props.deal)?.name : null, kind !== "all" ? kinds.find((k) => k.key === kind)?.label : null].filter(Boolean).join(" · ")}
        </span>
      </div>
      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto rounded-t-xl px-4 pb-6 pt-5">
          <SheetHeader className="mb-3 text-left"><SheetTitle className="text-base">Filters</SheetTitle></SheetHeader>
          <div className="space-y-4">
            {scope === "broker" && (
              <OptionGroup title="Deal" value={props.deal ?? "all"} onChange={(v) => props.onDealChange?.(v === "all" ? null : v)}
                options={[{ value: "all", label: "All deals" }, ...dealOptions.map((d) => ({ value: d.id, label: d.name }))]} />
            )}
            <OptionGroup<ActivityKindFilter> title="What happened" value={kind} onChange={setKind} options={kinds.map((k) => ({ value: k.key, label: k.label }))} />
          </div>
          <div className="sticky -bottom-6 -mx-4 mt-5 border-t border-border bg-background px-4 pb-6 pt-3">
            <Button className="w-full" onClick={() => setSheet(false)}>Show activity</Button>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );

  let body: React.ReactNode;
  if (q.isLoading) {
    body = <div className="space-y-2">{Array.from({ length: compact ? 3 : 6 }, (_, i) => <Skeleton key={i} className="h-12 w-full rounded-lg" />)}</div>;
  } else if (q.isError || !first) {
    body = <PanelError what="the activity" onRetry={() => q.refetch()} />;
  } else if (items.length === 0) {
    const last = first.lastActivity;
    const inPeriod = range !== "all";
    body = (
      <TabEmpty
        testId="activity-empty"
        title={inPeriod ? `Nothing happened in the ${rangeLabel(range).replace(/^Last/, "last")}.` : kind !== "all" ? "Nothing of this kind yet." : "No activity yet."}
        body={inPeriod && last ? `The last activity was on ${dayMonth(last.at)}: ${last.text}.` : !inPeriod && kind === "all" ? "When buyers open your CIM, sign the NDA, ask a question or decide, it shows here." : undefined}
        action={inPeriod && props.onShowAllTime ? <Button size="sm" variant="outline" onClick={props.onShowAllTime}>Show all time</Button> : undefined}
      />
    );
  } else {
    const shown = compact ? items.slice(0, limit) : items;
    body = (
      <>
        <ActivityList items={shown} showDeal={scope === "broker"} compact={compact} />
        {!compact && (
          <div className="flex flex-col items-center gap-2 pt-1">
            {q.hasNextPage && (
              <Button size="sm" variant="outline" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage} data-testid="activity-older">
                {q.isFetchingNextPage ? "Loading…" : "Show older"}
              </Button>
            )}
            <p className="text-xs text-muted-foreground" data-testid="activity-count">{items.length} of {first.total}</p>
          </div>
        )}
      </>
    );
  }

  return (
    <div className="space-y-3" data-testid={`activity-feed-${scope}`}>
      {!compact && <ReadingNowLine rows={nowRows} showDeal={scope === "broker"} />}
      {filterRow}
      {body}
      {compact && dealId && (
        <Link href={`/deal/${dealId}/engagement?view=activity`} className="inline-flex text-xs font-medium text-teal hover:underline" data-testid="activity-see-all">
          See all activity on the Engagement tab →
        </Link>
      )}
    </div>
  );
}
