import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PanelError } from "@/components/deal/PanelError";
import type { FinancialAnalysis, Discrepancy } from "@shared/schema";

/** One row of GET /financial-analysis/versions. */
interface AnalysisVersionSummary {
  id: string;
  version: number;
  status: string;
  createdAt: string | null;
  updatedAt: string | null;
  brokerReviewedAt: string | null;
}

/** apiRequest throws "<status>: <body>" — surface the server's own error message when the body is JSON. */
function apiErrorMessage(err: unknown, fallback: string): string {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const body = raw.replace(/^\d{3}:\s*/, "");
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed.error === "string") return parsed.error;
    if (parsed && typeof parsed.message === "string") return parsed.message;
  } catch {
    /* not a JSON body */
  }
  return body || fallback;
}

import { FinancialOverview } from "@/components/financial/FinancialOverview";
import { ReclassifiedTable } from "@/components/financial/ReclassifiedTable";
import type { ReclassifiedTableData } from "@/components/financial/ReclassifiedTable";
import { NormalizationPanel } from "@/components/financial/NormalizationPanel";
import type { NormalizationData } from "@/components/financial/NormalizationPanel";
import { WorkingCapitalPanel } from "@/components/financial/WorkingCapitalPanel";
import type { WorkingCapitalData } from "@/components/financial/WorkingCapitalPanel";
import { ClarifyingQuestions, countPendingQuestions } from "@/components/financial/ClarifyingQuestions";
import type { ClarifyingQuestion } from "@/components/financial/ClarifyingQuestions";
import { InsightsPanel } from "@/components/financial/InsightsPanel";
import type { InsightsData } from "@/components/financial/InsightsPanel";
import { AddbackVerification } from "@/components/financial/AddbackVerification";
import { DiscrepancyPanel } from "@/components/deal/DiscrepancyPanel";

import {
  DollarSign, Loader2, RefreshCw, Zap, BarChart3,
  Scale, Calculator, HelpCircle, Lightbulb, ArrowLeft, ShieldCheck,
  AlertTriangle, CheckCircle2, GitCompareArrows, MessageCircleQuestion,
} from "lucide-react";

/* ──────────────────────────────────────────────
   Props
─────────────────────────────────────────────── */
interface FinancialAnalysisCenterProps {
  dealId: string;
  onBack?: () => void;
}

/* ──────────────────────────────────────────────
   Status badge config
─────────────────────────────────────────────── */
const STATUS_BADGE: Record<string, { label: string; color: string }> = {
  draft:     { label: "Draft",      color: "bg-muted text-muted-foreground border-0" },
  running:   { label: "Processing", color: "bg-amber-500/10 text-amber-400 border-0" },
  completed: { label: "Ready",      color: "bg-success/10 text-success border-0" },
  failed:    { label: "Failed",     color: "bg-destructive/10 text-destructive border-0" },
  reviewed:  { label: "Approved",   color: "bg-teal/10 text-teal border-0" },
};

