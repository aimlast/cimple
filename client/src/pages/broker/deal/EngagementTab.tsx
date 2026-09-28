/**
 * EngagementTab — how buyers read this deal's CIM (/deal/:id/engagement).
 *
 *   header   the pulse sentence, "Reading now", filter chips
 *   Buyers   who to call today (BuyersView — intelligence stream)
 *   Document the heat map on the real CIM, page by page (DocumentView — viewer stream)
 *
 * The URL keeps the view and filters (?view=document&page=<pageId#part>&buyers=…)
 * so a link reopens the same place. Owned by the VIEWER stream; base = the
 * shell, the URL state and the two slots.
 */
import { useCallback, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import {
  engagementFiltersQuery,
  parseEngagementFilters,
  type EngagementFilters,
} from "@shared/analytics-v2";
import { useDeal } from "@/contexts/DealContext";
import { useEngagementSummary } from "@/hooks/useEngagement";
import { cn } from "@/lib/utils";
import { BuyersView } from "@/components/engagement/buyers/BuyersView";
import { DocumentView } from "@/components/engagement/document/DocumentView";
import { JourneyDrawer } from "@/components/engagement/journey/JourneyDrawer";
import type { EngagementNav, EngagementView } from "@/components/engagement/types";

export function EngagementTab() {
  const { dealId } = useDeal();
  const search = useSearch();
  const [, setLocation] = useLocation();
  const params = useMemo(() => Object.fromEntries(new URLSearchParams(search)), [search]);
  const view: EngagementView = params.view === "document" ? "document" : "buyers";
  const filters = useMemo(() => parseEngagementFilters(params), [params]);
  const [journeyFor, setJourneyFor] = useState<string | null>(null);
  const { data: summary } = useEngagementSummary(dealId);

  const go = useCallback((next: { view?: EngagementView; filters?: EngagementFilters; page?: string | null }) => {
    const q = new URLSearchParams(engagementFiltersQuery(next.filters ?? filters).replace(/^\?/, ""));
    const v = next.view ?? view;
    if (v !== "buyers") q.set("view", v);
    const page = next.page === undefined ? params.page : next.page;
    if (page && v === "document") q.set("page", page);
    const qs = q.toString();
    setLocation(`/deal/${dealId}/engagement${qs ? `?${qs}` : ""}`, { replace: true });
  }, [dealId, filters, params.page, setLocation, view]);

  const nav: EngagementNav = useMemo(() => ({
    openDocument: (opts) => go({
      view: "document",
      filters: opts?.accessId ? { ...filters, buyers: [opts.accessId] } : filters,
      page: opts?.pageId ? `${opts.pageId}#${opts.part ?? 0}` : null,
    }),
    openJourney: (accessId) => setJourneyFor(accessId),
  }), [filters, go]);

  const viewProps = { dealId, filters, onFiltersChange: (f: EngagementFilters) => go({ filters: f }), nav };

  return (
    <div className="p-4 sm:p-6 space-y-4" data-testid="engagement-tab">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-foreground/90 flex-1 min-w-0">{summary?.pulse.sentence ?? " "}</p>
        <div className="inline-flex rounded-md border border-border p-0.5" role="tablist" aria-label="Engagement view">
          {(["buyers", "document"] as const).map((v) => (
            <button
              key={v}
              role="tab"
              aria-selected={view === v}
              onClick={() => go({ view: v, filters: v === "buyers" ? { ...filters, buyers: [] } : filters })}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-[5px] transition-colors",
                view === v ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {v === "buyers" ? "Buyers" : "Document"}
            </button>
          ))}
        </div>
      </div>
      {view === "buyers" ? <BuyersView {...viewProps} /> : <DocumentView {...viewProps} />}
      <JourneyDrawer dealId={dealId} accessId={journeyFor} onClose={() => setJourneyFor(null)} />
    </div>
  );
}
