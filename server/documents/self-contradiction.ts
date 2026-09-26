/**
 * self-contradiction.ts — one source giving two figures for the same year
 * of the same fact.
 *
 * Ridgeline's FY2024 statements were read as giving FY2023 long-term debt
 * both as $1,058,000 (the term loan's own line, next to it in the debt note)
 * and as $1,068,000 (the balance-sheet line). Both values come from one row
 * with one date, so authority, fiscal period and source date all tie and
 * whichever was merged first stayed — $1,058,000, although the FY2023
 * statements (the statements FOR that year) say $1,068,000 too.
 *
 * A row that contradicts itself about a year is settled by the other rows:
 * when another row states one of its two figures and no other row states
 * the one on file, that figure is the year's value. The one on file stays
 * as another value (never lost), the row keeps the credit, and the other
 * rows that state the figure become its confirmations. Nothing is decided
 * when the other rows are silent or split. Only document / email figures
 * are weighed — never the seller's or the broker's own word.
 *
 * Pure (mutates `info` only).
 */
import {
  getFieldAlternates,
  getFieldSources,
  noteSameValue,
  displaceCorroborations,
  getFieldCorroborations,
  recordAlternate,
  repairCharIndexedValue,
  resolvedYearSources,
  setFieldSource,
  summariseMapSource,
  typedNumericValues,
  FIELD_ALTERNATES_KEY,
  type FieldAlternate,
  type FieldSource,
  type SourceRowLookup,
} from "../interview/info-merger";

type Info = Record<string, unknown>;
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** The figure a value states (its first amount), or undefined. */
function figureOf(v: unknown): number | undefined {
  if (typeof v !== "string" && typeof v !== "number") return undefined;
  return typedNumericValues(String(v))[0]?.value;
}

const sameFigure = (a: unknown, b: unknown) => {
  const x = figureOf(a);
  const y = figureOf(b);
  return x !== undefined && y !== undefined && Math.abs(x - y) <= Math.max(Math.abs(x), Math.abs(y)) * 1e-6 + 0.5;
};

/**
 * A row's own statement of the figure: a document or email, shared, stated
 * (never worked out) and not set aside as another kind of figure (a budget,
 * a part-year or run-rate figure — those carry a note).
 */
const SET_ASIDE_NOTE = /part-year|run-rate|budget|forecast|projection|unreviewed|preliminary|estimate|interim|ytd|year-to-date|quarter/i;
const isRowSource = (s: Partial<FieldSource> | null | undefined): s is FieldSource & { documentId: string } =>
  !!s && !!s.documentId && (s.source === "document" || s.source === "email") && !s.brokerOnly && !s.valueInferred &&
  !(s.note && SET_ASIDE_NOTE.test(s.note));

/**
 * Mutates `info`: every year of every by-year fact whose value on file comes
 * from a row that also gave another figure for that year is settled by the
 * other rows (see the header). Returns what was switched ("key.year").
 */
export function settleSelfContradictions(info: Info, lookup?: SourceRowLookup): string[] {
  const switched: string[] = [];
  for (const key of Object.keys(info)) {
    if (key.startsWith("_") || !/ByYear$/.test(key)) continue;
    const map = repairCharIndexedValue(info[key]);
    if (!isMap(map)) continue;
    const recorded = getFieldSources(info)[key];
    if (!recorded) continue;
    const years = resolvedYearSources(recorded, map, lookup);
    let changed = false;
    for (const [y, onFile] of Object.entries(map)) {
      const src = years[y];
      if (!isRowSource(src) || figureOf(onFile) === undefined) continue;
      const altKey = `${key}.${y}`;
      const alts = getFieldAlternates(info)[altKey] ?? [];
      // The row's other figures for this year.
      const own = alts.filter((a) => a.documentId === src.documentId && figureOf(a.value) !== undefined && !sameFigure(a.value, onFile));
      if (own.length === 0) continue;
      const others = (pred: (a: FieldAlternate) => boolean) =>
        new Set(alts.filter((a) => isRowSource(a) && a.documentId !== src.documentId && pred(a)).map((a) => a.documentId));
      // Other rows that state the figure on file (confirmations, or other values equal to it).
      const backingOnFile = new Set([
        ...Array.from(others((a) => sameFigure(a.value, onFile))),
        ...(getFieldCorroborations(info)[altKey] ?? []).filter((c) => isRowSource(c) && c.documentId !== src.documentId).map((c) => c.documentId!),
      ]);
      if (backingOnFile.size > 0) continue;
      const candidates = own.filter((a) => others((o) => sameFigure(o.value, a.value)).size > 0);
      const distinct = candidates.filter((a, i) => candidates.findIndex((b) => sameFigure(b.value, a.value)) === i);
      if (distinct.length !== 1) continue; // the other rows are silent, or back two figures
      const pick = distinct[0];
      const { value: pickValue, ...pickSrc } = pick;
      // The figure on file stays as another value; the row keeps the credit.
      recordAlternate(info, altKey, onFile, src);
      const next = { ...getFieldAlternates(info) } as Record<string, FieldAlternate[]>;
      const remaining: FieldAlternate[] = [];
      const confirming: FieldAlternate[] = [];
      for (const a of next[altKey] ?? []) {
        if (a === pick || (a.documentId === pick.documentId && a.value === pickValue)) continue;
        if (isRowSource(a) && a.documentId !== src.documentId && sameFigure(a.value, pickValue)) confirming.push(a);
        else remaining.push(a);
      }
      if (remaining.length > 0) next[altKey] = remaining;
      else delete next[altKey];
      info[FIELD_ALTERNATES_KEY] = next;
      map[y] = pickValue;
      years[y] = pickSrc as FieldSource;
      displaceCorroborations(info, altKey, pickValue);
      for (const c of confirming) {
        const { value: _v, ...cSrc } = c;
        noteSameValue(info, altKey, cSrc as FieldSource, { current: pickValue, recorded: pickSrc as FieldSource, setRecorded: () => {}, outranks: () => false });
      }
      switched.push(altKey);
      changed = true;
    }
    if (changed) {
      info[key] = map;
      const summary = summariseMapSource(years);
      if (summary) setFieldSource(info, key, summary);
    }
  }
  return switched;
}
