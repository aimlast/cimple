/**
 * BuyerQAPanel — Broker-facing panel for managing buyer questions.
 *
 * Shows all questions grouped by status (pending broker, pending seller, published).
 * Broker can draft answers, send to seller for approval, or publish directly.
 * Shows analytics on what buyers are asking about.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PanelError } from "@/components/deal/PanelError";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { BuyerQuestion } from "@shared/schema";
import {
  MessageCircle, Clock, CheckCircle2, AlertCircle,
  Send, ChevronDown, ChevronRight, Bot, User,
  XCircle, Loader2, Copy, Link2, Undo2,
} from "lucide-react";

interface BuyerQAPanelProps {
  dealId: string;
}

const STATUS_CONFIG = {
  pending_broker: { label: "Needs your response", color: "bg-amber-500/10 text-amber-400 border-0", icon: Clock },
  pending_seller: { label: "Awaiting seller approval", color: "bg-blue-500/10 text-blue-400 border-0", icon: Clock },
  published: { label: "Published", color: "bg-emerald-500/10 text-emerald-400 border-0", icon: CheckCircle2 },
  declined: { label: "Declined", color: "bg-red-500/10 text-red-400 border-0", icon: XCircle },
  pending_ai: { label: "Processing", color: "bg-muted text-muted-foreground border-0", icon: Bot },
};

/** Read the server's JSON error body, falling back to a readable default. */
async function readError(res: Response, fallback: string): Promise<string> {
  const body = await res.json().catch(() => null);
  return (body && typeof body.error === "string" && body.error) || fallback;
}

/**
 * Clipboard writes reject when the document isn't focused or the context
 * isn't secure. Returns whether the copy actually succeeded so callers can
 * show the link itself as a fallback instead of a false "copied" toast.
 */
async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * A question that is back with the broker but already carries a broker draft
 * was sent back by the seller — brokerDraft is only ever set on the
 * send-to-seller transition, so a fresh escalation never has one.
 */
function wasSentBackBySeller(q: BuyerQuestion): boolean {
  return q.status === "pending_broker" && !!q.brokerDraft && q.sellerApproved === false;
}

type ConfirmAction =
  | { kind: "decline"; q: BuyerQuestion }
  | { kind: "publish"; q: BuyerQuestion };

