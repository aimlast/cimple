/**
 * Props contract between the Engagement tab shell (viewer stream) and the
 * two views it hosts: Buyers (intelligence stream) and Document (viewer
 * stream). Both views receive the same filters and navigation callbacks,
 * so a buyer card's "See where they read" opens the Document view filtered
 * to that buyer, and a page link in a journey opens that page.
 */
import type { EngagementFilters } from "@shared/analytics-v2";

/**
 * The shell's views: Buyers, Where they read (document), Activity, plus any
 * registered extra view (extra-views.tsx: Teaser, Data room). Every reader of
 * `?view=` validates it against the known keys and the views available for
 * the deal (components/analytics/url.ts resolveEngagementView).
 */
export type EngagementView = "buyers" | "document" | "activity" | (string & {});

export interface EngagementNav {
  /** Open the Document view, optionally on one page (pageId + part) and/or filtered to one buyer. */
  openDocument(opts?: { accessId?: string; pageId?: string; part?: number }): void;
  /** Open the journey drawer (visits, path, key moments) for one buyer. */
  openJourney(accessId: string): void;
}

export interface EngagementViewProps {
  dealId: string;
  filters: EngagementFilters;
  onFiltersChange(next: EngagementFilters): void;
  nav: EngagementNav;
}
