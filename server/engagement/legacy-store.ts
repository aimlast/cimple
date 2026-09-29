/**
 * Storing the OLD tracker's reading for good (server/engagement/legacy.ts
 * reads it on the fly otherwise). Used by scripts/backfill-legacy-reading.ts
 * (the broker's choice, dry run first) and — automatically — by
 * generation-jobs.ts persistDocument just before a regeneration replaces
 * the sections, while the old keys still name the pages buyers read
 * (release review DEP-1: Beacon's rebuild renamed 13 section keys and the
 * on-the-fly view lost 155 of its 221 page exits).
 *
 * Each legacy visit keeps every exit (a visit's time is the buyer's, whatever
 * became of the page); each page row keeps the OLD KEY as its page id and the
 * lineage of the section it was on then, so any later regeneration finds its
 * page again — by lineage (assignLineage continues it), else by the key's
 * words (legacyKeyResolver). No rendition is recorded: the facts loader
 * draws legacy reading on the CIM as it is served now (facts.ts, DEP-2).
 *
 * Idempotent: visit ids come from the buyer link and the session's first
 * exit (stableUuid), and a visit already stored is left whole — its page rows
 * are never planned again (unstoredRows). A blind view's s_<id> key is stored
 * under the key of the section it resolves to AT THAT TIME, so a later store
 * (the next regeneration, or a backfill run) would otherwise name the same
 * reading under the renamed section's key and ON CONFLICT (visit, page)
 * wouldn't catch it — the page's time doubled (release review, DEP-1/DEP-2
 * follow-up). Rows are still inserted ON CONFLICT DO NOTHING. No AI.
 */
import { sql } from "drizzle-orm";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { blindSectionKey } from "@shared/cim-buyer-view";
import { legacyKeyResolver, legacySessions, type LegacyExit, type LegacySection, type LegacySession } from "./legacy";

const BLIND_KEY_RE = /^s_[a-z0-9]{4,}$/i;

export interface LegacyVisitRow {
  id: string;
  accessId: string;
  mode: string;
  accessLevel: string;
  startedAt: Date;
  lastSeenAt: Date;
  wallMs: number;
  activeMs: number;
  path: Array<[number, string]>;
}

export interface LegacyRollupRow {
  visitId: string;
  accessId: string;
  /** The old section key (or the blind view's s_<id> key) the buyer read. */
  pageId: string;
  /** The lineage of the section that key was on when stored (null: no current page). */
  lineageId: string | null;
  attentionMs: number;
  firstAt: Date;
  lastAt: Date;
}

export interface LegacyStorePlan {
  exits: number;
  sessions: number;
  buyers: number;
  visits: LegacyVisitRow[];
  rollups: LegacyRollupRow[];
  /** Each old key: how many exits, and the current page it is placed on (null: none). */
  keys: Array<{ key: string; exits: number; placedOn: { id: string; title: string | null } | null }>;
}

/**
 * The rows to store for a deal's old section exits, placed against its
 * current sections. Pure.
 */
export function planLegacyRows(
  exits: ReadonlyArray<LegacyExit>,
  accesses: ReadonlyArray<{ id: string; accessLevel: string }>,
  sections: ReadonlyArray<LegacySection>,
): LegacyStorePlan {
  const byAccess = new Map(accesses.map((a) => [a.id, a]));
  const known = exits.filter((e) => byAccess.has(e.accessId));
  const sessions: LegacySession[] = legacySessions([...known], (key) => key);
  const resolve = legacyKeyResolver(sections, blindSectionKey);
  const byId = new Map(sections.map((s) => [s.id, s]));
  const placed = new Map<string, LegacySection | null>();
  const place = (key: string) => {
    if (!placed.has(key)) placed.set(key, byId.get(resolve(key) ?? "") ?? null);
    return placed.get(key)!;
  };
  // A blind view's neutral s_<id> key is stored under its section's own key
  // (it names nothing once that section is gone; "patient_base" still
  // does). Every other key is kept as recorded.
  const pageKey = (key: string) => (BLIND_KEY_RE.test(key) ? place(key)?.sectionKey || key : key);
  const visits: LegacyVisitRow[] = [];
  const rollups: LegacyRollupRow[] = [];
  for (const s of sessions) {
    const a = byAccess.get(s.accessId)!;
    visits.push({
      id: s.visitId, accessId: s.accessId, mode: cimModeForAccessLevel(a.accessLevel), accessLevel: a.accessLevel,
      startedAt: s.startedAt, lastSeenAt: s.lastSeenAt, wallMs: s.wallMs, activeMs: s.activeMs,
      path: s.path.map(([t, key]) => [t, pageKey(key)] as [number, string]),
    });
    const pages = new Map<string, { ms: number; sec: LegacySection | null }>();
    s.pages.forEach((ms, key) => {
      const k = pageKey(key);
      const prev = pages.get(k);
      pages.set(k, { ms: (prev?.ms ?? 0) + ms, sec: prev?.sec ?? place(key) });
    });
    pages.forEach(({ ms, sec }, key) => {
      rollups.push({
        visitId: s.visitId, accessId: s.accessId, pageId: key, lineageId: sec ? sec.analyticsLineage || sec.id : null,
        attentionMs: ms, firstAt: s.startedAt, lastAt: s.lastSeenAt,
      });
    });
  }
  const counts = new Map<string, number>();
  for (const e of known) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
  const keys = Array.from(counts.entries())
    .sort((x, y) => y[1] - x[1])
    .map(([key, n]) => {
      const sec = place(key);
      return { key, exits: n, placedOn: sec ? { id: sec.id, title: sec.sectionTitle ?? null } : null };
    });
  return { exits: known.length, sessions: sessions.length, buyers: new Set(sessions.map((s) => s.accessId)).size, visits, rollups, keys };
}

