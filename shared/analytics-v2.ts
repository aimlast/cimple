/**
 * analytics-v2 — the shared contract of the buyer-engagement rebuild
 * ("reading time on the real CIM", replacing the cursor-sample heat map).
 *
 * Everything the three build streams exchange is typed here, so they can be
 * built in parallel:
 *
 *   capture       the view room measures reading time per page part and
 *                 sends it (ReadingPayload → POST /api/view/:token/reading);
 *                 the server stores visits + rollups and answers the broker
 *                 APIs below from them (DealReadingFacts is its hand-off).
 *   viewer        the broker's Engagement tab: the document heat map on the
 *                 real rendered CIM, filters, journeys; global Analytics page.
 *   intelligence  statuses, signals, talking points, call priority,
 *                 headlines, benchmarks and the optional AI brief — pure
 *                 functions over DealReadingFacts (server/engagement/insights.ts).
 *
 * Words the broker sees: "reading time", seconds and minutes. Never
 * "dwell", "engagement score", "heat samples" or percent-of-max.
 *
 * Privacy: a broker only ever sees their own deals. Blind buyers send only
 * section UUIDs (already served to them) and structural block keys
 * (shared/cim-blocks.ts) — nothing identifying; labels and real titles
 * exist only in broker responses. Buyers never receive analytics.
 */
import { z } from "zod";
import type { BlockKind, KindGroup } from "./cim-blocks";
import { isValidBlockKey } from "./cim-blocks";

export type { BlockKind, KindGroup } from "./cim-blocks";

// ── DOM identity ─────────────────────────────────────────────────────────

/** On every measured part of a page: the block key (shared/cim-blocks.ts). */
export const CIM_BLOCK_ATTR = "data-cim-block";
/** On every page: the section UUID, or "cim-disclaimer" / "cim-contact". */
export const CIM_PAGE_ATTR = "data-cim-page";
/** On sticky view-room chrome (header, section strip): the reading band starts below it. */
export const READING_CHROME_ATTR = "data-reading-chrome";

// ── Timing rules (one definition, used by capture, aggregation and UI) ───

export const READING_RULES = {
  /** A visit whose last ACTIVE reading is this recent is "Reading now" (buyer_visits.last_seen_at = last active). */
  readingNowMs: 90_000,
  /** A gap this long starts a new visit (and counts a new view). */
  visitGapMs: 30 * 60_000,
  /** A visit stops accruing reading after this much ACTIVE time. */
  visitMaxMs: 6 * 3_600_000,
  /** Server clamp slack over its own elapsed time. */
  clampSlackMs: 20_000,
  /**
   * The most active time a visit's FIRST send may claim (the server hasn't
   * seen it start): the tracker sends after 15 s, so this covers a few
   * failed retries. Later sends may grow by the time since the last one.
   */
  firstSendMaxActiveMs: 180_000,
  /** A buyer "read" a page with at least this much attention on it. */
  readerMinMs: 3_000,
  /** Blocks under this are "Nobody read this". */
  unreadBlockMs: 1_000,
  /** Payload limits per request. */
  maxBlockRows: 400,
  maxEvents: 100,
  maxPathEntries: 2_000,
  maxBodyBytes: 64 * 1024,
  /** Client flush cadence while active. */
  flushEveryMs: 15_000,
  /** A came-back visit this long after the previous one is a "return". */
  returnGapMs: 20 * 3_600_000,
  /** Engagement cache lifetime on the server. */
  cacheMs: 30_000,
} as const;

// ── Discrete interactions ────────────────────────────────────────────────

export const READING_INTERACTIONS = [
  "expand", "collapse",
  "financial_view",   // detail: "reported" | "normalized"
  "nav",              // detail: "toc" | "sticky" | "related"; targetPageId in detail after ":" ("toc:<pageId>")
  "locked_click",
  "media_play", "media_progress", // detail: seconds watched (progress)
  "gallery_open", "map_interact",
  "contact_click",    // detail: "email" | "phone" | "website"
  "copy", "print_attempt", "download_attempt",
  "chat_open",
] as const;
export type ReadingInteractionType = (typeof READING_INTERACTIONS)[number];

