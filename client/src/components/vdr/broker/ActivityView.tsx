/**
 * Activity (vdr spec §5.9), segmented: By buyer · By document
 * (?activity=buyers|documents). Who opened what, for how long; each
 * document's readers are in its drawer (Activity tab).
 */
import { cn } from "@/lib/utils";
import type { BrokerRoomPayload } from "@shared/vdr-api";
import { durationLabel, shortDate, useRoomBuyers } from "@/hooks/useDataRoom";
import { Skeleton } from "@/components/ui/skeleton";

export type ActivitySegment = "buyers" | "documents";

export function ActivityView({ dealId, data, segment, onSegment, onOpenItem, onViewAs }: { dealId: string; data: BrokerRoomPayload; segment: ActivitySegment; onSegment: (s: ActivitySegment) => void; onOpenItem: (id: string) => void; onViewAs: (accessId: string) => void }) {
  const { data: buyers, isLoading } = useRoomBuyers(dealId);
  const opened = data.items.filter((i) => !i.removed && i.opened.buyers > 0).sort((a, b) => b.opened.activeMs - a.opened.activeMs);
  return (
    <div className="space-y-4">
      <div className="inline-flex rounded-md border border-border p-0.5 text-xs" role="tablist" aria-label="Activity">
        {(["buyers", "documents"] as ActivitySegment[]).map((s) => (
          <button key={s} role="tab" aria-selected={segment === s} onClick={() => onSegment(s)} className={cn("rounded-[5px] px-3 py-1.5", segment === s ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground")}>
            {s === "buyers" ? "By buyer" : "By document"}
          </button>
        ))}
      </div>
      {segment === "buyers" ? (
        isLoading ? <Skeleton className="h-32 w-full" /> : !buyers || buyers.eligible.filter((b) => b.hasRoom).length === 0 ? (
          <Empty />
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="activity-buyers">
            {buyers.eligible.filter((b) => b.hasRoom).map((b) => (
              <button key={b.key} onClick={() => onViewAs(b.accessId)} className="flex w-full flex-col gap-0.5 border-b border-border px-4 py-3 text-left last:border-0 hover:bg-muted/30 sm:flex-row sm:items-center sm:gap-4">
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{b.company || b.name || b.email}</span>
                <span className="text-xs text-muted-foreground">can see {b.canSee} {b.canSee === 1 ? "document" : "documents"}{b.newCount ? ` · ${b.newCount} new for them` : ""}</span>
                <span className="text-xs text-muted-foreground">{b.lastOpenedAt ? `last opened one ${shortDate(b.lastOpenedAt)}` : "hasn't opened one yet"}</span>
              </button>
            ))}
          </div>
        )
      ) : opened.length === 0 ? (
        <Empty />
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card" data-testid="activity-documents">
          {opened.map((i) => (
            <button key={i.id} onClick={() => onOpenItem(i.id)} className="flex w-full flex-col gap-0.5 border-b border-border px-4 py-3 text-left last:border-0 hover:bg-muted/30 sm:flex-row sm:items-center sm:gap-4">
              <span className="min-w-0 flex-1 truncate text-sm"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{i.number}</span>{i.title}</span>
              <span className="text-xs text-muted-foreground">opened by {i.opened.buyers} {i.opened.buyers === 1 ? "buyer" : "buyers"} · {durationLabel(i.opened.activeMs)} in total</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty() {
  return <p className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground" data-testid="activity-empty">Nothing yet. Activity appears here as soon as a buyer opens the data room.</p>;
}
