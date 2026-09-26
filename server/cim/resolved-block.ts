/**
 * Resolved discrepancies → what the CIM writer (and any other consumer) must
 * treat as final. Replaces the old overlay that wrote `extractedInfo[d.field]`
 * — for descriptive or AI-invented field labels that added a label-named
 * pseudo-fact next to the stale one instead of correcting it.
 *
 * Rules:
 *  - A row whose factKey (or legacy `field`) is a real fact key overlays that
 *    fact under the SAME rules as the resolution's write-back
 *    (server/information/resolution-write.ts): never over a description the
 *    figure is only part of, never onto a fact that isn't the figure, and a
 *    headline and its by-year map together. The write-back already put the
 *    value on file; the overlay only matters for rows it couldn't write
 *    (older rows), and must never undo what it deliberately refused.
 *  - Latest wins: a fact (or map year) whose source is newer than the
 *    resolution — a later broker edit, a newer statement — is left as it is,
 *    and resolutions are applied oldest first, so the newest one on the same
 *    fact is what stands (deterministic, whatever order the rows come in).
 *  - Every resolved row still in force is also listed in a "RESOLVED — FINAL
 *    VALUES" block with the values it superseded, so narrative facts that
 *    still repeat a losing value are recognisably outdated. A row a later
 *    edit or resolution replaced is NOT listed (settleResolvedFacts marks
 *    it) — the block would otherwise overrule the newer figure by instruction.
 */
import type { Discrepancy } from "@shared/schema";
import { discrepancySideValue, discrepancyHasPrivateSide } from "@shared/discrepancy-sides";
import { numberTokens, tokensMatch } from "./discrepancy-filter";
import {
  targetForFactKey,
  planResolution,
  valueAtTarget,
  sourceAtTarget,
  overlayWrite,
  resolutionSourceExtras,
  targetRelatesToSides,
  sameFigure,
  RESOLVED_NOTE,
} from "../information/resolution-write";
import { HEADLINE_MAPS } from "../documents/merge-policy";

export interface ResolvedDiscrepancyNote {
  /** The discrepancy row it came from. */
  id?: string;
  /** Human label of what was reconciled (the discrepancy's field). */
  field: string;
  /** The extractedInfo key it resolved, when known. */
  factKey: string | null;
  /** Fiscal year for per-year maps, when known. */
  year: string | null;
  resolvedValue: string;
  /** The losing values (interview/document sides that differ from the result). */
  supersededValues: string[];
  /** When the broker resolved it (ISO) — the overlay's latest-wins order. */
  resolvedAt?: string | null;
  /** The row's source ("interview" check, "financial_analysis", "merge"). */
  source?: string | null;
  /**
   * The two sides as the write guards read them (does the fact hold this
   * figure; is it a description). A broker-private side is left out — it is
   * never carried into a consumer (the interview knowledge base spreads
   * these notes). Never rendered.
   */
  guardSides?: { interview?: string; document?: string };
  /** The resolved value came from the broker's own private side (see resolution-write). */
  fromPrivateSide?: boolean;
  /** Values earlier resolutions of the same fact settled on or ruled out (non-private) — the fact still "is" this figure. */
  priorValues?: string[];
  /** What became of it against the facts on file (settleResolvedFacts). */
  status?: ResolvedNoteStatus;
}