export interface ReadingInteraction {
  /** Per-visit sequence number (idempotency: (visitId, seq) is unique). */
  seq: number;
  type: ReadingInteractionType;
  pageId: string;
  blockKey?: string;
  /** Short structural detail — never CIM text (≤ 80 chars). */
  detail?: string;
  /** Client time (ISO). */
  at: string;
}

// ── Ingest payload (view room → POST /api/view/:token/reading) ───────────

/** [attentionMs, skimMs, visibleMs, pointerMs] — cumulative for the visit. */
export type BlockCounters = [number, number, number, number];

export type DeviceClass = "desktop" | "tablet" | "phone";

export interface ReadingPayload {
  /** crypto.randomUUID() per visit; resumed from sessionStorage within 30 min. */
  visitId: string;
  /** The opaque id GET /api/view/:token returned with the content. */
  renditionId: string;
  sentAt: string;
  device: { w: number; h: number; touch: boolean; dpr: number };
  /** Cumulative visit clocks (ms). */
  visit: {
    wallMs: number; activeMs: number; idleMs: number; hiddenMs: number; awayMs: number; outsideMs: number;
    /** Index (in the rendition's page order) of the furthest page reached. */
    maxPageIndex: number;
  };
  /** Only blocks changed since the last acknowledged send, with FULL cumulative values. Key: "<pageId>|<blockKey>". */
  blocks: Record<string, BlockCounters>;
  /** Path appended by absolute index: entries[k] is path[from + k]. [secondsSinceVisitStart, pageId]. */
  path: { from: number; entries: Array<[number, string]> };
  events: ReadingInteraction[];
}

const nonNegInt = z.number().int().min(0).max(1e9);
const idLike = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);

export const readingPayloadSchema = z.object({
  visitId: z.string().uuid(),
  renditionId: z.string().regex(/^[0-9a-f]{32}$/),
  sentAt: z.string().max(40),
  device: z.object({
    w: nonNegInt.max(20000), h: nonNegInt.max(20000), touch: z.boolean(), dpr: z.number().min(0).max(10),
  }),
  visit: z.object({
    wallMs: nonNegInt, activeMs: nonNegInt, idleMs: nonNegInt, hiddenMs: nonNegInt, awayMs: nonNegInt, outsideMs: nonNegInt,
    maxPageIndex: z.number().int().min(-1).max(10000),
  }),
  blocks: z.record(
    z.string().max(120).refine((k) => {
      const i = k.indexOf("|");
      return i > 0 && idLike.safeParse(k.slice(0, i)).success && isValidBlockKey(k.slice(i + 1));
    }, "bad block id"),
    z.tuple([nonNegInt, nonNegInt, nonNegInt, nonNegInt]),
  ).refine((r) => Object.keys(r).length <= READING_RULES.maxBlockRows, "too many blocks"),
  path: z.object({
    from: z.number().int().min(0).max(READING_RULES.maxPathEntries),
    entries: z.array(z.tuple([z.number().int().min(0).max(1e6), idLike])).max(READING_RULES.maxPathEntries),
  }),
  events: z.array(z.object({
    seq: z.number().int().min(0).max(1e6),
    type: z.enum(READING_INTERACTIONS),
    pageId: idLike,
    blockKey: z.string().max(40).refine(isValidBlockKey).optional(),
    detail: z.string().max(80).optional(),
    at: z.string().max(40),
  })).max(READING_RULES.maxEvents),
});

/** "<pageId>|<blockKey>" → [pageId, blockKey]. */
export function splitBlockId(id: string): [string, string] {
  const i = id.indexOf("|");
  return i === -1 ? [id, ""] : [id.slice(0, i), id.slice(i + 1)];
}
export function blockId(pageId: string, blockKey: string): string {
  return `${pageId}|${blockKey}`;
}

/** Device class from the viewport the client reported. */
export function deviceClassOf(device: { w: number; touch: boolean }): DeviceClass {
  if (device.touch && device.w < 768) return "phone";
  if (device.touch && device.w < 1280) return "tablet";
  return "desktop";
}

/**
 * Added to GET /api/view/:token on the content-serving branch ONLY (never
 * with the NDA gate or the preparing state) as `reading`. Opaque to the
 * buyer: an id that encodes nothing, and page ids they were already served.
 * The tracker starts only when this is present.
 */
