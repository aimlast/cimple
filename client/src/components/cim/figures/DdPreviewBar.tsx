/**
 * DdPreviewBar — the builder's bar above the paper while previewing a buyer
 * version (spec D21): what buyers don't see yet, and the way to show it.
 * App chrome (Obsidian & Brass tokens), not paper.
 */
import { AlertTriangle, Eye, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { BROKER_LAYER_FAILED, BROKER_NO_OTHER_RECORDS, BROKER_PREVIEW_BAR, BROKER_REVIEW_AND_SHOW } from "@shared/figure-copy";
import type { FigureLayer } from "@shared/figure-layer";

export interface DdPreviewBarProps {
  mode: "dd" | "normal" | "blind";
  layer: FigureLayer | null;
  loading?: boolean;
  failed?: boolean;
  refreshing?: boolean;
  /** The deal has tax returns or other records to compare with. */
  hasOtherRecords?: boolean;
  /** Why the layer was dropped (a blind-guard hit) — broker only. */
  dropped?: string | null;
  onReview?: () => void;
}

export function DdPreviewBar({ mode, layer, loading, failed, refreshing, hasOtherRecords, dropped, onReview }: DdPreviewBarProps) {
  if (failed || dropped) {
    return (
      <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{dropped ? `The figure notes are held back from this version: ${dropped}.` : BROKER_LAYER_FAILED}</span>
      </div>
    );
  }
  if (loading) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading the notes on the figures…
      </div>
    );
  }
  if (mode !== "dd") {
    const waiting = layer ? Object.values(layer.figures).filter((f) => f.why?.suggested).length : 0;
    if (waiting === 0) return null;
    return (
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5"><Eye className="h-3.5 w-3.5" /> {waiting} {waiting === 1 ? "note on a figure waits" : "notes on figures wait"} for your OK. Dashed notes aren't shown to buyers yet.</span>
        {onReview && <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onReview}>{BROKER_REVIEW_AND_SHOW}</Button>}
      </div>
    );
  }
  if (!hasOtherRecords) {
    return (
      <div className="sticky top-0 z-10 mb-3 rounded-lg border border-border bg-card/95 px-3 py-2 text-xs text-muted-foreground backdrop-blur">
        {BROKER_NO_OTHER_RECORDS}{refreshing ? " · Checking the numbers…" : ""}
      </div>
    );
  }
  if (layer?.ddChecksOn) {
    return refreshing ? (
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking the numbers…</div>
    ) : null;
  }
  return (
    <div className="sticky top-0 z-10 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-teal/40 bg-card/95 px-3 py-2 text-xs backdrop-blur" data-testid="dd-preview-bar">
      <span className="text-foreground">{BROKER_PREVIEW_BAR}{refreshing ? <span className="text-muted-foreground"> · Checking the numbers…</span> : null}</span>
      {onReview && <Button size="sm" className="h-7 text-xs" onClick={onReview}>{BROKER_REVIEW_AND_SHOW}</Button>}
    </div>
  );
}
