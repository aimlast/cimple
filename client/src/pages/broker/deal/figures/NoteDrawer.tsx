/**
 * NoteDrawer — one figure's note, for the broker (spec §5.2 "Note drawer"):
 * the numbers, what buyers read, the Blind CIM wording, what it rests on
 * (with the quotes), Cimple's newer wording, the history, and the actions.
 * Saving runs the server's guards: a staff name, a kept-out party or a blind
 * leak comes back as a plain message under the field; a note changed by
 * someone else meanwhile asks for a reload (409).
 *
 * Self-contained (dealId + what to open), so the CIM builder's preview opens
 * the same drawer as the Numbers & sources workspace. Right side, 480 px;
 * full screen on a phone.
 */
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ExternalLink, History, Loader2, Quote } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import type { FiguresWorkspace, WorkspaceAnswer, WorkspaceNote } from "@shared/figure-workspace";
import { FiguresError, figuresErrorText, figuresKey, figuresRequest, money, shortDate, signedMoney, useFigureActions } from "./useFigures";

/** What to open: a note by id, or a new note on a figure (from a hint, a seller's answer or blank). */
export type NoteDrawerTarget =
  | { noteId: string }
  | { figureKey: string; kind: "movement" | "difference" | "context"; compareKey?: string; prefill?: string; fromHint?: boolean; fromQuestionId?: string };

const MAX = 320;

interface Resolved {
  title: string;
  numbers: string[];
  note: WorkspaceNote | null;
  hint: string | null;
  answer: WorkspaceAnswer | null;
  figureKey: string;
  kind: "movement" | "difference" | "context";
  compareKey?: string;
}

/** Find the note / the figure in the workspace payload. */
function resolve(ws: FiguresWorkspace | undefined, target: NoteDrawerTarget | null): Resolved | null {
  if (!ws || !target) return null;
  if ("noteId" in target) {
    for (const m of ws.moves) if (m.note?.id === target.noteId) {
      return { title: `${m.label} · FY${m.year}`, numbers: moveNumbers(m), note: m.note, hint: m.hint, answer: m.answer, figureKey: m.figureKey, kind: m.note.kind, compareKey: m.note.compareKey };
    }
    for (const c of ws.checks) if (c.note?.id === target.noteId) {
      return { title: `${c.label} · FY${c.year}`, numbers: [`This CIM ${money(c.thisCim)}`, `${c.otherLabel} ${money(c.other)}`, `Differs by ${signedMoney(c.difference)}${c.pct ? ` (${c.pct})` : ""}`], note: c.note, hint: null, answer: null, figureKey: c.figureKey, kind: "difference", compareKey: c.note.compareKey };
    }
    for (const o of ws.otherNotes) if (o.note.id === target.noteId) {
      return { title: `${o.label} · FY${o.year}`, numbers: [], note: o.note, hint: null, answer: null, figureKey: o.figureKey, kind: o.note.kind, compareKey: o.note.compareKey };
    }
    return null;
  }
  const move = ws.moves.find((m) => m.figureKey === target.figureKey);
  const check = target.kind === "difference" ? ws.checks.find((c) => c.figureKey === target.figureKey && c.checkKey.endsWith(`~${target.compareKey ?? ""}`)) : undefined;
  const label = move?.label ?? check?.label ?? target.figureKey.split("|")[0];
  const year = move?.year ?? check?.year ?? target.figureKey.split("|")[1] ?? "";
  const existing = target.kind === "difference" ? check?.note ?? null : move?.note ?? null;
  return {
    title: `${label} · FY${year}`,
    numbers: check ? [`This CIM ${money(check.thisCim)}`, `${check.otherLabel} ${money(check.other)}`, `Differs by ${signedMoney(check.difference)}${check.pct ? ` (${check.pct})` : ""}`] : move ? moveNumbers(move) : [],
    note: existing && existing.status !== "hidden" ? existing : null,
    hint: move?.hint ?? null,
    answer: move?.answer ?? null,
    figureKey: target.figureKey,
    // A figure with no earlier year to compare with gets a plain note on the figure (a "context" note).
    kind: target.kind === "movement" && !move?.fromYear ? "context" : target.kind,
    compareKey: target.compareKey ?? (target.kind === "movement" ? move?.fromYear ?? undefined : undefined),
  };
}

