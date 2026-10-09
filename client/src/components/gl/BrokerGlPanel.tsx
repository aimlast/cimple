/**
 * BrokerGlPanel — Financials → "Add-backs in the books" (gl spec §3.4), a
 * dashboard: five KPI cells on top (the ledger, whether it matches the
 * statements, the add-backs, the seller, buyers), then one view at a time
 * (in the URL, &gl=): the add-backs × years grid · the ledger files · the
 * tie-out with the statements · what the seller mentioned and what Cimple
 * noticed. An add-back opens in a drawer (&addback=…&year=…).
 *
 * variant "ledgers-only": before the financial analysis exists, just the
 * ledger files (the general ledger can come in any time).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import {
  AlertTriangle, BookCheck, CheckCircle2, ChevronDown, ChevronRight, Eye, FileSpreadsheet, FileWarning, Loader2, Lock, RefreshCw, Send, Settings2, UserPlus, XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { sendJson, type BrokerGlData, type BrokerTrace } from "@/lib/gl-api";
import { useBrokerGl, invalidateGl } from "@/hooks/useGlStatus";
import { PanelError } from "@/components/deal/PanelError";
import { LedgerUpload } from "./LedgerUpload";
import { ExportHelp } from "./ExportHelp";
import { exportRange } from "./export-help";
import { GlLedgerViewer } from "./GlLedgerViewer";
import { GlKpiStrip, type GlView } from "./GlKpiStrip";
import { AddbackGrid } from "./AddbackGrid";
import { AddbackTraceDetail } from "./AddbackTraceDetail";
import { SendToSellerDialog } from "./SendToSellerDialog";
import { TieOutPanel } from "./TieOutPanel";
import { SuggestionsPanel } from "./SuggestionsPanel";
import { ColumnMappingDialog } from "./ColumnMappingDialog";
import { WaiveDialog } from "./GlGenerationNotice";
import { EvidencePreviewSheet, PublishEvidenceDialog } from "./PublishEvidenceDialog";
import { shortDate } from "./gl-ui";
import { formatCount, formatPeriod, ledgerStatusWords, softwareLabel } from "@shared/gl-copy";
import { primarySellerInvite } from "@shared/seller-invite-revocation";
import type { GlLedgerView } from "@shared/gl-types";
import type { SellerInvite } from "@shared/schema";

const VIEWS: Array<{ key: GlView; label: string; short: string }> = [
  { key: "addbacks", label: "Add-backs", short: "Add-backs" },
  { key: "ledger", label: "Ledger", short: "Ledger" },
  { key: "statements", label: "Matches the statements", short: "Statements" },
  { key: "seller", label: "From the seller", short: "Seller" },
];

const FYE_OPTIONS: Array<[string, string]> = [
  ["01-31", "Jan 31"], ["02-28", "Feb 28"], ["03-31", "Mar 31"], ["04-30", "Apr 30"], ["05-31", "May 31"], ["06-30", "Jun 30"],
  ["07-31", "Jul 31"], ["08-31", "Aug 31"], ["09-30", "Sep 30"], ["10-31", "Oct 31"], ["11-30", "Nov 30"], ["12-31", "Dec 31"],
];

/** The panel's view and the open add-back, in the URL (?fin=books&gl=…&addback=…&year=…). */
function usePanelUrl() {
  const [location, setLocation] = useLocation();
  const search = useSearch();
  const params = new URLSearchParams(search);
  const raw = params.get("gl");
  const view: GlView = VIEWS.some((v) => v.key === raw) ? (raw as GlView) : "addbacks";
  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) if (v === null) next.delete(k); else next.set(k, v);
    const qs = next.toString();
    setLocation(`${location}${qs ? `?${qs}` : ""}`, { replace: true });
  };
  return { view, addback: params.get("addback"), year: params.get("year"), set };
}