export function BuyerQAPanel({ dealId }: BuyerQAPanelProps) {
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [confirm, setConfirm] = useState<ConfirmAction | null>(null);

  const { data: questions = [], isLoading, error: loadError, refetch } = useQuery<BuyerQuestion[]>({
    queryKey: ["/api/deals", dealId, "questions"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/questions`);
      if (!r.ok) throw new Error(await readError(r, "Failed to load buyer questions"));
      return r.json();
    },
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "questions"] });

  const updateQuestion = useMutation({
    mutationFn: async ({ id, updates }: { id: string; updates: Record<string, any> }) => {
      const r = await fetch(`/api/questions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updates),
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r, "Failed to update question"));
      return r.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Question updated" });
    },
    onError: (e: Error) => toast({ title: "Couldn't update question", description: e.message, variant: "destructive" }),
  });

  // Publishing on the seller's behalf (after an offline OK) goes through the
  // seller-approve endpoint so the record carries sellerApproved /
  // sellerApprovedAt / addedToKnowledgeBase — a real audit trail, not a
  // unilateral publish dressed up as approval.
  const publishAsSellerApproved = useMutation({
    mutationFn: async ({ id, answer }: { id: string; answer: string }) => {
      const r = await fetch(`/api/questions/${id}/seller-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, revision: answer }),
        credentials: "include",
      });
      if (!r.ok) throw new Error(await readError(r, "Failed to publish answer"));
      return r.json();
    },
    onSuccess: () => {
      invalidate();
      toast({ title: "Answer published", description: "Recorded as seller-approved and added to the knowledge base." });
    },
    onError: (e: Error) => toast({ title: "Couldn't publish answer", description: e.message, variant: "destructive" }),
  });

  const copyApprovalLink = async (link: string, title: string) => {
    const ok = await copyToClipboard(link);
    if (ok) {
      toast({ title, description: "Approval link copied to clipboard — share it with the seller." });
    } else {
      toast({
        title: "Couldn't copy automatically",
        description: `Copy this link manually and share it with the seller: ${link}`,
        duration: 15000,
      });
    }
  };

  // Group by status
  const pendingBroker = questions.filter(q => q.status === "pending_broker");
  const pendingSeller = questions.filter(q => q.status === "pending_seller");
  const published = questions.filter(q => q.status === "published");
  const declined = questions.filter(q => q.status === "declined");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return <PanelError what="buyer questions" onRetry={() => refetch()} />;
  }

  if (questions.length === 0) {
    return (
      <Card className="bg-card/50 border-border/50">
        <CardContent className="py-8 text-center space-y-2">
          <MessageCircle className="h-8 w-8 text-muted-foreground/30 mx-auto" />
          <p className="text-sm font-medium">No buyer questions yet</p>
          <p className="text-xs text-muted-foreground max-w-sm mx-auto">
            When buyers ask questions about the CIM, they'll appear here for your review.
          </p>
        </CardContent>
      </Card>
    );
  }

  const renderQuestion = (q: BuyerQuestion) => {
    const isExpanded = expandedId === q.id;
    const config = STATUS_CONFIG[q.status as keyof typeof STATUS_CONFIG] || STATUS_CONFIG.pending_ai;
    const Icon = config.icon;
    const sentBack = wasSentBackBySeller(q);
    // The broker's last draft is what they revise — never the stale AI answer.
    const draftValue = drafts[q.id] ?? q.brokerDraft ?? q.aiAnswer ?? "";
    const busy = updateQuestion.isPending || publishAsSellerApproved.isPending;

    return (
      <Card key={q.id} className={`bg-card/50 border-border/50 ${q.status === "pending_broker" ? "border-amber-500/30" : ""}`}>
        <CardContent className="py-3 px-4">
          {/* Header */}
          <div
            className="flex items-start justify-between cursor-pointer gap-2"
            onClick={() => setExpandedId(isExpanded ? null : q.id)}
          >
            <div className="flex items-start gap-2 flex-1 min-w-0">
              {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />}
              <div className="min-w-0">
                <p className="text-sm font-medium truncate">{q.question}</p>
                <p className="text-[10px] text-muted-foreground mt-0.5">
                  {new Date(q.createdAt).toLocaleDateString()}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {sentBack && (
                <Badge className="bg-red-500/10 text-red-400 border-0 text-[10px]">
                  <Undo2 className="h-2.5 w-2.5 mr-1" />
                  Sent back by seller
                </Badge>
              )}
              <Badge className={`${config.color} text-[10px]`}>
                <Icon className="h-2.5 w-2.5 mr-1" />
                {config.label}
              </Badge>
            </div>
          </div>

          {/* Expanded details */}
          {isExpanded && (
            <div className="mt-3 pl-5 space-y-3">
              {sentBack && (
                <div className="rounded bg-red-500/5 border border-red-500/20 p-2.5 flex items-start gap-2">
                  <AlertCircle className="h-3 w-3 text-red-400 mt-0.5 shrink-0" />
                  <p className="text-xs text-muted-foreground">
                    The seller reviewed your draft and sent it back. Revise it below and resend for approval.
                  </p>
                </div>
              )}

              {/* AI answer if exists */}
              {q.aiAnswer && (
                <div className="rounded bg-muted/30 p-2.5">
                  <p className="text-[10px] text-muted-foreground font-medium mb-1 flex items-center gap-1">
                    <Bot className="h-2.5 w-2.5" /> AI Answer
                  </p>
                  <p className="text-xs">{q.aiAnswer}</p>
                </div>
              )}

              {/* Published answer */}
              {q.publishedAnswer && q.status === "published" && (
                <div className="rounded bg-emerald-500/5 border border-emerald-500/20 p-2.5">
                  <p className="text-[10px] text-emerald-400 font-medium mb-1 flex items-center gap-1">
                    <CheckCircle2 className="h-2.5 w-2.5" /> Published Answer
                  </p>
                  <p className="text-xs">{q.publishedAnswer}</p>
                </div>
              )}

              {/* Broker actions for pending questions */}
              {q.status === "pending_broker" && (
                <div className="space-y-2">
                  <Textarea
                    placeholder="Draft your answer..."
                    className="text-xs h-20 resize-none bg-muted/20"
                    value={draftValue}
                    onChange={(e) => setDrafts({ ...drafts, [q.id]: e.target.value })}
                  />
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1 bg-teal text-teal-foreground hover:bg-teal/90"
                      onClick={async () => {
                        let result: any;
                        try {
                          result = await updateQuestion.mutateAsync({
                            id: q.id,
                            updates: {
                              brokerDraft: draftValue.trim(),
                              status: "pending_seller",
                            },
                          });
                        } catch {
                          return; // onError already surfaced the toast
                        }
                        if (result?.approvalLink) {
                          const link = `${window.location.origin}${result.approvalLink}`;
                          await copyApprovalLink(link, "Sent to seller");
                        }
                      }}
                      disabled={busy || !draftValue.trim()}
                    >
                      <Send className="h-3 w-3" /> {sentBack ? "Resend to seller" : "Send to seller for approval"}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1"
                      onClick={() => setConfirm({ kind: "decline", q })}
                      disabled={busy}
                    >
                      <XCircle className="h-3 w-3" /> Decline
                    </Button>
                  </div>
                </div>
              )}

              {/* Pending seller - show what was sent + approval link */}
              {q.status === "pending_seller" && (
                <div className="space-y-2">
                  {q.brokerDraft && (
                    <div className="rounded bg-blue-500/5 border border-blue-500/20 p-2.5">
                      <p className="text-[10px] text-blue-400 font-medium mb-1 flex items-center gap-1">
                        <User className="h-2.5 w-2.5" /> Your draft (awaiting seller)
                      </p>
                      <p className="text-xs">{q.brokerDraft}</p>
                    </div>
                  )}

                  {/* Approval link for seller */}
                  {q.sellerApprovalToken && (
                    <div className="flex items-center gap-2 rounded bg-muted/30 px-2.5 py-2">
                      <Link2 className="h-3 w-3 text-muted-foreground shrink-0" />
                      <span className="text-[10px] text-muted-foreground flex-1 truncate" title={`${window.location.origin}/approve/${q.sellerApprovalToken}`}>
                        Seller approval link ready
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 text-[10px] gap-1 px-2"
                        onClick={() => {
                          const link = `${window.location.origin}/approve/${q.sellerApprovalToken}`;
                          void copyApprovalLink(link, "Link copied");
                        }}
                      >
                        <Copy className="h-2.5 w-2.5" /> Copy link
                      </Button>
                    </div>
                  )}

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1 bg-emerald-600 text-white hover:bg-emerald-700"
                      onClick={() => setConfirm({ kind: "publish", q })}
                      disabled={busy || !(q.brokerDraft || q.aiAnswer)}
                    >
                      <CheckCircle2 className="h-3 w-3" /> Publish (seller approved)
                    </Button>
                  </div>
                </div>
              )}

              {/* Knowledge base indicator */}
              {q.addedToKnowledgeBase && (
                <p className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <CheckCircle2 className="h-2.5 w-2.5 text-emerald-400" />
                  Added to knowledge base — future similar questions answered instantly
                </p>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold flex items-center gap-2">
          <MessageCircle className="h-4 w-4" />
          Buyer Questions
        </h3>
        <div className="flex items-center gap-2">
          {pendingBroker.length > 0 && (
            <Badge className="bg-amber-500/10 text-amber-400 border-0 text-[10px]">
              {pendingBroker.length} need response
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            {published.length}/{questions.length} published
          </span>
        </div>
      </div>

      {/* Pending broker — most urgent */}
      {pendingBroker.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-400">Needs your response</p>
          {pendingBroker.map(renderQuestion)}
        </div>
      )}

      {/* Pending seller */}
      {pendingSeller.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-blue-400">Awaiting seller</p>
          {pendingSeller.map(renderQuestion)}
        </div>
      )}

      {/* Published */}
      {published.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">Published</p>
          {published.map(renderQuestion)}
        </div>
      )}

      {/* Declined */}
      {declined.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Declined</p>
          {declined.map(renderQuestion)}
        </div>
      )}

      {/* Confirmations — declining hides the question from the workflow;
          publishing on the seller's behalf writes a seller-approval record. */}
      <AlertDialog open={!!confirm} onOpenChange={(open) => { if (!open) setConfirm(null); }}>
        <AlertDialogContent>
          {confirm?.kind === "decline" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Decline this question?</AlertDialogTitle>
                <AlertDialogDescription>
                  The buyer will not receive an answer and the question moves to Declined.
                  This cannot be undone from here.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={updateQuestion.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  disabled={updateQuestion.isPending}
                  onClick={(e) => {
                    e.preventDefault();
                    const q = confirm.q;
                    updateQuestion.mutate(
                      { id: q.id, updates: { status: "declined" } },
                      { onSettled: () => setConfirm(null) },
                    );
                  }}
                >
                  {updateQuestion.isPending ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Declining…</>
                  ) : (
                    <><XCircle className="h-3 w-3 mr-1" />Decline</>
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
          {confirm?.kind === "publish" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>Publish as seller-approved?</AlertDialogTitle>
                <AlertDialogDescription>
                  Only do this if the seller has already approved this answer outside Cimple
                  (by phone or email). The answer goes live to the buyer immediately and is
                  recorded as seller-approved with today's timestamp.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel disabled={publishAsSellerApproved.isPending}>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-emerald-600 text-white hover:bg-emerald-700"
                  disabled={publishAsSellerApproved.isPending}
                  onClick={(e) => {
                    e.preventDefault();
                    const q = confirm.q;
                    publishAsSellerApproved.mutate(
                      { id: q.id, answer: q.brokerDraft || q.aiAnswer || "" },
                      { onSettled: () => setConfirm(null) },
                    );
                  }}
                >
                  {publishAsSellerApproved.isPending ? (
                    <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Publishing…</>
                  ) : (
                    <><CheckCircle2 className="h-3 w-3 mr-1" />Publish</>
                  )}
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
