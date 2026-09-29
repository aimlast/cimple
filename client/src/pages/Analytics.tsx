/**
 * Analytics — how buyers are reading the broker's CIMs, across their deals
 * (/broker/analytics). Only the signed-in broker's own deals.
 *
 *   Who to call today   the merged call list of every live deal, best lead
 *                       first, with why (CallListPanel — intelligence stream)
 *   Your deals compared opened, reading this week, reading time per buyer,
 *                       reached the end, NDA → Interested; what kind of
 *                       content holds attention in your CIMs (ComparePanel)
 *   One deal            jump straight to that deal's page-by-page heat map
 *                       ("Where they read" on its Engagement tab), plus the
 *                       per-buyer table, buyer ranking and activity feed.
 *
 * The old cursor-sample heat map (the grid of teal squares), the scroll
 * "Drop-off" chart and the per-section average cards are gone: the heat map
 * now lives on the real CIM, page by page, in each deal's Engagement tab.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Activity, ArrowRight, BarChart3, BookOpenText, Flame, PhoneCall, ShieldCheck, Target, UserCheck, Users,
} from "lucide-react";
import type { BuyerAccess, Deal } from "@shared/schema";
import { formatReadingTime } from "@shared/analytics-v2";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { queryClient } from "@/lib/queryClient";
import { PanelError } from "@/components/deal/PanelError";
import { BuyerComparison } from "@/components/deal/BuyerComparison";
import { ActivityTimeline } from "@/components/deal/ActivityTimeline";
import { CallListPanel } from "@/components/engagement/global/CallListPanel";
import { ComparePanel } from "@/components/engagement/global/ComparePanel";

// ── Types (the per-buyer table still reads /analytics/computed until the
//    capture stream moves it onto reading rollups) ────────────────────────
type Tier = "hot" | "warm" | "cool" | "cold";

interface BuyerBreakdown extends BuyerAccess {
  totalTimeSeconds: number;
  sectionsViewedCount: number;
  questionCount: number;
  hasAccount: boolean;
  profile: {
    buyerType: string | null;
    profileCompletionPct: number;
    hasProofOfFunds: boolean;
    company: string | null;
  } | null;
  match: {
    criteriaMatched: number;
    criteriaTested: number;
    topDimensions: string[];
  } | null;
  qualifiedScore: {
    total: number;
    tier: Tier;
    reasons: string[];
  } | null;
}

interface ComputedAnalytics {
  buyerBreakdown: BuyerBreakdown[];
}

const TIER_STYLES: Record<Tier, { bg: string; label: string }> = {
  hot: { bg: "bg-red-500/15 text-red-400 border-red-500/30", label: "Hot" },
  warm: { bg: "bg-orange-500/15 text-orange-400 border-orange-500/30", label: "Warm" },
  cool: { bg: "bg-sky-500/15 text-sky-400 border-sky-500/30", label: "Cool" },
  cold: { bg: "bg-muted/30 text-muted-foreground border-border", label: "Cold" },
};

const BUYER_TYPE_LABELS: Record<string, string> = {
  individual: "Individual",
  strategic: "Strategic",
  financial: "Financial",
  search_fund: "Search fund",
  family_office: "Family office",
  private_equity: "PE",
};

function fmtDate(d: string | Date | null): string {
  if (!d) return "Never";
  return new Date(d).toLocaleDateString();
}

/**
 * Fetch JSON from a broker endpoint, surfacing the server's `{ error }`
 * message. On 401 the cached auth check is invalidated so BrokerAuthGate
 * re-renders the sign-in screen instead of this page showing zeros.
 */
