/**
 * Setting up the data room (vdr spec §5.3): the "Set up the data room" card
 * (with the deal's documents listed below it, so files are reachable before
 * set-up) and step 2, "Who sees what" — the recommended sharing plan by
 * folder, the documents Cimple wants the broker to check first, and what
 * buyers will read about each document. Nothing is shared until the broker
 * confirms.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { AlertTriangle, FolderTree, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { DD_ACCESS_LEVEL } from "@shared/access-levels";
import type { BrokerRoomPayload } from "@shared/vdr-api";
import { invalidateRoom, roomBase, shortDate, usePlan, vdrFetch } from "@/hooks/useDataRoom";
import { queryClient } from "@/lib/queryClient";
import { PanelError } from "@/components/deal/PanelError";

export function SetUpCard({ dealId, data, onSetUp }: { dealId: string; data: BrokerRoomPayload; onSetUp: (mode: "auto" | "empty") => Promise<void> }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"auto" | "empty" | null>(null);
  const eligible = data.documents.filter((d) => d.roomMaterial).length;
  const file = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: async (files: File[]) => {
      for (const f of files) {
        const fd = new FormData();
        fd.append("file", f);
        fd.append("sourceKind", "document");
        const res = await fetch(`/api/deals/${dealId}/documents/upload`, { method: "POST", body: fd, credentials: "include" });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(typeof j?.error === "string" ? j.error : `Couldn't upload ${f.name}`);
        }
      }
    },
    onSuccess: () => { invalidateRoom(dealId); queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] }); toast({ title: "Uploaded" }); },
    onError: (e: Error) => toast({ title: "Upload failed", description: e.message, variant: "destructive" }),
  });
  const go = async (mode: "auto" | "empty") => { setBusy(mode); try { await onSetUp(mode); } finally { setBusy(null); } };
  return (
    <div className="space-y-6">
      <div className="mx-auto max-w-2xl rounded-xl border border-border bg-card px-6 py-8 text-center sm:px-10" data-testid="room-setup-card">
        <FolderTree className="mx-auto h-8 w-8 text-teal" />
        <h2 className="mt-3 text-lg font-semibold">Set up the data room</h2>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {eligible === 0
            ? "No documents yet. Upload some, or ask the seller for them from the checklist."
            : `Cimple will sort this deal's ${eligible} ${eligible === 1 ? "document" : "documents"} into a standard data room: Financial, Legal & corporate, Operations, People, Licences & compliance. Then you choose who sees what. Buyers see nothing until you confirm. Emails, call notes and CRM notes stay out.`}
        </p>
        <div className="mt-5 flex flex-col items-center justify-center gap-2 sm:flex-row">
          <Button onClick={() => go("auto")} disabled={!!busy} data-testid="room-setup">{busy === "auto" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Set up the data room</Button>
          <Button variant="ghost" onClick={() => go("empty")} disabled={!!busy}>{busy === "empty" && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Start with empty folders</Button>
        </div>
      </div>
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">Documents in this deal ({data.documents.length})</h3>
          <Button size="sm" variant="outline" onClick={() => file.current?.click()} disabled={upload.isPending}>{upload.isPending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Upload className="mr-1.5 h-3.5 w-3.5" />} Upload</Button>
          <input ref={file} type="file" multiple className="hidden" accept=".pdf,.txt,.csv,.md,.xlsx,.xls,.pptx,.docx" onChange={(e) => { const f = Array.from(e.target.files ?? []); e.target.value = ""; if (f.length) upload.mutate(f); }} />
        </div>
        {data.documents.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border px-6 py-8 text-center text-sm text-muted-foreground">Nothing uploaded yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border bg-card">
            {data.documents.map((d) => (
              <div key={d.id} className="flex items-center gap-3 border-b border-border px-3 py-2.5 text-sm last:border-0">
                <span className="min-w-0 flex-1 truncate">{d.name}</span>
                <span className="hidden text-xs text-muted-foreground sm:inline">{d.typeLabel}</span>
                <span className="text-xs text-muted-foreground">{d.uploadedBy === "seller" ? "Seller" : "You"} · {shortDate(d.createdAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function SharingPlan({ dealId, data, onDone }: { dealId: string; data: BrokerRoomPayload; onDone: () => void }) {
  const { toast } = useToast();
  const { data: plan, isLoading, error, refetch } = usePlan(dealId, true);
  const [levels, setLevels] = useState<Record<string, "dd" | "not_yet">>({});
  const [ticks, setTicks] = useState<Record<string, boolean>>({});
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    if (plan) setLevels(Object.fromEntries(plan.folders.map((f) => [f.folderId, f.levels.length ? "dd" : "not_yet"])));
  }, [plan]);
  const flaggedIds = useMemo(() => new Set(plan?.flagged.map((f) => f.itemId) ?? []), [plan]);
  const live = data.items.filter((i) => !i.removed);
  const willShare = live.filter((i) => levels[i.folderId] === "dd" && (!flaggedIds.has(i.id) || ticks[i.id])).length;
  const checking = live.filter((i) => !i.prepared || i.prepared.status === "pending").length;
  const confirm = useMutation({
    mutationFn: () => vdrFetch<{ shared: number; newlyVisibleBuyers: number }>("POST", `${roomBase(dealId)}/plan`, {
      folders: (plan?.folders ?? []).map((f) => ({ folderId: f.folderId, levels: levels[f.folderId] === "dd" ? [DD_ACCESS_LEVEL] : [] })),
      includeFlagged: Object.entries(ticks).filter(([, v]) => v).map(([k]) => k),
      acceptSummaries: [],
    }),
    onSuccess: (r) => {
      invalidateRoom(dealId);
      toast({ title: r.shared ? `Shared ${r.shared} ${r.shared === 1 ? "document" : "documents"} with due diligence buyers.` : "Sharing plan saved", description: r.newlyVisibleBuyers ? `${r.newlyVisibleBuyers} ${r.newlyVisibleBuyers === 1 ? "buyer can" : "buyers can"} open them now.` : undefined });
      onDone();
    },
    onError: (e: Error) => toast({ title: "Couldn't apply the plan", description: e.message, variant: "destructive" }),
  });

  if (isLoading) return <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  if (error || !plan) return <PanelError what="the sharing plan" onRetry={() => refetch()} />;
  const summaries = showAll ? plan.summaries : plan.summaries.slice(0, 5);
  return (
    <div className="mx-auto max-w-3xl space-y-6" data-testid="sharing-plan">
      <div>
        <h2 className="text-lg font-semibold">Who sees what</h2>
        <p className="mt-1 text-sm text-muted-foreground">Our recommendation for a typical sale. Due diligence buyers are the ones you've moved to due diligence (usually after an LOI). You can change any of this later.</p>
      </div>
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {plan.folders.length === 0 && <p className="px-4 py-8 text-center text-sm text-muted-foreground">No folder holds documents yet.</p>}
        {plan.folders.map((f) => (
          <div key={f.folderId} className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3 last:border-0">
            <span className="w-9 font-mono text-[11px] text-muted-foreground">{f.number}</span>
            <span className="min-w-0 flex-1 text-sm">{f.name} <span className="text-muted-foreground">({f.documents})</span></span>
            <Select value={levels[f.folderId] ?? "not_yet"} onValueChange={(v) => setLevels((l) => ({ ...l, [f.folderId]: v as "dd" | "not_yet" }))}>
              <SelectTrigger className="h-8 w-[200px] text-xs" data-testid={`plan-${f.folderId}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="dd" className="text-xs">Due diligence buyers</SelectItem>
                <SelectItem value="not_yet" className="text-xs">Not yet</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>

      {plan.flagged.length > 0 && (
        <section className="rounded-lg border border-teal/30 bg-teal/5 p-4">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-teal"><AlertTriangle className="h-4 w-4" /> Check these yourself first ({plan.flagged.length})</h3>
          <div className="mt-3 space-y-3">
            {plan.flagged.map((f) => (
              <label key={f.itemId} className="flex items-start gap-2.5 text-sm">
                <Checkbox checked={!!ticks[f.itemId]} onCheckedChange={(v) => setTicks((t) => ({ ...t, [f.itemId]: v === true }))} className="mt-0.5" />
                <span className="flex-1">
                  <span className="font-medium"><span className="mr-1.5 font-mono text-[11px] text-muted-foreground">{f.number}</span>{f.title}</span>
                  <span className="block text-xs text-muted-foreground">{f.flags.map((x) => x.copy).join(" ")}</span>
                  <span className="block text-xs">I've checked it, include it</span>
                </span>
              </label>
            ))}
          </div>
        </section>
      )}
      {checking > 0 && (
        <p className="flex items-start gap-2 rounded-md bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" /> Cimple is still checking {checking} {checking === 1 ? "document" : "documents"}. Any that need a look will wait for your tick before buyers can open them.
        </p>
      )}

      <section>
        <h3 className="text-sm font-semibold">What buyers will read about each document</h3>
        <p className="mt-1 text-xs text-muted-foreground">Until you write or accept a description, buyers see a short basic line. You can write your own on any document.</p>
        <div className="mt-2 overflow-hidden rounded-lg border border-border bg-card">
          {summaries.map((s) => (
            <div key={s.itemId} className="border-b border-border px-4 py-2.5 last:border-0">
              <p className="text-sm font-medium">{s.title}</p>
              <p className="text-xs text-muted-foreground">{s.status === "accepted" && s.text ? s.text : s.basic}</p>
            </div>
          ))}
        </div>
        {plan.summaries.length > 5 && <button className="mt-1.5 text-xs text-teal underline-offset-2 hover:underline" onClick={() => setShowAll((v) => !v)}>{showAll ? "Show fewer" : `Show all ${plan.summaries.length}`}</button>}
      </section>

      <div className="flex flex-col-reverse gap-2 border-t border-border pt-4 sm:flex-row sm:justify-end">
        <Button variant="ghost" onClick={onDone}>Skip for now</Button>
        <Button onClick={() => confirm.mutate()} disabled={confirm.isPending} data-testid="plan-confirm">
          {confirm.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Confirm and share {willShare} {willShare === 1 ? "document" : "documents"}
        </Button>
      </div>
    </div>
  );
}
