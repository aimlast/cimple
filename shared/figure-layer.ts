/**
 * figure-layer — the notes on the CIM's figures and the due-diligence checks,
 * as one payload for a version of the CIM (stream "dd", spec §8, D9–D12, D21).
 *
 *   buildFigureLayer(sections, inputs, mode)  → FigureLayer | null
 *   withDdSourceCheck(sections, layer)        → sections + "How the figures check out" (DD)
 *
 * Who sees what (D12):
 *   - Teaser: nothing (buildBuyerCim never calls this for a teaser link).
 *   - Blind CIM: approved notes in their blind wording only — no labels, no
 *     comparisons, no citations, no document ids, opaque figure ids. The
 *     whole layer is then checked by the blind guard (cim-buyer-view.ts).
 *   - Full CIM: approved notes (+ the documents they cite).
 *   - Due diligence: everything — checks, side-by-side, "what's in it", the
 *     check page, page sources and key terms — once the broker turned the
 *     checks on (`ddShownAt`); approved notes show either way.
 *   - Buyers never see "no reason on file": a figure without a served note
 *     renders plain; an unexplained DD difference reads "Ask the broker
 *     about this difference".
 *   - The broker's preview (audience "broker") always sees the whole layer,
 *     with `preview` marks on what buyers don't see yet (D21).
 *
 * Nothing here trusts the inputs to be pre-filtered: every buyer rule
 * (approved only, values still the ones approved, D9a, located, decisions,
 * ddShownAt, citable) is applied again here.
 *
 * Pure.
 */
import { anchorFigures, type Anchor, type FigureRegistry, type RegistryFigure, glBridgeMarks, type GlBridgeLine } from "./figure-anchors";
import { agrees, dollars, percentOf, signedDollars, type DiffSize } from "./figure-compare";
import { checkState, type CheckState } from "./figure-states";
import { blindBasisLabel, changeLine, differsBy, SOURCE_CHECK_TITLE, type NoteBasis } from "./figure-copy";
import { AS_ISSUED, FIGURE_LINES, baseLineOf, figureKey, parseFigureKey, standardLine } from "./figure-lines";
import { pageRole } from "./cim-page-role";
import { keyTermFamilyFor, type KeyTermFamily } from "./dd-key-terms";
import { screenBuyerStrings, type StringScreen } from "./figure-strings";

// ── Documents (vdr contract fallbacks) ─────────────────────────────────────
// These mirror shared/vdr.ts (stream "vdr" — VdrDocKind, VdrDocRef,
// citationLabel, citableDocument) so dd builds and runs before vdr merges.
// INTEGRATOR: at the dd merge, alias FigureDocRef = VdrDocRef and switch the
// two functions to vdr's (same behaviour, same words).

export type FigureDocKind =
  | "financial_statements" | "tax_return" | "general_ledger" | "bank_statement" | "revenue_report"
  | "ar_ap_report" | "lease" | "contract" | "corporate_record" | "payroll_report" | "invoice"
  | "licence" | "insurance" | "asset_list" | "operating_report" | "other";

export interface FigureDocRef {
  documentId: string;
  kind: FigureDocKind;
  period?: string | null;
  page?: number | null;
  needle?: string | null;
  sheet?: string | null;
  rows?: number[] | null;
  sumColumn?: number | null;
}

const KIND_LABEL: Record<FigureDocKind, string> = {
  financial_statements: "Financial statements",
  tax_return: "Tax return",
  general_ledger: "General ledger",
  bank_statement: "Bank statement",
  revenue_report: "Revenue report",
  ar_ap_report: "Receivables and payables report",
  lease: "Lease",
  contract: "Contract",
  corporate_record: "Corporate record",
  payroll_report: "Payroll report",
  invoice: "Invoice",
  licence: "Licence",
  insurance: "Insurance document",
  asset_list: "Asset list",
  operating_report: "Operating report",
  other: "A supporting document",
};

/** The chip text when the document isn't visible: "Tax return 2023" — never a title (= vdr citationLabel). */
export function figureCitationLabel(ref: Pick<FigureDocRef, "kind" | "period">): string {
  const kind = ref.kind in KIND_LABEL ? ref.kind : "other";
  if (kind === "other") return KIND_LABEL.other;
  const period = typeof ref.period === "string" && /^(FY)?\d{4}(-\d{2})?$/.test(ref.period.trim()) ? ref.period.trim() : null;
  return period ? `${KIND_LABEL[kind]} ${period}` : KIND_LABEL[kind];
}

/** May the DD CIM cite this document at all (= vdr citableDocument / isRoomMaterial)? */
export function figureCitableDocument(doc: { visibility?: string | null; sourceKind?: string | null; category?: string | null; subcategory?: string | null; fileUrl?: string | null }): boolean {
  if (doc.visibility === "broker_only") return false;
  if (doc.sourceKind && doc.sourceKind !== "document") return false;
  if (!doc.fileUrl) return false;
  if (doc.category && ["transcripts", "email"].includes(doc.category)) return false;
  if (doc.subcategory && ["transcript", "call", "email", "crm_note"].includes(doc.subcategory)) return false;
  return true;
}

