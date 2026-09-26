/**
 * reply-polish — the one pass every message goes through before a seller
 * reads it: a new turn (at the stream gate and again when the turn is
 * final — the same input gives the same text, so what was shown is what is
 * saved), the opening, and a stored question shown again on resume.
 *
 *   filler guard (turn-guard.stripFillerPreamble)
 *   → no add-back / SDE calls        (reply-guards.removeNormalisationAssertions)
 *   → exactly one question           (reply-guards.enforceSingleQuestion)
 *   → options anchored to today      (reply-guards.anchorYearOptions)
 *   → the business's own vocabulary  (reply-guards.localiseTerms)
 *   → "you mentioned" only for the seller's words (reply-guards.fixAttribution)
 *
 * The chips and the rationale are put through the matching checks.
 */
import type { ConversationMessage } from "@shared/schema";
import type { KnowledgeBase } from "./knowledge-base";
import { stripFillerPreamble } from "./turn-guard";
import { getFieldSources, type FieldSource } from "./info-merger";
import {
  removeNormalisationAssertions,
  findNormalisationAssertions,
  assertsNormalisation,
  enforceSingleQuestion,
  anchorYearOptions,
  jurisdictionOf,
  localiseTerms,
  fixAttribution,
  jurisdictionPromptLines,
  type Jurisdiction,
  type AttributionFact,
} from "./reply-guards";

export interface PolishContext {
  /** The seller's message this reply answers (null: the opening, or unknown). */
  sellerMessage: string | null;
  jurisdiction: Jurisdiction | null;
  location: string;
  /** Everything the seller has said or written (all sessions, the questionnaire). */
  sellerText: string;
  facts: AttributionFact[];
  today: Date;
}

/** Where the business is, as one string ("Calgary, AB"). */
export function locationText(kb: Pick<KnowledgeBase, "business" | "industryContext">, dealLocation?: string | null): string {
  const loc = kb.business.location;
  const ctxLoc = (kb.industryContext?.location ?? null) as unknown;
  const ctxText =
    typeof ctxLoc === "string"
      ? ctxLoc
      : ctxLoc && typeof ctxLoc === "object"
        ? Object.values(ctxLoc as Record<string, unknown>).filter((v) => typeof v === "string").join(", ")
        : "";
  return [loc?.raw, loc?.municipality, loc?.stateProvince, loc?.country, dealLocation, ctxText]
    .filter((x): x is string => typeof x === "string" && x.trim() !== "")
    .filter((x, i, a) => a.indexOf(x) === i)
    .join(", ");
}

/** The vocabulary note for the deal's prompt (empty when the country is unknown). */
export function vocabularyPromptLines(kb: Pick<KnowledgeBase, "business" | "industryContext">): string[] {
  const where = locationText(kb);
  return jurisdictionPromptLines(jurisdictionOf(where), where);
}

const sellerMessagesOf = (sessions: Array<{ messages?: unknown }>): string[] =>
  sessions.flatMap((s) => (Array.isArray(s.messages) ? (s.messages as ConversationMessage[]) : []).filter((m) => m?.role === "user").map((m) => String(m.content ?? "")));

export function buildPolishContext(args: {
  kb: KnowledgeBase;
  dealLocation?: string | null;
  questionnaireData?: unknown;
  sessions: Array<{ messages?: unknown }>;
  /** Messages of the session in play (when not already among `sessions`). */
  currentMessages?: ConversationMessage[];
  sellerMessage: string | null;
  /** The facts as the interview sees them (sellerInterviewView). */
  info: Record<string, unknown>;
  today?: Date;
}): PolishContext {
  const location = locationText(args.kb, args.dealLocation);
  const sources = getFieldSources(args.info);
  const said = [
    ...sellerMessagesOf(args.sessions),
    ...(args.currentMessages ?? []).filter((m) => m.role === "user").map((m) => m.content),
    args.sellerMessage ?? "",
    args.questionnaireData ? JSON.stringify(args.questionnaireData) : "",
  ];
  const facts: AttributionFact[] = [];
  for (const [key, value] of Object.entries(args.info)) {
    if (key.startsWith("_") || value === null || value === undefined || value === "") continue;
    const src = sources[key] as (FieldSource & { speaker?: string }) | undefined;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    // What the seller themselves said is theirs to have "mentioned".
    if (src && (src.source === "interview" || src.source === "questionnaire" || (src.speaker && /\bseller\b/i.test(src.speaker)))) said.push(text);
    facts.push({ value: text, source: src?.source, speaker: src?.speaker });
  }
  for (const d of args.kb.sourceDigests ?? []) facts.push({ value: `${d.summary} ${d.keyFacts}`, source: d.kind });
  return {
    sellerMessage: args.sellerMessage,
    jurisdiction: jurisdictionOf(location),
    location,
    sellerText: said.join("\n"),
    facts,
    today: args.today ?? new Date(),
  };
}