const FACT_KEY_RE = /^[a-z][A-Za-z0-9_]*$/;

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function isoOf(v: unknown): string | null {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Oldest resolution first; rows never resolved at a known time go first; ties keep their order. */
function byResolvedAt<T extends { resolvedAt?: string | null }>(list: T[]): T[] {
  return list
    .map((n, i) => ({ n, i, t: n.resolvedAt ? Date.parse(n.resolvedAt) : -Infinity }))
    .sort((a, b) => a.t - b.t || a.i - b.i)
    .map((x) => x.n);
}

export function resolvedNotes(rows: Discrepancy[]): ResolvedDiscrepancyNote[] {
  const out: ResolvedDiscrepancyNote[] = [];
  for (const d of rows) {
    const resolvedValue = clean(d.resolvedValue);
    if (!resolvedValue) continue;
    // "_none" = the broker kept it as a note only — no fact to overlay.
    const ownKey = FACT_KEY_RE.test(clean(d.factKey)) ? clean(d.factKey) : "";
    const factKey = ownKey || (!clean(d.factKey) && FACT_KEY_RE.test(clean(d.field)) ? clean(d.field) : "");
    const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ");
    // The side the broker accepted isn't superseded (its headline figure is
    // the resolved one), and the analysis's " — source" labels are dropped.
    const lead = numberTokens(resolvedValue)[0];
    const superseded = [discrepancySideValue(d, "interview"), discrepancySideValue(d, "document")].filter((v) => {
      if (!v || norm(v) === norm(resolvedValue)) return false;
      const first = numberTokens(v)[0];
      return !(lead && first && tokensMatch({ ...lead, approx: false }, { ...first, approx: false }));
    });
    const priv = discrepancyHasPrivateSide(d);
    const guardSides: { interview?: string; document?: string } = {};
    if (!priv.interview && clean(d.interviewValue)) guardSides.interview = clean(d.interviewValue);
    if (!priv.document && clean(d.documentValue)) guardSides.document = clean(d.documentValue);
    out.push({
      id: d.id,
      field: clean(d.field) || factKey,
      factKey: factKey || null,
      year: clean(d.factYear) || null,
      resolvedValue,
      supersededValues: Array.from(new Set(superseded)),
      resolvedAt: isoOf(d.resolvedAt),
      source: d.source ?? null,
      guardSides,
      fromPrivateSide: Object.keys(resolutionSourceExtras(d, resolvedValue)).length > 0,
    });
  }
  // One final value per thing: when the broker settled the same thing more
  // than once, only the newest resolution is final — the block must never
  // list two "final" figures for one thing. Two resolutions of one fact are
  // the same thing when the fact is a headline figure (revenue 2024 has one
  // value), when they carry the same name, or when a figure of one appears
  // in the other; "Licensed field technicians" (24 vs 22 → 22) and "Total
  // employee headcount" (36 vs 28 → 36), both linked to employees, are two.
  // The newest one remembers the values the earlier ones settled on and
  // ruled out, so the overlay still recognises the fact as this figure.
  const ordered = byResolvedAt(out);
  const finals: ResolvedDiscrepancyNote[] = [];
  const replaced = new Set<ResolvedDiscrepancyNote>();
  const prior = new Map<ResolvedDiscrepancyNote, string[]>();
  ordered.forEach((n) => {
    if (!n.factKey) return;
    for (const before of finals) {
      if (replaced.has(before) || !sameResolvedThing(before, n)) continue;
      replaced.add(before);
      // (Never a value from the broker's private side — these notes reach the interview's knowledge base.)
      prior.set(n, [...(prior.get(n) ?? []), ...(prior.get(before) ?? []), ...(before.fromPrivateSide ? [] : [before.resolvedValue]), ...Object.values(before.guardSides ?? {})]);
    }
    finals.push(n);
  });
  return ordered
    .filter((n) => !replaced.has(n))
    .map((n) => {
      const p = prior.get(n);
      return p && p.length > 0 ? { ...n, priorValues: Array.from(new Set(p)) } : n;
    });
}

const HEADLINE_FAMILY = new Map(HEADLINE_MAPS.flatMap((p) => [[p.head, p.head], [p.map, p.head]] as Array<[string, string]>));

/** Two resolutions settle the same thing (see resolvedNotes). */
function sameResolvedThing(a: ResolvedDiscrepancyNote, b: ResolvedDiscrepancyNote): boolean {
  if (!a.factKey || !b.factKey) return false;
  const figures = (n: ResolvedDiscrepancyNote) =>
    [n.resolvedValue, ...Object.values(n.guardSides ?? {})].flatMap((v) => numberTokens(v)).filter((t) => !t.year);
  const shareFigure = () => {
    const fb = figures(b);
    return figures(a).some((t) => fb.some((o) => tokensMatch({ ...t, approx: false }, { ...o, approx: false })));
  };
  // A headline figure and its by-year map are one fact: the same year (or
  // a headline row with no year that settled the same figures) is one thing.
  const family = HEADLINE_FAMILY.get(a.factKey);
  if (family && family === HEADLINE_FAMILY.get(b.factKey)) {
    if ((a.year ?? "") === (b.year ?? "")) return true;
    return (!a.year || !b.year) && shareFigure();
  }
  if (a.factKey !== b.factKey || (a.year ?? "") !== (b.year ?? "")) return false;
  const name = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  return name(a.field) === name(b.field) || shareFigure();
}

const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.$]+/g, " ").replace(/\s+/g, " ").trim();

