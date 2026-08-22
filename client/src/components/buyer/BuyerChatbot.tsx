/**
 * BuyerChatbot — Floating chat widget for buyer Q&A on the CIM viewer.
 *
 * Buyers can ask questions about the business. The AI answers immediately
 * from CIM content. If it can't, the question escalates to the broker,
 * then the seller for approval. Published Q&A from prior buyers also shows.
 *
 * While any question is waiting on the broker, the widget polls the
 * published Q&A feed so the answer lands in the open session instead of
 * only appearing on the next page load.
 */
import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import type { BuyerQuestion } from "@shared/schema";
import {
  MessageCircle, X, Send, Loader2, Bot,
  HelpCircle, Clock, CheckCircle2,
} from "lucide-react";

interface BuyerChatbotProps {
  dealId: string;
  buyerAccessId: string;
  /** The buyer's view-room token — the server authenticates questions with it */
  accessToken: string;
  businessName: string;
  publishedQuestions: BuyerQuestion[];
}

interface ChatMessage {
  id: string;
  role: "buyer" | "ai" | "system";
  content: string;
  status?: "published" | "pending_broker" | "pending_seller" | "answered";
  /** Server-side question id — lets us pair an escalated question with its later answer */
  questionId?: string;
  timestamp: Date;
}

/** How often to check for a broker answer while a question is outstanding */
const ANSWER_POLL_MS = 30_000;