/**
 * The part of a plan not stored yet: visits whose id is already stored are
 * dropped with every page row of theirs (a stored visit is kept exactly as
 * it was stored). Pure.
 */
export function unstoredRows(plan: LegacyStorePlan, storedVisitIds: ReadonlySet<string>): { visits: LegacyVisitRow[]; rollups: LegacyRollupRow[] } {
  return {
    visits: plan.visits.filter((v) => !storedVisitIds.has(v.id)),
    rollups: plan.rollups.filter((r) => !storedVisitIds.has(r.visitId)),
  };
}

async function db() {
  return (await import("../db")).db;
}

/** A deal's old section exits that no part-by-part visit covers (every one — stored or not). */
async function loadExits(dealId: string): Promise<LegacyExit[]> {
  const { asDate } = await import("../analytics/reading-ingest");
  const rows = (await (await db()).execute(sql`
    SELECT e.buyer_access_id, e.section_key, e.time_spent_seconds, e.created_at FROM analytics_events e
    WHERE e.deal_id = ${dealId} AND e.event_type = 'section_exit' AND e.buyer_access_id IS NOT NULL AND e.section_key IS NOT NULL
      AND e.created_at < COALESCE((SELECT MIN(v.started_at) FROM buyer_visits v WHERE v.deal_id = ${dealId} AND NOT v.legacy AND NOT v.self_view), 'infinity'::timestamp)
    ORDER BY e.buyer_access_id, e.created_at
    LIMIT 50000`)) as unknown as Array<Record<string, unknown>>;
  return rows.map((r) => ({ accessId: String(r.buyer_access_id), key: String(r.section_key), seconds: Number(r.time_spent_seconds ?? 0) || 0, at: asDate(r.created_at) }));
}

/** What storing would write for this deal, against its current sections (read-only). */
export async function planLegacyReading(dealId: string): Promise<LegacyStorePlan> {
  const { storage } = await import("../storage");
  const [exits, accesses, sections] = await Promise.all([
    loadExits(dealId),
    storage.getBuyerAccessByDeal(dealId),
    storage.getCimSectionsByDeal(dealId),
  ]);
  return planLegacyRows(exits, accesses, sections);
}

/**
 * Stores the deal's old-tracker reading (idempotent — visits already stored
 * are kept as they are, page rows and all). Resolves to what was planned,
 * with how many visits were already stored; nothing is written when there is
 * no old reading. One transaction, one store per deal at a time.
 */
export async function storeLegacyReading(dealId: string): Promise<LegacyStorePlan & { alreadyStored: number }> {
  const plan = await planLegacyReading(dealId);
  if (plan.visits.length === 0) return { ...plan, alreadyStored: 0 };
  const d = await db();
  const ts = (x: Date) => sql`${x.toISOString()}::timestamp`;
  let alreadyStored = 0;
  await d.transaction(async (tx) => {
    // A regeneration and a backfill run at once must not both see "not stored".
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`legacy-store:${dealId}`}))`);
    const have = (await tx.execute(sql`SELECT id FROM buyer_visits WHERE deal_id = ${dealId} AND legacy`)) as unknown as Array<{ id: unknown }>;
    const storedIds = new Set(Array.from(have ?? [], (r) => String(r.id)));
    const todo = unstoredRows(plan, storedIds);
    alreadyStored = plan.visits.length - todo.visits.length;
    for (let i = 0; i < todo.visits.length; i += 200) {
      const chunk = todo.visits.slice(i, i + 200);
      await tx.execute(sql`
        INSERT INTO buyer_visits (id, deal_id, buyer_access_id, rendition_id, mode, access_level, device_class, started_at, last_seen_at,
          wall_ms, active_ms, idle_ms, hidden_ms, away_ms, outside_ms, max_page_index, path, self_view, clamped, legacy)
        VALUES ${sql.join(chunk.map((v) => sql`(${v.id}, ${dealId}, ${v.accessId}, NULL, ${v.mode}, ${v.accessLevel}, NULL, ${ts(v.startedAt)}, ${ts(v.lastSeenAt)},
          ${v.wallMs}, ${v.activeMs}, ${Math.max(0, v.wallMs - v.activeMs)}, 0, 0, 0, NULL, ${JSON.stringify(v.path)}::jsonb, false, false, true)`), sql`, `)}
        ON CONFLICT (id) DO NOTHING`);
    }
    for (let i = 0; i < todo.rollups.length; i += 400) {
      const chunk = todo.rollups.slice(i, i + 400);
      await tx.execute(sql`
        INSERT INTO reading_rollups (visit_id, page_id, block_key, deal_id, buyer_access_id, rendition_id, lineage_id, attention_ms, skim_ms, visible_ms, pointer_ms, first_at, last_at)
        VALUES ${sql.join(chunk.map((r) => sql`(${r.visitId}, ${r.pageId}, '', ${dealId}, ${r.accessId}, NULL, ${r.lineageId}, ${r.attentionMs}, 0, ${r.attentionMs}, 0, ${ts(r.firstAt)}, ${ts(r.lastAt)})`), sql`, `)}
        ON CONFLICT (visit_id, page_id, block_key) DO NOTHING`);
    }
  });
  return { ...plan, alreadyStored };
}
