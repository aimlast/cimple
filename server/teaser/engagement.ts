/**
 * Teaser reading (spec §4.10): who was sent the teaser, who opened it, how
 * far they read, who asked for the CIM, who said "Not for me", and who read
 * it but didn't ask ("Worth a call"). From the reading tracker's teaser
 * visits (buyer_visits.mode = 'teaser'), never mixed into CIM numbers.
 */
import { sql } from "drizzle-orm";
import type { BuyerAccess, BuyerAccessEvent, BuyerApprovalRequest } from "@shared/schema";
import { isTeaserOnly, normalizeAccessLevel, sameAccessLevel, TEASER_ACCESS_LEVEL } from "@shared/access-levels";
import type { RenditionPage } from "@shared/analytics-v2";
import type { TeaserEngagement, TeaserEngagementBuyer } from "@shared/teaser";
import { viewLinkProblem } from "../buyers/view-access";
import { latestPass, requestStateFor, TEASER_REQUEST_SOURCE } from "./requests";

export interface TeaserVisitRow {
  accessId: string;
  renditionId: string | null;
  startedAt: Date;
  lastSeenAt: Date;
  activeMs: number;
  maxPageIndex: number | null;
}
export interface TeaserBlockSumRow {
  accessId: string;
  pageId: string;
  attentionMs: number;
}
export interface TeaserEngagementSource {
  links(dealId: string): Promise<BuyerAccess[]>;
  requests(dealId: string): Promise<BuyerApprovalRequest[]>;
  visits(dealId: string): Promise<TeaserVisitRow[]>;
  blockSums(dealId: string): Promise<TeaserBlockSumRow[]>;
  pageIndexes(dealId: string): Promise<Map<string, RenditionPage[]>>;
}

const num = (v: unknown) => Number(v ?? 0) || 0;

async function rows(q: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const { db } = await import("../db");
  return (await db.execute(q)) as unknown as Array<Record<string, unknown>>;
}

export const dbTeaserEngagementSource: TeaserEngagementSource = {
  async links(dealId) {
    const { storage } = await import("../storage");
    return storage.getBuyerAccessByDeal(dealId);
  },
  async requests(dealId) {
    const { storage } = await import("../storage");
    return storage.getBuyerApprovalRequestsByDeal(dealId);
  },
  async visits(dealId) {
    const r = await rows(sql`
      SELECT v.buyer_access_id, v.rendition_id, v.started_at, v.last_seen_at, v.active_ms, v.max_page_index
      FROM buyer_visits v
      WHERE v.deal_id = ${dealId} AND v.mode = 'teaser' AND NOT v.self_view AND NOT v.clamped`);
    return r.map((x) => ({
      accessId: String(x.buyer_access_id), renditionId: x.rendition_id == null ? null : String(x.rendition_id),
      startedAt: new Date(String(x.started_at)), lastSeenAt: new Date(String(x.last_seen_at)), activeMs: num(x.active_ms),
      maxPageIndex: x.max_page_index == null ? null : num(x.max_page_index),
    }));
  },
  async blockSums(dealId) {
    const r = await rows(sql`
      SELECT r.buyer_access_id, r.page_id, SUM(r.attention_ms) AS att
      FROM reading_rollups r JOIN buyer_visits v ON v.id = r.visit_id
      WHERE r.deal_id = ${dealId} AND v.mode = 'teaser' AND NOT v.self_view AND NOT v.clamped
      GROUP BY r.buyer_access_id, r.page_id`);
    return r.map((x) => ({ accessId: String(x.buyer_access_id), pageId: String(x.page_id), attentionMs: num(x.att) }));
  },
  async pageIndexes(dealId) {
    const r = await rows(sql`SELECT id, page_index FROM cim_renditions WHERE deal_id = ${dealId} AND mode = 'teaser' ORDER BY created_at`);
    return new Map(r.map((x) => [String(x.id), (x.page_index as RenditionPage[]) ?? []]));
  },
};

