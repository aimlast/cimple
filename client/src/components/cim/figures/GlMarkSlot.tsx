/**
 * GlMarkSlot — where gl's "Found in the books" mark goes on an earnings-bridge
 * row (dd spec §4.4 / §11.2, INTEGRATION §2.7 rule 6): `<GlMark lineId
 * variant="row" />`, gl's own component, for rows the figure layer ties to a
 * general-ledger add-back line (`layer.glMarks`). gl's mark shows only when
 * that line's mark is on in what this reader is served (GlMarksProvider,
 * from the DD page / the note); without a provider nothing is drawn.
 */
import { useFigureLayer } from "./FigureLayerContext";
import { useBlockScope } from "../blocks";
import { GlMark } from "../gl/GlMark";

export function GlMarkSlot({ lineId, variant = "row" }: { lineId: string | null | undefined; variant?: "row" }) {
  if (!lineId) return null;
  return <GlMark lineId={lineId} variant={variant} />;
}

/** The gl line a bridge row (chart point) is, on the current page — or null. */
export function useGlLineAt(): (block: string) => string | null {
  const ctx = useFigureLayer();
  const scope = useBlockScope();
  return (block: string) => {
    if (!ctx?.layer.glMarks || !scope.pageId) return null;
    const key = scope.prefix ? `${scope.prefix}/${block}` : block;
    return ctx.layer.glMarks.find((m) => m.pageId === scope.pageId && m.block === key)?.lineId ?? null;
  };
}

/** gl's "Where each add-back is in the books" page, when it is on this CIM (its id starts "glsec_"). */
export function glBooksPage(): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>('[data-cim-page^="glsec_"], [id^="section-glsec_"]');
}
