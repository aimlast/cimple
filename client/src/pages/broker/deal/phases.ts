/**
 * Phase configuration shared between DealShell (horizontal stepper)
 * and OverviewTab (phase accordion).
 */
import type { Deal } from "@shared/schema";
import {
  DEAL_PHASES,
  phaseChecklist,
  phaseIndex,
  type DealProgressExtras,
  type PhaseActor,
  type PhaseItem,
} from "@shared/deal-progress";

export type { PhaseActor, PhaseItem };

/**
 * Labels, intros and checklist semantics come from shared/deal-progress.ts —
 * the same definition the deal list, dashboard and server use.
 */
export const PHASES = DEAL_PHASES.map((phase) => ({
  ...phase,
  // `extras.invited` comes from the invites query where available (OverviewTab);
  // the stepper calls without it and falls back to questionnaire evidence.
  items: (deal: Deal, extras?: DealProgressExtras): PhaseItem[] => phaseChecklist(phase.key, deal, extras),
}));

export function getPhaseIndex(key: string): number {
  return phaseIndex(key);
}

export const DOC_CATEGORIES = [
  { value: "financials", label: "Financials" },
  { value: "legal", label: "Legal" },
  { value: "marketing", label: "Marketing" },
  { value: "operations", label: "Operations" },
  { value: "transcripts", label: "Call Transcripts" },
  { value: "other", label: "Other" },
];
