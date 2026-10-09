/**
 * InterviewTranscriptPanel — Shows all interview sessions for a deal
 * with full conversation transcripts the broker can read through, and the
 * sessions together (the coverage board), each with its whole conversation.
 */
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  MessageSquare,
  Clock,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  Pause,
  Radio,
  User,
  Bot,
  Loader2,
  FileText,
} from "lucide-react";

import { useSittings } from "@/components/together/LastSession";
import { sittingListText, type SittingListRow, type TogetherLineView, type TogetherSittingView } from "@shared/together";
import { lineRole, speakerDisplay } from "@shared/together-speakers";

// ── Types ─────────────────────────────────────────────────────────────────────

interface ConversationMessage {
  role: "ai" | "user";
  content: string;
  timestamp: string;
}

interface SessionSummary {
  id: string;
  status: string;
  startedAt: string;
  lastActivityAt: string;
  completedAt: string | null;
  questionsAsked: number;
  questionsAnswered: number;
  questionsSkipped: number;
  messages: ConversationMessage[];
  messageCount: number;
  durationMinutes: number;
  /** Who ran it: the seller alone, the broker with the seller, or the broker alone. */
  conductedBy?: "seller" | "broker_with_seller" | "broker";
}

/** Who the answers in a session came from. */
const ANSWER_LABEL: Record<NonNullable<SessionSummary["conductedBy"]>, string> = {
  seller: "Seller",
  broker_with_seller: "In the room",
  broker: "You",
};
const SESSION_KIND: Record<NonNullable<SessionSummary["conductedBy"]>, string | null> = {
  seller: null,
  broker_with_seller: "Interview together",
  broker: "Your session",
};

