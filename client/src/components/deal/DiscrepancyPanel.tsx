/**
 * DiscrepancyPanel — Shows cross-reference discrepancies between
 * seller interview answers and uploaded documents.
 *
 * Renders before CIM generation in Phase 3. Critical discrepancies
 * must be resolved before the CIM can be generated.
 */
import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Discrepancy } from "@shared/schema";
import {
  AlertTriangle, CheckCircle2, XCircle, Loader2, Search,
  ChevronDown, ChevronRight, FileText, ArrowRight,
} from "lucide-react";

interface DiscrepancyPanelProps {
  dealId: string;
  onAllResolved?: () => void;
}

const SEVERITY_CONFIG = {
  critical:    { label: "Critical",    color: "bg-red-500/10 text-red-400 border-0",    icon: XCircle },
  significant: { label: "Significant", color: "bg-amber-500/10 text-amber-400 border-0", icon: AlertTriangle },
  minor:       { label: "Minor",       color: "bg-muted text-muted-foreground border-0", icon: AlertTriangle },
};

const CATEGORY_LABELS: Record<string, string> = {
  financial: "Financial",
  operational: "Operational",
  legal: "Legal",
  factual: "Factual",
};

export function DiscrepancyPanel({ dealId, onAllResolved }: DiscrepancyPanelProps) {
  const { toast } = useToast();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [resolvedValues, setResolvedValues] = useState<Record<string, string>>({});

  const { data: discrepancies = [], isLoading } = useQuery<Discrepancy[]>({
    queryKey: ["/api/deals", dealId, "discrepancies"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/discrepancies`);
      if (!r.ok) return [];
      return r.json();
    },
  });

  const runCheck = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/run-discrepancy-check`);
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancies"] });
      toast({
        title: data.count > 0 ? `${data.count} discrepancies found` : "No discrepancies found",
        description: data.count > 0 ? "Review and resolve before generating the CIM." : "All data is consistent. Ready to generate.",
      });
    },
    onError: (e: Error) => toast({ title: "Check failed", description: e.message, variant: "destructive" }),
  });

  const resolve = useMutation({
    mutationFn: async ({ id, action, value }: { id: string; action: "interview" | "document" | "custom"; value?: string }) => {
      const disc = discrepancies.find(d => d.id === id);
      if (!disc) throw new Error("Not found");

      const resolvedValue = action === "interview"
        ? disc.interviewValue || ""
        : action === "document"
        ? disc.documentValue || ""
        : value || "";

      const sellerResponse = responses[id] || null;

      const r = await apiRequest("PATCH", `/api/discrepancies/${id}`, {
        status: "resolved",
        resolvedValue,
        sellerResponse,
      });
      if (!r.ok) throw new Error("Failed to resolve");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "discrepancies"] });
      toast({ title: "Discrepancy resolved" });

      // Check if all are now resolved
      const remaining = discrepancies.filter(d => d.status === "open" || d.status === "seller_responded");
      if (remaining.length <= 1 && onAllResolved) {
        onAllResolved();
      }
    },
    onError: (e: Error) => toast({ title: "Failed", description: e.message, variant: "destructive" }),
  });

  // Stats
  const open = discrepancies.filter(d => d.status === "open");
  const resolved = discrepancies.filter(d => d.status === "resolved" || d.status === "accepted");
  const criticalOpen = open.filter(d => d.severity === "critical");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No discrepancies yet — show run button
  if (discrepancies.length === 0) {
    return (
      <Card className="bg-card/50 border-border/50">
        <CardContent className="py-6 text-center space-y-3">
          <Search className="h-8 w-8 text-muted-foreground/30 mx-auto" />
          <div>
            <p className="text-sm font-medium">Verification Check</p>
            <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
              Cross-reference seller interview answers against uploaded documents to catch inconsistencies before generating the CIM.
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
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h3 className="text-sm font-semibold">Verification Results</h3>
          {criticalOpen.length > 0 ? (
            <Badge className="bg-red-500/10 text-red-400 border-0">
              {criticalOpen.length} critical unresolved
            </Badge>
          ) : open.length > 0 ? (
            <Badge className="bg-amber-500/10 text-amber-400 border-0">
              {open.length} unresolved
            </Badge>
          ) : (
            <Badge className="bg-emerald-500/10 text-emerald-400 border-0">
              All resolved
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span>{resolved.length}/{discrepancies.length} resolved</span>
          <Button variant="ghost" size="sm" className="h-7 text-xs gap-1"
            onClick={() => runCheck.mutate()} disabled={runCheck.isPending}>
            {runCheck.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Search className="h-3 w-3" />}
            Re-check
          </Button>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 rounded-full bg-muted/40 overflow-hidden">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all"
          style={{ width: `${discrepancies.length > 0 ? (resolved.length / discrepancies.length) * 100 : 0}%` }}
        />
      </div>

      {/* Discrepancy cards */}
      {discrepancies.map((disc) => {
        const isExpanded = expandedId === disc.id;
        const config = SEVERITY_CONFIG[disc.severity as keyof typeof SEVERITY_CONFIG] || SEVERITY_CONFIG.minor;
        const Icon = config.icon;
        const isOpen = disc.status === "open" || disc.status === "seller_responded";

        return (
          <Card
            key={disc.id}
            className={`bg-card/50 transition-colors ${
              disc.status === "resolved" ? "border-emerald-500/20 opacity-60" :
              disc.severity === "critical" ? "border-red-500/30" : "border-border/50"
            }`}
          >
            <CardContent className="py-3 px-4">
              {/* Header */}
              <div
                className="flex items-center justify-between cursor-pointer"
                onClick={() => setExpandedId(isExpanded ? null : disc.id)}
              >
                <div className="flex items-center gap-2">
                  {isExpanded ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />}
                  <Icon className={`h-3.5 w-3.5 ${config.color.split(" ")[1]}`} />
                  <Badge className={config.color}>{config.label}</Badge>
                  <Badge variant="outline" className="text-2xs">{CATEGORY_LABELS[disc.category] || disc.category}</Badge>
                  <span className="text-sm font-medium">{disc.field}</span>
                </div>
                {disc.status === "resolved" && (
                  <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
                )}
              </div>

              {/* Expanded details */}
              {isExpanded && (
                <div className="mt-3 pl-6 space-y-3">
                  {/* Value comparison */}
                  <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start">
                    <div className="rounded bg-muted/30 p-2.5">
                      <p className="text-2xs text-muted-foreground font-medium mb-1">Interview / Seller said</p>
                      <p className="text-xs">{disc.interviewValue || "—"}</p>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground mt-5" />
                    <div className="rounded bg-muted/30 p-2.5">
                      <p className="text-2xs text-muted-foreground font-medium mb-1">Document shows</p>
                      <p className="text-xs">{disc.documentValue || "—"}</p>
                      {disc.documentName && (
                        <p className="text-2xs text-muted-foreground mt-1 flex items-center gap-1">
                          <FileText className="h-2.5 w-2.5" /> {disc.documentName}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* AI explanation */}
                  {disc.aiExplanation && (
                    <div className="text-xs text-muted-foreground bg-muted/20 rounded p-2.5">
                      <span className="font-medium text-foreground">AI analysis:</span> {disc.aiExplanation}
                    </div>
                  )}

                  {/* Resolution actions */}
                  {isOpen && (
                    <div className="space-y-2">
                      <Textarea
                        placeholder="Add context or explanation (optional)..."
                        className="text-xs h-14 resize-none bg-muted/20"
                        value={responses[disc.id] || ""}
                        onChange={(e) => setResponses({ ...responses, [disc.id]: e.target.value })}
                      />
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={() => resolve.mutate({ id: disc.id, action: "interview" })}
                          disabled={resolve.isPending}
                        >
                          Accept interview value
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-7 text-xs gap-1"
                          onClick={() => resolve.mutate({ id: disc.id, action: "document" })}
                          disabled={resolve.isPending}
                        >
                          Accept document value
                        </Button>
                        <div className="flex items-center gap-1">
                          <Input
                            placeholder="Enter corrected value..."
                            className="h-7 text-xs w-44"
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
                      </div>
                    </div>
                  )}

                  {/* Resolved state */}
                  {disc.status === "resolved" && (
                    <div className="flex items-center gap-2 text-xs text-emerald-400">
                      <CheckCircle2 className="h-3.5 w-3.5" />
                      Resolved: {disc.resolvedValue}
                      {disc.sellerResponse && (
                        <span className="text-muted-foreground ml-2">— {disc.sellerResponse}</span>
                      )}
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
