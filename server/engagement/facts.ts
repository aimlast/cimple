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
  type VersionNote,
  type VisitFacts,
} from "@shared/analytics-v2";
import { NAMED_ACCESS_LEVEL, cimModeForAccessLevel } from "@shared/cim-layouts";
import { CONTACT_PAGE_ID, DISCLAIMER_PAGE_ID, chartOfPoint, headingKey } from "@shared/cim-blocks";
import { pageRole } from "@shared/cim-page-role";
import { blindSectionKey, cimHeldFromBuyers, servesPublishedSnapshot } from "@shared/cim-buyer-view";
import { servedVersions } from "@shared/cim-published";
import { legacyPageRemap, legacyRows, legacySessions, liveRendition, mainAccessLevel, remapLegacyReading, type LegacyExit, type LegacyUnmatched } from "./legacy";
import { liveTitleSources, needsNamedNow, pageTitle, titleIndex, type TitleSources } from "./titles";
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
  type ReadingQuery,
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

let liveRenditionOf: typeof liveRendition = liveRendition;
/** Tests: the CIM "as served now" without the view room's inputs (null restores it). */
export function _setLiveRenditionForTests(fn: typeof liveRendition | null): void {
  liveRenditionOf = fn ?? liveRendition;
}

/** DealReadingFacts plus what only the aggregation needs (still a DealReadingFacts). */
export interface CaptureFacts extends DealReadingFacts {
  /** pageId → buyers who read that page on another block structure ("Changed since N buyers read it"). */
  changedReaders: Record<string, string[]>;
  /** pageIds with part-level reading (else only page totals: legacy data or another structure). */
  blockLevelPages: string[];
  /** Old-tracker reading on pages the current CIM no longer has (after a regeneration). */
  legacyUnmatched?: LegacyUnmatched;
  /**
   * viewerPageKey → how its reading is known: buyers with part-by-part rows
   * on the page, and per buyer the time known only as a page total (spread
   * over a split section's parts like the rest of the page-level time) —
   * read before part tracking, or on a version with different parts.
   */
  pageHeat?: Record<string, PageHeatFacts>;
  /** What the drawn version is, against what buyers are served now (kept copy, held update, an older version). */
  versionNote?: VersionNote | null;
  /**
   * The drawn pages (pageIds) with ANY reading on file for this deal — any
   * buyer, any date range or device, whatever the view is filtered to. With
   * old tracking (responses.ts reach basis) a page outside this set was never
   * recorded (added after these buyers read, or the old tracker didn't see
   * it): hatched, never a drop, never "skipped" (heat-map spec §5.4). A buyer
   * filter never makes another buyer's recorded pages "not recorded".
   */
  recordedPages?: string[];
}

