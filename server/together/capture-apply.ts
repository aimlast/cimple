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
 * Live capture (§5.7): applyCapture merges a guarded part of the
 * conversation through mergeExtractionIntoDeal (call provenance, decision A,
 * staff-private routing, alternates, merge discrepancies — exactly as an
 * uploaded call transcript), recording per key a before and an after
 * snapshot and the sitting's "applied" marker IN THE SAME SAVE, so a part is
 * applied exactly once and Undo can put the value back. The broker's typed
 * notes go through writeBrokerCallNotes (never the seller's words).
 */
import type { Deal, TogetherChunk, TogetherSitting } from "@shared/schema";
import type { CoverageBoard, CoverageItem } from "@shared/coverage-board";
import { boardFromCoverage, coverageValueText, loadCoverageInputs, valueHash, type CoverageLoaders } from "../interview/coverage-board";
import {
  FIELD_ALTERNATES_KEY,
  FIELD_CORROBORATIONS_KEY,
  getFieldAlternates,
  getFieldCorroborations,
  getFieldSources,
  setFieldSource,
  type FieldSource,
} from "../interview/info-merger";
import { mutateDealInfo } from "../information/facts";
import { clearMark, setMark } from "./marks";
import { BoardActionError } from "./errors";
import { storage } from "../storage";
import { togetherStore } from "./store";
import { withSittingQueue } from "./queue";
import type { GuardedCapture } from "./capture-guards";

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
  /** Undo snapshots of what was written. */
  filed: FiledRow[];
  /** The part was already filed (a retry). */
  skipped?: boolean;
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
  ctx: { sittingId: string; at?: string; chunk?: { id: string; chunkNo: number } },
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
  const result: CallNoteResult = { written: [], keptBeside: [], dropped: [], notes: 0, filed: [] };
  return mutateDealInfo(dealId, (info) => {
    const facts = info as Record<string, unknown>;
    // A typed part of a session is filed exactly once.
    if (ctx.chunk && isApplied(facts, ctx.sittingId, ctx.chunk.chunkNo)) { result.skipped = true; return result; }
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
    const src = { source: "broker" as const, note: BROKER_CALL_SOURCE_NOTE, at, sittingId: ctx.sittingId, ...(ctx.chunk ? { chunkId: ctx.chunk.id } : {}) };
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
      const beforeSnap = snapshotKey(facts, key);
      if (prev && priorText.trim() && priorText.trim() !== String(value).trim()) recordAlternate(facts, key, prior, prev);
      facts[key] = value;
      setFieldSource(facts, key, src);
      displaceCorroborations(facts, key, value);
      result.written.push(key);
      result.filed.push({ key, before: beforeSnap, after: snapshotKey(facts, key), kind: "typed", value: String(value) });
    }
    for (const n of notes) if (addPrivateNote(facts, n.note, { reason: n.reason })) result.notes++;
    if (ctx.chunk) markApplied(facts, ctx.sittingId, ctx.chunk.chunkNo);
    return result;
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Undo snapshots (§5.7)
// ─────────────────────────────────────────────────────────────────────────

/** Deal facts bookkeeping: the parts of each sitting already applied (saved with the facts they filed). */
export const APPLIED_KEY = "_togetherApplied";

/** Was this part of the sitting already applied? (An older single number means "every part up to it".) */
export function isApplied(info: Record<string, unknown>, sittingId: string, chunkNo: number): boolean {
  const v = ((info[APPLIED_KEY] as Record<string, unknown> | undefined) ?? {})[sittingId];
  if (typeof v === "number") return chunkNo <= v;
  return Array.isArray(v) && v.includes(chunkNo);
}

/** Records the part as applied (mutates). */
export function markApplied(info: Record<string, unknown>, sittingId: string, chunkNo: number): void {
  const all = { ...((info[APPLIED_KEY] as Record<string, unknown> | undefined) ?? {}) };
  const v = all[sittingId];
  const list = Array.isArray(v) ? (v as number[]) : typeof v === "number" ? Array.from({ length: v }, (_, i) => i + 1) : [];
  if (!list.includes(chunkNo)) all[sittingId] = [...list, chunkNo].slice(-2000);
  info[APPLIED_KEY] = all;
}

export interface KeySnapshot {
  value: unknown;
  source: FieldSource | null;
  /** Alternates / corroborations of the key (and of its years, "revenueByYear.2024"). */
  alternates: Record<string, unknown[]>;
  corroborations: Record<string, unknown[]>;
}

export interface FiledRow {
  key: string;
  itemId?: string | null;
  before: KeySnapshot;
  after: KeySnapshot;
  kind: "spoken" | "typed" | "noted";
  value: string;
  quote?: string;
  undoneAt?: string;
}

const ownKeys = (map: Record<string, unknown[]>, key: string) =>
  Object.fromEntries(Object.entries(map).filter(([k]) => k === key || k.startsWith(`${key}.`)).map(([k, v]) => [k, structuredClone(v)]));

export function snapshotKey(info: Record<string, unknown>, key: string): KeySnapshot {
  const v = info[key];
  return {
    value: v === undefined ? null : structuredClone(v),
    source: getFieldSources(info)[key] ? structuredClone(getFieldSources(info)[key]) : null,
    alternates: ownKeys(getFieldAlternates(info) as Record<string, unknown[]>, key),
    corroborations: ownKeys(getFieldCorroborations(info) as Record<string, unknown[]>, key),
  };
}

export function sameSnapshot(a: KeySnapshot, b: KeySnapshot): boolean {
  return JSON.stringify([a.value, a.source, a.alternates]) === JSON.stringify([b.value, b.source, b.alternates]);
}

/** Puts a key back exactly as it was (value, source, alternates, corroborations). Mutates `info`. */
export function restoreKey(info: Record<string, unknown>, key: string, snap: KeySnapshot): void {
  if (snap.value === null || snap.value === undefined) delete info[key];
  else info[key] = structuredClone(snap.value);
  const sources = { ...getFieldSources(info) };
  if (snap.source) sources[key] = structuredClone(snap.source);
  else delete sources[key];
  info["_fieldSources"] = sources;
  for (const [mapKey, snapMap] of [[FIELD_ALTERNATES_KEY, snap.alternates], [FIELD_CORROBORATIONS_KEY, snap.corroborations]] as const) {
    const all = { ...((info[mapKey] as Record<string, unknown[]> | undefined) ?? {}) };
    for (const k of Object.keys(all)) if (k === key || k.startsWith(`${key}.`)) delete all[k];
    Object.assign(all, structuredClone(snapMap));
    if (Object.keys(all).length > 0) info[mapKey] = all;
    else delete info[mapKey];
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Applying a guarded part (§5.7)
// ─────────────────────────────────────────────────────────────────────────

export interface ChunkResult {
  filed: FiledRow[];
  suggestions: Array<{ itemId: string; memberKey: string; value: string; quote: string; lines: number[]; confidence: "confirmed" | "approximate" }>;
  dropped: Array<{ key: string; code: string }>;
  notKnown: Array<{ key: string; itemId: string | null; whoHasIt?: string }>;
  brokerUnconfirmed: Array<{ key: string; itemId: string | null; value: string; quote: string }>;
  followUp: { itemId?: string; ask: string } | null;
  topicSections: string[];
  privateNotes: number;
  /** Nothing in this part answered anything. */
  nothing: boolean;
}

/** The meta maps a call transcript's extraction carries per key. */
const META_MAPS = ["_speakers", "_confidence", "_excerpts", "_verify"] as const;

/** The transcript row's extraction: every applied part's delta (latest value per key) minus what was undone. Pure. */
export function cumulativeExtraction(prev: Record<string, unknown> | null | undefined, delta: Record<string, unknown>, undone: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = { ...(prev ?? {}) };
  for (const [k, v] of Object.entries(delta)) {
    if (k === "_privateNotes") {
      const list = Array.isArray(out._privateNotes) ? (out._privateNotes as string[]) : [];
      out._privateNotes = Array.from(new Set([...list, ...((Array.isArray(v) ? v : []) as string[])])).slice(-40);
    } else if ((META_MAPS as readonly string[]).includes(k)) {
      out[k] = { ...((out[k] as Record<string, unknown>) ?? {}), ...((v as Record<string, unknown>) ?? {}) };
    } else if (!k.startsWith("_")) {
      out[k] = v;
    }
  }
  for (const key of undone) {
    delete out[key];
    for (const m of META_MAPS) if (out[m] && typeof out[m] === "object") delete (out[m] as Record<string, unknown>)[key];
  }
  if (!out.summary) out.summary = "Answers filed live during Interview together.";
  return out;
}

export interface ApplyArgs {
  sitting: TogetherSitting;
  chunk: Pick<TogetherChunk, "id" | "chunkNo">;
  guarded: GuardedCapture;
  /** "Tony Moretti (seller)" */
  sellerLabel: string;
  now?: Date;
}

/**
 * Files a guarded part. Spoken answers (and "also noted" facts) through
 * mergeExtractionIntoDeal with the applied marker and undo snapshots in the
 * same save; typed ones as the broker's call notes; "doesn't know" as a mark.
 * Returns the chunk's result (held answers, what the broker said with no
 * reply, the follow-up idea are passed through for the board).
 */
export async function applyCapture(args: ApplyArgs): Promise<ChunkResult> {
  const { sitting, chunk, guarded } = args;
  const result: ChunkResult = {
    filed: [],
    suggestions: guarded.suggestions.map(({ speaker: _s, ...h }) => h),
    dropped: guarded.dropped,
    notKnown: guarded.notKnown.map(({ quote: _q, ...n }) => n),
    brokerUnconfirmed: guarded.brokerUnconfirmed,
    followUp: guarded.followUp,
    topicSections: guarded.topicSections,
    privateNotes: guarded.privateNotes.length,
    nothing: false,
  };
  const deal = await storage.getDeal(sitting.dealId);
  if (!deal) return result;

  // ── typed: the broker's own notes ──
  if (guarded.typed.length > 0) {
    const notes = await writeBrokerCallNotes(sitting.dealId, guarded.typed.map((t) => ({ key: t.key, value: t.value })), { sittingId: sitting.id, chunk });
    for (const f of notes.filed) result.filed.push({ ...f, itemId: guarded.typed.find((t) => t.key === f.key)?.itemId ?? null });
  }

  // ── spoken: the seller's words, as a call transcript ──
  const spoken = [
    ...guarded.spoken.map((a) => ({ key: a.key, itemId: a.itemId, value: a.value, excerpt: a.excerpt, confidence: a.confidence, verify: a.verify, kind: "spoken" as const })),
    ...guarded.otherFacts.map((o) => ({ key: o.key, itemId: `${o.sectionKey}:${o.key}`, value: o.value, excerpt: o.quote, confidence: o.confidence, verify: undefined, kind: "noted" as const })),
  ];
  const needsMerge = spoken.length > 0 || guarded.retractions.length > 0 || guarded.privateNotes.length > 0 || guarded.keepOut.length > 0;
  if (needsMerge) {
    const { ensureTranscriptDocument } = await import("./transcript");
    // (In the sitting's queue: the first line and the first filing never create two rows.)
    const docId = await withSittingQueue(sitting.id, async () => {
      const s = (await togetherStore().getSitting(sitting.id)) ?? sitting;
      if (((s.captureState ?? {}) as { sourceDeleted?: boolean }).sourceDeleted) return null;
      return ensureTranscriptDocument(s, deal);
    });
    const doc = docId ? await storage.getDocument(docId) : undefined;
    if (doc) {
      const delta: Record<string, unknown> = {};
      const speakers: Record<string, string> = {};
      const confidence: Record<string, string> = {};
      const excerpts: Record<string, string> = {};
      const verify: Record<string, string> = {};
      for (const a of spoken) {
        delta[a.key] = a.value;
        speakers[a.key] = args.sellerLabel;
        confidence[a.key] = a.confidence;
        excerpts[a.key] = a.excerpt.slice(0, 200);
        if (a.verify) verify[a.key] = a.verify;
      }
      Object.assign(delta, { _speakers: speakers, _confidence: confidence, _excerpts: excerpts, _verify: verify });
      if (guarded.privateNotes.length > 0) delta._privateNotes = guarded.privateNotes.map((n) => n.note);
      const touched = new Set<string>([...spoken.map((a) => a.key), ...guarded.retractions.map((r) => r.field)]);
      const kindOf = new Map(spoken.map((a) => [a.key, a] as const));
      const { mergeExtractionIntoDeal } = await import("../documents/ingest");
      await mergeExtractionIntoDeal(doc, delta as never, {
        keepOut: guarded.keepOut,
        retractions: guarded.retractions,
        reviewNotes: process.env.ANTHROPIC_API_KEY !== "disabled",
        beforeSave: (merged, before) => {
          if (isApplied(before, sitting.id, chunk.chunkNo)) return "skip";
          for (const key of Array.from(touched)) {
            const beforeSnap = snapshotKey(before, key);
            const src = getFieldSources(merged)[key];
            if (src && src.documentId === doc.id && JSON.stringify(src) !== JSON.stringify(beforeSnap.source)) {
              setFieldSource(merged, key, { ...src, sittingId: sitting.id, chunkId: chunk.id });
            }
            const afterSnap = snapshotKey(merged, key);
            if (JSON.stringify(afterSnap) === JSON.stringify(beforeSnap)) continue;
            const a = kindOf.get(key);
            result.filed.push({ key, itemId: a?.itemId ?? null, before: beforeSnap, after: afterSnap, kind: a?.kind ?? "spoken", value: a?.value ?? "", ...(a?.excerpt ? { quote: a.excerpt } : {}) });
          }
          markApplied(merged, sitting.id, chunk.chunkNo);
        },
      });
      // The transcript row's extraction: the union of every applied part (minus what was undone —
      // a key filed again after its Undo stands again).
      const fresh = await storage.getDocument(doc.id);
      if (fresh) {
        const s = (await togetherStore().getSitting(sitting.id)) ?? sitting;
        const state = (s.captureState ?? {}) as { undone?: Array<{ chunkId: string; key: string }> };
        const refiled = (state.undone ?? []).filter((u) => u.key in delta && result.filed.some((f) => f.key === u.key));
        const undone = (state.undone ?? []).filter((u) => !refiled.includes(u));
        if (refiled.length > 0) await togetherStore().mergeCaptureState(s.id, { undone });
        await storage.updateDocument(doc.id, { extractedData: cumulativeExtraction(fresh.extractedData as Record<string, unknown>, delta, undone.map((u) => u.key)) } as never);
      }
      // "Also noted" facts become checklist items (after the filing — never nested in its lock).
      const noted = guarded.otherFacts.filter((o) => result.filed.some((f) => f.key === o.key));
      if (noted.length > 0) {
        const { appendNotedItems } = await import("../interview/outline");
        await appendNotedItems(sitting.dealId, noted.map((o) => ({ key: o.key, label: o.label, sectionKey: o.sectionKey })));
      }
    }
  }

  // ── "doesn't know — Denise has it": a mark, never a value ──
  for (const n of guarded.notKnown) {
    if (!n.itemId) continue;
    await setMark({ dealId: sitting.dealId, itemId: n.itemId, sectionKey: n.itemId.split(":")[0], kind: "not_known", note: n.whoHasIt ?? null, sittingId: sitting.id, createdBy: "system" }).catch(() => undefined);
  }
  result.nothing = result.filed.length === 0 && guarded.suggestions.length === 0 && guarded.notKnown.length === 0 && guarded.brokerUnconfirmed.length === 0 && guarded.privateNotes.length === 0;
  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Undo (§5.7)
// ─────────────────────────────────────────────────────────────────────────

/**
 * Puts one filed value back exactly as it was before the part filed it —
 * only while it is still what the part wrote ("This was changed since — use
 * Edit." otherwise). Recorded on the sitting so no later replay re-files it.
 */
export async function undoCapture(args: { sitting: TogetherSitting; chunk: TogetherChunk; key: string; at?: Date }): Promise<{ key: string }> {
  const { sitting, chunk, key } = args;
  const res = (chunk.result ?? null) as ChunkResult | null;
  const row = res?.filed?.find((f) => f.key === key && !f.undoneAt);
  if (!res || !row) throw new BoardActionError("That filing isn't there any more.", 404, "not_found");
  await mutateDealInfo(sitting.dealId, (info) => {
    const facts = info as Record<string, unknown>;
    if (!sameSnapshot(snapshotKey(facts, key), row.after)) throw new BoardActionError("This was changed since — use Edit.", 409, "changed");
    restoreKey(facts, key, row.before);
  });
  const at = (args.at ?? new Date()).toISOString();
  // The chunk remembers it, the sitting lists it (no replay or reprocess re-files it).
  const filed = res.filed.map((f) => (f === row ? { ...f, undoneAt: at } : f));
  await togetherStore().updateChunk(chunk.id, { result: { ...res, filed } });
  const fresh = (await togetherStore().getSitting(sitting.id)) ?? sitting;
  const state = (fresh.captureState ?? {}) as { undone?: Array<{ chunkId: string; key: string }> };
  const undone = [...(state.undone ?? []), { chunkId: chunk.id, key }];
  await togetherStore().mergeCaptureState(sitting.id, { undone });
  if (fresh.transcriptDocumentId) {
    const doc = await storage.getDocument(fresh.transcriptDocumentId);
    if (doc) await storage.updateDocument(doc.id, { extractedData: cumulativeExtraction(doc.extractedData as Record<string, unknown>, {}, undone.map((u) => u.key)) } as never);
  }
  const { settleMergeRowsQuietly } = await import("../documents/merge-conflicts");
  await settleMergeRowsQuietly(sitting.dealId, "together-undo");
  if (row.kind === "noted") {
    const { removeNotedItem } = await import("../interview/outline");
    await removeNotedItem(sitting.dealId, key);
  }
  return { key };
}
