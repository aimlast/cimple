/**
 * Data access for the broker's view of one buyer (profile page, timeline,
 * list). Every function is scoped to one broker: it only ever reads that
 * broker's contact row, that broker's deals and the buyer's activity on them.
 *
 * Kept out of storage.ts on purpose — these are read models for one screen,
 * not general storage primitives.
 */
import { db } from "../db";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import {
  analyticsEvents, brokerBuyerContacts, buyerAccess, buyerApprovalRequests, buyerEmails,
  buyerQuestions, buyerUsers, cimSections, dealOutreach, deals,
  type BrokerBuyerContact, type BuyerAccess, type BuyerDeepCheck, type BuyerUser,
} from "@shared/schema";

/**
 * Is this buyer on the broker's list? Same membership rule as the Buyers
 * page (storage.getBrokerBuyerContactList): a contact row, an invite from
 * this broker, or access linked to one of this broker's deals.
 */
export async function isBuyerInBrokerList(brokerId: string, buyerUserId: string): Promise<boolean> {
  if (!brokerId || !buyerUserId) return false;
  const rows = await db.select({ id: buyerUsers.id }).from(buyerUsers).where(and(
    eq(buyerUsers.id, buyerUserId),
    or(
      eq(buyerUsers.invitedByBroker, brokerId),
      sql`EXISTS (SELECT 1 FROM ${brokerBuyerContacts} c WHERE c.broker_id = ${brokerId} AND c.buyer_user_id = ${buyerUsers.id})`,
      sql`EXISTS (SELECT 1 FROM ${buyerAccess} ba JOIN ${deals} d ON d.id = ba.deal_id WHERE d.broker_id = ${brokerId} AND ba.buyer_user_id = ${buyerUsers.id})`,
    ),
  )).limit(1);
  return rows.length > 0;
}

/** Buyer ids from `ids` that are on the broker's list (for bulk endpoints). */
export async function filterBuyersInBrokerList(brokerId: string, ids: string[]): Promise<Set<string>> {
  const unique = Array.from(new Set(ids.filter(Boolean)));
  if (!brokerId || unique.length === 0) return new Set();
  const rows = await db.select({ id: buyerUsers.id }).from(buyerUsers).where(and(
    inArray(buyerUsers.id, unique),
    or(
      eq(buyerUsers.invitedByBroker, brokerId),
      sql`EXISTS (SELECT 1 FROM ${brokerBuyerContacts} c WHERE c.broker_id = ${brokerId} AND c.buyer_user_id = ${buyerUsers.id})`,
      sql`EXISTS (SELECT 1 FROM ${buyerAccess} ba JOIN ${deals} d ON d.id = ba.deal_id WHERE d.broker_id = ${brokerId} AND ba.buyer_user_id = ${buyerUsers.id})`,
    ),
  ));
  return new Set(rows.map((r) => r.id));
}

/** The broker's contact row for a buyer (oldest wins if a race ever made two). */
export async function getContact(brokerId: string, buyerUserId: string): Promise<BrokerBuyerContact | undefined> {
  const rows = await db.select().from(brokerBuyerContacts)
    .where(and(eq(brokerBuyerContacts.brokerId, brokerId), eq(brokerBuyerContacts.buyerUserId, buyerUserId)))
    .orderBy(brokerBuyerContacts.addedAt);
  return rows[0];
}

/** Contact row, created (source "deal") when the buyer is only on the list through access or an invite. */
export async function ensureContact(brokerId: string, buyerUserId: string): Promise<BrokerBuyerContact> {
  const existing = await getContact(brokerId, buyerUserId);
  if (existing) return existing;
  const [row] = await db.insert(brokerBuyerContacts).values({ brokerId, buyerUserId, source: "deal", tags: [] as any, notes: null } as any).returning();
  return row;
}

export async function updateContact(id: string, updates: Partial<BrokerBuyerContact>): Promise<BrokerBuyerContact | undefined> {
  const [row] = await db.update(brokerBuyerContacts).set({ ...updates, updatedAt: new Date() } as any).where(eq(brokerBuyerContacts.id, id)).returning();
  return row;
}

