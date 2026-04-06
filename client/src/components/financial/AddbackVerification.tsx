import { useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { AddbackVerification as AddbackVerificationType } from "@shared/schema";
import {
  Upload, Loader2, CheckCircle2, XCircle, AlertTriangle,
  HelpCircle, ChevronDown, ChevronRight, FileText, Search,
  ShieldCheck, MessageSquare, ArrowLeft,
} from "lucide-react";

/* ──────────────────────────────────────────────
   Types
─────────────────────────────────────────────── */
interface AddbackItem {
  id: string;
  label: string;
  description: string;
  category: string;
  annualAmount: number;
  yearAmounts: Record<string, number>;
  verificationStatus: "unverified" | "matched" | "seller_confirmed" | "disputed" | "no_match";
  matchedTransactions: Array<{
    date: string;
    description: string;
    amount: number;
    account: string;
    source: string;
    documentId: string;
    confidence: number;
  }>;
  sellerNotes: string | null;
  aiNotes: string | null;
}

interface SellerQuestion {
  id: string;
  question: string;
  context: string;
  relatedAddbackId: string | null;
  relatedTransactions: Array<{ date: string; description: string; amount: number }>;
  answer: string | null;
  status: "pending" | "answered" | "skipped";
}

interface AddbackVerificationProps {
  dealId: string;
  financialAnalysisId?: string;
  onBack?: () => void;
}

/* ──────────────────────────────────────────────
   Category config
─────────────────────────────────────────────── */
const CATEGORY_LABELS: Record<string, { label: string; color: string }> = {
  owner_comp:    { label: "Owner Comp",    color: "bg-blue-500/10 text-blue-400 border-0" },
  discretionary: { label: "Discretionary", color: "bg-purple-500/10 text-purple-400 border-0" },
  one_time:      { label: "One-Time",      color: "bg-orange-500/10 text-orange-400 border-0" },
  non_recurring: { label: "Non-Recurring", color: "bg-amber-500/10 text-amber-400 border-0" },
  non_cash:      { label: "Non-Cash",      color: "bg-slate-500/10 text-slate-400 border-0" },
  related_party: { label: "Related Party", color: "bg-rose-500/10 text-rose-400 border-0" },
  other:         { label: "Other",         color: "bg-muted text-muted-foreground border-0" },
};

const STATUS_ICONS: Record<string, { icon: any; color: string; label: string }> = {
  unverified:       { icon: HelpCircle,    color: "text-muted-foreground", label: "Unverified" },
  matched:          { icon: Search,        color: "text-blue-400",         label: "Match Found" },
  seller_confirmed: { icon: CheckCircle2,  color: "text-emerald-400",     label: "Confirmed" },
  disputed:         { icon: XCircle,       color: "text-red-400",         label: "Disputed" },
  no_match:         { icon: AlertTriangle, color: "text-amber-400",       label: "No Match" },
};

/* ──────────────────────────────────────────────
   Formatting
─────────────────────────────────────────────── */
function fmtCurrency(val: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(val);
}

function confidenceLabel(c: number): { label: string; color: string } {
  if (c >= 0.8) return { label: "High", color: "text-emerald-400" };
  if (c >= 0.5) return { label: "Medium", color: "text-amber-400" };
  return { label: "Low", color: "text-red-400" };
}

/* ──────────────────────────────────────────────
   Component
─────────────────────────────────────────────── */
export function AddbackVerification({ dealId, financialAnalysisId, onBack }: AddbackVerificationProps) {
  const { toast } = useToast();
  const [expandedAddback, setExpandedAddback] = useState<string | null>(null);
  const [sellerNotes, setSellerNotes] = useState<Record<string, string>>({});
  const [questionAnswers, setQuestionAnswers] = useState<Record<string, string>>({});

  // Fetch verification data
  const { data: verification, isLoading } = useQuery<AddbackVerificationType | null>({
    queryKey: ["/api/deals", dealId, "addback-verification"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/addback-verification`);
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("Failed to fetch");
      return r.json();
    },
  });

  // Start verification
  const startVerification = useMutation({
    mutationFn: async (workflow: "provided" | "from_scratch") => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/addback-verification`, {
        workflow,
        financialAnalysisId,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "addback-verification"] });
      toast({ title: "Verification started" });
    },
    onError: (err: Error) => {
      toast({ title: "Failed to start verification", description: err.message, variant: "destructive" });
    },
  });

  // Trigger AI analysis
  const runAnalysis = useMutation({
    mutationFn: async () => {
      if (!verification) throw new Error("No verification to analyze");
      const r = await apiRequest("POST", `/api/deals/${dealId}/addback-verification/${verification.id}/analyze`);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "addback-verification"] });
      toast({ title: "Analysis running", description: "The AI is matching transactions to addbacks. This may take a moment." });
    },
    onError: (err: Error) => {
      toast({ title: "Analysis failed", description: err.message, variant: "destructive" });
    },
  });

  // Update verification
  const updateVerification = useMutation({
    mutationFn: async (updates: Partial<AddbackVerificationType>) => {
      if (!verification) throw new Error("No verification");
      const r = await apiRequest("PATCH", `/api/deals/${dealId}/addback-verification/${verification.id}`, updates);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "addback-verification"] });
    },
    onError: (err: Error) => {
      toast({ title: "Update failed", description: err.message, variant: "destructive" });
    },
  });

  // Confirm all
  const confirmAll = useMutation({
    mutationFn: async () => {
      if (!verification) throw new Error("No verification");
      const r = await apiRequest("POST", `/api/deals/${dealId}/addback-verification/${verification.id}/confirm`);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "addback-verification"] });
      toast({ title: "Verification complete" });
    },
  });

  const addbacks = (verification?.addbacks as AddbackItem[] | null) || [];
  const questions = (verification?.sellerQuestions as SellerQuestion[] | null) || [];

  // Stats
  const stats = useMemo(() => {
    const total = addbacks.length;
    const confirmed = addbacks.filter((a) => a.verificationStatus === "seller_confirmed").length;
    const matched = addbacks.filter((a) => a.verificationStatus === "matched").length;
    const unmatched = addbacks.filter((a) => a.verificationStatus === "no_match").length;
    const totalAmount = addbacks.reduce((s, a) => s + (a.annualAmount || 0), 0);
    const verifiedAmount = addbacks
      .filter((a) => a.verificationStatus === "seller_confirmed" || a.verificationStatus === "matched")
      .reduce((s, a) => s + (a.annualAmount || 0), 0);
    return { total, confirmed, matched, unmatched, totalAmount, verifiedAmount };
  }, [addbacks]);

  // Confirm single addback
  const handleConfirm = (addbackId: string) => {
    const updated = addbacks.map((ab) =>
      ab.id === addbackId
        ? { ...ab, verificationStatus: "seller_confirmed" as const, sellerNotes: sellerNotes[addbackId] || ab.sellerNotes }
        : ab,
    );
    updateVerification.mutate({ addbacks: updated as any });
  };

  // Dispute single addback
  const handleDispute = (addbackId: string) => {
    const updated = addbacks.map((ab) =>
      ab.id === addbackId
        ? { ...ab, verificationStatus: "disputed" as const, sellerNotes: sellerNotes[addbackId] || ab.sellerNotes }
        : ab,
    );
    updateVerification.mutate({ addbacks: updated as any });
  };

  // Answer a question
  const handleAnswerQuestion = (questionId: string) => {
    const answer = questionAnswers[questionId];
    if (!answer?.trim()) return;
    const updated = questions.map((q) =>
      q.id === questionId ? { ...q, answer, status: "answered" as const } : q,
    );
    updateVerification.mutate({ sellerQuestions: updated as any });
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // ── No verification started ──
  if (!verification) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Addback Verification</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Corroborate addbacks with transaction-level proof from your GL, QuickBooks, or bank statements.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Workflow A */}
          <Card className="bg-card/50 border-border/50 hover:border-teal/30 transition-colors cursor-pointer"
                onClick={() => startVerification.mutate("provided")}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-teal" />
                Verify Existing Addbacks
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                You already have addbacks from a valuation or financial analysis. Upload supporting documents
                and the AI will find matching transactions to verify each one.
              </p>
            </CardContent>
          </Card>

          {/* Workflow B */}
          <Card className="bg-card/50 border-border/50 hover:border-blue-500/30 transition-colors cursor-pointer"
                onClick={() => startVerification.mutate("from_scratch")}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium flex items-center gap-2">
                <Search className="h-4 w-4 text-blue-400" />
                Discover Addbacks
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-xs text-muted-foreground">
                No addbacks yet? Upload your GL export, QuickBooks detail, or bank statements.
                The AI will analyze transactions and identify potential addbacks for your review.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // ── Pending Documents ──
  if (verification.status === "pending_documents") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Addback Verification</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              {verification.workflow === "provided"
                ? `${addbacks.length} addback${addbacks.length !== 1 ? "s" : ""} to verify`
                : "Upload transaction data to discover addbacks"}
            </p>
          </div>
          <Badge className="bg-amber-500/10 text-amber-400 border-0">Awaiting Documents</Badge>
        </div>

        {/* Show addbacks waiting to be verified (Workflow A) */}
        {addbacks.length > 0 && (
          <Card className="bg-card/50 border-border/50">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">Addbacks to Verify</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              {addbacks.map((ab) => (
                <div key={ab.id} className="flex items-center justify-between py-1.5 px-3 rounded bg-muted/30 text-sm">
                  <div className="flex items-center gap-2">
                    <Badge className={CATEGORY_LABELS[ab.category]?.color || CATEGORY_LABELS.other.color}>
                      {CATEGORY_LABELS[ab.category]?.label || ab.category}
                    </Badge>
                    <span>{ab.label}</span>
                  </div>
                  <span className="font-mono text-xs">{fmtCurrency(ab.annualAmount)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Upload prompt */}
        <Card className="bg-card/50 border-teal/20">
          <CardContent className="py-8 text-center space-y-4">
            <div className="h-12 w-12 rounded-full bg-teal/10 flex items-center justify-center mx-auto">
              <Upload className="h-6 w-6 text-teal/60" />
            </div>
            <div>
              <p className="text-sm font-medium mb-1">Upload transaction data</p>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                Upload your General Ledger export, QuickBooks P&L Detail report, or bank statements.
                CSV exports from QuickBooks work best. PDF bank statements are also supported.
              </p>
            </div>
            <div className="flex flex-col items-center gap-2">
              <p className="text-2xs text-muted-foreground">
                Upload documents via the Documents tab, then return here to run the analysis.
              </p>
              <Button
                className="bg-teal text-teal-foreground hover:bg-teal/90 gap-2"
                onClick={() => runAnalysis.mutate()}
                disabled={runAnalysis.isPending}
              >
                {runAnalysis.isPending ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Starting Analysis...</>
                ) : (
                  <><Search className="h-4 w-4" /> Analyze Uploaded Documents</>
                )}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Analyzing ──
  if (verification.status === "analyzing") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <h2 className="text-lg font-semibold tracking-tight">Addback Verification</h2>
          <Badge className="bg-blue-500/10 text-blue-400 border-0">Analyzing</Badge>
        </div>

        <Card className="bg-card/50 border-blue-500/20">
          <CardContent className="py-12 text-center space-y-4">
            <Loader2 className="h-8 w-8 animate-spin text-blue-400 mx-auto" />
            <div>
              <p className="text-sm font-medium mb-1">AI is analyzing your transactions</p>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                {verification.workflow === "provided"
                  ? "Matching each addback to supporting transactions in your records. This may take a minute."
                  : "Scanning transactions for potential addbacks. This may take a minute."}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Failed ──
  if (verification.status === "failed") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <h2 className="text-lg font-semibold tracking-tight">Addback Verification</h2>
          <Badge className="bg-destructive/10 text-destructive border-0">Failed</Badge>
        </div>

        <Card className="bg-card/50 border-destructive/20">
          <CardContent className="py-8 text-center space-y-4">
            <XCircle className="h-8 w-8 text-destructive mx-auto" />
            <div>
              <p className="text-sm font-medium mb-1">Analysis failed</p>
              <p className="text-xs text-muted-foreground max-w-md mx-auto">
                Could not find processed financial documents. Please upload and process GL exports,
                bank statements, or QuickBooks reports first, then try again.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => runAnalysis.mutate()}
              disabled={runAnalysis.isPending}
            >
              {runAnalysis.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
              Retry Analysis
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Verified (completed) ──
  if (verification.status === "verified") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <h2 className="text-lg font-semibold tracking-tight">Addback Verification</h2>
          <Badge className="bg-emerald-500/10 text-emerald-400 border-0">Verified</Badge>
        </div>

        <Card className="bg-card/50 border-emerald-500/20">
          <CardContent className="py-6">
            <div className="flex items-center gap-3 mb-4">
              <CheckCircle2 className="h-5 w-5 text-emerald-400" />
              <div>
                <p className="text-sm font-medium">All addbacks verified</p>
                <p className="text-xs text-muted-foreground">
                  {stats.confirmed} confirmed with transaction-level proof
                </p>
              </div>
            </div>

            <div className="space-y-2">
              {addbacks.map((ab) => {
                const statusCfg = STATUS_ICONS[ab.verificationStatus] || STATUS_ICONS.unverified;
                const Icon = statusCfg.icon;
                return (
                  <div key={ab.id} className="flex items-center justify-between py-2 px-3 rounded bg-muted/30 text-sm">
                    <div className="flex items-center gap-2">
                      <Icon className={`h-3.5 w-3.5 ${statusCfg.color}`} />
                      <Badge className={CATEGORY_LABELS[ab.category]?.color || CATEGORY_LABELS.other.color}>
                        {CATEGORY_LABELS[ab.category]?.label || ab.category}
                      </Badge>
                      <span>{ab.label}</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-2xs text-muted-foreground">
                        {ab.matchedTransactions?.length || 0} transactions
                      </span>
                      <span className="font-mono text-xs">{fmtCurrency(ab.annualAmount)}</span>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 pt-3 border-t border-border/50 flex justify-between items-center text-sm">
              <span className="text-muted-foreground">Total verified addbacks</span>
              <span className="font-mono font-medium">{fmtCurrency(stats.totalAmount)}</span>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── Pending Seller Review (main interactive state) ──
  const pendingQuestions = questions.filter((q) => q.status === "pending");

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Addback Verification</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              Review matched transactions and confirm each addback
            </p>
          </div>
          <Badge className="bg-amber-500/10 text-amber-400 border-0">Awaiting Review</Badge>
        </div>
        <Button
          size="sm"
          variant="outline"
          className="h-8 text-xs gap-1.5"
          onClick={() => runAnalysis.mutate()}
          disabled={runAnalysis.isPending}
        >
          {runAnalysis.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
          Re-analyze
        </Button>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-4 gap-3">
        <div className="rounded-lg bg-muted/30 p-3 text-center">
          <p className="text-lg font-semibold">{stats.total}</p>
          <p className="text-2xs text-muted-foreground">Total Addbacks</p>
        </div>
        <div className="rounded-lg bg-emerald-500/5 p-3 text-center">
          <p className="text-lg font-semibold text-emerald-400">{stats.confirmed}</p>
          <p className="text-2xs text-muted-foreground">Confirmed</p>
        </div>
        <div className="rounded-lg bg-blue-500/5 p-3 text-center">
          <p className="text-lg font-semibold text-blue-400">{stats.matched}</p>
          <p className="text-2xs text-muted-foreground">Matched</p>
        </div>
        <div className="rounded-lg bg-amber-500/5 p-3 text-center">
          <p className="text-lg font-semibold text-amber-400">{stats.unmatched}</p>
          <p className="text-2xs text-muted-foreground">No Match</p>
        </div>
      </div>

      {/* Amount summary */}
      <div className="flex items-center justify-between rounded-lg bg-muted/30 px-4 py-2 text-sm">
        <span className="text-muted-foreground">Verified amount</span>
        <span>
          <span className="font-mono font-medium">{fmtCurrency(stats.verifiedAmount)}</span>
          <span className="text-muted-foreground mx-1">/</span>
          <span className="font-mono text-muted-foreground">{fmtCurrency(stats.totalAmount)}</span>
        </span>
      </div>

      {/* Addback cards */}
      <div className="space-y-3">
        {addbacks.map((ab) => {
          const isExpanded = expandedAddback === ab.id;
          const statusCfg = STATUS_ICONS[ab.verificationStatus] || STATUS_ICONS.unverified;
          const Icon = statusCfg.icon;
          const isActionable = ab.verificationStatus === "matched" || ab.verificationStatus === "no_match" || ab.verificationStatus === "unverified";

          return (
            <Card
              key={ab.id}
              className={`bg-card/50 transition-colors ${
                ab.verificationStatus === "no_match"
                  ? "border-amber-500/30"
                  : ab.verificationStatus === "seller_confirmed"
                  ? "border-emerald-500/20"
                  : ab.verificationStatus === "disputed"
                  ? "border-red-500/20"
                  : "border-border/50"
              }`}
            >
              <CardContent className="py-3 px-4">
                {/* Header row */}
                <div
                  className="flex items-center justify-between cursor-pointer"
                  onClick={() => setExpandedAddback(isExpanded ? null : ab.id)}
                >
                  <div className="flex items-center gap-2">
                    {isExpanded ? (
                      <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                    )}
                    <Icon className={`h-3.5 w-3.5 ${statusCfg.color}`} />
                    <Badge className={CATEGORY_LABELS[ab.category]?.color || CATEGORY_LABELS.other.color}>
                      {CATEGORY_LABELS[ab.category]?.label || ab.category}
                    </Badge>
                    <span className="text-sm font-medium">{ab.label}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-2xs text-muted-foreground">{statusCfg.label}</span>
                    <span className="font-mono text-sm">{fmtCurrency(ab.annualAmount)}</span>
                  </div>
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="mt-3 pl-6 space-y-3">
                    {/* Description */}
                    {ab.description && (
                      <p className="text-xs text-muted-foreground">{ab.description}</p>
                    )}

                    {/* AI Notes */}
                    {ab.aiNotes && (
                      <div className="text-xs text-muted-foreground bg-muted/30 rounded p-2">
                        <span className="font-medium text-foreground">AI notes:</span> {ab.aiNotes}
                      </div>
                    )}

                    {/* Matched transactions */}
                    {ab.matchedTransactions && ab.matchedTransactions.length > 0 && (
                      <div>
                        <p className="text-xs font-medium mb-1.5">Supporting Transactions</p>
                        <div className="space-y-1">
                          {ab.matchedTransactions.map((tx, i) => {
                            const conf = confidenceLabel(tx.confidence);
                            return (
                              <div key={i} className="flex items-center justify-between py-1 px-2 rounded bg-muted/20 text-xs">
                                <div className="flex items-center gap-2">
                                  <FileText className="h-3 w-3 text-muted-foreground" />
                                  <span className="text-muted-foreground w-20">{tx.date}</span>
                                  <span className="truncate max-w-[200px]">{tx.description}</span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <Badge variant="outline" className="text-2xs h-4 px-1.5">{tx.source.toUpperCase()}</Badge>
                                  <span className={`text-2xs ${conf.color}`}>{conf.label}</span>
                                  <span className="font-mono w-20 text-right">{fmtCurrency(tx.amount)}</span>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* No match help */}
                    {ab.verificationStatus === "no_match" && (
                      <div className="rounded bg-amber-500/5 border border-amber-500/20 p-3 text-xs">
                        <p className="font-medium text-amber-400 mb-1">No matching transactions found</p>
                        <p className="text-muted-foreground">
                          If this addback is valid, add a note explaining where the supporting documentation can be found,
                          or upload additional transaction records.
                        </p>
                      </div>
                    )}

                    {/* Seller notes */}
                    {isActionable && (
                      <div className="space-y-2">
                        <Textarea
                          placeholder="Add a note (optional)..."
                          className="text-xs h-16 resize-none bg-muted/20"
                          value={sellerNotes[ab.id] || ab.sellerNotes || ""}
                          onChange={(e) => setSellerNotes({ ...sellerNotes, [ab.id]: e.target.value })}
                        />
                        <div className="flex gap-2">
                          <Button
                            size="sm"
                            className="h-7 text-xs gap-1 bg-emerald-600 hover:bg-emerald-700 text-white"
                            onClick={() => handleConfirm(ab.id)}
                          >
                            <CheckCircle2 className="h-3 w-3" /> Confirm
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1 border-red-500/30 text-red-400 hover:bg-red-500/10"
                            onClick={() => handleDispute(ab.id)}
                          >
                            <XCircle className="h-3 w-3" /> Dispute
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* Already confirmed/disputed */}
                    {ab.sellerNotes && !isActionable && (
                      <p className="text-xs text-muted-foreground italic">Seller note: {ab.sellerNotes}</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* AI Questions for seller */}
      {pendingQuestions.length > 0 && (
        <Card className="bg-card/50 border-blue-500/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium flex items-center gap-2">
              <MessageSquare className="h-4 w-4 text-blue-400" />
              Questions from the AI ({pendingQuestions.length} pending)
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingQuestions.map((q) => (
              <div key={q.id} className="rounded bg-muted/30 p-3 space-y-2">
                <p className="text-sm">{q.question}</p>
                {q.relatedTransactions && q.relatedTransactions.length > 0 && (
                  <div className="space-y-0.5">
                    {q.relatedTransactions.map((tx, i) => (
                      <p key={i} className="text-2xs text-muted-foreground font-mono">
                        {tx.date} | {tx.description} | {fmtCurrency(tx.amount)}
                      </p>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <Textarea
                    placeholder="Your answer..."
                    className="text-xs h-14 resize-none bg-muted/20 flex-1"
                    value={questionAnswers[q.id] || ""}
                    onChange={(e) => setQuestionAnswers({ ...questionAnswers, [q.id]: e.target.value })}
                  />
                  <Button
                    size="sm"
                    className="h-14 text-xs self-end"
                    disabled={!questionAnswers[q.id]?.trim()}
                    onClick={() => handleAnswerQuestion(q.id)}
                  >
                    Submit
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Finalize */}
      {stats.total > 0 && (
        <div className="flex justify-end">
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90 gap-2"
            onClick={() => confirmAll.mutate()}
            disabled={confirmAll.isPending || stats.confirmed + addbacks.filter(a => a.verificationStatus === "disputed").length < stats.total}
          >
            {confirmAll.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Finalizing...</>
            ) : (
              <><ShieldCheck className="h-4 w-4" /> Finalize Verification</>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}
