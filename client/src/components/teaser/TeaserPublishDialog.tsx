/**
 * Publishing the teaser: the button (Publish teaser / Publish changes /
 * Publish again) and its confirmation. The confirmation lists anything that
 * may let someone recognise the business and the seller's check; when the
 * confidentiality check couldn't run, the broker ticks "I've checked it"
 * (or tries the check again). The server's refusals are listed in place.
 */
import { useState } from "react";
import { AlertTriangle, Globe, Loader2, RotateCcw, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { cn } from "@/lib/utils";
import { TeaserApiError, type TeaserState } from "./api";
import type { TeaserApi } from "./useTeaser";
import { blockName, heldBlocks, pinpointBlocks } from "./draft-view";
import { sellerLineText } from "./TeaserSellerCheck";

/** What the publish button says and whether it can be pressed. */
export function publishButtonState(state: TeaserState): { label: string; disabled: boolean; why: string | null } {
  const t = state.teaser;
  const s = state.summary;
  const held = heldBlocks(t.draft, t.checks).length;
  const writing = t.generation?.status === "running";
  const label = s.status === "offline" ? "Publish again" : t.hasPublished ? "Publish changes" : "Publish teaser";
  if (writing) return { label, disabled: true, why: "Cimple is writing your teaser — wait a moment." };
  if (held > 0) return { label, disabled: true, why: `Fix the ${held === 1 ? "1 block" : `${held} blocks`} that ${held === 1 ? "names" : "name"} the business first.` };
  if (t.headerProblem) return { label, disabled: true, why: "Fix the header first — it names the business." };
  if (t.codenameProblem) return { label, disabled: true, why: "The codename could point to the business — see the note on the Teaser tab." };
  if (t.draft.blocks.filter((b) => !b.hidden && !b.placeholder).length === 0) return { label, disabled: true, why: "Add a block buyers can read first." };
  if (s.status === "published" && s.changedSincePublish === 0) return { label, disabled: true, why: "Buyers already see this version." };
  return { label, disabled: false, why: null };
}

export function TeaserPublishButton({ api, state, size = "sm", className }: { api: TeaserApi; state: TeaserState; size?: "sm" | "default"; className?: string }) {
  const [open, setOpen] = useState(false);
  const b = publishButtonState(state);
  return (
    <>
      <span title={b.why ?? undefined} className={cn("inline-flex", className)}>
        <Button
          size={size}
          className={cn("gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90", size === "sm" && "h-8 text-xs", className && "w-full")}
          disabled={b.disabled || api.publish.isPending}
          onClick={() => setOpen(true)}
          data-testid="button-publish-teaser"
        >
          {api.publish.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Globe className="h-3.5 w-3.5" />} {b.label}
        </Button>
      </span>
      {open && <TeaserPublishDialog api={api} state={state} onClose={() => setOpen(false)} />}
    </>
  );
}

function TeaserPublishDialog({ api, state, onClose }: { api: TeaserApi; state: TeaserState; onClose: () => void }) {
  const [checked, setChecked] = useState(false);
  const [problems, setProblems] = useState<string[]>([]);
  const t = state.teaser;
  const pin = pinpointBlocks(t.draft, t.checks);
  const reviewNeeded = state.summary.reviewNeeded;
  const seller = state.summary.seller;
  const busy = api.publish.isPending || api.confirmReview.isPending;

  const doPublish = () =>
    api.publish.mutate(undefined, {
      onSuccess: () => onClose(),
      onError: (err) => {
        if (err instanceof TeaserApiError && err.code === "cant_publish") setProblems((err.body?.problems as string[]) ?? [err.message]);
        else onClose();
      },
    });
  const go = () => {
    setProblems([]);
    if (reviewNeeded && checked && !t.reviewConfirmed) {
      api.confirmReview.mutate(undefined, {
        onSuccess: () => doPublish(),
        // review_ok = the check runs now: just publish.
        onError: (err) => { if (err instanceof TeaserApiError && err.code === "review_ok") doPublish(); },
      });
      return;
    }
    doPublish();
  };

  return (
    <AlertDialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <AlertDialogContent className="max-w-lg">
        <AlertDialogHeader>
          <AlertDialogTitle>{t.hasPublished ? "Publish your changes?" : "Publish the teaser?"}</AlertDialogTitle>
          <AlertDialogDescription>
            Buyers you send a teaser link to will see exactly this. You can keep editing — changes reach buyers when you publish them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-3 text-sm">
          {pin.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs" data-testid="publish-pinpoint">
              <p className="font-medium">These may let someone recognise the business:</p>
              <ul className="space-y-1">
                {pin.slice(0, 5).map(({ block, phrases }) => (
                  <li key={block.id} className="flex gap-1.5"><AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-amber-500" /><span><span className="font-medium">{blockName(block)}:</span> {phrases.map((p) => `“${p}”`).join(", ")}</span></li>
                ))}
              </ul>
              <p className="text-muted-foreground">Buyers will see them as written. Reword them first if they're too specific.</p>
            </div>
          )}
          <p className={cn("text-xs", seller.state === "approved" ? "text-success" : "text-muted-foreground")}>
            {seller.state === "none" ? "The seller hasn't checked this teaser. You can publish without it." : sellerLineText(seller)}
            {seller.state === "approved_earlier" || seller.state === "changes_requested" ? " You can still publish." : ""}
          </p>
          {reviewNeeded && !t.reviewConfirmed && (
            <div className="space-y-2 rounded-md border border-border p-3 text-xs">
              <p>The confidentiality check couldn't run, so Cimple can't confirm nothing the seller asked to keep confidential is in this teaser.</p>
              <label className="flex items-start gap-2">
                <Checkbox checked={checked} onCheckedChange={(v) => setChecked(v === true)} className="mt-0.5" data-testid="checkbox-teaser-review-confirm" />
                <span>I've checked it — nothing the seller asked to keep confidential is in it</span>
              </label>
              <button type="button" className="inline-flex items-center gap-1 text-teal hover:underline" onClick={() => { setChecked(false); doPublish(); }} disabled={busy}>
                <RotateCcw className="h-3 w-3" /> Check again
              </button>
            </div>
          )}
          {problems.length > 0 && (
            <div className="space-y-1.5 rounded-md border border-red-500/40 bg-red-500/10 p-3 text-xs" role="alert" data-testid="publish-problems">
              <p className="flex items-center gap-1.5 font-medium"><ShieldAlert className="h-3.5 w-3.5 text-red-400" /> Not published yet:</p>
              <ul className="list-disc space-y-1 pl-5">{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
            </div>
          )}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <Button className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={go} disabled={busy || (reviewNeeded && !t.reviewConfirmed && !checked)} data-testid="button-confirm-publish-teaser">
            {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />} {t.hasPublished ? "Publish changes" : "Publish"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
