/**
 * Resolved discrepancies → what the CIM writer (and any other consumer) must
 * treat as final. Replaces the old overlay that wrote `extractedInfo[d.field]`
 * — for descriptive or AI-invented field labels that added a label-named
 * pseudo-fact next to the stale one instead of correcting it.
 *
 * Rules:
 *  - A row whose factKey (or legacy `field`) is a real fact key overlays that
 *    key, as before (the broker's accepted value wins).
 *  - Every resolved row is also listed in a "RESOLVED — FINAL VALUES" block
 *    with the values it superseded, so narrative facts that still repeat a
 *    losing value are recognisably outdated.
 */
import type { Discrepancy } from "@shared/schema";
import { discrepancySideValue } from "@shared/discrepancy-sides";
import { numberTokens, tokensMatch } from "./discrepancy-filter";

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
}

const FACT_KEY_RE = /^[a-z][A-Za-z0-9_]*$/;

function clean(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
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
    out.push({
      field: clean(d.field) || factKey,
      factKey: factKey || null,
      year: clean(d.factYear) || null,
      resolvedValue,
      supersededValues: Array.from(new Set(superseded)),
    });
  }
  return out;
}

/**
 * Apply resolved values that name a real fact key onto a copy of the facts.
 * Per-year rows (factYear) update that year inside a map value.
 */
export function overlayResolvedFacts(
  extractedInfo: Record<string, unknown>,
  notes: ResolvedDiscrepancyNote[],
): Record<string, unknown> {
  const out = { ...extractedInfo };
  for (const n of notes) {
    if (!n.factKey) continue;
    if (n.year) {
      const cur = out[n.factKey];
      if (cur && typeof cur === "object" && !Array.isArray(cur)) {
        out[n.factKey] = { ...(cur as Record<string, unknown>), [n.year]: n.resolvedValue };
      }
      continue;
    }
    out[n.factKey] = n.resolvedValue;
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