export interface ViewRoomReading {
  renditionId: string;
  /** Page ids in document order (sections + "cim-disclaimer"/"cim-contact"), for maxPageIndex. */
  pageOrder: string[];
}

// ── Renditions (exactly what a buyer was served) ─────────────────────────

export type CimMode = "blind" | "normal" | "dd";
export type CimVariant = "teaser" | "full";

export interface RenditionBlock {
  key: string;
  kind: BlockKind;
  /** Label computed from the SERVED section (blind-safe for blind renditions). */
  label: string;
  expectedMs: number;
  part: number;
  virtual?: true;
  when?: "normalized" | "collapsed";
}

/** One page (a section, or the disclaimer/contact page) of a rendition. */
export interface RenditionPage {
  /** Section UUID, or "cim-disclaimer" / "cim-contact". */
  pageId: string;
  /** Stable across regenerations (cim_sections.analytics_lineage ?? id). */
  lineageId: string;
  /** Position in the served document (0-based). */
  order: number;
  /** Printed parts ("7a", "7b"): 1 for most pages. */
  parts: number;
  /** The title as the buyer saw it (redacted in blind renditions). */
  servedTitle: string;
  layoutType: string;
  locked: boolean;
  expectedMs: number;
  /** blockFingerprint(layoutType, default-view blocks). */
  blockFingerprint: string;
  blocks: RenditionBlock[];
}

export interface RenditionSummary {
  id: string;
  mode: CimMode;
  variant: CimVariant;
  createdAt: string;
  /** "Blind · published 12 Sep". */
  label: string;
  visitCount: number;
}

// ── Viewer pages ("page 7a") ─────────────────────────────────────────────

/** A printed page the broker pages through: one section part. */
export interface ViewerPageRef {
  pageId: string;
  part: number;
  /** 0-based position among all viewer pages. */
  index: number;
  /** "7", or "7a" / "7b" for a split section. */
  label: string;
}

/** Stable key of a viewer page: "<pageId>#<part>". */
export function viewerPageKey(pageId: string, part: number): string {
  return `${pageId}#${part}`;
}

/** Viewer pages of a rendition, in order, with their printed labels. */
export function viewerPagesOf(pages: ReadonlyArray<Pick<RenditionPage, "pageId" | "parts" | "order">>): ViewerPageRef[] {
  const out: ViewerPageRef[] = [];
  [...pages].sort((a, b) => a.order - b.order).forEach((p, n) => {
    for (let part = 0; part < Math.max(1, p.parts); part++) {
      out.push({
        pageId: p.pageId,
        part,
        index: out.length,
        label: p.parts > 1 ? `${n + 1}${String.fromCharCode(97 + Math.min(part, 25))}` : `${n + 1}`,
      });
    }
  });
  return out;
}

// ── Page roles (what a page is about; deterministic, broker side) ────────

export const PAGE_ROLES = [
  "front_matter", "overview", "financials", "normalization", "customers", "revenue_mix", "operations",
  "employees", "owner_transition", "location", "growth", "market", "transaction", "other",
] as const;
export type PageRole = (typeof PAGE_ROLES)[number];

// ── Filters (query string of every deal engagement GET) ──────────────────

export type EngagementRange = "all" | "7d" | "30d";
export type EngagementDevice = "all" | "desktop" | "phone";
/** "all" | "interested" | "undecided" | "type:<buyerType>" */
export type BuyerSegment = "all" | "interested" | "undecided" | `type:${string}`;

export interface EngagementFilters {
  range: EngagementRange;
  device: EngagementDevice;
  /** buyer_access ids; empty = every buyer. */
  buyers: string[];
  segment: BuyerSegment;
  /** A rendition id, or null = the most recent rendition with reading for this filter. */
  rendition: string | null;
}

export const DEFAULT_ENGAGEMENT_FILTERS: EngagementFilters = { range: "all", device: "all", buyers: [], segment: "all", rendition: null };

