/**
 * The board's live column (specs/together.md §4.1 "Live panel"):
 *   1. the listening card for this way of running it, with who's who;
 *   2. the live transcript (the last 8 lines; the words being heard now in
 *      italics; it follows along unless the broker scrolls up);
 *   3. the filing line;
 *   4. ✦ Suggest what to ask next;
 *   5. what Cimple filed this session (newest first);
 *   6. "Add what they said…" — a typed line, filed as the broker's own
 *      note, never as the seller's words.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Loader2, MoreHorizontal, Send } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { boardRequest, invalidateCoverage } from "@/hooks/useCoverageBoard";
import type { FilingState } from "@/hooks/useTogetherSitting";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LiveListening } from "@/hooks/useLiveListening";
import { InPersonCard, CimpleCallCard, NotetakerCard } from "./ModeCards";
import { SpeakerChips } from "./SpeakerChips";
import { SuggestNext } from "./SuggestNext";
import { StatusIcon } from "@/components/coverage/StatusIcon";
import { listenCopy, isNotetakerVia, type BrokerUnconfirmedView, type CaptureHints, type SpeakerMap, type SpeakerRole, type TogetherLineView, type TogetherSittingView } from "@shared/together";
import { lineRole, speakerDisplay, speakerKind } from "@shared/together-speakers";
import type { CoverageBoard, CoverageItem, NextToAskContext } from "@shared/coverage-board";
import { presentSpeakers } from "./SpeakerChips";

function ago(iso: string | undefined, now: number): string {
  if (!iso) return "";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 45) return "now";
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.round(m / 60)} h`;
}

export function filedThisSession(board: CoverageBoard | undefined, sittingId: string | undefined): Array<CoverageItem & { sectionTitle: string }> {
  if (!board || !sittingId) return [];
  const out: Array<CoverageItem & { sectionTitle: string }> = [];
  for (const s of board.sections) for (const i of s.items) if (i.filedInSittingId === sittingId) out.push({ ...i, sectionTitle: s.title });
  return out.sort((a, b) => new Date(b.filedAt ?? 0).getTime() - new Date(a.filedAt ?? 0).getTime());
}

export function TranscriptView({ lines, speakers, interim, maxLines = 8, emptyText }: { lines: TogetherLineView[]; speakers: SpeakerMap; interim?: string; maxLines?: number; emptyText: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const shown = lines.slice(-maxLines);
  const present = useMemo(() => presentSpeakers(lines), [lines]);
  useEffect(() => {
    const el = ref.current;
    if (el && follow) el.scrollTop = el.scrollHeight;
  }, [shown.length, interim, follow]);
  if (shown.length === 0 && !interim) return <p className="text-xs text-muted-foreground" data-testid="transcript-empty">{emptyText}</p>;
  return (
    <div
      ref={ref}
      onScroll={(e) => {
        const el = e.currentTarget;
        setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
      }}
      className="max-h-56 overflow-y-auto space-y-1.5 pr-1"
      data-testid="live-transcript"
      aria-live="polite"
    >
      {shown.map((l) => {
        const role: SpeakerRole = lineRole(speakers, { speaker: l.speaker, attested: l.attested });
        const who = speakerKind(l.speaker) === "typed" ? "You (typed)" : role === "seller" ? speakers[l.speaker]?.name || "Seller" : role === "broker" ? "You" : speakerDisplay(l.speaker, speakers[l.speaker], present);
        return (
          <p key={l.seq} className="text-xs leading-snug" data-testid={`line-${l.seq}`}>
            <span className={`font-medium ${role === "seller" ? "text-teal" : role === "unknown" ? "tg-warn-text" : "text-muted-foreground"}`}>{who}:</span>{" "}
            <span className="text-foreground/90">{l.text}</span>
          </p>
        );
      })}
      {interim && <p className="text-xs italic text-muted-foreground">{interim}</p>}
    </div>
  );
}

function AddWhatTheySaid({ onAdd, disabled }: { onAdd: (text: string) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onAdd(t);
    setText("");
  };
  return (
    <div className="space-y-1">
      <div className="flex gap-1.5">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 2000))}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
          placeholder="Add what they said…"
          className="h-8 text-sm"
          disabled={disabled}
          aria-label="Add what the seller said"
          data-testid="input-add-what-they-said"
        />
        <Button size="icon" variant="outline" className="h-8 w-8 shrink-0" onClick={submit} disabled={disabled || !text.trim()} aria-label="Add it" data-testid="button-add-what-they-said">
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
      <p className="text-[10.5px] text-muted-foreground">Typed lines are filed as your note, never as the seller's words.</p>
    </div>
  );
}

export function LivePanel({
  dealId,
  sitting,
  board,
  lines,
  listening,
  meetingLink,
  onSetSpeaker,
  onTyped,
  onShowItem,
  ended,
  hideSuggest,
  filing,
  brokerUnconfirmed = [],
  hints,
  onFileNow,
  onUndo,
  onRefile,
  onDismissUnconfirmed,
}: {
  dealId: string;
  sitting: TogetherSittingView;
  board: CoverageBoard;
  lines: TogetherLineView[];
  listening: LiveListening;
  meetingLink?: string;
  onSetSpeaker: (speaker: string, role: Exclude<SpeakerRole, "unknown">) => Promise<void>;
  onTyped: (text: string) => void;
  onShowItem: (itemId: string, sectionKey?: string) => void;
  ended?: boolean;
  /** On a phone, Suggest next lives in the bottom bar. */
  hideSuggest?: boolean;
  filing?: FilingState;
  brokerUnconfirmed?: BrokerUnconfirmedView[];
  hints?: CaptureHints;
  onFileNow?: () => Promise<void>;
  onUndo?: (chunkId: string, key: string) => Promise<void>;
  onRefile?: (minutes?: number) => Promise<void>;
  onDismissUnconfirmed?: (chunkId: string, key: string) => void;
}) {
  const { toast } = useToast();
  const [refileOpen, setRefileOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(id);
  }, []);
  const filed = filedThisSession(board, sitting.id);
  const heading = (t: string, extra?: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-2 mb-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{t}</p>
      {extra}
    </div>
  );
  const notetaker = isNotetakerVia(sitting.via);
  const suggestCtx = useMemo(() => suggestContext(board, hints, now), [board, hints, now]);
  const act = async (fn: () => Promise<unknown>, fail: string, done?: string) => {
    try {
      await fn();
      if (done) toast({ title: done });
    } catch (e) {
      toast({ title: fail, description: (e as Error).message, variant: "destructive" });
    }
  };
  return (
    <div className="space-y-5" data-testid="live-panel">
      <section>
        {heading(sitting.via === "cimple" ? "Cimple call" : notetaker ? "Notetaker" : "Listening")}
        {sitting.via === "cimple" ? (
          <CimpleCallCard dealId={dealId} listening={listening} ended={ended} />
        ) : notetaker ? (
          <NotetakerCard via={sitting.via} listening={listening} initialLink={meetingLink} ended={ended} />
        ) : (
          <InPersonCard listening={listening} ended={ended} />
        )}
        <div className="mt-2.5"><SpeakerChips speakers={sitting.speakers} lines={lines} onSet={onSetSpeaker} /></div>
      </section>

      <section>
        {heading(
          "Live transcript",
          !ended && onRefile && sitting.filingOn && lines.length > 0 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button type="button" className="h-5 w-5 inline-flex items-center justify-center rounded text-muted-foreground hover:text-foreground" aria-label="Transcript options" data-testid="button-transcript-menu">
                  <MoreHorizontal className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-64">
                <DropdownMenuItem onSelect={() => setRefileOpen(true)}>Re-file the last 10 minutes…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : undefined,
        )}
        <TranscriptView
          lines={lines}
          speakers={sitting.speakers}
          interim={listening.interim}
          emptyText={
            sitting.via === "cimple"
              ? "Nothing heard yet. Start the call, or type what the seller says below."
              : notetaker
                ? "Nothing heard yet. Send the notetaker, or type what the seller says below."
                : listenCopy("idle")
          }
        />
        <FilingLine sitting={sitting} filing={filing} filed={filed} now={now} ended={ended} onFileNow={onFileNow ? () => act(onFileNow, "Couldn't file that now") : undefined} />
      </section>

      {brokerUnconfirmed.length > 0 && !sitting.sellerSeesScreen && (
        <section data-testid="broker-unconfirmed">
          {heading("You said — not confirmed")}
          <ul className="space-y-2">
            {brokerUnconfirmed.slice(-4).reverse().map((b) => (
              <UnconfirmedRow key={`${b.chunkId}:${b.key}`} dealId={dealId} board={board} b={b} onShowItem={onShowItem} onDismiss={() => onDismissUnconfirmed?.(b.chunkId, b.key)} />
            ))}
          </ul>
        </section>
      )}

      {!hideSuggest && <SuggestNext board={board} ctx={suggestCtx} onShow={onShowItem} />}

      <section>
        {heading("Filed this session", <span className="text-xs tabular-nums text-muted-foreground">{filed.length}</span>)}
        {filed.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing filed yet.</p>
        ) : (
          <ul className="space-y-1.5" data-testid="filed-feed">
            {filed.slice(0, 12).map((i) => (
              <li key={i.id} className="flex items-start gap-2 text-xs group">
                <StatusIcon status={i.status} size={13} className="mt-px" />
                <button type="button" className="min-w-0 flex-1 text-left hover:underline underline-offset-2" onClick={() => onShowItem(i.id, i.sectionKey)}>
                  <span className="font-medium">{i.label}</span>
                  <span className="text-muted-foreground"> · {i.sectionTitle} · {ago(i.filedAt, now)}</span>
                  {i.yourNote && <span className="text-muted-foreground"> · your note</span>}
                </button>
                {!ended && onUndo && i.filedByChunkId && i.valueKey && (
                  <button
                    type="button"
                    className="shrink-0 text-[11px] text-muted-foreground hover:text-foreground underline underline-offset-2"
                    onClick={() => void act(() => onUndo(i.filedByChunkId!, i.valueKey!), "Couldn't undo that", `Undone — ${i.label}`)}
                    data-testid={`feed-undo-${i.id}`}
                  >
                    Undo
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <AddWhatTheySaid onAdd={onTyped} disabled={ended} />

      <AlertDialog open={refileOpen} onOpenChange={setRefileOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-file the last 10 minutes?</AlertDialogTitle>
            <AlertDialogDescription>
              Cimple will read the last 10 minutes again with the corrected speakers. What it filed from them (and you haven't changed since) is taken back first.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void act(() => onRefile!(10), "Couldn't read that part again", "Reading the last 10 minutes again")}>Re-file</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** Suggest next's context: the conversation's topic, the follow-up idea, what was asked recently. */
export function suggestContext(board: CoverageBoard, hints: CaptureHints | undefined, now: number): NextToAskContext {
  const askedAt: Record<string, number> = {};
  for (const s of board.sections) for (const i of s.items) {
    const m = i.marks.find((x) => x.kind === "asked");
    if (m) askedAt[i.id] = new Date(m.at).getTime();
  }
  return { topicSections: hints?.topicSections ?? [], followUp: hints?.followUp ?? null, askedAt, now };
}

/**
 * The filing line (§4.1): "Filing what the seller said about Seasonality…"
 * → "Filed 2 answers · 4 s ago" / "Nothing to file from that part", and a
 * quiet "Save this answer now" that files the open part at once.
 */
function FilingLine({ sitting, filing, filed, now, ended, onFileNow }: { sitting: TogetherSittingView; filing?: FilingState; filed: Array<CoverageItem & { sectionTitle: string }>; now: number; ended?: boolean; onFileNow?: () => void }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 2_000);
    return () => clearInterval(id);
  }, []);
  const t = Date.now();
  const ago2 = (at: number) => {
    const s = Math.max(0, Math.round((t - at) / 1000));
    return s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  };
  let body: JSX.Element;
  if (!sitting.filingOn) {
    body = <>Live filing isn't running here — tick ✓ Answered and type what the seller said.</>;
  } else if (sitting.waiting > 0) {
    body = <><Loader2 className="h-3 w-3 animate-spin" /> {sitting.waiting} {sitting.waiting === 1 ? "part" : "parts"} of the conversation waiting to be filed — nothing is lost.</>;
  } else if (filing?.active && t - filing.active.at < 30_000) {
    body = <><Loader2 className="h-3 w-3 animate-spin text-teal" /> Filing what the seller said{filing.active.sectionTitle ? ` about ${filing.active.sectionTitle}` : ""}…</>;
  } else if (filing?.last && t - filing.last.at < 5 * 60_000) {
    body = filing.last.filed > 0 ? <>Filed {filing.last.filed} {filing.last.filed === 1 ? "answer" : "answers"} · {ago2(filing.last.at)}</> : <>Nothing to file from that part · {ago2(filing.last.at)}</>;
  } else if (filed[0]) {
    body = <>Filed {filed[0].label.toLowerCase()} · {ago(filed[0].filedAt, now)}</>;
  } else {
    body = <>Cimple files the seller's answers here as they talk.</>;
  }
  return (
    <div className="mt-2 flex items-center justify-between gap-2" data-testid="filing-status">
      <p className="text-[11px] text-muted-foreground flex items-center gap-1.5 min-w-0">{body}</p>
      {!ended && sitting.filingOn && onFileNow && (
        <button type="button" onClick={onFileNow} className="shrink-0 text-[11px] text-teal hover:underline underline-offset-2" data-testid="button-save-answer-now">
          Save this answer now
        </button>
      )}
    </div>
  );
}

/** "You said August 2028 — the seller didn't confirm." with ✓ Confirmed (or the editor, in the broker's own words). */
function UnconfirmedRow({ dealId, board, b, onShowItem, onDismiss }: { dealId: string; board: CoverageBoard; b: BrokerUnconfirmedView; onShowItem: (itemId: string, sectionKey?: string) => void; onDismiss: () => void }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(b.value);
  const [busy, setBusy] = useState(false);
  const item = board.sections.flatMap((s) => s.items).find((i) => i.id === b.itemId);
  const label = b.label || item?.label || b.key;
  const holds = !!item?.value && item.value.replace(/\s+/g, " ").toLowerCase().includes(b.value.replace(/\s+/g, " ").toLowerCase());
  const confirm = async () => {
    // The item already holds what the broker said: "confirmed by you". Otherwise the broker's own edit.
    if (holds && item && item.status !== "on_file") {
      setBusy(true);
      try {
        await boardRequest("POST", `/api/deals/${dealId}/coverage-board/items/${encodeURIComponent(item.id)}/confirm`, { mode: "mark" }, "Couldn't confirm it");
        invalidateCoverage(dealId);
        onDismiss();
      } catch (e) {
        toast({ title: "Couldn't confirm it", description: (e as Error).message, variant: "destructive" });
      } finally {
        setBusy(false);
      }
      return;
    }
    if (holds) { onDismiss(); return; }
    setEditing(true);
  };
  const save = async () => {
    const key = item?.members.find((m) => m.writable)?.key ?? b.key;
    setBusy(true);
    try {
      await boardRequest("PUT", `/api/deals/${dealId}/information/facts/${encodeURIComponent(key)}`, { value: value.trim() }, "Couldn't save it");
      invalidateCoverage(dealId);
      toast({ title: "Saved as your edit", description: label });
      onDismiss();
    } catch (e) {
      toast({ title: "Couldn't save it", description: (e as Error).message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-md border border-border p-2.5 text-xs space-y-1.5" data-testid={`unconfirmed-${b.key}`}>
      <p className="flex items-start gap-1.5">
        <AlertTriangle className="h-3.5 w-3.5 mt-px shrink-0 cov-text-verify" />
        <span>
          You said <span className="font-medium">{b.value}</span> — the seller didn't confirm.{" "}
          <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => onShowItem(b.itemId, b.itemId.split(":")[0])}>{label}</button>
        </span>
      </p>
      {editing ? (
        <div className="space-y-1.5">
          <input value={value} onChange={(e) => setValue(e.target.value.slice(0, 400))} className="w-full h-7 rounded-md border border-border bg-background px-2 text-xs" aria-label={`${label} — your edit`} />
          <div className="flex gap-1.5">
            <Button size="sm" className="h-6 text-[11px] bg-teal text-teal-foreground hover:bg-teal/90" disabled={busy || !value.trim()} onClick={() => void save()}>Save as your edit</Button>
            <Button size="sm" variant="ghost" className="h-6 text-[11px]" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" className="h-6 text-[11px] border-teal/40 text-teal hover:bg-teal/10 hover:text-teal" disabled={busy} onClick={() => void confirm()}>✓ Confirmed</Button>
          <Button size="sm" variant="ghost" className="h-6 text-[11px] text-muted-foreground" onClick={onDismiss}>Dismiss</Button>
        </div>
      )}
    </li>
  );
}
