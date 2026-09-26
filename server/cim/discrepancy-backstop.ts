/**
 * Deterministic backstops around the discrepancy check's model output.
 *
 *  - likeForLikeCountConflict: the seller-side value and the document count
 *    the SAME thing ("licensed field technicians", "service vans") and give
 *    different numbers. The model is allowed to dismiss a candidate, but not
 *    this one: Lakeshore's planted "24 licensed field technicians" vs the
 *    roster's 22 was dismissed as "seller's rough count vs detailed roster".
 *    A hedged figure ("about 24", "40+"), a range ("17-18"), different years
 *    and different wording of the role never count.
 *  - stripSourceRefs: the prompt names sources S1, S2, …; the model copies
 *    them into values and explanations ("(per multiple sources including
 *    S8, S11)", "in the discovery call (S7)"). Broker-facing text never
 *    shows them: a ref inside brackets goes, a ref in a sentence becomes
 *    the source's name (never a private one's).
 *  - sameConflictByFigures: two rows describe one conflict when the finding's
 *    figure on each side appears in the other row (values or explanation)
 *    and they share a distinctive word — the check's "westlockProjectStatus"
 *    ($4.2M backlog incl. the $1.1M Westlock award) and the analysis's
 *    "Signed backlog (May 2025)" ($4.2M vs $3.1M; "$1.1M difference … Westlock").
 *
 * Pure — no I/O.
 */
import { numberTokens, tokensMatch, type NumTok } from "./discrepancy-filter";

// ── Like-for-like counts ────────────────────────────────────────────────

export interface CountMention {
  value: number;
  /** "licensed field technicians" as written. */
  phrase: string;
  /** Normalised phrase (lower-case, singular) — what is counted. */
  key: string;
  money: boolean;
  index: number;
  /** "24 licensed field technicians" / "$1,100,000 signed backlog" as written. */
  text: string;
  /** Narrowed to a subset by the words around it ("… from 2011-2014", "Nova Scotia 129 …"). */
  qualified?: boolean;
}

const QUALIFIER_AFTER_RE =
  /^\s*(?:from|with|needing|need|needs|that|which|who|in|at|on|for|older|newer|built|aged|dating|awaiting|pending|due|not|currently|still|under|over|of|per|outside|inside|excluding|excl\.?|among)\b/i;
// Capitalised words that open a clause without naming a subset.
const COMMON_CAPITALISED = new Set([
  "total", "the", "about", "approximately", "roughly", "around", "we", "they", "there", "our", "has", "have", "with",
  "employs", "currently", "now", "plus", "and", "includes", "including", "staff", "team", "headcount", "fleet", "has",
]);

const HEDGE_BEFORE_RE =
  /(?:~|≈|\babout|\bapprox\.?|\bapproximately|\baround|\broughly|\bover|\bmore than|\bunder|\bless than|\bfewer than|\bnearly|\balmost|\bestimated|\bsome|\bclose to|\bup to|\bat least|\bat most|\bno more than|\bat most|\babove|\bbelow|\bor so|\bmaybe|\bperhaps|\bprobably)\s*\$?\s*$/i;
const PHRASE_STOP = new Set([
  "and", "or", "plus", "of", "in", "at", "for", "with", "including", "incl", "per", "from", "to", "on", "as", "the", "a",
  "an", "by", "across", "who", "that", "which", "are", "is", "were", "was", "total", "each", "every", "approximately",
  "about", "but", "not", "than", "if", "when", "while", "since", "over", "under", "into", "out", "vs", "versus",
]);
const NON_COUNT_UNITS = new Set([
  "year", "yr", "month", "mo", "week", "wk", "day", "hour", "hr", "minute", "min", "second", "time", "sq", "ft", "square",
  "feet", "foot", "km", "mile", "metre", "meter", "kg", "lb", "ton", "tonne", "gallon", "litre", "liter", "percent", "pct",
  "dollar", "cent", "k", "m", "mm", "million", "thousand", "billion", "x", "st", "nd", "rd", "th", "am", "pm", "per",
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "fy", "q", "am", "pm",
]);
const singular = (w: string) => (w.length > 3 ? w.replace(/(?:ies)$/, "y").replace(/(?:sses)$/, "ss").replace(/(?<![su])s$/, "") : w);

