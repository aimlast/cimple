/**
 * InterviewTranscriptPanel — Shows all interview sessions for a deal
 * with full conversation transcripts the broker can read through.
 */
import { useState } from "react";
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
}

interface InterviewTranscriptPanelProps {
  dealId: string;
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

function MessageBubble({ message }: { message: ConversationMessage }) {
  const isAI = message.role === "ai";

  return (
    <div className={`flex gap-3 ${isAI ? "" : "flex-row-reverse"}`}>
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
            {isAI ? "Interviewer" : "Seller"}
          </span>
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

function SessionCard({ session, index }: { session: SessionSummary; index: number }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
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
              session.messages.map((msg, i) => (
                <MessageBubble key={i} message={msg} />
              ))
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

// ── Main Component ────────────────────────────────────────────────────────────

export function InterviewTranscriptPanel({
  dealId,
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

  if (!sessions || sessions.length === 0) {
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
  const totalMessages = sessions.reduce((s, sess) => s + sess.messageCount, 0);
  const completedCount = sessions.filter((s) => s.status === "completed").length;
  const totalDuration = sessions.reduce((s, sess) => s + sess.durationMinutes, 0);

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
              {sessions.length} session{sessions.length === 1 ? "" : "s"}
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
        {sessions.map((session, i) => (
          <SessionCard key={session.id} session={session} index={i} />
        ))}
      </CardContent>
    </Card>
  );
}
