/**
 * Section lineage — keeps a CIM page's reading history across a
 * regeneration. A regenerated CIM gets new section ids (and AI-invented
 * section keys), so without this every page's history would be orphaned.
 * persistDocument (server/cim/generation-jobs.ts) calls assignLineage before
 * it deletes the old sections and stores the result in
 * cim_sections.analytics_lineage; renditions carry it in their page index
 * and reading_rollups.lineage_id, so page-level totals merge by lineage.
 *
 * A new section continues an old one, in this order:
 *   1. the same section key;
 *   2. the same title (case, punctuation and "&"/"and" ignored);
 *   3. the same page role (shared/cim-page-role.ts), when that role is held
 *      by exactly one section on each side;
 *   4. otherwise it starts a lineage of its own (null).
 * Each old section is continued at most once. Builder operations keep the
 * row (rename, convert, AI rewrite) and so the lineage; a duplicate starts
 * its own.
 */
import { pageRole } from "@shared/cim-page-role";
import { headingKey } from "@shared/cim-blocks";

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

/** The lineage each new section continues (same order as `next`), or null for a fresh one. */
export function assignLineage(old: ReadonlyArray<LineageOld>, next: ReadonlyArray<LineageNew>): Array<string | null> {
  const out: Array<string | null> = next.map(() => null);
  const used = new Set<number>();
  const lineageOf = (o: LineageOld) => o.analyticsLineage || o.id;

  const pass = (same: (o: LineageOld, n: LineageNew) => boolean) => {
    next.forEach((n, i) => {
      if (out[i] !== null) return;
      const j = old.findIndex((o, k) => !used.has(k) && same(o, n));
      if (j === -1) return;
      used.add(j);
      out[i] = lineageOf(old[j]);
    });
  };
  pass((o, n) => !!o.sectionKey && o.sectionKey === n.sectionKey);
  pass((o, n) => !!headingKey(o.sectionTitle) && headingKey(o.sectionTitle) === headingKey(n.sectionTitle));

  // Page role, only where it is unambiguous on both sides.
  const roleOf = (s: { layoutType: string; sectionTitle: string; sectionKey: string }) =>
    pageRole({ layoutType: s.layoutType, title: s.sectionTitle, sectionKey: s.sectionKey });
  const count = <T,>(items: ReadonlyArray<T>, skip: (i: number) => boolean, role: (t: T) => string) => {
    const m = new Map<string, number>();
    items.forEach((t, i) => { if (!skip(i)) m.set(role(t), (m.get(role(t)) ?? 0) + 1); });
    return m;
  };
  const oldRoles = count(old, (k) => used.has(k), roleOf);
  const newRoles = count(next, (i) => out[i] !== null, roleOf);
  next.forEach((n, i) => {
    if (out[i] !== null) return;
    const r = roleOf(n);
    if (r === "other" || newRoles.get(r) !== 1 || oldRoles.get(r) !== 1) return;
    const j = old.findIndex((o, k) => !used.has(k) && roleOf(o) === r);
    if (j === -1) return;
    used.add(j);
    out[i] = lineageOf(old[j]);
  });
  return out;
}
