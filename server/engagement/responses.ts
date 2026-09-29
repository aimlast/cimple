/**
 * DealReadingFacts → the broker API responses (shared/analytics-v2.ts).
 * Pure. Owned by the CAPTURE stream (aggregation: readers, reach, block
 * attention, kind breakdown, strips, journeys); it calls the INTELLIGENCE
 * stream's insights.ts for everything that is judgement (status, why,
 * signals, talking points, headlines, moments) — never re-implementing it.
 *
 * Definitions (one place):
 *   reader of a page   a buyer with ≥ 3 s of attention on it
 *   reached            the buyer's furthest page is at or beyond it (a split
 *                      section's later parts: when any of their parts was on screen)
 *   opened             at least one tracked visit (buyers whose tracker was
 *                      blocked still count as opened in the pulse, via firstViewedAt)
 */
import {
  READING_RULES,
  blockId,
  viewerPageKey,
  type BlockAttention,
  type BuyerEngagementCard,
  type BuyerJourneyResponse,
  type BuyerReadingFacts,
  type BuyerSeconds,
  type CallListEntry,
  type DealReadingFacts,
  type DocumentPage,
  type EngagementBuyersResponse,
  type EngagementDocumentResponse,
  type EngagementSummaryResponse,
  type FactPage,
  type InteractionCounts,
  type JourneySegment,
  type JourneyVisit,
  type KindAttention,
  type NotOpenedBuyer,
  type PageRef,
  type PageStripCell,
  type ReachPoint,
  type ReadLabel,
} from "@shared/analytics-v2";
import { KIND_GROUPS, kindGroupOf, type KindGroup } from "@shared/cim-blocks";
import { groupReadLabel, pageReadLabel } from "@shared/cim-reading-model";
import { buyerInsight, journeyMoments, pageHeadline, pulseSentence, rankBuyers, reachHeadline, type InsightContext } from "./insights";

/** Optional extras the aggregation adds (server/engagement/facts.ts CaptureFacts). */
type Facts = DealReadingFacts & { changedReaders?: Record<string, string[]>; blockLevelPages?: string[] };

export function insightContext(facts: DealReadingFacts): InsightContext {
  return { now: new Date(facts.now), pages: facts.pages, buyers: facts.buyers };
}

// ── Shared helpers ────────────────────────────────────────────────────────

export function pageRefOf(facts: DealReadingFacts, pageId: string, part = 0): PageRef | null {
  const p = facts.pages.find((x) => x.pageId === pageId && x.part === part) ?? facts.pages.find((x) => x.pageId === pageId);
  return p ? { pageId: p.pageId, part: p.part, label: p.label, title: p.title } : null;
}

/** The furthest viewer page index this buyer reached (-1 = none). */
export function furthestViewerIndex(b: BuyerReadingFacts, pages: FactPage[]): number {
  const firstPartOfOrder: number[] = [];
  const seen = new Set<string>();
  for (const p of pages) {
    if (seen.has(p.pageId)) continue;
    seen.add(p.pageId);
    firstPartOfOrder.push(p.index);
  }
  let furthest = -1;
  for (const v of b.visits) {
    if (v.maxPageIndex >= 0 && v.maxPageIndex < firstPartOfOrder.length) furthest = Math.max(furthest, firstPartOfOrder[v.maxPageIndex]);
  }
  for (const p of pages) {
    const r = b.pages[viewerPageKey(p.pageId, p.part)];
    if (r && (r.attentionMs > 0 || r.visibleMs > 0)) furthest = Math.max(furthest, p.index);
  }
  return furthest;
}

const attentionOn = (b: BuyerReadingFacts, p: FactPage) => b.pages[viewerPageKey(p.pageId, p.part)]?.attentionMs ?? 0;
const opened = (b: BuyerReadingFacts) => b.visits.length > 0;
const lastSeenMs = (b: BuyerReadingFacts) => b.visits.reduce((m, v) => Math.max(m, Date.parse(v.lastSeenAt) || 0), 0);

// ── Buyers (call list) ─────────────────────────────────────────────────────

