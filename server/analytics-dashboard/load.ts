/**
 * Loading the analytics dashboards' inputs (the only file here that reads
 * the database, besides reading-now.ts).
 *
 *   loadBrokerInputs(brokerId, opts)   the Analytics page: the broker's own
 *                                      non-archived deals (example-deals
 *                                      rule applied), every buyer link on
 *                                      them, the questions and approvals
 *                                      that can wait on the broker, and the
 *                                      reading facts of every deal with a
 *                                      CIM link
 *   loadDealInputs(deal, filters)      the deal Engagement tab and the pulse
 *   loadDecisions(dealIds)             every recorded decision (Activity)
 *
 * The access, question and approval reads are never memoised (cheap; they
 * keep the "right now" numbers exact). The reading facts are memoised
 * (stale-while-revalidate, memo.ts) on top of the shared 30 s facts cache.
 *
 * An access fingerprint per deal (ids, levels, revokes, expiries,
 * decisions, NDA signatures, first views, number of broker actions) drops
 * that deal's cached facts the moment any of them changes — from ANY code
 * path — so grants, revokes, extensions, level changes, decisions and
 * "Mark contacted" show on the next request without editing those routes.
 *
 * Tenancy: everything starts from ownedLiveDeals(brokerId); every SQL read
 * is restricted to those deal ids. An empty broker id throws.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Deal } from "@shared/schema";
import { DEFAULT_ENGAGEMENT_FILTERS, type EngagementFilters } from "@shared/analytics-v2";
import { resolveExamples, type ExamplesMode } from "@shared/analytics-dashboard";
import { dealPublishedForBuyers } from "@shared/buyer-publish-gate";
import type { CaptureFacts } from "../engagement/facts";
import { cachedDealReadingFacts, invalidateDealFacts } from "../engagement/facts-cache";
import { ownedLiveDeals } from "../engagement/access";
import { readingVersion } from "../analytics/reading-ingest";
import { dropMemo, swr } from "./memo";
import { seesCim } from "./levels";

// ── Shapes ────────────────────────────────────────────────────────────────

export interface DashboardItem {
  deal: Deal;
  facts: CaptureFacts;
  demo: boolean;
  live: boolean;
}

export interface AccessEventRow {
  type: string;
  at: string;
  accessLevel?: string | null;
  expiresAt?: string | null;
}

export interface AccessRow {
  id: string;
  dealId: string;
  buyerName: string | null;
  buyerEmail: string;
  buyerCompany: string | null;
  buyerUserId: string | null;
  buyerType: string | null;
  accessLevel: string;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  firstViewedAt: Date | null;
  ndaSignedAt: Date | null;
  decision: string | null;
  decisionAt: Date | null;
  decisionNextStep: string | null;
  decisionReason: string | null;
  accessEvents: AccessEventRow[];
}

/** Questions that can still wait on someone (pending_ai | pending_broker | pending_seller). */
export interface QuestionRow {
  id: string;
  dealId: string;
  accessId: string | null;
  text: string;
  askedAt: Date;
  status: string;
  publishedAnswer: boolean;
}

/** Buyer approval requests waiting for the broker (status pending_broker_review). */
export interface ApprovalRow {
  id: string;
  dealId: string;
  buyerName: string;
  buyerCompany: string | null;
  /** 'teaser_request' = a buyer asked for the CIM from the teaser (teaser stream). */
  source: string | null;
  createdAt: Date;
  buyerAccessId: string | null;
}

export interface DecisionRow {
  dealId: string;
  accessId: string;
  decision: string;
  nextStep: string | null;
  at: Date;
}

