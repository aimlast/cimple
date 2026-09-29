/**
 * Legacy reading backfill: turns the OLD tracker's section-exit events
 * (analytics_events.event_type = 'section_exit', before reading analytics v2)
 * into page-level reading on synthetic legacy visits, so a deal's older
 * buyers still show in the Engagement tab ("Page-level only — recorded
 * before detailed reading tracking"). Offline, no AI, idempotent (visit and
 * rollup ids are derived from the events, re-runs change nothing).
 *
 *   - only events whose section key still resolves to a current section
 *     (real keys, or the blind view's neutral s_<id> keys) are used;
 *   - one legacy visit per buyer link per 30-minute session;
 *   - the old tracker double counted overlapping sections, so a session's
 *     section seconds are scaled down to fit its wall-clock span;
 *   - cursor heat-map samples are never read (they carry no page).
 *
 * DRY RUN by default. --apply writes. Deals outside the qa_cimgen account
 * also need --allow-real (the founder's go-ahead: never on broker_demo
 * without it).
 *
 *   ANTHROPIC_API_KEY=disabled DATABASE_URL=… npx tsx scripts/backfill-legacy-reading.ts --deal <id> [--apply] [--allow-real]
 */
import { createHash } from "crypto";
import { sql } from "drizzle-orm";
import { db } from "../server/db";
import { storage } from "../server/storage";
import { asDate } from "../server/analytics/reading-ingest";
import { cimModeForAccessLevel } from "../shared/cim-layouts";
import { blindSectionKey } from "../shared/cim-buyer-view";
import { READING_RULES } from "../shared/analytics-v2";


