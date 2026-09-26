/**
 * reply-guards — what the seller reads, held to the product rules after the
 * filler guard (turn-guard.stripFillerPreamble) has run. Each check here was
 * a live miss in the round-V verification (27 + 55 real turns):
 *
 *  - NO NORMALISATION CALLS. The interviewer must never tell the seller how
 *    an item is treated in SDE/EBITDA ("all of it would be an add-back for a
 *    new owner", "we'll show the personal expenses as a separate add-back").
 *    Owner dividends and draws are distributions, not expenses — a confident
 *    wrong call in front of the seller is worse than a hand-off. The
 *    sentence (or clause) is removed; when the seller raised it themselves
 *    they get the hand-off line instead. The same rule holds for what the
 *    turn records (guardNormalisationFields): a treatment conclusion is never
 *    stored as the seller's fact — it goes to the broker's private notes.
 *  - EXACTLY ONE QUESTION on a turn that doesn't end ("…where does that
 *    stand? Is it on the schedule for 2025 or 2026?").
 *  - OPTIONS ANCHORED TO TODAY: a future-framed question never offers a year
 *    that has already passed ("2025 or 2026?" asked on 2026-09-25).
 *  - LOCAL VOCABULARY: a Canadian business never hears US terms (W-2,
 *    1099, 401(k), S-corp, IRS) and a US business never hears Canadian ones.
 *  - WHO SAID IT: "you mentioned" only for what the seller said — a manager
 *    on the Zoom call or a note on file is attributed as such.
 *
 * Everything here is deterministic and pure (the stream gate runs it before
 * a word is shown, and the final reply must come out identical).
 */
import { splitSentences } from "./turn-guard";

// ═══════════════════════ Normalisation assertions ═══════════════════════

/** Words that put a sentence in normalisation territory. */
const NORM_TERM =
  String.raw`(?:add[- ]?backs?|added[- ]back|adding (?:it |that |them |this |those )?back|add (?:it|that|them|this|those) back|normali[sz](?:e|ed|es|ing|ation)|recast(?:ing)?|SDE|seller'?s discretionary (?:earnings|cash flow)|discretionary (?:earnings|cash flow)|adjusted (?:EBITDA|earnings)|normali[sz]ed (?:EBITDA|earnings))`;
const NORM_TERM_RE = new RegExp(`\\b${NORM_TERM}\\b`, "i");
/** A treatment call: a linking or presenting verb before the term, or a passive "added back". */
const TREATMENT_RE = new RegExp(
  String.raw`\b(?:is|are|'s|was|were|would be|will be|becomes?|counts? (?:as|toward|towards|in)|goes? (?:into|in|toward)|qualif(?:y|ies) as|treated as|shown as|presented as|counted as|classified as|listed as|(?:we|i)'?ll (?:show|treat|present|list|count|add|put|carry|record)|(?:we|i) (?:would|will|can|could) (?:show|treat|present|list|count|add|put|carry))\b(?:\s+[\w$~.,%'’-]+){0,10}?\s+(?:an?\s+|the\s+|one\s+|a separate\s+|separate\s+|your\s+|part of (?:the |your )?)?${NORM_TERM}\b` +
    String.raw`|\b(?:gets?|got|are|is|be|being|been|would be|will be)\s+(?:(?:fully|all|also|simply|just)\s+)?added[- ]back\b` +
    String.raw`|\b(?:SDE|adjusted EBITDA|discretionary earnings|normali[sz]ed (?:EBITDA|earnings))\s+(?:is|are|would be|will be|comes? (?:in )?(?:to|at)|works? out (?:to|at)|of|at|around|roughly|about)\s+(?:(?:about|around|roughly|approximately|close to|just over|just under)\s+)?(?:\$|\d)`,
  "i",
);
/**
 * The same call without the vocabulary: "a new owner wouldn't need to pay
 * me that", "all of it flows through", "comes back to the buyer" (live:
 * the Ridgeline fact was re-recorded as "Seller confirms all flows through
 * and a new owner wouldn't need to replicate it" once "add-back" was barred).
 */
