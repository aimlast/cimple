/**
 * analytics-dashboard — the shared contract of the broker's analytics
 * dashboards: the sidebar Analytics page (/broker/analytics) and the deal
 * Engagement tab's shell, KPI strip and Buyer pulse.
 *
 * One definition per number, in one place: the words (KPI_COPY) and the
 * small shared rules live here; the counting lives in
 * server/analytics-dashboard/* (pure functions over the reading facts and
 * the access / question / approval rows). The global page and the deal tab
 * call the SAME functions, so a deal's numbers are equal on both.
 *
 * Rules every screen follows:
 *   - reading time is a visit's ACTIVE time (idle, hidden tabs and the
 *     broker's own previews never count);
 *   - a "reader" has at least one visit with ≥ 3 s of active reading
 *     (hasReadCim — the one reader rule, INTEGRATION §2.9 / C11);
 *   - CIM numbers count CIM links only (seesCim): a teaser-only link is
 *     never "opened the CIM", never a reader, never "haven't opened";
 *   - never a bare 0 when older activity exists: a period number at 0 says
 *     when it last happened ("last on 23 Sept").
 *
 * Words the broker sees: plain language. Never "engagement score".
 */
import {
  READING_RULES,
  type BuyerStatus,
  type CallListEntry,
  type EngagementFilters,
  type KindAttention,
  type LayoutAttention,
  type PageRef,
  type PageRole,
  type RenditionSummary,
} from "./analytics-v2";

const DAY = 86_400_000;
const TZ = "America/Toronto";

// ── Periods ───────────────────────────────────────────────────────────────

export type DashboardRange = "7d" | "30d" | "all";
export type RangeRequest = DashboardRange | "auto";
export const DASHBOARD_RANGES: readonly DashboardRange[] = ["7d", "30d", "all"];

/** A query value → a range request ("auto" for anything absent or unknown). */
export function parseRangeRequest(v: unknown): RangeRequest {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "7d" || s === "30d" || s === "all" ? s : "auto";
}

/**
 * The period to show. An explicit choice is always honoured. "auto" is the
 * last 30 days when something happened in them, else all time (so a page
 * whose recent weeks are quiet never opens on a row of zeros).
 */
export function resolveRange(req: RangeRequest, lastActivityAt: Date | string | null, now: Date): { range: DashboardRange; auto: boolean } {
  if (req !== "auto") return { range: req, auto: false };
  const last = lastActivityAt ? new Date(lastActivityAt).getTime() : NaN;
  const recent = Number.isFinite(last) && now.getTime() - last <= 30 * DAY;
  return { range: recent ? "30d" : "all", auto: true };
}

/** [since, now) and the window before it, [prevSince, since). All time → nulls. */
export function rangeWindow(range: DashboardRange, now: Date): { since: Date | null; prevSince: Date | null } {
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 0;
  if (!days) return { since: null, prevSince: null };
  return { since: new Date(now.getTime() - days * DAY), prevSince: new Date(now.getTime() - 2 * days * DAY) };
}

/** Inside a sentence: "in the last 7 days" | "in the last 30 days" | "so far". */
export function rangeWords(range: DashboardRange): string {
  return range === "7d" ? "in the last 7 days" : range === "30d" ? "in the last 30 days" : "so far";
}

/** The control's words: "Last 7 days" | "Last 30 days" | "All time" (short: "7 days" | "30 days" | "All"). */
export function rangeLabel(range: DashboardRange, short = false): string {
  if (range === "7d") return short ? "7 days" : "Last 7 days";
  if (range === "30d") return short ? "30 days" : "Last 30 days";
  return short ? "All" : "All time";
}

/** "the 30 days before" — for deltas. */
export function previousWindowWords(range: DashboardRange): string {
  return range === "7d" ? "the 7 days before" : "the 30 days before";
}

// ── Example deals ─────────────────────────────────────────────────────────

export type ExamplesMode = "include" | "exclude";

export function parseExamplesMode(v: unknown): ExamplesMode | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s === "include" || s === "exclude" ? s : null;
}

/**
 * Whether the made-up showcase deals (deals.demo_key) count in the totals:
 * an explicit choice wins; otherwise they're included until the broker has
 * a live deal of their own.
 */
export function resolveExamples(mode: ExamplesMode | null, hasLiveRealDeal: boolean): boolean {
  if (mode === "include") return true;
  if (mode === "exclude") return false;
  return !hasLiveRealDeal;
}

// ── Small shared rules ────────────────────────────────────────────────────

