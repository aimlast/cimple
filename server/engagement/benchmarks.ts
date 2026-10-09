/**
 * reading_benchmarks — the cross-deal learning input, per deal.
 *
 * A deal's rows are RECOMPUTED from its own reading rollups (idempotent: run
 * it twice, get the same rows), aggregated to generic dimensions only:
 * page role × layout type × block kind, with readers, blocks, reading time
 * and the expected reading time of what those readers had in front of them.
 * No section key, no title, no block key and no CIM text ever reaches this
 * table — only these enumerations — so nothing one broker wrote can reach
 * another broker's layout prompt (the old engagement_insights stored raw
 * section-key slugs such as "kitchener_clinic_team").
 *
 * Demo and QA deals (deals.demo_key) never write here.
 *
 * Readers of the table:
 *   - the learning loop (server/cim/learning-loop.ts) → engagement_insights
 *     for the layout engine, only where ≥ LEARNING_MIN_DEALS deals stand
 *     behind a figure;
 *   - the broker's "compare" page (anonymous industry benchmark), only from
 *     OTHER brokerages' deals and only with ≥ BENCHMARK_MIN_DEALS deals.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db";
import { cimRenditions, cimSections, deals, readingBenchmarks } from "@shared/schema";
import { PAGE_ROLES, type PageRole, type RenditionPage } from "@shared/analytics-v2";
import { BLOCK_KINDS, type BlockKind } from "@shared/cim-blocks";
import { pageRole } from "@shared/cim-page-role";

/** The compare page shows an industry benchmark only with this many other brokerages' deals behind it. */
export const BENCHMARK_MIN_DEALS = 5;

export interface BenchmarkRollupRow {
  renditionId: string | null;
  pageId: string;
  blockKey: string;
  accessId: string;
  attentionMs: number;
}

/** What the benchmark needs to know about one served page. */
export interface BenchmarkPageMeta {
  layoutType: string;
  role: PageRole;
  blocks: Array<{ key: string; kind: BlockKind | string; expectedMs: number; virtual?: boolean; when?: string }>;
}

export interface DealBenchmarkRow {
  pageRole: PageRole;
  layoutType: string;
  blockKind: BlockKind;
  readers: number;
  blocks: number;
  attentionMs: number;
  expectedMs: number;
}

const LAYOUT_RE = /^[a-z][a-z_]{0,39}$/;
/** Containers and virtual parts would double count their children. */
const SKIP_KINDS: ReadonlySet<string> = new Set(["column", "point"]);

/** A generic dimension or "other" — never free text. */
function safeLayout(v: string): string {
  return LAYOUT_RE.test(v) ? v : "other";
}
function safeRole(v: string): PageRole {
  return (PAGE_ROLES as readonly string[]).includes(v) ? (v as PageRole) : "other";
}
function safeKind(v: string): BlockKind | null {
  return (BLOCK_KINDS as readonly string[]).includes(v) ? (v as BlockKind) : null;
}

/**
 * Pure: a deal's rollups → its benchmark rows. A page counts for a buyer
 * once they spent any reading time on it; its expected time then counts
 * block by block (read or not), so the ratio attention ÷ expected is how
 * much of what was in front of them they actually read.
 */
