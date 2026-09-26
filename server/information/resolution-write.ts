/**
 * What a discrepancy resolution may write, and exactly what it writes — ONE
 * set of rules shared by the write-back (PATCH /api/discrepancies/:id →
 * applyResolutionToInfo in facts.ts) and the read-time overlay every CIM,
 * DD and interview input applies (server/cim/resolved-block.ts). Before,
 * the write refused a narrative fact or a fact that isn't the figure, and
 * the overlay wrote the bare value over it anyway.
 *
 * Rules:
 *  - The target is the row's factKey (and factYear for a by-year map).
 *  - A model-chosen fact must hold the figure in question (either side's
 *    value, or empty) — "22 licensed technicians" never replaces
 *    "36 employees plus owner". The broker's own pick is trusted.
 *  - A description the figure is only part of is never overwritten with a
 *    bare value ("Largest customer Alderbrook is about 18% of revenue (under
 *    20%); no other customer over 10%" resolved as "22.0%"): the broker
 *    reviews a rewrite instead (resolution-propagation.ts).
 *  - A headline figure and its by-year map are one fact: resolving
 *    revenueByYear 2024 also corrects annualRevenue when the headline is
 *    2024's figure (or states the ruled-out figure), and resolving the
 *    headline also corrects its year in the map.
 *  - A value the broker took from their own private material (a CRM note,
 *    a broker-only file) is written as private provenance: brokerOnly (the
 *    seller view and the interview filter on it) + acceptedByBroker (the
 *    broker vouched for it, so the CIM may use it).
 *
 * Pure — no I/O, no storage import (resolved-block.ts is imported by the
 * interview knowledge base).
 */
import {
  isFactKey,
  getFieldSources,
  setFieldSource,
  repairCharIndexedValue,
  resolvedYearSources,
  summariseMapSource,
  isUntrackedSource,
  type FieldSource,
} from "../interview/info-merger";
import { HEADLINE_MAPS, headlineYearOnFile, periodYear } from "../documents/merge-policy";
import { numberTokens, tokensMatch } from "../cim/discrepancy-filter";
import { discrepancyHasPrivateSide, discrepancySideValue, mentionsPrivateSource } from "@shared/discrepancy-sides";

type Info = Record<string, unknown>;

/** Where a discrepancy resolution lands: a fact, or one year of a map fact. */
export interface DiscrepancyTarget {
  key: string;
  /** Year (sub-key) of a map fact — "2024" of revenueByYear. */
  sub?: string;
}

/** The parts of a discrepancy row the write rules read. */
export interface ResolutionRow {
  field?: string | null;
  factKey?: string | null;
  factYear?: string | null;
  resolvedValue?: string | null;
  interviewValue?: string | null;
  documentValue?: string | null;
  source?: string | null;
  sideSources?: unknown;
}

export const RESOLVED_NOTE = "Resolved discrepancy";

export function isPlainMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

const FACT_KEY_SHAPE = /^[a-z][A-Za-z0-9]*$/;

/** "$1,894,000 — 2024 P&L" → "$1,894,000" (the financial analysis appends where a value came from). */
export function bareDiscrepancyValue(v: string): string {
  const idx = v.indexOf(" — ");
  return (idx > 0 ? v.slice(0, idx) : v).trim();
}

const normText = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.$]+/g, " ").replace(/\s+/g, " ").trim();

/** Two values state the same thing: the same text, or the same leading figure (hedges ignored). */
export function sameFigure(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = bareDiscrepancyValue(a || "");
  const y = bareDiscrepancyValue(b || "");
  if (!x || !y) return false;
  if (normText(x) === normText(y)) return true;
  const fx = numberTokens(x).find((t) => !t.year);
  const fy = numberTokens(y).find((t) => !t.year);
  return !!fx && !!fy && fx.pct === fy.pct && tokensMatch({ ...fx, approx: false }, { ...fy, approx: false });
}

