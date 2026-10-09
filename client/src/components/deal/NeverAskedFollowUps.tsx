/**
 * Questions the broker sent to the seller's interview before follow-up
 * emails existed, on an interview that has since finished: nobody ever put
 * them to the seller (shared/discrepancy-gate.ts routedButNeverAsked). They
 * don't lock the CIM; the broker chooses — email the seller (their click,
 * never automatic; demo deals never email) or resolve it themselves.
 */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Calculator, MailQuestion, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { discrepancyFieldLabel } from "@shared/discrepancy-sides";

interface EmailResult {
  neverAsked: number;
  stamped: number;
  emailed: number;
  addressed: number;
  recentlyEmailed?: boolean;
  optedOut?: number;
}

/** "Email the seller" — the follow-up link for the never-asked questions. */
export function useEmailSellerFollowUps(dealId: string) {
  const { toast } = useToast();
  return useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/discrepancies/email-seller-followups`);
      return (await r.json()) as EmailResult;
    },
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancies"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      if (r.stamped === 0 && r.addressed === 0 && !r.recentlyEmailed) {
        toast({
          title: "Nobody to send it to",
          description: "The seller has no emailed invite of their own, so nothing reaches them. Send them their link from the Team tab, or resolve it yourself.",
          variant: "destructive",
        });
        return;
      }
      const n = r.stamped || r.neverAsked;
      toast({
        title: n === 1 ? "Sent to the seller" : `${n} questions sent to the seller`,
        description:
          (r.recentlyEmailed
            ? "They were emailed a follow-up link in the last hour — these are added to it."
            : r.emailed > 0
              ? "We emailed them a link to answer your follow-up questions."
              : "Their portal now shows your follow-up questions (nothing was emailed from here).") +
          " A critical conflict now keeps the CIM locked until they answer or you resolve it.",
      });
    },
    onError: () => toast({ title: "Couldn't email the seller", description: "Try again in a moment.", variant: "destructive" }),
  });
}

export function NeverAskedFollowUpsNotice({
  dealId,
  rows,
  onResolve,
  className = "",
}: {
  dealId: string;
  rows: Array<{ id: string; severity?: string | null; field?: string | null; factKey?: string | null; factYear?: string | null }>;
  /** Open the row in the discrepancy panel. */
  onResolve: (id: string) => void;
  className?: string;
}) {
  const email = useEmailSellerFollowUps(dealId);
  const figures = <FigureQuestionsReadyLine dealId={dealId} className={className} />;
  if (rows.length === 0) return figures;
  const names = rows.slice(0, 3).map((d) => `“${discrepancyFieldLabel(d)}”`);
  const more = rows.length > 3 ? ` and ${rows.length - 3} more` : "";
  const it = rows.length === 1 ? "it" : "them";
  // Only a critical conflict would lock the CIM once the seller is asked.
  const critical = rows.some((d) => d.severity === "critical");
  return (
    <div className={`rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 ${className}`} data-testid="never-asked-followups">
      <p className="text-xs text-foreground flex items-start gap-2">
        <MailQuestion className="h-4 w-4 shrink-0 text-amber-500 mt-0.5" aria-hidden="true" />
        <span>
          {names.join(", ")}{more} {rows.length === 1 ? "was" : "were"} sent to the seller's interview before it finished, and the
          seller was never asked.{" "}
          {critical
            ? `${rows.length === 1 ? "It doesn't" : "They don't"} lock the CIM until you email the seller — or resolve ${it} yourself.`
            : `Email the seller, or resolve ${it} yourself.`}
        </span>
      </p>
      <div className="mt-2 flex flex-wrap gap-2 pl-6">
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => email.mutate()} disabled={email.isPending} data-testid="button-email-seller-followups">
          {email.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          Email the seller
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onResolve(rows[0].id)} data-testid="button-resolve-followup-yourself">
          Resolve it yourself
        </Button>
      </div>
      <FigureQuestionsReadyLine dealId={dealId} className="mt-2 border-0 bg-transparent p-0 pl-6" />
    </div>
  );
}

/**
 * Questions about the CIM's figures that Cimple suggested and the broker
 * hasn't sent yet (stream dd): "2 questions about the figures are ready to
 * send · Review" — they go out through the same one follow-up email, from
 * Numbers & sources › Questions for the seller. Never sent on its own.
 */
export function FigureQuestionsReadyLine({ dealId, className = "" }: { dealId: string; className?: string }) {
  const [, navigate] = useLocation();
  const q = useQuery<{ counts?: { questionsSuggested: number } }>({
    queryKey: ["/api/deals", dealId, "figures", "status", "counts"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/figures/status?counts=1`, { credentials: "include" });
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    },
    staleTime: 30_000,
  });
  const n = q.data?.counts?.questionsSuggested ?? 0;
  if (n === 0) return null;
  return (
    <p className={`flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-xs ${className}`} data-testid="figure-questions-ready">
      <Calculator className="h-3.5 w-3.5 text-teal" aria-hidden="true" />
      <span>{n === 1 ? "1 question about the figures is" : `${n} questions about the figures are`} ready to send.</span>
      <button type="button" className="text-teal hover:underline" onClick={() => navigate(`/deal/${dealId}/cim?view=numbers&tab=questions`)}>Review</button>
    </p>
  );
}
