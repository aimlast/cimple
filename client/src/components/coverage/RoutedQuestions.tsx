/**
 * "Open questions": conflicts the broker sent to the seller that no
 * checklist item shows (each with Resolve…). Questions about the numbers
 * (dd) are ordinary "Numbers" items and render above this list.
 */
import { MessageCircleQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { RoutedQuestion } from "@shared/coverage-board";

export function RoutedQuestions({ routed, onResolve }: { routed: RoutedQuestion[]; onResolve: (discrepancyId: string) => void }) {
  if (routed.length === 0) return null;
  return (
    <div data-testid="routed-questions">
      <p className="px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Sent to the seller</p>
      <ul className="divide-y divide-border/60">
        {routed.map((q) => (
          <li key={q.discrepancyId} className="flex items-start gap-3 px-3 py-3">
            <MessageCircleQuestion className="h-4 w-4 mt-0.5 cov-text-verify shrink-0" aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{q.label}</p>
              <p className="text-xs text-muted-foreground">Ask: “{q.ask}”</p>
              {q.raisedInSitting && <p className="text-[11px] text-muted-foreground">Raised in this session.</p>}
            </div>
            <Button size="sm" variant="outline" className="h-7 px-2.5 text-xs border-teal/40 text-teal hover:bg-teal/10 hover:text-teal" onClick={() => onResolve(q.discrepancyId)}>
              Resolve…
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
