/**
 * To do (vdr spec §5.8), segmented: Waiting on you · Buyer requests · Seller
 * checklist (?todo=waiting|requests|checklist). Every waiting item has its
 * own one-click action. The seller checklist card moved here from the
 * Overview, unchanged, with the data-room column.
 */
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, FileClock, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { BrokerRoomPayload, RoomBuyerRow } from "@shared/vdr-api";
import { invalidateRoom, useRoomBuyers, vdrFetch } from "@/hooks/useDataRoom";
import { SellerChecklistCard } from "@/components/deal/SellerChecklistCard";
import { flagLabel } from "./parts";
import { useRoomActions } from "./actions";

export type TodoSegment = "waiting" | "requests" | "checklist";

export function TodoView({ dealId, data, segment, onSegment, onOpenItem }: { dealId: string; data: BrokerRoomPayload; segment: TodoSegment; onSegment: (s: TodoSegment) => void; onOpenItem: (id: string) => void }) {
  return (
    <div className="space-y-4">
      <div className="flex max-w-full overflow-x-auto rounded-md border border-border p-0.5 text-xs sm:inline-flex" role="tablist" aria-label="To do">
        {(["waiting", "requests", "checklist"] as TodoSegment[]).map((s) => (
          <button key={s} role="tab" aria-selected={segment === s} onClick={() => onSegment(s)} className={cn("shrink-0 rounded-[5px] px-3 py-1.5", segment === s ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground")}>
            {s === "waiting" ? `Waiting on you (${data.kpis.waiting})` : s === "requests" ? "Buyer requests" : `Seller checklist${data.kpis.missingRequired ? ` (${data.kpis.missingRequired} missing)` : ""}`}
          </button>
        ))}
      </div>
      {segment === "waiting" && <Waiting dealId={dealId} data={data} onOpenItem={onOpenItem} />}
      {segment === "requests" && (
        <p className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground" data-testid="todo-requests-empty">No requests. Buyers can ask for a document from their data room.</p>
      )}
      {segment === "checklist" && <SellerChecklistCard dealId={dealId} variant="room" roomItems={data.items} onOpenItem={onOpenItem} />}
    </div>
  );
}

function Waiting({ dealId, data, onOpenItem }: { dealId: string; data: BrokerRoomPayload; onOpenItem: (id: string) => void }) {
  const actions = useRoomActions(dealId);
  const { data: buyers } = useRoomBuyers(dealId);
  const { toast } = useToast();
  const extend = useMutation({
    mutationFn: async (b: RoomBuyerRow) => {
      const from = Math.max(Date.now(), b.expiresAt ? new Date(b.expiresAt).getTime() : 0);
      return vdrFetch("PATCH", `/api/buyers/${b.accessId}`, { expiresAt: new Date(from + 30 * 86_400_000).toISOString() });
    },
    onSuccess: () => { invalidateRoom(dealId); toast({ title: "Link extended by 30 days" }); },
    onError: (e: Error) => toast({ title: "Couldn't extend the link", description: e.message, variant: "destructive" }),
  });
  const live = data.items.filter((i) => !i.removed);
  const flagged = live.filter((i) => i.unchecked.length > 0);
  const versions = live.filter((i) => i.newVersion?.oldWasShared);
  const ending = (buyers?.eligible ?? []).filter((b) => b.hasRoom && b.endsInDays != null && b.endsInDays <= 5);
  const rows: React.ReactNode[] = [];
  for (const i of versions) {
    rows.push(
      <Row key={`v${i.id}`} icon={<FileClock className="h-4 w-4 text-teal" />} text={`New version from the seller: '${i.title}'. The old one was shared.`}>
        <Button size="sm" onClick={() => actions.shareLikeReplaced(i.id)}>Share with the same people</Button>
      </Row>,
    );
  }
  for (const i of flagged) {
    const words = i.flags.filter((f) => i.unchecked.includes(f.key)).map((f) => flagLabel(f.key).toLowerCase()).join(", ");
    rows.push(
      <Row key={`f${i.id}`} icon={i.sharing.shared ? <ShieldAlert className="h-4 w-4 text-teal" /> : <AlertTriangle className="h-4 w-4 text-teal" />} text={`${i.number ?? ""} ${i.title}: ${words}${i.sharing.shared ? ". Shared, but held back from buyers until you check it." : ""}`}>
        <Button size="sm" variant="outline" onClick={() => onOpenItem(i.id)}>Open</Button>
        <Button size="sm" variant="ghost" onClick={() => actions.check(i.id, i.unchecked)}>I've checked it</Button>
      </Row>,
    );
  }
  for (const b of ending) {
    rows.push(
      <Row key={`e${b.accessId}`} icon={<CalendarClock className="h-4 w-4 text-teal" />} text={`${b.company || b.name || b.email}'s access ends ${b.endsInDays === 0 ? "today" : `in ${b.endsInDays} ${b.endsInDays === 1 ? "day" : "days"}`}.`}>
        <Button size="sm" variant="outline" onClick={() => extend.mutate(b)} disabled={extend.isPending}>Extend 30 days</Button>
      </Row>,
    );
  }
  if (rows.length === 0) return <p className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground" data-testid="todo-waiting-empty">Nothing is waiting on you.</p>;
  return <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="todo-waiting">{rows}</div>;
}

function Row({ icon, text, children }: { icon: React.ReactNode; text: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 py-3 last:border-0 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-start gap-2.5">{icon}<p className="text-sm">{text}</p></div>
      <div className="flex shrink-0 gap-2 pl-6 sm:pl-0">{children}</div>
    </div>
  );
}
