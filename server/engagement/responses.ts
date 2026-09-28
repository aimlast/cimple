/**
 * DealReadingFacts → the broker API responses (shared/analytics-v2.ts).
 * Pure. Owned by the CAPTURE stream (aggregation: readers, reach, block
 * attention, kind breakdown, strips, journeys); it calls the INTELLIGENCE
 * stream's insights.ts for everything that is judgement (status, why,
 * signals, talking points, headlines, moments).
 *
 * Base bodies: correct shapes, minimal numbers (no reading exists yet).
 */
import {
  READING_RULES,
  type BuyerEngagementCard,
  type BuyerJourneyResponse,
  type CallListEntry,
  type DealReadingFacts,
  type EngagementBuyersResponse,
  type EngagementDocumentResponse,
  type EngagementSummaryResponse,
  type NotOpenedBuyer,
} from "@shared/analytics-v2";
import { buyerInsight, pulseSentence, rankBuyers, reachHeadline, type InsightContext } from "./insights";

export function insightContext(facts: DealReadingFacts): InsightContext {
  return { now: new Date(facts.now), pages: facts.pages, buyers: facts.buyers };
}

export function buildBuyersResponse(facts: DealReadingFacts): EngagementBuyersResponse {
  const ctx = insightContext(facts);
  const opened = facts.buyers.filter((b) => b.visits.length > 0);
  const ranked = rankBuyers(opened.map((f) => ({ facts: f, insight: buyerInsight(f, ctx) })));
  const buyers: BuyerEngagementCard[] = ranked.map(({ facts: b, insight }, rank) => ({
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
    firstSeenAt: b.visits.map((v) => v.startedAt).sort()[0] ?? null,
    lastSeenAt: b.visits.map((v) => v.lastSeenAt).sort().pop() ?? null,
    pagesReached: 0,
    totalPages: facts.pages.length,
    pageStrip: [],
    signals: insight.signals,
    talkingPoints: insight.talkingPoints,
    questions: b.questions,
    decision: b.decision,
    decisionAt: b.decisionAt,
    contactedAt: b.contactedAt,
    rank,
  }));
  const notOpened: NotOpenedBuyer[] = facts.buyers
    .filter((b) => b.visits.length === 0)
    .map((b) => ({ accessId: b.accessId, name: b.name, company: b.company, grantedAt: b.grantedAt, ndaSigned: !!b.ndaSignedAt }));
  return {
    buyers,
    notOpened,
    pages: facts.pages.map(({ pageId, part, index, label }) => ({ pageId, part, index, label })),
    legacyOnly: facts.legacyOnly,
  };
}

export function buildDocumentResponse(facts: DealReadingFacts): EngagementDocumentResponse {
  const openedBy = facts.buyers.filter((b) => b.visits.length > 0).length;
  return {
    rendition: facts.rendition,
    renditions: facts.renditions,
    openedBy,
    reach: [],
    reachHeadline: reachHeadline([]),
    pages: [],
    byKind: [],
    totals: { attentionMs: 0, skimMs: 0, readers: 0, visits: facts.buyers.reduce((s, b) => s + b.visits.length, 0) },
    legacyOnly: facts.legacyOnly,
  };
}

export function buildSummaryResponse(facts: DealReadingFacts, published: boolean, dealName: string): EngagementSummaryResponse {
  const now = new Date(facts.now).getTime();
  const lastSeen = (b: DealReadingFacts["buyers"][number]) => b.visits.reduce((m, v) => Math.max(m, Date.parse(v.lastSeenAt) || 0), 0);
  const granted = facts.buyers.length;
  const opened = facts.buyers.filter((b) => b.visits.length > 0 || !!b.firstViewedAt).length;
  const readThisWeek = facts.buyers.filter((b) => now - lastSeen(b) <= 7 * 86_400_000 && b.visits.length > 0).length;
  const readingNowBuyers = facts.buyers.filter((b) => b.visits.length > 0 && now - lastSeen(b) <= READING_RULES.readingNowMs);
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
  return {
    dealId: facts.dealId,
    published,
    pulse: {
      granted,
      opened,
      readThisWeek,
      readingNow: readingNowBuyers.length,
      sentence: pulseSentence({ granted, opened, readThisWeek, readingNow: readingNowBuyers.length }),
    },
    readingNow: readingNowBuyers.map((b) => ({ accessId: b.accessId, name: b.name, company: b.company, page: null, since: new Date(lastSeen(b)).toISOString() })),
    top,
    mostStudiedPage: null,
    renditions: facts.renditions,
    legacyOnly: facts.legacyOnly,
    lastWriteAt: facts.lastWriteAt,
  };
}

export function buildJourneyResponse(facts: DealReadingFacts, accessId: string): BuyerJourneyResponse | null {
  const b = facts.buyers.find((x) => x.accessId === accessId);
  if (!b) return null;
  return {
    accessId: b.accessId,
    name: b.name,
    company: b.company,
    visits: [],
    questions: b.questions,
    decisions: b.decisionAt ? [{ decision: b.decision, at: b.decisionAt }] : [],
  };
}
