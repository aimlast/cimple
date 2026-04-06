import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  CheckCircle2, Clock, Loader2, AlertCircle, FileText,
  TrendingUp, TrendingDown, Minus, DollarSign
} from "lucide-react";
import type { FinancialAnalysis } from "@shared/schema";

interface FinancialOverviewProps {
  analysis: FinancialAnalysis | null;
  dealId: string;
}

const STATUS_CONFIG: Record<string, { label: string; icon: React.ElementType; color: string; bg: string }> = {
  draft:     { label: "Draft",      icon: Clock,        color: "text-muted-foreground", bg: "bg-muted" },
  running:   { label: "Processing", icon: Loader2,      color: "text-amber-500",        bg: "bg-amber-500/10" },
  completed: { label: "Ready",      icon: CheckCircle2, color: "text-success",          bg: "bg-success/10" },
  failed:    { label: "Failed",     icon: AlertCircle,  color: "text-destructive",      bg: "bg-destructive/10" },
  reviewed:  { label: "Approved",   icon: CheckCircle2, color: "text-teal",             bg: "bg-teal/10" },
};

function formatCurrency(val: number | undefined | null): string {
  if (val == null) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(val);
}

function TrendIcon({ current, previous }: { current?: number; previous?: number }) {
  if (current == null || previous == null) return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
  if (current > previous) return <TrendingUp className="h-3.5 w-3.5 text-success" />;
  if (current < previous) return <TrendingDown className="h-3.5 w-3.5 text-destructive" />;
  return <Minus className="h-3.5 w-3.5 text-muted-foreground" />;
}

export function FinancialOverview({ analysis, dealId }: FinancialOverviewProps) {
  if (!analysis) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <DollarSign className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">No financial analysis yet</p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Run the analysis to reclassify financials, calculate SDE/EBITDA, and generate insights.
        </p>
      </div>
    );
  }

  const statusCfg = STATUS_CONFIG[analysis.status] || STATUS_CONFIG.draft;
  const StatusIcon = statusCfg.icon;

  // Extract key metrics from normalization data
  const normalization = analysis.normalization as {
    metric?: string;
    years?: Array<{ year: string; netIncome?: number; adjustedTotal?: number }>;
  } | null;

  const pnl = analysis.reclassifiedPnl as {
    years?: string[];
    rows?: Array<{ name: string; category: string; values: Record<string, number> }>;
  } | null;

  const wc = analysis.workingCapital as {
    netWorkingCapital?: number;
    pegAmount?: number;
  } | null;

  // Get revenue from P&L if available
  const years = pnl?.years || [];
  const latestYear = years[years.length - 1];
  const revenueRow = pnl?.rows?.find(r => r.category === "Revenue" || r.name?.toLowerCase().includes("revenue"));
  const latestRevenue = revenueRow && latestYear ? revenueRow.values?.[latestYear] : undefined;
  const prevRevenue = revenueRow && years.length > 1 ? revenueRow.values?.[years[years.length - 2]] : undefined;

  // Get SDE/EBITDA from normalization
  const normYears = normalization?.years || [];
  const latestNormYear = normYears[normYears.length - 1];
  const prevNormYear = normYears.length > 1 ? normYears[normYears.length - 2] : undefined;
  const latestAdjusted = latestNormYear?.adjustedTotal;
  const prevAdjusted = prevNormYear?.adjustedTotal;
  const metricLabel = normalization?.metric === "ebitda" ? "EBITDA" : "SDE";

  const sourceDocIds = (analysis.sourceDocumentIds as string[]) || [];

  return (
    <div className="space-y-4">
      {/* Status card */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Analysis Status</CardTitle>
            <Badge className={`${statusCfg.bg} ${statusCfg.color} border-0 gap-1.5`}>
              <StatusIcon className={`h-3 w-3 ${analysis.status === "running" ? "animate-spin" : ""}`} />
              {statusCfg.label}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">
            Version {analysis.version}
            {analysis.brokerReviewedAt && (
              <> &middot; Reviewed {new Date(analysis.brokerReviewedAt).toLocaleDateString()}</>
            )}
            {analysis.updatedAt && (
              <> &middot; Updated {new Date(analysis.updatedAt).toLocaleDateString()}</>
            )}
          </p>
        </CardContent>
      </Card>

      {/* Key metrics */}
      <div className="grid grid-cols-3 gap-3">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-2xs font-medium text-muted-foreground uppercase tracking-wider">Revenue</p>
              <TrendIcon current={latestRevenue} previous={prevRevenue} />
            </div>
            <p className="text-lg font-semibold">{formatCurrency(latestRevenue)}</p>
            {latestYear && (
              <p className="text-2xs text-muted-foreground mt-0.5">{latestYear}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-2xs font-medium text-muted-foreground uppercase tracking-wider">
                Adj. {metricLabel}
              </p>
              <TrendIcon current={latestAdjusted} previous={prevAdjusted} />
            </div>
            <p className="text-lg font-semibold">{formatCurrency(latestAdjusted)}</p>
            {latestNormYear?.year && (
              <p className="text-2xs text-muted-foreground mt-0.5">{latestNormYear.year}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between mb-1">
              <p className="text-2xs font-medium text-muted-foreground uppercase tracking-wider">Working Capital</p>
            </div>
            <p className="text-lg font-semibold">{formatCurrency(wc?.netWorkingCapital)}</p>
            {wc?.pegAmount != null && (
              <p className="text-2xs text-muted-foreground mt-0.5">Peg: {formatCurrency(wc.pegAmount)}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Source documents */}
      {sourceDocIds.length > 0 && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Source Documents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1.5">
              {sourceDocIds.map((docId, i) => (
                <div key={docId} className="flex items-center gap-2 text-xs text-muted-foreground">
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">Document {i + 1}</span>
                  <span className="text-2xs text-muted-foreground/50 ml-auto font-mono">{docId.slice(0, 8)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* AI reasoning */}
      {analysis.aiReasoning && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Analysis Approach</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-wrap">
              {analysis.aiReasoning}
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
