import { useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Plus, Search, ArrowRight, Clock, AlertCircle, CheckCircle2, Zap, Radio, X, RefreshCw, Building2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { formatDistanceToNow } from "date-fns";
import type { Deal } from "@shared/schema";

/* ─── Phase metadata ─── */
const PHASES = [
  { key: "phase1_info_collection",    short: "Phase 1", label: "Info Collection"  },
  { key: "phase2_platform_intake",    short: "Phase 2", label: "Platform Intake"  },
  { key: "phase3_content_creation",   short: "Phase 3", label: "Content Creation" },
  { key: "phase4_design_finalization", short: "Phase 4", label: "Design & Final"  },
];

/* ─── Derive deal urgency + contextual line ─── */
type DealUrgency = "action" | "progress" | "waiting" | "live";

/**
 * CTA labels use navigation phrasing ("Open to publish") and each one links
 * to the surface where that action actually lives — the card never pretends
 * to perform the action itself.
 */
interface DealMeta {
  urgency: DealUrgency;
  statusLine: string;
  cta: { label: string; href: string };
}

function getDealMeta(deal: Deal): DealMeta {
  const overview = `/deal/${deal.id}/overview`;
  const designer = `/deal/${deal.id}/design`;
  const interview = `/deal/${deal.id}/interview`;
  const buyers = `/deal/${deal.id}/buyers`;

  if (deal.isLive) {
    return { urgency: "live", statusLine: "Live — shared with buyers", cta: { label: "Open buyers", href: buyers } };
  }
  const lastActivity = deal.updatedAt
    ? formatDistanceToNow(new Date(deal.updatedAt), { addSuffix: true })
    : "recently";

  switch (deal.phase) {
    case "phase1_info_collection": {
      if (!deal.ndaSigned) return { urgency: "action",   statusLine: "NDA not yet signed",                        cta: { label: "Open deal", href: overview } };
      if (!deal.sqCompleted) return { urgency: "waiting", statusLine: `Awaiting questionnaire · ${lastActivity}`, cta: { label: "Open deal", href: overview } };
      if (!deal.valuationCompleted) return { urgency: "action", statusLine: "Valuation pending",                  cta: { label: "Open deal", href: overview } };
      return { urgency: "action", statusLine: "Phase 1 complete — advance to intake",                             cta: { label: "Open to advance", href: overview } };
    }
    case "phase2_platform_intake": {
      if (!deal.interviewCompleted) return { urgency: "action",   statusLine: "AI interview not started",         cta: { label: "Start interview", href: interview } };
      return { urgency: "progress", statusLine: `Interview complete · ${lastActivity}`,                           cta: { label: "Open deal", href: overview } };
    }
    case "phase3_content_creation": {
      if (!deal.cimContent) return { urgency: "action",           statusLine: "CIM content not yet generated",    cta: { label: "Open to generate", href: overview } };
      if (!deal.contentApprovedByBroker) return { urgency: "action", statusLine: "Awaiting your review",          cta: { label: "Open to review", href: overview } };
      if (!deal.contentApprovedBySeller) return { urgency: "waiting", statusLine: `Awaiting seller approval · ${lastActivity}`, cta: { label: "Open deal", href: overview } };
      return { urgency: "progress", statusLine: "Content approved — ready for design",                            cta: { label: "Open designer", href: designer } };
    }
    case "phase4_design_finalization": {
      if (!deal.designApprovedByBroker) return { urgency: "action",  statusLine: "Design needs your approval",    cta: { label: "Open designer", href: designer } };
      if (!deal.designApprovedBySeller) return { urgency: "waiting", statusLine: "Awaiting seller sign-off",      cta: { label: "Open deal", href: overview } };
      return { urgency: "action", statusLine: "Ready to publish live",                                            cta: { label: "Open to publish", href: overview } };
    }
    default:
      return { urgency: "waiting", statusLine: `Updated ${lastActivity}`, cta: { label: "Open deal", href: overview } };
  }
}

/* ─── Deal card ─── */
function DealCard({ deal }: { deal: Deal }) {
  const [, setLocation] = useLocation();
  const { urgency, statusLine, cta } = getDealMeta(deal);
  const phase = PHASES.find(p => p.key === deal.phase);

  const handleCTA = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setLocation(cta.href);
  };

  /* Status line colour — teal for action, muted otherwise */
  const statusColor =
    urgency === "action" ? "text-teal/80" :
    urgency === "live"   ? "text-success/80" :
    "text-muted-foreground";

  return (
    <Link href={`/deal/${deal.id}`}>
      <div
        className={`
          group relative flex items-center gap-4 px-6 py-3.5 border-b border-border
          cursor-pointer transition-colors duration-100
          ${urgency === "action" ? "hover:bg-teal/[0.03]" : "hover:bg-accent/30"}
        `}
        data-testid={`deal-card-${deal.id}`}
      >
        {/* Urgency accent — left edge rule for action items */}
        {urgency === "action" && (
          <div className="absolute left-0 top-1/4 bottom-1/4 w-[2px] rounded-r bg-teal/40" />
        )}

        {/* Status dot */}
        <div className={`
          rounded-full shrink-0 transition-all
          ${urgency === "action"   ? "h-2 w-2 bg-teal" :
            urgency === "progress" ? "h-2 w-2 bg-blue" :
            urgency === "live"     ? "h-2 w-2 bg-success" :
                                     "h-1.5 w-1.5 bg-muted-foreground/30"}
        `} />

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="text-sm font-medium text-foreground truncate leading-snug">
              {deal.businessName}
            </span>
            {deal.industry && (
              <span className="shrink-0 text-2xs bg-muted text-muted-foreground rounded px-1.5 py-0.5 leading-none">
                {deal.industry}
              </span>
            )}
          </div>
          <p className={`text-xs truncate leading-snug ${statusColor}`}>{statusLine}</p>
        </div>

        {/* Phase badge */}
        <div className="shrink-0 hidden sm:flex flex-col items-end gap-px">
          <span className="text-2xs font-medium text-muted-foreground/70">{phase?.short ?? "—"}</span>
          <span className="text-2xs text-muted-foreground/40">{phase?.label ?? deal.phase}</span>
        </div>

        {/* CTA — slides in on hover */}
        <button
          onClick={handleCTA}
          className={`
            shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md
            translate-x-1 opacity-0 group-hover:translate-x-0 group-hover:opacity-100
            focus-visible:translate-x-0 focus-visible:opacity-100
            transition-all duration-150
            ${urgency === "action" || urgency === "live"
              ? "bg-teal/10 text-teal hover:bg-teal/15"
              : "bg-accent text-muted-foreground hover:text-foreground"
            }
          `}
          data-testid={`deal-cta-${deal.id}`}
        >
          {cta.label}
          <ArrowRight className="h-3 w-3" />
        </button>
      </div>
    </Link>
  );
}

