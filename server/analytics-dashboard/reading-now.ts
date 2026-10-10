/**
 * "Reading now" — one cheap indexed read (buyer_visits_deal_seen_idx on
 * (deal_id, last_seen_at)), polled every 30 s (Analytics) / 20 s (deal).
 *
 * The one direct buyer_visits read of the analytics dashboards (everything
 * else goes through the reading facts). It stays right as other streams
 * change the facts:
 *   - superseded (hidden) visits are always legacy, and NOT v.legacy
 *     excludes them (INTEGRATION §2.13);
 *   - example-deal sample visits keep their old September times, so are
 *     never within 90 s;
 *   - last_seen_at advances only when ACTIVE time grows
 *     (server/analytics/reading-ingest.ts), so an idle, hidden or paused
 *     visit (the data-room drawer pauses the tracker) drops out within 90 s;
 *   - mode 'teaser' (a teaser read) is reported as document "teaser".
 */
import { sql, type SQL } from "drizzle-orm";
import { READING_RULES } from "@shared/analytics-v2";
import type { ReadingNowRow } from "@shared/analytics-dashboard";
import { TEASER_ACCESS_LEVEL, renditionKindFor } from "@shared/access-levels";

/** The rendition mode a teaser read is recorded under (from the registry, never a literal). */
const TEASER_MODE = renditionKindFor(TEASER_ACCESS_LEVEL).mode;

export interface ReadingNowDbRow {
  accessId: string;
  dealId: string;
  mode: string | null;
  lastSeenAt: Date;
  name: string | null;
  email: string;
  company: string | null;
}

/** Pure: the statement (tested for its exclusions and its window). */
export function readingNowSql(dealIds: string[], since: Date, now: Date): SQL {
  const ids = sql.join(dealIds.map((id) => sql`${id}`), sql`, `);
  return sql`
    SELECT v.buyer_access_id, v.deal_id, v.mode, v.last_seen_at, a.buyer_name, a.buyer_email, a.buyer_company
    FROM buyer_visits v JOIN buyer_access a ON a.id = v.buyer_access_id
    WHERE v.deal_id = ANY(ARRAY[${ids}]::varchar[])
      AND v.last_seen_at > ${since.toISOString()}::timestamp AND v.last_seen_at <= ${now.toISOString()}::timestamp
      AND NOT v.self_view AND NOT v.clamped AND NOT v.legacy AND a.revoked_at IS NULL
    ORDER BY v.last_seen_at DESC
    LIMIT 50`;
}

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const orNull = (v: unknown): string | null => (v == null ? null : String(v));

/** Buyers reading right now on these deals (newest first; at most 50 visits). */
export async function readingNowRows(dealIds: string[], now: Date = new Date()): Promise<ReadingNowDbRow[]> {
  if (dealIds.length === 0) return [];
  const { db } = await import("../db");
  const since = new Date(now.getTime() - READING_RULES.readingNowMs);
  const rows = (await db.execute(readingNowSql(dealIds, since, now))) as unknown as Array<Record<string, unknown>>;
  return rows.map((x) => ({
    accessId: String(x.buyer_access_id),
    dealId: String(x.deal_id),
    mode: orNull(x.mode),
    lastSeenAt: asDate(x.last_seen_at),
    name: orNull(x.buyer_name),
    email: String(x.buyer_email ?? ""),
    company: orNull(x.buyer_company),
  }));
}

/** Pure: one row per buyer link (its latest visit), teaser reads marked as such. */
export function readingNowResponseRows(rows: ReadingNowDbRow[], dealNameOf: (dealId: string) => string): ReadingNowRow[] {
  const seen = new Set<string>();
  const out: ReadingNowRow[] = [];
  for (const r of [...rows].sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())) {
    if (seen.has(r.accessId)) continue;
    seen.add(r.accessId);
    out.push({
      accessId: r.accessId,
      dealId: r.dealId,
      dealName: dealNameOf(r.dealId),
      name: r.name || r.email,
      company: r.company,
      document: r.mode === TEASER_MODE ? "teaser" : "cim",
      since: r.lastSeenAt.toISOString(),
      page: null,
    });
  }
  return out;
}
