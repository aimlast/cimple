/**
 * The CIM tab dashboard's slots (INTEGRATION §2.8). Teaser owns the layout
 * (CimTab.tsx); other streams add to it ONLY through these registries, so
 * no contributor edits the layout:
 *
 *   CIM_TAB_VIEWS          the tabs — teaser's attention · versions · teaser ·
 *   (= EXTRA_CIM_TAB_VIEWS) design; dd pushes `numbers` "Numbers & sources"
 *                          ({ key, label, badge? | useBadge?, Component })
 *   ACCESS_TILE_LINES      extra lines under the four "What each buyer sees"
 *                          tiles — at most 2 per tile, dd first, then vdr
 *   VERSION_CARD_EXTRAS    extra content on the Versions cards (dd, gl)
 *   ATTENTION_GROUPS       extra rows in "Needs attention" (dd)
 *   CIM_PUBLISH_NOTES      lines beside "Review and publish" (vdr; never blocks)
 *
 * Every entry's hook is called on every render, in registry order, so the
 * registries are filled at import time (module scope) and never change.
 */
import type { ComponentType, ReactNode } from "react";
import type { AccessLevel } from "@shared/access-levels";
import { VdrPublishNote, useVdrTileLines, vdrTileTooltips } from "@/components/vdr/cim-slots";
import { useRoom } from "@/hooks/useDataRoom";
import { GlGenerationNotice } from "@/components/gl/GlGenerationNotice";

export interface CimTabViewProps {
  dealId: string;
  /** Switch to another view (keeps pass-through params out). */
  setView: (key: string, params?: Record<string, string>) => void;
}

export interface CimTabView {
  key: string;
  label: string;
  /** A count on the tab (e.g. notes waiting); null/0 = none. Called every render (it may use hooks). */
  useBadge?: (dealId: string) => number | null;
  /** INTEGRATION §2.8 spelling: a fixed count, or a hook like `useBadge`. `useBadge` wins when both are given. */
  badge?: number | null | ((dealId: string) => number | null);
  Component: ComponentType<CimTabViewProps>;
}

/** Extra views other streams register (dd: "numbers"). Teaser's four are built into CimTab. */
export const EXTRA_CIM_TAB_VIEWS: CimTabView[] = [];
/** The same registry under its INTEGRATION §2.8 name (dd registers `numbers` here): one array, two names. */
export const CIM_TAB_VIEWS = EXTRA_CIM_TAB_VIEWS;

/** A registered view's badge this render (call once per view, every render — the hooks keep their order). */
export function useViewBadge(v: CimTabView, dealId: string): number | null {
  if (v.useBadge) return v.useBadge(dealId);
  return typeof v.badge === "function" ? v.badge(dealId) : v.badge ?? null;
}

export interface TileLine {
  key: string;
  text: string;
  tone?: "muted" | "amber";
  href?: string;
}

export interface AccessTileLineSource {
  key: string;
  /** Lines per access level; at most 2 per tile are shown (sources in registry order: dd, then vdr). */
  useLines: (dealId: string) => Partial<Record<AccessLevel, TileLine[]>>;
  /** A tooltip per tile ("No data room"), when there is no line. */
  useTooltips?: (dealId: string) => Partial<Record<AccessLevel, string>>;
}
export const ACCESS_TILE_LINES: AccessTileLineSource[] = [
  // (dd's source goes FIRST at the dd merge: "dd first, then vdr".)
  // The data room (vdr, merge step 6): Due diligence "+ data room · {k} documents shared" (or "{n} the DD
  // CIM points to aren't shared · Share them"); Full CIM "+ data room for {n} buyers you chose"; Teaser and
  // Blind CIM say "No data room" in the tooltip (C13).
  { key: "vdr", useLines: (dealId) => useVdrTileLines(dealId).lines, useTooltips: () => vdrTileTooltips() },
];

export type VersionCardKey = "blind" | "named" | "dd";
export interface VersionCardExtraSource {
  key: string;
  useExtras: (dealId: string) => Partial<Record<VersionCardKey, ReactNode>>;
}
export const VERSION_CARD_EXTRAS: VersionCardExtraSource[] = [
  // (dd's source goes FIRST at the dd merge: the Full and Blind lines, the DD summary + "Review and show to buyers".)
  // Add-backs in the books (gl, merge step 7): the DD card's hold notice — "Waiting for 'Add-backs in the
  // books' (3 of 7 to go)" + See add-backs + "Go ahead without the ledger…" (or the whole-CIM hold switch's
  // notice). Renders nothing when nothing holds the DD CIM; CimTab hides the DD Generate/Refresh while held.
  { key: "gl", useExtras: (dealId) => ({ dd: <GlGenerationNotice key="gl-dd" dealId={dealId} kind="dd" compact /> }) },
];

export interface AttentionGroupView {
  key: string;
  /** The row (full width). */
  node: ReactNode;
  /** Counts toward "Needs attention (n)". */
  counts: boolean;
}
export interface AttentionGroupSource {
  key: string;
  useGroup: (dealId: string) => AttentionGroupView | null;
}
export const ATTENTION_GROUPS: AttentionGroupSource[] = [];

export interface PublishNoteSource {
  key: string;
  useNotes: (dealId: string) => ReactNode[];
}
export const CIM_PUBLISH_NOTES: PublishNoteSource[] = [
  // The data room (vdr): "The DD CIM points to {n} documents not shared with due-diligence buyers · Share
  // them" — only when there is something to say; it never blocks publishing.
  {
    key: "vdr",
    useNotes: (dealId) => {
      const room = useRoom(dealId);
      const notShared = room.data?.room ? room.data.kpis.ddCitedNotShared : 0;
      return notShared > 0 ? [<VdrPublishNote key="vdr-publish" dealId={dealId} />] : [];
    },
  },
];

/** The tile lines for a level: dd's first, then vdr's, at most 2. */
export function tileLinesFor(level: AccessLevel, all: Array<Partial<Record<AccessLevel, TileLine[]>>>): TileLine[] {
  return all.flatMap((m) => m[level] ?? []).slice(0, 2);
}
