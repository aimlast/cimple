/**
 * useAiGate — the discrepancy gate for AI writing in the CIM builder. Critical
 * discrepancies that are open or awaiting review block every AI step that
 * writes CIM content (the server enforces the same rule and answers 409).
 */
import { useQuery } from "@tanstack/react-query";
import type { Discrepancy } from "@shared/schema";

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
  if (error) return { blockedReason: "Couldn't check for discrepancies — AI writing stays off until they load.", blockingCount: 0 };
  const open = (data ?? []).filter(
    (d) => d.severity === "critical" && (d.status === "open" || d.status === "seller_responded"),
  );
  return {
    blockedReason: open.length
      ? `Resolve ${open.length} critical discrepanc${open.length === 1 ? "y" : "ies"} (Overview tab) before the AI writes CIM content.`
      : null,
    blockingCount: open.length,
  };
}
