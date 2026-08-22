import { useState, useEffect, useRef, useCallback } from "react";
import { Send, StopCircle, CheckCircle, LogOut, Mic, MicOff, AlertCircle, RefreshCw, Pencil, X } from "lucide-react";
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
    }
  );
}

export function AIConversationInterface({
  dealId,
  businessName,
  sellerToken,
  onTurnResult,
  onComplete,
}: AIConversationInterfaceProps) {
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
    const behavior: ScrollBehavior = initialScrollDoneRef.current ? "smooth" : "auto";
    initialScrollDoneRef.current = true;
    messagesEndRef.current.scrollIntoView({ behavior, block: "end" });
  }, [messages, isLoading, isStarting]);

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
      for (let i = 0; i < event.results.length; i++) {
        const transcript = event.results[i][0].transcript;
        if (event.results[i].isFinal) {
          fullFinal += transcript + " ";
        } else {
          interimTranscript += transcript;
        }
      }
      const base = preRecordingInputRef.current;
      const prefix = base ? base + " " : "";
      const combined = prefix + fullFinal.trimEnd() + (interimTranscript ? "\u200B" + interimTranscript : "");
      setInput(combined);
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
    };

    recognitionRef.current = recognition;
    recognition.start();
  }, [getSpeechRecognition, stopRecording, toast]);

  const toggleRecording = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, stopRecording, startRecording]);

  // Cleanup speech recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) recognitionRef.current.stop();
    };
  }, []);

  // Send a message
  const handleSend = useCallback(async () => {
    if (isFinished || isLoading) return;
    if (!sessionId) {
      toast({
        title: "No active conversation",
        description: "The overview hasn't started yet. Use \"Try again\" to reconnect.",
        variant: "destructive",
      });
      return;
    }
    stopRecording();

    const cleanedInput = input.replace(/\u200B/g, "").trim();
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

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {messages.map((message, idx) => (
          <ChatMessage
            key={`${message.timestamp}-${idx}`}
            role={message.role}
            content={message.content}
            timestamp={message.timestamp}
            whyItMatters={message.role === "ai" ? message.whyItMatters : undefined}
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

      {/* Input area */}
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
            {suggestedAnswers.length > 0 && !isLoading && !editing && (
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
                  isRecording
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
                    onClick={handleSend}
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

      {/* Ending closes the session on the server — confirm before doing it */}
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
    </div>
  );
}