export function buildBuyersResponse(facts: DealReadingFacts): EngagementBuyersResponse {
  const ctx = insightContext(facts);
  const shown = facts.buyers.filter((b) => opened(b) || (facts.filters.range === "all" && !!b.firstViewedAt));
  const ranked = rankBuyers(shown.map((f) => ({ facts: f, insight: buyerInsight(f, ctx) })));
  const buyers: BuyerEngagementCard[] = ranked.map(({ facts: b, insight }, rank) => {
    const furthest = furthestViewerIndex(b, facts.pages);
    const pageStrip: PageStripCell[] = facts.pages.map((p) => {
      const key = viewerPageKey(p.pageId, p.part);
      const att = attentionOn(b, p);
      const reached = p.index <= furthest;
      return {
        pageId: p.pageId,
        part: p.part,
        label: p.label,
        attentionMs: att,
        readLabel: (insight.pageLabels[key] as ReadLabel | undefined) ?? pageReadLabel(p.role, att, p.expectedMs, reached),
        reached,
      };
    });
    const firstSeen = b.visits.map((v) => v.startedAt).sort()[0] ?? b.firstViewedAt ?? null;
    const lastSeen = b.visits.map((v) => v.lastSeenAt).sort().pop() ?? null;
    return {
      accessId: b.accessId,
      buyerUserId: b.buyerUserId,
      name: b.name,
      company: b.company,
      buyerType: b.buyerType,
      accessLevel: b.accessLevel,
      mode: b.mode,
      status: insight.status,
      statusLabel: insight.statusLabel,
      why: insight.why,
      fit: b.fit,
      activeMs: b.visits.reduce((s, v) => s + v.activeMs, 0),
      visits: b.visits.length,
      firstSeenAt: firstSeen,
      lastSeenAt: lastSeen,
      pagesReached: pageStrip.filter((c) => c.reached).length,
      totalPages: facts.pages.length,
      pageStrip,
      signals: insight.signals,
      talkingPoints: insight.talkingPoints,
      questions: b.questions,
      decision: b.decision,
      decisionAt: b.decisionAt,
      contactedAt: b.contactedAt,
      rank,
    };
  });
  const shownIds = new Set(shown.map((b) => b.accessId));
  const notOpened: NotOpenedBuyer[] = facts.buyers
    .filter((b) => !shownIds.has(b.accessId) && !b.firstViewedAt)
    .map((b) => ({ accessId: b.accessId, name: b.name, company: b.company, grantedAt: b.grantedAt, ndaSigned: !!b.ndaSignedAt }));
  return {
    buyers,
    notOpened,
    pages: facts.pages.map(({ pageId, part, index, label }) => ({ pageId, part, index, label })),
    legacyOnly: facts.legacyOnly,
  };
}

// ── Document (the heat map) ────────────────────────────────────────────────

const GROUP_LABEL = new Map<KindGroup, string>(KIND_GROUPS.map((g) => [g.key, g.label]));

