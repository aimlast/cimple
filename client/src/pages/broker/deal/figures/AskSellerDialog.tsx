/**
 * AskSellerDialog — "Ask the seller" (spec §5.2 Tab 3, §9.7): one
 * confirmation that lists EVERY follow-up waiting to be sent (these figure
 * questions and any conflicts routed before the interview finished), then
 * one email through the one follow-up path. While the interview is running
 * nothing is emailed: the interview asks them. Only ever on the broker's click.
 */
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { listJoin } from "@shared/figure-copy";
import { figuresErrorText, useFigureActions, type AskResult } from "./useFigures";

export type AskTarget = { questionIds?: string[]; figureKeys?: string[] } | null;

function summary(r: AskResult, interviewRunning: boolean): string {
  const figures = r.listed.filter((x) => x.kind === "figure").map((x) => x.label);
  const others = r.listed.filter((x) => x.kind !== "figure").map((x) => x.label);
  const n = r.listed.length;
  const parts: string[] = [];
  if (figures.length > 0) parts.push(`${figures.length} about the figures (${listJoin(figures)})`);
  if (others.length > 0) parts.push(`${others.length} you routed from Discrepancies (${listJoin(others)})`);
  if (interviewRunning) return `The interview is still running, so nothing is emailed: it asks the seller ${n === 1 ? "this question" : `these ${n} questions`} at natural moments.`;
  return `This emails the seller one link with ${n === 1 ? "1 question" : `${n} questions`}: ${listJoin(parts)}.`;
}

export function AskSellerDialog({ dealId, target, onClose }: { dealId: string; target: AskTarget; onClose: () => void }) {
  const { toast } = useToast();
  const { ask } = useFigureActions(dealId);
  const [preview, setPreview] = useState<AskResult | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  useEffect(() => {
    setPreview(null);
    setFailed(null);
    if (!target) return;
    ask.mutateAsync({ ...target, preview: true }).then(setPreview).catch((e) => setFailed(figuresErrorText(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(target)]);
  if (!target) return null;
  const empty = preview && preview.listed.length === 0;
  const running = !!preview && !preview.interviewFinished;

  const send = async () => {
    setSending(true);
    try {
      const r = await ask.mutateAsync({ questionIds: preview?.questionIds?.length ? preview.questionIds : target.questionIds, figureKeys: target.figureKeys });
      if (!r.interviewFinished) {
        toast({ title: "Added to the interview", description: "The interview asks the seller at natural moments. Nothing was emailed." });
      } else if (r.addressed === 0 && !r.recentlyEmailed) {
        toast({ title: "Nobody to send it to", description: "The seller has no emailed invite of their own, so nothing reaches them. Send them their link from the Team tab.", variant: "destructive" });
      } else {
        toast({
          title: r.listed.length === 1 ? "Sent to the seller" : `${r.listed.length} questions sent to the seller`,
          description: r.recentlyEmailed ? "They were emailed a follow-up link in the last hour; these are added to it." : r.emailed > 0 ? "We emailed them one link to answer your follow-up questions." : "Their portal now shows your follow-up questions (nothing was emailed from here).",
        });
      }
      onClose();
    } catch (e) {
      toast({ title: "Couldn't send the questions", description: figuresErrorText(e), variant: "destructive" });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-md" data-testid="ask-seller-dialog">
        <DialogHeader>
          <DialogTitle>Ask the seller</DialogTitle>
          <DialogDescription asChild>
            <div className="text-sm text-muted-foreground">
              {failed ? <span className="text-red-400">{failed}</span>
                : !preview ? <Skeleton className="h-10" />
                : empty ? "There's no question to send for this figure yet. Write the reason yourself, or check the numbers again first."
                : summary(preview, running)}
            </div>
          </DialogDescription>
        </DialogHeader>
        {preview && (preview.refused?.length ?? 0) > 0 && (
          <p className="text-xs text-muted-foreground" data-testid="ask-seller-refused">
            Not sent: {preview.refused!.map((r) => r.reason).filter((r, i, all) => all.indexOf(r) === i).join(" ")}
          </p>
        )}
        {preview && !empty && (
          <ul className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border px-3 py-2 text-xs">
            {preview.listed.map((x, i) => <li key={i}>{x.kind === "figure" ? "Figures" : "Discrepancies"}: {x.label}</li>)}
          </ul>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={send} disabled={!preview || !!empty || sending} data-testid="button-ask-seller-send">
            {sending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}{running ? "Add to the interview" : "Email the seller"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
