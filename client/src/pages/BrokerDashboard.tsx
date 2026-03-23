import { FileText, Clock, CheckCircle, Share2, Plus, Eye, Activity, ChevronRight } from "lucide-react";
import { StatCard } from "@/components/StatCard";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Link, useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { Deal } from "@shared/schema";
import { format } from "date-fns";

const PHASE_LABELS: Record<string, string> = {
  phase1_info_collection: "Phase 1",
  phase2_platform_intake: "Phase 2",
  phase3_content_creation: "Phase 3",
  phase4_design_finalization: "Phase 4",
};

const PHASE_DESCRIPTIONS: Record<string, string> = {
  phase1_info_collection: "Info Collection",
  phase2_platform_intake: "Platform Intake",
  phase3_content_creation: "Content Creation",
  phase4_design_finalization: "Design & Final",
};

function getPhaseBadgeVariant(phase: string): "default" | "secondary" | "outline" {
  switch (phase) {
    case "phase1_info_collection":
      return "secondary";
    case "phase2_platform_intake":
      return "default";
    case "phase3_content_creation":
      return "default";
    case "phase4_design_finalization":
      return "default";
    default:
      return "outline";
  }
}

export default function BrokerDashboard() {
  const [, setLocation] = useLocation();
  
  const { data: allDeals = [], isLoading } = useQuery<Deal[]>({
    queryKey: ["/api/deals"],
  });

  const handleNewDeal = () => {
    setLocation("/new-deal");
  };

  const phase1Count = allDeals.filter(d => d.phase === "phase1_info_collection").length;
  const phase2Count = allDeals.filter(d => d.phase === "phase2_platform_intake").length;
  const phase3Count = allDeals.filter(d => d.phase === "phase3_content_creation").length;
  const phase4Count = allDeals.filter(d => d.phase === "phase4_design_finalization").length;
  const liveCount = allDeals.filter(d => d.isLive).length;

  const recentDeals = allDeals.slice(0, 5);

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Welcome back! Here's your deal portfolio overview.
          </p>
        </div>
        <Button onClick={handleNewDeal} data-testid="button-new-deal">
          <Plus className="h-4 w-4 mr-2" />
          New Deal
        </Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatCard
          title="Phase 1"
          value={phase1Count}
          icon={FileText}
          description="Info Collection"
        />
        <StatCard
          title="Phase 2"
          value={phase2Count}
          icon={Clock}
          description="Platform Intake"
        />
        <StatCard
          title="Phase 3"
          value={phase3Count}
          icon={Activity}
          description="Content Creation"
        />
        <StatCard
          title="Phase 4"
          value={phase4Count}
          icon={CheckCircle}
          description="Design & Final"
        />
        <StatCard
          title="Live"
          value={liveCount}
          icon={Share2}
          description="Shared with buyers"
        />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0 pb-4">
          <CardTitle>Deal Pipeline</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-between gap-2">
            <div className="flex-1 text-center p-4 rounded-lg bg-muted/50">
              <div className="text-3xl font-bold">{phase1Count}</div>
              <div className="text-xs text-muted-foreground mt-1">Info Collection</div>
              <div className="text-xs text-muted-foreground">Phase 1</div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 text-center p-4 rounded-lg bg-muted/50">
              <div className="text-3xl font-bold">{phase2Count}</div>
              <div className="text-xs text-muted-foreground mt-1">Platform Intake</div>
              <div className="text-xs text-muted-foreground">Phase 2</div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 text-center p-4 rounded-lg bg-muted/50">
              <div className="text-3xl font-bold">{phase3Count}</div>
              <div className="text-xs text-muted-foreground mt-1">Content</div>
              <div className="text-xs text-muted-foreground">Phase 3</div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 text-center p-4 rounded-lg bg-muted/50">
              <div className="text-3xl font-bold">{phase4Count}</div>
              <div className="text-xs text-muted-foreground mt-1">Design</div>
              <div className="text-xs text-muted-foreground">Phase 4</div>
            </div>
            <ChevronRight className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            <div className="flex-1 text-center p-4 rounded-lg bg-primary/10">
              <div className="text-3xl font-bold text-primary">{liveCount}</div>
              <div className="text-xs text-muted-foreground mt-1">Live</div>
              <div className="text-xs text-muted-foreground">Shared</div>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-4 space-y-0">
            <CardTitle className="flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Recent Deals
            </CardTitle>
            <Link href="/deals">
              <Button variant="ghost" size="sm" data-testid="link-view-all-deals">
                View All
              </Button>
            </Link>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="text-sm text-muted-foreground">Loading deals...</div>
            ) : recentDeals.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No deals yet. Click "New Deal" to get started.
              </div>
            ) : (
              <div className="space-y-3">
                {recentDeals.map((deal) => (
                  <Link key={deal.id} href={`/deal/${deal.id}`}>
                    <div 
                      className="flex items-center justify-between p-3 rounded-lg hover-elevate cursor-pointer border"
                      data-testid={`deal-row-${deal.id}`}
                    >
                      <div className="flex flex-col gap-1">
                        <span className="font-medium">{deal.businessName}</span>
                        <span className="text-xs text-muted-foreground">{deal.industry}</span>
                      </div>
                      <Badge variant={getPhaseBadgeVariant(deal.phase)}>
                        {PHASE_DESCRIPTIONS[deal.phase] || deal.phase}
                      </Badge>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Eye className="h-5 w-5" />
              Engagement Highlights
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Avg. buyer viewing time</span>
              <span className="font-semibold">-</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Most viewed sections</span>
              <span className="font-semibold">-</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-sm text-muted-foreground">Total document views</span>
              <span className="font-semibold">-</span>
            </div>
            <p className="text-xs text-muted-foreground pt-2">
              Analytics will populate when CIMs are shared with buyers
            </p>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
