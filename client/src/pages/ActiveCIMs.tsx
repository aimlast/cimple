import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Search, ArrowRight, Clock, AlertCircle, CheckCircle2, Zap, Radio } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
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

function getDealMeta(deal: Deal): { urgency: DealUrgency; statusLine: string; ctaLabel: string } {
  if (deal.isLive) {
    return { urgency: "live", statusLine: "Live — shared with buyers", ctaLabel: "View CIM" };
  }
  const lastActivity = deal.updatedAt
    ? formatDistanceToNow(new Date(deal.updatedAt), { addSuffix: true })
    : "recently";

  switch (deal.phase) {
    case "phase1_info_collection": {
      if (!deal.ndaSigned) return { urgency: "action",   statusLine: "NDA not yet signed",                         ctaLabel: "Open Deal" };
      if (!deal.sqCompleted) return { urgency: "waiting", statusLine: `Awaiting questionnaire · ${lastActivity}`,  ctaLabel: "Open Deal" };
      if (!deal.valuationCompleted) return { urgency: "action", statusLine: "Valuation pending",                   ctaLabel: "Open Deal" };
      return { urgency: "action", statusLine: "Phase 1 complete — advance to intake",                              ctaLabel: "Advance"   };
    }
    case "phase2_platform_intake": {
      if (!deal.interviewCompleted) return { urgency: "action",   statusLine: "AI interview not started",          ctaLabel: "Start Interview" };
      return { urgency: "progress", statusLine: `Interview complete · ${lastActivity}`,                            ctaLabel: "Open Deal" };
    }
    case "phase3_content_creation": {
      if (!deal.cimContent) return { urgency: "action",           statusLine: "CIM content not yet generated",     ctaLabel: "Generate Content" };
      if (!deal.contentApprovedByBroker) return { urgency: "action", statusLine: "Awaiting your review",           ctaLabel: "Review CIM" };
      if (!deal.contentApprovedBySeller) return { urgency: "waiting", statusLine: `Awaiting seller approval · ${lastActivity}`, ctaLabel: "Open Deal" };
      return { urgency: "progress", statusLine: "Content approved — ready for design",                             ctaLabel: "Open Deal" };
    }
    case "phase4_design_finalization": {
      if (!deal.designApprovedByBroker) return { urgency: "action",  statusLine: "Design needs your approval",     ctaLabel: "Review Design" };
      if (!deal.designApprovedBySeller) return { urgency: "waiting", statusLine: "Awaiting seller sign-off",       ctaLabel: "Open Deal" };
      return { urgency: "action", statusLine: "Ready to publish live",                                             ctaLabel: "Publish CIM" };
    }
    default:
      return { urgency: "waiting", statusLine: `Updated ${lastActivity}`, ctaLabel: "Open Deal" };
  }
}

/* ─── Deal card ─── */
function DealCard({ deal }: { deal: Deal }) {
  const [, setLocation] = useLocation();
  const { urgency, statusLine, ctaLabel } = getDealMeta(deal);
  const phase = PHASES.find(p => p.key === deal.phase);

  const handleCTA = (e: React.MouseEvent) => {
    e.preventDefault();
    if (ctaLabel === "Start Interview") {
      setLocation(`/deal/${deal.id}/interview`);
    } else {
      setLocation(`/deal/${deal.id}`);
    }
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
            transition-all duration-150
            ${urgency === "action" || urgency === "live"
              ? "bg-teal/10 text-teal hover:bg-teal/15"
              : "bg-accent text-muted-foreground hover:text-foreground"
            }
          `}
          data-testid={`deal-cta-${deal.id}`}
        >
          {ctaLabel}
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
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const { data: deals = [], isLoading } = useQuery<Deal[]>({ queryKey: ["/api/deals"] });

  const filteredDeals = deals.filter(d =>
    d.businessName.toLowerCase().includes(search.toLowerCase()) ||
    d.industry?.toLowerCase().includes(search.toLowerCase())
  );

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

  const handleGenerateInvite = () => {
    const token = Math.random().toString(36).substring(2, 15);
    navigator.clipboard.writeText(`${window.location.origin}/invite/${token}`);
    toast({ title: "Invite link copied", description: "Send it to the seller to begin their intake." });
    setInviteOpen(false);
    setInviteEmail("");
  };

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
              variant="ghost"
              size="sm"
              onClick={() => setInviteOpen(true)}
              className="h-8 text-xs text-muted-foreground hover:text-foreground"
            >
              Invite Seller
            </Button>
            <Button
              size="sm"
              onClick={() => setLocation("/new-deal")}
              className="h-8 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5 shadow-sm"
              data-testid="button-new-deal"
            >
              <Plus className="h-3.5 w-3.5" />
              New Deal
            </Button>
          </div>
        </div>

        {/* Pipeline stats */}
        <div className="flex items-end gap-0 overflow-x-auto">
          {phaseCounts.map((p, i) => (
            <div
              key={p.key}
              className="flex flex-col shrink-0 pr-6 mr-6 border-r border-border last:border-0 last:mr-0"
            >
              <span className="text-[10px] font-semibold text-muted-foreground/60 uppercase tracking-[0.1em] mb-1">
                {p.short}
              </span>
              <span className="text-3xl font-bold tabular-nums leading-none text-foreground">
                {p.count}
              </span>
              <span className="text-[11px] text-muted-foreground/60 mt-1.5">{p.label}</span>
            </div>
          ))}

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
      <div className="px-6 py-3 border-b border-border flex items-center gap-3">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
          <Input
            placeholder="Search deals..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm bg-muted/60 border-0 focus-visible:ring-1 focus-visible:ring-teal/40 placeholder:text-muted-foreground/50"
            data-testid="input-search"
          />
        </div>
        {/* Result count when searching */}
        {search && (
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
        ) : filteredDeals.length === 0 ? (
          <EmptyState searching={!!search} onNewDeal={() => setLocation("/new-deal")} />
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

      {/* ── Invite seller dialog ── */}
      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite Seller</DialogTitle>
            <DialogDescription>
              Generate a secure intake link. The seller will be guided through the process by AI.
            </DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">Seller email (optional)</Label>
              <Input
                placeholder="seller@example.com"
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                className="h-9"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setInviteOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={handleGenerateInvite}
            >
              Copy Invite Link
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ─── Empty state ─── */
function EmptyState({ searching, onNewDeal }: { searching: boolean; onNewDeal: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center px-6">
      <div className="h-11 w-11 rounded-xl bg-teal/8 border border-teal/15 flex items-center justify-center mb-4">
        <Building2 className="h-5 w-5 text-teal/50" />
      </div>
      <p className="text-sm font-medium text-foreground mb-1">
        {searching ? "No matching deals" : "No deals yet"}
      </p>
      <p className="text-xs text-muted-foreground max-w-[220px]">
        {searching
          ? "Try a different search term"
          : "Create your first deal to start the CIM process"}
      </p>
      {!searching && (
        <Button
          size="sm"
          onClick={onNewDeal}
          className="mt-5 bg-teal text-teal-foreground hover:bg-teal/90 shadow-sm"
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New Deal
        </Button>
      )}
    </div>
  );
}

import { Building2 } from "lucide-react";
