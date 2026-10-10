/**
 * FixFirst — broker-only warnings that keep checks away from buyers (spec
 * D9a, D11): a CIM figure that disagrees with its statements, and a figure
 * Cimple couldn't find in its document. One line, expanding in place (never
 * a stacked section of its own); a banner on a phone.
 */
import { useState } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FixFirstItem } from "@shared/figure-workspace";

export function FixFirst({ items, dealId, onCorrect, onNavigate, open: openProp, onOpenChange }: {
  items: FixFirstItem[]; dealId: string; onCorrect: (checkKey: string) => void; onNavigate: (to: string) => void;
  /** Controlled (a held row's "Fix FY2022 first" opens it); omitted = toggles itself. */
  open?: boolean; onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (next: boolean | ((o: boolean) => boolean)) => {
    const v = typeof next === "function" ? next(open) : next;
    if (openProp === undefined) setOpenState(v);
    onOpenChange?.(v);
  };
  if (items.length === 0) return null;
  const mismatch = items.filter((i) => i.kind === "mismatch");
  const head = mismatch.length > 0
    ? `Your CIM's ${mismatch.map((m) => `FY${m.year}`).join(" and ")} figures don't match the statements.`
    : `Cimple couldn't find ${items.length === 1 ? "a figure" : `${items.length} figures`} in ${items.length === 1 ? "its document" : "their documents"}.`;
  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 text-sm" data-testid="figures-fix-first">
      <button type="button" className="flex w-full items-start gap-2 px-3 py-2 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
        <span className="flex-1"><span className="font-medium">Fix first ({items.length})</span> — {head}</span>
        <span className="hidden shrink-0 items-center gap-1 text-xs text-muted-foreground sm:inline-flex">{open ? "Hide" : "Show"}<ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? "rotate-180" : ""}`} /></span>
      </button>
      {open && (
        <ul className="space-y-3 border-t border-amber-500/20 px-3 py-3">
          {items.map((i) => (
            <li key={i.id} className="space-y-1.5 text-xs">
              <p className="text-foreground">{i.message}</p>
              <div className="flex flex-wrap gap-1.5">
                {i.kind === "mismatch" ? (
                  <>
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onNavigate(`/deal/${dealId}/financials`)}>Open the Financials tab</Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onNavigate(`/deal/${dealId}/design`)}>Open the CIM builder</Button>
                  </>
                ) : (
                  <>
                    {i.documentHref && <Button size="sm" variant="outline" className="h-7 text-xs" asChild><a href={i.documentHref} target="_blank" rel="noreferrer">Open document</a></Button>}
                    {i.checkKey && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onCorrect(i.checkKey!)}>Correct it</Button>}
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
