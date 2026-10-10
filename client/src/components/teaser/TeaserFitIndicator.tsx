/**
 * TeaserFitIndicator — "Fits on 1 page" / "Runs onto page 3 by about 6
 * lines — shorten a block or keep it longer, it's up to you". It never
 * blocks: the broker can make the teaser as long as they like.
 */
import { CheckCircle2, FileText, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fitSentence } from "./paginate";
import type { TeaserLayoutInfo } from "./TeaserPages";

export function TeaserFitIndicator({ info, targetPages, className }: { info: TeaserLayoutInfo | null; targetPages: number; className?: string }) {
  if (!info) {
    return (
      <p className={cn("inline-flex items-center gap-1.5 text-xs text-muted-foreground", className)} data-testid="teaser-fit">
        <Loader2 className="h-3 w-3 animate-spin" /> Measuring the pages…
      </p>
    );
  }
  const fit = fitSentence({ pages: info.pages, targetPages, lastPageUsed: info.lastPageUsed });
  return (
    <p
      className={cn("inline-flex items-center gap-1.5 text-xs", fit.over ? "text-amber-500" : "text-success", className)}
      data-testid="teaser-fit"
      aria-live="polite"
    >
      {fit.over ? <FileText className="h-3.5 w-3.5 shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />}
      <span>{fit.text}</span>
    </p>
  );
}
