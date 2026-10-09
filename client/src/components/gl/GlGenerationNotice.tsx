/**
 * "Add-backs in the books" before the CIM is written (gl spec §3.5
 * "Generation", D16; founder question F3/Q19 = A):
 *
 *   GlGenerationNotice kind="dd"   the DD CIM waits: "Finish 'Add-backs in the
 *                                  books' first (3 of 7 to go)" + See add-backs
 *                                  + "Go ahead without the ledger…" (a reason,
 *                                  for the broker's records)
 *   GlGenerationNotice kind="cim"  only when the hold switch is on (red)
 *   useGlGenerationConfirm         Full/Blind while unfinished: "3 of 7
 *                                  add-backs haven't been shown in the books
 *                                  yet… Write it now?"
 *   WaiveDialog                    "Go ahead without the ledger"
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { BookCheck, Loader2, OctagonAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { sendJson } from "@/lib/gl-api";
import { useGlProgress, invalidateGl } from "@/hooks/useGlStatus";
import { cn } from "@/lib/utils";

export function WaiveDialog({ dealId, open, onOpenChange }: { dealId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const waive = useMutation({
    mutationFn: () => sendJson("POST", `/api/deals/${dealId}/gl/waive`, { reason }),
    onSuccess: () => { invalidateGl(dealId); onOpenChange(false); setReason(""); toast({ title: "Going ahead without the ledger", description: "The due-diligence CIM can be written now." }); },
    onError: (e: unknown) => toast({ title: "That didn't work", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="gl-waive-dialog">
        <DialogHeader>
          <DialogTitle>Go ahead without the ledger?</DialogTitle>
          <DialogDescription>The due-diligence CIM will be written without the entries behind the add-backs.</DialogDescription>
        </DialogHeader>
        <label htmlFor="gl-waive-reason" className="text-sm">Why? <span className="text-muted-foreground">(for your records — buyers don't see this)</span></label>
        <Textarea id="gl-waive-reason" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} placeholder="e.g. The seller keeps no bookkeeping software; the add-backs are shown by bank statements." />
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button className="bg-teal text-teal-foreground hover:bg-teal/90" disabled={reason.trim().length < 3 || waive.isPending} onClick={() => waive.mutate()}>
            {waive.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Go ahead without it
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The notice on the DD version (kind "dd") or the hold switch's notice (kind "cim"). Renders nothing when there's nothing to say. */
export function GlGenerationNotice({ dealId, kind, compact = false, className }: { dealId: string; kind: "dd" | "cim"; compact?: boolean; className?: string }) {
  const { data } = useGlProgress(dealId);
  const [, navigate] = useLocation();
  const [waiving, setWaiving] = useState(false);
  const gate = data?.gate;
  if (!gate) return null;
  const books = () => navigate(`/deal/${dealId}/financials?fin=books`);
  if (gate.holdsCim) {
    return (
      <div className={cn("rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-xs space-y-2", className)} role="status" data-testid="gl-hold-notice">
        <p className="flex items-start gap-1.5 text-red-600 dark:text-red-400"><OctagonAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />You asked to hold the whole CIM until the add-backs are shown in the books ({gate.toGo} to go).</p>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={books}>See add-backs</Button>
      </div>
    );
  }
  if (kind !== "dd" || !gate.holdsDd) return null;
  return (
    <div className={cn("rounded-lg border border-teal/30 bg-teal/5 p-3 text-xs space-y-2", className)} role="status" data-testid="gl-dd-notice">
      <p className="flex items-start gap-1.5"><BookCheck className="h-3.5 w-3.5 mt-0.5 shrink-0 text-teal" />
        <span>{compact ? `Waiting for "Add-backs in the books" (${gate.toGo} of ${gate.total} to go).` : `The due-diligence CIM shows the ledger entries behind each add-back. Finish "Add-backs in the books" first (${gate.toGo} of ${gate.total} to go).`}</span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={books}>See add-backs</Button>
        <button type="button" className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline" onClick={() => setWaiving(true)} data-testid="gl-waive-link">Go ahead without the ledger…</button>
      </div>
      <WaiveDialog dealId={dealId} open={waiving} onOpenChange={setWaiving} />
    </div>
  );
}

/** The DD version's Generate is held (DD) — callers hide or disable their button. */
export function useGlDdHeld(dealId: string): boolean {
  const { data } = useGlProgress(dealId);
  return !!data?.gate?.holdsDd || !!data?.gate?.holdsCim;
}

/**
 * Full/Blind generation while the step is unfinished: confirm first (§3.5).
 * `run(start)` calls start at once when nothing is open; otherwise asks.
 */
export function useGlGenerationConfirm(dealId: string, what: "Full" | "the" = "the") {
  const { data } = useGlProgress(dealId);
  const [pending, setPending] = useState<null | (() => void)>(null);
  const [, navigate] = useLocation();
  const gate = data?.gate;
  const unfinished = !!gate && gate.holdsDd && !gate.holdsCim;
  const run = (start: () => void) => {
    if (!unfinished) return start();
    setPending(() => start);
  };
  const dialog = (
    <AlertDialog open={!!pending} onOpenChange={(o) => !o && setPending(null)}>
      <AlertDialogContent data-testid="gl-generate-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>Write the CIM now?</AlertDialogTitle>
          <AlertDialogDescription>
            {gate ? `${gate.toGo} of ${gate.total} add-backs haven't been shown in the books yet. ` : ""}
            The due-diligence CIM waits for this; {what === "Full" ? "the Full" : "the"} CIM can be written now.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => { setPending(null); navigate(`/deal/${dealId}/financials?fin=books`); }}>Go to Add-backs in the books</AlertDialogCancel>
          <AlertDialogAction onClick={() => { const fn = pending; setPending(null); fn?.(); }}>Write it now</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
  return { run, dialog, blocked: !!gate?.holdsCim };
}