/** The fact a real-shaped factKey names (the year of a by-year map when the row gives one). */
export function targetForFactKey(info: Info, factKey: string | null | undefined, factYear?: string | null): DiscrepancyTarget | null {
  const key = (factKey || "").trim();
  if (!key || !FACT_KEY_SHAPE.test(key) || !isFactKey(key)) return null;
  const year = (factYear || "").trim().replace(/^FY\s*/i, "");
  const cur = repairCharIndexedValue(info[key]);
  const mapLike = cur === undefined || cur === null || cur === "" ? key === "revenueByYear" || /ByYear$/.test(key) : isPlainMap(cur);
  if (year && mapLike) return { key, sub: year };
  return { key };
}

/** The value a target holds now (one year of a map, or the fact). */
export function valueAtTarget(info: Info, target: DiscrepancyTarget): unknown {
  const raw = repairCharIndexedValue(info[target.key]);
  return target.sub ? (isPlainMap(raw) ? raw[target.sub] : undefined) : raw;
}

/** The recorded source of a target (a map year's own source). */
export function sourceAtTarget(info: Info, target: DiscrepancyTarget): FieldSource | undefined {
  const src = getFieldSources(info)[target.key];
  if (!target.sub) return src;
  const map = repairCharIndexedValue(info[target.key]);
  return isPlainMap(map) && src ? resolvedYearSources(src, map)[target.sub] : undefined;
}

/** The two sides' values without their " — source" labels. */
export function sideValues(d: ResolutionRow): string[] {
  return [d.interviewValue, d.documentValue].map((v) => bareDiscrepancyValue(v || "")).filter(Boolean);
}

/**
 * A model-chosen fact key must hold the figure in question: the fact is
 * empty, or states one side's value (or a figure from it). "22 licensed
 * technicians" resolved into employees = "36 employees plus owner" is the
 * wrong fact — the broker is asked instead of the headcount being lost.
 */
export function targetRelatesToSides(info: Info, target: DiscrepancyTarget, d: Pick<ResolutionRow, "interviewValue" | "documentValue">): boolean {
  const cur = valueAtTarget(info, target);
  if (cur === undefined || cur === null || cur === "") return true;
  const text = typeof cur === "string" ? cur : JSON.stringify(cur);
  const sides = sideValues(d);
  if (sides.length === 0) return true; // nothing to compare against (an answered question)
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.]+/g, " ").trim();
  if (sides.some((v) => norm(text).includes(norm(v)) || norm(v).includes(norm(text)))) return true;
  const curNums = numberTokens(text, { keepSourceLabel: true }).filter((t) => !t.year);
  return sides.some((v) => numberTokens(v).filter((t) => !t.year).some((s) => curNums.some((c) => tokensMatch(c, s))));
}

// Words that carry no subject — what's left says what else a fact describes.
const FILLER_WORDS = new Set([
  "the", "and", "for", "with", "per", "its", "this", "that", "these", "those", "from", "are", "was", "were", "has", "have",
  "had", "been", "about", "approximately", "approx", "around", "roughly", "under", "over", "less", "more", "than", "nearly",
  "almost", "some", "each", "plus", "also", "total", "not", "any", "all", "only", "now", "which", "who", "into", "our",
  "their", "his", "her", "per", "via", "est", "estimated", "value", "figure", "amount", "number", "one", "two", "three",
]);
const stem = (w: string) => w.replace(/(?:ies|es|s)$/, "");
function contentWords(s: string): Set<string> {
  return new Set(
    s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 3 && !FILLER_WORDS.has(w)).map(stem),
  );
}
const HEADLINE_KEYS = new Set(HEADLINE_MAPS.map((p) => p.head));

/**
 * The fact is a description the resolved figure is only part of, so a
 * bare value must not replace it:
 *  - a long description (over 160 characters) and a much shorter value, or
 *  - a shorter one that says more than the conflict — four or more words
 *    beyond the figure ("Largest customer Alderbrook is about 18% of
 *    revenue; no other customer over 10%"), or two words and a figure the
 *    conflict isn't about (the 10%).
 * Parenthesised notes and " — source" labels don't count ("$1,820,000
 * (FY2024 per statements)" is a figure). A headline figure (revenue,
 * EBITDA, SDE…) is never a description.
 */
