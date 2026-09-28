/**
 * Journey drawer — one buyer's visits (date, device, reading time, pages
 * reached), the path strip of the selected visit (segments per page, width
 * = time; clicking one opens that page in the Document view filtered to
 * this buyer) and the key moments. Right-side sheet on desktop, full-screen
 * on phones.
 *
 * Owned by the VIEWER stream. Base stub: the visit list.
 */
import { formatReadingTime } from "@shared/analytics-v2";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useBuyerJourney } from "@/hooks/useEngagement";

export function JourneyDrawer({ dealId, accessId, onClose }: { dealId: string; accessId: string | null; onClose(): void }) {
  const { data } = useBuyerJourney(dealId, accessId);
  return (
    <Sheet open={!!accessId} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{data?.name ?? "Visits"}</SheetTitle>
        </SheetHeader>
        <ul className="mt-4 space-y-2 text-sm">
          {(data?.visits ?? []).map((v) => (
            <li key={v.id} className="flex justify-between">
              <span>{new Date(v.startedAt).toLocaleString()}</span>
              <span className="text-muted-foreground">{formatReadingTime(v.activeMs)}</span>
            </li>
          ))}
          {data && data.visits.length === 0 && <li className="text-muted-foreground">No visits recorded yet.</li>}
        </ul>
      </SheetContent>
    </Sheet>
  );
}
