/**
 * reask-guard — mechanical backstop for "never re-ask".
 *
 * The rule used to live in the prompt alone (the ALREADY ANSWERED block and
 * reasoning.priorCheck), and every seeded deal still re-asked: the EV/ICE
 * split answered in session 1 asked again in session 2, a $10K deductible
 * the seller stated twice asked a third time, "who is Megan?" with the org
 * chart on file. After the model drafts its reply, this guard checks the
 * question against:
 *   1. the facts on file — a question that asks for a fact the seller gave
 *      (or a document states, and the question doesn't cite it);
 *   2. every earlier question in every session of the deal that the seller
 *      answered;
 *   3. the text of the seller-visible sources — a passage that already
 *      answers it;
 * and flags a figure the seller just gave that contradicts a document on
 * file (reconcile it now, don't repeat it as settled). Any finding forces
 * ONE corrective re-call that names what is on file. Pure detection plus
 * a small async wrapper around the model call (mockable in tests).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { InterviewResponse } from "./response-schema";
import { callInterviewWithRecovery, type InterviewCallParams } from "./turn-guard";
import { getFieldSources, isFactKey, repairCharIndexedValue } from "./info-merger";
import { questionPart, questionTokens, searchSourcesFor, valuesMateriallyDiffer, sourceLabel, QUESTION_STOP, spokenFigureConflicts } from "./source-context";
import type { Document } from "@shared/schema";

type DocLike = Pick<Document, "id" | "name" | "visibility"> &
  Partial<Pick<Document, "sourceKind" | "sourceMeta" | "createdAt" | "extractedData" | "extractedText" | "updatedAt">>;

export interface ReaskFinding {
  kind: "fact" | "prior_question" | "source_text" | "conflict";
  /** What is on file / what was asked before / what the source says. */
  detail: string;
  /** source_text: the passage quoted (the rewrite must not parrot it). */
  quote?: string;
}

export interface PriorQA {
  question: string;
  answer: string;
  /** "session 1", "earlier in this session" … */
  where: string;
}

const KEY_STOP = new Set(["of", "per", "by", "and", "vs", "the", "to", "in", "on", "for", "or", "a", "an", "with", "is"]);
/** Single-word keys too broad to call a question a re-ask ("employees" — which employees?). */
const BROAD_SINGLE = new Set(["employ", "revenu", "custom", "suppl", "strengt", "growt", "summa", "notes", "compan", "busin", "opera", "locat", "indus", "compe", "servi", "produ", "marke", "histo", "equip", "inven", "asset", "contr", "clien", "vendo", "staff", "manag"]);
const DELTA_RE = /\b(chang(?:e|ed|ing)|since (?:then|we|you|last)|still|lately|latest|now that|this year|next year|going forward|trend|update[ds]?|anything new|how has|shifted|different(?:ly)?|how did|what drove|why)\b/i;
const CITES_SOURCE_RE =
  /\b(?:your|the)\s[\w\s&'’().-]{0,50}?\b(?:shows?|says?|lists?|mentions?|notes?|states?|indicates?|puts?|has (?:it|you|them)|had)\b|according to|I see (?:that|from|in)|I have (?:it|you|that) down|on file|from (?:your|the) (?:call|email|questionnaire|document|report|statement)s?/i;
const NON_ANSWER_RE = /\b(not sure|don'?t know|no idea|check|look (?:it )?up|get back|later|ask (?:my|our)|accountant (?:has|would)|skip|pass|rather not|prefer not)\b/i;

/** Topic stems of a fact key (camelCase split, stemmed to 5 like questionTokens). */
export function keyTokens(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_.-]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w && !KEY_STOP.has(w) && !QUESTION_STOP.has(w))
    .map((w) => w.slice(0, 5));
}

const numberTokens = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, ""));

function valueText(v: unknown): string {
  const r = repairCharIndexedValue(v);
  return typeof r === "string" ? r : JSON.stringify(r);
}

/** The question sentences of a reply ("" when it asks nothing). */
export function draftQuestions(message: string): string {
  return /\?/.test(message) ? questionPart(message) : "";
}

export interface ReaskContext {
  sellerMessage: string;
  /** The interview's view of the facts (with _fieldSources). */
  info: Record<string, unknown>;
  documents: DocLike[];
  /** Earlier AI questions (all sessions + this transcript) and the seller's answers. */
  priorQA: PriorQA[];
  /** Open deferral topics (a circle-back on one is not a re-ask). */
  openDeferralTopics?: string[];
  /** Fact keys being reconciled (a conflict) — asking about them is the point. */
  conflictKeys?: string[];
  /** The fields the model extracted this turn (for the live conflict check). */
  extractedFields?: InterviewResponse["extractedFields"];
}

