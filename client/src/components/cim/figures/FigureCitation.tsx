/**
 * FigureCitation — a document a figure or note comes from, as a chip: the
 * data room's <VdrCitationChip docRef /> (INTEGRATION §2.6, dd spec D16).
 * It takes no title: inside a VdrLinkProvider it resolves the room's title
 * and opens the document beside the CIM when the reader may open it, else
 * the neutral label ("Tax return 2023") + "Ask your broker for it"; outside
 * one (print preview, the heat map, the seller's review) the neutral label
 * as plain text; in the broker's preview the document's own name.
 */
import { VdrCitationChip } from "@/components/vdr/VdrCitationChip";
import type { FigureDocRef } from "@shared/figure-layer";
import { cn } from "@/lib/utils";

export function FigureCitation({ docRef, className }: { docRef: FigureDocRef; className?: string }) {
  return <VdrCitationChip docRef={docRef} className={className} />;
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
