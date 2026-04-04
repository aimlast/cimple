/**
 * Analytics — broker-facing engagement dashboard
 *
 * Tabs: Overview · Buyer Activity · Section Engagement · Heat Map · Drop-off
 *
 * All heavy aggregation is done server-side via /analytics/computed.
 * recharts used for section bar chart and scroll-depth funnel.
 */
import { useState } from "react";
import {
  Card, CardContent, CardHeader, CardTitle, CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RTooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import {
  Eye, Clock, TrendingUp, Users, FileText, MousePointer,
  BarChart3, Calendar, Scroll, Building,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Deal, BuyerAccess } from "@shared/schema";

// ── Types ──────────────────────────────────────────────────────────────────
interface SectionEngagement {
  sectionKey: string;
  avgSeconds: number;
  totalSeconds: number;
  viewerCount: number;
}

interface BuyerBreakdown extends BuyerAccess {
  totalTimeSeconds: number;
  sectionsViewedCount: number;
  maxScrollDepth: number;
  questionCount: number;
}

interface HeatGrid {
  grid: number[][];
  cols: number;
  rows: number;
  total: number;
}

interface ComputedAnalytics {
  sectionEngagement: SectionEngagement[];
  buyerBreakdown: BuyerBreakdown[];
  heatGrid: HeatGrid;
  scrollDistribution: { pct: number; count: number }[];
  viewsByDay: Record<string, number>;
  totalEvents: number;
}

interface AnalyticsSummary {
  totalViews: number;
  uniqueBuyers: number;
  avgTimeSpent: number;
  totalTimeSpent: number;
  recentViews: { date: string; count: number }[];
}

// ── Helpers ────────────────────────────────────────────────────────────────
function fmt(s: number): string {
  if (!s) return "0s";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function fmtDate(d: string | Date | null): string {
  if (!d) return "Never";
  return new Date(d).toLocaleDateString();
}

const TEAL = "hsl(162 65% 38%)";

// ── Heat map cell ──────────────────────────────────────────────────────────
function HeatMapViz({ heatGrid }: { heatGrid: HeatGrid }) {
  const { grid, cols, rows, total } = heatGrid;
  const maxCell = Math.max(...grid.flat(), 1);

  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center text-muted-foreground">
        <MousePointer className="h-8 w-8 mb-3 opacity-30" />
        <p className="text-sm">No heat map data yet</p>
        <p className="text-xs mt-1">Mouse tracking will appear here after buyers view the CIM</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{total.toLocaleString()} mouse events recorded</p>
      <div
        className="w-full rounded-lg overflow-hidden border border-border"
        style={{ aspectRatio: `${cols / rows}` }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${cols}, 1fr)`,
            gridTemplateRows: `repeat(${rows}, 1fr)`,
            height: "100%",
          }}
        >
          {grid.map((row, ri) =>
            row.map((count, ci) => {
              const intensity = count / maxCell;
              return (
                <div
                  key={`${ri}-${ci}`}
                  title={`${count} events`}
                  style={{
                    backgroundColor:
                      intensity === 0
                        ? "transparent"
                        : `hsla(162, 65%, 38%, ${0.08 + intensity * 0.92})`,
                  }}
                />
              );
            })
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <div className="flex gap-0.5 items-center">
          {[0.1, 0.3, 0.5, 0.7, 0.9].map(v => (
            <div
              key={v}
              className="h-3 w-5 rounded-sm"
              style={{ backgroundColor: `hsla(162, 65%, 38%, ${v})` }}
            />
          ))}
        </div>
        <span>Low → High engagement</span>
      </div>
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────
export default function Analytics() {
  const [selectedDealId, setSelectedDealId] = useState<string>("all");

  const { data: deals, isLoading: dealsLoading } = useQuery<Deal[]>({
    queryKey: ["/api/deals"],
  });

  const { data: summary, isLoading: summaryLoading } = useQuery<AnalyticsSummary>({
    queryKey: ["/api/analytics/summary", selectedDealId],
    queryFn: async () => {
      const url = selectedDealId === "all"
        ? "/api/analytics/summary"
        : `/api/analytics/summary?dealId=${selectedDealId}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error();
      return res.json();
    },
  });

  const { data: computed, isLoading: computedLoading } = useQuery<ComputedAnalytics>({
    queryKey: ["/api/deals", selectedDealId, "analytics/computed"],
    enabled: selectedDealId !== "all",
    queryFn: async () => {
      const res = await fetch(`/api/deals/${selectedDealId}/analytics/computed`);
      if (!res.ok) throw new Error();
      return res.json();
    },
  });

  const selectedDeal = deals?.find(d => d.id === selectedDealId);
  const isLoading = dealsLoading || summaryLoading;

  // Recent views chart data from summary
  const recentViews = summary?.recentViews ?? [];
  const maxViews = Math.max(...recentViews.map(d => d.count), 1);

  return (
    <div className="px-6 pt-6 pb-12 max-w-7xl mx-auto space-y-6">

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Buyer engagement across shared CIMs
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedDealId} onValueChange={setSelectedDealId}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Select a CIM" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All CIMs</SelectItem>
              {deals?.map(d => (
                <SelectItem key={d.id} value={d.id}>
                  {d.businessName || `Deal ${d.id.slice(0, 8)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Deal banner */}
      {selectedDeal && (
        <Card className="bg-muted/20">
          <CardContent className="py-3 flex items-center gap-3">
            <Building className="h-7 w-7 text-muted-foreground/40 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="font-semibold text-sm truncate">{selectedDeal.businessName}</p>
              <p className="text-xs text-muted-foreground">
                {selectedDeal.industry || "Unknown industry"} · {selectedDeal.phase?.replace(/_/g, " ")}
              </p>
            </div>
            <Badge variant="outline" className="shrink-0 text-xs">
              {computed?.buyerBreakdown.length ?? 0} buyers
            </Badge>
          </CardContent>
        </Card>
      )}

      {/* ── Stat cards ────────────────────────────────────────────────────── */}
      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        {(
          [
            { label: "Total Views", value: summary?.totalViews ?? 0, icon: Eye, sub: "Document opens" },
            { label: "Unique Buyers", value: summary?.uniqueBuyers ?? 0, icon: Users, sub: "Who viewed the CIM" },
            { label: "Avg. Time", value: fmt(summary?.avgTimeSpent ?? 0), icon: Clock, sub: "Per session" },
            { label: "Total Time", value: fmt(summary?.totalTimeSpent ?? 0), icon: TrendingUp, sub: "All sessions" },
          ] as const
        ).map(({ label, value, icon: Icon, sub }) => (
          <Card key={label}>
            <CardHeader className="flex flex-row items-center justify-between pb-1 pt-4 px-4">
              <CardTitle className="text-xs font-medium text-muted-foreground">{label}</CardTitle>
              <Icon className="h-4 w-4 text-muted-foreground/40" />
            </CardHeader>
            <CardContent className="px-4 pb-4">
              {isLoading
                ? <Skeleton className="h-8 w-20" />
                : <div className="text-3xl font-bold tabular-nums leading-none">{value}</div>
              }
              <p className="text-xs text-muted-foreground mt-1">{sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* ── Tabs ─────────────────────────────────────────────────────────── */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="flex-wrap h-auto gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="buyers" disabled={selectedDealId === "all"}>
            Buyer Activity
          </TabsTrigger>
          <TabsTrigger value="sections" disabled={selectedDealId === "all"}>
            Section Engagement
          </TabsTrigger>
          <TabsTrigger value="heatmap" disabled={selectedDealId === "all"}>
            Heat Map
          </TabsTrigger>
          <TabsTrigger value="dropoff" disabled={selectedDealId === "all"}>
            Drop-off
          </TabsTrigger>
        </TabsList>

        {/* ── Overview ──────────────────────────────────────────────────────── */}
        <TabsContent value="overview" className="mt-6 space-y-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Views — Last 30 days</CardTitle>
            </CardHeader>
            <CardContent>
              {recentViews.length > 0 ? (
                <>
                  <div className="flex items-end gap-0.5 h-28">
                    {recentViews.map((day, i) => {
                      const h = (day.count / maxViews) * 100;
                      return (
                        <div
                          key={i}
                          className="flex-1 bg-teal/20 hover:bg-teal/40 transition-colors rounded-t cursor-default"
                          style={{ height: `${Math.max(h, 3)}%` }}
                          title={`${day.date}: ${day.count} views`}
                        />
                      );
                    })}
                  </div>
                  <div className="flex justify-between mt-1.5 text-[10px] text-muted-foreground">
                    <span>{recentViews[0]?.date}</span>
                    <span>{recentViews[recentViews.length - 1]?.date}</span>
                  </div>
                </>
              ) : (
                <div className="h-28 flex items-center justify-center text-center">
                  <div>
                    <BarChart3 className="h-7 w-7 mx-auto mb-2 opacity-20" />
                    <p className="text-xs text-muted-foreground">No views yet</p>
                  </div>
                </div>
              )}
            </CardContent>
          </Card>

          {selectedDealId === "all" && (
            <p className="text-xs text-muted-foreground text-center">
              Select a specific deal to see section engagement, heat map, and per-buyer breakdown.
            </p>
          )}
        </TabsContent>

        {/* ── Buyer Activity ────────────────────────────────────────────────── */}
        <TabsContent value="buyers" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Per-buyer breakdown</CardTitle>
              <CardDescription>Time spent, sections reached, scroll depth, questions asked</CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              {computedLoading ? (
                <div className="p-6 space-y-3">{[...Array(3)].map((_, i) => <Skeleton key={i} className="h-10" />)}</div>
              ) : (computed?.buyerBreakdown.length ?? 0) === 0 ? (
                <div className="py-12 text-center">
                  <Users className="h-8 w-8 mx-auto mb-3 opacity-20" />
                  <p className="text-sm text-muted-foreground">No buyers have viewed this CIM yet</p>
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Buyer</TableHead>
                      <TableHead className="text-right">Time</TableHead>
                      <TableHead className="text-right">Sections</TableHead>
                      <TableHead className="text-right">Scroll</TableHead>
                      <TableHead className="text-right">Questions</TableHead>
                      <TableHead>Last Seen</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {computed?.buyerBreakdown.map(b => (
                      <TableRow key={b.id}>
                        <TableCell>
                          <p className="text-sm font-medium">{b.buyerName || "Unknown"}</p>
                          <p className="text-xs text-muted-foreground">{b.buyerEmail}</p>
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-sm">
                          {fmt(b.totalTimeSeconds)}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {b.sectionsViewedCount}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {b.maxScrollDepth > 0 ? `${b.maxScrollDepth}%` : "—"}
                        </TableCell>
                        <TableCell className="text-right text-sm">
                          {b.questionCount > 0 ? b.questionCount : "—"}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {fmtDate(b.lastAccessedAt)}
                        </TableCell>
                        <TableCell>
                          {b.revokedAt ? (
                            <Badge variant="destructive" className="text-[10px]">Revoked</Badge>
                          ) : b.expiresAt && new Date(b.expiresAt) < new Date() ? (
                            <Badge variant="secondary" className="text-[10px]">Expired</Badge>
                          ) : (
                            <Badge variant="outline" className="text-[10px]">Active</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Section Engagement ────────────────────────────────────────────── */}
        <TabsContent value="sections" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Section engagement — avg time spent</CardTitle>
              <CardDescription>Based on section_exit events. Longer bars = buyers read more carefully.</CardDescription>
            </CardHeader>
            <CardContent>
              {computedLoading ? (
                <div className="space-y-3">{[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8" />)}</div>
              ) : (computed?.sectionEngagement.length ?? 0) === 0 ? (
                <div className="py-12 text-center">
                  <FileText className="h-8 w-8 mx-auto mb-3 opacity-20" />
                  <p className="text-sm text-muted-foreground">No section data yet</p>
                  <p className="text-xs text-muted-foreground mt-1">Section times appear after buyers view the CIM</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {computed?.sectionEngagement.map((s, i) => {
                    const max = computed.sectionEngagement[0]?.avgSeconds ?? 1;
                    const pct = (s.avgSeconds / max) * 100;
                    return (
                      <div key={s.sectionKey}>
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="font-medium truncate max-w-[60%]">
                            {s.sectionKey.replace(/([A-Z])/g, " $1").replace(/_/g, " ")}
                          </span>
                          <span className="text-muted-foreground tabular-nums">
                            {fmt(s.avgSeconds)} avg · {s.viewerCount} viewers
                          </span>
                        </div>
                        <div className="h-2 bg-muted rounded-full overflow-hidden">
                          <div
                            className="h-full rounded-full transition-all"
                            style={{ width: `${pct}%`, backgroundColor: TEAL, opacity: 0.7 + 0.3 * (1 - i / computed.sectionEngagement.length) }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Heat Map ──────────────────────────────────────────────────────── */}
        <TabsContent value="heatmap" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <MousePointer className="h-4 w-4" />
                Mouse heat map
              </CardTitle>
              <CardDescription>
                Aggregate of where buyers move their cursor. Bright areas = high attention.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {computedLoading
                ? <Skeleton className="w-full h-48" />
                : <HeatMapViz heatGrid={computed?.heatGrid ?? { grid: [], cols: 20, rows: 10, total: 0 }} />
              }
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── Drop-off ──────────────────────────────────────────────────────── */}
        <TabsContent value="dropoff" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm flex items-center gap-2">
                <Scroll className="h-4 w-4" />
                Scroll depth distribution
              </CardTitle>
              <CardDescription>
                How far into the CIM buyers scroll. Drop-off is where bars get shorter.
              </CardDescription>
            </CardHeader>
            <CardContent>
              {computedLoading ? (
                <Skeleton className="w-full h-48" />
              ) : (computed?.scrollDistribution.some(d => d.count > 0)) ? (
                <ResponsiveContainer width="100%" height={200}>
                  <BarChart data={computed!.scrollDistribution} barSize={20}>
                    <XAxis
                      dataKey="pct"
                      tickFormatter={v => `${v}%`}
                      tick={{ fontSize: 11 }}
                      axisLine={false}
                      tickLine={false}
                    />
                    <YAxis hide />
                    <RTooltip
                      formatter={(v: number) => [v, "sessions"]}
                      labelFormatter={l => `At ${l}% scroll`}
                      contentStyle={{ fontSize: 12, borderRadius: 6 }}
                    />
                    <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                      {computed!.scrollDistribution.map((entry, i) => (
                        <Cell
                          key={i}
                          fill={TEAL}
                          opacity={0.3 + 0.7 * (1 - i / computed!.scrollDistribution.length)}
                        />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              ) : (
                <div className="h-48 flex flex-col items-center justify-center text-center">
                  <Scroll className="h-8 w-8 mb-3 opacity-20" />
                  <p className="text-sm text-muted-foreground">No scroll data yet</p>
                </div>
              )}
              {computed && computed.scrollDistribution.some(d => d.count > 0) && (() => {
                const total = computed.scrollDistribution.reduce((s, d) => s + d.count, 0);
                const reached75 = computed.scrollDistribution
                  .filter(d => d.pct >= 75)
                  .reduce((s, d) => s + d.count, 0);
                return (
                  <p className="text-xs text-muted-foreground mt-3">
                    {total > 0
                      ? `${Math.round((reached75 / total) * 100)}% of sessions reached 75% scroll depth`
                      : ""}
                  </p>
                );
              })()}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
