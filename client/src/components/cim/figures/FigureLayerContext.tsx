/**
 * FigureLayerContext — the notes on the CIM's figures and (due diligence) the
 * figure checks, for the renderers (stream "dd", spec §10).
 *
 * Hosts: the buyer view room (data.figureLayer) and the CIM builder's buyer
 * preview (GET /api/deals/:id/figure-layer, broker marks on). Without a
 * provider every renderer draws exactly as before (print preview, the heat
 * map's page canvas, teaser pages, the seller review page).
 *
 *   <FigureLayerProvider layer={…} broker={…} buyer={…}>
 *   useFigureAt(block, cell)   → the figure a value shows (scope-aware: page + two-column prefix)
 *   useFigureById(id)          → a figure by its id
 *   usePageFigures(pageId)     → the figures on a page (notes list)
 *   useFigureLayer()           → the layer + host hooks (or null)
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { FigureLayer, FigureView } from "@shared/figure-layer";
import { useBlockScope } from "../blocks";

/** What the broker preview can do from a popover (all optional). */
export interface FigureBrokerHooks {
  dealId: string;
  /** Approve a suggested note. */
  onApprove?(noteId: string): void;
  /** Open the note drawer for a figure (edit / write a note / use a hint). */
  onOpenNote?(figureKey: string, opts?: { hint?: string; noteId?: string }): void;
  /** Ask the seller about this figure (pass 2: questions). */
  onAskSeller?(figureKey: string): void;
  /** Open the review sheet ("Review and show to buyers"). */
  onReview?(): void;
}

/** What a buyer can do from a popover. */
export interface FigureBuyerHooks {
  /** Send a question about this figure to the broker. Resolves when sent. */
  onAsk?(figureId: string, text: string): Promise<void>;
}

interface Ctx {
  layer: FigureLayer;
  broker: FigureBrokerHooks | null;
  buyer: FigureBuyerHooks | null;
  /** Print preview: "Notes on these figures" lists start open. */
  expandNotes: boolean;
  /** pageId|block|cell → figure id. */
  index: Map<string, string>;
  /** pageId → figure ids in reading order. */
  byPage: Map<string, string[]>;
}

const FigureCtx = createContext<Ctx | null>(null);

const slot = (pageId: string, block: string, cell: number | null | undefined) => `${pageId}|${block}|${cell ?? ""}`;

export function FigureLayerProvider({
  layer, broker, buyer, expandNotes = false, children,
}: { layer: FigureLayer | null | undefined; broker?: FigureBrokerHooks | null; buyer?: FigureBuyerHooks | null; expandNotes?: boolean; children: ReactNode }) {
  const value = useMemo<Ctx | null>(() => {
    if (!layer) return null;
    const index = new Map<string, string>();
    const byPage = new Map<string, string[]>();
    for (const a of layer.anchors) {
      index.set(slot(a.pageId, a.block, a.cell), a.fig);
      const list = byPage.get(a.pageId) ?? [];
      if (!list.includes(a.fig)) list.push(a.fig);
      byPage.set(a.pageId, list);
    }
    return { layer, broker: broker ?? null, buyer: buyer ?? null, expandNotes, index, byPage };
  }, [layer, broker, buyer, expandNotes]);
  return <FigureCtx.Provider value={value}>{children}</FigureCtx.Provider>;
}

export function useFigureLayer(): Ctx | null {
  return useContext(FigureCtx);
}

/**
 * The figure shown at a block of the current page (`block` is the renderer's
 * local key — "row:3", "metric:0", "chart/point:2"; the two-column prefix and
 * the page come from the scope). Normalized rows ("nrow:i") never match.
 */
export function useFigureAt(block: string, cell: number | null = null): FigureView | null {
  const ctx = useContext(FigureCtx);
  const scope = useBlockScope();
  if (!ctx || !scope.pageId) return null;
  if (scope.rowKind === "nrow" && /^row:/.test(block)) return null;
  const key = scope.prefix ? `${scope.prefix}/${block}` : block;
  const id = ctx.index.get(slot(scope.pageId, key, cell));
  return id ? ctx.layer.figures[id] ?? null : null;
}

/** A lookup function for many cells (tables), with the same rules as useFigureAt. */
export function useFigureLookup(): (block: string, cell?: number | null) => FigureView | null {
  const ctx = useContext(FigureCtx);
  const scope = useBlockScope();
  return useMemo(() => (block: string, cell: number | null = null) => {
    if (!ctx || !scope.pageId) return null;
    if (scope.rowKind === "nrow" && /^row:/.test(block)) return null;
    const key = scope.prefix ? `${scope.prefix}/${block}` : block;
    const id = ctx.index.get(slot(scope.pageId, key, cell));
    return id ? ctx.layer.figures[id] ?? null : null;
  }, [ctx, scope.pageId, scope.prefix, scope.rowKind]);
}

export function useFigureById(id: string | null | undefined): FigureView | null {
  const ctx = useContext(FigureCtx);
  return id && ctx ? ctx.layer.figures[id] ?? null : null;
}

/** The figures on a page, in the order they first appear. */
export function usePageFigures(pageId: string | null | undefined): FigureView[] {
  const ctx = useContext(FigureCtx);
  if (!ctx || !pageId) return [];
  return (ctx.byPage.get(pageId) ?? []).map((id) => ctx.layer.figures[id]).filter((f): f is FigureView => !!f);
}

/** The first anchor of a figure on a page (to scroll to it from the notes list). */
export function anchorOf(layer: FigureLayer, figId: string, pageId: string): { block: string; cell: number | null } | null {
  const a = layer.anchors.find((x) => x.fig === figId && x.pageId === pageId);
  return a ? { block: a.block, cell: a.cell } : null;
}