async function fetchJson<T>(url: string, fallback: string): Promise<T> {
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) {
    if (res.status === 401) {
      queryClient.invalidateQueries({ queryKey: ["/api/broker-auth/me"] });
      throw new Error("Your session has expired — please sign in again.");
    }
    let message = `${fallback} (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = String(data.error);
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  return res.json();
}

// ── Main ───────────────────────────────────────────────────────────────────
export default function Analytics() {
  const { data: deals, isLoading: dealsLoading, isError: dealsError, refetch: refetchDeals } = useQuery<Deal[]>({
    queryKey: ["/api/deals"],
    queryFn: () => fetchJson<Deal[]>("/api/deals", "Couldn't load your deals"),
  });
  const active = useMemo(
    () => (deals ?? []).filter((d) => !d.archivedAt),
    [deals],
  );
  const [selectedDealId, setSelectedDealId] = useState<string | null>(null);
  // Default to a live deal (the one most likely to have readers), else the first.
  useEffect(() => {
    if (selectedDealId || active.length === 0) return;
    setSelectedDealId((active.find((d) => d.isLive) ?? active[0]).id);
  }, [active, selectedDealId]);
  const selectedDeal = active.find((d) => d.id === selectedDealId) ?? null;

  return (
    <div className="space-y-6 px-4 pb-12 pt-6 sm:px-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Analytics</h1>
        <p className="mt-0.5 text-sm text-muted-foreground">How buyers are reading your CIMs, across your deals.</p>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <PhoneCall className="h-4 w-4 text-teal" /> Who to call today
          </CardTitle>
          <CardDescription>Across your live deals, best lead first, with what to talk about.</CardDescription>
        </CardHeader>
        <CardContent>
          <CallListPanel />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <BarChart3 className="h-4 w-4 text-teal" /> Your deals compared
          </CardTitle>
          <CardDescription>Who opened each CIM, who is reading it now, how far they got, and what kind of content holds their attention.</CardDescription>
        </CardHeader>
        <CardContent>
          <ComparePanel />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <CardTitle className="flex items-center gap-2 text-sm">
                <BookOpenText className="h-4 w-4 text-teal" /> One deal in detail
              </CardTitle>
              <CardDescription>See where buyers read on the CIM itself, page by page, and each buyer's activity.</CardDescription>
            </div>
            {dealsLoading ? (
              <Skeleton className="h-9 w-56" />
            ) : active.length > 0 ? (
              <Select value={selectedDealId ?? undefined} onValueChange={setSelectedDealId}>
                <SelectTrigger className="w-full sm:w-[260px]" data-testid="analytics-deal-picker">
                  <SelectValue placeholder="Choose a deal" />
                </SelectTrigger>
                <SelectContent>
                  {active.map((d) => (
                    <SelectItem key={d.id} value={d.id}>{d.businessName || `Deal ${d.id.slice(0, 8)}`}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {dealsError ? (
            <PanelError what="your deals" onRetry={() => refetchDeals()} />
          ) : !selectedDeal ? (
            <p className="text-sm text-muted-foreground">{dealsLoading ? " " : "No deals yet."}</p>
          ) : (
            <>
              <Link
                href={`/deal/${selectedDeal.id}/engagement?view=document`}
                className="group flex items-center gap-4 rounded-lg border border-teal/30 bg-teal/5 p-4 transition-colors hover:bg-teal/10"
                data-testid="analytics-open-heatmap"
              >
                <HeatMapThumb />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Where buyers read in {selectedDeal.businessName}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    Page through the CIM exactly as buyers saw it: the parts they spent the most time on glow, with who read what and for how long.
                  </p>
                </div>
                <ArrowRight className="h-4 w-4 shrink-0 text-teal transition-transform group-hover:translate-x-0.5" />
              </Link>
              <DealDetailTabs dealId={selectedDeal.id} />
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** A tiny paper page with glowing parts — says "heat map on the CIM" at a glance. */
function HeatMapThumb() {
  return (
    <svg width="44" height="54" viewBox="0 0 44 54" aria-hidden className="shrink-0 rounded-[2px] shadow">
      <rect width="44" height="54" rx="2" fill="#FBF9F4" />
      <rect x="5" y="5" width="22" height="3" rx="1" fill="#201D18" opacity="0.75" />
      <rect x="5" y="12" width="34" height="9" rx="1.5" fill="#D18E3A" opacity="0.6" />
      <rect x="5" y="24" width="34" height="2" rx="1" fill="#201D18" opacity="0.25" />
      <rect x="5" y="28" width="30" height="2" rx="1" fill="#201D18" opacity="0.25" />
      <rect x="5" y="34" width="16" height="12" rx="1.5" fill="#F3E6C4" />
      <rect x="23" y="34" width="16" height="12" rx="1.5" fill="#B4582A" opacity="0.55" />
    </svg>
  );
}

function DealDetailTabs({ dealId }: { dealId: string }) {
  const [tab, setTab] = useState("buyers");
  const { data: computed, isLoading, isError, refetch } = useQuery<ComputedAnalytics>({
    queryKey: ["/api/deals", dealId, "analytics/computed"],
    queryFn: () => fetchJson<ComputedAnalytics>(`/api/deals/${dealId}/analytics/computed`, "Couldn't load deal analytics"),
  });
  const buyers = computed?.buyerBreakdown ?? [];

  return (
    <Tabs value={tab} onValueChange={setTab} className="w-full">
      <TabsList className="h-auto flex-wrap gap-1">
        <TabsTrigger value="buyers" className="gap-1.5"><Users className="h-3.5 w-3.5" /> Each buyer</TabsTrigger>
        <TabsTrigger value="scores" className="gap-1.5"><Flame className="h-3.5 w-3.5" /> Buyer ranking</TabsTrigger>
        <TabsTrigger value="activity" className="gap-1.5"><Activity className="h-3.5 w-3.5" /> Activity</TabsTrigger>
      </TabsList>

      <TabsContent value="buyers" className="mt-4">
        {isLoading ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10" />)}</div>
        ) : isError ? (
          <PanelError what="buyer activity" onRetry={() => refetch()} />
        ) : buyers.length === 0 ? (
          <div className="py-10 text-center">
            <Users className="mx-auto mb-3 h-8 w-8 opacity-20" />
            <p className="text-sm text-muted-foreground">No buyers have opened this CIM yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Buyer</TableHead>
                  <TableHead>Lead</TableHead>
                  <TableHead className="hidden md:table-cell">Profile</TableHead>
                  <TableHead className="hidden md:table-cell">Match fit</TableHead>
                  <TableHead className="text-right">Reading time</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">Sections</TableHead>
                  <TableHead className="hidden sm:table-cell text-right">Questions</TableHead>
                  <TableHead className="hidden lg:table-cell">Last seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {buyers.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <p className="text-sm font-medium">{b.buyerName || "Unknown"}</p>
                        {b.hasAccount && (
                          <span title="Has a Cimple account"><UserCheck className="h-3 w-3 text-primary" /></span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{b.profile?.company || b.buyerCompany || b.buyerEmail}</p>
                    </TableCell>
                    <TableCell>
                      {b.qualifiedScore ? (
                        <Badge variant="outline" className={`text-[10px] font-normal ${TIER_STYLES[b.qualifiedScore.tier].bg}`} title={b.qualifiedScore.reasons.join(" · ")}>
                          {TIER_STYLES[b.qualifiedScore.tier].label}
                        </Badge>
                      ) : (
                        <span className="text-[10px] italic text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {b.profile ? (
                        <div className="flex flex-col gap-1">
                          {b.profile.buyerType && (
                            <Badge variant="outline" className="w-fit text-[10px]">{BUYER_TYPE_LABELS[b.profile.buyerType] || b.profile.buyerType}</Badge>
                          )}
                          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                            <span>{b.profile.profileCompletionPct}% complete</span>
                            {b.profile.hasProofOfFunds && (
                              <span className="flex items-center gap-0.5 text-emerald-500" title="Proof of funds available">
                                <ShieldCheck className="h-2.5 w-2.5" /> PoF
                              </span>
                            )}
                          </div>
                        </div>
                      ) : (
                        <span className="text-[10px] italic text-muted-foreground">No account</span>
                      )}
                    </TableCell>
                    <TableCell className="hidden md:table-cell">
                      {b.match && b.match.criteriaMatched > 0 ? (
                        <div className="flex flex-col gap-1">
                          <Badge className="w-fit border-primary/30 bg-primary/10 text-[10px] text-primary">
                            <Target className="mr-0.5 h-2.5 w-2.5" /> {b.match.criteriaMatched} criteria
                          </Badge>
                          {b.match.topDimensions.length > 0 && (
                            <span className="max-w-[140px] truncate text-[10px] text-muted-foreground">{b.match.topDimensions.join(" · ")}</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-[10px] italic text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm tabular-nums">{formatReadingTime(b.totalTimeSeconds * 1000)}</TableCell>
                    <TableCell className="hidden sm:table-cell text-right text-sm">{b.sectionsViewedCount}</TableCell>
                    <TableCell className="hidden sm:table-cell text-right text-sm">{b.questionCount > 0 ? b.questionCount : "—"}</TableCell>
                    <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{fmtDate(b.lastAccessedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </TabsContent>

      <TabsContent value="scores" className="mt-4">
        <BuyerComparison dealId={dealId} />
      </TabsContent>

      <TabsContent value="activity" className="mt-4">
        <ActivityTimeline dealId={dealId} />
      </TabsContent>
    </Tabs>
  );
}
