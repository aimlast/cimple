import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { Send, StopCircle, CheckCircle, LogOut, Mic, MicOff, AlertCircle, RefreshCw, Pencil, X, PictureInPicture2, SkipForward, HelpCircle } from "lucide-react";
import { usePictureInPicture } from "@/lib/pip";
import { startLiveTranscription, NotConfiguredError, type LiveTranscriptionHandle, type LiveSegment } from "@/lib/live-transcription";
import { createDailyCall, joinDailyCall, type CallHandle } from "@/lib/daily-call";
import DailyIframe, { type DailyCall } from "@daily-co/daily-js";
import { CallStage } from "@/components/call/CallStage";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
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
import { ChatMessage } from "./ChatMessage";
import { useToast } from "@/hooks/use-toast";
import type { ConversationMessage } from "@shared/schema";

interface TurnResult {
  message: string;
  whyItMatters?: string;
  importance?: "critical" | "important" | "helpful";
  targetSection?: string;
  suggestedAnswers: string[];
  /** The messages exactly as the server persisted them this turn — adopted
   *  so the live view (timestamps, rationale, chips) matches a reload. */
  turnMessages?: { user?: ConversationMessage; ai: ConversationMessage };
  sessionId: string;
  captured: {
    total: number;
    newFields: string[];
    updatedFields: string[];
  };
  sectionCoverage: Array<{
    key: string;
    title: string;
    status: "well_covered" | "partial" | "missing";
  }>;
  industryContext: {
    identified: boolean;
    industry: string;
    activeTopics: string[];
    coveredTopics: string[];
  };
  deferredTopics: string[];
  shouldEnd: boolean;
  endReason?: string;
}

interface AIConversationInterfaceProps {
  dealId: string;
  businessName?: string;
  /** Seller invite token — sent as X-Seller-Token to authenticate seller-mode calls */
  sellerToken?: string;
  onTurnResult?: (result: TurnResult) => void;
  onComplete?: () => void | Promise<void>;
  /** "together": broker-led — the broker reads the question aloud, the
   *  seller answers by voice (mic) or the broker types; a floating window can
   *  carry the question over an external call. */
  variant?: "chat" | "together";
  via?: string;
  meetingLink?: string;
}

const IMPORTANCE_TEXT = { critical: "Critical for buyers", important: "Important", helpful: "Helpful" } as const;

const STOPWORDS = new Set(["the","a","an","and","or","of","to","in","on","for","with","is","are","do","does","did","you","your","it","that","this","what","how","any","have","has","be","at","as","by","we","i","so","if","about","from","there","their","they","them","can","would","could","which","who","when"]);
function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOPWORDS.has(w));
}
/**
 * Hands-free mode hears the broker reading the question aloud as well as the
 * seller's answer. A transcript segment whose content words mostly appear in
 * the current question is the question being read, not an answer — drop it.
 */
export function looksLikeQuestionEcho(segment: string, question: string | undefined): boolean {
  if (!question) return false;
  const seg = tokens(segment);
  if (seg.length < 3) return false;
  const q = new Set(tokens(question));
  const hits = seg.filter((w) => q.has(w)).length;
  return hits / seg.length >= 0.6;
}

/** The opening AI message as persisted (authoritative timestamp + rationale),
 *  with a client-side fallback for a server that doesn't echo it back. */
function openingMessageFrom(result: TurnResult): ConversationMessage {
  return (
    result.turnMessages?.ai ?? {
      role: "ai",
      content: result.message,
      timestamp: new Date().toISOString(),
      ...(result.whyItMatters ? { whyItMatters: result.whyItMatters } : {}),
      ...(result.importance ? { importance: result.importance } : {}),
    }
  );
}

