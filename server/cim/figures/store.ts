/**
 * store — every SQL statement for the figure notes, the DD check decisions,
 * the questions about the numbers and the per-deal figure state (spec §7,
 * §9.6, D24). Nothing here calls a model or sends anything.
 *
 * Write rules:
 *   - `cim_figure_state`: each column has its own setter (INSERT … ON
 *     CONFLICT (deal_id) DO UPDATE SET <that column>); nothing writes the row
 *     as a whole, so a build status can never clobber the DD switch.
 *   - The AI budget is ONE statement that needs no prior row and refuses the
 *     5th call of a UTC day (no row returned = cap reached).
 *   - Machine upserts (refresh / build) only overwrite a note that is still
 *     `suggested`, machine-written, never edited, and unchanged since it was
 *     read (its fingerprint); anything else gets the new wording as a
 *     `proposal` beside it (+ `figures_changed` when its values moved).
 *   - Broker writes compare-and-set on the `updated_at` they read (409 else).
 *
 * The functions take an optional drizzle database (tests pass an in-process
 * PGlite one); by default they use the app's.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  cimFigureNotes, cimFigureQuestions, cimFigureState, ddCheckDecisions,
  type CimFigureNote, type CimFigureQuestion, type CimFigureState, type DdCheckDecision,
  type FigureBuildStatus, type FigureLocatedEntry, type FigureNoteEvent, type FigureNoteProposal, type FigureNoteSource, type FigureValuesSnapshot,
} from "@shared/schema";

/** Any drizzle Postgres database (postgres-js in the app, PGlite in tests). */
export type FigureDb = any;

let appDb: FigureDb | null = null;
/** Tests: run every store function on this database (an in-process PGlite); null restores the app's. */
export function _useFigureDbForTests(d: FigureDb | null): void {
  appDb = d;
}
async function dbOf(d?: FigureDb): Promise<FigureDb> {
  if (d) return d;
  if (!appDb) appDb = (await import("../../db")).db;
  return appDb;
}
/** postgres-js returns the rows; PGlite returns { rows }. */
function rowsOf(r: unknown): any[] {
  if (Array.isArray(r)) return r;
  const rows = (r as { rows?: unknown })?.rows;
  return Array.isArray(rows) ? rows : [];
}
async function exec(d: FigureDb | undefined, q: SQL): Promise<any[]> {
  return rowsOf(await (await dbOf(d)).execute(q));
}

// ── Per-deal lock (refresh / build write phase / broker writes) ────────────

const locks = new Map<string, Promise<unknown>>();
/** Runs `fn` after any other figure write of the same deal (a per-deal queue). Never nest for one deal. */
export async function withFigureLock<T>(dealId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(dealId) ?? Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(dealId, tail);
  try {
    return await run;
  } finally {
    if (locks.get(dealId) === tail) locks.delete(dealId);
  }
}

// ── State (one row per deal, one setter per column) ────────────────────────

export async function getFigureState(dealId: string, d?: FigureDb): Promise<CimFigureState | null> {
  const db = await dbOf(d);
  const rows = await db.select().from(cimFigureState).where(eq(cimFigureState.dealId, dealId));
  return rows[0] ?? null;
}

/** The daily AI cap (D19). */
export const FIGURE_AI_DAILY_CAP = 4;

/**
 * Charge one AI call to the deal's budget for `day` (UTC "YYYY-MM-DD").
 * Returns the calls used today, or null when the cap is reached (nothing charged).
 */
export async function chargeFigureBudget(dealId: string, day: string, d?: FigureDb): Promise<number | null> {
  const rows = await exec(d, sql`
    INSERT INTO cim_figure_state (deal_id, budget_day, budget_calls) VALUES (${dealId}, ${day}, 1)
    ON CONFLICT (deal_id) DO UPDATE
      SET budget_calls = CASE WHEN cim_figure_state.budget_day = EXCLUDED.budget_day THEN cim_figure_state.budget_calls + 1 ELSE 1 END,
          budget_day = EXCLUDED.budget_day,
          updated_at = now()
      WHERE cim_figure_state.budget_day IS DISTINCT FROM EXCLUDED.budget_day OR cim_figure_state.budget_calls < ${FIGURE_AI_DAILY_CAP}
    RETURNING budget_calls`);
  return rows.length > 0 ? Number(rows[0].budget_calls) : null;
}

