/**
 * SellerBooks — /seller/:token/books, "Your books" (gl spec §3.3). The
 * seller (or their accountant) shows where the costs the broker listed sit
 * in the bookkeeping:
 *   A. Your ledger      upload it (export steps per program; "Email me this
 *                       link" on a phone; the accountant's adjusting entries;
 *                       "I can't get my ledger")
 *   B. Costs to show    one card per cost — one tap when Cimple already found
 *                       the entries ("Yes, that's right"), T4 slips for pay,
 *                       the invoice for a one-off
 *   C. One cost         ?cost=…&year=… (SellerCostDetail)
 *   Send                "These entries are correct to the best of my
 *                       knowledge" → Send to my broker
 * A broker previewing (their own session) sees the page with a banner, and
 * nothing they do is saved (the server refuses every write).
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useLocation, useParams, useSearch } from "wouter";
import { AlertTriangle, Check, CheckCircle2, ChevronDown, ChevronRight, Copy, Eye, Loader2, Mail, UserRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { queryClient } from "@/lib/queryClient";
import { getJson, glKeys, sendJson, type SellerGlData } from "@/lib/gl-api";
import { LedgerUpload } from "@/components/gl/LedgerUpload";
import { ExportHelp } from "@/components/gl/ExportHelp";
import { exportRange } from "@/components/gl/export-help";
import { SellerCostCard } from "@/components/gl/SellerCostCard";
import { SellerCostDetail } from "@/components/gl/SellerCostDetail";
import { SupportDocUpload } from "@/components/gl/SupportDocUpload";
import { CantGetLedgerSheet, OtherCostsBox } from "@/components/gl/CantGetLedgerSheet";
import { formatCount, formatPeriod } from "@shared/gl-copy";

type Save = "idle" | "saving" | "saved" | "error";

export default function SellerBooks() {
  const { token } = useParams<{ token: string }>();
  const search = useSearch();
  const [location, navigate] = useLocation();
  const params = new URLSearchParams(search);
  const costId = params.get("cost");
  const yearParam = params.get("year");
  const { toast } = useToast();
  const isMobile = useIsMobile();
  const [save, setSave] = useState<Save>("idle");
  const [cantOpen, setCantOpen] = useState(false);
  const [uploadFor, setUploadFor] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [showLedger, setShowLedger] = useState(false);
  const [adjustments, setAdjustments] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const { data, error, isLoading, refetch } = useQuery<SellerGlData, Error & { status?: number }>({
    queryKey: glKeys.seller(token!),
    queryFn: () => getJson<SellerGlData>(`/api/seller/${token}/gl`),
    refetchInterval: (q) => ((q.state.data?.ledgers ?? []).some((l) => l.status === "reading") ? 2000 : false),
    retry: false,
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: glKeys.seller(token!) });
    void queryClient.invalidateQueries({ queryKey: [`/api/seller/${token}/progress`] });
  };
  const setUrl = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [k, v] of Object.entries(patch)) if (v === null) next.delete(k); else next.set(k, v);
    const qs = next.toString();
    navigate(`${location}${qs ? `?${qs}` : ""}`);
    window.scrollTo({ top: 0 });
  };
  useEffect(() => {
    if (save !== "saved") return;
    const t = setTimeout(() => setSave("idle"), 2500);
    return () => clearTimeout(t);
  }, [save]);

  const confirmSummary = useMutation({
    mutationFn: (id: string) => sendJson("POST", `/api/seller/${token}/gl/traces/${id}/confirm-summary`),
    onMutate: () => setSave("saving"),
    onSuccess: () => { setSave("saved"); invalidate(); },
    onError: (e: unknown) => { setSave("error"); toast({ title: "That didn't save", description: e instanceof Error ? e.message : undefined, variant: "destructive" }); },
  });
  const done = useMutation({
    mutationFn: () => sendJson("POST", `/api/seller/${token}/gl/done`, { confirm: true }),
    onSuccess: () => { invalidate(); setConfirm(false); },
    onError: (e: unknown) => toast({ title: "Couldn't send it yet", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const emailLink = useMutation({
    mutationFn: () => sendJson<{ sent: boolean; demo: boolean }>("POST", `/api/seller/${token}/gl/email-me-link`),
    onSuccess: (r) => toast({ title: r.demo ? "This is a demo — nothing was emailed" : r.sent ? "Sent — check your email on your computer" : "We couldn't send it — copy the link instead" }),
    onError: (e: unknown) => toast({ title: "Couldn't email the link", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });

  const range = useMemo(() => exportRange(data?.fiscalYearEnd ?? null, data?.requestedYears ?? []), [data?.fiscalYearEnd, data?.requestedYears]);
  const forbidden = (error as { status?: number } | null)?.status === 403;

  if (isLoading) {
    return <div className="px-4 py-10 sm:p-6 max-w-3xl mx-auto flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading your books…</div>;
  }
  if (forbidden) {
    return (
      <div className="px-4 py-10 sm:p-6 max-w-3xl mx-auto space-y-3" data-testid="books-not-allowed">
        <h1 className="text-2xl font-semibold tracking-tight">Your books</h1>
        <p className="text-sm text-muted-foreground">Your broker asked the business owner or the accountant to do this step.</p>
        <Link href={`/seller/${token}/progress`} className="text-sm text-teal hover:underline">Back to your progress</Link>
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="px-4 py-10 sm:p-6 max-w-3xl mx-auto space-y-3">
        <p className="text-sm text-red-600 dark:text-red-400">{error?.message ?? "Couldn't load your books."}</p>
        <Button variant="outline" onClick={() => refetch()}>Try again</Button>
      </div>
    );
  }

  const preview = !!data.preview;
  const costs = data.costs ?? [];
  const payDoc = data.payDoc ?? { slips: "year-end payroll summary", short: "payroll summary", box: null };
  const ledgers = data.ledgers ?? [];
  const main = ledgers.filter((l) => l.role === "ledger");
  const ready = main.filter((l) => l.status === "ready");
  const readyYears = new Set(ready.flatMap((l) => l.years));
  const coversAll = ready.length > 0 && data.requestedYears.every((y) => readyYears.has(y));
  const requested = data.state !== "not_requested" && data.state !== "withdrawn";
  const allDone = costs.length > 0 && costs.every((c) => ["done", "not_in_ledger", "disputed"].includes(c.sellerStatus));
  const finished = data.state === "waiting_for_broker" || data.state === "done";
  const open = costId ? costs.find((c) => c.id === costId) ?? null : null;
  const uploadCost = uploadFor ? costs.find((c) => c.id === uploadFor) ?? null : null;
  const pageUrl = typeof window !== "undefined" ? `${window.location.origin}/seller/${token}/books` : "";
  const years = Array.from(new Set(costs.flatMap((c) => c.years.map((y) => y.year)))).sort();
  const step = !coversAll && ready.length === 0 ? 1 : finished ? 3 : 2;

  const header = (
    <div className="space-y-3">
      {preview && (
        <div className="rounded-lg border border-teal/40 bg-teal/10 px-3 py-2 text-sm flex items-start gap-2" data-testid="books-preview-banner">
          <Eye className="h-4 w-4 text-teal mt-0.5 shrink-0" /> Preview — this is what the seller sees. Nothing you do here is saved.
        </div>
      )}
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Your books</h1>
          {data.businessName && <p className="text-sm text-muted-foreground mt-0.5 break-words">{data.businessName}</p>}
        </div>
        {save !== "idle" && (
          <span className={cn("text-xs rounded-full px-2 py-1", save === "error" ? "bg-red-500/10 text-red-600 dark:text-red-400" : "bg-muted text-muted-foreground")} aria-live="polite" data-testid="books-autosave">
            {save === "saving" ? "Saving…" : save === "saved" ? "Saved" : "Couldn't save — try again"}
          </span>
        )}
      </div>
      {requested && (
        <ol className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Steps">
          {["Your ledger", "Check the costs", "Send to your broker"].map((s, i) => (
            <li key={s} className={cn("flex items-center gap-1.5", i + 1 === step ? "text-foreground font-medium" : i + 1 < step ? "text-teal" : "text-muted-foreground")}>
              <span className={cn("h-5 w-5 rounded-full flex items-center justify-center text-2xs", i + 1 < step ? "bg-teal/15" : i + 1 === step ? "border-2 border-teal" : "border border-border")}>{i + 1 < step ? <Check className="h-3 w-3" /> : i + 1}</span>
              {s}
            </li>
          ))}
        </ol>
      )}
    </div>
  );

  // C. One cost
  if (open) {
    return (
      <div className="px-4 py-6 sm:p-6 max-w-3xl mx-auto space-y-6">
        {header}
        <SellerCostDetail token={token!} cost={open} year={yearParam ?? open.years[0]?.year ?? ""} onYear={(y) => setUrl({ year: y })} onBack={() => setUrl({ cost: null, year: null })} payDoc={payDoc} preview={preview} onSaving={(s) => { setSave(s); if (s !== "saving") invalidate(); }} />
      </div>
    );
  }

  const ledgerStep = (
    <section className="space-y-4" data-testid="books-upload">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Upload your general ledger</h2>
        <p className="text-sm text-muted-foreground mt-1">
          The general ledger lists every entry in your bookkeeping. Export it for <strong className="text-foreground">{range.start} – {range.end}</strong> and upload it here as an Excel or CSV file. One file for all years, or one per year — both work.
        </p>
      </div>
      {isMobile && (
        <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2" data-testid="books-email-link">
          <p className="text-sm">Exporting is easier on a computer.</p>
          <div className="flex flex-col gap-2">
            <Button variant="outline" className="h-11 gap-1.5" disabled={preview || emailLink.isPending} onClick={() => emailLink.mutate()}><Mail className="h-4 w-4" /> Email me this link</Button>
            <button type="button" className="text-xs text-muted-foreground break-all text-left flex items-start gap-1.5" onClick={() => { void navigator.clipboard?.writeText(pageUrl).then(() => toast({ title: "Link copied" })).catch(() => undefined); }}>
              <Copy className="h-3.5 w-3.5 shrink-0 mt-0.5" /> {pageUrl}
            </button>
          </div>
        </div>
      )}
      <ExportHelp start={range.start} end={range.end} />
      <LedgerUpload
        uploadUrl={`/api/seller/${token}/gl/ledgers`}
        fields={adjustments ? { role: "adjustments" } : {}}
        ledgers={ledgers.map((l) => ({ ...l, problems: l.problems.map((p) => ({ kind: p.kind, message: p.message })) }))}
        onUploaded={invalidate}
        audience="seller"
        disabled={preview}
        disabledReason="Preview — nothing you do here is saved."
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-5">
        <button type="button" className="text-sm text-teal hover:underline text-left" onClick={() => setAdjustments((v) => !v)} aria-pressed={adjustments}>
          {adjustments ? "Uploading the accountant's adjusting entries (tap to switch back)" : "My accountant gave me their year-end adjusting entries"}
        </button>
        <button type="button" className="text-sm text-teal hover:underline text-left" onClick={() => setCantOpen(true)} data-testid="books-cant-get">I can't get my ledger</button>
      </div>
    </section>
  );

  return (
    <div className="px-4 py-6 sm:p-6 max-w-3xl mx-auto space-y-6" data-testid="seller-books">
      {header}
      {notice && <p className="rounded-lg border border-success/30 bg-success/5 p-3 text-sm" role="status">{notice}</p>}

      {data.state === "withdrawn" && (
        <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm">Your broker doesn't need anything from your books right now.</p>
      )}
      {data.state === "not_requested" && (
        <p className="rounded-lg border border-border bg-muted/30 p-4 text-sm">Your broker hasn't asked you to show any costs yet. You can upload your general ledger now — they'll let you know when they need more.</p>
      )}
      {data.state === "waiting_for_accountant" && data.accountant && (
        <div className="rounded-lg border border-teal/30 bg-teal/5 p-4 space-y-1">
          <p className="text-sm font-medium flex items-center gap-2"><UserRound className="h-4 w-4 text-teal" /> Waiting for {data.accountant.name}</p>
          <p className="text-sm text-muted-foreground">Your broker is sending {data.accountant.name.split(/\s+/)[0]} their own link. You'll see the ledger here once they've uploaded it — or do it yourself below.</p>
        </div>
      )}
      {data.message && requested && (
        <p className="rounded-lg border border-border bg-card p-3 text-sm"><span className="text-muted-foreground">Your broker: </span>"{data.message}"</p>
      )}

      {/* A. The ledger */}
      {(!coversAll || data.state === "not_requested") && ledgerStep}
      {coversAll && data.state !== "not_requested" && (
        <section className="rounded-lg border border-border bg-card" data-testid="books-ledger-done">
          <button type="button" className="w-full flex items-center gap-2 px-4 py-3 text-left min-h-[44px]" onClick={() => setShowLedger((v) => !v)} aria-expanded={showLedger}>
            <CheckCircle2 className="h-4 w-4 text-success shrink-0" />
            <span className="text-sm flex-1">Your ledger: <strong>{formatCount(ready.reduce((n, l) => n + l.rowCount, 0))} entries</strong>{ready[0]?.periodStart ? `, ${formatPeriod(ready.map((l) => l.periodStart!).sort()[0], ready.map((l) => l.periodEnd!).sort().slice(-1)[0])}` : ""}</span>
            {showLedger ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
          {showLedger && <div className="px-4 pb-4">{ledgerStep}</div>}
        </section>
      )}

      {/* B. The costs */}
      {requested && costs.length > 0 && (
        <section className="space-y-3" data-testid="books-costs">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-lg font-semibold tracking-tight">Costs to show</h2>
            <span className="text-sm text-muted-foreground">{data.done ?? 0} of {data.total ?? costs.length} done</span>
          </div>
          <p className="text-sm text-muted-foreground">Your broker listed these costs. For each one, show where it is in your books. We've suggested the likely entries.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {costs.map((c) => (
              <SellerCostCard key={c.id} cost={c} payDoc={payDoc} preview={preview}
                onOpen={(y) => setUrl({ cost: c.id, year: y ?? c.years.find((x) => x.status !== "found")?.year ?? c.years[0]?.year ?? null })}
                onConfirmSummary={() => confirmSummary.mutate(c.id)}
                confirming={confirmSummary.isPending && confirmSummary.variables === c.id}
                onUpload={() => setUploadFor(c.id)} />
            ))}
          </div>
        </section>
      )}

      {requested && costs.length > 0 && (
        <>
          <OtherCostsBox token={token!} years={years} preview={preview} onSent={invalidate} />
          {finished ? (
            <div className="rounded-lg border border-success/30 bg-success/5 p-4 space-y-1" data-testid="books-sent">
              <p className="text-sm font-medium flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-success" /> All done — thank you.</p>
              <p className="text-sm text-muted-foreground">Your broker will review these. You can still change anything until they finish.</p>
              <Link href={`/seller/${token}/progress`} className="text-sm text-teal hover:underline inline-block mt-1">Back to your progress</Link>
            </div>
          ) : (
            <section className="rounded-lg border border-border bg-card p-4 space-y-3" data-testid="books-send">
              {!allDone && <p className="text-sm text-muted-foreground flex items-start gap-2"><AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" /> Finish each cost (or tell your broker it isn't in your ledger) before you send.</p>}
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-1 h-4 w-4" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} disabled={!allDone} />
                These entries are correct to the best of my knowledge.
              </label>
              <Button className="w-full sm:w-auto h-11 bg-teal text-teal-foreground hover:bg-teal/90" disabled={!allDone || !confirm || done.isPending || preview} onClick={() => done.mutate()} data-testid="books-send-button">
                {done.isPending && <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />} Send to my broker
              </Button>
            </section>
          )}
        </>
      )}

      <CantGetLedgerSheet token={token!} open={cantOpen} onOpenChange={setCantOpen} preview={preview}
        onDone={(w) => { invalidate(); setNotice(w === "accountant" ? "Sent to your broker — they'll send your accountant their own link." : "Sent to your broker — they'll find another way."); }} />

      <Dialog open={!!uploadCost} onOpenChange={(o) => !o && setUploadFor(null)}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{uploadCost?.sellerLabel}</DialogTitle>
            <DialogDescription>Your {payDoc.slips} show this best. Cimple checks the amount you type is on the document.</DialogDescription>
          </DialogHeader>
          {uploadCost && (
            <SupportDocUpload uploadUrl={`/api/seller/${token}/gl/traces/${uploadCost.id}/support-docs`} years={uploadCost.years.map((y) => y.year)} kind="payroll" payDoc={payDoc} disabled={preview}
              personWord={uploadCost.sellerLabel === "Your pay as owner" ? "Your" : uploadCost.sellerLabel.replace(/ pay$/, "")}
              onDone={() => { invalidate(); void queryClient.invalidateQueries({ queryKey: glKeys.sellerEntries(token!, uploadCost.id) }); setUploadFor(null); toast({ title: "Uploaded", description: "Cimple is reading it — the result shows on the cost." }); }} />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
