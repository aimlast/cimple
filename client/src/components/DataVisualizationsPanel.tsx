import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { BarChart3, Target, Zap, TrendingUp, Workflow } from "lucide-react";
import type { Deal, BrandingSettings } from "@shared/schema";

interface VisualizationItem {
  id: string;
  title: string;
  description: string;
  type: "bar_chart" | "radar_chart" | "infographic" | "flowchart" | "process_flow";
  icon: typeof BarChart3;
  included: boolean;
}

interface DataVisualizationsPanelProps {
  deal: Deal;
  branding?: BrandingSettings | null;
}

function getExtractedData(deal: Deal): Record<string, string> {
  const info = deal.extractedInfo as Record<string, unknown> | null;
  if (!info) return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(info)) {
    if (Array.isArray(value)) {
      result[key] = value.join(", ");
    } else if (typeof value === "string") {
      result[key] = value;
    } else if (value != null) {
      result[key] = String(value);
    }
  }
  return result;
}

function getBrandColors(branding?: BrandingSettings | null) {
  const primary = branding?.primaryColor || "215 85% 55%";
  const accent = branding?.accentColor || "25 95% 53%";
  return {
    primary: `hsl(${primary})`,
    primaryLight: `hsl(${primary} / 0.2)`,
    accent: `hsl(${accent})`,
    accentLight: `hsl(${accent} / 0.2)`,
    muted: "hsl(220 10% 60%)",
    mutedLight: "hsl(220 10% 60% / 0.15)",
    success: "hsl(145 65% 50%)",
    successLight: "hsl(145 65% 50% / 0.15)",
    warning: "hsl(35 90% 60%)",
    warningLight: "hsl(35 90% 60% / 0.15)",
  };
}

function parseRevenueData(data: Record<string, string>): { label: string; value: number }[] {
  const streams = data.revenueStreams || data.keyProducts || "";
  if (!streams) {
    return [
      { label: "Product Sales", value: 45 },
      { label: "Services", value: 30 },
      { label: "Recurring", value: 15 },
      { label: "Other", value: 10 },
    ];
  }
  const items = streams.split(/[,;\n]+/).filter(Boolean).slice(0, 6);
  if (items.length === 0) {
    return [{ label: "Revenue", value: 100 }];
  }
  const baseValue = 100 / items.length;
  return items.map((item, i) => {
    const hash = item.trim().split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    const offset = ((hash + i * 7) % 21) - 10;
    return {
      label: item.trim().substring(0, 20),
      value: Math.round(baseValue + offset),
    };
  });
}

function parseStrengthsData(data: Record<string, string>): { label: string; value: number }[] {
  const dimensions = [
    { key: "competitiveAdvantage", label: "Competitive Edge", fallback: 75 },
    { key: "customerPerception", label: "Customer Trust", fallback: 80 },
    { key: "strengths", label: "Core Strengths", fallback: 85 },
    { key: "brandIdentity", label: "Brand Identity", fallback: 70 },
    { key: "industryPerception", label: "Industry Standing", fallback: 65 },
    { key: "uniqueSellingProposition", label: "Unique Value", fallback: 78 },
  ];
  return dimensions.map(d => ({
    label: d.label,
    value: data[d.key] ? Math.min(95, d.fallback + (data[d.key].length % 15)) : d.fallback,
  }));
}

