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

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 120_000 });

export interface ResolutionSubject {
  /** The discrepancy's label ("Alderbrook revenue percentage"). */
  field: string;
  factKey?: string | null;
  resolvedValue: string;
  /** The values the resolution ruled out. */
  supersededValues: string[];
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
  return null; // maps (revenueByYear) are corrected per year by the resolution itself
}

/**
 * Facts that still state a ruled-out figure about the same subject. A
 * figure counts when its surroundings (or the fact's name) mention the
 * subject — "warehousing approximately 20%" is not about Alderbrook.
 */
export function findStaleFacts(info: Record<string, unknown>, subject: ResolutionSubject): StaleFact[] {
  const losing = losingTokens(subject);
  if (losing.length === 0) return [];
  const subjectWords = new Set([...wordsOf(subject.field), ...wordsOf(subject.factKey ?? "")].map(stem));
  const out: StaleFact[] = [];
  for (const [key, raw] of Object.entries(info)) {
    if (!isFactKey(key)) continue;
    const text = factText(raw);
    if (!text) continue;
    const keyWords = wordsOf(key).map(stem);
    const keyIsSubject = key === subject.factKey || keyWords.some((w) => subjectWords.has(w));
    const found: string[] = [];
    for (const t of numberTokens(text, { keepSourceLabel: true })) {
      if (!losing.some((l) => sameQuantity(l, t))) continue;
      const contextWords = wordsOf(t.context).map(stem);
      if (keyIsSubject || contextWords.some((w) => subjectWords.has(w))) found.push(t.raw);
    }
    if (found.length > 0) out.push({ key, label: factDisplayLabel(info, key), value: text, outdated: Array.from(new Set(found)) });
  }
  return out;
}

/**
 * Deterministic fallback edit: swap each outdated figure for the resolved
 * one when the resolution states a single figure of the same kind. Returns
 * null when that can't be done safely.
 */
export function swapOutdatedFigures(fact: StaleFact, resolvedValue: string): string | null {
  const resolved = numberTokens(resolvedValue);
  if (resolved.length !== 1) return null;
  const r = resolved[0];
  let out = fact.value;
  for (const raw of fact.outdated) {
    const t = numberTokens(raw)[0];
    if (!t || t.pct !== r.pct || t.year !== r.year) return null;
    const escaped = raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(?:[<>~≈]\\s*|\\b(?:about|approximately|around|roughly|under|over|less than|more than|nearly)\\s+)?${escaped}`, "gi"), r.raw);
  }
  return out === fact.value ? null : out;
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
      "You correct facts in a business's file after the broker settled a conflicting figure. For each fact, make the SMALLEST edit that makes it agree with the resolved value: replace or reword only the outdated figure and any claim built on it (e.g. 'no customer over 20%' becomes 'largest customer 22.0%'). Keep every other word, name and figure exactly as written. Never add information that isn't in the resolved value.",
    messages: [{
      role: "user",
      content: [
        `Settled: ${subject.field} = ${subject.resolvedValue}`,
        `Ruled out: ${subject.supersededValues.map((v) => `"${stripLabel(v)}"`).join(", ")}`,
        "",
        "Facts to correct:",
        ...stale.map((f) => `- ${f.key} (outdated: ${f.outdated.join(", ")}): ${f.value}`),
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
  const losing = losingTokens(subject);
  return stale.map((f) => {
    const suggestion = ai[f.key];
    // A suggestion that still states an outdated figure is no fix.
    const stillStale = suggestion && numberTokens(suggestion, { keepSourceLabel: true }).some((t) => losing.some((l) => sameQuantity(l, t)));
    if (suggestion && suggestion !== f.value && !stillStale) return { ...f, proposed: suggestion, method: "ai" as const };
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