/** Counted quantities (and labelled amounts) in a value, with what they count. */
export function countMentions(text: string): CountMention[] {
  const out: CountMention[] = [];
  const re = /(\$\s*)?(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)(?:\s*(k|mm|m|million|thousand|b|billion)\b)?(?![\d%])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const prev = text.slice(Math.max(0, start - 1), start);
    // Part of a range, a code, a ref or a date ("17-18", "Q-25-118", "S18", "3/4", "1.5").
    if (/[\d\-–/.#:A-Za-z]/.test(prev)) continue;
    const after = text.slice(re.lastIndex);
    if (/^\s*(?:[-–]\s*\d|to\s+\d|\+|%|percent\b|or\s+so\b|ish\b|\/)/i.test(after)) continue;
    if (HEDGE_BEFORE_RE.test(text.slice(Math.max(0, start - 18), start))) continue;
    const money = !!m[1];
    let value = parseFloat(m[2].replace(/,/g, ""));
    if (!Number.isFinite(value)) continue;
    const mag = (m[3] || "").toLowerCase();
    value *= ({ k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 } as Record<string, number>)[mag] ?? 1;
    // A year is not a count.
    if (!money && !mag && Number.isInteger(value) && value >= 1900 && value <= 2099) continue;
    if (!money && !Number.isInteger(value)) continue;
    // What it counts: the words right after it, up to a stop word or punctuation.
    const words: string[] = [];
    const wordRe = /^\s+([A-Za-z][A-Za-z'’-]*)/;
    let rest = after;
    for (let i = 0; i < 4; i++) {
      const w = rest.match(wordRe);
      if (!w) break;
      if (PHRASE_STOP.has(w[1].toLowerCase())) break;
      words.push(w[1]);
      rest = rest.slice(w[0].length);
    }
    if (words.length === 0) continue;
    const norm = words.map((w) => singular(w.toLowerCase().replace(/[’']s$/, "")));
    if (NON_COUNT_UNITS.has(norm[0])) continue;
    const phrase = words.join(" ");
    // A subset, not the whole count: "14 reefer trailers from 2011-2014
    // needing replacement", "46 reefer trailers with telematics", "Nova
    // Scotia 129 clients", "Oakville (only 62 members)".
    const clause = text.slice(0, start).split(/[.;:(\n]|,\s/).pop() ?? "";
    const before = clause.trim().split(/\s+/).filter(Boolean);
    const lastWord = before[before.length - 1] ?? "";
    const qualified =
      QUALIFIER_AFTER_RE.test(rest) ||
      /^(?:only|just|another|additional|extra|new|old|older|newer|remaining|other|former|current)$/i.test(lastWord) ||
      (/^[A-Z][a-z]+$/.test(lastWord) && before.length >= 1 && !COMMON_CAPITALISED.has(lastWord.toLowerCase()));
    out.push({
      value,
      phrase,
      key: norm.join(" "),
      money,
      index: start,
      text: `${m[0].trim()} ${phrase}`,
      qualified,
    });
  }
  return out;
}

function yearsNear(text: string, index: number): string[] {
  const window = text.slice(Math.max(0, index - 70), index + 90);
  return Array.from(new Set(window.match(/\b(?:19|20)\d{2}\b/g) ?? []));
}

/**
 * The first count in the claim that the evidence gives differently for the
 * same thing, or null. Money only for a labelled amount the two sides word
 * the same way ("$4.2M backlog" vs "$3.1M signed backlog" are different
 * things); counts and amounts both need a whole-number difference.
 */
export function likeForLikeCountConflict(claim: string, evidence: string): { claim: CountMention; evidence: CountMention } | null {
  const ev = countMentions(evidence);
  const head = (k: string) => k.split(" ").pop() ?? k;
  // Statements about different periods ("… at Dec 31, 2023" vs a 2024 claim).
  const yearsIn = (t: string) => new Set(t.match(/\b(?:19|20)\d{2}\b/g) ?? []);
  const yClaim = yearsIn(claim);
  const yEvidence = yearsIn(evidence);
  if (yClaim.size > 0 && yEvidence.size > 0 && !Array.from(yClaim).some((y) => yEvidence.has(y))) return null;
  for (const c of countMentions(claim)) {
    if (c.qualified) continue;
    const same = ev.filter((e) => e.key === c.key && e.money === c.money && !e.qualified);
    if (same.length === 0) continue;
    const equal = (a: number, b: number) => (c.money ? Math.abs(a - b) / Math.max(a, b) <= 0.005 : a === b);
    // The document also gives the seller's number for it, under any wording
    // of the same thing ("186 clients" vs "186 managed clients") — no conflict.
    if (ev.some((e) => head(e.key) === head(c.key) && e.money === c.money && equal(e.value, c.value))) continue;
    const e = same[0];
    // A miscount is close; a count several times larger or smaller is a
    // different subset ("3,100 members" vs "only 62 members" in one town).
    const ratio = Math.max(c.value, e.value) / Math.max(1, Math.min(c.value, e.value));
    if (ratio > 1.5) continue;
    // Different periods ("24 technicians in 2022" vs "22 (2024 roster)").
    const yc = yearsNear(claim, c.index);
    const ye = yearsNear(evidence, e.index);
    if (yc.length > 0 && ye.length > 0 && !yc.some((y) => ye.includes(y))) continue;
    return { claim: c, evidence: e };
  }
  return null;
}

// ── Source refs ──────────────────────────────────────────────────────────

const REF_LIST = String.raw`S\d{1,3}(?:\s*(?:,|and|&|\/|;)\s*S\d{1,3})*`;

/**
 * Removes (in a value) or names (in prose) the prompt's source refs.
 * `labelFor` gives a known ref's broker-facing name ("the premises lease",
 * "the call with the seller") or null for a private one; unknown "S7"-like
 * text is left alone (it isn't a ref we issued).
 */
export function stripSourceRefs(text: string, labelFor: (ref: string) => string | null | undefined, mode: "value" | "prose"): string {
  if (!text) return text;
  const known = (ref: string) => labelFor(ref) !== undefined;
  const isRefList = (s: string) => (s.match(/S\d{1,3}/g) ?? []).every(known);
  let out = text;
  // A bracketed note made of refs and filler — "(S7)", "(per S8)",
  // "(per multiple sources including S8, S11, S18, S21)" — goes entirely.
  out = out.replace(/\s*\(([^()]*)\)/g, (whole, inner: string) => {
    if (!/\bS\d{1,3}\b/.test(inner) || !isRefList(inner)) return whole;
    const leftover = inner
      .replace(new RegExp(String.raw`\b${REF_LIST}\b`, "g"), " ")
      .replace(/\b(?:per|see|source|sources|from|in|via|according to|including|incl\.?|multiple|several|both|and|the|documents?|refs?)\b/gi, " ")
      .replace(/[\s,;:.&/-]+/g, "");
    if (leftover === "") return "";
    return ` (${inner.replace(new RegExp(String.raw`\s*\b${REF_LIST}\b`, "g"), "").replace(/\s{2,}/g, " ").replace(/\s+([,;)])/g, "$1").replace(/(?:,\s*)+$/, "").trim()})`;
  });
  // "per multiple sources including S8, S11" / "per S8" / "from S7" outside brackets.
  out = out.replace(
    new RegExp(String.raw`\s*,?\s*\b(?:per|from|in|see|via|according to)\s+(?:(?:multiple|several|both)\s+sources?\s+(?:including\s+)?)?(${REF_LIST})\b`, "gi"),
    (whole, list: string) => {
      if (!isRefList(list)) return whole;
      if (mode === "value") return "";
      const refs = list.match(/S\d{1,3}/g) ?? [];
      const names = refs.map((r) => labelFor(r)).filter((n): n is string => !!n);
      if (names.length !== 1 || refs.length !== 1) return refs.length > 1 ? " according to several sources" : "";
      return ` in ${names[0]}`;
    },
  );
  // Any ref left in a sentence: prose names it, a value drops it.
  out = out.replace(new RegExp(String.raw`\b(${REF_LIST})\b`, "g"), (whole, list: string) => {
    if (!isRefList(list)) return whole;
    if (mode === "value") return "";
    const refs = list.match(/S\d{1,3}/g) ?? [];
    if (refs.length !== 1) return "several sources";
    return labelFor(refs[0]!) || "another source";
  });
  return out.replace(/\s{2,}/g, " ").replace(/\s+([,.;:)])/g, "$1").replace(/\(\s*\)/g, "").trim();
}

// ── The same conflict across rows ────────────────────────────────────────

// Units of time say how long, not what — "2 years" and "18 months" appear in
// half the rows on a deal (Harborview: Kyle's "2 years full-time" vs "18
// months firm" was matched to an unrelated turnover row by "Tier 2" and a
// "retention bonus at 18 months").
const TIME_UNITS = new Set(["year", "yr", "month", "mo", "week", "wk", "day", "hour", "hr", "minute", "min", "quarter", "time", "fy"]);

/** Figures that identify a conflict: amounts of $1,000+, percentages, counts of a named thing. */
function distinctiveFigures(text: string | null | undefined): NumTok[] {
  if (!text) return [];
  return numberTokens(text, { keepSourceLabel: true }).filter((t) => {
    if (t.year || t.durationYears) return false;
    if (t.pct) return true;
    if (isAmount(t)) return t.value >= 1000;
    const unit = t.unitWord.replace(/s$/, "");
    return unit.length >= 3 && !TIME_UNITS.has(unit) && t.value >= 2;
  });
}
const isAmount = (t: NumTok) => /\$|\d\s*(?:k|m|mm|million|thousand|b|billion)\b/i.test(t.raw);

/** The same figure of the same kind: % with %, an amount with an amount, a count of the same thing. */
function sameFigureKind(a: NumTok, b: NumTok): boolean {
  if (a.pct !== b.pct || isAmount(a) !== isAmount(b)) return false;
  if (!a.pct && !isAmount(a) && a.unitWord.replace(/s$/, "") !== b.unitWord.replace(/s$/, "")) return false;
  return tokensMatch({ ...a, approx: false }, { ...b, approx: false });
}

const COMMON_WORDS = new Set([
  "seller", "sellers", "document", "documents", "shows", "stated", "states", "state", "total", "value", "values", "amount",
  "figure", "figures", "which", "their", "there", "about", "approximately", "report", "reported", "source", "sources",
  "discrepancy", "conflict", "difference", "claims", "claimed", "based", "these", "those", "while", "where", "other",
  "financial", "statements", "statement", "interview", "includes", "including", "included", "number", "revenue", "status",
  "details", "current", "annual", "years", "months", "weeks", "email", "emails", "call", "calls", "confirm", "confirmed",
]);
function distinctiveWords(text: string): Set<string> {
  return new Set(
    text.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 5 && !COMMON_WORDS.has(w)),
  );
}

/**
 * Two rows describe one conflict under different names and sources: the
 * finding's figure on EACH side (two different figures) appears in the
 * other row, as the same kind of figure, and a distinctive word from one
 * row's NAME appears in the other row — the check's "westlockProjectStatus"
 * ($4.2M backlog incl. the $1.1M Westlock award) and the analysis's
 * "Signed backlog (May 2025)" ($4.2M vs $3.1M; "$1.1M … Westlock").
 */
export function sameConflictByFigures(
  item: { field: string; interviewValue?: string | null; documentValue?: string | null; aiExplanation?: string | null },
  other: { field: string; interviewValue?: string | null; documentValue?: string | null; resolvedValue?: string | null; aiExplanation?: string | null },
): boolean {
  const claim = distinctiveFigures(item.interviewValue);
  const evidence = distinctiveFigures(item.documentValue);
  if (claim.length === 0 || evidence.length === 0) return false;
  const otherText = [other.field, other.interviewValue, other.documentValue, other.resolvedValue, other.aiExplanation].filter(Boolean).join(" \n ");
  const theirs = distinctiveFigures(otherText);
  const has = (t: NumTok) => theirs.some((o) => sameFigureKind(t, o));
  const c = claim.find(has);
  const e = evidence.find(has);
  if (!c || !e) return false;
  // Two different figures (one per side) — the same number twice proves nothing.
  if (sameFigureKind(c, e)) return false;
  const itemText = [item.field, item.interviewValue, item.documentValue, item.aiExplanation].filter(Boolean).join(" ");
  const theirWords = distinctiveWords(otherText);
  const myWords = distinctiveWords(itemText);
  return (
    Array.from(distinctiveWords(item.field)).some((w) => theirWords.has(w)) ||
    Array.from(distinctiveWords(other.field)).some((w) => myWords.has(w))
  );
}