// ── Inputs ───────────────────────────────────────────────────────────────

export type FigureNoteKind = "movement" | "difference" | "context";

export interface FigureNoteInput {
  id: string;
  figureKey: string;
  kind: FigureNoteKind;
  /** movement: the earlier year; difference: "<kind>:<documentId>"; context: "". */
  compareKey: string;
  origin: "computed" | "ai" | "broker";
  status: "suggested" | "approved" | "hidden";
  text: string;
  blindText: string | null;
  basis: NoteBasis;
  /** Named basis line ("From the warehouse lease", "Worked out from the figures."). */
  basisLabel: string;
  /** Documents the note cites that may still be cited (already filtered by the server). */
  citations: FigureDocRef[];
  valuesSnapshot: { year: string; value: number; fromYear?: string; fromValue?: number; other?: number };
  staleReason: string | null;
  /** An AI note whose cited sources are all gone (D10): never served. */
  groundless?: boolean;
  /** Rests only on the broker's internal resolution note (excluded from bulk approval). */
  internalOnly?: boolean;
}

export type FigureCheckKind = "tax_return" | "management" | "cim_statements" | "restated";

export interface FigureCheckInput {
  /** "<figureKey>~<compareKey>". */
  key: string;
  figureKey: string;
  compareKey: string;
  kind: FigureCheckKind;
  /** "Tax return (T2)", "Management accounts", "Financial statements as issued". */
  otherLabel: string;
  /** What the other record is compared with: the statements as issued, else this CIM's figure. */
  base: number;
  other: number;
  /** The other document's own line label (DD only, screened). */
  sourceLabel: string | null;
  size: DiffSize;
  /** D6 worked the difference out (template text below). */
  regrouped: boolean;
  regroupedText: string | null;
  /** D9a: this CIM figure disagrees with its statements and nothing explains it. */
  cimMismatch: boolean;
  /** D11: both figures were found in their documents' text by the last refresh. */
  located: boolean;
  /** "Grouped differently on the tax return": no comparable figure (D4); never a check. */
  blank?: "grouped";
  decision: "shown" | "left_out" | "corrected" | null;
  /** When the CIM figure differs from the statements as issued and D6 explains it. */
  asIssuedText?: string | null;
  baseCitation: FigureDocRef | null;
  otherCitation: FigureDocRef | null;
}

export interface KeyTermInput {
  family: KeyTermFamily;
  label: string;
  value: string;
  citation: FigureDocRef;
}

export interface FigureInputs {
  audience: "buyer" | "broker";
  registry: FigureRegistry;
  notes: FigureNoteInput[];
  checks: FigureCheckInput[];
  keyTerms: KeyTermInput[];
  /** Due-diligence buyers see the checks since (ISO), or null. */
  ddShownAt: string | null;
  /** The statements (base) document per fiscal year — the figure's own citation in DD. */
  statementsByYear?: Record<string, FigureDocRef>;
  /** Broker preview: analysis hints per figure key ("Cimple's analysis suggests …"). */
  hints?: Record<string, string>;
  /** Opaque buyer ids (server: HMAC); omitted = readable ids (broker). */
  idFor?: (figureKey: string) => string;
  /** D23 string pipeline (buyer audiences). */
  screen?: StringScreen | null;
  /** gl contract: the bridge's add-back lines tied to ledger lines (empty until gl is merged). */
  glLines?: GlBridgeLine[];
}

// ── Payload (spec §8.1) ──────────────────────────────────────────────────

export interface FigureNoteView {
  id: string;
  text: string;
  basis: NoteBasis;
  basisLabel: string;
  /** [] in the Blind CIM. */
  citations: FigureDocRef[];
  /** Broker preview only. */
  suggested?: true;
  stale?: string;
}

export interface FigureCheckView {
  id: string;
  kindLabel: string;
  /** The other record's figure. */
  value: string;
  sourceLabel?: string;
  difference: string | null;
  differencePct: string | null;
  state: CheckState;
  size: DiffSize;
  /** DD: the statements as issued, when D6 explains a CIM-vs-statements gap. */
  asIssued?: string;
  note: FigureNoteView | null;
  citation: FigureDocRef | null;
  /** The statements' citation for the compared figure. */
  baseCitation?: FigureDocRef | null;
  /** Broker preview only. */
  preview?: "not_shown" | "needs_checking" | "cim_mismatch";
}

export interface FigurePart {
  label: string;
  display: string;
  why?: FigureNoteView | null;
}

