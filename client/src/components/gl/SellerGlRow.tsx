/**
 * SellerGlRow — the general-ledger line on the seller's Documents checklist
 * (gl spec §3.1). The owner's or the accountant's link uploads it here (with
 * the steps for their software); anyone else's link sees who does it. Its
 * status comes from the ledger reader, never from a click: Missing ·
 * Reading… · Received — 48,213 entries, Jan 2022–Dec 2024 · Needs another look.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Clock, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";
import { queryClient } from "@/lib/queryClient";
import { getJson, glKeys, type SellerGlData } from "@/lib/gl-api";
import { ExportHelp } from "./ExportHelp";
import { LedgerUpload } from "./LedgerUpload";
import { exportRange } from "./export-help";
import { formatCount, formatPeriod } from "@shared/gl-copy";

export function SellerGlRow({ token, name, isRequired }: { token: string; name: string; isRequired: boolean }) {
  const isMobile = useIsMobile();
  const [open, setOpen] = useState(false);
  const [showAdjustments, setShowAdjustments] = useState(false);
  const { data, error, isLoading } = useQuery<SellerGlData, Error & { status?: number }>({
    queryKey: glKeys.seller(token),
    queryFn: () => getJson<SellerGlData>(`/api/seller/${token}/gl`),
    refetchInterval: (q) => ((q.state.data?.ledgers ?? []).some((l) => l.status === "reading") ? 2000 : false),
    retry: false,
  });
  const notAllowed = (error as { status?: number } | null)?.status === 403;
  const ledgers = data?.ledgers ?? [];
  const main = ledgers.filter((l) => l.role === "ledger");
  const ready = main.filter((l) => l.status === "ready");
  const reading = ledgers.some((l) => l.status === "reading");
  const trouble = !ready.length && main.find((l) => l.status === "needs_columns" || l.status === "failed");
  const range = exportRange(data?.fiscalYearEnd ?? null);
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: glKeys.seller(token) });
    void queryClient.invalidateQueries({ queryKey: [`/api/seller/${token}/progress`] });
  };
  const uploadState = ledgers.map((l) => ({ ...l, problems: l.problems.map((p) => ({ kind: p.kind, message: p.message })) }));

  const status = ready.length > 0 ? (
    <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1" data-testid="gl-row-received">
      <Check className="h-3 w-3" /> Received — {formatCount(ready.reduce((n, l) => n + l.rowCount, 0))} entries
      {ready[0].periodStart && ready[ready.length - 1].periodEnd ? `, ${formatPeriod(ready.map((l) => l.periodStart!).sort()[0], ready.map((l) => l.periodEnd!).sort().slice(-1)[0])}` : ""}
    </span>
  ) : reading ? (
    <span className="text-xs text-teal flex items-center gap-1" data-testid="gl-row-reading"><Loader2 className="h-3 w-3 animate-spin" /> Reading…</span>
  ) : trouble ? (
    <span className="text-xs text-amber-600 dark:text-amber-400 flex items-center gap-1" data-testid="gl-row-trouble"><AlertTriangle className="h-3 w-3" /> Needs another look</span>
  ) : null;

  const body = (
    <div className="space-y-5">
      <p className="text-sm text-muted-foreground">
        The general ledger lists every entry in your bookkeeping. Export it for <strong className="text-foreground">{range.start} – {range.end}</strong> and upload it here as an Excel or CSV file.
        One file for all years, or one per year — both work.
      </p>
      {data?.preview && (
        <p className="rounded-md border border-teal/30 bg-teal/5 px-3 py-2 text-xs" data-testid="gl-preview-banner">Preview — this is what the seller sees. Nothing you do here is saved.</p>
      )}
      <ExportHelp start={range.start} end={range.end} />
      {isMobile && (
        <p className="text-xs text-muted-foreground">Exporting is easier on a computer — you can open this page there and upload it from that computer.</p>
      )}
      <LedgerUpload
        uploadUrl={`/api/seller/${token}/gl/ledgers`}
        ledgers={uploadState}
        onUploaded={invalidate}
        audience="seller"
        disabled={!!data?.preview}
        disabledReason="You're previewing the seller's page — nothing is saved."
        testId="gl-seller-upload"
      />
      {!showAdjustments ? (
        <button type="button" className="text-xs text-teal hover:underline" onClick={() => setShowAdjustments(true)} data-testid="gl-adjustments-link">
          My accountant gave me their year-end adjusting entries
        </button>
      ) : (
        <div className="space-y-2 rounded-lg border border-border p-3">
          <p className="text-sm font-medium">Your accountant's year-end adjusting entries</p>
          <p className="text-xs text-muted-foreground">If your accountant made year-end entries that aren't in your software, add their file too.</p>
          <LedgerUpload
            uploadUrl={`/api/seller/${token}/gl/ledgers`}
            fields={{ role: "adjustments" }}
            ledgers={uploadState}
            onUploaded={invalidate}
            audience="seller"
            disabled={!!data?.preview}
            testId="gl-seller-adjustments"
          />
        </div>
      )}
    </div>
  );

  return (
    <div className="px-4 py-3" data-testid="requirement-row-gl">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <div className="flex items-start gap-3 min-w-0">
          {ready.length > 0 ? (
            <div className="h-5 w-5 rounded-full bg-amber-400/15 flex items-center justify-center shrink-0 mt-0.5"><Clock className="h-3 w-3 text-amber-500" /></div>
          ) : (
            <div className="h-5 w-5 rounded-full border border-border shrink-0 mt-0.5 flex items-center justify-center"><FileSpreadsheet className="h-3 w-3 text-muted-foreground/70" /></div>
          )}
          <div className="min-w-0">
            <p className="text-sm break-words">
              General ledger — every entry, last 3 years (Excel or CSV)
              {isRequired && !ready.length && !reading && <span className="text-xs text-destructive ml-1.5 whitespace-nowrap">Required</span>}
            </p>
            <div className="mt-0.5">{status}</div>
            {trouble && (
              <p className="text-xs text-muted-foreground mt-0.5 break-words">
                {trouble.status === "failed" ? trouble.failure : "We couldn't tell which column is which. The easiest fix: export the standard General Ledger report and upload that instead. Or leave it — your broker will sort it out."}
              </p>
            )}
            {notAllowed && <p className="text-xs text-muted-foreground mt-0.5" data-testid="gl-row-not-allowed">The business owner or the accountant uploads this one.</p>}
          </div>
        </div>
        {!notAllowed && !isLoading && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-8 sm:pl-0 sm:shrink-0">
            <button className="text-xs text-teal hover:underline flex items-center gap-1 min-h-8" onClick={() => setOpen(true)} data-testid="button-upload-gl">
              <Upload className="h-3 w-3" /> {ready.length ? "Add another file" : "Upload"}
            </button>
          </div>
        )}
      </div>
      <span className="sr-only">{name}</span>

      {isMobile ? (
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent side="bottom" className="max-h-[92vh] overflow-y-auto rounded-t-xl p-4" data-testid="gl-upload-sheet">
            <SheetHeader className="text-left mb-3">
              <SheetTitle>Upload your general ledger</SheetTitle>
              <SheetDescription className="sr-only">Steps to export the general ledger and upload it</SheetDescription>
            </SheetHeader>
            {body}
          </SheetContent>
        </Sheet>
      ) : (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="gl-upload-dialog">
            <DialogHeader>
              <DialogTitle>Upload your general ledger</DialogTitle>
              <DialogDescription className="sr-only">Steps to export the general ledger and upload it</DialogDescription>
            </DialogHeader>
            {body}
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