export function BuyerChatbot({
  dealId,
  buyerAccessId,
  accessToken,
  businessName,
  publishedQuestions,
}: BuyerChatbotProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>(() => {
    const initial: ChatMessage[] = [];

    // Welcome message
    initial.push({
      id: "welcome",
      role: "system",
      content: `Welcome! I can answer questions about ${businessName} based on the CIM. If I can't answer from the document, your question will be forwarded to the broker.`,
      timestamp: new Date(),
    });

    // Seed with published Q&A from previous buyers
    for (const q of publishedQuestions) {
      initial.push({
        id: `pq-${q.id}`,
        role: "buyer",
        content: q.question,
        status: "published",
        questionId: q.id,
        timestamp: new Date(q.createdAt),
      });
      initial.push({
        id: `pa-${q.id}`,
        role: "ai",
        content: q.publishedAnswer || q.aiAnswer || "",
        status: "published",
        questionId: q.id,
        timestamp: new Date(q.createdAt),
      });
    }

    return initial;
  });
  const [unreadCount, setUnreadCount] = useState(0);
  // Question ids still waiting on the broker — drives the answer poll
  const [pendingIds, setPendingIds] = useState<string[]>([]);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (isOpen) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, isOpen]);

  // Focus input when opened
  useEffect(() => {
    if (isOpen) {
      setUnreadCount(0);
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [isOpen]);

  const askQuestion = useMutation({
    mutationFn: async (question: string) => {
      const res = await fetch(`/api/deals/${dealId}/questions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, buyerAccessId, accessToken }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || "We couldn't send your question. Please try again.");
      }
      return res.json() as Promise<{ id: string; status: ChatMessage["status"]; message: string }>;
    },
    onMutate: (question) => {
      // Optimistic: add buyer message immediately
      const buyerMsg: ChatMessage = {
        id: `b-${Date.now()}`,
        role: "buyer",
        content: question,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, buyerMsg]);
      setInput("");
    },
    onSuccess: (data) => {
      const aiMsg: ChatMessage = {
        id: `a-${data.id}`,
        role: data.status === "published" ? "ai" : "system",
        content: data.message,
        status: data.status,
        questionId: data.id,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, aiMsg]);
      if (data.status === "pending_broker" || data.status === "pending_seller") {
        setPendingIds(prev => (prev.includes(data.id) ? prev : [...prev, data.id]));
      }

      if (!isOpen) {
        setUnreadCount(prev => prev + 1);
      }
    },
    onError: (e: Error) => {
      const errMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: "system",
        content: e.message || "Something went wrong. Please try again.",
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errMsg]);
      toast({ title: "Question not sent", description: e.message, variant: "destructive" });
    },
  });

  // ── Poll for broker answers while any question is outstanding ──────────
  const hasPending = pendingIds.length > 0;
  const answerPoll = useQuery<BuyerQuestion[]>({
    queryKey: ["/api/deals", dealId, "questions", "published", accessToken],
    enabled: hasPending,
    refetchInterval: hasPending ? ANSWER_POLL_MS : false,
    refetchOnWindowFocus: hasPending,
    queryFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/questions/published`, {
        headers: { "x-buyer-token": accessToken },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as { error?: string }));
        throw new Error(body.error || "Couldn't check for new answers");
      }
      return res.json();
    },
  });

  useEffect(() => {
    const published = answerPoll.data;
    if (!published || pendingIds.length === 0) return;
    const answered = published.filter(
      q => pendingIds.includes(q.id) && (q.publishedAnswer || q.aiAnswer),
    );
    if (answered.length === 0) return;

    setMessages(prev => {
      const next = prev.map(m =>
        m.questionId && m.status !== "published" && answered.some(a => a.id === m.questionId)
          ? { ...m, status: "answered" as const }
          : m,
      );
      for (const a of answered) {
        if (next.some(m => m.id === `pa-${a.id}`)) continue;
        next.push({
          id: `pa-${a.id}`,
          role: "ai",
          content: a.publishedAnswer || a.aiAnswer || "",
          status: "published",
          questionId: a.id,
          timestamp: new Date(a.updatedAt || a.createdAt),
        });
      }
      return next;
    });
    setPendingIds(prev => prev.filter(id => !answered.some(a => a.id === id)));
    if (!isOpen) setUnreadCount(prev => prev + answered.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answerPoll.data]);

  const handleSubmit = () => {
    const trimmed = input.trim();
    if (!trimmed || askQuestion.isPending) return;
    askQuestion.mutate(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  // Filter out the seeded published Q&A for the "prior answers" section
  const priorCount = publishedQuestions.length;

  return (
    <>
      {/* ── Floating trigger button ──────────────────────────────── */}
      {!isOpen && (
        <button
          onClick={() => setIsOpen(true)}
          aria-label="Ask a question about this business"
          className="fixed bottom-4 right-4 sm:bottom-6 sm:right-6 z-50 h-14 w-14 rounded-full bg-teal text-teal-foreground shadow-lg hover:bg-teal/90 transition-all hover:scale-105 flex items-center justify-center group"
          data-testid="button-open-chat"
        >
          <MessageCircle className="h-6 w-6" />
          {unreadCount > 0 && (
            <span className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">
              {unreadCount}
            </span>
          )}
        </button>
      )}

      {/* ── Chat panel ───────────────────────────────────────────── */}
      {/* Fits any viewport: full-width (minus margins) on phones, 380px on larger screens */}
      {isOpen && (
        <div
          className="fixed z-50 inset-x-4 bottom-4 sm:inset-x-auto sm:right-6 sm:bottom-6 w-auto sm:w-[380px] max-w-[calc(100vw-2rem)] h-[70vh] max-h-[560px] rounded-2xl border border-border bg-background shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 duration-200"
          data-testid="chat-panel"
        >
          {/* Header */}
          <div className="px-4 py-3 border-b border-border bg-card flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className="h-8 w-8 rounded-lg bg-teal/10 flex items-center justify-center shrink-0">
                <HelpCircle className="h-4 w-4 text-teal" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold leading-tight truncate">Ask about this business</p>
                <p className="text-[10px] text-muted-foreground">AI-powered &middot; answers from the CIM</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              aria-label="Close chat"
              className="h-7 w-7 rounded-md hover:bg-muted flex items-center justify-center transition-colors shrink-0"
              data-testid="button-close-chat"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {/* Prior Q&A count badge */}
          {priorCount > 0 && (
            <div className="px-4 py-2 border-b border-border bg-muted/30 flex items-center gap-2">
              <Badge variant="outline" className="text-[10px] h-5">
                {priorCount} prior {priorCount === 1 ? "answer" : "answers"}
              </Badge>
              <span className="text-[10px] text-muted-foreground">from previous buyers</span>
            </div>
          )}

          {/* Messages */}
          <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
            {messages.map((msg) => (
              <div key={msg.id} className={`flex gap-2 ${msg.role === "buyer" ? "flex-row-reverse" : ""}`}>
                {/* Avatar */}
                {msg.role !== "buyer" && (
                  <div className={`h-6 w-6 rounded-full shrink-0 flex items-center justify-center mt-0.5 ${
                    msg.role === "ai" ? "bg-teal/10" : "bg-muted"
                  }`}>
                    {msg.role === "ai" ? (
                      <Bot className="h-3.5 w-3.5 text-teal" />
                    ) : (
                      <HelpCircle className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                  </div>
                )}

                {/* Bubble */}
                <div className={`max-w-[85%] rounded-xl px-3 py-2 text-sm leading-relaxed ${
                  msg.role === "buyer"
                    ? "bg-teal text-teal-foreground rounded-br-sm"
                    : msg.role === "ai"
                    ? "bg-card border border-border rounded-bl-sm"
                    : "bg-muted/50 text-muted-foreground text-xs italic rounded-bl-sm"
                }`}>
                  {msg.content}
                  {(msg.status === "pending_broker" || msg.status === "pending_seller") && (
                    <div className="mt-1.5 space-y-0.5 text-[10px] opacity-80">
                      <div className="flex items-center gap-1">
                        <Clock className="h-2.5 w-2.5" />
                        Forwarded to your broker
                      </div>
                      <div className="not-italic opacity-80">
                        {answerPoll.isError
                          ? "We couldn't check for the answer just now — we'll keep trying, and it will also be here the next time you open this CIM."
                          : "The answer will appear here as soon as it's ready (we check every 30 seconds), and the next time you open this CIM."}
                      </div>
                    </div>
                  )}
                  {msg.status === "answered" && (
                    <div className="mt-1.5 flex items-center gap-1 text-[10px] opacity-80">
                      <CheckCircle2 className="h-2.5 w-2.5" />
                      Your broker has answered — see below
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Typing indicator */}
            {askQuestion.isPending && (
              <div className="flex gap-2">
                <div className="h-6 w-6 rounded-full bg-teal/10 flex items-center justify-center">
                  <Bot className="h-3.5 w-3.5 text-teal" />
                </div>
                <div className="bg-card border border-border rounded-xl rounded-bl-sm px-3 py-2">
                  <div className="flex gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:0ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:150ms]" />
                    <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 animate-bounce [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Input */}
          <div className="px-3 py-3 border-t border-border bg-card shrink-0">
            <div className="flex items-end gap-2">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Ask a question..."
                rows={1}
                className="flex-1 min-w-0 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-teal placeholder:text-muted-foreground/60 max-h-24"
                style={{ minHeight: "36px" }}
                data-testid="input-chat-question"
              />
              <Button
                size="sm"
                className="h-9 w-9 p-0 shrink-0 bg-teal text-teal-foreground hover:bg-teal/90"
                disabled={!input.trim() || askQuestion.isPending}
                onClick={handleSubmit}
                aria-label="Send question"
                data-testid="button-send-question"
              >
                {askQuestion.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Send className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