/**
 * Who a buyer question is waiting on (statuses per shared/schema.ts
 * buyerQuestions.status). Only "broker" counts in "Waiting on you";
 * "seller" is shown apart and never counted; "declined" never waits.
 */
export function questionWaitingOn(status: string, hasPublishedAnswer: boolean): "broker" | "seller" | "declined" | "answered" {
  if (status === "declined") return "declined";
  if (hasPublishedAnswer) return "answered";
  if (status === "pending_ai" || status === "pending_broker") return "broker";
  if (status === "pending_seller") return "seller";
  return "answered";
}

/** The Buyers tab's number chip: exactly the set a KPI counted (ids null → rows unchanged). */
export function applyKpiFilter<T extends { accessId: string }>(rows: T[], ids: string[] | null): T[] {
  if (!ids) return rows;
  const set = new Set(ids);
  return rows.filter((r) => set.has(r.accessId));
}

/** "23 Sept" (Toronto calendar day, like the rest of the broker's dates). */
export function dayMonth(at: Date | string | number | null | undefined): string {
  if (at == null || at === "") return "";
  const t = typeof at === "number" ? at : new Date(at).getTime();
  if (!Number.isFinite(t)) return "";
  return new Intl.DateTimeFormat("en-GB", { timeZone: TZ, day: "numeric", month: "short" }).format(t);
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * Example-deal sample reading (the heatmap stream marks those visits
 * `VisitFacts.sample`). Read through this one helper so the code compiles
 * before and after that field exists.
 */
export function isSampleVisit(v: unknown): boolean {
  return !!v && (v as { sample?: unknown }).sample === true;
}

/** THE reader rule: at least one visit with ≥ 3 s of active reading. */
export function hasReadCim(b: { visits: ReadonlyArray<{ activeMs: number }> }): boolean {
  return b.visits.some((v) => v.activeMs >= READING_RULES.readerMinMs);
}

/** "Opened": at least one tracked visit, or a stamped first view (a blocked tracker). */
export function openedCim(b: { visits: ReadonlyArray<unknown>; firstViewedAt: string | null }): boolean {
  return b.visits.length > 0 || !!b.firstViewedAt;
}

/** When the link was first opened: the earliest visit, else the stamped first view. */
export function firstOpenAt(b: { visits: ReadonlyArray<{ startedAt: string }>; firstViewedAt: string | null }): string | null {
  const first = b.visits.map((v) => v.startedAt).sort()[0];
  return first ?? b.firstViewedAt ?? null;
}

// ── KPIs ──────────────────────────────────────────────────────────────────

export type AnalyticsTab = "call" | "deals" | "buyers" | "activity" | "attention";
export const ANALYTICS_TABS: readonly AnalyticsTab[] = ["call", "deals", "buyers", "activity", "attention"];
export type KpiId = "opened" | "reading" | "nda" | "interested" | "to_call" | "waiting";
export type KpiBlock = "now" | "period";
/** The buyer numbers (each carries the exact access-id set it counted). */
export const BUYER_KPI_IDS: readonly KpiId[] = ["opened", "reading", "nda", "interested", "to_call"];

export interface KpiWho {
  kind: "buyer" | "question" | "cim_request" | "approval";
  accessId: string | null;
  dealId: string;
  dealName: string;
  name: string;
  company: string | null;
  /** ISO */
  at: string | null;
  /** "2 h 12 min reading", the question text … */
  note: string | null;
  /** Where the row links (a broker app route). */
  href: string;
  /** From example-deal sample reading. */
  sample?: boolean;
}

export interface Kpi {
  id: KpiId;
  block: KpiBlock;
  label: string;
  shortLabel: string;
  value: number;
  /** "13 of 13", "9" */
  display: string;
  /** The previous window's value (7d/30d), else null. */
  previous: number | null;
  /** The last event of this kind before the window (drives "last on"). */
  lastAt: string | null;
  sub: string | null;
  explain: string;
  rangeBound: boolean;
  /** ≤ 20 listed. */
  who: KpiWho[];
  whoMore: number;
  /** The exact access-id set (buyer numbers); null for "waiting". */
  ids: string[] | null;
  /** "waiting": questions / CIM requests / approvals. */
  breakdown: Array<{ label: string; count: number }> | null;
  /** "waiting": answers waiting for the seller's OK (shown, not counted). */
  sellerPending: number | null;
  link: { tab: AnalyticsTab | "buyers_view" | "qa" | "approval"; query?: Record<string, string> } | null;
}

/** The "who" list is capped at this many rows (the rest is "and N more"). */
export const KPI_WHO_MAX = 20;

/** The words of every number, defined once. */
export const KPI_COPY: Record<KpiId, {
  label: (r: DashboardRange) => string;
  shortLabel: string;
  explain: (r: DashboardRange, scope: "broker" | "deal") => string;
}> = {
  to_call: {
    label: () => "Worth a call",
    shortLabel: "Worth a call",
    explain: () =>
      "Buyers who read the CIM and haven't said no, best lead first. Cimple weighs how closely they read, how well they fit, how recently they were active, and whether you've called in the last 2 days. Buyers who said no, didn't respond in time, or whose link you removed are left out. The date range doesn't change this number.",
  },
  waiting: {
    label: () => "Waiting on you",
    shortLabel: "Waiting on you",
    explain: () =>
      "Things only you can move: questions buyers asked that nobody has answered yet, buyers who asked for the CIM from the teaser, and buyers waiting for your approval. The date range doesn't change this number.",
  },
  opened: {
    label: () => "Opened the CIM",
    shortLabel: "Opened",
    explain: (r) =>
      r === "all"
        ? "Buyers who opened their link at least once, out of everyone you've given the CIM, including links you later removed."
        : `Buyers who opened the CIM for the first time ${rangeWords(r)}.`,
  },
  reading: {
    label: () => "Buyers who read",
    shortLabel: "Read",
    explain: (r, scope) =>
      `Buyers who read ${scope === "broker" ? "one of your CIMs" : "the CIM"} ${rangeWords(r)}: at least one visit with 3 seconds or more of active reading. Idle time, hidden tabs and your own previews don't count.${scope === "broker" ? " A buyer with links to two deals counts once for each." : ""}`,
  },
  nda: {
    label: () => "NDAs signed",
    shortLabel: "NDAs",
    explain: (r) => `Buyers who signed the NDA ${rangeWords(r)}, including buyers who signed it to ask for the CIM from the teaser.`,
  },
  interested: {
    label: () => "Said interested",
    shortLabel: "Interested",
    explain: (r) =>
      `Buyers who chose 'Interested' in the view room ${rangeWords(r)}, and haven't changed their answer since. 'In due diligence' counts buyers you've given due-diligence access (all time).`,
  },
};

/** Deltas against the previous window: "3 more than the 30 days before" / "2 fewer than…" / "Same as…". */
export function deltaWords(value: number, previous: number | null, range: DashboardRange): string | null {
  if (range === "all" || previous == null || (value === 0 && previous === 0)) return null;
  const before = previousWindowWords(range);
  if (value === previous) return `Same as ${before}`;
  const d = Math.abs(value - previous);
  return value > previous ? `${d} more than ${before}` : `${d} fewer than ${before}`;
}

// ── Reading now ───────────────────────────────────────────────────────────

export interface ReadingNowRow {
  accessId: string;
  dealId: string;
  dealName: string;
  name: string;
  company: string | null;
  document: "cim" | "teaser";
  since: string;
  /** Filled only by the deal KPI response (from the facts). */
  page: { label: string; title: string } | null;
}
export interface ReadingNowResponse { rows: ReadingNowRow[] }

export interface HeadsUp { id: string; count: number; text: string; names: string[]; link: string }
export interface PartialLoad { failedDeals: Array<{ dealId: string; dealName: string }> }

/** The two heads-up lines the page shows at most. */
export const HEADS_UP_MAX = 2;

// ── Responses: the Analytics page ─────────────────────────────────────────

export interface AnalyticsOverviewResponse {
  range: DashboardRange;
  rangeAuto: boolean;
  now: string;
  examples: { included: boolean; canToggle: boolean; count: number };
  kpis: Kpi[];
  headsUp: HeadsUp[];
  counts: {
    /** The broker's non-archived deals (before the example-deals rule). */
    deals: number;
    /** Deals with at least one buyer link (after the rule). */
    dealsWithBuyers: number;
    /** Buyer links (CIM and teaser) on those deals. */
    buyers: number;
    call: number;
    /** CIM links never opened (not removed). */
    notOpened: number;
    teaserOnly: number;
  };
  lastActivity: { at: string; text: string; dealId: string } | null;
  demoDealIds: string[];
  partial: PartialLoad | null;
}

export interface DealDashboardRow {
  dealId: string;
  dealName: string;
  live: boolean;
  demo: boolean;
  granted: number;
  opened: number;
  readingInRange: number;
  medianReadingMs: number | null;
  medianPagesReached: number | null;
  contentPages: number;
  ndaSigned: number;
  interested: number;
  waiting: number;
  teaser: { sent: number; asked: number } | null;
  lastActivityAt: string | null;
  partByPart: boolean;
}
export interface AnalyticsDealsResponse {
  range: DashboardRange;
  rangeAuto: boolean;
  rows: DealDashboardRow[];
  withoutBuyers: Array<{ dealId: string; dealName: string; live: boolean; demo: boolean }>;
  partial: PartialLoad | null;
}

export interface BuyerDashboardRow {
  accessId: string;
  dealId: string;
  dealName: string;
  demo: boolean;
  live: boolean;
  document: "cim" | "teaser";
  buyerUserId: string | null;
  name: string;
  company: string | null;
  email: string;
  buyerType: string | null;
  accessLevel: string;
  accessLabel: string;
  status: BuyerStatus | "teaser" | "teaser_asked";
  statusLabel: string;
  readingMs: number | null;
  visits: number | null;
  pagesRead: number | null;
  contentPages: number | null;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  grantedAt: string;
  ndaSignedAt: string | null;
  decision: string;
  decisionAt: string | null;
  questions: number;
  questionsWaiting: number;
  contactedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  fit: { matched: number; total: number } | null;
  /** "4 of 6 criteria" */
  fitText: string | null;
}
export interface AnalyticsBuyersResponse { rows: BuyerDashboardRow[]; partial: PartialLoad | null }

/** The Buyers tab's status filter. */
export type BuyerStatusFilter =
  | "all" | "interested" | "deciding" | "not_opened" | "declined" | "expiring" | "teaser" | "teaser_asked" | "revoked";

export const BUYER_STATUS_FILTERS: ReadonlyArray<{ key: BuyerStatusFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "interested", label: "Interested" },
  { key: "deciding", label: "Still deciding" },
  { key: "not_opened", label: "Haven't opened" },
  { key: "declined", label: "Said no or didn't respond" },
  { key: "expiring", label: "Link runs out soon" },
  { key: "teaser", label: "Teaser only" },
  { key: "teaser_asked", label: "Asked for the CIM" },
  { key: "revoked", label: "Link removed" },
];

