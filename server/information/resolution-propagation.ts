/**
 * After a discrepancy is resolved: which OTHER facts still repeat the value
 * the broker just ruled out?
 *
 * Resolving "Alderbrook revenue percentage" as 22.0% corrected one fact, but
 * the stale ~18% lived on in customerConcentration, customerBase,
 * keyCustomerDetails and strengths — and the CIM said "Largest customer
 * <20%". Beacon: Daniel's "15 years" stayed in five narrative facts.
 *
 * findStaleFacts (pure) lists every confirmed fact that still states a
 * losing value in context of the same subject. proposeRewrites asks the
 * supporting model for the smallest edit that makes each one consistent
 * (a deterministic number swap when it can't); the broker reviews and
 * applies them in one click — written as broker edits, the old text kept as
 * another value.
 */
import Anthropic from "@anthropic-ai/sdk";
import { agentConfig } from "../interview/config/load-config";
import { isFactKey, getFieldSources } from "../interview/info-merger";
import { numberTokens, tokensMatch, type NumTok } from "../cim/discrepancy-filter";
import { factDisplayLabel } from "./facts";
import { HEADLINE_MAPS } from "../documents/merge-policy";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000 });

export interface ResolutionSubject {
  /** The discrepancy's label ("Alderbrook revenue percentage"). */
  field: string;
  factKey?: string | null;
  resolvedValue: string;
  /** The values the resolution ruled out. */
  supersededValues: string[];
  /** Fiscal year of a per-year resolution ("2024") — a by-year map's other years are other periods. */
  factYear?: string | null;
  /**
   * The resolution's own fact when it is a description the value wasn't
   * written into (NARRATIVE_FACT): offered for a rewrite even when it
   * doesn't repeat a ruled-out figure.
   */
  includeTarget?: string | null;
}

export interface StaleFact {
  key: string;
  label: string;
  value: string;
  /** The outdated figures found in it ("18%", "15 years"). */
  outdated: string[];
}

// Words that name a measure rather than the subject — "revenue percentage"
// says nothing about WHICH revenue.
const GENERIC_WORDS = new Set([
  "revenue", "revenues", "percentage", "percent", "total", "value", "values", "number", "count", "amount", "annual",
  "year", "years", "fiscal", "actual", "current", "figure", "rate", "ratio", "share", "size", "date", "details",
  "detail", "info", "information", "notes", "note", "status", "level", "base", "data", "claimed", "calculated",
  "stated", "reported", "adjusted", "the", "and", "for", "with", "from", "vs", "versus",
  // three-letter words that aren't subjects (acronyms like SDE, MRR, LTC are)
  "per", "all", "any", "are", "was", "has", "had", "not", "but", "its", "our", "one", "two", "new", "old", "top",
  "who", "how", "why", "now", "yes", "via", "own", "off", "out", "set", "see", "use", "may", "can", "due", "fy",
]);

function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w));
}

const stem = (w: string) => w.replace(/(?:ies|es|s)$/, "");

function stripLabel(v: string): string {
  const idx = v.indexOf(" — ");
  return (idx > 0 ? v.slice(0, idx) : v).trim();
}

/** Losing figures: numbers in the ruled-out values that the resolved value doesn't state. */
export function losingTokens(subject: ResolutionSubject): NumTok[] {
  const resolved = numberTokens(subject.resolvedValue);
  const out: NumTok[] = [];
  for (const v of subject.supersededValues) {
    for (const t of numberTokens(stripLabel(v))) {
      if (resolved.some((r) => sameQuantity(r, t))) continue;
      // Only a figure the resolution REPLACES is outdated: the resolved value
      // states the same kind of figure differently. "14 clinics" beside a
      // ruled-out "about 4%" is context, not a losing value.
      if (!resolved.some((r) => sameKind(r, t))) continue;
      if (out.some((o) => sameQuantity(o, t))) continue;
      out.push(t);
    }
  }
  return out;
}

const isMoney = (t: NumTok) => /\$|\d\s*(?:k|m|mm|million|thousand|b|billion)\b/i.test(t.raw);

/** Two figures of the same kind: both percentages, years, amounts, durations, or counts of the same thing. */
function sameKind(a: NumTok, b: NumTok): boolean {
  if (a.pct || b.pct) return a.pct && b.pct;
  if (a.year || b.year) return a.year && b.year;
  if (a.durationYears || b.durationYears) return a.durationYears && b.durationYears;
  if (isMoney(a) || isMoney(b)) return isMoney(a) && isMoney(b);
  return !!a.unitWord && stem(a.unitWord) === stem(b.unitWord);
}