export interface FigureView {
  id: string;
  /** Not in the Blind CIM. */
  label?: string;
  year: string;
  display: string;
  change?: { fromYear: string; fromDisplay: string; delta: string; pct: string | null; line: string } | null;
  why?: FigureNoteView | null;
  /** DD only: what's in a total. */
  parts?: FigurePart[];
  partsMore?: string | null;
  /** DD only. */
  checks?: FigureCheckView[];
  /** DD: the figure's own document (its year's statements). */
  citations?: FigureDocRef[];
  /** gl contract: the add-back line this bridge row is (pass 3). */
  gl?: { lineId: string } | null;
  /** DD: the tax return has no comparable line ("Grouped differently on the tax return"). */
  otherBlank?: string;
  /** Broker preview only. */
  hint?: string;
  noReason?: true;
  /** Broker preview: what has no reason on file — the change from the year before, or a difference. */
  noReasonFor?: { kind: "change"; fromYear: string } | { kind: "difference" };
  /** Broker preview: held by D9a (buyers see the cell plain). */
  cimMismatch?: true;
  /** …because it is worked out from that year's figures that disagree (EBITDA, gross profit…). */
  cimMismatchDerived?: true;
  figureKey?: string;
}

export interface KeyTermView {
  label: string;
  value: string;
  citation: FigureDocRef;
}

export interface FigureLayer {
  mode: "dd" | "normal" | "blind";
  audience: "buyer" | "broker";
  figures: Record<string, FigureView>;
  anchors: Array<{ pageId: string; block: string; cell: number | null; fig: string }>;
  pageSources?: Record<string, FigureDocRef[]>;
  keyTerms?: Record<string, KeyTermView[]>;
  summary?: { checked: number; matching: number; regrouped: number; differing: number; explained: number };
  ddChecksOn?: boolean;
  /** DD: the rows/columns of "How the figures check out" (structure only). */
  sourceCheck?: { lines: string[]; years: string[] } | null;
  /** gl contract (DD + Full): bridge rows that are a general-ledger add-back line → gl's `<GlMark lineId variant="row" />`. */
  glMarks?: Array<{ pageId: string; block: string; lineId: string }>;
}

/** The synthetic page's id and layout. */
export const DD_SOURCE_CHECK_PAGE_ID = "dd-source-check";
export const DD_SOURCE_CHECK_LAYOUT = "dd_source_check";

interface SectionLike {
  id: string;
  layoutType: string;
  layoutData: unknown;
  sectionTitle?: string | null;
  sectionKey?: string | null;
  order?: number;
}

// ── Building ─────────────────────────────────────────────────────────────

const EPS = 0.5;
const near = (a: number | undefined, b: number | undefined) => typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= EPS;

/** D10: the figures a note was approved for are the ones the CIM shows now. */
function snapshotHolds(note: FigureNoteInput, registry: FigureRegistry): boolean {
  const f = registry[note.figureKey];
  if (!f || !near(Math.abs(f.value), Math.abs(note.valuesSnapshot.value))) return false;
  if (note.kind === "movement") {
    const parsed = parseFigureKey(note.figureKey);
    if (!parsed || !note.valuesSnapshot.fromYear) return false;
    const prev = registry[figureKey(parsed.line, note.valuesSnapshot.fromYear)];
    if (!prev || !near(Math.abs(prev.value), Math.abs(note.valuesSnapshot.fromValue ?? NaN))) return false;
  }
  return true;
}

/** The figure keys a movement note is measured between. */
function movementKeys(note: FigureNoteInput): string[] {
  const parsed = parseFigureKey(note.figureKey);
  if (!parsed || note.kind !== "movement" || !note.valuesSnapshot.fromYear) return [note.figureKey];
  return [note.figureKey, figureKey(parsed.line, note.valuesSnapshot.fromYear)];
}

function noteView(note: FigureNoteInput, mode: FigureLayer["mode"], broker: boolean): FigureNoteView | null {
  const blind = mode === "blind";
  const text = blind ? note.blindText : note.text;
  if (!text || !text.trim()) return null;
  return {
    id: note.id,
    text: text.trim(),
    basis: note.basis,
    basisLabel: blind ? blindBasisLabel(note.basis) : note.basisLabel,
    citations: blind ? [] : note.citations,
    ...(broker && note.status === "suggested" ? { suggested: true as const } : {}),
    ...(broker && note.staleReason ? { stale: note.staleReason } : {}),
  };
}

/**
 * Build the layer for these (served) sections. Null when nothing applies.
 * `mode` is the CIM version; the audience comes from the inputs.
 */
