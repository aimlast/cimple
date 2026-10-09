/**
 * React Query hooks for the buyer engagement APIs (shared/analytics-v2.ts).
 * Base contract — shared by the viewer and intelligence UIs so both hit the
 * same cache keys. Every hook is broker-side (session cookie).
 *
 * Polling: the summary polls every 20 s while the tab is visible ("Reading
 * now"); the rest refetch on filter change only.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  engagementFiltersQuery,
  type BuyerBriefResponse,
  type BuyerJourneyResponse,
  type CallListResponse,
  type EngagementBuyersResponse,
  type EngagementCompareResponse,
  type EngagementDocumentResponse,
  type EngagementFilters,
  type EngagementRenditionResponse,
  type EngagementSummaryResponse,
  type MarkContactedResponse,
} from "@shared/analytics-v2";

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.text()) || res.statusText);
  return res.json() as Promise<T>;
}

/** Query-key roots (invalidate a deal's engagement with ["engagement", dealId]). */
export const engagementKeys = {
  all: (dealId: string) => ["engagement", dealId] as const,
  summary: (dealId: string) => ["engagement", dealId, "summary"] as const,
  buyers: (dealId: string, q: string) => ["engagement", dealId, "buyers", q] as const,
  document: (dealId: string, q: string) => ["engagement", dealId, "document", q] as const,
  rendition: (dealId: string, rid: string) => ["engagement", dealId, "rendition", rid] as const,
  journey: (dealId: string, accessId: string, q: string) => ["engagement", dealId, "journey", accessId, q] as const,
  callList: () => ["engagement", "broker", "call-list"] as const,
  compare: () => ["engagement", "broker", "compare"] as const,
};

const base = (dealId: string) => `/api/deals/${dealId}/engagement`;

export function useEngagementSummary(dealId: string | undefined) {
  return useQuery({
    queryKey: engagementKeys.summary(dealId ?? ""),
    queryFn: () => getJson<EngagementSummaryResponse>(`${base(dealId!)}/summary`),
    enabled: !!dealId,
    refetchInterval: () => (typeof document !== "undefined" && document.visibilityState === "visible" ? 20_000 : false),
  });
}

export function useEngagementBuyers(dealId: string | undefined, filters: Partial<EngagementFilters> = {}) {
  const q = engagementFiltersQuery(filters);
  return useQuery({
    queryKey: engagementKeys.buyers(dealId ?? "", q),
    queryFn: () => getJson<EngagementBuyersResponse>(`${base(dealId!)}/buyers${q}`),
    enabled: !!dealId,
  });
}

export function useEngagementDocument(dealId: string | undefined, filters: Partial<EngagementFilters> = {}) {
  const q = engagementFiltersQuery(filters);
  return useQuery({
    queryKey: engagementKeys.document(dealId ?? "", q),
    queryFn: () => getJson<EngagementDocumentResponse>(`${base(dealId!)}/document${q}`),
    enabled: !!dealId,
  });
}

/** The exact CIM a buyer was served (for the heat-map viewer). Immutable per id. */
export function useEngagementRendition(dealId: string | undefined, renditionId: string | null | undefined) {
  return useQuery({
    queryKey: engagementKeys.rendition(dealId ?? "", renditionId ?? ""),
    queryFn: () => getJson<EngagementRenditionResponse>(`${base(dealId!)}/renditions/${renditionId}`),
    enabled: !!dealId && !!renditionId,
    staleTime: Infinity,
  });
}

export function useBuyerJourney(dealId: string | undefined, accessId: string | null | undefined, filters: Partial<EngagementFilters> = {}) {
  const q = engagementFiltersQuery(filters);
  return useQuery({
    queryKey: engagementKeys.journey(dealId ?? "", accessId ?? "", q),
    queryFn: () => getJson<BuyerJourneyResponse>(`${base(dealId!)}/buyers/${accessId}/journey${q}`),
    enabled: !!dealId && !!accessId,
  });
}

export function useMarkContacted(dealId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (accessId: string) => postJson<MarkContactedResponse>(`${base(dealId)}/buyers/${accessId}/contacted`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: engagementKeys.all(dealId) });
      qc.invalidateQueries({ queryKey: engagementKeys.callList() });
      qc.invalidateQueries({ queryKey: ["analytics"] });
    },
  });
}

export function useBuyerBrief(dealId: string) {
  return useMutation({
    mutationFn: (accessId: string) => postJson<BuyerBriefResponse>(`${base(dealId)}/buyers/${accessId}/brief`),
  });
}

export function useCallList() {
  return useQuery({ queryKey: engagementKeys.callList(), queryFn: () => getJson<CallListResponse>("/api/broker/engagement/call-list") });
}

export function useEngagementCompare() {
  return useQuery({ queryKey: engagementKeys.compare(), queryFn: () => getJson<EngagementCompareResponse>("/api/broker/engagement/compare") });
}