/**
 * The same leading figure, exactly ("$31.5M" = "$31,500,000", "22%" =
 * "22.0%") — an edit from $31,500,000 to $31,450,000 is a new figure, however
 * close (sameFigure's rounding slack is for matching sources, not edits).
 */
function sameFigureExactly(a: string, b: string): boolean {
  if (flat(a) === flat(b)) return true;
  if (!sameFigure(a, b)) return false;
  const fa = numberTokens(a).find((t) => !t.year);
  const fb = numberTokens(b).find((t) => !t.year);
  return !!fa && !!fb && Math.abs(fa.value - fb.value) < 0.5;
}

/** The value on file states the resolved figure (the write happened, or a rewrite kept it). */
function holdsResolved(cur: unknown, resolved: string): boolean {
  if (typeof cur !== "string" || !cur.trim()) return false;
  return ` ${flat(cur)} `.includes(` ${flat(resolved)} `) || sameFigureExactly(cur, resolved);
}

/**
 * Apply the broker's resolutions to a copy of the facts and say what became
 * of each one:
 *  - applied: written onto its fact (or already there — the write-back did it);
 *  - superseded: the fact now holds a different value set AFTER the
 *    resolution — a later broker edit (Pacific: revenue resolved at
 *    $31,500,000, then edited on the Information tab to $31,250,000) or a
 *    newer resolution of the same fact. Latest wins: the fact on file
 *    stands, and the note is no longer a "final value" anywhere;
 *  - not_written: the write rules refused it (a description the figure is
 *    only part of, or a fact that isn't the figure) — the fact on file is
 *    NOT the broker's value, though the note still marks what it replaces;
 *  - unlinked: no fact key — a final value by name only.
 * Resolutions are applied oldest first (deterministic, whatever order the
 * rows come in). `apply: false` for a note judges it without writing it
 * (the interview never overlays a value from the broker's private side).
 */
export type ResolvedNoteStatus = "applied" | "superseded" | "not_written" | "unlinked";

