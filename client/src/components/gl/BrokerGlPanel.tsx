/**
 * BrokerGlPanel — Financials → "Add-backs in the books" (gl spec §3.4).
 *
 * This first part is the general ledger itself: upload it (or see the one
 * the seller uploaded), follow it being read, open it, read it again, keep
 * it private or share it with the seller. The add-back grid, the request to
 * the seller and the publish dialog build on this.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, BookCheck, CheckCircle2, ChevronDown, ChevronRight, Eye, FileSpreadsheet, FileWarning, Loader2, Lock, RefreshCw, XCircle,
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
import { queryClient } from "@/lib/queryClient";
import { getJson, glKeys, sendJson, type BrokerGlData } from "@/lib/gl-api";
import { PanelError } from "@/components/deal/PanelError";
import { LedgerUpload } from "./LedgerUpload";
import { ExportHelp } from "./ExportHelp";
import { exportRange } from "./export-help";
import { GlLedgerViewer } from "./GlLedgerViewer";
import { formatCount, formatPeriod, ledgerStatusWords, softwareLabel } from "@shared/gl-copy";
import type { GlLedgerView } from "@shared/gl-types";

export function BrokerGlPanel({ dealId, variant = "full" }: { dealId: string; variant?: "full" | "ledgers-only" }) {
  const { toast } = useToast();
  const [viewing, setViewing] = useState<GlLedgerView | null>(null);
  const [keepPrivate, setKeepPrivate] = useState(false);
  const [adjustments, setAdjustments] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [addingFile, setAddingFile] = useState(false);
  const [shareFor, setShareFor] = useState<GlLedgerView | null>(null);
  const [notLedgerFor, setNotLedgerFor] = useState<GlLedgerView | null>(null);

  const { data, isLoading, error, refetch } = useQuery<BrokerGlData>({
    queryKey: glKeys.broker(dealId),
    queryFn: () => getJson<BrokerGlData>(`/api/deals/${dealId}/gl`),
    refetchInterval: (q) => ((q.state.data?.ledgers ?? []).some((l) => l.status === "reading") ? 2000 : 30_000),
    refetchOnWindowFocus: true,
  });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: glKeys.broker(dealId) });
  const act = useMutation({
    mutationFn: ({ url, body, method = "POST" }: { url: string; body?: unknown; method?: string }) => sendJson(method, url, body ?? {}),
    onSuccess: () => invalidate(),
    onError: (err: unknown) => toast({ title: "That didn't work", description: err instanceof Error ? err.message : undefined, variant: "destructive" }),
  });

  const range = useMemo(() => exportRange(data?.fiscalYearEnd ?? null, data?.requestedYears ?? []), [data?.fiscalYearEnd, data?.requestedYears]);
  const ledgers = data?.ledgers ?? [];
  const uploadState = ledgers.map((l) => ({ ...l, progress: l.progress ? { rowsRead: l.progress.rowsRead } : null }));

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground gap-2" data-testid="gl-panel-loading">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading the general ledger…
      </div>
    );
  }
  if (error || !data) return <PanelError what="the general ledger" onRetry={() => refetch()} />;

  const fields: Record<string, string> = {};
  if (keepPrivate) fields.visibility = "broker_only";
  if (adjustments) fields.role = "adjustments";

  return (
    <div className="space-y-4" data-testid="gl-panel">
      {variant === "full" && (
        <div className="flex items-start gap-3">
          <div className="h-9 w-9 rounded-lg bg-teal/10 flex items-center justify-center shrink-0">
            <BookCheck className="h-4 w-4 text-teal" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-semibold tracking-tight">Add-backs in the books</h3>
            <p className="text-sm text-muted-foreground mt-0.5">
              Due-diligence buyers ask to see the entries behind every add-back. It starts with the general ledger — every bookkeeping entry, last three years, as Excel or CSV.
              Cimple reads it entry by entry on its own servers; the ledger is never sent to the AI.
            </p>
          </div>
        </div>
      )}

      <section className="rounded-lg border border-border bg-card" aria-labelledby="gl-ledgers-title">
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-border">
          <h4 id="gl-ledgers-title" className="text-sm font-medium flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" /> General ledger
          </h4>
          <span className="text-xs text-muted-foreground">
            {ledgers.length === 0 ? "Not uploaded yet" : `${ledgers.length} file${ledgers.length === 1 ? "" : "s"}`}
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
              />
            ))}
          </ul>
        )}

        {(data.unread.length > 0) && (
          <div className="px-4 py-3 border-t border-border space-y-2" data-testid="gl-unread">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">Ledgers Cimple hasn't read yet</p>
            {data.unread.map((u) => (
              <div key={u.documentId} className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="text-sm break-words">{u.name}</p>
                  {u.reason === "pdf" && <p className="text-xs text-muted-foreground">A PDF ledger can't be matched entry by entry — ask for the Excel or CSV export.</p>}
                </div>
                {u.reason === "not_read" && (
                  <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" disabled={act.isPending}
                    onClick={() => act.mutate({ url: `/api/deals/${dealId}/gl/ledgers/read-as-ledger`, body: { documentId: u.documentId } })}>
                    Read as a ledger
                  </Button>
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

function LedgerRow({ ledger: l, busy, onOpen, onReread, onShare, onNotLedger }: {
  ledger: GlLedgerView; busy: boolean; onOpen: () => void; onReread: () => void; onShare: () => void; onNotLedger: () => void;
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
            <p className="text-xs text-muted-foreground">Cimple couldn't tell which column is which. The easiest fix: ask for the standard General Ledger report and upload that instead.</p>
          )}
          {l.status === "failed" && l.failure && <p className="text-xs text-red-600 dark:text-red-400">{l.failure}</p>}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0">
          {l.status === "ready" && (
            <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" onClick={onOpen} data-testid="gl-ledger-open">
              <Eye className="h-3.5 w-3.5" /> Open the ledger
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
