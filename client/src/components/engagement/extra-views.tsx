/**
 * Views other streams plug into the deal's Engagement tab (Teaser, Data
 * room). The integrator registers them after those streams land:
 *
 *   EXTRA_ENGAGEMENT_VIEWS.push(
 *     { key: "teaser", label: "Teaser", useAvailable: useDealHasTeaser, filters: [],
 *       Component: ({ dealId }) => <TeaserEngagementPanel dealId={dealId} /> },
 *     { key: "data-room", label: "Data room", useAvailable: useDealHasDataRoom, filters: [],
 *       Component: ({ dealId }) => <DataRoomActivity dealId={dealId} variant="engagement" /> },
 *   );
 *
 * The shell shows a view's tab only when its `useAvailable(dealId)` is true
 * (a React hook: the list never changes after the app loads, so the shell
 * calls each one on every render), passes `{ dealId, filters }`, and shows
 * only the filters the view declares (none by default).
 */
import type { FC } from "react";
import type { EngagementFilters } from "@shared/analytics-v2";
import { useDealHasTeaser } from "@/components/teaser/useTeaserSummary";
import { TeaserEngagementPanel } from "@/components/teaser/TeaserEngagementPanel";

export type EngagementFilterKey = "buyers" | "when" | "device" | "version";

export interface ExtraEngagementView {
  /** The `?view=` value. */
  key: string;
  label: string;
  /** Below 640 px. */
  shortLabel?: string;
  /** Whether this deal has anything for the view (a React hook). */
  useAvailable(dealId: string): boolean;
  /** The filter bar's controls this view uses (default: none). */
  filters?: EngagementFilterKey[];
  Component: FC<{ dealId: string; filters: EngagementFilters }>;
}

/**
 * Registered by the integrator (INTEGRATION §2.9), in this order:
 *   teaser     at the analytics merge (step 4): a published teaser or any teaser link
 *   data-room  at the vdr merge (step 6)
 */
export const EXTRA_ENGAGEMENT_VIEWS: ExtraEngagementView[] = [
  {
    key: "teaser",
    label: "Teaser",
    useAvailable: useDealHasTeaser,
    filters: [],
    Component: ({ dealId }) => <TeaserEngagementPanel dealId={dealId} />,
  },
];