export function AIConversationInterface({
  dealId,
  businessName,
  sellerToken,
  onTurnResult,
  onComplete,
  variant = "chat",
  via,
  meetingLink,
}: AIConversationInterfaceProps) {
  const together = variant === "together";
  const conductedBy = together ? ("broker_with_seller" as const) : undefined;
  // Hands-free (together mode): keep listening across questions and send the
  // seller's answer automatically after a pause. The broker clicks once.
  const [handsFree, setHandsFree] = useState(false);
  const handsFreeRef = useRef(false);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consumedResultsRef = useRef(0);
  const lastResultsLengthRef = useRef(0);
  const currentQuestionRef = useRef<string | undefined>(undefined);
  const handleSendRef = useRef<(text?: string) => Promise<void>>(async () => {});
  const HANDS_FREE_PAUSE_MS = 3000;
  // Speaker-aware live transcription (Deepgram) — the room's conversation,
  // labelled by speaker, sent to the AI as an exchange after a pause.
  const [liveActive, setLiveActive] = useState(false);
  const [liveStarting, setLiveStarting] = useState(false);
  const [liveLines, setLiveLines] = useState<{ speaker: number; text: string }[]>([]);
  const [liveInterim, setLiveInterim] = useState("");
  const [brokerSpeaker, setBrokerSpeaker] = useState<number | null>(null);
  const liveRef = useRef<LiveTranscriptionHandle | null>(null);
  const liveLinesRef = useRef<{ speaker: number; text: string }[]>([]);
  const brokerSpeakerRef = useRef<number | null>(null);
  const liveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // How long the seller must be silent before their answer is sent. 3s cut
  // natural speech ("let me see…") into fragments; 5s lets people think.
  const LIVE_PAUSE_MS = 5000;
  /** Mirrors isLoading for timer callbacks (a stale closure would read false). */
  const isLoadingRef = useRef(false);
  // In-Cimple video call (Daily) — together mode with via="cimple".
  const inCimpleCall = together && via === "cimple";
  const callHandleRef = useRef<CallHandle | null>(null);
  const [callObject, setCallObject] = useState<DailyCall | null>(null);
  // Bumped by "Rejoin" to run the call startup again after leaving.
  const [callAttempt, setCallAttempt] = useState(0);
  const [callState, setCallState] = useState<"idle" | "joining" | "live" | "ended" | "error">("idle");
  const [callError, setCallError] = useState<string | null>(null);
  const [sellerCallLink, setSellerCallLink] = useState<string | null>(null);
  const [sellerEmail, setSellerEmail] = useState("");
  const [sellerName, setSellerName] = useState("");
  const [linkBusy, setLinkBusy] = useState<"create" | "send" | null>(null);
  const [linkSentTo, setLinkSentTo] = useState<string | null>(null);
  // Notetaker bot on the broker's own Zoom / Meet / Teams call (Recall.ai).
  const externalCall = together && (via === "zoom" || via === "meet" || via === "teams");
  const [botMeetingUrl, setBotMeetingUrl] = useState(meetingLink || "");
  const [botState, setBotState] = useState<"idle" | "starting" | "joining" | "live" | "ended" | "error" | "unavailable">("idle");
  const [botStatusText, setBotStatusText] = useState<string>("");
  const botSeqRef = useRef(0);
  const botActiveRef = useRef(false);
  const brokerNameRef = useRef<string>("");
  const pip = usePictureInPicture({ width: 460, height: 600 });
  // Seller-mode calls carry the invite token; broker-mode relies on the
  // session cookie. authHeaders merges the token header when present.
  const authHeaders = (base: Record<string, string> = {}) =>
    sellerToken ? { ...base, "X-Seller-Token": sellerToken } : base;

  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [suggestedAnswers, setSuggestedAnswers] = useState<string[]>([]);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(true);
  // Set when the session could not be started — renders a real error panel
  // with a retry, instead of an enabled composer that silently does nothing.
  const [startError, setStartError] = useState<string | null>(null);
  // Bumped by "Try again" to re-run the start effect.
  const [startAttempt, setStartAttempt] = useState(0);
  const [isFinished, setIsFinished] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [confirmEndOpen, setConfirmEndOpen] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  // Set while the seller is correcting an earlier answer via "Edit" — the
  // composer holds their rewrite and sending flags the message as a
  // correction of this one (rather than a fresh answer to the latest question).
  const [editing, setEditing] = useState<{ timestamp: string; content: string } | null>(null);
  // Two-stage thinking indicator — after a few seconds the label reassures
  const [slowThinking, setSlowThinking] = useState(false);
  // True once the AI reply has started streaming in — swaps the thinking dots
  // for the live text.
  const [isStreaming, setIsStreaming] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);
  const preRecordingInputRef = useRef("");
  // What the composer held before "Edit" replaced it — restored on Cancel.
  const preEditInputRef = useRef("");
  // False until the first scroll-to-bottom after the transcript mounts, so a
  // restored conversation jumps straight to its last message.
  const initialScrollDoneRef = useRef(false);
  const inputRef = useRef("");
  const { toast } = useToast();

  // Start or resume the interview session on mount (and on retry)
  useEffect(() => {
    let cancelled = false;

    async function initSession() {
      setIsStarting(true);
      setStartError(null);
      try {
        const res = await fetch(`/api/interview/${dealId}/start`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(conductedBy ? { conductedBy, ...(via ? { conductedVia: via } : {}) } : {}),
        });

        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Failed to start conversation (${res.status})`);
        }

        const result: TurnResult = await res.json();
        if (cancelled) return;
        if (!result.sessionId) {
          throw new Error("The server did not return a session. Please try again.");
        }

        setSessionId(result.sessionId);

        // If resuming, load full history
        if (result.message) {
          const historyRes = await fetch(`/api/interview/session/${result.sessionId}/history`, {
            headers: authHeaders(),
          });
          if (cancelled) return;
          if (historyRes.ok) {
            const history: { messages?: ConversationMessage[]; status?: string } =
              await historyRes.json();
            if (history.messages && history.messages.length > 0) {
              // Resume — rationale and chips ride on the stored messages, so
              // the transcript comes back exactly as the seller left it.
              setMessages(history.messages);
              const last = history.messages[history.messages.length - 1];
              if (history.status !== "completed" && last.role === "ai") {
                // The question is still pending — re-offer its chips.
                // `result.suggestedAnswers` covers sessions persisted before
                // chips were stored on the message.
                setSuggestedAnswers(last.suggestedAnswers ?? result.suggestedAnswers ?? []);
              }
            } else {
              // New session — just the opening message
              setMessages([openingMessageFrom(result)]);
              setSuggestedAnswers(result.suggestedAnswers || []);
            }

            if (history.status === "completed") {
              setIsFinished(true);
            }
          } else {
            // History is a nice-to-have — fall back to the opening message so
            // the seller can still talk rather than seeing an empty screen.
            setMessages([openingMessageFrom(result)]);
            setSuggestedAnswers(result.suggestedAnswers || []);
          }
        }

        onTurnResult?.(result);
      } catch (error: any) {
        console.error("Failed to start conversation:", error);
        if (!cancelled) {
          const message = error?.message || "Failed to start conversation";
          setStartError(message);
          toast({
            title: "Failed to start conversation",
            description: message,
            variant: "destructive",
          });
        }
      } finally {
        if (!cancelled) {
          setIsStarting(false);
        }
      }
    }

    initSession();
    return () => { cancelled = true; };
  }, [dealId, startAttempt]);

  const retryStart = useCallback(() => {
    setIsStarting(true);
    setStartError(null);
    setMessages([]);
    setSuggestedAnswers([]);
    setEditing(null);
    setSessionId(null);
    initialScrollDoneRef.current = false;
    setStartAttempt((n) => n + 1);
  }, []);

  // Auto-scroll to the newest message. This has to wait for the transcript
  // to mount: while the session is still starting, the end marker isn't
  // rendered, so a restore used to set the messages and then land at the
  // top. The first pass jumps instantly — smoothly sliding through a long
  // restored transcript reads as the page running away.
  useEffect(() => {
    if (isStarting || !messagesEndRef.current) return;
    // Broker-led: the call and the question to read aloud live at the top —
    // never scroll them out of view; the transcript below is secondary.
    if (variant === "together") return;
    const behavior: ScrollBehavior = initialScrollDoneRef.current ? "smooth" : "auto";
    initialScrollDoneRef.current = true;
    messagesEndRef.current.scrollIntoView({ behavior, block: "end" });
  }, [messages, isLoading, isStarting, variant]);

  // Escalate the thinking label after a few seconds so long Opus turns
  // read as "still with you" rather than frozen.
  useEffect(() => {
    if (!isLoading) {
      setSlowThinking(false);
      return;
    }
    const t = setTimeout(() => setSlowThinking(true), 6000);
    return () => clearTimeout(t);
  }, [isLoading]);

  // Speech recognition
  const getSpeechRecognition = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return null;
    return new SpeechRecognition();
  }, []);

  const stopRecording = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    setIsRecording(false);
  }, []);

  const startRecording = useCallback(() => {
    const recognition = getSpeechRecognition();
    if (!recognition) {
      toast({
        title: "Voice input not supported",
        description: "Your browser does not support speech recognition. Please try Chrome or Edge.",
        variant: "destructive",
      });
      return;
    }

    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    preRecordingInputRef.current = inputRef.current.trim();

    recognition.onstart = () => setIsRecording(true);

    recognition.onresult = (event: any) => {
      let fullFinal = "";
      let interimTranscript = "";
      const hf = handsFreeRef.current;
      lastResultsLengthRef.current = event.results.length;
      for (let i = hf ? consumedResultsRef.current : 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          // Hands-free: the broker reading the question aloud is not an answer.
          if (hf && looksLikeQuestionEcho(transcript, currentQuestionRef.current)) continue;
          fullFinal += transcript + " ";
        } else {
          interimTranscript += transcript;
        }
      }
      const base = hf ? "" : preRecordingInputRef.current;
      const prefix = base ? base + " " : "";
      const combined = prefix + fullFinal.trimEnd() + (interimTranscript ? "\u200B" + interimTranscript : "");
      setInput(combined);
      inputRef.current = combined;
      if (hf) {
        if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
        const words = fullFinal.trim().split(/\s+/).filter(Boolean).length;
        if (words >= 3) {
          silenceTimerRef.current = setTimeout(() => {
            consumedResultsRef.current = lastResultsLengthRef.current;
            void handleSendRef.current();
          }, HANDS_FREE_PAUSE_MS);
        }
      }
    };

    recognition.onerror = (event: any) => {
      if (event.error === "not-allowed") {
        toast({
          title: "Microphone access denied",
          description: "Please allow microphone access in your browser settings.",
          variant: "destructive",
        });
      } else if (event.error !== "aborted") {
        toast({
          title: "Voice input error",
          description: `Speech recognition error: ${event.error}`,
          variant: "destructive",
        });
      }
      stopRecording();
    };

    recognition.onend = () => {
      setIsRecording(false);
      recognitionRef.current = null;
      setInput((prev) => prev.replace(/\u200B/g, "").trimEnd());
      // Chrome ends recognition after a stretch of silence — in hands-free
      // mode start it again (fresh result list, so nothing is re-sent).
      if (handsFreeRef.current) {
        consumedResultsRef.current = 0;
        lastResultsLengthRef.current = 0;
        setTimeout(() => { if (handsFreeRef.current && !recognitionRef.current) startRecordingRef.current(); }, 400);
      }
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [getSpeechRecognition, stopRecording, toast]);

  const startRecordingRef = useRef(startRecording);
  useEffect(() => { startRecordingRef.current = startRecording; }, [startRecording]);

  const toggleRecording = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, stopRecording, startRecording]);

  const toggleHandsFree = useCallback(() => {
    const next = !handsFreeRef.current;
    handsFreeRef.current = next;
    setHandsFree(next);
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }
    consumedResultsRef.current = 0;
    lastResultsLengthRef.current = 0;
    if (next) {
      if (!recognitionRef.current) startRecording();
    } else {
      stopRecording();
    }
  }, [startRecording, stopRecording]);

  // Cleanup speech recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) recognitionRef.current.stop();
    };
  }, []);

  // Send a message
  const handleSend = useCallback(async (overrideText?: string) => {
    if (isFinished || isLoading) return;
    if (!sessionId) {
      toast({
        title: "No active conversation",
        description: "The overview hasn't started yet. Use \"Try again\" to reconnect.",
        variant: "destructive",
      });
      return;
    }
    if (!handsFreeRef.current) stopRecording();
    if (silenceTimerRef.current) { clearTimeout(silenceTimerRef.current); silenceTimerRef.current = null; }

    // overrideText: a message sent programmatically (e.g. the broker's Skip)
    // without going through the composer's state.
    const cleanedInput = (overrideText ?? input).replace(/\u200B/g, "").trim();
    if (!cleanedInput) return;

    // A message sent from the editing banner is a correction of that earlier
    // answer \u2014 both the transcript and the agent treat it as an update.
    const correction = editing;
    setEditing(null);
    preEditInputRef.current = "";

    // Add user message to UI immediately
    const userMessage: ConversationMessage = {
      role: "user",
      content: cleanedInput,
      timestamp: new Date().toISOString(),
      ...(correction
        ? { correctionOf: { timestamp: correction.timestamp, content: correction.content } }
        : {}),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    inputRef.current = "";
    setSuggestedAnswers([]); // Clear chips while waiting for AI response
    setSelectedAnswer(null);
    setIsLoading(true);

    const controller = new AbortController();
    setAbortController(controller);

    // The AI reply streams into a single bubble, identified by this timestamp.
    const aiTs = new Date().toISOString();
    let streamedAny = false;
    const ensureBubble = () => {
      if (streamedAny) return;
      streamedAny = true;
      setMessages((prev) => [...prev, { role: "ai", content: "", timestamp: aiTs }]);
    };
    const appendToBubble = (chunk: string) => {
      ensureBubble();
      setMessages((prev) =>
        prev.map((m) => (m.timestamp === aiTs && m.role === "ai" ? { ...m, content: m.content + chunk } : m)),
      );
    };
    const setBubble = (text: string) => {
      ensureBubble();
      setMessages((prev) =>
        prev.map((m) => (m.timestamp === aiTs && m.role === "ai" ? { ...m, content: text } : m)),
      );
    };

    try {
      const res = await fetch(`/api/interview/${dealId}/message/stream`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          message: cleanedInput,
          sessionId,
          ...(userMessage.correctionOf ? { correctionOf: userMessage.correctionOf } : {}),
          ...(conductedBy ? { conductedBy, ...(via ? { conductedVia: via } : {}) } : {}),
        }),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `${res.status}: ${res.statusText}`);
      }

      // Parse the SSE stream: `data: {json}\n\n` frames.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let result: TurnResult | null = null;
      let streamError: string | null = null;

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const evt = JSON.parse(line.slice(6));
          if (evt.type === "delta") {
            setIsStreaming(true); // swaps the "thinking" dots for live text
            appendToBubble(evt.text);
          } else if (evt.type === "done") {
            result = evt.result as TurnResult;
          } else if (evt.type === "error") {
            streamError = evt.error || "Failed to process message";
          }
        }
      }

      if (streamError) throw new Error(streamError);
      if (!result) throw new Error("No response received");
      const finalResult: TurnResult = result;

      // The done result is authoritative — swap in the messages exactly as the
      // server persisted them (timestamps, rationale, chips), so what the
      // seller sees now is what a reload restores. The AI text is identical
      // to the streamed text on the happy path; this also corrects it if the
      // server's governance/recovery produced a different message.
      ensureBubble();
      const userTs = userMessage.timestamp;
      setMessages((prev) =>
        prev.map((m) => {
          if (m.role === "user" && m.timestamp === userTs && finalResult.turnMessages?.user) {
            return finalResult.turnMessages.user;
          }
          if (m.role === "ai" && m.timestamp === aiTs) {
            return (
              finalResult.turnMessages?.ai ?? {
                ...m,
                content: finalResult.message,
                ...(finalResult.whyItMatters ? { whyItMatters: finalResult.whyItMatters } : {}),
                ...(finalResult.importance ? { importance: finalResult.importance } : {}),
              }
            );
          }
          return m;
        }),
      );
      if (!result.shouldEnd) {
        setSuggestedAnswers(result.suggestedAnswers || []);
      }
      onTurnResult?.(result);
      if (result.shouldEnd) {
        setIsFinished(true);
        setTimeout(() => { void onComplete?.(); }, 2000);
      }
    } catch (error: any) {
      if (error.name === "AbortError") return;

      console.error("Interview message error:", error);
      const errText =
        "I'm sorry, something went wrong on my end. Your answer is still in the box below — just hit send again.";
      if (streamedAny) {
        setBubble(errText);
      } else {
        setMessages((prev) => [...prev, { role: "ai", content: errText, timestamp: aiTs }]);
      }
      // Restore the seller's text so they don't have to retype it — and the
      // editing state, so a re-send still lands as a correction.
      setInput(cleanedInput);
      inputRef.current = cleanedInput;
      if (correction) setEditing(correction);
    } finally {
      setAbortController(null);
      setIsLoading(false);
      setIsStreaming(false);
    }
  }, [input, editing, isFinished, isLoading, sessionId, dealId, stopRecording, onTurnResult, onComplete, toast]);

  // "Edit" on an earlier answer loads it into the composer; the banner above
  // the composer names what's being corrected and offers Cancel.
  const beginEdit = useCallback((message: ConversationMessage) => {
    if (!editing) preEditInputRef.current = inputRef.current;
    setEditing({ timestamp: message.timestamp, content: message.content });
    setSelectedAnswer(null);
    setInput(message.content);
    inputRef.current = message.content;
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [editing]);

  const cancelEdit = useCallback(() => {
    if (!editing) return;
    setEditing(null);
    const restored = preEditInputRef.current;
    preEditInputRef.current = "";
    setInput(restored);
    inputRef.current = restored;
  }, [editing]);

  const handleCancel = useCallback(() => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsLoading(false);
      setIsStreaming(false);
    }
  }, [abortController]);

  // Runs after the seller confirms in the End Overview dialog.
  const handleEndInterview = useCallback(async () => {
    if (isEnding) return;
    setIsEnding(true);
    stopRecording();
    handleCancel();

    // Tell the server so the session closes, progress advances, and the next
    // visit doesn't resume a conversation the seller already ended. If that
    // fails, keep the conversation open and say so — silently "ending" on the
    // client would leave the server thinking the overview is still in flight.
    if (sessionId) {
      try {
        const res = await fetch(`/api/interview/${dealId}/end`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ sessionId }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `Failed to end the overview (${res.status})`);
        }
      } catch (err: any) {
        console.error("Failed to finalize interview end:", err);
        toast({
          title: "Couldn't end the overview",
          description: err?.message || "Please try again.",
          variant: "destructive",
        });
        setIsEnding(false);
        return;
      }
    }

    setConfirmEndOpen(false);
    setIsFinished(true);
    const finishMessage: ConversationMessage = {
      role: "ai",
      content: "Thank you for your time. Your broker will review the information you've provided and may reach out if they need anything else.",
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, finishMessage]);
    setIsEnding(false);
    void onComplete?.();
  }, [stopRecording, handleCancel, onComplete, sessionId, dealId, isEnding, toast]);

  // Enter sends (the convention in every messaging app); Shift+Enter inserts
  // a newline. Ctrl/Cmd+Enter still sends for muscle memory.
  // ── Speaker-aware listening (Deepgram) ──
  const speakerLabel = useCallback((speaker: number) => {
    const b = brokerSpeakerRef.current;
    if (b === null) return `Speaker ${speaker + 1}`;
    return speaker === b ? "Broker" : "Seller";
  }, []);

  const flushLiveExchange = useCallback(() => {
    const lines = liveLinesRef.current;
    if (lines.length === 0) return;
    // The AI is still answering the previous exchange: keep everything and try
    // again shortly. (Previously the lines were cleared and then the send was
    // refused because a reply was in progress — speech said while the AI was
    // thinking was silently lost.)
    if (isLoadingRef.current) {
      if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
      liveTimerRef.current = setTimeout(() => flushLiveExchangeRef.current(), 1500);
      return;
    }
    const b = brokerSpeakerRef.current;
    // Only send once the SELLER has said something substantive — the broker
    // reading or rephrasing the question alone is not an answer.
    const sellerWords = lines
      .filter((l) => b === null || l.speaker !== b)
      .reduce((n, l) => n + l.text.split(/\s+/).filter(Boolean).length, 0);
    if (sellerWords < 4) return;
    const text = lines
      // Only the broker's lines can be "the question being read aloud"; a
      // seller who repeats the question's words is answering it.
      .filter((l) => !(l.speaker === b && looksLikeQuestionEcho(l.text, currentQuestionRef.current)))
      .map((l) => `${speakerLabel(l.speaker)}: ${l.text}`)
      .join("\n");
    liveLinesRef.current = [];
    setLiveLines([]);
    setLiveInterim("");
    if (text.trim()) void handleSendRef.current(text);
  }, [speakerLabel]);

  const flushLiveExchangeRef = useRef(flushLiveExchange);
  useEffect(() => { flushLiveExchangeRef.current = flushLiveExchange; }, [flushLiveExchange]);
  useEffect(() => { isLoadingRef.current = isLoading; }, [isLoading]);

  const armLiveTimer = useCallback(() => {
    if (liveTimerRef.current) clearTimeout(liveTimerRef.current);
    liveTimerRef.current = setTimeout(flushLiveExchange, LIVE_PAUSE_MS);
  }, [flushLiveExchange]);

  const onLiveSegment = useCallback((seg: LiveSegment) => {
    if (!seg.isFinal) { setLiveInterim(seg.text); return; }
    setLiveInterim("");
    // The speaker who reads the question aloud is the broker.
    if (brokerSpeakerRef.current === null && looksLikeQuestionEcho(seg.text, currentQuestionRef.current)) {
      brokerSpeakerRef.current = seg.speaker;
      setBrokerSpeaker(seg.speaker);
    }
    const lines = liveLinesRef.current.slice();
    const last = lines[lines.length - 1];
    if (last && last.speaker === seg.speaker) last.text = `${last.text} ${seg.text}`.trim();
    else lines.push({ speaker: seg.speaker, text: seg.text });
    liveLinesRef.current = lines;
    setLiveLines(lines);
    armLiveTimer();
  }, [armLiveTimer]);

  const stopLive = useCallback(() => {
    liveRef.current?.stop();
    liveRef.current = null;
    if (liveTimerRef.current) { clearTimeout(liveTimerRef.current); liveTimerRef.current = null; }
    setLiveActive(false);
    setLiveInterim("");
  }, []);

  /** One "Listen" button: speaker-aware transcription when configured, else the browser's. */
  const toggleListening = useCallback(async () => {
    if (liveActive) { stopLive(); return; }
    if (handsFreeRef.current) { toggleHandsFree(); return; }
    setLiveStarting(true);
    try {
      liveRef.current = await startLiveTranscription({
        dealId,
        sellerToken,
        onSegment: onLiveSegment,
        onUtteranceEnd: armLiveTimer,
        onError: (message) => { toast({ title: "Listening stopped", description: message, variant: "destructive" }); stopLive(); },
      });
      setLiveActive(true);
    } catch (err: any) {
      if (err instanceof NotConfiguredError) {
        toast({ title: "Using basic listening", description: "Speaker separation isn't set up on this server; the browser's speech recognition is used instead." });
        toggleHandsFree();
      } else {
        toast({ title: "Couldn't start listening", description: err?.message || "Microphone unavailable", variant: "destructive" });
      }
    } finally {
      setLiveStarting(false);
    }
  }, [liveActive, stopLive, toggleHandsFree, dealId, sellerToken, onLiveSegment, armLiveTimer, toast]);

  useEffect(() => { if (isFinished) stopLive(); }, [isFinished, stopLive]);
  useEffect(() => () => { liveRef.current?.stop(); if (liveTimerRef.current) clearTimeout(liveTimerRef.current); }, []);

  // Start the deal's video call when the together page opens in Cimple-call
  // mode; the transcript arrives per participant, so labels are exact.
  // Runs once: a ref guards it, because putting callState in the deps made
  // the effect cancel itself the moment it set "joining" (the broker's side
  // stayed blank while the seller got in).
  const callStartedRef = useRef(false);
  const onLiveSegmentRef = useRef(onLiveSegment);
  useEffect(() => { onLiveSegmentRef.current = onLiveSegment; }, [onLiveSegment]);
  const [remoteCount, setRemoteCount] = useState(0);
  // Call layout: the conversation column keeps itself scrolled to the latest turn.
  const callChatScrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = callChatScrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, isLoading]);
  useEffect(() => {
    if (!inCimpleCall || !sessionId || callStartedRef.current) return;
    callStartedRef.current = true;
    const start = async () => {
      setCallState("joining");
      try {
        const r = await fetch(`/api/interview/${dealId}/call/start`, { method: "POST", credentials: "include" });
        if (r.status === 503) throw new Error("The video call service isn't set up on this server.");
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't start the call");
        const { roomUrl, token } = await r.json();
        brokerSpeakerRef.current = 0;
        setBrokerSpeaker(0);
        // Our own call screen renders from this object; Daily only carries media.
        const call = createDailyCall();
        setCallObject(call);
        callHandleRef.current = await joinDailyCall(call, {
          roomUrl,
          token,
          onTranscript: (line) => {
            onLiveSegmentRef.current({ speaker: line.local ? 0 : 1, text: line.text, isFinal: line.isFinal, speechFinal: false });
          },
          onLeft: () => { setCallState("ended"); setLiveActive(false); },
          onError: (m) => { setCallError(m); },
          onRemoteCount: setRemoteCount,
        });
        setLiveActive(true);
        setCallState("live");
      } catch (err: any) {
        setCallError(err?.message || "Couldn't start the call");
        setCallState("error");
        callStartedRef.current = false;
      }
    };
    void start();
  }, [inCimpleCall, sessionId, dealId, callAttempt]);

  /** Leave button on the stage — the room stays open so the broker can rejoin. */
  const leaveCall = useCallback(async () => {
    const h = callHandleRef.current;
    callHandleRef.current = null;
    setCallObject(null);
    setCallState("ended");
    setLiveActive(false);
    if (h) await h.leave();
  }, []);

  const rejoinCall = useCallback(() => {
    callStartedRef.current = false;
    setCallError(null);
    setCallState("idle");
    setCallAttempt((n) => n + 1);
  }, []);

  // Leaving the page ends the call for everyone and clears the room.
  // Also covers leaving before actually joining (e.g. still on the camera
  // check): the room exists from call/start, so end it and remove the frame.
  useEffect(() => () => {
    if (callHandleRef.current) {
      void callHandleRef.current.leave();
      callHandleRef.current = null;
    } else {
      try { DailyIframe.getCallInstance()?.destroy(); } catch { /* no call */ }
    }
    if (callStartedRef.current) {
      callStartedRef.current = false;
      void fetch(`/api/interview/${dealId}/call/end`, { method: "POST", credentials: "include", keepalive: true });
    }
  }, [dealId]);

  // Send the notetaker to the external call and poll its transcript.
  const startBot = useCallback(async (url: string) => {
    if (!url.trim()) return;
    setBotState("starting");
    setBotStatusText("");
    try {
      const me = await fetch("/api/broker-auth/me", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      brokerNameRef.current = (me?.name || me?.username || "").toString().trim().toLowerCase();
      const r = await fetch(`/api/interview/${dealId}/call/bot/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetingUrl: url.trim() }),
        credentials: "include",
      });
      if (r.status === 503) { setBotState("unavailable"); return; }
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't send the notetaker");
      botSeqRef.current = 0;
      botActiveRef.current = true;
      brokerSpeakerRef.current = 0;
      setBrokerSpeaker(0);
      setLiveActive(true);
      setBotState("joining");
    } catch (err: any) {
      setBotState("error");
      setBotStatusText(err?.message || "Couldn't send the notetaker");
    }
  }, [dealId]);

  useEffect(() => {
    if (!externalCall || !sessionId || botState !== "idle" || !meetingLink) return;
    void startBot(meetingLink);
  }, [externalCall, sessionId, botState, meetingLink, startBot]);

  useEffect(() => {
    if (!externalCall || !botActiveRef.current || (botState !== "joining" && botState !== "live")) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const r = await fetch(`/api/interview/${dealId}/call/bot/lines?after=${botSeqRef.current}`, { credentials: "include" });
        if (!r.ok || cancelled) return;
        const data = await r.json() as { lines: { seq: number; participantId: string | number; name: string | null; isHost: boolean | null; text: string }[]; seq: number; status: string | null };
        for (const l of data.lines) {
          botSeqRef.current = Math.max(botSeqRef.current, l.seq);
          const name = (l.name || "").trim().toLowerCase();
          const isBroker = (brokerNameRef.current && name && (name === brokerNameRef.current || name.includes(brokerNameRef.current))) || (!brokerNameRef.current && l.isHost === true);
          onLiveSegment({ speaker: isBroker ? 0 : 1, text: l.text, isFinal: true, speechFinal: false });
        }
        const st = data.status || "";
        if (st === "fatal" || st === "call_ended" || st === "done") {
          setBotState("ended");
          setBotStatusText(st === "fatal" ? "The notetaker couldn't join — check the meeting link and that the meeting has started." : "The notetaker left the call.");
          botActiveRef.current = false;
        } else if (st === "in_call_recording" || st === "in_call_not_recording" || data.lines.length > 0) {
          setBotState("live");
        } else if (st) {
          setBotStatusText(st.replace(/_/g, " "));
        }
      } catch { /* transient */ }
    };
    void tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [externalCall, botState, dealId, onLiveSegment]);

  // Leaving the page makes the bot leave the call.
  useEffect(() => () => {
    if (botActiveRef.current) {
      botActiveRef.current = false;
      void fetch(`/api/interview/${dealId}/call/bot/stop`, { method: "POST", credentials: "include", keepalive: true });
    }
  }, [dealId]);

  // The seller's link to the call — loaded as soon as the call page opens.
  useEffect(() => {
    if (!inCimpleCall) return;
    fetch(`/api/interview/${dealId}/call/seller-link`, { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d) return;
        if (d.link) setSellerCallLink(d.link);
        if (d.sellerEmail) setSellerEmail(d.sellerEmail);
        if (d.sellerName) setSellerName(d.sellerName);
      })
      .catch(() => {});
  }, [inCimpleCall, dealId]);

  const requestSellerLink = useCallback(async (send: boolean) => {
    setLinkBusy(send ? "send" : "create");
    try {
      const r = await fetch(`/api/interview/${dealId}/call/seller-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sellerEmail: sellerEmail.trim(), sellerName: sellerName.trim(), send }),
        credentials: "include",
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Couldn't get the seller's link");
      setSellerCallLink(d.link);
      if (send) {
        if (d.emailSent) { setLinkSentTo(sellerEmail.trim()); toast({ title: "Link sent", description: `Emailed to ${sellerEmail.trim()}.` }); }
        else toast({ title: "Email didn't send", description: "Copy the link and send it yourself.", variant: "destructive" });
      } else {
        const ok = await navigator.clipboard?.writeText(d.link).then(() => true).catch(() => false);
        toast({ title: ok ? "Seller's link copied" : "Seller's link ready", description: ok ? "Paste it into a text or email to the seller." : d.link });
      }
    } catch (err: any) {
      toast({ title: "Couldn't get the seller's link", description: err?.message, variant: "destructive" });
    } finally {
      setLinkBusy(null);
    }
  }, [dealId, sellerEmail, sellerName, toast]);

  const listening = liveActive || handsFree;
  const listenLabel = liveStarting ? "Starting…" : listening ? "Stop listening" : "Listen";

  // ── Broker-led ("together") helpers ──
  const currentQuestion = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "ai") return messages[i];
    return null;
  }, [messages]);
  const cleanInput = input.replace(/\u200B/g, "").trim();
  useEffect(() => { currentQuestionRef.current = currentQuestion?.content; }, [currentQuestion]);
  useEffect(() => { handleSendRef.current = handleSend; }, [handleSend]);
  // Stop hands-free when the interview finishes or the component unmounts.
  useEffect(() => {
    if (isFinished && handsFreeRef.current) { handsFreeRef.current = false; setHandsFree(false); stopRecording(); }
  }, [isFinished, stopRecording]);
  useEffect(() => () => { handsFreeRef.current = false; if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current); }, []);
  const skipQuestion = useCallback(() => {
    if (isFinished || isLoading) return;
    void handleSend("The seller would rather skip this one for now — please move on to the next question.");
  }, [isFinished, isLoading, handleSend]);

  /** The compact question + answer panel — main view and floating window share it. */
  /** What's being heard right now, labelled by speaker. */
  const renderLiveTranscript = (extraClass: string, maxLines: number) => (
    liveActive && (liveLines.length > 0 || liveInterim) ? (
        <div className={`${extraClass} rounded-lg border border-border/60 bg-card/60 px-3 py-2 text-xs space-y-0.5`} data-testid="live-transcript">
          {liveLines.slice(-maxLines).map((l, i) => (
            <p key={i} className="flex gap-2">
              <button
                type="button"
                className={`shrink-0 font-medium ${brokerSpeaker === l.speaker ? "text-muted-foreground" : "text-teal"} hover:underline`}
                title={brokerSpeaker === l.speaker ? "This is you" : "Click if this is you (the broker)"}
                onClick={() => { brokerSpeakerRef.current = l.speaker; setBrokerSpeaker(l.speaker); }}
              >
                {speakerLabel(l.speaker)}
              </button>
              <span className="text-foreground/90">{l.text}</span>
            </p>
          ))}
          {liveInterim && <p className="text-muted-foreground/60 italic">{liveInterim}</p>}
        </div>
      ) : null
  );

  const renderTogetherPanel = (compact: boolean) => (
    <div className={compact ? "p-4 space-y-3" : "max-w-3xl mx-auto mb-4"} data-testid={compact ? "together-panel-pip" : "together-panel"}>
      <div className="rounded-xl border border-teal/30 bg-teal/5 px-5 py-4">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-teal">Ask the seller</p>
          {currentQuestion?.importance && (
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{IMPORTANCE_TEXT[currentQuestion.importance]}</span>
          )}
        </div>
        <p className={`${compact ? "text-base" : "text-lg"} leading-snug`}>
          {currentQuestion?.content || (isLoading ? "Preparing the next question…" : "…")}
        </p>
        {currentQuestion?.whyItMatters && (
          <p className="mt-2 text-xs text-muted-foreground flex items-start gap-1.5">
            <HelpCircle className="h-3 w-3 mt-0.5 shrink-0" />
            <span>{currentQuestion.whyItMatters}</span>
          </p>
        )}
        {suggestedAnswers.length > 0 && !isLoading && (
          <div className="mt-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1">Listen for</p>
            <ul className="flex flex-wrap gap-1.5">
              {suggestedAnswers.map((a, i) => (
                <li key={i} className="text-xs rounded-full border border-border/70 px-2.5 py-1 text-muted-foreground">{a}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {!inCimpleCall && renderLiveTranscript(compact ? "" : "mt-2", 4)}
      {compact && !isFinished && (
        <div className="space-y-2">
          <Textarea
            value={input}
            onChange={(e) => { setInput(e.target.value); inputRef.current = e.target.value; }}
            placeholder={isRecording ? "Listening… the seller can answer now" : "Seller's answer — press the mic or type"}
            className="resize-none min-h-[72px] text-sm"
            disabled={isLoading}
          />
          <div className="flex items-center gap-2">
            <Button onClick={() => void toggleListening()} size="sm" variant={listening ? "destructive" : "outline"} disabled={isFinished || liveStarting} className="h-8 gap-1.5" title="What the seller says is sent automatically after a pause">
              {listening ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
              {listenLabel}
            </Button>
            <Button onClick={() => void handleSend()} size="sm" disabled={isLoading || !cleanInput} className="h-8 gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90">
              {isLoading ? <StopCircle className="h-3.5 w-3.5 animate-pulse" /> : <Send className="h-3.5 w-3.5" />}
              {isLoading ? "Thinking…" : "Send"}
            </Button>
            <Button onClick={skipQuestion} size="sm" variant="ghost" disabled={isLoading} className="h-8 gap-1.5 ml-auto text-muted-foreground">
              <SkipForward className="h-3.5 w-3.5" /> Skip
            </Button>
          </div>
        </div>
      )}
      {compact && isFinished && (
        <p className="text-sm text-muted-foreground">Interview finished — close this window.</p>
      )}
    </div>
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    } else if (e.key === "Escape" && editing) {
      e.preventDefault();
      cancelEdit();
    }
  };

  // Earlier answers that a later message corrected — dimmed in the transcript
  const correctedTimestamps = new Set(
    messages.flatMap((m) => (m.correctionOf?.timestamp ? [m.correctionOf.timestamp] : [])),
  );

  // Starting state
  if (isStarting) {
    return (
      <div className="flex flex-col h-full items-center justify-center gap-3 text-muted-foreground">
        <div className="flex gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0.15s" }} />
          <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0.3s" }} />
        </div>
        <span className="text-sm">
          {businessName ? `Preparing overview for ${businessName}...` : "Starting overview..."}
        </span>
      </div>
    );
  }

  // Start failed (auth, missing API key, deal not found, network) — show a
  // real error with a retry instead of a composer that can't send anything.
  if (startError || !sessionId) {
    return (
      <div className="flex flex-col h-full items-center justify-center p-6" data-testid="status-start-error">
        <div className="max-w-md w-full rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center space-y-4">
          <AlertCircle className="h-8 w-8 mx-auto text-destructive" />
          <div className="space-y-1.5">
            <p className="text-sm font-medium">We couldn't start your overview</p>
            <p className="text-xs text-muted-foreground">
              {startError || "No conversation session was created."}
            </p>
          </div>
          <Button
            onClick={retryStart}
            size="sm"
            className="bg-teal text-teal-foreground hover:bg-teal/90"
            data-testid="button-retry-start"
          >
            <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
            Try again
          </Button>
          <p className="text-[11px] text-muted-foreground/60">
            If this keeps happening, contact your broker.
          </p>
        </div>
      </div>
    );
  }

  // ── Reusable pieces of the conversation screen ──
  const messagesView = (
      <div className={inCimpleCall ? "px-4 py-4 space-y-4" : `px-6 py-5 space-y-5 ${together ? "opacity-80" : ""}`}>
        {messages.map((message, idx) => (
          <ChatMessage
            key={`${message.timestamp}-${idx}`}
            role={message.role}
            content={message.content}
            timestamp={message.timestamp}
            whyItMatters={message.role === "ai" ? message.whyItMatters : undefined}
            importance={message.role === "ai" ? message.importance : undefined}
            correctionOf={message.role === "user" ? message.correctionOf : undefined}
            superseded={message.role === "user" && correctedTimestamps.has(message.timestamp)}
            isEditing={message.role === "user" && editing?.timestamp === message.timestamp}
            onEdit={
              message.role === "user" && !isFinished && !isLoading
                ? () => beginEdit(message)
                : undefined
            }
          />
        ))}
        {isLoading && !isStreaming && (
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0.15s" }} />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0.3s" }} />
            </div>
            <span className="text-xs text-muted-foreground">
              {slowThinking
                ? "Still with you — pulling your details together..."
                : "Your advisor is thinking..."}
            </span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
  );

  const composerView = (
      <div className="border-t border-border px-4 py-3 bg-card">
        {isFinished ? (
          <div className="max-w-3xl mx-auto">
            <div className="flex items-center justify-between gap-3 px-4 py-3 rounded-lg bg-success/8 border border-success/20">
              <div className="flex items-center gap-3">
                <CheckCircle className="h-4 w-4 text-success shrink-0" />
                <div>
                  <p className="text-sm font-medium">Business Overview up to date</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    You can come back anytime to add or update details.
                  </p>
                </div>
              </div>
              {onComplete && (
                <button
                  onClick={() => { void onComplete(); }}
                  className="shrink-0 px-3 py-1.5 text-xs font-medium rounded-md bg-teal text-teal-foreground hover:bg-teal/90 transition-colors"
                >
                  Continue →
                </button>
              )}
            </div>
          </div>
        ) : (
          <>
            {isRecording && (
              <div className="max-w-3xl mx-auto mb-2 flex items-center gap-2" data-testid="status-voice-mode">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-destructive" />
                </span>
                <span className="text-xs font-medium text-destructive">Listening...</span>
              </div>
            )}

            {/* Editing banner — names the answer being corrected, offers Cancel */}
            {editing && (
              <div
                className="max-w-3xl mx-auto mb-2.5 flex items-center gap-2 rounded-md border border-teal/30 bg-teal/8 px-3 py-1.5 text-xs"
                data-testid="status-editing-answer"
              >
                <Pencil className="h-3 w-3 text-teal shrink-0" />
                <span className="font-medium text-foreground shrink-0">Editing your earlier answer</span>
                <span className="text-muted-foreground truncate min-w-0">“{editing.content}”</span>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="ml-auto shrink-0 inline-flex items-center gap-1 text-muted-foreground hover:text-foreground transition-colors"
                  data-testid="button-cancel-edit"
                >
                  <X className="h-3 w-3" />
                  Cancel
                </button>
              </div>
            )}

            {/* Suggested answer chips — single-select: picking one fills the
                composer (editable before sending); picking another replaces it.
                Multi-select produced nonsense like "One. Three." Hidden while
                editing: the chips answer the current question, not the one
                being corrected. */}
            {!together && suggestedAnswers.length > 0 && !isLoading && !editing && (
              <div className="max-w-3xl mx-auto mb-2.5 flex flex-wrap gap-1.5">
                {suggestedAnswers.map((answer, idx) => {
                  const isSelected = selectedAnswer === idx;
                  return (
                    <button
                      key={idx}
                      onClick={() => {
                        const next = isSelected ? null : idx;
                        setSelectedAnswer(next);
                        const text = next === null ? "" : answer;
                        setInput(text);
                        inputRef.current = text;
                      }}
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium
                        transition-colors duration-100 cursor-pointer select-none
                        ${isSelected
                          ? "bg-teal/20 text-teal border border-teal/50"
                          : "bg-teal/8 text-teal border border-teal/20 hover:bg-teal/15 hover:border-teal/35"
                        }`}
                    >
                      {isSelected && <span className="text-teal">✓</span>}
                      {answer}
                    </button>
                  );
                })}
              </div>
            )}

            <div className="max-w-3xl mx-auto flex gap-2">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => { setInput(e.target.value); inputRef.current = e.target.value; }}
                onKeyDown={handleKeyDown}
                placeholder={
                  together
                    ? (isRecording ? "Listening… the seller can answer now" : isLoading ? "Waiting…" : "Seller's answer — press the mic while they talk, or type what they said")
                    : isRecording
                    ? "Listening... speak now"
                    : isLoading
                      ? "Waiting..."
                      : editing
                        ? "Type your corrected answer..."
                        : suggestedAnswers.length > 0
                          ? "Pick an option above or type your own response..."
                          : "Your response..."
                }
                className="resize-none min-h-[56px] text-sm"
                disabled={isLoading}
                data-testid="input-message"
              />
              <div className="flex flex-col gap-1.5">
                <Button
                  onClick={toggleRecording}
                  size="icon"
                  variant={isRecording ? "destructive" : "outline"}
                  disabled={isFinished || isLoading}
                  className="h-8 w-8"
                  data-testid="button-mic-toggle"
                >
                  {isRecording ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                </Button>
                {isLoading ? (
                  <Button
                    onClick={handleCancel}
                    size="icon"
                    variant="destructive"
                    className="h-8 w-8"
                    data-testid="button-cancel"
                  >
                    <StopCircle className="h-3.5 w-3.5" />
                  </Button>
                ) : (
                  <Button
                    onClick={() => void handleSend()}
                    size="icon"
                    disabled={!input.replace(/\u200B/g, "").trim()}
                    className="h-8 w-8 bg-teal text-teal-foreground hover:bg-teal/90"
                    data-testid="button-send"
                  >
                    <Send className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>
            </div>

            <div className="max-w-3xl mx-auto mt-1.5 flex justify-between items-center">
              <span className="text-[10px] text-muted-foreground/60">
                {editing
                  ? "Enter to send your correction · Esc to cancel"
                  : "Enter to send · Shift+Enter for a new line · Progress saves automatically"}
              </span>
              {together && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={skipQuestion}
                  disabled={isLoading || isEnding}
                  className="h-6 text-[10px] text-muted-foreground/60 hover:text-muted-foreground px-2 ml-auto mr-1"
                  data-testid="button-skip-question"
                >
                  <SkipForward className="h-3 w-3 mr-1" />
                  Skip question
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmEndOpen(true)}
                disabled={isLoading || isEnding}
                className="h-6 text-[10px] text-muted-foreground/60 hover:text-muted-foreground px-2"
                data-testid="button-end-interview"
              >
                <LogOut className="h-3 w-3 mr-1" />
                End Overview
              </Button>
            </div>
          </>
        )}
      </div>
  );

  /** Invite the seller to the in-Cimple call — one compact row; collapses once they're in. */
  const inviteView = remoteCount > 0 ? (
    <p className="text-xs text-success flex items-center gap-1.5" data-testid="seller-joined">
      <CheckCircle className="h-3.5 w-3.5" /> Seller joined the call
      {sellerCallLink && (
        <button type="button" className="ml-2 text-muted-foreground hover:text-foreground underline underline-offset-2"
          onClick={() => { void navigator.clipboard?.writeText(sellerCallLink).then(() => toast({ title: "Seller's link copied" })); }}>
          copy link again
        </button>
      )}
    </p>
  ) : (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-teal/30 bg-teal/5 px-3 py-2 text-xs"
      title="The seller opens the link in their browser — nothing to install — and joins as soon as you're in the call."
      data-testid="seller-call-invite"
    >
      <span className="font-medium shrink-0">Invite the seller</span>
      {sellerCallLink ? (
        <>
          <span className="min-w-[160px] flex-1 truncate rounded border border-border bg-background px-2 py-1 font-mono text-[11px] text-muted-foreground" title={sellerCallLink}>{sellerCallLink}</span>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 shrink-0"
            onClick={() => { void navigator.clipboard?.writeText(sellerCallLink).then(() => toast({ title: "Seller's link copied", description: "Paste it into a text or email to the seller." })); }}
            data-testid="button-copy-seller-call-link"
          >
            <Copy className="h-3 w-3" /> Copy
          </Button>
        </>
      ) : (
        <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => void requestSellerLink(false)} disabled={!!linkBusy} data-testid="button-create-seller-call-link">
          {linkBusy === "create" ? "Creating…" : "Get the link"}
        </Button>
      )}
      <span className="text-muted-foreground shrink-0">or email it</span>
      <input
        value={sellerEmail}
        onChange={(e) => setSellerEmail(e.target.value)}
        placeholder="seller@email.com"
        type="email"
        className="h-7 w-44 rounded border border-border bg-background px-2 text-xs"
        data-testid="input-seller-call-email"
      />
      <Button
        size="sm"
        className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90 shrink-0"
        onClick={() => void requestSellerLink(true)}
        disabled={!!linkBusy || !sellerEmail.trim()}
        data-testid="button-email-seller-call-link"
      >
        {linkBusy === "send" ? "Sending…" : "Send"}
      </Button>
      {linkSentTo && <span className="text-success shrink-0">Sent to {linkSentTo}</span>}
    </div>
  );

  /** Ending closes the session on the server — confirm before doing it. */
  const confirmDialogView = (
      <AlertDialog
        open={confirmEndOpen}
        onOpenChange={(open) => { if (!open && !isEnding) setConfirmEndOpen(false); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>End your Business Overview?</AlertDialogTitle>
            <AlertDialogDescription>
              Everything you've shared so far is saved. Ending now closes this conversation
              and hands it to your broker — you can still come back later to add or update details.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isEnding}>Keep going</AlertDialogCancel>
            <AlertDialogAction
              disabled={isEnding}
              onClick={(e) => {
                e.preventDefault();
                void handleEndInterview();
              }}
              data-testid="button-confirm-end-interview"
            >
              {isEnding ? "Ending..." : "End Overview"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
  );


  // ── In-Cimple video call: video big on the left with the question under
  // it; transcript + conversation + notes in a column on the right. ──
  if (inCimpleCall) {
    return (
      <div className="flex h-full min-h-0 flex-col lg:flex-row" data-testid="call-layout">
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
          <div className="shrink-0">{inviteView}</div>
          {callState === "ended" || callState === "error" ? (
            <div className="flex min-h-[300px] flex-1 flex-col items-center justify-center gap-3 rounded-xl bg-[#0c0b0a] text-sm text-[#9C958A]" data-testid="broker-call-frame">
              <span>{callState === "ended" ? "You left the call." : (callError || "Couldn't start the call")}</span>
              <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={rejoinCall} data-testid="button-rejoin-call">
                {callState === "ended" ? "Rejoin the call" : "Try again"}
              </Button>
            </div>
          ) : (
            <CallStage
              call={callObject}
              selfLabel="You"
              otherLabel={sellerName || "Seller"}
              waitingText="Waiting for the seller to join…"
              onLeave={() => void leaveCall()}
              className="min-h-[300px] flex-1"
            />
          )}
          {callState === "live" && callError && <p className="shrink-0 -mt-1 text-[11px] text-red-400">{callError}</p>}
          <div className="shrink-0 [&_[data-testid=together-panel]]:max-w-none [&_[data-testid=together-panel]]:mb-0">
            {renderTogetherPanel(false)}
          </div>
        </div>
        <div className="flex min-h-[420px] w-full shrink-0 flex-col border-t border-border bg-card/30 lg:min-h-0 lg:w-[400px] lg:border-l lg:border-t-0">
          <div className="shrink-0 border-b border-border px-4 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-muted-foreground">Live transcript</p>
            {renderLiveTranscript("mt-1.5", 8) ?? (
              <p className="mt-1 text-xs text-muted-foreground/70">
                {callState === "live" ? "Listening — what the seller says appears here." : "Starts when you join the call."}
              </p>
            )}
            {liveLines.length > 0 && (
              <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                <span>{isLoading ? "Held until the AI finishes its reply…" : "Sends automatically 5 seconds after the seller stops."}</span>
                <button
                  type="button"
                  className="shrink-0 underline underline-offset-2 hover:text-foreground disabled:opacity-40"
                  disabled={isLoading}
                  onClick={() => { if (liveTimerRef.current) clearTimeout(liveTimerRef.current); flushLiveExchangeRef.current(); }}
                  data-testid="button-send-exchange-now"
                >
                  Send now
                </button>
              </div>
            )}
          </div>
          <div ref={callChatScrollRef} className="min-h-0 flex-1 overflow-y-auto">
            {messagesView}
          </div>
          {composerView}
        </div>
        {confirmDialogView}
        {together && pip.container && createPortal(renderTogetherPanel(true), pip.container)}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Everything above the composer scrolls as one — in "together" mode the
          call, invite box and question card would otherwise push the composer
          off the bottom of the screen. */}
      <div className="flex-1 min-h-0 overflow-y-auto">
      {/* Broker-led: the question to read aloud sits on top; the transcript
          below stays available but secondary. */}
      {externalCall && (
        <div className="px-6 pt-4 shrink-0">
          <div className="max-w-3xl mx-auto rounded-lg border border-border/60 bg-card/50 px-4 py-2.5 text-xs" data-testid="notetaker-panel">
            {(botState === "idle" || botState === "error" || botState === "ended" || botState === "unavailable") && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-muted-foreground">
                  {botState === "unavailable"
                    ? "The notetaker isn't set up on this server — use Listen below with your laptop mic instead."
                    : botState === "error" || botState === "ended"
                      ? botStatusText
                      : `Paste your ${via === "meet" ? "Google Meet" : via === "teams" ? "Teams" : "Zoom"} link and Cimple's notetaker will join to transcribe.`}
                </span>
                {botState !== "unavailable" && (
                  <>
                    <input
                      value={botMeetingUrl}
                      onChange={(e) => setBotMeetingUrl(e.target.value)}
                      placeholder="https://…"
                      className="flex-1 min-w-[220px] h-7 rounded border border-border bg-background px-2 text-xs"
                      data-testid="input-notetaker-url"
                    />
                    <Button size="sm" className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => void startBot(botMeetingUrl)} disabled={!botMeetingUrl.trim()} data-testid="button-notetaker-start">
                      {botState === "ended" || botState === "error" ? "Send again" : "Send notetaker"}
                    </Button>
                  </>
                )}
              </div>
            )}
            {(botState === "starting" || botState === "joining") && (
              <p className="text-muted-foreground flex items-center gap-2"><StopCircle className="h-3 w-3 animate-pulse" /> Cimple Notetaker is joining your call{botStatusText ? ` (${botStatusText})` : "…"} — it appears as a participant named "Cimple Notetaker".</p>
            )}
            {botState === "live" && (
              <p className="flex items-center gap-2"><span className="relative flex h-2 w-2"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-teal opacity-75" /><span className="relative inline-flex rounded-full h-2 w-2 bg-teal" /></span> In the call — transcribing. The seller's answers send automatically after a pause.</p>
            )}
          </div>
        </div>
      )}
      {together && (
        <div className="px-6 pt-5 shrink-0">
          {renderTogetherPanel(false)}
          <div className="max-w-3xl mx-auto -mt-2 mb-2 flex items-center justify-between gap-2">
            <p className="text-[11px] text-muted-foreground">
              {inCimpleCall
                ? "Read the question to the seller; their answer is captured from the call."
                : via && via !== "person"
                ? `On your ${via === "meet" ? "Google Meet" : via === "teams" ? "Teams" : "Zoom"} call${meetingLink ? "" : ""} — pop the question out so it floats over the call.`
                : liveActive
                  ? `Listening to the room — ${brokerSpeaker === null ? "read the question aloud once so Cimple learns your voice" : "the seller's answer is sent automatically after a pause"}.`
                  : "Read the question aloud; press Listen once and the seller's answer is sent automatically after a pause."}
            </p>
            {!isFinished && !inCimpleCall && !(externalCall && (botState === "joining" || botState === "live" || botState === "starting")) && (
              <Button
                size="sm"
                variant={listening ? "destructive" : "outline"}
                className="h-7 text-xs gap-1.5 shrink-0"
                onClick={() => void toggleListening()}
                disabled={liveStarting}
                title="Keep listening to the room; what the seller says is sent automatically after a pause"
                data-testid="button-listen"
              >
                {listening ? <MicOff className="h-3.5 w-3.5" /> : <Mic className="h-3.5 w-3.5" />}
                {listenLabel}
              </Button>
            )}
            {!isFinished && (
              <Button
                size="sm"
                variant={pip.isOpen ? "secondary" : "outline"}
                className="h-7 text-xs gap-1.5 shrink-0"
                onClick={() => {
                  if (pip.isOpen) { pip.close(); return; }
                  void pip.open()
                    .then((ok) => { if (!ok) toast({ title: "Floating window needs Chrome or Edge", description: "Keep this tab beside your call instead.", variant: "destructive" }); })
                    .catch((err: Error) => toast({ title: "Couldn't open the floating window", description: `${err.message}. Keep this tab beside your call instead.`, variant: "destructive" }));
                }}
                data-testid="button-pop-out"
              >
                <PictureInPicture2 className="h-3.5 w-3.5" />
                {pip.isOpen ? "Bring back" : "Pop out"}
              </Button>
            )}
          </div>
        </div>
      )}

      {messagesView}
      </div>

      {composerView}

      {confirmDialogView}

      {/* Floating question window (Chrome/Edge) — same state, rendered into
          the picture-in-picture document so it floats over the broker's call. */}
      {together && pip.container && createPortal(renderTogetherPanel(true), pip.container)}
    </div>
  );
}