export interface PageHeatFacts {
  partBuyers: string[];
  pageOnly: Record<string, { beforeMs: number; otherMs: number }>;
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
  // Which pages have any reading is a fact about the deal, not about the
  // buyers in view: with a narrowed view, read every buyer's page rows too
  // (one grouped read; on failure the view's own rows stand in).
  const allQ: ReadingQuery = { dealId: deal.id, since: null, device: "all", accessIds: null };
  const narrowed = q.accessIds !== null || q.since !== null || q.device !== "all";
  const [renditionsStored, visitsStored, sumsStored, visitPagesStored, events, questions, decisions, exits, dealWideStored] = await Promise.all([
    source.renditions(deal.id),
    source.visits(q),
    source.blockSums(q),
    source.visitPages(q),
    source.events(q),
    source.questions(deal.id),
    source.decisions(deal.id),
    source.legacyExits(deal.id).catch((): LegacyExit[] => []),
    narrowed ? source.visitPages(allQ).catch((): RawVisitPage[] | null => null) : Promise.resolve(null),
  ]);
  // Reading from the old tracker (before part-by-part tracking), read on the
  // fly (or stored by the legacy backfill): page totals, marked legacy. Every
  // exit counts toward its visit; its page is placed on the CIM as it is now
  // (remapLegacyReading) — reading on a page the CIM no longer has is
  // reported (legacyUnmatched), never silently dropped.
  const known = new Set(accesses.map((a) => a.id));
  const sessions = legacySessions(exits.filter((e) => known.has(e.accessId)), (key) => key);
  const legacy = legacyRows(sessions, q, () => null);
  const unplaced = {
    visits: [...visitsStored, ...legacy.visits],
    sums: [...sumsStored, ...legacy.sums],
    visitPages: [...visitPagesStored, ...legacy.visitPages],
  };
  let renditions = renditionsStored;
  let chosen = chooseRendition(renditions, unplaced.visits, filters.rendition);
  const liveIndexes = new Map<string, RenditionPage[]>();
  const legacyVisits = unplaced.visits.filter((v) => v.legacy);
  if (!chosen && legacyVisits.length > 0) {
    // Nothing was served since part-by-part tracking began: draw the old
    // reading on the CIM as it would be served now (not stored). Stored
    // legacy visits (the backfill) count too — DEP-2: with only those, the
    // Document view had no version to draw on and showed no pages at all.
    const levels = accesses.filter((a) => legacyVisits.some((v) => v.accessId === a.id)).map((a) => a.accessLevel);
    const since = new Date(Math.min(...legacyVisits.map((v) => v.startedAt.getTime())));
    // Broker side: a CIM held from buyers (an update waiting for review with
    // nobody served meanwhile) is still drawn — on the version buyers will
    // get — and the Document view says so (versionNote "held").
    const lr = (await liveRenditionOf(deal, mainAccessLevel(levels), since, { ignoreHold: true }))
      ?? (await liveRenditionOf(deal, NAMED_ACCESS_LEVEL, since, { ignoreHold: true }));
    if (lr) {
      renditions = [...renditions, lr.raw];
      chosen = lr.raw;
      liveIndexes.set(lr.raw.id, lr.row.pageIndex);
    }
  }
  const needed = new Set<string>();
  if (chosen) needed.add(chosen.id);
  for (const v of unplaced.visits) if (v.renditionId) needed.add(v.renditionId);
  const indexes = await source.pageIndexes(Array.from(needed).filter((id) => !liveIndexes.has(id)));
  liveIndexes.forEach((v, k) => indexes.set(k, v));
  // Old-tracker pages placed on the version drawn (by page, lineage, or what
  // the old key resolves to among the current sections).
  const remap = legacyPageRemap(live, blindSectionKey, chosen ? indexes.get(chosen.id) ?? [] : null);
  const placed = remapLegacyReading(unplaced, remap);
  const { visits, sums, visitPages } = placed;
  let dealWideVisitPages: RawVisitPage[] | undefined;
  if (dealWideStored) {
    // Old-tracker rows (no version) are placed the same way as the view's.
    dealWideVisitPages = [...dealWideStored, ...legacyRows(sessions, allQ, () => null).visitPages].map((r) => {
      if (r.renditionId !== null) return r;
      const to = remap(r.pageId, r.lineageId);
      return to ? { ...r, pageId: to.pageId, lineageId: to.lineageId } : r;
    });
  }
  const titles = await loadTitleSources(deal, live, renditionsStored, chosen, indexes);
  const facts = assembleFacts({
    deal, filters, now, accesses: listed, live, renditions, chosen, indexes, visits, sums, visitPages, events, questions, decisions, titles, dealWideVisitPages,
  });
  if (placed.unmatched && chosen) facts.legacyUnmatched = placed.unmatched;
  return facts;
}

/**
 * Where page titles come from (server/engagement/titles.ts): the kept copy
 * (SQL projection), the newest stored named version's page index, and — only
 * when a blind version has pages neither of those name — the titles named
 * buyers are served now. Never throws: a failed read leaves that source out.
 */
export async function loadTitleSources(
  deal: Deal,
  live: ReadonlyArray<Pick<CimSection, "id" | "sectionKey" | "sectionTitle"> & { analyticsLineage?: string | null }>,
  stored: RawRendition[],
  chosen: RawRendition | null,
  indexes: Map<string, RenditionPage[]>,
): Promise<TitleSources> {
  const kept = await (source.keptCopyTitles?.(deal.id) ?? Promise.resolve(null)).catch(() => null);
  const named = [...stored].filter((r) => r.mode === "normal" || r.mode === "dd").sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
  const namedServed = new Map<string, string>();
  if (named) {
    const index = indexes.get(named.id) ?? (await source.pageIndexes([named.id]).catch(() => new Map<string, RenditionPage[]>())).get(named.id) ?? [];
    for (const p of index) namedServed.set(p.pageId, p.servedTitle);
  }
  const src: TitleSources = { live, kept: kept?.sections ?? null, namedServed, namedNow: null };
  const chosenPages = chosen ? indexes.get(chosen.id) ?? [] : [];
  if (chosen && needsNamedNow(chosenPages, chosen.mode as CimMode, src)) {
    try {
      const [rows, published] = await Promise.all([
        storage.getCimSectionsByDeal(deal.id),
        storage.getCimSectionOverrides(deal.id, "published"),
      ]);
      const served = servedVersions({ deal, mode: "normal", sections: rows, overrides: [], published });
      src.namedNow = new Map(served.sections.map((s) => [s.id, s.sectionTitle]));
    } catch {
      // The live rows stand in (titles.ts falls back to them).
    }
  }
  return src;
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
  deal: Pick<Deal, "id" | "businessName"> & { buyerDeepCheck?: unknown; isLive?: boolean | null; cimGeneration?: unknown };
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
  /** Where page titles come from (default: the live sections only). */
  titles?: TitleSources;
  /**
   * Every buyer's page rows, whatever the filters (CaptureFacts.recordedPages);
   * only needed when the view is narrowed (else this view's rows are all of them).
   */
  dealWideVisitPages?: RawVisitPage[];
}

