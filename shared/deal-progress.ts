/**
 * Deal progress — the ONE definition of a deal's phases, its per-phase
 * checklist and "what happens next / whose move is it".
 *
 * Pure and shared: the deal page (stepper + Overview checklist), the deal
 * list, the broker dashboard and the server's list endpoint all read from
 * here, so a deal can never say "Needs your action" in one place and
 * "Waiting on the seller" in another.
 */
import type { Deal } from "./schema";

/* ─── Phases ─────────────────────────────────────────────────────────── */

export const DEAL_PHASES = [
  {
    key: "phase1_info_collection",
    step: 1,
    label: "Broker Prep",
    short: "Phase 1",
    intro:
      "Your prep work. Invite the seller when ready — one secure link covers their questionnaire, documents, and the AI interview. Valuation is optional here; finish it any time before the CIM.",
  },
  {
    key: "phase2_platform_intake",
    step: 2,
    label: "Seller Intake",
    short: "Phase 2",
    intro:
      "Mostly the seller's turn — they work through their invite link while you watch progress here. The public-data scrape runs on your click; the AI verifies everything with the seller.",
  },
  {
    key: "phase3_content_creation",
    step: 3,
    label: "Content Creation",
    short: "Phase 3",
    intro: "The AI drafts the CIM from everything collected; you review, then the seller approves.",
  },
  {
    key: "phase4_design_finalization",
    step: 4,
    label: "Design & Final",
    short: "Phase 4",
    intro: "The AI designs the visual CIM; you approve the layout, then the seller signs off.",
  },
] as const;

export type DealPhaseKey = (typeof DEAL_PHASES)[number]["key"];
export const DEAL_PHASE_COUNT = DEAL_PHASES.length;

/** 0-based index of a phase key; -1 for an unknown value. */
export function phaseIndex(key: string | null | undefined): number {
  return DEAL_PHASES.findIndex((p) => p.key === key);
}

export function isDealPhase(key: unknown): key is DealPhaseKey {
  return typeof key === "string" && phaseIndex(key) >= 0;
}

/** Broker-facing label ("Content Creation"); a readable fallback for unknown keys. */
export function phaseLabel(key: string | null | undefined): string {
  return DEAL_PHASES.find((p) => p.key === key)?.label ?? "Unknown phase";
}

/** 1–4, or 0 for an unknown phase. */
export function phaseStep(key: string | null | undefined): number {
  return DEAL_PHASES.find((p) => p.key === key)?.step ?? 0;
}

/* ─── Inputs ─────────────────────────────────────────────────────────── */

/**
 * The deal fields progress depends on. A full `Deal` satisfies it; the
 * server's slim list query passes booleans for the large JSON columns
 * (only their presence matters here).
 */
export type DealProgressInput = Pick<
  Deal,
  | "id"
  | "phase"
  | "isLive"
  | "ndaSigned"
  | "ndaSentAt"
  | "sqCompleted"
  | "valuationCompleted"
  | "interviewCompleted"
  | "contentApprovedByBroker"
  | "contentApprovedBySeller"
  | "designApprovedByBroker"
  | "designApprovedBySeller"
  | "cimLayoutGeneratedAt"
  | "scrapedAt"
> & {
  questionnaireData?: unknown;
  cimContent?: unknown;
  cimDesignData?: unknown;
};

/**
 * Facts that live outside the deal row. Every field is optional: callers
 * that don't have one get the same conservative fallback the Overview
 * checklist always used (e.g. "invited" falls back to questionnaire evidence).
 */
export interface DealProgressExtras {
  /** A seller invite exists for the deal. */
  invited?: boolean;
  /** The seller (or broker, together) has opened the AI interview at least once. */
  interviewStarted?: boolean;
  /** Generated CIM sections exist (layout-only generation doesn't set cimContent). */
  hasCimSections?: boolean;
  /** A CIM generation job is running right now. */
  cimGenerating?: boolean;
  /** Critical discrepancies still open — they block generation, approvals and publish. */
  openCriticalDiscrepancies?: number;
  /** Buyers whose link is active (not revoked, not expired). */
  buyersWithAccess?: number;
  /** Buyers who opened the CIM and haven't decided yet. */
  buyersViewing?: number;
  /** Information quality (0–100, shared/cim-readiness). Unknown → the interview decides. */
  readinessScore?: number | null;
}

/* ─── Can the AI write the CIM now? ──────────────────────────────────── */

/**
 * Information quality a deal needs before the AI writes a whole CIM when the
 * seller interview hasn't been completed: "Developing" or better on the
 * readiness score (shared/cim-readiness). Below it the CIM would be mostly
 * placeholders.
 */
