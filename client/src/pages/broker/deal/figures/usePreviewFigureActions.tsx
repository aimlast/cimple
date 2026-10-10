/**
 * usePreviewFigureActions — what the CIM builder's buyer preview can do from
 * a figure's popover (spec §5.1, D21): approve a suggested note, open the
 * note drawer (edit, write a reason, "This is right, use it" with Cimple's
 * hint), ask the seller, and open "Review and show to buyers" from the
 * preview bar. Returns the hooks for FigureLayerProvider and the overlays to
 * render once (the same drawer, sheet and dialog as Numbers & sources).
 */
import { useMemo, useState } from "react";
import type { FigureBrokerHooks } from "@/components/cim/figures/FigureLayerContext";
import { useToast } from "@/hooks/use-toast";
import { NoteDrawer, type NoteDrawerTarget } from "./NoteDrawer";
import { ReviewSheet } from "./ReviewSheet";
import { AskSellerDialog, type AskTarget } from "./AskSellerDialog";
import { figuresErrorText, useFigureActions } from "./useFigures";

export function usePreviewFigureActions(dealId: string): { hooks: FigureBrokerHooks; overlays: JSX.Element; openReview: () => void } {
  const { toast } = useToast();
  const actions = useFigureActions(dealId);
  const [target, setTarget] = useState<NoteDrawerTarget | null>(null);
  const [review, setReview] = useState(false);
  const [ask, setAsk] = useState<AskTarget>(null);
  const approve = actions.approveNotes;
  const hooks = useMemo<FigureBrokerHooks>(() => ({
    dealId,
    onApprove: (noteId) => {
      approve.mutateAsync([noteId])
        .then((r) => toast(r.approved > 0 ? { title: "Shown to buyers" } : { title: "Not shown", description: r.skipped[0]?.reason ? `It ${r.skipped[0].reason}.` : undefined }))
        .catch((e) => toast({ title: "Couldn't show that note", description: figuresErrorText(e), variant: "destructive" }));
    },
    onOpenNote: (figureKey, opts) => {
      if (opts?.noteId && !opts.noteId.includes("#")) setTarget({ noteId: opts.noteId });
      else if (opts?.hint) setTarget({ figureKey, kind: "movement", prefill: opts.hint, fromHint: true });
      else setTarget({ figureKey, kind: "movement" });
    },
    onAskSeller: (figureKey) => setAsk({ figureKeys: [figureKey] }),
    onReview: () => setReview(true),
  }), [dealId, approve, toast]);
  const overlays = (
    <>
      <NoteDrawer dealId={dealId} target={target} onClose={() => setTarget(null)} />
      <ReviewSheet dealId={dealId} open={review} onOpenChange={setReview} />
      <AskSellerDialog dealId={dealId} target={ask} onClose={() => setAsk(null)} />
    </>
  );
  return { hooks, overlays, openReview: () => setReview(true) };
}
