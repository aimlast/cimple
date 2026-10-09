/**
 * PublishEvidenceDialog — "What buyers see about the add-backs" (gl spec
 * §3.4, D30). One tick per version, with exactly what each will show:
 *
 *   Due-diligence CIM  the page "Where each add-back is in the books"
 *   Full CIM           the note under the earnings bridge (exact text)
 *   Blind CIM          the same note (counts and years only)
 *
 * Add-backs can be left out (they leave the counts, never shown as "not
 * found"). The warnings say what buyers won't see and why. Nothing reaches
 * buyers until "Show to buyers"; afterwards removals and private switches
 * apply at once, everything else waits for "Update what buyers see".
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, BookCheck, Eye, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useToast } from "@/hooks/use-toast";
import { getJson, sendJson, type GlPublishPreview, type GlVersions } from "@/lib/gl-api";
import { invalidateGl } from "@/hooks/useGlStatus";
import { glNoteText, type GlEvidencePayload } from "@shared/gl-evidence";
import { GlEvidenceBlock } from "@/components/cim/gl/GlEvidenceBlock";
import { Pill, shortDate } from "./gl-ui";

const STATUS_TONE = { found: "good", document: "good", partly_found: "warn", not_found: "muted", statement: "muted" } as const;

/** The note as it will read with these lines left out (the server builds the same text when publishing). */
export function noteFor(preview: GlPublishPreview, leaveOut: ReadonlySet<string>): string | null {
  const kept = preview.lines.filter((l) => !leaveOut.has(l.key) && l.status !== "statement");
  const years = new Set(kept.flatMap((l) => l.years));
  return glNoteText({
    found: kept.filter((l) => l.status === "found").length,
    documents: kept.filter((l) => l.status === "document").length,
    total: kept.length,
    agreeYears: preview.agreeYears.filter((y) => years.has(y)),
  });
}

