/**
 * Phase configuration shared between DealShell (horizontal stepper)
 * and OverviewTab (phase accordion).
 */
import type { Deal } from "@shared/schema";

/** Who performs a checklist item — drives the badge next to each label. */
export type PhaseActor = "broker" | "seller" | "auto";

export interface PhaseItem {
  label: string;
  done: boolean;
  actor: PhaseActor;
  /** Optional items don't count toward phase completion or block advancing. */
  optional?: boolean;
}

export const PHASES = [
  {
    key: "phase1_info_collection",
    label: "Broker Prep",
    short: "Phase 1",
    intro:
      "Your prep work. Invite the seller when ready — one secure link covers their questionnaire, documents, and the AI interview. Valuation is optional here; finish it any time before the CIM.",
    // `extras.invited` comes from the invites query where available (OverviewTab);
    // the stepper calls without it and falls back to questionnaire evidence.
    items: (deal: Deal, extras?: { invited?: boolean }): PhaseItem[] => [
      { label: "Seller invited", actor: "broker", done: extras?.invited ?? !!deal.questionnaireData },
      { label: "NDA signed", actor: "broker", done: !!deal.ndaSigned },
      // Auto-reflects the seller finishing intake — no manual "mark received"
      // needed once questionnaire data exists.
      { label: "Seller questionnaire", actor: "seller", done: !!deal.questionnaireData || !!deal.sqCompleted },
      { label: "Valuation", actor: "broker", optional: true, done: !!deal.valuationCompleted },
    ],
  },
  {
    key: "phase2_platform_intake",
    label: "Seller Intake",
    short: "Phase 2",
    intro:
      "Mostly the seller's turn — they work through their invite link while you watch progress here. The public-data scrape runs on your click; the AI verifies everything with the seller.",
    items: (deal: Deal): PhaseItem[] => [
      { label: "Seller onboarding", actor: "seller", done: !!deal.questionnaireData },
      { label: "Public data scraped", actor: "auto", optional: true, done: !!deal.scrapedAt },
      { label: "AI interview", actor: "seller", done: !!deal.interviewCompleted },
    ],
  },
  {
    key: "phase3_content_creation",
    label: "Content Creation",
    short: "Phase 3",
    intro: "The AI drafts the CIM from everything collected; you review, then the seller approves.",
    items: (deal: Deal): PhaseItem[] => [
      { label: "CIM draft generated", actor: "auto", done: !!deal.cimContent },
      { label: "Broker reviewed", actor: "broker", done: !!deal.contentApprovedByBroker },
      { label: "Seller approved", actor: "seller", done: !!deal.contentApprovedBySeller },
    ],
  },
  {
    key: "phase4_design_finalization",
    label: "Design & Final",
    short: "Phase 4",
    intro: "The AI designs the visual CIM; you approve the layout, then the seller signs off.",
    items: (deal: Deal): PhaseItem[] => [
      { label: "Design generated", actor: "auto", done: !!deal.cimDesignData },
      { label: "Broker approved", actor: "broker", done: !!deal.designApprovedByBroker },
      { label: "Seller approved", actor: "seller", done: !!deal.designApprovedBySeller },
    ],
  },
] as const;

export function getPhaseIndex(key: string): number {
  return PHASES.findIndex((p) => p.key === key);
}

export const DOC_CATEGORIES = [
  { value: "financials", label: "Financials" },
  { value: "legal", label: "Legal" },
  { value: "marketing", label: "Marketing" },
  { value: "operations", label: "Operations" },
  { value: "transcripts", label: "Call Transcripts" },
  { value: "other", label: "Other" },
];
