/**
 * AccessLevelSelect — what a buyer's link opens, on the deal's Buyers tab
 * (Teaser · Blind CIM · Full CIM · Due diligence — shared/access-levels.ts),
 * each with a one-line explanation. Saves through PATCH /api/buyers/:id
 * (validated server-side; legacy values show as the level they mean).
 *
 * Moving a buyer DOWN asks first: "Move Gurdeep to the Blind CIM? They've
 * already seen the business's name — this only changes what they see from
 * now on." Moving back to the teaser: "They'll lose the CIM." (The server
 * refuses the teaser when none is published; so does this menu.)
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import {
  ACCESS_LEVELS, TEASER_ACCESS_LEVEL, accessLevelLabel, accessLevelRank, isTeaserOnly, normalizeAccessLevel, seesNamedCim, type AccessLevel,
} from "@shared/access-levels";
import { useTeaserSummary, teaserIsPublished } from "@/components/teaser/useTeaserSummary";
import { invalidateBuyerPipeline } from "@/lib/buyer-pipeline";
import { builderRequest, errorText } from "./api";

interface Props {
  dealId: string;
  buyer: { id: string; accessLevel?: string | null; buyerName?: string | null; buyerEmail: string };
  /** Keeps test ids unique when the same buyer renders twice (table + phone card). */
  testIdSuffix?: string;
  /** A teaser is published, so "Teaser" can be chosen (the server refuses it otherwise). Default: read from the teaser summary. */
  teaserPublished?: boolean;
}

/** The question to ask before a move, or null when no confirmation is needed. */
export function moveQuestion(from: unknown, to: unknown, who: string): { title: string; body: string } | null {
  const a = normalizeAccessLevel(from);
  const b = normalizeAccessLevel(to);
  const first = who.split(/\s+/)[0] || who;
  if (isTeaserOnly(b) && !isTeaserOnly(a)) {
    return { title: `Move ${first} back to the teaser?`, body: "They'll lose the CIM. Their link shows the short anonymous summary instead." };
  }
  if (accessLevelRank(b) < accessLevelRank(a)) {
    const noun = ACCESS_LEVELS.find((l) => l.key === b)?.grantNoun ?? accessLevelLabel(b);
    const seen = seesNamedCim(a) && !seesNamedCim(b)
      ? "They've already seen the business's name — this only changes what they see from now on."
      : "They've already seen the due-diligence detail — this only changes what they see from now on.";
    return { title: `Move ${first} to ${noun}?`, body: seen };
  }
  return null;
}

export function AccessLevelSelect({ dealId, buyer, testIdSuffix = "", teaserPublished }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const current = normalizeAccessLevel(buyer.accessLevel);
  const who = buyer.buyerName || buyer.buyerEmail;
  const summary = useTeaserSummary(dealId, { enabled: teaserPublished === undefined });
  const teaserOk = teaserPublished ?? teaserIsPublished(summary.data);
  const [confirm, setConfirm] = useState<{ level: AccessLevel; title: string; body: string } | null>(null);

  const save = useMutation({
    mutationFn: (accessLevel: string) => builderRequest("PATCH", `/api/buyers/${buyer.id}`, { accessLevel }),
    onSuccess: (_r, level) => {
      invalidateBuyerPipeline(qc, dealId);
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-builder"] });
      const meta = ACCESS_LEVELS.find((l) => l.key === normalizeAccessLevel(level));
      toast({
        title: `${who} now has ${meta?.grantNoun ?? accessLevelLabel(level)}`,
        description: meta?.description,
      });
    },
    onError: (e) => toast({ title: "Couldn't change access", description: errorText(e), variant: "destructive" }),
  });

  const choose = (v: string) => {
    const level = normalizeAccessLevel(v);
    if (level === current) return;
    const q = moveQuestion(current, level, who);
    if (q) setConfirm({ level, ...q });
    else save.mutate(level);
  };

  return (
    <>
      <Select value={current} onValueChange={choose} disabled={save.isPending}>
        <SelectTrigger
          className="h-7 w-[124px] shrink-0 text-xs"
          aria-label={`What ${who} can see`}
          data-testid={`select-access-level-${buyer.id}${testIdSuffix}`}
        >
          {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
          {/* Only the label in the trigger — the items also carry an explanation. */}
          <SelectValue>{accessLevelLabel(current)}</SelectValue>
        </SelectTrigger>
        <SelectContent align="start" className="w-72">
          {ACCESS_LEVELS.map((l) => {
            const unavailable = l.key === TEASER_ACCESS_LEVEL && !teaserOk && current !== TEASER_ACCESS_LEVEL;
            return (
              <SelectItem key={l.key} value={l.key} className="text-xs" disabled={unavailable} data-testid={`option-access-level-${l.key}${testIdSuffix}`}>
                <span className="block font-medium">{l.label}</span>
                <span className="block text-[11px] text-muted-foreground leading-snug whitespace-normal">
                  {unavailable ? "Publish the teaser first." : l.description}
                </span>
              </SelectItem>
            );
          })}
        </SelectContent>
      </Select>
      <AlertDialog open={!!confirm} onOpenChange={(o) => !o && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirm?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirm?.body}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep {accessLevelLabel(current)}</AlertDialogCancel>
            <AlertDialogAction onClick={() => { if (confirm) save.mutate(confirm.level); setConfirm(null); }} data-testid="button-confirm-move-level">
              Move them
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
