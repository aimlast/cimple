/**
 * CrmBuyerSyncCard — turns the broker's Pipedrive buyer contacts into
 * matchable buyer profiles (server/crm/buyer-sync.ts). Lives at the top of
 * the Buyers page: connect prompt, one-time setup (which Pipedrive contacts
 * are buyers), live progress, and "Sync now".
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { RefreshCw, Settings2, Loader2, Link2, Lock } from "lucide-react";

type Mode = "pipelines" | "labels" | "all";
interface SyncSettings { mode: Mode; pipelineIds?: number[]; labelIds?: number[]; auto: boolean }
interface SyncStatus {
  state: "idle" | "running" | "done" | "failed"; startedAt?: string; finishedAt?: string; total?: number; processed?: number;
  created?: number; updated?: number; unchanged?: number; skippedNoEmail?: number; errors?: number; message?: string;
}
interface SyncInfo {
  connected: boolean; settings?: SyncSettings | null; status?: SyncStatus | null; lastSuccessAt?: string | null;
  syncedCount?: number;
  options?: { pipelines: { id: number; name: string }[]; labels: { id: number; name: string }[]; error?: string } | null;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { credentials: "include" });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})))?.error || "Request failed");
  return r.json();
}

function ago(iso?: string | null) {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

export function CrmBuyerSyncCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [setupOpen, setSetupOpen] = useState(false);

  const { data } = useQuery<SyncInfo>({
    queryKey: ["/api/integrations/pipedrive/buyer-sync"],
    queryFn: () => getJson("/api/integrations/pipedrive/buyer-sync"),
    refetchInterval: (q) => (q.state.data?.status?.state === "running" ? 2000 : false),
  });
  const running = data?.status?.state === "running";

  // When a run finishes, refresh the buyer list so new profiles show up.
  const [wasRunning, setWasRunning] = useState(false);
  useEffect(() => {
    if (running) setWasRunning(true);
    else if (wasRunning) {
      setWasRunning(false);
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers"] });
      const s = data?.status;
      if (s?.state === "done") toast({ title: "Pipedrive buyers synced", description: `${(s.created ?? 0) + (s.updated ?? 0)} profiles built or refreshed · ${s.unchanged ?? 0} unchanged.` });
      if (s?.state === "failed") toast({ title: "Sync stopped", description: s.message || "Something went wrong reading Pipedrive.", variant: "destructive" });
    }
  }, [running]); // eslint-disable-line react-hooks/exhaustive-deps

  const start = async (settings: SyncSettings) => {
    const r = await fetch("/api/integrations/pipedrive/buyer-sync", {
      method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) { toast({ title: "Couldn't start the sync", description: body.error, variant: "destructive" }); return false; }
    await qc.invalidateQueries({ queryKey: ["/api/integrations/pipedrive/buyer-sync"] });
    return true;
  };

  if (!data) return null;

  if (!data.connected) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3" data-testid="crm-sync-card">
        <div className="text-sm">
          <span className="font-medium">Bring in your CRM buyers.</span>{" "}
          <span className="text-muted-foreground">Connect Pipedrive and Cimple builds a buyer profile for everyone in it, so Suggested buyers covers your whole list.</span>
        </div>
        <Link href="/broker/integrations">
          <Button size="sm" variant="outline" data-testid="button-connect-crm"><Link2 className="mr-1.5 h-3.5 w-3.5" /> Connect Pipedrive</Button>
        </Link>
      </div>
    );
  }

  const s = data.status;
  const pct = s?.total ? Math.round(((s.processed ?? 0) / s.total) * 100) : 0;
  return (
    <div className="rounded-lg border border-border bg-card px-4 py-3" data-testid="crm-sync-card">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0 text-sm">
          {!data.settings ? (
            <>
              <span className="font-medium">Pipedrive is connected.</span>{" "}
              <span className="text-muted-foreground">Turn your Pipedrive buyers into matchable buyer profiles.</span>
            </>
          ) : running ? (
            <span className="font-medium">Reading your Pipedrive buyers… {s?.processed ?? 0}{s?.total ? ` of ${s.total}` : ""}</span>
          ) : (
            <>
              <span className="font-medium">{data.syncedCount ?? 0} buyer profiles from Pipedrive</span>
              <span className="text-muted-foreground"> · synced {ago(data.lastSuccessAt || s?.finishedAt)}{data.settings.auto ? " · keeps itself up to date" : ""}</span>
              {s?.state === "failed" && <span className="text-red-400"> · last run failed</span>}
            </>
          )}
        </div>
        <div className="flex items-center gap-2">
          {data.settings && (
            <Button size="sm" variant="outline" disabled={running} onClick={() => void start(data.settings!)} data-testid="button-crm-sync-now">
              {running ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-1.5 h-3.5 w-3.5" />} Sync now
            </Button>
          )}
          <Button size="sm" variant={data.settings ? "ghost" : "default"} disabled={running} onClick={() => setSetupOpen(true)} data-testid="button-crm-sync-setup">
            {data.settings ? <Settings2 className="h-3.5 w-3.5" /> : "Set up buyer sync"}
          </Button>
        </div>
      </div>
      {running && <Progress value={pct} className="mt-2 h-1.5" />}
      {setupOpen && <SetupDialog current={data.settings ?? null} onClose={() => setSetupOpen(false)} onStart={start} />}
    </div>
  );
}

function SetupDialog({ current, onClose, onStart }: { current: SyncSettings | null; onClose: () => void; onStart: (s: SyncSettings) => Promise<boolean> }) {
  const { data, isLoading } = useQuery<SyncInfo>({
    queryKey: ["/api/integrations/pipedrive/buyer-sync", "options"],
    queryFn: () => getJson("/api/integrations/pipedrive/buyer-sync?options=1"),
  });
  const pipelines = data?.options?.pipelines ?? [];
  const labels = data?.options?.labels ?? [];
  const [mode, setMode] = useState<Mode>(current?.mode ?? "pipelines");
  const [pipelineIds, setPipelineIds] = useState<number[]>(current?.pipelineIds ?? []);
  const [labelIds, setLabelIds] = useState<number[]>(current?.labelIds ?? []);
  const [auto, setAuto] = useState(current?.auto ?? true);
  const [busy, setBusy] = useState(false);

  // First setup: pre-tick pipelines that look like buyer pipelines, else all.
  useEffect(() => {
    if (current || !pipelines.length) return;
    const buyerish = pipelines.filter((p) => /buyer|acqui|inquir|enquir|prospect/i.test(p.name)).map((p) => p.id);
    setPipelineIds(buyerish.length ? buyerish : pipelines.map((p) => p.id));
  }, [pipelines.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (current || !labels.length) return;
    setLabelIds(labels.filter((l) => /buyer/i.test(l.name)).map((l) => l.id));
  }, [labels.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (list: number[], id: number) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const valid = mode === "all" || (mode === "pipelines" ? pipelineIds.length > 0 : labelIds.length > 0);

  const option = (value: Mode, title: string, hint: string, extra?: React.ReactNode) => (
    <div className={`rounded-lg border p-3 ${mode === value ? "border-teal bg-teal/5" : "border-border"}`}>
      <label className="flex cursor-pointer items-start gap-2">
        <input type="radio" className="mt-1 accent-[hsl(var(--teal))]" checked={mode === value} onChange={() => setMode(value)} />
        <span>
          <span className="block text-sm font-medium">{title}</span>
          <span className="block text-xs text-muted-foreground">{hint}</span>
        </span>
      </label>
      {mode === value && extra}
    </div>
  );

  const checks = (items: { id: number; name: string }[], selected: number[], set: (v: number[]) => void, empty: string) => (
    <div className="mt-2 ml-6 flex max-h-40 flex-col gap-1 overflow-y-auto">
      {items.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : items.map((i) => (
        <label key={i.id} className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={selected.includes(i.id)} onChange={() => set(toggle(selected, i.id))} /> {i.name}
        </label>
      ))}
    </div>
  );

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Sync buyers from Pipedrive</DialogTitle>
          <DialogDescription>
            Cimple reads each buyer's Pipedrive record — notes, organisation, the listings they asked about — and builds a buyer profile for matching.
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-3">
            {data?.options?.error && <p className="text-xs text-red-400">{data.options.error}</p>}
            <p className="text-xs font-medium">Which Pipedrive contacts are buyers?</p>
            {option("pipelines", "People on deals in these pipelines (recommended)", "Everyone attached to a deal in your buyer pipeline(s) — e.g. each buyer enquiry.",
              checks(pipelines, pipelineIds, setPipelineIds, "No pipelines found."))}
            {option("labels", "People with these labels", "Use this if you tag buyers with a label in Pipedrive.",
              checks(labels, labelIds, setLabelIds, "No person labels found in Pipedrive."))}
            {option("all", "Everyone in Pipedrive", "Only if your Pipedrive holds buyers only — sellers and advisors would be included too.")}
            <div className="flex items-center justify-between rounded-lg border border-border p-3">
              <Label htmlFor="crm-auto" className="text-sm">Keep in sync automatically<span className="block text-xs font-normal text-muted-foreground">Picks up new buyers and changes every 6 hours.</span></Label>
              <Switch id="crm-auto" checked={auto} onCheckedChange={setAuto} />
            </div>
            <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
              <Lock className="mt-px h-3 w-3 shrink-0" />
              Nobody is emailed. What Cimple reads from your CRM stays private to you — buyers never see it, and neither do other brokers.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            disabled={!valid || busy || isLoading}
            onClick={async () => {
              setBusy(true);
              const ok = await onStart({ mode, pipelineIds: mode === "pipelines" ? pipelineIds : undefined, labelIds: mode === "labels" ? labelIds : undefined, auto });
              setBusy(false);
              if (ok) onClose();
            }}
            data-testid="button-crm-sync-start"
          >
            {busy ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null} Start sync
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
