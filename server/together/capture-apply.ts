/**
 * Writes the coverage board makes to the deal (specs/together.md §4.6, §5.7).
 *
 * Pass 1 (checklist mode): "✓ Confirmed" — the broker confirms, with the
 * seller, a value already on file that was marked to verify (a seller
 * estimate, a guard flag, a lead from the CRM notes or website, the broker's
 * own AI-session notes, a "come back later" mark). No text is copied
 * anywhere: it records a "confirmed" mark keyed to the hash of the current
 * value (the board's override — it lapses when the value changes) and, for
 * a lead, vouches for the lead's source (acceptedByBroker), as the
 * Information tab's accept does for a same-value lead. A conflict between
 * sources needs Resolve; a non-answer needs an answer.
 *
 * Live capture (applyCapture, undo, call notes) lands here in pass 3.
 */
import type { Deal } from "@shared/schema";
import type { CoverageBoard, CoverageItem } from "@shared/coverage-board";
import { boardFromCoverage, coverageValueText, loadCoverageInputs, valueHash, type CoverageLoaders } from "../interview/coverage-board";
import { getFieldSources, setFieldSource } from "../interview/info-merger";
import { mutateDealInfo } from "../information/facts";
import { clearMark, setMark } from "./marks";
import { BoardActionError } from "./errors";

const LEAD_KINDS = new Set(["crm", "website", "social"]);
const CONFIRMABLE = new Set(["estimate", "guard", "lead", "broker_notes", "marked"]);

export { BoardActionError };

function findItem(board: CoverageBoard, itemId: string): CoverageItem | undefined {
  for (const s of board.sections) for (const i of s.items) if (i.id === itemId) return i;
  return undefined;
}

/**
 * ✓ Confirmed (no live session). Returns the broker board after the write.
 */
export async function confirmItem(
  deal: Deal,
  itemId: string,
  brokerId: string,
  opts: { sittingId?: string | null; loaders?: Partial<CoverageLoaders>; reload?: () => Promise<Deal> } = {},
): Promise<CoverageBoard> {
  const inputs = await loadCoverageInputs(deal, opts.loaders);
  const board = boardFromCoverage(inputs, "broker");
  const item = findItem(board, itemId);
  if (!item) throw new BoardActionError("That data point isn't on the checklist any more.", 404, "not_found");
  if (item.status === "on_file") return board;
  const code = item.reason?.code;
  if (code === "conflict" || code === "routed") {
    throw new BoardActionError("Two sources disagree here — resolve it instead.", 409, "resolve", { discrepancyId: item.conflictId ?? null });
  }
  if (item.status !== "verify" || !code || !CONFIRMABLE.has(code) || !item.valueKey) {
    throw new BoardActionError("There's nothing on file to confirm yet — add the answer instead.", 409, "needs_answer");
  }
  const key = item.valueKey;
  const full = coverageValueText(inputs.brokerFacts[key]);
  if (full === null) throw new BoardActionError("There's nothing on file to confirm yet — add the answer instead.", 409, "needs_answer");

  if (code === "lead") {
    // The broker vouches for the lead's source — its real kind stays.
    await mutateDealInfo(deal.id, (info) => {
      const src = getFieldSources(info)[key];
      if (src && LEAD_KINDS.has(String(src.source)) && !src.acceptedByBroker) setFieldSource(info, key, { ...src, acceptedByBroker: true });
    });
  }
  await setMark({ dealId: deal.id, itemId, sectionKey: item.sectionKey, kind: "confirmed", note: key, valueHash: valueHash(full), sittingId: opts.sittingId ?? null, createdBy: brokerId });
  if (item.marks.some((m) => m.kind === "verify_later")) await clearMark(deal.id, itemId, "verify_later");

  const fresh = opts.reload ? await opts.reload() : deal;
  return boardFromCoverage(await loadCoverageInputs(fresh, opts.loaders), "broker");
}

// ─────────────────────────────────────────────────────────────────────────
// The broker's call notes (§3.6) — what the broker types during a session
// ─────────────────────────────────────────────────────────────────────────

export interface CallNoteField {
  key: string;
  value: string;
}

export interface CallNoteResult {
  /** Filed as the broker's call note. */
  written: string[];
  /** A stronger value stays (the seller's own words, a document, a broker edit); the note is kept beside it. */
  keptBeside: string[];
  /** Not filed: the normalisation guard, a detail the seller asked to keep private… */
  dropped: Array<{ key: string; code: "normalisation" | "keep_out" | "staff_private" | "empty" }>;
  /** Private notes recorded (treatments, held-back details, staff-private matters). */
  notes: number;
}

const CALL_NOTE_MAX = 400;

