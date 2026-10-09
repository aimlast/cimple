/**
 * "About this document" beside the viewer (vdr spec §6.3): the description
 * the broker accepted (or the basic line), key figures (buyer-safe), what
 * it was checked against (due diligence only), the memorandum pages that use
 * it, the reader's questions about it (and answers the broker shared with
 * everyone who can open it), and "Ask about this document" — straight to
 * the broker, no AI.
 */
import { useState } from "react";
import { CheckCircle2, CircleAlert, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { BuyerItemAbout } from "@shared/vdr-api";
import { figureLines, hasPages } from "@shared/vdr";
import { shortDate, sourceKey, vdrFetch, vdrUrls, type VdrSource } from "@/hooks/useDataRoom";

export function AboutPanel({ about, source, page, memoHref }: { about: BuyerItemAbout; source?: VdrSource; page?: number | null; memoHref?: (sectionId: string) => string }) {
  return (
    <div className="space-y-5 text-sm" data-testid="vdr-about">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">About this document</h3>
        <p className="mt-1.5 font-medium text-foreground">{about.title}</p>
        <p className="text-xs text-muted-foreground">{about.sizeLabel}</p>
      </div>
      <div>
        <p className="leading-relaxed text-foreground/90">{about.description.text}</p>
        {about.description.points.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-foreground/90">
            {about.description.points.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}
      </div>

      {(about.keyFigures?.length ?? 0) > 0 && (
        <section>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Key figures</h4>
          <dl className="space-y-1">
            {about.keyFigures!.map((f, i) => (
              <div key={i} className="flex items-start justify-between gap-3 text-xs">
                {/* The label keeps at least 40% of the row; a long value wraps under itself (checker r2 R2-5). */}
                <dt className="min-w-[40%] max-w-[60%] shrink-0 text-muted-foreground">{f.label}</dt>
                <dd className="min-w-0 flex-1 break-words text-right text-foreground/90">{figureLines(f.value).map((l, j, all) => <span key={j} className={all.length > 1 ? "block whitespace-nowrap" : "block"}>{l}</span>)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}

      {(about.checks?.length ?? 0) > 0 && (
        <section>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Checked against other documents</h4>
          <ul className="space-y-1.5">
            {about.checks!.map((c, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs">
                {c.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-teal" />}
                <span className="text-foreground/90">{c.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {(about.usedIn?.length ?? 0) > 0 && (
        <section>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Used in the memorandum</h4>
          <ul className="space-y-1">
            {about.usedIn!.map((u) => (
              <li key={u.sectionId} className="text-xs">
                {memoHref ? <a href={memoHref(u.sectionId)} className="text-teal hover:underline">{u.title} →</a> : <span>{u.title}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Only a document with pages (PDF, photo) names one: a sheet's or a Word file's question is never "about page 1". */}
      {about.questions && <Questions about={about} source={source} page={hasPages(about.manifest.kind) ? page ?? null : null} />}
    </div>
  );
}

function Questions({ about, source, page }: { about: BuyerItemAbout; source?: VdrSource; page: number | null }) {
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const qs = about.questions ?? [];
  const ask = async () => {
    if (!source) return;
    setBusy(true);
    try {
      await vdrFetch("POST", `${vdrUrls(source).about(about.id)}/questions`, { question: text.trim(), page });
      setText("");
      setSent(true);
      await queryClient.invalidateQueries({ queryKey: [...sourceKey(source), "item", about.id] });
    } catch (e: any) {
      toast({ title: "Couldn't send your question", description: e?.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      {qs.length > 0 && (
        <section data-testid="vdr-your-questions">
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Your questions about it ({qs.filter((q) => q.mine).length})</h4>
          <ul className="space-y-2">
            {qs.map((q) => (
              <li key={q.id} className="rounded-md border border-border px-2.5 py-2 text-xs">
                <p className="text-foreground/90">"{q.question}"</p>
                <p className="mt-0.5 text-muted-foreground">{q.mine ? "You asked" : "Another buyer asked"}{q.page ? ` about page ${q.page}` : ""} · {shortDate(q.at)} · {q.status === "answered" ? "Answered" : "Waiting for the broker"}</p>
                {q.answer && <p className="mt-1.5 border-l-2 border-teal/50 pl-2 text-foreground/90">{q.answer}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {about.canAsk && source && (
        <section>
          <h4 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Ask about this document</h4>
          {sent ? (
            <p className="rounded-md bg-muted/30 px-2.5 py-2 text-xs text-foreground/90" data-testid="vdr-ask-sent">Sent to the broker. You'll see the answer here and in Questions. <button className="underline" onClick={() => setSent(false)}>Ask another</button></p>
          ) : (
            <>
              <Textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} rows={3} placeholder={page ? `Your question about page ${page}…` : about.manifest.kind === "sheet" ? "Your question about this spreadsheet…" : "Your question about this document…"} className="text-xs" data-testid="vdr-ask-input" />
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">It goes to your broker.</span>
                <Button size="sm" onClick={ask} disabled={busy || !text.trim()} data-testid="vdr-ask-send">{busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} Send to the broker</Button>
              </div>
            </>
          )}
        </section>
      )}
    </>
  );
}
