/**
 * Figures only the broker's private material holds.
 *
 * The financial analysis reads the broker's CRM notes and broker-only files
 * (SOURCE 5) as context. Two things built from its output can travel on
 * from there: an add-back (into EBITDA/SDE, the CIM bridge and the DD
 * writer) and a clarifying question (routed into the seller interview). The
 * prompt tells the model to keep private material out of both; this module
 * is the deterministic check behind that rule. A figure counts as private
 * when a private source states it and no shared source (the seller's
 * documents, answers, questionnaire) states the same amount about the same
 * thing — "$40K of personal vehicle costs" from a CRM note (a 2022 dividend
 * of $40,000 is not support), a replacement salary only the broker's recast
 * has (a $164,630 cash balance is not support).
 *
 * Pure apart from `loadDealFigureIndex`, which reads the deal's documents.
 */
import type { IStorage } from "../storage";
import { numberTokens, tokensMatch, type NumTok } from "../cim/discrepancy-filter";
import { brokerPrivacy } from "../interview/seller-view";
import { getFieldSources } from "../interview/info-merger";
import type { UiAddback, UiClarifyingQuestion, UiNormalization } from "./shape";

/** A figure with what it is about: the meaningful words of its own line or clause. */
export interface Figure {
  tok: NumTok;
  topic: Set<string>;
}

export interface FigureIndex {
  shared: Figure[];
  private: Figure[];
}

/**
 * A quantity worth protecting: money, or any number of 1,000 or more, or a
 * percentage with a decimal ("22.0%"). Small counts, years and round
 * percentages ("15%") are too common to say anything about their source.
 */
function distinctive(t: NumTok): boolean {
  if (t.year || t.durationYears) return false;
  if (t.pct) return !Number.isInteger(t.value);
  return t.value >= 1000 || (t.raw.includes("$") && t.value >= 100);
}

// ── What a figure is about ──

/** Words that say nothing about WHAT a figure is (every line of a deal has them). */
const GENERIC = new Set(
  (
    "the a an and or of to in on for per by with at from as is are was were be been being this that these those it its their his her our your my " +
    "owner owners owner's company company's business corp inc ltd total totals year years yr annual annually month monthly amount amounts figure figures " +
    "cost costs expense expenses paid paying approx approximately about around roughly nearly some each also only which where what how who when does do did " +
    "doesn't don't isn't aren't not no yes has have had will would could should can may might all any more less than into over under up down out off " +
    "appear appears show shows shown booked book run runs running through note notes crm broker broker's seller seller's statement statements fy line lines " +
    "account accounts per confirm please you we us they them there here our sample document fictional demonstration value values other misc net gross " +
    "item items general number numbers based estimate estimated current prior last next first new old just still yet then so if but because since"
  ).split(" "),
);

/** One word for each thing a figure can be about ("T4", "wages", "comp" are all pay). */
const SYNONYMS: Record<string, string> = {
  salary: "pay", salarie: "pay", wage: "pay", compensation: "pay", comp: "pay", payroll: "pay", remuneration: "pay", t4: "pay", pay: "pay",
  vehicle: "vehicle", truck: "vehicle", car: "vehicle", suv: "vehicle", auto: "vehicle", automobile: "vehicle", fuel: "vehicle",
  revenue: "revenue", sale: "revenue", turnover: "revenue",
  dividend: "dividend", distribution: "dividend", draw: "dividend",
  earning: "income", profit: "income",
};

function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/** The meaningful words of a piece of text, normalised ("Personal vehicle costs" → {personal, vehicle}). */
export function topicWords(text: string): Set<string> {
  const words = text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .split(/[^a-z0-9&]+/)
    .filter((w) => w.length >= 2 && !/^\d/.test(w));
  const out = new Set<string>();
  for (const raw of words) {
    if (GENERIC.has(raw)) continue;
    const s = stem(raw);
    if (GENERIC.has(s)) continue;
    out.add(SYNONYMS[s] ?? SYNONYMS[raw] ?? s);
  }
  return out;
}

/**
 * The clauses a figure's meaning comes from: a line, a sentence, a
 * semicolon- or dash-separated part. A "key: value" line from structured
 * data is one clause.
 */
