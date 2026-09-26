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
 *  - Every resolved row is also listed in a "RESOLVED — FINAL VALUES" block
 *    with the values it superseded, so narrative facts that still repeat a
 *    losing value are recognisably outdated.
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
  RESOLVED_NOTE,
} from "../information/resolution-write";

export interface ResolvedDiscrepancyNote {
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
  // One final value per fact: when the broker settled the same fact (and
  // year) more than once, only the newest resolution is final — the block
  // must never list two "final" figures for one thing.
  // The newest one remembers the values the earlier ones settled on and
  // ruled out, so the overlay still recognises the fact as this figure.
  const ordered = byResolvedAt(out);
  const latest = new Map<string, ResolvedDiscrepancyNote>();
  const prior = new Map<string, string[]>();
  ordered.forEach((n) => {
    if (!n.factKey) return;
    const k = `${n.factKey}|${n.year ?? ""}`;
    const before = latest.get(k);
    // (Never a value from the broker's private side — these notes reach the interview's knowledge base.)
    if (before) prior.set(k, [...(prior.get(k) ?? []), ...(before.fromPrivateSide ? [] : [before.resolvedValue]), ...Object.values(before.guardSides ?? {})]);
    latest.set(k, n);
  });
  return ordered
    .filter((n) => !n.factKey || latest.get(`${n.factKey}|${n.year ?? ""}`) === n)
    .map((n) => {
      const p = n.factKey ? prior.get(`${n.factKey}|${n.year ?? ""}`) : undefined;
      return p && p.length > 0 ? { ...n, priorValues: Array.from(new Set(p)) } : n;
    });
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
  const out: Record<string, unknown> = structuredClone(extractedInfo);
  for (const n of byResolvedAt(notes)) {
    if (!n.factKey || !n.resolvedValue) continue;
    const target = targetForFactKey(out, n.factKey, n.year);
    if (!target) continue;
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
    if (plan.kind !== "write") continue;
    const resolvedAt = n.resolvedAt ? Date.parse(n.resolvedAt) : NaN;
    for (const w of plan.writes) {
      const at = { key: w.key, ...(w.sub ? { sub: w.sub } : {}) };
      const cur = valueAtTarget(out, at);
      if (typeof cur === "string" && cur.trim() === w.value) continue;
      // Latest wins: set (by anyone) after this resolution — leave it.
      const src = sourceAtTarget(extractedInfo, at);
      const srcAt = src?.at ? Date.parse(src.at) : NaN;
      if (Number.isFinite(resolvedAt) && Number.isFinite(srcAt) && srcAt > resolvedAt) continue;
      overlayWrite(out, w, {
        source: "broker",
        note: RESOLVED_NOTE,
        ...(n.resolvedAt ? { at: n.resolvedAt } : {}),
        ...(n.fromPrivateSide ? { brokerOnly: true, acceptedByBroker: true } : {}),
      });
    }
  }
  return out;
}

export const RESOLVED_BLOCK_HEADING =
  "--- RESOLVED DISCREPANCIES — FINAL VALUES (the broker reconciled these; any other figure or wording for the same thing — anywhere above — is outdated and must not be used, nor any claim built on it) ---";

export function renderResolvedBlock(notes: ResolvedDiscrepancyNote[]): string {
  if (notes.length === 0) return "";
  // The ruled-out values are NOT quoted: a writer shown "replaces: ~18%
  // (under 20%)" wrote "Largest customer <20%" into Investment Highlights.
  // Stating that other figures exist is enough to mark them outdated.
  const lines = notes.map((n) => {
    const what = n.year ? `${n.field} (${n.year})` : n.field;
    const old = n.supersededValues.length ? " (final — earlier, different figures for this are wrong)" : "";
    return `${what}: ${n.resolvedValue}${old}`;
  });
  return [RESOLVED_BLOCK_HEADING, ...lines].join("\n");
}
