/**
 * One line on the Information tab's source viewer (vdr spec §5.12): where
 * this source is in the data room — "In the data room: 1.2.2 · shared with
 * due diligence buyers →" — or "Not in the data room · Put it in" for a
 * document that can go there. Working material (emails, calls, CRM notes)
 * and private files say nothing. No second file list.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { FolderLock, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { vdrBrokerHref } from "@shared/vdr";
import { invalidateRoom, roomBase, useRoom, vdrFetch } from "@/hooks/useDataRoom";

export function sourceRoomText(item: { number: string | null; sharing: { shared: boolean; label: string } }): string {
  const where = item.number ? `In the data room: ${item.number}` : "In the data room";
  return `${where} · ${item.sharing.shared ? `shared with ${item.sharing.label.charAt(0).toLowerCase()}${item.sharing.label.slice(1)}` : "not shared yet"}`;
}

export function SourceRoomLine({ dealId, documentId, visibility }: { dealId: string; documentId: string; visibility: string | null }) {
  const room = useRoom(dealId);
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const data = room.data;
  if (!data?.room || visibility === "broker_only") return null;
  const item = data.items.find((i) => i.documentId === documentId && !i.removed);
  if (item) {
    return (
      <button type="button" onClick={() => setLocation(vdrBrokerHref(dealId, { itemId: item.id }))} className="flex items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground" data-testid="source-room-line">
        <FolderLock className="h-3 w-3 shrink-0 text-teal" /> {sourceRoomText(item)} →
      </button>
    );
  }
  if (!data.notPlaced.some((d) => d.documentId === documentId)) return null; // working material stays out
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="source-room-line">
      <FolderLock className="h-3 w-3 shrink-0" /> Not in the data room ·
      <button
        type="button"
        className="text-teal underline-offset-2 hover:underline"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await vdrFetch("POST", `${roomBase(dealId)}/items`, { documentId });
            await invalidateRoom(dealId);
            toast({ title: "Put in the data room", description: "It isn't shared with anyone until you share it." });
          } catch (e: any) {
            toast({ title: "Couldn't put it in", description: e?.message, variant: "destructive" });
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Loader2 className="inline h-3 w-3 animate-spin" /> : "Put it in"}
      </button>
    </p>
  );
}