export function buildFigureLayer(sections: SectionLike[], inputs: FigureInputs | null | undefined, mode: FigureLayer["mode"]): FigureLayer | null {
  if (!inputs || !inputs.registry || Object.keys(inputs.registry).length === 0) return null;
  const broker = inputs.audience === "broker";
  const dd = mode === "dd";
  const ddOn = !!inputs.ddShownAt;
  const registry = inputs.registry;
  const idFor = inputs.idFor ?? ((k: string) => k);

  const anchors: Anchor[] = sections.flatMap((s) => anchorFigures(s, registry));
  const anchoredKeys = new Set(anchors.map((a) => a.figureKey));

  // D9a: a CIM figure that disagrees with its statements, unexplained — and
  // the derived totals of that year worked out from it (EBITDA has no
  // statements line of its own to disagree with).
  const mismatch = cimMismatchHeld(inputs.checks, registry);

  const notesBy = new Map<string, FigureNoteInput[]>();
  for (const n of inputs.notes) {
    if (!notesBy.has(n.figureKey)) notesBy.set(n.figureKey, []);
    notesBy.get(n.figureKey)!.push(n);
  }
  /** Is this note served here? Buyers: approved, current, grounded, not D9a; broker: anything not hidden. */
  const served = (n: FigureNoteInput): boolean => {
    if (n.status === "hidden") return false;
    if (broker) return true;
    if (n.status !== "approved" || n.staleReason || n.groundless) return false;
    if (!snapshotHolds(n, registry)) return false;
    if (n.kind === "movement" && movementKeys(n).some((k) => mismatch.has(k))) return false;
    if (mode === "blind" && !n.blindText) return false;
    return true;
  };

  const checksBy = new Map<string, FigureCheckInput[]>();
  for (const c of inputs.checks) {
    if (!checksBy.has(c.figureKey)) checksBy.set(c.figureKey, []);
    checksBy.get(c.figureKey)!.push(c);
  }
  /** A difference note still describes this check's figures (D10). */
  const sameOther = (n: FigureNoteInput, c: FigureCheckInput) => n.valuesSnapshot.other === undefined || near(Math.abs(n.valuesSnapshot.other), Math.abs(c.other));
  /** The approved (served) difference note for a check. */
  const differenceNote = (c: FigureCheckInput): FigureNoteInput | null =>
    (notesBy.get(c.figureKey) ?? []).find((n) => n.kind === "difference" && n.compareKey === c.compareKey && served(n) && (broker || sameOther(n, c))) ?? null;
  const approvedDifference = (c: FigureCheckInput): boolean =>
    (notesBy.get(c.figureKey) ?? []).some((n) => n.kind === "difference" && n.compareKey === c.compareKey && n.status === "approved" && !n.staleReason && !n.groundless && snapshotHolds(n, registry) && sameOther(n, c));

  /** A check as served: buyers only what D9 allows; the broker everything, marked. */
  const checkFor = (c: FigureCheckInput): FigureCheckView | null => {
    if (c.blank) return null;
    if (c.kind === "cim_statements" && !c.regrouped && !broker) return null; // a mismatch is broker-only
    const state = checkState({ size: c.size, regrouped: c.regrouped, approvedReason: approvedDifference(c) });
    const cimMis = mismatch.has(c.figureKey);
    const buyerSees = ddOn && !cimMis && c.located && c.decision !== "left_out" &&
      (state === "match" || state === "regrouped" || c.decision === "shown" || c.decision === "corrected");
    if (!broker && !buyerSees) return null;
    const diff = Math.abs(c.other) - Math.abs(c.base);
    const differs = !agrees(c.size);
    const note = differs && !c.regrouped ? differenceNote(c) : null;
    const preview: FigureCheckView["preview"] | undefined = broker && !buyerSees
      ? (cimMis || (c.kind === "cim_statements" && c.cimMismatch) ? "cim_mismatch" : !c.located ? "needs_checking" : "not_shown")
      : undefined;
    return {
      // Opaque for buyers (a check key carries the figure key, and a line slug can carry a name).
      id: idFor(c.key),
      kindLabel: c.otherLabel,
      value: dollars(c.other),
      ...(c.sourceLabel ? { sourceLabel: c.sourceLabel } : {}),
      difference: differs ? signedDollars(diff) : null,
      differencePct: differs ? percentOf(diff, c.base, "difference") : null,
      state,
      size: c.size,
      ...(c.asIssuedText ? { asIssued: c.asIssuedText } : {}),
      note: c.regrouped && c.regroupedText
        ? { id: `${idFor(c.key)}#computed`, text: c.regroupedText, basis: "computed", basisLabel: "Worked out from the two documents.", citations: [c.baseCitation, c.otherCitation].filter((x): x is FigureDocRef => !!x) }
        : note ? noteView(note, mode, broker) : null,
      citation: c.otherCitation,
      baseCitation: c.baseCitation,
      ...(preview ? { preview } : {}),
    };
  };

  const figures: Record<string, FigureView> = {};
  const servedChecks: FigureCheckView[] = [];
  const pageSources: Record<string, FigureDocRef[]> = {};
  const addSource = (pageId: string, ref: FigureDocRef | null | undefined) => {
    if (!ref) return;
    const list = pageSources[pageId] ?? (pageSources[pageId] = []);
    if (!list.some((r) => r.documentId === ref.documentId)) list.push({ documentId: ref.documentId, kind: ref.kind, period: ref.period ?? null, page: null });
  };

  for (const key of Array.from(anchoredKeys)) {
    const fig = registry[key];
    if (!fig) continue;
    // D9a: a CIM figure that disagrees with its statements (unexplained) is
    // the broker's to fix — buyers get that cell plain (no check, no note, no parts).
    if (!broker && mismatch.has(key)) continue;
    const first = anchors.find((a) => a.figureKey === key)!;
    const notes = (notesBy.get(key) ?? []).filter(served);
    const movement = notes.find((n) => n.kind === "movement") ?? null;
    const context = notes.find((n) => n.kind === "context") ?? null;
    const whyNote = movement ?? context;
    const why = whyNote ? noteView(whyNote, mode, broker) : null;
    // The value as the note reads it: "$293,240" whether the cell printed "293240", "(293,240)" or
    // "($293,240)"; a scaled figure ("$31.02M") stays as printed. Only a non-expense below zero keeps a sign.
    const display = /[a-z]/i.test(first.display.replace(/^\s*(?:c\$|us\$|ca\$|cad|usd)/i, "")) ? first.display
      : `${first.shown < 0 && !fig.expense ? "−" : ""}${dollars(first.shown)}`;
    const view: FigureView = { id: idFor(key), year: fig.year, display };
    if (mode !== "blind") view.label = fig.lineLabel;
    if (why) view.why = why;
    if (movement && why && movement.valuesSnapshot.fromYear) {
      const prev = registry[figureKey(fig.line, movement.valuesSnapshot.fromYear)];
      if (prev) {
        view.change = {
          fromYear: prev.year,
          fromDisplay: dollars(prev.value),
          delta: signedDollars(Math.abs(fig.value) - Math.abs(prev.value)),
          pct: percentOf(Math.abs(fig.value) - Math.abs(prev.value), prev.value, "change"),
          line: changeLine(Math.abs(prev.value), Math.abs(fig.value), prev.year),
        };
      }
    }
    if (dd) {
      const checks = (checksBy.get(key) ?? []).map(checkFor).filter((c): c is FigureCheckView => !!c);
      if (checks.length > 0) view.checks = checks;
      if ((checksBy.get(key) ?? []).some((c) => c.blank === "grouped") && !checks.some((c) => c.kindLabel.startsWith("Tax return") || c.kindLabel.startsWith("Form"))) {
        view.otherBlank = "Grouped differently on the tax return";
      }
      if (broker || ddOn) {
        const parts = partsOf(fig, registry, notesBy, served, mode, broker);
        if (parts) { view.parts = parts.parts; view.partsMore = parts.more; }
        const own = inputs.statementsByYear?.[fig.year];
        if (own) view.citations = [own];
      }
      // The summary counts what buyers get; the broker's preview counts every check (D21).
      for (const c of view.checks ?? []) if (broker || !c.preview) servedChecks.push(c);
    }
    if (broker) {
      view.figureKey = key;
      if (mismatch.has(key)) {
        view.cimMismatch = true;
        if (heldAsDerived(key, inputs.checks)) view.cimMismatchDerived = true;
      }
      const hasApproved = (notesBy.get(key) ?? []).some((n) => n.status === "approved" && (n.kind === "movement" || n.kind === "context"));
      // "No reason on file" only where a reason is expected: a change of 8%
      // or more from the year before, or a difference nothing explains —
      // never on a held figure, or a change measured from one (fix it first).
      const prev = registry[figureKey(fig.line, String(Number(fig.year) - 1))];
      const moved = !!prev && !mismatch.has(prev.key) && Math.abs(Math.abs(fig.value) - Math.abs(prev.value)) >= 2500 && Math.abs(prev.value) > 0
        && Math.abs(Math.abs(fig.value) - Math.abs(prev.value)) / Math.abs(prev.value) >= 0.08;
      const unexplained = (view.checks ?? []).some((c) => c.state === "ask");
      if (!mismatch.has(key) && !hasApproved && (moved || unexplained)) {
        view.noReason = true;
        view.noReasonFor = unexplained ? { kind: "difference" } : { kind: "change", fromYear: prev!.year };
        const hint = inputs.hints?.[key];
        if (hint) view.hint = hint;
      }
    }
    const shows = broker || !!view.why || (view.checks?.length ?? 0) > 0 || (dd && ddOn && (view.parts?.length ?? 0) > 0);
    if (!shows) continue;
    figures[key] = view;
  }

  // Page sources (DD): the documents behind the page's figures.
  if (dd && (broker || ddOn)) {
    for (const a of anchors) {
      const v = figures[a.figureKey];
      if (!v) continue;
      for (const r of v.citations ?? []) addSource(a.pageId, r);
      for (const c of v.checks ?? []) {
        if (c.preview && !broker) continue;
        addSource(a.pageId, c.baseCitation ?? null);
        addSource(a.pageId, c.citation);
      }
    }
  }

  // Key terms (DD): per page whose role shows a family.
  let keyTerms: Record<string, KeyTermView[]> | undefined;
  if (dd && (broker || ddOn) && inputs.keyTerms.length > 0) {
    keyTerms = {};
    for (const s of sections) {
      const family = keyTermFamilyFor(pageRole({ layoutType: s.layoutType, title: s.sectionTitle ?? null, sectionKey: s.sectionKey ?? null, layoutData: s.layoutData }), s.sectionTitle ?? "");
      if (!family) continue;
      const terms = inputs.keyTerms.filter((t) => t.family === family).slice(0, 6).map((t) => ({ label: t.label, value: t.value, citation: t.citation }));
      if (terms.length === 0) continue;
      keyTerms[s.id] = terms;
      for (const t of terms) addSource(s.id, t.citation);
    }
  }

  // The check page's structure: standard lines (registry order) × years with a served check.
  let sourceCheck: FigureLayer["sourceCheck"] = null;
  const pageAnchors: FigureLayer["anchors"] = [];
  if (dd) {
    const shows = (v: FigureView | undefined) => !!v && (v.checks ?? []).some((c) => broker || !c.preview);
    const visible = Object.entries(figures).filter(([, v]) => shows(v));
    const baseOf = (k: string) => { const p = parseFigureKey(k); return p ? baseLineOf(p.line) : null; };
    const lineIds = FIGURE_LINES.map((l) => l.id as string).filter((id) => visible.some(([k]) => baseOf(k) === id));
    const years = Array.from(new Set(visible.map(([k]) => parseFigureKey(k)?.year).filter((y): y is string => !!y))).sort();
    if (lineIds.length > 0 && years.length > 0) {
      sourceCheck = { lines: lineIds, years };
      lineIds.forEach((line, i) => years.forEach((y, j) => {
        // The figure the CIM shows for that line and year: the analysis's, else the statements-as-issued one.
        const own = figures[`${line}|${y}`];
        const v = shows(own) ? own : figures[`${line}${AS_ISSUED}|${y}`];
        if (shows(v)) pageAnchors.push({ pageId: DD_SOURCE_CHECK_PAGE_ID, block: `row:${i}`, cell: j, fig: v!.id });
      }));
    }
  }

  const summary = dd ? summarise(servedChecks) : undefined;

  // gl contract: "Found in the books" marks on bridge rows (DD and Full; never Blind).
  const glMarks = mode !== "blind" && (inputs.glLines?.length ?? 0) > 0
    ? sections.flatMap((s) => glBridgeMarks(s, inputs.glLines!))
    : [];
  for (const m of glMarks) {
    const a = anchors.find((x) => x.pageId === m.pageId && x.block === m.block);
    if (a && figures[a.figureKey]) figures[a.figureKey].gl = { lineId: m.lineId };
  }

  let layer: FigureLayer = {
    mode,
    audience: inputs.audience,
    figures: Object.fromEntries(Object.values(figures).map((v) => [v.id, v])),
    anchors: anchors.filter((a) => figures[a.figureKey]).map((a) => ({ pageId: a.pageId, block: a.block, cell: a.cell, fig: figures[a.figureKey].id })).concat(pageAnchors),
    ...(dd && (broker || ddOn) && Object.keys(pageSources).length > 0 ? { pageSources } : {}),
    ...(keyTerms && Object.keys(keyTerms).length > 0 ? { keyTerms } : {}),
    ...(summary ? { summary } : {}),
    ...(dd ? { ddChecksOn: ddOn } : {}),
    ...(dd ? { sourceCheck: broker || (ddOn && (summary?.checked ?? 0) > 0) ? sourceCheck : null } : {}),
    ...(glMarks.length > 0 ? { glMarks } : {}),
  };
  if (!broker && inputs.screen) layer = screenBuyerStrings(layer, inputs.screen);
  if (!broker) layer = withoutEmptyFigures(layer);
  const hasAnything = Object.keys(layer.figures).length > 0 || Object.keys(layer.keyTerms ?? {}).length > 0 || (layer.glMarks?.length ?? 0) > 0;
  return hasAnything ? layer : null;
}

