/**
 * The SQL behind the engagement APIs: grouped reads over reading_rollups /
 * buyer_visits / analytics_events / cim_renditions for one deal and one
 * filter set. Every query is a GROUP BY or a bounded per-deal read — raw
 * events are never loaded wholesale into JS. Self views (the owning broker
 * previewing the room) and CLAMPED visits (a send claimed more reading than
 * the server saw time pass — a buggy or forged client) are excluded here,
 * once, for everything above.
 *
 * `ReadingSource` is the seam: dbReadingSource runs the SQL; tests build
 * one from the in-memory ingest store (memoryReadingSource) so the
 * aggregation is exercised end to end without a database.
 */
import { sql, type SQL } from "drizzle-orm";
import type { EngagementDevice, RenditionPage } from "@shared/analytics-v2";
import { asDate, type MemoryReadingStore } from "../analytics/reading-ingest";
import type { LegacyExit } from "./legacy";

export interface ReadingQuery {
  dealId: string;
  /** Visits last seen at or after this (null = all time). */
  since: Date | null;
  device: EngagementDevice;
  /** Only these buyer links (null = every link of the deal). */
  accessIds: string[] | null;
}

export interface RawRendition {
  id: string;
  mode: string;
  variant: string;
  createdAt: Date;
  /** Non-self visits on it (all time). */
  visits: number;
}

export interface RawVisit {
  id: string;
  accessId: string;
  renditionId: string | null;
  startedAt: Date;
  lastSeenAt: Date;
  wallMs: number;
  activeMs: number;
  deviceClass: string | null;
  uaFamily: string | null;
  maxPageIndex: number | null;
  path: Array<[number, string]>;
  legacy: boolean;
  ipHash: string | null;
  /** Sample reading on an example deal (buyer_visits.demo_seed); absent/null = real. */
  demoSeed?: string | null;
}

