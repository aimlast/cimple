/**
 * section-words — the words of a CIM section's key and title, for matching
 * pages across versions (no AI, deterministic).
 *
 *   - keyStem / keyWordsOf / KEY_STOPWORDS / WEAK_KEY_WORDS: how an OLD
 *     tracker key ("services_revenue_streams") is placed on a current page
 *     (server/engagement/legacy.ts matchLegacyKey) — moved here unchanged.
 *   - sectionSimilarity: how a regenerated section is recognised as the
 *     continuation of an old one (server/analytics/lineage.ts assignLineage,
 *     pass 3). Precision first: a pair needs telling words in common, a
 *     single shared word needs a high score AND the same page role.
 *
 * The lineage word lists are the reference prototype's
 * (heatmap spec §5.1); tests/unit/engagement-lineage-v2.test.ts pins the
 * result on the Pacific demo CIM.
 */
import { pageRole } from "./cim-page-role";

// ── Old-tracker keys (legacy.ts) ─────────────────────────────────────────

export const KEY_STOPWORDS: ReadonlySet<string> = new Set(["the", "and", "of", "a", "an", "to", "for", "in", "on", "our", "we", "where", "with", "by", "at", "s", "vs"]);

/** One spelling per word: plurals folded, long words cut to their first six letters ("normalized"/"normalization" → "normal"). */
export function keyStem(word: string): string {
  let w = word.toLowerCase();
  if (w.length > 4 && w.endsWith("ies")) w = `${w.slice(0, -3)}y`;
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w.length > 6 ? w.slice(0, 6) : w;
}

/** camelCase split, split on anything that isn't a letter or digit, lower-cased. */
function rawWords(text: string | null | undefined): string[] {
  return String(text ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .map((w) => w.toLowerCase());
}

export function keyWordsOf(text: string | null | undefined): Set<string> {
  return new Set(rawWords(text).filter((w) => w.length >= 2 && !KEY_STOPWORDS.has(w)).map(keyStem));
}

/** Words too broad to place a page on their own ("services", "overview", "where we operate"). */
export const WEAK_KEY_WORDS: ReadonlySet<string> = new Set(
  ["service", "overview", "detail", "summary", "section", "page", "info", "information", "general", "key", "business", "company", "operate", "operations", "other", "notes"].map(keyStem),
);

// ── Lineage (assignLineage pass 3) ───────────────────────────────────────

export const LINEAGE_STOPWORDS: ReadonlySet<string> = new Set([...Array.from(KEY_STOPWORDS), "page"]);

/** Broad words: weight 0.5, never "telling" on their own. */
export const LINEAGE_WEAK: ReadonlySet<string> = new Set(
  ["service", "overview", "detail", "summary", "section", "info", "information", "general", "key", "business", "company", "operate", "operations", "operating", "other", "notes", "data", "profile", "top", "10"].map(keyStem),
);

/** Abbreviations read as their words. */
export const LINEAGE_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  capex: ["capital", "expenditure"],
  sde: ["seller", "discretionary", "earnings"],
  ebitda: ["ebitda"],
  pnl: ["income", "statement"],
  hr: ["employee"],
  ltc: ["long", "term", "care"],
};

/** Weighted stems of a section's key and title (1 = telling, 0.5 = broad). */
export function lineageWords(...texts: Array<string | null | undefined>): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of texts) {
    for (const w of rawWords(t)) {
      if (w.length < 2 || LINEAGE_STOPWORDS.has(w)) continue;
      for (const e of LINEAGE_SYNONYMS[w] ?? [w]) {
        const s = keyStem(e);
        out.set(s, LINEAGE_WEAK.has(s) ? 0.5 : 1);
      }
    }
  }
  return out;
}

export interface SectionWordsInput {
  sectionKey: string;
  sectionTitle: string;
  layoutType: string;
}

/** Score at or above which two sections may be the same page (two telling words in common). */
export const MIN_SECTION_SIMILARITY = 0.4;
/** With one telling word in common, the score must reach this AND the page roles must agree. */
export const ONE_WORD_SECTION_SIMILARITY = 0.5;

/**
 * How alike two sections are, 0–1: a weighted Dice over the stems of their
 * key and title; 0 unless at least one telling (non-broad) word is shared.
 * Two or more telling words: the score when ≥ 0.40. Exactly one: the score
 * when ≥ 0.50 and both pages have the same role (not "other"). Pure.
 */
export function sectionSimilarity(a: SectionWordsInput, b: SectionWordsInput): number {
  const A = lineageWords(a.sectionKey, a.sectionTitle);
  const B = lineageWords(b.sectionKey, b.sectionTitle);
  let shared = 0;
  let telling = 0;
  A.forEach((w, k) => {
    const wb = B.get(k);
    if (wb === undefined) return;
    shared += Math.min(w, wb);
    if (w === 1 && wb === 1) telling++;
  });
  if (telling === 0) return 0;
  let tot = 0;
  A.forEach((x) => { tot += x; });
  B.forEach((x) => { tot += x; });
  const dice = tot > 0 ? (2 * shared) / tot : 0;
  if (telling >= 2) return dice >= MIN_SECTION_SIMILARITY ? dice : 0;
  const ra = pageRole({ layoutType: a.layoutType, title: a.sectionTitle, sectionKey: a.sectionKey });
  const rb = pageRole({ layoutType: b.layoutType, title: b.sectionTitle, sectionKey: b.sectionKey });
  return dice >= ONE_WORD_SECTION_SIMILARITY && ra === rb && ra !== "other" ? dice : 0;
}
