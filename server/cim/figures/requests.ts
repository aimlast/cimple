/**
 * requests — questions about the numbers for the seller (spec D13, §6).
 * They live in cim_figure_questions, never in `discrepancies`: no conflict
 * engine, no CIM lock and no completion rule ever sees them.
 *
 *   planQuestions (pure)        what to ask, what is answered, what to close
 *   planExplainQuestions        runs after an analysis, at an interview's
 *                               start, after a sitting and after each refresh
 *   markExplainQuestionsRaised  a session's hand-back: answered / asked /
 *                               (when the interview completes) an auto-routed
 *                               question never raised goes back to suggested
 *   closeAnsweredQuestions      a question whose note the broker approved
 *   explainRequestsFor          the interview prompt's optional block
 *   figureQuestionsForBoard     "Interview together" board items (together's contract)
 *
 * Seller-facing values are the statements as issued from shared documents —
 * an analysis line only when its value is printed in a shared statement's
 * text. Never a reclassified or normalised figure, never a broker-only file.
 * No AI, no email: the running interview raises auto-routed questions;
 * after the interview they wait for the broker's "Ask the seller".
 */
import { dollars } from "@shared/figure-compare";
import { lowerFirst, shortLabel } from "@shared/figure-copy";
import { captureKeyFor, explainBoardItems, type ExplainBoardItem } from "@shared/figure-explain";
import type { FigureRegistry } from "@shared/figure-anchors";
import type { FigureCheckInput } from "@shared/figure-layer";
import { baseLineOf, lineWords, standardLine, type StandardLineId } from "@shared/figure-lines";
import { locatedIn } from "@shared/figure-compare";
import type { CimFigureQuestion } from "@shared/schema";
import { explainCandidates, type CandidateNoteRow, type DiscrepancyLike, type FigureCandidate } from "./candidates";
import { ownValue, sourceFor, type FinancialSource } from "./sources";
import type { NewQuestion, QuestionStatus } from "./store";

/**
 * Deals created before this moment start with "Ask during the interview
 * automatically" OFF (D13: no change to live interviews on deploy).
 * The release's ship day (release review security-integration F3: was a
 * placeholder ten days out). If the deploy slips past it, set the Railway
 * variable FIGURES_AUTO_ASK_SINCE to the deploy time (ISO) — no code change —
 * so deals created before the deploy keep it off.
 */
export const AUTO_ASK_SINCE = "2026-10-11T00:00:00.000Z";

/** The moment in force: FIGURES_AUTO_ASK_SINCE when it is a valid date, else AUTO_ASK_SINCE. */
export function autoAskSince(env: Record<string, string | undefined> = process.env): number {
  const v = env.FIGURES_AUTO_ASK_SINCE?.trim();
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : Date.parse(AUTO_ASK_SINCE);
}

export const MAX_OPEN_QUESTIONS = 6;
export const MAX_AUTO_ROUTED = 3;

/** Is auto-ask on for this deal: the broker's choice, else on for deals created since the release. */
export function autoAskEffective(chosen: boolean | null | undefined, dealCreatedAt: Date | string | null | undefined): boolean {
  if (typeof chosen === "boolean") return chosen;
  if (!dealCreatedAt) return false;
  const t = new Date(dealCreatedAt as any).getTime();
  return Number.isFinite(t) && t >= autoAskSince();
}

const OPEN: ReadonlySet<string> = new Set(["suggested", "ask_seller"]);

/** "fuel", "cost of sales", "facility rent — warehouse". */
export function lineWordOf(c: Pick<FigureCandidate, "line" | "lineLabel">): string {
  const std = standardLine(baseLineOf(String(c.line)));
  return std ? std.blindWord : lowerFirst(shortLabel(c.lineLabel));
}

function otherWord(kind: string | undefined): string {
  return kind === "management" ? "management accounts" : "tax return";
}

