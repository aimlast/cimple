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
import { format, formatDistanceToNow } from "date-fns";
import type { Deal } from "@shared/schema";

/* ─── Phase metadata ─── */
const PHASES = [
  { key: "phase1_info_collection",   short: "Phase 1", label: "Info Collection"  },
  { key: "phase2_platform_intake",   short: "Phase 2", label: "Platform Intake"  },
  { key: "phase3_content_creation",  short: "Phase 3", label: "Content Creation" },
  { key: "phase4_design_finalization", short: "Phase 4", label: "Design & Final" },
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
      if (!deal.ndaSigned) return { urgency: "action",   statusLine: "NDA not yet signed",         ctaLabel: "Open Deal" };
      if (!deal.sqCompleted) return { urgency: "waiting", statusLine: `Awaiting questionnaire · ${lastActivity}`, ctaLabel: "Open Deal" };
      if (!deal.valuationCompleted) return { urgency: "action", statusLine: "Valuation pending",    ctaLabel: "Open Deal" };
      return { urgency: "action", statusLine: "Phase 1 complete — advance to intake", ctaLabel: "Advance" };
    }
    case "phase2_platform_intake": {
      if (!deal.interviewCompleted) return { urgency: "action", statusLine: "AI interview not started", ctaLabel: "Start Interview" };
      return { urgency: "progress", statusLine: `Interview complete · ${lastActivity}`, ctaLabel: "Open Deal" };
    }
    case "phase3_content_creation": {
      if (!deal.cimContent) return { urgency: "action", statusLine: "CIM content not yet generated", ctaLabel: "Generate Content" };
      if (!deal.contentApprovedByBroker) return { urgency: "action", statusLine: "Awaiting your review", ctaLabel: "Review CIM" };
      if (!deal.contentApprovedBySeller) return { urgency: "waiting", statusLine: `Awaiting seller approval · ${lastActivity}`, ctaLabel: "Open Deal" };
      return { urgency: "progress", statusLine: "Content approved — ready for design", ctaLabel: "Open Deal" };
    }
    case "phase4_design_finalization": {
      if (!deal.designApprovedByBroker) return { urgency: "action", statusLine: "Design needs your approval", ctaLabel: "Review Design" };
      if (!deal.designApprovedBySeller) return { urgency: "waiting", statusLine: "Awaiting seller sign-off", ctaLabel: "Open Deal" };
      return { urgency: "action", statusLine: "Ready to publish live", ctaLabel: "Publish CIM" };
    }
    default:
      return { urgency: "waiting", statusLine: `Updated ${lastActivity}`, ctaLabel: "Open Deal" };
  }
}