/** A figure left with nothing to show after screening is dropped (and its anchors). */
function withoutEmptyFigures(layer: FigureLayer): FigureLayer {
  const keep = new Set(Object.entries(layer.figures).filter(([, v]) => !!v.why || (v.checks?.length ?? 0) > 0 || (layer.mode === "dd" && layer.ddChecksOn && (v.parts?.length ?? 0) > 0)).map(([id]) => id));
  if (keep.size === Object.keys(layer.figures).length) return layer;
  return {
    ...layer,
    figures: Object.fromEntries(Object.entries(layer.figures).filter(([id]) => keep.has(id))),
    anchors: layer.anchors.filter((a) => keep.has(a.fig)),
  };
}

function summarise(checks: FigureCheckView[]): NonNullable<FigureLayer["summary"]> {
  const s = { checked: 0, matching: 0, regrouped: 0, differing: 0, explained: 0 };
  const seen = new Set<string>();
  for (const c of checks) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    s.checked++;
    if (c.state === "match") s.matching++;
    else if (c.state === "regrouped") s.regrouped++;
    else {
      s.differing++;
      if (c.state === "explained") s.explained++;
    }
  }
  return s;
}

/** DD "what's in it": up to 5 components (analysis order), then "and N more ($X)". */
function partsOf(
  fig: RegistryFigure,
  registry: FigureRegistry,
  notesBy: Map<string, FigureNoteInput[]>,
  served: (n: FigureNoteInput) => boolean,
  mode: FigureLayer["mode"],
  broker: boolean,
): { parts: FigurePart[]; more: string | null } | null {
  if (!fig.total || !fig.components || fig.components.length < 2) return null;
  const comps = fig.components
    .map((c) => registry[c.key])
    .filter((c): c is RegistryFigure => !!c && Math.abs(c.value) >= 1);
  if (comps.length < 2) return null;
  const shown = comps.slice(0, 5);
  const rest = comps.slice(5);
  const parts: FigurePart[] = shown.map((c) => {
    const n = (notesBy.get(c.key) ?? []).find((x) => x.kind === "movement" && served(x));
    return { label: c.lineLabel, display: dollars(c.value), ...(n ? { why: noteView(n, mode, broker) } : {}) };
  });
  const more = rest.length > 0 ? `and ${rest.length} more (${dollars(rest.reduce((s, c) => s + Math.abs(c.value), 0))})` : null;
  return { parts, more };
}

