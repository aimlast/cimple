/**
 * "Share what the DD CIM points to" (vdr spec §5.3, §5.12, §11.1.4).
 *
 * The due-diligence CIM points buyers to documents (its citation links).
 * This dialog lists the ones due diligence buyers can't open yet, in three
 * groups: ready to share (a document not in the room yet goes into its
 * folder), ones Cimple couldn't fully check (the broker ticks "I've checked
 * it" first — nothing flagged is ever shared without it), and ones that
 * can't be shared (private files are counted, never named). One click shares
 * the ticked ones with due diligence buyers; then "Let them know?" (the
 * broker's email, never automatic).
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, FileText, Loader2, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import type { BulkShareResult, NewlyVisible } from "@shared/vdr-api";
import type { VdrFlag } from "@shared/vdr";
import { invalidateRoom, roomBase, roomKey, vdrFetch } from "@/hooks/useDataRoom";
import { LetThemKnow, type ShareSaved } from "./ShareDialog";

export type DdCitedPayload = {
  available: boolean;
  share: Array<{ itemId: string | null; documentId: string; title: string; place: boolean }>;
  check: Array<{ itemId: string; title: string; flags: VdrFlag[] }>;
  cannot: Array<{ documentId: string | null; reason: string }>;
};

export function useDdCited(dealId: string, enabled: boolean) {
  return useQuery<DdCitedPayload>({ queryKey: [...roomKey(dealId), "dd-cited"], queryFn: () => vdrFetch("GET", `${roomBase(dealId)}/dd-cited`), enabled });
}

export function DdCitedDialog({ dealId, open, onOpenChange }: { dealId: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const q = useDdCited(dealId, open);
  const { toast } = useToast();
  const [skip, setSkip] = useState<Set<string>>(new Set());
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<ShareSaved | null>(null);
  useEffect(() => { if (open) { setSkip(new Set()); setChecked(new Set()); setSaved(null); } }, [open]);

  const data = q.data;
  const keyOf = (r: { itemId: string | null; documentId: string }) => r.itemId ?? `doc:${r.documentId}`;
  const chosen = useMemo(() => (data ? data.share.filter((r) => !skip.has(keyOf(r))) : []), [data, skip]);
  const ticked = useMemo(() => (data ? data.check.filter((r) => checked.has(r.itemId)) : []), [data, checked]);
  const total = chosen.length + ticked.length;

  const shareThem = async () => {
    if (!data || total === 0) return;
    setBusy(true);
    try {
      const r = await vdrFetch<BulkShareResult & { newlyVisible?: NewlyVisible[]; itemIds?: string[] }>("POST", `${roomBase(dealId)}/share-dd-cited`, {
        itemIds: [...chosen.filter((x) => x.itemId).map((x) => x.itemId!), ...ticked.map((x) => x.itemId)],
        documentIds: chosen.filter((x) => !x.itemId).map((x) => x.documentId),
        checkedFlags: Object.fromEntries(ticked.map((x) => [x.itemId, x.flags.map((f) => f.key)])),
      });
      await invalidateRoom(dealId);
      const n = r.changed;
      toast({
        title: n === 0 ? "Nothing was shared" : `${n} ${n === 1 ? "document" : "documents"} shared with due diligence buyers`,
        description: r.skipped.length ? `${r.skipped.length} left out: ${r.skipped.map((s) => `${s.title} (${s.reason})`).join("; ")}` : undefined,
      });
      if ((r.newlyVisible ?? []).length > 0) setSaved({ newlyVisibleBuyers: r.newlyVisibleBuyers, newlyVisible: r.newlyVisible ?? [], itemIds: r.itemIds ?? [] });
      else onOpenChange(false);
    } catch (e: any) {
      toast({ title: "Couldn't share them", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto" data-testid="dd-cited-dialog">
        <DialogHeader>
          <DialogTitle>Share what the DD CIM points to</DialogTitle>
          <DialogDescription>
            The due-diligence CIM links buyers to these documents. Share them with due diligence buyers so every link in the CIM opens.
          </DialogDescription>
        </DialogHeader>
        {saved ? (
          <LetThemKnow dealId={dealId} saved={saved} onDone={() => onOpenChange(false)} />
        ) : q.isLoading ? (
          <div className="space-y-2">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}</div>
        ) : q.error || !data ? (
          <p className="text-sm text-muted-foreground">This list couldn't be loaded. Close and try again.</p>
        ) : !data.available ? (
          <p className="text-sm text-muted-foreground">Make the due-diligence CIM first. Then this lists the documents it points to.</p>
        ) : data.share.length + data.check.length === 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-border bg-muted/20 p-3 text-sm" data-testid="dd-cited-done">
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-teal" />
            <span>Everything the DD CIM points to is shared with due diligence buyers.{data.cannot.length ? " The ones below can't be shared." : ""}</span>
          </div>
        ) : null}

        {!saved && data?.available && (
          <div className="space-y-4">
            {data.share.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Ready to share ({data.share.length})</h3>
                {data.share.map((r) => (
                  <label key={keyOf(r)} className="flex cursor-pointer items-start gap-2.5 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/30">
                    <Checkbox checked={!skip.has(keyOf(r))} onCheckedChange={(v) => setSkip((s) => { const n = new Set(s); if (v === true) n.delete(keyOf(r)); else n.add(keyOf(r)); return n; })} className="mt-0.5" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5"><FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="truncate">{r.title}</span></span>
                      {r.place && <span className="mt-0.5 block text-xs text-muted-foreground">Not in the data room yet. It goes into its folder.</span>}
                    </span>
                  </label>
                ))}
              </section>
            )}
            {data.check.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Check these first ({data.check.length})</h3>
                {data.check.map((r) => (
                  <div key={r.itemId} className="space-y-1.5 rounded-md border border-teal/30 bg-teal/5 px-3 py-2 text-sm">
                    <p className="flex items-center gap-1.5 font-medium"><AlertTriangle className="h-3.5 w-3.5 shrink-0 text-teal" /><span className="truncate">{r.title}</span></p>
                    <ul className="space-y-0.5 text-xs text-muted-foreground">{r.flags.map((f) => <li key={f.key}>{f.copy}</li>)}</ul>
                    <label className="flex cursor-pointer items-center gap-2 text-xs">
                      <Checkbox checked={checked.has(r.itemId)} onCheckedChange={(v) => setChecked((s) => { const n = new Set(s); if (v === true) n.add(r.itemId); else n.delete(r.itemId); return n; })} data-testid={`dd-cited-check-${r.itemId}`} />
                      Cimple couldn't check everything in this document. I've checked it.
                    </label>
                  </div>
                ))}
              </section>
            )}
            {data.cannot.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Can't be shared ({data.cannot.length})</h3>
                {data.cannot.map((r, i) => (
                  <p key={r.documentId ?? `c${i}`} className="flex items-start gap-1.5 text-xs text-muted-foreground"><Lock className="mt-0.5 h-3 w-3 shrink-0" />{r.reason}</p>
                ))}
              </section>
            )}
          </div>
        )}

        {!saved && (
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
            {data?.available && data.share.length + data.check.length > 0 && (
              <Button onClick={shareThem} disabled={busy || total === 0} data-testid="dd-cited-share">
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                Share {total} with due diligence buyers
              </Button>
            )}
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
