/**
 * figure-workspace — the broker's "Numbers & sources" payload
 * (GET /api/deals/:id/figures, spec §5.2–5.3) and the pure helpers its
 * screens share (filters, the review sheet's ticks). Broker-only: nothing
 * here is ever sent to a buyer or the seller.
 */
import type { CheckState } from "./figure-states";
import type { DiffSize } from "./figure-compare";
import type { FigureBuildStatus, FigureNoteEvent } from "./schema";

export interface WorkspaceSource {
  kind: string;
  /** "Warehouse lease", "The owner, in the interview", "Your resolution note (internal)", "Worked out". */
  label: string;
  quote?: string | null;
  page?: number | null;
  documentId?: string | null;
  /** The broker's link to open the document (never sent to buyers or the seller). */
  href?: string | null;
  internal?: boolean;
}

export interface WorkspaceNote {
  id: string;
  /** updated_at as read (compare-and-set on save). */
  version: string;
  kind: "movement" | "difference" | "context";
  compareKey: string;
  origin: "computed" | "ai" | "broker";
  status: "suggested" | "approved" | "hidden";
  text: string;
  blindText: string | null;
  staleReason: string | null;
  sellerComment: string | null;
  /** One-line chips for the "Based on" column ("Lease", "Worked out"), with the full title for the tooltip. */
  chips: Array<{ label: string; title: string }>;
  sources: WorkspaceSource[];
  proposal: { text: string; blindText: string | null; at: string } | null;
  history: FigureNoteEvent[];
  /** Rests only on the broker's internal resolution note (never bulk-approved). */
  internalOnly: boolean;
  fingerprint: string;
}

/**
 * shown          approved, and buyers of at least one version read it now
 * after_publish  approved; buyers read it once you publish the update (they read the kept copy now)
 * not_served     approved, but no page buyers read carries it (e.g. a line inside a total, with the DD checks off)
 */
export type MoveStatus = "shown" | "after_publish" | "not_served" | "waiting" | "none" | "hidden" | "stale_figures" | "stale_seller" | "held";

/** Where a figure is: on a page buyers read · only in the update (not published yet) · inside a total on no page. */
export type FigurePlace = "page" | "update_only" | "inside_total";

export interface WorkspaceAnswer {
  text: string;
  /** "From the interview, Oct 3" / "From Interview together, Oct 3" / "From you". */
  from: string;
}

export interface WorkspaceMove {
  figureKey: string;
  label: string;
  year: string;
  fromYear: string | null;
  from: number | null;
  to: number;
  delta: number | null;
  pct: string | null;
  /** The CIM buyers read shows this figure itself (else it is a line inside a total, or only in the update). */
  shown: boolean;
  place: FigurePlace;
  status: MoveStatus;
  /** not_served: why buyers don't read it ("Shows to due-diligence buyers once the checks are on"). */
  unservedWhy?: string;
  /**
   * A derived total or a tax line with nothing for the broker to do (no note, no hint, nothing to
   * ask): folded behind "Show all figures" and left out of the "Changes explained" count.
   */
  folded: boolean;
  note: WorkspaceNote | null;
  hint: string | null;
  question: { id: string; status: string } | null;
  /** The seller's answer under the question's capture key, when there is one. */
  answer: WorkspaceAnswer | null;
  askable: boolean;
  /** D9a: the year whose CIM figures don't match the statements. */
  heldYear?: string;
}

export type CheckGroup = "difference" | "regrouped" | "needs_checking" | "match" | "left_out";

export interface WorkspaceCheck {
  checkKey: string;
  figureKey: string;
  label: string;
  year: string;
  kind: "tax_return" | "management" | "restated";
  otherLabel: string;
  /** The figure this CIM shows. */
  thisCim: number;
  /** What the other record is compared with (the statements as issued, else this CIM). */
  base: number;
  other: number;
  difference: number;
  pct: string | null;
  sourceLabel: string | null;
  state: CheckState;
  size: DiffSize;
  located: boolean;
  decision: "shown" | "left_out" | "corrected" | null;
  /** The other record's figure is the one you entered ("Cimple read it wrong") — "Your figure". */
  corrected: boolean;
  leftOutReason: string | null;
  regroupedText: string | null;
  note: WorkspaceNote | null;
  group: CheckGroup;
  /** Shown to due-diligence buyers now — read from what they are actually served. */
  shownToBuyers: boolean;
  /** Not shown now; shows to due-diligence buyers once you publish the update. */
  afterPublish: boolean;
  /** The figure is on a page due-diligence buyers read now (else only in the update). */
  onBuyerPage: boolean;
  preTicked: boolean;
  /** Why it can't be shown (needs checking, a CIM mismatch). */
  refusal: string | null;
  baseDocument: { id: string; name: string; href: string | null } | null;
  otherDocument: { id: string; name: string; href: string | null } | null;
  notLocatedMessage: string | null;
}