let source: TeaserEngagementSource = dbTeaserEngagementSource;
export function _setTeaserEngagementSourceForTests(s: TeaserEngagementSource | null): void {
  source = s ?? dbTeaserEngagementSource;
}

const DAY = 86_400_000;

/** A link that was ever a teaser link: currently teaser_only, or created at teaser_only. */
export function wasTeaserLink(a: Pick<BuyerAccess, "accessLevel" | "accessEvents">): boolean {
  if (isTeaserOnly(a.accessLevel)) return true;
  const events = (a.accessEvents as BuyerAccessEvent[] | null) ?? [];
  const granted = events.find((e) => e.type === "granted");
  return !!granted && sameAccessLevel(granted.accessLevel, TEASER_ACCESS_LEVEL);
}

export interface ComputeInput {
  links: BuyerAccess[];
  requests: BuyerApprovalRequest[];
  visits: TeaserVisitRow[];
  blockSums: TeaserBlockSumRow[];
  pageIndexes: Map<string, RenditionPage[]>;
  now?: number;
}

/** Pure: the funnel, per buyer and per block. */
export function computeTeaserEngagement(input: ComputeInput): TeaserEngagement {
  const now = input.now ?? Date.now();
  const links = input.links.filter(wasTeaserLink);
  const byAccess = new Map<string, TeaserVisitRow[]>();
  for (const v of input.visits) {
    const list = byAccess.get(v.accessId) ?? [];
    list.push(v);
    byAccess.set(v.accessId, list);
  }
  // Page titles and the last page index per rendition.
  const pageTitle = new Map<string, string>();
  const lastIndex = new Map<string, number>();
  const pageOrder: string[] = [];
  input.pageIndexes.forEach((pages, rid) => {
    lastIndex.set(rid, pages.length - 1);
    for (const p of pages) {
      if (!pageTitle.has(p.pageId)) {
        pageTitle.set(p.pageId, p.servedTitle || (p.pageId === "teaser_header" ? "Header" : "Untitled block"));
        pageOrder.push(p.pageId);
      }
    }
  });
  const furthestTitle = (visits: TeaserVisitRow[]): { title: string | null; toEnd: boolean } => {
    let best: { title: string | null; toEnd: boolean } = { title: null, toEnd: false };
    let bestIdx = -1;
    for (const v of visits) {
      if (v.maxPageIndex == null || !v.renditionId) continue;
      const pages = input.pageIndexes.get(v.renditionId) ?? [];
      const p = pages[v.maxPageIndex];
      const toEnd = v.maxPageIndex >= (lastIndex.get(v.renditionId) ?? Infinity);
      if (v.maxPageIndex > bestIdx || toEnd) {
        bestIdx = v.maxPageIndex;
        best = { title: p ? (p.servedTitle || null) : null, toEnd: best.toEnd || toEnd };
      }
    }
    return best;
  };

  // A fresh-link request is answered once the same address has a usable link on the deal again.
  const usableEmails = new Set(input.links.filter((a) => !viewLinkProblem(a, now)).map((a) => a.buyerEmail.trim().toLowerCase()));
  const buyers: TeaserEngagementBuyer[] = links.map((a) => {
    const visits = byAccess.get(a.id) ?? [];
    const events = (a.accessEvents as BuyerAccessEvent[] | null) ?? [];
    const granted = events.find((e) => e.type === "granted");
    const req = requestStateFor(a.id, input.requests as never);
    const reqRow = input.requests
      .filter((r) => (r as { buyerAccessId?: string | null }).buyerAccessId === a.id && (r as { source?: string | null }).source === TEASER_REQUEST_SOURCE)
      .sort((x, y) => new Date(y.createdAt).getTime() - new Date(x.createdAt).getTime())[0];
    const first = visits.length ? new Date(Math.min(...visits.map((v) => v.startedAt.getTime()))) : null;
    const last = visits.length ? new Date(Math.max(...visits.map((v) => v.lastSeenAt.getTime()))) : null;
    const activeMs = visits.reduce((n, v) => n + v.activeMs, 0);
    const far = furthestTitle(visits);
    const pass = latestPass(a);
    const fresh = [...events].reverse().find((e) => e.type === "fresh_link_requested");
    const problem = viewLinkProblem(a, now);
    const active = isTeaserOnly(a.accessLevel) && !a.revokedAt;
    const worthACall = !!first && now - first.getTime() >= 2 * DAY && req.state === "none" && !pass && !problem && isTeaserOnly(a.accessLevel);
    return {
      accessId: a.id,
      name: a.buyerName ?? null,
      company: a.buyerCompany ?? null,
      email: a.buyerEmail,
      sentAt: granted?.at ?? (a.createdAt ? new Date(a.createdAt).toISOString() : null),
      via: granted?.via === "outreach" ? "email" : "link",
      firstOpenedAt: first?.toISOString() ?? null,
      lastOpenedAt: last?.toISOString() ?? null,
      activeMs,
      furthestBlock: far.title,
      readToEnd: far.toEnd,
      request: {
        state: req.state,
        at: req.at,
        level: reqRow ? ((reqRow as { grantAccessLevel?: string | null }).grantAccessLevel ? normalizeAccessLevel((reqRow as { grantAccessLevel?: string | null }).grantAccessLevel) : null) : null,
        grantedBy: reqRow ? ((reqRow as { grantedBy?: string | null }).grantedBy ?? null) : null,
        requestId: reqRow?.id ?? null,
      },
      passed: pass,
      freshLinkRequestedAt: fresh && !usableEmails.has(a.buyerEmail.trim().toLowerCase()) ? fresh.at : null,
      worthACall,
      active,
      expired: problem === "expired",
    };
  });

  // Per block: readers and attention from teaser visits only.
  const perPage = new Map<string, { readers: Set<string>; attentionMs: number }>();
  for (const s of input.blockSums) {
    if (s.attentionMs <= 0) continue;
    const cur = perPage.get(s.pageId) ?? { readers: new Set<string>(), attentionMs: 0 };
    cur.readers.add(s.accessId);
    cur.attentionMs += s.attentionMs;
    perPage.set(s.pageId, cur);
  }
  const blocks = pageOrder
    .filter((p) => perPage.has(p))
    .map((pageId) => {
      const c = perPage.get(pageId)!;
      return { blockId: pageId, title: pageTitle.get(pageId) ?? "", readers: c.readers.size, attentionMs: c.attentionMs, avgMs: Math.round(c.attentionMs / Math.max(1, c.readers.size)) };
    });

  return {
    funnel: {
      sent: buyers.length,
      opened: buyers.filter((b) => !!b.firstOpenedAt).length,
      readToEnd: buyers.filter((b) => b.readToEnd).length,
      asked: buyers.filter((b) => b.request.state !== "none").length,
      granted: buyers.filter((b) => b.request.state === "granted").length,
      passed: buyers.filter((b) => !!b.passed).length,
    },
    buyers,
    blocks,
    openedToday: buyers.filter((b) => b.lastOpenedAt && now - Date.parse(b.lastOpenedAt) < DAY).length,
  };
}

export async function teaserEngagement(dealId: string, now = Date.now()): Promise<TeaserEngagement> {
  const [links, requests, visits, blockSums, pageIndexes] = await Promise.all([
    source.links(dealId),
    source.requests(dealId).catch(() => []),
    source.visits(dealId).catch(() => []),
    source.blockSums(dealId).catch(() => []),
    source.pageIndexes(dealId).catch(() => new Map<string, RenditionPage[]>()),
  ]);
  return computeTeaserEngagement({ links, requests, visits, blockSums, pageIndexes, now });
}
