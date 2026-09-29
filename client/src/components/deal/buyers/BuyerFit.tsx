/**
 * Fit of a buyer who has the CIM (Buyers tab → "Have the CIM"): the chip in
 * the table and the "why" dialog behind it. Scores come from
 * GET /api/deals/:dealId/buyer-fit, which keeps them current automatically
 * (server/matching/access-fit.ts) — there is nothing to run.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Check, Minus, X, Sparkles, Loader2, PencilLine, UserPlus, Ban, Copy } from "lucide-react";
import { fitReasons, type AccessFit, type FitReason, type FitTone } from "@shared/buyer-fit";
import { invalidateBuyerPipeline } from "@/lib/buyer-pipeline";
import { BUYER_CRITERIA_FIELDS, formatCriterion } from "@/components/buyers/profile/types";

const EXTRA_LABELS: Record<string, string> = {
  targetIndustries: "Target industries",
  targetLocations: "Target locations",
  lookingFor: "Looking for",
};
const criterionLabel = (key: string) => BUYER_CRITERIA_FIELDS[key]?.label ?? EXTRA_LABELS[key] ?? key;
const criterionValue = (key: string, v: unknown) =>
  Array.isArray(v) && !BUYER_CRITERIA_FIELDS[key] ? v.join(", ") : formatCriterion(key, v);

/** Criteria saved on this deal's access row (the old per-deal editor), read-only. */
function DealCriteriaList({ criteria, keys }: { criteria: Record<string, unknown>; keys: string[] }) {
  return (
    <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2" data-testid="fit-deal-criteria">
      {keys.map((k) => (
        <li key={k} className="min-w-0 text-sm">
          <span className="text-muted-foreground">{criterionLabel(k)}: </span>
          <span className="text-foreground/90 break-words">{criterionValue(k, criteria[k])}</span>
        </li>
      ))}
    </ul>
  );
}

const TONE_CLASS: Record<FitTone, string> = {
  strong: "bg-teal/15 text-teal border-teal/40",
  good: "bg-teal/[0.07] text-teal border-teal/25",
  partial: "bg-muted/40 text-foreground/80 border-border",
  weak: "bg-muted/20 text-muted-foreground border-border",
  excluded: "bg-amber-500/10 text-amber-500 border-amber-500/30",
  none: "bg-transparent text-muted-foreground border-dashed border-border",
};

export function fitChipText(fit: AccessFit): string {
  return fit.score != null ? `${fit.label} · ${fit.score}` : fit.label;
}

