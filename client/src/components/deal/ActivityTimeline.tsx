/**
 * ActivityTimeline — chronological feed of buyer events for a deal
 *
 * Shows who did what, when — views, NDA signs, section reads, questions asked.
 * Compact design for embedding in the DealDetail right panel.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Eye, FileSignature, BookOpen, ArrowDown, MessageSquare,
  Download, Clock, ChevronDown,
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

export function ActivityTimeline({ dealId }: { dealId: string }) {
  const [limit, setLimit] = useState(20);

  const { data, isLoading } = useQuery<{ timeline: TimelineEvent[]; total: number }>({
    queryKey: ["/api/deals", dealId, "analytics/timeline", limit],
    queryFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/analytics/timeline?limit=${limit}`);
      if (!res.ok) throw new Error();
      return res.json();
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

  const timeline = data?.timeline ?? [];
  const total = data?.total ?? 0;

  if (timeline.length === 0) {
    return (
      <div className="text-center py-4">
        <Clock className="h-5 w-5 mx-auto mb-1.5 opacity-20" />
        <p className="text-xs text-muted-foreground">No activity yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Clock className="h-3.5 w-3.5" /> Activity Feed
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

      {timeline.length < total && (
        <Button
          variant="ghost"
          size="sm"
          className="w-full h-7 text-2xs gap-1"
          onClick={() => setLimit(l => l + 20)}
        >
          <ChevronDown className="h-3 w-3" /> Show more ({total - timeline.length} remaining)
        </Button>
      )}
    </div>
  );
}
