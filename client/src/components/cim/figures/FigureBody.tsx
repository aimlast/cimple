/**
 * FigureBody — what a figure's popover / sheet says (spec §4.3), on the
 * theme-locked paper. Buyers: the comparison (DD), the change and its reason,
 * what's in a total (DD), the documents, and "Ask about this figure". The
 * broker's preview adds the marks buyers never see ("Not shown to buyers
 * yet", "No reason on file", Cimple's analysis hint) and the actions.
 *
 * Buyers never read "no reason on file": an unexplained DD difference says
 * "Ask the broker about this difference".
 */
import { useState } from "react";
import { X } from "lucide-react";
import type { FigureCheckView, FigureLayer, FigureNoteView, FigureView } from "@shared/figure-layer";
import {
  ASK_ABOUT_FIGURE, ASK_BROKER_DIFFERENCE, BROKER_ASK_SELLER, BROKER_CIM_MISMATCH, BROKER_HINT_PREFIX, BROKER_HINT_SUFFIX,
  BROKER_NO_REASON, BROKER_NOT_LOCATED, BROKER_NOT_SHOWN, BROKER_USE_HINT, BROKER_WRITE_NOTE, BROKER_WRITE_REASON,
  COL_THIS_CIM, SEND_TO_BROKER, SENT_TO_BROKER,
} from "@shared/figure-copy";
import { STATE_PAINT, STATE_WORDS } from "@shared/figure-states";
import { FigureCitation, FigureCitations } from "./FigureCitation";
import { StateIcon } from "./figurePaint";
import type { FigureBrokerHooks, FigureBuyerHooks } from "./FigureLayerContext";

const INK = "#201D18";
const SOFT = "#46423B";
const MUTED = "#6B665C";
const LINE = "#E3DED0";

function Basis({ note }: { note: FigureNoteView }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1 text-[11px]" style={{ color: MUTED }}>
      <span>{note.basisLabel}</span>
      <FigureCitations refs={note.citations} max={3} />
    </div>
  );
}

function NoteBlock({ note, broker, onApprove, onEdit }: { note: FigureNoteView; broker: boolean; onApprove?: () => void; onEdit?: () => void }) {
  const notShown = broker && (note.suggested || note.stale);
  return (
    <div className={notShown ? "rounded-md border border-dashed px-2 py-1.5" : undefined} style={notShown ? { borderColor: "#8A8170" } : undefined}>
      <p className="text-[13px] leading-snug" style={{ color: INK }}>{note.text}</p>
      <Basis note={note} />
      {notShown && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[11px]">
          <span style={{ color: MUTED }}>
            {note.stale === "seller_flagged" ? "Needs a look: the owner asked for a change" : note.stale ? "Needs a look: the figures changed" : BROKER_NOT_SHOWN}
          </span>
          {onApprove && note.suggested && !note.stale && (
            <button type="button" className="rounded border px-1.5 py-0.5 font-medium hover:bg-[#F2EEE3]" style={{ borderColor: LINE, color: INK }} onClick={onApprove}>Approve</button>
          )}
          {onEdit && <button type="button" className="underline underline-offset-2" style={{ color: SOFT }} onClick={onEdit}>Edit</button>}
        </div>
      )}
    </div>
  );
}

