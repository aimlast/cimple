/**
 * DiscrepancyPanel — Shows cross-reference discrepancies between what the
 * seller said and what the documents show: the verification check, the
 * financial analysis, and conflicts the fact merge raised itself ("Sources
 * disagree").
 *
 * Renders before CIM generation in Phase 3 (all discrepancies) and inside
 * the Financial Analysis Center (sourceFilter="financial_analysis").
 * Critical discrepancies must be resolved before the CIM can be generated.
 *
 * Broker actions per discrepancy:
 *  - Resolve now: accept one side, or enter a corrected value. The value is
 *    written into the fact it is about; when no fact maps, the broker is
 *    asked "Which fact should this update?" (never a silent no-op). Other
 *    facts that still repeat the ruled-out value are offered for a one-click
 *    update.
 *  - Ask the seller in the interview: routes it to the AI interview agent
 *    (status "ask_seller"), which raises it naturally with the seller. A side
 *    from the broker's private notes is never shown to the seller.
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PanelError } from "@/components/deal/PanelError";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Discrepancy } from "@shared/schema";
import {
  discrepancyFieldLabel,
  discrepancyHasPrivateSide,
  discrepancySideHeading,
  discrepancySideLabel,
  discrepancySideValue,
  isSettledDiscrepancy,
} from "@shared/discrepancy-sides";
import { DiscrepancyHeaderLine } from "@/components/deal/DiscrepancyHeaderLine";
import {
  CheckCircle2, Loader2, Search, ChevronDown, ChevronRight, FileText, ArrowRight,
  MessageCircleQuestion, Undo2, Lock, Link2, RefreshCw,
} from "lucide-react";

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

/** The list endpoint annotates resolved rows. */
type DiscrepancyRow = Discrepancy & {
  linkedFact?: { key: string; label: string } | null;
  needsFactMapping?: boolean;
  staleFactCount?: number;
};

interface StaleFact { key: string; label: string; value: string; outdated: string[] }
interface Proposal extends StaleFact { proposed: string; method: "ai" | "swap" | "manual" }
interface FactOption { key: string; label: string; value: string }

type ResolveResponse = Discrepancy & {
  factWrite:
    | { status: "written"; key: string }
    | { status: "narrative"; key: string }
    | { status: "needs_mapping" }
    | { status: "not_linked" }
    | null;
  staleFacts: StaleFact[];
};

interface DiscrepancyPanelProps {
  dealId: string;
  onAllResolved?: () => void;
  /** Show only discrepancies from one source (e.g. "financial_analysis"). */
  sourceFilter?: string;
  /** Hide the "Run Verification Check" CTA (the financial analysis generates its own). */
  hideRunCheck?: boolean;
}

const discrepanciesKey = (dealId: string) => ["/api/deals", dealId, "discrepancies"] as const;

function invalidateFacts(dealId: string) {
  queryClient.invalidateQueries({ queryKey: discrepanciesKey(dealId) });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "information"] });
  queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancy-check-status"] });
}