export function parseBuyerStatusFilter(v: unknown): BuyerStatusFilter {
  const s = Array.isArray(v) ? v[0] : v;
  return BUYER_STATUS_FILTERS.some((f) => f.key === s) ? (s as BuyerStatusFilter) : "all";
}

const FINAL_DECISIONS = new Set(["interested", "not_interested", "lapsed"]);

/** Whether a Buyers-tab row matches a status filter (the same rule on the client and in tests). */
export function matchesBuyerStatus(row: BuyerDashboardRow, filter: BuyerStatusFilter, now: Date): boolean {
  switch (filter) {
    case "all": return true;
    case "interested": return row.decision === "interested";
    // (firstSeenAt = the earliest visit, else the stamped first view.)
    case "deciding":
      return row.document === "cim" && !!row.firstSeenAt
        && (!row.decision || row.decision === "under_review" || row.decision === "need_more_time");
    case "not_opened": return row.document === "cim" && !row.firstSeenAt;
    case "declined": return row.decision === "not_interested" || row.decision === "lapsed";
    case "expiring": {
      if (row.revokedAt || !row.expiresAt || FINAL_DECISIONS.has(row.decision)) return false;
      const t = Date.parse(row.expiresAt);
      return t > now.getTime() && t - now.getTime() <= 7 * DAY;
    }
    case "teaser": return row.document !== "cim";
    case "teaser_asked": return row.status === "teaser_asked";
    case "revoked": return !!row.revokedAt;
  }
}

