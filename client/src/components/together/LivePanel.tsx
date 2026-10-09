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
import { Loader2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { LiveListening } from "@/hooks/useLiveListening";
import { InPersonCard, CimpleCallCard, NotetakerCard } from "./ModeCards";
import { SpeakerChips } from "./SpeakerChips";
import { SuggestNext } from "./SuggestNext";
import { StatusIcon } from "@/components/coverage/StatusIcon";
import { listenCopy, isNotetakerVia, type SpeakerMap, type SpeakerRole, type TogetherLineView, type TogetherSittingView } from "@shared/together";
import { lineRole, speakerDisplay, speakerKind } from "@shared/together-speakers";
import type { CoverageBoard, CoverageItem } from "@shared/coverage-board";
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
}) {
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
  const lastFiled = filed[0];
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
        {heading("Live transcript")}
        <TranscriptView lines={lines} speakers={sitting.speakers} interim={listening.interim} emptyText={listenCopy("idle")} />
        <p className="mt-2 text-[11px] text-muted-foreground flex items-center gap-1.5" data-testid="filing-status">
          {sitting.waiting > 0 ? (
            <><Loader2 className="h-3 w-3 animate-spin" /> {sitting.waiting} {sitting.waiting === 1 ? "part" : "parts"} of the conversation waiting to be filed</>
          ) : lastFiled ? (
            <>Filed {lastFiled.label.toLowerCase()} · {ago(lastFiled.filedAt, now)}</>
          ) : (
            <>Cimple files the seller's answers here as they talk.</>
          )}
        </p>
      </section>

      <SuggestNext board={board} onShow={onShowItem} />

      <section>
        {heading("Filed this session", <span className="text-xs tabular-nums text-muted-foreground">{filed.length}</span>)}
        {filed.length === 0 ? (
          <p className="text-xs text-muted-foreground">Nothing filed yet.</p>
        ) : (
          <ul className="space-y-1.5" data-testid="filed-feed">
            {filed.slice(0, 12).map((i) => (
              <li key={i.id} className="flex items-start gap-2 text-xs">
                <StatusIcon status={i.status} size={13} className="mt-px" />
                <button type="button" className="min-w-0 text-left hover:underline underline-offset-2" onClick={() => onShowItem(i.id, i.sectionKey)}>
                  <span className="font-medium">{i.label}</span>
                  <span className="text-muted-foreground"> · {i.sectionTitle} · {ago(i.filedAt, now)}</span>
                  {i.yourNote && <span className="text-muted-foreground"> · your note</span>}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AddWhatTheySaid onAdd={onTyped} disabled={ended} />
    </div>
  );
}
