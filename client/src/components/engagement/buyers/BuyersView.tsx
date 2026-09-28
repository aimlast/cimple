/**
 * Buyers view — "who to call today": one card per buyer, best lead first
 * (status in words, the one-line why, the page strip, up to three talking
 * points with their evidence; See where they read / Their visits / Email /
 * Mark contacted), then "Not opened yet".
 *
 * Owned by the INTELLIGENCE stream. Base stub: lists the buyers the API
 * returns so the tab works end to end.
 */
import { formatReadingTime } from "@shared/analytics-v2";
import { useEngagementBuyers } from "@/hooks/useEngagement";
import { Skeleton } from "@/components/ui/skeleton";
import type { EngagementViewProps } from "../types";

export function BuyersView({ dealId, filters, nav }: EngagementViewProps) {
  const { data, isLoading, error } = useEngagementBuyers(dealId, filters);
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error || !data) return <p className="text-sm text-muted-foreground">Couldn't load buyers.</p>;
  return (
    <div className="space-y-3" data-testid="engagement-buyers">
      {data.buyers.map((b) => (
        <div key={b.accessId} className="rounded-lg border border-border bg-card p-4">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold">{b.name}</span>
            {b.company && <span className="text-xs text-muted-foreground">{b.company}</span>}
            <span className="text-2xs rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{b.statusLabel}</span>
            <span className="ml-auto text-xs text-muted-foreground">{formatReadingTime(b.activeMs)} reading</span>
          </div>
          {b.why && <p className="mt-1 text-xs text-muted-foreground">{b.why}</p>}
          <button className="mt-2 text-xs text-teal hover:underline" onClick={() => nav.openDocument({ accessId: b.accessId })}>
            See where they read
          </button>
        </div>
      ))}
      {data.notOpened.length > 0 && (
        <p className="text-xs text-muted-foreground">Not opened yet ({data.notOpened.length})</p>
      )}
    </div>
  );
}
