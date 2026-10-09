/**
 * The Share dialog (vdr spec §5.5) — one document, several, or a whole
 * folder. Levels come from the registry (Due diligence / Full CIM); Teaser
 * and Blind CIM buyers are never offered. Specific buyers are the ones who
 * can have the room. "Hide it from" wins over everything. A document Cimple
 * couldn't fully check needs "I've checked it" before Save. The preview line
 * says exactly who will see it now. Nothing is emailed.
 *
 * ShareForm is the same controls inline (the drawer's Sharing tab).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, Loader2, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { DD_ACCESS_LEVEL, NAMED_ACCESS_LEVEL } from "@shared/access-levels";
import type { BulkShareResult, RoomFolderRow, RoomItemRow, ShareAudience } from "@shared/vdr-api";
import { invalidateRoom, roomBase, useAudience, vdrFetch } from "@/hooks/useDataRoom";

export type ShareTarget =
  | { kind: "item"; item: RoomItemRow }
  | { kind: "items"; items: RoomItemRow[] }
  | { kind: "folder"; folder: RoomFolderRow; items: RoomItemRow[] };

const LEDGER_COPY = "Only due-diligence buyers can open the general ledger. Move this buyer to Due diligence first.";

type Grants = { levels: string[]; allow: string[]; deny: string[] };

function initialGrants(items: RoomItemRow[], audience: ShareAudience | undefined): Grants {
  if (items.length === 0) return { levels: [], allow: [], deny: [] };
  const idFor = (email: string) => audience?.buyers.find((b) => b.key === email.toLowerCase())?.accessId ?? null;
  // Several documents: what they ALL have now.
  const levels = [DD_ACCESS_LEVEL, NAMED_ACCESS_LEVEL].filter((l) => items.every((i) => i.sharing.levels.includes(l)));
  const allowSets = items.map((i) => new Set(i.sharing.allow.map((a) => a.accessId ?? idFor(a.email)).filter((x): x is string => !!x)));
  const allow = Array.from(allowSets[0]).filter((id) => allowSets.every((s) => s.has(id)));
  const deny = items.length === 1 ? items[0].sharing.deny.map((a) => a.accessId ?? idFor(a.email)).filter((x): x is string => !!x) : [];
  return { levels, allow, deny };
}

/** Who will see it now, by name (the same rule the server uses, for this dialog's preview line). */
function whoSees(g: Grants, audience: ShareAudience, ledger: boolean): string[] {
  const out: string[] = [];
  for (const b of audience.buyers) {
    if (!b.hasRoom || g.deny.includes(b.accessId)) continue;
    if (ledger && !b.dd) continue;
    if (g.allow.includes(b.accessId) || g.levels.includes(b.level)) out.push(b.company || b.name || b.email);
  }
  return out;
}

export function ShareDialog({ dealId, target, open, onOpenChange, onSaved }: { dealId: string; target: ShareTarget | null; open: boolean; onOpenChange: (o: boolean) => void; onSaved?: (r: { newlyVisibleBuyers: number }) => void }) {
  const items = !target ? [] : target.kind === "item" ? [target.item] : target.items;
  const title = !target ? "" : target.kind === "item" ? `Who can see "${target.item.title}"?` : target.kind === "folder" ? `Who can see everything in ${target.folder.number} ${target.folder.name} (${target.items.length})?` : `Who can see these ${target.items.length} documents?`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="pr-6 text-base leading-snug">{title}</DialogTitle>
          <DialogDescription className="sr-only">Choose which buyers can open {items.length === 1 ? "this document" : "these documents"} in the data room.</DialogDescription>
        </DialogHeader>
        {target && <ShareForm key={items.map((i) => i.id).join(",")} dealId={dealId} target={target} onDone={(r) => { onSaved?.(r); onOpenChange(false); }} onCancel={() => onOpenChange(false)} />}
      </DialogContent>
    </Dialog>
  );
}