function clausesOf(text: string): string[] {
  return text.split(/\r?\n|;|\t|\s\|\s|(?<=[.!?])\s+(?=[A-Z$(])|\s[—–]\s/).map((c) => c.trim()).filter(Boolean);
}

/**
 * Every figure in a text, each with the topic of its own item: in a list
 * ("utilities $71,000, vehicle expenses $60,000, computer & software
 * $22,000") each amount is about its own words, not its neighbours'.
 */
export function figuresIn(text: string): Figure[] {
  const out: Figure[] = [];
  for (const clause of clausesOf(text)) {
    if (!/\d/.test(clause)) continue;
    // A long clause (a paragraph with no punctuation) is judged near the figure.
    const whole = clause.length <= 220 ? topicWords(clause) : null;
    for (const item of clause.split(/,\s|\s\+\s|\s(?:and|plus)\s|[()]/)) {
      const toks = numberTokens(item, { keepSourceLabel: true }).filter((t) => !t.year);
      if (toks.length === 0) continue;
      const own = topicWords(item);
      for (const t of toks) out.push({ tok: t, topic: own.size > 0 ? own : whole ?? topicWords(t.context) });
    }
  }
  return out;
}

export function buildFigureIndex(sharedTexts: string[], privateTexts: string[]): FigureIndex {
  const all = (texts: string[]) => texts.filter(Boolean).flatMap((t) => figuresIn(t));
  return { shared: all(sharedTexts), private: all(privateTexts) };
}

/** A bare amount as a token (for add-back amounts, which are numbers, not text). */
export function amountToken(value: number): NumTok {
  return { value: Math.abs(value), pct: false, year: false, durationYears: false, period: null, approx: false, raw: `$${Math.abs(value)}`, unitWord: "", context: "" };
}

const overlaps = (a: Set<string>, b: Set<string>) => Array.from(a).some((w) => b.has(w));

/**
 * True when the private material states this figure and nothing shared
 * supports it. A shared figure supports it only when it is the same amount
 * AND about the same thing (its clause shares a meaningful word with the
 * figure's own topic) — or when it is the very same non-round amount
 * ($11,340 twice is no coincidence). Value alone is not enough: a deal's
 * documents hold thousands of amounts, so a CRM note's "~$40K of personal
 * vehicle costs" would always find some $40,000 (a 2022 dividend) and a
 * "$165K" replacement salary a $164,630 cash balance within rounding — the
 * round-1 check treated both as shared and let them through.
 */
export function isPrivateOnly(t: NumTok, index: FigureIndex, topic: Set<string> = new Set()): boolean {
  if (!distinctive(t)) return false;
  // Exact comparison both ways: a hedged private "~$40K" still counts as
  // $40,000, and only a shared figure that says the same thing clears it.
  const exact = { ...t, approx: false };
  const same = (x: NumTok) => tokensMatch(exact, { ...x, approx: false });
  if (!index.private.some((p) => same(p.tok))) return false;
  const identical = (x: NumTok) => !t.pct && Math.abs(x.value - t.value) < 0.5 && Math.round(t.value) % 1000 !== 0;
  const supported = index.shared.some((s) => same(s.tok) && (identical(s.tok) || (topic.size > 0 && overlaps(topic, s.topic))));
  return !supported;
}

/** The figures in a piece of text that only the broker's private material holds (as written). */
export function privateOnlyFigures(text: string | null | undefined, index: FigureIndex): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const f of figuresIn(text)) {
    if (isPrivateOnly(f.tok, index, f.topic) && !out.includes(f.tok.raw)) out.push(f.tok.raw);
  }
  return out;
}

/** Drop every sentence that quotes a private-only figure; what is left may reach the seller. */
export function withoutPrivateFigureSentences(text: string, index: FigureIndex): string {
  return text
    .split(/(?<=[.?!])\s+/)
    .filter((sentence) => privateOnlyFigures(sentence, index).length === 0)
    .join(" ")
    .trim();
}

// ── The deal's shared vs private material ──

interface DocLike {
  id: string;
  visibility?: string | null;
  sourceKind?: string | null;
  isProcessed?: boolean | null;
  extractedText?: string | null;
  extractedData?: unknown;
}

/** Split a deal's material into what the seller's side holds and what only the broker holds. */
export function dealFigureTexts(
  docs: DocLike[],
  extractedInfo: Record<string, unknown> | null | undefined,
  questionnaireData: unknown,
): { shared: string[]; private: string[] } {
  const shared: string[] = [];
  const priv: string[] = [];
  for (const d of docs) {
    const brokerOnly = d.visibility === "broker_only" || d.sourceKind === "crm";
    const parts = [d.extractedText ?? "", d.extractedData ? structuredLines(d.extractedData) : ""];
    (brokerOnly ? priv : shared).push(...parts.filter(Boolean));
  }
  const info = extractedInfo ?? {};
  const { isPrivateSource } = brokerPrivacy(docs.map((d) => ({ id: d.id, visibility: d.visibility ?? null })) as any);
  const sources = getFieldSources(info);
  for (const [k, v] of Object.entries(info)) {
    if (k.startsWith("_") || v === null || v === undefined) continue;
    (isPrivateSource(sources[k]) ? priv : shared).push(structuredLines(v, k));
  }
  if (questionnaireData && typeof questionnaireData === "object") shared.push(structuredLines(questionnaireData));
  return { shared, private: priv };
}

