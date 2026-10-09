/**
 * React Query hooks for the analytics dashboards (shared/analytics-dashboard.ts
 * has every shape): the sidebar Analytics page, the deal Engagement tab's KPI
 * strip / Buyers list / Activity, and the Overview's Buyer pulse.
 *
 * Refreshing is cost-aware (spec §3.5, §8.4):
 *   - reading now: one cheap indexed read, every 30 s (global) / 20 s (deal)
 *     while the window is visible;
 *   - the numbers: on mount, on focus, on a period change and every 120 s
 *     (global) / 60 s (deal) while visible. The server answers from a short
 *     memo and refreshes it in the background, so a poll never waits;
 *   - tabs: on mount, on focus and on a tab switch.
 *
 * Every key lives under ["analytics"] (global) or ["engagement", dealId]
 * (deal), so `invalidateQueries({ queryKey: ["analytics"] })` and
 * engagementKeys.all(dealId) refresh everything a change can move.
 */
import { useEffect, useRef } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  engagementFiltersQuery,
  type EngagementFilters,
} from "@shared/analytics-v2";
import type {
  ActivityKindFilter,
  ActivityResponse,
  AnalyticsBuyersResponse,
  AnalyticsCallListResponse,
  AnalyticsDealsResponse,
  AnalyticsOverviewResponse,
  AttentionResponse,
  DashboardRange,
  DealKpisResponse,
  ExamplesMode,
  PageTitlesResponse,
  RangeRequest,
  ReadingNowResponse,
} from "@shared/analytics-dashboard";
import { queryClient as appQueryClient } from "@/lib/queryClient";

