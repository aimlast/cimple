/**
 * loadDealReadingFacts — everything known about how buyers read one deal's
 * CIM, for one filter set, as plain data (shared/analytics-v2.ts
 * DealReadingFacts). The hand-off between the CAPTURE stream (this file:
 * grouped SQL over reading_rollups / buyer_visits / analytics_events /
 * cim_renditions, server/engagement/queries.ts) and the INTELLIGENCE stream
 * (pure functions over the result, insights.ts).
 *
 * Rules:
 *   - self views (the owning broker previewing) are excluded (queries.ts);
 *   - filters apply: range on the visit's last activity, device class,
 *     buyers, segment (decision / buyer type), rendition;
 *   - pages come from the chosen rendition (the one asked for, else the
 *     latest with reading in the filter, else the latest), with REAL titles
 *     (broker side) and the served title when it differs (blind);
 *   - reading on another rendition merges onto the chosen pages: part by
 *     part where the page has the same block structure (blind and named
 *     versions usually do), page totals only (by lineage) where it
 *     doesn't — those buyers are counted in `changedSince`;
 *   - page ids in paths, events and questions are mapped onto the chosen
 *     rendition's pages; VisitFacts.maxPageIndex is an index in the CHOSEN
 *     rendition's page order;
 *   - revoked access rows are still listed (their reading happened).
 */
import type { BuyerAccess, BuyerDeepCheck, CimSection, Deal } from "@shared/schema";
import {
  READING_RULES,
  blockId,
  filterSince,
  viewerPageKey,
  viewerPagesOf,
  type BlockCounters,
  type BuyerFit,
  type BuyerReadingFacts,
  type CimMode,
  type CimVariant,
  type DealReadingFacts,
  type DeviceClass,
  type EngagementFilters,
  type FactPage,
  type PageReading,
  type ReadingInteractionType,
  type RenditionPage,
  type RenditionSummary,
  type VisitFacts,
} from "@shared/analytics-v2";
import { cimModeForAccessLevel } from "@shared/cim-layouts";
import { chartOfPoint, headingKey } from "@shared/cim-blocks";
import { pageRole } from "@shared/cim-page-role";
import { storage } from "../storage";
import {
  dbReadingSource,
  type RawBlockSum,
  type RawDecision,
  type RawEvent,
  type RawQuestion,
  type RawRendition,
  type RawVisit,
  type RawVisitPage,
  type ReadingSource,
} from "./queries";

let source: ReadingSource = dbReadingSource;
/** Tests: read from the in-memory ingest store instead of Postgres. */
export function setReadingSource(s: ReadingSource): void {
  source = s;
}
/** The source the engagement routes read from. */
export function readingSource(): ReadingSource {
  return source;
}

/** DealReadingFacts plus what only the aggregation needs (still a DealReadingFacts). */
export interface CaptureFacts extends DealReadingFacts {
  /** pageId → buyers who read that page on another block structure ("Changed since N buyers read it"). */
  changedReaders: Record<string, string[]>;
  /** pageIds with part-level reading (else only page totals: legacy data or another structure). */
  blockLevelPages: string[];
}

export async function loadDealReadingFacts(
  deal: Deal,
  filters: EngagementFilters,
  now: Date = new Date(),
): Promise<CaptureFacts> {
  const [accesses, live] = await Promise.all([
    storage.getBuyerAccessByDeal(deal.id),
    storage.getCimSectionsByDeal(deal.id).catch((): CimSection[] => []),
  ]);
  const listed = accesses.filter((a) => segmentMatches(a, filters) && (filters.buyers.length === 0 || filters.buyers.includes(a.id)));
  const q = {
    dealId: deal.id,
    since: filterSince(filters, now),
    device: filters.device,
    accessIds: filters.buyers.length > 0 || filters.segment !== "all" ? listed.map((a) => a.id) : null,
  };
  const [renditions, visits, sums, visitPages, events, questions, decisions] = await Promise.all([
    source.renditions(deal.id),
    source.visits(q),
    source.blockSums(q),
    source.visitPages(q),
    source.events(q),
    source.questions(deal.id),
    source.decisions(deal.id),
  ]);
  const chosen = chooseRendition(renditions, visits, filters.rendition);
  const needed = new Set<string>();
  if (chosen) needed.add(chosen.id);
  for (const v of visits) if (v.renditionId) needed.add(v.renditionId);
  const indexes = await source.pageIndexes(Array.from(needed));
  return assembleFacts({
    deal, filters, now, accesses: listed, live, renditions, chosen, indexes, visits, sums, visitPages, events, questions, decisions,
  });
}

