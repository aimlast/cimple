import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  BarChart3,
  Clock,
  FileText,
  MessageSquare,
  Mic,
  ShieldCheck,
  TrendingUp,
  Users,
} from "lucide-react";

interface DashboardData {
  stats: {
    activeDeals: number;
    totalPipelineValue: number;
    avgDaysInPhase: number;
    newBuyersThisWeek: number;
  };
  pipeline: Array<{
    phase: string;
    label: string;
    dealCount: number;
    totalAskingPrice: number;
    deals: Array<{ id: string; businessName: string; industry: string; updatedAt: string }>;
  }>;
  actions: {
    pendingApprovals: Array<{ dealId: string; dealName: string; buyerName: string; buyerCompany: string | null; submittedAt: string }>;
    unansweredQuestions: Array<{ dealId: string; dealName: string; questionPreview: string; askedAt: string }>;
    stalledInterviews: Array<{ dealId: string; dealName: string; lastActivity: string; daysSinceActivity: number }>;
    pendingReviewCIMs: Array<{ dealId: string; dealName: string }>;
    pendingDocuments: Array<{ dealId: string; dealName: string; count: number }>;
  };
  activity: Array<{
    type: string;
    dealId: string;
    dealName: string;
    description: string;
    timestamp: string;
  }>;
}

