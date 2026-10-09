/**
 * figure-strings — the one privacy pipeline every buyer-bound string of the
 * figure layer goes through (spec D23): figure labels, "what's in it" parts,
 * the tax-return line labels (`sourceLabel`), note texts, the "as issued"
 * line and the key terms.
 *
 * Pure: the screening itself is passed in (`StringScreen`) — on the server
 * it is built from the deal's held / keep-out names, staff names, the
 * staff-private screen and the sensitive-detail check (server/cim/figures/
 * serve.ts screenFor), so a later keep-out request takes effect at the next
 * view without a rebuild. The browser preview never needs it (broker side).
 *
 * Rules:
 *   - an individual pay line (owner compensation, a salary that names a
 *     person) is merged into one neutral part, "Wages and salaries";
 *   - a part whose label fails becomes "Other costs";
 *   - a failing label, sourceLabel or "as issued" line is dropped;
 *   - a failing note is dropped (the figure then shows plain);
 *   - a failing key term is dropped.
 */
import type { FigureLayer, FigureNoteView, FigureView } from "./figure-layer";

export interface StringScreen {
  /** True when the text may reach a buyer. */
  keep(text: string): boolean;
  /** An individual's pay (merged into "Wages and salaries"). Defaults to `isIndividualPayLine`. */
  isPayLine?(label: string): boolean;
}

export const WAGES_LABEL = "Wages and salaries";
export const OTHER_COSTS_LABEL = "Other costs";

const PAY_WORDS = /\b(?:salar(?:y|ies)|wages?|compensation|remuneration|pay\b|payroll|bonus(?:es)?|management fees?|draws?)\b/i;
const PERSONAL = /\b(?:owner'?s?|shareholders?'?|officers?'?|directors?'?|president|ceo|founder'?s?|spouse|wife|husband|son|daughter|family|related[- ]part(?:y|ies)|principal'?s?|partner'?s?)\b/i;
/** "Salary — Daniel Okafor, dispatcher", "Wages (Tony Moretti)": a person's name in a pay label. */
const NAMED = /(?:[—–:(,-]\s*|\bto\s+)(?:Dr\.?\s+)?[A-Z][a-z]+(?:[-'][A-Z][a-z]+)?\s+[A-Z][a-z]+/;

/** An individual's pay: owner / shareholder / family pay, or a pay line naming someone. */
export function isIndividualPayLine(label: string): boolean {
  if (!PAY_WORDS.test(label) && !/\bowner\s+comp/i.test(label)) return false;
  return PERSONAL.test(label) || NAMED.test(label);
}

/** A part's label as a buyer reads it. */
export function neutralPartLabel(label: string, screen: StringScreen): string {
  const pay = screen.isPayLine ? screen.isPayLine(label) : isIndividualPayLine(label);
  if (pay) return WAGES_LABEL;
  return screen.keep(label) ? label : OTHER_COSTS_LABEL;
}

function screenNote(note: FigureNoteView | null | undefined, screen: StringScreen): FigureNoteView | null {
  if (!note) return null;
  if (!screen.keep(note.text) || !screen.keep(note.basisLabel)) return null;
  return note;
}

const money = (s: string) => {
  const n = Number(String(s).replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const fmt = (n: number) => `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;

function screenParts(parts: NonNullable<FigureView["parts"]>, screen: StringScreen): NonNullable<FigureView["parts"]> {
  const out: NonNullable<FigureView["parts"]> = [];
  const merged = new Map<string, { label: string; total: number; count: number; why: FigureNoteView | null }>();
  for (const p of parts) {
    const label = neutralPartLabel(p.label, screen);
    if (label === p.label) {
      out.push({ ...p, why: screenNote(p.why, screen) });
      continue;
    }
    const m = merged.get(label) ?? { label, total: 0, count: 0, why: null };
    m.total += money(p.display);
    m.count += 1;
    merged.set(label, m);
  }
  for (const m of Array.from(merged.values())) {
    // One neutral part per kind; its value is the sum, never a person's pay on its own line.
    const existing = out.find((p) => p.label === m.label);
    if (existing) existing.display = fmt(money(existing.display) + m.total);
    else out.push({ label: m.label, display: fmt(m.total), why: null });
  }
  return out;
}

/** The layer with every buyer-bound string screened. Never adds anything. */
export function screenBuyerStrings(layer: FigureLayer, screen: StringScreen): FigureLayer {
  const figures: Record<string, FigureView> = {};
  for (const [id, f] of Object.entries(layer.figures)) {
    const next: FigureView = { ...f };
    if (next.label !== undefined && !screen.keep(next.label)) delete next.label;
    if (next.why !== undefined) next.why = screenNote(next.why, screen);
    if (next.parts) next.parts = screenParts(next.parts, screen);
    if (next.partsMore && !screen.keep(next.partsMore)) next.partsMore = null;
    if (next.checks) {
      next.checks = next.checks.map((c) => {
        const cc = { ...c, note: screenNote(c.note, screen) };
        if (cc.sourceLabel !== undefined && !screen.keep(cc.sourceLabel)) delete cc.sourceLabel;
        if (cc.asIssued !== undefined && !screen.keep(cc.asIssued)) delete cc.asIssued;
        return cc;
      });
    }
    figures[id] = next;
  }
  const keyTerms = layer.keyTerms
    ? Object.fromEntries(Object.entries(layer.keyTerms).map(([page, terms]) => [page, terms.filter((t) => screen.keep(t.label) && screen.keep(t.value))]))
    : undefined;
  return { ...layer, figures, ...(keyTerms ? { keyTerms } : {}) };
}