function urgencyDot(urgency: DealUrgency) {
  switch (urgency) {
    case "action":   return "dot-teal";
    case "progress": return "dot-blue";
    case "live":     return "dot-green";
    default:         return "dot-muted";
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

  return (
    <Link href={`/deal/${deal.id}`}>
      <div
        className="group flex items-center gap-4 px-5 py-4 border-b border-border hover:bg-accent/40 transition-colors cursor-pointer"
        data-testid={`deal-card-${deal.id}`}
      >
        {/* Status dot */}
        <div className={`h-2 w-2 rounded-full shrink-0 ${urgencyDot(urgency)}`} />

        {/* Main info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-medium text-foreground truncate">{deal.businessName}</span>
            {deal.industry && (
              <span className="text-2xs text-muted-foreground shrink-0">{deal.industry}</span>
            )}
          </div>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{statusLine}</p>
        </div>

        {/* Phase badge */}
        <div className="shrink-0 hidden sm:flex flex-col items-end gap-0.5">
          <span className="text-2xs font-medium text-muted-foreground">{phase?.short ?? "—"}</span>
          <span className="text-2xs text-muted-foreground/50">{phase?.label ?? deal.phase}</span>
        </div>

        {/* CTA */}
        <button
          onClick={handleCTA}
          className={`
            shrink-0 flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-md
            opacity-0 group-hover:opacity-100 transition-opacity
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

  // Group by urgency for the list
  const actionDeals   = filteredDeals.filter(d => getDealMeta(d).urgency === "action");
  const progressDeals = filteredDeals.filter(d => getDealMeta(d).urgency === "progress");
  const waitingDeals  = filteredDeals.filter(d => getDealMeta(d).urgency === "waiting");
  const liveDeals     = filteredDeals.filter(d => getDealMeta(d).urgency === "live");

  // Pipeline counts
  const phaseCounts = PHASES.map(p => ({
    ...p,
    count: deals.filter(d => d.phase === p.key).length,
  }));
  const liveCount = deals.filter(d => d.isLive).length;

  const handleGenerateInvite = () => {
    const token = Math.random().toString(36).substring(2, 15);
    navigator.clipboard.writeText(`${window.location.origin}/invite/${token}`);
    toast({ title: "Invite link copied", description: "Send it to the seller to begin their intake." });
    setInviteOpen(false);
    setInviteEmail("");
  };

  return (
    <div className="flex flex-col h-full min-h-screen">

      {/* ── Page header ── */}
      <div className="px-6 pt-6 pb-4 border-b border-border">
        <div className="flex items-center justify-between gap-4 mb-5">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Deals</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {deals.length === 0 ? "No deals yet" : `${deals.length} deal${deals.length !== 1 ? "s" : ""} in pipeline`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setInviteOpen(true)}
              className="h-8 text-xs"
            >
              Invite Seller
            </Button>
            <Button
              size="sm"
              onClick={() => setLocation("/new-deal")}
              className="h-8 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
              data-testid="button-new-deal"
            >
              <Plus className="h-3.5 w-3.5" />
              New Deal
            </Button>
          </div>
        </div>

        {/* ── Pipeline stats row ── */}
        <div className="flex gap-6 overflow-x-auto pb-1">
          {phaseCounts.map(p => (
            <div key={p.key} className="flex flex-col shrink-0">
              <span className="text-2xs text-muted-foreground uppercase tracking-widest font-medium">{p.short}</span>
              <span className="text-2xl font-semibold tabular-nums mt-0.5">{p.count}</span>
              <span className="text-2xs text-muted-foreground">{p.label}</span>
            </div>
          ))}
          <div className="w-px bg-border shrink-0" />
          <div className="flex flex-col shrink-0">
            <span className="text-2xs text-success uppercase tracking-widest font-medium">Live</span>
            <span className="text-2xl font-semibold tabular-nums mt-0.5 text-success">{liveCount}</span>
            <span className="text-2xs text-muted-foreground">Published</span>
          </div>
        </div>
      </div>

      {/* ── Search ── */}
      <div className="px-6 py-3 border-b border-border">
        <div className="relative max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            placeholder="Search deals..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="pl-8 h-8 text-sm bg-muted border-0 focus-visible:ring-1 focus-visible:ring-teal/50"
            data-testid="input-search"
          />
        </div>
      </div>

      {/* ── Deal list ── */}
      <div className="flex-1 overflow-auto scrollbar-thin">
        {isLoading ? (
          <div className="px-6 py-8 space-y-3">
            {[1, 2, 3].map(i => (
              <div key={i} className="h-14 rounded-lg bg-card animate-pulse" />
            ))}
          </div>
        ) : filteredDeals.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center px-6">
            <div className="h-12 w-12 rounded-xl bg-teal/8 flex items-center justify-center mb-4">
              <Building2 className="h-5 w-5 text-teal/60" />
            </div>
            <p className="text-sm font-medium text-muted-foreground">
              {search ? "No deals match your search" : "No deals yet"}
            </p>
            <p className="text-xs text-muted-foreground/60 mt-1">
              {search ? "Try a different search term" : "Create your first deal to get started"}
            </p>
            {!search && (
              <Button
                size="sm"
                onClick={() => setLocation("/new-deal")}
                className="mt-4 bg-teal text-teal-foreground hover:bg-teal/90"
              >
                <Plus className="h-3.5 w-3.5 mr-1.5" />
                New Deal
              </Button>
            )}
          </div>
        ) : (
          <div>
            {/* Needs action */}
            {actionDeals.length > 0 && (
              <DealGroup
                label="Needs action"
                icon={<Zap className="h-3 w-3 text-teal" />}
                deals={actionDeals}
              />
            )}
            {/* In progress */}
            {progressDeals.length > 0 && (
              <DealGroup
                label="In progress"
                icon={<Radio className="h-3 w-3 text-blue" />}
                deals={progressDeals}
              />
            )}
            {/* Waiting */}
            {waitingDeals.length > 0 && (
              <DealGroup
                label="Waiting"
                icon={<Clock className="h-3 w-3 text-muted-foreground" />}
                deals={waitingDeals}
              />
            )}
            {/* Live */}
            {liveDeals.length > 0 && (
              <DealGroup
                label="Live"
                icon={<CheckCircle2 className="h-3 w-3 text-success" />}
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
              Generate a secure intake link for the seller. They'll be guided through the process by AI.
            </DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Seller email (optional)</Label>
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
            <Button variant="outline" size="sm" onClick={() => setInviteOpen(false)}>Cancel</Button>
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

function DealGroup({ label, icon, deals }: { label: string; icon: React.ReactNode; deals: Deal[] }) {
  return (
    <div>
      {/* Group header */}
      <div className="flex items-center gap-2 px-6 py-2.5 sticky top-0 bg-background/95 backdrop-blur-sm border-b border-border z-10">
        {icon}
        <span className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground">{label}</span>
        <span className="text-2xs text-muted-foreground/50 ml-1">{deals.length}</span>
      </div>
      {deals.map(deal => (
        <DealCard key={deal.id} deal={deal} />
      ))}
    </div>
  );
}

// Import used in empty state
import { Building2 } from "lucide-react";
