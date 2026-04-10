/**
 * Buyers — broker's personal contact list of buyers.
 *
 * Aggregates buyers from three sources (auto-populated, not just manual):
 *   1. Buyers granted access to any of this broker's deals
 *   2. Buyers manually added via the "Add buyer" form
 *   3. Buyers imported via CSV (or CRM in future)
 *
 * Supports filter by source / buyer type / profile status, free-text search,
 * and a detail drawer showing the buyer's profile and per-deal engagement.
 */
import { useState, useMemo, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  Users, Plus, Upload, Search, Mail, Phone, Building2,
  ShieldCheck, Target, ExternalLink, FileText, Tag,
  Sparkles, UserPlus, Link as LinkIcon,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────
type Tier = "hot" | "warm" | "cool" | "cold";

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
  tags: string[];
  notes: string | null;
  contactId: string | null;
  addedAt: string;
  dealCount: number;
  lastActivityAt: string | null;
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

interface BuyerDetail {
  buyer: BuyerRow & { buyerCriteria: Record<string, any> | null; createdAt: string; lastLoginAt: string | null };
  contact: { id: string; tags: string[]; notes: string | null; source: string; addedAt: string } | null;
  deals: Array<{ dealId: string; businessName: string; lastAccessedAt: string | null; viewCount: number; decision: string | null }>;
}

const BUYER_TYPE_LABELS: Record<string, string> = {
  individual: "Individual",
  strategic: "Strategic acquirer",
  financial: "Financial buyer",
  search_fund: "Search fund",
  family_office: "Family office",
  private_equity: "Private equity",
};

const SOURCE_LABELS: Record<string, { label: string; color: string }> = {
  manual: { label: "Manual", color: "bg-blue-500/15 text-blue-400 border-blue-500/30" },
  csv: { label: "CSV import", color: "bg-purple-500/15 text-purple-400 border-purple-500/30" },
  crm: { label: "CRM", color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
  deal: { label: "Deal access", color: "bg-teal/15 text-teal border-teal/30" },
  signup: { label: "Self-signup", color: "bg-green-500/15 text-green-400 border-green-500/30" },
  self_signup: { label: "Self-signup", color: "bg-green-500/15 text-green-400 border-green-500/30" },
  broker_invited: { label: "Invited", color: "bg-teal/15 text-teal border-teal/30" },
  crm_imported: { label: "CRM", color: "bg-orange-500/15 text-orange-400 border-orange-500/30" },
};

const BROKER_ID = "default-broker";

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

// ── Main page ──────────────────────────────────────────────────────────────
export default function Buyers() {
  const [search, setSearch] = useState("");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [selectedBuyerId, setSelectedBuyerId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

  const { data, isLoading } = useQuery<{ buyers: BuyerRow[] }>({
    queryKey: ["/api/broker/buyers", BROKER_ID],
    queryFn: () => apiRequest("GET", `/api/broker/buyers?brokerId=${BROKER_ID}`).then(r => r.json()),
  });

  const buyers = data?.buyers ?? [];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return buyers.filter(b => {
      if (q) {
        const hay = `${b.name} ${b.email} ${b.company ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (sourceFilter !== "all" && b.source !== sourceFilter) return false;
      if (typeFilter !== "all" && b.buyerType !== typeFilter) return false;
      return true;
    });
  }, [buyers, search, sourceFilter, typeFilter]);

  const stats = useMemo(() => {
    const withProfile = buyers.filter(b => b.profileCompletionPct >= 50).length;
    const withPOF = buyers.filter(b => b.hasProofOfFunds).length;
    const active = buyers.filter(b => b.lastActivityAt).length;
    return { total: buyers.length, withProfile, withPOF, active };
  }, [buyers]);

  return (
    <div className="flex flex-col min-h-screen bg-background">
      {/* Header */}
      <div className="border-b border-border px-6 py-5">
        <div className="flex items-center justify-between gap-4">
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

      <div className="flex-1 p-6 space-y-6">
        {/* Stats row */}
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="Total buyers" value={stats.total} icon={<Users className="h-3.5 w-3.5" />} />
          <StatCard label="With profile" value={stats.withProfile} icon={<Target className="h-3.5 w-3.5" />} />
          <StatCard label="Proof of funds" value={stats.withPOF} icon={<ShieldCheck className="h-3.5 w-3.5" />} />
          <StatCard label="Engaged" value={stats.active} icon={<Sparkles className="h-3.5 w-3.5" />} />
        </div>

        {/* Filters + Search */}
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search by name, email, or company..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 h-9"
              data-testid="input-search-buyers"
            />
          </div>
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[160px] h-9" data-testid="select-source-filter">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All sources</SelectItem>
              <SelectItem value="manual">Manual</SelectItem>
              <SelectItem value="csv">CSV import</SelectItem>
              <SelectItem value="deal">Deal access</SelectItem>
              <SelectItem value="self_signup">Self-signup</SelectItem>
              <SelectItem value="broker_invited">Invited</SelectItem>
            </SelectContent>
          </Select>
          <Select value={typeFilter} onValueChange={setTypeFilter}>
            <SelectTrigger className="w-[180px] h-9" data-testid="select-type-filter">
              <SelectValue placeholder="Buyer type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All types</SelectItem>
              {Object.entries(BUYER_TYPE_LABELS).map(([k, v]) => (
                <SelectItem key={k} value={k}>{v}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Table */}
        <Card>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-6 space-y-3">
                {Array.from({ length: 5 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState hasBuyers={buyers.length > 0} onAdd={() => setAddOpen(true)} onImport={() => setImportOpen(true)} />
            ) : (
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="text-xs">Name</TableHead>
                    <TableHead className="text-xs">Company</TableHead>
                    <TableHead className="text-xs">Type</TableHead>
                    <TableHead className="text-xs">Score</TableHead>
                    <TableHead className="text-xs">Profile</TableHead>
                    <TableHead className="text-xs">Source</TableHead>
                    <TableHead className="text-xs">Deals</TableHead>
                    <TableHead className="text-xs">Last activity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((b) => (
                    <TableRow
                      key={b.id}
                      className="cursor-pointer hover:bg-muted/30"
                      onClick={() => setSelectedBuyerId(b.id)}
                      data-testid={`row-buyer-${b.id}`}
                    >
                      <TableCell>
                        <div className="flex flex-col">
                          <span className="text-sm font-medium text-foreground">{b.name}</span>
                          <span className="text-xs text-muted-foreground">{b.email}</span>
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {b.company ?? "—"}
                      </TableCell>
                      <TableCell>
                        {b.buyerType ? (
                          <Badge variant="outline" className="text-xs font-normal">
                            {BUYER_TYPE_LABELS[b.buyerType] ?? b.buyerType}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {b.qualifiedScore ? (
                          <Badge
                            variant="outline"
                            className={`text-2xs font-normal ${TIER_STYLES[b.qualifiedScore.tier].bg}`}
                            title={b.qualifiedScore.reasons.join(" · ")}
                          >
                            {TIER_STYLES[b.qualifiedScore.tier].label} · {b.qualifiedScore.total}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <div className="w-16 h-1 bg-muted rounded-full overflow-hidden">
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
                      <TableCell>
                        <Badge
                          variant="outline"
                          className={`text-2xs font-normal ${SOURCE_LABELS[b.source]?.color ?? "bg-muted/30"}`}
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
                      <TableCell className="text-xs text-muted-foreground tabular-nums">
                        {formatRelative(b.lastActivityAt)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Dialogs + drawer */}
      <AddBuyerDialog open={addOpen} onOpenChange={setAddOpen} />
      <ImportCsvDialog open={importOpen} onOpenChange={setImportOpen} />
      <BuyerDetailDrawer
        buyerId={selectedBuyerId}
        onClose={() => setSelectedBuyerId(null)}
      />
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
        brokerId: BROKER_ID,
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
      const r = await apiRequest("POST", "/api/broker/buyers", payload);
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Failed to add buyer");
      }
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers", BROKER_ID] });
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
      const r = await apiRequest("POST", "/api/broker/buyers/import-csv", {
        brokerId: BROKER_ID,
        csv,
        sendInvites,
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Failed to import");
      }
      return r.json();
    },
    onSuccess: (data) => {
      setResult(data);
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers", BROKER_ID] });
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

// ── Buyer detail drawer ────────────────────────────────────────────────────
function BuyerDetailDrawer({
  buyerId,
  onClose,
}: {
  buyerId: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [, setLocation] = useLocation();

  const { data, isLoading } = useQuery<BuyerDetail>({
    queryKey: ["/api/broker/buyers", buyerId, BROKER_ID],
    queryFn: () => apiRequest("GET", `/api/broker/buyers/${buyerId}?brokerId=${BROKER_ID}`).then(r => r.json()),
    enabled: !!buyerId,
  });

  const [notes, setNotes] = useState("");
  const [tagsText, setTagsText] = useState("");

  // Initialize editable state once data arrives (seeded off the buyer id so
  // opening a different buyer re-initializes).
  useEffect(() => {
    if (data) {
      setNotes(data.contact?.notes ?? "");
      setTagsText((data.contact?.tags ?? []).join(", "));
    }
  }, [data?.buyer?.id]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!buyerId) return;
      const tags = tagsText.split(",").map(s => s.trim()).filter(Boolean);
      const r = await apiRequest("PATCH", `/api/broker/buyers/${buyerId}?brokerId=${BROKER_ID}`, {
        tags,
        notes: notes.trim() || null,
      });
      if (!r.ok) throw new Error("Save failed");
      return r.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers", buyerId, BROKER_ID] });
      qc.invalidateQueries({ queryKey: ["/api/broker/buyers", BROKER_ID] });
      toast({ title: "Saved" });
    },
    onError: () => toast({ title: "Failed to save", variant: "destructive" }),
  });

  return (
    <Sheet open={!!buyerId} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
        {isLoading || !data ? (
          <div className="space-y-3 mt-6">
            <Skeleton className="h-8 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-32 w-full mt-6" />
          </div>
        ) : (
          <>
            <SheetHeader className="space-y-1">
              <SheetTitle className="text-lg flex items-center gap-2">
                {data.buyer.name}
                {data.buyer.hasProofOfFunds && (
                  <ShieldCheck className="h-4 w-4 text-teal" />
                )}
              </SheetTitle>
              <SheetDescription>{data.buyer.email}</SheetDescription>
              {data.buyer.company && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Building2 className="h-3 w-3" />
                  {data.buyer.company}
                  {data.buyer.title && ` · ${data.buyer.title}`}
                </div>
              )}
            </SheetHeader>

            <Tabs defaultValue="profile" className="mt-6">
              <TabsList className="grid grid-cols-3 w-full">
                <TabsTrigger value="profile" className="text-xs">Profile</TabsTrigger>
                <TabsTrigger value="deals" className="text-xs">Deals ({data.deals.length})</TabsTrigger>
                <TabsTrigger value="notes" className="text-xs">Notes</TabsTrigger>
              </TabsList>

              <TabsContent value="profile" className="space-y-4 mt-4">
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <DetailField label="Buyer type" value={data.buyer.buyerType ? BUYER_TYPE_LABELS[data.buyer.buyerType] ?? data.buyer.buyerType : "—"} />
                  <DetailField label="Profile" value={`${data.buyer.profileCompletionPct}% complete`} />
                  <DetailField label="Phone" value={data.buyer.phone ?? "—"} />
                  <DetailField label="LinkedIn" value={data.buyer.linkedinUrl ?? "—"} />
                  <DetailField label="Liquid funds" value={data.buyer.liquidFunds ?? "—"} />
                  <DetailField label="Proof of funds" value={data.buyer.hasProofOfFunds ? "Yes" : "No"} />
                </div>

                {Array.isArray(data.buyer.targetIndustries) && data.buyer.targetIndustries.length > 0 && (
                  <div>
                    <div className="text-2xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                      Target industries
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {data.buyer.targetIndustries.map((i) => (
                        <Badge key={i} variant="secondary" className="text-2xs font-normal">{i}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {Array.isArray(data.buyer.targetLocations) && data.buyer.targetLocations.length > 0 && (
                  <div>
                    <div className="text-2xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                      Target locations
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {data.buyer.targetLocations.map((l) => (
                        <Badge key={l} variant="secondary" className="text-2xs font-normal">{l}</Badge>
                      ))}
                    </div>
                  </div>
                )}

                {data.buyer.background && (
                  <div>
                    <div className="text-2xs font-medium text-muted-foreground uppercase tracking-wide mb-1.5">
                      Background
                    </div>
                    <p className="text-xs text-foreground/80 leading-relaxed">{data.buyer.background}</p>
                  </div>
                )}

                <div className="pt-3 border-t border-border flex items-center justify-between text-2xs text-muted-foreground">
                  <span>Added {formatRelative(data.contact?.addedAt ?? data.buyer.createdAt)}</span>
                  {data.buyer.lastLoginAt && (
                    <span>Last login {formatRelative(data.buyer.lastLoginAt)}</span>
                  )}
                </div>
              </TabsContent>

              <TabsContent value="deals" className="mt-4">
                {data.deals.length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">
                    This buyer hasn't been granted access to any of your deals yet.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {data.deals.map((d) => (
                      <div
                        key={d.dealId}
                        className="border border-border rounded-md p-3 hover:bg-muted/30 cursor-pointer transition-colors"
                        onClick={() => setLocation(`/deal/${d.dealId}`)}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-sm font-medium text-foreground">{d.businessName}</span>
                          <ExternalLink className="h-3 w-3 text-muted-foreground" />
                        </div>
                        <div className="flex items-center gap-3 mt-1 text-2xs text-muted-foreground">
                          <span>{d.viewCount} view{d.viewCount === 1 ? "" : "s"}</span>
                          <span>·</span>
                          <span>Last: {formatRelative(d.lastAccessedAt)}</span>
                          {d.decision && (
                            <>
                              <span>·</span>
                              <Badge variant="outline" className="text-2xs font-normal">
                                {d.decision}
                              </Badge>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </TabsContent>

              <TabsContent value="notes" className="space-y-3 mt-4">
                <div>
                  <Label className="text-xs">Tags</Label>
                  <Input
                    value={tagsText}
                    onChange={(e) => setTagsText(e.target.value)}
                    placeholder="key, private-equity, warm"
                  />
                  <p className="text-2xs text-muted-foreground mt-0.5">Comma-separated</p>
                </div>
                <div>
                  <Label className="text-xs">Private notes</Label>
                  <Textarea
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="Internal notes about this buyer..."
                    rows={6}
                  />
                </div>
                <Button
                  size="sm"
                  onClick={() => saveMutation.mutate()}
                  disabled={saveMutation.isPending}
                  data-testid="button-save-notes"
                >
                  {saveMutation.isPending ? "Saving..." : "Save"}
                </Button>
              </TabsContent>
            </Tabs>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-2xs font-medium text-muted-foreground uppercase tracking-wide">{label}</div>
      <div className="text-sm text-foreground mt-0.5 truncate">{value}</div>
    </div>
  );
}
