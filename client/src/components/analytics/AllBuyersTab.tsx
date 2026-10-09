/**
 * Analytics → Buyers: everyone you've given a link to, on every deal
 * (teaser-only links included), searchable, with their fit and a Nudge for
 * anyone who hasn't opened. One load per visit; search, filters, sort and
 * paging happen here. The number chip (`kpi=<id>:<range>`) shows exactly the
 * buyers a number counted.
 *   lg+: one-row toolbar (search, deal, status, sort, Clear), the number /
 *        heads-up chip on its own line under it, then the table;
 *   below: search, a Filters sheet, cards.
 */
import { useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { Copy, Mail, Search, SlidersHorizontal, UserRound } from "lucide-react";
import { formatReadingTime, type BuyerStatus } from "@shared/analytics-v2";
import {
  applyKpiFilter,
  BUYER_STATUS_FILTERS,
  dayMonth,
  matchesBuyerStatus,
  NOTICE_CHIP_WORDS,
  rangeWords,
  type BuyerDashboardRow,
  type BuyerStatusFilter,
  type DashboardRange,
  type ExamplesMode,
  type KpiId,
} from "@shared/analytics-dashboard";
import { useAnalyticsBuyers, useAnalyticsOverview } from "@/hooks/useAnalyticsDashboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PanelError } from "@/components/deal/PanelError";
import { StatusChip } from "@/components/engagement/buyers/parts";
import { useNudge } from "@/components/engagement/buyers/useBuyerCardActions";
import { cn } from "@/lib/utils";
import { InfoDot } from "./Explain";
import { Chip, DealChips, FilterChip, OptionGroup } from "./parts";
import { BUYER_SORTS, type AnalyticsUrlState, type BuyerSort, type KpiChip } from "./url";
import { TabEmpty } from "./EmptyStates";

export const BUYERS_TAB_DESCRIPTION = "Everyone you've given a link to, on every deal. Not affected by the date range.";
const PAGE = 50;
const TEASER_READING_TIP = "Teaser reading is on the deal's Engagement tab → Teaser.";

export const BUYER_COLUMN_INFO = {
  sees: "Which version their link opens.",
  status: "Where they stand, from their reading and their answer.",
  fit: "How many of the buyer's criteria this business meets, from the last fit check on the deal's Buyers tab.",
  reading: "Active reading over all their visits.",
  pages: "Pages with at least 3 seconds of reading, out of the content pages they could open.",
};

/** The number chip's words: "Read in the last 30 days", "Worth a call", "Signed the NDA so far". */
export function kpiChipWords(id: KpiId, range: DashboardRange): string {
  const r = rangeWords(range);
  switch (id) {
    case "to_call": return "Worth a call";
    case "reading": return `Read ${r}`;
    case "nda": return `Signed the NDA ${r}`;
    case "interested": return `Said interested ${r}`;
    case "opened": return range === "all" ? "Opened the CIM" : `Opened the CIM ${r}`;
    case "waiting": return "Waiting on you";
  }
}

const t = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

export function sortBuyerRows(rows: BuyerDashboardRow[], sort: BuyerSort): BuyerDashboardRow[] {
  const fit = (r: BuyerDashboardRow) => (r.fit && r.fit.total ? r.fit.matched / r.fit.total + r.fit.matched / 1000 : -1);
  return [...rows].sort((a, b) => {
    switch (sort) {
      case "name": return a.name.localeCompare(b.name);
      case "reading": return (b.readingMs ?? -1) - (a.readingMs ?? -1) || a.name.localeCompare(b.name);
      case "fit": return fit(b) - fit(a) || a.name.localeCompare(b.name);
      default: return t(b.lastSeenAt) - t(a.lastSeenAt) || t(b.grantedAt) - t(a.grantedAt) || a.name.localeCompare(b.name);
    }
  });
}

/** Search over name, company and email. */
export function searchBuyerRows(rows: BuyerDashboardRow[], q: string): BuyerDashboardRow[] {
  const s = q.trim().toLowerCase();
  if (!s) return rows;
  return rows.filter((r) => [r.name, r.company ?? "", r.email].some((x) => x.toLowerCase().includes(s)));
}

/** Haven't opened a CIM link on a live deal: the Nudge button applies. */
export function canNudge(r: BuyerDashboardRow): boolean {
  return r.document === "cim" && !r.firstSeenAt && !r.revokedAt && r.live;
}

/** "24 of 27" pages read; "—" for a teaser link, a CIM with no pages to count, or a buyer who never opened it (not "0 of 26"). */
export function pagesReadText(r: BuyerDashboardRow): string {
  if (r.document !== "cim" || !r.firstSeenAt || r.pagesRead == null || !r.contentPages) return "—";
  return `${r.pagesRead} of ${r.contentPages}`;
}

/** "2 h 12 min · 24 of 27 pages · 4 of 6 criteria · last 24 Sept" (the phone card line). */
export function buyerFactsLine(r: BuyerDashboardRow): string {
  if (r.document !== "cim") return r.ndaSignedAt ? `NDA signed ${dayMonth(r.ndaSignedAt)}` : "Has the teaser";
  const parts: string[] = [];
  if (r.readingMs) parts.push(formatReadingTime(r.readingMs));
  const pages = pagesReadText(r);
  if (pages !== "—") parts.push(`${pages} pages`);
  if (r.fitText) parts.push(r.fitText);
  parts.push(r.lastSeenAt ? `last ${dayMonth(r.lastSeenAt)}` : "not opened yet");
  return parts.join(" · ");
}

function rowHref(r: BuyerDashboardRow): string {
  return r.document === "cim" ? `/deal/${r.dealId}/engagement?buyer=${encodeURIComponent(r.accessId)}` : `/deal/${r.dealId}/engagement?view=teaser`;
}

export function BuyerStatusCell({ row }: { row: BuyerDashboardRow }) {
  if (row.status === "teaser" || row.status === "teaser_asked") {
    return <Chip tone={row.status === "teaser_asked" ? "brass" : "muted"} className="text-[11px]">{row.statusLabel}</Chip>;
  }
  return <StatusChip status={row.status as BuyerStatus} label={row.statusLabel} />;
}

export function AllBuyersTab({ examples, state, update }: {
  examples: ExamplesMode | null;
  state: AnalyticsUrlState;
  /** Change the tab's URL params (replace). */
  update(patch: Partial<AnalyticsUrlState>): void;
}) {
  const { data, isLoading, error, refetch } = useAnalyticsBuyers(examples);
  // The number chip: exactly the set that number counted, in its own period.
  const chip = state.kpi;
  const chipOverview = useAnalyticsOverview(chip?.range ?? "auto", examples, !!chip);
  const chipIds = chip ? chipOverview.data?.kpis.find((k) => k.id === chip.id)?.ids ?? null : null;
  // A heads-up line's "See them": exactly the buyers that line counted (the page's own overview, cached).
  const notice = state.notice;
  const noticeOverview = useAnalyticsOverview(state.range ?? "auto", examples, !!notice);
  const noticeIds = notice ? noticeOverview.data?.noticeIds?.[notice] ?? null : null;
  // Waiting for the set (never while it failed: that shows an error with Retry, not endless skeleton rows).
  const chipLoading = (!!chip && chipOverview.isPending) || (!!notice && noticeOverview.isPending);
  const chipFailed = (!!chip && chipOverview.isError && !chipOverview.data) || (!!notice && noticeOverview.isError && !noticeOverview.data);
  const [search, setSearch] = useState(state.q);
  const [shown, setShown] = useState(PAGE);
  const [sheet, setSheet] = useState(false);
  const nudge = useNudge();
  useEffect(() => setSearch(state.q), [state.q]);
  useEffect(() => {
    if (search === state.q) return;
    const id = setTimeout(() => update({ q: search }), 200);
    return () => clearTimeout(id);
  }, [search, state.q, update]);
  useEffect(() => setShown(PAGE), [state.q, state.deal, state.status, state.sort, state.kpi?.id, state.kpi?.range, state.notice]);

  const now = useMemo(() => new Date(), [data]);
  const all = data?.rows ?? [];
  const deals = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of all) if (!m.has(r.dealId)) m.set(r.dealId, r.dealName);
    return Array.from(m.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [all]);
  const rows = useMemo(() => {
    let r = applyKpiFilter(all, chip ? chipIds ?? [] : null);
    r = applyKpiFilter(r, notice ? noticeIds ?? [] : null);
    if (state.deal) r = r.filter((x) => x.dealId === state.deal);
    r = r.filter((x) => matchesBuyerStatus(x, state.status, now));
    r = searchBuyerRows(r, state.q);
    return sortBuyerRows(r, state.sort);
  }, [all, chip, chipIds, notice, noticeIds, state.deal, state.status, state.q, state.sort, now]);

  if (isLoading || chipLoading) return <div className="space-y-2" data-testid="buyers-loading"><Skeleton className="h-9 w-full" />{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>;
  if (error || !data) return <PanelError what="your buyers" onRetry={() => refetch()} />;
  if (chipFailed) {
    // The set behind a number or a heads-up line couldn't load: say so (Retry), or show everyone instead.
    return (
      <div className="space-y-2" data-testid="buyers-chip-error">
        <PanelError
          what="this list"
          onRetry={() => { if (chip) void chipOverview.refetch(); if (notice) void noticeOverview.refetch(); }}
        />
        <p className="text-center text-xs text-muted-foreground">
          Or{" "}
          <button type="button" className="font-medium text-teal hover:underline" onClick={() => update({ kpi: null, notice: null })} data-testid="buyers-chip-error-all">
            show all your buyers
          </button>
          .
        </p>
      </div>
    );
  }

  const any = !!(state.q || state.deal || state.status !== "all" || chip || notice);
  const nFilters = (state.deal ? 1 : 0) + (state.status !== "all" ? 1 : 0) + (state.sort !== "last_active" ? 1 : 0);
  const clear = () => { setSearch(""); update({ q: "", deal: null, status: "all", kpi: null, notice: null }); };
  const statusLabel = BUYER_STATUS_FILTERS.find((s) => s.key === state.status)?.label ?? "All";
  const dealName = deals.find((d) => d.id === state.deal)?.name ?? null;
  const page = rows.slice(0, shown);

  const chips = (
    <>
      {chip && <FilterChip onRemove={() => update({ kpi: null })} testId="kpi-chip">{kpiChipWords(chip.id, chip.range)}</FilterChip>}
      {notice && <FilterChip onRemove={() => update({ notice: null })} testId="notice-chip">{NOTICE_CHIP_WORDS[notice]}</FilterChip>}
      {state.deal && dealName && <FilterChip onRemove={() => update({ deal: null })}>{dealName}</FilterChip>}
      {state.status !== "all" && <FilterChip onRemove={() => update({ status: "all" })}>{statusLabel}</FilterChip>}
    </>
  );

  return (
    <div className="space-y-3" data-testid="buyers-tab">
      {/* Toolbar: one row at lg+ (the number / heads-up chip goes on the line under it) */}
      <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
        <div className="relative w-full lg:w-64 xl:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, company or email"
            className="h-9 pl-8 text-sm"
            data-testid="buyers-search"
          />
        </div>
        <div className="hidden shrink-0 items-center gap-2 lg:flex">
          <Select value={state.deal ?? "all"} onValueChange={(v) => update({ deal: v === "all" ? null : v })}>
            <SelectTrigger className="h-9 w-44 text-sm xl:w-48" data-testid="buyers-deal"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All deals</SelectItem>
              {deals.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={state.status} onValueChange={(v) => update({ status: v as BuyerStatusFilter })}>
            <SelectTrigger className="h-9 w-48 text-sm xl:w-52" data-testid="buyers-status"><SelectValue /></SelectTrigger>
            <SelectContent>
              {BUYER_STATUS_FILTERS.map((s) => <SelectItem key={s.key} value={s.key}>{s.key === "all" ? "Any status" : s.label}</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={state.sort} onValueChange={(v) => update({ sort: v as BuyerSort })}>
            <SelectTrigger className="h-9 w-40 text-sm" data-testid="buyers-sort"><span className="text-muted-foreground">Sort:</span><SelectValue /></SelectTrigger>
            <SelectContent>
              {BUYER_SORTS.map((s) => <SelectItem key={s.key} value={s.key}>{s.label}</SelectItem>)}
            </SelectContent>
          </Select>
          {any && <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={clear} data-testid="buyers-clear">Clear</Button>}
        </div>
        {/* phone: one Filters button, active filters as chips */}
        <div className="flex w-full flex-wrap items-center gap-2 lg:hidden">
          <Button size="sm" variant="outline" className={cn("h-8 gap-1.5 text-xs", nFilters > 0 && "border-teal/40 text-teal")} onClick={() => setSheet(true)} data-testid="buyers-filters-open">
            <SlidersHorizontal className="h-3.5 w-3.5" /> Filters{nFilters > 0 ? ` · ${nFilters}` : ""}
          </Button>
          {chips}
          {any && <button type="button" className="text-xs text-muted-foreground hover:text-foreground" onClick={clear}>Clear</button>}
        </div>
      </div>
      {(chip || notice) && (
        <div className="hidden flex-wrap items-center gap-2 lg:flex" data-testid="buyers-set-chips">
          {chip && <FilterChip onRemove={() => update({ kpi: null })} testId="kpi-chip">{kpiChipWords(chip.id, chip.range)}</FilterChip>}
          {notice && <FilterChip onRemove={() => update({ notice: null })} testId="notice-chip">{NOTICE_CHIP_WORDS[notice]}</FilterChip>}
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="buyers-count">
          {Math.min(shown, rows.length)} of {rows.length} buyer{rows.length === 1 ? "" : "s"}
        </p>
      )}

      {rows.length === 0 ? (
        <TabEmpty
          testId="buyers-empty"
          title="No buyers match."
          action={any ? <Button size="sm" variant="outline" onClick={clear}>Clear filters</Button> : undefined}
        />
      ) : (
        <BuyersTable rows={page} hideDeal={!!state.deal} onNudge={(r) => nudge.nudge({ buyerUserId: r.buyerUserId, email: r.email, name: r.name, dealId: r.dealId })} />
      )}
      {rows.length > shown && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" onClick={() => setShown((s) => s + PAGE)} data-testid="buyers-more">Show {Math.min(PAGE, rows.length - shown)} more</Button>
        </div>
      )}
      {nudge.dialogs}

      <Sheet open={sheet} onOpenChange={setSheet}>
        <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto rounded-t-xl px-4 pb-6 pt-5">
          <SheetHeader className="mb-3 text-left"><SheetTitle className="text-base">Filters</SheetTitle></SheetHeader>
          <div className="space-y-4">
            <OptionGroup title="Deal" value={state.deal ?? "all"} onChange={(v) => update({ deal: v === "all" ? null : v })}
              options={[{ value: "all", label: "All deals" }, ...deals.map((d) => ({ value: d.id, label: d.name }))]} />
            <OptionGroup<BuyerStatusFilter> title="Status" value={state.status} onChange={(v) => update({ status: v })}
              options={BUYER_STATUS_FILTERS.map((s) => ({ value: s.key, label: s.key === "all" ? "Any status" : s.label }))} />
            <OptionGroup<BuyerSort> title="Sort" value={state.sort} onChange={(v) => update({ sort: v })}
              options={BUYER_SORTS.map((s) => ({ value: s.key, label: s.label }))} />
          </div>
          <div className="sticky -bottom-6 -mx-4 mt-5 border-t border-border bg-background px-4 pb-6 pt-3">
            <Button className="w-full" onClick={() => setSheet(false)} data-testid="buyers-filters-apply">
              Show {rows.length} buyer{rows.length === 1 ? "" : "s"}
            </Button>
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

export function BuyersTable({ rows, hideDeal, onNudge }: { rows: BuyerDashboardRow[]; hideDeal?: boolean; onNudge(r: BuyerDashboardRow): void }) {
  const [, setLocation] = useLocation();
  const head = (label: string, info?: string, className?: string) => (
    <th className={cn("px-2.5 py-2.5 align-bottom font-medium", className)}>
      <span className="inline-flex items-end gap-1">{label}{info && <InfoDot text={info} />}</span>
    </th>
  );
  return (
    <>
      <div className="hidden overflow-x-auto rounded-xl border border-border lg:block">
        <table className="w-full text-sm" data-testid="buyers-table">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
              {head("Buyer", undefined, "pl-4")}
              {!hideDeal && head("Deal")}
              {head("Sees", BUYER_COLUMN_INFO.sees)}
              {head("Status", BUYER_COLUMN_INFO.status)}
              {head("Fit", BUYER_COLUMN_INFO.fit)}
              {head("Reading time", BUYER_COLUMN_INFO.reading)}
              {head("Pages read", BUYER_COLUMN_INFO.pages)}
              {head("NDA")}
              {head("Last active")}
              <th className="px-2.5 py-2.5"><span className="sr-only">Action</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const teaser = r.document !== "cim";
              return (
                <tr key={r.accessId} className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/20" onClick={() => setLocation(rowHref(r))} data-testid={`buyer-row-${r.accessId}`}>
                  <td className="max-w-[220px] px-2.5 py-2.5 pl-4">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate font-medium text-foreground">{r.name}</span>
                      {r.buyerUserId && (
                        <Link href={`/broker/buyers/${r.buyerUserId}`} onClick={(e: React.MouseEvent) => e.stopPropagation()} title="Open their profile" className="text-muted-foreground hover:text-teal">
                          <UserRound className="h-3.5 w-3.5" />
                        </Link>
                      )}
                    </div>
                    <p className="truncate text-xs text-muted-foreground">{r.company || r.email}</p>
                  </td>
                  {!hideDeal && (
                    <td className="max-w-[200px] px-2.5 py-2.5">
                      <span className="block truncate text-foreground/90" title={r.dealName}>{r.dealName}</span>
                      {(r.demo || !r.live) && <span className="mt-1 flex items-center gap-1.5"><DealChips live={r.live} demo={r.demo} /></span>}
                    </td>
                  )}
                  <td className="whitespace-nowrap px-2.5 py-2.5 text-foreground/90">{r.accessLabel}</td>
                  <td className="px-2.5 py-2.5"><BuyerStatusCell row={r} /></td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums">{r.fitText ?? "—"}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums" title={teaser ? TEASER_READING_TIP : undefined}>{teaser ? "—" : r.readingMs ? formatReadingTime(r.readingMs) : "—"}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums" title={teaser ? TEASER_READING_TIP : undefined}>{pagesReadText(r)}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums">{r.ndaSignedAt ? <span className="text-foreground/90">✓ {dayMonth(r.ndaSignedAt)}</span> : "—"}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums text-muted-foreground">{r.lastSeenAt ? dayMonth(r.lastSeenAt) : teaser ? "—" : "Not opened"}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 pr-4 text-right" onClick={(e) => e.stopPropagation()}>
                    <NudgeCell row={r} onNudge={onNudge} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <ul className="space-y-2 lg:hidden" data-testid="buyers-cards">
        {rows.map((r) => (
          <li key={r.accessId} className="rounded-xl border border-border bg-card">
            <Link href={rowHref(r)} className="block px-4 py-3">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-medium text-foreground">{r.name}</span>
                {r.company && <span className="truncate text-xs text-muted-foreground">{r.company}</span>}
              </span>
              <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                <span className="max-w-[12rem] truncate">{r.dealName}</span>
                <DealChips live={r.live} demo={r.demo} />
                <BuyerStatusCell row={r} />
              </span>
              <span className="mt-1.5 block text-xs tabular-nums text-foreground/80">{buyerFactsLine(r)}</span>
            </Link>
            {(canNudge(r) || (r.document === "cim" && !r.firstSeenAt && !r.revokedAt && !r.live)) && (
              <div className="border-t border-border/70 px-4 py-2"><NudgeCell row={r} onNudge={onNudge} /></div>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function NudgeCell({ row, onNudge }: { row: BuyerDashboardRow; onNudge(r: BuyerDashboardRow): void }) {
  if (row.document !== "cim" || row.firstSeenAt || row.revokedAt) return null;
  if (!row.live) return <span className="text-xs text-muted-foreground" title="Buyers can't open it right now">CIM not live</span>;
  return (
    <Button
      size="sm" variant="outline" className="h-7 text-xs"
      onClick={(e) => { e.stopPropagation(); onNudge(row); }}
      title={row.buyerUserId ? "Write them a short email (you send it)" : "Copies their email: they don't have a Cimple profile yet"}
      data-testid={`nudge-${row.accessId}`}
    >
      {row.buyerUserId ? <Mail className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}Nudge
    </Button>
  );
}

export type { KpiChip };