const OWNER_COST_CALL_RE =
  /\b(?:a |the )?(?:new owner|buyer|purchaser|acquirer)s?\b[^.;?]{0,40}?\b(?:would(?:n'?t| not)|won'?t|will not|does(?:n'?t| not)|do(?:n'?t| not)|need(?:n'?t| not)|never)\b[^.;?]{0,20}?\b(?:need to |have to )?(?:pay|replicate|cover|incur|carry|bear|fund)\s+(?:me|you|him|her|them|that|it|this|those|the (?:owner|salary|expenses?|comp\w*|full|whole)|an? (?:owner|salary)|\$|\d|(?:your|my|his|her) (?:salary|comp\w*|draws?|expenses?|pay))\b|\b(?:all (?:of )?(?:it|that|this)|it all|everything|the (?:whole|full|entire) (?:amount|\$?[\d.,]+\s?[km]?))\s+(?:flows?|comes?) (?:back|through)\b|\bcomes? back to (?:the|a) (?:buyer|new owner)\b/i;

/** A hand-off or an open question about treatment — never an assertion. */
const TREATMENT_HEDGE_RE =
  /\b(?:your broker|the broker|the (?:financial )?analysis|the normali[sz]ation|your accountant|the accountant|a buyer'?s (?:accountant|advisor)|quality of earnings)\b[^.?!]{0,80}\b(?:will|would|can|could|to|should) (?:confirm|decide|determine|work out|review|look at|handle|assess|sort out|verify)\b|\bwhether\b|\bif (?:it|that|they|those|any)\b(?:'s| is| are| counts?| qualif)|\byou (?:said|mentioned|told me|described|called)\b|\byour (?:add[- ]?back (?:list|schedule|summary|sheet)|recast)\b/i;

/** The hand-off the seller gets when they raised treatment themselves. */
export const NORMALISATION_HANDOFF =
  "Your broker will confirm what gets added back when they normalize the numbers against your statements.";

/**
 * The call made the other way round (live, Ridgeline round V: "Dividends work
 * differently — … so there's nothing to 'add back' for those"; "the $180K
 * salary and the personal expenses flow through") — right or wrong, the
 * normalization is the broker's to explain, not the interviewer's.
 */
const NEGATIVE_OR_ITEM_CALL_RE =
  /\b(?:nothing|no(?:thing)? (?:amount|part)) (?:to|that(?:'s| is| gets)?) (?:be )?["“']?add(?:ed)?["”']? back\b|\bnothing to ["“']?add back\b|\b(?:is|are|'s)(?:n't| not)\s+(?:an? |really an? )?["“']?(?:add[- ]?backs?|added back)\b|\bnot (?:an? )?["“']?add[- ]?backs?\b|\b(?:don'?t|doesn'?t|won'?t|wouldn'?t|never|can'?t) (?:get |be |need to be )?["“']?add(?:ed)? back\b|\b(?:salary|salaries|wages?|expenses?|comp(?:ensation)?|dividends?|draws?|perks?|personal (?:expenses|costs))\b[^.?;]{0,40}\b(?:flows?|comes?|goes?) (?:back|through)\b(?!\s+(?:the|your|my|our|his|her) (?:company|business|books|corporation|accounts?|shop|clinic|payroll|ledger|p&l))/i;
// A hand-off followed by the call anyway ("Your broker will confirm the full
// normalization, but the short answer is…") is still a call.
const HEDGE_THEN_CALL_RE = /\b(?:but|however|though|the short answer|in short|basically|that said)\b/i;

/** True when a clause asserts how something is treated in SDE / EBITDA. */
export function assertsNormalisation(text: string): boolean {
  const t = text.replace(/[’‘]/g, "'");
  const hedged = TREATMENT_HEDGE_RE.test(t) && !HEDGE_THEN_CALL_RE.test(t);
  if (OWNER_COST_CALL_RE.test(t) || NEGATIVE_OR_ITEM_CALL_RE.test(t)) return !hedged;
  if (!NORM_TERM_RE.test(t)) return false;
  return TREATMENT_RE.test(t) && !hedged;
}

/**
 * Any talk of add-backs, SDE or normalization — for the one-line rationale
 * under a question, which has no room for the hedge that would make it safe
 * (live: "Buyers and lenders normalize earnings by adding back owner
 * compensation and perks — the breakdown determines whether the $690K SDE
 * holds up").
 */
export function mentionsNormalisation(text: string): boolean {
  return NORM_TERM_RE.test(text) || OWNER_COST_CALL_RE.test(text) || NEGATIVE_OR_ITEM_CALL_RE.test(text);
}

/** The non-question sentences / clauses of a reply that assert treatment. */
export function findNormalisationAssertions(message: string): string[] {
  const out: string[] = [];
  for (const sp of splitSentences(message)) {
    const s = sp.text.trim();
    const head = s.includes("?") ? leadClauseOfQuestion(s)?.head ?? "" : s;
    if (head && assertsNormalisation(head)) out.push(head);
  }
  return out;
}

/** "<assertion>, <question>?" → the assertion part (null when the sentence is all question). */
function leadClauseOfQuestion(sentence: string): { head: string; rest: string } | null {
  const m = sentence.match(/^([^?]{8,300}?)(\s[—–]\s|:\s+|,\s+(?=(?:how|what|when|who|where|which|why|is|are|was|were|do|does|did|has|have|had|can|could|would|will|should|any)\b))([\s\S]*\?[\s\S]*)$/i);
  return m ? { head: m[1], rest: m[3] } : null;
}

/**
 * Removes treatment calls from a reply: a sentence that asserts treatment
 * goes (a clause of it, when the rest of the sentence stands on its own);
 * a question led by one keeps just its question. When the seller raised
 * add-backs themselves, the hand-off line takes the removed sentence's place.
 */
export function removeNormalisationAssertions(
  message: string,
  sellerMessage?: string | null,
  /** A call made in a sentence an earlier pass already cut (the filler guard): the seller who raised it still gets the hand-off. */
  opts: { callAlreadyCut?: boolean } = {},
): { message: string; removed: string[] } {
  const spans = splitSentences(message.trim());
  const removed: string[] = [];
  let handoffAt = -1;
  const out = spans.map((sp, i) => {
    const s = sp.text;
    const trail = s.match(/\s*$/)?.[0] ?? "";
    const core = s.trim();
    if (core.includes("?")) {
      const lc = leadClauseOfQuestion(core);
      if (lc && assertsNormalisation(lc.head)) {
        removed.push(lc.head.trim());
        if (handoffAt < 0) handoffAt = i;
        const rest = lc.rest.replace(/^(?:but|and|so)\s+/i, "");
        return rest.charAt(0).toUpperCase() + rest.slice(1) + trail;
      }
      return s;
    }
    if (!assertsNormalisation(core)) return s;
    // Keep the part of the sentence that doesn't make the call, when it can
    // stand alone ("Your T2 shows $180K in salary; we'll show it as an
    // add-back." → "Your T2 shows $180K in salary.").
    const parts = core.replace(/[.!]+$/, "").split(/(;\s+|\s[—–]\s|,\s+(?=(?:and|but|so|which)\s))/);
    const kept: string[] = [];
    for (let k = 0; k < parts.length; k += 2) {
      const clause = parts[k];
      if (!clause || assertsNormalisation(clause)) continue;
      if (kept.length === 0) kept.push(clause.replace(/^(?:and|but|so|which)\s+/i, ""));
      else kept.push((parts[k - 1] ?? " ") + clause);
    }
    const rest = kept.join("").trim();
    removed.push(core);
    if (handoffAt < 0) handoffAt = i;
    if (rest.split(/\s+/).length >= 4 && !/^(?:which|that|it|this)\b/i.test(rest) && !NORM_TERM_RE.test(rest)) {
      return rest.charAt(0).toUpperCase() + rest.slice(1) + "." + trail;
    }
    return "";
  });
  if (removed.length === 0 && !opts.callAlreadyCut) return { message, removed };
  if (removed.length === 0) handoffAt = 0;
  const sellerRaised = !!sellerMessage && NORM_TERM_RE.test(sellerMessage.replace(/\badd(?:s|ed|ing)? (?:it |that |them |this |those |all )?back\b/i, "add-back"));
  if (sellerRaised && handoffAt >= 0 && !out.some((x) => /your broker will confirm/i.test(x))) {
    const q = out.findIndex((x) => x.includes("?"));
    const at = q >= 0 ? q : out.length;
    out.splice(at, 0, `${NORMALISATION_HANDOFF}${q >= 0 ? " " : ""}`);
  }
  const text = out.join("").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return { message: text.charAt(0).toUpperCase() + text.slice(1), removed };
}

// ── The same rule for what the turn RECORDS ──

/** Keys whose value IS a normalisation conclusion (SDE, add-backs, recast). */
const NORM_KEY_RE = /add-?backs?|normali[sz]|recast|discretionary|^sde(?:[A-Z]|$|By)|adjusted(?:ebitda|earnings|sde)|^adj(?:usted)?Ebitda/i;
const DISTRIBUTION_RE = /\b(?:dividends?|draws?|distributions?|shareholder (?:loan )?repayments?|owner'?s? draws?)\b/i;
const DISTRIBUTION_NOTE =
  "Dividends and owner draws are distributions, not expenses, so they aren't added back — the normalization against the statements decides.";

export interface GuardableField { value: string; confidence: string; source?: string; basis?: string }

/**
 * Keeps normalisation conclusions out of the facts:
 *  - a treatment clause inside any fact's value ("… All $260K is add-back
 *    for new owner.") is removed from it and handed to the broker as a
 *    private note ("Seller's view on add-backs …"); a value that was
 *    nothing but the call is dropped;
 *  - an SDE / add-back / adjusted-earnings value the interviewer computed or
 *    inferred (basis not "verbatim") is not recorded at all;
 *  - dividends and draws listed as add-backs are taken out of an add-back
 *    value, with a note saying why.
 * Mutates `fields` and `notes`; returns the keys it changed.
 */
export function guardNormalisationFields(
  fields: Record<string, GuardableField>,
  notes: Array<{ note: string; reason: string }>,
): string[] {
  const changed: string[] = [];
  for (const [key, f] of Object.entries(fields)) {
    const value = String(f.value ?? "");
    if (NORM_KEY_RE.test(key)) {
      if (f.basis && f.basis !== "verbatim") {
        delete fields[key];
        changed.push(key);
        continue;
      }
      if (DISTRIBUTION_RE.test(value)) {
        const parts = value.split(/(;\s*|\n+|,\s+(?=[^,]*\$)|\s\+\s)/);
        const keptParts: string[] = [];
        const dropped: string[] = [];
        for (let i = 0; i < parts.length; i += 2) {
          const p = parts[i];
          if (!p || !p.trim()) continue;
          if (DISTRIBUTION_RE.test(p)) dropped.push(p.trim());
          else keptParts.push(p.trim());
        }
        if (dropped.length > 0) {
          notes.push({
            note: `The seller counts ${dropped.join("; ")} as an add-back (not recorded as a fact). ${DISTRIBUTION_NOTE}`,
            reason: "normalization is the broker's call, made against the statements",
          });
          if (keptParts.length === 0) delete fields[key];
          else f.value = keptParts.join("; ");
          changed.push(key);
        }
      }
      continue;
    }
    // Any other fact: the treatment call comes out of the value.
    const isCall = (p: string) => {
      const t = p.replace(/[’‘]/g, "'");
      return (NORM_TERM_RE.test(t) && TREATMENT_RE.test(t)) || OWNER_COST_CALL_RE.test(t) || NEGATIVE_OR_ITEM_CALL_RE.test(t);
    };
    if (!isCall(value)) continue;
    const pieces = value.split(/(?<=[.!;])\s+|\s[—–]\s|\n+|,\s+(?=and\s)/);
    const calls = pieces.filter(isCall);
    if (calls.length === 0) continue;
    const rest = pieces.filter((p) => !calls.includes(p)).join(" ").replace(/\s{2,}/g, " ").trim();
    notes.push({
      note: `Seller's view on add-backs (not recorded as a fact): ${calls.map((c) => c.trim()).join(" ")}${DISTRIBUTION_RE.test(value) ? ` ${DISTRIBUTION_NOTE}` : ""}`,
      reason: "normalization is the broker's call, made against the statements",
    });
    if (rest.replace(/[^A-Za-z0-9]/g, "").length < 8) delete fields[key];
    else f.value = rest;
    changed.push(key);
  }
  return changed;
}

// ═══════════════════════ One question per turn ═══════════════════════

const Q_START = String.raw`(?:are|is|was|were|do|does|did|have|has|had|can|could|would|will|should|what|how|when|where|who|which|why|any)`;
// "…the pre-audit prep, and are there any findings…?" — a second question
// joined onto the first.
const Q_LEAD = String.raw`(?:(?:if so|if not|separately|also|roughly|approximately|briefly|generally|typically|specifically|in (?:general|short)),?\s+)?`;
const COMPOUND_RE = new RegExp(String.raw`,?\s+(?:and|plus|also)\s+${Q_LEAD}(?=${Q_START}\b)|\s[—–]\s(?:and|also)\s+${Q_LEAD}(?=${Q_START}\b)`, "i");
const QUESTION_SHAPED_RE = new RegExp(String.raw`(?:^|[:—–]\s*|,\s*)${Q_START}\b|\b${Q_START}\b[^.?!]*$`, "i");

// "Specifically, …?" — the precise version of the question before it.
const SPECIFIC_LEAD_RE = /^(?:specifically|in particular|more specifically|concretely|put (?:another|differently)|to be (?:more )?specific)[,:]?\s+/i;
// "What about your skilled trades — setup technicians and toolmakers?"
const TOPIC_ONLY_RE = /^(?:and\s+)?(?:what|how) about ([^?]{3,120})\?$/i;
// "On the automotive side, what does…?" — a topic lead-in worth carrying.
const TOPIC_LABEL_RE = /^((?:on|for|regarding|shifting (?:gears )?to|switching to|turning to) [^,:?\u2014\u2013]{3,60}[,:\u2014\u2013]\s*)/i;

const words = (text: string): Set<string> =>
  new Set((text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []).map((w) => w.replace(/'s$|s$/, "")));
const overlap = (a: string, b: string) => {
  const B = words(b);
  return Array.from(words(a)).filter((w) => B.has(w)).length;
};

/**
 * Leaves exactly one question: an "Or …?" follow-on joins the question it
 * offers an alternative to; any further question sentence goes; a second
 * question joined with ", and …" goes. Chips that only fit a dropped
 * question go with it (the caller refills them if too few are left).
 */
export function enforceSingleQuestion(message: string, chips: string[] = []): { message: string; chips: string[]; dropped: string[] } {
  const spans = splitSentences(message.trim()).map((s) => ({ text: s.text }));
  // "Is it X? Or Y?" is one question.
  for (let i = 1; i < spans.length; i++) {
    const cur = spans[i].text.trim();
    if (/^or\b/i.test(cur) && cur.includes("?") && spans[i - 1].text.includes("?")) {
      const prev = spans[i - 1].text.replace(/\?\s*$/, "");
      spans[i - 1] = { text: `${prev}, ${cur.charAt(0).toLowerCase()}${cur.slice(1)}${spans[i].text.match(/\s*$/)?.[0] ?? ""}` };
      spans.splice(i, 1);
      i--;
    }
  }
  const merged = spans.length !== splitSentences(message.trim()).length;
  const qIdx = spans.map((s, i) => (s.text.includes("?") ? i : -1)).filter((i) => i >= 0);
  const dropped: string[] = [];
  if (qIdx.length === 0) return { message, chips, dropped };
  // Which question stays: the first — unless a later one is the specific
  // version of it ("…what does your platform exposure look like?
  // Specifically, how much of your automotive revenue is EV?"), or the first
  // only names a topic ("What about your skilled trades — setup technicians
  // and toolmakers? What does turnover look like there…?"). Then the later
  // one stays, carrying the first one's topic as its lead-in.
  let keep = qIdx[0];
  const later = qIdx.slice(1).find((i) => SPECIFIC_LEAD_RE.test(spans[i].text.trim()));
  const firstText = spans[qIdx[0]].text.trim();
  const topicOnly = firstText.match(TOPIC_ONLY_RE);
  if (later !== undefined || (topicOnly && qIdx.length > 1)) {
    const next = later ?? qIdx[1];
    const label = topicOnly ? `On ${topicOnly[1].trim()}: ` : (firstText.match(TOPIC_LABEL_RE)?.[1] ?? "");
    const body = spans[next].text.trim().replace(SPECIFIC_LEAD_RE, "");
    const trail = spans[next].text.match(/\s*$/)?.[0] ?? "";
    spans[next] = { text: label ? `${label.replace(/[,:\s\u2014\u2013-]+$/, "")}${/:\s*$/.test(label) || topicOnly ? ": " : ", "}${body.charAt(0).toLowerCase()}${body.slice(1)}${trail}` : `${body.charAt(0).toUpperCase()}${body.slice(1)}${trail}` };
    keep = next;
  }
  for (const i of qIdx) {
    if (i === keep) continue;
    dropped.push(spans[i].text.trim());
    spans[i] = { text: "" };
  }
  // A second question inside the kept sentence.
  const q = spans[keep].text;
  const trail = q.match(/\s*$/)?.[0] ?? "";
  const body = q.trim();
  const m = COMPOUND_RE.exec(body);
  if (m && m.index > 0) {
    const first = body.slice(0, m.index).replace(/[,;:\s]+$/, "");
    const second = body.slice(m.index + m[0].length);
    if (QUESTION_SHAPED_RE.test(first) && first.split(/\s+/).length >= 3 && second.includes("?")) {
      dropped.push(second.trim());
      spans[keep] = { text: `${first.replace(/\?+$/, "")}?${trail}` };
    }
  }
  // Only one "?" may remain in the kept sentence ("How many — and how old?").
  if (dropped.length === 0 && !merged) return { message, chips, dropped };
  const text = spans.map((s) => s.text).join("").replace(/[ \t]{2,}/g, " ").trim();
  const kept = spans[keep].text;
  const keptChips = chips.filter((c) => !(dropped.some((d) => overlap(c, d) > 0) && overlap(c, kept) === 0));
  return { message: text, chips: keptChips, dropped };
}

// ═══════════════════════ Options anchored to today ═══════════════════════

const FUTURE_CUE_RE =
  /\b(?:on the schedule|scheduled|planned|planning|plan(?:s)? to|going to|will|expect(?:ed|ing)?|upcoming|coming up|budget(?:ed|ing)? for|slated|target(?:ed|ing)?|next|due|intend(?:ed|ing)?|hoping to|looking to|aim(?:ing)? (?:for|to)|timeline|by when)\b/i;
const PAST_FRAME_RE = /^(?:(?:and|so|but)\s+)?(?:did|was|were|had|when did|what year did|which year did)\b/i;
const YEAR_LIST_RE = /\b(20\d{2})((?:\s*,\s*20\d{2})*)(\s*,?\s+or\s+|\s*[-–]\s*|\s+to\s+)(20\d{2})\b/g;

/**
 * A future-framed question offering a year that has already passed ("Is it
 * on the schedule for 2025 or 2026?" asked in September 2026) is re-anchored
 * to today: the offered years move forward so the first is this year
 * ("…for 2026 or 2027?"). Chips carrying the same years move with them;
 * a chip offering a past year for a future event is dropped.
 */
export function anchorYearOptions(message: string, chips: string[] = [], today: Date = new Date()): { message: string; chips: string[]; shifted: number } {
  const year = today.getUTCFullYear();
  let shift = 0;
  const fixSentence = (sentence: string): string => {
    if (!sentence.includes("?") || !FUTURE_CUE_RE.test(sentence) || PAST_FRAME_RE.test(sentence.trim())) return sentence;
    return sentence.replace(YEAR_LIST_RE, (all, a: string, more: string, sep: string, b: string) => {
      const years = [a, ...(more.match(/20\d{2}/g) ?? []), b].map(Number);
      const min = Math.min(...years);
      if (min >= year) return all;
      const d = year - min;
      shift = Math.max(shift, d);
      return all.replace(/20\d{2}/g, (y) => String(Number(y) + d));
    });
  };
  const spans = splitSentences(message);
  const fixed = spans.map((s) => fixSentence(s.text)).join("");
  const questionFuture = spans.some((s) => s.text.includes("?") && FUTURE_CUE_RE.test(s.text) && !PAST_FRAME_RE.test(s.text.trim()));
  let outChips = chips;
  if (questionFuture) {
    outChips = chips
      .map((c) => (shift > 0 ? c.replace(/\b20\d{2}\b/g, (y) => (Number(y) < year + 3 && Number(y) >= year - shift ? String(Number(y) + shift) : y)) : c))
      .filter((c) => {
        const ys = (c.match(/\b20\d{2}\b/g) ?? []).map(Number);
        // "Planned for 2025" on a future question, after the shift: a past year left over.
        return !(ys.length > 0 && ys.every((y) => y < year) && !/\b(?:done|did|was|were|last|already|in the past|back in|since)\b/i.test(c));
      });
  }
  return { message: shift > 0 ? fixed : message, chips: outChips, shifted: shift };
}

// ═══════════════════════ Local vocabulary ═══════════════════════

export type Jurisdiction = "CA" | "US";

const PROVINCES: Record<string, string> = {
  ontario: "ON", quebec: "QC", "québec": "QC", "british columbia": "BC", alberta: "AB", manitoba: "MB", saskatchewan: "SK",
  "nova scotia": "NS", "new brunswick": "NB", newfoundland: "NL", labrador: "NL", "prince edward island": "PE",
  yukon: "YT", "northwest territories": "NT", nunavut: "NU",
};
const PROVINCE_CODES = new Set(Object.values(PROVINCES));
const STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida", "georgia",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts",
  "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey",
  "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island",
  "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia",
  "wisconsin", "wyoming",
];
const STATE_CODES = new Set(
  "AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC".split(" "),
);
const CANADIAN_CITIES_RE = /\b(?:toronto|montreal|montréal|vancouver|calgary|edmonton|ottawa|winnipeg|halifax|victoria|saskatoon|regina|hamilton|mississauga|brampton|kelowna|kitchener|waterloo|london,? on|gta|lower mainland)\b/i;

/** Canada or the US, from the deal's location (raw string, country, province/state). */
export function jurisdictionOf(...parts: Array<string | null | undefined>): Jurisdiction | null {
  const text = parts.filter(Boolean).join(" | ");
  if (!text.trim()) return null;
  const lower = text.toLowerCase();
  if (/\bcanad(?:a|ian)\b/.test(lower)) return "CA";
  if (/\b(?:united states|usa|u\.s\.a?\.?)\b/.test(lower) || /\bUS\b/.test(text)) return "US";
  if (Object.keys(PROVINCES).some((p) => new RegExp(`\\b${p}\\b`).test(lower))) return "CA";
  const codes = Array.from(text.matchAll(/(?:,\s*|\(|\b)([A-Z]{2})\b(?!\.)/g)).map((m) => m[1]);
  if (codes.some((c) => PROVINCE_CODES.has(c) && !STATE_CODES.has(c))) return "CA";
  if (codes.some((c) => STATE_CODES.has(c) && !PROVINCE_CODES.has(c))) return "US";
  if (CANADIAN_CITIES_RE.test(lower)) return "CA";
  if (STATES.some((s) => new RegExp(`\\b${s}\\b`).test(lower))) return "US";
  return null;
}

/** Which province, for the workers' compensation board's name. */
function provinceOf(text: string): string | null {
  const lower = text.toLowerCase();
  for (const [name, code] of Object.entries(PROVINCES)) if (new RegExp(`\\b${name}\\b`).test(lower)) return code;
  const code = Array.from(text.matchAll(/(?:,\s*|\()([A-Z]{2})\b/g)).map((m) => m[1]).find((c) => PROVINCE_CODES.has(c));
  return code ?? null;
}
const WORKERS_COMP_BOARD: Record<string, string> = { ON: "WSIB", BC: "WorkSafeBC", QC: "CNESST", AB: "WCB", MB: "WCB", SK: "WCB", NS: "WCB", NB: "WorkSafeNB", NL: "WorkplaceNL", PE: "WCB", YT: "WCB", NT: "WSCC", NU: "WSCC" };

type Swap = [RegExp, string | ((m: string, ...g: string[]) => string)];
function swapsFor(j: Jurisdiction, location: string): Swap[] {
  if (j === "CA") {
    const board = WORKERS_COMP_BOARD[provinceOf(location) ?? ""] ?? "WCB";
    return [
      [/\bW-?2s?\b/g, "T4"],
      [/\b1099(?:-NEC)? (contractors?|workers?|staff)\b/gi, (_m, w: string) => `independent ${w}`],
      [/\b1099s?\b/g, "T4A"],
      [/\b401\s?\(?k\)?s?(?: plans?)?/gi, "group RRSP"],
      [/\b(?:an? )?(?:S|C)[- ]?corp(?:oration)?\b/g, (m) => (/^an? /i.test(m) ? "a corporation" : "corporation")],
      [/\b(?:an? )?LLC\b/g, (m) => (/^an? /i.test(m) ? "a corporation" : "corporation")],
      [/\bIRS\b/g, "CRA"],
      [/\bEIN\b/g, "business number"],
      [/\bFICA\b/g, "CPP and EI"],
      [/\bSocial Security\b/g, "CPP"],
      [/\bworkers'? comp(?:ensation)?(?: insurance)?\b/gi, board],
      [/\bzip codes?\b/gi, "postal code"],
      [/\bstate (licen[cs]e|licen[cs]ing|board|regulator|regulations?|law|requirements?|registration|permits?)\b/gi, (_m, w: string) => `provincial ${w}`],
    ];
  }
  return [
    [/\bT4 (employees?|staff|workers?)\b/g, (_m, w: string) => `W-2 ${w}`],
    [/\bT4s?\b/g, "W-2"],
    [/\bT4As?\b/g, "1099"],
    [/\bgroup RRSPs?\b/gi, "401(k)"],
    [/\bRRSPs?\b/g, "401(k)"],
    [/\bCRA\b/g, "IRS"],
    [/\bGST\/HST\b|\bHST\b|\bGST\b|\bPST\b/g, "sales tax"],
    [/\bWSIB\b|\bWorkSafeBC\b|\bCNESST\b|\bWCB\b/g, "workers' comp"],
    [/\bCCPC\b/g, "corporation"],
    [/\bT2 (?:corporate )?(?:tax )?returns?\b/g, "corporate tax return"],
    [/\bT2s?\b/g, "corporate tax return"],
    [/\bCPP\b/g, "Social Security"],
    [/\bpostal codes?\b/gi, "zip code"],
    [/\bprovincial (licen[cs]e|licen[cs]ing|board|regulator|regulations?|law|requirements?|registration|permits?)\b/gi, (_m, w: string) => `state ${w}`],
  ];
}

/** The other country's terms used in a text (for logs and tests). */
export function foreignTerms(text: string, j: Jurisdiction | null, location = ""): string[] {
  if (!j) return [];
  const found: string[] = [];
  for (const [re] of swapsFor(j, location)) {
    re.lastIndex = 0;
    const m = text.match(re);
    if (m) found.push(...m);
  }
  return found;
}

/**
 * Puts a text in the business's own vocabulary. A term the seller used
 * themselves (`sellerText`) is left alone — it's their word.
 */
export function localiseTerms(text: string, j: Jurisdiction | null, location = "", sellerText = ""): string {
  if (!j || !text) return text;
  let out = text;
  for (const [re, to] of swapsFor(j, location)) {
    out = out.replace(re, (...args: any[]) => {
      const m = args[0] as string;
      if (sellerText && new RegExp(`\\b${m.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(sellerText)) return m;
      return typeof to === "string" ? to : to(m, ...(args.slice(1, -2) as string[]));
    });
  }
  return out;
}

/** The prompt line that tells the agent which vocabulary the business uses. */
export function jurisdictionPromptLines(j: Jurisdiction | null, location: string): string[] {
  if (j === "CA") {
    const board = WORKERS_COMP_BOARD[provinceOf(location) ?? ""] ?? "the provincial WCB";
    return [
      `# LOCAL VOCABULARY: this business is in Canada${location ? ` (${location})` : ""}`,
      `Use Canadian terms only: T4 employees vs independent contractors, ${board} for workers' compensation, CRA, the T2 corporate return, GST/HST, group RRSP, provincial licensing. Never US terms (W-2, 1099, 401(k), S-corp, LLC, IRS, workers' comp insurance, state licensing) — to a Canadian owner they read as a form built for someone else.`,
    ];
  }
  if (j === "US") {
    return [
      `# LOCAL VOCABULARY: this business is in the United States${location ? ` (${location})` : ""}`,
      "Use US terms only: W-2 employees vs 1099 contractors, workers' comp, the IRS, sales tax, 401(k), state licensing. Never Canadian terms (T4, T2, CRA, GST/HST, RRSP, WSIB/WCB, provincial licensing).",
    ];
  }
  return [];
}

// ═══════════════════════ Who said it ═══════════════════════

export interface AttributionFact {
  value: string;
  /** Where the fact came from (a FieldSource kind). */
  source?: string;
  /** Who said it on a call ("Rob Kline (plant manager)"), when recorded. */
  speaker?: string;
}
export interface AttributionContext {
  /** Everything the seller has said or written: every session's answers, the questionnaire. */
  sellerText: string;
  /** Facts on the interview's file, with where they came from. */
  facts: AttributionFact[];
}

const YOU_SAID_RE = /\b(as )?you(?:'ve| have)? (mentioned|said|told me|noted|flagged|raised|described|indicated|brought up|shared)( that| earlier| before| on the call| in the call)?(?: that)?\b/gi;
const stems = (text: string): string[] =>
  (text.toLowerCase().match(/[a-z][a-z'-]{3,}|\d[\d,.]*/g) ?? [])
    .map((w) => w.replace(/[,.]+$/, "").replace(/,/g, ""))
    .filter((w) => !/^(?:that|this|with|from|have|there|their|they|them|about|would|could|should|which|what|when|where|your|yours|into|some|also|just|than|then|were|been|being|more|most|very|only|over|such|much|many|didn|doesn|don't|isn't|wasn't)$/.test(w))
    .map((w) => (/^\d/.test(w) ? w : w.slice(0, 5)));

function speakerFirstName(speaker: string): string {
  return speaker.replace(/\(.*$/, "").trim().split(/\s+/)[0] || speaker;
}
const isSellerSpeaker = (speaker?: string) => !!speaker && /\bseller\b/i.test(speaker);

/**
 * "you mentioned X" is kept only when the seller said X (their answers in
 * any session, their questionnaire). Otherwise it names who did: "Rob
 * mentioned X" (a call participant on file as the speaker), "the call
 * notes mention X" (a call, speaker unknown), or "I have a note about X"
 * (anything else — never the source itself, which may be the broker's).
 */
export function fixAttribution(message: string, ctx: AttributionContext): { message: string; fixes: string[] } {
  const said = new Set(stems(ctx.sellerText));
  const factStems = ctx.facts.map((f) => ({ f, s: new Set(stems(f.value)) }));
  const fixes: string[] = [];
  const out = message.replace(YOU_SAID_RE, (whole: string, as: string | undefined, verb: string, tail: string | undefined, offset: number) => {
    const after = message.slice(offset + whole.length).split(/[.?!;—–]/)[0] ?? "";
    const claim = stems(after).slice(0, 14);
    if (claim.length < 2) return whole;
    const heard = claim.filter((w) => said.has(w)).length / claim.length;
    if (heard >= 0.5) return whole;
    // Whose words are they?
    let best: AttributionFact | null = null;
    let bestScore = 0;
    for (const { f, s } of factStems) {
      const score = claim.filter((w) => s.has(w)).length / claim.length;
      if (score > bestScore) { best = f; bestScore = score; }
    }
    const match = bestScore >= 0.4 ? best : null;
    const that = /that/.test(tail ?? "") || /^(?:said|told me)$/i.test(verb) || /^\s*(?:the|your|it|they|there|we|he|she|[A-Z])[^,]*\b(?:is|are|was|were|has|have|had|will|would|runs?|came|comes|went|did)\b/.test(after);
    let replacement: string;
    if (match?.speaker && !isSellerSpeaker(match.speaker)) {
      const name = speakerFirstName(match.speaker);
      replacement = /told me|said/i.test(verb) ? `${name} said${that ? " that" : ""}` : `${name} mentioned${that ? " that" : ""}`;
    } else if (match && (match.source === "call" || match.source === "video_call") && !isSellerSpeaker(match.speaker)) {
      replacement = that ? "the call notes say that" : "the call notes mention";
    } else if (match && match.source === "document") {
      replacement = that ? "the documents say that" : "the documents mention";
    } else {
      replacement = that ? "I have a note that" : "I have a note about";
    }
    if (as) replacement = `as ${replacement.replace(/ (?:that|about)$/, "").replace(/^I have a note$/, "noted")}`;
    const cased = /^[A-Z]/.test(whole) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement;
    fixes.push(`${whole.trim()} → ${cased}`);
    return cased;
  });
  return { message: out, fixes };
}

// ═══════════════════════ Asking what it just said ═══════════════════════

const SELF_STOP = new Set(
  "about above after again against because before being below between could doing during every further having itself other ought their theirs there these those through under until where which while would should thinking looking business buyer buyers seller owner company interview question questions walk share tell happy still usually typically roughly around currently today".split(" "),
);
/** Distinctive words of a text: long words, hyphenated terms, figures. */
function distinctive(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.toLowerCase().match(/\$?\d[\d,.]*(?:%|k|m)?|[a-z][a-z'-]{4,}/g) ?? []) {
    const w = raw.replace(/[,.]+$/, "").replace(/'s$/, "").replace(/(?<=[a-z]{5})s$/, "");
    if (!SELF_STOP.has(w)) out.add(w);
  }
  return out;
}

/**
 * The interviewer asking for something it told the seller itself a turn or
 * two earlier (Clearwater: "The call notes mention … 12-month
 * non-solicitation and 12-month/5 km non-compete clauses in the 2024
 * agreement", then "could you walk me through the key terms? … the
 * non-compete radius and duration, and whether there's a non-solicitation
 * clause"). Returns re-ask candidates for the re-ask guard; the supporting
 * model confirms each before a rewrite is forced.
 */
export function selfStatedFindings(draft: string, ownMessages: string[]): Array<{ kind: "fact"; detail: string; verify: true }> {
  const spans = splitSentences(draft.trim()).map((s) => s.text.trim());
  const qi = spans.findIndex((s) => s.includes("?"));
  if (qi < 0) return [];
  const asked = distinctive(spans.slice(qi).join(" "));
  if (asked.size === 0) return [];
  const out: Array<{ kind: "fact"; detail: string; verify: true }> = [];
  const seen = new Set<string>();
  for (const msg of ownMessages.slice(-4)) {
    for (const sp of splitSentences(msg)) {
      const s = sp.text.trim();
      if (!s || s.includes("?") || s.split(/\s+/).length < 8 || seen.has(s)) continue;
      const shared = Array.from(distinctive(s)).filter((w) => asked.has(w));
      const strong = shared.filter((w) => w.length >= 7 || /[-\d]/.test(w));
      if (shared.length >= 3 && strong.length >= 2) {
        seen.add(s);
        out.push({ kind: "fact", detail: `you told the seller this yourself a few turns ago: «${s.slice(0, 300)}»`, verify: true });
      }
    }
  }
  return out.slice(0, 2);
}
