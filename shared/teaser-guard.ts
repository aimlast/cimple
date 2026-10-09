/**
 * Teaser checks (pure; server and client).
 *
 *  - guardTeaserText: the Blind CIM's identity check (shared/blind-guard.ts)
 *    plus the figure stand-ins the AI must never leave ("[amount]").
 *    Fail closed: a block that fails is held back from buyers.
 *  - figuresOutsideAllowed: any digit, money sign, percentage or spelled
 *    number of 13 or more outside the phrases the code supplied (the chips)
 *    or a short duration ("a 6-month handover"). AI text never carries a
 *    figure: the numbers live in fixed blocks built by code.
 *  - pinpointWarnings: wording that could give the business away without
 *    naming it ("the only…", "since 1987", "112 trucks"). A warning for the
 *    broker, never a hold.
 *  - processWordsIn: words that betray how the text was made ("the seller
 *    said", "per the interview", "CRM", "teaser").
 */
import { blindPlaceholders, findBlindLeaks, type BlindTerm } from "./blind-guard";

export interface TeaserGuardResult {
  ok: boolean;
  leaks: string[];
  placeholders: string[];
}

/** The stand-ins stripFigures writes into the AI's input. */
const FIGURE_TOKEN = /\[(?:amount|number|year|share)\]/gi;

export function guardTeaserText(texts: unknown, terms: BlindTerm[]): TeaserGuardResult {
  const leaks = findBlindLeaks(texts, terms);
  const all = typeof texts === "string" ? texts : JSON.stringify(texts ?? "");
  const tokens = Array.from(new Set((all.match(FIGURE_TOKEN) ?? []).map((t) => t.toLowerCase())));
  const placeholders = Array.from(new Set([...blindPlaceholders(texts), ...tokens]));
  return { ok: leaks.length === 0 && placeholders.length === 0, leaks, placeholders };
}

const KIND_WORDS: Record<string, string> = {
  name: "the business's name",
  person: "a person",
  place: "the town",
  contact: "a contact detail",
  registry: "a registration number",
};

/** "“Surrey” (the town)" — what a leak is, for the broker. */
export function describeLeak(leak: string, terms: BlindTerm[]): string {
  const t = terms.find((x) => x.text.toLowerCase() === leak.toLowerCase());
  return `“${leak}”${t ? ` (${KIND_WORDS[t.kind] ?? "something identifying"})` : ""}`;
}

/** The broker's sentence for a held block. */
export function heldReason(result: TeaserGuardResult, terms: BlindTerm[]): string | null {
  if (result.ok) return null;
  if (result.leaks.length > 0) {
    // "Lakeshore Home Comfort" already says "Lakeshore": name each thing once.
    const leaks = result.leaks.filter((l, i, all) => !all.some((o, j) => j !== i && o.length > l.length && o.toLowerCase().includes(l.toLowerCase())));
    return `it names ${leaks.slice(0, 2).map((l) => describeLeak(l, terms)).join(" and ")}`;
  }
  return `it still has a stand-in where a word should be (${result.placeholders.slice(0, 2).join(", ")})`;
}

/** A short duration ("a 6-month handover", "12 weeks") — allowed in AI text. */
const SHORT_DURATION = /\b(\d{1,2})(?:\s*[-–]\s*\d{1,2})?[\s-]+(?:weeks?|months?)\b/gi;

const SPELLED_13_PLUS = /\b(?:thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion)\b/i;

function stripPhrases(text: string, phrases: readonly string[]): string {
  let out = text;
  for (const p of [...phrases].filter((x) => x && x.trim()).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    out = out.replace(re, " ");
  }
  return out;
}

/**
 * Figures in `text` that the code didn't supply: digits, money signs,
 * percentages, and spelled numbers of 13 or more (pass the server's
 * spelledNumbers for the full reading; a word list is the fallback).
 * Allowed: the `allowed` phrases (the chips) and short durations of weeks
 * or months up to 24. Empty = clean.
 */
export function figuresOutsideAllowed(
  text: string,
  allowed: readonly string[],
  spelled?: (t: string) => Array<{ value: number; text: string }>,
): string[] {
  if (!text) return [];
  let rest = stripPhrases(text, allowed);
  rest = rest.replace(SHORT_DURATION, (m, n) => (Number(n) <= 24 ? " " : m));
  const found: string[] = [];
  for (const m of Array.from(rest.matchAll(/[$€£¥]\s*\d[\d,.]*\s*[kKmMbB]?|\d[\d,.]*\s*%|\d[\d,.]*/g))) found.push(m[0].trim());
  for (const m of Array.from(rest.matchAll(/[$€£¥]|%|\bper ?cent\b/gi))) if (!found.some((f) => f.includes(m[0]))) found.push(m[0]);
  if (spelled) {
    for (const s of spelled(rest)) if (s.value >= 13) found.push(s.text);
  } else {
    const m = SPELLED_13_PLUS.exec(rest);
    if (m) found.push(m[0]);
  }
  return Array.from(new Set(found));
}

const UNIQUE = /\b(?:(?:the|its|their|our)\s+(?:only|sole|first|best)\b(?:\s+[\w'’-]+){0,4}|(?:largest|biggest|oldest|leading|exclusive|number[- ]one|no\.\s?1|#1|premier|dominant|unrivall?ed|unmatched)\b(?:\s+[\w'’-]+){0,3}|(?:region|province|state|city|area|country)['’]s\s+(?:best|largest|biggest|leading|oldest|only)\b(?:\s+[\w'’-]+){0,3})/gi;
const YEAR_SINCE = /\b(?:since|founded|established|est\.?|incorporated|started|opened|in|from)\s+(?:in\s+)?(?:19|20)\d{2}\b/gi;
const COUNT_NOUN = /\b\d[\d,]*\+?\s+(?:[a-z][a-z-]*\s+){0,2}(?:trucks?|tractors?|trailers?|vehicles?|units?|stores?|locations?|clinics?|branches|outlets|sites?|beds?|chairs?|rooms?|employees|staff|members|customers|clients|patients|students|routes?|acres?|sq\.?\s?ft|square\s+feet|doors?|bays?)\b/gi;

/**
 * Wording that could let someone recognise the business without naming it.
 * Returns the phrases found (as written), never blocking.
 */
export function pinpointWarnings(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const re of [UNIQUE, YEAR_SINCE, COUNT_NOUN]) for (const m of Array.from(text.matchAll(re))) out.push(m[0].trim());
  return Array.from(new Set(out));
}

/** Words that betray how the text was made — never in buyer text. */
const PROCESS = /\b(?:the\s+(?:seller|owner|vendor)\s+(?:said|says|told|mentioned|explained)|per\s+the\s+(?:interview|seller|owner|call|transcript)|in\s+the\s+interview|knowledge\s+base|\bCRM\b|teaser|extracted|the\s+facts\s+(?:say|show)|according\s+to\s+(?:the\s+)?(?:interview|seller|documents?))\b/i;

export function processWordsIn(text: string): string | null {
  const m = PROCESS.exec(text ?? "");
  return m ? m[0] : null;
}
