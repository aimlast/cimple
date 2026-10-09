/**
 * URL state for the analytics dashboards (pure; tested in
 * tests/unit/analytics-url.test.ts).
 *
 *   /broker/analytics?tab=call|deals|buyers|activity|attention&range=7d|30d|all
 *     &examples=include|exclude&buyer=<accessId>&deal=<dealId>&status=<s>&q=<text>
 *     &sort=<s>&kpi=<id>:<range>&notice=expiring|not_opened&kind=<k>
 *
 *   /deal/:id/engagement?view=buyers|document|activity|<extra>&buyer=<accessId>
 *     &page=<pageId#part>&journey=<accessId>&range=&device=&buyers=&segment=&rendition=
 *     + any parameter a view owns (the heat map's compare=)
 *
 * Absent = the default. A range absent from the URL is "automatic" (the
 * server picks the last 30 days, or all time when they're empty).
 */
import {
  ANALYTICS_TABS,
  BUYER_KPI_IDS,
  parseActivityKind,
  parseBuyerStatusFilter,
  parseNoticeId,
  type NoticeId,
  type ActivityKindFilter,
  type AnalyticsTab,
  type BuyerStatusFilter,
  type DashboardRange,
  type ExamplesMode,
  type KpiId,
} from "@shared/analytics-dashboard";
import {
  engagementFiltersQuery,
  parseEngagementFilters,
  type EngagementFilters,
} from "@shared/analytics-v2";

export type BuyerSort = "last_active" | "reading" | "fit" | "name";
export const BUYER_SORTS: ReadonlyArray<{ key: BuyerSort; label: string }> = [
  { key: "last_active", label: "Last active" },
  { key: "reading", label: "Reading time" },
  { key: "fit", label: "Fit" },
  { key: "name", label: "Name" },
];

export interface KpiChip { id: KpiId; range: DashboardRange }

export interface AnalyticsUrlState {
  /** null = the default (Who to call when anyone is worth a call, else Deals). */
  tab: AnalyticsTab | null;
  /** null = automatic. */
  range: DashboardRange | null;
  /** null = the default (included until the broker has a live deal of their own). */
  examples: ExamplesMode | null;
  buyer: string | null;
  deal: string | null;
  status: BuyerStatusFilter;
  q: string;
  sort: BuyerSort;
  kpi: KpiChip | null;
  /** A heads-up line's "See them": exactly the buyers that line counted. */
  notice: NoticeId | null;
  kind: ActivityKindFilter;
}

export const ANALYTICS_URL_DEFAULTS: AnalyticsUrlState = {
  tab: null, range: null, examples: null, buyer: null, deal: null, status: "all", q: "", sort: "last_active", kpi: null, notice: null, kind: "all",
};

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const id = (v: string | null): string | null => (v && ID.test(v) ? v : null);
const isRange = (v: unknown): v is DashboardRange => v === "7d" || v === "30d" || v === "all";

/** "reading:30d" → { id: "reading", range: "30d" } (buyer numbers only; anything else → null). */
export function parseKpiChip(v: string | null | undefined): KpiChip | null {
  if (!v) return null;
  const [k, r] = v.split(":");
  if (!BUYER_KPI_IDS.includes(k as KpiId) || !isRange(r)) return null;
  return { id: k as KpiId, range: r };
}

export function parseAnalyticsSearch(search: string): AnalyticsUrlState {
  const p = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tab = p.get("tab");
  const range = p.get("range");
  const examples = p.get("examples");
  const sort = p.get("sort");
  return {
    tab: ANALYTICS_TABS.includes(tab as AnalyticsTab) ? (tab as AnalyticsTab) : null,
    range: isRange(range) ? range : null,
    examples: examples === "include" || examples === "exclude" ? examples : null,
    buyer: id(p.get("buyer")),
    deal: id(p.get("deal")),
    status: parseBuyerStatusFilter(p.get("status")),
    q: (p.get("q") ?? "").slice(0, 120),
    sort: BUYER_SORTS.some((s) => s.key === sort) ? (sort as BuyerSort) : "last_active",
    kpi: parseKpiChip(p.get("kpi")),
    notice: parseNoticeId(p.get("notice")),
    kind: parseActivityKind(p.get("kind")),
  };
}

