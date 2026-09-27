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
import { withRewrittenHead } from "./stream-head";
import { getFieldSources, isFactKey, repairCharIndexedValue } from "./info-merger";
import { questionPart, questionTokens, searchSourcesTop, valuesMateriallyDiffer, sourceLabel, QUESTION_STOP, spokenFigureConflicts, searchWord } from "./source-context";
import { normaliseTableText } from "./table-text";
import { modelAnswerVerifier, type AnswerVerifier } from "./answer-check";
import { selfStatedFindings } from "./reply-guards";
import { sellerQuestionFromMessage } from "./seller-intent";
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
/** Figures only — not the digits inside a code ("313A" is a licence class, not 313; "G1", "V-11"). */
const FIGURE_SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9 };
/**
 * …as values, a K/M/B suffix or a scale word applied ("$1.6M", "$1.6
 * million" and "$1,600,000" are one figure; "$240K" is 240000 — a cut at
 * the letter gave "1" and nothing).
 */
export const figureTokens = (s: string) =>
  Array.from(s.matchAll(/(?<![A-Za-z\d.-])(\d[\d,]*(?:\.\d+)?)(?:\s?(k|m|mm|b|bn)(?![A-Za-z\d])|\s+(thousand|million|billion)\b|(?![A-Za-z\d]))/gi)).map((m) => {
    const n = m[1].replace(/,/g, "");
    const scale = FIGURE_SCALE[(m[2] ?? m[3] ?? "").toLowerCase()];
    return scale ? String(Math.round(parseFloat(n) * scale)) : n;
  });
const yearsIn = (s: string) => new Set((s.match(/(?<!\d)(?:19|20)\d{2}(?!\d)/g) ?? []).map(Number));

/**
 * The words a question and the file use for the same thing: "capital
 * expenditure" is the fact capexRequirements (no word in common — the
 * capex figures on file were never even a candidate: round A, Great
 * Lakes), a lien is what a debt note calls "secured by". The question
 * text gets the other form appended, for matching only.
 */
const TERM_ALIASES: Array<[RegExp, string]> = [
  [/\bcapital (?:expenditures?|spend(?:ing)?|investments?)\b|\bcap[- ]ex\b/i, "capex"],
  [/\bcapex\b/i, "capital expenditure"],
  [/\bliens?\b|\bencumber\w*|\bpledged?\b|\bcollateral\b/i, "secured security"],
  [/\bseller'?s discretionary earnings\b/i, "sde"],
  [/\bnet working capital\b/i, "nwc"],
  [/\baccounts receivable\b/i, "receivables ar"],
  [/\baccounts payable\b/i, "payables ap"],
];
export function withTermAliases(text: string): string {
  const extra = TERM_ALIASES.filter(([re]) => re.test(text)).map(([, alias]) => alias);
  return extra.length ? `${text} (${extra.join(" ")})` : text;
}

/**
 * The years a fact states a figure for: a by-year map's years, or the years
 * written next to a figure in its value ("$2,960,000 in 2024; $3,420,000 in
 * 2023" → 2024, 2023). A year alone ("since 2019") is not a figure for it.
 */
export function yearsWithFigures(raw: unknown): Set<number> {
  const out = new Set<number>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (/^(?:19|20)\d{2}$/.test(k) && v !== null && v !== undefined && v !== "") out.add(Number(k));
    }
    return out;
  }
  const text = typeof raw === "string" ? raw : "";
  const re = /(?<!\d)((?:19|20)\d{2})(?!\d)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const around = `${text.slice(Math.max(0, m.index - 28), m.index)} ${text.slice(m.index + 4, m.index + 32)}`;
    if (figureTokens(around).some((n) => !/^(?:19|20)\d{2}$/.test(n) && n.replace(/\D/g, "").length >= 2)) out.add(Number(m[1]));
  }
  return out;
}
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

/**
 * The part of a long value or answer that bears on the question, at most
 * `max` characters: the sentence (or clause) sharing most of the question's
 * words, with its neighbours while they fit. A plain head-cut hid the
 * answer from the answer check — "…Owner prefers not to sell to Bowmont
 * (9-location compe" lost "for emotional reasons"; the reason behind a
 * figure sat past the 400th character of a long answer — and the check
 * rightly said the cut text didn't answer the question.
 */