/* ──────────────────────────────────────────────
   Component
─────────────────────────────────────────────── */
export function FinancialAnalysisCenter({ dealId, onBack }: FinancialAnalysisCenterProps) {
  const { toast } = useToast();
  const [tab, setTab] = useState("overview");
  // Re-run needs an explicit confirmation — it starts a new version.
  const [rerunOpen, setRerunOpen] = useState(false);
  // A specific earlier version the broker chose to view (null = latest).
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);

  // Fetch latest financial analysis; poll while a run is in progress
  const {
    data: latestAnalysis,
    isLoading,
    error: analysisError,
    refetch: refetchAnalysis,
  } = useQuery<FinancialAnalysis | null>({
    queryKey: ["/api/deals", dealId, "financial-analysis"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/financial-analysis`, { credentials: "include" });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("Failed to fetch");
      return r.json();
    },
    refetchInterval: (query) =>
      query.state.data?.status === "running" ? 4000 : false,
  });

  // Every version on the deal — the switcher. A re-run must never make the
  // previous run (and the broker's edits in it) unreachable.
  const { data: versions = [] } = useQuery<AnalysisVersionSummary[]>({
    queryKey: ["/api/deals", dealId, "financial-analysis", "versions"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/financial-analysis/versions`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load versions");
      return r.json();
    },
    enabled: !!latestAnalysis,
  });

  // The version being viewed when it is not the latest one
  const viewingOlder = !!selectedVersionId && selectedVersionId !== latestAnalysis?.id;
  const { data: selectedAnalysis } = useQuery<FinancialAnalysis>({
    queryKey: ["/api/deals", dealId, "financial-analysis", "version", selectedVersionId],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/financial-analysis/${selectedVersionId}`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load version");
      return r.json();
    },
    enabled: viewingOlder,
  });

  const analysis = viewingOlder ? (selectedAnalysis ?? latestAnalysis) : latestAnalysis;
  const analysisStatus = latestAnalysis?.status;

  // Financial-analysis discrepancies (cross-source conflicts) — drives the
  // routing banner. Shares the cache key with DiscrepancyPanel. Polls while a
  // run is in progress because the analyzer persists new rows mid-run.
  const {
    data: allDiscrepancies = [],
    error: discError,
    refetch: refetchDisc,
  } = useQuery<Discrepancy[]>({
    queryKey: ["/api/deals", dealId, "discrepancies"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/discrepancies`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load discrepancies");
      return r.json();
    },
    refetchInterval: analysisStatus === "running" ? 4000 : false,
  });

  // When a run finishes (running → completed/failed), the analyzer has just
  // written fresh discrepancies — refetch so the banner and tab badge reflect
  // the new run instead of the pre-run state.
  const prevStatusRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const prev = prevStatusRef.current;
    if (prev === "running" && analysisStatus && analysisStatus !== "running") {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancies"] });
    }
    prevStatusRef.current = analysisStatus;
  }, [analysisStatus, dealId]);
  const finDiscrepancies = allDiscrepancies.filter(
    (d) => d.source === "financial_analysis" && d.status !== "superseded",
  );
  const unrouted = finDiscrepancies.filter((d) => d.status === "open" || d.status === "seller_responded");
  const unroutedCritical = unrouted.filter((d) => d.severity === "critical");
  const routedToSeller = finDiscrepancies.filter((d) => d.status === "ask_seller");
  const resolvedDisc = finDiscrepancies.filter((d) => d.status === "resolved" || d.status === "accepted");

  // Run / re-run analysis
  const runAnalysis = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/financial-analysis`);
      return r.json();
    },
    onSuccess: () => {
      setRerunOpen(false);
      setSelectedVersionId(null);
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "financial-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancies"] });
      toast({ title: "Analysis started", description: "Analyzing all documents, tax returns, and deal knowledge. This can take a couple of minutes." });
    },
    onError: (err: unknown) => {
      toast({ title: "Could not start analysis", description: apiErrorMessage(err, "Failed to start financial analysis"), variant: "destructive" });
    },
  });

  // Update analysis data
  const updateAnalysis = useMutation({
    mutationFn: async (updates: Partial<FinancialAnalysis>) => {
      if (!analysis?.id) throw new Error("No analysis to update");
      const r = await apiRequest("PATCH", `/api/deals/${dealId}/financial-analysis/${analysis.id}`, updates);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "financial-analysis"] });
      toast({ title: "Updated" });
    },
    onError: (err: unknown) => {
      toast({ title: "Update failed", description: apiErrorMessage(err, "Failed to update financial analysis"), variant: "destructive" });
    },
  });

  // Clarifying-question edits. The PATCH replaces the whole clarifyingQuestions
  // blob, and route-to-seller writes status/discrepancyId server-side — so a
  // stale client list (routed in another tab, or before the invalidation
  // refetch landed) would silently un-route a question. Diff the edit against
  // the copy the UI rendered from, refetch this exact version, and apply only
  // the changed fields of the changed questions on top of the server's list.
  const updateQuestions = useMutation({
    mutationFn: async (updated: ClarifyingQuestion[]) => {
      if (!analysis?.id) throw new Error("No analysis to update");
      const before = (analysis.clarifyingQuestions as ClarifyingQuestion[] | null) ?? [];
      const beforeById = new Map(before.map((q) => [q.id, q]));
      const changes = new Map<string, Partial<ClarifyingQuestion>>();
      for (const q of updated) {
        const prev = beforeById.get(q.id);
        if (!prev) {
          changes.set(q.id, q);
          continue;
        }
        const diff: Partial<ClarifyingQuestion> = {};
        for (const key of Object.keys(q) as (keyof ClarifyingQuestion)[]) {
          if (JSON.stringify(q[key]) !== JSON.stringify(prev[key])) {
            (diff as Record<string, unknown>)[key] = q[key];
          }
        }
        if (Object.keys(diff).length > 0) changes.set(q.id, diff);
      }
      if (changes.size === 0) return analysis;

      const r = await fetch(`/api/deals/${dealId}/financial-analysis/${analysis.id}`, { credentials: "include" });
      if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
      const latest = (await r.json()) as FinancialAnalysis;
      const serverList = (latest.clarifyingQuestions as ClarifyingQuestion[] | null) ?? [];
      const seen = new Set<string>();
      const merged: ClarifyingQuestion[] = serverList.map((q) => {
        seen.add(q.id);
        const change = changes.get(q.id);
        return change ? { ...q, ...change } : q;
      });
      for (const q of updated) {
        if (!seen.has(q.id) && changes.has(q.id)) merged.push(q);
      }

      const res = await apiRequest("PATCH", `/api/deals/${dealId}/financial-analysis/${analysis.id}`, {
        clarifyingQuestions: merged,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "financial-analysis"] });
      toast({ title: "Updated" });
    },
    onError: (err: unknown) => {
      toast({ title: "Update failed", description: apiErrorMessage(err, "Failed to update clarifying questions"), variant: "destructive" });
    },
  });

  // Route a clarifying question to the seller interview. Goes through the
  // server so an ask_seller discrepancy is created — the interview knowledge
  // base reads those; a local status flip would reach no one.
  const routeToSeller = useMutation({
    mutationFn: async (question: ClarifyingQuestion) => {
      if (!analysis?.id) throw new Error("No analysis to update");
      const r = await apiRequest(
        "POST",
        `/api/deals/${dealId}/financial-analysis/${analysis.id}/questions/${encodeURIComponent(question.id)}/route-to-seller`,
      );
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "financial-analysis"] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancies"] });
      toast({
        title: "Routed to seller interview",
        description: "The AI interview will raise this with the seller naturally and capture their answer.",
      });
    },
    onError: (err: unknown) => {
      toast({ title: "Could not route to seller", description: apiErrorMessage(err, "Failed to route question to the seller interview"), variant: "destructive" });
    },
  });

  // Extract typed data from analysis
  const pnlData = analysis?.reclassifiedPnl as ReclassifiedTableData | null;
  const bsData = analysis?.reclassifiedBalanceSheet as ReclassifiedTableData | null;
  const normData = analysis?.normalization as NormalizationData | null;
  const wcData = analysis?.workingCapital as WorkingCapitalData | null;
  const questionsData = analysis?.clarifyingQuestions as ClarifyingQuestion[] | null;
  const insightsData = analysis?.insights as InsightsData | null;
  // Same rule the Questions tab uses for its "Pending" group (includes routed
  // questions the broker took back from the interview).
  const pendingQuestionCount = countPendingQuestions(questionsData, allDiscrepancies);

  // Handlers for editable sub-components
  const handlePnlUpdate = (updated: ReclassifiedTableData) => {
    updateAnalysis.mutate({ reclassifiedPnl: updated as any });
  };

  const handleBsUpdate = (updated: ReclassifiedTableData) => {
    updateAnalysis.mutate({ reclassifiedBalanceSheet: updated as any });
  };

  const handleNormUpdate = (updated: NormalizationData) => {
    updateAnalysis.mutate({ normalization: updated as any });
  };

  const handleQuestionsUpdate = (updated: ClarifyingQuestion[]) => {
    updateQuestions.mutate(updated);
  };

  const statusCfg = analysis ? (STATUS_BADGE[analysis.status] || STATUS_BADGE.draft) : null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // A failed fetch must never look like "no analysis yet" — the CTA below
  // would tempt the broker into starting a duplicate run.
  if (analysisError) {
    return <PanelError what="the financial analysis" onRetry={() => refetchAnalysis()} />;
  }

  // No analysis yet — show CTA
  if (!analysis) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          {onBack && (
            <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Financial Analysis</h2>
            <p className="text-sm text-muted-foreground mt-0.5">
              AI-powered reclassification, normalization, and insight generation.
            </p>
          </div>
        </div>

        <div className="rounded-lg border border-teal/30 bg-teal-muted/40 p-8 text-center">
          <div className="h-12 w-12 rounded-full bg-teal/10 flex items-center justify-center mx-auto mb-4">
            <DollarSign className="h-6 w-6 text-teal/60" />
          </div>
          <p className="text-sm font-medium mb-1">No financial analysis yet</p>
          <p className="text-xs text-muted-foreground mb-6 max-w-md mx-auto">
            The AI analyzes everything known about the deal — financial statements, tax returns,
            valuation workbooks, emails, and interview answers. It reclassifies accounts,
            calculates SDE/EBITDA, identifies working capital, cross-checks values between
            sources, and surfaces clarifying questions.
          </p>
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90 gap-2"
            onClick={() => runAnalysis.mutate()}
            disabled={runAnalysis.isPending}
          >
            {runAnalysis.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Running Analysis...</>
            ) : (
              <><Zap className="h-4 w-4" /> Run Financial Analysis</>
            )}
          </Button>
        </div>
      </div>
    );
  }

  const isRunning = analysis.status === "running";
  const isFailed = analysis.status === "failed";
  const latestIsRunning = latestAnalysis?.status === "running";
  const analysisComplete = analysis.status === "completed" || analysis.status === "reviewed";
  const latestVersion = latestAnalysis?.version ?? analysis.version;
  const versionLabel = (v: AnalysisVersionSummary) => {
    const status = (STATUS_BADGE[v.status] || STATUS_BADGE.draft).label;
    const when = v.createdAt ? new Date(v.createdAt).toLocaleDateString() : "";
    return `v${v.version}${v.id === latestAnalysis?.id ? " (latest)" : ""} · ${status}${when ? ` · ${when}` : ""}`;
  };

  // Analysis exists — show tabbed interface
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {onBack && (
            <button onClick={onBack} className="text-muted-foreground hover:text-foreground transition-colors" aria-label="Back">
              <ArrowLeft className="h-4 w-4" />
            </button>
          )}
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight">Financial Analysis</h2>
            {versions.length > 1 ? (
              <Select
                value={analysis.id}
                onValueChange={(id) => setSelectedVersionId(id === latestAnalysis?.id ? null : id)}
              >
                <SelectTrigger className="h-7 text-xs w-auto min-w-[200px] mt-0.5 border-border/60 bg-transparent px-2" aria-label="Analysis version">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {versions.map((v) => (
                    <SelectItem key={v.id} value={v.id} className="text-xs">
                      {versionLabel(v)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <p className="text-sm text-muted-foreground mt-0.5">
                Version {analysis.version}
              </p>
            )}
          </div>
          {statusCfg && (
            <Badge className={statusCfg.color}>{statusCfg.label}</Badge>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {viewingOlder && (
            <Button size="sm" variant="ghost" className="h-8 text-xs" onClick={() => setSelectedVersionId(null)}>
              View latest (v{latestVersion})
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs gap-1.5"
            onClick={() => setRerunOpen(true)}
            disabled={runAnalysis.isPending || latestIsRunning}
          >
            {runAnalysis.isPending || latestIsRunning ? (
              <><Loader2 className="h-3 w-3 animate-spin" /> Running...</>
            ) : (
              <><RefreshCw className="h-3 w-3" /> Re-run Analysis</>
            )}
          </Button>
        </div>
      </div>

      {/* Re-run confirmation — same pattern as the Designer's Regenerate Layout */}
      <AlertDialog open={rerunOpen} onOpenChange={(open) => { if (!runAnalysis.isPending) setRerunOpen(open); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Re-run the financial analysis?</AlertDialogTitle>
            <AlertDialogDescription>
              This creates version {latestVersion + 1} from the current documents, tax returns, and deal knowledge.
              Your reclassifications, custom addbacks, approval toggles, and answered, dismissed, or routed
              questions are carried into the new version. Version {latestVersion} stays available in the version menu.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={runAnalysis.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              disabled={runAnalysis.isPending}
              onClick={(e) => { e.preventDefault(); runAnalysis.mutate(); }}
            >
              {runAnalysis.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
              Re-run
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Viewing an earlier version */}
      {viewingOlder && (
        <div className="rounded-lg border border-border/60 bg-muted/20 px-4 py-2.5 text-xs text-muted-foreground">
          Viewing version {analysis.version}. Edits here are saved to this version only; the latest is v{latestVersion}.
        </div>
      )}

      {/* Running banner */}
      {isRunning && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-3 flex items-center gap-3">
          <Loader2 className="h-4 w-4 animate-spin text-amber-400 shrink-0" />
          <div>
            <p className="text-sm font-medium text-amber-400">Analysis in progress</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Extracting statements, cross-checking every source, and building the normalization. This page updates automatically.
            </p>
          </div>
        </div>
      )}

      {/* Failed banner */}
      {isFailed && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 flex items-start gap-3">
          <AlertTriangle className="h-4 w-4 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-destructive">Analysis failed</p>
            {analysis.aiReasoning && (
              <p className="text-xs text-muted-foreground mt-0.5">{analysis.aiReasoning}</p>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1 shrink-0"
            onClick={() => setRerunOpen(true)}
            disabled={runAnalysis.isPending}
          >
            <RefreshCw className="h-3 w-3" /> Retry
          </Button>
        </div>
      )}

      {/* Discrepancies failed to load — say so rather than silently showing "no discrepancies" */}
      {discError && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-4 py-2.5 flex items-center gap-3">
          <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0" />
          <p className="text-xs text-muted-foreground flex-1 min-w-0">
            Couldn't load discrepancies. The routing summary and the Discrepancies tab count may be out of date.
          </p>
          <Button size="sm" variant="outline" className="h-7 text-xs shrink-0" onClick={() => refetchDisc()}>
            Retry
          </Button>
        </div>
      )}

      {/* Discrepancy routing banner */}
      {!isRunning && !discError && finDiscrepancies.length > 0 && (
        unrouted.length > 0 ? (
          <div className={`rounded-lg border px-4 py-3 flex items-center gap-3 ${
            unroutedCritical.length > 0
              ? "border-red-500/30 bg-red-500/5"
              : "border-amber-500/30 bg-amber-500/5"
          }`}>
            <GitCompareArrows className={`h-4 w-4 shrink-0 ${unroutedCritical.length > 0 ? "text-red-400" : "text-amber-400"}`} />
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${unroutedCritical.length > 0 ? "text-red-400" : "text-amber-400"}`}>
                {unrouted.length} discrepanc{unrouted.length === 1 ? "y" : "ies"} to route
                {unroutedCritical.length > 0 && ` (${unroutedCritical.length} critical)`}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Sources disagree on these values. Resolve each one now, or send it to the AI seller interview.
                The analysis is finalized once every critical discrepancy is routed or resolved.
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs shrink-0"
              onClick={() => setTab("discrepancies")}
            >
              Review
            </Button>
          </div>
        ) : routedToSeller.length > 0 ? (
          <div className="rounded-lg border border-blue-500/30 bg-blue-500/5 px-4 py-3 flex items-center gap-3">
            <MessageCircleQuestion className="h-4 w-4 text-blue-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-blue-400">
                All discrepancies routed — {routedToSeller.length} awaiting the seller interview
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                The AI interview will raise {routedToSeller.length === 1 ? "it" : "them"} with the seller naturally. Answers flow back into the knowledge base.
              </p>
            </div>
            <Button size="sm" variant="ghost" className="h-7 text-xs shrink-0" onClick={() => setTab("discrepancies")}>
              View
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-4 py-3 flex items-center gap-3">
            <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-emerald-400">All financial discrepancies resolved</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {resolvedDisc.length} conflict{resolvedDisc.length === 1 ? "" : "s"} reconciled. The analysis is finalized.
              </p>
            </div>
          </div>
        )
      )}

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList className="w-full justify-start bg-muted/50 h-9">
          <TabsTrigger value="overview" className="text-xs gap-1.5 data-[state=active]:bg-background">
            <BarChart3 className="h-3 w-3" /> Overview
          </TabsTrigger>
          <TabsTrigger value="income" className="text-xs gap-1.5 data-[state=active]:bg-background">
            <DollarSign className="h-3 w-3" /> Income Statement
          </TabsTrigger>
          <TabsTrigger value="balance" className="text-xs gap-1.5 data-[state=active]:bg-background">
            <Scale className="h-3 w-3" /> Balance Sheet
          </TabsTrigger>
          <TabsTrigger value="normalization" className="text-xs gap-1.5 data-[state=active]:bg-background">
            <Calculator className="h-3 w-3" /> Normalization
          </TabsTrigger>
          <TabsTrigger value="working-capital" className="text-xs gap-1.5 data-[state=active]:bg-background">
            <DollarSign className="h-3 w-3" /> Working Capital
          </TabsTrigger>
          <TabsTrigger value="discrepancies" className="text-xs gap-1.5 data-[state=active]:bg-background">
            <GitCompareArrows className="h-3 w-3" /> Discrepancies
            {unrouted.length > 0 && (
              <span className={`ml-1 h-4 min-w-[1rem] rounded-full text-2xs font-medium flex items-center justify-center px-1 ${
                unroutedCritical.length > 0 ? "bg-red-500/20 text-red-400" : "bg-amber-500/20 text-amber-400"
              }`}>
                {unrouted.length}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="questions" className="text-xs gap-1.5 data-[state=active]:bg-background">
            <HelpCircle className="h-3 w-3" /> Questions
            {pendingQuestionCount > 0 && (
              <span className="ml-1 h-4 min-w-[1rem] rounded-full bg-amber-500/20 text-amber-400 text-2xs font-medium flex items-center justify-center px-1">
                {pendingQuestionCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="insights" className="text-xs gap-1.5 data-[state=active]:bg-background">
            <Lightbulb className="h-3 w-3" /> Insights
          </TabsTrigger>
          <TabsTrigger value="verify-addbacks" className="text-xs gap-1.5 data-[state=active]:bg-background">
            <ShieldCheck className="h-3 w-3" /> Verify Addbacks
          </TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <FinancialOverview analysis={analysis} dealId={dealId} />
        </TabsContent>

        <TabsContent value="income">
          <ReclassifiedTable
            data={pnlData}
            title="Reclassified Income Statement"
            onUpdate={handlePnlUpdate}
          />
        </TabsContent>

        <TabsContent value="balance">
          <ReclassifiedTable
            data={bsData}
            title="Reclassified Balance Sheet"
            mode="balance"
            onUpdate={handleBsUpdate}
            emptyMessage={analysisComplete
              ? "No balance sheet was found in the uploaded documents. Upload one on the Overview tab and re-run the analysis."
              : undefined}
          />
        </TabsContent>

        <TabsContent value="normalization">
          <NormalizationPanel
            data={normData}
            onUpdate={handleNormUpdate}
          />
        </TabsContent>

        <TabsContent value="working-capital">
          <WorkingCapitalPanel data={wcData} analysisComplete={analysisComplete} />
        </TabsContent>

        <TabsContent value="discrepancies">
          <DiscrepancyPanel
            dealId={dealId}
            sourceFilter="financial_analysis"
            hideRunCheck
          />
        </TabsContent>

        <TabsContent value="questions">
          <ClarifyingQuestions
            questions={questionsData}
            onUpdate={handleQuestionsUpdate}
            onRouteToSeller={(q) => routeToSeller.mutate(q)}
            routingQuestionId={routeToSeller.isPending ? routeToSeller.variables?.id ?? null : null}
            discrepancies={allDiscrepancies}
          />
        </TabsContent>

        <TabsContent value="insights">
          <InsightsPanel data={insightsData} />
        </TabsContent>

        <TabsContent value="verify-addbacks">
          <AddbackVerification
            dealId={dealId}
            financialAnalysisId={analysis?.id}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