export interface WorkspaceQuestion {
  id: string;
  figureKey: string;
  label: string;
  question: string;
  /** The question with its numbers, as the seller reads it. */
  display: string;
  status: "suggested" | "ask_seller" | "answered" | "asked" | "closed";
  routedAt: string | null;
  routedBy: string | null;
  raisedAt: string | null;
  closedReason: string | null;
  captureKey: string;
  answer: WorkspaceAnswer | null;
}

export interface FixFirstItem {
  id: string;
  kind: "mismatch" | "not_located";
  message: string;
  year?: string;
  documentId?: string;
  documentName?: string;
  documentHref?: string | null;
  checkKey?: string;
}

export interface WorkspaceServedSummary { checked: number; matching: number; regrouped: number; differing: number; explained: number }

export interface WorkspaceServedVersion {
  /** Notes buyers of this version read now. */
  notes: number;
  /** More notes they read once you publish the update. */
  afterPublish: number;
  /** The Blind CIM's notes were held back by the identity check (why). */
  dropped: string | null;
}

/** What each version serves now (from the sections buyers are actually served). */
export interface WorkspaceServed {
  /** Buyers read the kept copy of the live CIM while the update waits for you. */
  keptCopy: boolean;
  /** The CIM is held from every buyer. */
  held: boolean;
  normal: WorkspaceServedVersion;
  blind: WorkspaceServedVersion;
  dd: WorkspaceServedVersion & {
    /** The check page as DD buyers read it now (null: the checks are off). */
    summary: WorkspaceServedSummary | null;
    /** What turning the checks on would show on the pages DD buyers read now. */
    summaryIfOn: WorkspaceServedSummary | null;
  };
}

export interface FiguresWorkspace {
  status: {
    ddShownAt: string | null;
    autoAsk: boolean;
    autoAskChosen: boolean;
    build: FigureBuildStatus | null;
    refreshedAt: string | null;
    stale: boolean;
    hasCim: boolean;
    noFigures: "no_analysis" | "analysis_out_of_date" | null;
    hasOtherRecords: boolean;
    ddBuyers: number;
    dailyLimit: boolean;
  };
  kpis: {
    changesExplained: number;
    changesTotal: number;
    differences: number;
    differencesExplained: number;
    waiting: number;
    withSeller: number;
    documentsCited: number;
    /** Shared with due-diligence buyers (the data room fills this; null without it). */
    documentsShared: number | null;
  };
  fixFirst: FixFirstItem[];
  moves: WorkspaceMove[];
  checks: WorkspaceCheck[];
  questions: WorkspaceQuestion[];
  /** Notes on figures that aren't a movement row (difference notes, context notes) waiting or shown. */
  otherNotes: Array<{ figureKey: string; label: string; year: string; note: WorkspaceNote }>;
  /** The DD version still carries the old "verified from…" wording (refresh its sections). */
  oldDdWording: boolean;
  /** What each version serves now (null: couldn't be worked out — counts then read the working copy). */
  served: WorkspaceServed | null;
}

// ── Filters (Tab 1, Tab 2) ───────────────────────────────────────────────

/**
 * "needs" (the default): what needs the broker — a note waiting for an OK, one
 * that needs a look, and a figure with no reason where there is something to
 * do (Cimple's hint, a question to ask, the seller's answer to use).
 */
export type MoveFilter = "needs" | "all" | "waiting" | "none" | "shown" | "publish" | "look" | "hidden";

/** A row the broker can act on now. */
export function moveNeedsYou(m: WorkspaceMove): boolean {
  if (m.status === "waiting" || m.status === "stale_figures" || m.status === "stale_seller") return true;
  if (m.status !== "none") return false;
  return !!m.hint || !!m.answer || (m.askable && (!m.question || m.question.status === "suggested" || m.question.status === "answered"));
}