export function relevantExcerpt(text: string, question: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const parts = flat
    .split(/(?<=[.!?;])\s+/)
    .flatMap((x) => (x.length > max ? x.split(/(?<=,)\s+|\s+(?=[—–])/) : [x]))
    .map((x) => x.trim())
    .filter(Boolean);
  const q = stemsOfText(question);
  const names = distinctiveTokens(question);
  const scores = parts.map((x) => {
    let v = 0;
    stemsOfText(x).forEach((t) => { if (q.has(t)) v += names.has(t) ? 3 : 1; });
    return v;
  });
  const top = Math.max(...scores);
  if (!(top > 0)) return `${flat.slice(0, max)}…`;
  const best = scores.indexOf(top);
  let lo = best;
  let hi = best;
  let len = parts[best].length;
  // Grow toward the more relevant neighbour (the next one on a tie) while it fits.
  for (;;) {
    const canNext = hi + 1 < parts.length && len + parts[hi + 1].length + 1 <= max;
    const canPrev = lo > 0 && len + parts[lo - 1].length + 1 <= max;
    if (canNext && (!canPrev || scores[hi + 1] >= scores[lo - 1])) { hi++; len += parts[hi].length + 1; continue; }
    if (canPrev) { lo--; len += parts[lo].length + 1; continue; }
    break;
  }
  const body = parts.slice(lo, hi + 1).join(" ");
  const cut = body.length > max;
  return `${lo > 0 ? "…" : ""}${cut ? body.slice(0, max) : body}${hi < parts.length - 1 || cut ? "…" : ""}`;
}

