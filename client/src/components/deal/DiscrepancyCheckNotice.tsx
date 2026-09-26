/**
 * Next to Generate: says when the documents haven't been checked against
 * what the seller said since sources changed. Generating runs the check
 * first anyway (and stops at the gate on a critical conflict); "Run now"
 * lets the broker see the result before starting.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Search } from "lucide-react";

export interface DiscrepancyCheckStatus {
  canRun: boolean;
  checkedAt: string | null;
  stale: boolean;
  newSources: number;
  claimsChanged: boolean;
}

export const discrepancyCheckStatusKey = (dealId: string) => ["/api/deals", dealId, "discrepancy-check-status"] as const;

export function checkNoticeText(s: DiscrepancyCheckStatus | null | undefined): string | null {
  if (!s || !s.canRun || !s.stale) return null;
  if (!s.checkedAt) return "The documents haven't been checked against what the seller said yet. Generating runs the check first.";
  const parts: string[] = [];
  if (s.newSources > 0) parts.push(`${s.newSources} new source${s.newSources === 1 ? "" : "s"}`);
  if (s.claimsChanged) parts.push("new answers from the seller");
  return `Discrepancy check not run since ${parts.join(" and ") || "the sources changed"}. Generating runs it first.`;
}

export function DiscrepancyCheckNotice({ dealId, className = "" }: { dealId: string; className?: string }) {
  const { toast } = useToast();
  const { data } = useQuery<DiscrepancyCheckStatus | null>({
    queryKey: discrepancyCheckStatusKey(dealId),
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/discrepancy-check-status`, { credentials: "include" });
      if (!r.ok) return null;
      return r.json();
    },
  });
  const run = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/run-discrepancy-check`);
      return r.json() as Promise<{ count: number }>;
    },
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: discrepancyCheckStatusKey(dealId) });
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancies"] });
      toast({
        title: res.count > 0 ? `${res.count} new discrepanc${res.count === 1 ? "y" : "ies"} found` : "No new discrepancies",
        description: res.count > 0 ? "Review them before generating the CIM." : "What the seller said matches the documents.",
      });
    },
    onError: (e: Error) => toast({ title: "Check failed", description: e.message, variant: "destructive" }),
  });
  const text = checkNoticeText(data);
  if (!text) return null;
  return (
    <div className={`flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-xs text-muted-foreground ${className}`} data-testid="discrepancy-check-notice">
      <Search className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{text}</span>
      <Button
        variant="ghost"
        size="sm"
        className="h-auto px-1 py-0 text-xs text-teal underline-offset-2 hover:underline hover:bg-transparent"
        onClick={() => run.mutate()}
        disabled={run.isPending}
        data-testid="button-run-discrepancy-check"
      >
        {run.isPending ? <><Loader2 className="h-3 w-3 animate-spin mr-1" /> Checking…</> : "Run now"}
      </Button>
    </div>
  );
}