export interface PolishReport {
  filler: boolean;
  normalisation: string[];
  extraQuestions: string[];
  yearShift: number;
  vocabulary: boolean;
  attribution: string[];
}

/**
 * The seller-facing text of a reply. `closing`: the reply ends the
 * interview; `opening`: the first message (its welcome was handled by
 * finalizeOpeningMessage, so the filler guard is skipped).
 */
export function polishMessage(message: string, ctx: PolishContext, opts: { closing?: boolean; opening?: boolean } = {}): { message: string; report: PolishReport } {
  const report: PolishReport = { filler: false, normalisation: [], extraQuestions: [], yearShift: 0, vocabulary: false, attribution: [] };
  let text = message;
  const callBefore = findNormalisationAssertions(message).length > 0;
  if (!opts.opening) {
    const stripped = stripFillerPreamble(text, { sellerMessage: ctx.sellerMessage, closing: opts.closing });
    report.filler = stripped !== text;
    text = stripped;
  }
  const norm = removeNormalisationAssertions(text, ctx.sellerMessage, { callAlreadyCut: callBefore });
  report.normalisation = norm.removed.length > 0 ? norm.removed : callBefore ? findNormalisationAssertions(message) : [];
  text = norm.message;
  const single = enforceSingleQuestion(text);
  report.extraQuestions = single.dropped;
  text = single.message;
  const years = anchorYearOptions(text, [], ctx.today);
  report.yearShift = years.shifted;
  text = years.message;
  const local = localiseTerms(text, ctx.jurisdiction, ctx.location, ctx.sellerText);
  report.vocabulary = local !== text;
  text = local;
  const attr = fixAttribution(text, { sellerText: ctx.sellerText, facts: ctx.facts });
  report.attribution = attr.fixes;
  text = attr.message;
  return { message: text, report };
}

/** Chips that fit the polished question (the same checks, plus the dropped questions' chips). */
export function polishChips(chips: string[], polishedMessage: string, report: PolishReport, ctx: PolishContext): string[] {
  let out = chips.filter((c) => !assertsNormalisation(c));
  if (report.extraQuestions.length > 0) {
    // Re-run the split on a message holding the kept question + the dropped ones, to filter by fit.
    const probe = [polishedMessage, ...report.extraQuestions].join(" ");
    out = enforceSingleQuestion(probe, out).chips;
  }
  // A year-shifted question: chips carrying the old years move with it
  // ("2025", "2026" → "2026", "2027"); a past year left on a future
  // question's chip after that goes.
  if (report.yearShift > 0) {
    const year = ctx.today.getUTCFullYear();
    out = out.map((c) => c.replace(/\b20\d{2}\b/g, (y) => (Number(y) >= year - report.yearShift && Number(y) < year + 3 ? String(Number(y) + report.yearShift) : y)));
  }
  out = anchorYearOptions(polishedMessage, out, ctx.today).chips;
  out = out.map((c) => localiseTerms(c, ctx.jurisdiction, ctx.location, ctx.sellerText));
  return out.filter((c, i) => c.trim() && out.indexOf(c) === i);
}

export function polishRationale(why: string | undefined, ctx: PolishContext): string | undefined {
  if (!why) return why;
  return localiseTerms(why, ctx.jurisdiction, ctx.location, ctx.sellerText);
}

/** One log line for what the pass changed ("" when nothing). */
export function describeReport(r: PolishReport): string {
  const parts: string[] = [];
  if (r.filler) parts.push("filler");
  if (r.normalisation.length) parts.push(`add-back call removed (${r.normalisation.map((s) => `"${s.slice(0, 80)}"`).join("; ")})`);
  if (r.extraQuestions.length) parts.push(`extra question dropped (${r.extraQuestions.map((s) => `"${s.slice(0, 80)}"`).join("; ")})`);
  if (r.yearShift) parts.push(`past-year options moved forward ${r.yearShift}y`);
  if (r.vocabulary) parts.push("local vocabulary");
  if (r.attribution.length) parts.push(`attribution (${r.attribution.join("; ")})`);
  return parts.join(", ");
}

/** The add-back / SDE calls a draft still makes once the filler guard has run (those need the corrective rewrite). */
export function normalisationCallIn(message: string, sellerMessage: string | null): string[] {
  return findNormalisationAssertions(stripFillerPreamble(message, { sellerMessage }));
}