export function settleResolvedFacts(
  extractedInfo: Record<string, unknown>,
  notes: ResolvedDiscrepancyNote[],
  opts: { apply?: (n: ResolvedDiscrepancyNote) => boolean } = {},
): { facts: Record<string, unknown>; notes: ResolvedDiscrepancyNote[] } {
  const out: Record<string, unknown> = structuredClone(extractedInfo);
  const status = new Map<ResolvedDiscrepancyNote, ResolvedNoteStatus>();
  // Which note last wrote each target, and what — a newer note writing a
  // different value there supersedes it.
  const writer = new Map<string, { note: ResolvedDiscrepancyNote; value: string }>();
  for (const n of byResolvedAt(notes)) {
    if (!n.factKey || !n.resolvedValue) {
      status.set(n, "unlinked");
      continue;
    }
    const target = targetForFactKey(out, n.factKey, n.year);
    if (!target) {
      status.set(n, "not_written");
      continue;
    }
    const row = {
      field: n.field,
      factKey: n.factKey,
      factYear: n.year,
      resolvedValue: n.resolvedValue,
      interviewValue: n.guardSides?.interview ?? null,
      documentValue: n.guardSides?.document ?? null,
      source: n.source ?? null,
    };
    // A fact holding what an earlier resolution of it settled or ruled out is this figure too.
    const relatesToPrior = (n.priorValues ?? []).some((v) => targetRelatesToSides(out, target, { interviewValue: v, documentValue: null }));
    const plan = planResolution(out, target, row, { brokerChoseFact: relatesToPrior });
    const targets = plan.kind === "write" ? plan.writes.map((w) => ({ key: w.key, ...(w.sub ? { sub: w.sub } : {}) })) : [target];
    // Latest wins: a value set after this resolution that isn't the
    // resolved figure stands — on the fact, its year, or its pair. A source
    // merely re-stating a value this resolution ruled out (a reprocessed
    // document) is not newer information; the broker's own edit always is.
    const resolvedAt = n.resolvedAt ? Date.parse(n.resolvedAt) : NaN;
    const ruledOut = [...n.supersededValues, ...Object.values(n.guardSides ?? {})].filter((v) => !sameFigureExactly(v, n.resolvedValue));
    const newer = targets.some((at) => {
      const cur = valueAtTarget(extractedInfo, at);
      if (cur === undefined || cur === null || cur === "" || holdsResolved(cur, n.resolvedValue)) return false;
      const src = sourceAtTarget(extractedInfo, at);
      const srcAt = Date.parse(src?.at ?? "");
      if (!(Number.isFinite(resolvedAt) && Number.isFinite(srcAt) && srcAt > resolvedAt)) return false;
      return src?.source === "broker" || !ruledOut.some((v) => sameFigureExactly(String(cur), v));
    });
    if (newer) {
      status.set(n, "superseded");
      continue;
    }
    if (plan.kind !== "write") {
      status.set(n, "not_written");
      continue;
    }
    status.set(n, "applied");
    const apply = opts.apply ? opts.apply(n) : true;
    for (const w of plan.writes) {
      const id = `${w.key}|${w.sub ?? ""}`;
      const before = writer.get(id);
      if (before && before.note !== n && flat(before.value) !== flat(w.value)) status.set(before.note, "superseded");
      writer.set(id, { note: n, value: w.value });
      if (!apply) continue;
      const at = { key: w.key, ...(w.sub ? { sub: w.sub } : {}) };
      const cur = valueAtTarget(out, at);
      if (typeof cur === "string" && cur.trim() === w.value) continue;
      overlayWrite(out, w, {
        source: "broker",
        note: RESOLVED_NOTE,
        ...(n.resolvedAt ? { at: n.resolvedAt } : {}),
        ...(n.fromPrivateSide ? { brokerOnly: true, acceptedByBroker: true } : {}),
      });
    }
  }
  return { facts: out, notes: notes.map((n) => ({ ...n, status: status.get(n) ?? "unlinked" })) };
}

/**
 * Apply resolved values that name a real fact key onto a copy of the facts,
 * under the write-back's rules (see the header). Per-year rows update that
 * year inside a map value, and the headline / by-year pair moves together.
 */
export function overlayResolvedFacts(
  extractedInfo: Record<string, unknown>,
  notes: ResolvedDiscrepancyNote[],
): Record<string, unknown> {
  return settleResolvedFacts(extractedInfo, notes).facts;
}

/** The notes that are still final values (a later edit or resolution hasn't replaced them). */
export function currentResolvedNotes(notes: ResolvedDiscrepancyNote[]): ResolvedDiscrepancyNote[] {
  return notes.filter((n) => n.status !== "superseded");
}

export const RESOLVED_BLOCK_HEADING =
  "--- RESOLVED DISCREPANCIES — FINAL VALUES (the broker reconciled these; any other figure or wording for the same thing — anywhere above — is outdated and must not be used, nor any claim built on it) ---";

/** "Revenue (2024)" — the year once, however the field names it. */
export function resolvedNoteLabel(n: Pick<ResolvedDiscrepancyNote, "field" | "year">, name: string = n.field): string {
  return n.year && !name.includes(n.year) ? `${name} (${n.year})` : name;
}

export function renderResolvedBlock(notes: ResolvedDiscrepancyNote[]): string {
  // A resolution a later edit or resolution replaced is not final any more —
  // listing it would override the broker's newer figure by instruction.
  const current = currentResolvedNotes(notes);
  if (current.length === 0) return "";
  // The ruled-out values are NOT quoted: a writer shown "replaces: ~18%
  // (under 20%)" wrote "Largest customer <20%" into Investment Highlights.
  // Stating that other figures exist is enough to mark them outdated.
  const lines = current.map((n) => {
    const old = n.supersededValues.length ? " (final — earlier, different figures for this are wrong)" : "";
    return `${resolvedNoteLabel(n)}: ${n.resolvedValue}${old}`;
  });
  return [RESOLVED_BLOCK_HEADING, ...lines].join("\n");
}