export function buildDocumentResponse(facts: DealReadingFacts): EngagementDocumentResponse {
  const f = facts as Facts;
  const readersOf = facts.buyers.filter(opened);
  const openedBy = readersOf.length;
  const furthest = new Map(readersOf.map((b) => [b.accessId, furthestViewerIndex(b, facts.pages)]));
  const blockLevel = new Set(f.blockLevelPages ?? []);

  const pages: DocumentPage[] = facts.pages.map((p) => {
    const reachedBuyers = readersOf.filter((b) => (furthest.get(b.accessId) ?? -1) >= p.index);
    const perBuyer = readersOf.map((b) => ({ b, att: attentionOn(b, p), skim: b.pages[viewerPageKey(p.pageId, p.part)]?.skimMs ?? 0 }));
    const attentionMs = perBuyer.reduce((s, x) => s + x.att, 0);
    const skimMs = perBuyer.reduce((s, x) => s + x.skim, 0);
    const buyers: BuyerSeconds[] = perBuyer.filter((x) => x.att > 0)
      .sort((a, b) => b.att - a.att)
      .map((x) => ({ accessId: x.b.accessId, name: x.b.name, attentionMs: x.att }));

    // Parts of the page (the heat on the real page). Chart points fold into their chart.
    const blocks: BlockAttention[] = [];
    for (const blk of p.blocks) {
      if (blk.virtual) continue;
      let att = 0, skim = 0, vis = 0, ptr = 0, readers = 0;
      let top: BuyerSeconds | null = null;
      for (const b of readersOf) {
        const c = b.blocks[blockId(p.pageId, blk.key)];
        if (!c) continue;
        att += c[0]; skim += c[1]; vis += c[2]; ptr += c[3];
        if (c[0] >= READING_RULES.unreadBlockMs) readers++;
        if (c[0] > 0 && (!top || c[0] > top.attentionMs)) top = { accessId: b.accessId, name: b.name, attentionMs: c[0] };
      }
      // Another view nobody opened (Normalized rows). A collapsed section's
      // summary is always listed: it is what every buyer first saw.
      if (blk.when && blk.when !== "collapsed" && att + skim + vis + ptr === 0) continue;
      let topPoint: BlockAttention["topPoint"] = null;
      for (const pt of p.blocks) {
        if (!pt.virtual || !pt.key.startsWith(`${blk.key}/point:`)) continue;
        const ms = readersOf.reduce((s, b) => s + (b.blocks[blockId(p.pageId, pt.key)]?.[3] ?? 0), 0);
        if (ms > 0 && (!topPoint || ms > topPoint.pointerMs)) topPoint = { key: pt.key, label: pt.label, pointerMs: ms };
      }
      blocks.push({
        key: blk.key, kind: blk.kind, label: blk.label,
        attentionMs: att, skimMs: skim, visibleMs: vis, pointerMs: ptr,
        skimShare: att + skim > 0 ? Math.round((skim / (att + skim)) * 100) / 100 : 0,
        readers, topBuyer: top, topPoint,
      });
    }

    const interactions: InteractionCounts = {};
    for (const b of readersOf) {
      for (const e of b.events) {
        if (e.pageId !== p.pageId) continue;
        const part = e.blockKey ? p.blocks.find((x) => x.key === e.blockKey)?.part ?? 0 : 0;
        const pagePart = facts.pages.some((x) => x.pageId === p.pageId && x.part === part) ? part : 0;
        if (pagePart !== p.part) continue;
        interactions[e.type] = (interactions[e.type] ?? 0) + 1;
      }
    }
    const questions = p.part === 0
      ? facts.buyers.flatMap((b) => b.questions.filter((q) => q.pageId === p.pageId).map((q) => ({ ...q, accessId: b.accessId, name: b.name })))
      : [];
    const changedN = f.changedReaders?.[p.pageId]?.length ?? 0;
    return {
      pageId: p.pageId, part: p.part, index: p.index, label: p.label,
      lineageId: p.lineageId, title: p.title, servedTitle: p.servedTitle, blindTitle: p.blindTitle ?? null, layoutType: p.layoutType, role: p.role, locked: p.locked,
      readers: perBuyer.filter((x) => x.att >= READING_RULES.readerMinMs).length,
      reachedBy: reachedBuyers.length,
      attentionMs, skimMs, expectedMs: p.expectedMs,
      readLabel: groupReadLabel(reachedBuyers.map((b) => pageReadLabel(p.role, attentionOn(b, p), p.expectedMs, true))),
      headline: null,
      blocks,
      buyers,
      interactions,
      questions,
      changedSince: changedN > 0 ? changedN : null,
      pageLevelOnly: facts.legacyOnly || (attentionMs > 0 && !blockLevel.has(p.pageId)),
    };
  });
  const doc = { pages, openedBy };
  for (const pg of pages) pg.headline = pageHeadline(pg, doc);

  const reach: ReachPoint[] = pages.map((p) => ({ index: p.index, pageId: p.pageId, part: p.part, label: p.label, title: p.title, buyers: p.reachedBy }));

  const kinds = new Map<KindGroup, KindAttention>();
  for (const p of pages) {
    const fp = facts.pages[p.index];
    for (const blk of p.blocks) {
      const g = kindGroupOf(blk.kind);
      const k = kinds.get(g) ?? { group: g, label: GROUP_LABEL.get(g) ?? g, attentionMs: 0, expectedMs: 0, blocks: 0 };
      const expected = fp?.blocks.find((x) => x.key === blk.key)?.expectedMs ?? 0;
      k.attentionMs += blk.attentionMs;
      k.expectedMs += expected * p.reachedBy;
      k.blocks += 1;
      kinds.set(g, k);
    }
  }
  const byKind = KIND_GROUPS.map((g) => kinds.get(g.key)).filter((k): k is KindAttention => !!k && k.blocks > 0);

  return {
    rendition: facts.rendition,
    renditions: facts.renditions,
    openedBy,
    reach,
    reachHeadline: reachHeadline(reach),
    pages,
    byKind,
    totals: {
      attentionMs: pages.reduce((s, p) => s + p.attentionMs, 0),
      skimMs: pages.reduce((s, p) => s + p.skimMs, 0),
      readers: readersOf.filter((b) => facts.pages.some((p) => attentionOn(b, p) >= READING_RULES.readerMinMs)).length,
      visits: facts.buyers.reduce((s, b) => s + b.visits.length, 0),
    },
    legacyOnly: facts.legacyOnly,
  };
}

// ── Summary (pulse) ────────────────────────────────────────────────────────

