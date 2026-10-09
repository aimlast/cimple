/**
 * useGlStatus — "Add-backs in the books" data for the broker's screens
 * (react-query keys from lib/gl-api): the Financials panel's full payload,
 * and the small progress + gate the Overview, the CIM tab and the builder
 * read. Both refresh on window focus; the panel polls every 30 s (2 s while
 * a ledger is being read).
 */
import { useQuery } from "@tanstack/react-query";
import { getJson, glKeys, type BrokerGlData, type GlProgressData } from "@/lib/gl-api";
import { queryClient } from "@/lib/queryClient";

export function useBrokerGl(dealId: string, opts: { enabled?: boolean } = {}) {
  return useQuery<BrokerGlData>({
    queryKey: glKeys.broker(dealId),
    queryFn: () => getJson<BrokerGlData>(`/api/deals/${dealId}/gl`),
    enabled: opts.enabled ?? true,
    refetchInterval: (q) => ((q.state.data?.ledgers ?? []).some((l) => l.status === "reading") ? 2000 : (q.state.data?.traces ?? []).some((t) => t.assistant?.state === "looking") ? 3000 : 30_000),
    refetchOnWindowFocus: true,
  });
}

export function useGlProgress(dealId: string, opts: { enabled?: boolean } = {}) {
  return useQuery<GlProgressData>({
    queryKey: glKeys.progress(dealId),
    queryFn: () => getJson<GlProgressData>(`/api/deals/${dealId}/gl/progress`),
    enabled: opts.enabled ?? true,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });
}

/** After any GL change: the panel, the progress/gate and the deal list's next step. */
export function invalidateGl(dealId: string) {
  void queryClient.invalidateQueries({ queryKey: glKeys.broker(dealId) });
  void queryClient.invalidateQueries({ queryKey: glKeys.progress(dealId) });
  void queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "gl", "traces"] });
}
