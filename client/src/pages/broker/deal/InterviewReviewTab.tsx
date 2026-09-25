/**
 * InterviewReviewTab — Interview transcripts, coverage, and broker-private notes.
 */
import { useState } from "react";
import { useSearch } from "wouter";
import { useDeal } from "@/contexts/DealContext";
import { InterviewTranscriptPanel } from "@/components/deal/InterviewTranscriptPanel";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ShieldAlert, ChevronDown, ChevronUp } from "lucide-react";
import { groupSameNotes, isHousekeepingNote } from "@shared/private-notes";

interface PrivateNoteSource {
  reason?: string;
  turn?: number;
  documentId?: string;
  brokerOnly?: boolean;
  questionnaire?: boolean;
  /** This source's own words, when they differ from the note's. */
  wording?: string;
}

interface BrokerPrivateNote extends PrivateNoteSource {
  note: string;
  /** Other sources that state the same note. */
  alsoFrom?: PrivateNoteSource[];
}

function sourceLabel(s: PrivateNoteSource): string {
  const base = s.reason ? s.reason : s.questionnaire ? "From the intake questionnaire" : "Recorded during the interview";
  return typeof s.turn === "number" && !s.documentId ? `${base} · turn ${s.turn}` : base;
}

/** "in Pipedrive note — …" / "said in the interview (turn 4)". */
function alsoLabel(s: PrivateNoteSource): string {
  if (s.questionnaire) return "in the intake questionnaire";
  if (!s.documentId) return typeof s.turn === "number" ? `said in the interview (turn ${s.turn})` : "said in the interview";
  return s.reason ? s.reason.replace(/^From /, "in ") : "in another source";
}

/** Notes shown before "Show more" — the card sits above the transcripts. */
const VISIBLE_NOTES = 5;

/**
 * Sensitive facts the interview agent recorded for the broker only — a seller
 * said "don't put that in writing" about something the broker genuinely needs
 * (health-driven sale, litigation detail, a staff departure). These are stored
 * outside every CIM-feeding path and shown nowhere else in the product.
 */
function BrokerPrivateNotesPanel({ notes }: { notes: BrokerPrivateNote[] }) {
  const [expanded, setExpanded] = useState(false);
  if (notes.length === 0) return null;
  // Notes recorded before restatements were merged on write can say the same
  // thing in other words — shown once, with every source that said it.
  // Every source keeps its own words: a restatement in other words is shown
  // under the note, never dropped.
  const groups = groupSameNotes(notes.filter((n) => !isHousekeepingNote(n.note))).map(({ note, same }) => ({
    ...note,
    alsoFrom: [
      ...(note.alsoFrom ?? []),
      ...same.flatMap((s) => [
        { ...s, wording: s.wording ?? s.note },
        ...(s.alsoFrom ?? []).map((a) => ({ ...a, wording: a.wording ?? s.note })),
      ]),
    ].map((a) => (a.wording && a.wording.trim().toLowerCase() === note.note.trim().toLowerCase() ? { ...a, wording: undefined } : a)),
  }));
  if (groups.length === 0) return null;
  const shown = expanded ? groups : groups.slice(0, VISIBLE_NOTES);
  const hidden = groups.length - shown.length;
  return (
    <Card className="border-amber-600/30" data-testid="panel-broker-private-notes">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldAlert className="h-4 w-4 text-amber-500" />
          Broker-private notes
          <span className="text-xs font-normal text-muted-foreground tabular-nums">{groups.length}</span>
          <Badge variant="outline" className="ml-auto text-[10px] font-normal">
            Never appears in any CIM
          </Badge>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Sensitive context from the interview and your sources (CRM notes,
          emails, transcripts), kept out of documents. Visible only to you —
          excluded from CIM generation, financial analysis, and buyer-facing
          content.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {shown.map((n, i) => (
          <div
            key={i}
            className="rounded-md border border-border bg-muted/40 px-3 py-2.5"
            data-testid={`private-note-${i}`}
          >
            <p className="text-sm">{n.note}</p>
            <p className="text-[11px] text-muted-foreground mt-1">
              {sourceLabel(n)}
              {n.alsoFrom.some((a) => !a.wording) && ` · also ${n.alsoFrom.filter((a) => !a.wording).map(alsoLabel).join(", ")}`}
            </p>
            {n.alsoFrom.filter((a) => a.wording).map((a, j) => (
              <p key={j} className="mt-1.5 border-l-2 border-border pl-2 text-xs text-muted-foreground" data-testid={`private-note-${i}-wording-${j}`}>
                <span className="text-foreground/80">“{a.wording}”</span>
                <span className="text-[11px]"> · {alsoLabel(a)}</span>
              </p>
            ))}
          </div>
        ))}
        {groups.length > VISIBLE_NOTES && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="flex items-center gap-1 text-xs text-teal hover:underline"
            data-testid="button-toggle-private-notes"
          >
            {expanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
            {expanded ? "Show fewer" : `Show ${hidden} more`}
          </button>
        )}
      </CardContent>
    </Card>
  );
}

export function InterviewReviewTab() {
  const { dealId, deal } = useDeal();
  // ?session=<id>&turn=<n> — a fact's source link from the Information tab.
  const params = new URLSearchParams(useSearch());
  const focusSessionId = params.get("session");
  const turnParam = Number(params.get("turn"));
  const focusTurn = Number.isInteger(turnParam) && turnParam > 0 ? turnParam : null;
  const privateNotes: BrokerPrivateNote[] = Array.isArray(
    (deal.extractedInfo as Record<string, unknown> | null)?._brokerPrivateNotes,
  )
    ? ((deal.extractedInfo as Record<string, unknown>)
        ._brokerPrivateNotes as BrokerPrivateNote[])
    : [];

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
      <BrokerPrivateNotesPanel notes={privateNotes} />
      <InterviewTranscriptPanel dealId={dealId} focusSessionId={focusSessionId} focusTurn={focusTurn} />
    </div>
  );
}
