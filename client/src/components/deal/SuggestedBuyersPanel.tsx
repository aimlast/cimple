/**
 * SuggestedBuyersPanel — proactive buyer-to-deal outreach
 *
 * Workflow (broker stays in control — Cimple NEVER auto-sends):
 *   1. Server scores every buyer in the broker's contact list against the deal
 *      using the deep matching engine + composite qualified-lead scorer.
 *   2. Broker sees a ranked list with tier chips, criteria-matched count,
 *      top match dimensions, and reasons.
 *   3. Broker multi-selects buyers and clicks "Draft outreach".
 *   4. Claude Sonnet drafts personalised emails — broker reviews and edits
 *      every one in a Sheet drawer.
 *   5. Broker clicks "Send selected" → confirmation → server dispatches via
 *      Resend and records the outreach.
 *   6. Outreach history shows every email the broker has sent.
 *
 * IMPORTANT: This is broker-facing only. Composite scores and tier chips
 * never appear on buyer-facing UI.
 */
import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  Sparkles, Send, Loader2, CheckCircle2, ShieldCheck,
  ChevronDown, ChevronUp, Mail, TrendingUp, Zap,
  AlertCircle, Clock, Target,
} from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";

// ── Types ──────────────────────────────────────────────────────────────────
type Tier = "hot" | "warm" | "cool" | "cold";

interface SuggestedBuyer {
  buyerUserId: string;
  name: string;
  email: string;
  company: string | null;
  title: string | null;
  buyerType: string | null;
  hasProofOfFunds: boolean;
  profileCompletionPct: number;
  targetIndustries: string[] | null;
  source: string;
  tags: string[];
  alreadyHasAccess: boolean;
  alreadyContacted: boolean;
  match: {
    criteriaMatched: number;
    criteriaTested: number;
    deterministicScore: number;
    topDimensions: string[];
  } | null;
  qualifiedScore: {
    total: number;
    tier: Tier;
    reasons: string[];
    breakdown: {
      matchFit: number;
      profile: number;
      engagement: number;
      proofOfFunds: number;
    };
  };
  lastActivityAt: string | null;
}

interface SuggestedBuyersResponse {
  dealId: string;
  businessName: string;
  industry: string;
  suggested: SuggestedBuyer[];
  totalCandidates: number;
}

interface Draft {
  buyerUserId: string;
  buyerName: string;
  buyerEmail: string;
  subject: string;
  body: string;
}

interface OutreachHistoryItem {
  id: string;
  buyerUserId: string;
  buyerEmail: string;
  buyerName: string;
  subject: string;
  body: string;
  status: string;
  qualifiedScore: number | null;
  matchScore: number | null;
  topDimensions: string[];
  sentAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

const TIER_STYLES: Record<Tier, { bg: string; text: string; border: string; label: string }> = {
  hot:  { bg: "bg-red-500/15",    text: "text-red-400",    border: "border-red-500/30",    label: "Hot" },
  warm: { bg: "bg-orange-500/15", text: "text-orange-400", border: "border-orange-500/30", label: "Warm" },
  cool: { bg: "bg-sky-500/15",    text: "text-sky-400",    border: "border-sky-500/30",    label: "Cool" },
  cold: { bg: "bg-muted/30",      text: "text-muted-foreground", border: "border-border",  label: "Cold" },
};

const BUYER_TYPE_LABELS: Record<string, string> = {
  individual: "Individual",
  strategic: "Strategic",
  financial: "PE / Financial",
  search_fund: "Search Fund",
  family_office: "Family Office",
  private_equity: "Private Equity",
};

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  const diff = Date.now() - then;
  const d = Math.floor(diff / 86400000);
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

// ── Main panel ─────────────────────────────────────────────────────────────
export function SuggestedBuyersPanel({ dealId }: { dealId: string }) {
  const { toast } = useToast();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftSheetOpen, setDraftSheetOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showContacted, setShowContacted] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // ── Queries ──────────────────────────────────────────────────────────────
  const { data, isLoading, refetch } = useQuery<SuggestedBuyersResponse>({
    queryKey: ["/api/deals", dealId, "suggested-buyers"],
    enabled: !!dealId,
  });

  const { data: historyData } = useQuery<{ history: OutreachHistoryItem[] }>({
    queryKey: ["/api/deals", dealId, "outreach-history"],
    enabled: !!dealId,
  });

