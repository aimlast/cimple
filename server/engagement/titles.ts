/**
 * titles — one rule for what the broker sees as a heat-map page's title
 * (broker side; pure).
 *
 * A page is titled from the page ITSELF, never from a section that
 * continues it after a regeneration. Pacific (2026-10-09): buyers read the
 * kept copy, whose pages keep the old section ids; the old lookup ("the
 * live section with this id, else the one continuing its lineage") put the
 * draft's "Working Capital Summary" over the page buyers saw as "Capital
 * Expenditures & Fleet Replacement" (a wrong lineage link), and "Business
 * Overview" over "Business Model & Service Lines" (a right one).
 *
 * Order:
 *   1. the disclaimer and contact pages → the served title;
 *   2. a NAMED version (normal or DD) → its own served title: exactly what
 *      those buyers saw (on a live CIM that is the approved version, never a
 *      draft rename);
 *   3. a BLIND version → the named title of the same page id, from the kept
 *      copy → a stored named version → the title named buyers are served
 *      now (namedNow) → the live row → the served (redacted) title.
 *
 * `update` says what the current CIM does with a page that is no longer a
 * current section (a kept copy or an older version): renamed, or no
 * successor. Used by facts.ts assembleFacts, routes/engagement.ts
 * (realTitles) and benchmarks.ts (the page role).
 */
import type { CimMode, RenditionPage } from "@shared/analytics-v2";
import { CONTACT_PAGE_ID, DISCLAIMER_PAGE_ID, headingKey } from "@shared/cim-blocks";

export interface TitleSection {
  id: string;
  sectionKey: string;
  sectionTitle: string;
}

export interface TitleSources {
  live: ReadonlyArray<TitleSection & { analyticsLineage?: string | null }>;
  /** The kept copy's sections (id, key, title) — projected in SQL, never the whole row. Null when none. */
  kept: ReadonlyArray<TitleSection> | null;
  /** pageId → servedTitle from the newest stored NAMED rendition(s) of the deal (page_index only). */
  namedServed: ReadonlyMap<string, string>;
  /** Live section id → its title as named buyers are served it now. Only loaded when needed. */
  namedNow: ReadonlyMap<string, string> | null;
}

export interface PageTitle {
  title: string;
  /** For pageRole. */
  sectionKey: string | null;
  source: "served" | "kept_copy" | "named_version" | "served_now" | "section";
  /** What the current CIM does with this page (null when the page IS a current section, or nothing changed). */
  update: { status: "renamed"; title: string } | { status: "no_successor" } | null;
}

/** Title sources with nothing but the live sections (tests, callers with nothing else on hand). */
export function liveTitleSources(live: TitleSources["live"]): TitleSources {
  return { live, kept: null, namedServed: new Map(), namedNow: null };
}

const isBrokeragePage = (pageId: string) => pageId === DISCLAIMER_PAGE_ID || pageId === CONTACT_PAGE_ID;

/** Indexes over the sources (build once per facts load: pageTitle is called per page). */
export interface TitleIndex {
  liveById: Map<string, TitleSources["live"][number]>;
  liveByLineage: Map<string, TitleSources["live"][number]>;
  keptById: Map<string, TitleSection>;
  src: TitleSources;
}

export function titleIndex(src: TitleSources): TitleIndex {
  const liveById = new Map(src.live.map((s) => [s.id, s]));
  const liveByLineage = new Map<string, TitleSources["live"][number]>();
  for (const s of src.live) liveByLineage.set(s.analyticsLineage || s.id, s);
  const keptById = new Map((src.kept ?? []).map((s) => [s.id, s]));
  return { liveById, liveByLineage, keptById, src };
}

/** The page's title for the broker (see the order above). */
export function pageTitle(
  p: Pick<RenditionPage, "pageId" | "lineageId" | "servedTitle">,
  mode: CimMode,
  src: TitleSources | TitleIndex,
): PageTitle {
  const ix = "liveById" in src ? src : titleIndex(src);
  const kept = ix.keptById.get(p.pageId);
  const live = ix.liveById.get(p.pageId);
  const sectionKey = kept?.sectionKey ?? live?.sectionKey ?? null;
  let title: string;
  let source: PageTitle["source"];
  if (isBrokeragePage(p.pageId) || mode !== "blind") {
    title = p.servedTitle;
    source = "served";
  } else if (kept?.sectionTitle) {
    title = kept.sectionTitle;
    source = "kept_copy";
  } else if (ix.src.namedServed.get(p.pageId)) {
    title = ix.src.namedServed.get(p.pageId)!;
    source = "named_version";
  } else if (ix.src.namedNow?.get(p.pageId)) {
    title = ix.src.namedNow.get(p.pageId)!;
    source = "served_now";
  } else if (live?.sectionTitle) {
    title = live.sectionTitle;
    source = "section";
  } else {
    title = p.servedTitle;
    source = "served";
  }
  return { title, sectionKey, source, update: pageUpdate(p, title, ix) };
}

/** What the current CIM did with a page that isn't a current section. */
function pageUpdate(p: Pick<RenditionPage, "pageId" | "lineageId">, title: string, ix: TitleIndex): PageTitle["update"] {
  if (isBrokeragePage(p.pageId) || ix.liveById.has(p.pageId)) return null;
  const next = ix.liveByLineage.get(p.lineageId);
  if (!next) return { status: "no_successor" };
  return headingKey(next.sectionTitle) !== headingKey(title) ? { status: "renamed", title: next.sectionTitle } : null;
}

/**
 * Whether a blind version needs `namedNow` (some page isn't in the kept copy
 * or a stored named version) — the one extra read is skipped otherwise.
 */
export function needsNamedNow(pages: ReadonlyArray<Pick<RenditionPage, "pageId">>, mode: CimMode, src: Pick<TitleSources, "kept" | "namedServed">): boolean {
  if (mode !== "blind") return false;
  const kept = new Set((src.kept ?? []).map((s) => s.id));
  return pages.some((p) => !isBrokeragePage(p.pageId) && !kept.has(p.pageId) && !src.namedServed.has(p.pageId));
}
