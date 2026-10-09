/**
 * EngagementTab — how buyers read this deal's CIM (/deal/:id/engagement),
 * as a dashboard:
 *
 *   reading now   "● Reading now: Gurdeep Randhawa (Kinbrook) — page 12, …"
 *   numbers       NEEDS YOU NOW (worth a call, waiting on you) and the period
 *                 block headed with the filters in words (opened the CIM,
 *                 buyers who read, NDAs signed, said interested)
 *   view bar      Buyers · Where they read · Activity (+ Teaser, Data room
 *                 when registered and available), the filters on the right
 *   the view      Buyers (list + card), the heat map (DocumentView, owned by
 *                 the heat-map stream), Activity, or an extra view
 *
 * The URL keeps the view, the selected buyer, the open page, the open
 * journey, the filters and any parameter a view owns (the heat map's
 * compare=), so a link reopens the same place (components/analytics/url.ts
 * engagementSearch).
 */
import { useCallback, useMemo } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { parseEngagementFilters, type EngagementFilters } from "@shared/analytics-v2";
import type { Kpi, KpiWho } from "@shared/analytics-dashboard";
import { useDeal } from "@/contexts/DealContext";
import { useDealKpis, useDealReadingNow } from "@/hooks/useAnalyticsDashboard";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BuyersView } from "@/components/engagement/buyers/BuyersView";
import { DocumentView } from "@/components/engagement/document/DocumentView";
import { JourneyDrawer } from "@/components/engagement/journey/JourneyDrawer";
import { FilterBar, FilterChips, ALL_FILTERS, onlyShown } from "@/components/engagement/FilterBar";
import { EXTRA_ENGAGEMENT_VIEWS, type EngagementFilterKey } from "@/components/engagement/extra-views";
import type { EngagementNav } from "@/components/engagement/types";
import { KpiStrip, type KpiFooter } from "@/components/analytics/KpiStrip";
import { DashboardTabBar, type DashboardTab } from "@/components/analytics/DashboardTabBar";
import { ActivityFeed, LiveDot } from "@/components/analytics/ActivityFeed";
import { Chip } from "@/components/analytics/parts";
import { engagementSearch, resolveEngagementView, type EngagementNext } from "@/components/analytics/url";

export const SAMPLE_READING_CHIP = "Sample reading";
export const SAMPLE_READING_TIP = "This is an example deal: its buyers and their reading are made up.";

const CORE_FILTERS: Record<string, EngagementFilterKey[]> = {
  buyers: ALL_FILTERS,
  document: ALL_FILTERS,
  activity: ["buyers", "when"],
};

/** Each registered extra view's availability for this deal (one hook per view; the list never changes). */
function useExtraViews(dealId: string) {
  return EXTRA_ENGAGEMENT_VIEWS.map((v) => ({ view: v, available: v.useAvailable(dealId) }))
    .filter((x) => x.available)
    .map((x) => x.view);
}