export function isNarrativeTarget(info: Info, target: DiscrepancyTarget, resolved: string, sides: string[] = []): boolean {
  if (target.sub) return false;
  const cur = repairCharIndexedValue(info[target.key]);
  if (typeof cur !== "string") return false;
  if (cur.length > 160 && resolved.length < cur.length * 0.4) return true;
  if (HEADLINE_KEYS.has(target.key)) return false;
  // Already says the resolved value (the write happened) — nothing to protect.
  if (cur.trim() === resolved.trim()) return false;
  const core = bareDiscrepancyValue(cur.replace(/\([^()]*\)/g, " ")).replace(/\s+/g, " ");
  const known = new Set<string>();
  for (const s of [resolved, ...sides]) contentWords(bareDiscrepancyValue(s).replace(/\([^()]*\)/g, " ")).forEach((w) => known.add(w));
  const extra = Array.from(contentWords(core)).filter((w) => !known.has(w));
  if (extra.length >= 4) return true;
  if (extra.length < 2) return false;
  const stated = [resolved, ...sides].flatMap((s) => numberTokens(s)).filter((t) => !t.year);
  const unrelated = numberTokens(core).filter((t) => !t.year && !stated.some((s) => tokensMatch({ ...s, approx: false }, { ...t, approx: false })));
  return unrelated.length > 0;
}

/**
 * The broker settled on the value of their own private side (a CRM note, a
 * broker-only file) — not a value the seller-side or shared source also
 * states. Written as private provenance so the seller interview never sees it.
 */
export function resolvedFromPrivateSide(d: ResolutionRow, resolved: string): boolean {
  if (mentionsPrivateSource(resolved)) return true;
  const priv = discrepancyHasPrivateSide(d);
  if (!priv.interview && !priv.document) return false;
  const iv = discrepancySideValue(d, "interview");
  const dv = discrepancySideValue(d, "document");
  const privateMatch = (priv.interview && sameFigure(iv, resolved)) || (priv.document && sameFigure(dv, resolved));
  const publicMatch = (!priv.interview && sameFigure(iv, resolved)) || (!priv.document && sameFigure(dv, resolved));
  return privateMatch && !publicMatch;
}

/** Provenance extras for a resolution's writes. */
export function resolutionSourceExtras(d: ResolutionRow, resolved: string): Partial<FieldSource> {
  return resolvedFromPrivateSide(d, resolved) ? { brokerOnly: true, acceptedByBroker: true } : {};
}

export interface ResolutionWrite {
  key: string;
  sub?: string;
  value: string;
  /** Fiscal period to record with a headline write (its year's period end). */
  period?: string;
  /** The other half of a headline / by-year pair (not the row's own target). */
  paired?: boolean;
}

/**
 * The other half of a headline figure and its by-year map, when the
 * resolution changes a figure both hold:
 *  - a map year → the headline, when the headline is that year's figure
 *    (its period, tag or matching map year) or, its year unknown, states a
 *    ruled-out value;
 *  - the headline → its year in the map (the row's factYear, else the
 *    headline's year on file), when that year states a ruled-out value, is
 *    empty for a row that names the year, or is the headline's own year.
 * Never creates a map that doesn't exist.
 */
