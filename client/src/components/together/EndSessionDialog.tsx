/**
 * "End session" → the session summary (specs/together.md §4.7): what was
 * filed, what's still to get (critical, "come back later" and "someone else
 * has it" ticked by default — each ask editable), the documents still
 * needed, and what goes back to the seller: their next AI session (on by
 * default) and/or a short email the broker previews and sends. "The
 * interview is complete" is ticked by default only when no critical item is
 * open. Dialog on a laptop, full screen on a phone.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Mail } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { useIsMobile } from "@/hooks/use-mobile";
import { StatusIcon } from "@/components/coverage/StatusIcon";
import { summaryLine, type SittingSummary, type TogetherSittingView } from "@shared/together";

const DOCS_SHOWN = 6;

interface EmailPreview { to: string | null; subject: string; html: string; text: string; asks: string[]; documents: string[]; sent: boolean; recorded: boolean }

export function EndSessionDialog({
  open,
  onOpenChange,
  dealId,
  sitting,
  loadSummary,
  end,
  onDone,
  onUndo,
  onRetry,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dealId: string;
  sitting: TogetherSittingView;
  loadSummary: () => Promise<SittingSummary>;
  end: (body: { completeInterview: boolean; followUps: Array<{ itemId: string; ask: string }>; documents: string[]; addToNextSession: boolean }) => Promise<{ summary: SittingSummary; followUpsAdded: number }>;
  onDone: () => void;
  /** Undo a filing (while the session is live). */
  onUndo?: (chunkId: string, key: string) => Promise<void>;
  /** "Try now" for parts waiting to be filed. */
  onRetry?: () => Promise<void>;
}) {
  const isPhone = useIsMobile();
  const { toast } = useToast();
  const [summary, setSummary] = useState<SittingSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  const [asks, setAsks] = useState<Record<string, string>>({});
  const [docs, setDocs] = useState<Record<string, boolean>>({});
  const [nextSession, setNextSession] = useState(true);
  const [complete, setComplete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [askError, setAskError] = useState<{ itemId: string; message: string } | null>(null);
  const [preview, setPreview] = useState<EmailPreview | null>(null);
  const [emailBusy, setEmailBusy] = useState<"preview" | "send" | null>(null);
  const [allDocs, setAllDocs] = useState(false);

  const ended = sitting.status === "ended";
  const loadRef = useRef(loadSummary);
  loadRef.current = loadSummary;
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadRef.current()
      .then((s) => {
        if (cancelled) return;
        setSummary(s);
        setTicked(Object.fromEntries(s.stillToGet.map((r) => [r.itemId, r.ticked])));
        setAsks(Object.fromEntries(s.stillToGet.map((r) => [r.itemId, r.ask])));
        setDocs(Object.fromEntries(s.documents.map((d) => [d.requirementId, d.ticked])));
        setComplete(s.criticalOpen === 0);
      })
      .catch((e) => { if (!cancelled) setLoadError((e as Error).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  const groups = useMemo(() => {
    const out: Array<{ title: string; rows: SittingSummary["stillToGet"] }> = [];
    for (const r of summary?.stillToGet ?? []) {
      let g = out.find((x) => x.title === r.sectionTitle);
      if (!g) { g = { title: r.sectionTitle, rows: [] }; out.push(g); }
      g.rows.push(r);
    }
    return out;
  }, [summary]);
  const tickedItems = (summary?.stillToGet ?? []).filter((r) => ticked[r.itemId]);
  const tickedDocs = (summary?.documents ?? []).filter((d) => docs[d.requirementId]);
  const critical = (summary?.stillToGet ?? []).filter((r) => r.critical).length;

  const finish = async () => {
    if (!summary) return;
    setSaving(true);
    setAskError(null);
    try {
      await end({
        completeInterview: complete,
        followUps: tickedItems.map((r) => ({ itemId: r.itemId, ask: (asks[r.itemId] ?? r.ask).trim() })),
        documents: tickedDocs.map((d) => d.requirementId),
        addToNextSession: nextSession,
      });
      onDone();
    } catch (e) {
      const err = e as Error & { code?: string; details?: { itemId?: string } };
      if (err.code === "private_ask" && err.details?.itemId) setAskError({ itemId: err.details.itemId, message: err.message });
      else toast({ title: "Couldn't end the session", description: err.message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const email = async (send: boolean) => {
    setEmailBusy(send ? "send" : "preview");
    try {
      const r = await fetch(`/api/deals/${dealId}/together/sittings/${sitting.id}/follow-up-email`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          itemIds: tickedItems.map((t) => t.itemId),
          documentIds: tickedDocs.map((d) => d.requirementId),
          asks: Object.fromEntries(tickedItems.map((t) => [t.itemId, asks[t.itemId] ?? t.ask])),
          preview: !send,
        }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (d.code === "private_ask" && d.itemId) setAskError({ itemId: d.itemId, message: d.error });
        throw new Error(d.error || "Couldn't prepare the email");
      }
      if (!send) setPreview(d as EmailPreview);
      else {
        setPreview(null);
        toast(d.recorded ? { title: "Recorded", description: "This is a demo deal — nothing was emailed." } : d.sent ? { title: "Sent", description: `Emailed to ${d.to}.` } : { title: "The email didn't send", description: "Try again in a moment.", variant: "destructive" });
      }
    } catch (e) {
      toast({ title: "Email", description: (e as Error).message, variant: "destructive" });
    } finally {
      setEmailBusy(null);
    }
  };

  const heading = (t: string) => <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-muted-foreground mb-2">{t}</h3>;

  const body = (
    <div className="space-y-6 text-sm" data-testid="end-session">
      {loading && <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Putting the summary together…</p>}
      {loadError && <p className="text-xs text-destructive">{loadError}</p>}
      {summary && (
        <>
          <p className="text-sm font-medium" data-testid="summary-line">{summaryLine(summary)}</p>
          {summary.screen && <p className="text-xs text-muted-foreground -mt-4">Some values are hidden while the seller can see this screen.</p>}

          <section>
            {heading(`Filed in this session (${summary.filed.length})`)}
            {summary.filed.length === 0 ? (
              <p className="text-xs text-muted-foreground">Nothing was filed in this session.</p>
            ) : (
              <ul className="divide-y divide-border rounded-md border border-border">
                {summary.filed.map((f) => (
                  <li key={f.itemId} className="px-3 py-2 flex items-start gap-2.5">
                    <StatusIcon status={f.status} size={14} className="mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm"><span className="font-medium">{f.label}</span> <span className="text-xs text-muted-foreground">· {f.sectionTitle}</span></p>
                      {f.value && <p className="text-xs text-muted-foreground line-clamp-2">{f.value}</p>}
                      <p className="text-[11px] text-muted-foreground/80">{f.yourNote ? "Your note" : f.quote ? `“${f.quote}”` : null}</p>
                    </div>
                    {!ended && onUndo && f.chunkId && f.key && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
                        onClick={async () => {
                          try {
                            await onUndo(f.chunkId!, f.key!);
                            setSummary((cur) => (cur ? { ...cur, filed: cur.filed.filter((x) => x !== f) } : cur));
                            toast({ title: "Undone", description: f.label });
                          } catch (e) {
                            toast({ title: "Couldn't undo that", description: (e as Error).message, variant: "destructive" });
                          }
                        }}
                        data-testid={`summary-undo-${f.itemId}`}
                      >
                        Undo
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {(summary.alsoNoted > 0 || summary.privateNotes > 0) && (
              <p className="mt-2 text-xs text-muted-foreground">
                {summary.alsoNoted > 0 && <>Also noted ({summary.alsoNoted}). </>}
                {summary.privateNotes > 0 && <>Kept as private notes ({summary.privateNotes}) — on the Interview tab.</>}
              </p>
            )}
          </section>

          <section>
            {heading(`Still to get (${summary.stillToGet.length}${critical ? `, ${critical} critical` : ""})`)}
            {groups.length === 0 ? (
              <p className="text-xs text-muted-foreground">Everything on the checklist is on file.</p>
            ) : (
              <div className="space-y-3">
                {groups.map((g) => (
                  <div key={g.title}>
                    <p className="text-xs font-medium mb-1">{g.title}</p>
                    <ul className="space-y-1.5">
                      {g.rows.map((r) => (
                        <li key={r.itemId} className="flex items-start gap-2.5">
                          <Checkbox checked={!!ticked[r.itemId]} onCheckedChange={(v) => setTicked((p) => ({ ...p, [r.itemId]: v === true }))} className="mt-1" aria-label={`Follow up: ${r.label}`} data-testid={`check-followup-${r.itemId}`} />
                          <div className="min-w-0 flex-1 space-y-1">
                            <p className="text-sm flex items-center gap-1.5">
                              <StatusIcon status={r.status} size={12} />
                              <span>{r.label}</span>
                              {r.critical && <span className="text-[9.5px] font-semibold uppercase tracking-[0.08em] text-teal">Critical</span>}
                            </p>
                            {ticked[r.itemId] && (
                              <Textarea
                                value={asks[r.itemId] ?? r.ask}
                                onChange={(e) => { setAsks((p) => ({ ...p, [r.itemId]: e.target.value.replace(/\n/g, " ").slice(0, 300) })); if (askError?.itemId === r.itemId) setAskError(null); }}
                                rows={2}
                                className={`min-h-0 resize-none py-1.5 text-xs ${askError?.itemId === r.itemId ? "border-destructive" : ""}`}
                                aria-label={`Question for ${r.label}`}
                              />
                            )}
                            {askError?.itemId === r.itemId && <p className="text-[11px] text-destructive">{askError.message}</p>}
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            {heading(`Documents still needed (${summary.documents.length})`)}
            {summary.documents.length === 0 ? (
              <p className="text-xs text-muted-foreground">No documents outstanding.</p>
            ) : (
              <ul className="space-y-1.5">
                {(allDocs ? summary.documents : summary.documents.slice(0, DOCS_SHOWN)).map((d) => (
                  <li key={d.requirementId} className="flex items-center gap-2.5">
                    <Checkbox checked={!!docs[d.requirementId]} onCheckedChange={(v) => setDocs((p) => ({ ...p, [d.requirementId]: v === true }))} aria-label={`Ask for ${d.name}`} />
                    <span className="text-sm">{d.name}</span>
                    {d.promised && <span className="text-[10px] rounded-full border border-teal/40 px-1.5 text-teal">Seller will send it</span>}
                    {d.required && !d.promised && <span className="text-[10px] text-muted-foreground">Required</span>}
                  </li>
                ))}
                {!allDocs && summary.documents.length > DOCS_SHOWN && (
                  <li>
                    <button type="button" className="text-xs text-teal hover:underline underline-offset-2" onClick={() => setAllDocs(true)} data-testid="button-show-all-docs">
                      Show all {summary.documents.length} ({tickedDocs.length} ticked)
                    </button>
                  </li>
                )}
              </ul>
            )}
          </section>

          {ended && (
            <section className="rounded-md border border-border p-3 text-xs text-muted-foreground space-y-1" data-testid="summary-choices">
              <p>{summary.followUpsAdded ? `${summary.followUpsAdded} ${summary.followUpsAdded === 1 ? "question was" : "questions were"} added to the seller's next AI session.` : "Nothing was added to the seller's next AI session."}</p>
              <p>{summary.completeInterview ? "The interview was marked complete." : "The interview was left open."}</p>
            </section>
          )}
          <section className={`space-y-3 rounded-md border border-border p-3 ${ended ? "hidden" : ""}`}>
            <label className="flex items-start gap-2.5 cursor-pointer">
              <Checkbox checked={nextSession} onCheckedChange={(v) => setNextSession(v === true)} className="mt-0.5" data-testid="check-next-session" />
              <span>
                <span className="text-sm">Ask the seller in their next AI session</span>
                <span className="block text-xs text-muted-foreground">Their interview raises the ticked questions first.</span>
              </span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" className="gap-1.5" disabled={emailBusy !== null || (tickedItems.length === 0 && tickedDocs.length === 0)} onClick={() => void email(false)} data-testid="button-email-preview">
                {emailBusy === "preview" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Mail className="h-3.5 w-3.5" />} Email the seller this list…
              </Button>
              {summary.emailedAt && <span className="text-xs text-muted-foreground">Sent {new Date(summary.emailedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>}
            </div>
            <label className="flex items-start gap-2.5 cursor-pointer pt-1 border-t border-border">
              <Checkbox checked={complete} onCheckedChange={(v) => setComplete(v === true)} className="mt-0.5" data-testid="check-complete" />
              <span>
                <span className="text-sm">The interview is complete — move the deal on</span>
                {summary.criticalOpen > 0 && <span className="block text-xs tg-warn-text">{summary.criticalOpen} critical data {summary.criticalOpen === 1 ? "point is" : "points are"} still open.</span>}
              </span>
            </label>
          </section>

          {summary.waiting > 0 && (
            <div className="flex flex-wrap items-center gap-2" data-testid="summary-waiting">
              <p className="text-xs tg-warn-text flex-1 min-w-0">{summary.waiting} {summary.waiting === 1 ? "part" : "parts"} of the conversation are waiting to be filed. They'll be filed automatically when Cimple's AI is back — nothing is lost.</p>
              {onRetry && (
                <Button size="sm" variant="outline" className="h-7 text-xs" onClick={async () => {
                  try {
                    await onRetry();
                    toast({ title: "Trying again" });
                  } catch (e) {
                    toast({ title: "Couldn't try again", description: (e as Error).message, variant: "destructive" });
                  }
                }}>
                  Try now
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );

  const actions = (
    <>
      <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving} data-testid="button-keep-going">{ended ? "Close" : "Keep going"}</Button>
      {!ended && (
        <Button className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={finish} disabled={saving || !summary} data-testid="button-end-done">
          {saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Done
        </Button>
      )}
    </>
  );

  const previewDialog = (
    <Dialog open={!!preview} onOpenChange={(o) => { if (!o) setPreview(null); }}>
      <DialogContent className="max-w-lg max-h-[85vh] p-0 gap-0 flex flex-col overflow-hidden [&>*]:min-w-0" data-testid="email-preview">
        <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
          <DialogTitle>Email the seller</DialogTitle>
          <DialogDescription>{preview?.to ? `To ${preview.to}` : "There's no email address for the seller on this deal yet."}</DialogDescription>
        </DialogHeader>
        {preview && (
          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4">
            <div className="rounded-md border border-border bg-[#FBF9F4] text-[#201D18] p-4 text-sm">
              <p className="text-xs text-[#6b655c] mb-2">Subject: {preview.subject}</p>
              <div className="[&_ul]:list-disc [&_ul]:pl-5 [&_p]:my-2" dangerouslySetInnerHTML={{ __html: preview.html }} />
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">Nothing is sent until you click Send.</p>
          </div>
        )}
        <DialogFooter className="shrink-0 border-t border-border px-6 py-3">
          <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
          <Button className="bg-teal text-teal-foreground hover:bg-teal/90" disabled={!preview?.to || emailBusy !== null} onClick={() => void email(true)} data-testid="button-email-send">
            {emailBusy === "send" && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Send
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  if (isPhone) {
    return (
      <>
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent side="bottom" className="h-[100dvh] max-h-[100dvh] overflow-y-auto px-4 pb-24 pt-5 rounded-none">
            <SheetHeader className="text-left">
              <SheetTitle>Session summary</SheetTitle>
              <SheetDescription className="sr-only">What was filed, what's still to get, and what goes back to the seller.</SheetDescription>
            </SheetHeader>
            <div className="mt-4">{body}</div>
            <div className="fixed bottom-0 inset-x-0 border-t border-border bg-card/95 backdrop-blur px-4 py-3 flex justify-end gap-2">{actions}</div>
          </SheetContent>
        </Sheet>
        {previewDialog}
      </>
    );
  }
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[88vh] p-0 gap-0 flex flex-col overflow-hidden [&>*]:min-w-0">
          <DialogHeader className="px-6 pt-6 pb-3 shrink-0">
            <DialogTitle>Session summary</DialogTitle>
            <DialogDescription className="sr-only">What was filed, what's still to get, and what goes back to the seller.</DialogDescription>
          </DialogHeader>
          <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-5">{body}</div>
          <DialogFooter className="shrink-0 border-t border-border px-6 py-3 bg-background">{actions}</DialogFooter>
        </DialogContent>
      </Dialog>
      {previewDialog}
    </>
  );
}
