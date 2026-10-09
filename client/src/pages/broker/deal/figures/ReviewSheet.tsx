/**
 * ReviewSheet — "Review and show to buyers" (spec §5.3, D9): one checklist
 * that approves the notes, shows the differences and turns the
 * due-diligence checks on, in ONE request (POST …/figures/publish, one
 * transaction). Notes (except those resting only on the broker's internal
 * note) and worked-out / explained differences start ticked; a difference
 * with no reason starts unticked ("Ask the seller first"); a CIM figure that
 * disagrees with its statements or one Cimple couldn't find is never offered.
 * Self-contained (dealId), so the builder's preview bar opens it too.
 */
import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { reviewItems, type FiguresWorkspace } from "@shared/figure-workspace";
import { figuresErrorText, figuresKey, figuresRequest, useFigureActions } from "./useFigures";
import { useRoom } from "@/hooks/useDataRoom";
import { DdCitedDialog } from "@/components/vdr/broker/DdCitedDialog";

function Row({ checked, onChange, label, sub, disabled, testId }: { checked: boolean; onChange?: (v: boolean) => void; label: string; sub?: string | null; disabled?: boolean; testId?: string }) {
  return (
    <label className="flex cursor-pointer items-start gap-2.5 rounded-md px-2 py-1.5 hover:bg-muted/40" data-testid={testId}>
      <Checkbox checked={checked} onCheckedChange={(v) => onChange?.(v === true)} disabled={disabled} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="block text-sm leading-snug">{label}</span>
        {sub && <span className="mt-0.5 block text-[11px] text-muted-foreground">{sub}</span>}
      </span>
    </label>
  );
}

function Group({ title, all, onAll, children }: { title: string; all?: boolean; onAll?: (v: boolean) => void; children: React.ReactNode }) {
  return (
    <section className="space-y-1">
      <div className="flex items-center justify-between gap-3 px-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h4>
        {onAll && (
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Checkbox checked={!!all} onCheckedChange={(v) => onAll(v === true)} /> all
          </label>
        )}
      </div>
      {children}
    </section>
  );
}