export function pairedWrite(info: Info, target: DiscrepancyTarget, resolved: string, d: ResolutionRow): ResolutionWrite | null {
  const losing = sideValues(d).filter((v) => !sameFigure(v, resolved));
  const sources = getFieldSources(info);
  if (target.sub) {
    const pair = HEADLINE_MAPS.find((p) => p.map === target.key);
    if (!pair) return null;
    const head = repairCharIndexedValue(info[pair.head]);
    if (typeof head !== "string" || !head.trim() || sameFigure(head, resolved)) return null;
    const map = repairCharIndexedValue(info[target.key]);
    const headYear = headlineYearOnFile(head, sources[pair.head], isPlainMap(map) ? map : {});
    const matchesYear = headYear === target.sub;
    if (matchesYear || (!headYear && losing.some((l) => sameFigure(head, l)))) {
      const prevPeriod = sources[pair.head]?.period;
      return { key: pair.head, value: resolved, paired: true, ...(prevPeriod && periodYear(prevPeriod) === target.sub ? { period: prevPeriod } : {}) };
    }
    return null;
  }
  const pair = HEADLINE_MAPS.find((p) => p.head === target.key);
  if (!pair) return null;
  const map = repairCharIndexedValue(info[pair.map]);
  if (!isPlainMap(map)) return null;
  const named = (d.factYear || "").trim().replace(/^FY\s*/i, "");
  const head = repairCharIndexedValue(info[target.key]);
  const headYear = headlineYearOnFile(head, sources[target.key], map);
  const year = /^(?:19|20)\d{2}$/.test(named) ? named : headYear;
  if (!year) return null;
  const cur = map[year];
  const empty = cur === undefined || cur === null || cur === "";
  if (!empty && sameFigure(String(cur), resolved)) return null;
  if (empty ? year === named : typeof cur === "string" && (year === named || year === headYear || losing.some((l) => sameFigure(cur, l)))) {
    return { key: pair.map, sub: year, value: resolved, paired: true };
  }
  return null;
}

export type ResolutionPlan =
  | { kind: "write"; target: DiscrepancyTarget; writes: ResolutionWrite[] }
  | { kind: "narrative"; target: DiscrepancyTarget }
  | { kind: "needs_mapping" }
  | { kind: "none" };

/**
 * What resolving `d` onto `target` writes — the same decision for the
 * write-back and the overlay.
 *  - brokerChoseFact: the broker picked this fact in "Which fact should this
 *    update?" — trusted as the right fact (never as licence to overwrite a
 *    description).
 */
export function planResolution(
  info: Info,
  target: DiscrepancyTarget,
  d: ResolutionRow,
  opts: { brokerChoseFact?: boolean } = {},
): ResolutionPlan {
  const resolved = (d.resolvedValue || "").trim();
  if (!resolved) return { kind: "none" };
  if (!opts.brokerChoseFact && d.factKey && d.source !== "merge" && !targetRelatesToSides(info, target, d)) return { kind: "needs_mapping" };
  if (isNarrativeTarget(info, target, resolved, sideValues(d))) return { kind: "narrative", target };
  const writes: ResolutionWrite[] = [{ key: target.key, ...(target.sub ? { sub: target.sub } : {}), value: resolved }];
  const paired = pairedWrite(info, target, resolved, d);
  if (paired) writes.push(paired);
  return { kind: "write", target, writes };
}

/**
 * Read-time form of a write: sets the value and records the broker's
 * provenance on a COPY of the facts (the overlay never saves). Map years
 * keep every other year's own source.
 */
export function overlayWrite(info: Info, w: ResolutionWrite, src: FieldSource): void {
  if (w.sub) {
    const raw = repairCharIndexedValue(info[w.key]);
    if (raw !== undefined && raw !== null && raw !== "" && !isPlainMap(raw)) return;
    const map: Record<string, unknown> = isPlainMap(raw) ? { ...raw } : {};
    const prev = getFieldSources(info)[w.key];
    const legacy: FieldSource = { source: "system" };
    const years: Record<string, FieldSource> = prev && !isUntrackedSource(prev)
      ? resolvedYearSources(prev, map)
      : Object.fromEntries(Object.keys(map).map((y) => [y, legacy]));
    map[w.sub] = w.value;
    years[w.sub] = src;
    info[w.key] = map;
    const summary = summariseMapSource(years);
    if (summary) setFieldSource(info, w.key, summary);
    return;
  }
  info[w.key] = w.value;
  setFieldSource(info, w.key, { ...src, ...(w.period ? { period: w.period } : {}) });
}
