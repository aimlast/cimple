/**
 * TeaserEngagementPanel — the Engagement tab's "Teaser" view (the analytics
 * stream registers it: INTEGRATION §2.9). How buyers read the anonymous
 * summary, never mixed into the CIM's reading numbers:
 *   KPI strip: Sent · Opened · Read to the end · Asked for the CIM · Given the CIM · Not for them
 *   Where they read: each block — read by how many, time on average
 *   Each buyer: read line, Worth a call, what happened next (filterable)
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { PhoneCall } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelError } from "@/components/deal/PanelError";
import { formatReadingTime } from "@shared/analytics-v2";
import { cn } from "@/lib/utils";
import { TEASER_FILTERS, matchesTeaserFilter, teaserNextLine, teaserReadLine, type TeaserFilter } from "@/components/deal/buyers/HaveTeaserStage";
import { teaserEngagementKey, teaserRequest, type TeaserEngagement } from "./api";

export function TeaserEngagementPanel({ dealId }: { dealId: string }) {
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<TeaserFilter>("all");
  const q = useQuery<TeaserEngagement>({
    queryKey: teaserEngagementKey(dealId),
    queryFn: () => teaserRequest("GET", `/api/deals/${dealId}/teaser/engagement`),
    refetchOnWindowFocus: true,
  });
  const maxReaders = useMemo(() => Math.max(1, ...(q.data?.blocks ?? []).map((b) => b.readers)), [q.data]);

  if (q.isLoading) return <div className="space-y-3"><Skeleton className="h-20" /><Skeleton className="h-48" /></div>;
  if (q.error || !q.data) return <PanelError what="the teaser's reading" onRetry={() => q.refetch()} />;
  const e = q.data;
  const kpis: Array<{ label: string; value: number }> = [
    { label: "Sent", value: e.funnel.sent },
    { label: "Opened", value: e.funnel.opened },
    { label: "Read to the end", value: e.funnel.readToEnd },
    { label: "Asked for the CIM", value: e.funnel.asked },
    { label: "Given the CIM", value: e.funnel.granted },
    { label: "Not for them", value: e.funnel.passed },
  ];
  const opened = e.funnel.opened > 0;
  const shown = e.buyers.filter((b) => matchesTeaserFilter(b, filter));

  return (
    <div className="space-y-5" data-testid="teaser-engagement-panel">
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-border/70 bg-border/70 lg:grid-cols-6">
        {kpis.map((k) => (
          <div key={k.label} className="bg-card px-3 py-3">
            <p className="text-[11px] text-muted-foreground">{k.label}</p>
            <p className="mt-0.5 font-mono text-xl font-semibold tabular-nums">{k.value}</p>
          </div>
        ))}
      </div>

      {!opened ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center text-sm text-muted-foreground" data-testid="teaser-engagement-empty">
          No one has opened the teaser yet.
        </div>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <section className="space-y-2">
            <h3 className="text-sm font-semibold">Where they read</h3>
            <ul className="space-y-2 rounded-lg border border-border bg-card p-3">
              {e.blocks.map((b) => (
                <li key={b.blockId} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-2 text-xs">
                    <span className="truncate text-foreground/90">{b.title || "Header"}</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">read by {b.readers} of {e.funnel.opened} · {formatReadingTime(b.avgMs)} on average</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-teal/70" style={{ width: `${(b.readers / maxReaders) * 100}%` }} /></div>
                </li>
              ))}
            </ul>
          </section>
          <section className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Each buyer</h3>
              <button type="button" className="text-xs text-teal hover:underline" onClick={() => navigate(`/deal/${dealId}/buyers?stage=teaser`)}>Manage on the Buyers tab →</button>
            </div>
            <div className="-mx-4 flex gap-1.5 overflow-x-auto px-4 sm:mx-0 sm:flex-wrap sm:px-0">
              {TEASER_FILTERS.map((f) => (
                <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)} className={cn("shrink-0 rounded-full border px-3 py-1 text-xs", filter === f.key ? "border-teal bg-teal/15" : "border-border text-muted-foreground hover:text-foreground")}>{f.label}</button>
              ))}
            </div>
            <ul className="divide-y divide-border rounded-lg border border-border bg-card">
              {shown.length === 0 ? (
                <li className="p-4 text-center text-xs text-muted-foreground">Nobody here yet.</li>
              ) : shown.map((b) => (
                <li key={b.accessId} className="space-y-1 px-3 py-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{b.name || b.email}</span>
                    {b.company && <span className="text-xs text-muted-foreground">· {b.company}</span>}
                    {b.worthACall && <span className="inline-flex items-center gap-1 rounded-full bg-teal/15 px-2 py-0.5 text-[11px] font-medium text-teal"><PhoneCall className="h-3 w-3" /> Worth a call</span>}
                  </div>
                  <p className="text-xs text-muted-foreground">{teaserReadLine(b)}</p>
                  {teaserNextLine(b).text !== "—" && <p className="text-xs text-foreground/80">{teaserNextLine(b).text}</p>}
                </li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </div>
  );
}
