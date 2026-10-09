/**
 * Buyers (vdr spec §5.7): one row per buyer (by email) who can have the room
 * — their access, whether the room is on for them, downloads, how many
 * documents they can see, when they last opened one, when their link ends —
 * and, folded, the buyers who can't have it yet with the plain reason
 * (Blind CIM buyers get "Move to Full CIM"). Each buyer's team sits under
 * them (§6.8): add someone, approve the buyer's ask, send a new link, remove.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Eye, Loader2, MoreHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { NAMED_ACCESS_LEVEL } from "@shared/access-levels";
import type { NotEligibleBuyerRow, RoomBuyerRow } from "@shared/vdr-api";
import { invalidateRoom, shortDate, useRoomBuyers, vdrFetch } from "@/hooks/useDataRoom";
import { PanelError } from "@/components/deal/PanelError";
import { useRoomActions } from "./actions";
import { AddTeamMemberDialog, TeamRows } from "./TeamParts";

export function BuyersView({ dealId, focusAccessId, onViewAs }: { dealId: string; focusAccessId: string | null; onViewAs: (accessId: string) => void }) {
  const { data, isLoading, error, refetch } = useRoomBuyers(dealId);
  const actions = useRoomActions(dealId);
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [showOthers, setShowOthers] = useState(false);
  const [moving, setMoving] = useState<NotEligibleBuyerRow | null>(null);
  const [addingTo, setAddingTo] = useState<RoomBuyerRow | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const extend = useMutation({
    mutationFn: async (b: RoomBuyerRow) => {
      const from = Math.max(Date.now(), b.expiresAt ? new Date(b.expiresAt).getTime() : 0);
      return vdrFetch("PATCH", `/api/buyers/${b.accessId}`, { expiresAt: new Date(from + 30 * 86_400_000).toISOString() });
    },
    onSuccess: () => { invalidateRoom(dealId); toast({ title: "Link extended by 30 days" }); },
    onError: (e: Error) => toast({ title: "Couldn't extend the link", description: e.message, variant: "destructive" }),
  });
  const moveToFull = useMutation({
    mutationFn: (b: NotEligibleBuyerRow) => vdrFetch("PATCH", `/api/buyers/${b.accessId}`, { accessLevel: NAMED_ACCESS_LEVEL }),
    onSuccess: (_r, b) => { invalidateRoom(dealId); setMoving(null); toast({ title: `${b.company || b.name || b.email} is on the Full CIM`, description: "Their data room stays off until you turn it on." }); },
    onError: (e: Error) => toast({ title: "Couldn't move them", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-14 w-full" />)}</div>;
  if (error || !data) return <PanelError what="buyers" onRetry={() => refetch()} />;

  const roomSelect = (b: RoomBuyerRow) => (
    <Select
      value={b.rule === "auto_on" ? (b.roomAccess === "off" ? "off" : "auto") : b.roomAccess === "on" ? "on" : "off"}
      onValueChange={(v) => actions.buyer(b.accessId, { roomAccess: v as "auto" | "on" | "off" }, v === "off" ? "Data room off for them" : "Data room on for them")}
    >
      <SelectTrigger className="h-8 w-[150px] text-xs" data-testid={`buyer-room-${b.accessId}`}><SelectValue /></SelectTrigger>
      <SelectContent>
        {b.rule === "auto_on" ? <SelectItem value="auto" className="text-xs">Automatic (on)</SelectItem> : <SelectItem value="on" className="text-xs">On</SelectItem>}
        <SelectItem value="off" className="text-xs">Off</SelectItem>
      </SelectContent>
    </Select>
  );
  const ends = (b: RoomBuyerRow) => {
    if (!b.expiresAt) return <span className="text-xs text-muted-foreground">No end date</span>;
    const soon = b.endsInDays != null && b.endsInDays <= 5;
    return (
      <span className={cn("text-xs", soon ? "text-teal" : "text-muted-foreground")}>
        {shortDate(b.expiresAt)}
        {soon && <button className="ml-1.5 underline" onClick={() => extend.mutate(b)} disabled={extend.isPending}>Extend 30 days</button>}
      </span>
    );
  };
  const menu = (b: RoomBuyerRow) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="h-7 w-7" aria-label={`More for ${b.company || b.name || b.email}`}><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onViewAs(b.accessId)} disabled={!b.hasRoom}>View as this buyer</DropdownMenuItem>
        <DropdownMenuItem onClick={() => { setAddingTo(b); setAddOpen(true); }} disabled={!b.hasRoom || (b.team ?? []).length >= 5} data-testid={`buyer-add-team-${b.accessId}`}>Add someone from their team…</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setLocation(`/deal/${dealId}/buyers`)}>Open the Buyers tab</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
  const who = (b: { name: string | null; company: string | null; email: string }) => (
    <div className="min-w-0">
      <p className="truncate font-medium">{b.company || b.name || b.email}</p>
      <p className="truncate text-xs text-muted-foreground">{[b.company ? b.name : null, b.email].filter(Boolean).join(" · ")}</p>
    </div>
  );

  return (
    <div className="space-y-4" data-testid="room-buyers">
      {data.eligible.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border px-6 py-12 text-center text-sm text-muted-foreground" data-testid="room-buyers-empty">
          No buyer has the data room yet. Due diligence buyers get it automatically, and you can turn it on for any Full CIM buyer who signed the NDA.
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <table className="hidden w-full text-sm lg:table">
            <thead>
              <tr className="border-b border-border text-left text-2xs uppercase tracking-[0.12em] text-muted-foreground/70">
                <th className="px-3 py-2 font-medium">Buyer</th>
                <th className="px-2 py-2 font-medium">Access</th>
                <th className="px-2 py-2 font-medium">Data room</th>
                <th className="px-2 py-2 font-medium">Downloads</th>
                <th className="px-2 py-2 font-medium">Can see</th>
                <th className="px-2 py-2 font-medium">Last opened</th>
                <th className="px-2 py-2 font-medium">Link ends</th>
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {data.eligible.map((b) => (
                <tr key={b.key} className={cn("border-b border-border last:border-0", focusAccessId === b.accessId && "bg-teal/5")} data-testid={`buyer-row-${b.accessId}`}>
                  <td className="px-3 py-2.5">{who(b)}{b.links > 1 && <p className="text-[11px] text-muted-foreground">{b.links} links</p>}</td>
                  <td className="px-2 py-2.5 text-xs">{b.levelLabel}</td>
                  <td className="px-2 py-2.5">{roomSelect(b)}</td>
                  <td className="px-2 py-2.5"><label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch checked={b.allowDownloads} onCheckedChange={(v) => actions.buyer(b.accessId, { allowDownloads: v }, v ? "Downloads allowed" : "View only")} aria-label="Allow downloads" />Allow</label></td>
                  <td className="px-2 py-2.5 text-xs">
                    {b.hasRoom ? <button className="text-left underline-offset-2 hover:underline" onClick={() => onViewAs(b.accessId)}>{b.canSee} {b.canSee === 1 ? "document" : "documents"}{b.newCount ? ` · ${b.newCount} new` : ""}</button> : <span className="text-muted-foreground">Room off</span>}
                  </td>
                  <td className="px-2 py-2.5 text-xs text-muted-foreground">{b.lastOpenedAt ? shortDate(b.lastOpenedAt) : "Not yet"}</td>
                  <td className="px-2 py-2.5">{ends(b)}</td>
                  <td className="px-2 py-2.5">{menu(b)}</td>
                </tr>
              )).flatMap((row, idx) => {
                const b = data.eligible[idx];
                const team = b.team ?? [];
                return team.length === 0 ? [row] : [row, (
                  <tr key={`${b.key}-team`} className="border-b border-border bg-muted/10 last:border-0">
                    <td colSpan={8} className="px-3 pb-2.5 pt-0">
                      <p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground/70">Their team</p>
                      <TeamRows dealId={dealId} team={team} />
                    </td>
                  </tr>
                )];
              })}
            </tbody>
          </table>
          <div className="lg:hidden">
            {data.eligible.map((b) => (
              <div key={b.key} className="space-y-2 border-b border-border px-3 py-3 last:border-0">
                <div className="flex items-start justify-between gap-2">{who(b)}{menu(b)}</div>
                <p className="text-xs text-muted-foreground">{b.levelLabel} · {b.hasRoom ? `${b.canSee} documents${b.newCount ? ` · ${b.newCount} new` : ""}` : "room off"} · last opened {b.lastOpenedAt ? shortDate(b.lastOpenedAt) : "not yet"}</p>
                <div className="flex flex-wrap items-center gap-3">
                  {roomSelect(b)}
                  <label className="flex items-center gap-2 text-xs text-muted-foreground"><Switch checked={b.allowDownloads} onCheckedChange={(v) => actions.buyer(b.accessId, { allowDownloads: v }, v ? "Downloads allowed" : "View only")} aria-label="Allow downloads" />Allow downloads</label>
                </div>
                <div className="flex items-center justify-between gap-2">{ends(b)}{b.hasRoom && <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => onViewAs(b.accessId)}><Eye className="mr-1 h-3 w-3" /> View as them</Button>}</div>
                {(b.team ?? []).length > 0 && <div className="pt-1"><p className="mb-1 text-[11px] uppercase tracking-wider text-muted-foreground/70">Their team</p><TeamRows dealId={dealId} team={b.team ?? []} phone /></div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {data.notEligible.length > 0 && (
        <div className="rounded-lg border border-border bg-card">
          <button className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm font-medium" onClick={() => setShowOthers((v) => !v)} aria-expanded={showOthers}>
            {showOthers ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} Not eligible yet ({data.notEligible.length})
          </button>
          {showOthers && (
            <div className="border-t border-border">
              {data.notEligible.map((b) => (
                <div key={b.key} className="flex flex-wrap items-center gap-3 border-b border-border px-3 py-2.5 text-sm last:border-0">
                  <div className="min-w-0 flex-1">{who(b)}</div>
                  <span className="text-xs text-muted-foreground">{b.copy}</span>
                  {b.reason === "blind" && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setMoving(b)}>Move to Full CIM</Button>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Stays mounted after closing so the new link can be shown once. */}
      {addingTo && <AddTeamMemberDialog key={addingTo.accessId} dealId={dealId} accessId={addingTo.accessId} buyerLabel={addingTo.company || addingTo.name || addingTo.email} open={addOpen} onOpenChange={setAddOpen} />}

      <AlertDialog open={!!moving} onOpenChange={(o) => { if (!o) setMoving(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Move {moving?.company || moving?.name || moving?.email} to the Full CIM?</AlertDialogTitle>
            <AlertDialogDescription>They'll see the business's name in the memorandum. Their data room stays off until you turn it on.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={(e) => { e.preventDefault(); if (moving) moveToFull.mutate(moving); }} disabled={moveToFull.isPending}>
              {moveToFull.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Move to Full CIM
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