export function BrokerGlPanel({ dealId, variant = "full" }: { dealId: string; variant?: "full" | "ledgers-only" }) {
  const { data, isLoading, error, refetch } = useBrokerGl(dealId);
  const url = usePanelUrl();
  const [sending, setSending] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const { data: invites = [] } = useQuery<SellerInvite[]>({
    queryKey: ["/api/deals", dealId, "invites"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/invites`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load seller invites");
      return r.json();
    },
    enabled: variant === "full",
  });
  const primary = primarySellerInvite(invites as any) as SellerInvite | undefined;
  const previewHref = primary ? `/seller/${primary.token}/books` : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground gap-2" data-testid="gl-panel-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the general ledger…
      </div>
    );
  }
  if (error || !data) return <PanelError what="the general ledger" onRetry={() => refetch()} />;
  if (variant === "ledgers-only") return <LedgersView dealId={dealId} data={data} />;

  const traces = data.traces ?? [];
  const open = url.addback ? traces.find((t) => t.id === url.addback) ?? null : null;
  const toGoBadge = data.gate?.state === "with_broker" ? data.gate.toGo : 0;
  const sellerBadge = (data.suggestions?.length ?? 0) + (data.tracing?.accountantRequest && !data.tracing.accountantRequest.sentAt && !data.tracing.accountantRequest.declinedAt ? 1 : 0);

  return (
    <div className="space-y-4" data-testid="gl-panel">
      <div className="flex items-start gap-3">
        <div className="h-9 w-9 rounded-lg bg-teal/10 flex items-center justify-center shrink-0">
          <BookCheck className="h-4 w-4 text-teal" />
        </div>
        <div className="min-w-0">
          <h3 className="text-base font-semibold tracking-tight">Add-backs in the books</h3>
          <p className="text-sm text-muted-foreground mt-0.5">
            Due-diligence buyers ask to see the entries behind every add-back. Cimple asks the seller for the right proof — ledger entries, {data.payDoc?.slips ?? "pay slips"} or invoices — suggests the likely entries, and the seller confirms them. You review the result.
          </p>
        </div>
      </div>

      {data.tracesError ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm flex flex-wrap items-center gap-2" data-testid="gl-traces-error">
          <AlertTriangle className="h-4 w-4 text-amber-500" /> The add-backs couldn't load right now. The ledger files are still here.
          <Button size="sm" variant="outline" className="h-7 text-xs ml-auto" onClick={() => refetch()}>Try again</Button>
        </div>
      ) : (
        <GlKpiStrip data={data} onOpen={(v) => url.set({ gl: v === "addbacks" ? null : v, addback: null, year: null })} onBuyers={() => setPublishing(true)} />
      )}

      {!data.tracesError && <RequestStrip dealId={dealId} data={data} onSend={() => setSending(true)} />}

      {/* One view at a time */}
      <div className="border-b border-border">
        <div className="flex gap-1 overflow-x-auto -mb-px" role="tablist" aria-label="Add-backs in the books">
          {VIEWS.map((v) => {
            const badge = v.key === "addbacks" ? toGoBadge : v.key === "seller" ? sellerBadge : 0;
            return (
              <button key={v.key} type="button" role="tab" aria-selected={url.view === v.key}
                onClick={() => url.set({ gl: v.key === "addbacks" ? null : v.key, addback: null, year: null })}
                className={cn("shrink-0 px-2.5 sm:px-3 py-2 text-sm border-b-2 transition-colors min-h-[40px]", url.view === v.key ? "border-teal text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
                data-testid={`gl-view-${v.key}`}>
                <span className="hidden sm:inline">{v.label}</span><span className="sm:hidden">{v.short}</span>
                {badge > 0 && <span className="ml-1.5 inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-teal/15 px-1 text-2xs text-teal">{badge}</span>}
              </button>
            );
          })}
        </div>
      </div>

      {url.view === "addbacks" && data.tracesError && <LedgersView dealId={dealId} data={data} />}
      {url.view === "addbacks" && !data.tracesError && <AddbacksView dealId={dealId} data={data} onOpen={(t, y) => url.set({ addback: t.id, year: y ?? null })} onSend={() => setSending(true)} onLedger={() => url.set({ gl: "ledger" })} onPublish={() => setPublishing(true)} />}
      {url.view === "ledger" && <LedgersView dealId={dealId} data={data} />}
      {url.view === "statements" && <TieOutPanel dealId={dealId} data={data} onUploadAdjustments={() => url.set({ gl: "ledger" })} />}
      {url.view === "seller" && <SuggestionsPanel dealId={dealId} data={data} />}

      <Sheet open={!!open} onOpenChange={(o) => !o && url.set({ addback: null, year: null })}>
        <SheetContent side="right" className="w-full sm:max-w-xl p-4 sm:p-6 overflow-y-auto" data-testid="gl-drawer-sheet" onOpenAutoFocus={(e) => e.preventDefault()}>
          <SheetHeader className="text-left">
            <SheetTitle className="pr-6 break-words">{open?.label}</SheetTitle>
            <SheetDescription>Where this add-back is in the books.</SheetDescription>
          </SheetHeader>
          {open && <div className="mt-4"><AddbackTraceDetail key={open.id} dealId={dealId} trace={open} initialYear={url.year} docShort={data.payDoc?.short ?? "document"} payDoc={data.payDoc} onClose={() => url.set({ addback: null, year: null })} /></div>}
        </SheetContent>
      </Sheet>

      <SendToSellerDialog open={sending} onOpenChange={setSending} dealId={dealId} data={data} previewHref={previewHref} />
      <PublishEvidenceDialog open={publishing} onOpenChange={setPublishing} dealId={dealId} />
    </div>
  );
}

/** The request's state, the accountant hand-off, "can't get the ledger", going ahead without it, the hold switch. */
function RequestStrip({ dealId, data, onSend }: { dealId: string; data: BrokerGlData; onSend: () => void }) {
  const { toast } = useToast();
  const [waiving, setWaiving] = useState(false);
  const act = useMutation({
    mutationFn: ({ method = "POST", url, body }: { method?: string; url: string; body?: unknown }) => sendJson<{ demo?: boolean }>(method, url, body ?? {}),
    onSuccess: () => invalidateGl(dealId),
    onError: (e: unknown) => toast({ title: "That didn't work", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const tr = data.tracing;
  const gate = data.gate;
  if (!tr || !gate || gate.state === "not_needed") return null;
  const seller = data.seller?.name || "the seller";
  const first = seller.split(/\s+/)[0];
  const traces = (data.traces ?? []).filter((t) => t.sentAt && t.proof !== "statement");
  const doneCount = traces.filter((t) => ["done", "not_in_ledger", "disputed"].includes(t.sellerStatus)).length;
  const acc = tr.accountantRequest && !tr.accountantRequest.sentAt && !tr.accountantRequest.declinedAt ? tr.accountantRequest : null;
  const hasLedger = data.ledgers.some((l) => l.status === "ready" && l.audience === "shared");
  return (
    <div className="space-y-2" data-testid="gl-request-strip">
      {acc && (
        <div className="rounded-lg border border-teal/30 bg-teal/5 p-3 flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="gl-accountant-callout">
          <UserPlus className="h-4 w-4 text-teal shrink-0" />
          <p className="text-sm flex-1">{first} asked to bring in their accountant, <strong>{acc.name}</strong> ({acc.email}). Nothing has been sent.</p>
          <div className="flex gap-2">
            <Button size="sm" className="h-8 text-xs bg-teal text-teal-foreground hover:bg-teal/90" disabled={act.isPending}
              onClick={() => act.mutate({ url: `/api/deals/${dealId}/gl/accountant/send` }, { onSuccess: (r) => toast({ title: `${acc.name} has their own link`, description: r?.demo ? "This is a demo deal — nothing was emailed." : undefined }) })}>Send it</Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={act.isPending} onClick={() => act.mutate({ url: `/api/deals/${dealId}/gl/accountant/decline` })}>Not now</Button>
          </div>
        </div>
      )}
      {tr.cantGetLedger && !hasLedger && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" />
          <span>{first} can't get the general ledger{tr.cantGetLedger.reason === "no_software" ? " — they don't use accounting software" : tr.cantGetLedger.note ? `: "${tr.cantGetLedger.note}"` : ""}. Ask for another way, like bank statements, or go ahead without the ledger.</span>
        </div>
      )}
      {gate.state === "waived" && tr.waived ? (
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm flex flex-col gap-2 sm:flex-row sm:items-center">
          <p className="flex-1">You went ahead without the ledger on {shortDate(tr.waived.at)}: "{tr.waived.reason}"</p>
          <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={act.isPending} onClick={() => act.mutate({ method: "DELETE", url: `/api/deals/${dealId}/gl/waive` })}>Undo</Button>
        </div>
      ) : tr.requestedAt && !tr.withdrawnAt ? (
        <div className="rounded-lg border border-border bg-card p-3 flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="gl-with-seller">
          <p className="text-sm flex-1">
            Sent to {seller} on {shortDate(tr.requestedAt)} · {tr.sellerDoneAt ? (gate.state === "done" ? `finished ${shortDate(tr.sellerDoneAt)} · you've reviewed every add-back` : `finished ${shortDate(tr.sellerDoneAt)} — your turn to review`) : !hasLedger ? "waiting for the ledger" : `checking entries: ${doneCount} of ${traces.length} done`}
          </p>
          <div className="flex flex-wrap gap-2">
            {!tr.sellerDoneAt && <Button size="sm" variant="outline" className="h-8 text-xs" disabled={act.isPending} onClick={() => act.mutate({ url: `/api/deals/${dealId}/gl/remind` }, { onSuccess: (r) => toast({ title: "Reminder sent", description: r?.demo ? "This is a demo deal — nothing was emailed." : undefined }) })}>Remind {first}</Button>}
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onSend}>Send more costs</Button>
            {!tr.sellerDoneAt && <Button size="sm" variant="ghost" className="h-8 text-xs text-muted-foreground" disabled={act.isPending} onClick={() => act.mutate({ url: `/api/deals/${dealId}/gl/withdraw` })}>Withdraw the request</Button>}
          </div>
        </div>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2">
          <Switch id="gl-hold" checked={tr.requireBeforeCim} onCheckedChange={(v) => act.mutate({ method: "PATCH", url: `/api/deals/${dealId}/gl/settings`, body: { requireBeforeCim: v } })} disabled={act.isPending} />
          <Label htmlFor="gl-hold" className="text-xs font-normal">Hold the whole CIM until this is done</Label>
        </div>
        {gate.state !== "waived" && gate.state !== "done" && (
          <button type="button" className="text-xs text-muted-foreground hover:text-foreground hover:underline text-left" onClick={() => setWaiving(true)} data-testid="gl-waive-open">Go ahead without the ledger…</button>
        )}
      </div>
      <WaiveDialog dealId={dealId} open={waiving} onOpenChange={setWaiving} />
    </div>
  );
}

function AddbacksView({ dealId, data, onOpen, onSend, onLedger, onPublish }: { dealId: string; data: BrokerGlData; onOpen: (t: BrokerTrace, y?: string) => void; onSend: () => void; onLedger: () => void; onPublish: () => void }) {
  const { toast } = useToast();
  const [statementsOpen, setStatementsOpen] = useState(false);
  const [seeing, setSeeing] = useState(false);
  const act = useMutation({
    mutationFn: ({ url, body }: { url: string; body?: unknown }) => sendJson<{ reviewed?: number }>("POST", url, body ?? {}),
    onSuccess: () => invalidateGl(dealId),
    onError: (e: unknown) => toast({ title: "That didn't work", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  if (data.tracesError) return null;
  if (!data.analysis?.present) {
    return <EmptyState text="Run the financial analysis first. The add-backs it finds are what the seller shows in their books." />;
  }
  const traces = data.traces ?? [];
  const needs = traces.filter((t) => t.proof !== "statement");
  const statements = traces.filter((t) => t.proof === "statement");
  if (needs.length === 0) return <EmptyState text="None of the add-backs need proof from the books — they all come straight from the financial statements." />;
  const requested = !!data.tracing?.requestedAt && !data.tracing.withdrawnAt;
  const canReviewAll = needs.some((t) => !t.reviewedAt && t.includeInCim && t.computed?.suggestedVerdict === "found");
  const gateDone = data.gate?.state === "done" || data.gate?.state === "waived";
  const shownAt = data.buyers?.publishedAt ?? null;
  const changes = data.buyers?.changes ?? [];
  return (
    <div className="space-y-3" data-testid="gl-addbacks-view">
      {shownAt && (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3 flex flex-col gap-2 sm:flex-row sm:items-center" data-testid="gl-shown-strip">
          <div className="flex-1 min-w-0 text-sm">
            <p>Shown to buyers since {shortDate(shownAt)}.</p>
            {changes.length > 0 && (
              <details className="mt-0.5 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{changes.length} change{changes.length === 1 ? "" : "s"} since then</summary>
                <ul className="mt-1 list-disc pl-4 space-y-0.5">{changes.map((c) => <li key={c}>{c}</li>)}</ul>
              </details>
            )}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={onPublish} data-testid="gl-update-buyers">Update what buyers see…</Button>
            <Button size="sm" variant="ghost" className="h-8 text-xs gap-1" onClick={() => setSeeing(true)}><Eye className="h-3.5 w-3.5" /> See what buyers see</Button>
          </div>
        </div>
      )}
      <EvidencePreviewSheet dealId={dealId} open={seeing} onOpenChange={setSeeing} source="preview" />
      {!requested && data.gate?.state !== "waived" && (
        <div className="rounded-lg border border-teal/30 bg-teal/5 p-4 space-y-3" data-testid="gl-setup">
          <p className="text-sm font-medium">Show where each add-back is in the books</p>
          <p className="text-sm text-muted-foreground">
            {needs.length} add-back{needs.length === 1 ? "" : "s"} need{needs.length === 1 ? "s" : ""} proof. Cimple asks the seller for the right kind for each — and when a ledger is on file it has already found the likely entries, so the seller mostly confirms.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5" onClick={onSend} data-testid="gl-ask-seller"><Send className="h-4 w-4" /> Ask the seller…</Button>
            {!data.ledgers.some((l) => l.status === "ready") && <Button variant="outline" onClick={onLedger}>Upload the ledger myself</Button>}
          </div>
        </div>
      )}
      {(canReviewAll || !shownAt) && (
        <div className="flex flex-wrap justify-end gap-2">
          {canReviewAll && (
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" disabled={act.isPending}
              onClick={() => act.mutate({ url: `/api/deals/${dealId}/gl/review-found` }, { onSuccess: (r) => toast({ title: `${r?.reviewed ?? 0} marked reviewed` }) })} data-testid="gl-review-found">
              <CheckCircle2 className="h-3.5 w-3.5" /> Mark all that add up as reviewed
            </Button>
          )}
          {!shownAt && (
            <Button size="sm" className="h-8 text-xs gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" disabled={!gateDone} onClick={onPublish}
              title={gateDone ? undefined : "Review every add-back first"} data-testid="gl-show-buyers">
              <BookCheck className="h-3.5 w-3.5" /> Show to buyers…
            </Button>
          )}
        </div>
      )}
      <AddbackGrid traces={needs} onOpen={onOpen} busy={act.isPending}
        onReview={(t) => act.mutate({ url: `/api/deals/${dealId}/gl/traces/${t.id}/review`, body: { verdict: t.computed?.suggestedVerdict ?? "not_found" } })} />
      {statements.length > 0 && (
        <div className="rounded-lg border border-border">
          <button type="button" className="w-full flex items-center gap-2 px-3 py-2 text-sm text-left" onClick={() => setStatementsOpen((v) => !v)} aria-expanded={statementsOpen}>
            {statementsOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            From the financial statements ({statements.length}) — nothing needed
          </button>
          {statementsOpen && (
            <ul className="border-t border-border divide-y divide-border">
              {statements.map((t) => (
                <li key={t.id}><button type="button" className="w-full text-left px-3 py-2 text-sm hover:bg-muted/30" onClick={() => onOpen(t)}>{t.label}</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return <p className="text-sm text-muted-foreground rounded-lg border border-dashed border-border px-4 py-8 text-center" data-testid="gl-empty">{text}</p>;
}

/** The ledger files: upload, status, read again, share, open, the column dialog. */
function LedgersView({ dealId, data }: { dealId: string; data: BrokerGlData }) {
  const { toast } = useToast();
  const [viewing, setViewing] = useState<GlLedgerView | null>(null);
  const [keepPrivate, setKeepPrivate] = useState(false);
  const [adjustments, setAdjustments] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [addingFile, setAddingFile] = useState(false);
  const [shareFor, setShareFor] = useState<GlLedgerView | null>(null);
  const [notLedgerFor, setNotLedgerFor] = useState<GlLedgerView | null>(null);
  const [columnsFor, setColumnsFor] = useState<GlLedgerView | null>(null);
  const [fyeTo, setFyeTo] = useState<string | null>(null);
  const fyeByBroker = !!data.tracing?.fiscalYearEndByBroker;
  const invalidate = () => invalidateGl(dealId);
  const act = useMutation({
    mutationFn: ({ url, body, method = "POST" }: { url: string; body?: unknown; method?: string }) => sendJson(method, url, body ?? {}),
    onSuccess: () => invalidate(),
    onError: (err: unknown) => toast({ title: "That didn't work", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });
  const range = useMemo(() => exportRange(data.fiscalYearEnd ?? null, data.requestedYears ?? []), [data.fiscalYearEnd, data.requestedYears]);
  const ledgers = data.ledgers ?? [];
  const uploadState = ledgers.map((l) => ({ ...l, progress: l.progress ? { rowsRead: l.progress.rowsRead } : null }));
  const fields: Record<string, string> = {};
  if (keepPrivate) fields.visibility = "broker_only";
  if (adjustments) fields.role = "adjustments";
  return (
    <div className="space-y-4" data-testid="gl-ledgers-view">
      <section className="rounded-lg border border-border bg-card" aria-labelledby="gl-ledgers-title">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-border">
          <h4 id="gl-ledgers-title" className="text-sm font-medium flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" /> General ledger
          </h4>
          <span className="text-xs text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1">
            {ledgers.length === 0 ? "Not uploaded yet" : `${ledgers.length} file${ledgers.length === 1 ? "" : "s"}`}
            {/* The dot only where both sit on one line (phones wrap them onto two). */}
            <span className="flex items-center gap-1"><span aria-hidden="true" className="hidden sm:inline">·</span> Fiscal year ends
              <select className="h-7 rounded-md border border-input bg-background px-1.5 text-xs" value={data.fiscalYearEnd ?? "12-31"} aria-label="Fiscal year end"
                onChange={(e) => setFyeTo(e.target.value)} data-testid="gl-fye">
                {FYE_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                {data.fiscalYearEnd && !FYE_OPTIONS.some(([v]) => v === data.fiscalYearEnd) && <option value={data.fiscalYearEnd}>{data.fiscalYearEnd}</option>}
                {fyeByBroker && <option value="auto">Work it out from the deal's facts</option>}
              </select>
              {!fyeByBroker && <span className="text-2xs" data-testid="gl-fye-auto">(from the deal's facts)</span>}
            </span>
          </span>
        </div>

        {ledgers.length > 0 && (
          <ul className="divide-y divide-border" data-testid="gl-ledger-list">
            {ledgers.map((l) => (
              <LedgerRow
                key={l.id}
                ledger={l}
                busy={act.isPending}
                onOpen={() => setViewing(l)}
                onReread={() => act.mutate({ url: `/api/deals/${dealId}/gl/ledgers/${l.id}/reread` })}
                onShare={() => setShareFor(l)}
                onNotLedger={() => setNotLedgerFor(l)}
                onColumns={() => setColumnsFor(l)}
              />
            ))}
          </ul>
        )}

        {(data.unread.length > 0) && (
          <div className="px-4 py-3 border-t border-border space-y-2" data-testid="gl-unread">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {data.unread.every((u) => u.reason === "maybe") ? "Might one of these be the general ledger?" : "Ledgers Cimple hasn't read yet"}
            </p>
            {data.unread.map((u) => (
              <div key={u.documentId} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" data-testid={`gl-unread-${u.reason}`}>
                <div className="min-w-0">
                  <p className="text-sm break-words">{u.name}</p>
                  {u.reason === "pdf" && <p className="text-xs text-muted-foreground">A PDF ledger can't be matched entry by entry — ask for the Excel or CSV export.</p>}
                  {u.reason === "maybe" && <p className="text-xs text-muted-foreground">Laid out like a ledger, so Cimple read it as an ordinary document. If it is the general ledger, read it as one.</p>}
                </div>
                {(u.reason === "not_read" || u.reason === "maybe") && (
                  <div className="flex gap-2 shrink-0">
                    {u.reason === "maybe" && (
                      <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={act.isPending}
                        onClick={() => act.mutate({ url: `/api/deals/${dealId}/gl/maybe-ledgers/${u.documentId}/dismiss`, body: {} })} data-testid="gl-maybe-dismiss">
                        It isn't
                      </Button>
                    )}
                    <Button size="sm" variant="outline" className="h-8 text-xs" disabled={act.isPending}
                      onClick={() => act.mutate({ url: `/api/deals/${dealId}/gl/ledgers/read-as-ledger`, body: { documentId: u.documentId } })} data-testid="gl-read-as-ledger">
                      Read it as a ledger
                    </Button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {ledgers.length > 0 && !addingFile ? (
          <div className="px-4 py-3 border-t border-border flex flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
            <Button size="sm" variant="ghost" className="h-auto min-h-8 py-1.5 text-xs gap-1.5 -ml-2 whitespace-normal text-left" onClick={() => setAddingFile(true)} data-testid="gl-add-file">
              <FileSpreadsheet className="h-3.5 w-3.5 shrink-0" /> Upload another file
            </Button>
            <span className="text-2xs text-muted-foreground">Another year, or the accountant's year-end adjusting entries.</span>
          </div>
        ) : (
        <div className="px-4 py-4 border-t border-border space-y-3" data-testid="gl-broker-upload">
          {ledgers.length === 0 && (
            <p className="text-sm text-muted-foreground">
              The seller can upload it from their Documents page, or you can upload it here. Ask for <strong className="text-foreground">{range.start} – {range.end}</strong>, on an accrual basis.
            </p>
          )}
          <LedgerUpload
            uploadUrl={`/api/deals/${dealId}/gl/ledgers`}
            fields={fields}
            ledgers={uploadState}
            onUploaded={invalidate}
            audience="broker"
          />
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-6">
            <div className="flex items-center gap-2">
              <Switch id="gl-private" checked={keepPrivate} onCheckedChange={setKeepPrivate} />
              <Label htmlFor="gl-private" className="text-xs font-normal">Keep it private to me (the seller won't see it)</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch id="gl-adjustments" checked={adjustments} onCheckedChange={setAdjustments} />
              <Label htmlFor="gl-adjustments" className="text-xs font-normal">This is the accountant's year-end adjusting entries</Label>
            </div>
          </div>
          <button
            type="button"
            className="text-xs text-teal hover:underline flex items-center gap-1"
            onClick={() => setShowHelp((v) => !v)}
            aria-expanded={showHelp}
            data-testid="gl-export-help-toggle"
          >
            {showHelp ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
            How to export it from QuickBooks, Xero, Sage, Wave or FreshBooks
          </button>
          {showHelp && <ExportHelp start={range.start} end={range.end} compact />}
        </div>
        )}
      </section>

      <Sheet open={!!viewing} onOpenChange={(o) => !o && setViewing(null)}>
        <SheetContent side="right" className="w-full sm:max-w-4xl p-4 sm:p-6 overflow-y-auto" data-testid="gl-viewer-sheet">
          <SheetHeader className="text-left">
            <SheetTitle className="break-words pr-6">{viewing?.fileName}</SheetTitle>
            <SheetDescription>The general ledger as Cimple read it. Only you see every entry here.</SheetDescription>
          </SheetHeader>
          {viewing && <div className="mt-4"><GlLedgerViewer dealId={dealId} ledgerId={viewing.id} /></div>}
        </SheetContent>
      </Sheet>

      {columnsFor && <ColumnMappingDialog dealId={dealId} ledgerId={columnsFor.id} fileName={columnsFor.fileName} open={!!columnsFor} onOpenChange={(o) => !o && setColumnsFor(null)} />}

      <AlertDialog open={!!fyeTo} onOpenChange={(o) => !o && setFyeTo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{fyeTo === "auto" ? "Work out the fiscal year end from the deal's facts?" : `Change the fiscal year end to ${FYE_OPTIONS.find(([v]) => v === fyeTo)?.[1] ?? fyeTo}?`}</AlertDialogTitle>
            <AlertDialogDescription>
              {fyeTo === "auto"
                ? "Cimple takes it from the deal's facts and financial statements, and follows them if they change. If it moves, every ledger entry moves to the right fiscal year and Cimple looks for the add-backs' entries again."
                : "Cimple moves every ledger entry to the right fiscal year and looks for the add-backs' entries again. Entries already ticked stay ticked. It stays as you set it, even if the deal's facts say otherwise."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => fyeTo && act.mutate({ url: `/api/deals/${dealId}/gl/settings`, method: "PATCH", body: { fiscalYearEnd: fyeTo } })}>Change it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!shareFor} onOpenChange={(o) => !o && setShareFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Share this ledger with the seller?</AlertDialogTitle>
            <AlertDialogDescription>The seller will see every entry in this ledger. You can't make it private again from here.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it private</AlertDialogCancel>
            <AlertDialogAction onClick={() => shareFor && act.mutate({ url: `/api/deals/${dealId}/gl/ledgers/${shareFor.id}`, method: "PATCH", body: { sharedWithSeller: true } })}>
              Share it with the seller
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!notLedgerFor} onOpenChange={(o) => !o && setNotLedgerFor(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Read it as a normal document instead?</AlertDialogTitle>
            <AlertDialogDescription>
              Cimple will stop treating "{notLedgerFor?.fileName}" as a general ledger and read it like any other document. Its entries leave the ledger viewer.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => notLedgerFor && act.mutate({ url: `/api/deals/${dealId}/gl/ledgers/${notLedgerFor.id}/not-ledger` })}>
              Read it as a document
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function LedgerRow({ ledger: l, busy, onOpen, onReread, onShare, onNotLedger, onColumns }: {
  ledger: GlLedgerView; busy: boolean; onOpen: () => void; onReread: () => void; onShare: () => void; onNotLedger: () => void; onColumns: () => void;
}) {
  const period = l.periodStart && l.periodEnd ? formatPeriod(l.periodStart, l.periodEnd) : "";
  const tone =
    l.status === "ready" ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" :
    l.status === "reading" ? "bg-teal/10 text-teal" :
    l.status === "failed" ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-amber-500/10 text-amber-600 dark:text-amber-400";
  const Icon = l.status === "ready" ? CheckCircle2 : l.status === "reading" ? Loader2 : l.status === "failed" ? XCircle : FileWarning;
  return (
    <li className="px-4 py-3 space-y-2" data-testid={`gl-ledger-${l.id}`}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium break-words">{l.fileName}</p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge className={`border-0 gap-1 ${tone}`} data-testid="gl-ledger-status">
              <Icon className={`h-3 w-3 ${l.status === "reading" ? "animate-spin" : ""}`} />
              {l.status === "reading" && l.progress?.rowsRead ? `Reading… ${formatCount(l.progress.rowsRead)} entries so far` : ledgerStatusWords(l.status, l.rowCount, period)}
            </Badge>
            {l.role === "adjustments" && <Badge variant="outline" className="text-2xs border-border text-muted-foreground font-normal">Year-end adjusting entries</Badge>}
            {l.audience === "broker" ? (
              <Badge variant="outline" className="text-2xs gap-1 border-border text-muted-foreground font-normal"><Lock className="h-2.5 w-2.5" /> Private to you — the seller can't see it</Badge>
            ) : (
              <Badge variant="outline" className="text-2xs border-border text-muted-foreground font-normal">{l.uploadedBy === "seller" ? "Uploaded by the seller" : "Shared with the seller"}</Badge>
            )}
          </div>
          {l.status === "ready" && (
            <p className="text-xs text-muted-foreground">
              {softwareLabel(l.software)} · {formatCount(l.accountCount)} accounts{l.basis === "accrual" ? " · accrual basis" : ""}
              {l.duplicateCount > 0 ? ` · ${formatCount(l.duplicateCount)} copies of an earlier file not counted` : ""}
            </p>
          )}
          {l.status === "needs_columns" && (
            <p className="text-xs text-muted-foreground">Cimple couldn't tell which column is which. The easiest fix: ask for the standard General Ledger report and upload that instead — or set the columns yourself.</p>
          )}
          {l.status === "failed" && l.failure && <p className="text-xs text-red-600 dark:text-red-400">{l.failure}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {l.status === "ready" && (
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={onOpen} data-testid="gl-ledger-open">
              <Eye className="h-3.5 w-3.5" /> Open the ledger
            </Button>
          )}
          {l.status === "needs_columns" && (
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={onColumns} data-testid="gl-ledger-columns">
              <Settings2 className="h-3.5 w-3.5" /> Set the columns myself
            </Button>
          )}
          {l.status !== "reading" && (
            <Button size="sm" variant="ghost" className="h-8 text-xs gap-1.5" onClick={onReread} disabled={busy} data-testid="gl-ledger-reread">
              <RefreshCw className="h-3.5 w-3.5" /> Read it again
            </Button>
          )}
          {l.audience === "broker" && (
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={onShare} disabled={busy}>Share it with the seller</Button>
          )}
        </div>
      </div>
      {l.problems.length > 0 && l.status === "ready" && (
        <ul className="space-y-1">
          {l.problems.map((p, i) => (
            <li key={i} className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5">
              <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" /> <span>{p.message}</span>
            </li>
          ))}
        </ul>
      )}
      {l.status !== "reading" && (
        <button type="button" className="text-2xs text-muted-foreground hover:text-foreground hover:underline" onClick={onNotLedger} disabled={busy}>
          Not a ledger? Read it as a normal document instead
        </button>
      )}
    </li>
  );
}
