/**
 * Repairing stored section lineage (heat-map spec §7.1). Before 2026-10-09
 * assignLineage matched a regenerated page to an old one by "page role"
 * alone, which linked Pacific's new "Working Capital Summary" to the old
 * "Capital Expenditures & Fleet Replacement" (both financial) — so 27
 * minutes of capex reading were labelled as working capital. Lineage v2
 * (server/analytics/lineage.ts) no longer does that; this module re-checks
 * the links already stored, against the version the current pages replaced.
 *
 * Pure planning + an apply that runs through a small transaction seam
 * (scripts/repair-section-lineage.ts gives it Postgres; tests give it memory).
 * It only changes what it can check:
 *   - the earlier version is the kept copy when it was taken in the same
 *     generation as the current pages (a FULL check), else a PARTIAL check
 *     (the kept copy from an earlier generation, or a stored version exactly
 *     one CIM version back — versions hold the pages buyers were served only);
 *   - a stored link to a page that isn't in that version is left alone;
 *   - a new link where there was none is applied on a full check only (on a
 *     partial check it is listed as a possible link);
 *   - the guarded UPDATE changes a row only if its lineage is still what was
 *     read, and only those rows' stored versions and part-by-part rows are
 *     patched (old-tracker rows keep the old section's lineage, which is right).
 * No AI, no network besides the database.
 */
import type { RenditionPage } from "@shared/analytics-v2";
import { CONTACT_PAGE_ID, DISCLAIMER_PAGE_ID } from "@shared/cim-blocks";
import { keyStem, sharedLineageWords } from "@shared/section-words";
import { pageRole } from "@shared/cim-page-role";
import { matchLineage, type LineageOld } from "../analytics/lineage";

/** A kept copy taken within this long before the current pages were created is the version they replaced. */
export const SAME_GENERATION_MS = 15 * 60_000;

export interface RepairSection {
  id: string;
  sectionKey: string;
  sectionTitle: string;
  layoutType: string;
  analyticsLineage: string | null;
  createdAt: Date;
}

export interface RepairKeptCopy {
  takenAt: Date;
  sections: Array<{ id: string; sectionKey: string; sectionTitle: string; layoutType: string; analyticsLineage?: string | null }>;
}

export interface RepairRendition {
  id: string;
  mode: string;
  cimLayoutVersion: number | null;
  createdAt: Date;
  pageIndex: RenditionPage[];
  /** Served section keys by page id (named versions; blind keys are neutral). */
  keys: Record<string, string>;
}

export type RepairCheck = "full" | "partial";