export const CIM_GENERATION_MIN_READINESS = 35;

export interface CimGenerationGate {
  allowed: boolean;
  /** Still waiting for the readiness score (client only) — keep Generate off, no message. */
  pending: boolean;
  /** Plain-words reason when not allowed. */
  reason: string | null;
}

/**
 * THE rule for "can the AI write (or rewrite) the whole CIM now?" — used by
 * the Overview, the CIM tab, the CIM builder, computeNextStep and enforced by
 * the server on generate-content / generate-layout.
 *
 * The interview is not required: brokers now collect information through
 * calls, CRM, documents and the Information tab too. What's required is
 * enough information — a completed interview, or a readiness score of
 * CIM_GENERATION_MIN_READINESS or more from any mix of sources. Critical
 * discrepancies are a separate gate (with its own load-error handling).
 */
export function cimGenerationGate(
  deal: Pick<DealProgressInput, "interviewCompleted">,
  readinessScore: number | null | undefined,
): CimGenerationGate {
  if (deal.interviewCompleted) return { allowed: true, pending: false, reason: null };
  if (readinessScore === null || readinessScore === undefined) return { allowed: false, pending: true, reason: null };
  if (readinessScore >= CIM_GENERATION_MIN_READINESS) return { allowed: true, pending: false, reason: null };
  return {
    allowed: false,
    pending: false,
    reason:
      `Not enough information to write a CIM yet (information quality ${readinessScore}/100). ` +
      "Finish the seller interview, or add documents, calls or facts on the Information tab.",
  };
}

/* ─── Checklist (drives the Overview accordion + stepper) ────────────── */

/** Who performs a checklist item — drives the badge next to each label. */
export type PhaseActor = "broker" | "seller" | "auto";

export interface PhaseItem {
  label: string;
  done: boolean;
  actor: PhaseActor;
  /** Optional items don't count toward phase completion or block advancing. */
  optional?: boolean;
}

const hasQuestionnaire = (d: DealProgressInput) => !!d.questionnaireData || !!d.sqCompleted;
/** A CIM draft exists: content generation sets cimContent, layout-only
 *  generation (Designer) stamps cimLayoutGeneratedAt; sections prove either. */
const hasCimDraft = (d: DealProgressInput, x?: DealProgressExtras) =>
  !!d.cimContent || !!d.cimLayoutGeneratedAt || !!x?.hasCimSections;

export function phaseChecklist(
  phaseKey: string,
  deal: DealProgressInput,
  extras?: DealProgressExtras,
): PhaseItem[] {
  switch (phaseKey) {
    case "phase1_info_collection":
      return [
        // Without the invites query (the stepper) fall back to questionnaire evidence.
        { label: "Seller invited", actor: "broker", done: extras?.invited ?? !!deal.questionnaireData },
        { label: "NDA signed", actor: "broker", done: !!deal.ndaSigned },
        // Auto-reflects the seller finishing intake — no manual "mark received"
        // needed once questionnaire data exists.
        { label: "Seller questionnaire", actor: "seller", done: hasQuestionnaire(deal) },
        { label: "Valuation", actor: "broker", optional: true, done: !!deal.valuationCompleted },
      ];
    case "phase2_platform_intake":
      return [
        { label: "Seller onboarding", actor: "seller", done: !!deal.questionnaireData },
        { label: "Public data scraped", actor: "auto", optional: true, done: !!deal.scrapedAt },
        { label: "AI interview", actor: "seller", done: !!deal.interviewCompleted },
      ];
    case "phase3_content_creation":
      return [
        { label: "CIM draft generated", actor: "auto", done: hasCimDraft(deal, extras) },
        { label: "Broker reviewed", actor: "broker", done: !!deal.contentApprovedByBroker },
        { label: "Seller approved", actor: "seller", done: !!deal.contentApprovedBySeller },
      ];
    case "phase4_design_finalization":
      return [
        // Content generation already lays the CIM out visually (the layout
        // engine is one pass), so on a normal deal this is ticked on arrival.
        // It stays as an "auto" row for legacy text-only CIMs; computeNextStep
        // never reports it as anyone's move while a draft exists.
        { label: "Visual layout", actor: "auto", done: hasCimDraft(deal, extras) || !!deal.cimDesignData },
        { label: "Broker approved", actor: "broker", done: !!deal.designApprovedByBroker },
        { label: "Seller approved", actor: "seller", done: !!deal.designApprovedBySeller },
      ];
    default:
      return [];
  }
}

/* ─── Next step ──────────────────────────────────────────────────────── */

