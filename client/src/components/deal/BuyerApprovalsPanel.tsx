/**
 * BuyerApprovalsPanel — Broker-side UI for the buyer approval workflow.
 *
 * Features:
 *  - List of pending/approved/rejected buyer approval requests for a deal
 *  - Submit dialog with CRM autocomplete search (type name → see matches →
 *    click to auto-fill profile from CRM + attached files). Manual entry
 *    mode supported when no CRM match.
 *  - Lead broker review (approve → routes to seller, or reject)
 *  - Status pipeline visualization
 */
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  UserPlus, Loader2, Search, Building2, Mail, Phone, Shield,
  CheckCircle2, XCircle, Clock, Users, AlertCircle, Sparkles,
} from "lucide-react";

interface BuyerCategory { value: string; label: string; description: string; riskLevel: string }
interface BuyerSearchResult { id: string; name: string; email?: string; phone?: string; company?: string; source: string }

interface ApprovalRequest {
  id: string;
  buyerName: string;
  buyerEmail: string;
  buyerCompany?: string | null;
  category: string;
  riskLevel: "high" | "medium" | "low";
  status: string;
  background?: string | null;
  isCompetitor?: boolean;
  submittedByName?: string | null;
  brokerReviewNotes?: string | null;
  createdAt: string;
  sellerReviewToken?: string | null;
}

