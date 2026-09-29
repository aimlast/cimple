/**
 * seller-portal — the rules the seller's portal and the broker's view of it
 * share, so the two never tell different stories.
 *
 *  - Intake: "onboarding complete" means the seller saved the last intake
 *    page (Key People) — or the broker recorded the questionnaire as
 *    received outside Cimple. Page 1 alone used to read as complete
 *    everywhere, and the seller was sent past Systems and Key People.
 *  - The document checklist: a row the seller says they don't have
 *    ("unavailable") stops counting against them until the broker decides,
 *    so a cash café with no A/R, debt or lease can finish.
 *  - The interview's to-dos: the document requests and follow-ups the
 *    interview promised to "note so it doesn't get lost" — the ones the
 *    seller may see (never the broker's own session's, never a counsel
 *    check, never a skipped question).
 *  - The CIM review: which approval (content, then design) the seller is
 *    being asked for right now.
 *
 * Pure: used by the server (progress payload, gates) and the client.
 */

// ── Intake ───────────────────────────────────────────────────────────────

export interface IntakeInput {
  questionnaireData?: unknown;
  operationalSystems?: unknown;
  /** The Key People list (an array once saved — an empty list still counts). The deal list passes `true` for "saved". */
  employeeChart?: unknown;
  /** The seller's final intake save sets it; so does the broker's "received outside Cimple". */
  sqCompleted?: boolean | null;
  interviewCompleted?: boolean | null;
}

export interface IntakeState {
  status: "not_started" | "in_progress" | "complete";
  /** Intake pages saved (Business Basics, Systems, Key People). */
  pagesDone: number;
  pagesTotal: 3;
}

/** Something was actually typed into the questionnaire (not an empty autosave). */
function basicsFilled(q: unknown): boolean {
  if (q === true) return true; // the deal list sends "is set" as a boolean
  if (!q || typeof q !== "object") return false;
  return Object.values(q as Record<string, unknown>).some((v) => (typeof v === "string" ? v.trim() !== "" : !!v));
}

function isSet(v: unknown): boolean {
  if (v === true) return true;
  if (v === false || v == null) return false;
  if (typeof v === "object") return Object.keys(v as object).length > 0 || Array.isArray(v);
  return true;
}

/** The same rule as the intake wizard's own "done" (SellerIntake.tsx). */
export function sellerIntakeState(deal: IntakeInput): IntakeState {
  const basics = basicsFilled(deal.questionnaireData);
  // The Key People save is the wizard's last and carries every page with it
  // (an empty systems page included), so it implies page 2.
  const people = Array.isArray(deal.employeeChart) || deal.employeeChart === true;
  const systems = people || isSet(deal.operationalSystems);
  const pagesDone = (basics ? 1 : 0) + (systems ? 1 : 0) + (people ? 1 : 0);
  const complete = !!deal.sqCompleted || (basics && (people || !!deal.interviewCompleted));
  return {
    status: complete ? "complete" : pagesDone > 0 ? "in_progress" : "not_started",
    pagesDone,
    pagesTotal: 3,
  };
}

export function intakeComplete(deal: IntakeInput): boolean {
  return sellerIntakeState(deal).status === "complete";
}

// ── Document checklist ───────────────────────────────────────────────────

/**
 * "missing" | "uploaded" | "verified" | "unavailable" — the last is the
 * seller saying they don't have it (with a note for the broker). It no
 * longer counts against the seller; the broker decides (not needed, or ask
 * again).
 */
export const REQUIREMENT_STATUSES = ["missing", "uploaded", "verified", "unavailable"] as const;
export type RequirementStatus = (typeof REQUIREMENT_STATUSES)[number];

/** Statuses a seller may set on a checklist row. Only the broker verifies. */
export const SELLER_REQUIREMENT_STATUSES: readonly string[] = ["missing", "uploaded", "unavailable"];

/** The row no longer waits on the seller. */
export function requirementSettledForSeller(status: string | null | undefined): boolean {
  return status === "uploaded" || status === "verified" || status === "unavailable";
}

export interface ChecklistCounts {
  requiredTotal: number;
  requiredUploaded: number;
  /** Required rows the seller said they don't have (waiting on the broker). */
  requiredUnavailable: number;
  percentage: number;
}

export function checklistCounts(rows: Array<{ isRequired: boolean | null; status: string | null }>): ChecklistCounts {
  const required = rows.filter((r) => r.isRequired);
  const settled = required.filter((r) => requirementSettledForSeller(r.status));
  const unavailable = required.filter((r) => r.status === "unavailable").length;
  const requiredTotal = required.length;
  return {
    requiredTotal,
    requiredUploaded: settled.length - unavailable,
    requiredUnavailable: unavailable,
    // Nothing required → nothing blocks the seller.
    percentage: requiredTotal > 0 ? Math.round((settled.length / requiredTotal) * 100) : 100,
  };
}

