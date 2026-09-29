/**
 * Buyer pulse — the deal Overview's engagement card (replaces
 * DealAnalyticsWidget): the pulse sentence, who is reading right now, the
 * top 3 buyers to call with their one-line why, "Most studied page: <real
 * title>", and a link to the Engagement tab.
 *
 * Owned by the INTELLIGENCE stream.
 */
import { useLocation } from "wouter";
import { formatReadingTime } from "@shared/analytics-v2";
import { useEngagementSummary } from "@/hooks/useEngagement";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowRight, BookOpenText, Radio } from "lucide-react";
import { StatusChip } from "./buyers/parts";

export function BuyerPulseCard({ dealId }: { dealId: string }) {
  const { data, isLoading } = useEngagementSummary(dealId);
  const [, setLocation] = useLocation();
  const open = (qs = "") => setLocation(`/deal/${dealId}/engagement${qs}`);

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  }
  if (!data) return null;

  const header = (
    <div className="mb-3 flex items-center justify-between gap-3">
      <p className="font-mono text-2xs uppercase tracking-[0.16em] text-muted-foreground">Buyer pulse</p>
      {data.published && data.pulse.granted > 0 && (
        <button type="button" onClick={() => open()} className="inline-flex items-center gap-1 text-xs text-teal hover:underline" data-testid="link-engagement">
          See who to call <ArrowRight className="h-3 w-3" />
        </button>
      )}
    </div>
  );

  if (!data.published || data.pulse.granted === 0) {
    return (
      <div data-testid="buyer-pulse">
        {header}
        <p className="text-sm text-muted-foreground">
          {data.published
            ? "No buyers have access yet. Once they open the CIM, you'll see who is reading, what they study and who to call first."
            : "Once the CIM is live and buyers open it, you'll see who is reading, what they study and who to call first."}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="buyer-pulse">
      {header}
      <p className="text-sm text-foreground">{data.pulse.sentence}</p>

      {data.readingNow.length > 0 && (
        <div className="mt-2 space-y-1">
          {data.readingNow.slice(0, 3).map((r) => (
            <p key={r.accessId} className="flex items-start gap-2 text-xs text-success-muted-foreground">
              <Radio className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0">
                <span className="font-medium">{r.name}</span>{r.company ? ` (${r.company})` : ""} is reading now{r.page ? ` — page ${r.page.label}, ${r.page.title}` : ""}
              </span>
            </p>
          ))}
        </div>
      )}

      {data.top.length > 0 && (
        <div className="mt-4">
          <p className="mb-2 text-xs font-medium text-muted-foreground">Call first</p>
          <ol className="space-y-2">
            {data.top.map((e, i) => (
              <li key={e.accessId}>
                <button
                  type="button"
                  onClick={() => open()}
                  className="group flex w-full items-start gap-3 rounded-lg border border-border/70 px-3 py-2.5 text-left transition-colors hover:border-teal/40 hover:bg-teal/[0.03]"
                  data-testid={`pulse-top-${i}`}
                >
                  <span className="mt-0.5 font-mono text-xs text-teal tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-sm font-medium text-foreground">{e.name}</span>
                      {e.company && <span className="text-xs text-muted-foreground">{e.company}</span>}
                      <StatusChip status={e.status} label={e.statusLabel} />
                    </span>
                    <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground line-clamp-2">{e.why}</span>
                  </span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {data.mostStudiedPage && (
        <button
          type="button"
          onClick={() => open(`?view=document&page=${encodeURIComponent(`${data.mostStudiedPage!.pageId}#${data.mostStudiedPage!.part}`)}`)}
          className="mt-3 flex w-full items-center gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
          data-testid="pulse-most-studied"
        >
          <BookOpenText className="h-3.5 w-3.5 shrink-0 text-teal" />
          <span className="truncate">
            Most studied page: <span className="text-foreground">{data.mostStudiedPage.title}</span> · {formatReadingTime(data.mostStudiedPage.attentionMs)} of reading
          </span>
        </button>
      )}
      {data.legacyOnly && <p className="mt-2 text-2xs text-muted-foreground">Recorded before detailed reading tracking — page-level only.</p>}
    </div>
  );
}