export interface BrokerDealLite {
  id: string;
  businessName: string;
  industry: string | null;
  blindCodename: string | null;
  buyerDeepCheck: BuyerDeepCheck | null;
}

export async function getBrokerDeals(brokerId: string): Promise<BrokerDealLite[]> {
  const rows = await db.select({
    id: deals.id, businessName: deals.businessName, industry: deals.industry,
    blindCodename: deals.blindCodename, buyerDeepCheck: deals.buyerDeepCheck,
  }).from(deals).where(eq(deals.brokerId, brokerId));
  return rows as BrokerDealLite[];
}

/**
 * Access rows on the broker's deals that belong to this buyer — linked by
 * account, or (for rows granted before the account existed / unverified
 * accounts) by the same email. Broker-facing only, so matching by email here
 * never hands a buyer anything.
 */
export async function getBuyerAccessOnBrokerDeals(brokerDealIds: string[], buyer: Pick<BuyerUser, "id" | "email">): Promise<BuyerAccess[]> {
  if (brokerDealIds.length === 0) return [];
  return db.select().from(buyerAccess).where(and(
    inArray(buyerAccess.dealId, brokerDealIds),
    or(eq(buyerAccess.buyerUserId, buyer.id), sql`LOWER(${buyerAccess.buyerEmail}) = ${buyer.email.toLowerCase()}`),
  )).orderBy(desc(buyerAccess.createdAt));
}

export interface AccessEngagement {
  views: number;
  seconds: number;
  sectionsViewed: number;
  lastEventAt: Date | null;
  firstViewEventAt: Date | null;
  topSections: Array<{ key: string; seconds: number }>;
}

/** Views / time / sections per access row, from the analytics stream. */
export async function engagementByAccess(accessIds: string[]): Promise<Map<string, AccessEngagement>> {
  const out = new Map<string, AccessEngagement>();
  if (accessIds.length === 0) return out;
  const rows = await db.select({
    accessId: analyticsEvents.buyerAccessId,
    eventType: analyticsEvents.eventType,
    sectionKey: analyticsEvents.sectionKey,
    n: sql<number>`count(*)::int`,
    secs: sql<number>`coalesce(sum(${analyticsEvents.timeSpentSeconds}), 0)::int`,
    // Epoch ms: a raw timestamp-without-zone string would be parsed as local time.
    first: sql<number>`(extract(epoch from min(${analyticsEvents.createdAt})) * 1000)::float8`,
    last: sql<number>`(extract(epoch from max(${analyticsEvents.createdAt})) * 1000)::float8`,
  }).from(analyticsEvents)
    .where(and(
      inArray(analyticsEvents.buyerAccessId, accessIds),
      inArray(analyticsEvents.eventType, ["view", "section_enter", "section_exit", "scroll_depth", "decision", "nda_signed", "question_asked"]),
    ))
    .groupBy(analyticsEvents.buyerAccessId, analyticsEvents.eventType, analyticsEvents.sectionKey);

  const sectionSecs = new Map<string, Map<string, number>>();
  const sectionsSeen = new Map<string, Set<string>>();
  for (const r of rows) {
    const id = r.accessId!;
    const e = out.get(id) ?? { views: 0, seconds: 0, sectionsViewed: 0, lastEventAt: null, firstViewEventAt: null, topSections: [] };
    const last = r.last != null ? new Date(Number(r.last)) : null;
    if (last && (!e.lastEventAt || last > e.lastEventAt)) e.lastEventAt = last;
    if (r.eventType === "view") {
      e.views += Number(r.n) || 0;
      const first = r.first != null ? new Date(Number(r.first)) : null;
      if (first && (!e.firstViewEventAt || first < e.firstViewEventAt)) e.firstViewEventAt = first;
    }
    if (r.eventType === "section_exit" && r.sectionKey) {
      e.seconds += Number(r.secs) || 0;
      const m = sectionSecs.get(id) ?? new Map<string, number>();
      m.set(r.sectionKey, (m.get(r.sectionKey) ?? 0) + (Number(r.secs) || 0));
      sectionSecs.set(id, m);
    }
    if (r.eventType === "section_enter" && r.sectionKey) {
      const s = sectionsSeen.get(id) ?? new Set<string>();
      s.add(r.sectionKey);
      sectionsSeen.set(id, s);
    }
    out.set(id, e);
  }
  for (const [id, e] of Array.from(out.entries())) {
    e.sectionsViewed = sectionsSeen.get(id)?.size ?? 0;
    e.topSections = Array.from((sectionSecs.get(id) ?? new Map<string, number>()).entries())
      .map(([key, seconds]) => ({ key, seconds }))
      .filter((s) => s.seconds > 0)
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, 3);
  }
  return out;
}

