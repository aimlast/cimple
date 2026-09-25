/**
 * Data hooks for the seller-side CRM import: the deal's CRM link + import
 * status + seller contact, and a debounced Pipedrive search. Mutations answer
 * with the refreshed status, which replaces the cached one.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { requestJson, informationKey } from "@/components/information/useInformation";
import type { CrmSearchResponse, CrmStatusResponse } from "@shared/crm-seller";
import type { CrmRecordType } from "@shared/schema";

export const crmStatusKey = (dealId: string) => ["/api/deals", dealId, "crm-status"] as const;

/** Everything that shows facts or sources refreshes after an import. */
function invalidateAfterImport(dealId: string) {
  queryClient.invalidateQueries({ queryKey: informationKey(dealId) });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId], exact: true });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-readiness"] });
}

export function useCrmStatus(dealId: string) {
  const wasRunning = useRef(false);
  const query = useQuery<CrmStatusResponse>({
    queryKey: crmStatusKey(dealId),
    queryFn: () => requestJson<CrmStatusResponse>("GET", `/api/deals/${dealId}/crm/status`),
    refetchInterval: (q) => (q.state.data?.import?.state === "running" ? 2000 : false),
  });
  const state = query.data?.import?.state;
  const processed = query.data?.import?.processed;
  useEffect(() => {
    // New sources land while an import runs — keep the facts view current.
    if (state === "running") {
      if (wasRunning.current) queryClient.invalidateQueries({ queryKey: informationKey(dealId) });
      wasRunning.current = true;
    } else if (wasRunning.current) {
      wasRunning.current = false;
      invalidateAfterImport(dealId);
    }
  }, [state, processed, dealId]);
  return query;
}

export interface CrmAction {
  method: "POST" | "DELETE" | "PUT";
  path: string;
  body?: unknown;
}

export function useCrmAction(dealId: string) {
  return useMutation({
    mutationFn: (a: CrmAction) => requestJson<CrmStatusResponse>(a.method, `/api/deals/${dealId}${a.path}`, a.body),
    onSuccess: (status) => {
      queryClient.setQueryData(crmStatusKey(dealId), status);
      if (status.import?.state === "running") queryClient.invalidateQueries({ queryKey: informationKey(dealId) });
    },
  });
}

export const linkBody = (type: CrmRecordType, id: string, startImport = true) => ({ type, id, startImport });

/** Debounced CRM search. `dealId` null = the New Deal page (not tied to a deal yet). */
export function useCrmSearch(dealId: string | null, term: string) {
  const [debounced, setDebounced] = useState(term.trim());
  useEffect(() => {
    const t = setTimeout(() => setDebounced(term.trim()), 300);
    return () => clearTimeout(t);
  }, [term]);
  const url = dealId ? `/api/deals/${dealId}/crm/search` : `/api/crm/search`;
  return useQuery<CrmSearchResponse>({
    queryKey: [url, debounced],
    queryFn: () => requestJson<CrmSearchResponse>("GET", `${url}?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });
}

export function timeAgo(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  const s = Math.round((Date.now() - d.getTime()) / 1000);
  if (Number.isNaN(s)) return null;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export const RECORD_TYPE_LABEL: Record<CrmRecordType, string> = {
  deal: "Deal",
  organization: "Organisation",
  person: "Person",
};