// ── Activity ──────────────────────────────────────────────────────────────

export type ActivityKind =
  | "opened" | "returned" | "teaser_opened" | "nda_signed" | "cim_requested" | "interested" | "not_interested"
  | "more_time" | "lapsed" | "question" | "granted" | "level_changed" | "extended" | "contacted" | "revoked" | "link_expired" | "data_room";
export type ActivityGroup = "reading" | "nda" | "decision" | "question" | "broker" | "data_room";

export const ACTIVITY_GROUP_OF: Record<ActivityKind, ActivityGroup> = {
  opened: "reading", returned: "reading", teaser_opened: "reading",
  nda_signed: "nda",
  cim_requested: "decision", interested: "decision", not_interested: "decision", more_time: "decision", lapsed: "decision",
  question: "question",
  granted: "broker", level_changed: "broker", extended: "broker", contacted: "broker", revoked: "broker", link_expired: "broker",
  data_room: "data_room",
};

/** The kind chips: All · Reading · NDAs · Decisions & requests · Questions · Your actions (+ Data room when a source is registered). */
export type ActivityKindFilter = ActivityGroup | "all";
export const ACTIVITY_KIND_FILTERS: ReadonlyArray<{ key: ActivityKindFilter; label: string }> = [
  { key: "all", label: "All" },
  { key: "reading", label: "Reading" },
  { key: "nda", label: "NDAs" },
  { key: "decision", label: "Decisions & requests" },
  { key: "question", label: "Questions" },
  { key: "broker", label: "Your actions" },
  { key: "data_room", label: "Data room" },
];

