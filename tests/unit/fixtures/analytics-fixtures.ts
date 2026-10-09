/**
 * Fixtures for the analytics-dashboard tests: deals, buyer links, visits and
 * reading turned into the reading facts (assembleFacts, as the facts loader
 * does) and the loader's inputs — no database, no AI.
 */
import type { Deal } from "../../../shared/schema";
import { DEFAULT_ENGAGEMENT_FILTERS, filterSince, type EngagementFilters, type RenditionPage } from "../../../shared/analytics-v2";
import { seesCim } from "../../../shared/access-levels";
import { assembleFacts, type CaptureFacts } from "../../../server/engagement/facts";
import type { RawBlockSum, RawQuestion, RawVisit } from "../../../server/engagement/queries";
import type { AccessEventRow, AccessRow, ApprovalRow, BrokerInputs, DashboardItem, DealInputs, DecisionRow, QuestionRow } from "../../../server/analytics-dashboard/load";

export const NOW = new Date("2026-10-09T16:00:00Z");
export const DAY = 86_400_000;
export const R = "a".repeat(32);
export const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

type Block = { key: string; kind: string; label: string; expectedMs: number; part: number };
const para: Block[] = [{ key: "para:0", kind: "text", label: "Paragraph 1", expectedMs: 30_000, part: 0 }];
export function page(id: string, order: number, title: string, layoutType = "prose_highlight", blocks: Block[] = para): RenditionPage {
  return {
    pageId: id, lineageId: id, order, parts: 1, servedTitle: title, layoutType, locked: false,
    expectedMs: blocks.reduce((s, b) => s + b.expectedMs, 0), blockFingerprint: `fp-${id}`, blocks: blocks as RenditionPage["blocks"],
  };
}

/** cover (front matter) · Executive Summary · Income Statement (table) · Customer Base · Transaction Overview */
export const PAGES: RenditionPage[] = [
  page("cover", 0, "Project Coastal", "cover_page", [{ key: "", kind: "page", label: "Cover", expectedMs: 2_000, part: 0 }]),
  page("exec", 1, "Executive Summary"),
  page("fin", 2, "Income Statement", "financial_table", [
    { key: "row:0", kind: "table", label: "Row: Revenue", expectedMs: 20_000, part: 0 },
    { key: "row:1", kind: "table", label: "Row: EBITDA", expectedMs: 20_000, part: 0 },
  ]),
  page("cust", 3, "Customer Base"),
  page("deal", 4, "Transaction Overview"),
];

export interface LinkSpec {
  id: string;
  name: string;
  level?: string;
  company?: string | null;
  email?: string;
  createdDaysAgo?: number;
  firstViewedDaysAgo?: number | null;
  ndaDaysAgo?: number | null;
  decision?: string;
  decisionDaysAgo?: number | null;
  nextStep?: string | null;
  reason?: string | null;
  revokedDaysAgo?: number | null;
  expiresInDays?: number | null;
  buyerType?: string | null;
  buyerUserId?: string | null;
  events?: AccessEventRow[];
  fit?: { matched: number; total: number } | null;
}

export interface VisitSpec {
  id: string;
  access: string;
  /** Start, days before NOW. */
  daysAgo: number;
  activeMs: number;
  /** Minutes from start to the last active second. */
  minutes?: number;
  device?: "desktop" | "tablet" | "phone";
  pages?: string[];
  legacy?: boolean;
  sample?: boolean;
}

export interface ReadingSpec {
  visit: string;
  page: string;
  ms: number;
  /** Part-by-part (a block key on the page); default: page totals only. */
  block?: string;
}

export interface DealSpec {
  id: string;
  name: string;
  brokerId?: string;
  live?: boolean;
  demo?: boolean;
  industry?: string;
  links: LinkSpec[];
  visits?: VisitSpec[];
  reading?: ReadingSpec[];
  questions?: Array<{ id: string; access: string | null; text: string; daysAgo: number; status: string; published?: boolean }>;
}