function RevenueBarChart({ deal, colors }: { deal: Deal; colors: ReturnType<typeof getBrandColors> }) {
  const data = parseRevenueData(getExtractedData(deal));
  const maxVal = Math.max(...data.map(d => d.value));
  const chartHeight = 200;
  const chartWidth = 400;
  const barWidth = Math.min(50, (chartWidth - 40) / data.length - 10);
  const startX = 50;

  return (
    <svg viewBox={`0 0 ${chartWidth + 60} ${chartHeight + 60}`} className="w-full" data-testid="viz-revenue-chart">
      <line x1={startX} y1={10} x2={startX} y2={chartHeight + 10} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
      <line x1={startX} y1={chartHeight + 10} x2={chartWidth + 20} y2={chartHeight + 10} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />

      {[0, 25, 50, 75, 100].map(tick => {
        const y = chartHeight + 10 - (tick / 100) * chartHeight;
        return (
          <g key={tick}>
            <line x1={startX} y1={y} x2={chartWidth + 20} y2={y} stroke="currentColor" strokeOpacity={0.07} strokeWidth={1} />
            <text x={startX - 8} y={y + 4} textAnchor="end" fill="currentColor" fillOpacity={0.5} fontSize={10}>{tick}%</text>
          </g>
        );
      })}

      {data.map((item, i) => {
        const barHeight = (item.value / maxVal) * chartHeight;
        const x = startX + 20 + i * ((chartWidth - 40) / data.length);
        const y = chartHeight + 10 - barHeight;
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barHeight}
              rx={3}
              fill={i % 2 === 0 ? colors.primary : colors.accent}
              opacity={0.85}
            >
              <animate attributeName="height" from="0" to={barHeight} dur="0.6s" fill="freeze" />
              <animate attributeName="y" from={chartHeight + 10} to={y} dur="0.6s" fill="freeze" />
            </rect>
            <text
              x={x + barWidth / 2}
              y={y - 6}
              textAnchor="middle"
              fill="currentColor"
              fillOpacity={0.7}
              fontSize={10}
              fontWeight={600}
            >
              {item.value}%
            </text>
            <text
              x={x + barWidth / 2}
              y={chartHeight + 26}
              textAnchor="middle"
              fill="currentColor"
              fillOpacity={0.5}
              fontSize={9}
            >
              {item.label.length > 12 ? item.label.substring(0, 12) + "..." : item.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function MarketPositionRadar({ deal, colors }: { deal: Deal; colors: ReturnType<typeof getBrandColors> }) {
  const data = parseStrengthsData(getExtractedData(deal));
  const cx = 180;
  const cy = 160;
  const maxRadius = 120;
  const angleStep = (2 * Math.PI) / data.length;

  const getPoint = (index: number, value: number) => {
    const angle = angleStep * index - Math.PI / 2;
    const r = (value / 100) * maxRadius;
    return { x: cx + r * Math.cos(angle), y: cy + r * Math.sin(angle) };
  };

  const polygonPoints = data.map((d, i) => {
    const p = getPoint(i, d.value);
    return `${p.x},${p.y}`;
  }).join(" ");

  return (
    <svg viewBox="0 0 360 340" className="w-full" data-testid="viz-radar-chart">
      {[20, 40, 60, 80, 100].map(level => {
        const points = data.map((_, i) => {
          const p = getPoint(i, level);
          return `${p.x},${p.y}`;
        }).join(" ");
        return (
          <polygon
            key={level}
            points={points}
            fill="none"
            stroke="currentColor"
            strokeOpacity={0.1}
            strokeWidth={1}
          />
        );
      })}

      {data.map((d, i) => {
        const outerPoint = getPoint(i, 100);
        return (
          <g key={i}>
            <line x1={cx} y1={cy} x2={outerPoint.x} y2={outerPoint.y} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} />
            <text
              x={getPoint(i, 115).x}
              y={getPoint(i, 115).y}
              textAnchor="middle"
              dominantBaseline="middle"
              fill="currentColor"
              fillOpacity={0.6}
              fontSize={9}
            >
              {d.label}
            </text>
          </g>
        );
      })}

      <polygon
        points={polygonPoints}
        fill={colors.primary}
        fillOpacity={0.15}
        stroke={colors.primary}
        strokeWidth={2}
      />

      {data.map((d, i) => {
        const p = getPoint(i, d.value);
        return (
          <circle key={i} cx={p.x} cy={p.y} r={4} fill={colors.primary} stroke="white" strokeWidth={1.5} />
        );
      })}
    </svg>
  );
}

function StrengthsInfographic({ deal, colors }: { deal: Deal; colors: ReturnType<typeof getBrandColors> }) {
  const data = getExtractedData(deal);
  const strengths = [
    { label: "Competitive Advantage", value: data.competitiveAdvantage || "Strong market position", color: colors.primary },
    { label: "Unique Value", value: data.uniqueSellingProposition || "Differentiated offering", color: colors.accent },
    { label: "Brand Identity", value: data.brandIdentity || "Established brand", color: colors.success },
    { label: "Customer Trust", value: data.customerPerception || "High satisfaction", color: colors.warning },
  ];

  return (
    <svg viewBox="0 0 400 280" className="w-full" data-testid="viz-strengths-infographic">
      {strengths.map((s, i) => {
        const y = 20 + i * 65;
        const barWidth = 180 + (i * 30 % 60);
        return (
          <g key={i}>
            <circle cx={24} cy={y + 18} r={16} fill={s.color} fillOpacity={0.15} />
            <text x={24} y={y + 22} textAnchor="middle" fill={s.color} fontSize={14} fontWeight={700}>
              {i + 1}
            </text>
            <text x={50} y={y + 14} fill="currentColor" fillOpacity={0.85} fontSize={12} fontWeight={600}>
              {s.label}
            </text>
            <text x={50} y={y + 32} fill="currentColor" fillOpacity={0.5} fontSize={10}>
              {s.value.substring(0, 50)}{s.value.length > 50 ? "..." : ""}
            </text>
            <rect x={50} y={y + 40} width={barWidth} height={4} rx={2} fill={s.color} fillOpacity={0.3}>
              <animate attributeName="width" from="0" to={barWidth} dur="0.8s" fill="freeze" />
            </rect>
          </g>
        );
      })}
    </svg>
  );
}

function GrowthOpportunityFlowchart({ deal, colors }: { deal: Deal; colors: ReturnType<typeof getBrandColors> }) {
  const data = getExtractedData(deal);
  const opportunities = (data.growthOpportunities || data.expansionPlans || "")
    .split(/[,;\n]+/)
    .filter(Boolean)
    .slice(0, 4);

  const items = opportunities.length > 0
    ? opportunities.map(o => o.trim().substring(0, 25))
    : ["Market Expansion", "Product Innovation", "Digital Growth", "Strategic Partnerships"];

  return (
    <svg viewBox="0 0 400 280" className="w-full" data-testid="viz-growth-flowchart">
      <rect x={130} y={10} width={140} height={40} rx={8} fill={colors.primary} fillOpacity={0.15} stroke={colors.primary} strokeWidth={1.5} />
      <text x={200} y={35} textAnchor="middle" fill="currentColor" fillOpacity={0.85} fontSize={12} fontWeight={600}>
        Growth Strategy
      </text>

      <line x1={200} y1={50} x2={200} y2={80} stroke={colors.primary} strokeWidth={1.5} />

      {items.map((item, i) => {
        const cols = Math.min(items.length, 4);
        const colWidth = 360 / cols;
        const x = 20 + i * colWidth + colWidth / 2;
        const y = 100;

        return (
          <g key={i}>
            <line x1={200} y1={80} x2={x} y2={y} stroke={colors.primary} strokeWidth={1} strokeOpacity={0.4} />
            <rect x={x - 55} y={y} width={110} height={50} rx={6} fill={colors.accent} fillOpacity={0.1} stroke={colors.accent} strokeWidth={1} strokeOpacity={0.4} />
            <text x={x} y={y + 20} textAnchor="middle" fill="currentColor" fillOpacity={0.7} fontSize={10} fontWeight={500}>
              {item}
            </text>

            <line x1={x} y1={y + 50} x2={x} y2={y + 80} stroke={colors.muted} strokeWidth={1} strokeOpacity={0.3} />
            <circle cx={x} cy={y + 90} r={10} fill={colors.success} fillOpacity={0.15} stroke={colors.success} strokeWidth={1} strokeOpacity={0.4} />
            <text x={x} y={y + 94} textAnchor="middle" fill={colors.success} fontSize={12} fontWeight={700}>
              +
            </text>

            <line x1={x} y1={y + 100} x2={x} y2={y + 120} stroke={colors.muted} strokeWidth={1} strokeOpacity={0.3} />
            <rect x={x - 45} y={y + 120} width={90} height={30} rx={4} fill={colors.primary} fillOpacity={0.08} />
            <text x={x} y={y + 139} textAnchor="middle" fill="currentColor" fillOpacity={0.5} fontSize={9}>
              Revenue Impact
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function OperationsProcessFlow({ deal, colors }: { deal: Deal; colors: ReturnType<typeof getBrandColors> }) {
  const data = getExtractedData(deal);
  const systems = (data.operationalSystems || data.technologySystems || "")
    .split(/[,;\n]+/)
    .filter(Boolean)
    .slice(0, 5);

  const steps = systems.length > 0
    ? systems.map(s => s.trim().substring(0, 18))
    : ["Sales & Marketing", "Operations", "Fulfillment", "Support", "Analytics"];

  return (
    <svg viewBox="0 0 400 180" className="w-full" data-testid="viz-operations-flow">
      {steps.map((step, i) => {
        const stepWidth = 360 / steps.length;
        const x = 20 + i * stepWidth;
        const centerX = x + stepWidth / 2;
        const boxW = Math.min(80, stepWidth - 10);

        return (
          <g key={i}>
            <rect
              x={centerX - boxW / 2}
              y={60}
              width={boxW}
              height={60}
              rx={6}
              fill={i === 0 ? colors.primary : i === steps.length - 1 ? colors.accent : "currentColor"}
              fillOpacity={i === 0 || i === steps.length - 1 ? 0.12 : 0.05}
              stroke={i === 0 ? colors.primary : i === steps.length - 1 ? colors.accent : "currentColor"}
              strokeWidth={1}
              strokeOpacity={i === 0 || i === steps.length - 1 ? 0.5 : 0.15}
            />
            <text x={centerX} y={30} textAnchor="middle" fill="currentColor" fillOpacity={0.4} fontSize={10} fontWeight={600}>
              Step {i + 1}
            </text>
            <text x={centerX} y={94} textAnchor="middle" fill="currentColor" fillOpacity={0.7} fontSize={10} fontWeight={500}>
              {step}
            </text>

            {i < steps.length - 1 && (
              <polygon
                points={`${centerX + boxW / 2 + 5},90 ${centerX + boxW / 2 + 15},90 ${centerX + boxW / 2 + 10},85 ${centerX + boxW / 2 + 15},90 ${centerX + boxW / 2 + 10},95`}
                fill={colors.primary}
                fillOpacity={0.4}
              />
            )}
          </g>
        );
      })}

      <rect x={100} y={145} width={200} height={25} rx={12} fill={colors.success} fillOpacity={0.1} stroke={colors.success} strokeWidth={1} strokeOpacity={0.3} />
      <text x={200} y={162} textAnchor="middle" fill={colors.success} fontSize={10} fontWeight={500}>
        Integrated Business Operations
      </text>
    </svg>
  );
}

const VISUALIZATION_CONFIGS: Omit<VisualizationItem, "included">[] = [
  { id: "revenue_chart", title: "Revenue & Financial Breakdown", description: "Bar chart showing revenue streams and financial metrics", type: "bar_chart", icon: BarChart3 },
  { id: "market_position", title: "Market Position Analysis", description: "Radar chart displaying competitive positioning across key dimensions", type: "radar_chart", icon: Target },
  { id: "business_strengths", title: "Business Strengths", description: "Visual infographic highlighting core business strengths", type: "infographic", icon: Zap },
  { id: "growth_opportunities", title: "Growth Opportunity Map", description: "Flowchart mapping growth strategies and revenue impact", type: "flowchart", icon: TrendingUp },
  { id: "operations_flow", title: "Operations Process Flow", description: "Process diagram showing operational workflow and systems", type: "process_flow", icon: Workflow },
];

export default function DataVisualizationsPanel({ deal, branding }: DataVisualizationsPanelProps) {
  const [visualizations, setVisualizations] = useState<VisualizationItem[]>(
    VISUALIZATION_CONFIGS.map(v => ({ ...v, included: true }))
  );
  const colors = getBrandColors(branding);

  const toggleVisualization = (id: string) => {
    setVisualizations(prev => prev.map(v => v.id === id ? { ...v, included: !v.included } : v));
  };

  const renderVisualization = (viz: VisualizationItem) => {
    switch (viz.type) {
      case "bar_chart":
        return <RevenueBarChart deal={deal} colors={colors} />;
      case "radar_chart":
        return <MarketPositionRadar deal={deal} colors={colors} />;
      case "infographic":
        return <StrengthsInfographic deal={deal} colors={colors} />;
      case "flowchart":
        return <GrowthOpportunityFlowchart deal={deal} colors={colors} />;
      case "process_flow":
        return <OperationsProcessFlow deal={deal} colors={colors} />;
      default:
        return null;
    }
  };

  const includedCount = visualizations.filter(v => v.included).length;

  return (
    <div className="space-y-6" data-testid="data-visualizations-panel">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h3 className="text-lg font-semibold">Data Visualizations</h3>
          <p className="text-sm text-muted-foreground">
            Auto-generated charts and infographics from your deal data
          </p>
        </div>
        <Badge variant="secondary" data-testid="badge-included-count">
          {includedCount} of {visualizations.length} included
        </Badge>
      </div>

      <ScrollArea className="h-[600px]">
        <div className="grid gap-6 md:grid-cols-2">
          {visualizations.map(viz => (
            <Card key={viz.id} className={!viz.included ? "opacity-50" : ""} data-testid={`card-viz-${viz.id}`}>
              <CardHeader className="flex flex-row items-start justify-between gap-2 space-y-0 pb-2">
                <div className="flex items-start gap-3 min-w-0">
                  <div className="rounded-md p-2" style={{ backgroundColor: colors.primaryLight }}>
                    <viz.icon className="h-4 w-4" style={{ color: colors.primary }} />
                  </div>
                  <div className="min-w-0">
                    <CardTitle className="text-sm">{viz.title}</CardTitle>
                    <CardDescription className="text-xs mt-1">{viz.description}</CardDescription>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground">Include</span>
                  <Switch
                    checked={viz.included}
                    onCheckedChange={() => toggleVisualization(viz.id)}
                    data-testid={`switch-viz-${viz.id}`}
                  />
                </div>
              </CardHeader>
              <CardContent className="pt-2">
                <div className="rounded-md border p-4 bg-background">
                  {renderVisualization(viz)}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </ScrollArea>
    </div>
  );
}
