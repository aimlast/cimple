/**
 * SellerApprovalPage — Standalone page for seller to approve/reject
 * a buyer Q&A answer via a unique token link.
 *
 * No login required — the token IS the auth. The seller clicks the link
 * the broker shares, reviews the question + drafted answer, and
 * approves/edits/rejects. One page, one action, done.
 */
import { useState } from "react";
import { useParams } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import {
  CheckCircle2, XCircle, Edit3, Loader2, AlertCircle,
  MessageCircle, Building, ShieldCheck,
} from "lucide-react";

interface ApprovalData {
  question: {
    id: string;
    question: string;
    brokerDraft: string | null;
    aiAnswer: string | null;
    status: string;
  };
  businessName: string;
}

export default function SellerApprovalPage() {
  const { token } = useParams<{ token: string }>();
  const [editing, setEditing] = useState(false);
  const [revision, setRevision] = useState("");
  const [done, setDone] = useState<"approved" | "rejected" | null>(null);

  const { data, isLoading, error } = useQuery<ApprovalData>({
    queryKey: ["/api/approve", token],
    enabled: !!token,
    queryFn: async () => {
      const res = await fetch(`/api/approve/${token}`);
      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || "Invalid link");
      }
      return res.json();
    },
  });

  const submit = useMutation({
    mutationFn: async ({ approved, rev }: { approved: boolean; rev?: string }) => {
      const res = await fetch(`/api/approve/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved, revision: rev }),
      });
      if (!res.ok) throw new Error("Failed");
      return res.json();
    },
    onSuccess: (_, vars) => {
      setDone(vars.approved ? "approved" : "rejected");
    },
  });

  // Loading
  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Error / invalid token
  if (error || !data) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3">
          <AlertCircle className="h-8 w-8 mx-auto text-destructive/60" />
          <h2 className="text-lg font-semibold">Invalid approval link</h2>
          <p className="text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "This link is invalid or has expired."}
          </p>
        </div>
      </div>
    );
  }

  // Already processed
  if (data.question.status !== "pending_seller") {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3">
          <CheckCircle2 className="h-8 w-8 mx-auto text-emerald-400" />
          <h2 className="text-lg font-semibold">Already processed</h2>
          <p className="text-sm text-muted-foreground">
            This answer has already been reviewed. No further action needed.
          </p>
        </div>
      </div>
    );
  }

  // Done state
  if (done) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-6">
        <div className="max-w-sm text-center space-y-3">
          {done === "approved" ? (
            <>
              <CheckCircle2 className="h-10 w-10 mx-auto text-emerald-400" />
              <h2 className="text-lg font-semibold">Answer approved</h2>
              <p className="text-sm text-muted-foreground">
                The answer has been published and the buyer can now see it. Thank you!
              </p>
            </>
          ) : (
            <>
              <XCircle className="h-10 w-10 mx-auto text-amber-400" />
              <h2 className="text-lg font-semibold">Sent back to broker</h2>
              <p className="text-sm text-muted-foreground">
                Your broker will revise the answer and send it back for your review.
              </p>
            </>
          )}
        </div>
      </div>
    );
  }

  const draftAnswer = data.question.brokerDraft || data.question.aiAnswer || "";

  return (
    <div className="min-h-screen bg-background flex items-center justify-center p-4">
      <div className="max-w-lg w-full space-y-6">
        {/* Header */}
        <div className="text-center space-y-2">
          <div className="h-12 w-12 rounded-xl bg-teal/10 flex items-center justify-center mx-auto">
            <ShieldCheck className="h-6 w-6 text-teal" />
          </div>
          <h1 className="text-xl font-semibold">Approve buyer Q&A</h1>
          <p className="text-sm text-muted-foreground flex items-center justify-center gap-1.5">
            <Building className="h-3.5 w-3.5" />
            {data.businessName}
          </p>
        </div>

        {/* Question */}
        <Card className="border-border">
          <CardContent className="pt-5 space-y-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                <MessageCircle className="h-3 w-3" /> Buyer asked
              </p>
              <p className="text-sm font-medium">{data.question.question}</p>
            </div>

            <div className="border-t border-border pt-4">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Proposed answer
              </p>
              {editing ? (
                <Textarea
                  value={revision}
                  onChange={(e) => setRevision(e.target.value)}
                  className="text-sm min-h-[100px] resize-none"
                  placeholder="Edit the answer..."
                />
              ) : (
                <p className="text-sm text-foreground/90 leading-relaxed bg-muted/30 rounded-lg p-3">
                  {draftAnswer}
                </p>
              )}
            </div>

            {/* Actions */}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button
                className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700 gap-1.5"
                onClick={() => submit.mutate({
                  approved: true,
                  rev: editing ? revision : undefined,
                })}
                disabled={submit.isPending || (editing && !revision.trim())}
              >
                {submit.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-4 w-4" />
                )}
                {editing ? "Approve revised answer" : "Approve & publish"}
              </Button>

              {!editing && (
                <Button
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => {
                    setEditing(true);
                    setRevision(draftAnswer);
                  }}
                >
                  <Edit3 className="h-4 w-4" /> Edit
                </Button>
              )}

              <Button
                variant="outline"
                className="gap-1.5 text-red-400 hover:text-red-500 hover:border-red-500/30"
                onClick={() => submit.mutate({ approved: false })}
                disabled={submit.isPending}
              >
                <XCircle className="h-4 w-4" /> Send back
              </Button>
            </div>

            <p className="text-[10px] text-muted-foreground text-center">
              No answer goes to the buyer without your approval.
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
