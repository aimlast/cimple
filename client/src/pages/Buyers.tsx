/**
 * Buyers — broker's personal contact list of buyers.
 *
 * Aggregates buyers from every route in (auto-populated, not just manual):
 * deal access, NDAs signed, manual adds, CSV imports and the CRM sync.
 *
 * Search, filter (source / type / interest), sort (last activity, name,
 * profile, score). Each buyer opens their full profile page
 * (/broker/buyers/:id — BuyerProfilePage).
 */
import { useState, useMemo } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { CrmBuyerSyncCard } from "@/components/buyers/CrmBuyerSyncCard";
import {
  Users, Plus, Upload, Search,
  ShieldCheck, Target, ChevronRight, ArrowUpDown,
  Sparkles, UserPlus, AlertCircle, RefreshCw,
} from "lucide-react";

/**
 * JSON request that surfaces the server's own error message. `apiRequest`
 * throws a bare "500: {...}" string on non-2xx; mutations here need the
 * parsed `error` field so the toast says what actually went wrong.
 */
async function requestJson<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "include",
  });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const data = await res.json();
      if (data?.error) message = String(data.error);
      else if (data?.message) message = String(data.message);
    } catch {
      // non-JSON body — keep the status fallback
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

// ── Types ──────────────────────────────────────────────────────────────────
type Tier = "hot" | "warm" | "cool" | "cold";
type Interest = "hot" | "warm" | "cold" | "not_interested";

interface BuyerRow {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  company: string | null;
  title: string | null;
  linkedinUrl: string | null;
  buyerType: string | null;
  background: string | null;
  liquidFunds: string | null;
  hasProofOfFunds: boolean;
  targetIndustries: string[];
  targetLocations: string[];
  profileCompletionPct: number;
  source: string;
  hasAccount: boolean;
  tags: string[];
  notes: string | null;
  interestStatus: Interest | null;
  contactId: string | null;
  addedAt: string;
  dealCount: number;
  lastActivityAt: string | null;
  latestDecision: string | null;
  qualifiedScore: {
    total: number;
    tier: Tier;
    reasons: string[];
  };
}

const TIER_STYLES: Record<Tier, { bg: string; label: string }> = {
  hot:  { bg: "bg-red-500/15 text-red-400 border-red-500/30",       label: "Hot" },
  warm: { bg: "bg-orange-500/15 text-orange-400 border-orange-500/30", label: "Warm" },
  cool: { bg: "bg-sky-500/15 text-sky-400 border-sky-500/30",          label: "Cool" },
  cold: { bg: "bg-muted/30 text-muted-foreground border-border",       label: "Cold" },
};

const INTEREST_STYLES: Record<Interest, { label: string; chip: string; dot: string }> = {
  hot: { label: "Hot", chip: "border-red-500/30 bg-red-500/10 text-red-400", dot: "bg-red-400" },
  warm: { label: "Warm", chip: "border-amber-500/30 bg-amber-500/10 text-amber-400", dot: "bg-amber-400" },
  cold: { label: "Cold", chip: "border-sky-500/30 bg-sky-500/10 text-sky-400", dot: "bg-sky-400" },
  not_interested: { label: "Not interested", chip: "border-border bg-muted/40 text-muted-foreground", dot: "bg-muted-foreground/60" },
};

const BUYER_TYPE_LABELS: Record<string, string> = {
  individual: "Individual",
  strategic: "Strategic acquirer",
  financial: "Financial buyer",
  search_fund: "Search fund",
  family_office: "Family office",
  private_equity: "Private equity",
};

// How the buyer came into the broker's list (server: listSource in profile-view.ts).
const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  manual: { label: "Added by you", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  csv: { label: "CSV import", color: "bg-purple-500/15 text-purple-400 border-purple-500/30" },
  crm: { label: "CRM", color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  nda: { label: "Signed NDA", color: "bg-sky-500/15 text-sky-400 border-sky-500/30" },
  deal: { label: "Deal access", color: "bg-teal/15 text-teal border-teal/30" },
  self_signup: { label: "Self-signup", color: "bg-green-500/15 text-green-400 border-green-500/30" },
};

type SortKey = "activity" | "name" | "completion" | "score";
const SORTS: Record<SortKey, { label: string; cmp: (a: BuyerRow, b: BuyerRow) => number }> = {
  activity: {
    label: "Last activity",
    cmp: (a, b) => (b.lastActivityAt ? +new Date(b.lastActivityAt) : 0) - (a.lastActivityAt ? +new Date(a.lastActivityAt) : 0) || +new Date(b.addedAt) - +new Date(a.addedAt),
  },
  name: { label: "Name", cmp: (a, b) => a.name.localeCompare(b.name) },
  completion: { label: "Profile completeness", cmp: (a, b) => b.profileCompletionPct - a.profileCompletionPct },
  score: { label: "Lead score", cmp: (a, b) => (b.qualifiedScore?.total ?? 0) - (a.qualifiedScore?.total ?? 0) },
};

// Broker identity comes from the server session — no client-side broker id.

function formatRelative(iso: string | null): string {
  if (!iso) return "Never";
  const then = new Date(iso).getTime();
  const now = Date.now();
  const diff = now - then;
  const d = Math.floor(diff / 86400000);
  if (d === 0) return "Today";
  if (d === 1) return "Yesterday";
  if (d < 7) return `${d}d ago`;
  if (d < 30) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

function InterestChip({ value }: { value: Interest | null }) {
  if (!value) return <span className="text-xs text-muted-foreground/50">—</span>;
  const s = INTEREST_STYLES[value];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-2xs font-medium leading-4 whitespace-nowrap ${s.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />{s.label}
    </span>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────
export default function Buyers() {
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [interestFilter, setInterestFilter] = useState<string>("all");
  const [sort, setSort] = useState<SortKey>("activity");
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const { data, isLoading, error, refetch, isFetching } = useQuery<{ buyers: BuyerRow[] }>({
    queryKey: ["/api/broker/buyers"],
    queryFn: () => apiRequest("GET", "/api/broker/buyers").then(r => r.json()),
  });

  const buyers = data?.buyers ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return buyers.filter(b => {
      if (q) {
        const hay = `${b.name} ${b.email} ${b.company ?? ""} ${(b.tags ?? []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (sourceFilter !== "all" && b.source !== sourceFilter) return false;
      if (typeFilter !== "all" && b.buyerType !== typeFilter) return false;
      if (interestFilter === "none" && b.interestStatus) return false;
      if (interestFilter !== "all" && interestFilter !== "none" && b.interestStatus !== interestFilter) return false;
      return true;
    }).sort(SORTS[sort].cmp);
  }, [buyers, search, sourceFilter, typeFilter, interestFilter, sort]);

  const stats = useMemo(() => {
    const withProfile = buyers.filter(b => b.profileCompletionPct >= 50).length;
    const withPOF = buyers.filter(b => b.hasProofOfFunds).length;
    const active = buyers.filter(b => b.lastActivityAt).length;
    return { total: buyers.length, withProfile, withPOF, active };
  }, [buyers]);

  const open = (id: string) => setLocation(`/broker/buyers/${id}`);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border px-4 sm:px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold text-foreground flex items-center gap-2">
              <Users className="h-5 w-5 text-teal" />
              Buyers
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">
              Your personal contact list of buyers across every deal.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setImportOpen(true)}
              data-testid="button-import-csv"
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              Import CSV
            </Button>
            <Button
              size="sm"
              onClick={() => setAddOpen(true)}
              data-testid="button-add-buyer"
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Add buyer
            </Button>
          </div>
        </div>
      </div>

      <div className="flex-1 p-4 sm:p-6 space-y-5 sm:space-y-6">
        <CrmBuyerSyncCard />

        {/* Stats row */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total buyers" value={stats.total} icon={<Users className="h-3.5 w-3.5" />} />
          <StatCard label="With profile" value={stats.withProfile} icon={<Target className="h-3.5 w-3.5" />} />
          <StatCard label="Proof of funds" value={stats.withPOF} icon={<ShieldCheck className="h-3.5 w-3.5" />} />
          <StatCard label="Engaged" value={stats.active} icon={<Sparkles className="h-3.5 w-3.5" />} />
        </div>

        {/* Filters + Search */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative w-full sm:flex-1 sm:min-w-[240px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, company or tag..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
              data-testid="input-search-buyers"
            />
          </div>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[calc(50%-4px)] sm:w-[150px] h-9" data-testid="select-source-filter">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              {Object.entries(SOURCE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[calc(50%-4px)] sm:w-[160px] h-9" data-testid="select-type-filter">
              <SelectValue placeholder="Buyer type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {Object.entries(BUYER_TYPE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={interestFilter} onValueChange={setInterestFilter}>
            <SelectTrigger className="w-[calc(50%-4px)] sm:w-[150px] h-9" data-testid="select-interest-filter">
              <SelectValue placeholder="Interest" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any interest</SelectItem>
              {Object.entries(INTEREST_STYLES).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
              <SelectItem value="none">Not set</SelectItem>
            </SelectContent>
          </Select>
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="w-[calc(50%-4px)] sm:w-[180px] h-9" data-testid="select-sort">
              <ArrowUpDown className="h-3.5 w-3.5 mr-1.5 text-muted-foreground shrink-0" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(SORTS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* List */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : error ? (
              <ErrorState
                title="Couldn't load your buyers"
                message={error instanceof Error ? error.message : undefined}
                retrying={isFetching}
                onRetry={() => refetch()}
              />
            ) : filtered.length === 0 ? (
              <EmptyState hasBuyers={buyers.length > 0} onAdd={() => setAddOpen(true)} onImport={() => setImportOpen(true)} />
            ) : (
              <>
                {/* Phone: stacked rows */}
                <ul className="divide-y divide-border md:hidden">
                  {filtered.map((b) => (
                    <li key={b.id}>
                      <button type="button" className="flex w-full items-center gap-3 px-4 py-3 text-left active:bg-muted/40" onClick={() => open(b.id)} data-testid={`row-buyer-${b.id}`}>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="truncate text-sm font-medium text-foreground">{b.name}</span>
                            {b.hasProofOfFunds && <ShieldCheck className="h-3 w-3 shrink-0 text-teal" />}
                            {b.interestStatus && <InterestChip value={b.interestStatus} />}
                          </div>
                          <p className="truncate text-xs text-muted-foreground">{[b.company, b.buyerType ? BUYER_TYPE_LABELS[b.buyerType] ?? b.buyerType : null].filter(Boolean).join(" · ") || b.email}</p>
                          <div className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground tabular-nums">
                            {b.qualifiedScore && <span className={`rounded-full border px-1.5 ${TIER_STYLES[b.qualifiedScore.tier].bg}`}>Score {b.qualifiedScore.total}</span>}
                            <span>{b.profileCompletionPct}% profile</span>
                            {b.dealCount > 0 && <span>{b.dealCount} deal{b.dealCount === 1 ? "" : "s"}</span>}
                            <span>{formatRelative(b.lastActivityAt)}</span>
                          </div>
                        </div>
                        <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                      </button>
                    </li>
                  ))}
                </ul>

                {/* Tablet / desktop: table */}
                <div className="hidden md:block">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-xs">Name</TableHead>
                        <TableHead className="text-xs">Company</TableHead>
                        <TableHead className="text-xs">Type</TableHead>
                        <TableHead className="text-xs">Interest</TableHead>
                        <TableHead className="text-xs">Lead score</TableHead>
                        <TableHead className="text-xs">Profile</TableHead>
                        <TableHead className="text-xs hidden lg:table-cell">Source</TableHead>
                        <TableHead className="text-xs">Deals</TableHead>
                        <TableHead className="text-xs">Last activity</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {filtered.map((b) => (
                        <TableRow
                          key={b.id}
                          className="cursor-pointer hover:bg-muted/30 group"
                          onClick={() => open(b.id)}
                          onKeyDown={(e) => { if (e.key === "Enter") open(b.id); }}
                          tabIndex={0}
                          data-testid={`row-buyer-${b.id}`}
                        >
                          <TableCell>
                            <div className="flex flex-col min-w-0">
                              <span className="text-sm font-medium text-foreground group-hover:text-teal transition-colors">{b.name}</span>
                              <span className="text-xs text-muted-foreground truncate max-w-[220px]">{b.email}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-sm text-muted-foreground">
                            {b.company ?? "—"}
                          </TableCell>
                          <TableCell>
                            {b.buyerType ? (
                              <Badge variant="outline" className="text-xs font-normal whitespace-nowrap">
                                {BUYER_TYPE_LABELS[b.buyerType] ?? b.buyerType}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell><InterestChip value={b.interestStatus} /></TableCell>
                          <TableCell>
                            {b.qualifiedScore ? (
                              <Badge
                                variant="outline"
                                className={`text-2xs font-normal whitespace-nowrap ${TIER_STYLES[b.qualifiedScore.tier].bg}`}
                                title={`Lead score ${b.qualifiedScore.total}/100 (${b.qualifiedScore.tier}) — profile, proof of funds and engagement${b.qualifiedScore.reasons.length ? ": " + b.qualifiedScore.reasons.join(" · ") : ""}`}
                              >
                                {b.qualifiedScore.total}
                              </Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-2">
                              <div className="w-14 h-1 bg-muted rounded-full overflow-hidden">
                                <div
                                  className="h-full bg-teal transition-all"
                                  style={{ width: `${b.profileCompletionPct}%` }}
                                />
                              </div>
                              <span className="text-2xs text-muted-foreground tabular-nums">
                                {b.profileCompletionPct}%
                              </span>
                              {b.hasProofOfFunds && (
                                <ShieldCheck className="h-3 w-3 text-teal" />
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="hidden lg:table-cell">
                            <Badge
                              variant="outline"
                              className={`text-2xs font-normal whitespace-nowrap ${SOURCE_LABELS[b.source]?.color ?? "bg-muted/30"}`}
                            >
                              {SOURCE_LABELS[b.source]?.label ?? b.source}
                            </Badge>
                          </TableCell>
                          <TableCell className="text-sm tabular-nums">
                            {b.dealCount > 0 ? (
                              <Badge variant="secondary" className="text-2xs">{b.dealCount}</Badge>
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                            {formatRelative(b.lastActivityAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </>
            )}
          </CardContent>
        </Card>
        {!isLoading && !error && filtered.length > 0 && (
          <p className="text-2xs text-muted-foreground">
            Showing {filtered.length} of {buyers.length} buyer{buyers.length === 1 ? "" : "s"} · sorted by {SORTS[sort].label.toLowerCase()}
          </p>
        )}
      </div>

      {/* Dialogs */}
      <AddBuyerDialog open={addOpen} onOpenChange={setAddOpen} />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} />
    </div>
  );
}

// ── Stat card ──────────────────────────────────────────────────────────────
function StatCard({ label, value, icon }: { label: string; value: number; icon: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">{label}</span>
          <span className="text-muted-foreground">{icon}</span>
        </div>
        <div className="text-2xl font-semibold text-foreground tabular-nums mt-1">{value}</div>
      </CardContent>
    </Card>
  );
}

// ── Error state — distinct from "no buyers" ───────────────────────────────
function ErrorState({
  title,
  message,
  retrying,
  onRetry,
}: {
  title: string;
  message?: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="p-12 text-center space-y-4" role="alert" data-testid="buyers-error">
      <div className="h-12 w-12 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
        <AlertCircle className="h-6 w-6 text-destructive" />
      </div>
      <div>
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
          {message || "The server didn't respond. Check your connection and try again."}
        </p>
      </div>
      <Button size="sm" variant="outline" onClick={onRetry} disabled={retrying} data-testid="button-retry-buyers">
        <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${retrying ? "animate-spin" : ""}`} />
        {retrying ? "Retrying..." : "Retry"}
      </Button>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────
function EmptyState({
  hasBuyers,
  onAdd,
  onImport,
}: {
  hasBuyers: boolean;
  onAdd: () => void;
  onImport: () => void;
}) {
  if (hasBuyers) {
    // Filtered to nothing
    return (
      <div className="p-12 text-center">
        <p className="text-sm text-muted-foreground">No buyers match your filters.</p>
      </div>
    );
  }
  return (
    <div className="p-12 text-center space-y-4">
      <div className="h-12 w-12 rounded-full bg-teal/10 flex items-center justify-center mx-auto">
        <Users className="h-6 w-6 text-teal" />
      </div>
      <div>
        <h3 className="text-sm font-medium text-foreground">No buyers yet</h3>
        <p className="text-xs text-muted-foreground mt-1 max-w-sm mx-auto">
          Add buyers manually, import from CSV, or they'll be populated automatically
          when you grant access to a deal.
        </p>
      </div>
      <div className="flex items-center justify-center gap-2">
        <Button size="sm" variant="outline" onClick={onImport}>
          <Upload className="h-3.5 w-3.5 mr-1.5" />
          Import CSV
        </Button>
        <Button size="sm" onClick={onAdd}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Add buyer
        </Button>
      </div>
    </div>
  );
}

// ── Add buyer dialog ───────────────────────────────────────────────────────
function AddBuyerDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: "",
    email: "",
    company: "",
    phone: "",
    title: "",
    linkedinUrl: "",
    buyerType: "",
    targetIndustries: "",
    targetLocations: "",
    liquidFunds: "",
    hasProofOfFunds: false,
    notes: "",
    sendInvite: false,
  });

  const reset = () => setForm({
    name: "", email: "", company: "", phone: "", title: "", linkedinUrl: "",
    buyerType: "", targetIndustries: "", targetLocations: "", liquidFunds: "",
    hasProofOfFunds: false, notes: "", sendInvite: false,
  });

  const mutation = useMutation({
    mutationFn: async () => {
      const payload = {
        email: form.email.trim(),
        name: form.name.trim(),
        company: form.company.trim() || null,
        phone: form.phone.trim() || null,
        title: form.title.trim() || null,
        linkedinUrl: form.linkedinUrl.trim() || null,
        buyerType: form.buyerType || null,
        targetIndustries: form.targetIndustries.split(",").map(s => s.trim()).filter(Boolean),
        targetLocations: form.targetLocations.split(",").map(s => s.trim()).filter(Boolean),
        liquidFunds: form.liquidFunds.trim() || null,
        hasProofOfFunds: form.hasProofOfFunds,
        notes: form.notes.trim() || null,
        sendInvite: form.sendInvite,
      };
      return requestJson("POST", "/api/broker/buyers", payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers"] });
      toast({
        title: "Buyer added",
        description: form.sendInvite
          ? `${form.name} has been added. They'll receive a set-password email.`
          : `${form.name} has been added to your contact list.`,
      });
      reset();
      onOpenChange(false);
    },
    onError: (err: Error) => {
      toast({ title: "Failed to add buyer", description: err.message, variant: "destructive" });
    },
  });

  const canSubmit = form.name.trim() && form.email.trim() && form.email.includes("@");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <UserPlus className="h-4 w-4 text-teal" />
            Add buyer
          </DialogTitle>
          <DialogDescription>
            Add a buyer to your contact list. They won't receive any email unless you
            check "send invite" below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-2">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Name *</Label>
              <Input
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
                placeholder="Jane Doe"
                data-testid="input-add-name"
              />
            </div>
            <div>
              <Label className="text-xs">Email *</Label>
              <Input
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                placeholder="jane@example.com"
                data-testid="input-add-email"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Company</Label>
              <Input
                value={form.company}
                onChange={(e) => setForm({ ...form, company: e.target.value })}
                placeholder="Acme Ventures"
              />
            </div>
            <div>
              <Label className="text-xs">Title</Label>
              <Input
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                placeholder="Managing Partner"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Phone</Label>
              <Input
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
                placeholder="+1 555 123 4567"
              />
            </div>
            <div>
              <Label className="text-xs">LinkedIn URL</Label>
              <Input
                value={form.linkedinUrl}
                onChange={(e) => setForm({ ...form, linkedinUrl: e.target.value })}
                placeholder="linkedin.com/in/..."
              />
            </div>
          </div>

          <div>
            <Label className="text-xs">Buyer type</Label>
            <Select value={form.buyerType} onValueChange={(v) => setForm({ ...form, buyerType: v })}>
              <SelectTrigger data-testid="select-add-type">
                <SelectValue placeholder="Select a type..." />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(BUYER_TYPE_LABELS).map(([k, v]) => (
                  <SelectItem key={k} value={k}>{v}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Target industries</Label>
              <Input
                value={form.targetIndustries}
                onChange={(e) => setForm({ ...form, targetIndustries: e.target.value })}
                placeholder="SaaS, Manufacturing"
              />
              <p className="text-2xs text-muted-foreground mt-0.5">Comma-separated</p>
            </div>
            <div>
              <Label className="text-xs">Target locations</Label>
              <Input
                value={form.targetLocations}
                onChange={(e) => setForm({ ...form, targetLocations: e.target.value })}
                placeholder="USA, Canada"
              />
              <p className="text-2xs text-muted-foreground mt-0.5">Comma-separated</p>
            </div>
          </div>

          <div>
            <Label className="text-xs">Liquid funds available</Label>
            <Input
              value={form.liquidFunds}
              onChange={(e) => setForm({ ...form, liquidFunds: e.target.value })}
              placeholder="$2M - $5M"
            />
          </div>

          <div>
            <Label className="text-xs">Notes</Label>
            <Textarea
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="Internal notes about this buyer..."
              rows={2}
            />
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-border">
            <div className="flex items-center gap-2">
              <Switch
                id="hasPOF"
                checked={form.hasProofOfFunds}
                onCheckedChange={(v) => setForm({ ...form, hasProofOfFunds: v })}
              />
              <Label htmlFor="hasPOF" className="text-xs cursor-pointer">Has proof of funds</Label>
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="sendInvite"
                checked={form.sendInvite}
                onCheckedChange={(v) => setForm({ ...form, sendInvite: v })}
                data-testid="switch-send-invite"
              />
              <Label htmlFor="sendInvite" className="text-xs cursor-pointer">Send set-password email</Label>
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button
            size="sm"
            disabled={!canSubmit || mutation.isPending}
            onClick={() => mutation.mutate()}
            data-testid="button-submit-add-buyer"
          >
            {mutation.isPending ? "Adding..." : "Add buyer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── CSV import dialog ─────────────────────────────────────────────────────
function ImportCsvDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [csv, setCsv] = useState("");
  const [sendInvites, setSendInvites] = useState(false);
  const [result, setResult] = useState<null | {
    accepted: Array<{ email: string; name: string; status: string }>;
    rejected: Array<{ row: number; reason: string }>;
    totalRows: number;
  }>(null);

  const mutation = useMutation({
    mutationFn: async () => {
      return requestJson("POST", "/api/broker/buyers/import-csv", {
        csv,
        sendInvites,
      });
    },
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers"] });
      toast({
        title: "Import complete",
        description: `${data.accepted.length} buyer${data.accepted.length === 1 ? "" : "s"} imported.`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Import failed", description: err.message, variant: "destructive" });
    },
  });

  const reset = () => {
    setCsv("");
    setResult(null);
    setSendInvites(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="h-4 w-4 text-teal" />
            Import buyers from CSV
          </DialogTitle>
          <DialogDescription>
            Paste your CSV below. The first row must be a header. Email is required;
            all other columns are optional.
          </DialogDescription>
        </DialogHeader>

        {!result ? (
          <div className="space-y-3 py-2">
            <div className="rounded-md border border-border bg-muted/30 p-3">
              <p className="text-xs font-medium text-foreground mb-1">Accepted columns</p>
              <p className="text-2xs text-muted-foreground leading-relaxed">
                <code className="text-teal">email</code> (required),{" "}
                <code>name</code>, <code>company</code>, <code>phone</code>, <code>title</code>,{" "}
                <code>linkedin_url</code>, <code>buyer_type</code>, <code>target_industries</code>,{" "}
                <code>target_locations</code>, <code>liquid_funds</code>, <code>has_proof_of_funds</code>,{" "}
                <code>notes</code>, <code>tags</code>
              </p>
              <p className="text-2xs text-muted-foreground mt-2">
                Multi-value fields (industries, locations, tags) use semicolons or pipes to separate values.
              </p>
            </div>

            <Textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              placeholder={`email,name,company,buyer_type\njane@acme.com,Jane Doe,Acme Ventures,private_equity\n...`}
              rows={10}
              className="font-mono text-xs"
              data-testid="textarea-csv-input"
            />

            <div className="flex items-center gap-2 pt-2 border-t border-border">
              <Switch
                id="importInvites"
                checked={sendInvites}
                onCheckedChange={setSendInvites}
              />
              <Label htmlFor="importInvites" className="text-xs cursor-pointer">
                Send set-password emails to new buyers
              </Label>
            </div>
          </div>
        ) : (
          <div className="space-y-3 py-2">
            <div className="grid grid-cols-3 gap-2">
              <div className="rounded-md border border-border p-3 text-center">
                <div className="text-xs text-muted-foreground">Total</div>
                <div className="text-2xl font-semibold tabular-nums">{result.totalRows}</div>
              </div>
              <div className="rounded-md border border-teal/30 bg-teal/5 p-3 text-center">
                <div className="text-xs text-teal">Accepted</div>
                <div className="text-2xl font-semibold tabular-nums text-teal">{result.accepted.length}</div>
              </div>
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-center">
                <div className="text-xs text-destructive">Rejected</div>
                <div className="text-2xl font-semibold tabular-nums text-destructive">{result.rejected.length}</div>
              </div>
            </div>

            {result.rejected.length > 0 && (
              <div>
                <p className="text-xs font-medium text-foreground mb-1.5">Rejected rows</p>
                <div className="border border-border rounded-md max-h-40 overflow-y-auto text-2xs">
                  {result.rejected.map((r, i) => (
                    <div key={i} className="px-2 py-1 border-b border-border last:border-0 flex gap-2">
                      <span className="text-muted-foreground tabular-nums">Row {r.row}</span>
                      <span className="text-destructive">{r.reason}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {result.accepted.length > 0 && (
              <div>
                <p className="text-xs font-medium text-foreground mb-1.5">Imported buyers</p>
                <div className="border border-border rounded-md max-h-40 overflow-y-auto text-2xs">
                  {result.accepted.map((r, i) => (
                    <div key={i} className="px-2 py-1 border-b border-border last:border-0 flex items-center justify-between">
                      <span className="text-foreground">{r.name} · {r.email}</span>
                      <Badge variant="outline" className="text-2xs">{r.status}</Badge>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          {!result ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button
                size="sm"
                disabled={!csv.trim() || mutation.isPending}
                onClick={() => mutation.mutate()}
                data-testid="button-submit-import-csv"
              >
                {mutation.isPending ? "Importing..." : "Import"}
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => { reset(); }}>Import another</Button>
              <Button size="sm" onClick={() => onOpenChange(false)}>Done</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