export function moveMatches(m: WorkspaceMove, f: MoveFilter, opts: { all?: boolean } = {}): boolean {
  // Folded rows (derived totals and tax lines with nothing to do) only under "Show all figures".
  if (m.folded && !opts.all) return false;
  switch (f) {
    case "needs": return moveNeedsYou(m);
    case "all": return m.status !== "hidden";
    case "waiting": return m.status === "waiting";
    case "none": return m.status === "none";
    case "shown": return m.status === "shown";
    case "publish": return m.status === "after_publish" || m.status === "not_served";
    case "look": return m.status === "stale_figures" || m.status === "stale_seller" || m.status === "held";
    case "hidden": return m.status === "hidden";
  }
}

export function moveCounts(moves: WorkspaceMove[], opts: { all?: boolean } = {}): Record<MoveFilter, number> {
  const out = { needs: 0, all: 0, waiting: 0, none: 0, shown: 0, publish: 0, look: 0, hidden: 0 } as Record<MoveFilter, number>;
  for (const m of moves) for (const f of Object.keys(out) as MoveFilter[]) if (moveMatches(m, f, opts)) out[f]++;
  return out;
}

export function checkCounts(checks: WorkspaceCheck[]): Record<CheckGroup, number> {
  const out: Record<CheckGroup, number> = { difference: 0, regrouped: 0, needs_checking: 0, match: 0, left_out: 0 };
  for (const c of checks) out[c.group]++;
  return out;
}

// ── The review sheet ─────────────────────────────────────────────────────

export interface ReviewItems {
  notes: Array<{ id: string; label: string; text: string; fingerprint: string; ticked: boolean; why: string | null; versions: string }>;
  differences: Array<{ checkKey: string; label: string; ticked: boolean }>;
  needsLook: Array<{ checkKey: string; label: string; canShow: boolean; why: string }>;
  matchesAuto: number;
}

/** What the review sheet lists, and what starts ticked (D9). */
export function reviewItems(ws: FiguresWorkspace): ReviewItems {
  const notes: ReviewItems["notes"] = [];
  const seen = new Set<string>();
  const addNote = (label: string, n: WorkspaceNote | null, place: FigurePlace = "page") => {
    if (!n || seen.has(n.id) || n.status !== "suggested" || n.staleReason) return;
    seen.add(n.id);
    notes.push({
      id: n.id, label, text: n.text, fingerprint: n.fingerprint, ticked: !n.internalOnly,
      why: n.internalOnly ? "Based only on your internal note. Check it first."
        : place === "update_only" ? "Buyers read it once you publish the update." : null,
      // A line inside a total is on no page of its own: due-diligence buyers read it under the total.
      versions: place === "inside_total" ? "DD · under its total" : n.blindText ? "Full · Blind · DD" : "Full · DD",
    });
  };
  // Held moves (D9a) are never offered: nothing measured from a figure that disagrees with the statements.
  for (const m of ws.moves) if (m.status !== "held") addNote(`${m.label} FY${m.year}`, m.note, m.place);
  for (const o of ws.otherNotes) addNote(`${o.label} FY${o.year}`, o.note);
  const differences: ReviewItems["differences"] = [];
  const needsLook: ReviewItems["needsLook"] = [];
  let matchesAuto = 0;
  for (const c of ws.checks) {
    if (c.decision === "left_out") continue;
    if (c.group === "match") { matchesAuto++; continue; }
    if (c.refusal) { needsLook.push({ checkKey: c.checkKey, label: `${c.label} FY${c.year}`, canShow: false, why: c.refusal }); continue; }
    if (c.shownToBuyers || c.decision === "shown") continue;
    const sign = c.difference >= 0 ? "+" : "−";
    const amount = `${sign}$${Math.round(Math.abs(c.difference)).toLocaleString("en-US")}`;
    const later = c.onBuyerPage ? "" : " · shows once you publish the update";
    // A figure the broker typed ("Cimple read it wrong") is offered unticked: it shows only on their own tick.
    const yours = c.corrected ? " · your figure" : "";
    if (c.state === "ask") {
      needsLook.push({ checkKey: c.checkKey, label: `${c.label} FY${c.year} · ${amount} · no reason yet${yours}${later}`, canShow: true, why: "Ask the seller first" });
    } else {
      const what = c.state === "match" ? "matches" : `${c.state === "regrouped" ? "grouped differently" : "reason given"} (${amount})`;
      differences.push({ checkKey: c.checkKey, label: `${c.label} FY${c.year} · ${what}${yours}${later}`, ticked: c.preTicked });
    }
  }
  return { notes, differences, needsLook, matchesAuto };
}