/** The line the seller's "I don't have this" leaves in the row's notes (the broker's note stays above it). */
export const SELLER_UNAVAILABLE_PREFIX = "Seller: I don't have this";

export function withSellerUnavailableNote(notes: string | null | undefined, reason: string): string {
  const kept = withoutSellerUnavailableNote(notes);
  const why = reason.replace(/\s+/g, " ").trim().slice(0, 500);
  const line = why ? `${SELLER_UNAVAILABLE_PREFIX} — ${why}` : SELLER_UNAVAILABLE_PREFIX;
  return kept ? `${kept}\n${line}` : line;
}

export function withoutSellerUnavailableNote(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const kept = notes
    .split("\n")
    .filter((l) => !l.startsWith(SELLER_UNAVAILABLE_PREFIX))
    .join("\n")
    .trim();
  return kept || null;
}

/** The seller's reason, if the row carries one. */
export function sellerUnavailableReason(notes: string | null | undefined): string | null {
  const line = (notes ?? "").split("\n").find((l) => l.startsWith(SELLER_UNAVAILABLE_PREFIX));
  if (!line) return null;
  return line.slice(SELLER_UNAVAILABLE_PREFIX.length).replace(/^\s*—\s*/, "").trim();
}

// ── The interview's to-dos ───────────────────────────────────────────────

export interface TaskLike {
  id: string;
  type: string;
  title: string;
  description?: string | null;
  status: string;
  createdBy?: string | null;
  priority?: string | null;
  relatedField?: string | null;
  createdAt?: Date | string | null;
}

export const OPEN_TASK_STATUSES: readonly string[] = ["pending", "in_progress"];
export const isOpenTask = (t: Pick<TaskLike, "status">) => OPEN_TASK_STATUSES.includes(t.status);

/** Who writes interview tasks (session-mode.ts BROKER_SESSION_TASK_CREATOR is the broker's own session). */
const SELLER_INTERVIEW_CREATOR = "ai_interview";
/** The legal-grounding guard's title prefix (task-writes.ts COUNSEL_TASK_PREFIX) — the broker's to settle. */
const COUNSEL_PREFIX = "Verify with counsel: ";
/** The seller's "request changes" on the CIM review — a note for the broker. */
export const SELLER_REVIEW_TASK_CREATOR = "seller_review";

const OPEN_ITEM_CREATORS = new Set([SELLER_INTERVIEW_CREATOR, "ai_interview_broker", SELLER_REVIEW_TASK_CREATOR]);
// (A document request is keyed by the document it names — "Get the lease" and
// "Upload the lease" are one item, as on the seller's list.)
const openItemKey = (t: TaskLike) =>
  `${t.createdBy}|${t.type}|${(t.type === "document_request" ? documentRequestLabel(t.title) : t.title).trim().toLowerCase()}`;
const isOpenItem = (t: TaskLike) => isOpenTask(t) && OPEN_ITEM_CREATORS.has(String(t.createdBy ?? ""));

