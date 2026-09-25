/**
 * LockedSection — what a teaser buyer sees for a section the broker marked
 * "Full access". The server sends only the (redacted) title; this card says
 * the content exists and how to get it.
 */
import { Lock } from "lucide-react";
import { LOCKED_SECTION_MESSAGE } from "@shared/cim-layouts";

export function LockedSectionBody() {
  return (
    <div
      className="relative overflow-hidden rounded-xl border border-dashed border-border bg-card/60 px-6 pt-14 pb-8 text-center"
      data-testid="cim-locked-section"
    >
      {/* Faint ghost lines hint at content without revealing any. */}
      <div className="pointer-events-none absolute inset-x-8 top-5 space-y-1.5 opacity-[0.07]" aria-hidden="true">
        <div className="h-2 rounded bg-foreground w-4/5" />
        <div className="h-2 rounded bg-foreground w-3/5" />
        <div className="h-2 rounded bg-foreground w-2/3" />
      </div>
      <div className="relative flex flex-col items-center gap-2">
        <span className="flex h-9 w-9 items-center justify-center rounded-full border border-teal/40 bg-teal/10">
          <Lock className="h-4 w-4 text-teal" />
        </span>
        <p className="text-sm font-medium text-foreground/85">{LOCKED_SECTION_MESSAGE}</p>
        <p className="text-xs text-muted-foreground max-w-sm">
          This part of the memorandum is shared at the next stage of your review.
        </p>
      </div>
    </div>
  );
}
