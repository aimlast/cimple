import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Progress } from "@/components/ui/progress";
import { 
  Download, 
  BarChart3, 
  Eye, 
  Clock, 
  TrendingUp, 
  Users,
  FileText,
  MousePointer,
  Scroll,
  Calendar,
  Building
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { Deal, BuyerAccess, AnalyticsEvent } from "@shared/schema";

interface AnalyticsSummary {
  totalViews: number;
  uniqueBuyers: number;
  avgTimeSpent: number;
  totalTimeSpent: number;
  recentViews: { date: string; count: number }[];
}

function formatTime(seconds: number): string {
  if (!seconds || seconds === 0) return "0s";
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  return `${Math.round(seconds / 3600)}h ${Math.round((seconds % 3600) / 60)}m`;
}

function formatDate(date: string | Date | null): string {
  if (!date) return "Never";
  return new Date(date).toLocaleDateString();
}

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
      if (!res.ok) throw new Error("Failed to fetch analytics");
      return res.json();
    },
  });

  const { data: buyers } = useQuery<BuyerAccess[]>({
    queryKey: ["/api/deals", selectedDealId, "buyers"],
    enabled: selectedDealId !== "all",
    queryFn: async () => {
      const res = await fetch(`/api/deals/${selectedDealId}/buyers`);
      if (!res.ok) throw new Error("Failed to fetch buyers");
      return res.json();
    },
  });

  const { data: events } = useQuery<AnalyticsEvent[]>({
    queryKey: ["/api/deals", selectedDealId, "analytics"],
    enabled: selectedDealId !== "all",
    queryFn: async () => {
      const res = await fetch(`/api/deals/${selectedDealId}/analytics`);
      if (!res.ok) throw new Error("Failed to fetch events");
      return res.json();
    },
  });

  const selectedDeal = deals?.find(d => d.id === selectedDealId);
  const isLoading = dealsLoading || summaryLoading;

  const pageViewsBySection = events?.reduce((acc, e) => {
    if (e.eventType === "page_view" && e.sectionKey) {
      acc[e.sectionKey] = (acc[e.sectionKey] || 0) + 1;
    }
    return acc;
  }, {} as Record<string, number>) || {};

  const totalPageViews = Object.values(pageViewsBySection).reduce((a, b) => a + b, 0);

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Analytics</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Track engagement and performance across shared CIMs
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Select value={selectedDealId} onValueChange={setSelectedDealId}>
            <SelectTrigger className="w-[250px]" data-testid="select-cim">
              <SelectValue placeholder="Select a CIM" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All CIMs</SelectItem>
              {deals?.map((deal) => (
                <SelectItem key={deal.id} value={deal.id}>
                  {deal.businessName || `Deal ${deal.id.slice(0, 8)}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" data-testid="button-export-analytics">
            <Download className="h-4 w-4 mr-2" />
            Export CSV
          </Button>
        </div>
      </div>

      {selectedDealId !== "all" && selectedDeal && (
        <Card className="bg-muted/30">
          <CardContent className="py-4">
            <div className="flex items-center gap-4">
              <Building className="h-8 w-8 text-muted-foreground" />
              <div>
                <h2 className="font-semibold">{selectedDeal.businessName || "Untitled Deal"}</h2>
                <p className="text-sm text-muted-foreground">
                  {selectedDeal.industry || "Industry not specified"} • Phase: {selectedDeal.phase || "Unknown"}
                </p>
              </div>
              <Badge variant="outline" className="ml-auto">
                {buyers?.length || 0} Buyers Invited
              </Badge>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Views</CardTitle>
            <Eye className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold" data-testid="stat-total-views">
                {summary?.totalViews || 0}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {selectedDealId === "all" ? "Across all CIMs" : "For this CIM"}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Unique Buyers</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold" data-testid="stat-unique-buyers">
                {summary?.uniqueBuyers || 0}
              </div>
            )}
            <p className="text-xs text-muted-foreground">Who viewed documents</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg. Time Spent</CardTitle>
            <Clock className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold" data-testid="stat-avg-time">
                {formatTime(summary?.avgTimeSpent || 0)}
              </div>
            )}
            <p className="text-xs text-muted-foreground">Per buyer session</p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Time</CardTitle>
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold" data-testid="stat-total-time">
                {formatTime(summary?.totalTimeSpent || 0)}
              </div>
            )}
            <p className="text-xs text-muted-foreground">All sessions combined</p>
          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="overview" className="w-full">
        <TabsList>
          <TabsTrigger value="overview" data-testid="tab-overview">Overview</TabsTrigger>
          <TabsTrigger value="buyers" data-testid="tab-buyers">Buyer Activity</TabsTrigger>
          <TabsTrigger value="sections" data-testid="tab-sections">Section Engagement</TabsTrigger>
          <TabsTrigger value="timeline" data-testid="tab-timeline">Timeline</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="mt-6 space-y-6">
          {summary?.recentViews && summary.recentViews.length > 0 ? (
            <Card>
              <CardHeader>
                <CardTitle>Recent Activity</CardTitle>
                <CardDescription>Views in the last 30 days</CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex items-end gap-1 h-32">
                  {summary.recentViews.map((day, i) => {
                    const maxCount = Math.max(...summary.recentViews.map(d => d.count));
                    const height = maxCount > 0 ? (day.count / maxCount) * 100 : 0;
                    return (
                      <div
                        key={i}
                        className="flex-1 bg-primary/20 hover:bg-primary/40 transition-colors rounded-t"
                        style={{ height: `${Math.max(height, 4)}%` }}
                        title={`${day.date}: ${day.count} views`}
                        data-testid={`chart-bar-${i}`}
                      />
                    );
                  })}
                </div>
                <div className="flex justify-between mt-2 text-xs text-muted-foreground">
                  <span>{summary.recentViews[0]?.date}</span>
                  <span>{summary.recentViews[summary.recentViews.length - 1]?.date}</span>
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardContent className="py-12 text-center">
                <BarChart3 className="h-12 w-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <p className="text-muted-foreground">No activity data yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  Share CIMs with buyers to start tracking engagement
                </p>
              </CardContent>
            </Card>
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <MousePointer className="h-4 w-4" />
                  Engagement Metrics
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Document Opens</span>
                  <span className="font-medium">{summary?.totalViews || 0}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Avg. Session Duration</span>
                  <span className="font-medium">{formatTime(summary?.avgTimeSpent || 0)}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Active Buyers</span>
                  <span className="font-medium">{summary?.uniqueBuyers || 0}</span>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Scroll className="h-4 w-4" />
                  Content Engagement
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm">Sections Viewed</span>
                  <span className="font-medium">{Object.keys(pageViewsBySection).length}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Total Page Views</span>
                  <span className="font-medium">{totalPageViews}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-sm">Download Attempts</span>
                  <span className="font-medium">
                    {events?.filter(e => e.eventType === "download_attempt").length || 0}
                  </span>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="buyers" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Buyer Activity</CardTitle>
              <CardDescription>
                {selectedDealId === "all" 
                  ? "Select a specific CIM to view buyer details" 
                  : "Track individual buyer engagement"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              {selectedDealId === "all" ? (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>Select a specific CIM to view buyer activity</p>
                </div>
              ) : buyers && buyers.length > 0 ? (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Buyer</TableHead>
                      <TableHead>Company</TableHead>
                      <TableHead>Views</TableHead>
                      <TableHead>Last Viewed</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {buyers.map((buyer) => (
                      <TableRow key={buyer.id} data-testid={`buyer-row-${buyer.id}`}>
                        <TableCell>
                          <div>
                            <p className="font-medium">{buyer.buyerName || "Unknown"}</p>
                            <p className="text-xs text-muted-foreground">{buyer.buyerEmail}</p>
                          </div>
                        </TableCell>
                        <TableCell>{buyer.buyerCompany || "-"}</TableCell>
                        <TableCell>{buyer.viewCount || 0}</TableCell>
                        <TableCell>{formatDate(buyer.lastAccessedAt)}</TableCell>
                        <TableCell>
                          {buyer.revokedAt ? (
                            <Badge variant="destructive">Revoked</Badge>
                          ) : buyer.expiresAt && new Date(buyer.expiresAt) < new Date() ? (
                            <Badge variant="secondary">Expired</Badge>
                          ) : (
                            <Badge variant="default">Active</Badge>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Users className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No buyers have been invited yet</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="sections" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Section Engagement</CardTitle>
              <CardDescription>See which sections buyers spend the most time on</CardDescription>
            </CardHeader>
            <CardContent>
              {Object.keys(pageViewsBySection).length > 0 ? (
                <div className="space-y-4">
                  {Object.entries(pageViewsBySection)
                    .sort(([, a], [, b]) => b - a)
                    .map(([section, count]) => (
                      <div key={section} className="space-y-2">
                        <div className="flex items-center justify-between text-sm">
                          <span className="capitalize">{section.replace(/_/g, " ")}</span>
                          <span className="text-muted-foreground">{count} views</span>
                        </div>
                        <Progress 
                          value={totalPageViews > 0 ? (count / totalPageViews) * 100 : 0} 
                          data-testid={`progress-${section}`}
                        />
                      </div>
                    ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <FileText className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No section data available yet</p>
                  <p className="text-xs mt-1">Section tracking requires buyer document views</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="timeline" className="mt-6">
          <Card>
            <CardHeader>
              <CardTitle>Activity Timeline</CardTitle>
              <CardDescription>Recent events and interactions</CardDescription>
            </CardHeader>
            <CardContent>
              {events && events.length > 0 ? (
                <div className="space-y-4">
                  {events.slice(0, 20).map((event, i) => (
                    <div key={event.id || i} className="flex items-start gap-4 pb-4 border-b last:border-0">
                      <div className="p-2 rounded-full bg-muted">
                        {event.eventType === "view" && <Eye className="h-4 w-4" />}
                        {event.eventType === "page_view" && <FileText className="h-4 w-4" />}
                        {event.eventType === "scroll" && <Scroll className="h-4 w-4" />}
                        {event.eventType === "time_on_page" && <Clock className="h-4 w-4" />}
                        {event.eventType === "download_attempt" && <Download className="h-4 w-4" />}
                      </div>
                      <div className="flex-1">
                        <p className="text-sm font-medium capitalize">
                          {event.eventType.replace(/_/g, " ")}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {event.sectionKey && `Section: ${event.sectionKey}`}
                          {event.timeSpentSeconds && ` • ${formatTime(event.timeSpentSeconds)}`}
                          {event.scrollDepthPercent && ` • ${event.scrollDepthPercent}% scrolled`}
                        </p>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <Calendar className="h-3 w-3 inline mr-1" />
                        {formatDate(event.createdAt)}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  <Calendar className="h-12 w-12 mx-auto mb-4 opacity-50" />
                  <p>No events recorded yet</p>
                  <p className="text-xs mt-1">Activity will appear here when buyers view CIMs</p>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card>
        <CardHeader>
          <CardTitle>CRM Integrations</CardTitle>
          <CardDescription>
            Connect your CRM to automatically sync engagement data
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            <Button variant="outline" disabled className="justify-start" data-testid="button-hubspot">
              <BarChart3 className="h-4 w-4 mr-2" />
              HubSpot
            </Button>
            <Button variant="outline" disabled className="justify-start" data-testid="button-salesforce">
              <BarChart3 className="h-4 w-4 mr-2" />
              Salesforce
            </Button>
            <Button variant="outline" disabled className="justify-start" data-testid="button-pipedrive">
              <BarChart3 className="h-4 w-4 mr-2" />
              Pipedrive
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-4">
            Integration setup coming soon
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
