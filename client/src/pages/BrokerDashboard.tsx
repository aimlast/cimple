import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  AlertCircle,
  ArrowRight,
  ArrowUpRight,
  Building2,
  ChevronDown,
  Clock,
  FileText,
  MessageSquare,
  Mic,
  Plus,
  ShieldCheck,
  TrendingUp,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";

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
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h`;
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

const ACTIVITY_ICONS: Record<string, typeof AlertCircle> = {
  buyer_view: Users,
  nda_signed: ShieldCheck,
  question_asked: MessageSquare,
  document_uploaded: FileText,
  approval_submitted: ShieldCheck,
  interview_completed: Mic,
};

/** Small-caps mono section label with hairline rule — the dashboard's spine. */
function SectionLabel({ children, badge }: { children: React.ReactNode; badge?: number }) {
  return (
    <div className="flex items-center gap-3 mb-4">
      <span className="font-mono text-2xs font-medium uppercase tracking-[0.18em] text-teal">
        {children}
      </span>
      {badge !== undefined && badge > 0 && (
        <span className="font-mono text-2xs px-1.5 py-0.5 rounded bg-teal-muted text-teal-muted-foreground">
          {badge}
        </span>
      )}
      <div className="h-px flex-1 bg-border/70" />
    </div>
  );
}

export default function BrokerDashboard() {
  const { data, isLoading, error } = useQuery<DashboardData>({
    queryKey: ["/api/broker/dashboard"],
    refetchInterval: 60_000,
  });
  const [showAllActions, setShowAllActions] = useState(false);

  if (isLoading) {
    return (
      <div className="p-6 md:p-10 max-w-[1200px] mx-auto space-y-8">
        <div className="h-9 w-64 bg-muted animate-pulse rounded" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border rounded-xl overflow-hidden">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 bg-card animate-pulse" />
          ))}
        </div>
        <div className="h-24 bg-card animate-pulse rounded-xl" />
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-8">
          <div className="lg:col-span-3 h-64 bg-card animate-pulse rounded-xl" />
          <div className="lg:col-span-2 h-64 bg-card animate-pulse rounded-xl" />
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

  type ActionRow = {
    key: string;
    icon: typeof AlertCircle;
    tint: "brass" | "amber" | "neutral";
    label: string;
    detail: string;
    href: string;
    time?: string;
  };

  const actionRows: ActionRow[] = [
    ...actions.pendingApprovals.map((a): ActionRow => ({
      key: `approval-${a.dealId}-${a.buyerName}`,
      icon: ShieldCheck,
      tint: "brass",
      label: "Buyer approval needed",
      detail: `${a.buyerName}${a.buyerCompany ? ` (${a.buyerCompany})` : ""} · ${a.dealName}`,
      href: `/deal/${a.dealId}/buyers`,
      time: a.submittedAt,
    })),
    ...actions.unansweredQuestions.map((q, i): ActionRow => ({
      key: `qa-${q.dealId}-${i}`,
      icon: MessageSquare,
      tint: "brass",
      label: "Q&A needs a response",
      detail: `"${q.questionPreview}" · ${q.dealName}`,
      href: `/deal/${q.dealId}/qa`,
      time: q.askedAt,
    })),
    ...actions.stalledInterviews.map((s): ActionRow => ({
      key: `stalled-${s.dealId}`,
      icon: Mic,
      tint: "amber",
      label: `Interview quiet for ${s.daysSinceActivity} days`,
      detail: s.dealName,
      href: `/deal/${s.dealId}/overview`,
      time: s.lastActivity,
    })),
    ...actions.pendingReviewCIMs.map((c): ActionRow => ({
      key: `cim-${c.dealId}`,
      icon: FileText,
      tint: "brass",
      label: "CIM ready for your review",
      detail: c.dealName,
      href: `/deal/${c.dealId}/overview`,
    })),
    ...actions.pendingDocuments.map((d): ActionRow => ({
      key: `docs-${d.dealId}`,
      icon: FileText,
      tint: "neutral",
      label: `${d.count} required ${d.count === 1 ? "document" : "documents"} missing`,
      detail: d.dealName,
      href: `/deal/${d.dealId}/overview`,
    })),
  ];

  const visibleActions = showAllActions ? actionRows : actionRows.slice(0, 6);
  const totalPipelineDeals = pipeline.reduce((n, p) => n + p.dealCount, 0);

  const today = new Date().toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  return (
    <div className="p-6 md:p-10 max-w-[1200px] mx-auto space-y-10">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="font-mono text-2xs uppercase tracking-[0.18em] text-muted-foreground/70 mb-2">
            {today}
          </p>
          <h1 className="text-[1.75rem] font-semibold tracking-tight leading-none">
            {greeting()}.
          </h1>
        </div>
        <Link href="/broker/new-deal">
          <Button className="gap-1.5 shadow-sm" data-testid="button-new-deal">
            <Plus className="h-4 w-4" /> New Deal
          </Button>
        </Link>
      </div>

      {/* ── Stats — one joined block, mono numerals ── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-px bg-border/70 rounded-xl overflow-hidden border border-border/70">
        <StatCell label="Active deals" value={stats.activeDeals.toString()} icon={Building2} />
        <StatCell label="Pipeline value" value={formatCurrency(stats.totalPipelineValue)} icon={TrendingUp} />
        <StatCell label="Avg days in phase" value={`${stats.avgDaysInPhase}`} suffix="days" icon={Clock} />
        <StatCell label="New buyers · 7d" value={stats.newBuyersThisWeek.toString()} icon={Users} />
      </div>

      {/* ── Pipeline funnel ── */}
      <section>
        <SectionLabel>Pipeline</SectionLabel>
        {totalPipelineDeals === 0 ? (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <p className="text-sm text-muted-foreground">
              No active deals yet — start your first one and the pipeline builds itself.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {/* Proportional segmented bar */}
            <div className="flex h-2.5 rounded-full overflow-hidden gap-px">
              {pipeline.map((p, i) => (
                <div
                  key={p.phase}
                  className="transition-all"
                  style={{
                    flexGrow: Math.max(p.dealCount, 0.35),
                    backgroundColor:
                      p.dealCount === 0
                        ? "hsl(var(--muted))"
                        : `hsl(var(--teal) / ${0.35 + 0.65 * ((i + 1) / pipeline.length)})`,
                  }}
                />
              ))}
            </div>
            {/* Phase cells */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {pipeline.map((p) => (
                <Link key={p.phase} href={`/broker/deals?phase=${p.phase}`}>
                  <div className="group rounded-lg px-3 py-2.5 -mx-1 hover:bg-accent/60 transition-colors cursor-pointer">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="font-mono text-xl font-medium tabular-nums">
                        {p.dealCount}
                      </span>
                      {p.totalAskingPrice > 0 && (
                        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                          {formatCurrency(p.totalAskingPrice)}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                      {p.label}
                      <ArrowUpRight className="h-3 w-3 opacity-0 group-hover:opacity-60 transition-opacity" />
                    </p>
                    {p.deals.length > 0 && (
                      <p className="text-2xs text-muted-foreground/60 truncate mt-1">
                        {p.deals
                          .slice(0, 2)
                          .map((d) => d.businessName)
                          .join(" · ")}
                        {p.deals.length > 2 ? ` +${p.deals.length - 2}` : ""}
                      </p>
                    )}
                  </div>
                </Link>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* ── Attention + Activity ── */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-10">
        {/* Needs attention (3/5) — one card, divided rows, capped */}
        <section className="lg:col-span-3">
          <SectionLabel badge={actionRows.length}>Needs your attention</SectionLabel>
          {actionRows.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-10 text-center">
              <p className="text-sm text-muted-foreground">
                All clear — nothing is waiting on you right now.
              </p>
            </div>
          ) : (
            <div className="rounded-xl border border-card-border bg-card overflow-hidden">
              {visibleActions.map((row, i) => (
                <Link key={row.key} href={row.href}>
                  <div
                    className={`flex items-center gap-3.5 px-4 py-3.5 hover:bg-accent/50 transition-colors cursor-pointer group ${
                      i > 0 ? "border-t border-border/60" : ""
                    }`}
                  >
                    <span
                      className={`flex h-8 w-8 items-center justify-center rounded-lg shrink-0 ${
                        row.tint === "amber"
                          ? "bg-amber-500/10 text-amber-500"
                          : row.tint === "neutral"
                            ? "bg-muted text-muted-foreground"
                            : "bg-teal-muted text-teal"
                      }`}
                    >
                      <row.icon className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-medium leading-snug">{row.label}</p>
                      <p className="text-xs text-muted-foreground truncate mt-0.5">
                        {row.detail}
                      </p>
                    </div>
                    {row.time && (
                      <span className="font-mono text-2xs text-muted-foreground/50 shrink-0 tabular-nums">
                        {timeAgo(row.time)}
                      </span>
                    )}
                    <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/25 group-hover:text-teal group-hover:translate-x-0.5 shrink-0 transition-all" />
                  </div>
                </Link>
              ))}
              {actionRows.length > 6 && (
                <button
                  onClick={() => setShowAllActions((v) => !v)}
                  className="w-full flex items-center justify-center gap-1.5 px-4 py-2.5 border-t border-border/60 text-xs text-muted-foreground hover:text-foreground hover:bg-accent/50 transition-colors"
                >
                  {showAllActions ? "Show fewer" : `Show all ${actionRows.length}`}
                  <ChevronDown
                    className={`h-3.5 w-3.5 transition-transform ${showAllActions ? "rotate-180" : ""}`}
                  />
                </button>
              )}
            </div>
          )}
        </section>

        {/* Activity (2/5) — quiet timeline, no boxes */}
        <section className="lg:col-span-2">
          <SectionLabel>Activity</SectionLabel>
          {activity.length === 0 ? (
            <p className="text-sm text-muted-foreground/70 px-1 py-6">
              Quiet for the last 48 hours.
            </p>
          ) : (
            <div className="relative pl-4">
              {/* timeline rail */}
              <div className="absolute left-[3px] top-2 bottom-2 w-px bg-border/70" />
              <div className="space-y-1">
                {activity.slice(0, 12).map((item, i) => {
                  const Icon = ACTIVITY_ICONS[item.type] || AlertCircle;
                  return (
                    <Link key={i} href={`/deal/${item.dealId}/overview`}>
                      <div className="relative flex items-start gap-3 px-2 py-2 rounded-lg hover:bg-accent/50 transition-colors cursor-pointer">
                        <span className="absolute -left-[14.5px] top-3 h-[7px] w-[7px] rounded-full bg-teal/60 ring-4 ring-background" />
                        <Icon className="h-3.5 w-3.5 text-muted-foreground/60 mt-0.5 shrink-0" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm leading-snug truncate">{item.description}</p>
                          <p className="font-mono text-2xs text-muted-foreground/60 mt-0.5">
                            {item.dealName} · {timeAgo(item.timestamp)} ago
                          </p>
                        </div>
                      </div>
                    </Link>
                  );
                })}
              </div>
              {activity.length > 12 && (
                <Link
                  href="/broker/analytics"
                  className="inline-block mt-2 px-2 text-xs text-teal hover:underline"
                >
                  View all activity
                </Link>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

/* Sub-components */

function StatCell({
  label,
  value,
  suffix,
  icon: Icon,
}: {
  label: string;
  value: string;
  suffix?: string;
  icon: typeof Building2;
}) {
  return (
    <div className="bg-card px-5 py-5 group relative">
      <div className="flex items-center justify-between mb-3">
        <p className="text-2xs uppercase tracking-[0.14em] text-muted-foreground/70 font-medium">
          {label}
        </p>
        <Icon className="h-3.5 w-3.5 text-muted-foreground/30" />
      </div>
      <p className="font-mono text-[1.75rem] font-medium leading-none tabular-nums">
        {value}
        {suffix && (
          <span className="text-sm text-muted-foreground/60 ml-1.5 font-sans">{suffix}</span>
        )}
      </p>
      {/* brass hairline that appears on hover — quiet signature detail */}
      <div className="absolute bottom-0 left-5 right-5 h-px bg-teal/0 group-hover:bg-teal/40 transition-colors" />
    </div>
  );
}