/** Lenient parse of a query object (unknown values fall back to the defaults). */
export function parseEngagementFilters(q: Record<string, unknown>): EngagementFilters {
  const s = (v: unknown) => (typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : "");
  const range = s(q.range);
  const device = s(q.device);
  const segment = s(q.segment);
  const rendition = s(q.rendition);
  const buyers = s(q.buyers).split(",").map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_-]{1,64}$/.test(x)).slice(0, 200);
  return {
    range: range === "7d" || range === "30d" ? range : "all",
    device: device === "desktop" || device === "phone" ? device : "all",
    buyers,
    segment: segment === "interested" || segment === "undecided" || /^type:[a-z_]{1,40}$/.test(segment) ? (segment as BuyerSegment) : "all",
    rendition: /^[0-9a-f]{32}$/.test(rendition) ? rendition : null,
  };
}

/** Query string for a filter set (defaults omitted). */
export function engagementFiltersQuery(f: Partial<EngagementFilters>): string {
  const p = new URLSearchParams();
  if (f.range && f.range !== "all") p.set("range", f.range);
  if (f.device && f.device !== "all") p.set("device", f.device);
  if (f.buyers && f.buyers.length) p.set("buyers", f.buyers.join(","));
  if (f.segment && f.segment !== "all") p.set("segment", f.segment);
  if (f.rendition) p.set("rendition", f.rendition);
  const q = p.toString();
  return q ? `?${q}` : "";
}

/** The earliest time a filter includes (null = all time). */
export function filterSince(f: Pick<EngagementFilters, "range">, now: Date = new Date()): Date | null {
  if (f.range === "7d") return new Date(now.getTime() - 7 * 86_400_000);
  if (f.range === "30d") return new Date(now.getTime() - 30 * 86_400_000);
  return null;
}

// ── Labels, statuses, signals ────────────────────────────────────────────

/** How one buyer (or the median buyer) read a page, against its expected time. */
/** "opened" is for front matter (cover, disclaimer, contact): opened, never judged by reading time. */
export type ReadLabel = "skipped" | "glanced" | "read" | "studied" | "opened";
export const READ_LABEL_TEXT: Record<ReadLabel, string> = { skipped: "Skipped", glanced: "Glanced", read: "Read", studied: "Studied", opened: "Opened" };

export const BUYER_STATUSES = [
  "reading_now", "interested", "not_interested", "hot", "warming", "went_quiet", "skimmed", "opened", "not_opened", "lapsed",
] as const;
export type BuyerStatus = (typeof BUYER_STATUSES)[number];
export const BUYER_STATUS_TEXT: Record<BuyerStatus, string> = {
  reading_now: "Reading now",
  interested: "Interested",
  not_interested: "Not interested",
  hot: "Hot",
  warming: "Warming up",
  went_quiet: "Went quiet",
  skimmed: "Only skimmed",
  opened: "Opened",
  not_opened: "Not opened yet",
  lapsed: "No response",
};

export const SIGNAL_IDS = [
  "financial_deep_dive", "normalized_toggle", "concern_focus", "price_first", "growth_focus", "returned",
  "multi_network", "asked", "locked_interest", "contact_click", "stalled", "skimmed", "completed",
  "copy_print", "outlier_attention",
] as const;
export type SignalId = (typeof SIGNAL_IDS)[number];

export interface PageRef {
  pageId: string;
  part: number;
  /** "7a" */
  label: string;
  /** The real title (broker side). */
  title: string;
  /** For a blind buyer: the title THEY saw (the words used in talking points about them). */
  servedTitle?: string;
}

export interface Signal {
  id: SignalId;
  /** 0–1: how strong the evidence is (ranking only; never shown as a number). */
  strength: number;
  /** Evidence in seconds, pages and counts: "Studied the Income Statement for 2 min 40 s over 2 visits". */
  evidence: string;
  pageRefs: PageRef[];
}

export interface TalkingPoint {
  signalId: SignalId;
  /** Suggestive, never diagnostic: "Be ready to go through each add-back." */
  text: string;
  /** The evidence it rests on (quoted under the point). */
  evidence: string;
  pageRefs: PageRef[];
}

export interface BuyerFit {
  /** "4 of 6 criteria" from the matching engine. */
  criteriaMatched: number | null;
  criteriaTotal: number | null;
  /** AI deep-check verdict and 0–100 fit, when the broker ran it. */
  deepCheckVerdict: "strong" | "good" | "possible" | "unlikely" | null;
  deepCheckFit: number | null;
}