/**
 * What the broker typed during "Interview together" is the broker's own
 * call note — never the seller's statement and never a broker edit
 * (rank 4, with the questionnaire and emails: the seller's own answer later
 * replaces it, a document outranks it where documents are the authority).
 * The same guards as the interview run first: add-back treatment goes to a
 * private note (normalisation is the broker's call against the
 * statements), a detail the seller asked to keep out is held back, a staff
 * member's private matter goes to the private notes. One facts-lock write.
 */
export async function writeBrokerCallNotes(
  dealId: string,
  fields: CallNoteField[],
  ctx: { sittingId: string; at?: string },
): Promise<CallNoteResult> {
  const { guardNormalisationFields } = await import("../interview/reply-guards");
  const { getSellerKeepOut, carriesPrivateDetail, HELD_BACK_NOTE_REASON } = await import("../interview/seller-keep-out");
  const { routeStaffPrivateToNotes } = await import("../documents/extractor");
  const { staffContextFrom } = await import("../cim/staff-private");
  const { effectiveRank } = await import("../documents/merge-policy");
  const {
    BROKER_CALL_SOURCE_NOTE,
    BROKER_SESSION_RANK,
    SOURCE_RANK,
    addPrivateNote,
    displaceCorroborations,
    isBrokerFinalSource,
    isUntrackedSource,
    recordAlternate,
  } = await import("../interview/info-merger");
  const { isNotKnownValue } = await import("@shared/coverage-board");

  const at = ctx.at ?? new Date().toISOString();
  const result: CallNoteResult = { written: [], keptBeside: [], dropped: [], notes: 0 };
  return mutateDealInfo(dealId, (info) => {
    const facts = info as Record<string, unknown>;
    // 1. The interview's guards, on what the broker typed.
    const guarded: Record<string, { value: string; confidence: string; basis: "verbatim" }> = {};
    for (const f of fields) {
      const v = String(f.value ?? "").trim().slice(0, CALL_NOTE_MAX);
      if (!v) { result.dropped.push({ key: f.key, code: "empty" }); continue; }
      guarded[f.key] = { value: v, confidence: "confirmed", basis: "verbatim" };
    }
    const notes: Array<{ note: string; reason: string }> = [];
    const before = new Set(Object.keys(guarded));
    guardNormalisationFields(guarded, notes);
    // (An add-back item is kept under its own neutral key; its treatment went to a note.)
    for (const k of Array.from(before)) if (!guarded[k]) result.dropped.push({ key: k, code: "normalisation" });
    const keepOut = getSellerKeepOut(facts);
    const data: Record<string, unknown> = {};
    for (const [k, f] of Object.entries(guarded)) {
      const entry = keepOut.find((e) => carriesPrivateDetail(f.value, e));
      if (entry) {
        result.dropped.push({ key: k, code: "keep_out" });
        if (f.value.split(/\s+/).length > 8) notes.push({ note: f.value, reason: HELD_BACK_NOTE_REASON });
        continue;
      }
      data[k] = f.value;
    }
    const staffNotes = routeStaffPrivateToNotes(data, staffContextFrom(facts));
    for (const k of Object.keys(guarded)) if (!(k in data) && !result.dropped.some((d) => d.key === k)) result.dropped.push({ key: k, code: "staff_private" });
    for (const n of staffNotes) notes.push({ note: n, reason: "a staff member's private matter — kept out of the CIM" });
    delete data._privateNotes;

    // 2. Write each as the broker's call note — never over a stronger value.
    const sources = getFieldSources(facts);
    const src = { source: "broker" as const, note: BROKER_CALL_SOURCE_NOTE, at, sittingId: ctx.sittingId };
    for (const [key, value] of Object.entries(data)) {
      const prev = sources[key];
      const prior = facts[key];
      const priorText = prior === null || prior === undefined ? "" : typeof prior === "string" ? prior : JSON.stringify(prior);
      // (A recorded "the owner doesn't know" is no answer — the note fills it.)
      const hadValue = priorText.trim() !== "" && !(typeof prior === "string" && isNotKnownValue(prior));
      const priorWins =
        hadValue &&
        (isBrokerFinalSource(prev) || (!prev || isUntrackedSource(prev) ? SOURCE_RANK.interview : effectiveRank(key, prev)) > BROKER_SESSION_RANK);
      if (priorWins) {
        if (priorText.trim() !== String(value).trim()) recordAlternate(facts, key, value, src);
        result.keptBeside.push(key);
        continue;
      }
      if (prev && priorText.trim() && priorText.trim() !== String(value).trim()) recordAlternate(facts, key, prior, prev);
      facts[key] = value;
      setFieldSource(facts, key, src);
      displaceCorroborations(facts, key, value);
      result.written.push(key);
    }
    for (const n of notes) if (addPrivateNote(facts, n.note, { reason: n.reason })) result.notes++;
    return result;
  });
}
