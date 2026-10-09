/**
 * ApplyLedgerAmountDialog — "Use what the ledger shows" (gl spec §3.4,
 * §6.10): before anything changes, the broker sees the add-back's old and
 * new amount, adjusted EBITDA and SDE before and after, the CIM pages that
 * show a figure that changes (they'll need regenerating and re-approving)
 * and, on a live deal, that buyers keep the current copy until the update
 * is published. Saved through the Normalization tab's own code.
 */
import { useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { sendJson } from "@/lib/gl-api";
import { invalidateGl } from "@/hooks/useGlStatus";

interface Impact {
  addback: { label: string; year: string; from: number; to: number };
  adjustedEbitda: { from: number | null; to: number | null };
  sde: { from: number | null; to: number | null };
  sections: Array<{ id: string; title: string }>;
  liveBuyersKeepCopy: boolean;
}

const usd = (n: number | null) => (n === null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);

export function ApplyLedgerAmountDialog({ dealId, traceId, year, open, onOpenChange }: { dealId: string; traceId: string; year: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const url = `/api/deals/${dealId}/gl/traces/${traceId}/apply-ledger-amount`;
  const dry = useMutation({ mutationFn: () => sendJson<Impact>("POST", `${url}?dryRun=1`, { fy: year }) });
  const apply = useMutation({
    mutationFn: () => sendJson<Impact>("POST", url, { fy: year }),
    onSuccess: () => {
      invalidateGl(dealId);
      void queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "financial-analysis"] });
      onOpenChange(false);
      toast({ title: "Add-back changed", description: "The pages that show it are marked for regenerating." });
    },
    onError: (e: unknown) => toast({ title: "That didn't work", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  useEffect(() => { if (open) dry.mutate(); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const i = dry.data;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent data-testid="gl-apply-amount-dialog">
        <AlertDialogHeader>
          <AlertDialogTitle>Change the {year} add-back to what the ledger shows?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              {dry.isPending ? <p className="flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Working out what changes…</p>
                : dry.error ? <p className="text-red-600 dark:text-red-400">{(dry.error as Error).message}</p>
                : i ? (
                  <>
                    <p>{i.addback.label} {i.addback.year}: {usd(i.addback.from)} → <strong className="text-foreground">{usd(i.addback.to)}</strong>.</p>
                    {i.adjustedEbitda.from !== null && <p>Adjusted EBITDA {i.addback.year}: {usd(i.adjustedEbitda.from)} → {usd(i.adjustedEbitda.to)}.</p>}
                    {i.sde.from !== null && <p>SDE {i.addback.year}: {usd(i.sde.from)} → {usd(i.sde.to)}.</p>}
                    {i.sections.length > 0
                      ? <p>These CIM pages show a figure that changes and will need regenerating and re-approving: <em>{i.sections.map((s) => s.title).join(", ")}</em>.</p>
                      : <p>No CIM page shows these figures yet.</p>}
                    {i.liveBuyersKeepCopy && <p>Buyers with access keep the current copy until you publish the update.</p>}
                  </>
                ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={!i || apply.isPending} onClick={(e) => { e.preventDefault(); apply.mutate(); }}>
            {apply.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Change it
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