function setColumn(dealId: string, column: string, value: SQL, d?: FigureDb): Promise<any[]> {
  const col = sql.identifier(column);
  return exec(d, sql`
    INSERT INTO cim_figure_state (deal_id, ${col}) VALUES (${dealId}, ${value})
    ON CONFLICT (deal_id) DO UPDATE SET ${col} = EXCLUDED.${col}, updated_at = now()`);
}

const json = (v: unknown) => sql`${JSON.stringify(v ?? null)}::jsonb`;
const ts = (v: Date | null) => (v ? sql`${v.toISOString()}::timestamp` : sql`NULL::timestamp`);

export async function setBuild(dealId: string, build: FigureBuildStatus | null, d?: FigureDb): Promise<void> {
  await setColumn(dealId, "build", json(build), d);
}
export async function setAutoAsk(dealId: string, value: boolean | null, d?: FigureDb): Promise<void> {
  await setColumn(dealId, "auto_ask", value === null ? sql`NULL::boolean` : sql`${value}::boolean`, d);
}
/** Turn the DD checks on (a time + who) or off (null). Both columns in one statement — they are one value. */
export async function setDdShown(dealId: string, at: Date | null, by: string | null, d?: FigureDb): Promise<void> {
  await exec(d, sql`
    INSERT INTO cim_figure_state (deal_id, dd_shown_at, dd_shown_by) VALUES (${dealId}, ${ts(at)}, ${by})
    ON CONFLICT (deal_id) DO UPDATE SET dd_shown_at = EXCLUDED.dd_shown_at, dd_shown_by = EXCLUDED.dd_shown_by, updated_at = now()`);
}
export async function setKeepOut(dealId: string, keepOut: CimFigureState["keepOut"], d?: FigureDb): Promise<void> {
  await setColumn(dealId, "keep_out", json(keepOut), d);
}
/** Adds located results (never removes: a key names the document version it was read from). */
export async function mergeLocated(dealId: string, entries: Record<string, FigureLocatedEntry>, d?: FigureDb): Promise<void> {
  if (Object.keys(entries).length === 0) return;
  await exec(d, sql`
    INSERT INTO cim_figure_state (deal_id, located) VALUES (${dealId}, ${json(entries)})
    ON CONFLICT (deal_id) DO UPDATE SET located = cim_figure_state.located || EXCLUDED.located, updated_at = now()`);
}
export async function setRefreshed(dealId: string, fingerprint: string, d?: FigureDb): Promise<void> {
  await exec(d, sql`
    INSERT INTO cim_figure_state (deal_id, refreshed_fingerprint, refreshed_at) VALUES (${dealId}, ${fingerprint}, now())
    ON CONFLICT (deal_id) DO UPDATE SET refreshed_fingerprint = EXCLUDED.refreshed_fingerprint, refreshed_at = EXCLUDED.refreshed_at, updated_at = now()`);
}

// ── Notes ──────────────────────────────────────────────────────────────

export async function listNotes(dealId: string, d?: FigureDb): Promise<CimFigureNote[]> {
  const db = await dbOf(d);
  return db.select().from(cimFigureNotes).where(eq(cimFigureNotes.dealId, dealId)).orderBy(asc(cimFigureNotes.figureKey));
}

export async function getNote(dealId: string, noteId: string, d?: FigureDb): Promise<CimFigureNote | null> {
  const db = await dbOf(d);
  const rows = await db.select().from(cimFigureNotes).where(and(eq(cimFigureNotes.dealId, dealId), eq(cimFigureNotes.id, noteId)));
  return rows[0] ?? null;
}