function CheckBlock({ fig, check, broker }: { fig: FigureView; check: FigureCheckView; broker: boolean }) {
  const paint = STATE_PAINT[check.state];
  const isAsIssued = check.kindLabel === "Financial statements as issued";
  const ownCitation = check.baseCitation ?? fig.citations?.[0] ?? null;
  return (
    <div className="space-y-1">
      {!isAsIssued && (
        <div className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-[12px]">
          <span style={{ color: SOFT }}>{COL_THIS_CIM}</span>
          <span className="text-right tabular-nums font-medium" style={{ color: INK }}>{fig.display}</span>
          {ownCitation && <span className="col-span-2"><FigureCitation docRef={ownCitation} /></span>}
          <span style={{ color: SOFT }}>{check.kindLabel}</span>
          <span className="text-right tabular-nums font-medium" style={{ color: INK }}>{check.value}</span>
          {check.citation && <span className="col-span-2"><FigureCitation docRef={check.citation} /></span>}
          {check.sourceLabel && (
            <span className="col-span-2 text-[11px]" style={{ color: MUTED }}>
              {/tax|form/i.test(check.kindLabel) ? "Tax-return line" : "Line"}: “{check.sourceLabel}”
            </span>
          )}
        </div>
      )}
      <div className="flex items-start gap-1.5 rounded-md px-1.5 py-1" style={paint.tint ? { backgroundColor: paint.tint, boxShadow: `inset ${paint.ruleWidth}px 0 0 ${paint.rule}` } : undefined}>
        <StateIcon state={check.state} className="mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] font-medium" style={{ color: INK }}>
            {check.state === "ask" ? ASK_BROKER_DIFFERENCE : isAsIssued ? STATE_WORDS.regrouped : STATE_WORDS[check.state]}
          </p>
          {isAsIssued && check.asIssued && <p className="mt-0.5 text-[12px] leading-snug" style={{ color: SOFT }}>{check.asIssued}</p>}
          {!isAsIssued && check.note && <NoteBlock note={check.note} broker={broker} />}
        </div>
      </div>
      {check.difference && !isAsIssued && (
        <p className="text-[11px] tabular-nums" style={{ color: MUTED }}>
          Differs by {check.difference}{check.differencePct ? ` (${check.differencePct})` : ""}
        </p>
      )}
      {broker && check.preview && (
        <p className="rounded border border-dashed px-1.5 py-1 text-[11px]" style={{ borderColor: check.preview === "needs_checking" ? "#9B4A3A" : check.preview === "cim_mismatch" ? "#B7791F" : "#8A8170", color: SOFT }}>
          {check.preview === "needs_checking" ? BROKER_NOT_LOCATED : check.preview === "cim_mismatch" ? BROKER_CIM_MISMATCH : BROKER_NOT_SHOWN}
        </p>
      )}
    </div>
  );
}

function AskForm({ fig, mode, onAsk }: { fig: FigureView; mode: FigureLayer["mode"]; onAsk: (text: string) => Promise<void> }) {
  const prefix = mode === "blind" || !fig.label ? "About a figure on this page: " : `About ${fig.label}, FY${fig.year}: `;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(prefix);
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  if (state === "sent") return <p className="text-[12px]" style={{ color: "#2F6B4F" }} role="status">{SENT_TO_BROKER}</p>;
  if (!open) {
    return (
      <button type="button" className="rounded-md border px-2 py-1 text-[12px] font-medium hover:bg-[#F2EEE3]" style={{ borderColor: LINE, color: INK }} onClick={() => setOpen(true)}>
        {ASK_ABOUT_FIGURE}
      </button>
    );
  }
  const body = text.trim();
  const valid = body.length > prefix.trim().length && body.length <= 1000;
  return (
    <form
      className="space-y-1.5"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        setState("sending");
        try {
          await onAsk(body);
          setState("sent");
        } catch {
          setState("error");
        }
      }}
    >
      <label className="sr-only" htmlFor={`ask-${fig.id}`}>Your question</label>
      <textarea
        id={`ask-${fig.id}`}
        className="w-full resize-y rounded-md border bg-white px-2 py-1.5 text-[12px] outline-none focus:ring-1"
        style={{ borderColor: LINE, color: INK }}
        rows={3}
        maxLength={1000}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
      />
      {state === "error" && <p className="text-[11px]" style={{ color: "#9B4A3A" }}>That didn't send. Check your connection and try again.</p>}
      <div className="flex items-center justify-end gap-2">
        <button type="button" className="text-[12px] underline underline-offset-2" style={{ color: SOFT }} onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" disabled={!valid || state === "sending"} className="rounded-md px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50" style={{ backgroundColor: INK }}>
          {state === "sending" ? "Sending…" : SEND_TO_BROKER}
        </button>
      </div>
    </form>
  );
}

export interface FigureBodyProps {
  fig: FigureView;
  mode: FigureLayer["mode"];
  audience: FigureLayer["audience"];
  broker?: FigureBrokerHooks | null;
  buyer?: FigureBuyerHooks | null;
  onClose?: () => void;
}