  // ── Mutations ────────────────────────────────────────────────────────────
  const draftMutation = useMutation({
    mutationFn: async (buyerUserIds: string[]) => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/draft-outreach`, { buyerUserIds });
      return r.json() as Promise<{ drafts: Draft[] }>;
    },
    onSuccess: (resp) => {
      setDrafts(resp.drafts);
      setDraftSheetOpen(true);
      toast({ description: `Drafted ${resp.drafts.length} email${resp.drafts.length === 1 ? "" : "s"} — review and edit before sending.` });
    },
    onError: () => {
      toast({ variant: "destructive", description: "Failed to draft outreach. Try again." });
    },
  });

  const sendMutation = useMutation({
    mutationFn: async () => {
      // Pull qualifiedScore + topDimensions from the suggested list to snapshot
      const suggMap = new Map(data?.suggested.map(s => [s.buyerUserId, s]) ?? []);
      const payload = drafts.map(d => {
        const s = suggMap.get(d.buyerUserId);
        return {
          buyerUserId: d.buyerUserId,
          subject: d.subject,
          body: d.body,
          qualifiedScore: s?.qualifiedScore.total,
          matchScore: s?.match?.deterministicScore,
          topDimensions: s?.match?.topDimensions ?? [],
        };
      });
      const r = await apiRequest("POST", `/api/deals/${dealId}/send-outreach`, { outreach: payload });
      return r.json() as Promise<{ sent: number; total: number; results: Array<{ status: string; buyerName: string }> }>;
    },
    onSuccess: (resp) => {
      const failed = resp.total - resp.sent;
      toast({
        description: failed === 0
          ? `${resp.sent} email${resp.sent === 1 ? "" : "s"} sent successfully`
          : `${resp.sent} sent, ${failed} failed`,
      });
      setDraftSheetOpen(false);
      setConfirmOpen(false);
      setDrafts([]);
      setSelected(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "outreach-history"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "suggested-buyers"] });
    },
    onError: () => {
      toast({ variant: "destructive", description: "Failed to send outreach. Try again." });
      setConfirmOpen(false);
    },
  });

  // ── Derived ──────────────────────────────────────────────────────────────
  const visibleBuyers = useMemo(() => {
    if (!data) return [];
    return data.suggested.filter(b => {
      if (b.alreadyHasAccess) return false; // never re-suggest
      if (!showContacted && b.alreadyContacted) return false;
      return true;
    });
  }, [data, showContacted]);

  const stats = useMemo(() => {
    if (!data) return { total: 0, hot: 0, warm: 0, contacted: 0 };
    return {
      total: data.suggested.length,
      hot: data.suggested.filter(b => b.qualifiedScore.tier === "hot").length,
      warm: data.suggested.filter(b => b.qualifiedScore.tier === "warm").length,
      contacted: data.suggested.filter(b => b.alreadyContacted).length,
    };
  }, [data]);

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllTopN = (n: number) => {
    const ids = visibleBuyers.slice(0, n).map(b => b.buyerUserId);
    setSelected(new Set(ids));
  };

  const updateDraft = (id: string, field: "subject" | "body", value: string) => {
    setDrafts(prev => prev.map(d => d.buyerUserId === id ? { ...d, [field]: value } : d));
  };

  // ── Render ───────────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-teal" />
            Suggested buyers
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Ranked by qualified-lead score. Cimple drafts the email — you review, edit, and send.
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          <Button
            variant="outline"
            size="sm"
            onClick={() => refetch()}
            data-testid="button-refresh-suggested"
          >
            <Zap className="h-3 w-3 mr-1" />
            Re-score
          </Button>
        </div>
      </div>

      {/* Stat row */}
      <div className="grid grid-cols-4 gap-2">
        <StatPill label="Candidates" value={stats.total} />
        <StatPill label="Hot" value={stats.hot} accent="text-red-400" />
        <StatPill label="Warm" value={stats.warm} accent="text-orange-400" />
        <StatPill label="Contacted" value={stats.contacted} accent="text-muted-foreground" />
      </div>

      {/* Selection controls */}
      {visibleBuyers.length > 0 && (
        <div className="flex items-center justify-between gap-2 px-1">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">
              {selected.size > 0 ? `${selected.size} selected` : "Select buyers to draft outreach"}
            </span>
            {selected.size === 0 && (
              <>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => selectAllTopN(5)}>
                  Top 5
                </Button>
                <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => selectAllTopN(10)}>
                  Top 10
                </Button>
              </>
            )}
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
              <Checkbox
                checked={showContacted}
                onCheckedChange={(v) => setShowContacted(!!v)}
                data-testid="checkbox-show-contacted"
              />
              Show already contacted
            </label>
            <Button
              size="sm"
              disabled={selected.size === 0 || draftMutation.isPending}
              onClick={() => draftMutation.mutate(Array.from(selected))}
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              data-testid="button-draft-outreach"
            >
              {draftMutation.isPending ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Drafting…</>
              ) : (
                <><Mail className="h-3 w-3 mr-1" />Draft outreach</>
              )}
            </Button>
          </div>
        </div>
      )}

      {/* Buyer list */}
      {visibleBuyers.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <Target className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">No suggested buyers yet</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Add buyers to your contact list to see ranked suggestions for this deal.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {visibleBuyers.map((buyer) => (
            <BuyerRow
              key={buyer.buyerUserId}
              buyer={buyer}
              selected={selected.has(buyer.buyerUserId)}
              onToggle={() => toggleSelect(buyer.buyerUserId)}
            />
          ))}
        </div>
      )}

      {/* Outreach history (collapsible) */}
      {historyData?.history && historyData.history.length > 0 && (
        <Collapsible open={historyOpen} onOpenChange={setHistoryOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="w-full justify-between mt-2">
              <span className="text-xs flex items-center gap-2">
                <Clock className="h-3 w-3" />
                Outreach history ({historyData.history.length})
              </span>
              {historyOpen ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 space-y-1.5">
            {historyData.history.map((h) => (
              <div
                key={h.id}
                className="flex items-center justify-between gap-3 p-2 rounded border border-border bg-muted/10 text-xs"
                data-testid={`history-item-${h.id}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground truncate">{h.buyerName}</div>
                  <div className="text-muted-foreground truncate">{h.subject}</div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-2xs text-muted-foreground">
                    {formatRelative(h.sentAt ?? h.createdAt)}
                  </span>
                  <StatusBadge status={h.status} />
                </div>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Draft review Sheet */}
      <Sheet open={draftSheetOpen} onOpenChange={setDraftSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-[640px] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Mail className="h-4 w-4 text-teal" />
              Review outreach drafts
            </SheetTitle>
            <SheetDescription>
              Edit any draft before sending. Cimple will not send anything until you click the send button below.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-4 space-y-4">
            {drafts.map((d, i) => (
              <Card key={d.buyerUserId} className="border-border">
                <CardContent className="p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-xs">
                      <span className="font-medium text-foreground">{d.buyerName}</span>
                      <span className="text-muted-foreground"> · {d.buyerEmail}</span>
                    </div>
                    <span className="text-2xs text-muted-foreground">{i + 1} / {drafts.length}</span>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-2xs text-muted-foreground">Subject</Label>
                    <Input
                      value={d.subject}
                      onChange={(e) => updateDraft(d.buyerUserId, "subject", e.target.value)}
                      className="h-8 text-xs"
                      data-testid={`input-subject-${d.buyerUserId}`}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-2xs text-muted-foreground">Body</Label>
                    <Textarea
                      value={d.body}
                      onChange={(e) => updateDraft(d.buyerUserId, "body", e.target.value)}
                      className="text-xs font-mono min-h-[180px]"
                      data-testid={`textarea-body-${d.buyerUserId}`}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <div className="sticky bottom-0 bg-background border-t border-border pt-3 mt-4 flex items-center justify-between gap-2">
            <span className="text-xs text-muted-foreground">
              {drafts.length} draft{drafts.length === 1 ? "" : "s"} ready
            </span>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => setDraftSheetOpen(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                className="bg-teal text-teal-foreground hover:bg-teal/90"
                onClick={() => setConfirmOpen(true)}
                disabled={drafts.length === 0}
                data-testid="button-send-outreach"
              >
                <Send className="h-3 w-3 mr-1" />
                Send {drafts.length} email{drafts.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

      {/* Confirm send dialog */}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send {drafts.length} outreach email{drafts.length === 1 ? "" : "s"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Cimple will dispatch these emails on your behalf via Resend. Each recipient will receive
              their personalised message immediately. This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={sendMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => sendMutation.mutate()}
              disabled={sendMutation.isPending}
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              data-testid="button-confirm-send"
            >
              {sendMutation.isPending ? (
                <><Loader2 className="h-3 w-3 mr-1 animate-spin" />Sending…</>
              ) : (
                <><Send className="h-3 w-3 mr-1" />Send now</>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────
function StatPill({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded border border-border bg-muted/20 px-2 py-1.5">
      <div className={`text-base font-semibold tabular-nums ${accent ?? "text-foreground"}`}>{value}</div>
      <div className="text-2xs text-muted-foreground uppercase tracking-wider">{label}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, { bg: string; label: string; icon?: any }> = {
    sent:    { bg: "bg-teal/15 text-teal border-teal/30", label: "Sent", icon: CheckCircle2 },
    failed:  { bg: "bg-red-500/15 text-red-400 border-red-500/30", label: "Failed", icon: AlertCircle },
    opened:  { bg: "bg-blue-500/15 text-blue-400 border-blue-500/30", label: "Opened" },
    clicked: { bg: "bg-purple-500/15 text-purple-400 border-purple-500/30", label: "Clicked" },
    replied: { bg: "bg-green-500/15 text-green-400 border-green-500/30", label: "Replied" },
    draft:   { bg: "bg-muted/30 text-muted-foreground border-border", label: "Draft" },
  };
  const s = styles[status] ?? styles.draft;
  const Icon = s.icon;
  return (
    <Badge variant="outline" className={`text-2xs ${s.bg}`}>
      {Icon && <Icon className="h-2.5 w-2.5 mr-0.5" />}
      {s.label}
    </Badge>
  );
}

function BuyerRow({
  buyer,
  selected,
  onToggle,
}: {
  buyer: SuggestedBuyer;
  selected: boolean;
  onToggle: () => void;
}) {
  const tier = TIER_STYLES[buyer.qualifiedScore.tier];

  return (
    <div
      className={`flex items-start gap-3 p-3 rounded-md border transition-colors cursor-pointer ${
        selected ? "border-teal bg-teal/5" : "border-border bg-muted/10 hover:bg-muted/20"
      }`}
      onClick={onToggle}
      data-testid={`suggested-buyer-${buyer.buyerUserId}`}
    >
      <Checkbox checked={selected} onCheckedChange={onToggle} className="mt-1" />

      <div className="flex-1 min-w-0 space-y-1.5">
        {/* Top row: name + tier + already contacted badge */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-foreground">{buyer.name}</span>
          {buyer.company && (
            <span className="text-xs text-muted-foreground">· {buyer.company}</span>
          )}
          {buyer.buyerType && (
            <Badge variant="outline" className="text-2xs font-normal">
              {BUYER_TYPE_LABELS[buyer.buyerType] ?? buyer.buyerType}
            </Badge>
          )}
          <Badge variant="outline" className={`text-2xs font-normal ${tier.bg} ${tier.text} ${tier.border}`}>
            {tier.label} · {buyer.qualifiedScore.total}
          </Badge>
          {buyer.hasProofOfFunds && (
            <Badge variant="outline" className="text-2xs bg-teal/10 text-teal border-teal/30">
              <ShieldCheck className="h-2.5 w-2.5 mr-0.5" />
              POF
            </Badge>
          )}
          {buyer.alreadyContacted && (
            <Badge variant="outline" className="text-2xs bg-amber-500/10 text-amber-400 border-amber-500/30">
              Already contacted
            </Badge>
          )}
        </div>

        {/* Match dimensions */}
        {buyer.match && buyer.match.criteriaMatched > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-2xs text-muted-foreground">
              {buyer.match.criteriaMatched} criteria matched ·
            </span>
            {buyer.match.topDimensions.map((dim) => (
              <Badge key={dim} variant="outline" className="text-2xs font-normal bg-teal/5 border-teal/20 text-teal">
                {dim}
              </Badge>
            ))}
          </div>
        )}

        {/* Composite reasons (skip the "criteria matched" reason since it's
            already shown above as a badge row) */}
        {(() => {
          const extraReasons = buyer.qualifiedScore.reasons.filter(r => !/criteria match/i.test(r));
          if (extraReasons.length === 0) return null;
          return (
            <div className="text-2xs text-muted-foreground">
              {extraReasons.slice(0, 3).join(" · ")}
            </div>
          );
        })()}
      </div>

      {/* Right column: profile completion */}
      <div className="shrink-0 flex flex-col items-end gap-1 text-2xs text-muted-foreground">
        <div className="flex items-center gap-1">
          <TrendingUp className="h-2.5 w-2.5" />
          <span className="tabular-nums">{buyer.profileCompletionPct}%</span>
        </div>
        <div className="text-2xs">{buyer.email}</div>
      </div>
    </div>
  );
}