function segmentMatches(a: BuyerAccess, f: EngagementFilters): boolean {
  if (f.segment === "all") return true;
  if (f.segment === "interested") return a.decision === "interested";
  if (f.segment === "undecided") return !a.decision || a.decision === "under_review";
  return a.buyerType === f.segment.slice("type:".length);
}

/**
 * The version to draw on: the one asked for, else the latest published CIM
 * with reading in this filter, else the latest. One publish produces a
 * version per access level at about the same time (blind, named, teaser),
 * so among those the full (not teaser) one most buyers read wins.
 */
export function chooseRendition(renditions: RawRendition[], visits: RawVisit[], asked: string | null): RawRendition | null {
  if (asked) {
    const r = renditions.find((x) => x.id === asked);
    if (r) return r;
  }
  const readBy = new Map<string, number>();
  for (const v of visits) if (v.renditionId) readBy.set(v.renditionId, (readBy.get(v.renditionId) ?? 0) + 1);
  const withReading = renditions.filter((r) => readBy.has(r.id));
  const pool = withReading.length ? withReading : renditions;
  if (pool.length === 0) return null;
  const latest = Math.max(...pool.map((r) => r.createdAt.getTime()));
  const sameGeneration = pool.filter((r) => latest - r.createdAt.getTime() <= 86_400_000);
  return [...sameGeneration].sort((a, b) =>
    (a.variant === "teaser" ? 1 : 0) - (b.variant === "teaser" ? 1 : 0)
    || (readBy.get(b.id) ?? 0) - (readBy.get(a.id) ?? 0)
    || b.createdAt.getTime() - a.createdAt.getTime())[0];
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MODE_LABEL: Record<string, string> = { blind: "Blind", normal: "Named", dd: "Due diligence" };

/** "Blind · published 12 Sep", "Blind teaser · published 12 Sep". */
export function renditionLabel(r: { mode: string; variant: string; createdAt: Date }): string {
  const date = `${r.createdAt.getUTCDate()} ${MONTHS[r.createdAt.getUTCMonth()]}`;
  return `${MODE_LABEL[r.mode] ?? r.mode}${r.variant === "teaser" ? " teaser" : ""} · published ${date}`;
}

function summary(r: RawRendition): RenditionSummary {
  return { id: r.id, mode: r.mode as CimMode, variant: r.variant as CimVariant, createdAt: r.createdAt.toISOString(), label: renditionLabel(r), visitCount: r.visits };
}

export interface AssembleInput {
  deal: Pick<Deal, "id" | "businessName"> & { buyerDeepCheck?: unknown };
  filters: EngagementFilters;
  now: Date;
  accesses: BuyerAccess[];
  live: Array<Pick<CimSection, "id" | "sectionKey" | "sectionTitle" | "layoutType" | "isVisible"> & { analyticsLineage?: string | null }>;
  renditions: RawRendition[];
  chosen: RawRendition | null;
  indexes: Map<string, RenditionPage[]>;
  visits: RawVisit[];
  sums: RawBlockSum[];
  visitPages: RawVisitPage[];
  events: RawEvent[];
  questions: RawQuestion[];
  decisions: RawDecision[];
}

/** Pure: raw grouped rows → DealReadingFacts. */
export function assembleFacts(input: AssembleInput): CaptureFacts {
  const { deal, filters, now, accesses, live, chosen, indexes } = input;
  const chosenPages = chosen ? indexes.get(chosen.id) ?? [] : [];

  // ── Pages (real titles, broker side) ──
  const liveById = new Map(live.map((s) => [s.id, s]));
  const liveByLineage = new Map(live.map((s) => [s.analyticsLineage || s.id, s]));
  const realOf = (p: RenditionPage) => liveById.get(p.pageId) ?? liveByLineage.get(p.lineageId);
  const pageById = new Map(chosenPages.map((p) => [p.pageId, p]));
  const pageByLineage = new Map(chosenPages.map((p) => [p.lineageId, p]));
  const viewer = viewerPagesOf(chosenPages);
  const pages: FactPage[] = viewer.map((v) => {
    const p = pageById.get(v.pageId)!;
    const real = realOf(p);
    const title = real?.sectionTitle || p.servedTitle;
    const blocks = p.blocks.filter((b) => b.part === v.part);
    return {
      ...v,
      lineageId: p.lineageId,
      title,
      servedTitle: headingKey(p.servedTitle) !== headingKey(title) ? p.servedTitle : null,
      layoutType: p.layoutType,
      role: pageRole({ layoutType: p.layoutType, title, sectionKey: real?.sectionKey ?? null, pageId: p.pageId }),
      locked: p.locked,
      expectedMs: blocks.filter((b) => !b.virtual && !b.when).reduce((s, b) => s + b.expectedMs, 0),
      blocks,
    };
  });
  const orderOf = new Map(chosenPages.map((p) => [p.pageId, p.order]));

  /** A page of any rendition → the chosen rendition's page (same id, else same lineage). */
  const mapPage = (pageId: string, lineageId?: string | null): RenditionPage | undefined =>
    pageById.get(pageId) ?? (lineageId ? pageByLineage.get(lineageId) : undefined) ?? pageByLineage.get(pageId);
  const renditionPage = (renditionId: string | null, pageId: string) =>
    renditionId ? indexes.get(renditionId)?.find((p) => p.pageId === pageId) : undefined;

  // ── Per buyer ──
  const buyers = new Map<string, BuyerReadingFacts>();
  for (const a of accesses) buyers.set(a.id, buyerShell(a, fitOf(a, deal.buyerDeepCheck)));
  const listedIds = new Set(buyers.keys());

  for (const v of input.visits) {
    const b = buyers.get(v.accessId);
    if (!b) continue;
    b.visits.push(visitFacts(v, indexes, mapPage, orderOf));
  }

  // Reading per block → per viewer page part.
  type PartAcc = { att: number; skim: number; vis: number; first: Date | null; last: Date | null };
  const parts = new Map<string, Map<string, PartAcc>>();   // accessId → viewerKey → acc
  const pageLevel = new Map<string, Map<string, { att: number; skim: number; vis: number; first: Date | null; last: Date | null }>>(); // accessId → pageId
  const changed = new Map<string, Set<string>>();          // pageId → buyers who read it in another structure
  const blockLevel = new Set<string>();                    // pageIds with part-level reading
  const accOf = (accessId: string, key: string) => {
    let m = parts.get(accessId);
    if (!m) { m = new Map(); parts.set(accessId, m); }
    let a = m.get(key);
    if (!a) { a = { att: 0, skim: 0, vis: 0, first: null, last: null }; m.set(key, a); }
    return a;
  };
  const stamp = (a: { first: Date | null; last: Date | null }, s: RawBlockSum) => {
    if (s.firstAt && (!a.first || s.firstAt < a.first)) a.first = s.firstAt;
    if (s.lastAt && (!a.last || s.lastAt > a.last)) a.last = s.lastAt;
  };
  for (const s of input.sums) {
    const b = buyers.get(s.accessId);
    if (!b) continue;
    const target = mapPage(s.pageId, s.lineageId);
    if (!target) continue;
    const from = renditionPage(s.renditionId, s.pageId);
    const same = !!chosen && (s.renditionId === chosen.id || (!!from && from.blockFingerprint === target.blockFingerprint));
    const block = same && s.blockKey ? target.blocks.find((x) => x.key === s.blockKey) ?? (chartOfPoint(s.blockKey) ? target.blocks.find((x) => x.key === chartOfPoint(s.blockKey)) : undefined) : undefined;
    if (same && s.blockKey) {
      blockLevel.add(target.pageId);
      const id = blockId(target.pageId, s.blockKey);
      const c = b.blocks[id] ?? [0, 0, 0, 0];
      b.blocks[id] = [c[0] + s.attentionMs, c[1] + s.skimMs, c[2] + s.visibleMs, c[3] + s.pointerMs] as BlockCounters;
    }
    if (block) {
      // Chart points carry pointer time only; their attention is on the chart.
      const a = accOf(s.accessId, viewerPageKey(target.pageId, block.part));
      a.att += s.attentionMs; a.skim += s.skimMs; a.vis = Math.max(a.vis, s.visibleMs);
      stamp(a, s);
    } else {
      if (!same && s.attentionMs >= 1) {
        const set = changed.get(target.pageId) ?? new Set<string>();
        set.add(s.accessId);
        changed.set(target.pageId, set);
      }
      let m = pageLevel.get(s.accessId);
      if (!m) { m = new Map(); pageLevel.set(s.accessId, m); }
      const a = m.get(target.pageId) ?? { att: 0, skim: 0, vis: 0, first: null, last: null };
      a.att += s.attentionMs; a.skim += s.skimMs; a.vis = Math.max(a.vis, s.visibleMs);
      stamp(a, s);
      m.set(target.pageId, a);
    }
  }
  // Page-level time (the page outside its parts, or another structure): spread
  // over the page's printed parts by where this buyer read it (else by expected time).
  pageLevel.forEach((m, accessId) => {
    m.forEach((a, pageId) => {
      const pageParts = pages.filter((p) => p.pageId === pageId);
      if (pageParts.length === 0) return;
      const own = pageParts.map((p) => parts.get(accessId)?.get(viewerPageKey(pageId, p.part))?.att ?? 0);
      const ownTotal = own.reduce((s, x) => s + x, 0);
      const weights = ownTotal > 0 ? own : pageParts.map((p) => Math.max(1, p.expectedMs));
      const wTotal = weights.reduce((s, x) => s + x, 0);
      pageParts.forEach((p, i) => {
        const f = weights[i] / wTotal;
        const acc = accOf(accessId, viewerPageKey(pageId, p.part));
        acc.att += a.att * f; acc.skim += a.skim * f;
        if (i === 0 || f > 0) acc.vis = Math.max(acc.vis, a.vis);
        if (a.first && (!acc.first || a.first < acc.first)) acc.first = a.first;
        if (a.last && (!acc.last || a.last > acc.last)) acc.last = a.last;
      });
    });
  });

  // Visits that touched each page.
  const visitsOnPage = new Map<string, Map<string, Set<string>>>(); // accessId → pageId → visitIds
  for (const r of input.visitPages) {
    const target = mapPage(r.pageId, r.lineageId);
    if (!target || r.attentionMs <= 0) continue;
    let m = visitsOnPage.get(r.accessId);
    if (!m) { m = new Map(); visitsOnPage.set(r.accessId, m); }
    const set = m.get(target.pageId) ?? new Set<string>();
    set.add(r.visitId);
    m.set(target.pageId, set);
  }

  parts.forEach((m, accessId) => {
    const b = buyers.get(accessId);
    if (!b) return;
    m.forEach((a, key) => {
      const pageId = key.slice(0, key.lastIndexOf("#"));
      const reading: PageReading = {
        attentionMs: Math.round(a.att),
        skimMs: Math.round(a.skim),
        visibleMs: Math.round(a.vis),
        firstAt: a.first ? a.first.toISOString() : null,
        lastAt: a.last ? a.last.toISOString() : null,
        visits: a.att > 0 ? visitsOnPage.get(accessId)?.get(pageId)?.size ?? 1 : 0,
      };
      b.pages[key] = reading;
    });
  });

  // Interactions, mapped onto the chosen pages.
  for (const e of input.events) {
    const b = buyers.get(e.accessId);
    if (!b) continue;
    const target = mapPage(e.pageId);
    b.events.push({
      visitId: e.visitId,
      seq: e.seq,
      type: e.type as ReadingInteractionType,
      pageId: target?.pageId ?? e.pageId,
      ...(e.blockKey ? { blockKey: e.blockKey } : {}),
      ...(e.detail ? { detail: mapDetail(e.detail, mapPage) } : {}),
      at: e.at,
    });
  }

  for (const q of input.questions) {
    if (!q.accessId || !listedIds.has(q.accessId)) continue;
    buyers.get(q.accessId)!.questions.push({
      id: q.id, text: q.text, askedAt: q.askedAt.toISOString(),
      pageId: q.pageId ? mapPage(q.pageId)?.pageId ?? null : null, status: q.status, answered: q.answered,
    });
  }

  const renditions = input.renditions.map(summary);
  const lastSeen = input.visits.reduce<number>((m, v) => Math.max(m, v.lastSeenAt.getTime()), 0);
  const changedReaders: Record<string, string[]> = {};
  changed.forEach((set, pageId) => { changedReaders[pageId] = Array.from(set); });
  return {
    dealId: deal.id,
    dealName: deal.businessName,
    rendition: chosen ? summary(chosen) : null,
    renditions,
    now: now.toISOString(),
    filters,
    pages,
    buyers: Array.from(buyers.values()),
    legacyOnly: input.visits.length > 0 && input.visits.every((v) => v.legacy),
    lastWriteAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    changedReaders,
    blockLevelPages: Array.from(blockLevel),
  };
}

/** "toc:<pageId>" → the same with the target mapped onto the chosen rendition. */
function mapDetail(detail: string, mapPage: (id: string) => RenditionPage | undefined): string {
  const m = /^(toc|sticky|related):(.+)$/.exec(detail);
  if (!m) return detail;
  return `${m[1]}:${mapPage(m[2])?.pageId ?? m[2]}`;
}

function visitFacts(
  v: RawVisit,
  indexes: Map<string, RenditionPage[]>,
  mapPage: (pageId: string, lineageId?: string | null) => RenditionPage | undefined,
  orderOf: Map<string, number>,
): VisitFacts {
  const own = v.renditionId ? indexes.get(v.renditionId) ?? [] : [];
  const lineageOf = (pageId: string) => own.find((p) => p.pageId === pageId)?.lineageId ?? null;
  let maxPageIndex = -1;
  if (v.maxPageIndex != null && v.maxPageIndex >= 0) {
    const src = own.find((p) => p.order === v.maxPageIndex);
    const target = src ? mapPage(src.pageId, src.lineageId) : undefined;
    maxPageIndex = target ? orderOf.get(target.pageId) ?? -1 : -1;
    if (!src && own.length === 0) maxPageIndex = v.maxPageIndex;
  }
  return {
    id: v.id,
    renditionId: v.renditionId,
    startedAt: v.startedAt.toISOString(),
    lastSeenAt: v.lastSeenAt.toISOString(),
    wallMs: v.wallMs,
    activeMs: v.activeMs,
    device: (v.deviceClass as DeviceClass) || "desktop",
    uaFamily: v.uaFamily,
    maxPageIndex,
    path: v.path.map(([t, pageId]) => [t, mapPage(pageId, lineageOf(pageId))?.pageId ?? pageId] as [number, string]),
    legacy: v.legacy,
    networkKey: v.ipHash,
  };
}

function fitOf(a: BuyerAccess, deepCheck: unknown): BuyerFit | null {
  const mb = (a.matchBreakdown as { criteriaMatched?: number; criteriaTested?: number } | null) ?? null;
  const dc = a.buyerUserId ? (deepCheck as BuyerDeepCheck | null)?.results?.[a.buyerUserId] : undefined;
  if (!mb && !dc) return null;
  return {
    criteriaMatched: typeof mb?.criteriaMatched === "number" ? mb.criteriaMatched : null,
    criteriaTotal: typeof mb?.criteriaTested === "number" ? mb.criteriaTested : null,
    deepCheckVerdict: dc?.verdict ?? null,
    deepCheckFit: typeof dc?.fitScore === "number" ? dc.fitScore : null,
  };
}

/** A buyer with no reading recorded (also how "Not opened yet" buyers look). */
export function buyerShell(a: BuyerAccess, fit: BuyerFit | null = null): BuyerReadingFacts {
  const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
  const contacted = ((a.accessEvents as Array<{ type: string; at: string }> | null) ?? [])
    .filter((e) => e.type === "contacted")
    .map((e) => e.at)
    .sort()
    .pop() ?? null;
  return {
    accessId: a.id,
    buyerUserId: a.buyerUserId ?? null,
    name: a.buyerName || a.buyerEmail,
    company: a.buyerCompany ?? null,
    email: a.buyerEmail,
    buyerType: a.buyerType ?? null,
    accessLevel: a.accessLevel,
    mode: cimModeForAccessLevel(a.accessLevel) as CimMode,
    grantedAt: iso(a.createdAt)!,
    firstViewedAt: iso(a.firstViewedAt),
    ndaSignedAt: iso(a.ndaSignedAt),
    decision: a.decision ?? "under_review",
    decisionAt: iso(a.decisionAt),
    contactedAt: contacted,
    fit,
    visits: [],
    pages: {},
    blocks: {},
    events: [],
    questions: [],
  };
}

/** Decisions over time for one buyer (the analytics stream records every one). */
export async function decisionHistory(dealId: string, accessId: string): Promise<Array<{ decision: string; at: string }>> {
  const all = await source.decisions(dealId);
  return all.filter((d) => d.accessId === accessId).map((d) => ({ decision: d.decision, at: d.at.toISOString() }));
}

/** Readers ≥ 3 s on a page (the one definition). */
export function isReader(attentionMs: number): boolean {
  return attentionMs >= READING_RULES.readerMinMs;
}
