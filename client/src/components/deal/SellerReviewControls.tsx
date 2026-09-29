/**
 * The seller's approval of the CIM, from the broker's side.
 *
 * "Send to seller for review" emails each seller their own link to
 * /seller/:token/review, where they read the CIM and approve it or ask for
 * changes. "Approve on the seller's behalf" stays for sellers who reviewed
 * it outside Cimple — an explicit, confirmed override, never the default.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2, MailCheck, Send, UserCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface ReviewStatus {
  stage: "not_ready" | "content" | "design" | "waiting" | "approved";
  lastSentAt: string | null;
  lastSentStage: string | null;
  changeRequests: { id: string; title: string; note: string; at: string }[];
}

/** apiRequest's "409: {"error":"…"}" → the server's sentence. */
export function apiErrorText(e: unknown): string {
  const raw = e instanceof Error ? e.message.replace(/^\d{3}:\s*/, "") : String(e);
  try {
    const body = JSON.parse(raw);
    if (body && typeof body.error === "string") return body.error;
  } catch {
    /* not JSON */
  }
  return raw;
}

export function sellerReviewKey(dealId: string) {
  return ["/api/deals", dealId, "seller-review"] as const;
}

export function SellerReviewControls({
  dealId,
  stage,
  onApproveOnBehalf,
  approving,
  disabled,
  disabledReason,
}: {
  dealId: string;
  stage: "content" | "design";
  onApproveOnBehalf: () => void;
  approving?: boolean;
  disabled?: boolean;
  disabledReason?: string | null;
}) {
  const { toast } = useToast();
  const [confirm, setConfirm] = useState(false);
  const { data } = useQuery<ReviewStatus>({
    queryKey: sellerReviewKey(dealId),
    queryFn: async () => (await apiRequest("GET", `/api/deals/${dealId}/seller-review`)).json(),
  });
  const send = useMutation({
    mutationFn: async () =>
      (await apiRequest("POST", `/api/deals/${dealId}/seller-review/send`)).json() as Promise<{ recipients: number; emailsSent: number }>,
    onSuccess: (r) => {
      queryClient.invalidateQueries({ queryKey: sellerReviewKey(dealId) });
      toast(
        r.recipients === 0
          ? {
              title: "Nobody to send it to",
              description: "The seller has no emailed invite yet. Invite them from Phase 1 (or add them to the seller team), then send it again.",
              variant: "destructive",
            }
          : {
              title: "Sent to the seller",
              description: r.emailsSent > 0
                ? `Emailed ${r.emailsSent === 1 ? "the seller" : `${r.emailsSent} people`} a link to read and approve the CIM.`
                : "Their review link is ready (email isn't set up here, so nothing was emailed).",
            },
      );
    },
    onError: (e: Error) => toast({ title: "Couldn't send it", description: apiErrorText(e), variant: "destructive" }),
  });

  const sentForThisStage = !!data?.lastSentAt && data.lastSentStage === stage;
  const requests = data?.changeRequests.length ?? 0;
  return (
    <>
      {requests > 0 && (
        <span className="text-[11px] text-amber-500" data-testid="text-seller-change-requests">
          Seller asked for changes ({requests}) — see Open items
        </span>
      )}
      {sentForThisStage && requests === 0 && (
        <span className="text-[11px] text-muted-foreground flex items-center gap-1" data-testid="text-seller-review-sent">
          <MailCheck className="h-3 w-3" /> Sent {new Date(data!.lastSentAt!).toLocaleDateString()} · waiting on the seller
        </span>
      )}
      <Button
        size="sm"
        className="h-8 text-xs gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90"
        onClick={() => send.mutate()}
        disabled={send.isPending || disabled}
        title={disabledReason ?? undefined}
        data-testid={`button-send-seller-review-${stage}`}
      >
        {send.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        {sentForThisStage ? "Send again" : "Send to seller for review"}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-8 text-xs gap-1.5 text-muted-foreground"
        onClick={() => setConfirm(true)}
        disabled={approving || disabled}
        title={disabledReason ?? undefined}
        data-testid={`button-${stage}-approve-seller`}
      >
        <UserCheck className="h-3.5 w-3.5" /> Approve on the seller's behalf
      </Button>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Approve on the seller's behalf?</AlertDialogTitle>
            <AlertDialogDescription>
              Only if the seller has read the CIM {stage === "design" ? "design " : ""}and approved it with you outside
              Cimple. It's recorded as the seller's approval — they won't be asked to review it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirm(false);
                onApproveOnBehalf();
              }}
              data-testid={`button-confirm-${stage}-approve-seller`}
            >
              The seller approved it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