export function PublishEvidenceDialog({ open, onOpenChange, dealId }: { open: boolean; onOpenChange: (o: boolean) => void; dealId: string }) {
  const { toast } = useToast();
  const { data, isLoading, error, refetch } = useQuery<GlPublishPreview>({
    queryKey: ["/api/deals", dealId, "gl", "publish-preview"],
    queryFn: () => getJson<GlPublishPreview>(`/api/deals/${dealId}/gl/publish-preview`),
    enabled: open,
    staleTime: 0,
  });
  const [versions, setVersions] = useState<GlVersions>({ dd: true, normal: false, blind: false });
  const [leaveOut, setLeaveOut] = useState<Set<string>>(new Set());
  const [previewing, setPreviewing] = useState(false);
  useEffect(() => {
    if (!open || !data) return;
    setVersions(data.published ? data.published.versions : data.versions);
    setLeaveOut(new Set(data.published ? data.published.leaveOut : data.lines.filter((l) => l.defaultLeftOut).map((l) => l.key)));
  }, [open, data]);

  const note = useMemo(() => (data ? noteFor(data, leaveOut) : null), [data, leaveOut]);
  const keptCount = data ? data.lines.filter((l) => !leaveOut.has(l.key)).length : 0;
  const nothing = !versions.dd && !versions.normal && !versions.blind;
  const notesWithoutText = !versions.dd && !note;

  const publish = useMutation({
    mutationFn: () => sendJson<{ ok: boolean; lines: number }>("POST", `/api/deals/${dealId}/gl/publish`, { versions, leaveOut: Array.from(leaveOut) }),
    onSuccess: (r) => {
      invalidateGl(dealId);
      onOpenChange(false);
      toast({ title: data?.published ? "What buyers see is updated" : "Shown to buyers", description: `${r.lines} add-back${r.lines === 1 ? "" : "s"} in what buyers see.` });
    },
    onError: (e: unknown) => toast({ title: "Couldn't show it to buyers", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });
  const unpublish = useMutation({
    mutationFn: () => sendJson("DELETE", `/api/deals/${dealId}/gl/publish`, {}),
    onSuccess: () => {
      invalidateGl(dealId);
      onOpenChange(false);
      toast({ title: "Taken off what buyers see" });
    },
    onError: (e: unknown) => toast({ title: "That didn't work", description: e instanceof Error ? e.message : undefined, variant: "destructive" }),
  });

  const toggle = (key: string, out: boolean) => setLeaveOut((s) => { const n = new Set(s); if (out) n.add(key); else n.delete(key); return n; });

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto" data-testid="gl-publish-dialog">
          <DialogHeader>
            <DialogTitle>What buyers see about the add-backs</DialogTitle>
            <DialogDescription>
              {data?.published
                ? `Shown to buyers since ${shortDate(data.published.at)}. Your changes here replace what they see.`
                : "Nothing reaches buyers until you click Show to buyers."}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="flex items-center gap-2 py-10 justify-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Getting it ready…</div>
          ) : error || !data ? (
            <div className="py-6 text-sm text-center space-y-2">
              <p>This couldn't load right now.</p>
              <Button size="sm" variant="outline" onClick={() => refetch()}>Try again</Button>
            </div>
          ) : (
            <div className="space-y-5">
              {data.blocked && (
                <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm flex gap-2" data-testid="gl-publish-blocked">
                  <AlertTriangle className="h-4 w-4 text-amber-500 mt-0.5 shrink-0" /> {data.blocked}
                </p>
              )}

              <section className="space-y-3" aria-label="Versions">
                <VersionRow id="gl-v-dd" checked={versions.dd} onChange={(v) => setVersions((x) => ({ ...x, dd: v }))} title="Due-diligence CIM">
                  The page "Where each add-back is in the books": the entries behind each add-back, the documents, and your reasons.
                  <button type="button" className="mt-1 flex items-center gap-1 text-xs text-teal hover:underline" onClick={() => setPreviewing(true)} data-testid="gl-publish-see-page">
                    <Eye className="h-3.5 w-3.5" /> See the page
                  </button>
                </VersionRow>
                <VersionRow id="gl-v-normal" checked={versions.normal} onChange={(v) => setVersions((x) => ({ ...x, normal: v }))} title="Full CIM" reason={!versions.normal ? data.reasons.normal : null}>
                  This note under the earnings bridge:
                  <NoteQuote text={note} />
                </VersionRow>
                <VersionRow id="gl-v-blind" checked={versions.blind} onChange={(v) => setVersions((x) => ({ ...x, blind: v }))} title="Blind CIM" reason={!versions.blind ? data.reasons.blind : null}>
                  The same note — counts and years only, no names or amounts.
                </VersionRow>
              </section>

              {data.lines.length > 0 && (
                <section className="space-y-2">
                  <p className="text-sm font-medium">Leave out of what buyers see</p>
                  <ul className="rounded-lg border border-border divide-y divide-border">
                    {data.lines.map((l) => (
                      <li key={l.key} className="flex items-center gap-3 px-3 py-2">
                        <Checkbox id={`gl-out-${l.key}`} checked={leaveOut.has(l.key)} onCheckedChange={(v) => toggle(l.key, v === true)} aria-label={`Leave out ${l.label}`} />
                        <label htmlFor={`gl-out-${l.key}`} className="flex-1 min-w-0 text-sm break-words cursor-pointer">{l.label}</label>
                        <Pill tone={STATUS_TONE[l.status]}>{l.statusWords}</Pill>
                      </li>
                    ))}
                  </ul>
                  <p className="text-2xs text-muted-foreground">A left-out add-back isn't counted and is never shown as "not found".</p>
                </section>
              )}

              {(data.warnings.length > 0 || data.changes.length > 0) && (
                <section className="space-y-1.5">
                  <p className="text-sm font-medium">Before you {data.published ? "update" : "publish"}</p>
                  <ul className="space-y-1 text-sm text-muted-foreground list-disc pl-5" data-testid="gl-publish-warnings">
                    {data.changes.map((c) => <li key={`c-${c}`}>{c}</li>)}
                    {data.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                </section>
              )}
            </div>
          )}

          <DialogFooter className="gap-2 sm:gap-2 flex-col-reverse sm:flex-row">
            {data?.published && (
              <Button variant="ghost" className="text-muted-foreground sm:mr-auto" disabled={unpublish.isPending} onClick={() => unpublish.mutate()} data-testid="gl-unpublish">
                Stop showing it to buyers
              </Button>
            )}
            <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button
              className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
              disabled={!data?.canPublish || nothing || keptCount === 0 || notesWithoutText || publish.isPending}
              onClick={() => publish.mutate()}
              data-testid="gl-publish-submit"
            >
              {publish.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <BookCheck className="h-4 w-4" />}
              {data?.published ? "Update what buyers see" : "Show to buyers"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <EvidencePreviewSheet dealId={dealId} open={previewing} onOpenChange={setPreviewing} />
    </>
  );
}

function VersionRow({ id, checked, onChange, title, reason, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; title: string; reason?: string | null; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border p-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-0.5" data-testid={id} />
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="text-sm font-medium cursor-pointer">{title}</label>
        <div className="mt-0.5 text-sm text-muted-foreground">{children}</div>
        {reason && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{reason}</p>}
      </div>
    </div>
  );
}

function NoteQuote({ text }: { text: string | null }) {
  if (!text) return <p className="mt-1 text-xs italic">No note — none of these add-backs was found in the books.</p>;
  return <blockquote className="mt-1.5 border-l-2 border-teal/50 pl-3 text-sm italic text-foreground/90" data-testid="gl-publish-note">"{text}"</blockquote>;
}

/**
 * The DD page on the CIM paper. source "live": the data as it stands (the
 * publish dialog's "See the page"); "preview": what buyers see now when it's
 * published, else the live data marked "Not shown to buyers yet".
 */
export function EvidencePreviewSheet({ dealId, open, onOpenChange, source = "live" }: { dealId: string; open: boolean; onOpenChange: (o: boolean) => void; source?: "live" | "preview" }) {
  const { data, isLoading, error } = useQuery<{ payload: GlEvidencePayload | null; publishedAt: string | null }>({
    queryKey: ["/api/deals", dealId, "gl", "evidence", "dd", source],
    queryFn: () => getJson(`/api/deals/${dealId}/gl/evidence?mode=dd&source=${source}`),
    enabled: open,
    staleTime: 0,
  });
  // Live data on a deal already shown to buyers: they see it after "Update what buyers see", not "after you publish".
  const liveAfterPublish = source === "live" && !!data?.publishedAt;
  const payload = data?.payload && liveAfterPublish ? { ...data.payload, preview: false } : data?.payload ?? null;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-3xl p-0 overflow-y-auto" data-testid="gl-evidence-sheet">
        <SheetHeader className="px-4 pt-4 sm:px-6 text-left">
          <SheetTitle>Where each add-back is in the books</SheetTitle>
          <SheetDescription>
            {source === "preview" && data?.publishedAt
              ? `What due-diligence buyers see now (shown since ${shortDate(data.publishedAt)}).`
              : liveAfterPublish
                ? "With your latest changes — buyers see these after you click Update what buyers see."
                : "What due-diligence buyers will see, from the data as it stands now."}
          </SheetDescription>
        </SheetHeader>
        <div className="p-3 sm:p-6">
          {isLoading ? (
            <div className="flex items-center gap-2 py-10 justify-center text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
          ) : error ? (
            <p className="py-6 text-sm text-center">This couldn't load right now.</p>
          ) : !payload ? (
            <p className="py-6 text-sm text-center text-muted-foreground">Nothing to show yet — review the add-backs first.</p>
          ) : (
            <div className="cim-doc rounded-lg bg-[hsl(var(--cim-paper))] px-4 py-5 sm:px-8 sm:py-8 shadow-sm">
              <GlEvidenceBlock layoutData={payload} />
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