export interface EarlierVersion {
  check: RepairCheck;
  /** "the kept copy (27 pages, 29 Sep)" */
  label: string;
  sections: LineageOld[];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "29 Sep" — the way the Engagement tab dates versions. */
export const fmtDay = (d: Date) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;

/**
 * The version the current pages are checked against, or why there is none.
 * Pure.
 */
export function chooseEarlierVersion(input: {
  current: ReadonlyArray<Pick<RepairSection, "createdAt">>;
  kept: RepairKeptCopy | null;
  renditions: ReadonlyArray<RepairRendition>;
  cimLayoutVersion: number | null;
}): EarlierVersion | { cantCheck: string } {
  if (input.current.length === 0) return { cantCheck: "the deal has no CIM pages" };
  const createdMin = Math.min(...input.current.map((s) => s.createdAt.getTime()));
  if (input.kept && input.kept.sections.length > 0) {
    const t = input.kept.takenAt.getTime();
    const full = t <= createdMin && createdMin <= t + SAME_GENERATION_MS;
    return {
      check: full ? "full" : "partial",
      label: `the kept copy (${input.kept.sections.length} pages, ${fmtDay(input.kept.takenAt)})${full ? "" : " — taken before an earlier regeneration"}`,
      sections: input.kept.sections.map((s) => ({
        id: s.id, sectionKey: s.sectionKey ?? "", sectionTitle: s.sectionTitle ?? "", layoutType: s.layoutType ?? "", analyticsLineage: s.analyticsLineage ?? null,
      })),
    };
  }
  const v = input.cimLayoutVersion;
  if (v != null) {
    const prev = input.renditions.filter((r) => r.cimLayoutVersion === v - 1);
    const named = prev.filter((r) => r.mode !== "blind").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const blind = prev.filter((r) => r.mode === "blind").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
    const pick = named ?? blind;
    if (pick) {
      const blindOnly = !named;
      const pages = pick.pageIndex.filter((p) => p.pageId !== DISCLAIMER_PAGE_ID && p.pageId !== CONTACT_PAGE_ID);
      return {
        check: "partial",
        label: `a stored ${blindOnly ? "blind" : "named"} version (${pages.length} pages, ${fmtDay(pick.createdAt)})`,
        // A blind version's keys and titles are neutral: only the fixed-layout pass can use it.
        sections: pages.map((p) => ({
          id: p.pageId,
          sectionKey: blindOnly ? "" : pick.keys[p.pageId] ?? "",
          sectionTitle: blindOnly ? "" : p.servedTitle,
          layoutType: p.layoutType,
          analyticsLineage: p.lineageId && p.lineageId !== p.pageId ? p.lineageId : null,
        })),
      };
    }
  }
  return { cantCheck: "the earlier version isn't on file" };
}

export type RepairOutcome = "unchanged" | "change" | "addition" | "possible" | "cant_check" | "skipped";

export interface RepairRow {
  id: string;
  title: string;
  stored: string | null;
  proposed: string | null;
  outcome: RepairOutcome;
  /** "[similar words 0.62]", "[no shared meaning: only “capital”]" … */
  why: string;
}

const lineageOf = (o: LineageOld) => o.analyticsLineage || o.id;

function displayWord(stem: string, ...texts: string[]): string {
  for (const t of texts) {
    for (const w of t.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/)) {
      if (w && keyStem(w) === stem) return w.toLowerCase();
    }
  }
  return stem;
}

/**
 * Each current section: its stored link, what lineage v2 says against the
 * earlier version, and the outcome (§7.1 table). Pure.
 */
export function planLineageRepair(current: ReadonlyArray<Omit<RepairSection, "createdAt">>, earlier: EarlierVersion): RepairRow[] {
  const v2 = matchLineage(earlier.sections, current);
  const inEarlier = new Map(earlier.sections.map((o) => [lineageOf(o), o]));
  const rows: RepairRow[] = current.map((s, i) => {
    const stored = s.analyticsLineage ?? null;
    const m = v2[i];
    const proposed = m.lineage;
    const target = proposed ? inEarlier.get(proposed) : undefined;
    const sim = m.how === "similar words" && target
      ? `similar words ${m.score?.toFixed(2)}${sharedLineageWords(target, s).telling.length === 1 ? ", same role" : ""}`
      : m.how === "new" ? "" : m.how;
    if (stored === proposed) return { id: s.id, title: s.sectionTitle, stored, proposed, outcome: "unchanged", why: sim };
    if (stored && !inEarlier.has(stored)) {
      return { id: s.id, title: s.sectionTitle, stored, proposed: stored, outcome: "cant_check", why: "earlier page not on file" };
    }
    if (stored) {
      let why = sim;
      if (!proposed) {
        const old = inEarlier.get(stored)!;
        const shared = sharedLineageWords(old, s);
        const words = [...shared.telling, ...shared.broad].map((w) => `“${displayWord(w, old.sectionKey, old.sectionTitle, s.sectionKey, s.sectionTitle)}”`);
        const sameRole = pageRole({ layoutType: old.layoutType, title: old.sectionTitle, sectionKey: old.sectionKey })
          === pageRole({ layoutType: s.layoutType, title: s.sectionTitle, sectionKey: s.sectionKey });
        why = words.length === 0 ? "no words in common" : `no shared meaning: only ${words.join(", ")}${sameRole ? " (and the same page role)" : ""}`;
      }
      return { id: s.id, title: s.sectionTitle, stored, proposed, outcome: "change", why };
    }
    return { id: s.id, title: s.sectionTitle, stored, proposed, outcome: earlier.check === "full" ? "addition" : "possible", why: sim };
  });
  // Each old page is continued at most once: a change or addition onto a
  // page a link that stays (unchanged / can't check / not applied) still
  // holds is skipped.
  const applied = (r: RepairRow) => r.outcome === "change" || r.outcome === "addition";
  const finalOf = (r: RepairRow) => (applied(r) ? r.proposed : r.stored);
  const holders = new Map<string, number>();
  for (const r of rows) {
    const f = finalOf(r);
    if (f) holders.set(f, (holders.get(f) ?? 0) + 1);
  }
  for (const r of rows) {
    const f = finalOf(r);
    if (applied(r) && f && (holders.get(f) ?? 0) > 1 && rows.some((o) => o !== r && !applied(o) && o.stored === f)) {
      holders.set(f, (holders.get(f) ?? 1) - 1);
      r.outcome = "skipped";
      r.why = "that earlier page already continues on another page";
    }
  }
  return rows;
}