/** Everything the interview (seller's or broker's session) and the seller's review left open — the broker's list. */
export function openInterviewItems<T extends TaskLike>(tasks: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const t of [...tasks].sort((a, b) => time(a.createdAt) - time(b.createdAt))) {
    if (!isOpenItem(t)) continue;
    const k = openItemKey(t);
    if (seen.has(k)) continue; // earlier turns re-created it
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Every open task the listed item stands for (the item plus copies an
 * earlier turn re-created) — closing the item closes them all, so a copy
 * never pops up in its place.
 */
export function openItemTaskIds(tasks: TaskLike[], item: TaskLike): string[] {
  const k = openItemKey(item);
  const ids = tasks.filter((t) => isOpenItem(t) && openItemKey(t) === k).map((t) => t.id);
  return ids.includes(item.id) ? ids : [item.id, ...ids];
}

function time(v: Date | string | null | undefined): number {
  const n = v ? new Date(v).getTime() : 0;
  return Number.isFinite(n) ? n : 0;
}

export interface SellerTodoItem {
  id: string;
  kind: "document" | "follow_up";
  /** Written for the seller: "Template employment agreement", "Confirm WCB billing audit history". */
  title: string;
}

/** "Get template employment agreement" → "Template employment agreement" (a document row names the document). */
export function documentRequestLabel(title: string): string {
  const t = title
    .trim()
    .replace(/^(?:please\s+)?(?:get|obtain|request|collect|upload|send|provide|share|forward)\s+(?:(?:a|the)\s+)?(?:copy\s+of\s+(?:the\s+)?|copies\s+of\s+(?:the\s+)?)?/i, "")
    .trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : title.trim();
}

/**
 * What the seller is asked to do: the seller interview's open document
 * requests and follow-ups. Titles only — the task descriptions are written
 * for the broker ("Seller mentioned Kyle…").
 */
export function sellerTodoItems(tasks: TaskLike[]): SellerTodoItem[] {
  const out: SellerTodoItem[] = [];
  const seen = new Set<string>();
  for (const t of [...tasks].sort((a, b) => time(a.createdAt) - time(b.createdAt))) {
    if (!isOpenTask(t) || t.createdBy !== SELLER_INTERVIEW_CREATOR) continue;
    if (t.title.startsWith(COUNSEL_PREFIX)) continue;
    if (t.type !== "document_request" && t.type !== "follow_up") continue;
    const kind = t.type === "document_request" ? "document" : "follow_up";
    const title = kind === "document" ? documentRequestLabel(t.title) : t.title.trim();
    const k = `${kind}|${title.toLowerCase()}`;
    if (!title || seen.has(k)) continue;
    seen.add(k);
    out.push({ id: t.id, kind, title });
  }
  return out;
}

/** May a seller upload satisfy this task? (An open document request of the seller's interview.) */
export function sellerMaySatisfyTask(t: TaskLike | undefined | null, dealId: string, taskDealId: string | undefined): boolean {
  return !!t && taskDealId === dealId && t.type === "document_request" && t.createdBy === SELLER_INTERVIEW_CREATOR && isOpenTask(t);
}

// ── Steps on the seller's progress page ──────────────────────────────────

export type SellerStepId = "intake" | "interview" | "documents" | "review";

export interface SellerStepsInput {
  intake: IntakeState;
  interviewCompleted: boolean;
  interviewPct: number;
  docPct: number;
}

export function sellerSteps(x: SellerStepsInput): {
  currentStep: SellerStepId;
  steps: Array<{ id: SellerStepId; label: string; status: "completed" | "current" | "upcoming"; pct?: number }>;
} {
  const intakeDone = x.intake.status === "complete";
  let currentStep: SellerStepId = "intake";
  if (intakeDone && !x.interviewCompleted) currentStep = "interview";
  else if (intakeDone && x.interviewCompleted && x.docPct < 100) currentStep = "documents";
  else if (intakeDone && x.interviewCompleted && x.docPct >= 100) currentStep = "review";
  // (A finished conversation with an unfinished intake still asks for the intake first.)
  const status = (id: SellerStepId, done: boolean) => (done ? "completed" as const : currentStep === id ? "current" as const : "upcoming" as const);
  return {
    currentStep,
    steps: [
      { id: "intake", label: "Business Info", status: status("intake", intakeDone), pct: Math.round((x.intake.pagesDone / x.intake.pagesTotal) * 100) },
      { id: "interview", label: "Business Overview", status: status("interview", x.interviewCompleted), pct: x.interviewPct },
      { id: "documents", label: "Documents", status: status("documents", x.docPct >= 100), pct: x.docPct },
      { id: "review", label: "Review", status: currentStep === "review" ? "current" : "upcoming" },
    ],
  };
}

// ── The seller's CIM review ──────────────────────────────────────────────

export interface ReviewInput {
  contentApprovedByBroker?: boolean | null;
  contentApprovedBySeller?: boolean | null;
  designApprovedByBroker?: boolean | null;
  designApprovedBySeller?: boolean | null;
}

/**
 * Which approval the seller is asked for now:
 *  - "not_ready": the broker hasn't approved anything yet — the seller sees nothing;
 *  - "content" / "design": the broker approved it, the seller hasn't;
 *  - "waiting": the seller approved the content, the broker is on the design;
 *  - "approved": the seller approved the design (the last step before publishing).
 */
export type SellerReviewStage = "not_ready" | "content" | "design" | "waiting" | "approved";

export function sellerReviewStage(d: ReviewInput): SellerReviewStage {
  if (d.designApprovedByBroker) return d.designApprovedBySeller ? "approved" : "design";
  if (d.contentApprovedByBroker) return d.contentApprovedBySeller ? "waiting" : "content";
  return "not_ready";
}

/** The deal column the seller's approval at this stage sets. */
export function sellerApprovalField(stage: SellerReviewStage): "contentApprovedBySeller" | "designApprovedBySeller" | null {
  return stage === "content" ? "contentApprovedBySeller" : stage === "design" ? "designApprovedBySeller" : null;
}
