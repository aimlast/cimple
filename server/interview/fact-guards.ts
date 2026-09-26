/**
 * fact-guards
 *
 * Mechanical backstops for what an interview turn WRITES to the deal's facts
 * (turn-guard.ts polices what the seller READS). Each one exists because the
 * QA harvest (docs/qa/2026-09-26-demo-seeding-qa-harvest.md) caught the model
 * doing it:
 *
 * 1. RETRACTIONS — "Let me take those mold numbers back — I was guessing, and
 *    I don't want a guess ending up in the book." left the guess in
 *    toolingOwnership, bound for the CIM. A withdrawn statement is now removed
 *    (kept in the deleted-facts history), a document value it displaced comes
 *    back, and the model can't quietly record the guess again.
 * 2. DATE FIDELITY — the seller said "Leah just got the raise in October"
 *    (Sep 2026); the fact read "October 2024" as a confirmed fact. A year the
 *    seller never said is resolved from today's date and the tense, or
 *    downgraded — never stored as the seller's confirmed word.
 * 3. LEGAL CLAIMS THE AGENT INTRODUCED — the agent asserted "Ontario requires
 *    that pharmacy owners be licensed pharmacists", the seller agreed and
 *    embellished, and "all shareholders must be pharmacists" became a
 *    confirmed fact. A legal claim the agent's own previous message
 *    introduced is never confirmed by a seller's "yes"; the broker gets a
 *    verify-with-counsel task.
 * 4. SPEAKERS ON CALLS — a fact Luis (operations manager) said on the Teams
 *    call was put to the seller as "you mentioned". Call/video-call facts now
 *    record who said them.
 */
import {
  canonicalFieldName,
  getFieldSources,
  setFieldSource,
  getFieldAlternates,
  getFieldCorroborations,
  displaceCorroborations,
  parseAlternateValue,
  getSuppressedKeys,
  isLiveSellerKind,
  typedNumericValues,
  resolvedYearSources,
  summariseMapSource,
  BROKER_SUPPRESSED_KEY,
  FIELD_ALTERNATES_KEY,
  FIELD_CORROBORATIONS_KEY,
  type FieldAlternate,
  type FieldChange,
  type FieldSource,
} from "./info-merger";
import { HEADLINE_MAPS } from "../documents/merge-policy";

type Info = Record<string, unknown>;

// =====================
// Shared text helpers
// =====================

