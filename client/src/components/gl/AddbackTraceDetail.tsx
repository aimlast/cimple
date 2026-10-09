/**
 * AddbackTraceDetail (broker) — one add-back in the books (gl spec §3.4
 * "Drawer"): per year what was added back, what was found and the
 * difference; the entries (who ticked them) and the documents (the typed
 * amount and whether it was seen on the document); the seller's note and
 * answer; "Ask the seller about this"; "Mark reviewed" with Cimple's
 * suggestion pre-selected. Everything else is folded under "More options":
 * the proof asked for, the share added back, leaving a year out, why it's
 * added back (for due-diligence buyers), what the seller sees, the switches,
 * ticking entries yourself and "Look again".
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, ChevronDown, ChevronRight, FileText, Loader2, Lock, MessageSquare, RefreshCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { getJson, glKeys, sendJson, type BrokerEntriesData, type BrokerEntry, type BrokerTrace } from "@/lib/gl-api";
import { invalidateGl } from "@/hooks/useGlStatus";
import { Pill, dollars, ledgerDate, money, statusTone } from "./gl-ui";
import { ApplyLedgerAmountDialog } from "./ApplyLedgerAmountDialog";
import { SupportDocUpload } from "./SupportDocUpload";
import { accountPath, PROOF_LABEL, VERDICT_WORDS, YEAR_STATUS_WORDS } from "@shared/gl-copy";
import type { GlYearStatus } from "@shared/gl-types";

const NOT_IN_LEDGER: Record<string, string> = {
  personal: "the seller paid it personally, outside the business",
  other_document: "it's in another document",
  unsure: "the seller isn't sure",
};

export function AddbackTraceDetail({ dealId, trace, initialYear, docShort, payDoc: payDocProp, onClose }: {
  dealId: string;
  trace: BrokerTrace;
  initialYear?: string | null;
  docShort: string;
  /** The deal's pay documents (T4 slips / W-2 forms / the payroll summary). */
  payDoc?: { slips: string; short: string; box: string | null };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const years = Object.keys(trace.claims).filter((y) => /^\d{4}$/.test(y)).sort();
  const [year, setYear] = useState<string>(initialYear && years.includes(initialYear) ? initialYear : years[years.length - 1] ?? "");
  const [more, setMore] = useState(false);
  const [uploading, setUploading] = useState(false);
  const payDoc = payDocProp ?? { slips: "year-end payroll summary", short: docShort, box: null };
  const [question, setQuestion] = useState("");
  const [verdict, setVerdict] = useState<string>(trace.brokerVerdict ?? trace.computed?.suggestedVerdict ?? "found");
  const [note, setNote] = useState(trace.brokerNote ?? "");
  useEffect(() => setVerdict(trace.brokerVerdict ?? trace.computed?.suggestedVerdict ?? "found"), [trace.id, trace.brokerVerdict, trace.computed?.suggestedVerdict]);

  const entriesQ = useQuery<BrokerEntriesData>({
    queryKey: glKeys.brokerEntries(dealId, trace.id),
    queryFn: () => getJson<BrokerEntriesData>(`/api/deals/${dealId}/gl/traces/${trace.id}/entries`),
  });
  const changed = () => {
    invalidateGl(dealId);
    void entriesQ.refetch();
  };
  const act = useMutation({
    mutationFn: ({ method, url, body }: { method: string; url: string; body?: unknown }) => sendJson(method, url, body ?? {}),
    onSuccess: () => changed(),
    onError: (e: unknown) => toast({ title: "That didn't work", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const patch = (body: Record<string, unknown>) => act.mutate({ method: "PATCH", url: `/api/deals/${dealId}/gl/traces/${trace.id}`, body });
  const links = (body: Record<string, unknown>) => act.mutate({ method: "PUT", url: `/api/deals/${dealId}/gl/traces/${trace.id}/links`, body: { fy: year, ...body } });

  const y = trace.computed?.byYear?.[year];
  const entries = (entriesQ.data?.entries ?? []).filter((e) => e.fiscalYear === year);
  const docs = (entriesQ.data?.documents ?? []).filter((d) => d.fiscalYear === year);
  const confirmed = entries.filter((e) => e.state === "confirmed");
  const proposed = entries.filter((e) => e.state === "proposed");
  const rejected = entries.filter((e) => e.state === "rejected");
  const overall = trace.computed?.overall ?? "not_started";
  const statusWord = (s: GlYearStatus | string) => YEAR_STATUS_WORDS[s as GlYearStatus]?.broker ?? s;

  return (
    <div className="space-y-5" data-testid="gl-drawer">
      <div className="space-y-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <Pill tone={statusTone(overall)}>{statusWord(overall)}</Pill>
          <Pill tone="muted">{trace.proofLabel}</Pill>
          {trace.privateEvidence && <Pill tone="warn"><Lock className="h-2.5 w-2.5" /> From your private notes</Pill>}
          {!trace.sentAt && <Pill tone="muted">Not sent to the seller</Pill>}
        </div>
        <p className="text-xs text-muted-foreground">The seller sees it as <strong className="text-foreground">{trace.sellerLabel}</strong>{trace.sellerHint ? ` — ${trace.sellerHint}` : ""}</p>
      </div>

      {/* Years */}
      {years.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Year">
          {years.map((yy) => (
            <button key={yy} type="button" role="tab" aria-selected={yy === year} onClick={() => setYear(yy)}
              ref={(el) => { if (el && yy === year) el.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
              className={cn("shrink-0 rounded-full border px-3 py-1 text-xs min-h-[32px]", yy === year ? "border-teal bg-teal/10 text-teal" : "border-border text-muted-foreground hover:text-foreground")}>
              {yy} · {trace.cells[yy]?.words ?? "—"}
            </button>
          ))}
        </div>
      )}

      {y && (
        <div className="grid grid-cols-3 gap-2 text-center" data-testid="gl-drawer-year">
          <Figure label="Added back" value={dollars(y.claimedCents)} sub={trace.sharePct ? `${trace.sharePct}% of ${dollars(y.targetCents)}` : undefined} />
          <Figure label="Found" value={dollars(y.foundCents + y.documentCents)} sub={y.documentCents ? `${dollars(y.documentCents)} by a document` : undefined} />
          <Figure label="Difference" value={y.status === "left_out" || y.status === "statement" ? "—" : dollars(Math.abs(y.diffCents))} sub={y.status === "left_out" || y.status === "statement" ? statusWord(y.status) : y.targetCents ? `${((Math.abs(y.diffCents) / Math.max(1, y.targetCents)) * 100).toFixed(1)}% · ${statusWord(y.status)}` : undefined} />
        </div>
      )}
      {y?.privateOnly && (
        <p className="text-xs text-amber-600 dark:text-amber-400 flex items-start gap-1.5"><Lock className="h-3 w-3 mt-0.5 shrink-0" /> These entries are only in a ledger private to you — buyers and the seller won't see them.</p>
      )}
      {trace.notInLedger && (
        <p className="text-xs text-muted-foreground flex items-start gap-1.5"><AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-amber-500" /> The seller says this isn't in the ledger: {NOT_IN_LEDGER[trace.notInLedger.reason] ?? trace.notInLedger.reason}.</p>
      )}

      {/* Entries */}
      <section className="space-y-2">
        <h4 className="text-sm font-medium">Entries {confirmed.length ? `· ${confirmed.length} ticked` : ""}</h4>
        {entriesQ.isLoading ? (
          <p className="text-xs text-muted-foreground flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading the entries…</p>
        ) : entriesQ.error ? (
          <p className="text-xs text-red-500">Couldn't load the entries. <button className="underline" onClick={() => entriesQ.refetch()}>Try again</button></p>
        ) : confirmed.length === 0 && proposed.length === 0 && docs.length === 0 ? (
          <p className="text-xs text-muted-foreground">{trace.proof === "statement" ? "Nothing to find — this comes straight from the financial statements." : "No entries yet for this year."}</p>
        ) : (
          <EntryTable
            rows={[...confirmed, ...proposed]}
            onTick={(e, tick) => links(tick ? { add: [{ ledgerId: e.ledgerId, rowNo: e.rowNo }] } : { remove: [{ ledgerId: e.ledgerId, rowNo: e.rowNo }] })}
            busy={act.isPending}
          />
        )}
        {rejected.length > 0 && <p className="text-2xs text-muted-foreground">{rejected.length} entr{rejected.length === 1 ? "y" : "ies"} marked "not part of it".</p>}
        {docs.map((d) => (
          <div key={d.id} className="rounded-md border border-border px-3 py-2 text-xs flex flex-wrap items-center gap-2" data-testid="gl-drawer-doc">
            <FileText className="h-3.5 w-3.5 text-muted-foreground" />
            {d.fileUrl ? <a className="underline-offset-2 hover:underline break-all" href={d.fileUrl} target="_blank" rel="noreferrer">{d.name}</a> : <span className="break-all">{d.name}</span>}
            <span className="text-muted-foreground">typed {dollars(d.amountCents)}</span>
            {d.check === "found_in_document" ? <Pill tone="good"><Check className="h-2.5 w-2.5" /> Seen on the document</Pill>
              : d.check === "not_found" ? <Pill tone="warn">Not seen on the document — check it</Pill>
              : d.check === "unreadable" ? <Pill tone="muted">Couldn't read it — check it</Pill>
              : <Pill tone="muted">Being read…</Pill>}
          </div>
        ))}
        {trace.proof !== "statement" && (
          uploading ? (
            <div className="rounded-md border border-border p-3" data-testid="gl-drawer-support-upload">
              <SupportDocUpload
                uploadUrl={`/api/deals/${dealId}/gl/traces/${trace.id}/support-docs`}
                years={years}
                kind={trace.proof === "payroll" ? "payroll" : trace.proof === "one_off" ? "one_off" : "other"}
                payDoc={payDoc}
                onDone={() => { setUploading(false); changed(); toast({ title: "Document added", description: "Cimple looks for the amount in it once it's read." }); }}
              />
              <Button size="sm" variant="ghost" className="mt-1 h-8 text-xs" onClick={() => setUploading(false)}>Cancel</Button>
            </div>
          ) : (
            <Button size="sm" variant="ghost" className="h-8 text-xs gap-1.5 -ml-2" onClick={() => setUploading(true)} data-testid="gl-drawer-upload-doc">
              <FileText className="h-3.5 w-3.5" /> Upload a supporting document ({trace.proof === "payroll" ? payDoc.slips : trace.proof === "one_off" ? "invoice or letter" : "any document"})
            </Button>
          )
        )}
      </section>

      {/* The seller's words */}
      {(trace.sellerNote || trace.question) && (
        <section className="space-y-2">
          {trace.sellerNote && (
            <div className="rounded-md bg-muted/40 px-3 py-2 text-sm"><p className="text-2xs uppercase tracking-wide text-muted-foreground mb-0.5">The seller's note</p>{trace.sellerNote}</div>
          )}
          {trace.question && (
            <div className="rounded-md border border-teal/30 bg-teal/5 px-3 py-2 text-sm space-y-1">
              <p><span className="text-2xs uppercase tracking-wide text-muted-foreground">You asked</span><br />{trace.question.text}</p>
              {trace.question.answer ? <p><span className="text-2xs uppercase tracking-wide text-muted-foreground">The seller answered</span><br />{trace.question.answer}</p> : <p className="text-xs text-muted-foreground">Waiting for the seller's answer.</p>}
            </div>
          )}
        </section>
      )}

      {trace.moveFrom && (
        <div className="rounded-lg border border-teal/30 bg-teal/5 p-3 space-y-2" data-testid="gl-move-from">
          <p className="text-sm">
            {trace.moveFrom.count} entr{trace.moveFrom.count === 1 ? "y was" : "ies were"} ticked for <strong>"{trace.moveFrom.label}"</strong>, which is no longer in the analysis. They look like they belong here.
          </p>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={act.isPending}
            onClick={() => act.mutate({ method: "POST", url: `/api/deals/${dealId}/gl/traces/${trace.id}/move-links`, body: { fromTraceId: trace.moveFrom!.traceId } }, { onSuccess: (r: any) => toast({ title: `${r?.moved ?? 0} entr${r?.moved === 1 ? "y" : "ies"} moved here` }) })}>
            Move the ticked entries here
          </Button>
        </div>
      )}

      {trace.assistant && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground" aria-live="polite" data-testid="gl-assistant-line">
          {trace.assistant.state === "looking" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
          {trace.assistant.words}
        </p>
      )}

      {/* Ask */}
      {trace.sentAt && (
        <section className="space-y-2">
          <Label htmlFor="gl-ask" className="text-sm font-medium">Ask the seller about this</Label>
          <Textarea id="gl-ask" value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="e.g. Is the Petro-Canada fuel for the Lexus only?" rows={2} maxLength={1000} />
          <Button size="sm" variant="outline" className="h-8 text-xs gap-1.5" disabled={question.trim().length < 3 || act.isPending}
            onClick={() => act.mutate({ method: "POST", url: `/api/deals/${dealId}/gl/traces/${trace.id}/question`, body: { text: question } }, { onSuccess: () => { setQuestion(""); toast({ title: "Question sent", description: "It's on the seller's page." }); } })}>
            <MessageSquare className="h-3.5 w-3.5" /> Send the question
          </Button>
        </section>
      )}

      {/* Review */}
      {trace.proof !== "statement" && (
        <section className="rounded-lg border border-border p-3 space-y-2" data-testid="gl-drawer-review">
          {trace.reviewedAt && trace.brokerVerdict ? (
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm flex items-center gap-1.5"><Check className="h-4 w-4 text-success" /> Reviewed: <strong>{VERDICT_WORDS[trace.brokerVerdict]}</strong></p>
              <Button size="sm" variant="ghost" className="h-8 text-xs" disabled={act.isPending} onClick={() => act.mutate({ method: "POST", url: `/api/deals/${dealId}/gl/traces/${trace.id}/review`, body: { undo: true } })}>Undo</Button>
            </div>
          ) : (
            <>
              <p className="text-sm font-medium">Mark reviewed</p>
              <p className="text-xs text-muted-foreground">Cimple suggests: {VERDICT_WORDS[trace.computed?.suggestedVerdict ?? "not_found"]}.</p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select value={verdict} onValueChange={setVerdict}>
                  <SelectTrigger className="h-9 sm:w-56" aria-label="Verdict"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {(["found", "partly_found", "not_found"] as const).map((v) => <SelectItem key={v} value={v}>{VERDICT_WORDS[v]}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Your note (optional)" className="h-9" maxLength={2000} />
              </div>
              <Button size="sm" className="h-9 bg-teal text-teal-foreground hover:bg-teal/90" disabled={act.isPending}
                onClick={() => act.mutate({ method: "POST", url: `/api/deals/${dealId}/gl/traces/${trace.id}/review`, body: { verdict, note } })} data-testid="gl-drawer-mark-reviewed">
                Mark reviewed
              </Button>
            </>
          )}
        </section>
      )}

      {/* More options */}
      <section>
        <button type="button" className="text-sm text-teal flex items-center gap-1" onClick={() => setMore((v) => !v)} aria-expanded={more} data-testid="gl-drawer-more">
          {more ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} More options
        </button>
        {more && <MoreOptions dealId={dealId} trace={trace} year={year} busy={act.isPending} patch={patch} onLookAgain={() => act.mutate({ method: "POST", url: `/api/deals/${dealId}/gl/traces/${trace.id}/look-again` }, { onSuccess: (r: any) => toast({ title: "Cimple looked again", description: r?.unconfident && trace.sentAt ? "The rules' suggestions are up to date; Cimple's assistant may add a few more in a moment." : "The suggested entries are up to date." }) })} rejected={rejected} onUnreject={(e) => links({ remove: [{ ledgerId: e.ledgerId, rowNo: e.rowNo }] })} docShort={docShort} />}
      </section>

      <div className="pt-1">
        <Button variant="ghost" size="sm" className="h-9 text-xs" onClick={onClose}>Close</Button>
      </div>
    </div>
  );
}

function Figure({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-border px-2 py-2 min-w-0">
      <p className="text-2xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums mt-0.5">{value}</p>
      {sub && <p className="text-2xs text-muted-foreground mt-0.5 break-words">{sub}</p>}
    </div>
  );
}

function EntryTable({ rows, onTick, busy }: { rows: BrokerEntry[]; onTick: (e: BrokerEntry, tick: boolean) => void; busy: boolean }) {
  const total = rows.filter((r) => r.state === "confirmed").reduce((s, r) => s + r.amountCents, 0);
  return (
    <div className="rounded-md border border-border">
      <ul className="divide-y divide-border max-h-[22rem] overflow-y-auto">
        {rows.map((e) => {
          const ticked = e.state === "confirmed";
          return (
            <li key={e.id} className="flex items-start gap-2 px-3 py-2 text-xs">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[hsl(var(--teal))]" checked={ticked} disabled={busy}
                aria-label={`Tick: ${ledgerDate(e.date)} · ${e.name ?? ""} · ${money(e.amountCents)}`} onChange={(ev) => onTick(e, ev.target.checked)} />
              <div className="flex-1 min-w-0">
                <p className="flex flex-wrap gap-x-2"><span className="tabular-nums text-muted-foreground">{ledgerDate(e.date)}</span><span className="font-medium break-words">{e.name || "—"}</span></p>
                <p className="text-muted-foreground break-words">{accountPath(e.account)}{e.memo ? ` · ${e.memo}` : ""}</p>
                <p className="text-2xs text-muted-foreground mt-0.5">
                  {ticked ? (e.decidedBy === "seller" ? "Ticked by the seller" : "Ticked by you") : e.reason ? `Suggested: ${e.reason}` : "Suggested by Cimple"}
                  {e.privateLedger ? " · private ledger" : ""}
                </p>
              </div>
              <span className="tabular-nums font-medium shrink-0">{money(e.amountCents)}</span>
            </li>
          );
        })}
      </ul>
      <p className="px-3 py-2 border-t border-border text-xs text-right">Ticked: <strong className="tabular-nums">{money(total)}</strong></p>
    </div>
  );
}

function MoreOptions({ dealId, trace, year, busy, patch, onLookAgain, rejected, onUnreject, docShort }: {
  dealId: string; trace: BrokerTrace; year: string; busy: boolean; patch: (b: Record<string, unknown>) => void; onLookAgain: () => void;
  rejected: BrokerEntry[]; onUnreject: (e: BrokerEntry) => void; docShort: string;
}) {
  const [sellerLabel, setSellerLabel] = useState(trace.sellerLabel);
  const [sellerHint, setSellerHint] = useState(trace.sellerHint ?? "");
  const [share, setShare] = useState(trace.sharePct ? String(trace.sharePct) : "");
  const [basis, setBasis] = useState(trace.shareBasis ?? "estimate");
  const [basisDoc, setBasisDoc] = useState(trace.shareBasisDoc ?? "");
  const [reason, setReason] = useState(trace.buyerReason ?? "");
  const [leaveReason, setLeaveReason] = useState("");
  const [applying, setApplying] = useState(false);
  const left = trace.leftOut?.years ?? [];
  const yearLeft = left.includes(year);
  const proofs = useMemo(() => (["ledger", "payroll", "one_off", "statement"] as const), []);
  return (
    <div className="mt-3 space-y-4 rounded-lg border border-border p-3" data-testid="gl-drawer-options">
      <div className="space-y-1.5">
        <Label className="text-xs">Proof to ask for</Label>
        <Select value={trace.proof} onValueChange={(v) => patch({ proof: v })}>
          <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
          <SelectContent>
            {proofs.map((p) => <SelectItem key={p} value={p}>{p === "payroll" ? `Pay slips (${docShort}) or payroll summary` : PROOF_LABEL[p]}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">What the seller sees</Label>
        <Input value={sellerLabel} onChange={(e) => setSellerLabel(e.target.value)} maxLength={120} className="h-9" aria-label="The cost's name for the seller" />
        <Input value={sellerHint} onChange={(e) => setSellerHint(e.target.value)} maxLength={300} className="h-9" placeholder="What they're looking for" aria-label="What the seller is looking for" />
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy || (!sellerLabel.trim())} onClick={() => patch({ sellerLabel, sellerHint })}>Save what the seller sees</Button>
      </div>

      {trace.proof !== "statement" && trace.proof !== "payroll" && (
        <div className="space-y-1.5">
          <Label className="text-xs">Share added back</Label>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex items-center gap-1"><Input value={share} onChange={(e) => setShare(e.target.value.replace(/[^\d]/g, "").slice(0, 3))} className="h-9 w-20" inputMode="numeric" aria-label="Percent added back" placeholder="100" /><span className="text-sm">%</span></div>
            <Select value={basis} onValueChange={setBasis}>
              <SelectTrigger className="h-9 sm:w-56"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="estimate">The owner's estimate</SelectItem>
                <SelectItem value="documented">Documented by…</SelectItem>
              </SelectContent>
            </Select>
            {basis === "documented" && <Input value={basisDoc} onChange={(e) => setBasisDoc(e.target.value)} placeholder="e.g. the vehicle logbook" className="h-9" maxLength={200} />}
          </div>
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy}
            onClick={() => patch(share ? { sharePct: Number(share), shareBasis: basis, shareBasisDoc: basis === "documented" ? basisDoc : null } : { sharePct: null })}>Save the share</Button>
        </div>
      )}

      {year && trace.proof !== "statement" && (
        <div className="space-y-1.5">
          <Label className="text-xs">{yearLeft ? `${year} is left out` : `Leave ${year} out`}</Label>
          {yearLeft ? (
            <div className="flex items-center gap-2"><p className="text-xs text-muted-foreground flex-1">{trace.leftOut?.reason}</p>
              <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => { const rest = left.filter((x) => x !== year); patch({ leftOut: rest.length ? { years: rest, reason: trace.leftOut!.reason } : null }); }}>Put it back</Button></div>
          ) : (
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input value={leaveReason} onChange={(e) => setLeaveReason(e.target.value)} placeholder="Why? (required)" className="h-9" maxLength={300} />
              <Button size="sm" variant="outline" className="h-9 text-xs shrink-0" disabled={busy || leaveReason.trim().length < 3}
                onClick={() => patch({ leftOut: { years: Array.from(new Set([...left, year])), reason: leaveReason.trim() } })}>Leave it out</Button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-1.5">
        <Label className="text-xs">Why it's added back <span className="text-muted-foreground">(due-diligence buyers read this)</span></Label>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={1200} placeholder="e.g. The owner's personal vehicle; a buyer won't have this cost." />
        <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => patch({ buyerReason: reason })}>Save the reason</Button>
      </div>

      <div className="space-y-2">
        <Toggle id="gl-show-seller-note" label="Show the seller's explanation to due-diligence buyers" checked={trace.sellerNoteShown} onChange={(v) => patch({ sellerNoteShown: v })} disabled={busy || !trace.sellerNote} />
        <Toggle id="gl-show-broker-note" label="Show my note to due-diligence buyers" checked={trace.brokerNoteShown} onChange={(v) => patch({ brokerNoteShown: v })} disabled={busy || !trace.brokerNote} />
        <Toggle id="gl-include" label="Include in the CIM" checked={trace.includeInCim} onChange={(v) => patch({ includeInCim: v })} disabled={busy} />
      </div>

      {rejected.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium">Marked "not part of it"</p>
          {rejected.map((e) => (
            <div key={e.id} className="flex items-center gap-2 text-xs">
              <span className="flex-1 min-w-0 truncate">{ledgerDate(e.date)} · {e.name ?? accountPath(e.account)} · {money(e.amountCents)}</span>
              <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" disabled={busy} onClick={() => onUnreject(e)}><X className="h-3 w-3" /> Undo</Button>
            </div>
          ))}
        </div>
      )}

      {(trace.proof === "ledger" || trace.proof === "one_off") && year && (trace.computed?.byYear?.[year]?.foundCents ?? 0) > 0 && trace.computed?.byYear?.[year]?.status !== "found" && (
        <div className="space-y-1">
          <Button size="sm" variant="outline" className="h-8 text-xs" disabled={busy} onClick={() => setApplying(true)} data-testid="gl-apply-amount">Use what the ledger shows for {year}</Button>
          <p className="text-2xs text-muted-foreground">Changes the add-back to the entries ticked. You'll see what it changes first.</p>
          <ApplyLedgerAmountDialog dealId={dealId} traceId={trace.id} year={year} open={applying} onOpenChange={setApplying} />
        </div>
      )}
      {trace.proof === "payroll" && <p className="text-2xs text-muted-foreground">Change owner and family pay on the Normalization tab.</p>}

      <Button size="sm" variant="ghost" className="h-8 text-xs gap-1.5" disabled={busy} onClick={onLookAgain} data-testid="gl-look-again">
        <RefreshCw className="h-3.5 w-3.5" /> Look again for likely entries
      </Button>
    </div>
  );
}

function Toggle({ id, label, checked, onChange, disabled }: { id: string; label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <div className="flex items-start gap-2">
      <Switch id={id} checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5" />
      <Label htmlFor={id} className="text-xs font-normal leading-snug">{label}</Label>
    </div>
  );
}
