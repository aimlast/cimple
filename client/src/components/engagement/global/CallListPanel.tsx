/**
 * "Who to call today, across your deals" — the merged call list of the
 * broker's own non-archived deals (top 15), for /broker/analytics. Each row:
 * the buyer, the deal, the status in words, why, and the first thing to say;
 * clicking opens that deal's Engagement tab.
 *
 * Owned by the INTELLIGENCE stream; the VIEWER stream places it on the
 * reworked Analytics page.
 */
import { useLocation } from "wouter";
import { useCallList } from "@/hooks/useEngagement";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpRight, MessageSquare } from "lucide-react";
import { StatusChip, agoText } from "../buyers/parts";

export function CallListPanel() {
  const { data, isLoading, error } = useCallList();
  const [, setLocation] = useLocation();
  if (isLoading) return <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}</div>;
  if (error) return <p className="text-sm text-muted-foreground">Couldn't load who to call.</p>;
  if (!data || data.entries.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground" data-testid="call-list-empty">
        When buyers read your CIMs, the ones to call first show here — with why, and what to say.
      </p>
    );
  }
  return (
    <ol className="space-y-2" data-testid="call-list">
      {data.entries.map((e, i) => (
        <li key={`${e.dealId}:${e.accessId}`}>
          <button
            type="button"
            onClick={() => setLocation(`/deal/${e.dealId}/engagement`)}
            className="group flex w-full items-start gap-3 rounded-lg border border-border bg-card px-3.5 py-3 text-left transition-colors hover:border-teal/40"
          >
            <span className="mt-0.5 w-4 shrink-0 font-mono text-xs text-teal tabular-nums">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-foreground">{e.name}</span>
                {e.company && <span className="text-xs text-muted-foreground">{e.company}</span>}
                <StatusChip status={e.status} label={e.statusLabel} />
                <span className="ml-auto hidden text-2xs text-muted-foreground sm:inline">{agoText(e.lastSeenAt)}</span>
              </span>
              <span className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
                <span className="truncate">{e.dealName}</span>
                <ArrowUpRight className="h-3 w-3 shrink-0 opacity-50 group-hover:opacity-100" />
              </span>
              <span className="mt-1.5 block text-xs leading-relaxed text-foreground/85">{e.why}</span>
              {e.talkingPoints[0] && (
                <span className="mt-1.5 flex items-start gap-1.5 text-xs text-muted-foreground">
                  <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-teal" />
                  <span>{e.talkingPoints[0].text}</span>
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