/** What intelligence derives for one buyer (server/engagement/insights.ts buyerInsight). */
export interface BuyerInsight {
  status: BuyerStatus;
  statusLabel: string;
  /** One line: why the buyer is where they are. */
  why: string;
  signals: Signal[];
  talkingPoints: TalkingPoint[];
  /** 0–1 reading intent (also feeds server/scoring/buyer-score.ts). */
  intent: number;
  /** Sort key for the call list — never shown. Higher = call sooner. */
  priority: number;
  /** Per viewer page: how this buyer read it. Key = viewerPageKey. */
  pageLabels: Record<string, ReadLabel>;
}

export interface KeyMoment {
  at: string;
  /** "Went straight to Financials after the cover". */
  text: string;
  pageRef?: PageRef;
}

// ── Facts: capture's aggregation → intelligence (server-internal) ────────

/** A viewer page with everything intelligence needs about it (real titles; broker side). */
export interface FactPage extends ViewerPageRef {
  lineageId: string;
  title: string;
  /** The title the buyer saw, when it differs (blind). */
  servedTitle: string | null;
  /**
   * The title BLIND buyers saw on this page (from the blind version, even
   * when the chosen version is the named one); null when no blind version
   * of the page is known. Words about a blind buyer use this, never `title`.
   */
  blindTitle?: string | null;
  layoutType: string;
  role: PageRole;
  locked: boolean;
  expectedMs: number;
  blocks: RenditionBlock[];
}

export interface PageReading {
  attentionMs: number;
  skimMs: number;
  visibleMs: number;
  firstAt: string | null;
  lastAt: string | null;
  /** Visits in which this page got any attention. */
  visits: number;
}

export interface VisitFacts {
  id: string;
  renditionId: string | null;
  startedAt: string;
  lastSeenAt: string;
  wallMs: number;
  activeMs: number;
  device: DeviceClass;
  /** "Chrome/Mac" — no version, no raw user agent. */
  uaFamily: string | null;
  /** Furthest page reached: index in ViewRoomReading.pageOrder (-1 = none). A split section's later parts count as reached when any of their blocks was on screen (rollups). */
  maxPageIndex: number;
  /** [secondsSinceVisitStart, pageId] — dominant page changes. */
  path: Array<[number, string]>;
  /** Recorded before detailed reading tracking (page-level only). */
  legacy: boolean;
  /** Opaque per-deal network key (keyed hash) — only for "opened from N places". */
  networkKey: string | null;
}

export interface BuyerQuestionRef {
  id: string;
  text: string;
  askedAt: string;
  /** The page the buyer was on when asking (buyer_questions.section_id). */
  pageId: string | null;
  status: string;
  answered: boolean;
}

export interface BuyerReadingFacts {
  accessId: string;
  buyerUserId: string | null;
  name: string;
  company: string | null;
  email: string;
  buyerType: string | null;
  accessLevel: string;
  mode: CimMode;
  grantedAt: string;
  firstViewedAt: string | null;
  ndaSignedAt: string | null;
  decision: string;
  decisionAt: string | null;
  /** Last "Mark contacted" (buyer_access.access_events). */
  contactedAt: string | null;
  fit: BuyerFit | null;
  visits: VisitFacts[];
  /** Key = viewerPageKey(pageId, part). */
  pages: Record<string, PageReading>;
  /** Key = blockId(pageId, blockKey) → cumulative counters over the filtered visits. */
  blocks: Record<string, BlockCounters>;
  events: Array<ReadingInteraction & { visitId: string }>;
  questions: BuyerQuestionRef[];
}

export interface DealReadingFacts {
  dealId: string;
  dealName: string;
  /** The CIM version the facts are drawn on. */
  rendition: RenditionSummary | null;
  renditions: RenditionSummary[];
  now: string;
  filters: EngagementFilters;
  pages: FactPage[];
  buyers: BuyerReadingFacts[];
  /** Only legacy (page-level) reading exists for this filter. */
  legacyOnly: boolean;
  lastWriteAt: string | null;
}

// ── Broker API responses ─────────────────────────────────────────────────
// Every route: requireBroker + requireOwnedDeal (deal routes) or scoped to
// session.brokerId (global). Unknown/foreign ids → 404.