export function computeBenchmarkRows(
  rollups: BenchmarkRollupRow[],
  pageMeta: (renditionId: string, pageId: string) => BenchmarkPageMeta | null,
): DealBenchmarkRow[] {
  // (access, rendition, page) → block key → attention
  const reads = new Map<string, { accessId: string; renditionId: string; pageId: string; blocks: Map<string, number>; total: number }>();
  for (const r of rollups) {
    if (!r.renditionId) continue;
    const k = `${r.accessId}|${r.renditionId}|${r.pageId}`;
    const e = reads.get(k) ?? { accessId: r.accessId, renditionId: r.renditionId, pageId: r.pageId, blocks: new Map(), total: 0 };
    const a = Math.max(0, Number(r.attentionMs) || 0);
    e.blocks.set(r.blockKey, (e.blocks.get(r.blockKey) ?? 0) + a);
    e.total += a;
    reads.set(k, e);
  }
  const dims = new Map<string, { row: DealBenchmarkRow; readers: Set<string>; blocks: Set<string> }>();
  for (const e of Array.from(reads.values())) {
    if (e.total <= 0) continue;
    const meta = pageMeta(e.renditionId, e.pageId);
    if (!meta) continue;
    const role = safeRole(meta.role);
    const layout = safeLayout(meta.layoutType);
    for (const b of meta.blocks) {
      if (b.virtual || b.when) continue;
      const kind = safeKind(String(b.kind));
      if (!kind || SKIP_KINDS.has(kind)) continue;
      const key = `${role}|${layout}|${kind}`;
      const d = dims.get(key) ?? {
        row: { pageRole: role, layoutType: layout, blockKind: kind, readers: 0, blocks: 0, attentionMs: 0, expectedMs: 0 },
        readers: new Set<string>(),
        blocks: new Set<string>(),
      };
      const att = e.blocks.get(b.key) ?? 0;
      d.row.attentionMs += att;
      d.row.expectedMs += Math.max(0, b.expectedMs || 0);
      d.blocks.add(`${e.renditionId}|${e.pageId}|${b.key}`);
      if (att > 0) d.readers.add(e.accessId);
      dims.set(key, d);
    }
  }
  return Array.from(dims.values())
    .filter((d) => d.row.expectedMs > 0)
    .map((d) => ({ ...d.row, readers: d.readers.size, blocks: d.blocks.size, attentionMs: Math.round(d.row.attentionMs), expectedMs: Math.round(d.row.expectedMs) }))
    .sort((a, b) => a.pageRole.localeCompare(b.pageRole) || a.layoutType.localeCompare(b.layoutType) || a.blockKind.localeCompare(b.blockKind));
}

/** Reads a deal's rollups + served pages and returns its benchmark rows (no writes). */
export async function computeDealBenchmarks(dealId: string): Promise<DealBenchmarkRow[]> {
  const rows = await db.execute<{ rendition_id: string | null; page_id: string; block_key: string; access_id: string; att: string | number }>(sql`
    SELECT r.rendition_id, r.page_id, r.block_key, r.buyer_access_id AS access_id, SUM(r.attention_ms)::bigint AS att
    FROM reading_rollups r
    JOIN buyer_visits v ON v.id = r.visit_id
    WHERE r.deal_id = ${dealId} AND v.self_view = false AND v.clamped = false AND v.legacy = false AND v.mode IS DISTINCT FROM 'teaser'
    GROUP BY r.rendition_id, r.page_id, r.block_key, r.buyer_access_id
  `);
  const rollups: BenchmarkRollupRow[] = Array.from(rows as unknown as Array<Record<string, unknown>>).map((r) => ({
    renditionId: (r.rendition_id as string | null) ?? null,
    pageId: String(r.page_id),
    blockKey: String(r.block_key ?? ""),
    accessId: String(r.access_id),
    attentionMs: Number(r.att) || 0,
  }));
  const renditionIds = Array.from(new Set(rollups.map((r) => r.renditionId).filter((x): x is string => !!x)));
  if (renditionIds.length === 0) return [];
  const [renditions, sections] = await Promise.all([
    db.select({ id: cimRenditions.id, pageIndex: cimRenditions.pageIndex }).from(cimRenditions)
      .where(and(eq(cimRenditions.dealId, dealId), inArray(cimRenditions.id, renditionIds))),
    db.select({
      id: cimSections.id, title: cimSections.sectionTitle, key: cimSections.sectionKey,
      layoutType: cimSections.layoutType, layoutData: cimSections.layoutData, lineage: cimSections.analyticsLineage,
    }).from(cimSections).where(eq(cimSections.dealId, dealId)),
  ]);
  const byId = new Map(sections.map((s) => [s.id, s]));
  const byLineage = new Map(sections.map((s) => [s.lineage || s.id, s]));
  const pages = new Map<string, RenditionPage>();
  for (const r of renditions) for (const p of (r.pageIndex ?? []) as RenditionPage[]) pages.set(`${r.id}|${p.pageId}`, p);
  return computeBenchmarkRows(rollups, (rid, pageId) => {
    const p = pages.get(`${rid}|${pageId}`);
    if (!p) return null;
    // The REAL title decides the role (broker side, never stored); the served
    // (possibly blind) title only when the section no longer exists.
    const live = byId.get(pageId) ?? byLineage.get(p.lineageId);
    const role = pageRole({
      layoutType: p.layoutType, title: live?.title ?? p.servedTitle, sectionKey: live?.key ?? null,
      layoutData: live?.layoutData, pageId,
    });
    return { layoutType: p.layoutType, role, blocks: p.blocks };
  });
}

/**
 * Recompute and store a deal's benchmark rows (one transaction: the deal's
 * old rows go, the new ones are upserted on the unique dimensions). Demo /
 * QA deals and deals without an industry never write. Returns the rows
 * written (empty when skipped).
 */