/** Every decision the buyer submitted (including "need more time"), oldest first. */
export async function decisionEvents(accessIds: string[]) {
  if (accessIds.length === 0) return [];
  return db.select({
    accessId: analyticsEvents.buyerAccessId, eventData: analyticsEvents.eventData, createdAt: analyticsEvents.createdAt,
  }).from(analyticsEvents)
    .where(and(inArray(analyticsEvents.buyerAccessId, accessIds), eq(analyticsEvents.eventType, "decision")))
    .orderBy(analyticsEvents.createdAt)
    .limit(200);
}

export async function questionsFor(accessIds: string[]) {
  if (accessIds.length === 0) return [];
  return db.select({
    id: buyerQuestions.id, accessId: buyerQuestions.buyerAccessId, dealId: buyerQuestions.dealId,
    question: buyerQuestions.question, status: buyerQuestions.status, createdAt: buyerQuestions.createdAt,
  }).from(buyerQuestions).where(inArray(buyerQuestions.buyerAccessId, accessIds)).orderBy(desc(buyerQuestions.createdAt)).limit(100);
}

export async function outreachFor(brokerId: string, buyerUserId: string) {
  return db.select({
    id: dealOutreach.id, dealId: dealOutreach.dealId, subject: dealOutreach.subject, status: dealOutreach.status,
    sentAt: dealOutreach.sentAt, createdAt: dealOutreach.createdAt,
  }).from(dealOutreach)
    .where(and(eq(dealOutreach.brokerId, brokerId), eq(dealOutreach.buyerUserId, buyerUserId)))
    .orderBy(desc(dealOutreach.createdAt)).limit(100);
}

export async function emailsFor(brokerId: string, buyerUserId: string) {
  return db.select().from(buyerEmails)
    .where(and(eq(buyerEmails.brokerId, brokerId), eq(buyerEmails.buyerUserId, buyerUserId)))
    .orderBy(desc(buyerEmails.createdAt)).limit(100);
}

/** Approval requests for this buyer (by email) on the broker's deals. */
export async function approvalsFor(brokerDealIds: string[], email: string) {
  if (brokerDealIds.length === 0) return [];
  return db.select({
    id: buyerApprovalRequests.id, dealId: buyerApprovalRequests.dealId, status: buyerApprovalRequests.status,
    category: buyerApprovalRequests.category, background: buyerApprovalRequests.background,
    financialCapability: buyerApprovalRequests.financialCapability, isCompetitor: buyerApprovalRequests.isCompetitor,
    brokerReviewedAt: buyerApprovalRequests.brokerReviewedAt, sellerReviewedAt: buyerApprovalRequests.sellerReviewedAt,
    rejectionReason: buyerApprovalRequests.rejectionReason, grantedAt: buyerApprovalRequests.grantedAt,
    createdAt: buyerApprovalRequests.createdAt,
  }).from(buyerApprovalRequests).where(and(
    inArray(buyerApprovalRequests.dealId, brokerDealIds),
    sql`LOWER(${buyerApprovalRequests.buyerEmail}) = ${email.toLowerCase()}`,
  )).orderBy(desc(buyerApprovalRequests.createdAt)).limit(50);
}

