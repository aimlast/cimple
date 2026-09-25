/**
 * Deal list model — row type from GET /api/deals/list, the broker's saved
 * view preferences, and the pure sort / filter / group functions the page
 * renders from. No React here.
 */
import { DEAL_PHASES, NEXT_STEP_OWNER_LABELS, type NextStep, type NextStepOwner } from "@shared/deal-progress";

export interface DealListRow {
  id: string;
  businessName: string;
  industry: string;
  subIndustry: string | null;
  region: string | null;
  phase: string;
  phaseLabel: string;
  isLive: boolean;
  archivedAt: string | null;
  createdAt: string;
  lastActivityAt: string;
  askingPrice: string | null;
  askingPriceValue: number | null;
  annualRevenue: number | null;
  /** Only a CRM note / the website / a broker-only source states the revenue — shown flagged. */
  revenueUnverified?: boolean;
  sde: number | null;
  /** The earnings figure for the card: SDE or EBITDA, labelled. */
  earnings?: { label: "SDE" | "EBITDA"; value: number; unverified?: boolean } | null;
  readiness: { score: number; label: "Thin" | "Developing" | "Solid" | "Buyer-ready" } | null;
  nextStep: NextStep;
  counts: { documents: number; buyersWithAccess: number; buyerViews: number; openDiscrepancies: number };
  sellerName: string | null;
  blindCodename: string | null;
}

/* ─── Preferences ─────────────────────────────────────────────────────── */

export type GroupBy = "none" | "phase" | "owner" | "industry" | "status";
export type SortBy = "recent" | "newest" | "oldest" | "name" | "price" | "readiness";
export type ViewMode = "cards" | "table";

export interface DealListPrefs {
  groupBy: GroupBy;
  sort: SortBy;
  view: ViewMode;
  phases: string[];
  industries: string[];
  liveOnly: boolean;
  showArchived: boolean;
}

export const DEFAULT_PREFS: DealListPrefs = {
  groupBy: "none",
  sort: "recent",
  view: "cards",
  phases: [],
  industries: [],
  liveOnly: false,
  showArchived: false,
};

export const GROUP_OPTIONS: { value: GroupBy; label: string }[] = [
  { value: "none", label: "No grouping" },
  { value: "phase", label: "Phase" },
  { value: "owner", label: "Whose move" },
  { value: "industry", label: "Industry" },
  { value: "status", label: "Status" },
];

export const SORT_OPTIONS: { value: SortBy; label: string }[] = [
  { value: "recent", label: "Most recent activity" },
  { value: "newest", label: "Newest" },
  { value: "oldest", label: "Oldest" },
  { value: "name", label: "Name A–Z" },
  { value: "price", label: "Asking price, high to low" },
  { value: "readiness", label: "CIM readiness" },
];

const PREFS_KEY = "cimple.dealList.prefs.v1";

/** Saved view, merged over the defaults; storage can be missing or blocked. */
export function loadPrefs(): DealListPrefs {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const saved = JSON.parse(raw) as Partial<DealListPrefs>;
    const pick = <T,>(v: unknown, allowed: readonly T[], fallback: T): T =>
      allowed.includes(v as T) ? (v as T) : fallback;
    return {
      groupBy: pick(saved.groupBy, GROUP_OPTIONS.map((o) => o.value), DEFAULT_PREFS.groupBy),
      sort: pick(saved.sort, SORT_OPTIONS.map((o) => o.value), DEFAULT_PREFS.sort),
      view: pick(saved.view, ["cards", "table"] as const, DEFAULT_PREFS.view),
      phases: Array.isArray(saved.phases) ? saved.phases.filter((p) => typeof p === "string") : [],
      industries: Array.isArray(saved.industries) ? saved.industries.filter((p) => typeof p === "string") : [],
      liveOnly: saved.liveOnly === true,
      showArchived: saved.showArchived === true,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: DealListPrefs): void {
  try {
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private window / blocked storage — the view just isn't remembered */
  }
}

/* ─── Filter / sort / group ───────────────────────────────────────────── */

export function filterDeals(rows: DealListRow[], prefs: DealListPrefs, search: string): DealListRow[] {
  const q = search.trim().toLowerCase();
  return rows.filter((d) => {
    if (d.archivedAt && !prefs.showArchived) return false;
    if (prefs.liveOnly && !d.isLive) return false;
    if (prefs.phases.length > 0 && !prefs.phases.includes(d.phase)) return false;
    if (prefs.industries.length > 0 && !prefs.industries.includes(d.industry)) return false;
    if (!q) return true;
    return [d.businessName, d.industry, d.subIndustry, d.region, d.sellerName, d.blindCodename]
      .some((v) => v?.toLowerCase().includes(q));
  });
}

const byName = (a: DealListRow, b: DealListRow) =>
  a.businessName.localeCompare(b.businessName, undefined, { sensitivity: "base" });
/** Descending by a nullable number; unknown values go last. */
const descNullsLast = (x: number | null | undefined, y: number | null | undefined) =>
  (y ?? -Infinity) - (x ?? -Infinity);

export function sortDeals(rows: DealListRow[], sort: SortBy): DealListRow[] {
  const out = [...rows];
  const recent = (a: DealListRow, b: DealListRow) => b.lastActivityAt.localeCompare(a.lastActivityAt);
  switch (sort) {
    case "recent":
      return out.sort((a, b) => recent(a, b) || byName(a, b));
    case "newest":
      return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || byName(a, b));
    case "oldest":
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || byName(a, b));
    case "name":
      return out.sort(byName);
    case "price":
      return out.sort((a, b) => descNullsLast(a.askingPriceValue, b.askingPriceValue) || recent(a, b));
    case "readiness":
      return out.sort((a, b) => descNullsLast(a.readiness?.score, b.readiness?.score) || recent(a, b));
  }
}

