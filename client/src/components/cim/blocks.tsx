/**
 * blocks — the reading-analytics identity of the parts of a rendered CIM.
 *
 * Every CIM renderer marks the parts a buyer reads — a table row, a metric
 * card, a paragraph, a chart — with `data-cim-block="<key>"`, and every page
 * (a section, the disclaimer, the contact page) with `data-cim-page="<id>"`.
 * The keys are structural (shared/cim-blocks.ts: "row:3", "metric:0",
 * "left/para:1") and never carry any text, so a blind buyer's browser sends
 * nothing that identifies the business.
 *
 * The attributes are only written inside a <CimBlocksProvider>: the buyer
 * view room (which measures reading time against them) and the broker's
 * engagement viewer (which draws the heat map over them). The builder, the
 * print preview and every other host render exactly as before.
 *
 *   <CimBlocksProvider host={…}>        enables attributes (+ optional callbacks)
 *     <CimBlockScope pageId=… prefix="left" rowKind="nrow" off>   nesting
 *   useBlockAttrs()(key)                → { "data-cim-block": "<prefix/>key" } | {}
 *   usePageAttrs(pageId)                → { "data-cim-page": id } | {}
 *   useChartPointReporter()(index|null) → tells the host which datum is pointed at
 *   useCimInteraction()(type, key?, detail?) → a discrete interaction (play, open…)
 */
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { CIM_BLOCK_ATTR, CIM_PAGE_ATTR, type ReadingInteractionType } from "@shared/analytics-v2";
import { chartPointKey, joinBlockKey } from "@shared/cim-blocks";

/** What the page hosting the CIM wants to hear about (all optional). */
export interface CimBlockHost {
  /** The chart datum under the pointer (index into the chart's data), or null when the pointer leaves the chart. */
  onChartPoint?(pageId: string, blockKey: string, index: number | null): void;
  /** A discrete buyer interaction inside a renderer (video play, photo opened, map used…). */
  onInteraction?(event: { type: ReadingInteractionType; pageId: string; blockKey?: string; detail?: string }): void;
}

interface Scope {
  /** "left" / "right" inside a two-column section ("" at the top level). */
  prefix: string;
  /** "nrow" while a financial table shows its Normalized rows. */
  rowKind: "row" | "nrow";
  /** True inside previews that must not be measured (a collapsed section's summary). */
  off: boolean;
  pageId: string | null;
}

const HostContext = createContext<CimBlockHost | null>(null);
const ScopeContext = createContext<Scope>({ prefix: "", rowKind: "row", off: false, pageId: null });

const NONE: Record<string, string> = Object.freeze({}) as Record<string, string>;

/** Turns block/page attributes on for everything inside. */
export function CimBlocksProvider({ host, children }: { host?: CimBlockHost; children: ReactNode }) {
  const value = useMemo(() => host ?? {}, [host]);
  return <HostContext.Provider value={value}>{children}</HostContext.Provider>;
}

/** Nests a part of the CIM: a page, a two-column side, the Normalized table view, or an unmeasured preview. */
export function CimBlockScope({
  pageId, prefix, rowKind, off, children,
}: { pageId?: string; prefix?: string; rowKind?: "row" | "nrow"; off?: boolean; children: ReactNode }) {
  const parent = useContext(ScopeContext);
  const value = useMemo<Scope>(() => ({
    prefix: prefix ? joinBlockKey(parent.prefix, prefix) : parent.prefix,
    rowKind: rowKind ?? parent.rowKind,
    off: off ?? parent.off,
    pageId: pageId ?? parent.pageId,
  }), [parent, pageId, prefix, rowKind, off]);
  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

/** True when block attributes are being written here. */
export function useBlocksEnabled(): boolean {
  const host = useContext(HostContext);
  const scope = useContext(ScopeContext);
  return !!host && !scope.off;
}

/**
 * `ba("row:3")` → `{ "data-cim-block": "left/row:3" }` inside the left column
 * of a two-column section, `{}` when attributes are off. `ba.row(i)` gives
 * the table-row key for the current view ("row:i" or "nrow:i").
 */
export function useBlockAttrs(): ((key: string) => Record<string, string>) & { row: (i: number) => Record<string, string> } {
  const enabled = useBlocksEnabled();
  const scope = useContext(ScopeContext);
  return useMemo(() => {
    const fn = ((key: string) => (enabled ? { [CIM_BLOCK_ATTR]: joinBlockKey(scope.prefix, key) } : NONE)) as
      ((key: string) => Record<string, string>) & { row: (i: number) => Record<string, string> };
    fn.row = (i: number) => fn(`${scope.rowKind}:${i}`);
    return fn;
  }, [enabled, scope.prefix, scope.rowKind]);
}

/** `{ "data-cim-page": pageId }` when attributes are on. */
export function usePageAttrs(pageId: string | null | undefined): Record<string, string> {
  const enabled = useBlocksEnabled();
  return enabled && pageId ? { [CIM_PAGE_ATTR]: pageId } : NONE;
}

/** Report the chart datum under the pointer: call with its index, or null when the pointer leaves. */
export function useChartPointReporter(blockKey = "chart"): (index: number | null | undefined) => void {
  const host = useContext(HostContext);
  const scope = useContext(ScopeContext);
  const key = joinBlockKey(scope.prefix, blockKey);
  return useCallback((index: number | null | undefined) => {
    if (!host?.onChartPoint || scope.off || !scope.pageId) return;
    host.onChartPoint(scope.pageId, index == null || index < 0 ? key : chartPointKey(key, index), index ?? null);
  }, [host, scope.off, scope.pageId, key]);
}

/** Report a discrete interaction from inside a renderer. A no-op outside the view room. */
export function useCimInteraction(): (type: ReadingInteractionType, blockKey?: string, detail?: string) => void {
  const host = useContext(HostContext);
  const scope = useContext(ScopeContext);
  return useCallback((type: ReadingInteractionType, blockKey?: string, detail?: string) => {
    if (!host?.onInteraction || scope.off || !scope.pageId) return;
    host.onInteraction({ type, pageId: scope.pageId, blockKey: blockKey ? joinBlockKey(scope.prefix, blockKey) : undefined, detail });
  }, [host, scope.off, scope.pageId, scope.prefix]);
}