/** Section titles for analytics section keys, per deal. */
export async function sectionTitles(dealIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (dealIds.length === 0) return out;
  const rows = await db.select({ dealId: cimSections.dealId, key: cimSections.sectionKey, title: cimSections.sectionTitle })
    .from(cimSections).where(inArray(cimSections.dealId, dealIds));
  for (const r of rows) out.set(`${r.dealId}:${r.key}`, r.title);
  return out;
}

export async function recordBuyerEmail(row: typeof buyerEmails.$inferInsert) {
  const [created] = await db.insert(buyerEmails).values(row).returning();
  return created;
}

/**
 * Per-buyer engagement across all of the broker's deals, for the Buyers
 * list (score, sort by activity). One pass over the broker's access rows.
 */
export async function brokerBuyerEngagement(brokerId: string, buyers: Array<Pick<BuyerUser, "id" | "email">>): Promise<Map<string, {
  views: number; seconds: number; sectionsViewed: number; questions: number; ndaSigned: boolean;
  lastActivityAt: Date | null; dealIds: Set<string>; latestDecision: string | null;
}>> {
  const out = new Map<string, any>();
  const brokerDealIds = (await db.select({ id: deals.id }).from(deals).where(eq(deals.brokerId, brokerId))).map((d) => d.id);
  if (brokerDealIds.length === 0 || buyers.length === 0) return out;
  const byId = new Map(buyers.map((b) => [b.id, b.id]));
  const byEmail = new Map(buyers.map((b) => [b.email.toLowerCase(), b.id]));
  const accesses = await db.select({
    id: buyerAccess.id, dealId: buyerAccess.dealId, buyerUserId: buyerAccess.buyerUserId, buyerEmail: buyerAccess.buyerEmail,
    viewCount: buyerAccess.viewCount, ndaSignedAt: buyerAccess.ndaSignedAt, lastAccessedAt: buyerAccess.lastAccessedAt,
    decision: buyerAccess.decision, decisionAt: buyerAccess.decisionAt,
  }).from(buyerAccess).where(inArray(buyerAccess.dealId, brokerDealIds));
  const owner = new Map<string, string>();
  for (const a of accesses) {
    const buyerId = (a.buyerUserId && byId.get(a.buyerUserId)) || byEmail.get(a.buyerEmail.toLowerCase());
    if (!buyerId) continue;
    owner.set(a.id, buyerId);
    const e = out.get(buyerId) ?? { views: 0, seconds: 0, sectionsViewed: 0, questions: 0, ndaSigned: false, lastActivityAt: null, dealIds: new Set<string>(), latestDecision: null, _decisionAt: null };
    e.views += a.viewCount ?? 0;
    e.ndaSigned = e.ndaSigned || !!a.ndaSignedAt;
    e.dealIds.add(a.dealId);
    for (const t of [a.lastAccessedAt, a.ndaSignedAt, a.decisionAt]) if (t && (!e.lastActivityAt || t > e.lastActivityAt)) e.lastActivityAt = t;
    if (a.decision && a.decision !== "under_review" && a.decisionAt && (!e._decisionAt || a.decisionAt > e._decisionAt)) { e.latestDecision = a.decision; e._decisionAt = a.decisionAt; }
    out.set(buyerId, e);
  }
  const ids = Array.from(owner.keys());
  if (ids.length) {
    const eng = await engagementByAccess(ids);
    for (const [accessId, g] of Array.from(eng.entries())) {
      const e = out.get(owner.get(accessId)!);
      if (!e) continue;
      e.seconds += g.seconds;
      e.sectionsViewed += g.sectionsViewed;
      if (!e.views && g.views) e.views = g.views;
    }
    const qs = await db.select({ accessId: buyerQuestions.buyerAccessId, n: sql<number>`count(*)::int` })
      .from(buyerQuestions).where(inArray(buyerQuestions.buyerAccessId, ids)).groupBy(buyerQuestions.buyerAccessId);
    for (const q of qs) {
      const e = out.get(owner.get(q.accessId!)!);
      if (e) e.questions += Number(q.n) || 0;
    }
  }
  for (const e of Array.from(out.values())) delete e._decisionAt;
  return out;
}
