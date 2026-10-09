/**
 * Analytics → Deals: each CIM side by side. "Read" follows the period above;
 * the other columns are all time. A table at lg+ (sortable, every header
 * explained), cards below. Every row has a Heat map link straight to that
 * deal's "Where they read". Deals with no buyers fold away underneath.
 */
import { useMemo, useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowDown, ArrowUp, ChevronDown, Flame } from "lucide-react";
import { formatReadingTime } from "@shared/analytics-v2";
import { dayMonth, rangeLabel, type DashboardRange, type DealDashboardRow, type ExamplesMode, type RangeRequest } from "@shared/analytics-dashboard";
import { useAnalyticsDeals } from "@/hooks/useAnalyticsDashboard";
import { Skeleton } from "@/components/ui/skeleton";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { PanelError } from "@/components/deal/PanelError";
import { cn } from "@/lib/utils";
import { InfoDot } from "./Explain";
import { DealChips } from "./parts";
import { TabEmpty } from "./EmptyStates";

export const DEALS_TAB_DESCRIPTION = "How each CIM is doing, side by side. 'Read' follows the period above; the other columns are all time.";

type SortKey = "deal" | "opened" | "read" | "time" | "far" | "nda" | "teaser_links" | "waiting" | "last";

export const DEAL_COLUMN_INFO: Record<SortKey, string> = {
  deal: "Your deals with at least one buyer link.",
  opened: "Buyers who opened their link at least once, out of everyone you've given the CIM (links you later removed included).",
  read: "Buyers with at least one visit of 3 seconds or more of active reading in the period above.",
  time: "The middle buyer's active reading time over all their visits (idle time, hidden tabs and your own previews don't count).",
  far: "The middle buyer's furthest page, out of the content pages they could open (cover, disclaimer and contact pages left out).",
  nda: "Buyers who signed the NDA, then how many of them chose 'Interested'. All time.",
  teaser_links: "Teaser links you've given, and how many of those buyers asked for the CIM.",
  waiting: "Questions nobody has answered yet, buyers who asked for the CIM, and buyers waiting for your approval.",
  last: "The latest visit, question, NDA, decision or request for the CIM.",
};

const t = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

function sortValue(r: DealDashboardRow, k: SortKey): number | string {
  switch (k) {
    case "deal": return r.dealName.toLowerCase();
    case "opened": return r.granted ? r.opened / r.granted : -1;
    case "read": return r.readingInRange;
    case "time": return r.medianReadingMs ?? -1;
    case "far": return r.medianPagesReached != null && r.contentPages ? r.medianPagesReached / r.contentPages : -1;
    case "nda": return r.ndaSigned * 1000 + r.interested;
    case "teaser_links": return r.teaser ? r.teaser.sent : -1;
    case "waiting": return r.waiting;
    case "last": return t(r.lastActivityAt);
  }
}

export function sortDealRows(rows: DealDashboardRow[], key: SortKey, dir: "asc" | "desc"): DealDashboardRow[] {
  return [...rows].sort((a, b) => {
    const x = sortValue(a, key);
    const y = sortValue(b, key);
    const c = typeof x === "string" ? x.localeCompare(String(y)) : x - (y as number);
    return (dir === "asc" ? c : -c) || a.dealName.localeCompare(b.dealName);
  });
}

/** The figures in words, shared by the table and the cards. */
export function dealFigures(r: DealDashboardRow) {
  return {
    opened: r.granted === 0 ? "—" : `${r.opened} of ${r.granted}`,
    read: String(r.readingInRange),
    time: r.medianReadingMs != null ? formatReadingTime(r.medianReadingMs) : "—",
    far: r.medianPagesReached != null && r.contentPages > 0 ? `${r.medianPagesReached} of ${r.contentPages} pages` : "—",
    nda: `${r.ndaSigned} → ${r.interested}`,
    teaser: r.teaser ? `${r.teaser.sent} sent · ${r.teaser.asked} asked` : "—",
    waiting: r.waiting > 0 ? String(r.waiting) : "—",
    last: r.lastActivityAt ? dayMonth(r.lastActivityAt) : "—",
  };
}

