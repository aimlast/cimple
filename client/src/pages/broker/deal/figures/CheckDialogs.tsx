/**
 * CheckDialogs — the broker's decisions on one due-diligence check (spec §5.2
 * Tab 2): "Leave out…" (a reason is required; only the broker sees it) and
 * "Cimple read it wrong" (what the document actually says; the check is
 * worked out again with it).
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import type { WorkspaceCheck } from "@shared/figure-workspace";
import { FiguresError, figuresErrorText, money, useFigureActions } from "./useFigures";

export type CheckDialogState = { kind: "leave_out" | "read_wrong"; check: WorkspaceCheck } | null;

export function CheckDialogs({ dealId, state, onClose }: { dealId: string; state: CheckDialogState; onClose: () => void }) {
  const { toast } = useToast();
  const { putCheck } = useFigureActions(dealId);
  const [reason, setReason] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason("");
    setValue(state?.kind === "read_wrong" ? String(Math.round(Math.abs(state.check.other))) : "");
    setError(null);
  }, [state]);
  if (!state) return null;
  const c = state.check;
  const isLeave = state.kind === "leave_out";
  const record = c.kind === "tax_return" ? "tax return" : c.kind === "management" ? "management accounts" : "statements";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (isLeave) {
        if (!reason.trim()) { setError("Say why it's left out. Only you see this."); return; }
        await putCheck.mutateAsync({ checkKey: c.checkKey, state: "left_out", reason: reason.trim() });
        toast({ title: "Left out", description: "Due-diligence buyers won't see this comparison." });
      } else {
        const n = Number(value.replace(/[$,\s]/g, ""));
        if (!Number.isFinite(n)) { setError("Enter the figure as the document shows it, e.g. 86000."); return; }
        await putCheck.mutateAsync({ checkKey: c.checkKey, state: "corrected", correctedValue: n });
        toast({ title: "Corrected", description: "Cimple worked the check out again with your figure." });
      }
      onClose();
    } catch (err) {
      if (err instanceof FiguresError && err.status === 422) setError(err.body?.message ?? figuresErrorText(err));
      else toast({ title: "Couldn't save that", description: figuresErrorText(err), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>{isLeave ? "Leave this comparison out?" : `What does the ${record} say?`}</DialogTitle>
            <DialogDescription>
              {c.label}, FY{c.year}: this CIM {money(c.thisCim)}, {c.otherLabel.toLowerCase()} {money(c.other)}.
              {isLeave ? " Due-diligence buyers won't see it. The reason stays with you." : " Cimple compares the figure you enter instead and checks the difference again."}
            </DialogDescription>
          </DialogHeader>
          {isLeave ? (
            <div className="space-y-1.5">
              <Label htmlFor="leave-out-reason" className="text-xs">Why (only you see this)</Label>
              <Textarea id="leave-out-reason" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Prior-year adjustment filed late; the accountant's letter is in the data room" autoFocus />
            </div>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="read-wrong-value" className="text-xs">The figure in the {record}</Label>
              <Input id="read-wrong-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
            </div>
          )}
          {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={putCheck.isPending} className="bg-teal text-teal-foreground hover:bg-teal/90">
              {putCheck.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{isLeave ? "Leave it out" : "Use this figure"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