function moveNumbers(m: FiguresWorkspace["moves"][number]): string[] {
  if (m.from === null || m.fromYear === null) return [`FY${m.year}: ${money(m.to)}`];
  return [`FY${m.fromYear} ${money(m.from)} → FY${m.year} ${money(m.to)}`, `${signedMoney(m.delta)}${m.pct ? ` (${m.pct})` : ""}`];
}

const HISTORY_WORDS: Record<string, string> = {
  written: "Written", edited: "Edited", approved: "Shown to buyers", hidden: "Hidden", restored: "Restored", flagged: "The owner asked for a change", proposal_used: "Cimple's newer wording used",
};
const WHO: Record<string, string> = { cimple: "by Cimple", broker: "by you", owner: "by the owner" };

export function NoteDrawer({ dealId, target, onClose }: { dealId: string; target: NoteDrawerTarget | null; onClose: () => void }) {
  const { toast } = useToast();
  const actions = useFigureActions(dealId);
  const ws = useQuery<FiguresWorkspace>({ queryKey: figuresKey(dealId), queryFn: () => figuresRequest("GET", `/api/deals/${dealId}/figures`), enabled: !!target });
  const r = useMemo(() => resolve(ws.data, target), [ws.data, target]);
  const note = r?.note ?? null;

  const [text, setText] = useState("");
  const [blindOn, setBlindOn] = useState(false);
  const [blindText, setBlindText] = useState("");
  const [error, setError] = useState<{ field: string; message: string } | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [comparing, setComparing] = useState(false);
  const key = target ? JSON.stringify(target) : "";
  useEffect(() => {
    if (!r) return;
    const prefill = target && !("noteId" in target) ? target.prefill : undefined;
    setText(note?.text ?? prefill ?? "");
    setBlindOn(!!note?.blindText);
    setBlindText(note?.blindText ?? "");
    setError(null);
    setWarnings([]);
    setComparing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, note?.id, note?.version]);

  const busy = actions.patchNote.isPending || actions.writeNote.isPending;
  const failed = (e: unknown) => {
    if (e instanceof FiguresError && e.status === 422 && e.body?.message) setError({ field: e.body.field ?? "text", message: e.body.message });
    else if (e instanceof FiguresError && e.status === 409) setError({ field: "text", message: "This note changed while you were editing. Reload to see the latest." });
    else toast({ title: "Couldn't save the note", description: figuresErrorText(e), variant: "destructive" });
  };

  const save = async (approve: boolean) => {
    if (!r) return;
    setError(null);
    const blind = blindOn ? blindText.trim() || null : null;
    try {
      if (note) {
        const changed = text.trim() !== note.text || blind !== (note.blindText ?? null);
        const res = await actions.patchNote.mutateAsync({
          id: note.id, version: note.version, ...(approve ? { action: "approve" as const } : {}),
          ...(changed ? { text: text.trim(), blindText: blind } : {}),
        });
        setWarnings(res.warnings.map((w) => w.message));
        toast({ title: approve ? "Shown to buyers" : "Saved", description: approve ? "Buyers see this note in every version it's written for." : undefined });
      } else {
        const t = target && !("noteId" in target) ? target : null;
        const res = await actions.writeNote.mutateAsync({
          figureKey: r.figureKey, kind: r.kind, ...(r.compareKey ? { compareKey: r.compareKey } : {}), text: text.trim(), blindText: blind,
          ...(t?.fromHint ? { fromHint: true } : {}), ...(t?.fromQuestionId ? { fromQuestionId: t.fromQuestionId } : {}),
        });
        setWarnings(res.warnings.map((w) => w.message));
        toast({ title: "Note saved and shown to buyers", description: "Your own notes are shown as soon as you save them." });
      }
      if (!approve && note) return;
      onClose();
    } catch (e) {
      failed(e);
    }
  };

  const act = async (action: "hide" | "restore" | "use_proposal") => {
    if (!note) return;
    try {
      await actions.patchNote.mutateAsync({ id: note.id, version: note.version, action });
      toast({ title: action === "hide" ? "Hidden from buyers" : action === "restore" ? "Restored as a suggestion" : "Cimple's newer wording is in the note" });
      if (action === "hide") onClose();
    } catch (e) {
      failed(e);
    }
  };

  const internalOnly = !!note?.internalOnly;
  const len = text.trim().length;
  return (
    <Sheet open={!!target} onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 overflow-y-auto p-0 sm:w-[480px] sm:max-w-[480px]" data-testid="figure-note-drawer">
        <SheetHeader className="space-y-1 border-b border-border px-5 py-4 text-left">
          <SheetTitle className="text-base">{r?.title ?? "Note"}</SheetTitle>
          <SheetDescription className="text-xs">What buyers read about this figure, and what it rests on.</SheetDescription>
        </SheetHeader>

        {!r ? (
          <div className="flex items-center gap-2 px-5 py-6 text-sm text-muted-foreground">
            {ws.isLoading ? <><Loader2 className="h-4 w-4 animate-spin" /> Loading…</> : "This figure isn't in the CIM's numbers any more."}
          </div>
        ) : (
          <div className="flex-1 space-y-5 px-5 py-4">
            {r.numbers.length > 0 && (
              <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm tabular-nums">
                {r.numbers.map((n, i) => <p key={i} className={i === 0 ? "text-foreground" : "text-muted-foreground"}>{n}</p>)}
              </div>
            )}

            {note?.staleReason === "seller_flagged" && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs" role="status">
                <p className="font-medium text-foreground">The owner asked for a change. Buyers don't see this note until you save it again.</p>
                {note.sellerComment && <p className="mt-1 text-muted-foreground">“{note.sellerComment}”</p>}
              </div>
            )}
            {note?.staleReason === "figures_changed" && (
              <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-foreground" role="status">The figures changed since this note was written. Buyers don't see it until you check it.</p>
            )}

            {note?.proposal && (
              <div className="space-y-2 rounded-md border border-teal/40 px-3 py-2 text-xs">
                <p className="text-foreground">Cimple has newer wording for this{note.staleReason === "figures_changed" ? " (the figures changed)" : ""}.</p>
                {comparing && (
                  <div className="space-y-1 text-muted-foreground">
                    <p><span className="font-medium text-foreground">Yours:</span> {note.text}</p>
                    <p><span className="font-medium text-foreground">Cimple's:</span> {note.proposal.text}</p>
                  </div>
                )}
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setComparing((c) => !c)}>{comparing ? "Hide comparison" : "Compare"}</Button>
                  <Button size="sm" className="h-7 text-xs" onClick={() => act("use_proposal")} disabled={busy}>Use it</Button>
                </div>
              </div>
            )}

            {!note && r.hint && target && !("noteId" in target) && target.fromHint && (
              <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
                From Cimple's analysis (not checked). Edit it until it is right — buyers read your words.
              </p>
            )}
            {!note && r.answer && (
              <div className="rounded-md border border-border px-3 py-2 text-xs">
                <p className="text-muted-foreground">{r.answer.from}:</p>
                <p className="mt-0.5 text-foreground">“{r.answer.text}”</p>
                {text.trim() !== r.answer.text && (
                  <button type="button" className="mt-1 text-teal hover:underline" onClick={() => setText(r.answer!.text.slice(0, MAX))}>Use the seller's answer</button>
                )}
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="figure-note-text" className="text-xs font-semibold">What buyers read</Label>
              <Textarea
                id="figure-note-text"
                value={text}
                onChange={(e) => { setText(e.target.value.slice(0, MAX)); if (error?.field === "text") setError(null); }}
                rows={4}
                aria-invalid={error?.field === "text"}
                placeholder="Why the figure is what it is, in one or two plain sentences."
                data-testid="input-figure-note"
              />
              <div className="flex items-start justify-between gap-3 text-[11px]">
                {error?.field === "text" ? <p className="text-red-400" role="alert">{error.message}</p> : <span className="text-muted-foreground">Shown in the Full and due-diligence CIMs.</span>}
                <span className={cn("shrink-0 tabular-nums", len > 300 ? "text-amber-500" : "text-muted-foreground")}>{len}/{MAX}</span>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor="figure-note-blind-switch" className="text-xs font-semibold">In the Blind CIM</Label>
                <Switch id="figure-note-blind-switch" checked={blindOn} onCheckedChange={setBlindOn} />
              </div>
              {blindOn ? (
                <>
                  <Textarea
                    value={blindText}
                    onChange={(e) => { setBlindText(e.target.value.slice(0, MAX)); if (error?.field === "blindText") setError(null); }}
                    rows={3}
                    aria-invalid={error?.field === "blindText"}
                    placeholder="The same note without names: the business, people, customers, suppliers, places."
                    aria-label="Blind CIM wording"
                  />
                  {error?.field === "blindText" && <p className="text-[11px] text-red-400" role="alert">{error.message}</p>}
                </>
              ) : (
                <p className="text-[11px] text-muted-foreground">Not shown in the Blind CIM. Turn it on to write wording with no names.</p>
              )}
            </div>

            {note && note.sources.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-semibold">Based on</p>
                {internalOnly && (
                  <p className="flex items-start gap-1.5 text-[11px] text-amber-500"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" /> Based only on your internal note. Check the wording before buyers see it.</p>
                )}
                <ul className="space-y-2">
                  {note.sources.map((s, i) => (
                    <li key={i} className="rounded-md border border-border px-3 py-2 text-xs">
                      {s.quote && <p className="flex gap-1.5 text-foreground"><Quote className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />“{s.quote}”</p>}
                      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-muted-foreground">
                        — {s.internal ? "From your resolution note (internal)" : s.label}{s.page ? `, p. ${s.page}` : ""}
                        {s.href && (
                          <a className="inline-flex items-center gap-0.5 text-teal hover:underline" href={s.href} target="_blank" rel="noreferrer">
                            Open <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {warnings.length > 0 && (
              <div className="space-y-1">
                {warnings.map((w, i) => <p key={i} className="flex items-start gap-1.5 text-[11px] text-amber-500"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />{w}</p>)}
              </div>
            )}

            {note && note.history.length > 0 && (
              <div className="space-y-1">
                <p className="flex items-center gap-1 text-xs font-semibold"><History className="h-3.5 w-3.5" /> History</p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {note.history.slice(-6).map((h) => `${HISTORY_WORDS[h.what] ?? h.what} ${WHO[h.by] ?? ""} on ${shortDate(h.at)}${h.comment && h.by === "owner" ? `: “${h.comment}”` : ""}`).join(" · ")}
                </p>
              </div>
            )}
          </div>
        )}

        {r && (
          <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t border-border bg-background px-5 py-3">
            {note && note.status !== "hidden" && (
              <Button variant="ghost" size="sm" className="mr-auto text-xs text-muted-foreground" onClick={() => act("hide")} disabled={busy}>Hide from buyers</Button>
            )}
            {note && note.status === "hidden" && (
              <Button variant="ghost" size="sm" className="mr-auto text-xs" onClick={() => act("restore")} disabled={busy}>Restore</Button>
            )}
            <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
            {note && note.status !== "hidden" && (
              <Button variant="outline" size="sm" onClick={() => save(false)} disabled={busy || len === 0}>Save</Button>
            )}
            {(!note || note.status !== "approved" || note.staleReason || text.trim() !== note.text) && note?.status !== "hidden" && (
              <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => save(true)} disabled={busy || len === 0} data-testid="button-show-note">
                {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {note ? "Save and show to buyers" : "Save and show to buyers"}
              </Button>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