/** GET /api/deals/:dealId/engagement/summary */
export interface EngagementSummaryResponse {
  dealId: string;
  /** The CIM has been live to at least one buyer. */
  published: boolean;
  pulse: {
    granted: number;
    opened: number;
    readThisWeek: number;
    readingNow: number;
    /** "9 of 13 buyers have opened the CIM · 4 read it this week · 2 reading now" */
    sentence: string;
  };
  readingNow: Array<{ accessId: string; name: string; company: string | null; page: PageRef | null; since: string }>;
  /** The top 3 of the call list. */
  top: CallListEntry[];
  mostStudiedPage: (PageRef & { attentionMs: number }) | null;
  renditions: RenditionSummary[];
  legacyOnly: boolean;
  lastWriteAt: string | null;
}

export interface PageStripCell {
  pageId: string;
  part: number;
  label: string;
  attentionMs: number;
  readLabel: ReadLabel | null;
  reached: boolean;
}

export interface BuyerEngagementCard {
  accessId: string;
  buyerUserId: string | null;
  name: string;
  company: string | null;
  buyerType: string | null;
  accessLevel: string;
  mode: CimMode;
  status: BuyerStatus;
  statusLabel: string;
  why: string;
  fit: BuyerFit | null;
  activeMs: number;
  visits: number;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  pagesReached: number;
  totalPages: number;
  pageStrip: PageStripCell[];
  signals: Signal[];
  talkingPoints: TalkingPoint[];
  questions: BuyerQuestionRef[];
  decision: string;
  decisionAt: string | null;
  contactedAt: string | null;
  /** 0 = call first. */
  rank: number;
}

export interface NotOpenedBuyer {
  accessId: string;
  name: string;
  company: string | null;
  grantedAt: string;
  ndaSigned: boolean;
}

/** GET /api/deals/:dealId/engagement/buyers?<filters> */
export interface EngagementBuyersResponse {
  buyers: BuyerEngagementCard[];
  notOpened: NotOpenedBuyer[];
  pages: ViewerPageRef[];
  legacyOnly: boolean;
}

export interface BuyerSeconds {
  accessId: string;
  name: string;
  attentionMs: number;
}

export interface BlockAttention {
  key: string;
  kind: BlockKind;
  label: string;
  attentionMs: number;
  skimMs: number;
  visibleMs: number;
  pointerMs: number;
  /** skim ÷ (attention + skim): "mostly scrolled past" when high. */
  skimShare: number;
  readers: number;
  topBuyer: BuyerSeconds | null;
  /** For charts: the most pointed-at datum. */
  topPoint: { key: string; label: string; pointerMs: number } | null;
}

export type InteractionCounts = Partial<Record<ReadingInteractionType, number>>;

export interface DocumentPage extends ViewerPageRef {
  lineageId: string;
  title: string;
  servedTitle: string | null;
  /** What blind buyers saw as this page's title (FactPage.blindTitle). */
  blindTitle?: string | null;
  layoutType: string;
  role: PageRole;
  locked: boolean;
  /** Buyers with ≥ READING_RULES.readerMinMs on this page. */
  readers: number;
  /** Buyers whose furthest page is at or beyond this one. */
  reachedBy: number;
  attentionMs: number;
  skimMs: number;
  expectedMs: number;
  readLabel: ReadLabel | null;
  /** One computed sentence ("Most studied page in the CIM"), or null. */
  headline: string | null;
  blocks: BlockAttention[];
  buyers: BuyerSeconds[];
  interactions: InteractionCounts;
  questions: Array<BuyerQuestionRef & { accessId: string; name: string }>;
  /** "Changed since N buyers read it" — N, or null when unchanged. */
  changedSince: number | null;
  /** Page-level only (legacy data, or layout differed between merged versions). */
  pageLevelOnly: boolean;
}

export interface ReachPoint {
  index: number;
  pageId: string;
  part: number;
  label: string;
  title: string;
  /** Buyers whose furthest page is ≥ this one. */
  buyers: number;
}

export interface KindAttention {
  group: KindGroup;
  label: string;
  attentionMs: number;
  expectedMs: number;
  blocks: number;
}

