/**
 * Section lineage — keeps a CIM page's reading history across a
 * regeneration. A regenerated CIM gets new section ids (and AI-invented
 * section keys), so without this every page's history would be orphaned.
 * persistDocument (server/cim/generation-jobs.ts) calls assignLineage before
 * it deletes the old sections and stores the result in
 * cim_sections.analytics_lineage; renditions carry it in their page index
 * and reading_rollups.lineage_id, so page-level totals merge by lineage.
 *
 * Version 2 (2026-10-09) favours precision: a wrong link labels a page with
 * another page's reading (Pacific's "Working Capital Summary" carried the
 * capital-expenditure page's 27 minutes), while a missed one only starts a
 * fresh history. A new section continues an old one, in this order:
 *   1. the same section key;
 *   2. the same title (case, punctuation and "&"/"and" ignored);
 *   3. similar words in key + title (shared/section-words.ts
 *      sectionSimilarity): every remaining pair scored, best pairs first,
 *      each side once; a section whose two best candidates are within 0.05
 *      of each other is ambiguous and skipped (on either side);
 *   4. the same FIXED layout (cover, divider, waterfall, org chart, location
 *      card or map) when exactly one unmatched page of that layout is left on
 *      each side and both have the same page role;
 *   5. otherwise it starts a lineage of its own (null).
 * The old "same page role" pass is gone: two financial pages are not the
 * same page because both are financial.
 *
 * Each old section is continued at most once. Builder operations keep the
 * row (rename, convert, AI rewrite) and so the lineage; a duplicate starts
 * its own.
 */
import { pageRole } from "@shared/cim-page-role";
import { headingKey } from "@shared/cim-blocks";
import { MIN_SECTION_SIMILARITY, sectionSimilarity } from "@shared/section-words";

export interface LineageOld {
  id: string;
  sectionKey: string;
  sectionTitle: string;
  layoutType: string;
  analyticsLineage?: string | null;
}

export interface LineageNew {
  sectionKey: string;
  sectionTitle: string;
  layoutType: string;
}

/** How a new section's lineage was found (reports and the repair script). */
export type LineagePass = "same key" | "same title" | "similar words" | "same fixed layout" | "new";

export interface LineageMatch {
  lineage: string | null;
  how: LineagePass;
  /** The similarity score (pass 3 only), rounded to 2 decimals. */
  score?: number;
}

/** Layouts whose page role is fixed whatever the title says (shared/cim-page-role.ts BY_LAYOUT). */
export const FIXED_LINEAGE_LAYOUTS: ReadonlySet<string> = new Set(["cover_page", "divider", "waterfall_chart", "org_chart", "location_card", "location_map"]);

/** Two best candidates closer than this make a section ambiguous. */
const AMBIGUITY_GAP = 0.05;

/** The lineage each new section continues (same order as `next`), with how it was found. Pure. */
export function matchLineage(old: ReadonlyArray<LineageOld>, next: ReadonlyArray<LineageNew>): LineageMatch[] {
  const out: LineageMatch[] = next.map(() => ({ lineage: null, how: "new" }));
  const used = new Set<number>();
  const lineageOf = (o: LineageOld) => o.analyticsLineage || o.id;

  const pass = (how: LineagePass, same: (o: LineageOld, n: LineageNew) => boolean) => {
    next.forEach((n, i) => {
      if (out[i].lineage !== null) return;
      const j = old.findIndex((o, k) => !used.has(k) && same(o, n));
      if (j === -1) return;
      used.add(j);
      out[i] = { lineage: lineageOf(old[j]), how };
    });
  };
  pass("same key", (o, n) => !!o.sectionKey && o.sectionKey === n.sectionKey);
  pass("same title", (o, n) => !!headingKey(o.sectionTitle) && headingKey(o.sectionTitle) === headingKey(n.sectionTitle));

  // 3. Similar words: every remaining pair scored, best pairs first (global greedy), each side once.
  const pairs: Array<{ i: number; j: number; s: number }> = [];
  next.forEach((n, i) => {
    if (out[i].lineage !== null) return;
    old.forEach((o, j) => {
      if (used.has(j)) return;
      const s = sectionSimilarity(o, n);
      if (s >= MIN_SECTION_SIMILARITY) pairs.push({ i, j, s });
    });
  });
  pairs.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  const ambiguous = (key: (p: { i: number; j: number }) => number) => {
    const scores = new Map<number, number[]>();
    for (const p of pairs) {
      const k = key(p);
      const list = scores.get(k) ?? [];
      list.push(p.s);
      scores.set(k, list);
    }
    const out = new Set<number>();
    scores.forEach((ss, k) => { if (ss.length > 1 && ss[0] - ss[1] < AMBIGUITY_GAP) out.add(k); });
    return out;
  };
  const ambNew = ambiguous((p) => p.i);
  const ambOld = ambiguous((p) => p.j);
  for (const p of pairs) {
    if (out[p.i].lineage !== null || used.has(p.j) || ambNew.has(p.i) || ambOld.has(p.j)) continue;
    used.add(p.j);
    out[p.i] = { lineage: lineageOf(old[p.j]), how: "similar words", score: Math.round(p.s * 100) / 100 };
  }

  // 4. Fixed-role layouts only: same layout, the only one unmatched on each side, same role.
  const roleOf = (s: LineageNew) => pageRole({ layoutType: s.layoutType, title: s.sectionTitle, sectionKey: s.sectionKey });
  next.forEach((n, i) => {
    if (out[i].lineage !== null || !FIXED_LINEAGE_LAYOUTS.has(n.layoutType)) return;
    const newSame = next.filter((m, k) => out[k].lineage === null && m.layoutType === n.layoutType).length;
    const oldSame = old.filter((o, k) => !used.has(k) && o.layoutType === n.layoutType);
    if (newSame !== 1 || oldSame.length !== 1) return;
    const j = old.indexOf(oldSame[0]);
    if (roleOf(old[j]) !== roleOf(n)) return;
    used.add(j);
    out[i] = { lineage: lineageOf(old[j]), how: "same fixed layout" };
  });
  return out;
}

/** The lineage each new section continues (same order as `next`), or null for a fresh one. */
export function assignLineage(old: ReadonlyArray<LineageOld>, next: ReadonlyArray<LineageNew>): Array<string | null> {
  return matchLineage(old, next).map((m) => m.lineage);
}