const STOPWORDS = new Set(
  "about above after again also and any are because been before being below between both but can cannot could did does doing down during each few for from further had has have having here how into its just like more most much must need needs other our ours out over own really same should some such than that the their theirs them then there these they this those through too under until very was were what when where which while who why will with would you your yours business thing things something anything know think said says just every each even still many well right sure actually honestly exactly maybe probably".split(" "),
);
const stems = (text: string): Set<string> =>
  new Set(
    (text.toLowerCase().match(/[a-z][a-z'’-]{3,}/g) ?? [])
      .map((w) => w.replace(/['’]s$/, ""))
      .filter((w) => !STOPWORDS.has(w))
      .map((w) => w.slice(0, 5)),
  );
const overlap = (a: Set<string>, b: Set<string>) => Array.from(a).filter((w) => b.has(w)).length;

// =====================
// 1. Retractions
// =====================

/**
 * The seller withdrawing something they said: "take those numbers back", "I
 * was guessing", "scratch that", "don't put that in", "ignore what I said".
 *
 * Every form is anchored to the SELLER as speaker and to this conversation —
 * first person ("let me take those back", "I was guessing") or an instruction
 * to the interviewer ("scratch that", "don't put that in the book") — so the
 * same verbs describing the business never read as a withdrawal: "we take
 * the old units back and recycle them", "we take it back, no questions
 * asked", "we don't use it in the winter", "customers forget that we do
 * repairs" (review-caught: each one fired the retraction path, which could
 * delete the seller's previous answer).
 */
// An instruction to the interviewer starts its clause: "Scratch that", "…,
// actually don't put that in", "Oh — ignore what I said".
const IMPERATIVE_AT = String.raw`(?<=^|[.!?;:,(—–-]\s{0,3}|\b(?:please|just|actually|oh|so|and|but|ok|okay|no|wait|sorry|hmm|um|also|then|yeah|you can|can you|could you)\s{1,3})`;
const RETRACTION_FORMS = [
  // "Let me take those mold numbers back", "I take that back", "I'd like to take back what I said"
  String.raw`(?:let me|lemme|i(?:'ll| will|'d like to| would like to| want to| wanna| need to| have to| gotta| should| must| better)?|can i|could i) take (?:that|those|it|this|them|(?:that|those|the|my) [\w-]+(?: [\w-]+)?) back(?! (?:to|from|into|in|for|and|at|on|off|when|every|each|as|with|under|through)\b)`,
  String.raw`(?:let me|lemme|i(?:'d like to| would like to| want to| wanna| need to| have to| should)?) take back (?:what i (?:just )?said|that(?: last)?(?: number| figure| part| bit)?|those (?:numbers|figures))`,
  String.raw`i was (?:just |only |really |kind of |sort of |kinda )?guessing(?=\s*(?:[.,;:!?—–)-]|$|\s(?:on|about|there|at|with|when|before|earlier|here|and|so|but|really|honestly|though)\b))`,
  String.raw`(?:that|those|it|this) (?:was|were|is|are) (?:just |only |really |more of |more like )?(?:a |my )?(?:rough |wild |total )?guess(?:es|timates?)?(?=\s*(?:[.,;:!?—–)-]|$|\s(?:on my part|on (?:the|that|those|my)|about (?:the|that|those)|there|really|honestly|so|and|but|though|at best|anyway)\b))`,
  String.raw`${IMPERATIVE_AT}scratch that(?! (?:off|out|from)\b)`,
  String.raw`${IMPERATIVE_AT}ignore (?:what i (?:just )?said|that(?: last)?(?: number| figure| part| bit| answer)?(?=\s*(?:[.,;:!?—–-]|$|\s(?:i|it|the|we)\b))|those (?:numbers|figures))`,
  String.raw`${IMPERATIVE_AT}(?:strike|disregard|forget) (?:that(?: last)?(?: number| figure| part| bit| answer)?(?=\s*(?:[.,;:!?—–-]|$))|those (?:numbers|figures)|what i (?:just )?said)`,
  String.raw`i (?:mis-?spoke|shouldn'?t have said (?:that|it|those))`,
];
export const RETRACTION_RE = new RegExp(`\\b(?:${RETRACTION_FORMS.join("|")})`, "i");

/**
 * The seller withdrawing or correcting something they said (the instant
 * pattern tier; seller-intent.ts classifies the turn properly). A marker
 * alone doesn't say WHICH: "Scratch that — the lease is 12 years, not 10"
 * is a correction (the new value stands), "I was guessing, Rob has the
 * list" a withdrawal — see detectCorrection. A request to keep something
 * out of the book is neither (detectPrivacyRequest).
 */
export function detectRetraction(sellerMessage: string): boolean {
  return RETRACTION_RE.test(sellerMessage.replace(/[’‘]/g, "'"));
}

// A replacement value given with the withdrawal: "it's 12", "closer to 40",
// "14 employees not 12", "it's Rob, not Rick", "make that $2.4M".
const NUMBERISH = String.raw`(?:\$\s?)?(?:\d[\d,.]*|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|a hundred|half)`;
const CORRECTION_FORMS = [
  String.raw`(?:it'?s|it is|it was|they'?re|there(?:'s| is| are| were)|we (?:have|had|do|did|run|ran|made|make|are at|were at)|we'?re at|that'?s|that was|closer to|more like|make (?:that|it)|should (?:be|have been|read)|i meant|actually|really|more accurately|the (?:real|right|correct|actual) (?:number|figure|one|answer) is|revenue was)\s+(?:about |around |roughly |only |just |exactly |more like |actually |really )?${NUMBERISH}`,
  String.raw`\b${NUMBERISH}(?:\s*[a-z%$'/-]+){0,3}\s*,?\s*(?:and )?not\s+${NUMBERISH}`,
  String.raw`\bnot\s+${NUMBERISH}[\w%]*\s*[,;—–-]+\s*(?:it'?s|but|more like|closer to)?\s*${NUMBERISH}`,
  String.raw`(?:it'?s|it was|the \w+ (?:is|was)|they'?re|he'?s|she'?s)\s+[A-Z][\w.&'-]*(?:\s+[A-Z][\w.&'-]*){0,3},?\s+not\s+[A-Z]`,
];
const CORRECTION_RE = new RegExp(`(?:${CORRECTION_FORMS.join("|")})`, "i");
const CORRECTION_MARKER_RE =
  /\b(?:scratch that|i mis-?spoke|ignore what i said|i take (?:that|it) back|take that back|correction|let me correct|i got (?:that|it) wrong|my mistake|i meant|sorry,? (?:i|it'?s|it was|that'?s)|wait|actually|no,? no|not quite|that'?s wrong|that was wrong|i was wrong)\b/i;

/**
 * A correction: the seller replaces a value with a new one in the same
 * message ("Scratch that — the lease is 12 years, not 10", "Sorry, I
 * misspoke, we have 14 employees not 12"). The new value is the fact — it is
 * never withdrawn with the old one (QA harvest: both were deleted).
 */
export function detectCorrection(sellerMessage: string): boolean {
  const text = sellerMessage.replace(/[’‘]/g, "'");
  const xNotY = new RegExp(CORRECTION_FORMS.slice(1).join("|"), "i");
  if (xNotY.test(text)) return true;
  return (CORRECTION_MARKER_RE.test(text) || RETRACTION_RE.test(text)) && CORRECTION_RE.test(text);
}

// "Keep that out of the book", "don't put that in the document", "that's
// between us", "off the record" — privacy, not a withdrawal: the detail goes
// to the broker's private notes; nothing on file is deleted (QA harvest: a
// health disclosure was treated as a retraction and the reason for sale
// withdrawn).
const DOC_NOUN = String.raw`(?:book|cim|c\.i\.m\.?|document|doc|memo|memorandum|write-?up|materials|listing|marketing|report|profile|package|record|file|thing you(?:'re| are) writing|sale document|sales? package)`;
const PRIVACY_FORMS = [
  String.raw`${IMPERATIVE_AT}(?:leave|keep) (?:that|this|those|it|them|the [\w-]+(?: [\w-]+)? (?:part|bit|stuff|piece|detail|details))(?: part| bit)? (?:out|off)(?: of (?:the|your|any|this) ${DOC_NOUN}| of (?:it|there|this))?(?=\s*(?:[.,;:!?—–-]|$|\s(?:please|for now|i|it|if|ok|okay)\b))`,
  String.raw`${IMPERATIVE_AT}(?:please )?(?:don'?t|do not|never) (?:put|write|include|mention|share|use|record|keep|say) (?:that|this|those|it|them|any of (?:that|this)|the [\w-]+(?: [\w-]+)? (?:part|bit|stuff|detail|details|number|figure))(?: \w+){0,3} (?:in|into|on|down|to buyers|with buyers|on file)(?=\s*(?:[.,;:!?—–-]|$|\s(?:the|your|any|my|a|there|please|yet|for|anywhere)\b))`,
  String.raw`(?:that'?s|this is|it'?s|keep (?:it|this|that)) (?:just |strictly |only )?between (?:us|you and me|me and you|you and my broker|me and my broker|ourselves)`,
  String.raw`off the record`,
  String.raw`(?:keep|treat) (?:that|this|it|them|those)(?: part| bit)? (?:private|confidential|to yourself|under wraps|quiet)`,
  String.raw`(?:that'?s|this is|it'?s) (?:private|confidential|personal)(?:,| and| —| so)? (?:please|don'?t|keep|not for)`,
  String.raw`(?:i )?(?:don'?t|do not) want (?:that|this|it|those|them|buyers|anyone|any buyer)(?: \w+){0,4} (?:in (?:the|a|any|your) ${DOC_NOUN}|to (?:know|see|read|hear) (?:that|this|about))`,
  String.raw`(?:just |only )?for (?:my |the )?broker'?s? (?:eyes|ears|information|to know)`,
  String.raw`(?:please )?(?:don'?t|do not) (?:tell|share (?:this|that|it) with|mention (?:this|that|it) to) (?:the )?(?:buyers?|anyone|anybody)`,
];
const PRIVACY_RE = new RegExp(`\\b(?:${PRIVACY_FORMS.join("|")})`, "i");

/** The seller asking that something be kept out of the sale document. */
export function detectPrivacyRequest(sellerMessage: string): boolean {
  return PRIVACY_RE.test(sellerMessage.replace(/[’‘]/g, "'"));
}

export interface Retraction {
  field: string;
  reason: string;
  /**
   * A by-year map fact (revenueByYear): the years withdrawn. Without it,
   * every year the seller stated is withdrawn — never a document's year.
   */
  years?: string[];
}

/** A per-year suppression: that source row's figure for that year stays out ("revenueByYear.2024@<documentId>"). */
export function yearSuppressionKey(mapKey: string, year: string, documentId: string): string {
  return `${mapKey}.${year}@${documentId}`;
}

const isPlainMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * The years of a by-year map a withdrawn claim is about: the years it names
 * ("the 2022 revenue"), else the years whose figure is the claim's ("the
 * $2.1M was a guess"). [] when it can't be placed.
 */
export function claimYearsInMap(claim: string, map: Record<string, unknown>): string[] {
  const keys = Object.keys(map);
  const named = keys.filter((y) => {
    const digits = y.match(/\d{4}/)?.[0];
    return !!digits && new RegExp(String.raw`(?<!\d)(?:fy\s?)?${digits}(?!\d)`, "i").test(claim);
  });
  if (named.length > 0) return named;
  const nums = numbersIn(claim).filter((n) => !(Number.isInteger(n) && n >= 1900 && n <= 2100));
  if (nums.length === 0) return [];
  return keys.filter((y) => {
    const have = numbersIn(typeof map[y] === "string" ? (map[y] as string) : JSON.stringify(map[y] ?? ""));
    return nums.some((c) => have.some((n) => Math.abs(n - c) <= Math.max(1e-9, Math.abs(c) * 0.01)));
  });
}

/**
 * Withdraws years of a by-year map fact (review R2: withdrawing one year's
 * guess deleted the whole map, statement years included). Only a year whose
 * OWN source is the seller's live words goes; a document's year is never
 * touched, and a document figure the guess displaced comes back. A year
 * that came from a call transcript is suppressed for that transcript only,
 * so a reprocess can't bring the guess back while a later statement can
 * still fill the year. Mutates `info`; false when no year was the seller's.
 */
function withdrawMapYears(
  info: Info,
  key: string,
  r: Retraction,
  src: FieldSource,
  result: RetractionResult,
  ctx: { turn: number; at: string },
): boolean {
  const map = { ...(info[key] as Record<string, unknown>) };
  const years = resolvedYearSources(src, map);
  const wanted = r.years?.length ? r.years.filter((y) => y in map) : Object.keys(map);
  const sellerYears = wanted.filter((y) => isLiveSellerKind(years[y]?.source));
  if (sellerYears.length === 0) return false;
  const alts = { ...getFieldAlternates(info) };
  const suppressed = [...getSuppressedKeys(info)];
  const withdrawn: Record<string, unknown> = {};
  let restored = false;
  for (const y of sellerYears) {
    withdrawn[y] = map[y];
    const ys = years[y];
    if (ys.documentId) {
      const k = yearSuppressionKey(key, y, ys.documentId);
      if (!suppressed.includes(k)) suppressed.push(k);
    }
    const altKey = `${key}.${y}`;
    const list = Array.isArray(alts[altKey]) ? [...alts[altKey]] : [];
    const docIdx = list
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.source === "document" && a.value)
      .sort((x, z) => String(z.a.at ?? "").localeCompare(String(x.a.at ?? "")))[0]?.i;
    if (docIdx !== undefined) {
      const { value: altValue, ...altSrc } = list[docIdx] as FieldAlternate;
      list.splice(docIdx, 1);
      if (list.length > 0) alts[altKey] = list;
      else delete alts[altKey];
      map[y] = parseAlternateValue(altValue);
      years[y] = altSrc as FieldSource;
      restored = true;
      continue;
    }
    delete map[y];
    delete years[y];
  }
  info[FIELD_ALTERNATES_KEY] = alts;
  if (suppressed.length > 0) info[BROKER_SUPPRESSED_KEY] = suppressed;
  const deleted = { ...((info[BROKER_DELETED_KEY] as Record<string, unknown> | undefined) ?? {}) };
  const prior = deleted[key] as { value?: unknown } | undefined;
  deleted[key] = {
    value: isPlainMap(prior?.value) ? { ...prior!.value, ...withdrawn } : withdrawn,
    source: src,
    at: ctx.at,
    note: `Withdrawn by the seller in the interview (turn ${ctx.turn}) — ${Object.keys(withdrawn).join(", ")} only${r.reason ? ` — ${r.reason}` : ""}`,
  };
  info[BROKER_DELETED_KEY] = deleted;
  result.withdrawn.push({ key, value: JSON.stringify(withdrawn), turn: ctx.turn });
  const sources = { ...getFieldSources(info) };
  if (Object.keys(map).length === 0) {
    delete info[key];
    delete sources[key];
    result.removed.push(key);
  } else {
    info[key] = map;
    sources[key] = summariseMapSource(years) ?? src;
    for (const y of sellerYears) if (!(y in map)) result.removed.push(`${key}.${y}`);
  }
  info["_fieldSources"] = sources;
  if (restored) result.restoredFromDocument.push(key);
  return true;
}

/** A retraction the session remembers, so a later turn can't record the guess again. */
export interface RetractedValue {
  key: string;
  value: string;
  turn: number;
}

export interface RetractionResult {
  /** Removed outright (nothing else on file for it). */
  removed: string[];
  /** Removed, and a document's value that it had displaced is back. */
  restoredFromDocument: string[];
  /** Asked to retract, but the value on file isn't the seller's own words — left alone. */
  skipped: string[];
  /** What was withdrawn, for the session's memory. */
  withdrawn: RetractedValue[];
}

const BROKER_DELETED_KEY = "_brokerDeleted"; // server/information/facts.ts — same history the Information tab lists

/**
 * Removes the values the seller withdrew. Only a value whose recorded source
 * is the seller's own live words (interview / call / video call) is touched —
 * a document's figure is never deleted because the seller disowned a guess.
 * The withdrawn value goes to the deleted-facts history (restorable, noted as
 * withdrawn by the seller). When a document's value had been displaced by
 * the guess, that value comes back as the fact. A value that came from a call
 * transcript (a source that re-extraction would re-read) is also suppressed
 * so reprocessing can't bring the guess back; an interview answer has no such
 * source, and a later document with the real figure must still be able to
 * fill the gap. Mutates `info`.
 */
export function applySellerRetractions(
  info: Info,
  retractions: Retraction[],
  ctx: { turn: number; at?: string },
): RetractionResult {
  const result: RetractionResult = { removed: [], restoredFromDocument: [], skipped: [], withdrawn: [] };
  const at = ctx.at ?? new Date().toISOString();
  const seen = new Set<string>();
  for (const r of retractions) {
    if (!r?.field) continue;
    const key = canonicalFieldName(r.field, Object.keys(info));
    if (seen.has(key) || key.startsWith("_")) continue;
    seen.add(key);
    const current = info[key];
    if (current === undefined || current === null || current === "") continue;
    const sources = { ...getFieldSources(info) };
    const src = sources[key];
    // A by-year map: year by year, each by its own source.
    if (src && isPlainMap(current)) {
      if (!withdrawMapYears(info, key, r, src, result, { turn: ctx.turn, at })) result.skipped.push(key);
      continue;
    }
    if (!src || !isLiveSellerKind(src.source)) {
      result.skipped.push(key);
      continue;
    }
    const value = typeof current === "string" ? current : JSON.stringify(current);
    result.withdrawn.push({ key, value, turn: ctx.turn });

    const deleted = { ...((info[BROKER_DELETED_KEY] as Record<string, unknown> | undefined) ?? {}) };
    deleted[key] = {
      value: current,
      source: src,
      at,
      note: `Withdrawn by the seller in the interview (turn ${ctx.turn})${r.reason ? ` — ${r.reason}` : ""}`,
    };
    info[BROKER_DELETED_KEY] = deleted;

    // A document's value that the guess displaced comes back.
    const alts = { ...getFieldAlternates(info) };
    const list = Array.isArray(alts[key]) ? [...alts[key]] : [];
    const docIdx = list
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.source === "document" && a.value)
      .sort((x, y) => String(y.a.at ?? "").localeCompare(String(x.a.at ?? "")))[0]?.i;
    if (docIdx !== undefined) {
      const alt = list[docIdx];
      list.splice(docIdx, 1);
      if (list.length > 0) alts[key] = list;
      else delete alts[key];
      info[FIELD_ALTERNATES_KEY] = alts;
      const { value: altValue, ...altSrc } = alt as FieldAlternate;
      info[key] = parseAlternateValue(altValue);
      setFieldSource(info, key, altSrc as FieldSource);
      result.restoredFromDocument.push(key);
      continue;
    }

    // A document that states the very same value (a corroboration — the
    // merge records a same-value source there, not as an alternate) still
    // backs it: the value stays, now on the document's word.
    const corr = { ...getFieldCorroborations(info) };
    const corrList = Array.isArray(corr[key]) ? [...corr[key]] : [];
    const corrIdx = corrList
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.source === "document")
      .sort((x, y) => String(y.a.at ?? "").localeCompare(String(x.a.at ?? "")))[0]?.i;
    if (corrIdx !== undefined) {
      const { value: _same, ...docSrc } = corrList[corrIdx] as FieldAlternate;
      corrList.splice(corrIdx, 1);
      if (corrList.length > 0) corr[key] = corrList;
      else delete corr[key];
      if (Object.keys(corr).length > 0) info[FIELD_CORROBORATIONS_KEY] = corr;
      else delete info[FIELD_CORROBORATIONS_KEY];
      setFieldSource(info, key, docSrc as FieldSource);
      result.restoredFromDocument.push(key);
      continue;
    }
    // Nothing backs it: other same-value sources (a CRM lead, the website)
    // are kept as alternates, not as corroborations of a value that's gone.
    if (corrList.length > 0) displaceCorroborations(info, key, undefined);

    delete info[key];
    delete sources[key];
    info["_fieldSources"] = sources;
    if (src.documentId) {
      const suppressed = getSuppressedKeys(info);
      if (!suppressed.includes(key)) info[BROKER_SUPPRESSED_KEY] = [...suppressed, key];
    }
    result.removed.push(key);
  }
  return result;
}

/**
 * Takes ONE claim out of a fact that also holds true content (Great Lakes:
 * "…Buckeye Freight handles dedicated outbound lanes (~40 trucks/year).
 * Approximately 40 customer trucks per week…" — the seller withdrew only
 * the 40 trucks). `proposed` is the supporting model's rewrite of the value
 * without the claim; it is used only when it is really the same value minus
 * the claim (its words come from the value, none of the claim's figures
 * survive). Otherwise the sentences / clauses that carry the claim — its
 * figures, or failing that its distinctive words — are dropped.
 * Returns the value to keep ("" = nothing true is left: remove the whole
 * fact), or null when the claim can't be found in it.
 */
export function removeClaim(value: string, claim: string, proposed?: string | null, terms: string[] = [], opts: { termsOnly?: boolean } = {}): string | null {
  const v = value.trim();
  if (!v || !claim.trim()) return null;
  const claimNums = numbersIn(claim);
  const claimUnits = new Set(Array.from(stems(claim)).filter((w) => !WITHDRAWAL_VOCAB.has(w) && !CLAIM_FILLER.has(w)));
  const termRes = terms.map(termRegex).filter((re): re is RegExp => !!re);
  const hasClaim = (text: string): boolean => {
    if (termRes.some((re) => re.test(text))) return true;
    // A private detail is found by its own words only — "wants to sell"
    // shared with a reason-for-sale is not the diagnosis (QA round V).
    if (opts.termsOnly) return false;
    const nums = numbersIn(text);
    if (claimNums.length > 0) {
      // The figure, and what it counts: "about 40 trucks" is not the 40 in
      // "each crew works about 40 hours a week" or in "third shift 35-40"
      // (round-2 review: both were cut on a withdrawal of 40 trucks).
      const figure = claimNums.some((c) => nums.some((n) => Math.abs(n - c) <= Math.max(1e-9, Math.abs(c) * 0.01)));
      return figure && (claimUnits.size === 0 || overlap(stems(text), claimUnits) > 0);
    }
    const distinctive = new Set(Array.from(stems(claim)).filter((w) => !WITHDRAWAL_VOCAB.has(w)));
    return distinctive.size > 0 && overlap(stems(text), distinctive) >= Math.min(2, distinctive.size);
  };
  if (!hasClaim(v)) return null;
  const sentencesOf = (t: string) => t.split(/(?<=[.;!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9$%]+/g, " ").trim();
  if (typeof proposed === "string") {
    const p = proposed.trim();
    if (p === "" && sentencesOf(v).every(hasClaim)) return "";
    const own = Array.from(stems(p));
    const fromValue = own.length === 0 ? 1 : own.filter((w) => stems(v).has(w)).length / own.length;
    // Every sentence the rewrite dropped or changed must carry the claim —
    // a rewrite that also loses something true is not used (Clearwater: a
    // private-detail move dropped "wants to sell while the business is
    // growing").
    const kept = norm(p);
    const onlyClaimTouched = sentencesOf(v).every((s) => kept.includes(norm(s)) || hasClaim(s));
    if (p && p !== v && p.length < v.length && fromValue >= 0.85 && !hasClaim(p) && onlyClaimTouched) return p;
  }
  // A claim in brackets goes on its own: "outbound lanes (~40 trucks/year)".
  const unbracketed = v.replace(/\s*\([^()]*\)/g, (m) => (hasClaim(m) ? "" : m)).trim();
  const parts = unbracketed.split(/(?<=[.;!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  if (unbracketed !== v && !hasClaim(unbracketed)) return unbracketed;
  const pieces = parts.length > 1 ? parts : unbracketed.split(/,\s+|\s+[—–]\s+/).map((s) => s.trim()).filter(Boolean);
  const kept = pieces.filter((s) => !hasClaim(s));
  if (kept.length === pieces.length) return null;
  if (kept.length === 0) return "";
  const joined = parts.length > 1 ? kept.join(" ") : kept.join(", ");
  return joined.replace(/[,;\s]+$/, "").replace(/^\s*[,;]\s*/, "");
}

/**
 * A word or phrase that must not appear, as a pattern: whole words, case
 * ignored — except a short acronym ("MS"), which must match its case so
 * "ms" and "terms" don't, and never as part of a product name ("MS
 * Dynamics", "MS Office" — review RV-INT-3).
 */
export function termRegex(term: string): RegExp | null {
  const t = term.trim();
  if (t.length < 2 || (t.length < 3 && !/^[A-Z]{2}$/.test(t))) return null;
  const body = t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return /^[A-Z]{2,4}$/.test(t) ? new RegExp(`\\b${body}\\b(?!\\s+[A-Z][a-z])`) : new RegExp(`\\b${body}`, "i");
}

const numbersIn = (text: string): number[] => {
  const typed = typedNumericValues(text).map((t) => t.value);
  const bare = Array.from(text.matchAll(/\d[\d,]*(?:\.\d+)?/g)).map((m) => parseFloat(m[0].replace(/,/g, "")));
  return [...typed, ...bare].filter((n) => !Number.isNaN(n));
};

/**
 * True when a new value for a withdrawn field is just the withdrawn guess
 * again — its figures are the guess's figures (and the seller didn't say
 * them again this turn), or its wording is mostly the guess's.
 */
export function restatesWithdrawnValue(newValue: string, withdrawn: string, sellerMessage: string): boolean {
  const nums = numbersIn(newValue);
  const old = numbersIn(withdrawn);
  const said = numbersIn(sellerMessage);
  if (nums.length > 0 && old.length > 0) {
    const inOld = nums.every((n) => old.some((o) => Math.abs(n - o) <= Math.max(1e-9, Math.abs(o) * 0.01)));
    const saidAgain = nums.some((n) => said.some((s) => Math.abs(n - s) <= Math.max(1e-9, Math.abs(s) * 0.01)));
    return inOld && !saidAgain;
  }
  const a = stems(newValue);
  if (a.size < 3) return false;
  return overlap(a, stems(withdrawn)) / a.size >= 0.7;
}

/**
 * Fallback when the seller clearly withdrew something but the model named no
 * field: the facts the seller's PREVIOUS turn wrote in this session that the
 * retraction talks about ("those mold numbers" → toolingOwnership). With no
 * shared words, the previous turn's only fact is taken only when the whole
 * message is a short withdrawal ("Scratch that — I was guessing."); in a
 * longer answer the model, which was just told the seller withdrew
 * something and still named nothing, is trusted over the pattern.
 */
export function guessRetractedFields(info: Info, sellerMessage: string, ctx: { sessionId: string; turn: number }): string[] {
  const sources = getFieldSources(info);
  const lastTurn = Object.entries(sources)
    .filter(([k, s]) => !k.startsWith("_") && s?.sessionId === ctx.sessionId && s.turn === ctx.turn - 1 && isLiveSellerKind(s.source))
    .map(([k]) => k);
  if (lastTurn.length === 0) return [];
  // A correction ("I misspoke — it's 9 trucks") or a privacy request isn't a
  // withdrawal of the previous answer (Northbeam: "sorry — I misspoke, it's 9
  // trucks" withdrew the unrelated headcount the previous turn recorded).
  if (detectCorrection(sellerMessage) || detectPrivacyRequest(sellerMessage)) return [];
  // Shared words must be about the fact itself — not the vocabulary of
  // withdrawing ("sorry", "numbers", "guess", "right").
  const said = new Set(Array.from(stems(sellerMessage)).filter((w) => !WITHDRAWAL_VOCAB.has(w)));
  const saidNums = numbersIn(sellerMessage);
  const matching = lastTurn.filter((k) => {
    const v = info[k];
    const text = `${k.replace(/([A-Z])/g, " $1")} ${typeof v === "string" ? v : JSON.stringify(v ?? "")}`;
    const factNums = numbersIn(text);
    if (saidNums.some((n) => factNums.some((f) => Math.abs(n - f) <= Math.max(1e-9, Math.abs(f) * 0.01)))) return true;
    return overlap(new Set(Array.from(stems(text)).filter((w) => !WITHDRAWAL_VOCAB.has(w))), said) > 0;
  });
  if (matching.length > 0) return matching;
  const words = (sellerMessage.trim().match(/\S+/g) ?? []).length;
  return lastTurn.length === 1 && words <= 20 ? lastTurn : [];
}

// Hedges around a figure — not what it counts ("approximately 40 trucks").
const CLAIM_FILLER = new Set(
  "approximately approx around roughly about nearly almost close under over least most plus total thereabouts give take".split(" ").map((w) => w.slice(0, 5)),
);

const WITHDRAWAL_VOCAB = new Set(
  "sorry take back guess guessing guessed guesses scratch ignore misspoke misspeak wrong number numbers figure figures book said told earlier before meant mean real really actual actually right correct honest honestly wait part answer estimate estimates rough ballpark".split(" ").map((w) => w.slice(0, 5)),
);

/** Who the seller says holds the real answer: "Rob keeps the tooling list" → "Rob". */
export function whoHoldsTheAnswer(sellerMessage: string): string {
  const m = sellerMessage.match(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?)\s+(?:keeps|has|holds|tracks|knows|maintains|can send|will send|could send|can pull|would know|manages|owns)\b/);
  if (m && !/^(?:I|We|It|That|This|He|She|They|Let|The)$/.test(m[1])) return m[1];
  const role = sellerMessage.match(/\bmy (accountant|bookkeeper|controller|office manager|lawyer|ops manager|operations manager|plant manager|tool ?room (?:lead|manager))\b/i);
  return role ? `the seller's ${role[1]}` : "";
}

// =====================
// 2. Date fidelity
// =====================

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ALT = String.raw`Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sept?(?:ember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?`;
const monthIndex = (word: string): number => {
  const w = word.toLowerCase().replace(/\.$/, "");
  return MONTHS.findIndex((m) => m.startsWith(w.slice(0, 3)));
};
const MONTH_YEAR_RE = new RegExp(String.raw`\b(${MONTH_ALT})\.?,?\s+(?:of\s+)?((?:19|20)\d{2})\b`, "gi");
// In the seller's words: a month named on its own. "May" needs a date cue
// ("in May", "last May") so the modal verb isn't read as a month.
const SPOKEN_MONTH_RE = new RegExp(
  String.raw`\b(?:(in|since|by|until|til|last|this|next|early|mid|late|end of|around|back in|from|through|come|coming)\s+)?(${MONTH_ALT})\b(?:\.?,?\s+(?:of\s+)?((?:19|20)\d{2}))?`,
  "gi",
);
const YEAR_RE = /\b(19\d{2}|20\d{2})\b/g;

const FUTURE_RE = /\b(?:will|'ll|going to|gonna|plan(?:ning)? to|planned|planning|scheduled|expect(?:ing|ed)? to|next|upcoming|coming up|intend|hope to|aim(?:ing)? to|about to|set to|due (?:in|to))\b|\b(?:are|'re|is|'s|am|'m) \w+ing\b/i;
// Irregular past forms count too — "We sent it to collections in March" is
// past; without "sent" the clause read as tenseless and a "we'll get most of
// it back" in the next clause made it future (Ridgeline: March 2027).
// (Forms that double as present — put, set, cut, let, hit, read — don't.)
const PAST_RE = /\b(?:was|were|did|had|got|went|came|made|last|ago|back in|already|just|used to|happened|sent|took|paid|lost|sold|bought|built|began|left|won|gave|told|said|brought|caught|found|held|kept|knew|led|met|ran|saw|spent|stood|thought|wrote|became|broke|chose|drove|fell|felt|flew|forgot|grew|heard|hired|meant|rode|rose|sank|sat|spoke|stole|struck|taught|threw|wore|bid|hung|dug|fought|sought|shot|shut down|signed|opened|closed|\w+ed)\b/i;
// "was expecting to…", "were planning…" — past, though FUTURE_RE matches the -ing.
const PAST_PROGRESSIVE_RE = /\b(?:was|were) (?:\w+ing|going to|planning|expecting|hoping)\b/i;

export type Tense = "past" | "future" | "unknown";

/**
 * Past or future, from the seller's words around the month. `sentence` is
 * the clause that names the month (see clauseAround) — the verb of THAT
 * clause decides: in "Leah just got the raise in October, so she's
 * staying" the month belongs to "got" (past), not to "she's staying"
 * (review-caught: reading the whole sentence turned a correct October 2025
 * into October 2026). `wider` (the whole sentence) is only consulted when
 * the clause has no verb that decides it.
 */
export function tenseOf(sentence: string, cue?: string, wider?: string): Tense {
  const c = (cue ?? "").toLowerCase();
  if (c === "last" || c === "back in" || c === "since") return "past";
  if (c === "next" || c === "coming" || c === "come" || c === "by" || c === "until" || c === "til") return "future";
  const own = clauseTense(sentence);
  if (own !== "unknown") return own;
  // The rest of the sentence decides only for a bare time phrase ("In March,
  // we're moving the shop") — a clause with its own verb that doesn't say
  // is left unknown (verified, never guessed) rather than borrowing another
  // clause's tense ("We sent it to collections in March, honestly I think
  // we'll get most of it back" is not a future March).
  if (wider && isBareTimePhrase(sentence)) return clauseTense(wider);
  return "unknown";
}

function clauseTense(text: string): Tense {
  if (PAST_PROGRESSIVE_RE.test(text)) return "past";
  if (FUTURE_RE.test(text)) return "future";
  if (PAST_RE.test(text)) return "past";
  return "unknown";
}

const TIME_PHRASE_FILLER = new Set(
  "in on by of the early mid late end beginning start back this last next sometime around about then so and but or come coming until til since from through".split(" "),
);
function isBareTimePhrase(clause: string): boolean {
  const month = new RegExp(String.raw`^(?:${MONTH_ALT})$`, "i");
  const words = (clause.toLowerCase().match(/[a-z]+/g) ?? []).filter((w) => !TIME_PHRASE_FILLER.has(w) && !month.test(w));
  return words.length <= 1;
}

/**
 * The clause of `text` that holds `index`: sentence breaks, commas, dashes,
 * semicolons and the conjunctions that start a new clause ("so", "and",
 * "but", "because", "while", "which"…) bound it.
 */
export function clauseAround(text: string, index: number): string {
  const BOUNDARY = /[.!?;,\n\u2014\u2013]|\s(?:so|and|but|because|while|although|though|whereas|which|then|plus|or)\s/gi;
  let start = 0;
  let end = text.length;
  for (const m of Array.from(text.matchAll(BOUNDARY))) {
    const at = m.index ?? 0;
    if (at + m[0].length <= index) start = at + m[0].length;
    else if (at > index) { end = at; break; }
  }
  return text.slice(start, end);
}

/**
 * The year a bare month refers to, from today: the most recent one for the
 * past, the next one for the future ("in October", said in September 2026:
 * past → 2025; "in May": future → 2027).
 */
export function resolveMonthYear(month: number, tense: Tense, today: Date): number | null {
  const y = today.getFullYear();
  const m = today.getMonth();
  if (tense === "past") return month <= m ? y : y - 1;
  if (tense === "future") return month >= m ? y : y + 1;
  return null;
}

const SEASON_START: Record<string, number> = { spring: 2, summer: 5, fall: 8, autumn: 8, winter: 11 };
const seasonOfMonth = (m: number): string => (m === 11 || m <= 1 ? "winter" : m <= 4 ? "spring" : m <= 7 ? "summer" : "fall");

/**
 * The year a relative season names, from today: in September 2026 "last
 * fall" is fall 2025 (this fall is under way), "last spring" is spring 2026,
 * "next spring" 2027. Winter straddles two years — null (not resolved).
 */
export function resolveSeasonYear(season: string, cue: "last" | "this" | "next", today: Date): number | null {
  const s = season.toLowerCase() === "autumn" ? "fall" : season.toLowerCase();
  if (s === "winter" || SEASON_START[s] === undefined) return null;
  const y = today.getFullYear();
  const m = today.getMonth();
  const start = SEASON_START[s];
  const current = seasonOfMonth(m) === s;
  if (cue === "this") return y;
  if (cue === "last") return current || start > m ? y - 1 : y;
  return start > m ? y : y + 1;
}

export interface RelativeYearPhrase {
  phrase: string;
  year: number;
  /** "year" for this/last/next year; the season's name for a season. */
  unit: string;
}

/**
 * Relative years the seller used, resolved against today: "this year",
 * "last year", "next year", "the current year", "year to date", "last
 * fall", "this past spring", "next summer".
 */
export function relativeYearPhrases(text: string, today: Date): RelativeYearPhrase[] {
  const y = today.getFullYear();
  const t = text.toLowerCase().replace(/[’‘]/g, "'");
  const out: RelativeYearPhrase[] = [];
  const add = (phrase: string, year: number | null, unit: string) => {
    if (year !== null && !out.some((p) => p.phrase === phrase)) out.push({ phrase, year, unit });
  };
  for (const m of Array.from(t.matchAll(/\b(?:(this|the current|current|last|the previous|previous|next|the coming|coming)(?: fiscal)? year|year[- ]to[- ]date|ytd|a year ago)\b/g))) {
    const w = m[1] ?? "";
    const year = /last|previous/.test(w) || /a year ago/.test(m[0]) ? y - 1 : /next|coming/.test(w) ? y + 1 : y;
    add(m[0], year, "year");
  }
  for (const m of Array.from(t.matchAll(/\b(this past|last|this|next|this coming)\s+(spring|summer|fall|autumn|winter)\b/g))) {
    const cue = m[1] === "this past" ? "last" : m[1] === "this coming" ? "next" : (m[1] as "last" | "this" | "next");
    add(m[0], resolveSeasonYear(m[2], cue, today), m[2] === "autumn" ? "fall" : m[2]);
  }
  return out;
}

/** Years a seller's relative wording points at: "last year", "three years ago", "in two years". */
export function relativeYears(text: string, today: Date): number[] {
  const y = today.getFullYear();
  const out: number[] = relativeYearPhrases(text, today).map((p) => p.year);
  const t = text.toLowerCase();
  if (/\blast year\b/.test(t)) out.push(y - 1);
  if (/\bthis year\b/.test(t)) out.push(y);
  if (/\bnext year\b/.test(t)) out.push(y + 1);
  // Winter straddles the new year: "last winter" grounds both.
  if (/\b(?:last|this past) winter\b/.test(t)) out.push(today.getMonth() >= 11 ? y : y - 1, today.getMonth() >= 11 ? y + 1 : y);
  const WORDN: Record<string, number> = { one: 1, a: 1, two: 2, couple: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, fifteen: 15, twenty: 20, thirty: 30 };
  for (const m of Array.from(t.matchAll(/\b(\d{1,2}|a|one|two|couple(?: of)?|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)\s+(?:\w+\s+)?years?\b(\s+ago)?/g))) {
    const raw = m[1].replace(/ of$/, "");
    const n = /^\d/.test(raw) ? parseInt(raw, 10) : WORDN[raw] ?? NaN;
    if (Number.isNaN(n)) continue;
    const before = t.slice(Math.max(0, (m.index ?? 0) - 6), m.index ?? 0);
    if (/\bin\s*$/.test(before)) out.push(y + n);
    out.push(y - n, y - n - 1, y - n + 1);
  }
  return out;
}

export interface DateFlag {
  fieldName: string;
  reason: string;
  /** The value was corrected in place (a resolved year), not just downgraded. */
  corrected?: boolean;
  /** Opens a "verify <field> date" deferral. */
  needsVerification?: boolean;
}

// Fiscal-year wording: "FY2026", "fiscal 2025", "year-end", "the year that
// ended in March", "revenueFY2026".
const FISCAL_YEAR_RE =
  /\bfiscal\b|fy\s?'?\d{2}|\byear[- ]?end(?:ed|ing|s)?\b|\byear (?:that )?(?:ended|ends|ending|closed|closes)\b|\b(?:ended|ending|closed) (?:on |in )?(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov)[a-z]*\b/i;

const sentenceAround = (text: string, index: number): string => {
  const start = Math.max(text.lastIndexOf(".", index), text.lastIndexOf("?", index), text.lastIndexOf("!", index), text.lastIndexOf("\n", index)) + 1;
  const ends = [".", "?", "!", "\n"].map((c) => text.indexOf(c, index)).filter((i) => i >= 0);
  return text.slice(start, ends.length ? Math.min(...ends) : text.length);
};

/**
 * DATE-FIDELITY GUARD. For each seller-statement change, every year in the
 * value must be one the seller (or the record) actually gave:
 *
 * - "Month YYYY" where the seller named only the month: the year is resolved
 *   from today and the tense (past → the most recent such month, future →
 *   the next), written into the value, and the confidence capped at
 *   "inferred". Tense unclear → "approximate" + a verify deferral.
 * - A bare year that appears nowhere — not in the seller's words this
 *   session, the previous question, the relative dates they used, or the
 *   facts on file — is an invention: "approximate" + a verify deferral.
 *
 * Mutates the changes (newValue / newConfidence) and `updatedConfidence`.
 */
export function applyDateFidelityGuard(
  changes: FieldChange[],
  updatedConfidence: Record<string, string>,
  ctx: {
    sellerMessage: string;
    /** Everything the seller said this session (earlier turns included). */
    sessionSellerText?: string;
    /** The agent's previous message (the question being answered). */
    prevAiMessage?: string;
    /** All text on file (facts as the interview sees them). */
    onFileText?: string;
    /** The seller's earlier messages this session, oldest first (for a value written a turn later). */
    sessionSellerMessages?: string[];
    /** Keys already on file — a year-named key is renamed only onto a free key. */
    existingKeys?: Iterable<string>;
    today?: Date;
  },
): DateFlag[] {
  const flags: DateFlag[] = [];
  const today = ctx.today ?? new Date();
  const seller = ctx.sellerMessage ?? "";
  const grounded = new Set<number>([
    ...Array.from(`${seller} ${ctx.sessionSellerText ?? ""} ${ctx.prevAiMessage ?? ""}`.matchAll(YEAR_RE)).map((m) => Number(m[1])),
    ...relativeYears(`${seller} ${ctx.sessionSellerText ?? ""}`, today),
  ]);
  const onFile = new Set<number>(Array.from((ctx.onFileText ?? "").matchAll(YEAR_RE)).map((m) => Number(m[1])));
  // Years the seller has actually said this session (or implied by "last year", "three years ago").
  const sellerYears = new Set<number>([
    ...Array.from(`${seller} ${ctx.sessionSellerText ?? ""}`.matchAll(YEAR_RE)).map((m) => Number(m[1])),
    ...relativeYears(`${seller} ${ctx.sessionSellerText ?? ""}`, today),
  ]);
  const lower = (s: string) => s.toLowerCase();

  for (const change of changes) {
    if (change.source !== "seller_statement") continue;
    if (!/\b(?:19|20)\d{2}\b/.test(change.newValue) && !/(?:19|20)\d{2}$/.test(change.fieldName)) continue;
    const prior = String(change.previousValue ?? "");
    const priorYears = new Set<number>(Array.from(prior.matchAll(YEAR_RE)).map((m) => Number(m[1])));
    let value = change.newValue;
    const reasons: string[] = [];
    let corrected = false;
    let verify = false;
    const handledYearsAt = new Set<number>();

    // Month + year pairs the seller gave only as a month.
    for (const m of Array.from(value.matchAll(MONTH_YEAR_RE))) {
      const month = monthIndex(m[1]);
      const year = Number(m[2]);
      if (month < 0) continue;
      const exact = new RegExp(String.raw`\b${MONTHS[month].slice(0, 3)}\w*\.?,?\s+(?:of\s+)?${year}\b`, "i");
      // Given as a month AND year by the seller, or already in this fact's
      // own value — it's grounded. (Another fact on file isn't enough: the
      // Clearwater "Oct 2024" the model copied came from a mis-extracted
      // document line, and the seller's "last fall … effective October"
      // meant 2025.)
      if ([seller, ctx.sessionSellerText ?? "", prior].some((t) => exact.test(t))) { handledYearsAt.add(m.index ?? -1); continue; }
      // The seller said this year and this month in the same message ("we
      // opened Seton in 2021, in May") — grounded. The year alone in another
      // context ("e-trucks on order for mid-2026") is not.
      const monthInSeller = Array.from(seller.matchAll(SPOKEN_MONTH_RE)).some((x) => monthIndex(x[2]) === month && !(/^may$/i.test(x[2]) && !x[1]));
      if (monthInSeller && new RegExp(String.raw`\b${year}\b`).test(seller)) { handledYearsAt.add(m.index ?? -1); continue; }
      // Did the seller name this month on its own — this turn, or (a value
      // written a turn later from earlier context) in one of their last few
      // messages this session? Ridgeline: "sent it to collections in March"
      // on turn 12 became "March 2025" on turn 13 with no month said.
      const bareMonthIn = (text: string): RegExpExecArray | null => {
        for (const s of Array.from(text.matchAll(SPOKEN_MONTH_RE))) {
          if (monthIndex(s[2]) !== month || s[3]) continue;
          if (/^may$/i.test(s[2]) && !s[1]) continue;
          return s as RegExpExecArray;
        }
        return null;
      };
      let spoken = bareMonthIn(seller);
      let spokenIn = seller;
      let ambiguousEarlier = false;
      if (!spoken) {
        // Only when no document or fact on file gives this month that year —
        // a lease signed "March 2025" on file is grounded, whatever the
        // seller said about another March.
        const pairOnFile = new RegExp(String.raw`\b${MONTHS[month].slice(0, 3)}\w*\.?,?\s+(?:of\s+)?${year}\b`, "i").test(ctx.onFileText ?? "");
        if (!pairOnFile) {
          // Several earlier mentions of this month that point at different
          // years ("sent it to collections in March" / "we expand in
          // March") can't tell which one this is — the first one found is
          // used for the wording, but the year is only verified.
          const hits = (ctx.sessionSellerMessages ?? []).slice(-4).reverse()
            .map((text) => ({ text, hit: bareMonthIn(text) }))
            .filter((x): x is { text: string; hit: RegExpExecArray } => !!x.hit);
          if (hits.length > 0) {
            spoken = hits[0].hit;
            spokenIn = hits[0].text;
            const years = new Set(hits.map((x) => resolveMonthYear(month, tenseOf(clauseAround(x.text, x.hit.index ?? 0), x.hit[1], sentenceAround(x.text, x.hit.index ?? 0)), today)));
            if (years.size > 1) ambiguousEarlier = true;
          }
        }
      }
      if (!spoken) {
        // The model re-dating a month this fact already holds with another
        // year, when the seller gave no new year (seen live: a resolved "May
        // 2027" rewritten back to "May 2026" a turn later) — the date on
        // file stands.
        const onRecord = prior.match(new RegExp(String.raw`\b${MONTHS[month].slice(0, 3)}\w*\.?,?\s+(?:of\s+)?((?:19|20)\d{2})\b`, "i"));
        if (onRecord && Number(onRecord[1]) !== year) {
          handledYearsAt.add(m.index ?? -1);
          value = value.replace(m[0], `${m[1]} ${onRecord[1]}`);
          corrected = true;
          reasons.push(`kept ${m[1]} ${onRecord[1]} already on file — the seller gave no new year (the model wrote ${year})`);
        }
        continue; // otherwise not a month the seller just gave — the bare-year check below decides
      }
      handledYearsAt.add(m.index ?? -1);
      const tense = tenseOf(clauseAround(spokenIn, spoken.index ?? 0), spoken[1], sentenceAround(spokenIn, spoken.index ?? 0));
      // "Last fall, effective October": a relative season the month sits
      // in settles the year when the clause alone doesn't.
      const seasonYear = relativeYearPhrases(spokenIn, today).find((p) => p.unit !== "year" && seasonOfMonth(month) === p.unit)?.year ?? null;
      const resolved = tense === "unknown" && seasonYear !== null ? seasonYear : resolveMonthYear(month, tense, today);
      if (resolved === null || ambiguousEarlier) {
        verify = true;
        reasons.push(`the seller said "${spoken[0].trim()}" without a year; "${m[0]}" can't be confirmed`);
        continue;
      }
      if (resolved !== year) {
        const monthWord = m[1];
        value = value.replace(m[0], `${monthWord} ${resolved}`);
        corrected = true;
        reasons.push(`the seller said "${spoken[0].trim()}" (${tense}); the model wrote ${year}, resolved to ${resolved} from today's date`);
      } else {
        reasons.push(`year ${year} resolved from "${spoken[0].trim()}", not stated by the seller`);
      }
      // Another fact on file dates the same month differently: keep the
      // resolved year, but have it verified.
      const otherYears = Array.from((ctx.onFileText ?? "").matchAll(new RegExp(String.raw`\b${MONTHS[month].slice(0, 3)}\w*\.?,?\s+(?:of\s+)?((?:19|20)\d{2})\b`, "gi")))
        .map((x) => Number(x[1]))
        .filter((y) => y !== resolved);
      if (otherYears.length > 0) {
        verify = true;
        reasons.push(`another fact on file says ${m[1]} ${otherYears[0]}`);
      }
    }

    // Relative years: "this year it's back over eight hundred" became
    // "(current year, 2025)" on 25 Sep 2026 (Clearwater). A year the value
    // labels as this / last / next year, or pins to a season the seller
    // named relatively ("last fall" → "fall 2024"), is resolved from today.
    const said = relativeYearPhrases(`${seller}`, today);
    // (Calendar years only — a "current fiscal year" may carry another
    // year's label, so fiscal wording is left alone.)
    const labelled: Array<{ re: RegExp; year: number; what: string }> = [
      { re: /\b(?:the )?(?:current|this) year\W{0,4}((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\W{0,4}(?:the )?(?:current|this) year\b/gi, year: today.getFullYear(), what: "this year" },
      { re: /\b(?:last|previous|prior) year\W{0,4}((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\W{0,4}(?:last|previous|prior) year\b/gi, year: today.getFullYear() - 1, what: "last year" },
      { re: /\bnext year\W{0,4}((?:19|20)\d{2})\b|\b((?:19|20)\d{2})\W{0,4}next year\b/gi, year: today.getFullYear() + 1, what: "next year" },
    ];
    // "(2025 year-to-date)" — year-to-date is this year only when the seller
    // spoke of this year (a fiscal year can run on).
    if (said.some((p) => p.unit === "year" && p.year === today.getFullYear())) {
      labelled.push({
        re: /\b((?:19|20)\d{2})\W{0,4}(?:year[- ]to[- ]date|ytd)\b|\b(?:year[- ]to[- ]date|ytd)\W{0,4}((?:19|20)\d{2})\b/gi,
        year: today.getFullYear(),
        what: "this year",
      });
    }
    let yearFixedFrom: number | null = null;
    let yearFixedTo: number | null = null;
    const fixedYears = new Set<number>();
    for (const l of labelled) {
      value = value.replace(l.re, (whole: string, a?: string, b?: string) => {
        const y = Number(a ?? b);
        if (!y || y === l.year || (sellerYears.has(y) && new RegExp(`\\b${y}\\b`).test(seller))) return whole;
        corrected = true;
        fixedYears.add(y);
        yearFixedFrom = y;
        yearFixedTo = l.year;
        reasons.push(`the seller said "${l.what}" — that's ${l.year}, the model wrote ${y}`);
        return whole.replace(String(y), String(l.year));
      });
    }
    for (const p of said.filter((x) => x.unit !== "year")) {
      const re = new RegExp(String.raw`\b(${p.unit === "fall" ? "fall|autumn" : p.unit})\s+(?:of\s+)?((?:19|20)\d{2})\b`, "gi");
      value = value.replace(re, (whole: string, word: string, yy: string) => {
        const y = Number(yy);
        if (y === p.year || new RegExp(`\\b${word}\\s+(?:of\\s+)?${y}\\b`, "i").test(seller)) return whole;
        corrected = true;
        fixedYears.add(y);
        reasons.push(`the seller said "${p.phrase}" — that's ${word} ${p.year}, the model wrote ${y}`);
        return `${word} ${p.year}`;
      });
    }
    // A value dating something to one year when the seller only said "this
    // year" / "last year" (and no year of their own): off by one from what
    // they meant is the classic slip — verified, not silently kept.
    // (A year the question itself named is the seller answering about that
    // year — "your 2024 owner compensation?" → "…on last year's return".)
    // The year counts as named in "FY2026", "fiscal 2026" or "FY26" too —
    // there's no word boundary before the digits (round-2 review: "FY2026
    // sales — the year that ended in March?" had its key renamed to 2025).
    // And on a fiscal year, "last year" / "this year" is a fiscal year whose
    // label can't be read off the calendar (a March year-end's "last year"
    // on 26 Sep 2026 is FY2026) — those checks stand down.
    const namesYear = (y: number, t: string) =>
      new RegExp(`(?<!\\d)${y}(?!\\d)|\\b(?:fy|fiscal(?: year)?)\\s?'?${String(y).slice(2)}(?!\\d)`, "i").test(t);
    const fiscalContext = [seller, ctx.prevAiMessage ?? "", value, change.fieldName].some((t) => FISCAL_YEAR_RE.test(t));
    if (!corrected && !fiscalContext && said.some((p) => p.unit === "year")) {
      const ys = Array.from(new Set(Array.from(value.matchAll(YEAR_RE)).map((m) => Number(m[1]))));
      const meant = said.filter((p) => p.unit === "year").map((p) => p.year);
      const asked = namesYear(ys[0], ctx.prevAiMessage ?? "");
      const saidIt = namesYear(ys[0], seller);
      if (ys.length === 1 && !asked && !saidIt && !meant.includes(ys[0]) && meant.some((r) => Math.abs(r - ys[0]) === 1) && !priorYears.has(ys[0])) {
        verify = true;
        reasons.push(`the seller said "${said.find((p) => p.unit === "year")!.phrase}" (${meant.join("/")}); the value says ${ys[0]}`);
      }
    }
    // A key named for a year the seller only said as "this year" / "last
    // year" — off by one, the classic slip ("setonRevenue2025" for "this
    // year it's back over eight hundred", 25 Sep 2026).
    const keyYear = Number(change.fieldName.match(/((?:19|20)\d{2})$/)?.[1] ?? NaN);
    const meantYears = said.filter((p) => p.unit === "year");
    if (
      yearFixedFrom === null &&
      !Number.isNaN(keyYear) &&
      !fiscalContext &&
      meantYears.length === 1 &&
      Math.abs(keyYear - meantYears[0].year) === 1 &&
      ![seller, ctx.prevAiMessage ?? "", value].some((t) => namesYear(keyYear, t))
    ) {
      yearFixedFrom = keyYear;
      yearFixedTo = meantYears[0].year;
      corrected = true;
      reasons.push(`the seller said "${meantYears[0].phrase}" — that's ${meantYears[0].year}, the key says ${keyYear}`);
    }
    // A key named for the wrong year follows the fix ("setonRevenue2025" →
    // "setonRevenue2026"), when that key is free.
    if (yearFixedFrom !== null && yearFixedTo !== null && new RegExp(`${yearFixedFrom}$`).test(change.fieldName)) {
      const renamed = change.fieldName.replace(new RegExp(`${yearFixedFrom}$`), String(yearFixedTo));
      const taken = new Set(Array.from(ctx.existingKeys ?? []));
      if (!taken.has(renamed) && !changes.some((c) => c !== change && c.fieldName === renamed)) {
        if (updatedConfidence[change.fieldName] !== undefined) {
          updatedConfidence[renamed] = updatedConfidence[change.fieldName];
          delete updatedConfidence[change.fieldName];
        }
        reasons.push(`key renamed ${change.fieldName} → ${renamed}`);
        change.fieldName = renamed;
      }
    }

    // Bare years nobody gave.
    const invented: number[] = [];
    for (const m of Array.from(change.newValue.matchAll(YEAR_RE))) {
      const y = Number(m[1]);
      if (fixedYears.has(y)) continue;
      const pairAt = Array.from(change.newValue.matchAll(MONTH_YEAR_RE)).find((p) => (p.index ?? 0) <= (m.index ?? 0) && (p.index ?? 0) + p[0].length >= (m.index ?? 0) + 4);
      if (pairAt && handledYearsAt.has(pairAt.index ?? -1)) continue;
      if (grounded.has(y) || priorYears.has(y) || onFile.has(y)) continue;
      invented.push(y);
    }
    if (invented.length > 0) {
      verify = true;
      reasons.push(`year(s) ${Array.from(new Set(invented)).join(", ")} appear nowhere in what the seller said or what's on file`);
    }

    // A date the record holds only as inferred/approximate can't become
    // "confirmed" because the model rewrote the whole field — the seller
    // hasn't said that year (seen live: a resolved "March 2026" re-stated as
    // confirmed two turns later).
    const prevConf = String(change.previousConfidence ?? "");
    if (
      reasons.length === 0 &&
      change.newConfidence === "confirmed" &&
      (prevConf === "inferred" || prevConf === "approximate") &&
      Array.from(change.newValue.matchAll(YEAR_RE)).some((m) => priorYears.has(Number(m[1])) && !sellerYears.has(Number(m[1])))
    ) {
      change.newConfidence = prevConf;
      updatedConfidence[change.fieldName] = prevConf;
      flags.push({ fieldName: change.fieldName, reason: `keeps the ${prevConf} date on file — the seller didn't state the year` });
      continue;
    }
    if (reasons.length === 0) continue;
    if (value !== change.newValue) change.newValue = value;
    const conf = lower(change.newConfidence);
    const capped = verify ? "approximate" : conf === "confirmed" ? "inferred" : change.newConfidence;
    change.newConfidence = capped;
    updatedConfidence[change.fieldName] = capped;
    flags.push({ fieldName: change.fieldName, reason: reasons.join("; "), corrected, needsVerification: verify });
  }
  return flags;
}

// =====================
// 3. Legal claims the agent introduced
// =====================

const LEGAL_NOUN_RE =
  /\b(?:act|law|laws|legislation|statute|regulations?|regulatory|regulator|college|licen[cs](?:e[ds]?|ing|ee)|permit|bylaws?|by-laws?|assignment clause|consent clause|change[- ]of[- ]control|shareholders?|ownership|owners?|registrar|ministry|provincial|federal|council|board|health canada|fda|tssa|cra|irs)\b/i;
const LEGAL_ASSERTION_RE =
  /\b(?:requires?|required|must|mandates?|mandatory|prohibits?|prohibited|forbids?|forbidden|restricts?|restricted to|is illegal|(?:is|are)n'?t (?:allowed|permitted)|not (?:allowed|permitted)|(?:can|may) only|cannot|can'?t|by law|legally|under the (?:[\w-]+ ){0,4}(?:act|law|regulations?|rules?)|the law (?:says|requires)|avoid triggering|(?:does|do|will|would)(?:n'?t| not) trigger|triggers?)\b|\bonly (?:a |an |the )?[\w\s-]{1,50}?\b(?:can|may|is allowed to|are allowed to|is permitted to|are permitted to|is eligible to|are eligible to)\b/i;
const HEDGE_RE =
  /\b(?:typically|usually|commonly|generally|often|normally|in most (?:cases|deals|provinces|states|places)|in many|may|might|can vary|varies|vary|i (?:believe|understand|think)|my understanding|as i understand|if i understand|your (?:lawyer|broker|accountant|counsel)|a lawyer|legal counsel|to (?:check|confirm|verify)|i'?m not (?:certain|sure)|not certain|depends|worth confirming|you (?:mentioned|said|noted)|your (?:documents?|lease|contract|agreement|msa|policy) (?:says?|shows?|states?|has)|the (?:lease|contract|msa|agreement|policy) (?:says|states|has))\b/i;
const PREMISE_RE = /^(?:since|because|given (?:that)?|as|now that|with)\b/i;

/**
 * Sentences in an outgoing message that state a legal or regulatory
 * requirement as fact ("Ontario requires that pharmacy owners be licensed
 * pharmacists.") — declaratives, or a question built on one as its premise
 * ("Since the Act requires…, would you…?"). Hedged wording, the seller's own
 * words ("you mentioned…") and a document's terms ("your lease says…") pass.
 */
export function findLegalAssertions(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  return sentences.filter((s) => {
    const isQuestion = s.endsWith("?");
    if (isQuestion && !PREMISE_RE.test(s)) return false;
    const clause = isQuestion ? s.split(/[,—–]/)[0] : s;
    return LEGAL_ASSERTION_RE.test(clause) && LEGAL_NOUN_RE.test(clause) && !HEDGE_RE.test(clause);
  });
}

export interface LegalGroundingFlag {
  fieldName: string;
  reason: string;
  /** The agent's sentence that introduced the claim. */
  introducedBy: string;
}

const GENERIC_STEMS = new Set(["buyer", "sale", "sell", "selli", "busin", "compa", "owner", "requi", "must", "shoul"]);

/**
 * A "confirmed" seller-statement value that states a legal requirement whose
 * subject the agent's own previous message asserted as law is capped at
 * "inferred" — the seller's "yes" to the agent's claim is not a verified
 * fact. The caller creates a verify-with-counsel task for the broker.
 */
export function applyLegalGroundingGuard(
  changes: FieldChange[],
  updatedConfidence: Record<string, string>,
  prevAiMessage: string | undefined,
): LegalGroundingFlag[] {
  if (!prevAiMessage) return [];
  const claims = findLegalAssertions(prevAiMessage);
  if (claims.length === 0) return [];
  const flags: LegalGroundingFlag[] = [];
  for (const change of changes) {
    if (change.source !== "seller_statement") continue;
    if (change.newConfidence !== "confirmed" && change.newConfidence !== "inferred") continue;
    if (!(LEGAL_ASSERTION_RE.test(change.newValue) || /\b(?:only|all)\b[^.]{0,40}\b(?:can|may|must|have to)\b/i.test(change.newValue))) continue;
    const valueStems = new Set(Array.from(stems(change.newValue)).filter((s) => !GENERIC_STEMS.has(s)));
    const source = claims.find((c) => overlap(valueStems, stems(c)) >= 1);
    if (!source) continue;
    if (change.newConfidence === "confirmed") {
      change.newConfidence = "inferred";
      updatedConfidence[change.fieldName] = "inferred";
    }
    flags.push({
      fieldName: change.fieldName,
      introducedBy: source,
      reason: `the interviewer introduced this legal point ("${source.slice(0, 140)}") and the seller agreed — not a verified fact`,
    });
  }
  return flags;
}

// =====================
// 4. Speakers on calls
// =====================

/**
 * Records who said each fact a call or video-call transcript contributed.
 * `speakers` is the extraction's field → "Name (role)" map; only fields this
 * document is the recorded source of are stamped. Mutates `info`.
 */
export function recordFactSpeakers(info: Info, speakers: unknown, documentId: string): number {
  if (!speakers || typeof speakers !== "object" || Array.isArray(speakers)) return 0;
  const sources = { ...getFieldSources(info) };
  let n = 0;
  for (const [rawKey, who] of Object.entries(speakers as Record<string, unknown>)) {
    if (typeof who !== "string" || !who.trim()) continue;
    const key = canonicalFieldName(rawKey, Object.keys(info));
    const src = sources[key];
    if (!src || src.documentId !== documentId || (src.source !== "call" && src.source !== "video_call")) continue;
    sources[key] = { ...src, speaker: who.trim().slice(0, 120) };
    n++;
  }
  if (n > 0) info["_fieldSources"] = sources;
  return n;
}

/**
 * Who a recorded speaker is, relative to the seller: "seller" (only the
 * seller), "joint" (the seller and someone else — "Luis Ortega (operations
 * manager) and Gord McAllister (seller)"), or "other" (a manager, a
 * minority partner, the accountant…). The extractor marks the seller
 * "(seller)"; a "15% owner" who isn't selling is someone else.
 */
export function speakerRole(speaker: string | undefined): "seller" | "joint" | "other" | "unknown" {
  if (!speaker) return "unknown";
  if (!/\bseller\b/i.test(speaker)) return "other";
  const people = speaker.split(/\s+(?:and|&)\s+|,\s*(?=[A-Z])/).filter((p) => /[A-Z][a-z]+/.test(p));
  return people.some((p) => !/\bseller\b/i.test(p) && /^[A-Z][a-z]+\s+[A-Z]/.test(p.trim())) ? "joint" : "seller";
}

/** "Luis Ortega (operations manager)" → "Luis". */
export function speakerFirstName(speaker: string): string {
  return speaker.replace(/\(.*$/, "").trim().split(/\s+/)[0] || speaker;
}

// =====================
// Withdrawn values vs open discrepancies
// =====================

/** The fields of a discrepancy row this check reads (shared/schema Discrepancy). */
export interface DiscrepancyLike {
  id: string;
  status: string;
  factKey?: string | null;
  factYear?: string | null;
  interviewValue?: string | null;
  sideSources?: unknown;
}

const LIVE_SELLER_SIDE = new Set(["interview", "call", "video_call"]);
const UNSETTLED = new Set(["open", "seller_responded", "ask_seller"]);

/** The headline and its by-year map are one fact (annualRevenue ≡ revenueByYear). */
const factFamily = (key: string): string => HEADLINE_MAPS.find((p) => p.head === key)?.map ?? key;

/**
 * Open discrepancies whose seller side is a value the seller just withdrew
 * (applySellerRetractions → RetractedValue): the conflict no longer stands —
 * the seller disowned their side — and leaving it open would block CIM
 * generation and let "accept the interview value" write the withdrawn guess
 * back. Matched on the same fact (headline ≡ its by-year map; the year's
 * entry for a per-year row) and the same figures / wording, and only when
 * the row's seller side was live speech (interview / call / video call —
 * the only sources a retraction removes). Settled rows are the broker's
 * decision and are never returned. Returns row ids.
 */
export function discrepanciesSettledByRetraction(rows: DiscrepancyLike[], withdrawn: RetractedValue[]): string[] {
  const ids: string[] = [];
  for (const row of rows) {
    if (!UNSETTLED.has(row.status) || !row.factKey || !row.interviewValue) continue;
    const side = (row.sideSources as { interview?: { kind?: string } } | null | undefined)?.interview;
    if (side?.kind && !LIVE_SELLER_SIDE.has(side.kind)) continue;
    const hit = withdrawn.some((w) => {
      if (factFamily(canonicalFieldName(w.key)) !== factFamily(canonicalFieldName(row.factKey!))) return false;
      let value = w.value;
      if (row.factYear) {
        try {
          const map = JSON.parse(w.value);
          if (map && typeof map === "object" && !Array.isArray(map)) {
            const entry = (map as Record<string, unknown>)[row.factYear];
            if (entry === undefined || entry === null) return false;
            value = String(entry);
          }
        } catch { /* a scalar headline: compared as it is */ }
      }
      const a = row.interviewValue!.trim().toLowerCase().replace(/\s+/g, " ");
      if (a === value.trim().toLowerCase().replace(/\s+/g, " ")) return true;
      const nums = numbersIn(row.interviewValue!);
      const old = numbersIn(value);
      if (nums.length > 0 && old.length > 0) {
        return nums.every((n) => old.some((o) => Math.abs(n - o) <= Math.max(1e-9, Math.abs(o) * 0.01)));
      }
      const s = stems(row.interviewValue!);
      return s.size >= 2 && overlap(s, stems(value)) / s.size >= 0.7;
    });
    if (hit) ids.push(row.id);
  }
  return ids;
}