// ── The "How the figures check out" page ───────────────────────────────────

/**
 * Where the check page goes: right after the last table (never an earnings
 * bridge or a chart) with ≥ 3 checked cells, else after the last financial table, else
 * at the end (before the contact page). Returns the index to insert after
 * (−1 = at the end).
 */
export function ddSourceCheckAnchor(sections: SectionLike[], layer: FigureLayer): number {
  const checkedFigs = new Set(Object.values(layer.figures).filter((v) => (v.checks?.length ?? 0) > 0).map((v) => v.id));
  let best = -1;
  sections.forEach((s, i) => {
    // An earnings bridge is never the anchor: the check page comes before it
    // (financial table → check page → … → bridge → gl's ledger page).
    if (s.layoutType === "waterfall_chart") return;
    // Table cells only: a chart of the same figures is not where readers compare them.
    const n = layer.anchors.filter((a) => a.pageId === s.id && checkedFigs.has(a.fig) && /(^|\/)row:\d+$/.test(a.block)).length;
    if (n >= 3) best = i;
  });
  if (best >= 0) return best;
  sections.forEach((s, i) => {
    if (s.layoutType === "financial_table" || s.layoutType === "comparison_table") best = i;
  });
  return best;
}

/** True when this anchor's figure is held by D9a (its CIM figure disagrees with the statements, or is worked out from one that does). */
export function heldByCimMismatch(
  anchor: { figureKey: string },
  checks: ReadonlyArray<Pick<FigureCheckInput, "figureKey" | "kind" | "cimMismatch">>,
  registry?: FigureRegistry | null,
): boolean {
  return cimMismatchHeld(checks, registry).has(anchor.figureKey);
}

