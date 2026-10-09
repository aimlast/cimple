/**
 * Figures out of the teaser AI's input (E2): the model never sees a money
 * amount, a percentage, a count, a year or a large spelled number, so it
 * can't write one. The numbers a teaser shows come only from code
 * (server/teaser/key-numbers.ts), as ranges or rounded figures.
 *
 *   "$18.2M in 2024"                    → "[amount] in [year]"
 *   "112 trucks"                        → "[number] trucks"
 *   "top customer 22%"                  → "top customer [share]"
 *   "since 1987"                        → "since [year]"
 *   "one hundred and twelve tractors"   → "[number] tractors"
 * Kept: short durations of weeks or months up to 24 ("a 6-month handover"),
 * which the transition phrase needs.
 */
import { spelledNumbers } from "../cim/spoken-figures";

const SHORT_DURATION = /\b(\d{1,2})(\s*[-–]\s*\d{1,2})?([\s-]+)(weeks?|months?)\b/gi;

/** The model is told what the brackets mean (generate.ts). */
export const FIGURE_NOTE = "Text in [brackets] stands for a figure you are not given. Never write a figure, and never write the brackets.";

export function stripFigures(text: string): string {
  if (!text) return "";
  // Keep short durations: stash them, strip, restore.
  const kept: string[] = [];
  let t = text.replace(SHORT_DURATION, (m, n: string) => {
    if (Number(n) > 24) return m;
    kept.push(m);
    return `\u0000${letters(kept.length - 1)}\u0000`;
  });
  // Money (with units), then percentages, then years, then any other digits.
  t = t.replace(/(?:[$€£¥]|\b(?:US|CA|C|USD|CAD)\$)\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|b|bn|thousand|million|billion)?\b/gi, "[amount]");
  t = t.replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|bn|thousand|million|billion)\s*(?:dollars|usd|cad)?\b/gi, "[amount]");
  t = t.replace(/\b\d[\d,]*(?:\.\d+)?\s*(?:%|percent\b|per cent\b)/gi, "[share]");
  t = t.replace(/\b(?:19|20)\d{2}(?:s\b)?/g, "[year]");
  t = t.replace(/\b\d[\d,]*(?:\.\d+)?\b/g, "[number]");
  // Spelled numbers of 13 and more ("one hundred and twelve", "twenty-four").
  const spelled = spelledNumbers(t).filter((s) => s.value >= 13).sort((a, b) => b.index - a.index);
  for (const s of spelled) t = t.slice(0, s.index) + (s.percent ? "[share]" : "[number]") + t.slice(s.index + s.text.length);
  t = t.replace(/\[share\]\s*(?:percent|per cent)\b/gi, "[share]");
  return t.replace(/\u0000([A-Z]+)\u0000/g, (_m, l: string) => kept[fromLetters(l)] ?? "");
}

/** A stash index as letters (digits would be stripped as figures). */
function letters(i: number): string {
  let s = "";
  let n = i + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
function fromLetters(s: string): number {
  let n = 0;
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A spelled number of at least `min` in the text. */
export function spelledFigureAtLeast(text: string, min = 13): boolean {
  return spelledNumbers(text).some((s) => s.value >= min);
}