export function FigureBody({ fig, mode, audience, broker, buyer, onClose }: FigureBodyProps) {
  const isBroker = audience === "broker";
  const checks = mode === "dd" ? fig.checks ?? [] : [];
  const title = mode === "blind" || !fig.label ? `FY${fig.year}` : `${fig.label} · FY${fig.year}`;
  const key = fig.figureKey ?? "";
  return (
    <div className="space-y-2.5 text-left" style={{ color: INK }}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[13px] font-semibold leading-tight">
          {title}
          {mode !== "dd" && <span className="ml-1 font-normal tabular-nums" style={{ color: SOFT }}>· {fig.display}</span>}
        </p>
        {onClose && (
          <button type="button" aria-label="Close" onClick={onClose} className="-m-1 rounded p-1 hover:bg-[#F2EEE3]" style={{ color: MUTED }}>
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {checks.map((c) => <CheckBlock key={c.id} fig={fig} check={c} broker={isBroker} />)}
      {mode === "dd" && fig.otherBlank && checks.every((c) => c.kindLabel.startsWith("Financial statements")) && (
        <p className="text-[11px]" style={{ color: MUTED }}>{fig.otherBlank}.</p>
      )}

      {fig.change && (
        <p className="text-[12px] tabular-nums" style={{ color: SOFT }}>{fig.change.line}</p>
      )}
      {fig.why && (
        <div>
          {checks.length > 0 && <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>Why</p>}
          <NoteBlock
            note={fig.why}
            broker={isBroker}
            onApprove={broker?.onApprove ? () => broker.onApprove!(fig.why!.id) : undefined}
            onEdit={broker?.onOpenNote ? () => broker.onOpenNote!(key, { noteId: fig.why!.id }) : undefined}
          />
        </div>
      )}

      {mode === "dd" && (fig.parts?.length ?? 0) > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide" style={{ color: MUTED }}>What's in it</p>
          <ul className="space-y-0.5 text-[12px]">
            {fig.parts!.map((p, i) => (
              <li key={i} className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate" style={{ color: SOFT }} title={p.label}>{p.label}</span>
                <span className="shrink-0 tabular-nums" style={{ color: INK }}>{p.display}</span>
              </li>
            ))}
            {fig.partsMore && <li className="text-[11px]" style={{ color: MUTED }}>{fig.partsMore}</li>}
          </ul>
        </div>
      )}

      {isBroker && fig.noReason && !fig.why && (
        <div className="space-y-1.5 rounded-md border border-dashed px-2 py-1.5" style={{ borderColor: "#8A8170" }}>
          <p className="text-[12px] font-medium" style={{ color: SOFT }}>{BROKER_NO_REASON}</p>
          {fig.hint && (
            <p className="text-[12px] leading-snug" style={{ color: SOFT }}>
              {BROKER_HINT_PREFIX} “{fig.hint}” <span style={{ color: MUTED }}>{BROKER_HINT_SUFFIX}</span>
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-[12px]">
            {fig.hint && broker?.onOpenNote && (
              <button type="button" className="rounded border px-1.5 py-0.5 font-medium hover:bg-[#F2EEE3]" style={{ borderColor: LINE }} onClick={() => broker.onOpenNote!(key, { hint: fig.hint })}>{BROKER_USE_HINT}</button>
            )}
            {broker?.onAskSeller && <button type="button" className="underline underline-offset-2" onClick={() => broker.onAskSeller!(key)}>{BROKER_ASK_SELLER}</button>}
            {broker?.onOpenNote && <button type="button" className="underline underline-offset-2" onClick={() => broker.onOpenNote!(key)}>{BROKER_WRITE_REASON}</button>}
          </div>
        </div>
      )}
      {isBroker && fig.why && broker?.onOpenNote && (
        <button type="button" className="text-[12px] underline underline-offset-2" style={{ color: SOFT }} onClick={() => broker.onOpenNote!(key, { noteId: fig.why!.id })}>{BROKER_WRITE_NOTE}</button>
      )}

      {!isBroker && buyer?.onAsk && (
        <div className="border-t pt-2" style={{ borderColor: LINE }}>
          <AskForm fig={fig} mode={mode} onAsk={(text) => buyer.onAsk!(fig.id, text)} />
        </div>
      )}
    </div>
  );
}
