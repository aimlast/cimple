/**
 * Data hooks for the deal's Information tab. Every mutation answers with the
 * refreshed view, which replaces the cached one (no refetch round trip).
 */
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import type { InformationView } from "@shared/information";

export const informationKey = (dealId: string) => ["/api/deals", dealId, "information"] as const;

const isProcessing = (status?: string) => status === "pending" || status === "parsing";

export function useInformation(dealId: string) {
  return useQuery<InformationView>({
    queryKey: informationKey(dealId),
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/information`, { credentials: "include" });
      if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error((body && body.error) || "Couldn't load the collected information");
      }
      return (await r.json()) as InformationView;
    },
    // A source still being read will add facts in a moment — keep watching.
    refetchInterval: (query) => (query.state.data?.sources.some((s) => isProcessing(s.status)) ? 2500 : false),
  });
}

export async function requestJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, {
    method,
    credentials: "include",
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed: any = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
  if (!r.ok) {
    throw new Error(
      (parsed && typeof parsed.error === "string" && parsed.error) ||
        (r.status === 401 ? "Your session has expired — please sign in again." : `Request failed (${r.status})`),
    );
  }
  return parsed as T;
}

/** Everything else that reads the deal's facts (overview, readiness, outline). */
function invalidateDealFacts(dealId: string) {
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId], exact: true });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-readiness"] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "interview-outline"] });
}

export interface FactAction {
  method: "PUT" | "POST" | "DELETE" | "PATCH";
  path: string;
  body?: unknown;
}

/** Runs a fact/source action and adopts the view it returns. */
export function useInformationAction(dealId: string) {
  return useMutation({
    mutationFn: async (action: FactAction) => {
      const res = await requestJson<InformationView | { view: InformationView }>(
        action.method,
        `/api/deals/${dealId}/information${action.path}`,
        action.body,
      );
      return res && "view" in res ? res.view : (res as InformationView);
    },
    onSuccess: (view) => {
      if (view && Array.isArray((view as InformationView).sections)) queryClient.setQueryData(informationKey(dealId), view);
      invalidateDealFacts(dealId);
    },
  });
}