/** The changes to write: section id → { from, to }. */
export function repairChanges(rows: ReadonlyArray<RepairRow>): Array<{ id: string; from: string | null; to: string | null }> {
  return rows.filter((r) => r.outcome === "change" || r.outcome === "addition").map((r) => ({ id: r.id, from: r.stored, to: r.proposed }));
}

/** A stored version's page index with the changed sections' lineage replaced (null when nothing changes). Pure. */
export function patchPageIndex(pageIndex: ReadonlyArray<RenditionPage>, lineageBySection: ReadonlyMap<string, string>): RenditionPage[] | null {
  let changed = false;
  const out = pageIndex.map((p) => {
    if (!lineageBySection.has(p.pageId)) return p;
    const next = lineageBySection.get(p.pageId)!;
    if (p.lineageId === next) return p;
    changed = true;
    return { ...p, lineageId: next };
  });
  return changed ? out : null;
}

/** The database seam the apply runs through (one transaction per deal). */
export interface RepairTx {
  /** UPDATE … WHERE id AND deal_id AND analytics_lineage IS NOT DISTINCT FROM `from` — true when the row changed. */
  updateSectionLineage(dealId: string, id: string, from: string | null, to: string | null): Promise<boolean>;
  renditionsWithPages(dealId: string, sectionIds: string[]): Promise<Array<{ id: string; pageIndex: RenditionPage[] }>>;
  setRenditionPageIndex(dealId: string, id: string, pageIndex: RenditionPage[]): Promise<void>;
  /** reading_rollups.lineage_id for part-by-part rows (rendition_id NOT NULL) of that page. */
  setRollupLineage(dealId: string, pageId: string, lineage: string): Promise<number>;
}

/**
 * Applies the changes: each section row through the guarded UPDATE, then —
 * only for the rows it actually changed — the stored versions' page index
 * and the part-by-part rows of that page. A row changed meanwhile is
 * reported and left alone, with nothing else touched for it.
 */
export async function applyLineageRepair(
  tx: RepairTx,
  dealId: string,
  changes: ReadonlyArray<{ id: string; from: string | null; to: string | null }>,
): Promise<{ updated: string[]; changedMeanwhile: string[]; renditionsPatched: number; rollupsPatched: number }> {
  const updated: string[] = [];
  const changedMeanwhile: string[] = [];
  for (const c of changes) {
    if (await tx.updateSectionLineage(dealId, c.id, c.from, c.to)) updated.push(c.id);
    else changedMeanwhile.push(c.id);
  }
  const lineage = new Map<string, string>();
  for (const id of updated) {
    const c = changes.find((x) => x.id === id)!;
    lineage.set(id, c.to ?? id);
  }
  let renditionsPatched = 0;
  let rollupsPatched = 0;
  if (lineage.size > 0) {
    for (const r of await tx.renditionsWithPages(dealId, Array.from(lineage.keys()))) {
      const next = patchPageIndex(r.pageIndex, lineage);
      if (next) {
        await tx.setRenditionPageIndex(dealId, r.id, next);
        renditionsPatched++;
      }
    }
    for (const [pageId, lin] of Array.from(lineage.entries())) rollupsPatched += await tx.setRollupLineage(dealId, pageId, lin);
  }
  return { updated, changedMeanwhile, renditionsPatched, rollupsPatched };
}
