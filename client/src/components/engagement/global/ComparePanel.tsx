/**
 * "Your deals compared" (opened, reading this week, median reading time per
 * buyer, read to the end, NDA → Interested) and "What works in your CIMs"
 * (reading time by content kind and by layout, your deals only; plus the
 * anonymous benchmark from other brokerages' CIMs in your industries, shown
 * only when at least five of their deals stand behind a figure).
 *
 * Owned by the INTELLIGENCE stream; placed by the VIEWER stream on
 * /broker/analytics.
 */
import { useLocation } from "wouter";
import { formatReadingTime, READ_LABEL_TEXT, type DealEngagementRow, type LayoutAttention } from "@shared/analytics-v2";
import { readLabel, timesWord } from "@shared/cim-reading-model";
import { PAGE_ROLE_TEXT } from "@shared/cim-page-role";
import { useEngagementCompare } from "@/hooks/useEngagement";
import { Skeleton } from "@/components/ui/skeleton";
import { AttentionByKind } from "../AttentionByKind";

/** 2.1 → "twice their expected reading time"; 0.5 → "about half their expected reading time". */
function ratioWords(r: number): string {
  if (r >= 1.1) return `${timesWord(r)} their expected reading time`;
  if (r >= 0.9) return "about their expected reading time";
  if (r >= 0.6) return "about two-thirds of their expected reading time";
  if (r >= 0.4) return "about half their expected reading time";
  return "under half their expected reading time";
}

function opened(d: DealEngagementRow): string {
  return d.granted === 0 ? "No buyers yet" : `${d.opened} of ${d.granted}`;
}

