/**
 * Phase configuration shared between DealShell (horizontal stepper)
 * and OverviewTab (phase accordion).
 */
import type { Deal } from "@shared/schema";

export const PHASES = [
  {
    key: "phase1_info_collection",
    label: "Info Collection",
    short: "Phase 1",
    items: (deal: Deal) => [
      { label: "NDA signed", done: !!deal.ndaSigned },
      { label: "Seller questionnaire", done: !!deal.sqCompleted },
      { label: "Valuation", done: !!deal.valuationCompleted },
    ],
  },
  {
    key: "phase2_platform_intake",
    label: "Platform Intake",
    short: "Phase 2",
    items: (deal: Deal) => [
      { label: "Onboarding complete", done: !!deal.questionnaireData },
      { label: "AI interview", done: !!deal.interviewCompleted },
    ],
  },
  {
    key: "phase3_content_creation",
    label: "Content Creation",
    short: "Phase 3",
    items: (deal: Deal) => [
      { label: "CIM draft generated", done: !!deal.cimContent },
      { label: "Broker reviewed", done: !!deal.contentApprovedByBroker },
      { label: "Seller approved", done: !!deal.contentApprovedBySeller },
    ],
  },
  {
    key: "phase4_design_finalization",
    label: "Design & Final",
    short: "Phase 4",
    items: (deal: Deal) => [
      { label: "Design generated", done: !!deal.cimDesignData },
      { label: "Broker approved", done: !!deal.designApprovedByBroker },
      { label: "Seller approved", done: !!deal.designApprovedBySeller },
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