/**
 * Structured data as one "path: value" line per value, so each figure keeps
 * what it is about ("dividends 2022: 40000", not one long JSON string where
 * every amount sits next to every key).
 */
function structuredLines(value: unknown, path = "", depth = 0): string {
  if (value === null || value === undefined) return "";
  if (typeof value !== "object" || depth > 6) return `${path}${path ? ": " : ""}${String(value)}`;
  const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value as Record<string, unknown>);
  return entries
    .map(([k, v]) => structuredLines(v, Array.isArray(value) ? path : `${path}${path ? " " : ""}${k}`, depth + 1))
    .filter(Boolean)
    .join("\n");
}

/** The figure index for a deal, read fresh from storage (no AI). */
export async function loadDealFigureIndex(dealId: string, storage: IStorage): Promise<FigureIndex> {
  const [deal, docs] = await Promise.all([storage.getDeal(dealId), storage.getDocumentsByDeal(dealId)]);
  const texts = dealFigureTexts(docs, (deal?.extractedInfo as Record<string, unknown>) ?? {}, deal?.questionnaireData);
  return buildFigureIndex(texts.shared, texts.private);
}

// ── Applying it to an analysis ──

/**
 * The amounts an add-back rests on: an owner-pay line rests on the owner's
 * actual pay (the market salary is an estimate the analysis makes anyway),
 * every other line on its own amounts.
 */
function evidenceAmounts(ab: UiAddback, all: UiAddback[]): number[] {
  if (ab.ownerCompPart) {
    const excess = ab.ownerCompPart === "excess" ? ab : all.find((x) => x.ownerCompPart === "excess" && `${x.id}_market` === ab.id);
    const actual = excess?.ownerActualComp;
    if (actual && Object.keys(actual).length > 0) return Object.values(actual);
  } else if (ab.ownerActualComp && Object.keys(ab.ownerActualComp).length > 0) {
    return Object.values(ab.ownerActualComp);
  }
  return Object.values(ab.amounts ?? {});
}

const PRIVATE_NOTE = (label: string) =>
  `"${label}" rests only on your private notes (CRM or broker-only files), so it is left out of EBITDA, SDE and the CIM until you approve it.`;

/**
 * Mark add-backs whose only support is the broker's private material: the
 * model said so (`declaredPrivate`), or an amount appears only in private
 * material. A marked line is unapproved until the broker approves it; a
 * broker's own line or decision is never touched.
 */
export function markPrivateAddbacks(
  n: UiNormalization | null,
  index: FigureIndex,
  declaredPrivate: Set<string> = new Set(),
): UiNormalization | null {
  if (!n || !Array.isArray(n.addbacks)) return n;
  const notes = [...(n.notes ?? [])];
  const baseOf = (label: string) => label.replace(/\s+—\s+market salary$/i, "");
  const privateLabels = new Set<string>();
  for (const ab of n.addbacks) {
    if (ab.custom || ab.approvedOverride) continue;
    const amounts = evidenceAmounts(ab, n.addbacks).filter((v) => Number.isFinite(v) && v !== 0);
    // What the line is about: its label ("Owner personal vehicle costs").
    const topic = topicWords(baseOf(ab.label));
    const byAmount = amounts.some((v) => isPrivateOnly(amountToken(v), index, topic));
    if (byAmount || declaredPrivate.has(baseOf(ab.label)) || declaredPrivate.has(ab.label)) privateLabels.add(baseOf(ab.label));
  }
  if (privateLabels.size === 0) return n;
  const addbacks = n.addbacks.map((ab) => {
    if (ab.custom || ab.approvedOverride || !privateLabels.has(baseOf(ab.label))) return ab;
    return { ...ab, privateEvidence: true, approved: false };
  });
  for (const label of Array.from(privateLabels)) notes.push(PRIVATE_NOTE(label));
  return { ...n, addbacks, notes: Array.from(new Set(notes)) };
}

/** Record, per clarifying question, the figures in it that only private material holds. */
export function markPrivateQuestionFigures(
  questions: UiClarifyingQuestion[] | null,
  index: FigureIndex,
): UiClarifyingQuestion[] | null {
  if (!questions) return questions;
  return questions.map((q) => {
    const figures = privateOnlyFigures(`${q.question} ${q.context ?? ""}`, index);
    if (figures.length === 0) {
      if (!q.privateFigures) return q;
      const { privateFigures: _drop, ...rest } = q;
      return rest;
    }
    return { ...q, privateFigures: figures };
  });
}
