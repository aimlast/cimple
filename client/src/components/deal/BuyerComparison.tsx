/**
 * BuyerComparison — engagement scoring and side-by-side comparison
 *
 * Ranks buyers by composite engagement score and shows intent signals.
 * Helps brokers identify serious buyers vs tire-kickers.
 */
import { useQuery } from "@tanstack/react-query";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Users, TrendingUp, Eye, Clock, BookOpen, ArrowDown,
  MessageSquare, FileSignature, Flame,
} from "lucide-react";

interface BuyerScore {
  buyerId: string;
  buyerName: string;
  buyerEmail: string;
  status: "active" | "expired" | "revoked";
  ndaSigned: boolean;
  totalTimeSeconds: number;
  sectionsViewed: number;
  maxScrollDepth: number;
  questionCount: number;
  viewCount: number;
  engagementScore: number;
  intent: "high" | "medium" | "low" | "minimal";
  lastSeen: string | null;
  firstSeen: string | null;
}

function fmt(s: number): string {
  if (!s) return "0s";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

const INTENT_CONFIG = {
  high:    { label: "High intent",    color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" },
  medium:  { label: "Medium intent",  color: "bg-amber-500/15 text-amber-400 border-amber-500/30" },
  low:     { label: "Low intent",     color: "bg-muted text-muted-foreground border-border" },
  minimal: { label: "Minimal",        color: "bg-muted/50 text-muted-foreground/60 border-border" },
};

export function BuyerComparison({ dealId }: { dealId: string }) {
  const { data: scores, isLoading } = useQuery<BuyerScore[]>({
    queryKey: ["/api/deals", dealId, "analytics/buyer-scores"],
    queryFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/analytics/buyer-scores`);
      if (!res.ok) throw new Error();
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-28" />
        {[...Array(3)].map((_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
    );
  }

  if (!scores || scores.length === 0) {
    return (
      <div className="text-center py-4">
        <Users className="h-5 w-5 mx-auto mb-1.5 opacity-20" />
        <p className="text-xs text-muted-foreground">No buyer data yet</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Flame className="h-3.5 w-3.5" /> Buyer Engagement Ranking
      </p>

      <div className="space-y-2">
        {scores.map((buyer, rank) => {
          const intentCfg = INTENT_CONFIG[buyer.intent];
          return (
            <div
              key={buyer.buyerId}
              className="p-2.5 rounded-lg bg-card border border-border space-y-2"
            >
              {/* Header row */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-2xs font-bold text-muted-foreground/40 tabular-nums w-4">
                      #{rank + 1}
                    </span>
                    <p className="text-xs font-medium truncate">{buyer.buyerName}</p>
                  </div>
                  <p className="text-2xs text-muted-foreground ml-6 truncate">{buyer.buyerEmail}</p>
                </div>
                <Badge variant="outline" className={`shrink-0 text-2xs ${intentCfg.color}`}>
                  {intentCfg.label}
                </Badge>
              </div>

              {/* Score bar */}
              <div className="ml-6">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-2xs text-muted-foreground">Engagement</span>
                  <span className="text-2xs font-semibold tabular-nums">{buyer.engagementScore}/100</span>
                </div>
                <Progress
                  value={buyer.engagementScore}
                  className="h-1.5"
                />
              </div>

              {/* Metric chips */}
              <div className="ml-6 flex flex-wrap gap-1.5">
                <MetricChip icon={Eye} label={`${buyer.viewCount} view${buyer.viewCount !== 1 ? "s" : ""}`} />
                <MetricChip icon={Clock} label={fmt(buyer.totalTimeSeconds)} />
                <MetricChip icon={BookOpen} label={`${buyer.sectionsViewed} sections`} />
                <MetricChip icon={ArrowDown} label={`${buyer.maxScrollDepth}% scroll`} />
                {buyer.questionCount > 0 && (
                  <MetricChip icon={MessageSquare} label={`${buyer.questionCount} Q&A`} highlight />
                )}
                {buyer.ndaSigned && (
                  <MetricChip icon={FileSignature} label="NDA" highlight />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MetricChip({ icon: Icon, label, highlight }: { icon: typeof Eye; label: string; highlight?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded-full border ${
      highlight
        ? "bg-teal/10 text-teal border-teal/20"
        : "bg-muted/50 text-muted-foreground border-transparent"
    }`}>
      <Icon className="h-2.5 w-2.5" />
      {label}
    </span>
  );
}
