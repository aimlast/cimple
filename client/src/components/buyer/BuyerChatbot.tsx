/**
 * BuyerChatbot — Floating chat widget for buyer Q&A on the CIM viewer.
 *
 * Buyers can ask questions about the business. The AI answers immediately
 * from CIM content. If it can't, the question escalates to the broker,
 * then the seller for approval. Published Q&A from prior buyers also shows.
 */
import { useState, useRef, useEffect } from "react";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { BuyerQuestion } from "@shared/schema";
import {
  MessageCircle, X, Send, Loader2, Bot,
  HelpCircle, Clock,
} from "lucide-react";

interface BuyerChatbotProps {
  dealId: string;
  buyerAccessId: string;
  businessName: string;
  publishedQuestions: BuyerQuestion[];
}

interface ChatMessage {
  id: string;
  role: "buyer" | "ai" | "system";
  content: string;
  status?: "published" | "pending_broker" | "pending_seller";
  timestamp: Date;
}

export function BuyerChatbot({
  dealId,
  buyerAccessId,
  businessName,
  publishedQuestions,
}: BuyerChatbotProps) {
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
        timestamp: new Date(q.createdAt),
      });
      initial.push({
        id: `pa-${q.id}`,
        role: "ai",
        content: q.publishedAnswer || q.aiAnswer || "",
        status: "published",
        timestamp: new Date(q.createdAt),
      });
    }

    return initial;
  });
  const [unreadCount, setUnreadCount] = useState(0);

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
        body: JSON.stringify({ question, buyerAccessId }),
      });
      if (!res.ok) throw new Error("Failed to submit");
      return res.json();
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
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, aiMsg]);

      if (!isOpen) {
        setUnreadCount(prev => prev + 1);
      }
    },
    onError: () => {
      const errMsg: ChatMessage = {
        id: `err-${Date.now()}`,
        role: "system",
        content: "Something went wrong. Please try again.",
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, errMsg]);
    },
  });

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
          className="fixed bottom-6 right-6 z-50 h-14 w-14 rounded-full bg-teal text-teal-foreground shadow-lg hover:bg-teal/90 transition-all hover:scale-105 flex items-center justify-center group"
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
      {isOpen && (
        <div className="fixed bottom-6 right-6 z-50 w-[380px] h-[560px] rounded-2xl border border-border bg-background shadow-2xl flex flex-col overflow-hidden animate-in slide-in-from-bottom-4 duration-200">
          {/* Header */}
          <div className="px-4 py-3 border-b border-border bg-card flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="h-8 w-8 rounded-lg bg-teal/10 flex items-center justify-center">
                <HelpCircle className="h-4 w-4 text-teal" />
              </div>
              <div>
                <p className="text-sm font-semibold leading-tight">Ask about this business</p>
                <p className="text-[10px] text-muted-foreground">AI-powered &middot; answers from the CIM</p>
              </div>
            </div>
            <button
              onClick={() => setIsOpen(false)}
              className="h-7 w-7 rounded-md hover:bg-muted flex items-center justify-center transition-colors"
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
                  {msg.status === "pending_broker" && (
                    <div className="mt-1.5 flex items-center gap-1 text-[10px] opacity-70">
                      <Clock className="h-2.5 w-2.5" />
                      Forwarded to broker
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
                className="flex-1 resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-teal placeholder:text-muted-foreground/60 max-h-24"
                style={{ minHeight: "36px" }}
              />
              <Button
                size="sm"
                className="h-9 w-9 p-0 shrink-0 bg-teal text-teal-foreground hover:bg-teal/90"
                disabled={!input.trim() || askQuestion.isPending}
                onClick={handleSubmit}
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
