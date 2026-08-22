/**
 * ActivityTimeline — chronological feed of buyer events for a deal
 *
 * Shows who did what, when — CIM opens, NDA signatures, section reads,
 * scroll milestones, questions asked. (nda_signed / question_asked are
 * written server-side at signing / submission time; download_attempt stays
 * in EVENT_CONFIG for the server filter but no client emits it yet, so it is
 * deliberately not promised in any user-facing copy.)
 * Compact design for embedding in the deal TeamTab and the Analytics page.
 *
 * Pages are fetched with offset/limit and appended client-side; the server
 * clamps a single request to 200 rows, so growing `limit` alone used to stall
 * on busy deals with a "Show more" button that never loaded anything.
 */
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelError } from "@/components/deal/PanelError";
import {
  Eye, FileSignature, BookOpen, ArrowDown, MessageSquare,
  Download, Clock, ChevronDown, Loader2,
} from "lucide-react";

interface TimelineEvent {
  id: string;
  eventType: string;
  buyerName: string;
  buyerEmail: string | null;
  sectionKey: string | null;
  scrollDepthPercent: number | null;
  timeSpentSeconds: number | null;
  createdAt: string;
}

interface TimelinePage {
  timeline: TimelineEvent[];
  total: number;
}

const PAGE_SIZE = 20;

const EVENT_CONFIG: Record<string, { icon: typeof Eye; label: string; color: string }> = {
  view:             { icon: Eye,            label: "Opened CIM",       color: "text-blue-400" },
  nda_signed:       { icon: FileSignature,  label: "Signed NDA",       color: "text-emerald-400" },
  section_enter:    { icon: BookOpen,        label: "Viewed section",   color: "text-muted-foreground" },
  scroll_depth:     { icon: ArrowDown,       label: "Scrolled to",      color: "text-muted-foreground" },
  question_asked:   { icon: MessageSquare,   label: "Asked question",   color: "text-amber-400" },
  download_attempt: { icon: Download,        label: "Download attempt", color: "text-red-400" },
};

function fmtSection(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, c => c.toUpperCase())
    .trim();
}

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

async function readError(res: Response, fallback: string): Promise<string> {
  if (res.status === 401) return "Your session has expired — please sign in again.";
  try {
    const data = await res.json();
    if (data?.error) return String(data.error);
  } catch {
    // non-JSON body
  }
  return `${fallback} (${res.status})`;
}

export function ActivityTimeline({ dealId }: { dealId: string }) {
  const {
    data, isLoading, isError, refetch,
    fetchNextPage, hasNextPage, isFetchingNextPage,
  } = useInfiniteQuery<TimelinePage>({
    queryKey: ["/api/deals", dealId, "analytics/timeline"],
    initialPageParam: 0,
    queryFn: async ({ pageParam }) => {
      const offset = Number(pageParam) || 0;
      const res = await fetch(
        `/api/deals/${dealId}/analytics/timeline?limit=${PAGE_SIZE}&offset=${offset}`,
        { credentials: "include" },
      );
      if (!res.ok) throw new Error(await readError(res, "Failed to load activity"));
      return res.json();
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.timeline.length, 0);
      // Stop when the server returned a short page or we've reached its total —
      // never promise rows that can't be loaded.
      if (lastPage.timeline.length < PAGE_SIZE || loaded >= lastPage.total) return undefined;
      return loaded;
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-20" />
        {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-10" />)}
      </div>
    );
  }

  if (isError) {
    return <PanelError what="buyer activity" onRetry={() => refetch()} />;
  }

  const timeline = data?.pages.flatMap(p => p.timeline) ?? [];
  const total = data?.pages[data.pages.length - 1]?.total ?? timeline.length;

  if (timeline.length === 0) {
    return (
      <div className="text-center py-4">
        <Clock className="h-5 w-5 mx-auto mb-1.5 opacity-20" />
        <p className="text-xs text-muted-foreground">No activity yet</p>
        <p className="text-2xs text-muted-foreground/60 mt-0.5">
          Buyer opens, NDA signatures, section reads, and questions will appear here.
        </p>
      </div>
    );
  }

  const remaining = Math.max(total - timeline.length, 0);

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5" /> Activity Feed
        <span className="text-2xs text-muted-foreground/60 font-normal tabular-nums">
          · {timeline.length} of {total}
        </span>
      </p>

      <div className="relative">
        {/* Timeline line */}
        <div className="absolute left-[11px] top-2 bottom-2 w-px bg-border" />

        <div className="space-y-0.5">
          {timeline.map(event => {
            const config = EVENT_CONFIG[event.eventType] || EVENT_CONFIG.view;
            const Icon = config.icon;

            let detail = "";
            if (event.eventType === "section_enter" && event.sectionKey) {
              detail = fmtSection(event.sectionKey);
            } else if (event.eventType === "scroll_depth" && event.scrollDepthPercent != null) {
              detail = `${event.scrollDepthPercent}%`;
            }

            return (
              <div key={event.id} className="flex items-start gap-2.5 py-1.5 pl-0 relative">
                <div className={`shrink-0 mt-0.5 h-[22px] w-[22px] rounded-full bg-card border border-border flex items-center justify-center z-10 ${config.color}`}>
                  <Icon className="h-3 w-3" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs leading-tight">
                    <span className="font-medium">{event.buyerName}</span>
                    <span className="text-muted-foreground"> {config.label.toLowerCase()}</span>
                    {detail && <span className="text-muted-foreground"> — {detail}</span>}
                  </p>
                  <p className="text-2xs text-muted-foreground/60 mt-0.5">{timeAgo(event.createdAt)}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full h-7 text-2xs gap-1"
          disabled={isFetchingNextPage}
          onClick={() => fetchNextPage()}
        >
          {isFetchingNextPage
            ? <Loader2 className="h-3 w-3 animate-spin" />
            : <ChevronDown className="h-3 w-3" />}
          {isFetchingNextPage ? "Loading…" : `Show more${remaining > 0 ? ` (${remaining} remaining)` : ""}`}
        </Button>
      )}
    </div>
  );
}