function LayoutBars({ layouts }: { layouts: LayoutAttention[] }) {
  // How closely each layout is read: reading time ÷ the time its content
  // needs (fair across layouts used a lot or a little, long or short).
  const per = layouts
    .filter((l) => l.pages > 0 && l.expectedMs > 0)
    .map((l) => ({ ...l, ratio: l.attentionMs / l.expectedMs }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, 8);
  if (per.length === 0) return null;
  const max = Math.max(...per.map((l) => l.ratio), 1);
  const top = per[0];
  return (
    <div className="min-w-0" data-testid="attention-by-layout">
      <p className="mb-1 text-xs font-medium text-muted-foreground">By layout</p>
      <p className="mb-3 text-sm text-foreground/90">
        {top.ratio >= 1.1
          ? `${top.label} pages are read most closely — ${timesWord(top.ratio)} the time their content needs.`
          : `${top.label} pages are read most closely.`}
      </p>
      <ul className="space-y-2">
        {per.map((l) => {
          const label = readLabel(l.attentionMs, l.expectedMs);
          return (
            <li key={l.layoutType} className="grid grid-cols-[minmax(84px,140px)_1fr_auto] items-center gap-3 text-xs">
              <span className="truncate text-foreground/90">{l.label}</span>
              <span className="h-2.5 overflow-hidden rounded-full bg-muted">
                <span className="block h-full rounded-full bg-teal/60" style={{ width: `${Math.max(2, (l.ratio / max) * 100)}%` }} />
              </span>
              <span className="whitespace-nowrap text-right tabular-nums text-muted-foreground">
                {label && <span className="text-foreground">{READ_LABEL_TEXT[label]}</span>}
                <span className="ml-1.5 hidden sm:inline">· {formatReadingTime(l.attentionMs)} on {l.pages} page{l.pages === 1 ? "" : "s"}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function ComparePanel() {
  const { data, isLoading, error } = useEngagementCompare();
  const [, setLocation] = useLocation();
  if (isLoading) return <Skeleton className="h-48 w-full rounded-xl" />;
  if (error || !data) return <p className="text-sm text-muted-foreground">Couldn't compare your deals.</p>;
  const withBuyers = data.deals.filter((d) => d.granted > 0);
  const rows = withBuyers.length ? withBuyers : data.deals;
  const hidden = data.deals.length - rows.length;

  return (
    <div className="space-y-8" data-testid="engagement-compare">
      <section>
        <h3 className="text-sm font-semibold text-foreground">Your deals compared</h3>
        <p className="mt-0.5 mb-3 text-xs text-muted-foreground">Reading time is time with the CIM on screen and the buyer active — never idle or hidden tabs.</p>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No deals yet.</p>
        ) : (
          <>
            {/* Desktop table */}
            <div className="hidden overflow-x-auto rounded-lg border border-border md:block">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/30 text-left text-xs text-muted-foreground">
                    <th className="px-4 py-2.5 font-medium">Deal</th>
                    <th className="px-3 py-2.5 font-medium">Opened</th>
                    <th className="px-3 py-2.5 font-medium">Read this week</th>
                    <th className="px-3 py-2.5 font-medium">Reading time per buyer</th>
                    <th className="px-3 py-2.5 font-medium">Read to the end</th>
                    <th className="px-3 py-2.5 font-medium">NDA → Interested</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.dealId} className="cursor-pointer border-b border-border last:border-0 hover:bg-muted/20" onClick={() => setLocation(`/deal/${d.dealId}/engagement`)}>
                      <td className="max-w-[280px] truncate px-4 py-3 font-medium text-foreground">{d.dealName}</td>
                      <td className="px-3 py-3 tabular-nums">{opened(d)}</td>
                      <td className="px-3 py-3 tabular-nums">{d.readingThisWeek}</td>
                      <td className="px-3 py-3 tabular-nums">{d.medianActiveMs != null ? formatReadingTime(d.medianActiveMs) : "—"}</td>
                      <td className="px-3 py-3 tabular-nums">{d.opened ? `${d.reachedEnd} of ${d.opened}` : "—"}</td>
                      <td className="px-3 py-3 tabular-nums">{d.ndaSigned ? `${d.ndaSigned} → ${d.interested}` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {/* Phone cards */}
            <ul className="space-y-2 md:hidden">
              {rows.map((d) => (
                <li key={d.dealId}>
                  <button type="button" onClick={() => setLocation(`/deal/${d.dealId}/engagement`)} className="w-full rounded-lg border border-border px-3.5 py-3 text-left">
                    <p className="truncate text-sm font-medium text-foreground">{d.dealName}</p>
                    <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 text-xs">
                      <dt className="text-muted-foreground">Opened</dt><dd className="tabular-nums">{opened(d)}</dd>
                      <dt className="text-muted-foreground">Read this week</dt><dd className="tabular-nums">{d.readingThisWeek}</dd>
                      <dt className="text-muted-foreground">Per buyer</dt><dd className="tabular-nums">{d.medianActiveMs != null ? formatReadingTime(d.medianActiveMs) : "—"}</dd>
                      <dt className="text-muted-foreground">To the end</dt><dd className="tabular-nums">{d.opened ? `${d.reachedEnd} of ${d.opened}` : "—"}</dd>
                      <dt className="text-muted-foreground">NDA → Interested</dt><dd className="tabular-nums">{d.ndaSigned ? `${d.ndaSigned} → ${d.interested}` : "—"}</dd>
                    </dl>
                  </button>
                </li>
              ))}
            </ul>
            {hidden > 0 && <p className="mt-2 text-2xs text-muted-foreground">{hidden} deal{hidden === 1 ? "" : "s"} with no buyers yet not shown.</p>}
          </>
        )}
      </section>

      {(data.byKind.length > 0 || data.byLayout.length > 0) && (
        <section>
          <h3 className="text-sm font-semibold text-foreground">What works in your CIMs</h3>
          <p className="mt-0.5 mb-4 text-xs text-muted-foreground">Across your own deals: what kind of content buyers read most closely.</p>
          <div className="grid gap-8 lg:grid-cols-2">
            <AttentionByKind kinds={data.byKind} title="By kind of content" />
            <LayoutBars layouts={data.byLayout} />
          </div>
        </section>
      )}

      {data.benchmarks.length > 0 && (
        <section data-testid="engagement-benchmarks">
          <h3 className="text-sm font-semibold text-foreground">Other brokerages, same industry</h3>
          <p className="mt-0.5 mb-3 text-xs text-muted-foreground">Anonymous — shown only where at least five of their deals stand behind a figure.</p>
          <ul className="space-y-1.5 text-sm">
            {data.benchmarks.map((b) => (
              <li key={`${b.industry}:${b.role}`} className="text-foreground/90">
                {b.industry}: buyers give <span className="font-medium">{PAGE_ROLE_TEXT[b.role]}</span> pages{" "}
                {ratioWords(b.medianStudyRatio)}
                <span className="text-muted-foreground"> ({b.deals} deals)</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