export function DealsTab({ range, examples }: { range: RangeRequest; examples: ExamplesMode | null }) {
  const { data, isLoading, error, refetch } = useAnalyticsDeals(range, examples);
  const [sort, setSort] = useState<{ key: SortKey; dir: "asc" | "desc" }>({ key: "last", dir: "desc" });
  const rows = useMemo(() => sortDealRows(data?.rows ?? [], sort.key, sort.dir), [data, sort]);
  if (isLoading && !data) return <Skeleton className="h-56 w-full rounded-xl" />;
  if (error || !data) return <PanelError what="your deals" onRetry={() => refetch()} />;
  return (
    <div className="space-y-4" data-testid="deals-tab">
      {rows.length === 0 ? (
        <TabEmpty title="No buyers on your deals yet" body="Give a buyer access from a deal's Buyers tab and each CIM shows up here." />
      ) : (
        <DealsTable rows={rows} range={data.range} sort={sort} onSort={(key) => setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }))} />
      )}
      <WithoutBuyers deals={data.withoutBuyers} />
    </div>
  );
}

export function DealsTable({ rows, range, sort, onSort }: {
  rows: DealDashboardRow[];
  range: DashboardRange;
  sort: { key: SortKey; dir: "asc" | "desc" };
  onSort(key: SortKey): void;
}) {
  const [, setLocation] = useLocation();
  const teaser = rows.some((r) => r.teaser);
  const readHead = range === "all" ? "Read it" : `Read · ${rangeLabel(range, true)}`;
  const cols: Array<{ key: SortKey; label: string; className?: string }> = [
    { key: "deal", label: "Deal", className: "min-w-[180px] pl-4" },
    { key: "opened", label: "Opened" },
    { key: "read", label: readHead },
    { key: "time", label: "Time per buyer" },
    { key: "far", label: "How far they got" },
    { key: "nda", label: "NDA → Interested" },
    ...(teaser ? [{ key: "teaser_links" as SortKey, label: "Teaser" }] : []),
    { key: "waiting", label: "Waiting on you" },
    { key: "last", label: "Last activity" },
  ];
  return (
    <>
      {/* lg+: the table */}
      <div className="hidden overflow-x-auto rounded-xl border border-border lg:block">
        <table className="w-full text-sm" data-testid="deals-table">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
              {cols.map((c) => (
                <th key={c.key} className={cn("px-2.5 py-2.5 align-bottom font-medium", c.className)} aria-sort={sort.key === c.key ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}>
                  <span className="inline-flex items-end gap-1">
                    <button type="button" onClick={() => onSort(c.key)} className={cn("inline-flex items-end gap-1 text-left hover:text-foreground", sort.key === c.key && "text-foreground")}>
                      {c.label}
                      {sort.key === c.key && (sort.dir === "desc" ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" />)}
                    </button>
                    <InfoDot text={DEAL_COLUMN_INFO[c.key]} />
                  </span>
                </th>
              ))}
              <th className="px-2.5 py-2.5"><span className="sr-only">Heat map</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const f = dealFigures(r);
              return (
                <tr
                  key={r.dealId}
                  className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/20"
                  onClick={() => setLocation(`/deal/${r.dealId}/engagement`)}
                  data-testid={`deal-row-${r.dealId}`}
                >
                  <td className="max-w-[240px] px-2.5 py-2.5 pl-4">
                    <span className="block truncate font-medium text-foreground" title={r.dealName}>{r.dealName}</span>
                    <span className="mt-1 flex items-center gap-1.5"><DealChips live={r.live} demo={r.demo} showLive /></span>
                  </td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums" title={`${r.opened} of ${r.granted} buyers opened their link`}>{f.opened}</td>
                  <td className="px-2.5 py-2.5 tabular-nums">{f.read}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums" title={r.medianReadingMs != null ? `Median of ${r.opened} buyers' active reading time` : undefined}>{f.time}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums" title={r.medianPagesReached != null ? `Median furthest page of ${r.opened} buyers` : undefined}>{f.far}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums">{f.nda}</td>
                  {teaser && <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums">{f.teaser}</td>}
                  <td className={cn("px-2.5 py-2.5 tabular-nums", r.waiting > 0 && "font-medium text-teal")}>{f.waiting}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 tabular-nums text-muted-foreground">{f.last}</td>
                  <td className="whitespace-nowrap px-2.5 py-2.5 pr-4 text-right">
                    <HeatMapLink dealId={r.dealId} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {/* below lg: one card per deal */}
      <ul className="space-y-2 lg:hidden" data-testid="deals-cards">
        {rows.map((r) => {
          const f = dealFigures(r);
          return (
            <li key={r.dealId} className="rounded-xl border border-border bg-card">
              <Link href={`/deal/${r.dealId}/engagement`} className="block px-4 pb-2 pt-3">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-sm font-medium text-foreground">{r.dealName}</span>
                  <DealChips live={r.live} demo={r.demo} showLive />
                </span>
                <dl className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
                  <Fig label="Opened" value={f.opened} />
                  <Fig label={range === "all" ? "Read it" : `Read · ${rangeLabel(range, true)}`} value={f.read} />
                  <Fig label="Per buyer" value={f.time} />
                  <Fig label="How far" value={f.far} />
                  <Fig label="NDA → Interested" value={f.nda} />
                  <Fig label="Waiting on you" value={f.waiting} brass={r.waiting > 0} />
                  {r.teaser && <Fig label="Teaser" value={f.teaser} />}
                  <Fig label="Last activity" value={f.last} />
                </dl>
              </Link>
              <div className="border-t border-border/70 px-4 py-2">
                <HeatMapLink dealId={r.dealId} />
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function Fig({ label, value, brass }: { label: string; value: string; brass?: boolean }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-2">
      <dt className="truncate text-muted-foreground">{label}</dt>
      <dd className={cn("shrink-0 tabular-nums text-foreground", brass && "font-medium text-teal")}>{value}</dd>
    </div>
  );
}

export function HeatMapLink({ dealId }: { dealId: string }) {
  return (
    <Link
      href={`/deal/${dealId}/engagement?view=document`}
      onClick={(e: React.MouseEvent) => e.stopPropagation()}
      className="inline-flex items-center gap-1 text-xs font-medium text-teal hover:underline"
      data-testid={`heatmap-link-${dealId}`}
    >
      <Flame className="h-3.5 w-3.5" /> Heat map
    </Link>
  );
}

function WithoutBuyers({ deals }: { deals: Array<{ dealId: string; dealName: string; live: boolean; demo: boolean }> }) {
  const [open, setOpen] = useState(false);
  if (deals.length === 0) return null;
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button type="button" className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" data-testid="deals-without-buyers">
          <ChevronDown className={cn("h-4 w-4 transition-transform", open && "rotate-180")} />
          {deals.length} deal{deals.length === 1 ? " has" : "s have"} no buyers yet
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ul className="mt-2 divide-y divide-border/70 rounded-xl border border-border">
          {deals.map((d) => (
            <li key={d.dealId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <span className="flex min-w-0 flex-1 items-center gap-1.5">
                <span className="truncate text-sm text-foreground">{d.dealName}</span>
                <DealChips live={d.live} demo={d.demo} />
              </span>
              <Link href={`/deal/${d.dealId}/buyers?stage=send`} className="text-xs font-medium text-teal hover:underline">Give buyers access →</Link>
            </li>
          ))}
        </ul>
      </CollapsibleContent>
    </Collapsible>
  );
}