/** GET a broker JSON endpoint; the server's `{ error }` becomes the message; a 401 re-checks the session. */
export async function getAnalyticsJson<T>(url: string, fallback = "Couldn't load your analytics"): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    if (res.status === 401) {
      appQueryClient.invalidateQueries({ queryKey: ["/api/broker-auth/me"] });
      throw new Error("Your session has ended. Please sign in again.");
    }
    let message = `${fallback} (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = String(data.error);
    } catch {
      /* not JSON */
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

const visible = () => typeof document === "undefined" || document.visibilityState === "visible";
/** Poll every `ms` while the window is visible. */
const whileVisible = (ms: number) => () => (visible() ? ms : false);

function qs(params: Record<string, string | null | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

/** Query keys. Global ones under ["analytics"]; deal ones under ["engagement", dealId]. */
export const analyticsKeys = {
  all: ["analytics"] as const,
  overview: (range: RangeRequest, examples: ExamplesMode | null) => ["analytics", "overview", range, examples ?? "default"] as const,
  readingNow: (examples: ExamplesMode | null) => ["analytics", "reading-now", examples ?? "default"] as const,
  callList: (examples: ExamplesMode | null) => ["analytics", "call-list", examples ?? "default"] as const,
  deals: (range: RangeRequest, examples: ExamplesMode | null) => ["analytics", "deals", range, examples ?? "default"] as const,
  buyers: (examples: ExamplesMode | null) => ["analytics", "buyers", examples ?? "default"] as const,
  activity: (range: RangeRequest, deal: string | null, kind: ActivityKindFilter, examples: ExamplesMode | null) =>
    ["analytics", "activity", range, deal ?? "", kind, examples ?? "default"] as const,
  attention: (examples: ExamplesMode | null) => ["analytics", "attention", examples ?? "default"] as const,
  dealKpis: (dealId: string, q: string) => ["engagement", dealId, "kpis", q] as const,
  dealReadingNow: (dealId: string) => ["engagement", dealId, "reading-now"] as const,
  dealActivity: (dealId: string, q: string) => ["engagement", dealId, "activity", q] as const,
  pageTitles: (dealId: string, rendition: string | null) => ["engagement", dealId, "page-titles", rendition ?? ""] as const,
};

const A = "/api/broker/analytics";

// ── The Analytics page ────────────────────────────────────────────────────

export function useAnalyticsOverview(range: RangeRequest, examples: ExamplesMode | null, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.overview(range, examples),
    enabled,
    queryFn: () => getAnalyticsJson<AnalyticsOverviewResponse>(`${A}/overview${qs({ range: range === "auto" ? null : range, examples })}`),
    refetchOnWindowFocus: true,
    refetchInterval: whileVisible(120_000),
    placeholderData: (prev) => prev,
  });
}

export function useAnalyticsReadingNow(examples: ExamplesMode | null, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.readingNow(examples),
    enabled,
    queryFn: () => getAnalyticsJson<ReadingNowResponse>(`${A}/reading-now${qs({ examples })}`),
    refetchOnWindowFocus: true,
    refetchInterval: whileVisible(30_000),
  });
}

export function useAnalyticsCallList(examples: ExamplesMode | null) {
  return useQuery({
    queryKey: analyticsKeys.callList(examples),
    queryFn: () => getAnalyticsJson<AnalyticsCallListResponse>(`${A}/call-list${qs({ examples })}`, "Couldn't load who to call"),
    refetchOnWindowFocus: true,
  });
}

export function useAnalyticsDeals(range: RangeRequest, examples: ExamplesMode | null, enabled = true) {
  return useQuery({
    queryKey: analyticsKeys.deals(range, examples),
    enabled,
    queryFn: () => getAnalyticsJson<AnalyticsDealsResponse>(`${A}/deals${qs({ range: range === "auto" ? null : range, examples })}`),
    refetchOnWindowFocus: true,
    placeholderData: (prev) => prev,
  });
}

export function useAnalyticsBuyers(examples: ExamplesMode | null) {
  return useQuery({
    queryKey: analyticsKeys.buyers(examples),
    queryFn: () => getAnalyticsJson<AnalyticsBuyersResponse>(`${A}/buyers${qs({ examples })}`),
    refetchOnWindowFocus: true,
  });
}

export function useAnalyticsAttention(examples: ExamplesMode | null) {
  return useQuery({
    queryKey: analyticsKeys.attention(examples),
    queryFn: () => getAnalyticsJson<AttentionResponse>(`${A}/attention${qs({ examples })}`),
    refetchOnWindowFocus: true,
  });
}

export interface ActivityQuery {
  scope: "broker" | "deal";
  dealId?: string;
  /** Broker scope: the page's period ("auto" = the server's choice). Deal scope: from `filters`. */
  range?: RangeRequest;
  /** Broker scope: one deal, or null for all. */
  deal?: string | null;
  kind: ActivityKindFilter;
  examples?: ExamplesMode | null;
  /** Deal scope: the Engagement tab's filters (When and Buyers apply). */
  filters?: EngagementFilters;
  limit?: number;
}

/** The activity feed, paged with a cursor ("Show older"). */
export function useAnalyticsActivity(q: ActivityQuery) {
  const limit = q.limit ?? 50;
  const isDeal = q.scope === "deal";
  const dealQ = isDeal ? engagementFiltersQuery({ ...(q.filters ?? {}), device: "all", rendition: null }).replace(/^\?/, "") : "";
  const key = isDeal
    ? analyticsKeys.dealActivity(q.dealId ?? "", `${dealQ}|${q.kind}|${limit}`)
    : analyticsKeys.activity(q.range ?? "auto", q.deal ?? null, q.kind, q.examples ?? null);
  return useInfiniteQuery({
    queryKey: [...key, limit],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params: Record<string, string | null> = { kind: q.kind === "all" ? null : q.kind, cursor: pageParam, limit: String(limit) };
      if (isDeal) {
        const p = new URLSearchParams(dealQ);
        p.forEach((v, k) => { params[k] = v; });
        return getAnalyticsJson<ActivityResponse>(`/api/deals/${q.dealId}/engagement/activity${qs(params)}`, "Couldn't load the activity");
      }
      params.range = q.range && q.range !== "auto" ? q.range : null;
      params.deal = q.deal ?? null;
      params.examples = q.examples ?? null;
      return getAnalyticsJson<ActivityResponse>(`${A}/activity${qs(params)}`, "Couldn't load the activity");
    },
    getNextPageParam: (last) => last.next,
    enabled: !isDeal || !!q.dealId,
    refetchOnWindowFocus: true,
  });
}

// ── One deal (Engagement tab, Buyer pulse) ────────────────────────────────

/** The deal's numbers, Buyers-view groups, reading now and versions. Device and version never change a number. */
export function useDealKpis(dealId: string | undefined, filters: Partial<EngagementFilters>) {
  // Device and Which CIM version don't change any number: keep them out of the key (one cache entry).
  const q = engagementFiltersQuery({ ...filters, device: "all", rendition: null });
  return useQuery({
    queryKey: analyticsKeys.dealKpis(dealId ?? "", q),
    queryFn: () => getAnalyticsJson<DealKpisResponse>(`/api/deals/${dealId}/engagement/kpis${q}`),
    enabled: !!dealId,
    refetchOnWindowFocus: true,
    refetchInterval: whileVisible(60_000),
    placeholderData: (prev) => prev,
  });
}

/**
 * Who is reading this deal right now (one cheap read, every 20 s). When it
 * names someone the KPI response doesn't list yet, the KPIs are refreshed
 * once (at most every 10 s) so the page they're on appears within a cycle.
 */
export function useDealReadingNow(dealId: string | undefined, kpiReadingNow?: ReadonlyArray<{ accessId: string }>) {
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: analyticsKeys.dealReadingNow(dealId ?? ""),
    queryFn: () => getAnalyticsJson<ReadingNowResponse>(`/api/deals/${dealId}/engagement/reading-now`),
    enabled: !!dealId,
    refetchOnWindowFocus: true,
    refetchInterval: whileVisible(20_000),
  });
  const lastKick = useRef(0);
  const known = kpiReadingNow ? kpiReadingNow.map((r) => r.accessId).join(",") : null;
  useEffect(() => {
    if (!dealId || known == null || !query.data) return;
    const have = new Set(known ? known.split(",") : []);
    const missing = query.data.rows.some((r) => !have.has(r.accessId));
    const now = Date.now();
    if (missing && now - lastKick.current > 10_000) {
      lastKick.current = now;
      qc.invalidateQueries({ queryKey: ["engagement", dealId, "kpis"] });
    }
  }, [dealId, known, query.data, qc]);
  return query;
}

/** The deal's page titles (slim; the same titles as the heat map). */
export function useEngagementPageTitles(dealId: string | undefined, rendition: string | null = null) {
  return useQuery({
    queryKey: analyticsKeys.pageTitles(dealId ?? "", rendition),
    queryFn: () => getAnalyticsJson<PageTitlesResponse>(`/api/deals/${dealId}/engagement/page-titles${qs({ rendition })}`),
    enabled: !!dealId,
    staleTime: 5 * 60_000,
  });
}

/** Real titles and the titles blind buyers saw, by viewerPageKey (for page strips). */
export function titleMaps(data: PageTitlesResponse | undefined): { titles: Map<string, string>; blindTitles: Map<string, string> } {
  const titles = new Map<string, string>();
  const blindTitles = new Map<string, string>();
  for (const p of data?.pages ?? []) {
    titles.set(p.key, p.title);
    blindTitles.set(p.key, p.blindTitle || `page ${p.label}`);
  }
  return { titles, blindTitles };
}

export type { DashboardRange };
