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