const STATUS_META: Record<string, { label: string; icon: any; color: string }> = {
  pending_broker_review:  { label: "Pending broker review",  icon: Clock,        color: "bg-amber-500/10 text-amber-400 border-amber-500/30" },
  pending_seller_review:  { label: "With seller",             icon: Users,        color: "bg-blue-500/10 text-blue-400 border-blue-500/30" },
  access_granted:         { label: "Access granted",          icon: CheckCircle2, color: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" },
  rejected:               { label: "Rejected",                icon: XCircle,      color: "bg-red-500/10 text-red-400 border-red-500/30" },
};

const RISK_COLORS: Record<string, string> = {
  high: "bg-red-500/10 text-red-400 border-red-500/30",
  medium: "bg-amber-500/10 text-amber-400 border-amber-500/30",
  low: "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
};

export function BuyerApprovalsPanel({ dealId }: { dealId: string }) {
  const qc = useQueryClient();
  const [submitOpen, setSubmitOpen] = useState(false);
  const [reviewing, setReviewing] = useState<ApprovalRequest | null>(null);

  const { data: requests = [], isLoading } = useQuery<ApprovalRequest[]>({
    queryKey: [`/api/deals/${dealId}/buyer-approvals`],
    queryFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/buyer-approvals`);
      if (!res.ok) throw new Error("Failed to load approvals");
      return res.json();
    },
  });

  const pending = requests.filter(r => r.status === "pending_broker_review");
  const inProgress = requests.filter(r => r.status === "pending_seller_review");
  const completed = requests.filter(r => r.status === "access_granted" || r.status === "rejected");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Buyer approvals</h2>
          <p className="text-xs text-muted-foreground mt-0.5">
            Submit prospective buyers for broker + seller review before granting CIM access.
          </p>
        </div>
        <Button size="sm" onClick={() => setSubmitOpen(true)}>
          <UserPlus className="h-3.5 w-3.5 mr-1.5" />
          Submit buyer
        </Button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-sm text-muted-foreground">
            No buyer approval requests yet. Submit a buyer to get started.
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {pending.length > 0 && (
            <Section title="Needs your review" items={pending} onReview={setReviewing} showReviewBtn />
          )}
          {inProgress.length > 0 && (
            <Section title="With seller" items={inProgress} onReview={setReviewing} />
          )}
          {completed.length > 0 && (
            <Section title="Completed" items={completed} onReview={setReviewing} />
          )}
        </div>
      )}

      <SubmitDialog
        dealId={dealId}
        open={submitOpen}
        onClose={() => setSubmitOpen(false)}
        onSubmitted={() => {
          setSubmitOpen(false);
          qc.invalidateQueries({ queryKey: [`/api/deals/${dealId}/buyer-approvals`] });
        }}
      />

      {reviewing && (
        <ReviewDialog
          request={reviewing}
          onClose={() => setReviewing(null)}
          onDone={() => {
            setReviewing(null);
            qc.invalidateQueries({ queryKey: [`/api/deals/${dealId}/buyer-approvals`] });
          }}
        />
      )}
    </div>
  );
}

function Section({
  title, items, onReview, showReviewBtn,
}: {
  title: string;
  items: ApprovalRequest[];
  onReview: (r: ApprovalRequest) => void;
  showReviewBtn?: boolean;
}) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground mb-2">{title}</div>
      <div className="space-y-2">
        {items.map((r) => {
          const meta = STATUS_META[r.status];
          const StatusIcon = meta?.icon || Clock;
          return (
            <Card key={r.id}>
              <CardContent className="p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <div className="font-medium truncate">{r.buyerName}</div>
                      {r.buyerCompany && (
                        <span className="text-xs text-muted-foreground truncate">· {r.buyerCompany}</span>
                      )}
                      <Badge variant="outline" className="text-xs capitalize">
                        {r.category.replace(/_/g, " ")}
                      </Badge>
                      <Badge className={`text-xs ${RISK_COLORS[r.riskLevel] || ""}`}>{r.riskLevel}</Badge>
                      {r.isCompetitor && (
                        <Badge variant="outline" className="text-xs border-amber-500/30 text-amber-400">
                          <AlertCircle className="h-3 w-3 mr-0.5" /> Competitor
                        </Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
                      <span className="flex items-center gap-1"><Mail className="h-3 w-3" />{r.buyerEmail}</span>
                      {r.submittedByName && <span>· submitted by {r.submittedByName}</span>}
                    </div>
                    {r.background && (
                      <div className="text-xs mt-2 line-clamp-2">{r.background}</div>
                    )}
                  </div>
                  <div className="flex flex-col items-end gap-2">
                    <Badge className={`text-xs ${meta?.color || ""}`}>
                      <StatusIcon className="h-3 w-3 mr-1" />
                      {meta?.label || r.status}
                    </Badge>
                    {showReviewBtn && (
                      <Button size="sm" variant="outline" onClick={() => onReview(r)}>
                        Review
                      </Button>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Submit Dialog — CRM search autocomplete → prefill → edit → submit
// ─────────────────────────────────────────────────────────────────────

interface FormState {
  buyerName: string;
  buyerTitle: string;
  buyerEmail: string;
  buyerPhone: string;
  buyerCompany: string;
  buyerCompanyUrl: string;
  linkedinUrl: string;
  category: string;
  background: string;
  liquidFunds: string;
  sourceOfFunds: string;
  investmentSizeTarget: string;
  hasProofOfFunds: boolean;
  isCompetitor: boolean;
  competitorDetails: string;
  ndaSigned: boolean;
  ndaNotes: string;
  submittedByName: string;
  submittedBy: string;
  crmSource?: string;
  crmRecordId?: string;
  crmRawData?: any;
}

const EMPTY_FORM: FormState = {
  buyerName: "", buyerTitle: "", buyerEmail: "", buyerPhone: "",
  buyerCompany: "", buyerCompanyUrl: "", linkedinUrl: "",
  category: "other", background: "",
  liquidFunds: "", sourceOfFunds: "", investmentSizeTarget: "", hasProofOfFunds: false,
  isCompetitor: false, competitorDetails: "",
  ndaSigned: false, ndaNotes: "",
  submittedByName: "", submittedBy: "",
};

function SubmitDialog({
  dealId, open, onClose, onSubmitted,
}: {
  dealId: string;
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<BuyerSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [prefilling, setPrefilling] = useState(false);
  const [crmFiles, setCrmFiles] = useState<any[]>([]);

  const { data: categories = [] } = useQuery<BuyerCategory[]>({
    queryKey: ["/api/buyer-categories"],
    queryFn: async () => (await fetch("/api/buyer-categories")).json(),
  });

  // Debounced CRM search
  useEffect(() => {
    if (!searchQuery || searchQuery.length < 2) {
      setSearchResults([]);
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/deals/${dealId}/buyer-search?q=${encodeURIComponent(searchQuery)}`);
        const data = await res.json();
        setSearchResults(data.results || []);
      } catch (e) {
        setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [searchQuery, dealId]);

  const handleSelectResult = async (result: BuyerSearchResult) => {
    setPrefilling(true);
    setSearchResults([]);
    setSearchQuery(result.name);
    try {
      const res = await fetch(`/api/deals/${dealId}/buyer-prefill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: result.email || result.name, recordId: result.id }),
      });
      const data = await res.json();
      if (data.found && data.fields) {
        const f = data.fields;
        setForm(prev => ({
          ...prev,
          buyerName: f.buyerName || result.name || prev.buyerName,
          buyerTitle: f.buyerTitle || prev.buyerTitle,
          buyerEmail: f.buyerEmail || result.email || prev.buyerEmail,
          buyerPhone: f.buyerPhone || result.phone || prev.buyerPhone,
          buyerCompany: f.buyerCompany || result.company || prev.buyerCompany,
          buyerCompanyUrl: f.buyerCompanyUrl || prev.buyerCompanyUrl,
          linkedinUrl: f.linkedinUrl || prev.linkedinUrl,
          category: f.category || prev.category,
          background: f.background || prev.background,
          liquidFunds: f.financialCapability?.liquidFunds || prev.liquidFunds,
          sourceOfFunds: f.financialCapability?.sourceOfFunds || prev.sourceOfFunds,
          investmentSizeTarget: f.financialCapability?.investmentSizeTarget || prev.investmentSizeTarget,
          hasProofOfFunds: f.financialCapability?.hasProofOfFunds ?? prev.hasProofOfFunds,
          isCompetitor: f.isCompetitor ?? prev.isCompetitor,
          competitorDetails: f.competitorDetails || prev.competitorDetails,
          ndaSigned: f.ndaSigned ?? prev.ndaSigned,
          ndaNotes: f.ndaNotes || prev.ndaNotes,
          crmSource: data.source,
          crmRecordId: data.crmRecordId,
          crmRawData: data.rawData,
        }));
        setCrmFiles(data.files || []);
      }
    } catch (e) {
      console.error("Prefill failed", e);
    } finally {
      setPrefilling(false);
    }
  };

  const submit = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/deals/${dealId}/buyer-approvals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...form,
          financialCapability: {
            liquidFunds: form.liquidFunds || null,
            sourceOfFunds: form.sourceOfFunds || null,
            investmentSizeTarget: form.investmentSizeTarget || null,
            hasProofOfFunds: form.hasProofOfFunds,
          },
          otherProfileUrls: [],
          partners: [],
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to submit");
      }
      return res.json();
    },
    onSuccess: () => {
      setForm(EMPTY_FORM);
      setSearchQuery("");
      setCrmFiles([]);
      onSubmitted();
    },
  });

  const update = <K extends keyof FormState>(key: K, val: FormState[K]) =>
    setForm(prev => ({ ...prev, [key]: val }));

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Submit buyer for approval</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* CRM search bar */}
          <div className="space-y-2">
            <Label className="text-xs">Search your CRM</Label>
            <div className="relative">
              <Search className="absolute left-2 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Type a buyer's name, email, or company..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8"
              />
              {searching && (
                <Loader2 className="absolute right-2 top-2.5 h-3.5 w-3.5 animate-spin text-muted-foreground" />
              )}
            </div>
            {searchResults.length > 0 && (
              <div className="border border-border rounded-md bg-card divide-y divide-border">
                {searchResults.map((r) => (
                  <button
                    key={r.id}
                    onClick={() => handleSelectResult(r)}
                    className="w-full text-left p-2 hover:bg-accent transition-colors"
                  >
                    <div className="text-sm font-medium">{r.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {r.email}{r.company ? ` · ${r.company}` : ""}
                    </div>
                  </button>
                ))}
              </div>
            )}
            {prefilling && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Sparkles className="h-3 w-3 animate-pulse" />
                Reading CRM record and parsing with AI...
              </div>
            )}
            {form.crmSource && (
              <div className="text-xs text-emerald-500 flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" />
                Prefilled from {form.crmSource}
                {crmFiles.length > 0 && ` (${crmFiles.length} file${crmFiles.length === 1 ? "" : "s"} attached)`}
              </div>
            )}
          </div>

          <div className="border-t border-border pt-4" />

          {/* Buyer info */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Full name *" value={form.buyerName} onChange={(v) => update("buyerName", v)} />
            <Field label="Title" value={form.buyerTitle} onChange={(v) => update("buyerTitle", v)} />
            <Field label="Email *" value={form.buyerEmail} onChange={(v) => update("buyerEmail", v)} type="email" />
            <Field label="Phone" value={form.buyerPhone} onChange={(v) => update("buyerPhone", v)} />
            <Field label="Company" value={form.buyerCompany} onChange={(v) => update("buyerCompany", v)} />
            <Field label="Company URL" value={form.buyerCompanyUrl} onChange={(v) => update("buyerCompanyUrl", v)} />
            <Field label="LinkedIn URL" value={form.linkedinUrl} onChange={(v) => update("linkedinUrl", v)} className="col-span-2" />
          </div>

          {/* Category */}
          <div className="space-y-1">
            <Label className="text-xs">Category *</Label>
            <Select value={form.category} onValueChange={(v) => update("category", v)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {categories.map((c) => (
                  <SelectItem key={c.value} value={c.value}>
                    {c.label} <span className="text-xs text-muted-foreground ml-2">({c.riskLevel} risk)</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Background */}
          <div className="space-y-1">
            <Label className="text-xs">Background / notes</Label>
            <Textarea value={form.background} onChange={(e) => update("background", e.target.value)} rows={3} />
          </div>

          {/* Financial */}
          <div className="border border-border rounded-md p-3 space-y-3">
            <div className="text-xs font-medium">Financial capability</div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Liquid funds" value={form.liquidFunds} onChange={(v) => update("liquidFunds", v)} />
              <Field label="Target investment size" value={form.investmentSizeTarget} onChange={(v) => update("investmentSizeTarget", v)} />
              <Field label="Source of funds" value={form.sourceOfFunds} onChange={(v) => update("sourceOfFunds", v)} className="col-span-2" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox id="pof" checked={form.hasProofOfFunds} onCheckedChange={(v) => update("hasProofOfFunds", !!v)} />
              <Label htmlFor="pof" className="text-xs">Proof of funds on file</Label>
            </div>
          </div>

          {/* Competitor */}
          <div className="flex items-center gap-2">
            <Checkbox id="comp" checked={form.isCompetitor} onCheckedChange={(v) => update("isCompetitor", !!v)} />
            <Label htmlFor="comp" className="text-xs">Competitor or competitor-adjacent</Label>
          </div>
          {form.isCompetitor && (
            <Textarea
              placeholder="Competitor details..."
              value={form.competitorDetails}
              onChange={(e) => update("competitorDetails", e.target.value)}
              rows={2}
            />
          )}

          {/* NDA */}
          <div className="flex items-center gap-2">
            <Checkbox id="nda" checked={form.ndaSigned} onCheckedChange={(v) => update("ndaSigned", !!v)} />
            <Label htmlFor="nda" className="text-xs">NDA signed</Label>
          </div>

          <div className="border-t border-border pt-3">
            <Field
              label="Your name (submitted by)"
              value={form.submittedByName}
              onChange={(v) => update("submittedByName", v)}
            />
          </div>

          {submit.error && (
            <div className="text-xs text-red-400">{(submit.error as Error).message}</div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button
            onClick={() => submit.mutate()}
            disabled={!form.buyerName || !form.buyerEmail || submit.isPending}
          >
            {submit.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            Submit for approval
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label, value, onChange, type = "text", className = "",
}: { label: string; value: string; onChange: (v: string) => void; type?: string; className?: string }) {
  return (
    <div className={`space-y-1 ${className}`}>
      <Label className="text-xs">{label}</Label>
      <Input type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Review Dialog — broker approves or rejects
// ─────────────────────────────────────────────────────────────────────

function ReviewDialog({
  request, onClose, onDone,
}: { request: ApprovalRequest; onClose: () => void; onDone: () => void }) {
  const [notes, setNotes] = useState("");

  const review = useMutation({
    mutationFn: async (action: "approve" | "reject") => {
      const res = await fetch(`/api/buyer-approvals/${request.id}/broker-review`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, notes }),
      });
      if (!res.ok) throw new Error("Review failed");
      return res.json();
    },
    onSuccess: onDone,
  });

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Review: {request.buyerName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {request.buyerCompany && (
            <div className="flex items-center gap-1">
              <Building2 className="h-3 w-3 text-muted-foreground" />
              {request.buyerCompany}
            </div>
          )}
          <div className="flex items-center gap-1">
            <Mail className="h-3 w-3 text-muted-foreground" />
            {request.buyerEmail}
          </div>
          <div className="flex gap-2">
            <Badge variant="outline" className="capitalize">{request.category.replace(/_/g, " ")}</Badge>
            <Badge className={RISK_COLORS[request.riskLevel] || ""}>{request.riskLevel} risk</Badge>
          </div>
          {request.background && (
            <div className="text-muted-foreground whitespace-pre-wrap">{request.background}</div>
          )}
          <Textarea
            placeholder="Review notes (optional)"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => review.mutate("reject")} disabled={review.isPending}>
            Reject
          </Button>
          <Button onClick={() => review.mutate("approve")} disabled={review.isPending}>
            {review.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />}
            Approve & send to seller
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
