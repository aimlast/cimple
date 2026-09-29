/**
 * useAiGate — the discrepancy gate for AI writing in the CIM builder. Critical
 * discrepancies that are open or awaiting review block every AI step that
 * writes CIM content (the server enforces the same rule and answers 409) —
 * and so does one routed to a seller who had already finished the interview,
 * until they answer (shared/discrepancy-gate.ts).
 */
import { useQuery } from "@tanstack/react-query";
import type { Discrepancy } from "@shared/schema";
import { discrepancyBlocksCim } from "@shared/discrepancy-gate";

export function useAiGate(dealId: string): { blockedReason: string | null; blockingCount: number } {
  const { data, error } = useQuery<Discrepancy[]>({
    queryKey: ["/api/deals", dealId, "discrepancies"],
    enabled: !!dealId,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/discrepancies`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load discrepancies");
      return r.json();
    },
  });
  // (The deal row is cached app-wide; only its interviewCompleted is read.)
  const { data: deal } = useQuery<{ interviewCompleted?: boolean | null }>({
    queryKey: ["/api/deals", dealId],
    enabled: !!dealId,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load the deal");
      return r.json();
    },
  });
  if (error) return { blockedReason: "Couldn't check for discrepancies — AI writing stays off until they load.", blockingCount: 0 };
  const blocking = (data ?? []).filter((d) => discrepancyBlocksCim(d, deal?.interviewCompleted));
  const withSeller = blocking.filter((d) => d.status === "ask_seller").length;
  const open = blocking.length - withSeller;
  return {
    blockedReason: open
      ? `Resolve ${open} critical discrepanc${open === 1 ? "y" : "ies"} (Overview tab) before the AI writes CIM content.`
      : withSeller
        ? `Waiting on the seller to answer ${withSeller} critical question${withSeller === 1 ? "" : "s"} you sent them — or resolve ${withSeller === 1 ? "it" : "them"} on the Overview tab — before the AI writes CIM content.`
        : null,
    blockingCount: blocking.length,
  };
}
