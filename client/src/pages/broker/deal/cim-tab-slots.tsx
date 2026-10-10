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
 *
 * Filled: dd (numbers view, tile lines, Versions lines, attention row) at
 * merge step 8; vdr (tile lines, publish note) at step 6; gl (DD hold
 * notice) at step 7.
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
import { NumbersWorkspace } from "./figures/NumbersWorkspace";
import {
  FigureNotesWaitingLine, FigureVersionLines, useFigureAttention, useFigureNotesWaiting, useFigureTileLines,
} from "./figures/CimTabLines";

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

/** "Numbers & sources" inside the dashboard (the dashboard carries the header, tiles and tabs). */
function NumbersView(_props: CimTabViewProps) {
  return <NumbersWorkspace embedded />;
}

/** Extra views other streams register (dd: "numbers"). Teaser's four are built into CimTab. */
export const EXTRA_CIM_TAB_VIEWS: CimTabView[] = [
  // dd (merge step 8, C12): the fifth tab, "Numbers & sources" — why the CIM's figures moved, how they
  // compare with the tax returns, questions for the seller. Badge = notes waiting for the broker's OK.
  // Its own params (tab, note, filter, group, all) pass through the URL (PASS_THROUGH in CimTab).
  { key: "numbers", label: "Numbers & sources", useBadge: useFigureNotesWaiting, Component: NumbersView },
];
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
  // Figures (dd, merge step 8) — FIRST ("dd first, then vdr"): Blind CIM and Full CIM "+ notes on {n} figures";
  // Due diligence "+ figure checks · {k} differences shown" (or "(not shown yet)").
  { key: "dd", useLines: (dealId) => useFigureTileLines(dealId) },
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
  // Figures (dd, merge step 8) — FIRST: the Full and Blind lines ("9 figures have notes · 3 wait for your OK"),
  // the DD summary + "Review and show to buyers" + broker-only "Fix first" + the way into Numbers & sources.
  {
    key: "dd",
    useExtras: (dealId) => ({
      blind: <FigureVersionLines key="dd-blind" dealId={dealId} mode="blind" />,
      named: <FigureVersionLines key="dd-named" dealId={dealId} mode="normal" />,
      dd: <FigureVersionLines key="dd-dd" dealId={dealId} mode="dd" />,
    }),
  },
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
export const ATTENTION_GROUPS: AttentionGroupSource[] = [
  // Figures (dd, merge step 8): "{n} figure notes wait for your OK · Review" and the owner's "Change this"
  // requests — one row, counted in "Needs attention (n)". Never blocks publishing.
  {
    key: "dd",
    useGroup: (dealId) => {
      const a = useFigureAttention(dealId);
      return a.waiting + a.flagged > 0 ? { key: "dd-figures", node: <FigureNotesWaitingLine dealId={dealId} />, counts: true } : null;
    },
  },
];

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
