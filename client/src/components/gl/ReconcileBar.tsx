/**
 * ReconcileBar — the seller's live total for one cost and year (gl spec
 * §3.3 C): "Ticked $27,840 of $28,000" + a bar + the words ("Adds up",
 * "Close — $160 short", "$14,000 short", "$3,200 more than the cost"), and
 * always: "It doesn't need to add up exactly…". Sticky on the page; read
 * out politely to screen readers.
 */
import { reconcileWords } from "@shared/gl-reconcile";
import { cn } from "@/lib/utils";
import { dollars } from "./gl-ui";

export function ReconcileBar({ tickedCents, targetCents, claimedCents, sharePct, label, payroll, year, documentCents = 0 }: {
  tickedCents: number;
  targetCents: number;
  claimedCents: number;
  sharePct?: number | null;
  label: string;
  payroll?: boolean;
  year: string;
  documentCents?: number;
}) {
  const got = Math.abs(tickedCents) + documentCents;
  const r = reconcileWords(got, targetCents);
  const pct = targetCents ? Math.min(100, Math.round((got / Math.abs(targetCents)) * 100)) : 0;
  const tone = r.status === "found" ? "bg-success" : r.status === "close" ? "bg-teal" : "bg-amber-500";
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  // Entries are ticked; a document (a T4) shows the amount.
  const verb = documentCents > 0 && tickedCents === 0 ? "Shown" : documentCents > 0 ? "Ticked and shown" : "Ticked";
  const lead = payroll
    ? <>{verb} <strong>{dollars(got)}</strong> of your <strong>{dollars(targetCents)}</strong> pay for {year}.</>
    : sharePct
      ? <>{verb} <strong>{dollars(got)}</strong> of your <strong>{dollars(targetCents)}</strong> {lower} (your broker counts {sharePct === 50 ? "half" : `${sharePct}%`} of it — {dollars(claimedCents)} — as personal).</>
      : <>{verb} <strong>{dollars(got)}</strong> of <strong>{dollars(targetCents)}</strong>.</>;
  return (
    <div className="sticky top-0 z-10 -mx-4 px-4 sm:mx-0 sm:px-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 py-3 border-b border-border" data-testid="reconcile-bar">
      <div aria-live="polite" className="space-y-1.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <p className="text-sm">{lead}</p>
          <span className={cn("text-sm font-medium", r.status === "found" ? "text-success" : r.status === "close" ? "text-teal" : "text-amber-600 dark:text-amber-400")} data-testid="reconcile-words">{got === 0 ? "Nothing ticked yet" : r.words}</span>
        </div>
        <div className="h-2 rounded-full bg-muted overflow-hidden"><div className={cn("h-full rounded-full transition-all", tone)} style={{ width: `${pct}%` }} /></div>
        <p className="text-xs text-muted-foreground">It doesn't need to add up exactly — tick only entries that really are this cost. Your broker will adjust the figure if needed.</p>
      </div>
    </div>
  );
}