/** Reading per (buyer, rendition, page, block), summed over the filtered visits. */
export interface RawBlockSum {
  accessId: string;
  renditionId: string | null;
  lineageId: string | null;
  pageId: string;
  blockKey: string;
  attentionMs: number;
  skimMs: number;
  visibleMs: number;
  pointerMs: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

/** Attention per (buyer, visit, rendition, page) — how many visits touched a page. */
export interface RawVisitPage {
  accessId: string;
  visitId: string;
  renditionId: string | null;
  lineageId: string | null;
  pageId: string;
  attentionMs: number;
}

export interface RawEvent {
  accessId: string;
  visitId: string;
  renditionId: string | null;
  type: string;
  pageId: string;
  blockKey: string | null;
  detail: string | null;
  seq: number;
  at: string;
}

export interface RawQuestion {
  id: string;
  accessId: string | null;
  text: string;
  askedAt: Date;
  pageId: string | null;
  status: string;
  answered: boolean;
}

export interface RawDecision {
  accessId: string;
  decision: string;
  at: Date;
}

/** One stored rendition in full (what the viewer renders). */
export interface RenditionRow extends RawRendition {
  sections: unknown[];
  design: unknown;
  pageIndex: RenditionPage[];
}

export interface ReadingSource {
  renditions(dealId: string): Promise<RawRendition[]>;
  /** The rendition, only when it belongs to this deal. */
  rendition(dealId: string, id: string): Promise<RenditionRow | null>;
  pageIndexes(ids: string[]): Promise<Map<string, RenditionPage[]>>;
  visits(q: ReadingQuery): Promise<RawVisit[]>;
  blockSums(q: ReadingQuery): Promise<RawBlockSum[]>;
  visitPages(q: ReadingQuery): Promise<RawVisitPage[]>;
  events(q: ReadingQuery): Promise<RawEvent[]>;
  questions(dealId: string): Promise<RawQuestion[]>;
  decisions(dealId: string): Promise<RawDecision[]>;
  /**
   * The OLD tracker's section exits (server/engagement/legacy.ts) that no
   * stored visit covers: none once a legacy backfill was written, and only
   * those before the deal's first part-by-part visit (no double counting).
   */
  legacyExits(dealId: string): Promise<LegacyExit[]>;
  /**
   * The kept copy's sections (id, key, title only — projected in SQL, never
   * the whole snapshot row) and when it was taken; null when the deal has no
   * kept copy (server/engagement/titles.ts).
   */
  keptCopyTitles?(dealId: string): Promise<KeptCopyTitles | null>;
}

/** The kept copy as the titles need it (server/cim/published-snapshot.ts holds the copy). */
export interface KeptCopyTitles {
  takenAt: Date;
  sections: Array<{ id: string; sectionKey: string; sectionTitle: string }>;
}

const num = (v: unknown) => Number(v ?? 0) || 0;
const orNull = (v: unknown) => (v == null ? null : String(v));
const ANSWERED = new Set(["published", "answered", "approved"]);

/** The device filter: "desktop" includes tablets (a big screen), "phone" is phones only. */
function deviceMatches(device: EngagementDevice, cls: string | null): boolean {
  if (device === "all") return true;
  if (device === "phone") return cls === "phone";
  return cls !== "phone";
}

// ── Postgres ─────────────────────────────────────────────────────────────

function visitFilter(q: ReadingQuery, v = sql.raw("v")): SQL {
  const parts: SQL[] = [sql`${v}.deal_id = ${q.dealId}`, sql`NOT ${v}.self_view`, sql`NOT ${v}.clamped`];
  if (q.since) parts.push(sql`${v}.last_seen_at >= ${q.since.toISOString()}::timestamp`);
  if (q.device === "phone") parts.push(sql`${v}.device_class = 'phone'`);
  if (q.device === "desktop") parts.push(sql`COALESCE(${v}.device_class, 'desktop') <> 'phone'`);
  if (q.accessIds) {
    if (q.accessIds.length === 0) parts.push(sql`false`);
    else parts.push(sql`${v}.buyer_access_id IN (${sql.join(q.accessIds.map((id) => sql`${id}`), sql`, `)})`);
  }
  return sql.join(parts, sql` AND `);
}

async function rows(q: SQL): Promise<Array<Record<string, unknown>>> {
  const { db } = await import("../db");
  return (await db.execute(q)) as unknown as Array<Record<string, unknown>>;
}

export const dbReadingSource: ReadingSource = {
  async renditions(dealId) {
    const r = await rows(sql`
      SELECT r.id, r.mode, r.variant, r.created_at,
        (SELECT COUNT(*) FROM buyer_visits v WHERE v.rendition_id = r.id AND NOT v.self_view AND NOT v.clamped) AS visits
      FROM cim_renditions r WHERE r.deal_id = ${dealId} ORDER BY r.created_at`);
    return r.map((x) => ({ id: String(x.id), mode: String(x.mode), variant: String(x.variant), createdAt: asDate(x.created_at), visits: num(x.visits) }));
  },
  async rendition(dealId, id) {
    const r = await rows(sql`
      SELECT id, mode, variant, created_at, sections, design, page_index FROM cim_renditions
      WHERE id = ${id} AND deal_id = ${dealId} LIMIT 1`);
    const x = r[0];
    if (!x) return null;
    return {
      id: String(x.id), mode: String(x.mode), variant: String(x.variant), createdAt: asDate(x.created_at), visits: 0,
      sections: (x.sections as unknown[]) ?? [], design: x.design ?? null, pageIndex: (x.page_index as RenditionPage[]) ?? [],
    };
  },
  async pageIndexes(ids) {
    const out = new Map<string, RenditionPage[]>();
    if (ids.length === 0) return out;
    const r = await rows(sql`SELECT id, page_index FROM cim_renditions WHERE id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})`);
    for (const x of r) out.set(String(x.id), (x.page_index as RenditionPage[]) ?? []);
    return out;
  },
  async visits(q) {
    const r = await rows(sql`
      SELECT v.id, v.buyer_access_id, v.rendition_id, v.started_at, v.last_seen_at, v.wall_ms, v.active_ms, v.device_class,
        v.ua_family, v.max_page_index, v.path, v.legacy, v.ip_hash
      FROM buyer_visits v WHERE ${visitFilter(q)} ORDER BY v.started_at`);
    return r.map((x) => ({
      id: String(x.id), accessId: String(x.buyer_access_id), renditionId: orNull(x.rendition_id),
      startedAt: asDate(x.started_at), lastSeenAt: asDate(x.last_seen_at), wallMs: num(x.wall_ms), activeMs: num(x.active_ms),
      deviceClass: orNull(x.device_class), uaFamily: orNull(x.ua_family),
      maxPageIndex: x.max_page_index == null ? null : num(x.max_page_index),
      path: Array.isArray(x.path) ? (x.path as Array<[number, string]>) : [], legacy: !!x.legacy, ipHash: orNull(x.ip_hash),
    }));
  },
  async blockSums(q) {
    const r = await rows(sql`
      SELECT r.buyer_access_id, r.rendition_id, r.lineage_id, r.page_id, r.block_key,
        SUM(r.attention_ms) AS att, SUM(r.skim_ms) AS skim, SUM(r.visible_ms) AS vis, SUM(r.pointer_ms) AS ptr,
        MIN(r.first_at) AS first_at, MAX(r.last_at) AS last_at
      FROM reading_rollups r JOIN buyer_visits v ON v.id = r.visit_id
      WHERE r.deal_id = ${q.dealId} AND ${visitFilter(q)}
      GROUP BY r.buyer_access_id, r.rendition_id, r.lineage_id, r.page_id, r.block_key`);
    return r.map((x) => ({
      accessId: String(x.buyer_access_id), renditionId: orNull(x.rendition_id), lineageId: orNull(x.lineage_id),
      pageId: String(x.page_id), blockKey: String(x.block_key ?? ""),
      attentionMs: num(x.att), skimMs: num(x.skim), visibleMs: num(x.vis), pointerMs: num(x.ptr),
      firstAt: x.first_at ? asDate(x.first_at) : null, lastAt: x.last_at ? asDate(x.last_at) : null,
    }));
  },
  async visitPages(q) {
    const r = await rows(sql`
      SELECT r.buyer_access_id, r.visit_id, r.rendition_id, r.lineage_id, r.page_id, SUM(r.attention_ms) AS att
      FROM reading_rollups r JOIN buyer_visits v ON v.id = r.visit_id
      WHERE r.deal_id = ${q.dealId} AND ${visitFilter(q)} AND r.attention_ms > 0
      GROUP BY r.buyer_access_id, r.visit_id, r.rendition_id, r.lineage_id, r.page_id`);
    return r.map((x) => ({
      accessId: String(x.buyer_access_id), visitId: String(x.visit_id), renditionId: orNull(x.rendition_id),
      lineageId: orNull(x.lineage_id), pageId: String(x.page_id), attentionMs: num(x.att),
    }));
  },
  async events(q) {
    const r = await rows(sql`
      SELECT e.buyer_access_id, e.visit_id, e.rendition_id, e.event_type, e.page_id, e.block_key, e.event_data, e.client_seq, e.created_at
      FROM analytics_events e JOIN buyer_visits v ON v.id = e.visit_id
      WHERE e.deal_id = ${q.dealId} AND e.visit_id IS NOT NULL AND ${visitFilter(q)}
      ORDER BY e.visit_id, e.client_seq
      LIMIT 20000`);
    return r.map((x) => {
      const data = (x.event_data as { detail?: string | null; at?: string } | null) ?? {};
      return {
        accessId: String(x.buyer_access_id), visitId: String(x.visit_id), renditionId: orNull(x.rendition_id),
        type: String(x.event_type), pageId: String(x.page_id ?? ""), blockKey: orNull(x.block_key), detail: data.detail ?? null,
        seq: num(x.client_seq), at: typeof data.at === "string" ? data.at : asDate(x.created_at).toISOString(),
      };
    });
  },
  async questions(dealId) {
    const r = await rows(sql`
      SELECT id, buyer_access_id, question, created_at, section_id, status, published_answer
      FROM buyer_questions WHERE deal_id = ${dealId} ORDER BY created_at`);
    return r.map((x) => ({
      id: String(x.id), accessId: orNull(x.buyer_access_id), text: String(x.question ?? ""), askedAt: asDate(x.created_at),
      pageId: orNull(x.section_id), status: String(x.status ?? ""), answered: ANSWERED.has(String(x.status)) || !!x.published_answer,
    }));
  },
  async decisions(dealId) {
    const r = await rows(sql`
      SELECT buyer_access_id, event_data, created_at FROM analytics_events
      WHERE deal_id = ${dealId} AND event_type = 'decision' AND buyer_access_id IS NOT NULL ORDER BY created_at`);
    return r
      .map((x) => ({ accessId: String(x.buyer_access_id), decision: String((x.event_data as { decision?: string } | null)?.decision ?? ""), at: asDate(x.created_at) }))
      .filter((d) => !!d.decision);
  },
  async legacyExits(dealId) {
    const r = await rows(sql`
      SELECT e.buyer_access_id, e.section_key, e.time_spent_seconds, e.created_at FROM analytics_events e
      WHERE e.deal_id = ${dealId} AND e.event_type = 'section_exit' AND e.buyer_access_id IS NOT NULL AND e.section_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM buyer_visits v WHERE v.deal_id = ${dealId} AND v.legacy)
        AND e.created_at < COALESCE((SELECT MIN(v.started_at) FROM buyer_visits v WHERE v.deal_id = ${dealId} AND NOT v.legacy AND NOT v.self_view), 'infinity'::timestamp)
      ORDER BY e.buyer_access_id, e.created_at
      LIMIT 50000`);
    return r.map((x) => ({ accessId: String(x.buyer_access_id), key: String(x.section_key), seconds: Number(x.time_spent_seconds ?? 0) || 0, at: asDate(x.created_at) }));
  },
  async keptCopyTitles(dealId) {
    const r = await rows(sql`
      SELECT s->>'id' AS id, s->>'sectionKey' AS section_key, s->>'sectionTitle' AS section_title, p.taken_at
      FROM cim_published_snapshots p, jsonb_array_elements(p.sections) s
      WHERE p.deal_id = ${dealId}
        AND p.taken_at = (SELECT MAX(taken_at) FROM cim_published_snapshots WHERE deal_id = ${dealId})`);
    if (r.length === 0) return null;
    return {
      takenAt: asDate(r[0].taken_at),
      sections: r.filter((x) => x.id != null).map((x) => ({ id: String(x.id), sectionKey: String(x.section_key ?? ""), sectionTitle: String(x.section_title ?? "") })),
    };
  },
};

// ── In memory (tests) ────────────────────────────────────────────────────

/** A source over the in-memory ingest store, plus fixture questions/decisions. */
export function memoryReadingSource(
  store: MemoryReadingStore,
  extra: { questions?: RawQuestion[]; decisions?: RawDecision[]; sections?: Map<string, unknown[]>; legacyExits?: LegacyExit[]; kept?: KeptCopyTitles | null } = {},
): ReadingSource {
  const visitOk = (q: ReadingQuery, v: { dealId: string; buyerAccessId: string; selfView: boolean; clamped: boolean; lastSeenAt: Date; deviceClass: string }) =>
    v.dealId === q.dealId && !v.selfView && !v.clamped && (!q.since || v.lastSeenAt >= q.since) && deviceMatches(q.device, v.deviceClass)
    && (!q.accessIds || q.accessIds.includes(v.buyerAccessId));
  const visits = () => Array.from(store.visits.values());
  return {
    async renditions(dealId) {
      return Array.from(store.renditions.values()).filter((r) => r.dealId === dealId)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
        .map((r) => ({ id: r.id, mode: r.mode, variant: r.variant, createdAt: r.createdAt, visits: visits().filter((v) => v.renditionId === r.id && !v.selfView && !v.clamped).length }));
    },
    async rendition(dealId, id) {
      const r = store.renditions.get(id);
      if (!r || r.dealId !== dealId) return null;
      return { id: r.id, mode: r.mode, variant: r.variant, createdAt: r.createdAt, visits: 0, sections: extra.sections?.get(id) ?? [], design: null, pageIndex: r.pageIndex };
    },
    async pageIndexes(ids) {
      return new Map(ids.filter((id) => store.renditions.has(id)).map((id) => [id, store.renditions.get(id)!.pageIndex]));
    },
    async visits(q) {
      return visits().filter((v) => visitOk(q, v)).sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime()).map((v) => ({
        id: v.id, accessId: v.buyerAccessId, renditionId: v.renditionId, startedAt: v.startedAt, lastSeenAt: v.lastSeenAt,
        wallMs: v.wallMs, activeMs: v.activeMs, deviceClass: v.deviceClass, uaFamily: v.uaFamily, maxPageIndex: v.maxPageIndex,
        path: v.path, legacy: false, ipHash: v.ipHash,
      }));
    },
    async blockSums(q) {
      const ok = new Set(visits().filter((v) => visitOk(q, v)).map((v) => v.id));
      const m = new Map<string, RawBlockSum>();
      store.rollups.forEach((r) => {
        if (!ok.has(r.visitId)) return;
        const k = [r.buyerAccessId, r.renditionId, r.lineageId, r.pageId, r.blockKey].join("|");
        const prev = m.get(k) ?? {
          accessId: r.buyerAccessId, renditionId: r.renditionId, lineageId: r.lineageId, pageId: r.pageId, blockKey: r.blockKey,
          attentionMs: 0, skimMs: 0, visibleMs: 0, pointerMs: 0, firstAt: r.at, lastAt: r.at,
        };
        prev.attentionMs += r.attentionMs; prev.skimMs += r.skimMs; prev.visibleMs += r.visibleMs; prev.pointerMs += r.pointerMs;
        if (prev.firstAt && r.at < prev.firstAt) prev.firstAt = r.at;
        if (prev.lastAt && r.at > prev.lastAt) prev.lastAt = r.at;
        m.set(k, prev);
      });
      return Array.from(m.values());
    },
    async visitPages(q) {
      const ok = new Set(visits().filter((v) => visitOk(q, v)).map((v) => v.id));
      const m = new Map<string, RawVisitPage>();
      store.rollups.forEach((r) => {
        if (!ok.has(r.visitId) || r.attentionMs <= 0) return;
        const k = [r.visitId, r.renditionId, r.lineageId, r.pageId].join("|");
        const prev = m.get(k) ?? { accessId: r.buyerAccessId, visitId: r.visitId, renditionId: r.renditionId, lineageId: r.lineageId, pageId: r.pageId, attentionMs: 0 };
        prev.attentionMs += r.attentionMs;
        m.set(k, prev);
      });
      return Array.from(m.values());
    },
    async events(q) {
      const ok = new Set(visits().filter((v) => visitOk(q, v)).map((v) => v.id));
      return Array.from(store.events.values()).filter((e) => ok.has(e.visitId)).sort((a, b) => a.clientSeq - b.clientSeq).map((e) => ({
        accessId: e.buyerAccessId, visitId: e.visitId, renditionId: e.renditionId, type: e.eventType, pageId: e.pageId,
        blockKey: e.blockKey, detail: e.detail, seq: e.clientSeq, at: e.clientAt,
      }));
    },
    async questions() {
      return extra.questions ?? [];
    },
    async decisions() {
      return extra.decisions ?? [];
    },
    async legacyExits(dealId) {
      const first = visits().filter((v) => v.dealId === dealId && !v.selfView).reduce<number>((m, v) => Math.min(m, v.startedAt.getTime()), Infinity);
      return (extra.legacyExits ?? []).filter((e) => e.at.getTime() < first);
    },
    async keptCopyTitles() {
      return extra.kept ?? null;
    },
  };
}