/** A note as the machine (refresh / build) writes it. */
export interface MachineNote {
  figureKey: string;
  kind: "movement" | "difference" | "context";
  compareKey: string;
  origin: "computed" | "ai";
  text: string;
  blindText: string | null;
  sources: FigureNoteSource[];
  valuesSnapshot: FigureValuesSnapshot;
  inputFingerprint: string;
}

/**
 * Write a machine note (D24). `seenFingerprint` = the row's fingerprint when
 * it was read (null = there was no row). Returns "written" (inserted or the
 * suggested row updated) or "proposal" (a row the broker owns — approved,
 * hidden, edited, broker-written — or one changed since it was read: only
 * its `proposal` was set, plus `figures_changed` when the values moved).
 */
export async function upsertMachineNote(dealId: string, note: MachineNote, seenFingerprint: string | null, d?: FigureDb): Promise<"written" | "proposal"> {
  const history: FigureNoteEvent[] = [{ at: new Date().toISOString(), by: "cimple", what: "written" }];
  const rows = await exec(d, sql`
    INSERT INTO cim_figure_notes (deal_id, figure_key, kind, compare_key, origin, status, text, blind_text, sources, values_snapshot, input_fingerprint, history)
    VALUES (${dealId}, ${note.figureKey}, ${note.kind}, ${note.compareKey}, ${note.origin}, 'suggested', ${note.text}, ${note.blindText},
            ${json(note.sources)}, ${json(note.valuesSnapshot)}, ${note.inputFingerprint}, ${json(history)})
    ON CONFLICT (deal_id, figure_key, kind, compare_key) DO UPDATE
      SET text = EXCLUDED.text, blind_text = EXCLUDED.blind_text, sources = EXCLUDED.sources,
          values_snapshot = EXCLUDED.values_snapshot, input_fingerprint = EXCLUDED.input_fingerprint,
          origin = EXCLUDED.origin, stale_reason = NULL, proposal = NULL, updated_at = now()
      WHERE cim_figure_notes.status = 'suggested' AND cim_figure_notes.origin <> 'broker'
        AND cim_figure_notes.edited_at IS NULL AND cim_figure_notes.input_fingerprint = ${seenFingerprint ?? ""}
    RETURNING id`);
  if (rows.length > 0) return "written";
  const proposal: FigureNoteProposal = {
    text: note.text, blindText: note.blindText, sources: note.sources, valuesSnapshot: note.valuesSnapshot,
    inputFingerprint: note.inputFingerprint, at: new Date().toISOString(),
  };
  // Never touches text, blind_text or status.
  await exec(d, sql`
    UPDATE cim_figure_notes
       SET proposal = ${json(proposal)},
           stale_reason = CASE
             WHEN stale_reason = 'seller_flagged' THEN stale_reason
             WHEN values_snapshot->>'value' IS DISTINCT FROM ${String(note.valuesSnapshot.value)}
               OR coalesce(values_snapshot->>'fromValue', '') IS DISTINCT FROM ${note.valuesSnapshot.fromValue === undefined ? "" : String(note.valuesSnapshot.fromValue)}
             THEN 'figures_changed' ELSE stale_reason END,
           updated_at = now()
     WHERE deal_id = ${dealId} AND figure_key = ${note.figureKey} AND kind = ${note.kind} AND compare_key = ${note.compareKey}
       AND (proposal IS NULL OR proposal->>'inputFingerprint' IS DISTINCT FROM ${note.inputFingerprint})
       AND input_fingerprint IS DISTINCT FROM ${note.inputFingerprint}`);
  return "proposal";
}