export function ReviewSheet({ dealId, open, onOpenChange }: { dealId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const { toast } = useToast();
  const { publish } = useFigureActions(dealId);
  const ws = useQuery<FiguresWorkspace>({ queryKey: figuresKey(dealId), queryFn: () => figuresRequest("GET", `/api/deals/${dealId}/figures`), enabled: open });
  const items = useMemo(() => (ws.data ? reviewItems(ws.data) : null), [ws.data]);
  const [notes, setNotes] = useState<Record<string, boolean>>({});
  const [diffs, setDiffs] = useState<Record<string, boolean>>({});
  const [anyway, setAnyway] = useState<Record<string, boolean>>({});
  const [turnOn, setTurnOn] = useState(true);
  useEffect(() => {
    if (!open || !items) return;
    setNotes(Object.fromEntries(items.notes.map((n) => [n.id, n.ticked])));
    setDiffs(Object.fromEntries(items.differences.map((d) => [d.checkKey, d.ticked])));
    setAnyway({});
    setTurnOn(!ws.data?.status.ddShownAt);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, !!items]);

  const checksOn = !!ws.data?.status.ddShownAt;
  const ticked = (m: Record<string, boolean>) => Object.entries(m).filter(([, v]) => v).map(([k]) => k);
  const submit = async () => {
    if (!items) return;
    const noteIds = ticked(notes);
    const shown = [...ticked(diffs), ...ticked(anyway)];
    // A worked-out difference unticked here is left out (it would otherwise show automatically with the checks on).
    const leaveOut = items.differences.filter((d) => !diffs[d.checkKey] && ws.data?.checks.find((c) => c.checkKey === d.checkKey)?.state === "regrouped").map((d) => d.checkKey);
    try {
      const r = await publish.mutateAsync({
        notes: items.notes.filter((n) => noteIds.includes(n.id)).map((n) => ({ id: n.id, fingerprint: n.fingerprint })),
        checkKeys: shown, leaveOut, turnOnChecks: turnOn && !checksOn,
      });
      const parts: string[] = [];
      if (r.checksOn) parts.push("Due-diligence buyers now see the checks.");
      if (r.approved > 0) parts.push(`${r.approved} ${r.approved === 1 ? "note is" : "notes are"} shown in every version.`);
      if (r.shown > 0 && !r.checksOn) parts.push(`${r.shown} ${r.shown === 1 ? "difference is" : "differences are"} ready for due-diligence buyers.`);
      const skipped = r.skippedNotes.length + r.refused.length;
      toast({
        title: parts.length > 0 ? "Shown to buyers" : "Nothing changed",
        description: [...parts, skipped > 0 ? `${skipped} changed while you were reviewing and ${skipped === 1 ? "was" : "were"} left as ${skipped === 1 ? "it was" : "they were"}.` : ""].filter(Boolean).join(" "),
      });
      onOpenChange(false);
    } catch (e) {
      toast({ title: "Nothing was changed", description: figuresErrorText(e), variant: "destructive" });
    }
  };

  const nothing = items && items.notes.length === 0 && items.differences.length === 0 && items.needsLook.length === 0;
  const count = ticked(notes).length + ticked(diffs).length + ticked(anyway).length;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:w-[520px] sm:max-w-[520px]" data-testid="figure-review-sheet">
        <SheetHeader className="space-y-1 border-b border-border px-5 py-4 text-left">
          <SheetTitle className="text-base">Review and show to buyers</SheetTitle>
          <SheetDescription className="text-xs">Tick what buyers may read. Nothing reaches them until you click Show to buyers.</SheetDescription>
        </SheetHeader>
        <div className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
          {!items ? (
            <div className="space-y-2 px-2">{Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="h-8" />)}</div>
          ) : (
            <>
              {items.notes.length > 0 && (
                <Group title={`Notes ready to show (${items.notes.length})`} all={items.notes.every((n) => notes[n.id])} onAll={(v) => setNotes(Object.fromEntries(items.notes.map((n) => [n.id, v])))}>
                  {items.notes.map((n) => (
                    <Row key={n.id} checked={!!notes[n.id]} onChange={(v) => setNotes((s) => ({ ...s, [n.id]: v }))}
                      label={`${n.label}: ${n.text}`} sub={n.why ?? n.versions} testId={`review-note-${n.id}`} />
                  ))}
                </Group>
              )}
              {items.differences.length > 0 && (
                <Group title={`Differences ready to show (${items.differences.length})`} all={items.differences.every((d) => diffs[d.checkKey])} onAll={(v) => setDiffs(Object.fromEntries(items.differences.map((d) => [d.checkKey, v])))}>
                  {items.differences.map((d) => (
                    <Row key={d.checkKey} checked={!!diffs[d.checkKey]} onChange={(v) => setDiffs((s) => ({ ...s, [d.checkKey]: v }))} label={d.label} />
                  ))}
                  {items.matchesAuto > 0 && <p className="px-2 text-[11px] text-muted-foreground">+ {items.matchesAuto} {items.matchesAuto === 1 ? "match" : "matches"} (shown automatically)</p>}
                </Group>
              )}
              {items.needsLook.length > 0 && (
                <Group title={`Need a look first (${items.needsLook.length})`}>
                  {items.needsLook.map((n) => n.canShow ? (
                    <Row key={n.checkKey} checked={!!anyway[n.checkKey]} onChange={(v) => setAnyway((s) => ({ ...s, [n.checkKey]: v }))} label={n.label} sub={`${n.why} · tick to show anyway`} />
                  ) : (
                    <div key={n.checkKey} className="flex items-start gap-2.5 px-2 py-1.5 opacity-70">
                      <Checkbox checked={false} disabled className="mt-0.5" />
                      <span className="text-sm leading-snug">{n.label}<span className="mt-0.5 block text-[11px] text-muted-foreground">{n.why} (can't be shown)</span></span>
                    </div>
                  ))}
                </Group>
              )}
              {/* The data room (vdr contract §11.1): documents the DD CIM points to that due-diligence buyers can't open yet. */}
              <ReviewRoomLine dealId={dealId} />
              {nothing && <p className="px-2 text-sm text-muted-foreground">Nothing is waiting. New notes and differences appear here as Cimple finds them.</p>}
            </>
          )}
        </div>
        <SheetFooter className="flex-col gap-3 border-t border-border px-5 py-3 sm:flex-col sm:space-x-0">
          {!checksOn ? (
            <Row checked={turnOn} onChange={setTurnOn} label="Turn on the checks for due-diligence buyers" sub="They see matches and the differences you show, with the documents behind them." testId="review-turn-on" />
          ) : (
            <p className="px-2 text-xs text-muted-foreground">Due-diligence buyers already see the checks.</p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={submit} disabled={publish.isPending || !items || (count === 0 && !(turnOn && !checksOn))} data-testid="button-review-publish">
              {publish.isPending && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />} Show to buyers
            </Button>
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

/**
 * "{n} documents the DD CIM points to aren't shared with due-diligence buyers ·
 * Share them in the data room" — the data room's own count and dialog (vdr's
 * GET/POST …/data-room/dd-cited). Mounted only while the sheet is open.
 * Nothing when the room isn't set up or everything cited is shared.
 */
function ReviewRoomLine({ dealId }: { dealId: string }) {
  const room = useRoom(dealId);
  const [open, setOpen] = useState(false);
  const n = room.data?.room ? room.data.kpis.ddCitedNotShared : 0;
  if (!n || n <= 0) return null;
  return (
    <>
      <p className="px-2 text-xs text-amber-500" data-testid="review-room-line">
        {n === 1 ? "1 document" : `${n} documents`} the DD CIM points to {n === 1 ? "isn't" : "aren't"} shared with due-diligence buyers.{" "}
        <button type="button" className="text-teal hover:underline" onClick={() => setOpen(true)}>Share them in the data room</button>
      </p>
      <DdCitedDialog dealId={dealId} open={open} onOpenChange={setOpen} />
    </>
  );
}