export interface BrokerInputs {
  /** Own, not archived, after the example-deals rule. */
  deals: Deal[];
  /** Deals with ≥ 1 CIM link, with their reading facts. */
  items: DashboardItem[];
  /** Every link on those deals (teaser included). */
  access: AccessRow[];
  questions: QuestionRow[];
  approvals: ApprovalRow[];
  /** Every recorded decision on those deals, oldest first ("asked for more time", Activity). */
  decisions: DecisionRow[];
  failed: Array<{ dealId: string; dealName: string }>;
  examples: { included: boolean; canToggle: boolean; count: number };
  /** The broker's non-archived deals before the example-deals rule. */
  ownDeals: number;
}

export interface DealInputs extends BrokerInputs {
  /** The facts the Buyers view's groups and cards use (the When and Buyers filters; any device, latest version). */
  groupFacts: CaptureFacts;
  filters: EngagementFilters;
}

// ── Seams (tests) ─────────────────────────────────────────────────────────

export interface LoaderDeps {
  ownedDeals(brokerId: string): Promise<Deal[]>;
  accessRows(dealIds: string[]): Promise<AccessRow[]>;
  questions(dealIds: string[]): Promise<QuestionRow[]>;
  approvals(dealIds: string[]): Promise<ApprovalRow[]>;
  decisions(dealIds: string[]): Promise<DecisionRow[]>;
  facts(deal: Deal, filters: EngagementFilters): Promise<CaptureFacts>;
  readingVersion(dealId: string): number;
  invalidateFacts(dealId: string): void;
}

async function rows(q: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  const { db } = await import("../db");
  return (await db.execute(q)) as unknown as Array<Record<string, unknown>>;
}

const asDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
const dateOrNull = (v: unknown): Date | null => (v == null ? null : asDate(v));
const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
const idList = (ids: string[]) => sql.join(ids.map((id) => sql`${id}`), sql`, `);

const dbDeps: LoaderDeps = {
  ownedDeals: (brokerId) => ownedLiveDeals(brokerId),
  async accessRows(dealIds) {
    if (dealIds.length === 0) return [];
    const r = await rows(sql`
      SELECT id, deal_id, buyer_name, buyer_email, buyer_company, buyer_user_id, buyer_type, access_level, created_at,
        expires_at, revoked_at, first_viewed_at, nda_signed_at, decision, decision_at, decision_next_step, decision_reason, access_events
      FROM buyer_access WHERE deal_id = ANY(ARRAY[${idList(dealIds)}]::varchar[])`);
    return r.map((x) => ({
      id: String(x.id),
      dealId: String(x.deal_id),
      buyerName: strOrNull(x.buyer_name),
      buyerEmail: String(x.buyer_email ?? ""),
      buyerCompany: strOrNull(x.buyer_company),
      buyerUserId: strOrNull(x.buyer_user_id),
      buyerType: strOrNull(x.buyer_type),
      accessLevel: String(x.access_level ?? ""),
      createdAt: asDate(x.created_at),
      expiresAt: dateOrNull(x.expires_at),
      revokedAt: dateOrNull(x.revoked_at),
      firstViewedAt: dateOrNull(x.first_viewed_at),
      ndaSignedAt: dateOrNull(x.nda_signed_at),
      decision: strOrNull(x.decision),
      decisionAt: dateOrNull(x.decision_at),
      decisionNextStep: strOrNull(x.decision_next_step),
      decisionReason: strOrNull(x.decision_reason),
      accessEvents: Array.isArray(x.access_events) ? (x.access_events as AccessEventRow[]) : [],
    }));
  },
  async questions(dealIds) {
    if (dealIds.length === 0) return [];
    const r = await rows(sql`
      SELECT id, deal_id, buyer_access_id, question, created_at, status, published_answer
      FROM buyer_questions
      WHERE deal_id = ANY(ARRAY[${idList(dealIds)}]::varchar[]) AND status IN ('pending_ai', 'pending_broker', 'pending_seller')`);
    return r.map((x) => ({
      id: String(x.id),
      dealId: String(x.deal_id),
      accessId: strOrNull(x.buyer_access_id),
      text: String(x.question ?? ""),
      askedAt: asDate(x.created_at),
      status: String(x.status ?? ""),
      publishedAnswer: !!x.published_answer,
    }));
  },
  async approvals(dealIds) {
    if (dealIds.length === 0) return [];
    // source / buyer_access_id are the teaser stream's new columns: read
    // through to_jsonb so this works before and after they exist.
    const r = await rows(sql`
      SELECT r.id, r.deal_id, r.buyer_name, r.buyer_company, r.created_at,
        to_jsonb(r)->>'source' AS source, to_jsonb(r)->>'buyer_access_id' AS buyer_access_id
      FROM buyer_approval_requests r
      WHERE r.deal_id = ANY(ARRAY[${idList(dealIds)}]::varchar[]) AND r.status = 'pending_broker_review'`);
    return r.map((x) => ({
      id: String(x.id),
      dealId: String(x.deal_id),
      buyerName: String(x.buyer_name ?? ""),
      buyerCompany: strOrNull(x.buyer_company),
      source: strOrNull(x.source),
      createdAt: asDate(x.created_at),
      buyerAccessId: strOrNull(x.buyer_access_id),
    }));
  },
  async decisions(dealIds) {
    if (dealIds.length === 0) return [];
    const r = await rows(sql`
      SELECT deal_id, buyer_access_id, event_data, created_at FROM analytics_events
      WHERE event_type = 'decision' AND buyer_access_id IS NOT NULL AND deal_id = ANY(ARRAY[${idList(dealIds)}]::varchar[])
      ORDER BY created_at`);
    return r
      .map((x) => {
        const data = (x.event_data as { decision?: unknown; nextStep?: unknown } | null) ?? {};
        return {
          dealId: String(x.deal_id),
          accessId: String(x.buyer_access_id),
          decision: typeof data.decision === "string" ? data.decision : "",
          nextStep: typeof data.nextStep === "string" && data.nextStep ? data.nextStep : null,
          at: asDate(x.created_at),
        };
      })
      .filter((d) => !!d.decision);
  },
  facts: (deal, filters) => cachedDealReadingFacts(deal, filters),
  readingVersion: (dealId) => readingVersion(dealId),
  invalidateFacts: (dealId) => invalidateDealFacts(dealId),
};

