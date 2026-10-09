/**
 * TeaserSellerCheck — the seller line on the Teaser tab and its dialog.
 *   "Seller: not checked yet [Ask the seller to check it]"
 *   "Sent to the seller Oct 8 — waiting [Send again]"
 *   "Seller approved Oct 9"
 *   "Seller approved an earlier version — you've changed it since [Send again]"
 *   "Seller asked for changes: '…' [Open it]"
 * The broker sends it (the seller's review page shows it); nothing goes to
 * buyers until the broker publishes.
 */
import { useState } from "react";
import { CheckCircle2, Clock, Loader2, MessageSquareText, UserCheck } from "lucide-react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { shortDay, type TeaserState } from "./api";
import type { TeaserApi } from "./useTeaser";

export function sellerLineText(seller: TeaserState["summary"]["seller"]): string {
  switch (seller.state) {
    case "sent": return `Sent to the seller ${shortDay(seller.at)} — waiting`;
    case "approved": return `Seller approved ${shortDay(seller.at)}`;
    case "approved_earlier": return "Seller approved an earlier version — you've changed it since";
    case "changes_requested": return `Seller asked for changes${seller.note ? `: “${seller.note}”` : ""}`;
    default: return "Seller: not checked yet";
  }
}

export function TeaserSellerCheck({ dealId, api, state, onOpenEditor, className }: { dealId: string; api: TeaserApi; state: TeaserState; onOpenEditor?: () => void; className?: string }) {
  const [, navigate] = useLocation();
  const [confirm, setConfirm] = useState(false);
  const seller = state.summary.seller;
  const owner = state.sellerOwner;
  const Icon = seller.state === "approved" ? CheckCircle2 : seller.state === "changes_requested" ? MessageSquareText : seller.state === "sent" ? Clock : UserCheck;
  const tone = seller.state === "approved" ? "text-success" : seller.state === "changes_requested" ? "text-blue-400" : seller.state === "approved_earlier" ? "text-amber-500" : "text-muted-foreground";
  const action = seller.state === "none" ? "Ask the seller to check it"
    : seller.state === "sent" || seller.state === "approved_earlier" ? "Send again"
    : seller.state === "changes_requested" ? "Open it"
    : null;
  return (
    <div className={cn("flex flex-wrap items-center justify-between gap-2", className)} data-testid="teaser-seller-line">
      <p className={cn("flex min-w-0 items-start gap-1.5 text-xs", tone)}>
        <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span className="break-words">{sellerLineText(seller)}</span>
      </p>
      {action && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 shrink-0 text-xs"
          disabled={(!owner && action !== "Open it") || api.sellerCheck.isPending}
          title={!owner && action !== "Open it" ? "Add the seller on the Team tab first." : undefined}
          onClick={() => (action === "Open it" ? onOpenEditor?.() : setConfirm(true))}
          data-testid="button-teaser-seller-check"
        >
          {api.sellerCheck.isPending && <Loader2 className="mr-1 h-3 w-3 animate-spin" />} {action}
        </Button>
      )}
      {!owner && seller.state === "none" && (
        <p className="basis-full text-[11px] text-muted-foreground">
          Add the seller on the Team tab first.{" "}
          <button type="button" className="text-teal hover:underline" onClick={() => navigate(`/deal/${dealId}/team`)}>Go to the Team tab</button>
        </p>
      )}
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send the teaser draft to {owner ?? "the seller"} to check?</AlertDialogTitle>
            <AlertDialogDescription>
              They'll see it on their review page and can approve it or ask for changes. Nothing goes to buyers until you publish.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => api.sellerCheck.mutate()} data-testid="button-confirm-teaser-seller-check">
              Send it
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