interface InterviewTranscriptPanelProps {
  dealId: string;
  /** Open this session and jump to one seller turn (links from the Information tab). */
  focusSessionId?: string | null;
  focusTurn?: number | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

function formatTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

function formatDuration(minutes: number): string {
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function statusIcon(status: string) {
  switch (status) {
    case "completed":
      return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />;
    case "paused":
      return <Pause className="h-3.5 w-3.5 text-amber-400" />;
    case "active":
      return <Radio className="h-3.5 w-3.5 text-teal" />;
    default:
      return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "paused":
      return "Paused";
    case "active":
      return "In Progress";
    default:
      return status;
  }
}

// ── Message Bubble ────────────────────────────────────────────────────────────

function MessageBubble({
  message,
  turn,
  anchorId,
  highlighted,
  answerLabel = "Seller",
}: {
  message: ConversationMessage;
  /** Seller turn number (1-based) — what fact sources cite as "turn N". */
  turn?: number;
  anchorId?: string;
  highlighted?: boolean;
  /** Who the answers came from ("You" in the broker's own session). */
  answerLabel?: string;
}) {
  const isAI = message.role === "ai";

  return (
    <div
      id={anchorId}
      className={`flex gap-3 scroll-mt-4 rounded-lg transition-colors ${isAI ? "" : "flex-row-reverse"} ${
        highlighted ? "ring-1 ring-teal/60 bg-teal/5 p-2 -m-2" : ""
      }`}
    >
      {/* Avatar */}
      <div
        className={`flex-shrink-0 w-7 h-7 rounded-full flex items-center justify-center ${
          isAI
            ? "bg-teal/15 text-teal"
            : "bg-muted text-muted-foreground"
        }`}
      >
        {isAI ? <Bot className="h-3.5 w-3.5" /> : <User className="h-3.5 w-3.5" />}
      </div>

      {/* Content */}
      <div
        className={`flex-1 max-w-[85%] ${isAI ? "" : "flex flex-col items-end"}`}
      >
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[11px] font-medium text-muted-foreground/70">
            {isAI ? "Interviewer" : answerLabel}
          </span>
          {typeof turn === "number" && (
            <span className="text-[10px] text-muted-foreground/50">Turn {turn}</span>
          )}
          <span className="text-[10px] text-muted-foreground/40">
            {formatTime(message.timestamp)}
          </span>
        </div>
        <div
          className={`rounded-lg px-3.5 py-2.5 text-sm leading-relaxed ${
            isAI
              ? "bg-card border border-border/50 text-foreground/90"
              : "bg-teal/10 border border-teal/20 text-foreground/90"
          }`}
        >
          {message.content.split("\n").map((line, i) => (
            <p key={i} className={i > 0 ? "mt-2" : ""}>
              {line}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Session Card ──────────────────────────────────────────────────────────────

function SessionCard({
  session,
  index,
  focusTurn,
  focused,
}: {
  session: SessionSummary;
  index: number;
  focusTurn?: number | null;
  focused?: boolean;
}) {
  const [expanded, setExpanded] = useState(!!focused);
  const cardRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focused) return;
    setExpanded(true);
    // Wait for the transcript to render, then bring the cited turn into view.
    const t = window.setTimeout(() => {
      const target = focusTurn ? document.getElementById(`turn-${session.id}-${focusTurn}`) : null;
      (target ?? cardRef.current)?.scrollIntoView({ behavior: "smooth", block: target ? "center" : "start" });
    }, 150);
    return () => window.clearTimeout(t);
  }, [focused, focusTurn, session.id]);

  // Seller turn number for each message; the AI question right before a
  // highlighted turn is highlighted with it.
  let userTurn = 0;
  const turns = session.messages.map((m) => (m.role === "user" ? ++userTurn : undefined));

  return (
    <div ref={cardRef} className={`border rounded-lg overflow-hidden scroll-mt-4 ${focused ? "border-teal/40" : "border-border/50"}`}>
      {/* Header (clickable) */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left"
      >
        <div className="flex items-center gap-3">
          {statusIcon(session.status)}
          <div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">
                Session {index + 1}
              </span>
              {session.conductedBy && SESSION_KIND[session.conductedBy] && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-teal/10 text-teal border-0" data-testid="badge-session-kind">
                  {SESSION_KIND[session.conductedBy]}
                </Badge>
              )}
              <Badge
                variant="secondary"
                className="text-[10px] px-1.5 py-0 h-4 bg-muted/60 border-0"
              >
                {statusLabel(session.status)}
              </Badge>
            </div>
            <div className="flex items-center gap-3 mt-0.5 text-[11px] text-muted-foreground/60">
              <span>{formatDate(session.startedAt)}</span>
              <span>{session.messageCount} messages</span>
              <span>{formatDuration(session.durationMinutes)}</span>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-4">
          {/* Metrics */}
          <div className="hidden sm:flex items-center gap-3 text-[11px] text-muted-foreground/60">
            <span>{session.questionsAsked} asked</span>
            <span>{session.questionsAnswered} answered</span>
            {session.questionsSkipped > 0 && (
              <span className="text-amber-400/70">
                {session.questionsSkipped} skipped
              </span>
            )}
          </div>

          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground/50" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground/50" />
          )}
        </div>
      </button>

      {/* Expanded transcript */}
      {expanded && (
        <div className="border-t border-border/30 bg-background/50">
          <div className="px-4 py-4 space-y-4 max-h-[600px] overflow-y-auto">
            {session.messages.length === 0 ? (
              <p className="text-sm text-muted-foreground/50 text-center py-8">
                No messages in this session.
              </p>
            ) : (
              session.messages.map((msg, i) => {
                const turn = turns[i];
                const isFocus =
                  !!focused && !!focusTurn &&
                  (turn === focusTurn || (msg.role === "ai" && turns[i + 1] === focusTurn));
                return (
                  <MessageBubble
                    key={i}
                    message={msg}
                    turn={turn}
                    anchorId={turn ? `turn-${session.id}-${turn}` : undefined}
                    highlighted={isFocus}
                    answerLabel={ANSWER_LABEL[session.conductedBy ?? "seller"]}
                  />
                );
              })
            )}
          </div>

          {/* Session footer */}
          <div className="px-4 py-2.5 border-t border-border/20 bg-muted/20 flex items-center justify-between text-[10px] text-muted-foreground/40">
            <span>
              Started {formatDate(session.startedAt)} at{" "}
              {formatTime(session.startedAt)}
            </span>
            {session.completedAt && (
              <span>
                Completed {formatDate(session.completedAt)} at{" "}
                {formatTime(session.completedAt)}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Sessions together (the coverage board) ───────────────────────────────────

/**
 * A session together: "Interview together — 9 Oct · 24 min · in person · 9
 * filed"; it opens to the whole two-sided conversation (broker only — the
 * seller's own transcript document holds only their words).
 */
function SittingCard({ dealId, row }: { dealId: string; row: SittingListRow }) {
  const [expanded, setExpanded] = useState(false);
  const { data, isLoading, error } = useQuery<{ sitting: TogetherSittingView; lines: TogetherLineView[] }>({
    queryKey: ["/api/deals", dealId, "together-sittings", row.id],
    enabled: expanded,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/together/sittings/${row.id}`, { credentials: "include" });
      if (!r.ok) throw new Error("Couldn't load the conversation");
      return r.json();
    },
  });
  const present = data ? Array.from(new Set(data.lines.map((l) => l.speaker))) : [];
  return (
    <div className="border border-border/50 rounded-lg overflow-hidden" data-testid={`sitting-card-${row.id}`}>
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors text-left">
        <div className="flex items-center gap-3 min-w-0">
          {row.status === "ended" ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" /> : <Radio className="h-3.5 w-3.5 text-teal shrink-0" />}
          <span className="text-sm truncate">{sittingListText(row)}</span>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground/50 shrink-0" /> : <ChevronDown className="h-4 w-4 text-muted-foreground/50 shrink-0" />}
      </button>
      {expanded && (
        <div className="border-t border-border/30 bg-background/50 px-4 py-4 max-h-[600px] overflow-y-auto space-y-1.5">
          {isLoading && <p className="text-xs text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="h-3 w-3 animate-spin" /> Loading the conversation…</p>}
          {error && <p className="text-xs text-muted-foreground">Couldn't load the conversation.</p>}
          {data && data.lines.length === 0 && <p className="text-sm text-muted-foreground/60 text-center py-6">Nothing was said in this session.</p>}
          {data?.lines.map((l) => {
            const role = lineRole(data.sitting.speakers, { speaker: l.speaker, attested: l.attested });
            const who = l.source === "typed" ? "You (typed)" : role === "seller" ? data.sitting.speakers[l.speaker]?.name || "Seller" : role === "broker" ? "You" : speakerDisplay(l.speaker, data.sitting.speakers[l.speaker], present);
            return (
              <p key={l.seq} className="text-sm leading-relaxed">
                <span className="text-[10px] text-muted-foreground/50 tabular-nums mr-2">{formatTime(l.at)}</span>
                <span className={`font-medium ${role === "seller" ? "text-teal" : "text-muted-foreground"}`}>{who}:</span> {l.text}
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function InterviewTranscriptPanel({
  dealId,
  focusSessionId,
  focusTurn,
}: InterviewTranscriptPanelProps) {
  const {
    data: sessions,
    isLoading,
    error,
  } = useQuery<SessionSummary[]>({
    queryKey: ["/api/deals", dealId, "sessions"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/sessions`, {
        credentials: "include",
      });
      if (!r.ok) throw new Error("Failed to load interview sessions");
      return r.json();
    },
  });

  const { data: sittingRows } = useSittings(dealId);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <span className="ml-2 text-sm text-muted-foreground">
            Loading interview history...
          </span>
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <span className="text-sm text-muted-foreground">
            Failed to load interview history.
          </span>
        </CardContent>
      </Card>
    );
  }

  const sittings = sittingRows ?? [];
  if ((!sessions || sessions.length === 0) && sittings.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-4 w-4 text-teal" />
            Interview Transcripts
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center text-center py-6 gap-3">
            <div className="rounded-full bg-muted p-3">
              <FileText className="h-6 w-6 text-muted-foreground" />
            </div>
            <div>
              <p className="text-sm text-muted-foreground">
                No interviews conducted yet.
              </p>
              <p className="text-xs text-muted-foreground/60 mt-1">
                Once the seller completes an interview session, the full
                transcript will appear here.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    );
  }

  // Summary stats
  const sessionList = sessions ?? [];
  const totalMessages = sessionList.reduce((s, sess) => s + sess.messageCount, 0);
  const completedCount = sessionList.filter((s) => s.status === "completed").length;
  const totalDuration = sessionList.reduce((s, sess) => s + sess.durationMinutes, 0) + sittings.reduce((n, r) => n + r.durationMin, 0);

  return (
    <Card>
      <CardHeader className="pb-4">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <MessageSquare className="h-4 w-4 text-teal" />
            Interview Transcripts
          </CardTitle>
          <div className="flex items-center gap-3 text-xs text-muted-foreground/60">
            <span>
              {sessionList.length + sittings.length} session{sessionList.length + sittings.length === 1 ? "" : "s"}
            </span>
            <span>{totalMessages} messages</span>
            <span>{formatDuration(totalDuration)} total</span>
            {completedCount > 0 && (
              <Badge
                variant="secondary"
                className="text-[10px] bg-emerald-500/10 text-emerald-400 border-0"
              >
                {completedCount} completed
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {sittings.length > 0 && (
          <div className="space-y-2" data-testid="sittings-list">
            {sittings.map((row) => <SittingCard key={row.id} dealId={dealId} row={row} />)}
          </div>
        )}
        {/* Newest first; numbered in the order they happened (Session 1 = first). */}
        {sessionList.map((session, i) => (
          <SessionCard
            key={session.id}
            session={session}
            index={sessionList.length - 1 - i}
            focused={focusSessionId === session.id}
            focusTurn={focusSessionId === session.id ? focusTurn : null}
          />
        ))}
      </CardContent>
    </Card>
  );
}