/** Machine notes whose figure no longer exists or is no longer produced: a suggested, unedited machine row is removed. */
export async function removeMachineNote(dealId: string, noteId: string, seenFingerprint: string, d?: FigureDb): Promise<boolean> {
  const rows = await exec(d, sql`
    DELETE FROM cim_figure_notes
     WHERE deal_id = ${dealId} AND id = ${noteId} AND status = 'suggested' AND origin <> 'broker'
       AND edited_at IS NULL AND input_fingerprint = ${seenFingerprint}
    RETURNING id`);
  return rows.length > 0;
}

export type BrokerNoteAction = "approve" | "hide" | "restore" | "use_proposal";

/**
 * A broker's change to a note, compare-and-set on the `updated_at` they read
 * (`version`, ISO). Returns the row, "conflict" (changed meanwhile) or
 * "not_found" (no such note on this deal).
 */
export async function brokerUpdateNote(
  dealId: string,
  noteId: string,
  version: string,
  change: { action?: BrokerNoteAction; text?: string; blindText?: string | null; by: string },
  d?: FigureDb,
): Promise<CimFigureNote | "conflict" | "not_found"> {
  const current = await getNote(dealId, noteId, d);
  if (!current) return "not_found";
  if (!sameInstant(current.updatedAt, version)) return "conflict";
  const now = new Date();
  const events: FigureNoteEvent[] = [...(current.history ?? [])];
  const set: Record<string, unknown> = {};
  if (change.text !== undefined || change.blindText !== undefined) {
    if (change.text !== undefined) set.text = change.text;
    if (change.blindText !== undefined) set.blindText = change.blindText;
    set.editedAt = now;
    events.push({ at: now.toISOString(), by: "broker", what: "edited" });
  }
  switch (change.action) {
    case "approve":
      Object.assign(set, { status: "approved", approvedAt: now, approvedBy: change.by, staleReason: null });
      events.push({ at: now.toISOString(), by: "broker", what: "approved" });
      break;
    case "hide":
      set.status = "hidden";
      events.push({ at: now.toISOString(), by: "broker", what: "hidden" });
      break;
    case "restore":
      Object.assign(set, { status: "suggested", staleReason: null, sellerComment: null });
      events.push({ at: now.toISOString(), by: "broker", what: "restored" });
      break;
    case "use_proposal": {
      const p = current.proposal;
      if (!p) break;
      Object.assign(set, {
        text: p.text, blindText: p.blindText, sources: p.sources, valuesSnapshot: p.valuesSnapshot, inputFingerprint: p.inputFingerprint,
        proposal: null, staleReason: null, status: "suggested",
      });
      events.push({ at: now.toISOString(), by: "broker", what: "proposal_used" });
      break;
    }
    default:
      break;
  }
  set.history = events.slice(-40);
  set.updatedAt = now;
  const db = await dbOf(d);
  const rows = await db.update(cimFigureNotes).set(set)
    .where(and(eq(cimFigureNotes.dealId, dealId), eq(cimFigureNotes.id, noteId), eq(cimFigureNotes.updatedAt, current.updatedAt)))
    .returning();
  return rows[0] ?? "conflict";
}

function sameInstant(a: Date | string | null | undefined, b: string): boolean {
  if (!a) return false;
  const x = new Date(a as any).getTime();
  const y = new Date(b).getTime();
  return Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) < 1;
}