/** P&L order of the standard lines: a line's figure feeds the derived totals after it. */
const PNL_STAGE: Record<string, number> = {
  revenue: 0, costOfSales: 0,
  grossProfit: 1, operatingExpenses: 1, nonRecurring: 1,
  ebitda: 2, otherIncome: 2, amortization: 2, interest: 2,
  incomeBeforeTax: 3, incomeTaxes: 3,
  netIncome: 4,
};
/** Totals the CIM works out from other lines (the statements may carry none to compare with — EBITDA never). */
export const DERIVED_TOTAL_LINES: ReadonlySet<string> = new Set(["grossProfit", "ebitda", "incomeBeforeTax", "netIncome"]);

/**
 * D9a and what follows from it: the CIM figures held because they disagree
 * with the statements and nothing explains it — plus, in the same year, every
 * derived total worked out after them (gross profit, EBITDA, income before
 * taxes, net income). A derived total with no line of its own on the
 * statements never shows a mismatch by itself: Pacific's FY2022 EBITDA
 * ($4,129,000) is built from the cost of sales and operating expenses the
 * FY2022 statements disagree with ($3,409,800 from the statements as issued),
 * so no movement note, hint, question or check measured from or to it may
 * reach buyers either. A statements-as-issued variant is the statements' own
 * figure and is never held. `registry` omitted: the direct mismatches only.
 */