export function dealOf(spec: DealSpec): Deal {
  return {
    id: spec.id, businessName: spec.name, brokerId: spec.brokerId ?? "brokerA", isLive: spec.live ?? true,
    demoKey: spec.demo ? `demo-${spec.id}` : null, archivedAt: null, industry: spec.industry ?? "Logistics", buyerDeepCheck: null,
  } as unknown as Deal;
}

export function accessOf(dealId: string, l: LinkSpec): AccessRow {
  const d = (n: number | null | undefined) => (n == null ? null : ago(n));
  return {
    id: l.id,
    dealId,
    buyerName: l.name,
    buyerEmail: l.email ?? `${l.id}@buyer.invalid`,
    buyerCompany: l.company === undefined ? `${l.name} Co` : l.company,
    buyerUserId: l.buyerUserId ?? null,
    buyerType: l.buyerType ?? null,
    accessLevel: l.level ?? "loi",
    createdAt: ago(l.createdDaysAgo ?? 20),
    expiresAt: l.expiresInDays == null ? null : new Date(NOW.getTime() + l.expiresInDays * DAY),
    revokedAt: d(l.revokedDaysAgo),
    firstViewedAt: d(l.firstViewedDaysAgo),
    ndaSignedAt: d(l.ndaDaysAgo),
    decision: l.decision ?? "under_review",
    decisionAt: d(l.decisionDaysAgo),
    decisionNextStep: l.nextStep ?? null,
    decisionReason: l.reason ?? null,
    accessEvents: l.events ?? [],
  };
}

/** The schema-shaped buyer_access row the facts loader reads. */
function schemaRow(a: AccessRow, l: LinkSpec) {
  return {
    ...a,
    accessToken: `tok-${a.id}`,
    matchBreakdown: l.fit ? { criteriaMatched: l.fit.matched, criteriaTested: l.fit.total } : null,
  };
}

function visitRow(v: VisitSpec): RawVisit {
  const startedAt = ago(v.daysAgo);
  const lastSeenAt = new Date(startedAt.getTime() + (v.minutes ?? 30) * 60_000);
  const pages = v.pages ?? ["exec", "fin"];
  return {
    id: v.id, accessId: v.access, renditionId: v.legacy ? null : R, startedAt, lastSeenAt,
    wallMs: Math.max(v.activeMs, (v.minutes ?? 30) * 60_000), activeMs: v.activeMs, deviceClass: v.device ?? "desktop", uaFamily: "Chrome/Mac",
    maxPageIndex: Math.max(...pages.map((p) => PAGES.findIndex((x) => x.pageId === p))),
    path: pages.map((p, i) => [i * 60, p] as [number, string]), legacy: !!v.legacy, ipHash: null,
  };
}

