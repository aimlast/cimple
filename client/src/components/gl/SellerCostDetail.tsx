/**
 * SellerCostDetail — one cost, one year at a time (gl spec §3.3 C), at
 * /seller/:token/books?cost=…&year=…:
 *   the broker's question (and the reply box), "Your broker updated this
 *   amount", the years as chips, the sticky reconcile bar, the entries
 *   Cimple suggests (grouped by account, Tick all), "Add an entry we missed"
 *   (search), the documents (T4 / invoice) with what Cimple saw on them,
 *   "Something's off?", "This isn't in my ledger", then Next year / Done
 *   with this cost. Every tick saves at once.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Check, FileText, Loader2, MessageSquare, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { getJson, glKeys, sendJson, type SellerCost, type SellerEntriesData, type SellerEntry } from "@/lib/gl-api";
import { queryClient } from "@/lib/queryClient";
import { ReconcileBar } from "./ReconcileBar";
import { EntryGroup, EntryRow, LedgerSearch, entryKey } from "./EntryRow";
import { SupportDocUpload, docCheckWords } from "./SupportDocUpload";
import { Pill, dollars, statusTone } from "./gl-ui";

export function SellerCostDetail({ token, cost, year, onYear, onBack, payDoc, preview, onSaving }: {
  token: string;
  cost: SellerCost;
  year: string;
  onYear: (y: string) => void;
  onBack: () => void;
  payDoc: { slips: string; short: string; box: string | null };
  preview?: boolean;
  onSaving: (s: "saving" | "saved" | "error") => void;
}) {
  const { toast } = useToast();
  const [answer, setAnswer] = useState("");
  const [offOpen, setOffOpen] = useState(false);
  const [offText, setOffText] = useState(cost.note ?? "");
  const [notInOpen, setNotInOpen] = useState(false);
  const [notInScope, setNotInScope] = useState<"year" | "all">(cost.years.length > 1 ? "year" : "all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [docOpen, setDocOpen] = useState(cost.proof === "payroll");
  const y = cost.years.find((x) => x.year === year) ?? cost.years[cost.years.length - 1];
  const idx = cost.years.findIndex((x) => x.year === y?.year);
  const entriesQ = useQuery<SellerEntriesData>({
    queryKey: glKeys.sellerEntries(token, cost.id),
    queryFn: () => getJson<SellerEntriesData>(`/api/seller/${token}/gl/entries?trace=${cost.id}`),
    refetchInterval: (q) => ((q.state.data?.documents ?? []).some((d) => d.check === null) ? 3000 : false),
  });
  const refresh = () => {
    void entriesQ.refetch();
    void queryClient.invalidateQueries({ queryKey: glKeys.seller(token) });
  };
  const write = useMutation({
    mutationFn: ({ method = "POST", url, body }: { method?: string; url: string; body?: unknown }) => sendJson(method, url, body ?? {}),
    onMutate: () => onSaving("saving"),
    onSuccess: () => { onSaving("saved"); refresh(); },
    onError: (e: unknown) => { onSaving("error"); toast({ title: "That didn't save", description: e instanceof Error ? e.message : undefined, variant: "destructive" }); refresh(); },
  });
  const tick = (e: SellerEntry, on: boolean) => write.mutate({ method: "PUT", url: `/api/seller/${token}/gl/traces/${cost.id}/links`, body: { fy: e.fiscalYear, ...(on ? { add: [{ ledgerId: e.ledgerId, rowNo: e.rowNo }] } : { remove: [{ ledgerId: e.ledgerId, rowNo: e.rowNo }] }) } });
  const tickMany = (es: SellerEntry[], on: boolean) => write.mutate({ method: "PUT", url: `/api/seller/${token}/gl/traces/${cost.id}/links`, body: { fy: y?.year, [on ? "add" : "remove"]: es.map((e) => ({ ledgerId: e.ledgerId, rowNo: e.rowNo })) } });
  const reject = (es: SellerEntry[]) => write.mutate({ method: "PUT", url: `/api/seller/${token}/gl/traces/${cost.id}/links`, body: { fy: y?.year, reject: es.map((e) => ({ ledgerId: e.ledgerId, rowNo: e.rowNo })) } });

  const entries = (entriesQ.data?.entries ?? []).filter((e) => e.fiscalYear === y?.year);
  const docs = (entriesQ.data?.documents ?? []).filter((d) => d.fiscalYear === y?.year);
  const confirmed = entries.filter((e) => e.state === "confirmed");
  const suggested = entries.filter((e) => e.state === "proposed" || e.state === "confirmed");
  const rejected = entries.filter((e) => e.state === "rejected");
  const isChecked = (e: SellerEntry) => confirmed.some((c) => entryKey(c) === entryKey(e));
  const tickedCents = confirmed.reduce((s, e) => s + e.amountCents, 0);
  const docCents = docs.reduce((s, d) => s + Math.abs(d.amountCents), 0);
  const groups = useMemo(() => {
    const m = new Map<string, SellerEntry[]>();
    for (const e of suggested) m.set(e.account, [...(m.get(e.account) ?? []), e]);
    return Array.from(m.entries());
  }, [suggested]);
  if (!y) return null;
  const last = idx >= cost.years.length - 1;
  const pending = write.isPending || !!preview;
  // "This isn't in my ledger": for this year only (then on to the next year) or for every year (then back to the list).
  const notIn = (reason: "personal" | "unsure") => {
    const yearOnly = notInScope === "year" && cost.years.length > 1;
    write.mutate(
      { url: `/api/seller/${token}/gl/traces/${cost.id}/not-in-ledger`, body: { reason, ...(yearOnly ? { fy: y.year } : {}) } },
      { onSuccess: () => { setNotInOpen(false); if (yearOnly && !last) onYear(cost.years[idx + 1].year); else onBack(); } },
    );
  };

  return (
    <div className="space-y-5" data-testid="books-cost">
      <button type="button" onClick={onBack} className="text-sm text-teal flex items-center gap-1 min-h-[36px]"><ArrowLeft className="h-4 w-4" /> All costs</button>
      <div>
        <h2 className="text-lg font-semibold tracking-tight break-words">{cost.sellerLabel}</h2>
        {cost.sellerHint && <p className="text-sm text-muted-foreground mt-0.5">{cost.sellerHint}</p>}
      </div>

      {cost.question && (
        <div className="rounded-lg border border-teal/40 bg-teal/5 p-3 space-y-2" data-testid="cost-question">
          <p className="text-sm flex items-start gap-2"><MessageSquare className="h-4 w-4 text-teal mt-0.5 shrink-0" /><span>Your broker asks: "{cost.question.text}"</span></p>
          {cost.question.answer ? (
            <p className="text-sm text-muted-foreground">You answered: "{cost.question.answer}"</p>
          ) : (
            <>
              <Textarea value={answer} onChange={(e) => setAnswer(e.target.value)} rows={2} maxLength={2000} placeholder="Your answer" aria-label="Your answer" />
              <Button size="sm" className="h-9 bg-teal text-teal-foreground hover:bg-teal/90" disabled={pending || !answer.trim()} onClick={() => write.mutate({ url: `/api/seller/${token}/gl/traces/${cost.id}/answer`, body: { text: answer } }, { onSuccess: () => setAnswer("") })}>Send your answer</Button>
            </>
          )}
        </div>
      )}
      {cost.reopenedNote && (
        <p className="rounded-lg border border-teal/40 bg-teal/5 p-3 text-sm flex items-start gap-2"><RotateCcw className="h-4 w-4 text-teal mt-0.5 shrink-0" />{cost.reopenedNote}</p>
      )}

      {cost.years.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0" role="tablist" aria-label="Year">
          {cost.years.map((x) => (
            <button key={x.year} type="button" role="tab" aria-selected={x.year === y.year} onClick={() => onYear(x.year)}
              ref={(el) => { if (el && x.year === y.year) el.scrollIntoView({ block: "nearest", inline: "nearest" }); }}
              className={cn("shrink-0 rounded-full border px-3 py-1.5 text-xs min-h-[36px]", x.year === y.year ? "border-teal bg-teal/10 text-teal" : "border-border text-muted-foreground")}>
              {x.chip}
            </button>
          ))}
        </div>
      )}

      <ReconcileBar tickedCents={tickedCents} documentCents={docCents} targetCents={y.targetCents} claimedCents={y.claimedCents} label={cost.sellerLabel} sharePct={cost.shareWords ? Math.round((y.claimedCents / Math.max(1, y.targetCents)) * 100) : null} payroll={cost.proof === "payroll"} year={y.year} />

      {!y.inLedger && (
        <p className="text-sm rounded-lg border border-border bg-muted/30 p-3">Your ledger doesn't include {y.year}. Add {y.year}'s ledger, or tap "This isn't in my ledger".</p>
      )}

      {entriesQ.isLoading ? (
        <p className="text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Loading the entries…</p>
      ) : entriesQ.error ? (
        <p className="text-sm text-red-500">Couldn't load the entries. <button className="underline" onClick={() => entriesQ.refetch()}>Try again</button></p>
      ) : groups.length > 0 ? (
        <section className="space-y-2">
          <p className="text-sm">These look like they make up your <strong>{dollars(y.targetCents)} {cost.sellerLabel.charAt(0).toLowerCase() + cost.sellerLabel.slice(1)}</strong> for <strong>{y.year}</strong>. Tick the ones that are right.</p>
          {groups.map(([account, es]) => (
            <EntryGroup key={account} account={account} entries={es} isChecked={isChecked} onToggle={tick} onAll={(v) => tickMany(es, v)} disabled={pending} />
          ))}
          {suggested.some((e) => e.state === "proposed") && (
            <button type="button" className="text-xs text-muted-foreground hover:text-foreground" disabled={pending} onClick={() => reject(suggested.filter((e) => e.state === "proposed"))}>None of the others are part of it</button>
          )}
        </section>
      ) : y.inLedger && cost.proof !== "payroll" ? (
        <p className="text-sm text-muted-foreground">Cimple didn't find likely entries for {y.year}. Search for them below, or tell your broker what's different.</p>
      ) : null}

      {rejected.length > 0 && (
        <details className="rounded-lg border border-border">
          <summary className="px-3 py-2 text-sm cursor-pointer">Not part of it ({rejected.length})</summary>
          <div className="divide-y divide-border border-t border-border">
            {rejected.map((e) => <EntryRow key={entryKey(e)} e={e} checked={false} disabled={pending} onChange={(v) => v && tick(e, true)} />)}
          </div>
        </details>
      )}

      <section className="space-y-2">
        {!searchOpen ? (
          <Button variant="outline" className="h-10" onClick={() => setSearchOpen(true)}>Add an entry we missed</Button>
        ) : (
          <LedgerSearch searchUrl={`/api/seller/${token}/gl/search`} years={[y.year]} isChecked={isChecked} onAdd={tick} disabled={pending} />
        )}
      </section>

      {(docs.length > 0 || cost.proof !== "ledger") && (
        <section className="space-y-2">
          {docs.map((d) => {
            const w = docCheckWords(d.check, dollars(d.amountCents));
            return (
              <div key={`${d.documentId}-${d.fiscalYear}`} className="rounded-md border border-border px-3 py-2 text-sm flex flex-wrap items-center gap-2" data-testid="cost-doc">
                <FileText className="h-4 w-4 text-muted-foreground" /><span className="break-all">{d.name}</span>
                <Pill tone={w.tone}>{d.check === "found_in_document" && <Check className="h-3 w-3" />}{w.text}</Pill>
              </div>
            );
          })}
          {docOpen ? (
            <SupportDocUpload uploadUrl={`/api/seller/${token}/gl/traces/${cost.id}/support-docs`} years={cost.years.map((x) => x.year)} kind={cost.proof === "payroll" ? "payroll" : cost.proof === "one_off" ? "one_off" : "other"} payDoc={payDoc} disabled={!!preview}
              personWord={cost.sellerLabel === "Your pay as owner" ? "Your" : cost.sellerLabel.replace(/ pay$/, "")} onDone={refresh} />
          ) : (
            <Button variant="outline" className="h-10" onClick={() => setDocOpen(true)}>{cost.proof === "one_off" ? "Upload the letter or invoice" : "It's in another document"}</Button>
          )}
        </section>
      )}

      <section className="space-y-2">
        <button type="button" className="text-sm text-teal hover:underline" onClick={() => setOffOpen((v) => !v)} aria-expanded={offOpen}>Something's off?</button>
        {offOpen && (
          <div className="space-y-2">
            <Textarea value={offText} onChange={(e) => setOffText(e.target.value)} rows={3} maxLength={2000} placeholder="Tell your broker what's different — e.g. 'Half of the fuel was for the service vans.'" aria-label="What's different" />
            <Button size="sm" variant="outline" className="h-9" disabled={pending || !offText.trim()} onClick={() => write.mutate({ url: `/api/seller/${token}/gl/traces/${cost.id}/note`, body: { text: offText, off: true } }, { onSuccess: () => { setOffOpen(false); toast({ title: "Sent to your broker" }); } })}>Send to my broker</Button>
          </div>
        )}
        <div>
          <button type="button" className="text-sm text-teal hover:underline" onClick={() => setNotInOpen((v) => !v)} aria-expanded={notInOpen}>This isn't in my ledger</button>
          {notInOpen && (
            <div className="mt-2 space-y-2">
              {cost.years.length > 1 && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm" role="radiogroup" aria-label="Which years">
                  <label className="flex items-center gap-1.5 min-h-[32px]">
                    <input type="radio" className="h-4 w-4 accent-[hsl(var(--teal))]" name={`notin-${cost.id}`} checked={notInScope === "year"} onChange={() => setNotInScope("year")} /> Only {y.year}
                  </label>
                  <label className="flex items-center gap-1.5 min-h-[32px]">
                    <input type="radio" className="h-4 w-4 accent-[hsl(var(--teal))]" name={`notin-${cost.id}`} checked={notInScope === "all"} onChange={() => setNotInScope("all")} /> Every year
                  </label>
                </div>
              )}
              <div className="grid gap-2 sm:grid-cols-3">
                <Button variant="outline" className="h-auto min-h-10 whitespace-normal text-left justify-start" disabled={pending} onClick={() => notIn("personal")}>I paid it personally, outside the business</Button>
                <Button variant="outline" className="h-auto min-h-10 whitespace-normal text-left justify-start" onClick={() => { setDocOpen(true); setNotInOpen(false); }}>It's in another document</Button>
                <Button variant="outline" className="h-auto min-h-10 whitespace-normal text-left justify-start" disabled={pending} onClick={() => notIn("unsure")}>I'm not sure</Button>
              </div>
            </div>
          )}
        </div>
      </section>

      <div className="flex flex-col gap-2 sm:flex-row sm:justify-end pt-2 border-t border-border">
        {!last ? (
          <Button className="h-11 sm:h-10 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => onYear(cost.years[idx + 1].year)}>Next year ({cost.years[idx + 1].year})</Button>
        ) : (
          <Button className="h-11 sm:h-10 bg-teal text-teal-foreground hover:bg-teal/90" disabled={pending} data-testid="cost-done"
            onClick={() => write.mutate({ url: `/api/seller/${token}/gl/traces/${cost.id}/status`, body: { status: "done" } }, { onSuccess: onBack })}>
            Done with this cost
          </Button>
        )}
      </div>
      <p className="sr-only" aria-live="polite">{cost.years.map((x) => `${x.chip}`).join(", ")}</p>
      <span className="hidden">{statusTone(y.status)}</span>
    </div>
  );
}
