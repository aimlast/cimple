/**
 * useCimGenerationGate — "can the AI write the whole CIM now?" on the
 * client: the shared rule (shared/deal-progress cimGenerationGate — a
 * completed interview, or enough information from any source) with the
 * deal's readiness score from GET /api/deals/:id/cim-readiness. The server
 * enforces the same rule on generate-content / generate-layout.
 *
 * Critical discrepancies are a separate gate (useAiGate / useDiscrepancyGate).
 */
import { useQuery } from "@tanstack/react-query";
import { cimGenerationGate, type CimGenerationGate } from "@shared/deal-progress";
import type { CimReadiness } from "@shared/cim-readiness";

export const cimReadinessKey = (dealId: string) => ["/api/deals", dealId, "cim-readiness"] as const;

export function useCimGenerationGate(
  dealId: string,
  interviewCompleted: boolean | null | undefined,
): CimGenerationGate & { readiness: CimReadiness | null } {
  const { data, error } = useQuery<{ readiness: CimReadiness }>({
    queryKey: cimReadinessKey(dealId),
    enabled: !!dealId,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/cim-readiness`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load CIM readiness");
      return r.json();
    },
  });
  const readiness = data?.readiness ?? null;
  if (!interviewCompleted && error && !readiness) {
    return {
      allowed: false,
      pending: false,
      reason: "Couldn't check how much information the deal has — generating stays off until it loads.",
      readiness: null,
    };
  }
  return { ...cimGenerationGate({ interviewCompleted: !!interviewCompleted }, readiness?.score), readiness };
}
