/**
 * "Share documents with this buyer…" (vdr spec §5.7, Buyers row menu): pick
 * documents from the room and share them with ONE buyer by name. Documents
 * they can already open are shown ticked and greyed. A document Cimple
 * couldn't fully check is left out until the broker ticks it in its drawer;
 * a general ledger only goes to due diligence buyers (the server refuses the
 * rest with plain words). Then "Let them know?" (the broker's email).
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { sameAccessLevel } from "@shared/access-levels";
import type { BulkShareResult, RoomBuyerRow } from "@shared/vdr-api";
import { invalidateRoom, roomBase, useRoom, vdrFetch } from "@/hooks/useDataRoom";
import { LetThemKnow, type ShareSaved } from "./ShareDialog";

export function ShareWithBuyerDialog({ dealId, buyer, open, onOpenChange }: { dealId: string; buyer: RoomBuyerRow | null; open: boolean; onOpenChange: (o: boolean) => void }) {
  const room = useRoom(dealId);
  const { toast } = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<ShareSaved | null>(null);
  useEffect(() => { if (open) { setPicked(new Set()); setSaved(null); } }, [open, buyer?.accessId]);
  const label = buyer ? buyer.company || buyer.name || buyer.email : "";
  const rows = useMemo(() => {
    if (!buyer || !room.data) return [];
    return room.data.items
      .filter((i) => !i.removed)
      .map((i) => {
        const has = i.sharing.levels.some((l) => sameAccessLevel(l, buyer.level)) || i.sharing.allow.some((a) => a.email.toLowerCase() === buyer.key);
        const hidden = i.sharing.deny.some((a) => a.email.toLowerCase() === buyer.key);
        const why = i.unchecked.length > 0 ? "Check it first: open it and tick \"I've checked it\"." : i.isLedger && buyer.rule !== "auto_on" ? "Only due diligence buyers can open the general ledger." : null;
        return { item: i, has: has && !hidden, why };
      });
  }, [room.data, buyer]);

  const share = async () => {
    if (!buyer || picked.size === 0) return;
    setBusy(true);
    try {
      const r = await vdrFetch<BulkShareResult & { newlyVisible?: Array<{ accessId: string; label: string }> }>("POST", `${roomBase(dealId)}/shares/bulk`, { itemIds: Array.from(picked), add: { levels: [], allow: [buyer.accessId] } });
      await invalidateRoom(dealId);
      toast({ title: r.changed === 0 ? "Nothing was shared" : `${r.changed} ${r.changed === 1 ? "document" : "documents"} shared with ${label}`, description: r.skipped.length ? `${r.skipped.length} left out: ${r.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}` : undefined });
      const ids = Array.from(picked).filter((id) => !r.skipped.some((s) => s.itemId === id));
      if ((r.newlyVisible ?? []).length > 0 && ids.length > 0) setSaved({ newlyVisibleBuyers: r.newlyVisibleBuyers, newlyVisible: r.newlyVisible ?? [], itemIds: ids });
      else onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Couldn't share them", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg grid-cols-[minmax(0,1fr)] overflow-y-auto" data-testid="share-with-buyer">
        <DialogHeader>
          <DialogTitle className="pr-6">Share documents with {label}</DialogTitle>
          <DialogDescription>Only {label} will see the ones you pick. Nothing is emailed unless you choose to tell them.</DialogDescription>
        </DialogHeader>
        {saved ? (
          <LetThemKnow dealId={dealId} saved={saved} onDone={() => onOpenChange(false)} />
        ) : !buyer?.hasRoom ? (
          <p className="text-sm text-muted-foreground">Turn the data room on for {label} first.</p>
        ) : room.isLoading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">The data room is empty.</p>
        ) : (
          <div className="divide-y divide-border rounded-md border border-border">
            {rows.map(({ item, has, why }) => (
              <label key={item.id} className={`flex items-start gap-2.5 px-3 py-2 text-sm ${has || why ? "opacity-60" : "cursor-pointer hover:bg-muted/30"}`}>
                <Checkbox
                  checked={has || picked.has(item.id)}
                  disabled={has || !!why}
                  onCheckedChange={(v) => setPicked((s) => { const n = new Set(s); if (v === true) n.add(item.id); else n.delete(item.id); return n; })}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{item.number}</span>{item.title}</span>
                  {has ? <span className="block text-xs text-muted-foreground">They can already open it.</span> : why ? <span className="flex items-center gap-1 text-xs text-teal"><AlertTriangle className="h-3 w-3" />{why}</span> : null}
                </span>
              </label>
            ))}
          </div>
        )}
        {!saved && (
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button onClick={share} disabled={busy || picked.size === 0} data-testid="share-with-buyer-save">{busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}Share {picked.size || ""} with {label}</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