export type NextStepOwner = "you" | "seller" | "buyers" | "none";

export interface NextStep {
  /** Short phrase without the owner prefix: "review the CIM content", "questionnaire". */
  label: string;
  owner: NextStepOwner;
  /** Where in the app the step is done. */
  href?: string;
}

/**
 * What happens next on a deal and whose move it is. Walks the same
 * checklist as the Overview accordion, in order, for the deal's current
 * phase only (steps of earlier phases are never re-raised — a phase-3 deal
 * whose broker ran the interview in person isn't told to invite the seller).
 * The optional valuation is never anyone's move.
 */
export function computeNextStep(deal: DealProgressInput, extras: DealProgressExtras = {}): NextStep {
  const base = `/deal/${deal.id}`;
  const overview = `${base}/overview`;
  const buyers = `${base}/buyers`;
  const designer = `${base}/design`;
  const you = (label: string, href = overview): NextStep => ({ label, owner: "you", href });
  const seller = (label: string, href = overview): NextStep => ({ label, owner: "seller", href });

  if (deal.isLive) {
    const withAccess = extras.buyersWithAccess ?? 0;
    const viewing = extras.buyersViewing ?? 0;
    if (withAccess === 0) return you("give buyers access", buyers);
    return {
      owner: "buyers",
      href: buyers,
      label: viewing > 0
        ? `Live with buyers · ${viewing} viewing`
        : `Live with buyers · ${withAccess} with access, none opened yet`,
    };
  }

  const invited = extras.invited ?? !!deal.questionnaireData;
  const openCritical = extras.openCriticalDiscrepancies ?? 0;
  const conflicts = () =>
    you(`resolve ${openCritical} conflicting fact${openCritical === 1 ? "" : "s"}`);
  const interviewStep = () =>
    seller(extras.interviewStarted ? "AI interview (in progress)" : "AI interview (not started yet)");

  switch (deal.phase) {
    case "phase1_info_collection": {
      if (!invited) return you("invite the seller");
      if (!deal.ndaSigned) return deal.ndaSentAt ? seller("NDA signature") : you("get the NDA signed");
      if (!hasQuestionnaire(deal)) return seller("questionnaire");
      return you("move the deal to Seller Intake");
    }
    case "phase2_platform_intake": {
      if (!deal.interviewCompleted) {
        if (!invited && !extras.interviewStarted) return you("invite the seller");
        if (!hasQuestionnaire(deal) && !extras.interviewStarted) return seller("questionnaire");
        return interviewStep();
      }
      return you("start content creation");
    }
    case "phase3_content_creation": {
      if (!hasCimDraft(deal, extras)) {
        if (extras.cimGenerating) return { label: "Cimple is writing the CIM", owner: "none", href: overview };
        // Same rule as the Generate buttons: a finished interview OR enough
        // information from any source. With no seller in the loop yet the
        // broker's move is to add information (or invite the seller).
        if (!cimGenerationGate(deal, extras.readinessScore).allowed) {
          if (!invited && !extras.interviewStarted) return you("add information or invite the seller", `${base}/information`);
          return interviewStep();
        }
        if (openCritical > 0) return conflicts();
        return you("generate the CIM");
      }
      if (extras.cimGenerating) return { label: "Cimple is rewriting the CIM", owner: "none", href: overview };
      if (!deal.contentApprovedByBroker) return you("review the CIM content");
      if (!deal.contentApprovedBySeller) return seller("content approval");
      if (openCritical > 0) return conflicts();
      return you("move the deal to Design");
    }
    case "phase4_design_finalization": {
      if (extras.cimGenerating) return { label: "Cimple is laying out the CIM", owner: "none", href: designer };
      if (!hasCimDraft(deal, extras) && !deal.cimDesignData) return you("generate the design", designer);
      if (!deal.designApprovedByBroker) return you("approve the design");
      if (!deal.designApprovedBySeller) return seller("design sign-off");
      if (openCritical > 0) return conflicts();
      return you("publish to buyers");
    }
    default:
      return you("open the deal");
  }
}

/** The full sentence for a next step: "Your move: review the CIM content". */
export function nextStepText(step: NextStep): string {
  switch (step.owner) {
    case "you":
      return `Your move: ${step.label}`;
    case "seller":
      return `Waiting on the seller: ${step.label}`;
    default:
      return step.label;
  }
}

/** Plain-words name of each owner, for group headers and badges. */
export const NEXT_STEP_OWNER_LABELS: Record<NextStepOwner, string> = {
  you: "Your move",
  seller: "Waiting on the seller",
  buyers: "With buyers",
  none: "Cimple is working",
};
