/**
 * TeamTab — Team management, seller profile, activity timeline.
 */
import { useDeal } from "@/contexts/DealContext";
import { TeamPanel } from "@/components/deal/TeamPanel";
import { SellerProfilePanel } from "@/components/deal/SellerProfilePanel";
import { ActivityTimeline } from "@/components/deal/ActivityTimeline";

export function TeamTab() {
  const { dealId } = useDeal();

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <SellerProfilePanel dealId={dealId} />

      <div className="pt-2 border-t border-border">
        <TeamPanel dealId={dealId} />
      </div>

      <div className="pt-2 border-t border-border">
        <ActivityTimeline dealId={dealId} />
      </div>
    </div>
  );
}
