/**
 * BuyerChatbot — Floating chat widget for buyer Q&A on the CIM viewer.
 *
 * Buyers can ask questions about the business. The AI answers immediately
 * from CIM content. If it can't, the question escalates to the broker,
 * then the seller for approval.
 *
 * The seeded history is the buyer's full feed: published Q&A (theirs and
 * other buyers', labelled by ownership) plus their own questions still
 * waiting on the broker — so a reload never loses a pending question.
 *
 * While any question is waiting on the broker, the widget polls the feed
 * so the answer lands in the open session instead of only appearing on
 * the next page load.
 */
import { useState, useRef, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import {
  MessageCircle, X, Send, Loader2, Bot,
  HelpCircle, Clock, CheckCircle2,
} from "lucide-react";

/**
 * One item of the buyer-facing Q&A feed (GET /api/view/:token →
 * publishedQuestions, GET /api/deals/:dealId/questions/published).
 * Whitelisted server shape — never the raw buyerQuestions row.
 */
export interface BuyerQuestionFeedItem {
  id: string;
  question: string;
  /** pending_ai | pending_broker | pending_seller | published | declined */
  status: string;
  isPublished: boolean;
  aiAnswer: string | null;
  publishedAnswer: string | null;
  createdAt: string | Date;
  updatedAt: string | Date;
  /** True when this buyer asked the question */
  isMine: boolean;
}

interface BuyerChatbotProps {
  dealId: string;
  buyerAccessId: string;
  /** The buyer's view-room token — the server authenticates questions with it */
  accessToken: string;
  businessName: string;
  questionFeed: BuyerQuestionFeedItem[];
}

interface ChatMessage {
  id: string;
  role: "buyer" | "ai" | "system";
  content: string;
  status?: "published" | "pending_broker" | "pending_seller" | "answered" | "declined";
  /** Server-side question id — lets us pair an escalated question with its later answer */
  questionId?: string;
  /** Who asked a seeded question — other buyers' questions get a caption */
  origin?: "mine" | "other";
  timestamp: Date;
}

/** How often to check for a broker answer while a question is outstanding */
const ANSWER_POLL_MS = 30_000;

const PENDING_TEXT = "Forwarded to your broker.";
const DECLINED_TEXT = "Your broker wasn't able to answer this one.";

function isPendingStatus(status: string | undefined): boolean {
  return status === "pending_broker" || status === "pending_seller" || status === "pending_ai";
}

/** Build the initial chat history (and the set of still-pending ids) from the feed. */
function seedFromFeed(feed: BuyerQuestionFeedItem[], businessName: string) {
  const messages: ChatMessage[] = [{
    id: "welcome",
    role: "system",
    content: `Ask anything about ${businessName}. Answers come from the CIM; anything it doesn't cover goes to your broker.`,
    timestamp: new Date(),
  }];
  const pendingIds: string[] = [];

  for (const q of feed) {
    const asked = new Date(q.createdAt);
    if (q.isPublished) {
      messages.push({
        id: `pq-${q.id}`,
        role: "buyer",
        content: q.question,
        status: "published",
        questionId: q.id,
        origin: q.isMine ? "mine" : "other",
        timestamp: asked,
      });
      messages.push({
        id: `pa-${q.id}`,
        role: "ai",
        content: q.publishedAnswer || q.aiAnswer || "",
        status: "published",
        questionId: q.id,
        timestamp: asked,
      });
      continue;
    }
    if (!q.isMine) continue;

    // The buyer's own unanswered question — keep it in the thread with its
    // waiting state so it doesn't silently vanish on reload.
    messages.push({
      id: `pq-${q.id}`,
      role: "buyer",
      content: q.question,
      questionId: q.id,
      origin: "mine",
      timestamp: asked,
    });
    const declined = q.status === "declined";
    messages.push({
      id: `ps-${q.id}`,
      role: "system",
      content: declined ? DECLINED_TEXT : PENDING_TEXT,
      status: declined ? "declined" : "pending_broker",
      questionId: q.id,
      timestamp: asked,
    });
    if (!declined) pendingIds.push(q.id);
  }

  return { messages, pendingIds };
}

export function BuyerChatbot({
  dealId,
  buyerAccessId,
  accessToken,
  businessName,
  questionFeed,
}: BuyerChatbotProps) {
  const { toast } = useToast();
  const [isOpen, setIsOpen] = useState(false);
  const [input, setInput] = useState("");
  const [seed] = useState(() => seedFromFeed(questionFeed, businessName));
  const [messages, setMessages] = useState<ChatMessage[]>(seed.messages);
  const [unreadCount, setUnreadCount] = useState(0);
  // Question ids still waiting on the broker — drives the answer poll
  const [pendingIds, setPendingIds] = useState<string[]>(seed.pendingIds);

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
        origin: "mine",
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, buyerMsg]);
      setInput("");
    },
    onSuccess: (data) => {
      const pending = isPendingStatus(data.status);
      const aiMsg: ChatMessage = {
        id: `a-${data.id}`,
        role: data.status === "published" ? "ai" : "system",
        content: pending ? PENDING_TEXT : data.message,
        status: data.status,
        questionId: data.id,
        timestamp: new Date(),
      };
      setMessages(prev => [...prev, aiMsg]);
      if (pending) {
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
  const answerPoll = useQuery<BuyerQuestionFeedItem[]>({
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
    const feed = answerPoll.data;
    if (!feed || pendingIds.length === 0) return;
    const answered = feed.filter(
      q => pendingIds.includes(q.id) && q.isPublished && (q.publishedAnswer || q.aiAnswer),
    );
    const declined = feed.filter(q => pendingIds.includes(q.id) && q.status === "declined");
    if (answered.length === 0 && declined.length === 0) return;

    setMessages(prev => {
      const next = prev.map(m => {
        if (!m.questionId || m.status === "published") return m;
        if (answered.some(a => a.id === m.questionId)) return { ...m, status: "answered" as const };
        if (m.role === "system" && declined.some(d => d.id === m.questionId)) {
          return { ...m, status: "declined" as const, content: DECLINED_TEXT };
        }
        return m;
      });
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
    const resolved = new Set([...answered, ...declined].map(q => q.id));
    setPendingIds(prev => prev.filter(id => !resolved.has(id)));
    if (!isOpen && answered.length > 0) setUnreadCount(prev => prev + answered.length);
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

  // Header counts: answers from other buyers vs. this buyer's open questions
  const othersAnswered = questionFeed.filter(q => q.isPublished && !q.isMine).length;
  const awaitingCount = pendingIds.length;

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

          {/* Feed summary — labelled by ownership */}
          {(othersAnswered > 0 || awaitingCount > 0) && (
            <div className="px-4 py-2 border-b border-border bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-1" data-testid="chat-feed-summary">
              {othersAnswered > 0 && (
                <span className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] h-5">
                    {othersAnswered} {othersAnswered === 1 ? "answer" : "answers"}
                  </Badge>
                  <span className="text-[10px] text-muted-foreground">from other buyers</span>
                </span>
              )}
              {awaitingCount > 0 && (
                <span className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] h-5 border-teal/30 text-teal">
                    {awaitingCount} awaiting your broker
                  </Badge>
                </span>
              )}
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

                {/* Bubble (+ ownership caption for other buyers' questions) */}
                <div className={`max-w-[85%] flex flex-col ${msg.role === "buyer" ? "items-end" : "items-start"}`}>
                  {msg.role === "buyer" && msg.origin === "other" && (
                    <span className="text-[10px] text-muted-foreground/70 mb-0.5 px-1">Another buyer asked</span>
                  )}
                  <div className={`rounded-xl px-3 py-2 text-sm leading-relaxed ${
                    msg.role === "buyer"
                      ? msg.origin === "other"
                        ? "bg-muted text-foreground rounded-br-sm"
                        : "bg-teal text-teal-foreground rounded-br-sm"
                      : msg.role === "ai"
                      ? "bg-card border border-border rounded-bl-sm"
                      : "bg-muted/50 text-muted-foreground text-xs italic rounded-bl-sm"
                  }`}>
                    {msg.content}
                    {(msg.status === "pending_broker" || msg.status === "pending_seller") && (
                      <div className="mt-1.5 flex items-center gap-1 text-[10px] not-italic opacity-80" data-testid="chat-awaiting-broker">
                        <Clock className="h-2.5 w-2.5" />
                        {answerPoll.isError
                          ? "Awaiting your broker — couldn't check just now, will retry"
                          : "Awaiting your broker — the answer appears here when ready"}
                      </div>
                    )}
                    {msg.status === "answered" && (
                      <div className="mt-1.5 flex items-center gap-1 text-[10px] not-italic opacity-80">
                        <CheckCircle2 className="h-2.5 w-2.5" />
                        Answered — see below
                      </div>
                    )}
                  </div>
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
