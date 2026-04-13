import { useState, useEffect, useRef, useCallback } from "react";
import { Send, StopCircle, CheckCircle, LogOut, Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { ChatMessage } from "./ChatMessage";
import { useToast } from "@/hooks/use-toast";
import type { ConversationMessage } from "@shared/schema";

interface TurnResult {
  message: string;
  suggestedAnswers: string[];
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
  onTurnResult?: (result: TurnResult) => void;
  onComplete?: () => void;
}

export function AIConversationInterface({
  dealId,
  businessName,
  onTurnResult,
  onComplete,
}: AIConversationInterfaceProps) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [suggestedAnswers, setSuggestedAnswers] = useState<string[]>([]);
  const [selectedAnswers, setSelectedAnswers] = useState<Set<number>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isStarting, setIsStarting] = useState(true);
  const [isFinished, setIsFinished] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [abortController, setAbortController] = useState<AbortController | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const recognitionRef = useRef<any>(null);
  const preRecordingInputRef = useRef("");
  const inputRef = useRef("");
  const { toast } = useToast();

  // Start or resume the interview session on mount
  useEffect(() => {
    let cancelled = false;

    async function initSession() {
      try {
        const res = await fetch(`/api/interview/${dealId}/start`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || "Failed to start conversation");
        }

        const result: TurnResult = await res.json();
        if (cancelled) return;

        setSessionId(result.sessionId);

        // If resuming, load full history
        if (result.message) {
          const historyRes = await fetch(`/api/interview/session/${result.sessionId}/history`);
          if (historyRes.ok) {
            const history = await historyRes.json();
            if (history.messages && history.messages.length > 0) {
              setMessages(history.messages);
              // Don't show suggestions when resuming — context is already established
            } else {
              // New session — just the opening message
              setMessages([{
                role: "ai",
                content: result.message,
                timestamp: new Date().toISOString(),
              }]);
              setSuggestedAnswers(result.suggestedAnswers || []);
            }

            if (history.status === "completed") {
              setIsFinished(true);
            }
          }
        }

        onTurnResult?.(result);
      } catch (error: any) {
        console.error("Failed to start conversation:", error);
        if (!cancelled) {
          toast({
            title: "Failed to start conversation",
            description: error.message,
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
  }, [dealId]);

  // Auto-scroll to bottom
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isLoading]);

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
    if (isFinished || isLoading || !sessionId) return;
    stopRecording();

    const cleanedInput = input.replace(/\u200B/g, "").trim();
    if (!cleanedInput) return;

    // Add user message to UI immediately
    const userMessage: ConversationMessage = {
      role: "user",
      content: cleanedInput,
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    inputRef.current = "";
    setSuggestedAnswers([]); // Clear chips while waiting for AI response
    setSelectedAnswers(new Set());
    setIsLoading(true);

    const controller = new AbortController();
    setAbortController(controller);

    try {
      const res = await fetch(`/api/interview/${dealId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: cleanedInput, sessionId }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || `${res.status}: ${res.statusText}`);
      }

      const result: TurnResult = await res.json();

      // Add AI response
      const aiMessage: ConversationMessage = {
        role: "ai",
        content: result.message,
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, aiMessage]);

      // Show new suggested answers for this question
      if (!result.shouldEnd) {
        setSuggestedAnswers(result.suggestedAnswers || []);
      }

      // Update parent with turn results
      onTurnResult?.(result);

      if (result.shouldEnd) {
        setIsFinished(true);
        // Let the user see the completion banner, then fire onComplete
        setTimeout(() => onComplete?.(), 2000);
      }
    } catch (error: any) {
      if (error.name === "AbortError") return;

      console.error("Interview message error:", error);
      const errorMessage: ConversationMessage = {
        role: "ai",
        content: "I'm sorry, something went wrong on my end. Could you try sending that again?",
        timestamp: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setAbortController(null);
      setIsLoading(false);
    }
  }, [input, isFinished, isLoading, sessionId, dealId, stopRecording, onTurnResult]);

  const handleCancel = useCallback(() => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsLoading(false);
    }
  }, [abortController]);

  const handleEndInterview = useCallback(() => {
    stopRecording();
    handleCancel();
    setIsFinished(true);

    const finishMessage: ConversationMessage = {
      role: "ai",
      content: "Thank you for your time. Your broker will review the information you've provided and may reach out if they need anything else.",
      timestamp: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, finishMessage]);
    onComplete?.();
  }, [stopRecording, handleCancel, onComplete]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

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
          {businessName ? `Preparing conversation for ${businessName}...` : "Starting conversation..."}
        </span>
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
          />
        ))}
        {isLoading && (
          <div className="flex items-center gap-2">
            <div className="flex gap-1">
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0.15s" }} />
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce" style={{ animationDelay: "0.3s" }} />
            </div>
            <span className="text-xs text-muted-foreground">thinking...</span>
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
                  <p className="text-sm font-medium">Conversation up to date</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    You can come back anytime to add or update details.
                  </p>
                </div>
              </div>
              {onComplete && (
                <button
                  onClick={() => onComplete()}
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

            {/* Suggested answer chips — multi-select */}
            {suggestedAnswers.length > 0 && !isLoading && (
              <div className="max-w-3xl mx-auto mb-2.5 flex flex-wrap gap-1.5">
                {suggestedAnswers.map((answer, idx) => {
                  const isSelected = selectedAnswers.has(idx);
                  return (
                    <button
                      key={idx}
                      onClick={() => {
                        const next = new Set(selectedAnswers);
                        if (isSelected) {
                          next.delete(idx);
                        } else {
                          next.add(idx);
                        }
                        setSelectedAnswers(next);
                        // Combine all selected answers into the input
                        const combined = suggestedAnswers
                          .filter((_, i) => next.has(i))
                          .join(". ");
                        setInput(combined);
                        inputRef.current = combined;
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
                value={input}
                onChange={(e) => { setInput(e.target.value); inputRef.current = e.target.value; }}
                onKeyDown={handleKeyDown}
                placeholder={
                  isRecording
                    ? "Listening... speak now"
                    : isLoading
                      ? "Waiting..."
                      : suggestedAnswers.length > 0
                        ? "Select an option above or type your own response..."
                        : "Your response... (Shift+Enter to send)"
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
              <span className="text-[10px] text-muted-foreground/60">Shift+Enter to send</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleEndInterview}
                disabled={isLoading}
                className="h-6 text-[10px] text-muted-foreground/60 hover:text-muted-foreground px-2"
                data-testid="button-end-interview"
              >
                <LogOut className="h-3 w-3 mr-1" />
                End Conversation
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