export function parseActivityKind(v: unknown): ActivityKindFilter {
  const s = Array.isArray(v) ? v[0] : v;
  return ACTIVITY_KIND_FILTERS.some((k) => k.key === s) ? (s as ActivityKindFilter) : "all";
}

export interface ActivityItem {
  id: string;
  at: string;
  kind: ActivityKind;
  group: ActivityGroup;
  dealId: string;
  dealName: string;
  accessId: string | null;
  name: string | null;
  company: string | null;
  title: string;
  detail: string | null;
  tone: "positive" | "negative" | "neutral";
  link: { href: string; label: string } | null;
  sample?: boolean;
}
export interface ActivityResponse {
  items: ActivityItem[];
  next: string | null;
  total: number;
  lastActivity: { at: string; text: string } | null;
  partial: PartialLoad | null;
}

export const ACTIVITY_PAGE_DEFAULT = 50;
export const ACTIVITY_PAGE_MAX = 100;

// ── Attention ("What buyers read most") ───────────────────────────────────

export interface RoleAttention { role: PageRole; label: string; attentionMs: number; expectedMs: number; readers: number; pages: number }
export interface AttentionResponse {
  partByPart: boolean;
  byRole: RoleAttention[];
  byKind: KindAttention[];
  byLayout: LayoutAttention[];
  benchmarks: Array<{ role: PageRole; industry: string; medianStudyRatio: number; deals: number }>;
  basis: { buyers: number; deals: number; attentionMs: number };
}

// ── The deal Engagement tab and the pulse ─────────────────────────────────

export interface GroupRow {
  accessId: string;
  name: string;
  company: string | null;
  accessLevel: string;
  grantedAt: string;
  ndaSigned: boolean;
  /** All time. */
  lastSeenAt: string | null;
  hasCard: boolean;
}
export interface BuyerGroups {
  worthACall: GroupRow[];
  reading: GroupRow[];
  quietInRange: GroupRow[];
  declined: GroupRow[];
  revoked: GroupRow[];
  notOpened: GroupRow[];
}
export interface DealKpisResponse {
  published: boolean;
  /** Scope "deal" (§6.1). */
  kpis: Kpi[];
  /** First 3 of the call order (the pulse's rows). */
  callTop: CallListEntry[];
  /** The Buyers view's list. */
  groups: BuyerGroups;
  /** With page refs (from the facts). */
  readingNow: ReadingNowRow[];
  readersAll: number;
  readersWeek: number;
  lastReadAt: string | null;
  grantedCim: number;
  mostStudiedPage: (PageRef & { attentionMs: number }) | null;
  /** The filter bar's version list. */
  renditions: RenditionSummary[];
  legacyOnly: boolean;
  /** Example-deal sample reading is shown (INTEGRATION C9: the shell's "Sample reading" chip and the pulse). */
  sampleReading: boolean;
  /** "Last 7 days · Interested buyers" */
  forText: string | null;
}
export interface PageTitlesResponse { pages: Array<{ key: string; label: string; title: string; blindTitle: string | null }> }

const BUYER_TYPE_WORDS: Record<string, string> = {
  individual: "Individual", strategic: "Strategic", financial: "Financial", search_fund: "Search fund",
  family_office: "Family office", private_equity: "Private equity",
};

/** "All buyers" | "Interested buyers" | "Buyers still deciding" | "Strategic buyers" | "One buyer" | "3 buyers". */
export function buyersFilterWords(f: Pick<EngagementFilters, "buyers" | "segment">): string {
  if (f.buyers.length === 1) return "One buyer";
  if (f.buyers.length > 1) return `${f.buyers.length} buyers`;
  if (f.segment === "interested") return "Interested buyers";
  if (f.segment === "undecided") return "Buyers still deciding";
  if (f.segment.startsWith("type:")) {
    const t = f.segment.slice(5);
    return `${BUYER_TYPE_WORDS[t] ?? t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())} buyers`;
  }
  return "All buyers";
}

/** The deal strip's period header: "All time · All buyers", "Last 7 days · Interested buyers". */
export function forTextOf(f: Pick<EngagementFilters, "range" | "buyers" | "segment">): string {
  return `${rangeLabel(f.range)} · ${buyersFilterWords(f)}`;
}
