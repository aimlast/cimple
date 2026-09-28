/**
 * Buyer pulse — the deal Overview's engagement card (replaces
 * DealAnalyticsWidget): the pulse sentence, the top 3 buyers to call with
 * their one-line why, "Most studied page: <real title>", and a link to the
 * Engagement tab.
 *
 * Owned by the INTELLIGENCE stream (it also swaps it into OverviewTab).
 * Base stub: the sentence and the link.
 */
import { useLocation } from "wouter";
import { useEngagementSummary } from "@/hooks/useEngagement";

export function BuyerPulseCard({ dealId }: { dealId: string }) {
  const { data } = useEngagementSummary(dealId);
  const [, setLocation] = useLocation();
  if (!data) return null;
  return (
    <div className="rounded-lg border border-border bg-card p-4" data-testid="buyer-pulse">
      <p className="text-sm">{data.pulse.sentence}</p>
      <button className="mt-2 text-xs text-teal hover:underline" onClick={() => setLocation(`/deal/${dealId}/engagement`)}>
        See buyer engagement
      </button>
    </div>
  );
}
