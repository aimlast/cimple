/**
 * fact-dates — a year the seller never said doesn't reach the CIM.
 *
 * The interview's extractor turned "we're promoting him to Assistant Shop
 * Foreman in May" (said in January 2026) into "promoted … in May 2025": a
 * year the seller never said, in the wrong tense, which the CIM then copied
 * (Pacific, 2026-09-26). Interview facts keep the session and seller turn
 * they came from, so before the CIM writer sees such a fact, each
 * "Month YYYY" in it is checked against the seller's own words on that turn.
 * When the seller named the month but not that year, the year is taken out
 * (never guessed — working it out from the date said fails as soon as a
 * sentence mixes past and future), the writer gets the seller's sentence to
 * keep the tense ("is being promoted in May"), and the broker is told to
 * correct the fact.
 *
 * Pure: no database, no AI.
 */

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_ALT = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";
/** "May 2025", "Sept. 2024", "March 3, 2026". */
const MONTH_YEAR = new RegExp(String.raw`\b(${MONTH_ALT})\.?(\s+\d{1,2}(?:st|nd|rd|th)?)?,?\s+((?:19|20)\d{2})\b`, "gi");

function monthIndex(token: string): number {
  const t = token.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(t));
}

/** The seller's sentence that names the month with no year after it, if any. */
function sentenceWithMonth(words: string, month: number): string | null {
  const name = MONTHS[month];
  const re = new RegExp(String.raw`\b(?:${name}|${name.slice(0, 3)}\.?)(?![a-z])(?!,?\s*\d)`, "i");
  // "May" is also a verb ("it may take"): only "in/by/since/early … May" counts.
  if (month === 4 && !/\b(in|by|from|until|till|since|early|late|mid|end of|before|after|this|next|last|back in)\s+may\b/i.test(words)) return null;
  const sentences = words.split(/(?<=[.?!])\s+|\n+/);
  return sentences.find((s) => re.test(s)) ?? null;
}

export interface YearRepair {
  /** The fact text with the unsaid year(s) taken out. */
  text: string;
  /** What was changed, for the broker ("May 2025 → May"). */
  changes: string[];
  /** The seller's own sentence(s), for the writer (tense). */
  quotes: string[];
}

/**
 * Check each "Month YYYY" in an interview-recorded fact against the words
 * the seller said on that turn. Returns null when nothing needs changing
 * (the seller said that year, or didn't name the month on that turn).
 */
export function repairInferredYears(valueText: string, sellerWords: string): YearRepair | null {
  if (!valueText || !sellerWords) return null;
  const changes: string[] = [];
  const quotes: string[] = [];
  const text = valueText.replace(MONTH_YEAR, (whole, monthTok: string, day: string | undefined, yearTok: string) => {
    const m = monthIndex(monthTok);
    if (m < 0) return whole;
    // The seller said that year on that turn: the fact's year is theirs.
    if (sellerWords.includes(yearTok)) return whole;
    const sentence = sentenceWithMonth(sellerWords, m);
    if (!sentence) return whole;
    const kept = `${monthTok}${day ?? ""}`;
    changes.push(`${whole.trim()} → ${kept}`);
    const q = sentence.trim().replace(/\s+/g, " ");
    const short = q.length > 220 ? `${q.slice(0, 217)}…` : q;
    if (!quotes.includes(short)) quotes.push(short);
    return kept;
  });
  return changes.length > 0 ? { text, changes, quotes } : null;
}

/** Does a value state a "Month YYYY"? (The facts worth checking.) */
export function hasMonthYear(text: string): boolean {
  MONTH_YEAR.lastIndex = 0;
  const hit = MONTH_YEAR.test(text);
  MONTH_YEAR.lastIndex = 0;
  return hit;
}

// ── Relative and dated targets ────────────────────────────────────────────

const REL_MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const SPAN_WORD = String.raw`(?:\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|eighteen|twenty-four|a few|a couple of|several)`;
/**
 * Wording whose meaning depends on when it was said: "in May", "last year",
 * "next spring", "within one year", "before his next birthday", "over the
 * next 18 months", "by year-end". "within one year" and "next birthday"
 * were missed (Pacific 2026-09-26: the timeline fact reached the CIM with no
 * recorded date and the CIM promised a sale "before fall 2026" in
 * September 2026).
 */
const RELATIVE_TIME = new RegExp(
  [
    String.raw`\b(?:last|next|this|coming|past|previous)\s+(?:year|month|quarter|spring|summer|fall|autumn|winter|week|birthday|season|fiscal year)\b`,
    String.raw`\b(?:recently|ago|upcoming|soon|shortly|later this year|earlier this year|year[- ]end|end of (?:the )?(?:year|month|quarter))\b`,
    String.raw`\b(?:within|in|over|for|inside|under)\s+(?:the\s+)?(?:next\s+|coming\s+|past\s+|last\s+)?(?:roughly\s+|about\s+|approximately\s+|around\s+|~\s?)?${SPAN_WORD}\s+(?:years?|months?|weeks?|quarters?)\b`,
    String.raw`\b(?:within|in|over)\s+(?:the\s+)?(?:next|coming)\s+(?:year|months?|quarters?)\b`,
    String.raw`\b(?:within|in)\s+(?:a|one)\s+year\b`,
    String.raw`\b(?:in|by|since|until|from|around|early|late|mid|end of)\s+(?:${REL_MONTHS})\b(?![\s,.-]*(?:\d{1,2}(?:st|nd|rd|th)?[\s,]*)?\d{4})`,
  ].join("|"),
  "i",
);

