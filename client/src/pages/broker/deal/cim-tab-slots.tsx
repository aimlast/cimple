/**
 * The CIM tab dashboard's slots (INTEGRATION §2.8). Teaser owns the layout
 * (CimTab.tsx); other streams add to it ONLY through these registries, so
 * no contributor edits the layout:
 *
 *   CIM_TAB_VIEWS          the tabs — teaser's attention · versions · teaser ·
 *                          design; dd pushes `numbers` "Numbers & sources"
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

export interface CimTabViewProps {
  dealId: string;
  /** Switch to another view (keeps pass-through params out). */
  setView: (key: string, params?: Record<string, string>) => void;
}

export interface CimTabView {
  key: string;
  label: string;
  /** A count on the tab (e.g. notes waiting); null/0 = none. Called every render. */
  useBadge?: (dealId: string) => number | null;
  Component: ComponentType<CimTabViewProps>;
}

/** Extra views other streams register (dd: "numbers"). Teaser's four are built into CimTab. */
export const EXTRA_CIM_TAB_VIEWS: CimTabView[] = [];

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
export const ACCESS_TILE_LINES: AccessTileLineSource[] = [];

export type VersionCardKey = "blind" | "named" | "dd";
export interface VersionCardExtraSource {
  key: string;
  useExtras: (dealId: string) => Partial<Record<VersionCardKey, ReactNode>>;
}
export const VERSION_CARD_EXTRAS: VersionCardExtraSource[] = [];

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
export const CIM_PUBLISH_NOTES: PublishNoteSource[] = [];

/** The tile lines for a level: dd's first, then vdr's, at most 2. */
export function tileLinesFor(level: AccessLevel, all: Array<Partial<Record<AccessLevel, TileLine[]>>>): TileLine[] {
  return all.flatMap((m) => m[level] ?? []).slice(0, 2);
}
