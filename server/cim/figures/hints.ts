/**
 * hints — D8a: what Cimple's financial analysis already says about a figure,
 * offered to the BROKER only ("Cimple's analysis suggests: … (not checked)"
 * with "This is right, use it"). A hint is never a source for the AI and
 * never reaches a buyer or the seller; once the broker uses one it becomes
 * the broker's own note (guarded like any broker text).
 *
 * A hint matches a figure when one sentence of an analysis note names the
 * line (its words or synonyms) and its year — or, for a movement, both
 * years. Internal check text ("Check: …", "does not tie", "Net income
 * computed …") is never offered. Pure.
 */
import type { FigureRegistry } from "@shared/figure-anchors";
import { lineWords, parseFigureKey } from "@shared/figure-lines";

const INTERNAL = /^\s*check:|does not tie|doesn't tie|net income computed|reported net income|not added back unless you approve|rests only on your private notes|left out of ebitda|review the income statement reclassification/i;

/** The analysis's notes as sentences: reclassified P&L notes, normalization notes, insight details. */
export function analysisNoteSentences(analysis: { reclassifiedPnl?: unknown; normalization?: unknown; insights?: unknown } | null | undefined): string[] {
  if (!analysis) return [];
  const texts: string[] = [];
  const notesOf = (v: unknown) => {
    const notes = (v as { notes?: unknown } | null | undefined)?.notes;
    if (Array.isArray(notes)) for (const n of notes) if (typeof n === "string") texts.push(n);
  };
  notesOf(analysis.reclassifiedPnl);
  notesOf(analysis.normalization);
  const ins = analysis.insights as Record<string, unknown> | null | undefined;
  if (ins && typeof ins === "object") {
    for (const list of Object.values(ins)) {
      if (!Array.isArray(list)) continue;
      for (const it of list) {
        const d = (it as { detail?: unknown })?.detail;
        if (typeof d === "string") texts.push(d);
      }
    }
  }
  const out: string[] = [];
  for (const t of texts) {
    if (INTERNAL.test(t)) continue;
    for (const s of t.split(/(?<=[.!?])\s+(?=[A-Z(])/)) {
      const sentence = s.trim();
      if (sentence.length >= 12 && !INTERNAL.test(sentence)) out.push(sentence);
    }
  }
  return out;
}

function hits(sentence: string, words: string[]): number {
  const s = sentence.toLowerCase();
  return words.filter((w) => {
    const word = w.toLowerCase().trim();
    if (!word) return false;
    const re = new RegExp(`(?:^|[^a-z])${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:s|es)?(?:[^a-z]|$)`, "i");
    return re.test(s);
  }).length;
}

const STOP = new Set(["expenses", "expense", "costs", "cost", "other", "total", "general", "including", "incl", "benefits", "with", "from", "into", "and", "net", "of", "the"]);
/** The line's own meaningful words ("Facility rent — warehouse" → facility, rent, warehouse). */
function ownWords(label: string): string[] {
  return String(label).toLowerCase().replace(/\([^)]*\)/g, " ").split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !STOP.has(w));
}

/**
 * Does a sentence name this line? Two of its own words (one when it has only
 * one), or one own word plus a synonym — "HVAC" alone never makes a sentence
 * about "HVAC equipment replacement & installation".
 */
function mentions(sentence: string, label: string, synonyms: string[]): boolean {
  const own = Array.from(new Set(ownWords(label)));
  if (own.length === 0) return hits(sentence, synonyms) > 0;
  const ownHits = hits(sentence, own);
  if (ownHits >= Math.min(2, own.length)) return true;
  const extra = synonyms.filter((w) => !own.includes(w.toLowerCase()));
  return ownHits >= 1 && hits(sentence, extra) >= 1;
}

/**
 * The hint for each figure key (a movement from the year before, or a
 * difference in its year). First matching sentence wins.
 */
export function hintsFor(figureKeys: Iterable<string>, registry: FigureRegistry, sentences: string[], opts: { movement?: (key: string) => boolean } = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Array.from(new Set(figureKeys))) {
    const parsed = parseFigureKey(key);
    const fig = registry[key];
    if (!parsed || !fig) continue;
    const words = lineWords(parsed.line, fig.lineLabel);
    if (words.length === 0) continue;
    const prev = String(Number(parsed.year) - 1);
    const isMovement = opts.movement ? opts.movement(key) : true;
    const about = (s: string) => mentions(s, fig.lineLabel, words);
    const hit = sentences.find((s) => about(s) && s.includes(parsed.year) && (!isMovement || s.includes(prev)))
      ?? (isMovement ? undefined : sentences.find((s) => about(s) && s.includes(parsed.year)));
    if (hit) out[key] = hit.length > 400 ? `${hit.slice(0, 397)}…` : hit;
  }
  return out;
}