/** The Fit cell: label + score, and a plain line under it. Click opens the why. */
export function FitChip({ fit, loading, onOpen, testIdSuffix = "" }: { fit: AccessFit | undefined; loading?: boolean; onOpen: () => void; testIdSuffix?: string }) {
  if (!fit) {
    return loading
      ? <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Checking…</span>
      : <span className="text-xs text-muted-foreground/60">—</span>;
  }
  const sub = fit.tone === "none"
    ? fit.criteriaFrom ? "Their criteria can't be tested yet" : "Add what they want"
    : fit.tone === "excluded"
      ? fit.excludedBy ? `Excludes “${fit.excludedBy}”` : "Excluded by their criteria"
      : `${fit.criteriaMatched} of ${fit.criteriaTested} criteria met`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group text-left"
      aria-label={`Fit: ${fitChipText(fit)} — see why`}
      data-testid={`button-fit-${fit.accessId}${testIdSuffix}`}
    >
      <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium ${TONE_CLASS[fit.tone]}`}>
        {fit.ai && <Sparkles className="h-3 w-3" aria-label="Includes the AI's check" />}
        {fitChipText(fit)}
      </span>
      <span className="mt-0.5 block text-[11px] text-muted-foreground group-hover:text-foreground group-hover:underline underline-offset-2">
        {sub}
      </span>
    </button>
  );
}

function ReasonList({ title, items, icon: Icon, iconClass }: { title: string; items: FitReason[]; icon: typeof Check; iconClass: string }) {
  if (!items.length) return null;
  return (
    <div>
      <p className="mb-1.5 text-2xs font-medium uppercase tracking-wide text-muted-foreground">{title}</p>
      <ul className="space-y-1.5">
        {items.map((r, i) => (
          <li key={i} className="flex items-start gap-2 text-sm">
            <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${iconClass}`} />
            <span className="min-w-0">
              <span className="text-muted-foreground">{r.category}: </span>
              <span className="text-foreground/90">{r.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

interface BuyerLike { id: string; buyerName?: string | null; buyerEmail: string; buyerCompany?: string | null }

export function BuyerFitDialog({
  dealId, buyer, fit, open, onOpenChange,
}: {
  dealId: string;
  buyer: BuyerLike | null;
  fit: AccessFit | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const name = buyer?.buyerName || buyer?.buyerEmail || "This buyer";

  // A buyer who isn't on the broker's list yet has no profile to hold
  // criteria: add them (no email is sent), then open their profile.
  // Criteria saved on this deal's access row -> the broker's private edits of
  // the buyer's profile (gap-fill only). Returns the profile to open.
  const copyCriteriaRequest = async (): Promise<{ buyerId: string; copied: string[] }> => {
    const r = await fetch(`/api/deals/${dealId}/buyer-fit/${buyer!.id}/copy-criteria`, { method: "POST", credentials: "include" });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || "Couldn't copy these criteria");
    return body;
  };
  const copyCriteria = useMutation({
    mutationFn: async (opts: { thenOpen: boolean }) => ({ ...(await copyCriteriaRequest()), thenOpen: opts.thenOpen }),
    onSuccess: (body) => {
      invalidateBuyerPipeline(qc, dealId);
      if (body.thenOpen) setLocation(`/broker/buyers/${body.buyerId}`);
      else toast({
        title: body.copied.length ? "Copied to their profile" : "Already on their profile",
        description: body.copied.length
          ? `${body.copied.length} criteri${body.copied.length === 1 ? "on" : "a"} added as your private edits. The fit updates on its own.`
          : undefined,
      });
    },
    onError: (e: Error) => toast({ title: "Couldn't copy these criteria", description: e.message, variant: "destructive" }),
  });

  const addToList = useMutation({
    mutationFn: async () => {
      const r = await fetch("/api/broker/buyers", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: buyer!.buyerEmail,
          name: buyer!.buyerName?.trim() || buyer!.buyerEmail.split("@")[0],
          company: buyer!.buyerCompany || null,
          sendInvite: false,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Couldn't add this buyer to your list");
      // Criteria the broker once saved on this deal come along, so the
      // profile doesn't open empty ("No acquisition criteria on file yet").
      if (fit?.dealCriteriaToCopy.length) await copyCriteriaRequest();
      return body as { buyerUser: { id: string } };
    },
    onSuccess: (body) => {
      invalidateBuyerPipeline(qc, dealId);
      setLocation(`/broker/buyers/${body.buyerUser.id}`);
    },
    onError: (e: Error) => toast({ title: "Couldn't add this buyer", description: e.message, variant: "destructive" }),
  });

  const checkWithAI = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/buyer-fit/${buyer!.id}/ai`, { method: "POST", credentials: "include" });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Couldn't check fit with AI");
      return body as { fit: AccessFit | null; aiUnavailable: string | null };
    },
    onSuccess: (body) => {
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyer-fit"] });
      toast(body.aiUnavailable
        ? { title: "The AI couldn't add to this score", description: body.aiUnavailable }
        : { title: "Fit checked with AI", description: body.fit ? `${name}: ${fitChipText(body.fit)}` : undefined });
    },
    onError: (e: Error) => toast({ title: "Couldn't check fit with AI", description: e.message, variant: "destructive" }),
  });

  const reasons = fitReasons(fit?.breakdown);
  const profileHref = fit?.profileBuyerId ? `/broker/buyers/${fit.profileBuyerId}` : null;
  const canAI = !!fit && fit.tone !== "none" && fit.tone !== "excluded";
  const toCopy = fit?.dealCriteriaToCopy ?? [];
  const dealCriteria = fit?.dealCriteria ?? null;
  // The fit is scored on per-deal criteria that the profile page can't show:
  // the main action moves them there first.
  const moveThenEdit = !!profileHref && fit?.criteriaFrom === "deal" && toCopy.length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>How well {name} fits</DialogTitle>
          <DialogDescription>
            Fit compares this business with what the buyer says they want. It isn&apos;t about how much of the CIM they&apos;ve read — that&apos;s Engagement.
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto space-y-4 pr-1" data-testid="fit-dialog-body">
          {!fit ? (
            <p className="text-sm text-muted-foreground">Working out the fit…</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-sm font-medium ${TONE_CLASS[fit.tone]}`}>
                  {fit.ai && <Sparkles className="h-3.5 w-3.5" />}
                  {fitChipText(fit)}
                </span>
                {fit.tone !== "none" && fit.tone !== "excluded" && (
                  <span className="text-sm text-muted-foreground">
                    {fit.criteriaMatched} of {fit.criteriaTested} of their criteria met
                  </span>
                )}
              </div>

              {fit.tone === "none" && !fit.criteriaFrom && (
                <p className="text-sm text-foreground/85">
                  {name} hasn&apos;t said what they&apos;re looking for yet, so there&apos;s nothing to compare.
                  {profileHref
                    ? " Add their criteria on their profile — the fit here updates on its own."
                    : " They aren't in your buyer list yet. Add them to set their criteria — the fit here updates on its own."}
                </p>
              )}
              {fit.tone === "none" && fit.criteriaFrom && (
                <p className="text-sm text-foreground/85">
                  None of {name}&apos;s criteria can be compared with this business yet — either they only describe what they want in words, or the facts they care about (like revenue or location) aren&apos;t on file for this deal.
                </p>
              )}
              {fit.tone === "excluded" && (
                <p className="text-sm text-foreground/85 flex items-start gap-2">
                  <Ban className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
                  <span>{name} has said they don&apos;t buy {fit.excludedBy ? <>in <span className="font-medium">“{fit.excludedBy}”</span></> : "in this industry"}. If that&apos;s changed, update their profile.</span>
                </p>
              )}

              <ReasonList title="What matches" items={reasons.met} icon={Check} iconClass="text-teal" />
              <ReasonList title="Partly matches" items={reasons.partly} icon={Minus} iconClass="text-amber-500" />
              <ReasonList title="Doesn't match" items={reasons.unmet} icon={X} iconClass="text-muted-foreground" />

              {fit.aiAssessment && (
                <div className="rounded-md border border-border bg-muted/20 p-3">
                  <p className="mb-1 flex items-center gap-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                    <Sparkles className="h-3 w-3 text-teal" /> The AI&apos;s read
                  </p>
                  <p className="text-sm text-foreground/85">{fit.aiAssessment}</p>
                </div>
              )}

              {dealCriteria && fit.criteriaFrom === "deal" && (
                <div className="rounded-md border border-border p-3 space-y-2" data-testid="fit-deal-criteria-box">
                  <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Criteria you saved for {name} on this deal</p>
                  <DealCriteriaList criteria={dealCriteria} keys={Object.keys(dealCriteria)} />
                  <p className="text-xs text-muted-foreground">
                    {toCopy.length
                      ? "These were saved on this deal before buyer profiles existed. Copy them to their profile to see and edit them there — they then count on every deal."
                      : "Everything here is already on their profile too."}
                  </p>
                </div>
              )}
              {dealCriteria && fit.criteriaFrom === "profile" && toCopy.length > 0 && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/[0.06] p-3 space-y-2" data-testid="fit-deal-criteria-unused">
                  <p className="text-sm text-foreground/90">
                    {toCopy.length === 1 ? "1 criterion" : `${toCopy.length} criteria`} you saved for {name} on this deal {toCopy.length === 1 ? "isn't" : "aren't"} on their profile, so {toCopy.length === 1 ? "it doesn't" : "they don't"} count in this fit:
                  </p>
                  <DealCriteriaList criteria={dealCriteria} keys={toCopy} />
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5"
                    onClick={() => copyCriteria.mutate({ thenOpen: false })}
                    disabled={copyCriteria.isPending}
                    data-testid="button-fit-copy-criteria"
                  >
                    {copyCriteria.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Copy className="h-3.5 w-3.5" />}
                    Copy to their profile
                  </Button>
                </div>
              )}

              <p className="text-2xs text-muted-foreground">
                {fit.criteriaFrom === "deal"
                  ? "Based on criteria saved for this buyer on this deal. "
                  : fit.criteriaFrom === "profile" ? "Based on their buyer profile. " : ""}
                {fit.ai
                  ? "Includes the AI's check — kept until their criteria or this deal's facts change."
                  : "Updates on its own whenever their criteria or this deal's facts change."}
              </p>
            </>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {canAI ? (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={() => checkWithAI.mutate()}
              disabled={checkWithAI.isPending}
              title="Asks the AI to weigh softer things like growth, management depth and the seller's reasons. Uses AI."
              data-testid="button-fit-check-ai"
            >
              {checkWithAI.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {checkWithAI.isPending ? "Checking…" : "Check fit with AI"}
              <span className="text-2xs font-normal text-muted-foreground">(uses AI)</span>
            </Button>
          ) : <span />}
          {moveThenEdit ? (
            <Button
              size="sm"
              className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => copyCriteria.mutate({ thenOpen: true })}
              disabled={copyCriteria.isPending}
              data-testid="button-fit-move-criteria"
            >
              {copyCriteria.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <PencilLine className="h-3.5 w-3.5" />}
              Copy to their profile and edit
            </Button>
          ) : profileHref ? (
            <Button
              size="sm"
              className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => setLocation(profileHref)}
              data-testid="button-fit-edit-criteria"
            >
              <PencilLine className="h-3.5 w-3.5" /> Edit their criteria
            </Button>
          ) : buyer && fit ? (
            <Button
              size="sm"
              className="gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => addToList.mutate()}
              disabled={addToList.isPending}
              data-testid="button-fit-add-to-list"
            >
              {addToList.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <UserPlus className="h-3.5 w-3.5" />}
              {toCopy.length ? "Add to my buyers with these criteria" : "Add to my buyers and set criteria"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