export function ShareForm({ dealId, target, onDone, onCancel, inline }: { dealId: string; target: ShareTarget; onDone?: (r: { newlyVisibleBuyers: number }) => void; onCancel?: () => void; inline?: boolean }) {
  const { toast } = useToast();
  const { data: audience, isLoading } = useAudience(dealId);
  const items = target.kind === "item" ? [target.item] : target.items;
  const single = target.kind === "item" ? target.item : null;
  const anyLedger = items.some((i) => i.isLedger);
  const [g, setG] = useState<Grants>({ levels: [], allow: [], deny: [] });
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (audience && !ready) { setG(initialGrants(items, audience)); setReady(true); }
  }, [audience]); // eslint-disable-line react-hooks/exhaustive-deps
  const [downloadable, setDownloadable] = useState(single?.downloadable ?? false);
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const needs = items.filter((i) => i.unchecked.length > 0);
  const granting = g.levels.length > 0 || g.allow.length > 0;
  const missingTicks = granting && needs.some((i) => !ticks[i.id]);

  const save = useMutation({
    mutationFn: async () => {
      if (single) {
        const r = await vdrFetch<{ newlyVisibleBuyers: number }>("PUT", `${roomBase(dealId)}/items/${single.id}/shares`, { ...g, checkedFlags: ticks[single.id] ? single.unchecked : [] });
        if (downloadable !== single.downloadable) await vdrFetch("PATCH", `${roomBase(dealId)}/items/${single.id}`, { downloadable });
        return { newlyVisibleBuyers: r?.newlyVisibleBuyers ?? 0, skipped: [] as BulkShareResult["skipped"] };
      }
      const before = initialGrants(items, audience);
      const body = {
        ...(target.kind === "folder" ? { folderId: target.folder.id } : { itemIds: items.map((i) => i.id) }),
        add: { levels: g.levels, allow: g.allow },
        remove: { levels: before.levels.filter((l) => !g.levels.includes(l)), allow: before.allow.filter((a) => !g.allow.includes(a)) },
        checkedFlags: Object.fromEntries(needs.filter((i) => ticks[i.id]).map((i) => [i.id, i.unchecked])),
      };
      const r = await vdrFetch<BulkShareResult>("POST", `${roomBase(dealId)}/shares/bulk`, body);
      return { newlyVisibleBuyers: r.newlyVisibleBuyers, skipped: r.skipped };
    },
    onSuccess: (r) => {
      invalidateRoom(dealId);
      const n = items.length - r.skipped.length;
      toast({
        title: single ? "Sharing saved" : `Sharing saved for ${n} ${n === 1 ? "document" : "documents"}`,
        description: r.skipped.length ? `${r.skipped.length} skipped: ${r.skipped.slice(0, 3).map((s) => `${s.title} (${s.reason})`).join("; ")}` : undefined,
      });
      onDone?.({ newlyVisibleBuyers: r.newlyVisibleBuyers });
    },
    onError: (e: Error) => toast({ title: "Couldn't save who can see it", description: e.message, variant: "destructive" }),
  });

  const turnOn = useMutation({
    mutationFn: (accessId: string) => vdrFetch("PATCH", `${roomBase(dealId)}/buyers/${accessId}`, { roomAccess: "on" }),
    onSuccess: () => invalidateRoom(dealId),
    onError: (e: Error) => toast({ title: "Couldn't turn on the data room", description: e.message, variant: "destructive" }),
  });

  if (isLoading || !audience || !ready) return <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading buyers…</div>;

  const toggleLevel = (l: string, on: boolean) => setG((x) => ({ ...x, levels: on ? Array.from(new Set([...x.levels, l])) : x.levels.filter((y) => y !== l) }));
  const buyerName = (id: string) => {
    const b = audience.buyers.find((x) => x.accessId === id);
    return b ? b.company || b.name || b.email : "A buyer";
  };
  const sees = whoSees(g, audience, anyLedger);
  const allowable = audience.buyers.filter((b) => !g.allow.includes(b.accessId) && !g.deny.includes(b.accessId) && (!anyLedger || b.dd));
  const hideable = audience.buyers.filter((b) => !g.deny.includes(b.accessId) && !g.allow.includes(b.accessId));

  return (
    <div className={cn("space-y-5 text-sm", inline && "pt-1")} data-testid="share-form">
      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">By access level</h4>
        <div className="space-y-2">
          {audience.levels.map((l) => {
            const disabled = anyLedger && l.key !== DD_ACCESS_LEVEL;
            return (
              <label key={l.key} className={cn("flex items-start gap-2.5", disabled && "opacity-50")}>
                <Checkbox checked={g.levels.includes(l.key)} disabled={disabled} onCheckedChange={(v) => toggleLevel(l.key, v === true)} className="mt-0.5" data-testid={`share-level-${l.key}`} />
                <span className="flex-1">
                  <span className="font-medium">{l.label}</span> <span className="text-muted-foreground">({l.buyers})</span>
                  {l.rule === "manual" && <span className="block text-xs text-muted-foreground">Only those you've given the data room.</span>}
                  {disabled && <span className="block text-xs text-muted-foreground">{LEDGER_COPY}</span>}
                </span>
              </label>
            );
          })}
          <p className="text-xs text-muted-foreground">Blind CIM and teaser buyers don't get a data room. Move a buyer to Full CIM to share documents.</p>
        </div>
      </section>

      <section>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Specific buyers</h4>
        <div className="flex flex-wrap gap-1.5">
          {g.allow.map((id) => {
            const b = audience.buyers.find((x) => x.accessId === id);
            return (
              <span key={id} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">
                {buyerName(id)}
                <button aria-label={`Remove ${buyerName(id)}`} onClick={() => setG((x) => ({ ...x, allow: x.allow.filter((y) => y !== id) }))}><X className="h-3 w-3" /></button>
                {b && !b.hasRoom && (
                  <span className="ml-1 text-[11px] text-teal">doesn't have the data room. <button className="underline" onClick={() => turnOn.mutate(id)} disabled={turnOn.isPending}>Turn on</button></span>
                )}
              </span>
            );
          })}
          <BuyerPicker label="Add a buyer" buyers={allowable} onPick={(id) => setG((x) => ({ ...x, allow: [...x.allow, id] }))} />
        </div>
        {audience.buyers.length === 0 && <p className="mt-1 text-xs text-muted-foreground">No buyer can have the data room yet: they need a Full CIM or due-diligence link and a signed NDA.</p>}
      </section>

      {single && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Hide it from</h4>
          <div className="flex flex-wrap gap-1.5">
            {g.deny.map((id) => (
              <span key={id} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted/40 px-2 py-0.5 text-xs">
                {buyerName(id)}
                <button aria-label={`Stop hiding from ${buyerName(id)}`} onClick={() => setG((x) => ({ ...x, deny: x.deny.filter((y) => y !== id) }))}><X className="h-3 w-3" /></button>
              </span>
            ))}
            <BuyerPicker label="Pick a buyer" buyers={hideable} onPick={(id) => setG((x) => ({ ...x, deny: [...x.deny, id] }))} />
          </div>
        </section>
      )}

      {single && (
        <section>
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Downloads</h4>
          <label className="flex items-start gap-2.5">
            <Switch checked={downloadable} onCheckedChange={setDownloadable} disabled={single.isLedger} data-testid="share-downloadable" />
            <span className="flex-1">
              <span className="font-medium">Let buyers download it</span>
              <span className="block text-xs text-muted-foreground">
                {single.isLedger ? "The general ledger can't be downloaded." : "PDFs and photos download as page images with the buyer's name on every page. Spreadsheets download as a values-only copy. Buyers also need downloads allowed on the Buyers tab."}
              </span>
            </span>
          </label>
        </section>
      )}

      {single && (
        <section>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">What buyers will read about it</h4>
          <p className="rounded-md border border-border bg-muted/20 px-3 py-2 text-sm text-foreground/90">
            {single.summary.status === "accepted" && single.summary.text && !single.summary.hidden ? single.summary.text : single.summary.basic}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">Edit it on the document's notes.</p>
        </section>
      )}

      {needs.length > 0 && granting && (
        <section className="rounded-md border border-teal/30 bg-teal/5 p-3">
          <h4 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-teal"><AlertTriangle className="h-3.5 w-3.5" /> Check first</h4>
          <div className="space-y-2.5">
            {needs.map((i) => (
              <label key={i.id} className="flex items-start gap-2.5">
                <Checkbox checked={!!ticks[i.id]} onCheckedChange={(v) => setTicks((t) => ({ ...t, [i.id]: v === true }))} className="mt-0.5" data-testid={`share-check-${i.id}`} />
                <span className="flex-1 text-sm">
                  {items.length > 1 && <span className="font-medium">{i.number} {i.title}: </span>}
                  {i.flags.filter((f) => i.unchecked.includes(f.key)).map((f) => f.copy).join(" ")}
                  <span className="block font-medium">Cimple couldn't check everything in this document. I've checked it.</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}

      <p className="rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground" data-testid="share-preview">
        {sees.length === 0
          ? "Nobody will see it yet."
          : `${sees.length} ${sees.length === 1 ? "buyer" : "buyers"} will see it now: ${sees.slice(0, 4).join(", ")}${sees.length > 4 ? ` and ${sees.length - 4} more` : ""}.`}
      </p>

      <div className={cn("flex justify-end gap-2", !inline && "pt-1")}>
        {onCancel && <Button variant="ghost" onClick={onCancel}>Cancel</Button>}
        <Button onClick={() => save.mutate()} disabled={save.isPending || missingTicks} data-testid="share-save">
          {save.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Save
        </Button>
      </div>
    </div>
  );
}

function BuyerPicker({ label, buyers, onPick }: { label: string; buyers: ShareAudience["buyers"]; onPick: (accessId: string) => void }) {
  const [value, setValue] = useState("");
  if (buyers.length === 0) return null;
  return (
    <Select value={value} onValueChange={(v) => { onPick(v); setValue(""); }}>
      <SelectTrigger className="h-7 w-auto gap-1 rounded-full border-dashed px-2.5 text-xs">
        <Plus className="h-3 w-3" /><SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {buyers.map((b) => (
          <SelectItem key={b.accessId} value={b.accessId} className="text-xs">
            {b.company || b.name || b.email} <span className="text-muted-foreground">· {b.levelLabel}{b.hasRoom ? "" : " · no data room yet"}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