export function cimMismatchHeld(
  checks: ReadonlyArray<Pick<FigureCheckInput, "figureKey" | "kind" | "cimMismatch">>,
  registry?: FigureRegistry | null,
): Set<string> {
  const out = new Set<string>();
  const firstStage = new Map<string, number>(); // year → the earliest P&L stage that disagrees
  for (const c of checks) {
    if (c.kind !== "cim_statements" || !c.cimMismatch) continue;
    out.add(c.figureKey);
    const p = parseFigureKey(c.figureKey);
    if (!p) continue;
    const stage = PNL_STAGE[baseLineOf(p.line)];
    if (stage === undefined) continue;
    firstStage.set(p.year, Math.min(firstStage.get(p.year) ?? Infinity, stage));
  }
  if (!registry || firstStage.size === 0) return out;
  for (const f of Object.values(registry)) {
    if (!DERIVED_TOTAL_LINES.has(String(f.line))) continue; // standard derived lines only (never "@statements")
    const from = firstStage.get(f.year);
    if (from === undefined || PNL_STAGE[String(f.line)] <= from) continue;
    // The statements state this total and agree with it (Pacific's FY2022 net income, $1,115,900):
    // the figure buyers read is right whatever the lines above it say.
    if (typeof f.statementsValue === "number" && Math.abs(Math.abs(f.statementsValue) - Math.abs(f.value)) <= 1) continue;
    out.add(f.key);
  }
  return out;
}

/** True when a held figure is held only because it is worked out from figures that disagree (not itself compared). */
export function heldAsDerived(figureKey: string, checks: ReadonlyArray<Pick<FigureCheckInput, "figureKey" | "kind" | "cimMismatch">>): boolean {
  return !checks.some((c) => c.figureKey === figureKey && c.kind === "cim_statements" && c.cimMismatch);
}

/**
 * The sections with "How the figures check out" inserted (DD only, when the
 * layer has a check page). Its layoutData is structure only — the values,
 * states and decisions come from the layer — so a broker decision never
 * changes what the page IS (the rendition hash).
 */
export function withDdSourceCheck<T extends SectionLike & { dealId?: string }>(sections: T[], layer: FigureLayer | null): T[] {
  if (!layer || layer.mode !== "dd" || !layer.sourceCheck || layer.sourceCheck.lines.length === 0) return sections;
  if (sections.some((s) => s.id === DD_SOURCE_CHECK_PAGE_ID)) return sections;
  const at = ddSourceCheckAnchor(sections, layer);
  const anchor = at >= 0 ? sections[at] : sections[sections.length - 1];
  const page = {
    id: DD_SOURCE_CHECK_PAGE_ID,
    dealId: anchor?.dealId ?? "",
    sectionKey: DD_SOURCE_CHECK_LAYOUT,
    sectionTitle: SOURCE_CHECK_TITLE,
    order: (anchor?.order ?? 0) + 0.5,
    layoutType: DD_SOURCE_CHECK_LAYOUT,
    layoutData: { v: 1, lines: layer.sourceCheck.lines, years: layer.sourceCheck.years },
    aiDraftContent: null,
    brokerEditedContent: null,
    isVisible: true,
  } as unknown as T;
  const out = [...sections];
  out.splice(at >= 0 ? at + 1 : out.length, 0, page);
  return out;
}

/** The standard line's label for the check page's rows. */
export function sourceCheckRowLabel(lineId: string): string {
  return standardLine(lineId)?.label ?? lineId;
}

/** Every human string in the layer (the blind whole-layer check reads these). */
export function layerStrings(layer: FigureLayer): string[] {
  const out: string[] = [];
  const note = (n: FigureNoteView | null | undefined) => { if (n) out.push(n.text, n.basisLabel); };
  for (const f of Object.values(layer.figures)) {
    if (f.label) out.push(f.label);
    out.push(f.display);
    if (f.change) out.push(f.change.line, f.change.fromDisplay);
    note(f.why);
    for (const p of f.parts ?? []) { out.push(p.label, p.display); note(p.why); }
    if (f.partsMore) out.push(f.partsMore);
    for (const c of f.checks ?? []) {
      out.push(c.kindLabel, c.value);
      if (c.sourceLabel) out.push(c.sourceLabel);
      if (c.asIssued) out.push(c.asIssued);
      note(c.note);
    }
    if (f.otherBlank) out.push(f.otherBlank);
  }
  for (const terms of Object.values(layer.keyTerms ?? {})) for (const t of terms) out.push(t.label, t.value);
  return out;
}

// Re-exported for renderers that only import the layer module.
export { differsBy };