/** Same quantity AND the same kind of thing: a bare count needs the same unit word. */
function sameQuantity(a: NumTok, b: NumTok): boolean {
  if (a.year !== b.year) return false;
  if (a.year) return a.value === b.value;
  if (!tokensMatch({ ...a, approx: false }, { ...b, approx: false })) return false;
  const plainCount = (t: NumTok) => !t.pct && !/\$|k\b|m\b|million|thousand/.test(t.raw) && t.value < 1000;
  if (plainCount(a) || plainCount(b)) return !!a.unitWord && stem(a.unitWord) === stem(b.unitWord);
  return true;
}

function factText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("; ") || null;
  return null; // maps are checked year by year (see the headline family below)
}

// A headline metric's own words ("revenue" is generic for "Alderbrook
// revenue percentage", but IS the subject of a revenue resolution).
const FAMILY_WORDS: Record<string, string[]> = {
  annualRevenue: ["revenue", "revenues", "sales", "turnover"],
  grossProfit: ["gross", "profit"],
  netIncome: ["net", "income", "profit"],
  ebitda: ["ebitda"],
  adjustedEbitda: ["ebitda"],
  sde: ["sde", "discretionary"],
};

/** The headline / by-year pair a fact key belongs to (annualRevenue ↔ revenueByYear), if any. */
function familyOf(key: string | null | undefined): { head: string; map: string } | null {
  if (!key) return null;
  return HEADLINE_MAPS.find((p) => p.head === key || p.map === key) ?? null;
}

function rawWords(text: string): string[] {
  return text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3);
}

/**
 * Facts that still state a ruled-out figure about the same subject. A
 * figure counts when its surroundings (or the fact's name) mention the
 * subject — "warehousing approximately 20%" is not about Alderbrook.
 * For a headline metric (revenue, EBITDA, SDE…) the metric's own words are
 * the subject, and the other half of the pair — the headline, or the
 * resolution year in the by-year map — is checked too ("revenueByYear.2024").
 */
export function findStaleFacts(info: Record<string, unknown>, subject: ResolutionSubject): StaleFact[] {
  const losing = losingTokens(subject);
  const resolvedTokens = numberTokens(subject.resolvedValue);
  // A hedged figure that also fits the settled one ("~$31M" beside a
  // settled $31,240,000) is still true — not outdated.
  const isStale = (t: NumTok) => losing.some((l) => sameQuantity(l, t)) && !(t.approx && resolvedTokens.some((r) => tokensMatch(t, r)));
  const out: StaleFact[] = [];
  const family = familyOf(subject.factKey);
  const subjectWords = new Set([...wordsOf(subject.field), ...wordsOf(subject.factKey ?? "")].map(stem));
  if (family) for (const w of FAMILY_WORDS[family.head] ?? []) subjectWords.add(stem(w));
  if (losing.length > 0) {
    for (const [key, raw] of Object.entries(info)) {
      if (!isFactKey(key)) continue;
      const text = factText(raw);
      if (!text) continue;
      const keyWords = rawWords(key).map(stem);
      const keyIsSubject = key === subject.factKey || (family && key === family.head) || keyWords.some((w) => subjectWords.has(w));
      const found: string[] = [];
      for (const t of numberTokens(text, { keepSourceLabel: true })) {
        if (!isStale(t)) continue;
        // Subject words are never generic ones (except a metric's own), so
        // the raw context words can be matched against them.
        const contextWords = rawWords(t.context).map(stem);
        if (keyIsSubject || contextWords.some((w) => subjectWords.has(w))) found.push(t.raw);
      }
      if (found.length > 0) out.push({ key, label: factDisplayLabel(info, key), value: text, outdated: Array.from(new Set(found)) });
    }
    // The by-year map of a headline metric: the resolution's year (or, with
    // no year, any year) that still states a ruled-out figure.
    if (family) {
      const map = info[family.map];
      if (map && typeof map === "object" && !Array.isArray(map)) {
        const year = (subject.factYear || "").replace(/^FY\s*/i, "").trim();
        for (const [y, v] of Object.entries(map as Record<string, unknown>)) {
          if (typeof v !== "string" || (year && y !== year)) continue;
          const found = numberTokens(v).filter(isStale).map((t) => t.raw);
          if (found.length > 0) {
            out.push({ key: `${family.map}.${y}`, label: `${factDisplayLabel(info, family.map)} (${y})`, value: v, outdated: Array.from(new Set(found)) });
          }
        }
      }
    }
  }
  // The resolution's own fact, when it is a description the value wasn't
  // written into: offered for a rewrite unless it already states the value.
  const own = subject.includeTarget;
  if (own && !out.some((f) => f.key === own)) {
    const text = factText(info[own]);
    const states = text && numberTokens(subject.resolvedValue).some((r) => numberTokens(text).some((t) => sameQuantity(r, t)));
    if (text && !states) out.push({ key: own, label: factDisplayLabel(info, own), value: text, outdated: [] });
  }
  return out;
}