export function EngagementTab() {
  const { dealId } = useDeal();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const extras = useExtraViews(dealId);
  const extraKeyList = extras.map((v) => v.key).join(",");
  const extraKeys = useMemo(() => (extraKeyList ? extraKeyList.split(",") : []), [extraKeyList]);
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const view = resolveEngagementView(params.view, extraKeys);
  const filters = useMemo(() => parseEngagementFilters(params), [params]);
  const journeyFor = /^[A-Za-z0-9_-]{1,64}$/.test(params.journey ?? "") ? params.journey : null;
  const selectedBuyer = /^[A-Za-z0-9_-]{1,64}$/.test(params.buyer ?? "") ? params.buyer : null;

  const kpisQ = useDealKpis(dealId, filters);
  const k = kpisQ.data;
  const readingNowQ = useDealReadingNow(dealId, k?.readingNow);

  const go = useCallback((next: EngagementNext) => {
    const qs = engagementSearch(search, next, extraKeys);
    const viewChange = next.view !== undefined && resolveEngagementView(next.view, extraKeys) !== view;
    setLocation(`/deal/${dealId}/engagement${qs}`, { replace: !viewChange });
  }, [dealId, extraKeys, search, setLocation, view]);

  const nav: EngagementNav = useMemo(() => ({
    openDocument: (opts) => go({
      view: "document",
      filters: opts?.accessId ? { ...filters, buyers: [opts.accessId], segment: "all" } : filters,
      page: opts?.pageId ? `${opts.pageId}#${opts.part ?? 0}` : null,
      journey: null,
    }),
    openJourney: (accessId) => go({ journey: accessId }),
  }), [filters, go]);

  const switchView = (v: string) => {
    if (v === "buyers" && view === "document" && filters.buyers.length === 1) {
      // Back from "See where they read": the whole list, with that buyer selected.
      go({ view: v, filters: { ...filters, buyers: [] }, buyer: filters.buyers[0] });
      return;
    }
    go({ view: v });
  };

  const extra = extras.find((v) => v.key === view) ?? null;
  const show: EngagementFilterKey[] = extra ? extra.filters ?? [] : CORE_FILTERS[view] ?? ALL_FILTERS;
  const viewFilters = onlyShown(filters, show);
  const setFilters = (f: EngagementFilters) => go({ filters: f });

  const kpi = (id: Kpi["id"]) => k?.kpis.find((x) => x.id === id);
  const opened = kpi("opened");
  const anyOpened = k
    ? (filters.range === "all" ? (opened?.value ?? 0) > 0 : k.readersAll > 0 || k.groups.worthACall.length + k.groups.reading.length + k.groups.quietInRange.length > 0)
    : false;
  const unpublished = !!k && !k.published && !anyOpened;
  const noCimBuyers = !!k && k.grantedCim === 0;
  const olderVisits = !!k && k.legacyOnly && !k.sampleReading;

  // Reading now: the cheap poll says who; the KPI response adds the page they're on.
  const nowRows = (readingNowQ.data?.rows ?? []).map((r) => ({ ...r, page: k?.readingNow.find((x) => x.accessId === r.accessId)?.page ?? null }));

  const onWho = (w: KpiWho): boolean => {
    if (w.kind === "buyer" && w.accessId) {
      go({ view: "buyers", buyer: w.accessId, filters });
      return true;
    }
    return false;
  };
  const footerFor = (x: Kpi): KpiFooter | null => {
    if (x.id === "waiting") {
      const q = x.breakdown?.[0]?.count ?? 0;
      if (x.value === 0) return null;
      return q > 0 ? { label: "Answer in Q&A", href: `/deal/${dealId}/qa` } : { label: "Review in Buyers", href: `/deal/${dealId}/buyers?stage=approval` };
    }
    if (view === "buyers" || x.value === 0) return null;
    return { label: "Open the Buyers list", onClick: () => go({ view: "buyers" }) };
  };

  // "Buyers 13": everyone who opened (all time); under a date filter the list says the rest.
  const buyersCount = k ? (filters.range === "all" ? opened?.value ?? 0 : undefined) : "loading" as const;
  const tabs: DashboardTab[] = [
    ...(noCimBuyers ? [{ key: "buyers", label: "Buyers" }] : [
      { key: "buyers", label: "Buyers", count: buyersCount },
      { key: "document", label: "Where they read", shortLabel: "Heat map" },
      { key: "activity", label: "Activity" },
    ]),
    ...extras.map((v) => ({ key: v.key, label: v.label, shortLabel: v.shortLabel })),
  ];

  if (unpublished) {
    return (
      <div className="p-4 sm:p-6" data-testid="engagement-tab">
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center" data-testid="engagement-unpublished">
          <p className="text-sm font-medium">Your CIM isn't live to buyers yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Once it's published and buyers open it, you'll see who read what, page by page, right on the CIM.
          </p>
        </div>
      </div>
    );
  }

  const right = (
    <>
      {k?.sampleReading && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span><Chip tone="example" testId="sample-reading-chip">{SAMPLE_READING_CHIP}</Chip></span>
          </TooltipTrigger>
          <TooltipContent className="max-w-xs text-xs">{SAMPLE_READING_TIP}</TooltipContent>
        </Tooltip>
      )}
      {!noCimBuyers && <FilterBar dealId={dealId} filters={filters} onChange={setFilters} renditions={k?.renditions ?? []} show={show} />}
    </>
  );

  return (
    <div className="space-y-4 p-4 sm:p-6" data-testid="engagement-tab">
      {nowRows.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="engagement-reading-now">
          <LiveDot />
          <span className="font-medium">Reading now:</span>
          {nowRows.map((r, i) => (
            <button
              key={r.accessId}
              type="button"
              onClick={() => (r.document === "teaser" ? go({ view: extraKeys.includes("teaser") ? "teaser" : "buyers" }) : go({ view: "buyers", buyer: r.accessId }))}
              className="text-left hover:text-teal"
            >
              {r.name}{r.company ? ` (${r.company})` : ""}
              {r.document === "teaser" ? " is reading the teaser" : r.page ? ` — page ${r.page.label}, ${r.page.title}` : ""}
              {i < nowRows.length - 1 ? ";" : ""}
            </button>
          ))}
        </p>
      )}

      {!noCimBuyers && (
        <KpiStrip
          kpis={k?.kpis}
          range={filters.range}
          loading={kpisQ.isLoading}
          error={kpisQ.isError}
          onRetry={() => kpisQ.refetch()}
          size="sm"
          periodTitle={k?.forText ?? "All time · All buyers"}
          onWho={onWho}
          footerFor={footerFor}
          collapsible={view !== "buyers"}
        />
      )}

      <DashboardTabBar
        tabs={tabs}
        value={noCimBuyers && !extra ? "buyers" : view}
        onChange={switchView}
        right={right}
        rightClassName="md:w-full lg:w-auto"
        ariaLabel="Engagement views"
        sticky
      >
        <div className="space-y-3 pt-3">
          {!noCimBuyers && <FilterChips dealId={dealId} filters={filters} onChange={setFilters} renditions={k?.renditions ?? []} show={show} />}
          {noCimBuyers && !extra ? (
            <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center" data-testid="engagement-no-buyers">
              <p className="text-sm font-medium">No buyers have this CIM yet</p>
              <p className="mt-1 text-sm text-muted-foreground">Give a buyer access and you'll see who reads what, page by page, and who to call first.</p>
              <Button asChild size="sm" className="mt-4"><Link href={`/deal/${dealId}/buyers?stage=send`}>Give access</Link></Button>
            </div>
          ) : extra ? (
            <extra.Component dealId={dealId} filters={viewFilters} />
          ) : view === "document" ? (
            <DocumentView
              dealId={dealId}
              filters={filters}
              onFiltersChange={setFilters}
              nav={nav}
              page={params.page ?? null}
              onPageChange={(page) => go({ page })}
              openedSoFar={opened?.value ?? 0}
            />
          ) : view === "activity" ? (
            <ActivityFeed scope="deal" dealId={dealId} filters={viewFilters} onShowAllTime={() => setFilters({ ...filters, range: "all" })} />
          ) : (
            <BuyersView
              dealId={dealId}
              filters={filters}
              onFiltersChange={setFilters}
              nav={nav}
              groups={k?.groups ?? null}
              readers={kpi("reading")?.value ?? 0}
              olderVisits={olderVisits}
              published={k?.published ?? true}
              selected={selectedBuyer}
              onSelect={(buyer) => go({ buyer })}
            />
          )}
        </div>
      </DashboardTabBar>
      <JourneyDrawer dealId={dealId} accessId={journeyFor} filters={filters} nav={nav} onClose={() => go({ journey: null })} />
    </div>
  );
}