/** A note the broker writes (origin broker, approved at once). Converts a machine row on the same key (its text kept in history). */
export async function upsertBrokerNote(
  dealId: string,
  note: { figureKey: string; kind: "movement" | "difference" | "context"; compareKey: string; text: string; blindText: string | null; sources: FigureNoteSource[]; valuesSnapshot: FigureValuesSnapshot; by: string },
  d?: FigureDb,
): Promise<CimFigureNote> {
  const now = new Date().toISOString();
  const rows = await exec(d, sql`
    INSERT INTO cim_figure_notes (deal_id, figure_key, kind, compare_key, origin, status, text, blind_text, sources, values_snapshot, input_fingerprint, approved_at, approved_by, edited_at, history)
    VALUES (${dealId}, ${note.figureKey}, ${note.kind}, ${note.compareKey}, 'broker', 'approved', ${note.text}, ${note.blindText},
            ${json(note.sources)}, ${json(note.valuesSnapshot)}, 'broker', now(), ${note.by}, now(),
            ${json([{ at: now, by: "broker", what: "written" }, { at: now, by: "broker", what: "approved" }])})
    ON CONFLICT (deal_id, figure_key, kind, compare_key) DO UPDATE
      SET history = cim_figure_notes.history || ${json([{ at: now, by: "cimple", what: "written", comment: "Cimple's earlier wording, replaced by yours" }])}
                    || ${json([{ at: now, by: "broker", what: "written" }, { at: now, by: "broker", what: "approved" }])},
          origin = 'broker', status = 'approved', text = EXCLUDED.text, blind_text = EXCLUDED.blind_text, sources = EXCLUDED.sources,
          values_snapshot = EXCLUDED.values_snapshot, input_fingerprint = 'broker', approved_at = now(), approved_by = EXCLUDED.approved_by,
          edited_at = now(), stale_reason = NULL, proposal = NULL, seller_comment = NULL, updated_at = now()
    RETURNING id`);
  return (await getNote(dealId, String(rows[0].id), d))!;
}

/** The owner's "Change this" (D22): hidden from buyers at once, the comment kept for the broker. */
export async function flagNoteBySeller(dealId: string, noteId: string, comment: string, d?: FigureDb): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = await exec(d, sql`
    UPDATE cim_figure_notes
       SET stale_reason = 'seller_flagged', seller_comment = ${comment.slice(0, 500)},
           history = history || ${json([{ at: now, by: "owner", what: "flagged", comment: comment.slice(0, 500) }])}, updated_at = now()
     WHERE deal_id = ${dealId} AND id = ${noteId} AND status = 'approved'
    RETURNING id`);
  return rows.length > 0;
}

// ── DD check decisions ───────────────────────────────────────────────────

export async function listDecisions(dealId: string, d?: FigureDb): Promise<DdCheckDecision[]> {
  const db = await dbOf(d);
  return db.select().from(ddCheckDecisions).where(eq(ddCheckDecisions.dealId, dealId));
}

export async function putDecision(
  dealId: string,
  decision: { checkKey: string; state: "shown" | "left_out" | "corrected"; reason: string | null; correctedValue: number | null; valuesSnapshot: { base: number; other: number }; by: string },
  d?: FigureDb,
): Promise<void> {
  await exec(d, sql`
    INSERT INTO dd_check_decisions (deal_id, check_key, state, reason, corrected_value, values_snapshot, decided_by, decided_at)
    VALUES (${dealId}, ${decision.checkKey}, ${decision.state}, ${decision.reason}, ${decision.correctedValue === null ? null : String(decision.correctedValue)},
            ${json(decision.valuesSnapshot)}, ${decision.by}, now())
    ON CONFLICT (deal_id, check_key) DO UPDATE
      SET state = EXCLUDED.state, reason = EXCLUDED.reason, corrected_value = EXCLUDED.corrected_value,
          values_snapshot = EXCLUDED.values_snapshot, decided_by = EXCLUDED.decided_by, decided_at = now()`);
}

// ── Questions ──────────────────────────────────────────────────────────

export async function listQuestions(dealId: string, d?: FigureDb): Promise<CimFigureQuestion[]> {
  const db = await dbOf(d);
  return db.select().from(cimFigureQuestions).where(eq(cimFigureQuestions.dealId, dealId)).orderBy(asc(cimFigureQuestions.createdAt));
}

export type QuestionStatus = "suggested" | "ask_seller" | "answered" | "asked" | "closed";

export interface NewQuestion {
  figureKey: string;
  kind: "movement" | "difference";
  compareKey: string;
  captureKey: string;
  question: string;
  valuesShown: Record<string, string | number>;
  status: "suggested" | "ask_seller";
  routedBy: "auto" | "broker" | null;
}

