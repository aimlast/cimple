import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, AlertTriangle } from "lucide-react";

/* ──────────────────────────────────────────────
   Types
─────────────────────────────────────────────── */
export interface FinancialInsight {
  id: string;
  type: "positive" | "negative";
  title: string;
  detail: string;
  cimSection?: string;
}

export interface InsightsData {
  positive: FinancialInsight[];
  negative: FinancialInsight[];
}

interface InsightsPanelProps {
  data: InsightsData | null;
}

/* ──────────────────────────────────────────────
   CIM section labels
─────────────────────────────────────────────── */
const CIM_SECTION_LABELS: Record<string, string> = {
  executiveSummary: "Executive Summary",
  companyOverview: "Company Overview",
  historyMilestones: "History & Milestones",
  uniqueSellingPropositions: "Unique Selling Propositions",
  sourcesOfRevenue: "Sources of Revenue",
  growthStrategies: "Growth Strategies",
  targetMarket: "Target Market",
  financialOverview: "Financial Overview",
  transactionOverview: "Transaction Overview",
  employeeOverview: "Employee Overview",
  locationSite: "Location & Site",
  seasonality: "Seasonality",
  permitsLicenses: "Permits & Licenses",
};

/* ──────────────────────────────────────────────
   Component
─────────────────────────────────────────────── */
export function InsightsPanel({ data }: InsightsPanelProps) {
  if (!data || (data.positive.length === 0 && data.negative.length === 0)) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Financial Insights</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-8">
            No insights generated yet. Run the analysis to surface positive and negative findings.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <Card>
        <CardContent className="p-4">
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-3">
              <Badge className="bg-success/10 text-success border-0 gap-1 text-xs">
                <TrendingUp className="h-3 w-3" />
                {data.positive.length} positive
              </Badge>
              <Badge className="bg-amber-500/10 text-amber-400 border-0 gap-1 text-xs">
                <AlertTriangle className="h-3 w-3" />
                {data.negative.length} risk{data.negative.length !== 1 ? "s" : ""}
              </Badge>
            </div>
            <p className="text-2xs text-muted-foreground ml-auto">
              These insights will be used in CIM section drafting
            </p>
          </div>
        </CardContent>
      </Card>

      {/* Two-column layout */}
      <div className="grid grid-cols-2 gap-4">
        {/* Positive insights */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1 mb-1">
            <TrendingUp className="h-3.5 w-3.5 text-success" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Positive
            </p>
          </div>
          {data.positive.map(insight => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
          {data.positive.length === 0 && (
            <p className="text-xs text-muted-foreground/50 text-center py-4">None identified</p>
          )}
        </div>

        {/* Negative / risk insights */}
        <div className="space-y-2">
          <div className="flex items-center gap-2 px-1 mb-1">
            <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              Risks & Concerns
            </p>
          </div>
          {data.negative.map(insight => (
            <InsightCard key={insight.id} insight={insight} />
          ))}
          {data.negative.length === 0 && (
            <p className="text-xs text-muted-foreground/50 text-center py-4">None identified</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────
   Insight card sub-component
─────────────────────────────────────────────── */
function InsightCard({ insight }: { insight: FinancialInsight }) {
  const isPositive = insight.type === "positive";
  const borderColor = isPositive ? "border-success/20" : "border-amber-500/20";
  const accentBg = isPositive ? "bg-success/5" : "bg-amber-500/5";

  return (
    <Card className={`${borderColor} ${accentBg}`}>
      <CardContent className="p-3">
        <p className="text-xs font-medium mb-1">{insight.title}</p>
        <p className="text-2xs text-muted-foreground leading-relaxed">
          {insight.detail}
        </p>
        {insight.cimSection && (
          <Badge className="mt-2 bg-muted text-muted-foreground border-0 text-2xs">
            {CIM_SECTION_LABELS[insight.cimSection] || insight.cimSection}
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