let deps: LoaderDeps = dbDeps;

/** Tests: replace some or all of the loader's reads (null restores the database). */
export function _setLoaderDeps(d: Partial<LoaderDeps> | null): void {
  deps = d ? { ...dbDeps, ...d } : dbDeps;
}

// ── Access fingerprints ───────────────────────────────────────────────────

const fingerprints = new Map<string, string>();

const isoOrEmpty = (d: Date | null) => (d ? d.toISOString() : "");

/** A hash of what about a deal's links changes the numbers. */
export function accessFingerprint(rows: AccessRow[]): string {
  const parts = [...rows]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((r) => [r.id, r.accessLevel, isoOrEmpty(r.revokedAt), isoOrEmpty(r.expiresAt), r.decision ?? "", isoOrEmpty(r.decisionAt),
      isoOrEmpty(r.ndaSignedAt), isoOrEmpty(r.firstViewedAt), r.accessEvents.length].join("|"));
  return createHash("sha1").update(parts.join("\n")).digest("hex");
}

/**
 * Compare each deal's links with the last time they were seen; any change
 * drops that deal's cached facts (shared facts cache + this memo).
 */
export function checkAccessFingerprints(dealIds: string[], access: AccessRow[]): string[] {
  const byDeal = new Map<string, AccessRow[]>();
  for (const id of dealIds) byDeal.set(id, []);
  for (const a of access) byDeal.get(a.dealId)?.push(a);
  const changed: string[] = [];
  byDeal.forEach((list, dealId) => {
    const fp = accessFingerprint(list);
    const prev = fingerprints.get(dealId);
    fingerprints.set(dealId, fp);
    if (prev !== undefined && prev !== fp) {
      changed.push(dealId);
      deps.invalidateFacts(dealId);
      dropMemo(`f:${dealId}`);
      dropMemo(`d:${dealId}|`);
    }
  });
  return changed;
}

