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

/** "86,000", "$86000", "(86,000)", "-86,000", "−86,000" → a number (parentheses and minus = negative); null when it isn't one. */
export function parseTypedFigure(input: string): number | null {
  const t = String(input ?? "").trim();
  if (!t) return null;
  const negative = /^\(.*\)$/.test(t) || /^[-−–]/.test(t);
  const digits = t.replace(/[()$,\s−–-]/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(digits)) return null;
  const n = Number(digits);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/** Expense lines compare as amounts (no sign). */
function isExpenseCheck(c: WorkspaceCheck): boolean {
  return !c.signed;
}

export function CheckDialogs({ dealId, state, onClose }: { dealId: string; state: CheckDialogState; onClose: () => void }) {
  const { toast } = useToast();
  const { putCheck } = useFigureActions(dealId);
  const [reason, setReason] = useState("");
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason("");
    // An expense as an amount; a loss keeps its minus sign (checker r2 R2-7: signs matter for profits).
    setValue(state?.kind === "read_wrong" ? String(Math.round(state.check.other < 0 && !isExpenseCheck(state.check) ? state.check.other : Math.abs(state.check.other))) : "");
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
        const n = parseTypedFigure(value);
        if (n === null) { setError("Enter the figure as the document shows it, e.g. 86000 (a loss as -86000 or (86,000))."); return; }
        await putCheck.mutateAsync({ checkKey: c.checkKey, state: "corrected", correctedValue: n });
        toast({ title: "Corrected", description: "Cimple looks for your figure on that line of the document. Buyers see it only once you show it." });
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
              {isLeave ? " Due-diligence buyers won't see it. The reason stays with you." : " Cimple compares the figure you enter instead, looks for it in the document and checks the difference again. Buyers don't see a difference until you show it."}
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