/** A question about the numbers (ON CONFLICT DO NOTHING on deal + figure + kind + compare key). Returns its id when inserted. */
export async function insertQuestionIfAbsent(dealId: string, q: NewQuestion, d?: FigureDb): Promise<string | null> {
  const routed = q.status === "ask_seller";
  const rows = await exec(d, sql`
    INSERT INTO cim_figure_questions (deal_id, figure_key, kind, compare_key, capture_key, question, values_shown, status, routed_at, routed_by)
    VALUES (${dealId}, ${q.figureKey}, ${q.kind}, ${q.compareKey}, ${q.captureKey}, ${q.question}, ${json(q.valuesShown)}, ${q.status},
            ${routed ? sql`now()` : sql`NULL::timestamp`}, ${routed ? q.routedBy : null})
    ON CONFLICT (deal_id, figure_key, kind, compare_key) DO NOTHING
    RETURNING id`);
  return rows.length > 0 ? String(rows[0].id) : null;
}

export async function getQuestion(dealId: string, id: string, d?: FigureDb): Promise<CimFigureQuestion | null> {
  const db = await dbOf(d);
  const rows = await db.select().from(cimFigureQuestions).where(and(eq(cimFigureQuestions.dealId, dealId), eq(cimFigureQuestions.id, id)));
  return rows[0] ?? null;
}

export interface QuestionChange {
  status?: QuestionStatus;
  routedAt?: Date | null;
  routedBy?: "auto" | "broker" | null;
  raisedAt?: Date | null;
  sessionId?: string | null;
  closedReason?: string | null;
  question?: string;
  valuesShown?: Record<string, string | number>;
}

/**
 * Compare-and-set on the status read (like updateDiscrepancyIfStill): the
 * change applies only while the question is still in one of `from`.
 * Returns true when it applied.
 */
export async function updateQuestionIf(dealId: string, id: string, from: QuestionStatus[], change: QuestionChange, d?: FigureDb): Promise<boolean> {
  if (from.length === 0) return false;
  const db = await dbOf(d);
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(change)) if (v !== undefined) set[k] = v;
  const rows = await db.update(cimFigureQuestions).set(set)
    .where(and(eq(cimFigureQuestions.dealId, dealId), eq(cimFigureQuestions.id, id), inArray(cimFigureQuestions.status, from)))
    .returning({ id: cimFigureQuestions.id });
  return rows.length > 0;
}

// ── Bulk approval and the review sheet ─────────────────────────────────────

/** Why a note can't be approved in bulk (null = it can). */
export function bulkApproveRefusal(n: Pick<CimFigureNote, "status" | "staleReason" | "sources">): string | null {
  if (n.status === "approved") return "already shown to buyers";
  if (n.status !== "suggested") return "hidden";
  if (n.staleReason === "seller_flagged") return "the owner asked for a change";
  if (n.staleReason) return "the figures changed";
  const sources = n.sources ?? [];
  if (sources.length > 0 && sources.every((s) => s.internal === true)) return "based only on your internal note; check the wording first";
  return null;
}

/**
 * Approve suggested notes by id (compare-and-set on status 'suggested' and
 * — when given — the fingerprint the broker saw). Returns what was approved
 * and what was skipped, with the reason.
 */