/* ─── Deal group ─── */
function DealGroup({ label, icon, deals }: { label: string; icon: React.ReactNode; deals: Deal[] }) {
  return (
    <div>
      <div className="flex items-center gap-2 px-6 py-2 sticky top-0 bg-background/98 backdrop-blur-sm z-10">
        {icon}
        <span className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground/70">{label}</span>
        <span className="text-2xs tabular-nums text-muted-foreground/40 font-medium">{deals.length}</span>
      </div>
      {deals.map(deal => (
        <DealCard key={deal.id} deal={deal} />
      ))}
    </div>
  );
}

/* ─── Page ─── */
export default function ActiveCIMs() {
  const [search, setSearch] = useState("");
  const [, setLocation] = useLocation();

  // `?phase=` comes from the dashboard pipeline cells (and the stat cells
  // below). Only known phase keys are honored; anything else is ignored.
  const searchString = useSearch();
  const requestedPhase = new URLSearchParams(searchString).get("phase");
  const phaseFilter = PHASES.find(p => p.key === requestedPhase) ?? null;
  const setPhaseFilter = (key: string | null) =>
    setLocation(key ? `/broker/deals?phase=${encodeURIComponent(key)}` : "/broker/deals", { replace: true });

  const { data: deals = [], isLoading, error, refetch, isFetching } = useQuery<Deal[]>({ queryKey: ["/api/deals"] });

  const filteredDeals = deals.filter(d => {
    if (phaseFilter && d.phase !== phaseFilter.key) return false;
    const q = search.toLowerCase();
    if (!q) return true;
    return d.businessName.toLowerCase().includes(q) || (d.industry?.toLowerCase().includes(q) ?? false);
  });

  const actionDeals   = filteredDeals.filter(d => getDealMeta(d).urgency === "action");
  const progressDeals = filteredDeals.filter(d => getDealMeta(d).urgency === "progress");
  const waitingDeals  = filteredDeals.filter(d => getDealMeta(d).urgency === "waiting");
  const liveDeals     = filteredDeals.filter(d => getDealMeta(d).urgency === "live");

  const phaseCounts = PHASES.map(p => ({
    ...p,
    count: deals.filter(d => d.phase === p.key).length,
  }));
  const liveCount  = deals.filter(d => d.isLive).length;
  const totalDeals = deals.length;
  const isFiltering = !!search || !!phaseFilter;

  return (
    <div className="flex flex-col h-full min-h-screen">

      {/* ── Header ── */}
      <div className="px-6 pt-6 pb-5 border-b border-border">

        {/* Title row */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">Deals</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {totalDeals === 0
                ? "No deals in pipeline yet"
                : `${totalDeals} deal${totalDeals !== 1 ? "s" : ""} in pipeline`}
            </p>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <Button
              size="sm"
              onClick={() => setLocation("/broker/new-deal")}
              className="h-8 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5 shadow-sm"
              data-testid="button-new-deal"
            >
              <Plus className="h-3.5 w-3.5" />
              New Deal
            </Button>
          </div>
        </div>

        {/* Pipeline stats — clicking a phase filters the list */}
        <div className="flex items-end gap-0 overflow-x-auto">
          {phaseCounts.map((p) => {
            const active = phaseFilter?.key === p.key;
            return (
              <button
                key={p.key}
                type="button"
                onClick={() => setPhaseFilter(active ? null : p.key)}
                aria-pressed={active}
                title={active ? "Clear phase filter" : `Show only ${p.short} deals`}
                className={`
                  flex flex-col items-start shrink-0 pr-6 mr-6 border-r border-border last:border-0 last:mr-0
                  text-left rounded-sm transition-colors
                  ${active ? "" : "hover:opacity-80"}
                `}
                data-testid={`stat-phase-${p.key}`}
              >
                <span className={`text-[10px] font-semibold uppercase tracking-[0.1em] mb-1 ${active ? "text-teal" : "text-muted-foreground/60"}`}>
                  {p.short}
                </span>
                <span className={`text-3xl font-bold tabular-nums leading-none ${active ? "text-teal" : "text-foreground"}`}>
                  {p.count}
                </span>
                <span className="text-[11px] text-muted-foreground/60 mt-1.5">{p.label}</span>
              </button>
            );
          })}

          {/* Divider */}
          <div className="w-px self-stretch bg-border mx-2 shrink-0" />

          {/* Live */}
          <div className="flex flex-col shrink-0 pl-4">
            <span className="text-[10px] font-semibold text-success/70 uppercase tracking-[0.1em] mb-1">
              Live
            </span>
            <span className="text-3xl font-bold tabular-nums leading-none text-success">
              {liveCount}
            </span>
            <span className="text-[11px] text-muted-foreground/60 mt-1.5">Published</span>
          </div>
        </div>
      </div>

      {/* ── Search & filter bar ── */}
      <div className="px-6 py-3 border-b border-border flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 max-w-sm min-w-[200px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
          <Input
            placeholder="Search deals..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm bg-muted/60 border-0 focus-visible:ring-1 focus-visible:ring-teal/40 placeholder:text-muted-foreground/50"
            data-testid="input-search"
          />
        </div>

        {/* Active phase filter chip — clearable */}
        {phaseFilter && (
          <button
            type="button"
            onClick={() => setPhaseFilter(null)}
            className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-1.5 rounded-full bg-teal/10 text-teal text-xs font-medium hover:bg-teal/15 transition-colors"
            data-testid="chip-phase-filter"
          >
            {phaseFilter.short} · {phaseFilter.label}
            <X className="h-3 w-3" />
          </button>
        )}

        {/* Result count when filtering */}
        {isFiltering && !isLoading && !error && (
          <span className="text-xs text-muted-foreground shrink-0">
            {filteredDeals.length} result{filteredDeals.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {/* ── Deal list ── */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        {isLoading ? (
          <div className="px-6 py-5 space-y-px">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-[58px] rounded-sm bg-muted/40 animate-pulse" />
            ))}
          </div>
        ) : error ? (
          <ErrorState
            message={error instanceof Error ? error.message : undefined}
            retrying={isFetching}
            onRetry={() => refetch()}
          />
        ) : filteredDeals.length === 0 ? (
          <EmptyState
            searching={!!search}
            phaseLabel={phaseFilter ? `${phaseFilter.short} · ${phaseFilter.label}` : null}
            onClearPhase={() => setPhaseFilter(null)}
            onNewDeal={() => setLocation("/broker/new-deal")}
          />
        ) : (
          <div>
            {actionDeals.length > 0 && (
              <DealGroup
                label="Needs action"
                icon={<Zap className="h-3 w-3 text-teal/70" />}
                deals={actionDeals}
              />
            )}
            {progressDeals.length > 0 && (
              <DealGroup
                label="In progress"
                icon={<Radio className="h-3 w-3 text-blue/70" />}
                deals={progressDeals}
              />
            )}
            {waitingDeals.length > 0 && (
              <DealGroup
                label="Waiting"
                icon={<Clock className="h-3 w-3 text-muted-foreground/50" />}
                deals={waitingDeals}
              />
            )}
            {liveDeals.length > 0 && (
              <DealGroup
                label="Live"
                icon={<CheckCircle2 className="h-3 w-3 text-success/70" />}
                deals={liveDeals}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Error state — distinct from "no deals" ─── */
function ErrorState({ message, retrying, onRetry }: { message?: string; retrying: boolean; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center px-6" role="alert" data-testid="deals-error">
      <div className="h-11 w-11 rounded-xl bg-destructive/10 border border-destructive/20 flex items-center justify-center mb-4">
        <AlertCircle className="h-5 w-5 text-destructive" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">Couldn't load your deals</p>
      <p className="text-xs text-muted-foreground max-w-[280px]">
        {message || "The server didn't respond. Check your connection and try again."}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={onRetry}
        disabled={retrying}
        className="mt-5"
        data-testid="button-retry-deals"
      >
        <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${retrying ? "animate-spin" : ""}`} />
        {retrying ? "Retrying..." : "Retry"}
      </Button>
    </div>
  );
}

/* ─── Empty state ─── */
function EmptyState({
  searching,
  phaseLabel,
  onClearPhase,
  onNewDeal,
}: {
  searching: boolean;
  phaseLabel: string | null;
  onClearPhase: () => void;
  onNewDeal: () => void;
}) {
  const filtering = searching || !!phaseLabel;
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center px-6">
      <div className="h-11 w-11 rounded-xl bg-teal/8 border border-teal/15 flex items-center justify-center mb-4">
        <Building2 className="h-5 w-5 text-teal/50" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">
        {phaseLabel && !searching
          ? `No deals in ${phaseLabel}`
          : filtering ? "No matching deals" : "No deals yet"}
      </p>
      <p className="text-xs text-muted-foreground max-w-[240px]">
        {phaseLabel && !searching
          ? "Nothing is sitting in this phase right now."
          : filtering
            ? "Try a different search term or clear the filter."
            : "Create your first deal to start the CIM process"}
      </p>
      {phaseLabel ? (
        <Button size="sm" variant="outline" onClick={onClearPhase} className="mt-5" data-testid="button-clear-phase-filter">
          <X className="h-3.5 w-3.5 mr-1.5" />
          Show all deals
        </Button>
      ) : !searching ? (
        <Button
          size="sm"
          onClick={onNewDeal}
          className="mt-5 bg-teal text-teal-foreground hover:bg-teal/90 shadow-sm"
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Deal
        </Button>
      ) : null}
    </div>
  );
}