export interface DealGroup {
  key: string;
  label: string;
  hint?: string;
  rows: DealListRow[];
}

const OWNER_ORDER: NextStepOwner[] = ["you", "seller", "buyers", "none"];
const OWNER_HINT: Record<NextStepOwner, string> = {
  you: "The next step is yours",
  seller: "Nothing for you to do until the seller finishes",
  buyers: "Live — buyers are reviewing",
  none: "Cimple is working on these",
};

/** Groups in a stable, meaningful order; empty groups are dropped. */
export function groupDeals(rows: DealListRow[], groupBy: GroupBy): DealGroup[] {
  if (groupBy === "none") return [{ key: "all", label: "", rows }];
  const buckets = new Map<string, DealGroup>();
  const add = (key: string, label: string, row: DealListRow, hint?: string) => {
    if (!buckets.has(key)) buckets.set(key, { key, label, hint, rows: [] });
    buckets.get(key)!.rows.push(row);
  };
  for (const d of rows) {
    switch (groupBy) {
      case "phase": {
        const p = DEAL_PHASES.find((x) => x.key === d.phase);
        add(d.phase, p ? `${p.short} · ${p.label}` : d.phaseLabel, d);
        break;
      }
      case "owner":
        add(d.nextStep.owner, NEXT_STEP_OWNER_LABELS[d.nextStep.owner], d, OWNER_HINT[d.nextStep.owner]);
        break;
      case "industry":
        add(d.industry || "Other", d.industry || "Other", d);
        break;
      case "status":
        if (d.archivedAt) add("archived", "Archived", d, "Hidden from your dashboard — restore any time");
        else if (d.isLive) add("live", "Live", d, "Shared with buyers");
        else add("progress", "In progress", d);
        break;
    }
  }
  const order: string[] =
    groupBy === "phase" ? DEAL_PHASES.map((p) => p.key)
    : groupBy === "owner" ? OWNER_ORDER
    : groupBy === "status" ? ["progress", "live", "archived"]
    : Array.from(buckets.keys()).sort((a, b) => a.localeCompare(b));
  const known = order.filter((k) => buckets.has(k)).map((k) => buckets.get(k)!);
  const rest = Array.from(buckets.values()).filter((g) => !order.includes(g.key));
  return [...known, ...rest];
}

/* ─── Formatting ──────────────────────────────────────────────────────── */

export function formatMoney(n: number | null | undefined): string | null {
  if (n == null || !Number.isFinite(n) || n <= 0) return null;
  // Two decimals at most, trailing zeros dropped: $1.85M stays $1.85M (not "$1.9M").
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n >= 10_000_000 ? 1 : 2).replace(/\.?0+$/, "")}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

/** "Your move", "Waiting on the seller"… — the words before the step. */
export function ownerPrefix(owner: NextStepOwner): string | null {
  if (owner === "you") return "Your move";
  if (owner === "seller") return "Waiting on the seller";
  return null;
}
