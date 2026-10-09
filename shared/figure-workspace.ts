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
  /** Short chips for the "Based on" column. */
  chips: string[];
  sources: WorkspaceSource[];
  proposal: { text: string; blindText: string | null; at: string } | null;
  history: FigureNoteEvent[];
  /** Rests only on the broker's internal resolution note (never bulk-approved). */
  internalOnly: boolean;
  fingerprint: string;
}

export type MoveStatus = "shown" | "waiting" | "none" | "hidden" | "stale_figures" | "stale_seller" | "held";

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
  /** The CIM shows this figure itself (else it is a line inside a total it shows). */
  shown: boolean;
  status: MoveStatus;
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
  /** Shown to due-diligence buyers now (checks on + allowed). */
  shownToBuyers: boolean;
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
}

// ── Filters (Tab 1, Tab 2) ───────────────────────────────────────────────

export type MoveFilter = "all" | "waiting" | "none" | "shown" | "look" | "hidden";

export function moveMatches(m: WorkspaceMove, f: MoveFilter): boolean {
  switch (f) {
    case "all": return m.status !== "hidden";
    case "waiting": return m.status === "waiting";
    case "none": return m.status === "none";
    case "shown": return m.status === "shown";
    case "look": return m.status === "stale_figures" || m.status === "stale_seller" || m.status === "held";
    case "hidden": return m.status === "hidden";
  }
}

export function moveCounts(moves: WorkspaceMove[]): Record<MoveFilter, number> {
  const out = { all: 0, waiting: 0, none: 0, shown: 0, look: 0, hidden: 0 } as Record<MoveFilter, number>;
  for (const m of moves) for (const f of Object.keys(out) as MoveFilter[]) if (moveMatches(m, f)) out[f]++;
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
  const addNote = (label: string, n: WorkspaceNote | null) => {
    if (!n || seen.has(n.id) || n.status !== "suggested" || n.staleReason) return;
    seen.add(n.id);
    notes.push({
      id: n.id, label, text: n.text, fingerprint: n.fingerprint, ticked: !n.internalOnly,
      why: n.internalOnly ? "Based only on your internal note. Check it first." : null,
      versions: n.blindText ? "Full · Blind · DD" : "Full · DD",
    });
  };
  for (const m of ws.moves) addNote(`${m.label} FY${m.year}`, m.note);
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
    if (c.state === "ask") {
      needsLook.push({ checkKey: c.checkKey, label: `${c.label} FY${c.year} · ${amount} · no reason yet`, canShow: true, why: "Ask the seller first" });
    } else {
      differences.push({ checkKey: c.checkKey, label: `${c.label} FY${c.year} · ${c.state === "regrouped" ? "grouped differently" : "reason given"} (${amount})`, ticked: c.preTicked });
    }
  }
  return { notes, differences, needsLook, matchesAuto };
}
