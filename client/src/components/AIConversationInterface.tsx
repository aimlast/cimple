import { useState, useEffect, useRef, useCallback } from "react";
import { Send, StopCircle, SkipForward, HelpCircle, AlertTriangle, CheckCircle, LogOut, Mic, MicOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ChatMessage } from "./ChatMessage";
import { useToast } from "@/hooks/use-toast";
import type { ConversationMessage, ExtractedInfo } from "@shared/schema";

interface AIConversationInterfaceProps {
  dealId?: string;
  businessName?: string;
  industry?: string;
  existingInfo?: ExtractedInfo;
  onInfoUpdate?: (info: ExtractedInfo) => void;
  onComplete?: () => void;
  preliminaryData?: Record<string, string>;
}

const QUICK_ACTIONS = [
  { label: "Skip this question", value: "I don't have this information right now. Please ask me a different question.", icon: SkipForward },
  { label: "Need clarification", value: "Can you explain what you mean by that? I want to make sure I give you the right information.", icon: HelpCircle },
  { label: "Need to verify", value: "I'm not 100% sure about this - I'll need to verify with my records or team before answering.", icon: AlertTriangle },
];

export function AIConversationInterface({ 
  dealId,
  businessName,
  industry,
  existingInfo,
  onInfoUpdate, 
  onComplete,
  preliminaryData = {} 
}: AIConversationInterfaceProps) {
  
  const greeting = businessName 
    ? `Hi! I'm going to walk you through some straightforward questions about ${businessName} so we can put together a strong profile for buyers. I'll go one at a time — just answer what you know.\n\nFirst up: what does ${businessName} sell or offer? List out your main products or services.`
    : "Hi! I'm going to walk you through some straightforward questions about your business so we can put together a strong profile for buyers. I'll go one at a time — just answer what you know.\n\nFirst up: what does your business sell or offer? List out your main products or services.";

  const [messages, setMessages] = useState<ConversationMessage[]>([
    {
      role: "ai",
      content: greeting,
      timestamp: new Date().toLocaleTimeString(),
    },
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [extractedInfo, setExtractedInfo] = useState<ExtractedInfo>({});
  const [messageQueue, setMessageQueue] = useState<string[]>([]);
  const [abortController, setAbortController] = useState<AbortController | null>(null);
  const [isFinished, setIsFinished] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const processingRef = useRef(false);
  const recognitionRef = useRef<any>(null);
  const preRecordingInputRef = useRef("");
  const inputRef = useRef("");
  const { toast } = useToast();

  const getSpeechRecognition = useCallback(() => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      return null;
    }
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

    recognition.onstart = () => {
      setIsRecording(true);
    };

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
          description: "Please allow microphone access in your browser settings to use voice input.",
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
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  }, [isRecording, stopRecording, startRecording]);

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  const handleEndInterview = () => {
    stopRecording();
    if (abortController) {
      abortController.abort();
      setAbortController(null);
    }
    setIsLoading(false);
    setIsFinished(true);
    setMessageQueue([]);
    
    const finishMessage: ConversationMessage = {
      role: "ai",
      content: "Thank you for completing this interview! I've gathered all the information you've shared. Your broker will review this and may reach out if they need any additional details. You can close this window now.",
      timestamp: new Date().toLocaleTimeString(),
    };
    setMessages((prev) => [...prev, finishMessage]);
    
    if (onComplete) {
      onComplete();
    }
  };

  // Process queued messages when AI finishes responding
  useEffect(() => {
    if (isFinished) return; // Don't process queue if interview is finished
    if (!isLoading && messageQueue.length > 0 && !processingRef.current) {
      processingRef.current = true;
      const nextMessage = messageQueue[0];
      setMessageQueue((prev) => prev.slice(1));
      
      const nextUserMessage: ConversationMessage = {
        role: "user",
        content: nextMessage,
        timestamp: new Date().toLocaleTimeString(),
      };
      
      setMessages((prev) => [...prev, nextUserMessage]);
      setIsLoading(true);
      processingRef.current = false;
    }
  }, [isLoading, messageQueue, isFinished]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleCancel = () => {
    if (abortController) {
      abortController.abort();
      setAbortController(null);
      setIsLoading(false);
      
      const cancelMessage: ConversationMessage = {
        role: "ai",
        content: "Response cancelled. Feel free to continue with your next message.",
        timestamp: new Date().toLocaleTimeString(),
      };
      setMessages((prev) => [...prev, cancelMessage]);
    }
  };

  // Process message with current messages from state
  useEffect(() => {
    if (isLoading && !abortController) {
      const controller = new AbortController();
      setAbortController(controller);

      (async () => {
        try {
          const res = await fetch("/api/chat", {
            method: "POST",
            body: JSON.stringify({
              messages,
              extractedInfo,
              preliminaryData,
            }),
            headers: {
              "Content-Type": "application/json",
            },
            signal: controller.signal,
          });

          const response: {
            message?: string;
            extractedInfo?: ExtractedInfo;
            error?: string;
            userMessage?: string;
            shouldFinish?: boolean;
          } = await res.json();

          if (!res.ok) {
            throw new Error(response.userMessage || response.error || `${res.status}: ${res.statusText}`);
          }

          if (response.message) {
            const aiMessage: ConversationMessage = {
              role: "ai",
              content: response.message,
              timestamp: new Date().toLocaleTimeString(),
            };

            setMessages((prev) => [...prev, aiMessage]);
            
            if (response.extractedInfo) {
              setExtractedInfo(response.extractedInfo);
              
              if (onInfoUpdate) {
                onInfoUpdate(response.extractedInfo);
              }
            }
            
            // If AI suggests finishing, auto-finish the interview
            if (response.shouldFinish) {
              setIsFinished(true);
              setMessageQueue([]);
              if (onComplete) {
                onComplete();
              }
            }
          }
        } catch (error: any) {
          if (error.name === 'AbortError') {
            // Request was cancelled, don't show error
            return;
          }
          
          console.error("Chat error:", error);
          
          // Graceful retry: If the error suggests the AI didn't understand or get an answer
          const shouldRetry = error.message?.includes("error") || error.message?.includes("failed");
          
          if (shouldRetry) {
            const retryMessage: ConversationMessage = {
              role: "ai",
              content: "I apologize, but I didn't quite catch that. Could you please rephrase your response or provide more details?",
              timestamp: new Date().toLocaleTimeString(),
            };
            setMessages((prev) => [...prev, retryMessage]);
          } else {
            const errorMessage: ConversationMessage = {
              role: "ai",
              content: error.message || "I apologize, but I encountered an error. Please try again.",
              timestamp: new Date().toLocaleTimeString(),
            };
            setMessages((prev) => [...prev, errorMessage]);
          }
        } finally {
          setAbortController(null);
          setIsLoading(false);
        }
      })();
    }
  }, [isLoading, messages, extractedInfo, preliminaryData, abortController, onInfoUpdate]);

  const handleSend = () => {
    if (isFinished) return;
    stopRecording();
    const cleanedInput = input.replace(/\u200B/g, "").trim();
    if (!cleanedInput) return;

    const userMessage: ConversationMessage = {
      role: "user",
      content: cleanedInput,
      timestamp: new Date().toLocaleTimeString(),
    };

    setInput("");
    inputRef.current = "";
    const currentInput = cleanedInput;

    // If AI is already responding, queue this message
    if (isLoading) {
      setMessageQueue((prev) => [...prev, currentInput]);
      return;
    }

    // Add message and trigger AI processing
    setMessages((prev) => [...prev, userMessage]);
    setIsLoading(true);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Shift+Enter or Ctrl+Enter sends the message
    // Plain Enter creates a new line (default behavior)
    if (e.key === "Enter" && (e.shiftKey || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {messages.map((message, idx) => (
          <ChatMessage
            key={`${message.timestamp}-${idx}`}
            role={message.role}
            content={message.content}
            timestamp={message.timestamp}
          />
        ))}
        {isLoading && (
          <div className="flex items-center gap-2 text-muted-foreground text-sm">
            <div className="flex gap-1">
              <span className="animate-bounce">●</span>
              <span className="animate-bounce" style={{ animationDelay: "0.1s" }}>●</span>
              <span className="animate-bounce" style={{ animationDelay: "0.2s" }}>●</span>
            </div>
            <span>AI is thinking...</span>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t p-4 bg-card">
        {isFinished ? (
          <div className="max-w-3xl mx-auto">
            <Card className="bg-primary/5 border-primary/20">
              <CardContent className="pt-6 text-center space-y-4">
                <CheckCircle className="h-12 w-12 mx-auto text-primary" />
                <div>
                  <h3 className="font-semibold text-lg">Interview Complete</h3>
                  <p className="text-muted-foreground text-sm mt-1">
                    Thank you for your time. Your broker will review the information you've provided.
                  </p>
                </div>
              </CardContent>
            </Card>
          </div>
        ) : (
          <>
            {messageQueue.length > 0 && (
              <div className="max-w-3xl mx-auto mb-2 text-sm text-muted-foreground">
                {messageQueue.length} message{messageQueue.length > 1 ? 's' : ''} queued
              </div>
            )}
            
            <div className="max-w-3xl mx-auto mb-3 flex flex-wrap gap-2">
              {QUICK_ACTIONS.map((action) => {
                const IconComponent = action.icon;
                return (
                  <Button
                    key={action.label}
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      if (isLoading) {
                        setMessageQueue((prev) => [...prev, action.value]);
                      } else {
                        const userMessage: ConversationMessage = {
                          role: "user",
                          content: action.value,
                          timestamp: new Date().toLocaleTimeString(),
                        };
                        setMessages((prev) => [...prev, userMessage]);
                        setIsLoading(true);
                      }
                    }}
                    disabled={isLoading && messageQueue.length >= 3}
                    data-testid={`button-quick-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
                  >
                    <IconComponent className="h-3 w-3 mr-1" />
                    {action.label}
                  </Button>
                );
              })}
              <Button
                variant="secondary"
                size="sm"
                onClick={handleEndInterview}
                disabled={isLoading}
                data-testid="button-end-interview"
              >
                <LogOut className="h-3 w-3 mr-1" />
                End Interview
              </Button>
            </div>

            {isRecording && (
              <div className="max-w-3xl mx-auto mb-2 flex items-center gap-2" data-testid="status-voice-mode">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-destructive opacity-75" />
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-destructive" />
                </span>
                <span className="text-sm font-medium text-destructive">Voice mode active — listening...</span>
              </div>
            )}

            <div className="max-w-3xl mx-auto flex gap-2">
              <Textarea
                value={input}
                onChange={(e) => { setInput(e.target.value); inputRef.current = e.target.value; }}
                onKeyDown={handleKeyDown}
                placeholder={isRecording ? "Listening... speak now" : isLoading ? "Type your next message... (will be sent after AI responds)" : "Type your response... (Shift+Enter to send)"}
                className="resize-none min-h-[60px]"
                data-testid="input-message"
              />
              <div className="flex flex-col gap-1">
                <Button
                  onClick={toggleRecording}
                  size="icon"
                  variant={isRecording ? "destructive" : "outline"}
                  disabled={isFinished}
                  data-testid="button-mic-toggle"
                >
                  {isRecording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                </Button>
                {isLoading ? (
                  <Button
                    onClick={handleCancel}
                    size="icon"
                    variant="destructive"
                    data-testid="button-cancel"
                  >
                    <StopCircle className="h-5 w-5" />
                  </Button>
                ) : (
                  <Button
                    onClick={handleSend}
                    size="icon"
                    disabled={!input.replace(/\u200B/g, "").trim()}
                    data-testid="button-send"
                  >
                    <Send className="h-5 w-5" />
                  </Button>
                )}
              </div>
            </div>
            <div className="max-w-3xl mx-auto mt-2 text-xs text-muted-foreground text-center">
              Not sure about something? Use the quick actions above, or click "End Interview" when you're done.
            </div>
          </>
        )}
      </div>
    </div>
  );
}