/** The seller wording of a question. */
export function questionWording(c: FigureCandidate): string {
  const line = lineWordOf(c);
  if (c.kind === "movement") {
    const up = Math.abs(c.value) >= Math.abs(c.fromValue ?? 0);
    return `What was behind the ${up ? "rise" : "drop"} in ${line} in ${c.year}?`;
  }
  return `Why does ${line} for ${c.year} differ between the financial statements and the ${otherWord(c.otherKind)}?`;
}

/** "Your statements show $5,420,000 in 2022 and $4,760,000 in 2023." (null when the question carries no numbers). */
export function valuesSentence(v: Record<string, string | number> | null | undefined): string | null {
  if (!v) return null;
  if (typeof v.from === "number" && typeof v.value === "number" && v.fromYear && v.year) {
    return `Your statements show ${dollars(v.from)} in ${v.fromYear} and ${dollars(v.value)} in ${v.year}.`;
  }
  if (typeof v.statements === "number" && typeof v.other === "number" && v.year) {
    return `For ${v.year}, the financial statements show ${dollars(v.statements)} and the ${v.otherKind ?? "tax return"} shows ${dollars(v.other)}.`;
  }
  return null;
}

/** The question as the broker and the seller read it, numbers included. */
export function questionDisplay(q: Pick<CimFigureQuestion, "question" | "valuesShown">): string {
  const v = valuesSentence(q.valuesShown as Record<string, string | number>);
  return v ? `${q.question} (${v})` : q.question;
}

export interface StatementText {
  source: FinancialSource;
  text: string | null;
}

/**
 * The figures the seller may be shown: statements as issued (a shared
 * statement's own extracted value, else the next year's comparative), or an
 * analysis line's value only when it is printed in that statement's text.
 */
export function sellerValues(c: FigureCandidate, statements: StatementText[], checks: ReadonlyArray<FigureCheckInput>): Record<string, string | number> {
  const line = lineWordOf(c);
  const sources = statements.map((s) => s.source);
  const textOf = (src: FinancialSource | null) => (src ? statements.find((s) => s.source.documentId === src.documentId)?.text ?? null : null);
  const std = standardLine(baseLineOf(String(c.line)));
  const valueFor = (year: string, analysisValue: number | undefined): number | null => {
    const own = sourceFor(sources, "statements", year);
    const next = sourceFor(sources, "statements", String(Number(year) + 1));
    if (std) {
      const id = std.id as StandardLineId;
      const v = ownValue(own, id) ?? next?.values[id]?.[year];
      return typeof v === "number" ? v : null;
    }
    if (typeof analysisValue !== "number") return null;
    for (const src of [own, next]) {
      const t = textOf(src);
      if (t && locatedIn(t, analysisValue)) return analysisValue;
    }
    return null;
  };
  if (c.kind === "movement" && c.fromYear) {
    const value = valueFor(c.year, c.value);
    const from = valueFor(c.fromYear, c.fromValue);
    if (value !== null && from !== null) return { line, fromYear: c.fromYear, from: Math.abs(from), year: c.year, value: Math.abs(value) };
    return { line };
  }
  const check = checks.find((x) => x.key === c.checkKey);
  if (check && check.located && typeof c.other === "number") {
    return { line, year: c.year, statements: Math.abs(check.base), other: Math.abs(check.other), otherKind: otherWord(c.otherKind) };
  }
  return { line };
}

export interface PlanInput {
  registry: FigureRegistry;
  anchoredKeys: Iterable<string>;
  checks: ReadonlyArray<FigureCheckInput>;
  notes: ReadonlyArray<CandidateNoteRow & { id?: string }>;
  facts: Record<string, unknown>;
  hints: Record<string, string>;
  discrepancies: ReadonlyArray<DiscrepancyLike>;
  questions: ReadonlyArray<Pick<CimFigureQuestion, "id" | "figureKey" | "kind" | "compareKey" | "captureKey" | "status" | "routedBy">>;
  statements: StatementText[];
  /** Auto-ask on, a seller-line session exists and the interview isn't completed. */
  autoRoute: boolean;
}