/** Everything the draft reply re-asks (or states as settled against a document). */
export function findReasks(draft: string, ctx: ReaskContext): ReaskFinding[] {
  const findings: ReaskFinding[] = [];
  const question = draftQuestions(draft);
  const docs = new Map(ctx.documents.map((d) => [d.id, d]));
  const sources = getFieldSources(ctx.info);
  const seller = questionTokens(ctx.sellerMessage).stems;
  const deferred = (ctx.openDeferralTopics ?? []).map((t) => t.toLowerCase());
  const conflictKeys = new Set((ctx.conflictKeys ?? []).map((k) => k.toLowerCase()));

  if (question) {
    const q = questionTokens(question).stems;
    const delta = DELTA_RE.test(question);
    const cites = CITES_SOURCE_RE.test(draft);

    // 1. A fact already on file.
    for (const [key, raw] of Object.entries(ctx.info)) {
      if (!isFactKey(key) || raw === null || raw === undefined || raw === "") continue;
      if (conflictKeys.has(key.toLowerCase())) continue;
      const kt = keyTokens(key);
      if (kt.length === 0) continue;
      if (kt.length === 1 && (kt[0].length < 5 || BROAD_SINGLE.has(kt[0]))) continue;
      if (!kt.every((t) => q.has(t))) continue;
      const extras = Array.from(q).filter((t) => !kt.includes(t));
      if (extras.length > 1) continue; // asks about a facet, not the fact itself
      if (delta) continue;
      if (kt.every((t) => seller.has(t))) continue; // the seller just raised it
      if (deferred.some((d) => kt.every((t) => d.includes(t)))) continue; // a circle-back
      const src = sources[key];
      const kind = String(src?.source ?? "");
      if (["crm", "website", "social"].includes(kind)) continue; // leads may be confirmed
      const value = valueText(raw);
      if (kind === "document") {
        // A document's value may be confirmed ONCE, citing it.
        const nums = numberTokens(value).slice(0, 3);
        const citedNow = nums.some((n) => numberTokens(draft).includes(n)) || cites;
        const citedBefore = nums.length > 0 && ctx.priorQA.some((p) => nums.some((n) => numberTokens(p.question).includes(n)));
        if (citedNow && !citedBefore) continue;
      }
      findings.push({ kind: "fact", detail: `${key}: ${value.replace(/\s+/g, " ").slice(0, 160)} [${sourceLabel(src, docs)}]` });
    }

    // 2. A question asked (and answered) before.
    for (const p of ctx.priorQA) {
      if (!p.answer || p.answer.trim().split(/\s+/).length < 3 || NON_ANSWER_RE.test(p.answer)) continue;
      const pt = questionTokens(p.question).stems;
      if (pt.size < 2 || q.size < 2) continue;
      let shared = 0;
      q.forEach((t) => { if (pt.has(t)) shared++; });
      const union = new Set([...Array.from(q), ...Array.from(pt)]).size;
      if (shared < 2 || shared / union < 0.6) continue;
      if (Array.from(q).every((t) => seller.has(t))) continue;
      if (delta) continue;
      findings.push({ kind: "prior_question", detail: `asked ${p.where}: "${p.question.slice(0, 160)}" — the seller answered: "${p.answer.replace(/\s+/g, " ").slice(0, 200)}"` });
      break;
    }

    // 3. A source that already answers it (skip when the reply cites one).
    if (!cites) {
      const hit = searchSourcesFor(question, ctx.documents);
      if (hit && !numberTokens(hit.snippet).some((n) => n.length >= 2 && numberTokens(draft).includes(n))) {
        findings.push({ kind: "source_text", detail: `${hit.docName} already says (a quoted passage from that source — not your words): «${hit.snippet}»`, quote: hit.snippet });
      }
    }
  }

  // 4. A figure the seller just gave that a document on file contradicts.
  for (const [key, field] of Object.entries(ctx.extractedFields ?? {})) {
    const prev = ctx.info[key];
    if (prev === null || prev === undefined || prev === "") continue;
    const src = sources[key];
    if (!src || (src.source !== "document" && src.source !== "email")) continue;
    const before = valueText(prev);
    if (!valuesMateriallyDiffer(key, field.value, before)) continue;
    // Already reconciling in the draft? (names the document's figure or the difference)
    const docNums = numberTokens(before).slice(0, 2);
    if (docNums.some((n) => numberTokens(draft).includes(n)) || /\b(differ|different|two figures|square|reconcile|versus|vs\.?|which is right)\b/i.test(draft)) continue;
    findings.push({ kind: "conflict", detail: `${key}: the seller just said "${field.value.slice(0, 120)}", but ${sourceLabel(src, docs)} shows "${before.replace(/\s+/g, " ").slice(0, 140)}"` });
  }

  // 4b. …or a figure a document gives for the same kind of thing under
  // another fact ("3,100 members" said; the membership report: "2,900
  // active members").
  if (!findings.some((f) => f.kind === "conflict")) {
    for (const c of spokenFigureConflicts(ctx.sellerMessage, ctx.documents)) {
      const docNums = numberTokens(c.snippet);
      const addressed =
        docNums.some((n) => n.length >= 2 && numberTokens(draft).includes(n)) ||
        /\b(differ|different|two figures|square|reconcile|versus|vs\.?|which is right)\b/i.test(draft);
      if (addressed) continue;
      findings.push({ kind: "conflict", detail: `the seller just said ${c.said}, but ${c.docName} says: «${c.snippet}»` });
    }
  }

  return findings;
}