/** Reading facts for a deal under a filter set (range filters visits by their last active second, like the SQL). */
export function factsOf(spec: DealSpec, filters: EngagementFilters = DEFAULT_ENGAGEMENT_FILTERS): CaptureFacts {
  const deal = dealOf(spec);
  const since = filterSince(filters, NOW);
  const listed = spec.links.filter((l) => filters.buyers.length === 0 || filters.buyers.includes(l.id));
  const accesses = listed.map((l) => schemaRow(accessOf(spec.id, l), l));
  const listedIds = new Set(listed.map((l) => l.id));
  const visitSpecs = (spec.visits ?? []).filter((v) => listedIds.has(v.access));
  const visits = visitSpecs.map(visitRow).filter((v) => !since || v.lastSeenAt >= since)
    .filter((v) => filters.device === "all" || (filters.device === "phone" ? v.deviceClass === "phone" && !v.legacy : v.deviceClass !== "phone"));
  const kept = new Set(visits.map((v) => v.id));
  const sums = new Map<string, RawBlockSum>();
  for (const r of spec.reading ?? []) {
    if (!kept.has(r.visit)) continue;
    const v = visits.find((x) => x.id === r.visit)!;
    const key = [v.accessId, r.page, r.block ?? ""].join("|");
    const s = sums.get(key) ?? {
      accessId: v.accessId, renditionId: v.renditionId, lineageId: r.page, pageId: r.page, blockKey: r.block ?? "",
      attentionMs: 0, skimMs: 0, visibleMs: 0, pointerMs: 0, firstAt: v.startedAt, lastAt: v.lastSeenAt,
    };
    s.attentionMs += r.ms;
    s.visibleMs = Math.max(s.visibleMs, r.ms);
    sums.set(key, s);
  }
  const questions: RawQuestion[] = (spec.questions ?? []).map((q) => ({
    id: q.id, accessId: q.access, text: q.text, askedAt: ago(q.daysAgo), pageId: null, status: q.status,
    answered: ["published", "answered", "approved"].includes(q.status) || !!q.published,
  }));
  const rendition = { id: R, mode: "normal", variant: "full", createdAt: ago(30), visits: visits.length };
  const facts = assembleFacts({
    deal: deal as any, filters, now: NOW, accesses: accesses as any, live: [], renditions: [rendition], chosen: rendition,
    indexes: new Map([[R, PAGES]]), visits, sums: Array.from(sums.values()), visitPages: [], events: [], questions, decisions: [],
  });
  // Example-deal sample reading (the heatmap stream's VisitFacts.sample).
  for (const b of facts.buyers) for (const v of b.visits) if (visitSpecs.find((s) => s.id === v.id)?.sample) (v as { sample?: boolean }).sample = true;
  return facts;
}

export interface Extra {
  questions?: QuestionRow[];
  approvals?: ApprovalRow[];
  decisions?: DecisionRow[];
  failed?: Array<{ dealId: string; dealName: string }>;
  examples?: BrokerInputs["examples"];
  /** Deals with no facts (no CIM link, or failed). */
  noFacts?: string[];
}

export function questionRow(dealId: string, q: { id: string; access: string | null; text: string; daysAgo: number; status: string; published?: boolean }): QuestionRow {
  return { id: q.id, dealId, accessId: q.access, text: q.text, askedAt: ago(q.daysAgo), status: q.status, publishedAnswer: !!q.published };
}

/** The Analytics page's inputs over these deals (the loader's shape). */
export function inputsOf(specs: DealSpec[], extra: Extra = {}): BrokerInputs {
  const deals = specs.map(dealOf);
  const items: DashboardItem[] = specs
    .filter((s) => !(extra.noFacts ?? []).includes(s.id))
    .filter((s) => s.links.some((l) => seesCim(l.level ?? "loi")))
    .map((s) => ({ deal: dealOf(s), facts: factsOf(s), demo: !!s.demo, live: s.live ?? true }));
  const pendingQuestions = specs.flatMap((s) => (s.questions ?? [])
    .filter((q) => ["pending_ai", "pending_broker", "pending_seller"].includes(q.status))
    .map((q) => questionRow(s.id, q)));
  return {
    deals,
    items,
    access: specs.flatMap((s) => s.links.map((l) => accessOf(s.id, l))),
    questions: extra.questions ?? pendingQuestions,
    approvals: extra.approvals ?? [],
    decisions: extra.decisions ?? [],
    failed: extra.failed ?? [],
    examples: extra.examples ?? { included: true, canToggle: false, count: specs.filter((s) => s.demo).length },
    ownDeals: specs.length,
  };
}

/** The deal tab's inputs (KPI facts all time with the Buyers filters; group facts with the When filter too). */
export function dealInputsOf(spec: DealSpec, filters: EngagementFilters = DEFAULT_ENGAGEMENT_FILTERS, extra: Extra = {}): DealInputs {
  const base = inputsOf([spec], extra);
  const kf = { ...filters, range: "all" as const, device: "all" as const, rendition: null };
  const gf = { ...filters, device: "all" as const, rendition: null };
  const facts = factsOf(spec, kf);
  return {
    ...base,
    items: [{ deal: dealOf(spec), facts, demo: !!spec.demo, live: spec.live ?? true }],
    groupFacts: factsOf(spec, gf),
    filters,
  };
}