export interface PlanResult {
  inserts: NewQuestion[];
  answered: string[];
  closed: Array<{ id: string; reason: "note_approved" | "figures_changed" }>;
}

/** A fact recorded under a question's capture key (the seller's or the broker's answer). */
export function answerOf(facts: Record<string, unknown>, captureKey: string): string | null {
  const v = facts[captureKey];
  if (v === null || v === undefined || typeof v === "object") return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** Pure: what the planner writes. */
export function planQuestions(input: PlanInput): PlanResult {
  const answered: string[] = [];
  const closed: PlanResult["closed"] = [];
  const approved = new Set(
    input.notes.filter((n) => n.status === "approved").map((n) => (n.kind === "difference" ? `${n.figureKey}|difference|${n.compareKey}` : `${n.figureKey}|movement`)),
  );
  for (const q of input.questions) {
    if (q.status === "closed") continue;
    const noteKey = q.kind === "difference" ? `${q.figureKey}|difference|${q.compareKey}` : `${q.figureKey}|movement`;
    if (approved.has(noteKey)) { closed.push({ id: q.id, reason: "note_approved" }); continue; }
    if (!input.registry[q.figureKey] && q.status === "suggested") { closed.push({ id: q.id, reason: "figures_changed" }); continue; }
    if ((q.status === "suggested" || q.status === "ask_seller" || q.status === "asked") && answerOf(input.facts, q.captureKey)) answered.push(q.id);
  }
  const done = new Set([...answered, ...closed.map((c) => c.id)]);
  const existing = new Set(input.questions.map((q) => `${q.figureKey}|${q.kind}|${q.compareKey}`));
  let open = input.questions.filter((q) => OPEN.has(q.status) && !done.has(q.id)).length;
  let autoOpen = input.questions.filter((q) => q.status === "ask_seller" && q.routedBy === "auto" && !done.has(q.id)).length;
  const inserts: NewQuestion[] = [];
  const targets = explainCandidates({
    registry: input.registry, anchoredKeys: input.anchoredKeys, checks: input.checks, notes: input.notes,
    facts: input.facts, hints: input.hints, discrepancies: input.discrepancies,
  });
  for (const c of targets) {
    if (open >= MAX_OPEN_QUESTIONS) break;
    if (existing.has(c.key)) continue;
    const route = input.autoRoute && autoOpen < MAX_AUTO_ROUTED;
    inserts.push({
      figureKey: c.figureKey, kind: c.kind, compareKey: c.compareKey,
      captureKey: captureKeyFor(c.lineLabel, c.kind, c.year),
      question: questionWording(c),
      valuesShown: sellerValues(c, input.statements, input.checks),
      status: route ? "ask_seller" : "suggested",
      routedBy: route ? "auto" : null,
    });
    open++;
    if (route) autoOpen++;
  }
  return { inserts, answered, closed };
}

// ── Running it on a deal ────────────────────────────────────────────────

/** The deal's state the planner needs (sessions, interview, auto-ask). */
async function dealPlanContext(dealId: string): Promise<{ createdAt: Date | null; interviewCompleted: boolean; sellerSession: boolean; discrepancies: DiscrepancyLike[]; sections: Array<{ id: string; layoutType: string; layoutData: unknown }> }> {
  const { db } = await import("../../db");
  const { deals, discrepancies, cimSections } = await import("@shared/schema");
  const { eq, sql } = await import("drizzle-orm");
  const [dealRows, sessionRows, discRows, sections] = await Promise.all([
    db.select({ createdAt: deals.createdAt, interviewCompleted: deals.interviewCompleted }).from(deals).where(eq(deals.id, dealId)),
    // Only who ran each session (never the transcripts): a broker-alone session isn't the seller's line.
    db.execute(sql`SELECT extracted_info->>'_conductedBy' AS mode FROM interview_sessions WHERE deal_id = ${dealId}`),
    db.select({ field: discrepancies.field, factKey: discrepancies.factKey, factYear: discrepancies.factYear, status: discrepancies.status }).from(discrepancies).where(eq(discrepancies.dealId, dealId)),
    db.select({ id: cimSections.id, layoutType: cimSections.layoutType, layoutData: cimSections.layoutData }).from(cimSections).where(eq(cimSections.dealId, dealId)),
  ]);
  return {
    createdAt: dealRows[0]?.createdAt ?? null,
    interviewCompleted: !!dealRows[0]?.interviewCompleted,
    sellerSession: (Array.isArray(sessionRows) ? sessionRows : (sessionRows as any)?.rows ?? []).some((s: any) => s.mode !== "broker"),
    discrepancies: discRows as DiscrepancyLike[],
    sections,
  };
}

/** The shared statements' texts (for an analysis line's value printed in them). */
async function statementTexts(sources: FinancialSource[]): Promise<StatementText[]> {
  const st = sources.filter((s) => s.kind === "statements");
  if (st.length === 0) return [];
  const { db } = await import("../../db");
  const { documents } = await import("@shared/schema");
  const { inArray } = await import("drizzle-orm");
  const rows = await db.select({ id: documents.id, extractedText: documents.extractedText }).from(documents).where(inArray(documents.id, st.map((s) => s.documentId)));
  const byId = new Map(rows.map((r: { id: string; extractedText: string | null }) => [r.id, r.extractedText]));
  return st.map((source) => ({ source, text: byId.get(source.documentId) ?? null }));
}

/**
 * Plan the deal's questions now (deterministic, $0). Never throws: an error
 * is logged and nothing changes. Returns what was written.
 */
export async function planExplainQuestions(dealId: string): Promise<{ inserted: number; answered: number; closed: number }> {
  try {
    const { loadFigureRaw, invalidateFigureRaw } = await import("./serve");
    const { insertQuestionIfAbsent, updateQuestionIf, getFigureState } = await import("./store");
    const { anchorFigures } = await import("@shared/figure-anchors");
    const { hintsFor } = await import("./hints");
    const { defaultShownKeys } = await import("./candidates");
    const [raw, ctx, state] = await Promise.all([loadFigureRaw(dealId), dealPlanContext(dealId), getFigureState(dealId)]);
    if (Object.keys(raw.registry).length === 0) return { inserted: 0, answered: 0, closed: 0 };
    const anchored = ctx.sections.flatMap((s) => anchorFigures(s, raw.registry)).map((a) => a.figureKey);
    const anchoredKeys = anchored.length > 0 ? anchored : defaultShownKeys(raw.registry);
    const plan = planQuestions({
      registry: raw.registry,
      anchoredKeys,
      checks: raw.checks.checks,
      notes: raw.notes,
      facts: raw.info,
      hints: hintsFor(Object.keys(raw.registry), raw.registry, raw.hintSentences),
      discrepancies: ctx.discrepancies,
      questions: raw.questions,
      statements: await statementTexts(raw.sources),
      autoRoute: autoAskEffective(state?.autoAsk, ctx.createdAt) && ctx.sellerSession && !ctx.interviewCompleted,
    });
    let inserted = 0, answered = 0, closed = 0;
    for (const id of plan.answered) if (await updateQuestionIf(dealId, id, ["suggested", "ask_seller", "asked"], { status: "answered" })) answered++;
    for (const c of plan.closed) if (await updateQuestionIf(dealId, c.id, ["suggested", "ask_seller", "asked", "answered"], { status: "closed", closedReason: c.reason })) closed++;
    for (const q of plan.inserts) if (await insertQuestionIfAbsent(dealId, q)) inserted++;
    if (inserted + answered + closed > 0) invalidateFigureRaw(dealId);
    return { inserted, answered, closed };
  } catch (err) {
    console.warn(`[figures] question planning failed for deal ${dealId}:`, (err as Error)?.message);
    return { inserted: 0, answered: 0, closed: 0 };
  }
}

/** A question whose note the broker approved is closed ("note_approved"). */
export async function closeAnsweredQuestions(dealId: string): Promise<number> {
  const { listNotes, listQuestions, updateQuestionIf } = await import("./store");
  const [notes, questions] = await Promise.all([listNotes(dealId), listQuestions(dealId)]);
  const approved = new Set(notes.filter((n) => n.status === "approved").map((n) => (n.kind === "difference" ? `${n.figureKey}|difference|${n.compareKey}` : `${n.figureKey}|movement`)));
  let n = 0;
  for (const q of questions) {
    if (q.status === "closed") continue;
    const key = q.kind === "difference" ? `${q.figureKey}|difference|${q.compareKey}` : `${q.figureKey}|movement`;
    if (approved.has(key) && (await updateQuestionIf(dealId, q.id, ["suggested", "ask_seller", "asked", "answered"], { status: "closed", closedReason: "note_approved" }))) n++;
  }
  return n;
}

// ── The interview's hand-back ──────────────────────────────────────────────

/** Did this session's interviewer bring the question up (its line's words and its year in one message)? Pure. */
export function explainQuestionDiscussed(
  q: Pick<CimFigureQuestion, "figureKey" | "valuesShown" | "question">,
  messages: ReadonlyArray<{ role: string; content: string }>,
): boolean {
  const year = q.figureKey.split("|")[1] ?? "";
  const line = String((q.valuesShown as Record<string, unknown>)?.line ?? "");
  const words = Array.from(new Set([...line.toLowerCase().split(/[^a-z]+/), ...lineWords(q.figureKey.split("|")[0] as any, line).map((w) => w.toLowerCase())]))
    .filter((w) => w.length >= 4 && !["what", "with", "from", "costs", "expenses"].includes(w));
  if (words.length === 0) return false;
  return messages.some((m) => {
    if (m.role !== "ai" && m.role !== "assistant") return false;
    const t = m.content.toLowerCase();
    return t.includes(year) && words.some((w) => t.includes(w.slice(0, Math.max(4, Math.ceil(w.length * 0.7)))));
  });
}

export interface HandBackResult {
  answered: number;
  asked: number;
  reverted: number;
}

/** Pure: the hand-back decisions for a session. */
export function handBackPlan(
  questions: ReadonlyArray<Pick<CimFigureQuestion, "id" | "status" | "routedBy" | "captureKey" | "figureKey" | "valuesShown" | "question">>,
  facts: Record<string, unknown>,
  sessionId: string | null,
  messages: ReadonlyArray<{ role: string; content: string }>,
  completedInterview: boolean,
): Array<{ id: string; to: "answered" | "asked" | "suggested" }> {
  const sources = ((facts._fieldSources ?? {}) as Record<string, any>) || {};
  const out: Array<{ id: string; to: "answered" | "asked" | "suggested" }> = [];
  for (const q of questions) {
    if (q.status !== "ask_seller") continue;
    const answer = answerOf(facts, q.captureKey);
    const src = sources[q.captureKey];
    const fromThisSession = !!answer && (!sessionId || !src?.sessionId || String(src.sessionId) === sessionId);
    if (answer && fromThisSession) { out.push({ id: q.id, to: "answered" }); continue; }
    if (explainQuestionDiscussed(q, messages)) { out.push({ id: q.id, to: "asked" }); continue; }
    if (completedInterview && q.routedBy === "auto") out.push({ id: q.id, to: "suggested" });
  }
  return out;
}

/**
 * At a session's end (next to markRoutedDiscrepanciesRaised): routed
 * questions become answered (their capture key was filed this session) or
 * asked (raised, no reason given); when this session completes the
 * interview, an auto-routed question never raised goes back to suggested,
 * so nothing counts as "with the seller" that the seller was never asked.
 * Compare-and-set on the status read. Never throws.
 */
export async function markExplainQuestionsRaised(
  dealId: string,
  sessionId: string | null,
  messages: ReadonlyArray<{ role: string; content: string }>,
  opts: { completedInterview?: boolean } = {},
): Promise<HandBackResult> {
  const result: HandBackResult = { answered: 0, asked: 0, reverted: 0 };
  try {
    const { listQuestions, updateQuestionIf } = await import("./store");
    const { storage } = await import("../../storage");
    const [questions, deal] = await Promise.all([listQuestions(dealId), storage.getDeal(dealId)]);
    const facts = ((deal?.extractedInfo ?? {}) as Record<string, unknown>) || {};
    const now = new Date();
    for (const step of handBackPlan(questions, facts, sessionId, messages, !!opts.completedInterview)) {
      if (step.to === "answered") {
        if (await updateQuestionIf(dealId, step.id, ["ask_seller"], { status: "answered", raisedAt: now, sessionId })) result.answered++;
      } else if (step.to === "asked") {
        if (await updateQuestionIf(dealId, step.id, ["ask_seller"], { status: "asked", raisedAt: now, sessionId })) result.asked++;
      } else if (await updateQuestionIf(dealId, step.id, ["ask_seller"], { status: "suggested", routedAt: null, routedBy: null })) {
        result.reverted++;
      }
    }
    if (result.answered + result.asked + result.reverted > 0) {
      const { invalidateFigureRaw } = await import("./serve");
      invalidateFigureRaw(dealId);
    }
  } catch (err) {
    console.warn(`[figures] question hand-back failed for deal ${dealId}:`, (err as Error)?.message);
  }
  return result;
}

// ── What the interview and the together board read ─────────────────────────

export interface ExplainRequest {
  captureKey: string;
  kind: "movement" | "difference";
  line: string;
  year: string;
  fromYear?: string;
  from?: number;
  value?: number;
  statements?: number;
  other?: number;
  otherKind?: string;
}

/** Pure: the routed questions as the interview's block reads them. */
export function explainRequestsOf(questions: ReadonlyArray<Pick<CimFigureQuestion, "status" | "captureKey" | "kind" | "figureKey" | "valuesShown">>): ExplainRequest[] {
  return questions
    .filter((q) => q.status === "ask_seller")
    .map((q) => {
      const v = (q.valuesShown ?? {}) as Record<string, string | number>;
      const year = q.figureKey.split("|")[1] ?? String(v.year ?? "");
      return {
        captureKey: q.captureKey,
        kind: q.kind === "difference" ? "difference" : "movement",
        line: String(v.line ?? ""),
        year,
        ...(typeof v.from === "number" ? { fromYear: String(v.fromYear), from: v.from, value: Number(v.value) } : {}),
        ...(typeof v.statements === "number" ? { statements: v.statements, other: Number(v.other), otherKind: String(v.otherKind ?? "tax return") } : {}),
      } as ExplainRequest;
    });
}

/** The routed questions for an interview turn (seller sessions and "Interview together"; [] on any error). */
export async function explainRequestsFor(dealId: string, conductedBy?: string | null): Promise<ExplainRequest[]> {
  if (conductedBy === "broker") return [];
  try {
    const { listQuestions } = await import("./store");
    return explainRequestsOf(await listQuestions(dealId));
  } catch {
    return [];
  }
}

/** together's board loader (contract §11.5): open questions as board items under Financials. */
export async function figureQuestionsForBoard(dealId: string): Promise<ExplainBoardItem[]> {
  try {
    const { listQuestions } = await import("./store");
    const qs = await listQuestions(dealId);
    return explainBoardItems(qs.map((q) => ({ status: q.status, captureKey: q.captureKey, question: questionDisplay(q) })));
  } catch {
    return [];
  }
}

export type { QuestionStatus };
