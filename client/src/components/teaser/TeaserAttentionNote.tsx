/**
 * TeaserAttentionNote — one line on the deal Overview (directly under the
 * published-version banner, INTEGRATION §2.10), shown only when there's
 * something to say:
 *   "Your teaser's Highlights block is hidden from buyers — it names “Surrey” (the town). [Fix it]"
 *   "2 buyers read the teaser but didn't ask for the CIM. [See who]"
 */
import { useLocation } from "wouter";
import { PhoneCall, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useTeaserSummary } from "./useTeaserSummary";

export function TeaserAttentionNote({ dealId }: { dealId: string }) {
  const [, navigate] = useLocation();
  const { data } = useTeaserSummary(dealId);
  if (!data) return null;
  const held = data.heldBlocks[0];
  if (held) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/5 px-3.5 py-2.5 text-sm" data-testid="teaser-attention-note">
        <ShieldAlert className="h-4 w-4 shrink-0 text-red-400" />
        <p className="min-w-0 flex-1">
          Your teaser's {held.title} block is hidden from buyers — {held.reason}.
          {data.heldBlocks.length > 1 ? ` (${data.heldBlocks.length - 1} more)` : ""}
        </p>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate(`/deal/${dealId}/teaser?block=${held.blockId}`)}>Fix it</Button>
      </div>
    );
  }
  const n = data.counts.worthACall;
  if (n > 0) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-teal/30 bg-teal/5 px-3.5 py-2.5 text-sm" data-testid="teaser-attention-note">
        <PhoneCall className="h-4 w-4 shrink-0 text-teal" />
        <p className="min-w-0 flex-1">{n === 1 ? "1 buyer read" : `${n} buyers read`} the teaser but didn't ask for the CIM.</p>
        <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => navigate(`/deal/${dealId}/buyers?stage=teaser`)}>See who</Button>
      </div>
    );
  }
  return null;
}
