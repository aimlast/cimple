/**
 * Analytics (/broker/analytics): how buyers are reading the broker's CIMs,
 * across their deals, as one dashboard that needs no scrolling to find
 * anything.
 *
 *   header        title, and "Reading now: …" when a buyer is reading
 *   numbers       NEEDS YOU NOW (worth a call, waiting on you: right now)
 *                 BUYERS with the period control in its own header (buyers who
 *                 read, NDAs signed, said interested)
 *   lines         the period note (automatic → all time), a heads-up or two
 *   tabs          Who to call · Deals · Buyers · Activity · What buyers read most
 *
 * Every number explains how it was counted and opens exactly who it counts.
 * All state is in the URL (components/analytics/url.ts); a tab change pushes
 * (Back returns to the previous tab), everything else replaces.
 */
import { useCallback, useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { AlertTriangle } from "lucide-react";
import {
  rangeWindow,
  type AnalyticsTab,
  type DashboardRange,
  type Kpi,
  type KpiWho,
  type ReadingNowRow,
} from "@shared/analytics-dashboard";
import { useAnalyticsOverview, useAnalyticsReadingNow } from "@/hooks/useAnalyticsDashboard";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { KpiStrip, type KpiFooter } from "@/components/analytics/KpiStrip";
import { RangeControl } from "@/components/analytics/RangeControl";
import { RangeNote } from "@/components/analytics/RangeNote";
import { HeadsUp } from "@/components/analytics/HeadsUp";
import { DashboardTabBar, type DashboardTab } from "@/components/analytics/DashboardTabBar";
import { CallListTab, CALL_TAB_COPY } from "@/components/analytics/CallListTab";
import { DealsTab, DEALS_TAB_DESCRIPTION } from "@/components/analytics/DealsTab";
import { AllBuyersTab, BUYERS_TAB_DESCRIPTION } from "@/components/analytics/AllBuyersTab";
import { ActivityFeed, LiveDot } from "@/components/analytics/ActivityFeed";
import { AttentionTab, ATTENTION_COPY } from "@/components/analytics/AttentionTab";
import { AnalyticsEmpty, analyticsEmptyKind } from "@/components/analytics/EmptyStates";
import { InfoDot } from "@/components/analytics/Explain";
import { EXAMPLE_TIP, TabDescription } from "@/components/analytics/parts";
import { analyticsSearch, parseAnalyticsSearch, parseKpiChip, resolveAnalyticsTab, switchTab, type AnalyticsUrlState } from "@/components/analytics/url";

export const ANALYTICS_TAB_LABELS: Record<AnalyticsTab, { label: string; short: string }> = {
  call: { label: "Who to call", short: "Call" },
  deals: { label: "Deals", short: "Deals" },
  buyers: { label: "Buyers", short: "Buyers" },
  activity: { label: "Activity", short: "Activity" },
  attention: { label: "What buyers read most", short: "Most read" },
};
const TAB_ORDER: AnalyticsTab[] = ["call", "deals", "buyers", "activity", "attention"];

function activityPeriodWords(range: DashboardRange): string {
  return range === "7d" ? "the last 7 days" : range === "30d" ? "the last 30 days" : "all time";
}

export default function Analytics() {
  const search = useSearch();
  const [, setLocation] = useLocation();
  const state = useMemo(() => parseAnalyticsSearch(search), [search]);
  const rangeReq = state.range ?? "auto";
  const overview = useAnalyticsOverview(rangeReq, state.examples);
  const o = overview.data;
  const readingNow = useAnalyticsReadingNow(state.examples);
  const tab = resolveAnalyticsTab(state.tab, o ? o.counts.call : null);

  const go = useCallback((next: AnalyticsUrlState, replace: boolean) => {
    setLocation(`/broker/analytics${analyticsSearch(next)}`, { replace });
  }, [setLocation]);
  const update = useCallback((patch: Partial<AnalyticsUrlState>) => go({ ...state, ...patch }, true), [go, state]);
  const onTab = (t: string) => go(switchTab({ ...state, tab }, t as AnalyticsTab), false);

  const range: DashboardRange = o?.range ?? state.range ?? "30d";
  const empty = o ? analyticsEmptyKind(o) : null;

  const footerFor = (kpi: Kpi): KpiFooter | null => {
    const chip = parseKpiChip(kpi.link?.query?.kpi);
    if (!kpi.ids || !chip || kpi.value === 0) return null;
    return {
      label: `See all ${kpi.value} in Buyers`,
      href: `/broker/analytics${analyticsSearch({ range: state.range, examples: state.examples, tab: "buyers", kpi: chip })}`,
    };
  };

  const header = (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">How buyers are reading your CIMs, across your deals.</p>
      </div>
      <ReadingNowHeader rows={readingNow.data?.rows ?? []} />
    </div>
  );

  const examplesAside = o && o.examples.count > 0 ? (
    o.examples.canToggle || state.examples ? (
      <label className="flex cursor-pointer items-center gap-2 text-xs text-muted-foreground" data-testid="examples-switch">
        <Switch
          checked={o.examples.included}
          onCheckedChange={(on) => update({ examples: on ? "include" : "exclude" })}
          className="origin-left scale-[0.8]"
          data-testid="examples-toggle"
        />
        Include example deals
        <InfoDot text={EXAMPLE_TIP} />
      </label>
    ) : o.examples.included ? (
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="examples-caption">
        Includes example deals <InfoDot text={EXAMPLE_TIP} />
      </span>
    ) : null
  ) : null;

  const tabs: DashboardTab[] = TAB_ORDER.map((k) => ({
    key: k,
    label: ANALYTICS_TAB_LABELS[k].label,
    shortLabel: ANALYTICS_TAB_LABELS[k].short,
    count: k === "call" ? (o ? o.counts.call : "loading")
      : k === "deals" ? (o ? o.counts.dealsWithBuyers : "loading")
      : k === "buyers" ? (o ? o.counts.buyers : "loading")
      : undefined,
  }));

  const lastAt = o?.lastActivity ? Date.parse(o.lastActivity.at) : 0;
  const since = o ? rangeWindow(o.range, new Date(o.now)).since : null;
  const anyInRange = !since || lastAt >= since.getTime();

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 px-4 pb-12 pt-6 sm:px-6" data-testid="analytics-page">
      {header}
      {empty ? (
        <AnalyticsEmpty kind={empty} onIncludeExamples={() => update({ examples: "include" })} />
      ) : (
        <>
          <KpiStrip
            kpis={o?.kpis}
            range={range}
            loading={overview.isLoading}
            error={overview.isError}
            onRetry={() => overview.refetch()}
            periodTitle="Buyers"
            periodControl={<RangeControl value={range} onChange={(r) => update({ range: r })} className="w-full sm:w-auto" />}
            periodAside={examplesAside}
            showDeal
            footerFor={footerFor}
          />
          {o && (
            <RangeNote
              range={o.range}
              rangeAuto={o.rangeAuto}
              anyInRange={anyInRange}
              lastActivity={o.lastActivity}
              onPick={(r) => update({ range: r })}
            />
          )}
          {o?.partial && o.partial.failedDeals.length > 0 && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground" data-testid="analytics-partial">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
              <p className="min-w-0 flex-1">
                Couldn't load the reading for {o.partial.failedDeals.map((d) => d.dealName).join(", ")}. The numbers leave it out for now.
              </p>
              <Button size="sm" variant="ghost" className="h-7 px-2 text-xs text-teal" onClick={() => overview.refetch()}>Try again</Button>
            </div>
          )}
          {o && <HeadsUp lines={o.headsUp} />}

          <DashboardTabBar tabs={tabs} value={tab} onChange={onTab} ariaLabel="Analytics views" className="pt-1">
            <div className="space-y-4 pt-3">
              <TabDescription info={tab === "call" ? CALL_TAB_COPY.info : undefined}>
                {tab === "call" ? CALL_TAB_COPY.description
                  : tab === "deals" ? DEALS_TAB_DESCRIPTION
                  : tab === "buyers" ? BUYERS_TAB_DESCRIPTION
                  : tab === "activity" ? `What buyers did, newest first. Showing ${activityPeriodWords(range)}.`
                  : ATTENTION_COPY.description}
              </TabDescription>
              {tab === "call" && (
                <CallListTab
                  examples={state.examples}
                  selected={state.buyer}
                  onSelect={(buyer) => update({ buyer })}
                  callCount={o?.counts.call ?? 0}
                  notOpened={o?.counts.notOpened ?? 0}
                />
              )}
              {tab === "deals" && <DealsTab range={rangeReq} examples={state.examples} />}
              {tab === "buyers" && <AllBuyersTab examples={state.examples} state={state} update={update} />}
              {tab === "activity" && (
                <ActivityFeed
                  scope="broker"
                  range={rangeReq}
                  resolvedRange={range}
                  examples={state.examples}
                  deal={state.deal}
                  onDealChange={(deal) => update({ deal })}
                  kind={state.kind}
                  onKindChange={(kind) => update({ kind })}
                  onShowAllTime={() => update({ range: "all" })}
                />
              )}
              {tab === "attention" && <AttentionTab examples={state.examples} />}
            </div>
          </DashboardTabBar>
        </>
      )}
    </div>
  );
}

/** "● Reading now: Gurdeep Randhawa · Pacific Coast…" (and "and 2 more"); a click lists each. */
function ReadingNowHeader({ rows }: { rows: ReadingNowRow[] }) {
  if (rows.length === 0) return null;
  const first = rows[0];
  const more = rows.length - 1;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="flex min-w-0 max-w-full items-center gap-2 rounded-md py-1 text-left text-sm sm:max-w-[26rem] sm:pt-1.5" data-testid="analytics-reading-now">
          <LiveDot />
          <span className="min-w-0 truncate">
            <span className="font-medium">Reading now:</span> {first.name}
            {more > 0 ? ` and ${more} more` : ` · ${first.dealName}`}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 max-w-[calc(100vw-2rem)] p-2">
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li key={r.accessId}>
              <Link
                href={r.document === "teaser" ? `/deal/${r.dealId}/engagement?view=teaser` : `/deal/${r.dealId}/engagement?buyer=${encodeURIComponent(r.accessId)}`}
                className="block rounded-md px-2 py-1.5 text-sm hover:bg-muted/40"
              >
                <span className="font-medium">{r.name}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {r.document === "teaser" ? `is reading the teaser of ${r.dealName}` : `is reading ${r.dealName}`}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export type { KpiWho };
