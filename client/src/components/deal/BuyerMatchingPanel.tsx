/**
 * BuyerMatchingPanel — deep M&A criteria matching
 *
 * Comprehensive buyer criteria editor covering financial, operational,
 * business quality, deal structure, and growth criteria. AI-powered
 * matching scores buyers against the full deal knowledge base.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Target, Zap, DollarSign, MapPin, Building, Shield,
  TrendingUp, ChevronDown, ChevronUp, Edit3, Save,
  BarChart3, Users, Briefcase, Rocket, AlertTriangle,
  CheckCircle2, XCircle, MinusCircle, Brain, Loader2,
  ThumbsUp, ThumbsDown, Clock,
} from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { BUYER_CRITERIA_SECTIONS } from "@shared/schema";

// ── Types ────────────────────────────────────────────────────────────────────
interface CategoryScore {
  score: number;
  max: number;
  details: Record<string, { score: number; max: number; note: string }>;
}

interface MatchBreakdown {
  financialFit: CategoryScore;
  locationFit: CategoryScore;
  industryFit: CategoryScore;
  operationalFit: CategoryScore;
  dealStructureFit: CategoryScore;
  qualificationFit: CategoryScore;
  aiQualitative?: {
    growthAlignment: number;
    competitiveMoat: number;
    managementDepth: number;
    customerHealth: number;
    strategicFit: number;
    reasonForSaleRisk: number;
    overallAssessment: string;
    score: number;
  };
  deterministicScore: number;
  aiScore: number;
  finalScore: number;
  criteriaMatched: number;
  criteriaTested: number;
  dataCompleteness: number;
}

interface MatchResult {
  buyerId: string;
  buyerName: string;
  buyerEmail: string;
  buyerCompany: string | null;
  buyerType: string | null;
  prequalified?: boolean;
  proofOfFunds?: boolean;
  matchScore: number | null;
  breakdown: MatchBreakdown | null;
  noCriteria?: boolean;
  decision?: "under_review" | "interested" | "not_interested" | null;
  decisionNextStep?: string | null;
  decisionReason?: string | null;
  decisionAt?: string | null;
  crmSyncStatus?: string | null;
}

const BUYER_TYPES = [
  { value: "individual", label: "Individual" },
  { value: "strategic", label: "Strategic" },
  { value: "financial", label: "PE / Financial" },
  { value: "search_fund", label: "Search Fund" },
  { value: "family_office", label: "Family Office" },
  { value: "private_equity", label: "Private Equity" },
];

const CAT_ICONS: Record<string, typeof DollarSign> = {
  financialFit: DollarSign,
  industryFit: Building,
  locationFit: MapPin,
  operationalFit: Users,
  dealStructureFit: Briefcase,
};

const CAT_LABELS: Record<string, string> = {
  financialFit: "Financial",
  industryFit: "Industry & Business",
  locationFit: "Location",
  operationalFit: "Operational",
  dealStructureFit: "Deal Structure",
};

// ── Helpers ──────────────────────────────────────────────────────────────────
function decisionBadge(decision?: string | null): { label: string; color: string; Icon: typeof ThumbsUp } | null {
  switch (decision) {
    case "interested":
      return { label: "Interested", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30", Icon: ThumbsUp };
    case "not_interested":
      return { label: "Declined", color: "bg-rose-500/15 text-rose-400 border-rose-500/30", Icon: ThumbsDown };
    case "under_review":
    case null:
    case undefined:
      return { label: "Under Review", color: "bg-amber-500/10 text-amber-400/80 border-amber-500/20", Icon: Clock };
    default:
      return null;
  }
}

function scoreColor(score: number): string {
  if (score >= 70) return "text-emerald-400";
  if (score >= 45) return "text-amber-400";
  if (score >= 20) return "text-orange-400";
  return "text-red-400";
}

function scoreBadge(score: number | null, noCriteria?: boolean): { label: string; color: string } {
  if (noCriteria || score === null) return { label: "No criteria set", color: "bg-muted/50 text-muted-foreground/60 border-border" };
  if (score >= 75) return { label: "Strong match", color: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" };
  if (score >= 55) return { label: "Good match", color: "bg-teal/15 text-teal border-teal/30" };
  if (score >= 35) return { label: "Moderate", color: "bg-amber-500/15 text-amber-400 border-amber-500/30" };
  if (score >= 15) return { label: "Weak", color: "bg-orange-500/15 text-orange-400 border-orange-500/30" };
  return { label: "Poor match", color: "bg-red-500/15 text-red-400 border-red-500/30" };
}

function DetailIcon({ score, max }: { score: number; max: number }) {
  const pct = max > 0 ? (score / max) * 100 : 0;
  if (pct >= 70) return <CheckCircle2 className="h-3 w-3 text-emerald-400 shrink-0" />;
  if (pct >= 40) return <MinusCircle className="h-3 w-3 text-amber-400 shrink-0" />;
  return <XCircle className="h-3 w-3 text-red-400 shrink-0" />;
}

// ── Main Panel ───────────────────────────────────────────────────────────────
export function BuyerMatchingPanel({ dealId }: { dealId: string }) {
  const [editingBuyer, setEditingBuyer] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { data: buyers } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "buyers"],
    enabled: !!dealId,
  });

  const runMatching = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/deals/${dealId}/match-buyers`);
      return res.json() as Promise<MatchResult[]>;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
    },
  });

  const results = runMatching.data;
  const activeBuyers = (buyers || []).filter((b: any) => !b.revokedAt);

  // Use either fresh match results or existing stored scores
  // Enrich match results with decision data from buyers list (even when
  // using fresh match results from /match-buyers).
  const buyerById = new Map<string, any>(activeBuyers.map((b: any) => [b.id, b]));
  const baseDisplay: MatchResult[] = results || activeBuyers.map((b: any) => ({
    buyerId: b.id,
    buyerName: b.buyerName || "Unknown",
    buyerEmail: b.buyerEmail,
    buyerCompany: b.buyerCompany,
    buyerType: b.buyerType,
    prequalified: b.prequalified,
    proofOfFunds: b.proofOfFunds,
    matchScore: b.matchScore,
    breakdown: b.matchBreakdown as MatchBreakdown | null,
    noCriteria: !b.buyerCriteria || Object.keys(b.buyerCriteria || {}).length === 0,
  }));
  const displayData: MatchResult[] = baseDisplay.map((m) => {
    const b = buyerById.get(m.buyerId);
    return {
      ...m,
      decision: b?.decision || "under_review",
      decisionNextStep: b?.decisionNextStep || null,
      decisionReason: b?.decisionReason || null,
      decisionAt: b?.decisionAt || null,
      crmSyncStatus: b?.crmSyncStatus || null,
    };
  });

  const sorted = [...displayData].sort((a, b) => (b.matchScore ?? -1) - (a.matchScore ?? -1));

  if (activeBuyers.length === 0) {
    return (
      <div className="text-center py-4">
        <Target className="h-5 w-5 mx-auto mb-1.5 opacity-20" />
        <p className="text-xs text-muted-foreground">No buyers to match</p>
      </div>
    );
  }

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
          {runMatching.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Zap className="h-3 w-3" />}
          {runMatching.isPending ? "Scoring..." : "Run Match"}
        </Button>
      </div>

      <div className="space-y-2">
        {sorted.map(buyer => {
          const badge = scoreBadge(buyer.matchScore, buyer.noCriteria);
          const isExpanded = expanded === buyer.buyerId;
          const bd = buyer.breakdown;

          return (
            <div key={buyer.buyerId} className="rounded-lg border border-border bg-card overflow-hidden">
              {/* Header */}
              <div
                className="flex items-center gap-2.5 p-2.5 cursor-pointer hover:bg-muted/20 transition-colors"
                onClick={() => setExpanded(isExpanded ? null : buyer.buyerId)}
              >
                {buyer.matchScore != null ? (
                  <div className={`text-lg font-bold tabular-nums w-10 text-center ${scoreColor(buyer.matchScore)}`}>
                    {buyer.matchScore}
                  </div>
                ) : (
                  <div className="text-lg font-bold tabular-nums w-10 text-center text-muted-foreground/30">—</div>
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{buyer.buyerName}</p>
                  <p className="text-2xs text-muted-foreground truncate">
                    {buyer.buyerCompany || buyer.buyerEmail}
                    {buyer.buyerType && ` · ${BUYER_TYPES.find(t => t.value === buyer.buyerType)?.label || buyer.buyerType}`}
                  </p>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  {buyer.prequalified && <Shield className="h-3 w-3 text-emerald-400" aria-label="Prequalified" />}
                  {buyer.proofOfFunds && <DollarSign className="h-3 w-3 text-emerald-400" aria-label="Proof of funds" />}
                  {(() => {
                    const db = decisionBadge(buyer.decision);
                    if (!db) return null;
                    const DIcon = db.Icon;
                    return (
                      <Badge variant="outline" className={`text-2xs gap-1 ${db.color}`}>
                        <DIcon className="h-2.5 w-2.5" />
                        {db.label}
                      </Badge>
                    );
                  })()}
                  <Badge variant="outline" className={`text-2xs ${badge.color}`}>
                    {badge.label}
                  </Badge>
                </div>
                {isExpanded ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground/40" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/40" />}
              </div>

              {/* Expanded breakdown */}
              {isExpanded && (
                <div className="border-t border-border p-2.5 space-y-3">
                  {/* Buyer decision block */}
                  {buyer.decision && buyer.decision !== "under_review" && (
                    <div className="rounded-md bg-muted/20 border border-border p-2 space-y-1">
                      <div className="flex items-center justify-between">
                        <p className="text-2xs font-medium text-muted-foreground uppercase tracking-wide">Buyer decision</p>
                        {buyer.crmSyncStatus === "synced" && (
                          <span className="text-2xs text-emerald-400 flex items-center gap-1">
                            <CheckCircle2 className="h-2.5 w-2.5" /> CRM synced
                          </span>
                        )}
                        {buyer.crmSyncStatus === "failed" && (
                          <span className="text-2xs text-rose-400 flex items-center gap-1" title="Update your CRM manually">
                            <AlertTriangle className="h-2.5 w-2.5" /> CRM sync failed
                          </span>
                        )}
                        {buyer.crmSyncStatus === "not_configured" && (
                          <span className="text-2xs text-muted-foreground/60">No CRM connected</span>
                        )}
                      </div>
                      {buyer.decisionNextStep && (
                        <p className="text-2xs">
                          <span className="text-muted-foreground">Next step: </span>
                          <span className="text-foreground">{buyer.decisionNextStep.replace(/_/g, " ")}</span>
                        </p>
                      )}
                      {buyer.decisionReason && (
                        <p className="text-2xs text-muted-foreground italic">&ldquo;{buyer.decisionReason}&rdquo;</p>
                      )}
                      {buyer.decisionAt && (
                        <p className="text-2xs text-muted-foreground/60">
                          {new Date(buyer.decisionAt).toLocaleDateString()} · {new Date(buyer.decisionAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      )}
                    </div>
                  )}
                  {bd && bd.criteriaTested > 0 ? (
                    <>
                      {/* Score summary */}
                      <div className="flex items-center gap-3 text-2xs">
                        <span className="text-muted-foreground">
                          {bd.criteriaMatched}/{bd.criteriaTested} criteria matched
                        </span>
                        <span className="text-muted-foreground">·</span>
                        <span className="text-muted-foreground">
                          Data completeness: {bd.dataCompleteness}%
                        </span>
                        {bd.aiQualitative && (
                          <>
                            <span className="text-muted-foreground">·</span>
                            <span className="text-muted-foreground flex items-center gap-0.5">
                              <Brain className="h-3 w-3" /> AI: {bd.aiScore}/100
                            </span>
                          </>
                        )}
                      </div>

                      {/* Category bars */}
                      <div className="space-y-1.5">
                        {(["financialFit", "industryFit", "locationFit", "operationalFit", "dealStructureFit"] as const).map(catKey => {
                          const cat = bd[catKey];
                          if (!cat || cat.max === 0) return null;
                          const Icon = CAT_ICONS[catKey] || BarChart3;
                          const pct = Math.round((cat.score / cat.max) * 100);
                          return (
                            <Collapsible key={catKey}>
                              <CollapsibleTrigger className="w-full">
                                <div className="flex items-center gap-2">
                                  <Icon className="h-3 w-3 text-muted-foreground/50 shrink-0" />
                                  <span className="text-2xs w-20 text-left">{CAT_LABELS[catKey]}</span>
                                  <div className="flex-1">
                                    <Progress value={pct} className="h-1.5" />
                                  </div>
                                  <span className={`text-2xs font-semibold tabular-nums w-10 text-right ${scoreColor(pct)}`}>
                                    {pct}%
                                  </span>
                                  <ChevronDown className="h-3 w-3 text-muted-foreground/30" />
                                </div>
                              </CollapsibleTrigger>
                              <CollapsibleContent>
                                <div className="ml-5 mt-1 space-y-0.5">
                                  {Object.entries(cat.details).map(([key, detail]) => (
                                    <div key={key} className="flex items-start gap-1.5 text-2xs py-0.5">
                                      <DetailIcon score={detail.score} max={detail.max} />
                                      <span className="text-muted-foreground flex-1">{detail.note}</span>
                                    </div>
                                  ))}
                                </div>
                              </CollapsibleContent>
                            </Collapsible>
                          );
                        })}
                      </div>

                      {/* AI assessment */}
                      {bd.aiQualitative && (
                        <div className="rounded-md bg-muted/20 border border-border p-2 space-y-1.5">
                          <p className="text-2xs font-medium flex items-center gap-1">
                            <Brain className="h-3 w-3 text-teal" /> AI Qualitative Assessment
                          </p>
                          <div className="grid grid-cols-3 gap-1">
                            {[
                              { key: "growthAlignment", label: "Growth" },
                              { key: "competitiveMoat", label: "Moat" },
                              { key: "managementDepth", label: "Mgmt" },
                              { key: "customerHealth", label: "Customers" },
                              { key: "strategicFit", label: "Strategic" },
                              { key: "reasonForSaleRisk", label: "Sale risk" },
                            ].map(({ key, label }) => {
                              const val = (bd.aiQualitative as any)[key] as number;
                              return (
                                <div key={key} className="text-center">
                                  <span className={`text-xs font-bold tabular-nums ${scoreColor(val * 10)}`}>{val}</span>
                                  <span className="text-2xs text-muted-foreground/60">/10</span>
                                  <p className="text-[9px] text-muted-foreground">{label}</p>
                                </div>
                              );
                            })}
                          </div>
                          {bd.aiQualitative.overallAssessment && (
                            <p className="text-2xs text-muted-foreground italic">{bd.aiQualitative.overallAssessment}</p>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="text-center py-2">
                      <AlertTriangle className="h-4 w-4 mx-auto mb-1 opacity-30" />
                      <p className="text-2xs text-muted-foreground">
                        {buyer.noCriteria ? "No criteria set — edit buyer profile to add criteria" : "Run match to see results"}
                      </p>
                    </div>
                  )}

                  <Button
                    variant="outline"
                    size="sm"
                    className="h-6 text-2xs gap-1 w-full"
                    onClick={(e) => { e.stopPropagation(); setEditingBuyer(buyer.buyerId); }}
                  >
                    <Edit3 className="h-3 w-3" /> Edit buyer criteria
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {editingBuyer && (
        <BuyerCriteriaDialog
          dealId={dealId}
          buyer={activeBuyers.find((b: any) => b.id === editingBuyer)}
          onClose={() => setEditingBuyer(null)}
        />
      )}
    </div>
  );
}

// ── Comprehensive Criteria Editor ────────────────────────────────────────────
function BuyerCriteriaDialog({ dealId, buyer, onClose }: { dealId: string; buyer: any; onClose: () => void }) {
  const existing = (buyer?.buyerCriteria || {}) as Record<string, any>;
  const [criteria, setCriteria] = useState<Record<string, any>>(existing);
  const [buyerType, setBuyerType] = useState(buyer?.buyerType || "");
  const [prequalified, setPrequalified] = useState(buyer?.prequalified || false);
  const [proofOfFunds, setProofOfFunds] = useState(buyer?.proofOfFunds || false);
  const [notes, setNotes] = useState(buyer?.buyerNotes || "");

  const update = (key: string, val: any) => setCriteria(prev => ({ ...prev, [key]: val }));

  const save = useMutation({
    mutationFn: async () => {
      // Clean empty values
      const cleaned: Record<string, any> = {};
      for (const [k, v] of Object.entries(criteria)) {
        if (v === "" || v === null || v === undefined) continue;
        if (Array.isArray(v) && v.length === 0) continue;
        cleaned[k] = v;
      }

      const res = await apiRequest("PATCH", `/api/buyers/${buyer.id}/profile`, {
        buyerType: buyerType || null,
        prequalified,
        proofOfFunds,
        buyerNotes: notes || null,
        buyerCriteria: cleaned,
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
      <DialogContent className="max-w-lg max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="text-sm">Buyer Criteria — {buyer?.buyerName || buyer?.buyerEmail}</DialogTitle>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto scrollbar-thin space-y-4 pr-1">
          {/* Profile basics */}
          <div className="space-y-2">
            <p className="text-xs font-medium">Profile</p>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-2xs">Buyer type</Label>
                <Select value={buyerType} onValueChange={setBuyerType}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Select..." /></SelectTrigger>
                  <SelectContent>
                    {BUYER_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2 pt-3">
                <div className="flex items-center justify-between">
                  <Label className="text-2xs">Prequalified</Label>
                  <Switch checked={prequalified} onCheckedChange={setPrequalified} className="scale-75" />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-2xs">Proof of funds</Label>
                  <Switch checked={proofOfFunds} onCheckedChange={setProofOfFunds} className="scale-75" />
                </div>
              </div>
            </div>
          </div>

          {/* Criteria sections */}
          <Tabs defaultValue="financial" className="w-full">
            <TabsList className="flex-wrap h-auto gap-0.5 p-0.5">
              {Object.entries(BUYER_CRITERIA_SECTIONS).map(([key, section]) => (
                <TabsTrigger key={key} value={key} className="text-2xs px-2 py-1 h-auto">
                  {section.label.replace(" Criteria", "").replace(" & Strategic", "")}
                </TabsTrigger>
              ))}
            </TabsList>

            {Object.entries(BUYER_CRITERIA_SECTIONS).map(([sectionKey, section]) => (
              <TabsContent key={sectionKey} value={sectionKey} className="mt-3 space-y-2">
                {Object.entries(section.fields).map(([fieldKey, fieldDef]) => {
                  const def = fieldDef as { label: string; type: string; options?: readonly string[] };
                  const value = criteria[fieldKey];

                  if (def.type === "currency" || def.type === "number" || def.type === "percent") {
                    return (
                      <div key={fieldKey} className="space-y-0.5">
                        <Label className="text-2xs text-muted-foreground">{def.label}</Label>
                        <Input
                          className="h-7 text-xs"
                          placeholder={def.type === "currency" ? "e.g. 500000" : def.type === "percent" ? "e.g. 25" : "e.g. 10"}
                          value={value || ""}
                          onChange={e => update(fieldKey, e.target.value)}
                        />
                      </div>
                    );
                  }

                  if (def.type === "select" && def.options) {
                    return (
                      <div key={fieldKey} className="space-y-0.5">
                        <Label className="text-2xs text-muted-foreground">{def.label}</Label>
                        <Select value={value || ""} onValueChange={v => update(fieldKey, v)}>
                          <SelectTrigger className="h-7 text-xs"><SelectValue placeholder="Any" /></SelectTrigger>
                          <SelectContent>
                            <SelectItem value="">Any</SelectItem>
                            {(def.options as readonly string[]).map(opt => (
                              <SelectItem key={opt} value={opt}>{opt.replace(/_/g, " ")}</SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    );
                  }

                  if (def.type === "multiselect" && def.options) {
                    const selected = (value as string[]) || [];
                    return (
                      <div key={fieldKey} className="space-y-1">
                        <Label className="text-2xs text-muted-foreground">{def.label}</Label>
                        <div className="flex flex-wrap gap-1">
                          {(def.options as readonly string[]).map(opt => {
                            const active = selected.includes(opt);
                            return (
                              <button
                                key={opt}
                                type="button"
                                className={`text-2xs px-2 py-0.5 rounded-full border transition-colors ${
                                  active
                                    ? "bg-teal/15 text-teal border-teal/30"
                                    : "bg-muted/30 text-muted-foreground border-transparent hover:border-border"
                                }`}
                                onClick={() => {
                                  if (opt === "any") {
                                    update(fieldKey, ["any"]);
                                  } else {
                                    const next = active
                                      ? selected.filter(s => s !== opt)
                                      : [...selected.filter(s => s !== "any"), opt];
                                    update(fieldKey, next);
                                  }
                                }}
                              >
                                {opt.replace(/_/g, " ")}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    );
                  }

                  if (def.type === "boolean") {
                    return (
                      <div key={fieldKey} className="flex items-center justify-between py-0.5">
                        <Label className="text-2xs text-muted-foreground">{def.label}</Label>
                        <Switch
                          checked={value || false}
                          onCheckedChange={v => update(fieldKey, v)}
                          className="scale-75"
                        />
                      </div>
                    );
                  }

                  if (def.type === "tags") {
                    return (
                      <div key={fieldKey} className="space-y-0.5">
                        <Label className="text-2xs text-muted-foreground">{def.label} (comma-separated)</Label>
                        <Input
                          className="h-7 text-xs"
                          placeholder="e.g. Construction, HVAC, Plumbing"
                          value={Array.isArray(value) ? value.join(", ") : (value || "")}
                          onChange={e => update(fieldKey, e.target.value.split(",").map(s => s.trim()).filter(Boolean))}
                        />
                      </div>
                    );
                  }

                  return null;
                })}
              </TabsContent>
            ))}
          </Tabs>

          {/* Notes */}
          <div className="space-y-1">
            <Label className="text-2xs text-muted-foreground">Broker notes (internal)</Label>
            <Textarea className="text-xs min-h-[40px]" placeholder="Internal notes..." value={notes} onChange={e => setNotes(e.target.value)} />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-3 border-t border-border shrink-0">
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1" onClick={() => save.mutate()} disabled={save.isPending}>
            <Save className="h-3 w-3" /> Save Criteria
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
