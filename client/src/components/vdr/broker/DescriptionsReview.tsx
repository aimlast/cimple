/**
 * "Descriptions to accept" (vdr spec §5.8, V12): every description Cimple
 * wrote for a shared document, on one screen. Buyers read the basic line
 * until the broker accepts one — here (Use this · Use all) or in the
 * document's notes (Edit).
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import type { RoomItemRow } from "@shared/vdr-api";
import { invalidateRoom, roomBase, vdrFetch } from "@/hooks/useDataRoom";

export function DescriptionsReview({ dealId, items, open, onOpenChange, onEdit }: { dealId: string; items: RoomItemRow[]; open: boolean; onOpenChange: (o: boolean) => void; onEdit: (itemId: string) => void }) {
  const { toast } = useToast();
  const drafted = items.filter((i) => !i.removed && i.summary.status === "drafted" && !!i.summary.text);
  const [busy, setBusy] = useState<string | null>(null);
  const accept = async (ids: string[]) => {
    setBusy(ids.length > 1 ? "all" : ids[0]);
    try {
      const r = await vdrFetch<{ accepted: number }>("POST", `${roomBase(dealId)}/summaries/accept`, { itemIds: ids });
      await invalidateRoom(dealId);
      toast({ title: r.accepted === 1 ? "Buyers will read this description" : `Buyers will read ${r.accepted} descriptions` });
      if (ids.length === drafted.length) onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Couldn't accept them", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-base">What buyers will read about each document</DialogTitle>
          <DialogDescription>Cimple wrote these from the documents themselves. Buyers see a basic line until you accept one.</DialogDescription>
        </DialogHeader>
        {drafted.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">Nothing left to review.</p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border" data-testid="descriptions-review">
            {drafted.map((i) => (
              <div key={i.id} className="space-y-1.5 px-4 py-3 text-sm">
                <p className="font-medium"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{i.number}</span>{i.title}</p>
                <p className="text-foreground/90">{i.summary.text}</p>
                {i.summary.points.length > 0 && <ul className="list-disc space-y-0.5 pl-5 text-foreground/80">{i.summary.points.map((p, k) => <li key={k}>{p}</li>)}</ul>}
                <div className="flex gap-2 pt-1">
                  <Button size="sm" variant="outline" onClick={() => accept([i.id])} disabled={!!busy}>{busy === i.id && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Use this</Button>
                  <Button size="sm" variant="ghost" onClick={() => { onOpenChange(false); onEdit(i.id); }}>Edit</Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
          {drafted.length > 1 && <Button onClick={() => accept(drafted.map((i) => i.id))} disabled={!!busy}>{busy === "all" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Use all ({drafted.length})</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
