/**
 * StatusPill — whether due-diligence buyers see the figure checks, and the
 * one primary action (spec §5.2): "Review and show to buyers", or "Turn off"
 * (with a confirmation). Full width on a phone.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { shortDate } from "./useFigures";

export function StatusPill({ ddShownAt, ddBuyers, onReview, onTurnOff, busy, toReview = 1 }: { ddShownAt: string | null; ddBuyers: number; onReview: () => void; onTurnOff: () => void; busy?: boolean; /** Notes waiting + differences not shown yet (0 = nothing new to show). */ toReview?: number }) {
  const [confirm, setConfirm] = useState(false);
  const on = !!ddShownAt;
  const words = on
    ? `Due-diligence buyers: seeing the checks since ${shortDate(ddShownAt)}`
    : ddBuyers === 0 ? "No due-diligence buyers yet · the checks are off" : "Due-diligence buyers: not seeing the checks yet";
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-testid="figures-status-pill">
      <p className="flex items-center gap-2 text-sm">
        <span className={cn("h-2 w-2 shrink-0 rounded-full", on ? "bg-success" : "bg-muted-foreground/60")} aria-hidden="true" />
        {words}
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        {/* The primary action only while there is something to show; once the checks are on and nothing waits, a quiet "Review". */}
        {on && toReview === 0
          ? <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={onReview} data-testid="button-review-and-show">Review</Button>
          : <Button size="sm" className="w-full bg-teal text-teal-foreground hover:bg-teal/90 sm:w-auto" onClick={onReview} data-testid="button-review-and-show">Review and show to buyers</Button>}
        {on && <Button size="sm" variant="outline" className="w-full sm:w-auto" onClick={() => setConfirm(true)} disabled={busy}>Turn off</Button>}
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Turn the checks off for due-diligence buyers?</AlertDialogTitle>
            <AlertDialogDescription>They stop seeing the side-by-side figures, the colours and the “How the figures check out” page straight away. Notes you approved keep showing. Your decisions are kept for when you turn the checks back on.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep them on</AlertDialogCancel>
            <AlertDialogAction onClick={() => { setConfirm(false); onTurnOff(); }}>Turn off</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
