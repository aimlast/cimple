/**
 * source-removal.ts — taking a deleted source's facts off a deal, and what
 * steps in for them.
 *
 * removeDocumentFields (info-merger.ts) strips what the source asserted. A
 * fact it leaves empty used to be refilled from the alternate with the
 * highest RAW source rank — a call (5) or an interview (6) beat a document
 * (3) whatever the fact — and a by-year map's emptied year was never
 * refilled at all. Deleting a draft P&L (a routine clean-up) therefore put a
 * call's spoken $2.3M on annualRevenue while the final statements' $1,835,000
 * sat as an alternate, dropped FY2024 from revenueByYear, superseded the old
 * merge row and raised no new one — the call's figure reached the CIM with
 * nothing blocking generation.
 *
 * Here every emptied fact and every emptied year is refilled through the
 * normal merge (mergeScalarInto / mergeYearMapInto): its surviving values
 * are merged back one by one, so the merge's own authority picks the winner
 * (a statement over a call for the facts it is the authority on — decision
 * A — the newer period, the newer source date) and any material difference
 * left standing is collected in `ctx.conflicts` for recordMergeConflicts.
 * Headlines are then lined up with their maps again. Pure.
 */
import {
  removeDocumentFields,
  getFieldAlternates,
  parseAlternateValue,
  recordAlternate,
  repairCharIndexedValue,
  isSuppressed,
  typedNumericValues,
  FIELD_ALTERNATES_KEY,
  type FieldAlternate,
  type FieldSource,
} from "../interview/info-merger";
import {
  mergeScalarInto,
  mergeYearMapInto,
  reconcileHeadlines,
  isYearMapKey,
  HEADLINE_MAPS,
  UNREVIEWED_YEAR_NOTE,
  EARLY_YEAR_NOTE,
  FORECAST_YEAR_NOTE,
  type MergeContext,
} from "./merge-policy";

type Info = Record<string, unknown>;
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const filled = (v: unknown) => v !== undefined && v !== null && v !== "";

/** Other values kept as what they are — never a year's reported figure (a budget, a quarter, an unreviewed number). */
const SET_ASIDE_NOTES: ReadonlySet<string> = new Set([UNREVIEWED_YEAR_NOTE, EARLY_YEAR_NOTE, FORECAST_YEAR_NOTE, "Part-year / run-rate figure"]);

export interface SourceRemoval {
  info: Info;
  /** Keys (and "key:documentId" for years of a map) the source's removal emptied. */
  removed: string[];
  /** Facts ("key") and years ("key.2024") another source's value now fills. */
  refilled: string[];
  changed: boolean;
}

/**
 * Removes a deleted source's facts (see removeDocumentFields) and refills
 * what it emptied by the merge's own authority (module comment). Conflicts
 * the refill leaves standing go to `ctx.conflicts`.
 */
export function removeSourceFromFacts(info: Info, documentId: string, ctx: MergeContext = {}): SourceRemoval {
  const r = removeDocumentFields(info, documentId, { promoteAlternates: false });
  const out = r.info;
  const refilled: string[] = [];

  /** The values kept for `altKey` that may stand in, taken off the alternates list (the merge re-records the losers). */
  const takeCandidates = (altKey: string): FieldAlternate[] => {
    const all = { ...getFieldAlternates(out) } as Record<string, FieldAlternate[]>;
    const list = Array.isArray(all[altKey]) ? all[altKey] : [];
    const usable = list.filter((a) => !(a.note && SET_ASIDE_NOTES.has(a.note)));
    if (usable.length === 0) return [];
    const rest = list.filter((a) => !usable.includes(a));
    if (rest.length > 0) all[altKey] = rest;
    else delete all[altKey];
    out[FIELD_ALTERNATES_KEY] = all;
    // An explicit value before a worked-out one: a worked-out value only fills a gap.
    return [...usable].sort((a, b) => Number(!!a.valueInferred) - Number(!!b.valueInferred));
  };

  // Whole facts the source emptied.
  for (const key of r.removed) {
    if (key.includes(":") || isYearMapKey(key)) continue;
    if (filled(out[key]) || isSuppressed(out, key)) continue;
    const head = HEADLINE_MAPS.some((h) => h.head === key);
    for (const { value, ...src } of takeCandidates(key)) {
      const v = parseAlternateValue(value);
      // A headline remark with no amount in it ("call it a million and a half") is never the headline.
      if (head && typeof v === "string" && !typedNumericValues(v).some((t) => t.kind === "currency")) {
        recordAlternate(out, key, v, src as FieldSource);
        continue;
      }
      mergeScalarInto(out, key, v, src as FieldSource, ctx);
    }
    if (filled(out[key])) refilled.push(key);
  }

  // Years of by-year maps the source emptied (a whole map or some years).
  for (const [key, raw] of Object.entries(info)) {
    if (key.startsWith("_") || !isYearMapKey(key) || isSuppressed(out, key)) continue;
    const was = repairCharIndexedValue(raw);
    if (!isMap(was)) continue;
    for (const y of Object.keys(was)) {
      const now = repairCharIndexedValue(out[key]);
      if (isMap(now) && filled(now[y])) continue;
      for (const { value, ...src } of takeCandidates(`${key}.${y}`)) {
        const v = parseAlternateValue(value);
        if (typeof v !== "string" && typeof v !== "number") continue;
        mergeYearMapInto(out, key, { [y]: String(v) }, src as FieldSource, ctx);
      }
      const after = repairCharIndexedValue(out[key]);
      if (isMap(after) && filled(after[y])) refilled.push(`${key}.${y}`);
    }
  }

  if (refilled.length > 0) reconcileHeadlines(out, ctx);
  return { info: out, removed: r.removed, refilled, changed: r.changed || refilled.length > 0 };
}
