import { useState, useCallback } from "react";
import { AIConversationInterface } from "@/components/AIConversationInterface";
import { Button } from "@/components/ui/button";
import { CheckCircle, ChevronRight, AlertCircle, Clock, ArrowLeft, PanelRight } from "lucide-react";
import { useLocation, useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import type { Deal } from "@shared/schema";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface SectionCoverage {
  key: string;
  title: string;
  status: "well_covered" | "partial" | "missing";
}

interface IndustryContext {
  identified: boolean;
  industry: string;
  activeTopics: string[];
  coveredTopics: string[];
}

interface TurnResult {
  message: string;
  sessionId: string;
  captured: {
    total: number;
    newFields: string[];
    updatedFields: string[];
  };
  sectionCoverage: SectionCoverage[];
  industryContext: IndustryContext;
  deferredTopics: string[];
  shouldEnd: boolean;
  endReason?: string;
}

export default function CIMInterview() {
  const [, setLocation] = useLocation();
  const [, dealParams] = useRoute("/deal/:id/interview");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sectionCoverage, setSectionCoverage] = useState<SectionCoverage[]>([]);
  const [industryContext, setIndustryContext] = useState<IndustryContext>({
    identified: false,
    industry: "",
    activeTopics: [],
    coveredTopics: [],
  });
  const [deferredTopics, setDeferredTopics] = useState<string[]>([]);
  const [capturedTotal, setCapturedTotal] = useState(0);
  const [isCompleting, setIsCompleting] = useState(false);
  const [interviewEnded, setInterviewEnded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(true);
  const { toast } = useToast();

  const dealId = dealParams?.id;

  const { data: deal } = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    enabled: !!dealId,
  });

  const handleTurnResult = useCallback((result: TurnResult) => {
    setSessionId(result.sessionId);
    setSectionCoverage(result.sectionCoverage);
    setIndustryContext(result.industryContext);
    setDeferredTopics(result.deferredTopics);
    setCapturedTotal(result.captured.total);
    if (result.shouldEnd) {
      setInterviewEnded(true);
    }
  }, []);

  const handleComplete = async () => {
    setIsCompleting(true);
    try {
      if (dealId) {
        await queryClient.invalidateQueries({ queryKey: ["/api/deals"] });
        await queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
        setLocation(`/deal/${dealId}`);
      }
    } catch (error: any) {
      console.error("Failed to navigate after interview:", error);
      toast({
        title: "Error",
        description: "Something went wrong. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsCompleting(false);
    }
  };

  const coveredCount = sectionCoverage.filter((s) => s.status === "well_covered").length;
  const partialCount = sectionCoverage.filter((s) => s.status === "partial").length;
  const missingCount = sectionCoverage.filter((s) => s.status === "missing").length;

  return (
    <div className="flex h-screen bg-background overflow-hidden">

      {/* ── Main conversation ── */}
      <div className="flex-1 flex flex-col min-w-0">

        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0 bg-card/50">
          <button
            onClick={() => dealId && setLocation(`/deal/${dealId}`)}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </button>
          <span className="text-muted-foreground/30">·</span>
          <span className="text-sm font-medium truncate">{deal?.businessName ?? "AI Interview"}</span>
          {industryContext.identified && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span className="text-xs text-amber font-medium">{industryContext.industry}</span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            <span className="text-2xs text-muted-foreground tabular-nums hidden sm:block">
              {capturedTotal} fields captured
            </span>
            <button
              onClick={() => setPanelOpen(p => !p)}
              className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors ${
                panelOpen
                  ? "bg-amber/10 text-amber"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              }`}
              title="Toggle coverage panel"
            >
              <PanelRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Chat */}
        <div className="flex-1 overflow-hidden">
          {dealId && (
            <AIConversationInterface
              dealId={dealId}
              businessName={deal?.businessName}
              onTurnResult={handleTurnResult}
              onComplete={handleComplete}
            />
          )}
        </div>

        {/* Bottom status bar */}
        {interviewEnded && (
          <div className="border-t border-border px-4 py-2.5 bg-card shrink-0">
            <div className="max-w-3xl mx-auto flex justify-end">
              <Button
                onClick={handleComplete}
                disabled={isCompleting}
                size="sm"
                className="h-7 text-xs bg-amber text-amber-foreground hover:bg-amber/90"
                data-testid="button-complete"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                {isCompleting ? "Saving..." : "Return to Deal"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Coverage panel ── */}
      {panelOpen && (
        <div className="w-64 border-l border-border overflow-y-auto bg-card shrink-0 scrollbar-thin">

          {/* Section coverage */}
          <div className="p-4 border-b border-border">
            <p className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground mb-3">
              CIM Coverage
            </p>
            {sectionCoverage.length > 0 ? (
              <>
                {/* Coverage bar */}
                <div className="flex gap-0.5 h-1.5 rounded-full overflow-hidden mb-3">
                  <div
                    className="bg-success rounded-full transition-all"
                    style={{ width: `${(coveredCount / sectionCoverage.length) * 100}%` }}
                  />
                  <div
                    className="bg-amber/60 rounded-full transition-all"
                    style={{ width: `${(partialCount / sectionCoverage.length) * 100}%` }}
                  />
                  <div
                    className="bg-muted rounded-full flex-1 transition-all"
                  />
                </div>
                <div className="flex gap-3 mb-3 text-2xs text-muted-foreground">
                  <span><span className="text-success font-medium">{coveredCount}</span> covered</span>
                  <span><span className="text-amber font-medium">{partialCount}</span> partial</span>
                  <span><span className="font-medium">{missingCount}</span> missing</span>
                </div>
                <div className="space-y-0.5">
                  {sectionCoverage.map((section) => (
                    <div key={section.key} className="flex items-center gap-2 px-1 py-1 rounded text-xs">
                      {section.status === "well_covered" ? (
                        <CheckCircle className="h-3 w-3 text-success shrink-0" />
                      ) : section.status === "partial" ? (
                        <Clock className="h-3 w-3 text-amber shrink-0" />
                      ) : (
                        <AlertCircle className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                      )}
                      <span className={
                        section.status === "well_covered"
                          ? "text-foreground"
                          : section.status === "partial"
                            ? "text-muted-foreground"
                            : "text-muted-foreground/40"
                      }>
                        {section.title}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground/60">
                Coverage updates as the interview progresses.
              </p>
            )}
          </div>

          {/* Industry context */}
          {industryContext.identified && (
            <div className="p-4 border-b border-border">
              <p className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                Industry
              </p>
              <p className="text-sm font-medium mb-2 text-amber">{industryContext.industry}</p>
              {industryContext.activeTopics.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-2xs text-muted-foreground uppercase tracking-widest">Active topics</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {industryContext.activeTopics.map((topic) => (
                      <span key={topic} className="text-2xs px-1.5 py-0.5 rounded bg-amber/10 text-amber">
                        {topic.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {industryContext.coveredTopics.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  <p className="text-2xs text-muted-foreground uppercase tracking-widest">Covered</p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {industryContext.coveredTopics.map((topic) => (
                      <span key={topic} className="text-2xs px-1.5 py-0.5 rounded bg-success/10 text-success flex items-center gap-1">
                        <CheckCircle className="h-2.5 w-2.5" />
                        {topic.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Deferred topics */}
          {deferredTopics.length > 0 && (
            <div className="p-4">
              <p className="text-2xs font-semibold uppercase tracking-widest text-muted-foreground mb-2">
                To Revisit
              </p>
              <div className="space-y-1.5">
                {deferredTopics.map((topic, idx) => (
                  <div key={idx} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <ChevronRight className="h-3 w-3 mt-0.5 shrink-0 text-muted-foreground/40" />
                    <span>{topic}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