/** The query string for a state (defaults omitted; "" when everything is default). */
export function analyticsSearch(state: Partial<AnalyticsUrlState>): string {
  const s = { ...ANALYTICS_URL_DEFAULTS, ...state };
  const p = new URLSearchParams();
  if (s.tab) p.set("tab", s.tab);
  if (s.range) p.set("range", s.range);
  if (s.examples) p.set("examples", s.examples);
  if (s.buyer) p.set("buyer", s.buyer);
  if (s.deal) p.set("deal", s.deal);
  if (s.status && s.status !== "all") p.set("status", s.status);
  if (s.q) p.set("q", s.q);
  if (s.sort && s.sort !== "last_active") p.set("sort", s.sort);
  if (s.kpi) p.set("kpi", `${s.kpi.id}:${s.kpi.range}`);
  if (s.notice) p.set("notice", s.notice);
  if (s.kind && s.kind !== "all") p.set("kind", s.kind);
  const q = p.toString();
  return q ? `?${q}` : "";
}

/** The tab to show: the URL's, else Who to call when anyone is worth a call, else Deals. */
export function resolveAnalyticsTab(tab: AnalyticsTab | null, callCount: number | null | undefined): AnalyticsTab {
  if (tab) return tab;
  return (callCount ?? 0) > 0 ? "call" : "deals";
}

/**
 * Params each tab owns: dropped when the broker moves to another tab, so a
 * stale filter never follows them around.
 */
const TAB_PARAMS: Record<AnalyticsTab, Array<keyof AnalyticsUrlState>> = {
  call: ["buyer"],
  deals: [],
  buyers: ["deal", "status", "q", "sort", "kpi", "notice"],
  activity: ["deal", "kind"],
  attention: [],
};

/** The state after switching to `tab`: page-wide params (range, examples) stay; the old tab's own params go. */
export function switchTab(state: AnalyticsUrlState, tab: AnalyticsTab): AnalyticsUrlState {
  const next: AnalyticsUrlState = { ...state, tab };
  const keep = new Set(TAB_PARAMS[tab]);
  for (const k of Array.from(new Set([...TAB_PARAMS.call, ...TAB_PARAMS.buyers, ...TAB_PARAMS.activity]))) {
    if (!keep.has(k)) (next as unknown as Record<string, unknown>)[k] = ANALYTICS_URL_DEFAULTS[k];
  }
  return next;
}

// ── The deal Engagement tab ───────────────────────────────────────────────

export const CORE_ENGAGEMENT_VIEWS = ["buyers", "document", "activity"] as const;
/** Params the shell rebuilds from state; every other param belongs to a view. */
const SHELL_PARAMS = new Set(["view", "buyer", "page", "journey", "range", "device", "buyers", "segment", "rendition"]);

/** A view key the shell can show: the three core views, or a registered extra view available for this deal. */
export function resolveEngagementView(v: string | null | undefined, extraViews: readonly string[] = []): string {
  if (v && ((CORE_ENGAGEMENT_VIEWS as readonly string[]).includes(v) || extraViews.includes(v))) return v;
  return "buyers";
}

export interface EngagementNext {
  view?: string;
  filters?: EngagementFilters;
  /** The selected buyer on the Buyers view (null clears it). */
  buyer?: string | null;
  /** The open page on the heat map (null clears it). */
  page?: string | null;
  /** The open journey drawer (null closes it). */
  journey?: string | null;
}

/**
 * The Engagement tab's next query string. Shell params are rebuilt from
 * state; `buyer` is kept only on the Buyers view and `page` only on the heat
 * map; a view's own params (the heat map's compare=) are copied through
 * while the view stays the same and dropped on a view switch.
 */
export function engagementSearch(current: string, next: EngagementNext, extraViews: readonly string[] = []): string {
  const cur = new URLSearchParams(current.startsWith("?") ? current.slice(1) : current);
  const curView = resolveEngagementView(cur.get("view"), extraViews);
  const view = resolveEngagementView(next.view ?? curView, extraViews);
  const filters = next.filters ?? parseEngagementFilters(Object.fromEntries(cur));
  const out = new URLSearchParams(engagementFiltersQuery(filters).replace(/^\?/, ""));
  if (view !== "buyers") out.set("view", view);
  const buyer = next.buyer !== undefined ? next.buyer : view === curView ? id(cur.get("buyer")) : null;
  if (view === "buyers" && buyer) out.set("buyer", buyer);
  const page = next.page !== undefined ? next.page : view === curView ? cur.get("page") : null;
  if (view === "document" && page) out.set("page", page);
  const journey = next.journey !== undefined ? next.journey : id(cur.get("journey"));
  if (journey) out.set("journey", journey);
  if (view === curView) {
    cur.forEach((v, k) => {
      if (!SHELL_PARAMS.has(k) && !out.has(k)) out.append(k, v);
    });
  }
  const q = out.toString();
  return q ? `?${q}` : "";
}