/** A uuid-shaped id derived from a string (stable across runs). */
function stableUuid(s: string): string {
  const h = createHash("sha256").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

interface Exit { accessId: string; key: string; seconds: number; at: Date }

export interface LegacySession {
  visitId: string;
  accessId: string;
  startedAt: Date;
  lastSeenAt: Date;
  activeMs: number;
  wallMs: number;
  path: Array<[number, string]>;
  pages: Map<string, number>;   // pageId → attention ms
}

/** Section-exit events of one buyer → legacy sessions (pure). */
export function legacySessions(exits: Exit[], resolve: (key: string) => string | null): LegacySession[] {
  const out: LegacySession[] = [];
  const byAccess = new Map<string, Exit[]>();
  for (const e of exits) byAccess.set(e.accessId, [...(byAccess.get(e.accessId) ?? []), e]);
  byAccess.forEach((list, accessId) => {
    list.sort((a, b) => a.at.getTime() - b.at.getTime());
    let cur: Exit[] = [];
    const flush = () => {
      const used = cur.map((e) => ({ ...e, pageId: resolve(e.key) })).filter((e) => e.pageId && e.seconds > 0) as Array<Exit & { pageId: string }>;
      cur = [];
      if (used.length === 0) return;
      const start = new Date(used[0].at.getTime() - used[0].seconds * 1000);
      const end = used[used.length - 1].at;
      const wallMs = Math.max(1000, end.getTime() - start.getTime());
      const raw = used.reduce((s, e) => s + e.seconds * 1000, 0);
      const f = raw > wallMs ? wallMs / raw : 1;   // overlapping sections were double counted
      const pages = new Map<string, number>();
      const path: Array<[number, string]> = [];
      let t = 0;
      for (const e of used) {
        const ms = Math.round(e.seconds * 1000 * f);
        pages.set(e.pageId, (pages.get(e.pageId) ?? 0) + ms);
        if (!path.length || path[path.length - 1][1] !== e.pageId) path.push([Math.floor(t / 1000), e.pageId]);
        t += ms;
      }
      out.push({
        visitId: stableUuid(`legacy|${accessId}|${start.toISOString()}`),
        accessId, startedAt: start, lastSeenAt: end, wallMs, activeMs: Math.min(wallMs, Math.round(raw * f)), path, pages,
      });
    };
    for (const e of list) {
      if (cur.length && e.at.getTime() - cur[cur.length - 1].at.getTime() > READING_RULES.visitGapMs) flush();
      cur.push(e);
    }
    flush();
  });
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const dealId = (() => { const i = args.indexOf("--deal"); return i >= 0 ? args[i + 1] : undefined; })();
  const apply = args.includes("--apply");
  const allowReal = args.includes("--allow-real");
  if (!dealId) throw new Error("usage: --deal <id> [--apply] [--allow-real]");
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error("no such deal");
  const broker = deal.brokerId ? await storage.getUser(deal.brokerId) : undefined;
  if (apply && broker?.username !== "qa_cimgen" && !allowReal) {
    throw new Error(`refusing to write to "${deal.businessName}" (not a qa_cimgen deal) without --allow-real`);
  }
  const sections = await storage.getCimSectionsByDeal(deal.id);
  const byKey = new Map(sections.map((s) => [s.sectionKey, s]));
  const resolve = (key: string): string | null => {
    const s = byKey.get(key) ?? sections.find((x) => blindSectionKey(x.id) === key);
    return s ? s.id : null;
  };
  const lineage = new Map(sections.map((s) => [s.id, s.analyticsLineage || s.id]));
  const accesses = new Map((await storage.getBuyerAccessByDeal(deal.id)).map((a) => [a.id, a]));
  const rows = (await db.execute(sql`
    SELECT buyer_access_id, section_key, time_spent_seconds, created_at FROM analytics_events
    WHERE deal_id = ${deal.id} AND event_type = 'section_exit' AND buyer_access_id IS NOT NULL AND section_key IS NOT NULL
    ORDER BY buyer_access_id, created_at`)) as unknown as Array<Record<string, unknown>>;
  const exits: Exit[] = rows
    .filter((r) => accesses.has(String(r.buyer_access_id)))
    .map((r) => ({ accessId: String(r.buyer_access_id), key: String(r.section_key), seconds: Number(r.time_spent_seconds ?? 0) || 0, at: asDate(r.created_at) }));
  const sessions = legacySessions(exits, resolve);
  const unresolved = new Set(exits.filter((e) => !resolve(e.key)).map((e) => e.key));
  console.log(JSON.stringify({
    deal: deal.businessName, apply, exits: exits.length, sessions: sessions.length,
    buyers: new Set(sessions.map((s) => s.accessId)).size,
    unresolvedKeys: unresolved.size, pageRows: sessions.reduce((s, x) => s + x.pages.size, 0),
  }, null, 2));
  if (!apply) return;
  for (const s of sessions) {
    const a = accesses.get(s.accessId)!;
    await db.execute(sql`
      INSERT INTO buyer_visits (id, deal_id, buyer_access_id, rendition_id, mode, access_level, device_class, started_at, last_seen_at,
        wall_ms, active_ms, idle_ms, hidden_ms, away_ms, outside_ms, max_page_index, path, self_view, clamped, legacy)
      VALUES (${s.visitId}, ${deal.id}, ${s.accessId}, NULL, ${cimModeForAccessLevel(a.accessLevel)}, ${a.accessLevel}, NULL,
        ${s.startedAt.toISOString()}::timestamp, ${s.lastSeenAt.toISOString()}::timestamp, ${s.wallMs}, ${s.activeMs}, ${Math.max(0, s.wallMs - s.activeMs)}, 0, 0, 0,
        NULL, ${JSON.stringify(s.path)}::jsonb, false, false, true)
      ON CONFLICT (id) DO NOTHING`);
    for (const [pageId, ms] of s.pages) {
      await db.execute(sql`
        INSERT INTO reading_rollups (visit_id, page_id, block_key, deal_id, buyer_access_id, rendition_id, lineage_id, attention_ms, skim_ms, visible_ms, pointer_ms, first_at, last_at)
        VALUES (${s.visitId}, ${pageId}, '', ${deal.id}, ${s.accessId}, NULL, ${lineage.get(pageId) ?? pageId}, ${ms}, 0, ${ms}, 0,
          ${s.startedAt.toISOString()}::timestamp, ${s.lastSeenAt.toISOString()}::timestamp)
        ON CONFLICT (visit_id, page_id, block_key) DO NOTHING`);
    }
  }
  console.log(`wrote ${sessions.length} legacy visits`);
}

if (process.argv[1] && /backfill-legacy-reading/.test(process.argv[1])) {
  main().then(() => process.exit(0)).catch((err) => { console.error(String(err?.message ?? err)); process.exit(1); });
}