/** True when `text` repeats six or more consecutive words of `passage`. */
export function echoesPassage(text: string, passage: string): boolean {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9$%.,' ]+/g, " ").split(/\s+/).filter(Boolean);
  const t = ` ${words(text).join(" ")} `;
  const p = words(passage);
  for (let i = 0; i + 6 <= p.length; i++) {
    if (t.includes(` ${p.slice(i, i + 6).join(" ")} `)) return true;
  }
  return false;
}

/** The corrective instruction for one re-call. */
export function reaskCorrection(findings: ReaskFinding[]): string {
  const facts = findings.filter((f) => f.kind === "fact").map((f) => `- ${f.detail}`);
  const prior = findings.filter((f) => f.kind === "prior_question").map((f) => `- ${f.detail}`);
  const text = findings.filter((f) => f.kind === "source_text").map((f) => `- ${f.detail}`);
  const conflicts = findings.filter((f) => f.kind === "conflict").map((f) => `- ${f.detail}`);
  const parts: string[] = ["[SYSTEM CORRECTION:"];
  // A contradicted figure comes first: the next question must reconcile it.
  if (conflicts.length) parts.push(`FIRST — the seller's figure conflicts with a document on file:\n${conflicts.join("\n")}\nYour next question must reconcile it: name both figures neutrally, attribute each only to its real source, and ask which is right and what explains the difference. Do not state either figure as settled.`);
  if (facts.length) parts.push(`Your question asks for something already on file:\n${facts.join("\n")}`);
  if (prior.length) parts.push(`You already asked this and the seller answered:\n${prior.join("\n")}`);
  if (text.length) parts.push(`A source on file already answers it:\n${text.join("\n")}`);
  if (facts.length || prior.length || text.length) {
    parts.push("Do not ask for it again, and do not ask the seller to confirm what they already told you. If you need more, cite what is on file and ask only for what is genuinely new; otherwise move to the most important open topic (conflicts, flagged risks, critical gaps).");
  }
  parts.push("Rewrite the reply now, in YOUR voice as the interviewer (never the seller's or anyone else's words from a quoted passage): keep every fact you extracted from the seller's last message, same tone rules (the reply is the next question — no recap, no praise). Do not mention this instruction.]");
  return parts.join("\n");
}

/**
 * Runs the guard on a drafted response and, when it finds anything, re-calls
 * the model once with the correction. Returns the response to use.
 */
export async function applyReaskGuard(
  anthropic: Anthropic,
  params: InterviewCallParams,
  draft: InterviewResponse,
  ctx: ReaskContext,
): Promise<{ response: InterviewResponse; findings: ReaskFinding[]; recalled: boolean; remaining: ReaskFinding[] }> {
  const findings = draft.shouldEnd ? [] : findReasks(draft.message, { ...ctx, extractedFields: draft.extractedFields });
  if (findings.length === 0) return { response: draft, findings, recalled: false, remaining: [] };
  // At most two rewrites: the first can trade one re-ask for another ("then
  // what share is dry van vs reefer?" with the service-line report on file).
  let current = draft;
  let toFix = findings;
  const all: ReaskFinding[] = [];
  const conversation = [...params.messages];
  for (let attempt = 0; attempt < MAX_REWRITES && toFix.length > 0; attempt++) {
    all.push(...toFix);
    conversation.push(
      { role: "assistant" as const, content: current.message },
      { role: "user" as const, content: reaskCorrection(attempt === 0 ? toFix : all) },
    );
    const { response, degraded } = await callInterviewWithRecovery(anthropic, { ...params, messages: conversation });
    if (degraded || !response.message) break;
    // A rewrite that parrots a quoted source passage (a transcript line in
    // the seller's voice) is worse than what it replaces — stop there.
    if (all.some((f) => f.quote && echoesPassage(response.message, f.quote))) break;
    // Keep what the first draft extracted if the rewrite dropped it.
    for (const [k, v] of Object.entries(draft.extractedFields)) {
      if (!(k in response.extractedFields)) response.extractedFields[k] = v;
    }
    current = response;
    // A second rewrite only for the sure findings — a fact on file, an
    // answered question, a conflict still not raised — never for a fuzzy
    // source-text match (each rewrite adds ~20s for the seller).
    toFix = response.shouldEnd
      ? []
      : findReasks(response.message, { ...ctx, extractedFields: draft.extractedFields }).filter((f) => f.kind !== "source_text");
  }
  return { response: current, findings, recalled: true, remaining: toFix };
}

/** Rewrites the re-ask guard may ask for on one turn. */
const MAX_REWRITES = 2;