// A figure after one of these is a bound or comparison ("no customer over
// 18%", "under 20%", "at least 12"): swapping in the bare resolved figure
// breaks the sentence ("no customer 22.0%") — it needs a rewrite.
const BOUND_BEFORE_RE = /(?:[<>≤≥]|\b(?:under|over|below|above|less than|more than|fewer than|greater than|at least|at most|up to|no more than|exceeds?|exceeding|beyond|within|maximum of|minimum of|max|min))\s*$/i;
// A hedge only described the old figure — the resolved one is exact.
const HEDGE_BEFORE_RE = /(?:[~≈]|\b(?:about|approximately|approx\.?|around|roughly|nearly|almost|close to|some|an estimated|estimated))\s*$/i;

/**
 * Deterministic fallback edit: swap each outdated figure for the resolved
 * one when the resolution states a single figure of the same kind, dropping
 * a hedge that described the old figure ("about 18%" → "22.0%"). Returns
 * null when that can't be done safely — a figure used as a bound or
 * comparison ("no customer over 18%") needs a rewrite, not a swap.
 */
export function swapOutdatedFigures(fact: StaleFact, resolvedValue: string): string | null {
  const resolved = numberTokens(resolvedValue);
  if (resolved.length !== 1) return null;
  const r = resolved[0];
  if (fact.outdated.length === 0) return null;
  let out = fact.value;
  for (const raw of fact.outdated) {
    const t = numberTokens(raw)[0];
    if (!t || t.pct !== r.pct || t.year !== r.year) return null;
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(?<![\\d.,])${escaped}(?![\\d])`, "gi");
    let m: RegExpExecArray | null;
    let next = "";
    let last = 0;
    while ((m = re.exec(out)) !== null) {
      const before = out.slice(0, m.index);
      if (BOUND_BEFORE_RE.test(before)) return null;
      const hedge = before.match(HEDGE_BEFORE_RE);
      const cut = hedge ? m.index - hedge[0].length : m.index;
      next += out.slice(last, Math.max(last, cut)) + r.raw;
      last = m.index + m[0].length;
    }
    if (last === 0) return null;
    out = next + out.slice(last);
  }
  return out === fact.value ? null : out;
}

/**
 * The resolved figure is exact: a hedge the rewrite left in front of it
 * ("about 22.0% of revenue") is dropped.
 */
export function dropHedgesBeforeResolved(text: string, resolvedValue: string): string {
  const r = numberTokens(resolvedValue)[0];
  if (!r || r.approx) return text;
  const escaped = r.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(
    new RegExp(`(?:[~≈]\\s*|\\b(?:about|approximately|approx\\.?|around|roughly|nearly|almost|close to|an estimated|estimated)\\s+)(${escaped})(?![\\d])`, "gi"),
    "$1",
  );
}

/**
 * A suggested rewrite is a fix only when it no longer states an outdated
 * figure (the ones found in THIS fact — "warehousing approximately 20%"
 * elsewhere in it is not outdated) and keeps every other figure the fact
 * states (a rewrite may not drop "no other customer over 10%").
 */
export function acceptableRewrite(fact: StaleFact, suggestion: string, resolvedValue: string): boolean {
  if (!suggestion.trim() || suggestion.trim() === fact.value.trim()) return false;
  const outdated = fact.outdated.map((o) => numberTokens(o)[0]).filter((t): t is NumTok => !!t);
  const sug = numberTokens(suggestion, { keepSourceLabel: true });
  const orig = numberTokens(fact.value, { keepSourceLabel: true });
  for (const o of outdated) {
    const before = orig.filter((t) => sameQuantity(o, t)).length;
    const after = sug.filter((t) => sameQuantity(o, t)).length;
    // Every stale mention must be gone; a same-figure mention about another
    // subject may stay only when the original had more than the stale ones.
    if (after > 0 && after >= before) return false;
  }
  const resolved = numberTokens(resolvedValue);
  // A description the settled value is added to must end up stating it.
  if (outdated.length === 0 && resolved.length > 0 && !resolved.some((r) => sug.some((s) => sameQuantity(r, s)))) return false;
  for (const t of orig) {
    if (t.year) continue;
    if (outdated.some((o) => sameQuantity(o, t))) continue;
    if (!sug.some((s) => sameQuantity(s, t) || s.raw === t.raw) && !resolved.some((r) => sameQuantity(r, t))) return false;
  }
  return true;
}

export interface ProposedRewrite extends StaleFact {
  /** The suggested new text (the broker can edit it before applying). */
  proposed: string;
  /** "ai" | "swap" | "manual" (no safe suggestion — edit by hand). */
  method: "ai" | "swap" | "manual";
}

const REWRITE_TOOL = {
  name: "rewrite_facts",
  description: "Return each fact rewritten so it agrees with the resolved value.",
  input_schema: {
    type: "object" as const,
    properties: {
      rewrites: {
        type: "array",
        items: {
          type: "object",
          properties: { key: { type: "string" }, text: { type: "string" } },
          required: ["key", "text"],
        },
      },
    },
    required: ["rewrites"],
  },
};

/** The model call — returns [{key, text}]. Swappable for tests. */
type RewriteModel = (stale: StaleFact[], subject: ResolutionSubject) => Promise<Array<{ key?: string; text?: string }>>;
const defaultRewriteModel: RewriteModel = async (stale, subject) => {
  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 4000,
    temperature: 0,
    tools: [REWRITE_TOOL],
    tool_choice: { type: "tool", name: REWRITE_TOOL.name },
    system:
      [
        "You correct facts in a business's file after the broker settled a conflicting figure. For each fact, make the SMALLEST edit that makes it agree with the resolved value: replace or reword only the outdated figure and any claim built on it, and keep the sentence true and grammatical.",
        "A figure used as a bound or a comparison needs the claim reworded, not the number swapped: 'no customer over 18%' becomes 'largest customer 22.0%' (never 'no customer 22.0%'); 'under 20%' goes when the settled figure is above it.",
        "The settled figure is exact: state it as settled, without the hedge that described the old figure ('about 18% of revenue' becomes '22.0% of revenue', not 'about 22.0%').",
        "Keep every other word, name and figure exactly as written — including other figures about other things ('no other customer over 10%', 'warehousing approximately 20% of revenue'). Keep whose figure it is (the customer, the role, the year).",
        "A fact with no outdated figure listed is a description the settled value belongs in: work the settled value into it in the fewest words, without removing anything else.",
        "Never add information that isn't in the resolved value.",
      ].join("\n"),
    messages: [{
      role: "user",
      content: [
        `Settled: ${subject.field}${subject.factYear ? ` (${subject.factYear})` : ""} = ${subject.resolvedValue}`,
        `Ruled out: ${subject.supersededValues.map((v) => `"${stripLabel(v)}"`).join(", ")}`,
        "",
        "Facts to correct:",
        ...stale.map((f) => `- ${f.key} (outdated: ${f.outdated.length > 0 ? f.outdated.join(", ") : "none — add the settled value"}): ${f.value}`),
      ].join("\n"),
    }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  return ((block && block.type === "tool_use" ? block.input : {}) as { rewrites?: Array<{ key?: string; text?: string }> }).rewrites ?? [];
};
let rewriteModel: RewriteModel = defaultRewriteModel;
export function _setRewriteModelForTests(fn: RewriteModel | null) {
  rewriteModel = fn ?? defaultRewriteModel;
}

/** Suggested rewrites for the stale facts — AI, then a number swap, else hand edit. */
export async function proposeRewrites(stale: StaleFact[], subject: ResolutionSubject): Promise<ProposedRewrite[]> {
  if (stale.length === 0) return [];
  let ai: Record<string, string> = {};
  try {
    const rows = await rewriteModel(stale, subject);
    for (const r of rows) if (r && typeof r.key === "string" && typeof r.text === "string" && r.text.trim()) ai[r.key] = r.text.trim();
  } catch (err: any) {
    console.warn("[resolution-propagation] AI rewrite failed, falling back:", err?.message || err);
    ai = {};
  }
  return stale.map((f) => {
    const suggestion = ai[f.key] ? dropHedgesBeforeResolved(ai[f.key], subject.resolvedValue) : "";
    // A suggestion that still states an outdated figure, or drops another
    // figure the fact states, is no fix.
    if (suggestion && acceptableRewrite(f, suggestion, subject.resolvedValue)) return { ...f, proposed: suggestion, method: "ai" as const };
    const swapped = swapOutdatedFigures(f, subject.resolvedValue);
    if (swapped) return { ...f, proposed: swapped, method: "swap" as const };
    return { ...f, proposed: f.value, method: "manual" as const };
  });
}

/** Which of the stale facts the seller or a document said (for the panel's labels). */
export function staleFactSources(info: Record<string, unknown>, stale: StaleFact[]): Record<string, string> {
  const sources = getFieldSources(info);
  return Object.fromEntries(stale.map((f) => [f.key, sources[f.key]?.source ?? "unknown"]));
}
