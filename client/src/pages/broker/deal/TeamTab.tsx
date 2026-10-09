/**
 * TeamTab — the deal team, the seller's profile, and the latest buyer
 * activity (every visit included; the full feed is on the Engagement tab).
 */
import { useDeal } from "@/contexts/DealContext";
import { TeamPanel } from "@/components/deal/TeamPanel";
import { SellerProfilePanel } from "@/components/deal/SellerProfilePanel";
import { ActivityFeed } from "@/components/analytics/ActivityFeed";

export function TeamTab() {
  const { dealId } = useDeal();

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <SellerProfilePanel dealId={dealId} />

      <div className="pt-2 border-t border-border">
        <TeamPanel dealId={dealId} />
      </div>

      <section className="pt-4 border-t border-border space-y-3" data-testid="team-activity">
        <div>
          <h2 className="text-sm font-semibold">Buyer activity</h2>
          <p className="text-xs text-muted-foreground">The latest from buyers on this deal, newest first.</p>
        </div>
        <ActivityFeed scope="deal" dealId={dealId} limit={10} compact />
      </section>
    </div>
  );
}
