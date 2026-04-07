/**
 * BuyerMatchingPanel — buyer profile management + match scoring
 *
 * Brokers can fill in buyer criteria (budget, industries, location, qualification)
 * and run match scoring against the deal to rank buyers by fit.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  Target, Zap, DollarSign, MapPin, Building, Shield,
  TrendingUp, ChevronDown, ChevronUp, Edit3, Save, X,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface BuyerWithProfile {
  id: string;
  buyerName: string | null;
  buyerEmail: string;
  buyerCompany: string | null;
  buyerType: string | null;
  budgetMin: string | null;
  budgetMax: string | null;
  targetIndustries: string[];
  targetLocations: string[];
  acquisitionCriteria: string | null;
  prequalified: boolean;
  proofOfFunds: boolean;
  buyerNotes: string | null;
  matchScore: number | null;
  matchBreakdown: Record<string, number> | null;
  ndaSignedAt: string | null;
  revokedAt: string | null;
  expiresAt: string | null;
}

interface MatchResult {
  buyerId: string;
  buyerName: string;
  buyerEmail: string;
  buyerCompany: string | null;
  buyerType: string | null;
  matchScore: number;
  breakdown: Record<string, number>;
}

const BUYER_TYPES = [
  { value: "individual", label: "Individual Buyer" },
  { value: "strategic", label: "Strategic Acquirer" },
  { value: "financial", label: "Financial Buyer (PE)" },
  { value: "search_fund", label: "Search Fund" },
  { value: "family_office", label: "Family Office" },
];

const BREAKDOWN_LABELS: Record<string, { label: string; icon: typeof Target; max: number }> = {
  budgetFit:      { label: "Budget fit",      icon: DollarSign, max: 25 },
  industryMatch:  { label: "Industry match",  icon: Building,   max: 25 },
  locationMatch:  { label: "Location match",  icon: MapPin,     max: 15 },
  qualification:  { label: "Qualification",   icon: Shield,     max: 20 },
  engagement:     { label: "Engagement",       icon: TrendingUp, max: 15 },
};

function scoreColor(score: number): string {
  if (score >= 70) return "text-emerald-400";
  if (score >= 45) return "text-amber-400";
  return "text-muted-foreground";
}

function scoreBadge(score: number): { label: string; color: string } {
  if (score >= 70) return { label: "Strong match", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
  if (score >= 45) return { label: "Moderate", color: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
  if (score >= 20) return { label: "Weak", color: "bg-muted text-muted-foreground border-border" };
  return { label: "No match data", color: "bg-muted/50 text-muted-foreground/60 border-border" };
}

export function BuyerMatchingPanel({ dealId }: { dealId: string }) {
  const [editingBuyer, setEditingBuyer] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: buyers, isLoading } = useQuery<BuyerWithProfile[]>({
    queryKey: ["/api/deals", dealId, "buyers"],
    enabled: !!dealId,
  });

  const runMatching = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/deals/${dealId}/match-buyers`);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
    },
  });

  if (isLoading) {
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-32" />
        {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-20" />)}
      </div>
    );
  }

  const activeBuyers = (buyers || []).filter(b => !b.revokedAt);

  if (activeBuyers.length === 0) {
    return (
      <div className="text-center py-4">
        <Target className="h-5 w-5 mx-auto mb-1.5 opacity-20" />
        <p className="text-xs text-muted-foreground">No buyers to match</p>
        <p className="text-2xs text-muted-foreground/60 mt-0.5">Add buyers from the Team tab to enable matching</p>
      </div>
    );
  }

  // Sort by match score (null scores last)
  const sorted = [...activeBuyers].sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
          <Target className="h-3.5 w-3.5" /> Buyer Matching
        </p>
        <Button
          variant="outline"
          size="sm"
          className="h-6 text-2xs gap-1 px-2"
          onClick={() => runMatching.mutate()}
          disabled={runMatching.isPending}
        >
          <Zap className="h-3 w-3" />
          {runMatching.isPending ? "Scoring..." : "Run Match"}
        </Button>
      </div>

      <div className="space-y-2">
        {sorted.map(buyer => {
          const badge = scoreBadge(buyer.matchScore ?? 0);
          const isExpanded = expanded === buyer.id;

          return (
            <div key={buyer.id} className="rounded-lg border border-border bg-card overflow-hidden">
              {/* Header */}
              <div
                className="flex items-center gap-2.5 p-2.5 cursor-pointer hover:bg-muted/20 transition-colors"
                onClick={() => setExpanded(isExpanded ? null : buyer.id)}
              >
                {buyer.matchScore != null ? (
                  <div className={`text-lg font-bold tabular-nums w-10 text-center ${scoreColor(buyer.matchScore)}`}>
                    {buyer.matchScore}
                  </div>
                ) : (
                  <div className="text-lg font-bold tabular-nums w-10 text-center text-muted-foreground/30">—</div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{buyer.buyerName || "Unknown"}</p>
                  <p className="text-2xs text-muted-foreground truncate">
                    {buyer.buyerCompany || buyer.buyerEmail}
                    {buyer.buyerType && ` · ${BUYER_TYPES.find(t => t.value === buyer.buyerType)?.label || buyer.buyerType}`}
                  </p>
                </div>
                <Badge variant="outline" className={`shrink-0 text-2xs ${badge.color}`}>
                  {badge.label}
                </Badge>
                {isExpanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/40" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/40" />}
              </div>

              {/* Expanded detail */}
              {isExpanded && (
                <div className="border-t border-border p-2.5 space-y-3">
                  {/* Score breakdown */}
                  {buyer.matchBreakdown && (
                    <div className="space-y-1.5">
                      <p className="text-2xs font-medium text-muted-foreground">Score breakdown</p>
                      {Object.entries(BREAKDOWN_LABELS).map(([key, cfg]) => {
                        const value = buyer.matchBreakdown?.[key];
                        if (value === undefined) return null;
                        const Icon = cfg.icon;
                        const isUnknown = value === -1;
                        return (
                          <div key={key} className="flex items-center gap-2">
                            <Icon className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                            <span className="text-2xs w-24">{cfg.label}</span>
                            <div className="flex-1">
                              <Progress value={isUnknown ? 0 : (value / cfg.max) * 100} className="h-1" />
                            </div>
                            <span className="text-2xs tabular-nums w-10 text-right">
                              {isUnknown ? "N/A" : `${value}/${cfg.max}`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {/* Profile summary */}
                  <div className="grid grid-cols-2 gap-1.5 text-2xs">
                    {buyer.budgetMin && (
                      <div><span className="text-muted-foreground">Budget:</span> ${buyer.budgetMin}–${buyer.budgetMax || "?"}</div>
                    )}
                    {(buyer.targetIndustries as string[] || []).length > 0 && (
                      <div><span className="text-muted-foreground">Industries:</span> {(buyer.targetIndustries as string[]).join(", ")}</div>
                    )}
                    {buyer.prequalified && (
                      <div className="flex items-center gap-1"><Shield className="h-2.5 w-2.5 text-emerald-400" /> Prequalified</div>
                    )}
                    {buyer.proofOfFunds && (
                      <div className="flex items-center gap-1"><DollarSign className="h-2.5 w-2.5 text-emerald-400" /> Proof of funds</div>
                    )}
                  </div>

                  {buyer.buyerNotes && (
                    <p className="text-2xs text-muted-foreground italic">{buyer.buyerNotes}</p>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-2xs gap-1 w-full"
                    onClick={(e) => { e.stopPropagation(); setEditingBuyer(buyer.id); }}
                  >
                    <Edit3 className="h-3 w-3" /> Edit buyer profile
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Edit dialog */}
      {editingBuyer && (
        <BuyerProfileDialog
          dealId={dealId}
          buyer={activeBuyers.find(b => b.id === editingBuyer)!}
          onClose={() => setEditingBuyer(null)}
        />
      )}
    </div>
  );
}

// ── Buyer Profile Editor Dialog ──────────────────────────────────────────────
function BuyerProfileDialog({ dealId, buyer, onClose }: { dealId: string; buyer: BuyerWithProfile; onClose: () => void }) {
  const [buyerType, setBuyerType] = useState(buyer.buyerType || "");
  const [budgetMin, setBudgetMin] = useState(buyer.budgetMin || "");
  const [budgetMax, setBudgetMax] = useState(buyer.budgetMax || "");
  const [industries, setIndustries] = useState((buyer.targetIndustries as string[] || []).join(", "));
  const [locations, setLocations] = useState((buyer.targetLocations as string[] || []).join(", "));
  const [criteria, setCriteria] = useState(buyer.acquisitionCriteria || "");
  const [prequalified, setPrequalified] = useState(buyer.prequalified || false);
  const [proofOfFunds, setProofOfFunds] = useState(buyer.proofOfFunds || false);
  const [notes, setNotes] = useState(buyer.buyerNotes || "");

  const save = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("PATCH", `/api/buyers/${buyer.id}/profile`, {
        buyerType: buyerType || null,
        budgetMin: budgetMin || null,
        budgetMax: budgetMax || null,
        targetIndustries: industries.split(",").map(s => s.trim()).filter(Boolean),
        targetLocations: locations.split(",").map(s => s.trim()).filter(Boolean),
        acquisitionCriteria: criteria || null,
        prequalified,
        proofOfFunds,
        buyerNotes: notes || null,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">Buyer Profile — {buyer.buyerName || buyer.buyerEmail}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs">Buyer type</Label>
            <Select value={buyerType} onValueChange={setBuyerType}>
              <SelectTrigger className="h-8 text-xs"><SelectValue placeholder="Select type..." /></SelectTrigger>
              <SelectContent>
                {BUYER_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs">Budget min</Label>
              <Input className="h-8 text-xs" placeholder="e.g. 500000" value={budgetMin} onChange={e => setBudgetMin(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Budget max</Label>
              <Input className="h-8 text-xs" placeholder="e.g. 2000000" value={budgetMax} onChange={e => setBudgetMax(e.target.value)} />
            </div>
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Target industries (comma-separated)</Label>
            <Input className="h-8 text-xs" placeholder="e.g. Construction, HVAC, Plumbing" value={industries} onChange={e => setIndustries(e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Target locations (comma-separated)</Label>
            <Input className="h-8 text-xs" placeholder="e.g. Ontario, British Columbia" value={locations} onChange={e => setLocations(e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Acquisition criteria</Label>
            <Textarea className="text-xs min-h-[60px]" placeholder="What is this buyer looking for?" value={criteria} onChange={e => setCriteria(e.target.value)} />
          </div>

          <div className="flex items-center justify-between">
            <Label className="text-xs">Prequalified</Label>
            <Switch checked={prequalified} onCheckedChange={setPrequalified} />
          </div>
          <div className="flex items-center justify-between">
            <Label className="text-xs">Proof of funds</Label>
            <Switch checked={proofOfFunds} onCheckedChange={setProofOfFunds} />
          </div>

          <div className="space-y-1">
            <Label className="text-xs">Broker notes</Label>
            <Textarea className="text-xs min-h-[40px]" placeholder="Internal notes about this buyer..." value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1" onClick={() => save.mutate()} disabled={save.isPending}>
            <Save className="h-3 w-3" /> Save Profile
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