/** Pure: raw grouped rows → DealReadingFacts. */
export function assembleFacts(input: AssembleInput): CaptureFacts {
  const { deal, filters, now, accesses, live, chosen, indexes } = input;
  const chosenPages = chosen ? indexes.get(chosen.id) ?? [] : [];

  // ── Pages (real titles, broker side: the served page's own, titles.ts) ──
  const titles = titleIndex(input.titles ?? liveTitleSources(live));
  const drawnMode = (chosen?.mode ?? "normal") as CimMode;
  const pageById = new Map(chosenPages.map((p) => [p.pageId, p]));
  const pageByLineage = new Map(chosenPages.map((p) => [p.lineageId, p]));
  const viewer = viewerPagesOf(chosenPages);
  // What BLIND buyers saw as each page's title: from the chosen version when
  // it is blind, else from the newest blind version (full before teaser) of
  // the same page (by id, else lineage).
  const blindTitleOf = new Map<string, string>();
  const blindRenditions = input.renditions
    .filter((r) => r.mode === "blind" && indexes.has(r.id))
    .sort((a, b) => (a.variant === "teaser" ? 1 : 0) - (b.variant === "teaser" ? 1 : 0) || b.createdAt.getTime() - a.createdAt.getTime());
  if (chosen?.mode === "blind") blindRenditions.unshift(chosen);
  for (const r of blindRenditions) {
    for (const bp of indexes.get(r.id) ?? []) {
      if (!blindTitleOf.has(bp.pageId)) blindTitleOf.set(bp.pageId, bp.servedTitle);
      if (!blindTitleOf.has(`lin:${bp.lineageId}`)) blindTitleOf.set(`lin:${bp.lineageId}`, bp.servedTitle);
    }
  }
  const pages: FactPage[] = viewer.map((v) => {
    const p = pageById.get(v.pageId)!;
    const named = pageTitle(p, drawnMode, titles);
    const title = named.title || p.servedTitle;
    const blocks = p.blocks.filter((b) => b.part === v.part);
    return {
      ...v,
      lineageId: p.lineageId,
      title,
      servedTitle: headingKey(p.servedTitle) !== headingKey(title) ? p.servedTitle : null,
      blindTitle: blindTitleOf.get(p.pageId) ?? blindTitleOf.get(`lin:${p.lineageId}`) ?? null,
      layoutType: p.layoutType,
      role: pageRole({ layoutType: p.layoutType, title, sectionKey: named.sectionKey, pageId: p.pageId }),
      locked: p.locked,
      expectedMs: blocks.filter((b) => !b.virtual && !b.when).reduce((s, b) => s + b.expectedMs, 0),
      blocks,
      update: named.update,
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
  // How each page's reading is known (DocumentPage.heat): buyers with part
  // rows, and time known only as a page total (old tracking / other parts).
  const partBuyersOf = new Map<string, Set<string>>();     // pageId → buyers with ≥ 1 part row
  const pageOnlyRaw = new Map<string, Map<string, { before: number; other: number }>>(); // accessId → pageId
  const pageHeat: Record<string, PageHeatFacts> = {};      // viewerKey → heat facts
  const heatOf = (key: string) => (pageHeat[key] ??= { partBuyers: [], pageOnly: {} });
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
      const set = partBuyersOf.get(target.pageId) ?? new Set<string>();
      set.add(s.accessId);
      partBuyersOf.set(target.pageId, set);
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
      if (!same && s.renditionId && s.attentionMs >= 1) {
        const set = changed.get(target.pageId) ?? new Set<string>();
        set.add(s.accessId);
        changed.set(target.pageId, set);
      }
      if (!same && s.attentionMs > 0) {
        let m = pageOnlyRaw.get(s.accessId);
        if (!m) { m = new Map(); pageOnlyRaw.set(s.accessId, m); }
        const o = m.get(target.pageId) ?? { before: 0, other: 0 };
        if (s.renditionId === null) o.before += s.attentionMs; else o.other += s.attentionMs;
        m.set(target.pageId, o);
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
      const only = pageOnlyRaw.get(accessId)?.get(pageId);
      pageParts.forEach((p, i) => {
        const f = weights[i] / wTotal;
        if (only && f > 0) {
          const h = heatOf(viewerPageKey(pageId, p.part));
          const prev = h.pageOnly[accessId] ?? { beforeMs: 0, otherMs: 0 };
          h.pageOnly[accessId] = { beforeMs: prev.beforeMs + only.before * f, otherMs: prev.otherMs + only.other * f };
        }
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

  for (const p of pages) {
    const set = partBuyersOf.get(p.pageId);
    if (set) heatOf(viewerPageKey(p.pageId, p.part)).partBuyers = Array.from(set);
  }

  // Drawn pages with any reading on file, deal-wide (CaptureFacts.recordedPages):
  // this view's reading, plus every other buyer's when the view is narrowed.
  const recorded = new Set<string>();
  for (const r of [...input.sums, ...(input.dealWideVisitPages ?? [])]) {
    if (!(r.attentionMs > 0)) continue;
    const target = mapPage(r.pageId, r.lineageId);
    if (target) recorded.add(target.pageId);
  }

  const renditions = input.renditions.map(summary);
  const lastSeen = input.visits.reduce<number>((m, v) => Math.max(m, v.lastSeenAt.getTime()), 0);
  const changedReaders: Record<string, string[]> = {};
  changed.forEach((set, pageId) => { changedReaders[pageId] = Array.from(set); });
  const sampleReading = input.visits.some((v) => !!v.demoSeed);
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
    sampleReading,
    lastWriteAt: lastSeen ? new Date(lastSeen).toISOString() : null,
    changedReaders,
    blockLevelPages: Array.from(blockLevel),
    pageHeat,
    versionNote: versionNoteOf(deal, chosenPages, input.titles?.kept ?? null, live, sampleReading),
    recordedPages: Array.from(recorded),
  };
}

const isBrokeragePage = (pageId: string) => pageId === DISCLAIMER_PAGE_ID || pageId === CONTACT_PAGE_ID;

/**
 * What the drawn version is, for the Document view's status line:
 *   kept_copy      buyers read the copy kept while the broker reviews an
 *                  update, and this IS that copy;
 *   held           the CIM is held from buyers (an update waiting for
 *                  review with nothing served meanwhile): drawn on the
 *                  version they'll get (ignoreHold);
 *   older_version  some drawn pages are no longer current sections.
 * Pure.
 */
export function versionNoteOf(
  deal: { isLive?: boolean | null; cimGeneration?: unknown },
  drawn: ReadonlyArray<Pick<RenditionPage, "pageId">>,
  kept: ReadonlyArray<{ id: string }> | null,
  live: ReadonlyArray<{ id: string }>,
  sample: boolean,
): VersionNote | null {
  const sectionPages = drawn.filter((p) => !isBrokeragePage(p.pageId));
  if (sectionPages.length === 0) return null;
  if (servesPublishedSnapshot(deal) && kept && kept.length > 0) {
    const keptIds = new Set(kept.map((s) => s.id));
    if (sectionPages.every((p) => keptIds.has(p.pageId))) {
      const since = (deal.cimGeneration as { buyerHold?: { since?: string } | null } | null | undefined)?.buyerHold?.since ?? "";
      return { kind: "kept_copy", since };
    }
  }
  if (cimHeldFromBuyers(deal)) return { kind: "held", sample };
  const liveIds = new Set(live.map((s) => s.id));
  const changed = sectionPages.filter((p) => !liveIds.has(p.pageId)).length;
  return changed > 0 ? { kind: "older_version", changedPages: changed } : null;
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
    sample: !!v.demoSeed,
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
    revokedAt: iso(a.revokedAt),
    expiresAt: iso(a.expiresAt),
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
