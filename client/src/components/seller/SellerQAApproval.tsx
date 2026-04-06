/**
 * SellerQAApproval — Seller reviews broker-drafted answers to buyer questions.
 *
 * Seller can approve (publishes to buyer), revise (edits then approves),
 * or reject (sends back to broker). No buyer-facing answer goes live
 * without seller sign-off.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { BuyerQuestion } from "@shared/schema";
import {
  CheckCircle2, XCircle, Loader2, MessageCircle,
  Edit3, ChevronDown, ChevronRight,
} from "lucide-react";

interface SellerQAApprovalProps {
  dealId: string;
}

export function SellerQAApproval({ dealId }: SellerQAApprovalProps) {
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [revisions, setRevisions] = useState<Record<string, string>>({});
  const [editingId, setEditingId] = useState<string | null>(null);

  const { data: questions = [], isLoading } = useQuery<BuyerQuestion[]>({
    queryKey: ["/api/deals", dealId, "questions", "pending-seller"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/questions/pending-seller`);
      if (!r.ok) return [];
      return r.json();
    },
  });

  const approve = useMutation({
    mutationFn: async ({ id, revision }: { id: string; revision?: string }) => {
      const r = await fetch(`/api/questions/${id}/seller-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true, revision }),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "questions"] });
      toast({ title: "Answer approved and published to buyer" });
      setEditingId(null);
    },
    onError: () => toast({ title: "Failed to approve", variant: "destructive" }),
  });

  const reject = useMutation({
    mutationFn: async (id: string) => {
      const r = await fetch(`/api/questions/${id}/seller-approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: false }),
      });
      if (!r.ok) throw new Error("Failed");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "questions"] });
      toast({ title: "Sent back to broker for revision" });
    },
    onError: () => toast({ title: "Failed", variant: "destructive" }),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (questions.length === 0) {
    return (
      <div className="text-center py-6 space-y-2">
        <CheckCircle2 className="h-6 w-6 text-emerald-400 mx-auto" />
        <p className="text-sm text-muted-foreground">No answers waiting for your approval</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <MessageCircle className="h-4 w-4 text-blue-400" />
        <h3 className="text-sm font-semibold">Buyer Questions — Your Approval Needed</h3>
        <Badge className="bg-blue-500/10 text-blue-400 border-0 text-[10px]">
          {questions.length} pending
        </Badge>
      </div>

      <p className="text-xs text-muted-foreground">
        Your broker has drafted answers to buyer questions. Review each one — no answer goes
        to the buyer without your approval.
      </p>

      {questions.map((q) => {
        const isExpanded = expandedId === q.id;
        const isEditing = editingId === q.id;

        return (
          <Card key={q.id} className="bg-card/50 border-blue-500/20">
            <CardContent className="py-3 px-4">
              <div
                className="flex items-start justify-between cursor-pointer gap-2"
                onClick={() => setExpandedId(isExpanded ? null : q.id)}
              >
                <div className="flex items-start gap-2">
                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />
                    : <ChevronRight className="h-3.5 w-3.5 mt-0.5 text-muted-foreground shrink-0" />}
                  <p className="text-sm font-medium">{q.question}</p>
                </div>
              </div>

              {isExpanded && (
                <div className="mt-3 pl-5 space-y-3">
                  {/* Broker's draft */}
                  <div className="rounded bg-muted/30 p-3">
                    <p className="text-[10px] text-muted-foreground font-medium mb-1">Broker's proposed answer:</p>
                    {isEditing ? (
                      <Textarea
                        className="text-xs resize-none bg-background mt-1"
                        value={revisions[q.id] ?? q.brokerDraft ?? ""}
                        onChange={(e) => setRevisions({ ...revisions, [q.id]: e.target.value })}
                        rows={4}
                      />
                    ) : (
                      <p className="text-xs">{q.brokerDraft || q.aiAnswer || "—"}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      className="h-7 text-xs gap-1 bg-emerald-600 text-white hover:bg-emerald-700"
                      onClick={() => {
                        const revision = isEditing ? revisions[q.id] : undefined;
                        approve.mutate({ id: q.id, revision });
                      }}
                      disabled={approve.isPending}
                    >
                      <CheckCircle2 className="h-3 w-3" />
                      {isEditing ? "Approve revised answer" : "Approve & publish"}
                    </Button>
                    {!isEditing && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingId(q.id);
                          setRevisions({ ...revisions, [q.id]: q.brokerDraft || q.aiAnswer || "" });
                        }}
                      >
                        <Edit3 className="h-3 w-3" /> Edit before approving
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-xs gap-1 text-red-400 hover:text-red-500"
                      onClick={() => reject.mutate(q.id)}
                      disabled={reject.isPending}
                    >
                      <XCircle className="h-3 w-3" /> Send back to broker
                    </Button>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