export function buildSummaryResponse(facts: DealReadingFacts, published: boolean, dealName: string): EngagementSummaryResponse {
  const now = new Date(facts.now).getTime();
  const granted = facts.buyers.length;
  const openedN = facts.buyers.filter((b) => opened(b) || !!b.firstViewedAt).length;
  const readThisWeek = facts.buyers.filter((b) => opened(b) && now - lastSeenMs(b) <= 7 * 86_400_000).length;
  const readingNowBuyers = facts.buyers.filter((b) => opened(b) && now - lastSeenMs(b) <= READING_RULES.readingNowMs);
  const cards = buildBuyersResponse(facts).buyers;
  const top: CallListEntry[] = cards.slice(0, 3).map((c) => ({
    dealId: facts.dealId,
    dealName,
    accessId: c.accessId,
    name: c.name,
    company: c.company,
    status: c.status,
    statusLabel: c.statusLabel,
    why: c.why,
    talkingPoints: c.talkingPoints,
    lastSeenAt: c.lastSeenAt,
  }));
  // The most studied page: most reading time, front matter aside.
  let most: (PageRef & { attentionMs: number }) | null = null;
  for (const p of facts.pages) {
    if (p.role === "front_matter") continue;
    const att = facts.buyers.reduce((s, b) => s + attentionOn(b, p), 0);
    if (att > 0 && (!most || att > most.attentionMs)) most = { pageId: p.pageId, part: p.part, label: p.label, title: p.title, attentionMs: att };
  }
  return {
    dealId: facts.dealId,
    published,
    pulse: {
      granted,
      opened: openedN,
      readThisWeek,
      readingNow: readingNowBuyers.length,
      sentence: pulseSentence({ granted, opened: openedN, readThisWeek, readingNow: readingNowBuyers.length }),
    },
    readingNow: readingNowBuyers.map((b) => {
      const latest = [...b.visits].sort((x, y) => Date.parse(y.lastSeenAt) - Date.parse(x.lastSeenAt))[0];
      const at = latest?.path.length ? latest.path[latest.path.length - 1][1] : null;
      return { accessId: b.accessId, name: b.name, company: b.company, page: at ? pageRefOf(facts, at) : null, since: new Date(lastSeenMs(b)).toISOString() };
    }),
    top,
    mostStudiedPage: most,
    renditions: facts.renditions,
    legacyOnly: facts.legacyOnly,
    lastWriteAt: facts.lastWriteAt,
  };
}

// ── Journey (one buyer's visits) ───────────────────────────────────────────

export function buildJourneyResponse(
  facts: DealReadingFacts,
  accessId: string,
  decisions?: Array<{ decision: string; at: string }>,
): BuyerJourneyResponse | null {
  const b = facts.buyers.find((x) => x.accessId === accessId);
  if (!b) return null;
  const ctx = insightContext(facts);
  const visits: JourneyVisit[] = [...b.visits]
    .sort((x, y) => Date.parse(y.startedAt) - Date.parse(x.startedAt))
    .map((v) => {
      const navs = b.events.filter((e) => e.visitId === v.id && e.type === "nav" && e.detail)
        .sort((x, y) => x.seq - y.seq)
        .map((e) => { const m = /^(toc|sticky|related):(.+)$/.exec(e.detail!); return m ? { via: m[1] as JourneySegment["via"], target: m[2] } : null; })
        .filter((x): x is { via: JourneySegment["via"]; target: string } => !!x);
      let cursor = 0;
      const path: JourneySegment[] = v.path.map(([t, pageId], i) => {
        const ref = pageRefOf(facts, pageId);
        const end = i + 1 < v.path.length ? v.path[i + 1][0] : Math.max(t, Math.floor(v.activeMs / 1000));
        return {
          pageId, part: ref?.part ?? 0, label: ref?.label ?? "", title: ref?.title ?? "A page no longer in the CIM",
          startSec: t, durationSec: Math.max(0, end - t), via: null,
        };
      });
      // Jumps: the k-th "go to page X" marks the next arrival on X.
      for (const n of navs) {
        const at = path.findIndex((s, i) => i >= cursor && s.pageId === n.target);
        if (at >= 0) { path[at].via = n.via; cursor = at + 1; }
      }
      return {
        id: v.id,
        startedAt: v.startedAt,
        lastSeenAt: v.lastSeenAt,
        activeMs: v.activeMs,
        device: v.device,
        pagesReached: new Set(v.path.map(([, p]) => p)).size || (v.maxPageIndex >= 0 ? v.maxPageIndex + 1 : 0),
        legacy: v.legacy,
        path,
        moments: journeyMoments(v, b, ctx),
      };
    });
  return {
    accessId: b.accessId,
    name: b.name,
    company: b.company,
    visits,
    questions: b.questions,
    decisions: decisions && decisions.length ? decisions : b.decisionAt ? [{ decision: b.decision, at: b.decisionAt }] : [],
  };
}