/** Does a fact's wording depend on when it was said? */
export function hasRelativeTime(text: string): boolean {
  return !!text && RELATIVE_TIME.test(text);
}

const SEASONS: Record<string, [number, number]> = {
  // [first month, last month] (0-based); winter runs into the next year.
  spring: [2, 4], summer: [5, 7], fall: [8, 10], autumn: [8, 10], winter: [11, 13],
};
const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** The period a "fall 2026" / "Q1 2027" / "March 2026" / "2026" names: [start, end). */
export function namedPeriod(text: string): { start: Date; end: Date } | null {
  const t = text.toLowerCase().trim();
  let m = /^(?:(early|mid|late)[- ])?(spring|summer|fall|autumn|winter)\s+(?:of\s+)?((?:19|20)\d{2})$/.exec(t);
  if (m) {
    const [a, b] = SEASONS[m[2]];
    const y = Number(m[3]);
    return { start: new Date(Date.UTC(y, a, 1)), end: new Date(Date.UTC(y, b + 1, 1)) };
  }
  m = /^q([1-4])\s+(?:of\s+)?((?:19|20)\d{2})$/.exec(t);
  if (m) {
    const q = Number(m[1]) - 1;
    const y = Number(m[2]);
    return { start: new Date(Date.UTC(y, q * 3, 1)), end: new Date(Date.UTC(y, q * 3 + 3, 1)) };
  }
  m = /^(?:(early|mid|late)[- ])?([a-z]+)\.?\s+((?:19|20)\d{2})$/.exec(t);
  if (m) {
    const i = MONTH_NAMES.findIndex((n) => n.startsWith(m![2].slice(0, 3)) && m![2].length >= 3);
    if (i >= 0) {
      const y = Number(m[3]);
      return { start: new Date(Date.UTC(y, i, 1)), end: new Date(Date.UTC(y, i + 1, 1)) };
    }
  }
  m = /^(?:(early|mid|late)[- ])?((?:19|20)\d{2})$/.exec(t);
  if (m) {
    const y = Number(m[2]);
    return { start: new Date(Date.UTC(y, 0, 1)), end: new Date(Date.UTC(y + 1, 0, 1)) };
  }
  return null;
}

const PERIOD = String.raw`(?:(?:early|mid|late)[- ])?(?:spring|summer|fall|autumn|winter|q[1-4]|${REL_MONTHS})\.?\s+(?:of\s+)?(?:19|20)\d{2}|(?:(?:early|mid|late)[- ])?(?:19|20)\d{2}`;
/** "before fall 2026", "by Q1 2027", "no later than March 2026", "targeting late 2026". */
const DEADLINE = new RegExp(String.raw`\b(before|by|no later than|until|ahead of|in time for|targeting|target(?:ed)? for|planned for|scheduled for|expected (?:in|by)|to (?:close|complete|finish) (?:in|by))\s+(?:(?:his|her|their|the owner's|the seller's)\s+)?(?:next\s+birthday\s+)?\(?(?:in\s+)?(${PERIOD})\b`, "gi");
/** A sentence that looks ahead (a wish, plan or target), not a report of the past. */
const FORWARD = /\b(wants?|wanted|plans?|planned|planning|intends?|intended|aims?|targets?|targeting|expects?|expected|hopes?|would like|will|to (?:complete|close|sell|finish|exit|retire)|looking to|goal|timeline|timing|before|by|no later than|ahead of)\b/i;

export interface StaleTarget {
  /** The words as written ("before fall 2026"). */
  phrase: string;
  period: string;
}

/**
 * Future targets that TODAY has reached or passed: "complete the sale before
 * fall 2026" written in September 2026. A "before X" target is stale once X
 * starts; a "by / in X" target once X is over.
 */
export function staleTargets(text: string, today: Date): StaleTarget[] {
  const out: StaleTarget[] = [];
  if (!text) return out;
  for (const sentence of text.split(/(?<=[.!?;])\s+|\n+/)) {
    if (!FORWARD.test(sentence)) continue;
    DEADLINE.lastIndex = 0;
    for (const m of Array.from(sentence.matchAll(DEADLINE))) {
      const p = namedPeriod(m[2]);
      if (!p) continue;
      const word = m[1].toLowerCase();
      const edge = word === "before" || word === "ahead of" || word === "in time for" ? p.start : p.end;
      if (edge.getTime() <= today.getTime()) out.push({ phrase: m[0].replace(/\(\s*/g, "").replace(/\s+/g, " ").trim(), period: m[2] });
    }
  }
  return out;
}
