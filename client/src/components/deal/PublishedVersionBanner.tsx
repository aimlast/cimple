/**
 * Shown on a live deal whose CIM was regenerated: buyers keep reading the
 * version last published (server/cim/published-snapshot.ts) until the
 * broker reviews the new one and publishes the update.
 */
import { Eye } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { reviewingUpdate } from "@shared/cim-generation-warnings";

export function PublishedVersionBanner({ deal }: { deal: { id: string; isLive?: boolean | null; cimGeneration?: unknown } }) {
  const [, navigate] = useLocation();
  const update = reviewingUpdate(deal);
  if (!update) return null;
  const since = update.since ? new Date(update.since) : null;
  const when = since && !Number.isNaN(since.getTime())
    ? since.toLocaleDateString("en-US", { month: "long", day: "numeric" })
    : null;
  const who = update.buyers > 0 ? `${update.buyers} buyer${update.buyers === 1 ? "" : "s"}` : "Buyers";
  return (
    <div
      className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
      data-testid="published-version-banner"
      role="status"
    >
      <div className="flex items-start gap-3 min-w-0">
        <Eye className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
        <div className="min-w-0">
          <p className="text-sm font-medium">Buyers are seeing the previous version — review and publish the update</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            The CIM was regenerated{when ? ` on ${when}` : ""}. {who} still see the version you published, Blind and due-diligence
            versions included. The new one reaches them only when you approve it and publish the update.
            {update.ddCleared ? " Generate its due-diligence version before you publish." : ""}
          </p>
        </div>
      </div>
      <Button size="sm" variant="outline" className="h-8 text-xs shrink-0 self-start sm:self-center" onClick={() => navigate(`/deal/${deal.id}/design`)}>
        Review the new version
      </Button>
    </div>
  );
}
