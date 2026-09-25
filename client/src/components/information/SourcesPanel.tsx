/**
 * Sources panel — every source the deal's information came from (documents,
 * emails, calls, video calls, CRM notes, the website, interview sessions,
 * the questionnaire, the broker's own edits), how many facts each gave, and
 * a viewer that opens one (its text, what it said overall, the original file).
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { AlertCircle, ExternalLink, Loader2, Lock, Plus, Trash2 } from "lucide-react";
import type { InformationSource } from "@shared/information";
import { sourceContributionText, sourceCountText } from "@shared/information";
import type { DocumentSourceMeta, SourceKind } from "@shared/schema";
import { KIND_META, formatShortDate } from "./source-kinds";
import { informationKey, requestJson, useInformationAction } from "./useInformation";

const PLATFORM: Record<string, string> = { zoom: "Zoom", meet: "Google Meet", teams: "Teams", cimple: "Cimple call", person: "In person", other: "Other" };

export function metaLine(kind: SourceKind, meta: DocumentSourceMeta | null | undefined, date: string | null): string {
  const parts: string[] = [];
  if (meta?.from || meta?.to) parts.push([meta.from, meta.to].filter(Boolean).join(" → "));
  if (meta?.participants) parts.push(meta.participants);
  if (meta?.platform) parts.push(PLATFORM[meta.platform] ?? meta.platform);
  if (meta?.provider) parts.push(meta.provider.charAt(0).toUpperCase() + meta.provider.slice(1));
  if (meta?.durationMin) parts.push(`${meta.durationMin} min`);
  const when = formatShortDate(date);
  if (when) parts.push(when);
  if (kind === "website" && meta?.url) parts.push(meta.url.replace(/^https?:\/\//, ""));
  return parts.join(" · ");
}

function StatusBit({ status }: { status?: string }) {
  if (status === "pending" || status === "parsing")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-amber-500">
        <Loader2 className="h-2.5 w-2.5 animate-spin" /> Reading…
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 text-[10px] text-red-400">
        <AlertCircle className="h-2.5 w-2.5" /> Couldn't read
      </span>
    );
  return null;
}

export function SourcesPanel({
  sources,
  activeSourceId,
  onFilterSource,
  onOpen,
  onAdd,
  untrackedFacts = 0,
}: {
  sources: InformationSource[];
  activeSourceId: string | null;
  onFilterSource: (id: string | null) => void;
  onOpen: (src: InformationSource) => void;
  onAdd: () => void;
  /** Facts collected before source tracking that match no source. */
  untrackedFacts?: number;
}) {
  const sorted = [...sources].sort((a, b) => {
    const ad = a.date ? +new Date(a.date) : 0;
    const bd = b.date ? +new Date(b.date) : 0;
    return bd - ad;
  });
  return (
    <section className="rounded-lg border border-border bg-card" data-testid="sources-panel">
      <header className="flex items-center justify-between gap-2 px-4 py-3 border-b border-border/60">
        <div>
          <h3 className="text-sm font-semibold">Sources</h3>
          <p className="text-[11px] text-muted-foreground" data-testid="sources-count">{sourceCountText(sources)}</p>
          {untrackedFacts > 0 && (
            <p className="text-[11px] text-muted-foreground/80 mt-0.5 max-w-[15rem] leading-snug" data-testid="sources-untracked-note">
              {untrackedFacts} earlier fact{untrackedFacts === 1 ? "" : "s"} can't be traced to one of these.
            </p>
          )}
        </div>
        <Button size="sm" className="h-7 text-xs gap-1 bg-teal text-teal-foreground hover:bg-teal/90" onClick={onAdd} data-testid="button-open-add-source">
          <Plus className="h-3 w-3" /> Add source
        </Button>
      </header>
      {sorted.length === 0 ? (
        <p className="px-4 py-6 text-xs text-muted-foreground text-center">
          No sources yet. Add documents, emails, call transcripts or your CRM notes.
        </p>
      ) : (
        <ul className="divide-y divide-border/40">
          {sorted.map((s) => {
            const Icon = KIND_META[s.kind]?.icon ?? KIND_META.unknown.icon;
            const active = activeSourceId === s.id;
            const line = metaLine(s.kind, s.meta, s.date);
            const openable = !!s.documentId || !!s.sessionId || s.kind === "website";
            return (
              <li key={s.id} className={`px-4 py-2.5 ${active ? "bg-teal/5" : ""}`}>
                <div className="flex items-start gap-2.5">
                  <Icon className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <button
                      type="button"
                      disabled={!openable}
                      onClick={() => onOpen(s)}
                      className={`block w-full text-left text-[13px] leading-snug truncate ${openable ? "hover:text-teal" : "cursor-default"}`}
                      title={s.title}
                    >
                      {s.title}
                    </button>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] text-muted-foreground">
                      <span>{KIND_META[s.kind]?.label ?? s.kind}</span>
                      {line && <span className="truncate max-w-full">{line}</span>}
                      {s.visibility === "broker_only" && (
                        <span className="inline-flex items-center gap-0.5 text-teal"><Lock className="h-2.5 w-2.5" /> Broker only</span>
                      )}
                      <StatusBit status={s.status} />
                    </div>
                    {/* What it gave beyond the facts recorded from it — a source that only confirmed others isn't "0 facts". */}
                    {((s.corroboratedCount ?? 0) > 0 || (s.alternateCount ?? 0) > 0) && (
                      <p className="mt-0.5 text-[10px] text-muted-foreground/80" data-testid={`source-contribution-${s.id}`}>
                        {sourceContributionText(s)}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onFilterSource(active ? null : s.id)}
                    disabled={s.factCount === 0}
                    aria-label={s.factCount === 0 ? "No facts traced to this source" : `${s.factCount} facts: show only these`}
                    className={`shrink-0 text-[11px] tabular-nums rounded-full px-2 py-0.5 border transition-colors ${
                      active
                        ? "border-teal/50 bg-teal/10 text-teal"
                        : s.factCount === 0
                          ? "border-transparent text-muted-foreground/50"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-teal/40"
                    }`}
                    title={
                      s.factCount
                        ? `Show only the facts from this source${s.inferredFactCount ? ` (${s.inferredFactCount === s.factCount ? "all" : s.inferredFactCount} traced by matching values, from before source tracking)` : ""}`
                        : untrackedFacts > 0
                          ? "No fact on file traces back to this source (some earlier facts can't be traced to any source)"
                          : "No facts on file from this source"
                    }
                    data-testid={`source-facts-${s.id}`}
                  >
                    {/* A bare "0 facts" reads as broken when earlier facts can't be traced, so show a dash then. */}
                    {s.factCount === 0 && ((s.corroboratedCount ?? 0) > 0 || (s.alternateCount ?? 0) > 0)
                      ? "0 recorded"
                      : s.factCount === 0 && untrackedFacts > 0 ? "—" : `${s.factCount} fact${s.factCount === 1 ? "" : "s"}`}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

interface SourceText {
  id: string;
  title: string;
  kind: SourceKind;
  meta: DocumentSourceMeta | null;
  visibility: "shared" | "broker_only";
  text: string;
  fileUrl: string;
  mimeType: string | null;
  status: string;
}

/** Opens one documents-backed source: what it is, what it said, the text, the original. */
export function SourceViewer({
  dealId,
  source,
  onClose,
  onShowFacts,
}: {
  dealId: string;
  source: InformationSource | null;
  onClose: () => void;
  onShowFacts: (id: string) => void;
}) {
  const { toast } = useToast();
  const action = useInformationAction(dealId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const docId = source?.documentId ?? null;
  const { data, isLoading, error } = useQuery<SourceText>({
    queryKey: ["/api/deals", dealId, "information", "source-text", docId],
    enabled: !!docId,
    queryFn: () => requestJson<SourceText>("GET", `/api/deals/${dealId}/information/sources/${docId}/text`),
  });
  const del = useMutation({
    mutationFn: () => requestJson<{ removedFields?: string[] }>("DELETE", `/api/documents/${docId}`),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: informationKey(dealId) });
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId], exact: true });
      // Say what the server actually did: a source whose facts were only matched
      // by inference (or that gave none) removes nothing.
      const removed = new Set((res?.removedFields ?? []).map((k) => k.split(":")[0])).size;
      toast({
        title: "Source deleted",
        description: removed > 0
          ? `What it contributed to ${removed} fact${removed === 1 ? "" : "s"} was removed too.`
          : "No facts on file were removed.",
      });
      setConfirmDelete(false);
      onClose();
    },
    onError: (e: Error) => toast({ title: "Couldn't delete", description: e.message, variant: "destructive" }),
  });

  if (!source) return null;
  const Icon = KIND_META[source.kind]?.icon ?? KIND_META.unknown.icon;
  const line = metaLine(source.kind, source.meta, source.date);
  const h = source.highlights;
  const isPdf = (data?.mimeType ?? "").includes("pdf") || /\.pdf$/i.test(source.fileUrl ?? "");
  // Deleting a document removes the facts RECORDED from it; facts only traced
  // to it (collected before source tracking) stay.
  const inferredFacts = source.inferredFactCount ?? 0;
  const recordedFacts = Math.max(0, source.factCount - inferredFacts);

  return (
    <>
      <Dialog open={!!source} onOpenChange={(o) => !o && onClose()}>
        <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-3 focus:outline-none" onOpenAutoFocus={(e) => e.preventDefault()}>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 pr-6">
              <Icon className="h-4 w-4 text-teal shrink-0" />
              <span className="truncate">{source.title}</span>
            </DialogTitle>
            <DialogDescription className="text-xs">
              {KIND_META[source.kind]?.label}
              {line ? ` · ${line}` : ""}
              {source.visibility === "broker_only" ? " · Broker only" : ""}
            </DialogDescription>
          </DialogHeader>

          {h && (h.summary || h.keyFacts || h.redFlags || h.actionItems || h.sellerConcerns || h.followUpNeeded) && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-3 space-y-1.5 text-xs">
              {h.summary && <p><span className="text-muted-foreground">Summary: </span>{h.summary}</p>}
              {h.keyFacts && <p><span className="text-muted-foreground">Key facts: </span>{h.keyFacts}</p>}
              {h.sellerConcerns && <p><span className="text-muted-foreground">Seller's concerns: </span>{h.sellerConcerns}</p>}
              {h.actionItems && <p><span className="text-muted-foreground">Action items: </span>{h.actionItems}</p>}
              {h.followUpNeeded && <p><span className="text-muted-foreground">Follow up: </span>{h.followUpNeeded}</p>}
              {h.redFlags && <p className="text-amber-500/90"><span className="text-muted-foreground">Watch out: </span>{h.redFlags}</p>}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border/60 bg-background/60 p-3">
            {isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Opening…</div>
            ) : error ? (
              <p className="text-xs text-red-400">Couldn't open this source.</p>
            ) : data?.text ? (
              <pre className="whitespace-pre-wrap break-words font-sans text-[13px] leading-relaxed text-foreground/90">{data.text}</pre>
            ) : (
              <p className="text-xs text-muted-foreground">
                {source.status === "pending" || source.status === "parsing" ? "Cimple is still reading this source." : "No readable text — open the original file."}
              </p>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 justify-between">
            <label className="flex items-center gap-2 text-xs cursor-pointer">
              <Switch
                checked={source.visibility === "broker_only"}
                disabled={action.isPending}
                onCheckedChange={(v) =>
                  action.mutate(
                    { method: "PATCH", path: `/sources/${source.documentId}`, body: { visibility: v ? "broker_only" : "shared" } },
                    {
                      onSuccess: () => toast({ title: v ? "Now broker only" : "Now shared", description: v ? "The seller can't see or open it, and the interview won't use its facts." : "The seller can see it in their documents, and the interview can confirm its facts with them." }),
                      onError: (e) => toast({ title: "Couldn't change it", description: (e as Error).message, variant: "destructive" }),
                    },
                  )
                }
              />
              <span className="flex items-center gap-1"><Lock className="h-3 w-3" /> Broker only</span>
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {source.factCount > 0 && (
                <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => { onShowFacts(source.id); onClose(); }}>
                  Show its {source.factCount} fact{source.factCount === 1 ? "" : "s"}
                </Button>
              )}
              {source.fileUrl && (
                <Button asChild size="sm" variant="outline" className="h-8 text-xs gap-1">
                  <a href={source.fileUrl} target="_blank" rel="noreferrer">
                    <ExternalLink className="h-3 w-3" /> {isPdf ? "Open PDF" : "Open original"}
                  </a>
                </Button>
              )}
              <Button size="sm" variant="ghost" className="h-8 text-xs gap-1 text-muted-foreground hover:text-red-400" onClick={() => setConfirmDelete(true)}>
                <Trash2 className="h-3 w-3" /> Delete
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this source?</AlertDialogTitle>
            <AlertDialogDescription>
              {recordedFacts > 0
                ? <>"{source.title}" and the {recordedFacts} fact{recordedFacts === 1 ? "" : "s"} it contributed will be removed.
                  Where another source gave a value for the same fact, that value takes its place.</>
                : <>"{source.title}" will be removed. No fact on file was recorded from it, so none are removed.</>}
              {inferredFacts > 0 && (
                <> {inferredFacts} earlier fact{inferredFacts === 1 ? "" : "s"} that match{inferredFacts === 1 ? "es" : ""} it stay{inferredFacts === 1 ? "s" : ""} on file.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction onClick={() => del.mutate()} className="bg-red-600 hover:bg-red-600/90">
              {del.isPending ? "Deleting…" : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