export function DiscrepancyPanel({ dealId, onAllResolved, sourceFilter, hideRunCheck }: DiscrepancyPanelProps) {
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [resolvedValues, setResolvedValues] = useState<Record<string, string>>({});
  const [linkFor, setLinkFor] = useState<DiscrepancyRow | null>(null);
  const [updateFor, setUpdateFor] = useState<DiscrepancyRow | null>(null);

  const { data: allDiscrepancies = [], isLoading, error: loadError, refetch } = useQuery<DiscrepancyRow[]>({
    queryKey: discrepanciesKey(dealId),
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/discrepancies`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load discrepancies");
      return r.json();
    },
  });

  // Superseded rows are stale findings replaced by a newer run — never shown
  const discrepancies = allDiscrepancies.filter(
    (d) => d.status !== "superseded" && (!sourceFilter || d.source === sourceFilter),
  );

  const runCheck = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/run-discrepancy-check`);
      return r.json();
    },
    onSuccess: (data) => {
      invalidateFacts(dealId);
      toast({
        title: data.count > 0 ? `${data.count} new discrepanc${data.count === 1 ? "y" : "ies"} found` : "No new discrepancies",
        description: data.count > 0
          ? "Review and resolve before generating the CIM."
          : data.cleared > 0
            ? `${data.cleared} earlier finding${data.cleared === 1 ? "" : "s"} turned out to agree and ${data.cleared === 1 ? "was" : "were"} cleared.`
            : "What the seller said matches the documents.",
      });
    },
    onError: (e: unknown) => toast({ title: "Check failed", description: apiErrorMessage(e, "Discrepancy check failed"), variant: "destructive" }),
  });

  const resolve = useMutation({
    mutationFn: async ({ id, action, value }: { id: string; action: "interview" | "document" | "custom"; value?: string }) => {
      const disc = discrepancies.find(d => d.id === id);
      if (!disc) throw new Error("Not found");
      const resolvedValue = action === "custom" ? value || "" : discrepancySideValue(disc, action);
      const r = await apiRequest("PATCH", `/api/discrepancies/${id}`, {
        status: "resolved",
        resolvedValue,
        sellerResponse: responses[id] || null,
      });
      return (await r.json()) as ResolveResponse;
    },
    onSuccess: (data) => {
      invalidateFacts(dealId);
      const row = { ...(discrepancies.find((d) => d.id === data.id) ?? {}), ...data } as DiscrepancyRow;
      if (data.factWrite?.status === "needs_mapping") {
        toast({ title: "Discrepancy resolved", description: "Choose which fact this value should update." });
        setLinkFor(row);
      } else if ((data.factWrite?.status === "written" || data.factWrite?.status === "narrative") && data.staleFacts?.length > 0) {
        toast({ title: "Discrepancy resolved", description: `${data.staleFacts.length} other fact${data.staleFacts.length === 1 ? " still says" : "s still say"} the old value.` });
        setUpdateFor(row);
      } else if (data.factWrite?.status === "narrative") {
        toast({ title: "Discrepancy resolved", description: "That fact is a longer description, so it wasn't overwritten — update its wording on the Information tab if it mentions the old figure." });
      } else {
        toast({ title: "Discrepancy resolved" });
      }
      const remaining = discrepancies.filter(d => d.status === "open" || d.status === "seller_responded");
      if (remaining.length <= 1 && onAllResolved) onAllResolved();
    },
    onError: (e: unknown) => toast({ title: "Could not resolve discrepancy", description: apiErrorMessage(e, "Failed to resolve discrepancy"), variant: "destructive" }),
  });

  const route = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "ask_seller" | "open" }) => {
      const r = await apiRequest("PATCH", `/api/discrepancies/${id}`, { status });
      return r.json();
    },
    onSuccess: (data, vars) => {
      invalidateFacts(dealId);
      const priv = discrepancyHasPrivateSide(data);
      toast({
        title: vars.status === "ask_seller" ? "Routed to seller interview" : "Returned to open",
        description: vars.status === "ask_seller"
          ? priv.interview || priv.document
            ? "The interview will ask the seller for the right figure in its own words — your private notes are never shown or mentioned."
            : "The AI interview will raise this with the seller naturally and capture their answer."
          : undefined,
      });
    },
    onError: (e: unknown) => toast({ title: "Could not update routing", description: apiErrorMessage(e, "Failed to update discrepancy"), variant: "destructive" }),
  });

  // Stats
  const open = discrepancies.filter(d => d.status === "open" || d.status === "seller_responded");
  const routed = discrepancies.filter(d => d.status === "ask_seller");
  const resolved = discrepancies.filter(isSettledDiscrepancy);
  const criticalOpen = open.filter(d => d.severity === "critical");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (loadError) {
    return <PanelError what="discrepancies" onRetry={() => refetch()} />;
  }

  // No discrepancies yet — show run button (or an all-clear note)
  if (discrepancies.length === 0) {
    if (hideRunCheck) {
      return (
        <Card className="bg-card/50 border-border/50">
          <CardContent className="py-6 text-center space-y-2">
            <CheckCircle2 className="h-8 w-8 text-emerald-400/40 mx-auto" />
            <p className="text-sm font-medium">No discrepancies</p>
            <p className="text-xs text-muted-foreground max-w-md mx-auto">
              The financial analysis cross-checks values across documents, tax returns, the
              knowledge base, and the questionnaire. Conflicts it finds will appear here.
            </p>
          </CardContent>
        </Card>
      );
    }
    return (
      <Card className="bg-card/50 border-border/50">
        <CardContent className="py-6 text-center space-y-3">
          <Search className="h-8 w-8 text-muted-foreground/30 mx-auto" />
          <div>
            <p className="text-sm font-medium">Verification Check</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
              Cross-reference what the seller said against the uploaded documents to catch inconsistencies before generating the CIM.
            </p>
          </div>
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90 gap-2"
            onClick={() => runCheck.mutate()}
            disabled={runCheck.isPending}
          >
            {runCheck.isPending ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> Checking...</>
            ) : (
              <><Search className="h-4 w-4" /> Run Verification Check</>
            )}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <h3 className="text-sm font-semibold">
            {sourceFilter === "financial_analysis" ? "Financial Discrepancies" : "Verification Results"}
          </h3>
          {criticalOpen.length > 0 ? (
            <Badge className="bg-red-500/10 text-red-400 border-0">
              {criticalOpen.length} critical unrouted
            </Badge>
          ) : open.length > 0 ? (
            <Badge className="bg-amber-500/10 text-amber-400 border-0">
              {open.length} to route
            </Badge>
          ) : routed.length > 0 ? (
            <Badge className="bg-blue-500/10 text-blue-400 border-0">
              All routed — {routed.length} with seller
            </Badge>
          ) : (
            <Badge className="bg-emerald-500/10 text-emerald-400 border-0">
              All resolved
            </Badge>
          )}
          {routed.length > 0 && open.length > 0 && (
            <Badge className="bg-blue-500/10 text-blue-400 border-0">
              {routed.length} with seller
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{resolved.length}/{discrepancies.length} resolved</span>
          {!hideRunCheck && (
            <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
              onClick={() => runCheck.mutate()} disabled={runCheck.isPending}>
              {runCheck.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
              Re-check
            </Button>
          )}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden flex">
        <div
          className="h-full bg-emerald-500 transition-all"
          style={{ width: `${discrepancies.length > 0 ? (resolved.length / discrepancies.length) * 100 : 0}%` }}
        />
        <div
          className="h-full bg-blue-500/70 transition-all"
          style={{ width: `${discrepancies.length > 0 ? (routed.length / discrepancies.length) * 100 : 0}%` }}
        />
      </div>

      {/* Discrepancy cards */}
      {discrepancies.map((disc) => {
        const isExpanded = expandedId === disc.id;
        const isFinancial = disc.source === "financial_analysis";
        const isRouted = disc.status === "ask_seller";
        const isOpen = disc.status === "open" || disc.status === "seller_responded";
        const settled = isSettledDiscrepancy(disc);
        // A clarifying question routed from the financial analysis has no second
        // source — it is a question with context, not two conflicting values.
        const isQuestion = isFinancial && !disc.documentValue;
        const priv = discrepancyHasPrivateSide(disc);
        const sideBox = (side: "interview" | "document") => {
          const value = discrepancySideValue(disc, side);
          const label = discrepancySideLabel(disc, side);
          const isPrivate = side === "interview" ? priv.interview : priv.document;
          return (
            <div className={`rounded p-2.5 min-w-0 ${isPrivate ? "bg-muted/20 border border-dashed border-border/60" : "bg-muted/30"}`}>
              <p className="text-2xs text-muted-foreground font-medium mb-1 flex items-center gap-1">
                {isPrivate && <Lock className="h-2.5 w-2.5" aria-hidden="true" />}
                {discrepancySideHeading(disc, side)}
              </p>
              <p className="text-xs break-words">{value || "—"}</p>
              {!isPrivate && (label || (side === "document" && disc.documentName)) && (
                <p className="text-2xs text-muted-foreground mt-1 flex items-center gap-1 break-words">
                  <FileText className="h-2.5 w-2.5 shrink-0" /> {label || disc.documentName}
                </p>
              )}
            </div>
          );
        };

        return (
          <Card
            key={disc.id}
            className={`bg-card/50 transition-colors ${
              settled ? "border-emerald-500/20 opacity-70" :
              isRouted ? "border-blue-500/20" :
              disc.severity === "critical" ? "border-red-500/30" : "border-border/50"
            }`}
          >
            <CardContent className="py-3 px-3 sm:px-4">
              {/* Header — a real button so it is keyboard-reachable and announces its state */}
              <button
                type="button"
                className="w-full flex items-start gap-2 text-left rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                onClick={() => setExpandedId(isExpanded ? null : disc.id)}
                aria-expanded={isExpanded}
                aria-controls={`discrepancy-${disc.id}`}
              >
                {isExpanded ? <ChevronDown className="h-3.5 w-3.5 mt-1 shrink-0 text-muted-foreground" aria-hidden="true" />
                  : <ChevronRight className="h-3.5 w-3.5 mt-1 shrink-0 text-muted-foreground" aria-hidden="true" />}
                <DiscrepancyHeaderLine disc={disc} showSource={!sourceFilter} />
              </button>

              {/* Resolved: which fact it updated, and anything still saying the old value */}
              {settled && !isExpanded && (disc.needsFactMapping || (disc.staleFactCount ?? 0) > 0) && (
                <div className="mt-2 pl-6 flex flex-wrap gap-2">
                  {disc.needsFactMapping && (
                    <Button size="sm" variant="outline" className="h-6 text-2xs gap-1" onClick={() => setLinkFor(disc)}>
                      <Link2 className="h-3 w-3" /> Choose the fact it updates
                    </Button>
                  )}
                  {(disc.staleFactCount ?? 0) > 0 && (
                    <Button size="sm" variant="outline" className="h-6 text-2xs gap-1 border-amber-500/30 text-amber-400" onClick={() => setUpdateFor(disc)}>
                      <RefreshCw className="h-3 w-3" /> {disc.staleFactCount} fact{disc.staleFactCount === 1 ? " still says" : "s still say"} the old value
                    </Button>
                  )}
                </div>
              )}

              {/* Expanded details */}
              {isExpanded && (
                <div id={`discrepancy-${disc.id}`} className="mt-3 pl-6 space-y-3">
                  {/* Value comparison (or a single context block for a routed question) */}
                  {isQuestion ? (
                    <div className="rounded bg-muted/30 p-2.5">
                      <p className="text-2xs text-muted-foreground font-medium mb-1">Context from the analysis</p>
                      <p className="text-xs">{disc.interviewValue || "No additional context"}</p>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_1fr] gap-2 sm:gap-3 items-start">
                      {sideBox("interview")}
                      <ArrowRight className="hidden sm:block h-4 w-4 text-muted-foreground mt-5" />
                      {sideBox("document")}
                    </div>
                  )}

                  {/* AI explanation */}
                  {disc.aiExplanation && (
                    <div className="text-xs text-muted-foreground bg-muted/20 rounded p-2.5">
                      <span className="font-medium text-foreground">AI analysis:</span> {disc.aiExplanation}
                    </div>
                  )}
                  {disc.suggestedResolution && (isOpen || isRouted) && (
                    <div className="text-xs text-muted-foreground bg-muted/20 rounded p-2.5">
                      <span className="font-medium text-foreground">Suggested:</span> {disc.suggestedResolution}
                    </div>
                  )}

                  {/* Routed state note */}
                  {isRouted && (
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-blue-500/5 border border-blue-500/20 p-2.5">
                      <p className="text-xs text-blue-400 flex items-center gap-1.5">
                        <MessageCircleQuestion className="h-3.5 w-3.5 shrink-0" />
                        The AI interview will raise this with the seller. You can still resolve it now below.
                      </p>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 text-2xs gap-1 text-muted-foreground shrink-0"
                        onClick={() => route.mutate({ id: disc.id, status: "open" })}
                        disabled={route.isPending}
                      >
                        <Undo2 className="h-3 w-3" /> Un-route
                      </Button>
                    </div>
                  )}

                  {/* Resolution actions */}
                  {(isOpen || isRouted) && (
                    <div className="space-y-2">
                      <Textarea
                        placeholder="Add context or explanation (optional)..."
                        className="text-xs h-14 resize-none bg-muted/20"
                        value={responses[disc.id] || ""}
                        onChange={(e) => setResponses({ ...responses, [disc.id]: e.target.value })}
                      />
                      <div className="flex flex-wrap gap-2">
                        {/* Only offer "accept" for values that exist — a routed
                            question has none; its answer is typed in below. */}
                        {!isQuestion && disc.interviewValue && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1"
                            onClick={() => resolve.mutate({ id: disc.id, action: "interview" })}
                            disabled={resolve.isPending}
                          >
                            Accept {priv.interview ? "your note's value" : `“${discrepancySideValue(disc, "interview").slice(0, 28)}${discrepancySideValue(disc, "interview").length > 28 ? "…" : ""}”`}
                          </Button>
                        )}
                        {!isQuestion && disc.documentValue && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1"
                            onClick={() => resolve.mutate({ id: disc.id, action: "document" })}
                            disabled={resolve.isPending}
                          >
                            Accept {priv.document ? "your note's value" : `“${discrepancySideValue(disc, "document").slice(0, 28)}${discrepancySideValue(disc, "document").length > 28 ? "…" : ""}”`}
                          </Button>
                        )}
                        <div className="flex items-center gap-1 w-full sm:w-auto">
                          <Input
                            placeholder={isQuestion ? "Enter the seller's answer..." : "Enter corrected value..."}
                            className="h-7 text-xs flex-1 sm:w-44"
                            value={resolvedValues[disc.id] || ""}
                            onChange={(e) => setResolvedValues({ ...resolvedValues, [disc.id]: e.target.value })}
                          />
                          <Button
                            size="sm"
                            className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90"
                            onClick={() => resolve.mutate({ id: disc.id, action: "custom", value: resolvedValues[disc.id] })}
                            disabled={resolve.isPending || !resolvedValues[disc.id]?.trim()}
                          >
                            Save
                          </Button>
                        </div>
                        {isOpen && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-xs gap-1 border-blue-500/30 text-blue-400 hover:bg-blue-500/10 hover:text-blue-300"
                            onClick={() => route.mutate({ id: disc.id, status: "ask_seller" })}
                            disabled={route.isPending}
                          >
                            <MessageCircleQuestion className="h-3 w-3" /> Ask seller in interview
                          </Button>
                        )}
                      </div>
                      {isOpen && (priv.interview || priv.document) && (
                        <p className="text-2xs text-muted-foreground flex items-start gap-1.5" data-testid="text-private-routing">
                          <Lock className="h-3 w-3 mt-px shrink-0" />
                          Part of this comes from your private notes. If you send it to the interview, the seller is asked for the figure in neutral words — your notes are never shown or mentioned.
                        </p>
                      )}
                    </div>
                  )}

                  {/* Resolved state */}
                  {settled && (
                    <div className="space-y-2">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-emerald-400">
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        <span>{disc.status === "accepted" ? "Accepted" : "Resolved"}{disc.resolvedValue ? `: ${disc.resolvedValue}` : ""}</span>
                        {disc.sellerResponse && (
                          <span className="text-muted-foreground">— {disc.sellerResponse}</span>
                        )}
                      </div>
                      {disc.linkedFact && (
                        <p className="text-2xs text-muted-foreground">Updated the fact “{disc.linkedFact.label}”.</p>
                      )}
                      <div className="flex flex-wrap gap-2">
                        {disc.needsFactMapping && (
                          <Button size="sm" variant="outline" className="h-6 text-2xs gap-1" onClick={() => setLinkFor(disc)}>
                            <Link2 className="h-3 w-3" /> Choose the fact it updates
                          </Button>
                        )}
                        {(disc.staleFactCount ?? 0) > 0 && (
                          <Button size="sm" variant="outline" className="h-6 text-2xs gap-1 border-amber-500/30 text-amber-400" onClick={() => setUpdateFor(disc)}>
                            <RefreshCw className="h-3 w-3" /> {disc.staleFactCount} fact{disc.staleFactCount === 1 ? " still says" : "s still say"} the old value
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}

      <LinkFactDialog
        dealId={dealId}
        disc={linkFor}
        onClose={() => setLinkFor(null)}
        onLinked={(data) => {
          setLinkFor(null);
          if (data.staleFacts?.length > 0) setUpdateFor({ ...(linkFor as DiscrepancyRow), ...data });
        }}
      />
      <UpdateRelatedFactsDialog dealId={dealId} disc={updateFor} onClose={() => setUpdateFor(null)} />
    </div>
  );
}

/**
 * "Which fact should this update?" — shown when a resolution names no fact
 * on file. Best matches first, a search over every fact, or keep it as a
 * note only.
 */
function LinkFactDialog({
  dealId, disc, onClose, onLinked,
}: {
  dealId: string;
  disc: DiscrepancyRow | null;
  onClose: () => void;
  onLinked: (data: ResolveResponse) => void;
}) {
  const { toast } = useToast();
  const [search, setSearch] = useState("");
  const { data, isLoading } = useQuery<{ suggestions: FactOption[]; all: FactOption[] }>({
    queryKey: ["/api/discrepancies", disc?.id, "fact-targets"],
    enabled: !!disc,
    queryFn: async () => {
      const r = await fetch(`/api/discrepancies/${disc!.id}/fact-targets`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load facts");
      return r.json();
    },
  });
  const link = useMutation({
    mutationFn: async (choice: { factKey: string } | { newFactLabel: string }) => {
      const r = await apiRequest("PATCH", `/api/discrepancies/${disc!.id}`, choice);
      return (await r.json()) as ResolveResponse;
    },
    onSuccess: (res) => {
      invalidateFacts(dealId);
      const status = res.factWrite?.status;
      toast({
        title: status === "written" ? "Fact updated" : status === "narrative" ? "Resolved — review the wording" : "Kept as a note",
        description:
          status === "written" ? undefined
          : status === "narrative" ? "That fact is a longer description, so it wasn't overwritten."
          : "The resolution stays on record without changing a fact.",
      });
      setSearch("");
      onLinked(res);
    },
    onError: (e: unknown) => toast({ title: "Couldn't update the fact", description: apiErrorMessage(e, "Failed to link the fact"), variant: "destructive" }),
  });
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return (data?.all ?? []).filter((o) => o.label.toLowerCase().includes(q) || o.key.toLowerCase().includes(q) || o.value.toLowerCase().includes(q)).slice(0, 30);
  }, [search, data]);
  const option = (o: FactOption) => (
    <button
      key={o.key}
      type="button"
      className="block w-full min-w-0 overflow-hidden text-left rounded border border-border/50 px-3 py-2 hover:bg-muted/40 disabled:opacity-50"
      onClick={() => link.mutate({ factKey: o.key })}
      disabled={link.isPending}
    >
      <p className="text-xs font-medium">{o.label}</p>
      <p className="text-2xs text-muted-foreground truncate">{o.value}</p>
    </button>
  );
  return (
    <Dialog open={!!disc} onOpenChange={(open) => { if (!open) { setSearch(""); onClose(); } }}>
      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto grid-cols-1 [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Which fact should this update?</DialogTitle>
          <DialogDescription>
            {disc ? <>“{discrepancyFieldLabel(disc)}” was resolved as <span className="text-foreground">{disc.resolvedValue}</span>. Pick the fact on file it corrects.</> : null}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="min-w-0 space-y-3">
            {(data?.suggestions.length ?? 0) > 0 && (
              <div className="space-y-1.5">
                <p className="text-2xs uppercase tracking-wide text-muted-foreground">Best matches</p>
                {data!.suggestions.map(option)}
              </div>
            )}
            <div className="space-y-1.5">
              <Input placeholder="Search every fact…" className="h-8 text-xs" value={search} onChange={(e) => setSearch(e.target.value)} />
              {search.trim() && (
                <div className="max-h-56 overflow-y-auto space-y-1.5">
                  {filtered.length > 0 ? filtered.map(option) : <p className="text-2xs text-muted-foreground py-2">No fact matches “{search}”.</p>}
                </div>
              )}
            </div>
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-0 flex-wrap">
          {disc && (
            <Button variant="outline" size="sm" className="text-xs" onClick={() => link.mutate({ newFactLabel: discrepancyFieldLabel(disc) })} disabled={link.isPending}>
              Save as a new fact “{discrepancyFieldLabel(disc)}”
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-xs" onClick={() => link.mutate({ factKey: "" })} disabled={link.isPending}>
            Keep as a note only
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Other facts that still state the value the resolution ruled out — each
 * with a suggested rewrite the broker can edit, then applied in one click
 * (written as the broker's edits; the old text stays as another value).
 */
function UpdateRelatedFactsDialog({ dealId, disc, onClose }: { dealId: string; disc: DiscrepancyRow | null; onClose: () => void }) {
  const { toast } = useToast();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [included, setIncluded] = useState<Record<string, boolean>>({});
  const { data, isLoading, error } = useQuery<{ proposals: Proposal[] }>({
    queryKey: ["/api/discrepancies", disc?.id, "propagation", "proposals"],
    enabled: !!disc,
    staleTime: 0,
    gcTime: 0,
    queryFn: async () => {
      const r = await apiRequest("POST", `/api/discrepancies/${disc!.id}/propagation/propose`);
      const body = (await r.json()) as { proposals: Proposal[] };
      setDrafts(Object.fromEntries(body.proposals.map((p) => [p.key, p.proposed])));
      setIncluded(Object.fromEntries(body.proposals.map((p) => [p.key, p.method !== "manual"])));
      return body;
    },
  });
  const apply = useMutation({
    mutationFn: async () => {
      const edits = (data?.proposals ?? [])
        .filter((p) => included[p.key] && (drafts[p.key] ?? "").trim())
        .map((p) => ({ key: p.key, value: drafts[p.key].trim() }));
      const r = await apiRequest("POST", `/api/discrepancies/${disc!.id}/propagation/apply`, { edits });
      return (await r.json()) as { applied: string[]; staleFacts: StaleFact[] };
    },
    onSuccess: (res) => {
      invalidateFacts(dealId);
      toast({
        title: `Updated ${res.applied.length} fact${res.applied.length === 1 ? "" : "s"}`,
        description: res.staleFacts.length > 0
          ? `${res.staleFacts.length} still mention${res.staleFacts.length === 1 ? "s" : ""} the old value — edit ${res.staleFacts.length === 1 ? "it" : "them"} on the Information tab.`
          : "The old text is kept as another value on each fact.",
      });
      onClose();
    },
    onError: (e: unknown) => toast({ title: "Couldn't update the facts", description: apiErrorMessage(e, "Update failed"), variant: "destructive" }),
  });
  const proposals = data?.proposals ?? [];
  const chosen = proposals.filter((p) => included[p.key]).length;
  return (
    <Dialog open={!!disc} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto grid-cols-1 [&>*]:min-w-0">
        <DialogHeader>
          <DialogTitle>Update facts that still say the old value</DialogTitle>
          <DialogDescription>
            {disc ? <>You settled “{discrepancyFieldLabel(disc)}” as <span className="text-foreground">{disc.resolvedValue}</span>. These facts don't match it yet, and the CIM is written from them. Review each suggested update before it's saved.</> : null}
          </DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Drafting the updates…
          </div>
        ) : error ? (
          <p className="text-xs text-red-400 py-4">{apiErrorMessage(error, "Couldn't suggest the updates.")}</p>
        ) : proposals.length === 0 ? (
          <p className="text-xs text-muted-foreground py-4">Nothing else on file repeats the old value.</p>
        ) : (
          <div className="min-w-0 space-y-3">
            {proposals.map((p) => (
              <div key={p.key} className="rounded border border-border/50 p-3 space-y-2">
                <div className="flex items-start gap-2">
                  <Checkbox
                    id={`upd-${p.key}`}
                    checked={!!included[p.key]}
                    onCheckedChange={(v) => setIncluded({ ...included, [p.key]: v === true })}
                    className="mt-0.5"
                  />
                  <label htmlFor={`upd-${p.key}`} className="min-w-0 flex-1">
                    <p className="text-xs font-medium">{p.label}</p>
                    <p className="text-2xs text-muted-foreground">
                      {p.outdated.length > 0
                        ? <>Still says {p.outdated.map((o) => `“${o}”`).join(", ")}</>
                        : <>A description — the settled value is worked into it, nothing else changes</>}
                      {p.method === "manual" ? " — edit the text below" : ""}
                    </p>
                  </label>
                </div>
                <p className="text-2xs text-muted-foreground line-through decoration-muted-foreground/50 break-words pl-6">{p.value}</p>
                <Textarea
                  className="text-xs min-h-[64px] bg-muted/20 ml-6 w-[calc(100%-1.5rem)]"
                  value={drafts[p.key] ?? ""}
                  onChange={(e) => { setDrafts({ ...drafts, [p.key]: e.target.value }); setIncluded({ ...included, [p.key]: true }); }}
                />
              </div>
            ))}
          </div>
        )}
        <DialogFooter className="gap-2 sm:gap-0">
          <Button variant="ghost" size="sm" className="text-xs" onClick={onClose}>Not now</Button>
          <Button
            size="sm"
            className="text-xs bg-teal text-teal-foreground hover:bg-teal/90"
            onClick={() => apply.mutate()}
            disabled={apply.isPending || chosen === 0}
          >
            {apply.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : `Update ${chosen} fact${chosen === 1 ? "" : "s"}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