/** Tests: forget every fingerprint. */
export function _resetFingerprints(): void {
  fingerprints.clear();
}

// ── Facts ─────────────────────────────────────────────────────────────────

const FACTS_MEMO = { freshMs: 30_000, staleMs: 600_000 };
const DEAL_FACTS_MEMO = { freshMs: 20_000, staleMs: 600_000 };

/** A deal's facts with the default filters (the same cache key as the call list). */
function memoFacts(deal: Deal): Promise<CaptureFacts> {
  return swr(`f:${deal.id}`, FACTS_MEMO, () => deps.facts(deal, DEFAULT_ENGAGEMENT_FILTERS), deps.readingVersion(deal.id));
}

function memoDealFacts(deal: Deal, filters: EngagementFilters): Promise<CaptureFacts> {
  const key = JSON.stringify(filters);
  return swr(`d:${deal.id}|${key}`, DEAL_FACTS_MEMO, () => deps.facts(deal, filters), deps.readingVersion(deal.id));
}

const isDemo = (d: Deal) => !!d.demoKey;

// ── The Analytics page ────────────────────────────────────────────────────

export interface BrokerLoadOptions {
  examples: ExamplesMode | null;
  /** An explicit deal filter (Activity): always included, even an example deal left out. */
  forceDealId?: string | null;
}

/**
 * Only the deals (no links, no facts): the cheap "reading now" poll and
 * the deal-filter check. `all` = every own non-archived deal; `counted` =
 * after the example-deals rule.
 */
export async function loadBrokerDeals(brokerId: string, opts: BrokerLoadOptions): Promise<{ all: Deal[]; counted: Deal[]; included: boolean }> {
  if (!brokerId) throw new Error("loadBrokerDeals: a broker id is required");
  const all = (await deps.ownedDeals(brokerId)).filter((d) => d.brokerId === brokerId && !d.archivedAt);
  const included = resolveExamples(opts.examples, all.some((d) => dealPublishedForBuyers(d) && !isDemo(d)));
  return { all, counted: all.filter((d) => included || !isDemo(d) || d.id === opts.forceDealId), included };
}

const inflight = new Map<string, Promise<BrokerInputs>>();

