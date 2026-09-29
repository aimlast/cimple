/**
 * EngagementTab — how buyers read this deal's CIM (/deal/:id/engagement).
 *
 *   header   the pulse sentence ("6 of 7 buyers have opened the CIM · …"),
 *            "Reading now: …" with a live dot, the Buyers | Document switch
 *            and the filter bar (buyers, dates, device, version)
 *   Buyers   who to call today (BuyersView — intelligence stream)
 *   Document the heat map on the real CIM, page by page (DocumentView)
 *
 * The URL keeps the view, the filters, the open page and the open journey
 * (?view=document&page=<pageId#part>&buyers=…&journey=<accessId>) so a link
 * reopens the same place. Owned by the VIEWER stream.
 */
import { useCallback, useMemo } from "react";
import { useLocation, useSearch } from "wouter";
import { BarChart3, BookOpenText, Users } from "lucide-react";
import {
  engagementFiltersQuery,
  parseEngagementFilters,
  type EngagementFilters,
} from "@shared/analytics-v2";
import { useDeal } from "@/contexts/DealContext";
import { useEngagementSummary } from "@/hooks/useEngagement";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { BuyersView } from "@/components/engagement/buyers/BuyersView";
import { DocumentView } from "@/components/engagement/document/DocumentView";
import { JourneyDrawer } from "@/components/engagement/journey/JourneyDrawer";
import { FilterBar } from "@/components/engagement/FilterBar";
import type { EngagementNav, EngagementView } from "@/components/engagement/types";

export function EngagementTab() {
  const { dealId } = useDeal();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const view: EngagementView = params.view === "document" ? "document" : "buyers";
  const filters = useMemo(() => parseEngagementFilters(params), [params]);
  const journeyFor = /^[A-Za-z0-9_-]{1,64}$/.test(params.journey ?? "") ? params.journey : null;
  const { data: summary, isLoading } = useEngagementSummary(dealId);

  const go = useCallback((next: { view?: EngagementView; filters?: EngagementFilters; page?: string | null; journey?: string | null }) => {
    const q = new URLSearchParams(engagementFiltersQuery(next.filters ?? filters).replace(/^\?/, ""));
    const v = next.view ?? view;
    if (v !== "buyers") q.set("view", v);
    const page = next.page === undefined ? params.page : next.page;
    if (page && v === "document") q.set("page", page);
    const journey = next.journey === undefined ? journeyFor : next.journey;
    if (journey) q.set("journey", journey);
    const qs = q.toString();
    setLocation(`/deal/${dealId}/engagement${qs ? `?${qs}` : ""}`, { replace: true });
  }, [dealId, filters, params.page, setLocation, view, journeyFor]);

  const nav: EngagementNav = useMemo(() => ({
    openDocument: (opts) => go({
      view: "document",
      filters: opts?.accessId ? { ...filters, buyers: [opts.accessId], segment: "all" } : filters,
      page: opts?.pageId ? `${opts.pageId}#${opts.part ?? 0}` : null,
      journey: null,
    }),
    openJourney: (accessId) => go({ journey: accessId }),
  }), [filters, go]);

  const viewProps = { dealId, filters, onFiltersChange: (f: EngagementFilters) => go({ filters: f }), nav };
  const unpublished = summary && !summary.published && summary.pulse.opened === 0;

  return (
    <div className="space-y-4 p-4 sm:p-6" data-testid="engagement-tab">
      <header className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:gap-4">
          <div className="min-w-0 flex-1 space-y-1">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <BarChart3 className="h-4 w-4 text-teal" /> How buyers read your CIM
            </h2>
            {isLoading ? (
              <Skeleton className="h-4 w-80 max-w-full" />
            ) : (
              <p className="text-sm text-muted-foreground" data-testid="engagement-pulse">{summary?.pulse.sentence ?? " "}</p>
            )}
            {summary && summary.readingNow.length > 0 && (
              <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" data-testid="engagement-reading-now">
                <span className="relative inline-flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-500" />
                </span>
                <span className="font-medium">Reading now:</span>
                {summary.readingNow.map((r, i) => (
                  <button
                    key={r.accessId}
                    type="button"
                    onClick={() => nav.openDocument({ accessId: r.accessId, pageId: r.page?.pageId, part: r.page?.part })}
                    className="text-left hover:text-teal"
                  >
                    {r.name}{r.company ? ` (${r.company})` : ""}{r.page ? `, page ${r.page.label}` : ""}{i < summary.readingNow.length - 1 ? ";" : ""}
                  </button>
                ))}
              </p>
            )}
          </div>
          <div className="inline-flex self-start rounded-md border border-border p-0.5" role="tablist" aria-label="Engagement view">
            {(["buyers", "document"] as const).map((v) => (
              <button
                key={v}
                role="tab"
                aria-selected={view === v}
                onClick={() => go({ view: v, filters: v === "buyers" ? { ...filters, buyers: [] } : filters })}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-[5px] px-3 py-1.5 text-xs font-medium transition-colors",
                  view === v ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground",
                )}
              >
                {v === "buyers" ? <Users className="h-3.5 w-3.5" /> : <BookOpenText className="h-3.5 w-3.5" />}
                {v === "buyers" ? "Buyers" : "Where they read"}
              </button>
            ))}
          </div>
        </div>
        {!unpublished && (
          <FilterBar dealId={dealId} filters={filters} onChange={(f) => go({ filters: f })} renditions={summary?.renditions ?? []} />
        )}
      </header>

      {unpublished ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center" data-testid="engagement-unpublished">
          <p className="text-sm font-medium">Your CIM isn't live to buyers yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Once it's published and buyers open it, you'll see who read what, page by page, right on the CIM.
          </p>
        </div>
      ) : view === "buyers" ? (
        <BuyersView {...viewProps} />
      ) : (
        <DocumentView {...viewProps} page={params.page ?? null} onPageChange={(page) => go({ page })} openedSoFar={summary?.pulse.opened ?? 0} />
      )}
      <JourneyDrawer dealId={dealId} accessId={journeyFor} filters={filters} nav={nav} onClose={() => go({ journey: null })} />
    </div>
  );
}