function formatCurrency(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

const ACTIVITY_ICONS: Record<string, typeof AlertCircle> = {
  buyer_view: Users,
  nda_signed: ShieldCheck,
  question_asked: MessageSquare,
  document_uploaded: FileText,
  approval_submitted: ShieldCheck,
  interview_completed: Mic,
};

export default function BrokerDashboard() {
  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: ["/api/broker/dashboard"],
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="p-8 space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="grid grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-24 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
        <div className="grid grid-cols-2 gap-6">
          <div className="h-64 bg-muted animate-pulse rounded-lg" />
          <div className="h-64 bg-muted animate-pulse rounded-lg" />
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-8">
        <p className="text-destructive">Failed to load dashboard data.</p>
      </div>
    );
  }

  const { stats, pipeline, actions, activity } = data;
  const totalActions =
    actions.pendingApprovals.length +
    actions.unansweredQuestions.length +
    actions.stalledInterviews.length +
    actions.pendingReviewCIMs.length +
    actions.pendingDocuments.length;

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Your command center — what needs attention right now.
        </p>
      </div>

      {/* Quick Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Active Deals" value={stats.activeDeals.toString()} icon={BarChart3} />
        <StatCard label="Pipeline Value" value={formatCurrency(stats.totalPipelineValue)} icon={TrendingUp} />
        <StatCard label="Avg Days in Phase" value={`${stats.avgDaysInPhase}d`} icon={Clock} />
        <StatCard label="New Buyers (7d)" value={stats.newBuyersThisWeek.toString()} icon={Users} />
      </div>

      {/* Pipeline Snapshot */}
      <section>
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">Pipeline</h2>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {pipeline.map((p) => (
            <Link key={p.phase} href={`/broker/deals?phase=${p.phase}`}>
              <div className="rounded-lg border border-border bg-card p-4 hover:border-teal/40 hover:bg-teal/5 transition-colors cursor-pointer group">
                <p className="text-xs text-muted-foreground mb-1">{p.label}</p>
                <div className="flex items-baseline gap-2">
                  <span className="text-2xl font-semibold">{p.dealCount}</span>
                  <span className="text-xs text-muted-foreground">
                    {p.dealCount === 1 ? "deal" : "deals"}
                  </span>
                </div>
                {p.totalAskingPrice > 0 && (
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatCurrency(p.totalAskingPrice)}
                  </p>
                )}
                {p.deals.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {p.deals.slice(0, 3).map((d) => (
                      <p key={d.id} className="text-xs text-muted-foreground/80 truncate">
                        {d.businessName}
                      </p>
                    ))}
                    {p.deals.length > 3 && (
                      <p className="text-xs text-muted-foreground/60">+{p.deals.length - 3} more</p>
                    )}
                  </div>
                )}
              </div>
            </Link>
          ))}
        </div>
      </section>

      {/* Two-column: Actions + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Action Items (3/5) */}
        <section className="lg:col-span-3">
          <div className="flex items-center gap-2 mb-3">
            <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Action Items</h2>
            {totalActions > 0 && (
              <span className="inline-flex items-center justify-center rounded-full bg-teal/15 text-teal text-xs font-medium px-2 py-0.5">
                {totalActions}
              </span>
            )}
          </div>

          {totalActions === 0 ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-sm text-muted-foreground">You're all caught up — nothing needs attention right now.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {actions.pendingApprovals.map((a) => (
                <ActionItem
                  key={`approval-${a.dealId}-${a.buyerName}`}
                  icon={ShieldCheck}
                  label="Buyer approval needed"
                  detail={`${a.buyerName}${a.buyerCompany ? ` (${a.buyerCompany})` : ""} — ${a.dealName}`}
                  href={`/deal/${a.dealId}/buyers`}
                  time={a.submittedAt}
                />
              ))}

              {actions.unansweredQuestions.map((q, i) => (
                <ActionItem
                  key={`qa-${q.dealId}-${i}`}
                  icon={MessageSquare}
                  label="Q&A needs response"
                  detail={`"${q.questionPreview}" — ${q.dealName}`}
                  href={`/deal/${q.dealId}/qa`}
                  time={q.askedAt}
                />
              ))}

              {actions.stalledInterviews.map((s) => (
                <ActionItem
                  key={`stalled-${s.dealId}`}
                  icon={Mic}
                  label="Interview stalled"
                  detail={`${s.dealName} — no activity for ${s.daysSinceActivity} days`}
                  href={`/deal/${s.dealId}/overview`}
                  time={s.lastActivity}
                  variant="warning"
                />
              ))}

              {actions.pendingReviewCIMs.map((c) => (
                <ActionItem
                  key={`cim-${c.dealId}`}
                  icon={FileText}
                  label="CIM ready for review"
                  detail={c.dealName}
                  href={`/deal/${c.dealId}/overview`}
                />
              ))}

              {actions.pendingDocuments.map((d) => (
                <ActionItem
                  key={`docs-${d.dealId}`}
                  icon={FileText}
                  label="Documents needed"
                  detail={`${d.count} required ${d.count === 1 ? "document" : "documents"} missing — ${d.dealName}`}
                  href={`/deal/${d.dealId}/overview`}
                  variant="subtle"
                />
              ))}
            </div>
          )}
        </section>

        {/* Recent Activity (2/5) */}
        <section className="lg:col-span-2">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-3">Recent Activity</h2>
          {activity.length === 0 ? (
            <div className="rounded-lg border border-border bg-card p-8 text-center">
              <p className="text-sm text-muted-foreground">No activity in the last 48 hours.</p>
            </div>
          ) : (
            <div className="rounded-lg border border-border bg-card divide-y divide-border">
              {activity.map((item, i) => {
                const Icon = ACTIVITY_ICONS[item.type] || AlertCircle;
                return (
                  <Link key={i} href={`/deal/${item.dealId}/overview`}>
                    <div className="flex items-start gap-3 px-4 py-3 hover:bg-muted/50 transition-colors cursor-pointer">
                      <Icon className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
                      <div className="min-w-0 flex-1">
                        <p className="text-sm leading-snug truncate">{item.description}</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {item.dealName} · {timeAgo(item.timestamp)}
                        </p>
                      </div>
                    </div>
                  </Link>
                );
              })}
              {activity.length >= 20 && (
                <div className="px-4 py-2 text-center">
                  <Link href="/broker/analytics" className="text-xs text-teal hover:underline">
                    View all activity
                  </Link>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* Sub-components */

function StatCard({ label, value, icon: Icon }: { label: string; value: string; icon: typeof BarChart3 }) {
  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">{label}</p>
        <Icon className="h-4 w-4 text-muted-foreground/50" />
      </div>
      <p className="text-2xl font-semibold mt-1">{value}</p>
    </div>
  );
}

function ActionItem({
  icon: Icon,
  label,
  detail,
  href,
  time,
  variant = "default",
}: {
  icon: typeof AlertCircle;
  label: string;
  detail: string;
  href: string;
  time?: string;
  variant?: "default" | "warning" | "subtle";
}) {
  const borderColor =
    variant === "warning"
      ? "border-amber-500/30 bg-amber-500/5"
      : "border-border bg-card";

  return (
    <Link href={href}>
      <div
        className={`flex items-center gap-3 rounded-lg border px-4 py-3 hover:border-teal/40 hover:bg-teal/5 transition-colors cursor-pointer group ${borderColor}`}
      >
        <Icon
          className={`h-4 w-4 shrink-0 ${variant === "warning" ? "text-amber-500" : "text-teal/70"}`}
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium leading-snug">{label}</p>
          <p className="text-xs text-muted-foreground truncate mt-0.5">{detail}</p>
        </div>
        {time && <span className="text-2xs text-muted-foreground/60 shrink-0">{timeAgo(time)}</span>}
        <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/30 group-hover:text-teal/50 shrink-0 transition-colors" />
      </div>
    </Link>
  );
}
