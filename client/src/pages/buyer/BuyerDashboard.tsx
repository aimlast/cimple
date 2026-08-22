/**
 * BuyerDashboard — main buyer-side landing page.
 *
 * Shows all CIMs the buyer has access to with rich filters and thoughtful
 * match labelling that never discourages. Match info is shown as:
 *   - A raw count of criteria matched ("7 criteria matched")
 *   - The top 3 matching dimensions as positive chips
 *   - NEVER a letter grade or percentage
 *
 * This keeps buyers engaged with opportunities that partially fit their
 * criteria rather than dismissing them as "low grade" matches.
 *
 * Blind deals (teaser/full access) arrive with the project codename and
 * null location/description — the card must degrade gracefully, never
 * render "null", and never hint at what the view room withholds.
 */
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import {
  Loader2, Search, Sparkles, TrendingUp, Building2, MapPin, DollarSign,
  ChevronRight, UserCircle, AlertCircle, RefreshCw, Lock,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BuyerNav, readErrorBody } from "./shared";

interface DashboardDeal {
  dealId: string;
  businessName: string | null;
  industry: string | null;
  subIndustry: string | null;
  askingPrice: string | null;
  location: string | null;
  description: string | null;
  brokerFirm: string | null;
  accessToken: string;
  accessLevel: string;
  ndaSigned: boolean;
  lastAccessedAt: string | null;
  /** Optional server hint — links the server already filters out never reach us */
  accessStatus?: "active" | "expired" | "revoked";
  match: {
    criteriaMatched: number;
    criteriaTested: number;
    topDimensions: string[] | null;
    dataCompleteness: number;
  } | null;
}

interface DashboardData {
  deals: DashboardDeal[];
  profileCompletionPct: number;
}

type SortMode = "best_match" | "recent" | "price_high" | "price_low";

const FALLBACK_NAME = "Confidential Opportunity";

function parsePriceToNumber(price: string | null): number {
  if (!price) return 0;
  const cleaned = price.replace(/[^0-9.]/g, "");
  const n = parseFloat(cleaned);
  if (isNaN(n)) return 0;
  // Handle K/M/B suffixes
  const upper = price.toUpperCase();
  if (upper.includes("B")) return n * 1e9;
  if (upper.includes("M")) return n * 1e6;
  if (upper.includes("K")) return n * 1e3;
  return n;
}

/** Teaser/full access levels see the blind CIM — identity is withheld. */
function isBlindAccess(level: string): boolean {
  return !["loi", "due_diligence"].includes(String(level || ""));
}