/** GET /api/deals/:dealId/engagement/document?<filters> */
export interface EngagementDocumentResponse {
  rendition: RenditionSummary | null;
  renditions: RenditionSummary[];
  /** Buyers who opened the CIM (denominator of "7/9 read"). */
  openedBy: number;
  reach: ReachPoint[];
  reachHeadline: string | null;
  pages: DocumentPage[];
  /** What holds attention across the whole CIM (per page: DocumentPage.blocks grouped by kindGroupOf). */
  byKind: KindAttention[];
  totals: { attentionMs: number; skimMs: number; readers: number; visits: number };
  legacyOnly: boolean;
}

/** GET /api/deals/:dealId/engagement/renditions/:renditionId — what the viewer renders. */
export interface EngagementRenditionResponse {
  id: string;
  mode: CimMode;
  variant: CimVariant;
  createdAt: string;
  /** The served sections exactly as the buyer got them (shared/cim-buyer-view BuyerSection[]). */
  sections: unknown[];
  /** The CIM design the buyer saw (same shape GET /api/view/:token returns as `design`). */
  design: unknown;
  pages: RenditionPage[];
  /** pageId → the real (named) title, broker side. */
  realTitles: Record<string, string>;
}

export interface JourneySegment {
  pageId: string;
  part: number;
  label: string;
  title: string;
  startSec: number;
  durationSec: number;
  /** How they got here, when it was a jump ("toc", "sticky", "related"). */
  via: "toc" | "sticky" | "related" | null;
}

export interface JourneyVisit {
  id: string;
  startedAt: string;
  lastSeenAt: string;
  activeMs: number;
  device: DeviceClass;
  pagesReached: number;
  legacy: boolean;
  path: JourneySegment[];
  moments: KeyMoment[];
}

/** GET /api/deals/:dealId/engagement/buyers/:accessId/journey */
export interface BuyerJourneyResponse {
  accessId: string;
  name: string;
  company: string | null;
  visits: JourneyVisit[];
  questions: BuyerQuestionRef[];
  decisions: Array<{ decision: string; at: string }>;
}

/** POST /api/deals/:dealId/engagement/buyers/:accessId/contacted */
export interface MarkContactedResponse {
  ok: true;
  contactedAt: string;
}

export interface CallListEntry {
  dealId: string;
  dealName: string;
  accessId: string;
  name: string;
  company: string | null;
  status: BuyerStatus;
  statusLabel: string;
  why: string;
  talkingPoints: TalkingPoint[];
  lastSeenAt: string | null;
}

/** GET /api/broker/engagement/call-list — across the broker's own non-archived deals (top 15). */
export interface CallListResponse {
  entries: CallListEntry[];
}

export interface DealEngagementRow {
  dealId: string;
  dealName: string;
  granted: number;
  opened: number;
  readingThisWeek: number;
  medianActiveMs: number | null;
  reachedEnd: number;
  ndaSigned: number;
  interested: number;
}

export interface LayoutAttention {
  layoutType: string;
  label: string;
  attentionMs: number;
  expectedMs: number;
  pages: number;
}

/** GET /api/broker/engagement/compare — the broker's own deals only. */
export interface EngagementCompareResponse {
  deals: DealEngagementRow[];
  byKind: KindAttention[];
  byLayout: LayoutAttention[];
  /** Anonymous cross-brokerage benchmark (industry × page role), only with enough deals behind it. */
  benchmarks: Array<{ role: PageRole; industry: string; medianStudyRatio: number; deals: number }>;
}

/** POST /api/deals/:dealId/engagement/buyers/:accessId/brief — optional AI narrative (broker-triggered, cached). */
export interface BuyerBriefResponse {
  accessId: string;
  text: string;
  generatedAt: string;
  cached: boolean;
}

// ── Formatting (one way to say time, everywhere) ─────────────────────────

/** 48000 → "48 s", 160000 → "2 min 40 s", 3_900_000 → "1 h 5 min". */
export function formatReadingTime(ms: number | null | undefined): string {
  const s = Math.max(0, Math.round((ms ?? 0) / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  if (m < 60) return rs ? `${m} min ${rs} s` : `${m} min`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm ? `${h} h ${rm} min` : `${h} h`;
}