export function loadBrokerInputs(brokerId: string, opts: BrokerLoadOptions): Promise<BrokerInputs> {
  if (!brokerId) return Promise.reject(new Error("loadBrokerInputs: a broker id is required"));
  const key = `${brokerId}|${opts.examples ?? "default"}|${opts.forceDealId ?? ""}`;
  const running = inflight.get(key);
  if (running) return running;
  const p = loadBrokerInputsNow(brokerId, opts).finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

async function loadBrokerInputsNow(brokerId: string, opts: BrokerLoadOptions): Promise<BrokerInputs> {
  const own = await deps.ownedDeals(brokerId);
  // Defence in depth (the routes already pass requireBroker): only this broker's rows.
  const mine = own.filter((d) => d.brokerId === brokerId && !d.archivedAt);
  const hasLiveRealDeal = mine.some((d) => dealPublishedForBuyers(d) && !isDemo(d));
  const included = resolveExamples(opts.examples, hasLiveRealDeal);
  const counted = mine.filter((d) => included || !isDemo(d) || d.id === opts.forceDealId);
  const allIds = mine.map((d) => d.id);
  const countedIds = new Set(counted.map((d) => d.id));

  const countedList = counted.map((d) => d.id);
  const [allAccess, questions, approvals, decisions] = await Promise.all([
    deps.accessRows(allIds),
    deps.questions(countedList),
    deps.approvals(countedList),
    deps.decisions(countedList),
  ]);
  checkAccessFingerprints(allIds, allAccess);

  const exampleWithBuyers = new Set(allAccess.filter((a) => mine.find((d) => d.id === a.dealId && isDemo(d))).map((a) => a.dealId));
  const access = allAccess.filter((a) => countedIds.has(a.dealId));
  const withCim = counted.filter((d) => access.some((a) => a.dealId === d.id && seesCim(a.accessLevel)));

  const items: DashboardItem[] = [];
  const failed: Array<{ dealId: string; dealName: string }> = [];
  for (let i = 0; i < withCim.length; i += 4) {
    const got = await Promise.all(withCim.slice(i, i + 4).map(async (deal) => {
      try {
        return { deal, facts: await memoFacts(deal), demo: isDemo(deal), live: dealPublishedForBuyers(deal) };
      } catch (err) {
        console.warn(`[analytics] facts for deal ${deal.id} failed:`, (err as Error)?.message ?? err);
        failed.push({ dealId: deal.id, dealName: deal.businessName });
        return null;
      }
    }));
    for (const g of got) if (g) items.push(g);
  }

  return {
    deals: counted,
    items,
    access,
    questions: questions.filter((q) => countedIds.has(q.dealId)),
    approvals: approvals.filter((a) => countedIds.has(a.dealId)),
    decisions: decisions.filter((d) => countedIds.has(d.dealId)),
    failed,
    examples: { included, canToggle: hasLiveRealDeal, count: exampleWithBuyers.size },
    ownDeals: mine.length,
  };
}

// ── One deal (Engagement tab, pulse) ──────────────────────────────────────

/**
 * The KPI facts keep only the Buyers filters: the period is applied in
 * memory (so deltas and "last on" work) and Device / Which CIM version
 * never change a number (the facts loader drops every old-tracker visit
 * under the phone filter, so passing them through WOULD change numbers).
 */
export function kpiFactsFilters(f: EngagementFilters): EngagementFilters {
  return { ...f, range: "all", device: "all", rendition: null };
}

/** The Buyers view's facts: the When and Buyers filters, any device, the latest version. */
export function groupFactsFilters(f: EngagementFilters): EngagementFilters {
  return { ...f, device: "all", rendition: null };
}

export async function loadDealInputs(deal: Deal, filters: EngagementFilters): Promise<DealInputs> {
  const ids = [deal.id];
  const [access, questions, approvals, decisions] = await Promise.all([
    deps.accessRows(ids), deps.questions(ids), deps.approvals(ids), deps.decisions(ids),
  ]);
  checkAccessFingerprints(ids, access);
  const kf = kpiFactsFilters(filters);
  const gf = groupFactsFilters(filters);
  const [facts, groupFacts] = await Promise.all([
    memoDealFacts(deal, kf),
    JSON.stringify(kf) === JSON.stringify(gf) ? null : memoDealFacts(deal, gf),
  ]);
  const demo = isDemo(deal);
  return {
    deals: [deal],
    items: [{ deal, facts, demo, live: dealPublishedForBuyers(deal) }],
    access: access.filter((a) => a.dealId === deal.id),
    questions: questions.filter((q) => q.dealId === deal.id),
    approvals: approvals.filter((a) => a.dealId === deal.id),
    decisions: decisions.filter((d) => d.dealId === deal.id),
    failed: [],
    examples: { included: true, canToggle: false, count: demo ? 1 : 0 },
    ownDeals: 1,
    groupFacts: groupFacts ?? facts,
    filters,
  };
}

/** Every recorded decision on these deals, oldest first (one read for all). */
export function loadDecisions(dealIds: string[]): Promise<DecisionRow[]> {
  return deps.decisions(dealIds);
}

/** Facts with arbitrary filters (page titles, the deal Activity view). */
export function loadDealFacts(deal: Deal, filters: EngagementFilters): Promise<CaptureFacts> {
  return memoDealFacts(deal, filters);
}
