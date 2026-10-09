/**
 * FigureCitation — a document a figure or note comes from, as a chip.
 *
 * STAND-IN for vdr's <VdrCitationChip docRef /> (INTEGRATION §2.6, dd spec
 * D16): until the vdr stream merges, the chip shows the neutral label
 * ("Tax return 2023 · p. 3") and links nowhere. INTEGRATOR: at the dd merge,
 * render `<VdrCitationChip docRef={docRef} />` here (it resolves the room
 * title and opens the data-room drawer when the reader has access).
 */
import { FileText } from "lucide-react";
import { figureCitationLabel, type FigureDocRef } from "@shared/figure-layer";
import { cn } from "@/lib/utils";

export function FigureCitation({ docRef, className }: { docRef: FigureDocRef; className?: string }) {
  const label = figureCitationLabel(docRef);
  const page = typeof docRef.page === "number" && docRef.page > 0 ? ` · p. ${docRef.page}` : "";
  return (
    <span
      data-vdr-chip=""
      className={cn(
        "inline-flex max-w-full items-center gap-1 rounded-full border border-[#E3DED0] bg-[#FEFDFB] px-1.5 py-px text-[10px] font-medium leading-4 text-[#46423B] align-middle",
        className,
      )}
      title={`${label}${page}`}
    >
      <FileText aria-hidden className="h-2.5 w-2.5 shrink-0 text-[#8C8779]" />
      <span className="truncate">{label}{page}</span>
    </span>
  );
}

/** Several chips, at most `max`, then "+n more". */
export function FigureCitations({ refs, max = 6, className }: { refs: FigureDocRef[]; max?: number; className?: string }) {
  if (!refs.length) return null;
  const shown = refs.slice(0, max);
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1", className)}>
      {shown.map((r) => <FigureCitation key={`${r.documentId}-${r.page ?? ""}`} docRef={r} />)}
      {refs.length > max && <span className="text-[10px] text-[#6B665C]">+{refs.length - max} more</span>}
    </span>
  );
}
