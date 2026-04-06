/**
 * DealAnalyticsWidget — compact analytics summary embedded in DealDetail
 *
 * Shows key engagement metrics at a glance without leaving the deal page.
 * Links to the full Analytics page for deeper exploration.
 */
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Eye, Users, Clock, MessageSquare, FileSignature,
  ArrowRight, TrendingUp, Target,
} from "lucide-react";

interface DealSummary {
  totalViews: number;
  uniqueBuyers: number;
  avgTimePerBuyer: number;
  totalTime: number;
  totalQuestions: number;
  ndaSigned: number;
  completionRate: number;
  topSection: { key: string; seconds: number } | null;
  activeBuyers: number;
}

function fmt(s: number): string {
  if (!s) return "0s";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtSection(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/^\w/, c => c.toUpperCase())
    .trim();
}

export function DealAnalyticsWidget({ dealId, onNavigate }: { dealId: string; onNavigate?: () => void }) {
  const { data, isLoading } = useQuery<DealSummary>({
    queryKey: ["/api/deals", dealId, "analytics/summary"],
    queryFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/analytics/summary`);
      if (!res.ok) throw new Error();
      return res.json();
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-24" />
        <div className="grid grid-cols-2 gap-2">
          {[...Array(4)].map((_, i) => <Skeleton key={i} className="h-16" />)}
        </div>
      </div>
    );
  }

  if (!data || (data.totalViews === 0 && data.uniqueBuyers === 0)) {
    return (
      <div className="text-center py-6">
        <Eye className="h-6 w-6 mx-auto mb-2 opacity-20" />
        <p className="text-xs text-muted-foreground">No buyer activity yet</p>
        <p className="text-2xs text-muted-foreground/60 mt-0.5">Analytics appear once buyers view the CIM</p>
      </div>
    );
  }

  const metrics = [
    { icon: Eye, label: "Views", value: data.totalViews },
    { icon: Users, label: "Buyers", value: `${data.uniqueBuyers} (${data.activeBuyers} active)` },
    { icon: Clock, label: "Avg Time", value: fmt(data.avgTimePerBuyer) },
    { icon: FileSignature, label: "NDAs", value: data.ndaSigned },
    { icon: MessageSquare, label: "Questions", value: data.totalQuestions },
    { icon: Target, label: "Completion", value: `${data.completionRate}%` },
  ];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <TrendingUp className="h-3.5 w-3.5" /> Buyer Engagement
        </p>
        {onNavigate && (
          <Button variant="ghost" size="sm" className="h-6 text-2xs gap-1 px-2" onClick={onNavigate}>
            Full analytics <ArrowRight className="h-3 w-3" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-1.5">
        {metrics.map(({ icon: Icon, label, value }) => (
          <div key={label} className="p-2 rounded-md bg-card border border-border text-center">
            <Icon className="h-3 w-3 mx-auto mb-1 text-muted-foreground/50" />
            <p className="text-sm font-semibold tabular-nums leading-none">{value}</p>
            <p className="text-2xs text-muted-foreground mt-0.5">{label}</p>
          </div>
        ))}
      </div>

      {data.topSection && (
        <div className="flex items-center gap-2 px-2 py-1.5 rounded bg-muted/30 text-2xs text-muted-foreground">
          <span>Most engaged:</span>
          <Badge variant="outline" className="text-2xs h-5">{fmtSection(data.topSection.key)}</Badge>
          <span className="ml-auto tabular-nums">{fmt(data.topSection.seconds)} total</span>
        </div>
      )}
    </div>
  );
}
