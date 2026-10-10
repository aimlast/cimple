/**
 * The data room's lines on other screens (vdr spec §5.12, §11.3;
 * INTEGRATION §2.8 slots, §3 C13). Teaser owns the CIM tab's layout; vdr
 * fills its slots with these, and HaveCimStage calls the DD nudge.
 *
 *  - `vdrTileLines(kpis)` → the access tiles' extra lines (≤ 1 per tile from
 *    vdr; dd's go first, ≤ 2 in all): Due diligence "+ data room · {k}
 *    documents shared" and "{n} the DD CIM points to aren't shared · Share
 *    them"; Full CIM "+ data room for {n} buyers you chose". Teaser and Blind
 *    CIM get "No data room" in the tile's TOOLTIP (`vdrTileTooltips`), never a
 *    line.
 *  - `VdrPublishNote` → the publish confirmation's line (never blocks
 *    publishing).
 *  - `useDdRoomNudge` → after a buyer moves to due diligence: "Northgate is
 *    now in due diligence. The data room is on for them. 6 documents the DD
 *    CIM points to aren't shared yet. [Share them]" (only when > 0).
 */
import { useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { Share2 } from "lucide-react";
import { ToastAction } from "@/components/ui/toast";
import { useToast } from "@/hooks/use-toast";
import { BLIND_ACCESS_LEVEL, DD_ACCESS_LEVEL, NAMED_ACCESS_LEVEL, TEASER_ACCESS_LEVEL, cimModeForAccessLevel } from "@shared/access-levels";
import type { BrokerRoomPayload, RoomKpis } from "@shared/vdr-api";
import { roomBase, useRoom, vdrFetch } from "@/hooks/useDataRoom";

export type TileLine = { key: string; text: string; tone?: "muted" | "amber"; href?: string };

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** The data room's tile lines, keyed by the registry's level keys (nothing before the room is set up). */
export function vdrTileLines(dealId: string, payload: Pick<BrokerRoomPayload, "room" | "kpis"> | null | undefined): Record<string, TileLine[]> {
  const out: Record<string, TileLine[]> = { [TEASER_ACCESS_LEVEL]: [], [BLIND_ACCESS_LEVEL]: [], [NAMED_ACCESS_LEVEL]: [], [DD_ACCESS_LEVEL]: [] };
  if (!payload?.room) return out;
  const k: RoomKpis = payload.kpis;
  const room = `/deal/${encodeURIComponent(dealId)}/data-room`;
  const ddShared = k.sharedByLevel[DD_ACCESS_LEVEL] ?? 0;
  out[DD_ACCESS_LEVEL].push(
    k.ddCitedNotShared > 0
      ? { key: "vdr-dd-cited", text: `${n(k.ddCitedNotShared, "document", "documents")} the DD CIM points to ${k.ddCitedNotShared === 1 ? "isn't" : "aren't"} shared · Share them`, tone: "amber", href: `${room}?dd=1` }
      : { key: "vdr-dd", text: `+ data room · ${n(ddShared, "document", "documents")} shared`, href: room },
  );
  const fullBuyers = k.roomBuyersByLevel[NAMED_ACCESS_LEVEL] ?? 0;
  if (fullBuyers > 0) out[NAMED_ACCESS_LEVEL].push({ key: "vdr-full", text: `+ data room for ${n(fullBuyers, "buyer", "buyers")} you chose`, href: `${room}?view=buyers` });
  return out;
}

/** "No data room" for the levels that never get one (in the tile's tooltip, C13). */
export function vdrTileTooltips(): Record<string, string> {
  return { [TEASER_ACCESS_LEVEL]: "No data room", [BLIND_ACCESS_LEVEL]: "No data room: documents name the business. Move a buyer to the Full CIM to share documents." };
}

/** The same lines from a live query (for the CIM tab). */
export function useVdrTileLines(dealId: string): { lines: Record<string, TileLine[]>; tooltips: Record<string, string> } {
  const room = useRoom(dealId);
  return { lines: vdrTileLines(dealId, room.data ?? null), tooltips: vdrTileTooltips() };
}

/** The publish confirmation's line (CIM tab, §2.8 `publishNotes`); null when there's nothing to say. */
export function VdrPublishNote({ dealId }: { dealId: string }) {
  const room = useRoom(dealId);
  const k = room.data?.room ? room.data.kpis.ddCitedNotShared : 0;
  if (!k) return null;
  return (
    <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground" data-testid="vdr-publish-note">
      <Share2 className="h-3.5 w-3.5 text-teal" />
      The DD CIM points to {n(k, "document", "documents")} not shared with due-diligence buyers.
      <a href={`/deal/${encodeURIComponent(dealId)}/data-room?dd=1`} className="text-teal underline underline-offset-2">Share them</a>
    </p>
  );
}

/** The nudge's words (exported for the test). */
export function ddNudgeText(who: string, notShared: number): string {
  return `${who} is now in due diligence. The data room is on for them. ${n(notShared, "document", "documents")} the DD CIM points to ${notShared === 1 ? "isn't" : "aren't"} shared yet.`;
}

/**
 * After a buyer moves to due diligence (the Buyers tab's level select), the
 * toast with "Share them" — only when the room is set up and something the
 * DD CIM points to isn't shared. Watches the rows it's given; the first
 * render never toasts.
 */
export function useDdRoomNudge(dealId: string, rows: ReadonlyArray<{ id: string; accessLevel?: string | null; buyerName?: string | null; buyerCompany?: string | null; buyerEmail?: string | null }>) {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const prev = useRef<Map<string, string> | null>(null);
  const key = rows.map((r) => `${r.id}:${r.accessLevel ?? ""}`).join("|");
  useEffect(() => {
    const now = new Map(rows.map((r) => [r.id, String(r.accessLevel ?? "")]));
    const before = prev.current;
    prev.current = now;
    if (!before) return;
    const moved = rows.filter((r) => cimModeForAccessLevel(r.accessLevel) === "dd" && before.has(r.id) && cimModeForAccessLevel(before.get(r.id)) !== "dd");
    if (moved.length === 0) return;
    let alive = true;
    vdrFetch<BrokerRoomPayload>("GET", roomBase(dealId))
      .then((p) => {
        if (!alive || !p.room) return;
        const k = p.kpis.ddCitedNotShared;
        if (k <= 0) return;
        const who = moved.length === 1 ? moved[0].buyerCompany || moved[0].buyerName || moved[0].buyerEmail || "This buyer" : `${moved.length} buyers`;
        toast({
          title: "Due diligence and the data room",
          description: moved.length === 1 ? ddNudgeText(who, k) : `${who} are now in due diligence. The data room is on for them. ${n(k, "document", "documents")} the DD CIM points to ${k === 1 ? "isn't" : "aren't"} shared yet.`,
          action: <ToastAction altText="Share them" onClick={() => setLocation(`/deal/${dealId}/data-room?dd=1`)}>Share them</ToastAction>,
        });
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
}