export async function recomputeDealBenchmarks(dealId: string): Promise<{ skipped: string | null; rows: DealBenchmarkRow[]; industry: string | null }> {
  const [deal] = await db.select({ id: deals.id, industry: deals.industry, demoKey: deals.demoKey }).from(deals).where(eq(deals.id, dealId)).limit(1);
  if (!deal) return { skipped: "no deal", rows: [], industry: null };
  if (deal.demoKey) return { skipped: "demo deal", rows: [], industry: null };
  const industry = (deal.industry || "").trim();
  if (!industry) return { skipped: "no industry", rows: [], industry: null };
  const rows = await computeDealBenchmarks(dealId);
  await db.transaction(async (tx) => {
    await tx.delete(readingBenchmarks).where(eq(readingBenchmarks.dealId, dealId));
    if (rows.length === 0) return;
    await tx.insert(readingBenchmarks).values(rows.map((r) => ({ dealId, industry, ...r, updatedAt: new Date() })))
      .onConflictDoUpdate({
        target: [readingBenchmarks.dealId, readingBenchmarks.pageRole, readingBenchmarks.layoutType, readingBenchmarks.blockKind],
        set: {
          industry: sql`excluded.industry`,
          readers: sql`excluded.readers`,
          blocks: sql`excluded.blocks`,
          attentionMs: sql`excluded.attention_ms`,
          expectedMs: sql`excluded.expected_ms`,
          updatedAt: sql`now()`,
        },
      });
  });
  return { skipped: null, rows, industry };
}

export interface IndustryBenchmarkRow {
  dealId: string;
  pageRole: string;
  layoutType: string;
  blockKind: string;
  readers: number;
  attentionMs: number;
  expectedMs: number;
}

/** Every non-demo deal's benchmark rows for an industry (case-insensitive), optionally without one broker's deals. */
export async function industryBenchmarkRows(industry: string, opts: { excludeBrokerId?: string } = {}): Promise<IndustryBenchmarkRow[]> {
  const ind = industry.trim().toLowerCase();
  if (!ind) return [];
  const rows = await db.select({
    dealId: readingBenchmarks.dealId, pageRole: readingBenchmarks.pageRole, layoutType: readingBenchmarks.layoutType,
    blockKind: readingBenchmarks.blockKind, readers: readingBenchmarks.readers,
    attentionMs: readingBenchmarks.attentionMs, expectedMs: readingBenchmarks.expectedMs,
  }).from(readingBenchmarks)
    .innerJoin(deals, eq(deals.id, readingBenchmarks.dealId))
    .where(and(
      sql`lower(${readingBenchmarks.industry}) = ${ind}`,
      sql`${deals.demoKey} IS NULL`,
      opts.excludeBrokerId ? sql`${deals.brokerId} <> ${opts.excludeBrokerId}` : sql`true`,
    ));
  return rows.map((r) => ({ ...r, readers: Number(r.readers) || 0, attentionMs: Number(r.attentionMs) || 0, expectedMs: Number(r.expectedMs) || 0 }));
}

/**
 * Pure: the anonymous industry benchmark per page role — the median over
 * deals of each deal's study ratio (reading time ÷ expected) — only where
 * at least `minDeals` deals stand behind the figure.
 */
export function roleBenchmarks(rows: IndustryBenchmarkRow[], minDeals = BENCHMARK_MIN_DEALS): Array<{ role: PageRole; medianStudyRatio: number; deals: number }> {
  const perDeal = new Map<string, Map<string, { att: number; exp: number }>>();
  for (const r of rows) {
    const role = safeRole(r.pageRole);
    const m = perDeal.get(role) ?? new Map();
    const e = m.get(r.dealId) ?? { att: 0, exp: 0 };
    e.att += r.attentionMs;
    e.exp += r.expectedMs;
    m.set(r.dealId, e);
    perDeal.set(role, m);
  }
  const out: Array<{ role: PageRole; medianStudyRatio: number; deals: number }> = [];
  for (const [role, m] of Array.from(perDeal.entries())) {
    const ratios = Array.from(m.values()).filter((e) => e.exp > 0).map((e) => e.att / e.exp).sort((a, b) => a - b);
    if (ratios.length < minDeals) continue;
    const mid = Math.floor(ratios.length / 2);
    const med = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
    out.push({ role: role as PageRole, medianStudyRatio: Math.round(med * 100) / 100, deals: ratios.length });
  }
  return out.sort((a, b) => a.role.localeCompare(b.role));
}
