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
  parseAlternateValue,
  getSuppressedKeys,
  isLiveSellerKind,
  typedNumericValues,
  BROKER_SUPPRESSED_KEY,
  FIELD_ALTERNATES_KEY,
  type FieldAlternate,
  type FieldChange,
  type FieldSource,
} from "./info-merger";

type Info = Record<string, unknown>;

// =====================
// Shared text helpers
// =====================

const STOPWORDS = new Set(
  "about above after again also and any are because been before being below between both but can cannot could did does doing down during each few for from further had has have having here how into its just like more most much must need needs other our ours out over own really same should some such than that the their theirs them then there these they this those through too under until very was were what when where which while who why will with would you your yours business thing things something anything know think said says just".split(" "),
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
 */
export const RETRACTION_RE =
  /\b(?:take (?:that|those|it|this|them|back what i said|(?:that|those|the|my) [\w-]+(?: [\w-]+)?) back|i was (?:just |only |kind of |sort of )?guessing|(?:that|those|it) (?:was|were) (?:just )?(?:a )?guess(?:es)?|scratch that|ignore (?:what i (?:just )?said|that(?: last)?(?: number| figure| part| bit)?|those (?:numbers|figures))|don'?t (?:put|write|include|use|record) (?:that|those|it|this|them)(?: \w+){0,3} (?:in|down)|(?:strike|disregard|forget) (?:that|those|what i said)|i (?:mis-?spoke|shouldn'?t have said)|leave (?:that|those|it|them) out(?: of the (?:book|cim|document))?)\b/i;

export function detectRetraction(sellerMessage: string): boolean {
  return RETRACTION_RE.test(sellerMessage.replace(/[’‘]/g, "'"));
}

export interface Retraction {
  field: string;
  reason: string;
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
 * retraction talks about ("those mold numbers" → toolingOwnership). Exactly
 * one candidate from the previous turn is taken even without shared words.
 */
export function guessRetractedFields(info: Info, sellerMessage: string, ctx: { sessionId: string; turn: number }): string[] {
  const sources = getFieldSources(info);
  const lastTurn = Object.entries(sources)
    .filter(([k, s]) => !k.startsWith("_") && s?.sessionId === ctx.sessionId && s.turn === ctx.turn - 1 && isLiveSellerKind(s.source))
    .map(([k]) => k);
  if (lastTurn.length === 0) return [];
  const said = stems(sellerMessage);
  const matching = lastTurn.filter((k) => {
    const v = info[k];
    const text = `${k.replace(/([A-Z])/g, " $1")} ${typeof v === "string" ? v : JSON.stringify(v ?? "")}`;
    return overlap(stems(text), said) > 0;
  });
  if (matching.length > 0) return matching;
  return lastTurn.length === 1 ? lastTurn : [];
}

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
const PAST_RE = /\b(?:was|were|did|had|got|went|came|made|last|ago|back in|already|just|used to|happened|\w+ed)\b/i;

export type Tense = "past" | "future" | "unknown";

/** Past or future, from the seller's sentence that names the month. */
export function tenseOf(sentence: string, cue?: string): Tense {
  const c = (cue ?? "").toLowerCase();
  if (c === "last" || c === "back in" || c === "since") return "past";
  if (c === "next" || c === "coming" || c === "come" || c === "by" || c === "until" || c === "til") return "future";
  if (FUTURE_RE.test(sentence)) return "future";
  if (PAST_RE.test(sentence)) return "past";
  return "unknown";
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

/** Years a seller's relative wording points at: "last year", "three years ago", "in two years". */
export function relativeYears(text: string, today: Date): number[] {
  const y = today.getFullYear();
  const out: number[] = [];
  const t = text.toLowerCase();
  if (/\blast year\b/.test(t)) out.push(y - 1);
  if (/\bthis year\b/.test(t)) out.push(y);
  if (/\bnext year\b/.test(t)) out.push(y + 1);
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
    if (!/\b(?:19|20)\d{2}\b/.test(change.newValue)) continue;
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
      // Did the seller name this month on its own?
      let spoken: RegExpExecArray | null = null;
      for (const s of Array.from(seller.matchAll(SPOKEN_MONTH_RE))) {
        if (monthIndex(s[2]) !== month || s[3]) continue;
        if (/^may$/i.test(s[2]) && !s[1]) continue;
        spoken = s as RegExpExecArray;
        break;
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
      const tense = tenseOf(sentenceAround(seller, spoken.index ?? 0), spoken[1]);
      const resolved = resolveMonthYear(month, tense, today);
      if (resolved === null) {
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

    // Bare years nobody gave.
    const invented: number[] = [];
    for (const m of Array.from(change.newValue.matchAll(YEAR_RE))) {
      const y = Number(m[1]);
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
