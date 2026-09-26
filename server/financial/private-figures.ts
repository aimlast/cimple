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
 * documents, answers, questionnaire) does — "$40K of personal vehicle costs"
 * from a CRM note, a replacement salary only the broker's recast has.
 *
 * Pure apart from `loadDealFigureIndex`, which reads the deal's documents.
 */
import type { IStorage } from "../storage";
import { numberTokens, tokensMatch, type NumTok } from "../cim/discrepancy-filter";
import { brokerPrivacy } from "../interview/seller-view";
import { getFieldSources } from "../interview/info-merger";
import type { UiAddback, UiClarifyingQuestion, UiNormalization } from "./shape";

export interface FigureIndex {
  shared: NumTok[];
  private: NumTok[];
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

function tokensOf(texts: string[]): NumTok[] {
  const out: NumTok[] = [];
  for (const text of texts) {
    if (!text) continue;
    for (const t of numberTokens(text, { keepSourceLabel: true })) if (!t.year) out.push(t);
  }
  return out;
}

export function buildFigureIndex(sharedTexts: string[], privateTexts: string[]): FigureIndex {
  return { shared: tokensOf(sharedTexts), private: tokensOf(privateTexts) };
}

/** A bare amount as a token (for add-back amounts, which are numbers, not text). */
export function amountToken(value: number): NumTok {
  return { value: Math.abs(value), pct: false, year: false, durationYears: false, period: null, approx: false, raw: `$${Math.abs(value)}`, unitWord: "", context: "" };
}

/** True when the private material states this figure and nothing shared does. */
export function isPrivateOnly(t: NumTok, index: FigureIndex): boolean {
  if (!distinctive(t)) return false;
  // Exact comparison both ways: a hedged private "~$40K" still counts as
  // $40,000, and only a shared figure that says the same thing clears it.
  const exact = { ...t, approx: false };
  const hit = (list: NumTok[]) => list.some((x) => tokensMatch(exact, { ...x, approx: false }));
  return hit(index.private) && !hit(index.shared);
}

/** The figures in a piece of text that only the broker's private material holds (as written). */
export function privateOnlyFigures(text: string | null | undefined, index: FigureIndex): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const t of numberTokens(text, { keepSourceLabel: true })) {
    if (isPrivateOnly(t, index) && !out.includes(t.raw)) out.push(t.raw);
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
    const parts = [d.extractedText ?? "", d.extractedData ? JSON.stringify(d.extractedData) : ""];
    (brokerOnly ? priv : shared).push(...parts.filter(Boolean));
  }
  const info = extractedInfo ?? {};
  const { isPrivateSource } = brokerPrivacy(docs.map((d) => ({ id: d.id, visibility: d.visibility ?? null })) as any);
  const sources = getFieldSources(info);
  for (const [k, v] of Object.entries(info)) {
    if (k.startsWith("_") || v === null || v === undefined) continue;
    const text = `${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`;
    (isPrivateSource(sources[k]) ? priv : shared).push(text);
  }
  if (questionnaireData && typeof questionnaireData === "object") shared.push(JSON.stringify(questionnaireData));
  return { shared, private: priv };
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
    const byAmount = amounts.some((v) => isPrivateOnly(amountToken(v), index));
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
