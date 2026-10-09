/**
 * The data room's activity for other screens (vdr spec §10, §11.4): the
 * analytics stream mounts it as the Engagement tab's "Data room" view
 * (`variant="engagement"`). By buyer · By document, with links into the
 * deal's Data room tab. Nothing here is recorded or sent.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { cn } from "@/lib/utils";
import { ByBuyer, ByDocument } from "./broker/ActivityView";

export function DataRoomActivity({ dealId, variant = "engagement" }: { dealId: string; variant?: "engagement" }) {
  const [, setLocation] = useLocation();
  const [view, setView] = useState<"buyers" | "documents">("buyers");
  const room = (q: string) => setLocation(`/deal/${dealId}/data-room?${q}`);
  return (
    <div className={cn("space-y-3", variant === "engagement" && "text-sm")} data-testid="data-room-activity">
      <div className="inline-flex rounded-md border border-border p-0.5 text-xs" role="tablist" aria-label="Data room activity">
        {(["buyers", "documents"] as const).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} onClick={() => setView(v)} className={cn("rounded-[5px] px-3 py-1.5", view === v ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground")}>
            {v === "buyers" ? "By buyer" : "By document"}
          </button>
        ))}
      </div>
      {view === "buyers" ? (
        <ByBuyer dealId={dealId} onOpenItem={(id) => room(`item=${encodeURIComponent(id)}`)} onViewAs={(id) => room(`as=${encodeURIComponent(id)}`)} onLog={(id) => room(`view=activity&activity=log&buyer=${encodeURIComponent(id)}`)} />
      ) : (
        <ByDocument dealId={dealId} onOpenItem={(id) => room(`item=${encodeURIComponent(id)}`)} />
      )}
    </div>
  );
}
