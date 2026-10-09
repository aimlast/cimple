/**
 * Room settings (vdr spec §5.10): open/closed, adding new documents
 * automatically, the sharing plan, what the watermark looks like, and the
 * plain line about personal numbers (always covered; no switch).
 */
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { BrokerRoomPayload } from "@shared/vdr-api";
import { useRoomActions } from "./actions";

export function RoomSettingsDialog({ dealId, room, open, onOpenChange, onPlan }: { dealId: string; room: NonNullable<BrokerRoomPayload["room"]>; open: boolean; onOpenChange: (o: boolean) => void; onPlan: () => void }) {
  const actions = useRoomActions(dealId);
  const sample = "Jane Doe · jane@example.invalid · 2026-10-09 14:02 UTC · 7F3K2Q";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Room settings</DialogTitle>
          <DialogDescription className="sr-only">Open or close the data room, and how new documents are added.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5 text-sm">
          <label className="flex items-start gap-3">
            <Switch checked={room.status === "open"} onCheckedChange={(v) => actions.settings({ status: v ? "open" : "closed" }, v ? "The data room is open" : "The data room is closed")} data-testid="settings-open" />
            <span><span className="font-medium">Data room open</span><span className="block text-xs text-muted-foreground">Closing it stops every buyer and their team at once. Reopen any time.</span></span>
          </label>
          <label className="flex items-start gap-3">
            <Switch checked={room.autoAddNew} onCheckedChange={(v) => actions.settings({ autoAddNew: v }, v ? "New documents are added to the room" : "New documents aren't added on their own")} />
            <span><span className="font-medium">Add new documents to the room automatically</span><span className="block text-xs text-muted-foreground">New uploads are filed into the right folder, not shared.</span></span>
          </label>
          <div className="flex items-center justify-between gap-3">
            <span><span className="font-medium">Sharing plan</span><span className="block text-xs text-muted-foreground">{room.planAppliedAt ? "Change who sees each folder." : "Choose who sees each folder."}</span></span>
            <Button size="sm" variant="outline" onClick={() => { onOpenChange(false); onPlan(); }}>Open the plan</Button>
          </div>
          <div>
            <p className="font-medium">Watermark</p>
            <div className="relative mt-2 h-36 overflow-hidden rounded-md border border-border bg-white" aria-label="A sample page with the watermark">
              <div className="absolute inset-x-6 top-5 space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-1.5 rounded bg-[#E4E0D8]" style={{ width: `${90 - i * 8}%` }} />)}</div>
              <div className="absolute -inset-10 flex -rotate-[30deg] flex-col justify-center gap-6 opacity-[0.16]">
                {Array.from({ length: 4 }).map((_, i) => <p key={i} className="whitespace-nowrap text-[11px] text-[#46423B]">{sample}  ·  {sample}</p>)}
              </div>
              <div className="absolute inset-x-0 bottom-0 bg-[#FBF9F4] px-2 py-0.5 text-[9px] text-[#46423B]">Confidential · viewed by jane@example.invalid on Oct 9, 2026, 14:02 UTC</div>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">No data room can stop a screenshot. Every page carries the reader's name, so a leaked page shows who leaked it.</p>
          </div>
          <p className="rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">Social insurance, social security and card numbers are always covered for buyers. If Cimple covers something that isn't one, upload a cleaned copy of that document.</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
