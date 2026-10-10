/**
 * useTeaserSummary — the light teaser summary (GET …/teaser/summary): the
 * CIM tab's strip, the Buyers tab, the Overview note. Polls every 2 s while
 * Cimple is writing the teaser, so every screen sees "written" at once.
 * Errors stay quiet: the teaser is never essential to those screens.
 */
import { useQuery } from "@tanstack/react-query";
import { teaserRequest, teaserSummaryKey, type TeaserSummary } from "./api";

export function useTeaserSummary(dealId: string | null | undefined, opts: { enabled?: boolean } = {}) {
  return useQuery<TeaserSummary>({
    queryKey: teaserSummaryKey(dealId ?? ""),
    enabled: !!dealId && opts.enabled !== false,
    queryFn: () => teaserRequest<TeaserSummary>("GET", `/api/deals/${dealId}/teaser/summary`),
    refetchInterval: (q) => ((q.state.data as TeaserSummary | undefined)?.generation?.status === "running" ? 2000 : false),
    refetchOnWindowFocus: true,
    retry: 1,
  });
}

/** A published teaser buyers can open right now. */
export function teaserIsPublished(s: TeaserSummary | null | undefined): boolean {
  return s?.status === "published";
}

/**
 * The Engagement tab's Teaser view is offered when there is a teaser or a
 * teaser link (the integrator registers it: INTEGRATION §2.9).
 */
export function useDealHasTeaser(dealId: string): boolean {
  const { data } = useTeaserSummary(dealId);
  return !!data && (data.status !== "none" || data.counts.links > 0);
}
