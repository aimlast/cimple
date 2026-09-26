/**
 * spoken-figures — numbers as people say them.
 *
 * Interview and call facts are recorded the way the seller said them
 * ("six-point-something years", "twenty-four drivers over ten years", "ten
 * to fifteen percent"). Two consumers:
 *  - normalizeSpokenFigures: the CIM writer sees clean, buyer-facing wording
 *    with the meaning unchanged ("just over 6 years", "24 drivers over 10
 *    years", "10 to 15 percent") instead of copying the seller's phrasing
 *    into a metric (Pacific 2026-09-26: "Six-point-something years across
 *    all drivers" printed as a footnote).
 *  - spelledNumbers: the figure check reads "three million TEUs" and "a
 *    decade" as numbers, so a figure written in words is traced like one
 *    written in digits.
 *
 * Pure: no database, no AI.
 */

const UNITS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };

const UNIT_ALT = Object.keys(UNITS).join("|");
const TENS_ALT = Object.keys(TENS).join("|");
/** "twenty-four", "twenty four", "seventeen", "ten". */
const SMALL = String.raw`(?:(?:${TENS_ALT})(?:[\s-](?:${UNIT_ALT}))?|${UNIT_ALT})`;
/** "three million", "two hundred and fifty thousand", "a million". */
const SPELLED = new RegExp(
  String.raw`\b(?:(?:a|an)(?=\s+(?:hundred|thousand|million|billion))|${SMALL})(?:(?:\s+and)?[\s-]+(?:${SMALL}|hundred|thousand|million|billion))*\b`,
  "gi",
);

function wordValue(phrase: string): number | null {
  const words = phrase.toLowerCase().replace(/-/g, " ").split(/\s+/).filter((w) => w && w !== "and");
  let total = 0;
  let current = 0;
  let any = false;
  for (const w of words) {
    if (w === "a" || w === "an") { current = Math.max(current, 1); continue; }
    if (w in UNITS) { current += UNITS[w]; any = true; continue; }
    if (w in TENS) { current += TENS[w]; any = true; continue; }
    if (w === "hundred") { current = (current || 1) * 100; any = true; continue; }
    if (w in SCALES) { total += (current || 1) * SCALES[w]; current = 0; any = true; continue; }
    return null;
  }
  return any ? total + current : null;
}

export interface SpelledNumber {
  value: number;
  text: string;
  index: number;
  /** "percent" / "per cent" follows. */
  percent: boolean;
}

/** Numbers written in words ("three million", "twenty-four", "a decade"). */
export function spelledNumbers(text: string): SpelledNumber[] {
  const out: SpelledNumber[] = [];
  if (!text) return out;
  for (const m of Array.from(text.matchAll(SPELLED))) {
    const v = wordValue(m[0]);
    if (v === null) continue;
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 12);
    out.push({ value: v, text: m[0], index: m.index!, percent: /^\s*(?:percent|per cent)\b/i.test(after) });
  }
  // "a decade" / "two decades" — a span of years.
  for (const m of Array.from(text.matchAll(/\b(a|one|two|three|four|five)\s+decades?\b/gi))) {
    const n = m[1].toLowerCase() === "a" ? 1 : UNITS[m[1].toLowerCase()];
    out.push({ value: n * 10, text: m[0], index: m.index!, percent: false });
  }
  return out;
}

const DIGIT_WORD = String.raw`(\d+|${UNIT_ALT}|${TENS_ALT})`;
const POINT_SOMETHING = new RegExp(String.raw`\b${DIGIT_WORD}[\s-]+point[\s-]+something\b`, "gi");
const ISH = new RegExp(String.raw`\b${DIGIT_WORD}-?ish\b`, "gi");

function asDigits(tok: string): string {
  if (/^\d+$/.test(tok)) return tok;
  const v = wordValue(tok);
  return v === null ? tok : String(v);
}

/** Seller phrasing a buyer-facing document must never quote. */
export const CASUAL_FIGURE = new RegExp(`${POINT_SOMETHING.source}|${ISH.source}|\\bballpark\\b|\\bgive or take\\b`, "i");

/**
 * Spoken figures as clean, buyer-facing wording — the meaning unchanged:
 *   "six-point-something years" → "just over 6 years"
 *   "forty-ish trucks"          → "about 40 trucks"
 *   "twenty-four drivers over ten years" → "24 drivers over 10 years"
 * Numbers below ten stay in words ("two sites"), as in house style.
 */
export function normalizeSpokenFigures(text: string): string {
  if (!text || typeof text !== "string") return text;
  let out = text
    .replace(POINT_SOMETHING, (_w, n: string) => `just over ${asDigits(n)}`)
    .replace(ISH, (_w, n: string) => `about ${asDigits(n)}`);
  out = out.replace(SPELLED, (phrase: string, offset: number, whole: string) => {
    const v = wordValue(phrase);
    // Scale words stay words ("three million" reads fine; "a million-dollar" must not become digits).
    if (v === null || v < 10 || /hundred|thousand|million|billion/i.test(phrase)) return phrase;
    // "one of the …" / "ten-year" keep working; only the number itself changes.
    const prev = whole.slice(Math.max(0, offset - 1), offset);
    if (/[A-Za-z]/.test(prev)) return phrase;
    // A capitalised number word mid-sentence is part of a name ("Forty Creek", "Twenty Mile Road").
    if (/^\s*[A-Z]/.test(phrase)) {
      const before = whole.slice(0, offset).trimEnd();
      if (before && !/[.;:!?]$/.test(before)) return phrase;
    }
    const lead = /^\s*/.exec(phrase)?.[0] ?? "";
    return `${lead}${v.toLocaleString("en-US")}`;
  });
  return out;
}