export async function approveNotes(
  dealId: string,
  items: Array<{ id: string; fingerprint?: string | null }>,
  by: string,
  d?: FigureDb,
  opts: { allowInternal?: boolean } = {},
): Promise<{ approved: string[]; skipped: Array<{ id: string; reason: string }> }> {
  const approved: string[] = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  const notes = new Map((await listNotes(dealId, d)).map((n) => [n.id, n]));
  const now = new Date().toISOString();
  for (const item of items) {
    const n = notes.get(item.id);
    if (!n) { skipped.push({ id: item.id, reason: "not found" }); continue; }
    const refusal = bulkApproveRefusal(n);
    if (refusal && !(opts.allowInternal && refusal.startsWith("based only"))) { skipped.push({ id: item.id, reason: refusal }); continue; }
    if (item.fingerprint && item.fingerprint !== n.inputFingerprint) { skipped.push({ id: item.id, reason: "changed while you were reviewing" }); continue; }
    const rows = await exec(d, sql`
      UPDATE cim_figure_notes
         SET status = 'approved', approved_at = now(), approved_by = ${by}, stale_reason = NULL,
             history = history || ${json([{ at: now, by: "broker", what: "approved" }])}, updated_at = now()
       WHERE deal_id = ${dealId} AND id = ${item.id} AND status = 'suggested' AND stale_reason IS NULL
         AND input_fingerprint = ${n.inputFingerprint}
      RETURNING id`);
    if (rows.length > 0) approved.push(item.id);
    else skipped.push({ id: item.id, reason: "changed while you were reviewing" });
  }
  return { approved, skipped };
}

/** Run `fn` in one database transaction (the review sheet's publish). */
export async function inFigureTransaction<T>(fn: (tx: FigureDb) => Promise<T>, d?: FigureDb): Promise<T> {
  const db = await dbOf(d);
  return db.transaction(async (tx: FigureDb) => fn(tx));
}

/** Counts for the CIM tab's lines and the follow-up card (cheap). */
export async function figureCounts(dealId: string, d?: FigureDb): Promise<{ notesWaiting: number; notesShown: number; ownerFlagged: number; questionsSuggested: number; questionsWithSeller: number }> {
  const rows = await exec(d, sql`
    SELECT
      (SELECT count(*)::int FROM cim_figure_notes WHERE deal_id = ${dealId} AND status = 'suggested' AND stale_reason IS NULL
         AND NOT (origin = 'computed' AND kind = 'difference')) AS waiting,
      (SELECT count(*)::int FROM cim_figure_notes WHERE deal_id = ${dealId} AND status = 'approved' AND stale_reason IS NULL) AS shown,
      (SELECT count(*)::int FROM cim_figure_notes WHERE deal_id = ${dealId} AND status = 'approved' AND stale_reason = 'seller_flagged') AS flagged,
      (SELECT count(*)::int FROM cim_figure_questions WHERE deal_id = ${dealId} AND status = 'suggested') AS suggested,
      (SELECT count(*)::int FROM cim_figure_questions WHERE deal_id = ${dealId} AND status = 'ask_seller') AS with_seller`);
  const r = rows[0] ?? {};
  return { notesWaiting: Number(r.waiting ?? 0), notesShown: Number(r.shown ?? 0), ownerFlagged: Number(r.flagged ?? 0), questionsSuggested: Number(r.suggested ?? 0), questionsWithSeller: Number(r.with_seller ?? 0) };
}

// ── Cache key parts ──────────────────────────────────────────────────────

/** When each figure table last changed for this deal (the serve cache's key). */
export async function figureTablesStamp(dealId: string, d?: FigureDb): Promise<string> {
  const rows = await exec(d, sql`
    SELECT
      (SELECT max(updated_at)::text FROM cim_figure_notes WHERE deal_id = ${dealId}) AS notes,
      (SELECT count(*)::text FROM cim_figure_notes WHERE deal_id = ${dealId}) AS notes_n,
      (SELECT max(updated_at)::text FROM cim_figure_questions WHERE deal_id = ${dealId}) AS questions,
      (SELECT max(decided_at)::text FROM dd_check_decisions WHERE deal_id = ${dealId}) AS decisions,
      (SELECT count(*)::text FROM dd_check_decisions WHERE deal_id = ${dealId}) AS decisions_n,
      (SELECT updated_at::text FROM cim_figure_state WHERE deal_id = ${dealId}) AS state`);
  const r = rows[0] ?? {};
  return [r.notes, r.notes_n, r.questions, r.decisions, r.decisions_n, r.state].map((x) => x ?? "-").join("|");
}
