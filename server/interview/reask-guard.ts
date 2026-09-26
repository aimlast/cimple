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
 *      answered (reworded, shorter or longer), and the subject of the
 *      question inside an earlier answer;
 *   3. the text of the seller-visible sources — a passage that already
 *      answers it;
 * and flags a figure the seller just gave that contradicts a document on
 * file (reconcile it now, don't repeat it as settled). Word-overlap
 * candidates (a source passage, a subject inside an earlier answer, an
 * answer that seems to be about something else) stop a question only once
 * the supporting model confirms they answer it (answer-check.ts); the rest
 * are sure. A finding forces a corrective rewrite that names what is on file
 * (at most two). On the streamed path the session manager runs this the
 * moment the message is complete, before the seller sees it. Pure detection
 * plus small async wrappers around the model calls (mockable in tests).
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { InterviewResponse } from "./response-schema";
import { callInterviewWithRecovery, type InterviewCallParams } from "./turn-guard";
import { getFieldSources, isFactKey, repairCharIndexedValue } from "./info-merger";
import { questionPart, questionTokens, searchSourcesTop, valuesMateriallyDiffer, sourceLabel, QUESTION_STOP, spokenFigureConflicts } from "./source-context";
import { modelAnswerVerifier, type AnswerVerifier } from "./answer-check";
import type { Document } from "@shared/schema";

type DocLike = Pick<Document, "id" | "name" | "visibility"> &
  Partial<Pick<Document, "sourceKind" | "sourceMeta" | "createdAt" | "extractedData" | "extractedText" | "updatedAt">>;

export interface ReaskFinding {
  /**
   * echo: a rewrite repeated a quoted passage word for word (streaming path).
   * own_statement: the interviewer itself told the seller this earlier in the session.
   */
  kind: "fact" | "prior_question" | "source_text" | "conflict" | "echo" | "own_statement";
  /** What is on file / what was asked before / what the source says. */
  detail: string;
  /** source_text: the passage quoted (the rewrite must not parrot it). */
  quote?: string;
  /**
   * Checked by the supporting model (confirmFindings): it stops the question
   * only once the model confirms the item answers what the question mainly
   * asks. Conflicts and echoes are never verified.
   */
  verify?: boolean;
  /** conflict (live claim check): the fact key it is about, and the file's own figure/wording. */
  key?: string;
  onFileValue?: string;
  /**
   * A strong mechanical match (the fact's own words, the same question
   * reworded) that still stands when the model can't give a verdict in time.
   * Never set for the exchange the seller is answering right now — a
   * follow-up on the unanswered half of a compound question is not a re-ask.
   */
  fallback?: boolean;
}

export interface PriorQA {
  question: string;
  answer: string;
  /** "session 1", "earlier in this session" … */
  where: string;
  /** The exchange the seller's current message answers (their answer may be partial). */
  current?: boolean;
}

/** An item the file answers beyond the facts (on-file-evidence.ts). */
export interface OnFileFact {
  key: string;
  label: string;
  answer: string;
  source: string;
}

const KEY_STOP = new Set(["of", "per", "by", "and", "vs", "the", "to", "in", "on", "for", "or", "a", "an", "with", "is"]);
/** Single-word keys too broad to call a question a re-ask ("employees" — which employees?). Stems, 5 characters like keyTokens. */
const BROAD_SINGLE = new Set(
  ["employees", "revenue", "customers", "suppliers", "strengths", "growth", "summary", "notes", "company", "business", "operations", "location", "industry", "competition", "services", "products", "marketing", "history", "equipment", "inventory", "assets", "contracts", "clients", "vendors", "staff", "management"].map((w) => w.slice(0, 5)),
);
/** Words that ask for the measure of a fact, not a new facet of it ("what percentage", "the split", "roughly how much"). */
const MEASURE_STEMS = new Set(
  ["percentage", "percent", "share", "split", "portion", "proportion", "mix", "number", "count", "figure", "amount", "total", "level", "rate", "ratio", "size", "value", "roughly", "approximately", "estimate", "currently", "today", "tied", "traditional"].map((w) => w.slice(0, 5)),
);
/** A question about what has changed since (a delta on a known fact is not a re-ask). */
const DELTA_RE = /\b(chang(?:e|ed|ing)|since (?:then|we|you|last)|still|lately|latest|now that|this year|next year|going forward|trend|update[ds]?|anything new|how has|shifted|different(?:ly)?)\b/i;
/**
 * A question about the reason or the story behind something ("what drove
 * that", "why"). A new facet of a figure on file — never a sure re-ask of
 * it — but the file may well state the story (the 2019 union vote: "the vote
 * failed, sixty-one to thirty-nine" on the Zoom call), so the candidates
 * still go to the answer check. (Treated as a delta before, which skipped
 * every candidate: the union question went out unchecked.)
 */
const REASON_RE = /\b(how did|what drove|why|what (?:caused|led to|happened)|reasons?)\b/i;
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
const yearsIn = (s: string) => new Set((s.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) ?? []).map(Number));
/** Acronyms and mid-sentence capitalised names — the words that pin a question to one topic (CARB, BBB, EV, Megan). */
function distinctiveTokens(text: string): Set<string> {
  const out = new Set<string>();
  const words = text.match(/[A-Za-z0-9][A-Za-z0-9'’&-]*/g) ?? [];
  words.forEach((w, i) => {
    const clean = w.replace(/['’]s$/i, "");
    if (/^[A-Z][A-Z0-9&]{1,5}$/.test(clean) && !/^(I|OK|US|AM|PM)$/.test(clean)) out.add(clean.toLowerCase().slice(0, 5));
    else if (/^[A-Z][a-z]{2,}$/.test(clean) && i > 0 && !/[.!?]$/.test(words[i - 1] ?? "") && !QUESTION_STOP.has(clean.toLowerCase())) out.add(clean.toLowerCase().slice(0, 5));
  });
  return out;
}

/**
 * Every question → answer pair from the deal's EARLIER sessions, in full
 * (the prompt's digest trims answers; the guard must see all of it — "the
 * cleanroom HVAC was all new in 2023" sits deep in an answer about the
 * building).
 */
export function priorQAFromSessions(
  sessions: Array<{ id: string; messages: unknown; startedAt?: unknown }>,
  currentSessionId: string | null | undefined,
): PriorQA[] {
  const ordered = [...sessions]
    .filter((x) => x.id !== currentSessionId)
    .sort((a, b) => new Date(String(a.startedAt ?? 0)).getTime() - new Date(String(b.startedAt ?? 0)).getTime());
  const out: PriorQA[] = [];
  ordered.forEach((x, idx) => {
    const msgs = (Array.isArray(x.messages) ? x.messages : []) as { role: string; content: string }[];
    for (let i = 0; i < msgs.length - 1; i++) {
      if (msgs[i].role !== "ai" || msgs[i + 1].role !== "user") continue;
      const answer = String(msgs[i + 1].content ?? "").trim();
      if (!answer) continue;
      out.push({ question: questionPart(String(msgs[i].content ?? "")), answer, where: `in session ${idx + 1}` });
    }
  });
  return out;
}

/** Sentences of a seller answer. */
const sentencesOf = (t: string) => t.replace(/\s+/g, " ").split(/(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean);

/** The topic words of a question (5-letter stems; stop words and short words left out, acronyms kept). */
function subjectWords(question: string): Set<string> {
  const out = new Set<string>();
  for (const w of question.match(/[A-Za-z0-9][A-Za-z0-9'’&-]*/g) ?? []) {
    const lower = w.replace(/['’]s$/i, "").toLowerCase();
    if (QUESTION_STOP.has(lower)) continue;
    if (lower.length >= 4 || /^[A-Z0-9&]{2,5}$/.test(w)) out.add(lower.slice(0, 5));
  }
  return out;
}

function valueText(v: unknown): string {
  const r = repairCharIndexedValue(v);
  return typeof r === "string" ? r : JSON.stringify(r);
}

/** The question sentences of a reply ("" when it asks nothing). */
export function draftQuestions(message: string): string {
  return /\?/.test(message) ? questionPart(message) : "";
}

/**
 * The question with the sentence that sets it up — "There's a wrongful
 * dismissal lawsuit pending. What's the status of that case?" asks about the
 * lawsuit, which only the lead-in names.
 */
export function questionWithLeadIn(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  const sentences = flat.match(/[^.!?]+[.!?]+/g) ?? [flat];
  const first = sentences.findIndex((x) => x.includes("?"));
  if (first < 0) return "";
  return sentences.slice(Math.max(0, first - 1)).filter((x) => x.includes("?") || sentences.indexOf(x) === first - 1).join(" ").trim();
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
  /** Items the sources or earlier sessions answer beyond the facts (on-file-evidence.ts). */
  onFile?: OnFileFact[];
  /** The interviewer's own earlier messages in this session (newest last) — what it already told the seller. */
  agentStatements?: string[];
  /** Figures the seller just gave that the file states differently (live-claims.ts), not yet raised. */
  liveConflicts?: ReaskFinding[];
}

/** How many model-checked candidates one draft may carry (strongest first). */
const MAX_CANDIDATES = 8;

/** Stems of a text as questionTokens makes them (5 characters, stop words out, acronyms kept). */
const stemsOfText = (t: string) => questionTokens(t).stems;

/**
 * Facts (and on-file items) that may answer the question, ranked by the
 * words they share with it — the key's own words count double, a name or an
 * acronym (PPM, IATF, Megan) counts triple. Candidates only: the answer
 * check decides. Catches what the strict rule can't: "how many presses have
 * robots" vs robotCount "21 robots", "your PPM with automotive customers" vs
 * qualityMetrics "18 PPM".
 */
export function rankedFactCandidates(
  question: string,
  info: Record<string, unknown>,
  onFile: OnFileFact[],
  exclude: ReadonlySet<string>,
  docs: Map<string, DocLike> = new Map(),
  limit = 5,
): ReaskFinding[] {
  const q = stemsOfText(question);
  const qDistinct = distinctiveTokens(question);
  if (q.size < 2) return [];
  const sources = getFieldSources(info);
  const scored: { score: number; finding: ReaskFinding }[] = [];
  const score = (keyStems: string[], textStems: Set<string>) => {
    const k = keyStems.filter((t) => q.has(t)).length;
    let v = 0;
    let d = 0;
    textStems.forEach((t) => { if (q.has(t) && !keyStems.includes(t)) v++; if (qDistinct.has(t)) d++; });
    keyStems.forEach((t) => { if (qDistinct.has(t) && !textStems.has(t)) d++; });
    return { k, total: k * 2 + v + d * 3, d };
  };
  for (const [key, raw] of Object.entries(info)) {
    if (!isFactKey(key) || raw === null || raw === undefined || raw === "" || exclude.has(key.toLowerCase())) continue;
    const kind = String(sources[key]?.source ?? "");
    if (["crm", "website", "social"].includes(kind) && !sources[key]?.acceptedByBroker) continue;
    const kt = keyTokens(key.replace(/\d+/g, " "));
    if (kt.length === 0) continue;
    const value = valueText(raw);
    const s = score(kt, stemsOfText(value.slice(0, 400)));
    // Two of the key's words, or half of a short key's (robotCount for "how
    // many presses have robots") — not one broad word alone — or a name /
    // acronym in the value (PPM).
    const broadOnly = s.k === 1 && kt.filter((t) => q.has(t)).every((t) => BROAD_SINGLE.has(t));
    if (!(s.k >= 2 || (s.k >= 1 && s.k / kt.length >= 0.5 && !broadOnly) || (s.d >= 1 && s.total >= 4))) continue;
    scored.push({ score: s.total, finding: { kind: "fact", detail: `${key}: ${value.replace(/\s+/g, " ").slice(0, 200)} [${sourceLabel(sources[key], docs)}]`, verify: true } });
  }
  for (const f of onFile) {
    if (exclude.has(f.key.toLowerCase())) continue;
    const kt = keyTokens(f.key);
    const s = score(kt, stemsOfText(`${f.label} ${f.answer}`));
    if (!(s.k >= 2 || (s.k >= 1 && s.total >= 3) || (s.d >= 1 && s.total >= 4) || s.total >= 4)) continue;
    scored.push({ score: s.total + 1, finding: { kind: "fact", detail: `${f.key} (${f.label}): ${f.answer.slice(0, 200)} [${f.source}]`, verify: true } });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.finding);
}

/**
 * Earlier exchanges that may already answer the question though worded
 * differently ("how much resin cost is passed through" after "are you on
 * index-based pricing that passes resin volatility through?"), ranked by the
 * words the question shares with the earlier question and with the answer.
 * Candidates only.
 */
export function rankedPriorCandidates(question: string, priorQA: PriorQA[], skip: ReadonlySet<PriorQA>, limit = 3): ReaskFinding[] {
  const q = stemsOfText(question);
  const qDistinct = distinctiveTokens(question);
  if (q.size < 2) return [];
  const scored: { score: number; finding: ReaskFinding }[] = [];
  for (const p of priorQA) {
    if (skip.has(p) || !p.answer || p.answer.trim().split(/\s+/).length < 4) continue;
    const pq = stemsOfText(p.question);
    const pa = stemsOfText(p.answer.slice(0, 1200));
    let sq = 0;
    let sa = 0;
    let d = 0;
    q.forEach((t) => {
      if (pq.has(t)) sq++;
      if (pa.has(t)) sa++;
      if (qDistinct.has(t) && (pq.has(t) || pa.has(t))) d++;
    });
    const total = sq * 2 + sa + d * 2;
    if (sq + sa < 3 || total < 6) continue;
    scored.push({
      score: total,
      finding: {
        kind: "prior_question",
        detail: p.current
          ? `the seller's last message answered your previous question "${p.question.slice(0, 160)}": "${p.answer.replace(/\s+/g, " ").slice(0, 400)}"`
          : `asked ${p.where}: "${p.question.slice(0, 160)}" — the seller answered: "${p.answer.replace(/\s+/g, " ").slice(0, 400)}"`,
        verify: true,
      },
    });
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.finding);
}

/**
 * What the interviewer itself already told the seller this session ("the
 * 2024 agreement has a 12-month non-solicit and a 12-month / 5 km
 * non-compete") that the question now asks the seller for. Candidates only.
 */
export function ownStatementCandidates(question: string, statements: string[], limit = 2): ReaskFinding[] {
  const q = stemsOfText(question);
  const qDistinct = distinctiveTokens(question);
  if (q.size < 2) return [];
  const scored: { score: number; finding: ReaskFinding }[] = [];
  for (const msg of statements.slice(-4)) {
    for (const sentence of sentencesOf(msg)) {
      if (sentence.includes("?") || sentence.split(/\s+/).length < 6) continue;
      const s = stemsOfText(sentence);
      let shared = 0;
      let d = 0;
      q.forEach((t) => { if (s.has(t)) { shared++; if (qDistinct.has(t)) d++; } });
      if (shared < 3 && !(shared >= 2 && d >= 1)) continue;
      scored.push({ score: shared + d, finding: { kind: "own_statement", detail: `you told the seller yourself earlier in this session: «${sentence.slice(0, 260)}»`, verify: true } });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((x) => x.finding);
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
    const reason = REASON_RE.test(question);
    const cites = CITES_SOURCE_RE.test(draft);

    // 1. A fact already on file.
    for (const [key, raw] of Object.entries(ctx.info)) {
      if (!isFactKey(key) || raw === null || raw === undefined || raw === "") continue;
      if (conflictKeys.has(key.toLowerCase())) continue;
      const kt = keyTokens(key.replace(/\d+/g, " "));
      if (kt.length === 0) continue;
      if (kt.length === 1 && (kt[0].length < 5 || BROAD_SINGLE.has(kt[0]))) continue;
      if (!kt.every((t) => q.has(t))) continue;
      // A fact for one year doesn't answer a question about another ("revenue in 2025 so far" vs revenue2024).
      const keyYears = yearsIn(key);
      const qYears = yearsIn(question);
      if (qYears.size > 0 && (keyYears.size > 0 ? !Array.from(qYears).some((y) => keyYears.has(y)) : !Array.from(qYears).some((y) => yearsIn(valueText(raw)).has(y)))) continue;
      // A facet is new when the question adds topic words that are neither
      // the fact's own words (key or stored value) nor words that only ask
      // for its measure ("what percentage", "the split").
      const valueStems = questionTokens(valueText(raw)).stems;
      const extras = Array.from(q).filter((t) => !kt.includes(t) && !valueStems.has(t) && !MEASURE_STEMS.has(t));
      // One new word is still the fact itself for a compound key ("EV vs ICE
      // split … by platform"); a one-word key ("insurance") must be asked
      // about exactly — "the deductible on your insurance" is a new facet.
      if (extras.length > (kt.length > 1 ? 1 : 0)) continue; // asks about a facet, not the fact itself
      if (delta || reason) continue;
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
      findings.push({ kind: "fact", detail: `${key}: ${value.replace(/\s+/g, " ").slice(0, 160)} [${sourceLabel(src, docs)}]`, verify: true, fallback: true });
    }

    // 2. A question asked (and answered) before — reworded or not. The
    // same question: most words shared both ways; or the draft is a subset
    // of an earlier question and they share its distinctive word (an
    // acronym, a name: "Has your insurer or the BBB flagged…" after a longer
    // BBB question). Or the subject asked about ("cleanroom HVAC") already
    // sits in a seller answer with a figure or date: cite it, ask the delta.
    const qDistinct = distinctiveTokens(question);
    const words = (p: PriorQA) => (p.answer ? p.answer.trim().split(/\s+/).length : 0);
    // A hedge at the start of a long answer ("I'd have to check with Dana,
    // but my understanding is…") is still an answer — the model decides; a
    // short "not sure, I'll check" is a deferral that may be followed up.
    const hedged = (p: PriorQA) => NON_ANSWER_RE.test(p.answer.slice(0, 160));
    const answered = (p: PriorQA) => !!p.answer && words(p) >= 3 && (!hedged(p) || words(p) >= 20);
    // Sure enough to stand without the model: a clear answer to an EARLIER
    // exchange. The exchange the seller is answering right now may have
    // left half a compound question open — only the model may call a
    // follow-up on it a re-ask.
    const sureAnswer = (p: PriorQA) => !p.current && words(p) >= 3 && !hedged(p);
    const matchedPrior = new Set<PriorQA>();
    if (!delta && !Array.from(q).every((t) => seller.has(t))) {
      for (const p of ctx.priorQA) {
        if (!answered(p)) continue;
        const pt = questionTokens(p.question).stems;
        if (pt.size < 2 || q.size < 2) continue;
        let shared = 0;
        let sharedDistinct = 0;
        q.forEach((t) => { if (pt.has(t)) { shared++; if (qDistinct.has(t)) sharedDistinct++; } });
        const union = new Set([...Array.from(q), ...Array.from(pt)]).size;
        const same =
          (shared >= 2 && shared / union >= 0.6) ||
          (shared >= 3 && sharedDistinct >= 1 && shared / pt.size >= 0.6 && shared / q.size >= 0.5) ||
          (shared >= 3 && sharedDistinct >= 1 && shared / q.size >= 0.8) ||
          // Many words in common, a distinctive one among them, most of the shorter question.
          (shared >= 5 && sharedDistinct >= 1 && shared / Math.min(q.size, pt.size) >= 0.6);
        if (!same) continue;
        // The seller may have answered something else ("how does that compare
        // to last year?" → "the Larkspur MSA is evergreen…"): when the answer
        // shares no topic word with that question, the model decides.
        const answerStems = questionTokens(p.answer).stems;
        const onTopic = Array.from(pt).some((t) => answerStems.has(t));
        matchedPrior.add(p);
        findings.push({
          kind: "prior_question",
          detail: p.current
            ? `the seller's last message answered your previous question "${p.question.slice(0, 160)}": "${p.answer.replace(/\s+/g, " ").slice(0, 400)}"`
            : `asked ${p.where}: "${p.question.slice(0, 160)}" — the seller answered: "${p.answer.replace(/\s+/g, " ").slice(0, 400)}"`,
          verify: true,
          // (A "why" after a "what" is usually the next facet — the model decides.)
          ...(onTopic && sureAnswer(p) && !reason ? { fallback: true } : {}),
        });
        break;
      }
      if (!findings.some((f) => f.kind === "prior_question")) {
        // The question's distinctive subject ("HVAC", "Megan") next to another
        // of its topic words ("cleanroom HVAC") in a seller answer that states
        // something definite (a figure, a date, "new", "never").
        const topical = subjectWords(question);
        outer: for (const p of ctx.priorQA) {
          if (!answered(p) || qDistinct.size === 0) continue;
          for (const sentence of sentencesOf(p.answer)) {
            if (!/\d|\b(?:new|replaced|none|never|no)\b/i.test(sentence)) continue;
            const words = (sentence.match(/[A-Za-z0-9][A-Za-z0-9'’&-]*/g) ?? []).map((w) => w.replace(/['’]s$/i, "").toLowerCase().slice(0, 5));
            for (let i = 0; i < words.length; i++) {
              if (!qDistinct.has(words[i])) continue;
              const near = words.slice(Math.max(0, i - 3), i + 4).some((w, j) => j !== Math.min(3, i) && w !== words[i] && topical.has(w));
              if (!near) continue;
              matchedPrior.add(p);
              findings.push({ kind: "prior_question", detail: `the seller already said ${p.where} (answering "${p.question.slice(0, 100)}"): "${sentence.slice(0, 220)}"`, verify: true });
              break outer;
            }
          }
        }
      }
    }

    // 2b. Ranked candidates the strict rules above can't see — reworded
    // questions, a fact under another key, an on-file item, what the
    // interviewer itself told the seller. The answer check decides each —
    // a delta question too (the check knows "what has changed since" is not
    // answered by the older item; "is the union still a risk?" after the
    // seller explained the failed vote on the call is).
    {
      const factKeys = new Set(findings.filter((f) => f.kind === "fact").map((f) => f.detail.split(":")[0].toLowerCase()));
      const exclude = new Set([...Array.from(conflictKeys), ...Array.from(factKeys)]);
      findings.push(...rankedFactCandidates(questionWithLeadIn(draft), ctx.info, ctx.onFile ?? [], exclude, docs));
      if (!Array.from(q).every((t) => seller.has(t))) findings.push(...rankedPriorCandidates(question, ctx.priorQA, matchedPrior));
      findings.push(...ownStatementCandidates(question, ctx.agentStatements ?? []));
    }

    // 3. A source that already answers it (skip when the reply cites one).
    // Candidates only — the supporting model confirms them (confirmFindings).
    if (!cites) {
      let kept = 0;
      for (const hit of searchSourcesTop(questionWithLeadIn(draft), ctx.documents, 4)) {
        if (kept >= 3) break;
        // A passage whose figure the draft already cites is what it builds on.
        if (numberTokens(hit.snippet).some((n) => n.length >= 2 && numberTokens(draft).includes(n))) continue;
        kept++;
        findings.push({ kind: "source_text", detail: `${hit.docName} already says (a quoted passage from that source — not your words): «${hit.snippet}»`, quote: hit.snippet, verify: true });
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

  // 4c. …or one the live claim check found (live-claims.ts: a percentage,
  // a count, a claim — checked against the file by the supporting model),
  // unless the draft already raises it.
  findings.push(...liveConflictFindings(ctx.liveConflicts ?? [], draft, findings));

  // Strongest candidates first, at most MAX_CANDIDATES for the answer check.
  const order = (f: ReaskFinding) => (!f.verify ? 0 : f.fallback ? 1 : f.kind === "fact" ? 2 : f.kind === "prior_question" ? 3 : f.kind === "source_text" ? 4 : 5);
  const sorted = [...findings].sort((a, b) => order(a) - order(b));
  let verifyCount = 0;
  return sorted.filter((f) => !f.verify || ++verifyCount <= MAX_CANDIDATES);
}

/** The live claim check's conflicts the draft doesn't raise (and `existing` doesn't hold already). */
export function liveConflictFindings(live: ReaskFinding[], draft: string, existing: ReaskFinding[] = []): ReaskFinding[] {
  const out: ReaskFinding[] = [];
  for (const c of live) {
    if (liveConflictAddressed(c, draft)) continue;
    if ([...existing, ...out].some((f) => f.kind === "conflict" && f.detail === c.detail)) continue;
    out.push(c);
  }
  return out;
}

/** The draft already raises a live conflict: names the file's figure, or asks which is right. */
export function liveConflictAddressed(c: ReaskFinding, draft: string): boolean {
  const onFile = c.onFileValue ?? "";
  const nums = numberTokens(onFile).filter((n) => n.length >= 2 || /\./.test(n));
  return nums.some((n) => numberTokens(draft).includes(n)) ||
    /\b(differ|different|two figures|square|reconcile|versus|vs\.?|which is right|which (?:one|figure) is)\b/i.test(draft);
}

/**
 * Keeps the findings that stand: conflicts and echoes as they are; every
 * other finding only when the verifier confirms it answers what the
 * question mainly asks. When the verifier can't decide in time, the strong
 * mechanical matches (fallback) stand and the weaker candidates don't.
 */
export async function confirmFindings(
  findings: ReaskFinding[],
  draft: string,
  verifier: AnswerVerifier = modelAnswerVerifier,
  /** How long the check may take (a streamed message is waiting on it). */
  timeoutMs?: number,
): Promise<ReaskFinding[]> {
  const candidates = findings.filter((f) => f.verify);
  if (candidates.length === 0) return findings;
  const question = draftQuestions(draft) || draft;
  const t0 = Date.now();
  const confirmed = await verifier(question, candidates.map((f, i) => ({ id: String(i + 1), text: f.detail })), timeoutMs);
  const took = `${((Date.now() - t0) / 1000).toFixed(1)}s`;
  console.log(
    confirmed === null
      ? `[reask-guard] answer check: no verdict after ${took} — ${candidates.filter((f) => f.fallback).length} of ${candidates.length} candidate(s) stand on the strong match alone`
      : `[reask-guard] answer check: ${confirmed.size} of ${candidates.length} candidate(s) confirmed (${took})`,
  );
  return findings.filter((f) => {
    if (!f.verify) return true;
    if (confirmed === null) return !!f.fallback;
    return confirmed.has(String(candidates.indexOf(f) + 1));
  });
}

/** Findings that stand without a model verdict (after a rewrite, the second check is mechanical). */
export const sureFindings = (findings: ReaskFinding[]) => findings.filter((f) => !f.verify || f.fallback);

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
  const own = findings.filter((f) => f.kind === "own_statement").map((f) => `- ${f.detail}`);
  const text = findings.filter((f) => f.kind === "source_text").map((f) => `- ${f.detail}`);
  const conflicts = findings.filter((f) => f.kind === "conflict").map((f) => `- ${f.detail}`);
  const parts: string[] = ["[SYSTEM CORRECTION:"];
  // A contradicted figure comes first: the next question must reconcile it.
  if (conflicts.length) parts.push(`FIRST — the seller's figure conflicts with a document on file:\n${conflicts.join("\n")}\nYour next question must reconcile it: name both figures neutrally, attribute each only to its real source, and ask which is right and what explains the difference. Do not state either figure as settled.`);
  if (facts.length) parts.push(`Your question asks for something already on file:\n${facts.join("\n")}`);
  if (prior.length) parts.push(`You already asked this and the seller answered:\n${prior.join("\n")}`);
  if (own.length) parts.push(`You already told the seller this yourself — don't ask them for it:\n${own.join("\n")}`);
  if (text.length) parts.push(`A source on file already answers it:\n${text.join("\n")}`);
  const echo = findings.filter((f) => f.kind === "echo").map((f) => `- ${f.detail}`);
  if (echo.length) parts.push(`Your last version repeated a quoted passage word for word:\n${echo.join("\n")}\nAsk in your own words.`);
  if (facts.length || prior.length || text.length || own.length) {
    parts.push("Do not ask for it again, and do not ask the seller to confirm what they already told you. If the seller answered only part of an earlier question, ask only for the part they left out, citing what they said. If you need more, cite what is on file and ask only for what is genuinely new; otherwise move to the most important open topic (conflicts, flagged risks, critical gaps).");
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
  verifier: AnswerVerifier = modelAnswerVerifier,
): Promise<{ response: InterviewResponse; findings: ReaskFinding[]; recalled: boolean; remaining: ReaskFinding[] }> {
  const findings = draft.shouldEnd ? [] : await confirmFindings(findReasks(draft.message, { ...ctx, extractedFields: draft.extractedFields }), draft.message, verifier);
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
      : sureFindings(findReasks(response.message, { ...ctx, extractedFields: draft.extractedFields }));
  }
  return { response: current, findings, recalled: true, remaining: toFix };
}

/** Rewrites the re-ask guard may ask for on one turn. */
export const MAX_REWRITES = 2;