/** Words that name no option ("based on a …", "is it more …"). */
const OPTION_STOP = new Set(
  "a an the on by from to for of in at be is it its are was were this that these those your our their more mostly mainly primarily largely based driven expecting expect planning plan would will could should do does did has have had any some just rather than either whether".split(" "),
);
/** Question-filler words that are option words all the same. */
const OPTION_WORDS = new Set(["share", "split"]);
/** Words right before a phrase that deny it ("not a trailing average", "rather than …"). */
const NEGATED_BEFORE_RE = /\b(?:not|never|no|n't|rather than|instead of|other than|except)\s+(?:\S+\s+){0,2}$/i;
/** A seller who hasn't decided ("I don't know if…", "we haven't decided", "Tom would know") — not one hedging a figure ("probably $6.5 million"). */
const UNDECIDED_RE =
  /\b(?:(?:do ?n[o'’]t|doesn['’]t|didn['’]t) (?:know|remember|recall)|not sure|unsure|no idea|(?:have|has)n['’]?t (?:decided|settled|figured)|not (?:yet )?(?:decided|settled)|undecided|still (?:deciding|figuring|working (?:it|that) out)|back and forth|either way|up in the air|torn|debating|hard to say|can['’]?t say|depends|(?:would|will|might) know|(?:have|need) to check|check with|ask (?:my|our|the) \w+|we['’]?ll see)\b/i;
const optionWords = (phrase: string) =>
  Array.from(
    new Set(
      (phrase.match(/[A-Za-z0-9][A-Za-z0-9'’&]*/g) ?? [])
        .map((w) => w.toLowerCase())
        // ("share" and "split" name options — a share sale, a fee split — though a question's "share with me" names none.)
        .filter((w) => !OPTION_STOP.has(w) && (!QUESTION_STOP.has(w) || OPTION_WORDS.has(w)) && (w.length >= 3 || /\d/.test(w)))
        .map((w) => w.slice(0, 5)),
    ),
  );

/**
 * A choice question ("…a trailing-twelve-month average, or a point-in-time
 * snapshot at closing?") one of whose options the seller's LAST message
 * already states ("$6.5 to $6.8 million trailing-twelve average") — the
 * seller had just said it (Great Lakes T10: "that's what I just said"). An
 * option is the noun phrase on either side of "or"; it counts when at least
 * two of its words, and three in four of them, sit together in the seller's message
 * and aren't denied there ("not a trailing average"). A seller who hasn't
 * chosen is left alone: one who names the other option too ("going back and
 * forth between a share sale and an asset sale") or says they don't know
 * ("I don't know if it'd be a trailing-twelve average or a snapshot — Tom
 * would know") — this finding is sure, and telling the model such a seller
 * already answered would have it treat them as decided. Returns the option,
 * or null. Pure.
 */
export function choiceAnsweredNow(question: string, sellerMessage: string): string | null {
  if (!sellerMessage || !/\bor\b/i.test(question)) return null;
  // The question sentence itself (its lead-in and any statement stay out).
  const q = (question.replace(/\s+/g, " ").match(/[^.!?]*\?/g) ?? []).pop()?.trim() ?? "";
  const said = sellerMessage.replace(/\s+/g, " ");
  const saidTokens = Array.from(said.matchAll(/[A-Za-z0-9][A-Za-z0-9'’&]*/g)).map((t) => ({ w: t[0].toLowerCase().slice(0, 5), at: t.index ?? 0 }));
  const pairs: [string, string][] = [];
  for (const m of Array.from(q.matchAll(/\bor\b/gi))) {
    const at = m.index ?? 0;
    // A real choice between two things: "…, or a point-in-time snapshot?" —
    // not a second question joined on ("…your $10K deductible, or is there
    // any portion still in dispute?", "…, or does it only apply to…").
    if (/^\s*(?:is|are|was|were|do|does|did|would|will|can|could|should|has|have|had|might|may|must|if|when|whether|how|what|why|who|not|something|anything|someone|anyone)\b/i.test(q.slice(at + m[0].length))) continue;
    // …nor a range ("one or two associates"), nor an "or" inside a phrase
    // the question goes on past ("compounding or community prescriptions,
    // and if so, how concentrated…"): the choice is what the question ends on.
    if (/\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few|few)\s*$/i.test(q.slice(0, at))) continue;
    const tail = q.slice(at + m[0].length);
    if (!/^\s*\?/.test(tail.slice(tail.split(/[?.!:;,—–]/)[0].length))) continue;
    // Left: the words after the last function word before "or".
    const lw = (q.slice(0, at).split(/[?.!:;—–]/).pop() ?? "").replace(/,\s*$/, "").split(/[\s,]+/).filter(Boolean);
    let i = lw.length;
    while (i > 0 && !OPTION_STOP.has(lw[i - 1].toLowerCase())) i--;
    const left = lw.slice(i).join(" ");
    // Right: past the leading function words, up to the next one.
    const rw = (q.slice(at + m[0].length).split(/[?.!:;,—–]/)[0] ?? "").split(/\s+/).filter(Boolean);
    let j = 0;
    while (j < rw.length && OPTION_STOP.has(rw[j].toLowerCase())) j++;
    let k = j;
    while (k < rw.length && !OPTION_STOP.has(rw[k].toLowerCase())) k++;
    pairs.push([left, rw.slice(j, k).join(" ")]);
  }
  /** Where the message states the option (index of its first word), or -1. */
  const statedAt = (phrase: string): number => {
    const words = optionWords(phrase);
    if (words.length < 2) return -1;
    // The best run of the option's words in the message (positions within a short span).
    for (let s = 0; s < saidTokens.length; s++) {
      if (!words.includes(saidTokens[s].w)) continue;
      const run = saidTokens.slice(s, s + words.length + 2);
      const window = run.map((t) => t.w);
      const found = words.filter((w) => window.includes(w)).length;
      // (Three words in four: "signed contractor agreements" is not answered
      // by "associates on contractor agreements" — that was about the PTs.)
      if (found < 2 || found / words.length < 0.75) continue;
      // Denied anywhere in the run: "a share sale — not an asset sale" does
      // not state "asset sale" (the run "sale — not an asset" held both).
      if (run.some((t) => words.includes(t.w) && NEGATED_BEFORE_RE.test(said.slice(0, t.at)))) continue;
      return s;
    }
    return -1;
  };
  /**
   * The message names the other option at all — one of the words that set
   * it apart ("asset", not the "sale" both options share), not denied
   * ("…or a snapshot — Tom would know"; "not a snapshot" is a choice).
   */
  const named = (other: string, chosen: string): boolean =>
    optionWords(other)
      .filter((w) => w.length >= 4 && !optionWords(chosen).includes(w))
      .some((w) => saidTokens.some((t) => t.w === w && !NEGATED_BEFORE_RE.test(said.slice(0, t.at))));
  for (const [left, right] of pairs) {
    for (const [phrase, other] of [[left, right], [right, left]]) {
      const at = statedAt(phrase);
      if (at < 0) continue;
      // A seller who names BOTH options hasn't chosen ("going back and forth
      // between a share sale and an asset sale"), and one who says they
      // don't know hasn't either ("I don't know if it'd be a trailing-twelve
      // average or a snapshot — Tom would know"): the question may stand.
      if (named(other, phrase)) continue;
      const sentence = sentencesOf(said).find((x) => x.includes(said.slice(saidTokens[at].at, saidTokens[at].at + 12))) ?? said;
      if (UNDECIDED_RE.test(sentence)) continue;
      return phrase;
    }
  }
  return null;
}

/** The reply asks the seller (or their staff) to send a document. */
const DOC_REQUEST_RE =
  /\b(?:send|upload|e-?mail|forward|share|pull(?: together)?|put together|provide|dig up|get (?:me|us|your broker)|could (?:you|\w+) (?:send|share))\b[^?]{0,40}?\b(?:list|report|breakdown|spreadsheet|schedule|summary|roster|copy|copies|statement|statements|document|file|chart|register|export|record|records|sheet|agreement|contract|certificates?|licen[cs]es?|table)\b/i;
const LEAD_KIND = new Set(["crm", "website", "social"]);
/** Words that name no document ("send over a copy of your …"). */
const REQUEST_STOP = new Set(
  "send over along upload email mail forward share pull together provide copy copies document documents file files could would please each every their your our breakdown list report summary showing show shows alongside with which specific individually name names help round section like out".split(" "),
);

/** Up to `max` characters of a document's lines that bear on the question (in their order). */
export function relevantLines(text: string, question: string, max: number): string {
  const q = stemsOfText(question);
  const lines = normaliseTableText(text).split("\n").map((l) => l.trim()).filter((l) => l.length > 3);
  const scored = lines.map((l, i) => ({ i, l, s: Array.from(stemsOfText(l)).filter((t) => q.has(t)).length })).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s || a.i - b.i);
  const picked: typeof scored = [];
  let len = 0;
  for (const x of scored) {
    if (len + x.l.length + 3 > max) continue;
    picked.push(x);
    len += x.l.length + 3;
  }
  return picked.sort((a, b) => a.i - b.i).map((x) => x.l).join(" | ");
}

/**
 * Documents on file that a document request in the reply may be asking for
 * again: the reply asks the seller to send something, and a seller-visible
 * document's name shares two of the request's topic words (the words of the
 * question and its lead-in: "which technicians hold which licences" →
 * "Staff roster with technician licences"). Candidates only — the answer
 * check decides whether the document covers what is asked.
 */
export function requestedDocumentCandidates(questionAndLeadIn: string, documents: DocLike[], limit = 2): { docName: string; excerpt: string }[] {
  if (!DOC_REQUEST_RE.test(questionAndLeadIn)) return [];
  const words = new Set(
    (questionAndLeadIn.match(/[A-Za-z0-9][A-Za-z0-9'’&-]*/g) ?? [])
      .map((w) => searchWord(w))
      .filter((w) => w.length >= 4 && !REQUEST_STOP.has(w) && !QUESTION_STOP.has(w)),
  );
  const out: { docName: string; excerpt: string; score: number }[] = [];
  for (const d of documents) {
    if (d.visibility === "broker_only" || LEAD_KIND.has(String(d.sourceKind))) continue;
    const text = typeof d.extractedText === "string" ? d.extractedText : "";
    if (!text.trim()) continue;
    const nameWords = new Set((d.name.match(/[A-Za-z0-9][A-Za-z0-9'’&-]*/g) ?? []).map((w) => searchWord(w)));
    const shared = Array.from(words).filter((w) => nameWords.has(w));
    if (shared.length < 2) continue;
    const excerpt = relevantLines(text, questionAndLeadIn, 420);
    if (!excerpt) continue;
    out.push({ docName: d.name, excerpt, score: shared.length });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit).map(({ docName, excerpt }) => ({ docName, excerpt }));
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
  /** The interviewer's own earlier messages in this session (newest last) — what it already told the seller (asking for it is a re-ask too). */
  ownStatements?: string[];
  /** Figures the seller just gave that the file states differently (live-claims.ts), not yet raised. */
  liveConflicts?: ReaskFinding[];
  /** When the seller's message arrived (ms) — bounds the answer check on a rewrite (rewriteCheckBudget). */
  turnStartedAt?: number;
}

/** How many model-checked candidates one draft may carry (strongest first). */
const MAX_CANDIDATES = 8;

/** Stems of a text as questionTokens makes them (5 characters, stop words out, acronyms kept). */
const stemsOfText = (t: string) => questionTokens(t).stems;

/** A clause that opens the ask: an auxiliary or a question word ("is there…", "how many…", "would you…"). */
const ASK_HEAD_RE = /^(?:(?:and|but|so|then)\s+)?(?:is|are|was|were|do|does|did|would|will|can|could|should|has|have|had|what(?:['’]s)?|how(?:['’]s)?|which|who|whose|when|where|why)\b/i;

/**
 * The clause of the last question that asks — from its question word on —
 * without the lead-in that sets it up ("On Leah specifically — given the
 * Bowmont situation last fall and her importance to the concussion
 * program, is there any retention arrangement being discussed…" → "is
 * there any retention arrangement being discussed…"). "" when the question
 * has no lead-in, or none can be told apart. Pure.
 */
export function askClause(text: string): string {
  const last = (text.replace(/\s+/g, " ").match(/[^.!?]*\?/g) ?? []).pop()?.trim() ?? "";
  const segs = last.split(/(?<=[,:;—–])\s*/).map((x) => x.trim()).filter(Boolean);
  const at = segs.findIndex((x) => ASK_HEAD_RE.test(x));
  return at > 0 ? segs.slice(at).join(" ") : "";
}

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
  type Score = { k: number; v: number; d: number; total: number };
  type Entry = { keyStems: string[]; textStems: Set<string>; pass: (s: Score) => boolean; bonus: number; finding: ReaskFinding };
  const entries: Entry[] = [];
  const score = (keyStems: string[], textStems: Set<string>, w: (t: string) => number = () => 1): Score => {
    const k = keyStems.filter((t) => q.has(t)).length;
    let v = 0;
    let d = 0;
    let total = 0;
    keyStems.forEach((t) => { if (q.has(t)) total += 2 * w(t); });
    textStems.forEach((t) => {
      if (q.has(t) && !keyStems.includes(t)) { v++; total += w(t); }
      if (qDistinct.has(t)) { d++; total += 3 * w(t); }
    });
    keyStems.forEach((t) => { if (qDistinct.has(t) && !textStems.has(t)) { d++; total += 3 * w(t); } });
    return { k, v, d, total };
  };
  for (const [key, raw] of Object.entries(info)) {
    if (!isFactKey(key) || raw === null || raw === undefined || raw === "" || exclude.has(key.toLowerCase())) continue;
    const kind = String(sources[key]?.source ?? "");
    if (["crm", "website", "social"].includes(kind) && !sources[key]?.acceptedByBroker) continue;
    const kt = keyTokens(key.replace(/\d+/g, " "));
    if (kt.length === 0) continue;
    const value = valueText(raw);
    // Two of the key's words, or half of a short key's (robotCount for "how
    // many presses have robots") — not one broad word alone — or a name /
    // acronym in the value (PPM).
    // …or three of the question's topic words in the value itself ("the annual budget for the press
    // replacement program" vs maintenanceCapexRun "$1.6 million annually … press replacements").
    const pass = (s: Score) => {
      const broadOnly = s.k === 1 && kt.filter((t) => q.has(t)).every((t) => BROAD_SINGLE.has(t));
      return s.k >= 2 || (s.k >= 1 && s.k / kt.length >= 0.5 && !broadOnly) || (s.d >= 1 && s.total >= 4) || s.v >= 3;
    };
    entries.push({ keyStems: kt, textStems: stemsOfText(value.slice(0, 800)), pass, bonus: 0, finding: { kind: "fact", detail: `${key}: ${relevantExcerpt(value, question, 280)} [${sourceLabel(sources[key], docs)}]`, verify: true } });
  }
  for (const f of onFile) {
    if (exclude.has(f.key.toLowerCase())) continue;
    const kt = keyTokens(f.key);
    const pass = (s: Score) => s.k >= 2 || (s.k >= 1 && s.total >= 3) || (s.d >= 1 && s.total >= 4) || s.total >= 4;
    entries.push({ keyStems: kt, textStems: stemsOfText(`${f.label} ${f.answer}`), pass, bonus: 1, finding: { kind: "fact", detail: `${f.key} (${f.label}): ${relevantExcerpt(f.answer, question, 280)} [${f.source}]`, verify: true } });
  }
  // Ranked by how telling the shared words are: a word most facts share
  // (the seller's name, a key employee, the business's own vocabulary)
  // says little about which fact answers; a word few facts use says a lot.
  // Clearwater, "…given the Bowmont situation and her importance to the
  // concussion program, is there any retention arrangement for Leah?": five
  // facts naming Leah, Bowmont and the concussion program outranked the one
  // that answers it (transitionPlan: "Retention arrangements recommended
  // for Leah and Dana"), and the 5-fact limit cut it. Which facts qualify is
  // still decided on plain counts; with a handful of facts there is nothing
  // to weigh against, and every word counts the same.
  // The words of the clause that asks count fully; the lead-in's ("On Leah
  // specifically — given the Bowmont situation last fall, …") half — it
  // sets the question up, the ask ("is there any retention arrangement…")
  // is what an answer must state.
  const n = entries.length;
  const df = new Map<string, number>();
  for (const e of entries) new Set([...e.keyStems, ...Array.from(e.textStems)]).forEach((t) => { if (q.has(t)) df.set(t, (df.get(t) ?? 0) + 1); });
  const ask = askClause(question);
  const askStems = ask ? stemsOfText(ask) : null;
  const weight = (t: string) =>
    (n < 8 ? 1 : Math.log(1 + n / Math.max(1, df.get(t) ?? 1)) / Math.log(1 + n)) * (askStems && !askStems.has(t) ? 0.5 : 1);
  const scored: { score: number; finding: ReaskFinding }[] = [];
  for (const e of entries) {
    if (!e.pass(score(e.keyStems, e.textStems))) continue;
    scored.push({ score: score(e.keyStems, e.textStems, weight).total + e.bonus, finding: e.finding });
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
          ? `the seller's last message answered your previous question "${p.question.slice(0, 160)}": "${relevantExcerpt(p.answer, question, 420)}"`
          : `asked ${p.where}: "${p.question.slice(0, 160)}" — the seller answered: "${relevantExcerpt(p.answer, question, 420)}"`,
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

/**
 * What the interviewer told the seller itself, asked back: the question's
 * words against its recent statements (ownStatementCandidates), plus the
 * draft read from its first question to the end (reply-guards
 * selfStatedFindings — "…could you walk me through the key terms? I'm
 * thinking notice period, the non-compete radius…" carries the topic after
 * the question mark). One candidate per statement; the answer check decides.
 */
export function ownStatementFindings(draft: string, question: string, statements: string[], limit = 2): ReaskFinding[] {
  if (statements.length === 0) return [];
  const out = ownStatementCandidates(question, statements, limit);
  const quoted = (d: string) => (d.match(/«([^»]*)/)?.[1] ?? d).slice(0, 200);
  for (const f of selfStatedFindings(draft, statements)) {
    if (out.length >= limit) break;
    if (out.some((o) => quoted(o.detail) === quoted(f.detail))) continue;
    out.push({ kind: "own_statement", detail: f.detail, verify: true });
  }
  return out;
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
      findings.push({ kind: "fact", detail: `${key}: ${relevantExcerpt(value, question, 220)} [${sourceLabel(src, docs)}]`, verify: true, fallback: true });
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
    // 2a. A choice whose option the seller's last message states outright
    // ("trailing-twelve-month average, or a snapshot at closing?" right after
    // "…$6.5 to $6.8 million trailing-twelve average"). Sure, like a
    // conflict — it stands without the answer check: offering the seller
    // what they just said as an option asks them to repeat it. (Replayed
    // over every recorded interview — 707 seller answers followed by a
    // question — it fired twice, both real re-asks.)
    const option = choiceAnsweredNow(question, ctx.sellerMessage);
    if (option) {
      const current = ctx.priorQA.find((p) => p.current);
      if (current) matchedPrior.add(current);
      findings.push({
        kind: "prior_question",
        detail: `the seller's last message already answers it — you offer "${option}" as an option, and they just said: "${relevantExcerpt(ctx.sellerMessage, option, 300)}"`,
      });
    }
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
            ? `the seller's last message answered your previous question "${p.question.slice(0, 160)}": "${relevantExcerpt(p.answer, question, 420)}"`
            : `asked ${p.where}: "${p.question.slice(0, 160)}" — the seller answered: "${relevantExcerpt(p.answer, question, 420)}"`,
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

    // 1b. A question over several years with some of them on file (capex
    // "for 2022, 2023, and 2024" with 2023 and 2024 in the statements): ask
    // only for the years missing, citing the ones on file. Sure — the
    // answer check read the whole question as unanswered (2022 isn't on
    // file) and it went out, re-asking two years the seller had sent.
    {
      const qYears = Array.from(yearsIn(question)).sort();
      if (qYears.length >= 2 && !delta) {
        const matchText = withTermAliases(questionWithLeadIn(draft));
        for (const c of rankedFactCandidates(matchText, ctx.info, [], conflictKeys, docs, 4)) {
          const key = c.detail.split(":")[0];
          const raw = ctx.info[key];
          const kind = String(sources[key]?.source ?? "");
          if (["crm", "website", "social"].includes(kind)) continue;
          const have = yearsWithFigures(raw);
          const onFile = qYears.filter((y) => have.has(y));
          const missing = qYears.filter((y) => !have.has(y));
          if (onFile.length === 0 || missing.length === 0) continue;
          // Already citing what is on file ("I have 2023 at $3.42M and 2024
          // at $2.96M — what was 2022?"): that is the right question.
          const onFileFigures = figureTokens(valueText(raw)).filter((n) => !/^(?:19|20)\d{2}$/.test(n) && n.length >= 2);
          if (onFileFigures.some((n) => figureTokens(draft).includes(n))) continue;
          findings.push({
            kind: "fact",
            detail: `${key}: ${relevantExcerpt(valueText(raw), question, 220)} [${sourceLabel(sources[key], docs)}] — on file for ${onFile.join(" and ")}; ask ONLY for ${missing.join(" and ")}, citing the ${onFile.length === 1 ? "year" : "years"} on file`,
          });
          break;
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
      findings.push(...rankedFactCandidates(withTermAliases(questionWithLeadIn(draft)), ctx.info, ctx.onFile ?? [], exclude, docs));
      if (!Array.from(q).every((t) => seller.has(t))) findings.push(...rankedPriorCandidates(question, ctx.priorQA, matchedPrior));
      findings.push(...ownStatementFindings(draft, question, ctx.ownStatements ?? []));
    }

    // 3. A source that already answers it. Candidates only — the supporting
    // model confirms them (confirmFindings). Searched even when the reply
    // cites a source: naming the source is no licence to ask for what it
    // says ("the staff roster lists your technicians' licences … how many
    // of your techs hold the 313A?" with the count on the licensing summary).
    // A passage whose figure the draft already cites is what it builds on.
    {
      // 3a. A document asked for that is on file ("Could Denise send over a
      // breakdown of each tech's certifications?" with the staff roster with
      // technician licences uploaded) — first: a request for a document the
      // seller already sent is the plainest re-ask there is.
      const requested = requestedDocumentCandidates(questionWithLeadIn(draft), ctx.documents);
      for (const c of requested) {
        findings.push({ kind: "source_text", detail: `${c.docName} is already on file (the seller sent it) — it reads: «${c.excerpt}»`, quote: c.excerpt, verify: true });
      }
      // …and the clause that asks on its own, after: a long lead-in ("given
      // the Bowmont situation last fall and her importance to the concussion
      // program, is there any retention arrangement…") pulled the Zoom
      // call's best passage toward Bowmont and last fall, away from the line
      // where the broker proposed retention for Leah and Dana. (Not instead:
      // a lead-in can carry the subject — "of your 11 physiotherapists, how
      // many are T4?")
      const ask = askClause(draft);
      const hits = [...searchSourcesTop(withTermAliases(questionWithLeadIn(draft)), ctx.documents, 4), ...(ask ? searchSourcesTop(withTermAliases(ask), ctx.documents, 2) : [])];
      let kept = 0;
      for (const [i, hit] of Array.from(hits.entries())) {
        if (kept >= 3) break;
        if (requested.some((c) => c.docName === hit.docName)) continue;
        if (hits.findIndex((h) => h.snippet === hit.snippet) !== i) continue;
        if (figureTokens(hit.snippet).some((n) => n.length >= 2 && figureTokens(draft).includes(n))) continue;
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

  return capCandidates(findings);
}

/** The kinds of model-checked candidates, in the order they take turns for the slots. */
const CANDIDATE_KINDS: ReaskFinding["kind"][] = ["fact", "prior_question", "source_text", "own_statement"];

/**
 * At most MAX_CANDIDATES go to the answer check: the sure findings as they
 * are, the strong mechanical matches (fallback) first, then the kinds TAKING
 * TURNS — the best fact, the best earlier exchange, the best source passage,
 * the best own statement, then the second of each… (each list is already
 * ranked). Filling the slots kind by kind (facts, then earlier exchanges,
 * then sources) cut every source whenever five facts and three earlier
 * exchanges matched, which on a real deal is most turns: with the full
 * acceptance-test context the staff roster the reply asked Denise to send
 * (Lakeshore) and the Zoom line where the seller agreed to Leah's retention
 * (Clearwater) never reached the check.
 */
export function capCandidates(findings: ReaskFinding[], max = MAX_CANDIDATES): ReaskFinding[] {
  const sure = findings.filter((f) => !f.verify);
  const strong = findings.filter((f) => f.verify && f.fallback);
  const queues = CANDIDATE_KINDS.map((k) => findings.filter((f) => f.verify && !f.fallback && f.kind === k));
  const other = findings.filter((f) => f.verify && !f.fallback && !CANDIDATE_KINDS.includes(f.kind));
  const picked: ReaskFinding[] = strong.slice(0, max);
  for (let round = 0; picked.length < max && queues.some((qu) => round < qu.length); round++) {
    for (const qu of queues) if (round < qu.length && picked.length < max) picked.push(qu[round]);
  }
  for (const f of other) if (picked.length < max) picked.push(f);
  return [...sure, ...picked];
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
export function reaskCorrection(
  findings: ReaskFinding[],
  opts: {
    /** The seller's message this turn answers (their own question in it is kept — see below). */
    sellerMessage?: string | null;
  } = {},
): string {
  const facts = findings.filter((f) => f.kind === "fact").map((f) => `- ${f.detail}`);
  const prior = findings.filter((f) => f.kind === "prior_question").map((f) => `- ${f.detail}`);
  const own = findings.filter((f) => f.kind === "own_statement").map((f) => `- ${f.detail}`);
  const text = findings.filter((f) => f.kind === "source_text").map((f) => `- ${f.detail}`);
  const conflicts = findings.filter((f) => f.kind === "conflict").map((f) => `- ${f.detail}`);
  const parts: string[] = ["[SYSTEM CORRECTION:"];
  // The seller's own question survives every rewrite. A rewrite told "a
  // source on file already answers it" dropped the draft's answer to "who
  // holds which licences — do you have that?" and switched topic (round A,
  // Lakeshore); a conflict rewrite dropped "what happens to my personal
  // guarantees at closing?" (Great Lakes).
  const asked = opts.sellerMessage ? sellerQuestionFromMessage(opts.sellerMessage) : "";
  if (asked) {
    parts.push(
      `THE SELLER ASKED YOU: "${asked.slice(0, 300)}" — your rewrite must still answer it, first, in a sentence of its own. When the file answers it (a source named below, or a fact on file), say so and give the answer from the file ("Yes — the staff roster lists …"); when it is the broker's to answer, say that plainly. Never drop it to change the topic, and never ask the seller for what the file already holds.`,
    );
  }
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
      { role: "user" as const, content: reaskCorrection(attempt === 0 ? toFix : all, { sellerMessage: ctx.sellerMessage }) },
    );
    // A wording rewrite: only its head is used (the question, why we ask,
    // chips) — the model is stopped there instead of writing a tail that
    // would be thrown away (~15s of Opus output); the draft's extracted
    // facts, reasoning and tasks stand (stream-head.ts).
    const rewrite = await callInterviewWithRecovery(anthropic, { ...params, messages: conversation }, undefined, undefined, { headOnly: true });
    if (rewrite.degraded || !rewrite.response.message) break;
    const response = rewrite.headOnly ? withRewrittenHead(current, rewrite.response) : rewrite.response;
    // A rewrite that parrots a quoted source passage (a transcript line in
    // the seller's voice) is worse than what it replaces — stop there.
    if (all.some((f) => f.quote && echoesPassage(response.message, f.quote))) break;
    // Keep what the first draft extracted if the rewrite dropped it.
    for (const [k, v] of Object.entries(draft.extractedFields)) {
      if (!(k in response.extractedFields)) response.extractedFields[k] = v;
    }
    current = response;
    // The rewrite is a NEW question and gets the same check as the draft
    // (checkRewrite): the acceptance test's re-asks were almost all
    // rewrites that went out on the mechanical check alone — the 313A count
    // on the licensing summary, Leah's retention from the Zoom call, the
    // peg method the seller had just given. After the last rewrite nothing
    // can change any more: only the sure findings are reported.
    toFix = response.shouldEnd
      ? []
      : await checkRewrite(response.message, { ...ctx, extractedFields: draft.extractedFields }, attempt + 1, verifier);
  }
  return { response: current, findings, recalled: true, remaining: toFix };
}

/** Rewrites the re-ask guard may ask for on one turn. */
export const MAX_REWRITES = 2;
/** How long the answer check on a rewrite may take (the seller has already waited for one check and a rewrite). */
export const REWRITE_CHECK_TIMEOUT_MS = 6_000;

/**
 * By when, counted from the seller's message, a rewrite's answer check must
 * be done. A confirmed candidate on a rewrite means one more Opus rewrite
 * (+10–15s); past this point the seller has waited long enough, and the
 * rewrite goes out on its sure findings alone — so a turn with two rewrites
 * starts its last one within ~30s of the seller's message at the latest.
 * (The first draft's check is not bounded by this.)
 */
export const REWRITE_CHECK_DEADLINE_MS = 30_000;
/** Less time than this left for a rewrite's check: no model call (the check itself takes ~2–3s). */
const MIN_REWRITE_CHECK_MS = 2_500;

/**
 * How long the answer check on rewrite number `attempt` (1 = the first
 * rewrite) may take; 0 = no model call, only the sure findings count — on
 * the last allowed rewrite (nothing could be rewritten again), or once the
 * turn is past REWRITE_CHECK_DEADLINE_MS. Pure.
 */
export function rewriteCheckBudget(attempt: number, turnStartedAt?: number, now: number = Date.now()): number {
  if (attempt >= MAX_REWRITES) return 0;
  if (turnStartedAt === undefined || !Number.isFinite(turnStartedAt)) return REWRITE_CHECK_TIMEOUT_MS;
  const left = turnStartedAt + REWRITE_CHECK_DEADLINE_MS - now;
  return left < MIN_REWRITE_CHECK_MS ? 0 : Math.min(REWRITE_CHECK_TIMEOUT_MS, left);
}

/**
 * The check on rewrite number `attempt` (1 = the first rewrite): every
 * candidate goes to the answer check, as on the first draft (past the
 * timeout, only the strong mechanical matches stand), within the turn's
 * budget (rewriteCheckBudget); on the last allowed rewrite, or past the
 * budget, no model call is made and only the sure findings are returned.
 */
export async function checkRewrite(
  message: string,
  ctx: ReaskContext,
  attempt: number,
  verifier: AnswerVerifier = modelAnswerVerifier,
  timeoutMs: number = rewriteCheckBudget(attempt, ctx.turnStartedAt),
): Promise<ReaskFinding[]> {
  const candidates = findReasks(message, ctx);
  if (attempt >= MAX_REWRITES || timeoutMs <= 0) {
    if (attempt < MAX_REWRITES) console.log(`[reask-guard] rewrite ${attempt}: past the turn's check budget — sure findings only`);
    return sureFindings(candidates);
  }
  return confirmFindings(candidates, message, verifier, timeoutMs);
}