export default function BuyerDashboard() {
  const [, setLocation] = useLocation();
  const [query, setQuery] = useState("");
  const [industryFilter, setIndustryFilter] = useState<string>("all");
  const [firmFilter, setFirmFilter] = useState<string>("all");
  const [sortMode, setSortMode] = useState<SortMode>("best_match");

  const { data, isLoading, error, refetch, isFetching } = useQuery<DashboardData>({
    queryKey: ["/api/buyer-auth/dashboard"],
    queryFn: async () => {
      const res = await fetch("/api/buyer-auth/dashboard", { credentials: "include" });
      if (res.status === 401) {
        window.location.href = "/buyer/login";
        throw new Error("Not authenticated");
      }
      if (!res.ok) {
        const body = await readErrorBody(res);
        throw new Error(body.error || "We couldn't load your opportunities right now.");
      }
      return res.json();
    },
  });

  const allDeals = useMemo(() => (Array.isArray(data?.deals) ? data!.deals : []), [data]);

  // Build filter option lists from dataset
  const industries = useMemo(() => {
    const set = new Set<string>();
    allDeals.forEach(d => { if (d.industry) set.add(d.industry); });
    return Array.from(set).sort();
  }, [allDeals]);

  const firms = useMemo(() => {
    const set = new Set<string>();
    allDeals.forEach(d => { if (d.brokerFirm) set.add(d.brokerFirm); });
    return Array.from(set).sort();
  }, [allDeals]);

  // Apply filters + sort
  const filteredDeals = useMemo(() => {
    let deals = allDeals;

    if (query) {
      const q = query.toLowerCase();
      deals = deals.filter(d =>
        (d.businessName || "").toLowerCase().includes(q)
        || (d.industry || "").toLowerCase().includes(q)
        || (d.subIndustry || "").toLowerCase().includes(q)
        || (d.description || "").toLowerCase().includes(q)
        || (d.location || "").toLowerCase().includes(q)
        || (d.brokerFirm || "").toLowerCase().includes(q),
      );
    }
    if (industryFilter !== "all") deals = deals.filter(d => d.industry === industryFilter);
    if (firmFilter !== "all") deals = deals.filter(d => d.brokerFirm === firmFilter);

    const sorted = [...deals];
    switch (sortMode) {
      case "best_match":
        sorted.sort((a, b) => (b.match?.criteriaMatched ?? 0) - (a.match?.criteriaMatched ?? 0));
        break;
      case "recent":
        sorted.sort((a, b) => {
          const at = a.lastAccessedAt ? new Date(a.lastAccessedAt).getTime() : 0;
          const bt = b.lastAccessedAt ? new Date(b.lastAccessedAt).getTime() : 0;
          return bt - at;
        });
        break;
      case "price_high":
        sorted.sort((a, b) => parsePriceToNumber(b.askingPrice) - parsePriceToNumber(a.askingPrice));
        break;
      case "price_low":
        sorted.sort((a, b) => parsePriceToNumber(a.askingPrice) - parsePriceToNumber(b.askingPrice));
        break;
    }
    return sorted;
  }, [allDeals, query, industryFilter, firmFilter, sortMode]);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // Distinguishable error state: keeps the nav (sign out / profile still
  // reachable) and offers a retry instead of a dead-end string.
  if (error || !data) {
    return (
      <div className="min-h-screen bg-background">
        <BuyerNav />
        <div className="max-w-6xl mx-auto px-6 py-8">
          <Card className="border-destructive/30">
            <CardContent className="p-8 text-center space-y-3" data-testid="dashboard-error">
              <AlertCircle className="h-8 w-8 mx-auto text-destructive/70" />
              <h2 className="text-lg font-semibold">Couldn't load your opportunities</h2>
              <p className="text-sm text-muted-foreground">
                {error instanceof Error ? error.message : "Something went wrong on our side."}
              </p>
              <div className="flex items-center justify-center gap-2 pt-1">
                <Button onClick={() => refetch()} disabled={isFetching} data-testid="button-retry-dashboard">
                  {isFetching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Try again
                </Button>
                <Button variant="outline" onClick={() => setLocation("/buyer/profile")}>
                  <UserCircle className="h-3.5 w-3.5 mr-1.5" />
                  Go to profile
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <BuyerNav />

      <div className="max-w-6xl mx-auto px-6 py-8 space-y-6">
        {/* Header */}
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold">Your opportunities</h1>
            <p className="text-sm text-muted-foreground mt-1">
              {allDeals.length
                ? `${allDeals.length} ${allDeals.length === 1 ? "deal" : "deals"} you have access to`
                : "No deals yet — your broker-invited CIMs will appear here."}
            </p>
          </div>
          {(data.profileCompletionPct ?? 0) < 70 && (
            <Card className="max-w-sm">
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <Sparkles className="h-4 w-4 text-primary mt-0.5" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">Complete your profile</div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Add your investment criteria to see stronger matches across your deals.
                    </p>
                    <div className="h-1 bg-muted rounded-full mt-2 overflow-hidden">
                      <div
                        className="h-full bg-primary transition-all"
                        style={{ width: `${data.profileCompletionPct ?? 0}%` }}
                      />
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-1">
                      {data.profileCompletionPct ?? 0}% complete
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="mt-2 w-full"
                      onClick={() => setLocation("/buyer/profile")}
                    >
                      <UserCircle className="h-3 w-3 mr-1.5" />
                      Complete profile
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </div>

        {/* Filters */}
        {allDeals.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[240px]">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Search deals..."
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="pl-8"
                data-testid="input-search-deals"
              />
            </div>
            {industries.length > 1 && (
              <Select value={industryFilter} onValueChange={setIndustryFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Industry" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All industries</SelectItem>
                  {industries.map(i => <SelectItem key={i} value={i}>{i}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            {firms.length > 1 && (
              <Select value={firmFilter} onValueChange={setFirmFilter}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Brokerage" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All brokerages</SelectItem>
                  {firms.map(f => <SelectItem key={f} value={f}>{f}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
            <Select value={sortMode} onValueChange={(v) => setSortMode(v as SortMode)}>
              <SelectTrigger className="w-[180px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="best_match">Best match</SelectItem>
                <SelectItem value="recent">Recently viewed</SelectItem>
                <SelectItem value="price_high">Price: high to low</SelectItem>
                <SelectItem value="price_low">Price: low to high</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {/* Deals grid */}
        {filteredDeals.length === 0 ? (
          <Card>
            <CardContent className="p-12 text-center text-sm text-muted-foreground" data-testid="dashboard-empty">
              {allDeals.length === 0
                ? "No CIMs yet — brokers will add you to deals and they'll show up here."
                : "No deals match your filters."}
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {filteredDeals.map((deal) => (
              <DealCard key={deal.dealId} deal={deal} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function DealCard({ deal }: { deal: DashboardDeal }) {
  const matchCount = deal.match?.criteriaMatched ?? 0;
  const topDimensions = deal.match?.topDimensions ?? [];
  const blind = isBlindAccess(deal.accessLevel);
  const name = (deal.businessName || "").trim() || FALLBACK_NAME;
  const inactive = deal.accessStatus === "expired" || deal.accessStatus === "revoked";

  const body = (
    <Card
      className={`h-full transition-colors ${
        inactive ? "opacity-70" : "hover:border-primary/50 cursor-pointer"
      }`}
      data-testid={`card-deal-${deal.dealId}`}
    >
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="font-semibold text-lg truncate flex items-center gap-2">
              <span className="truncate">{name}</span>
              {blind && (
                <Badge variant="outline" className="text-[10px] h-4 shrink-0 font-normal">
                  <Lock className="h-2.5 w-2.5 mr-1" />
                  Confidential
                </Badge>
              )}
            </div>
            {(deal.industry || deal.subIndustry) && (
              <div className="text-xs text-muted-foreground mt-0.5">
                {[deal.industry, deal.subIndustry].filter(Boolean).join(" · ")}
              </div>
            )}
          </div>
          {!inactive && <ChevronRight className="h-4 w-4 text-muted-foreground mt-1 flex-shrink-0" />}
        </div>

        {deal.description ? (
          <p className="text-xs text-muted-foreground line-clamp-2">{deal.description}</p>
        ) : blind ? (
          <p className="text-xs text-muted-foreground/70">
            Identifying details are withheld at this stage — open the secure view room for the full overview.
          </p>
        ) : null}

        {(deal.askingPrice || deal.location || deal.brokerFirm) && (
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            {deal.askingPrice && (
              <span className="flex items-center gap-1">
                <DollarSign className="h-3 w-3" />
                {deal.askingPrice}
              </span>
            )}
            {deal.location && (
              <span className="flex items-center gap-1">
                <MapPin className="h-3 w-3" />
                {deal.location}
              </span>
            )}
            {deal.brokerFirm && (
              <span className="flex items-center gap-1">
                <Building2 className="h-3 w-3" />
                {deal.brokerFirm}
              </span>
            )}
          </div>
        )}

        {/* Match badge — positive framing only */}
        {matchCount > 0 && deal.match && (
          <div className="flex items-center gap-2 flex-wrap pt-2 border-t border-border">
            <Badge className="bg-primary/10 text-primary border-primary/30 hover:bg-primary/20">
              <TrendingUp className="h-3 w-3 mr-1" />
              {matchCount} {matchCount === 1 ? "criterion" : "criteria"} matched
            </Badge>
            {topDimensions.map((dim) => (
              <Badge key={dim} variant="outline" className="text-xs">
                {dim}
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-[10px] text-muted-foreground pt-1">
          {inactive ? (
            <span className="text-destructive/80">
              {deal.accessStatus === "revoked" ? "Access revoked" : "Access expired"} — contact your broker
            </span>
          ) : (
            <span>{deal.ndaSigned ? "NDA signed" : "NDA required"}</span>
          )}
          {deal.lastAccessedAt && (
            <span>Last viewed {new Date(deal.lastAccessedAt).toLocaleDateString()}</span>
          )}
        </div>
      </CardContent>
    </Card>
  );

  if (inactive) return <div className="block">{body}</div>;

  return (
    <a href={`/view/${deal.accessToken}`} className="block" data-testid={`link-deal-${deal.dealId}`}>
      {body}
    </a>
  );
}
