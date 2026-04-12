/**
 * Interview — Shared AI interview component used by both broker and seller.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │                     MODE CONTRACT                                   │
 * │                                                                     │
 * │  This component renders identically in both modes. All behavioral   │
 * │  differences are listed below. If a behavior is not listed, it is   │
 * │  the same in both modes.                                            │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * ═══════════════════════════════════════════════════════════════════════
 *  DIMENSION              │ mode="broker"              │ mode="seller"
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  TOP BAR / HEADER
 *  Back button label       │ "← Back" — onBack callback │ "← Back" — onBack callback
 *  Business name           │ Shown                       │ Shown
 *  "Fields captured" count │ Shown                       │ Hidden
 *  Coverage panel toggle   │ Shown (PanelRight button)   │ Hidden
 *
 *  COVERAGE SIDE PANEL
 *  Visibility              │ Shown (togglable, default   │ Never shown. Sellers see
 *                          │ open).                      │ a simplified progress
 *                          │                             │ indicator in the top bar.
 *
 *  PROGRESS INDICATOR
 *  Broker view             │ Coverage panel shows per-   │ N/A
 *                          │ section status              │
 *  Seller view             │ N/A                         │ Dot-based progress + %
 *                          │                             │ in the top bar
 *
 *  END / EXIT
 *  "Return to Deal" button │ Shown after interview ends  │ Not shown — onComplete
 *                          │                             │ auto-advances
 *
 * ═══════════════════════════════════════════════════════════════════════
 *
 *  PROPS
 *  ─────
 *  mode: "broker" | "seller"
 *  dealId: string
 *  businessName?: string
 *  onComplete?: () => void
 *  onBack?: () => void
 */

import { useState, useCallback } from "react";
import { AIConversationInterface } from "@/components/AIConversationInterface";
import { Button } from "@/components/ui/button";
import {
  CheckCircle,
  ChevronRight,
  AlertCircle,
  Clock,
  ArrowLeft,
  PanelRight,
} from "lucide-react";

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

interface InterviewProps {
  mode: "broker" | "seller";
  dealId: string;
  businessName?: string;
  onComplete?: () => void;
  onBack?: () => void;
}

export function Interview({
  mode,
  dealId,
  businessName,
  onComplete,
  onBack,
}: InterviewProps) {
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
  const [panelOpen, setPanelOpen] = useState(mode === "broker");

  const isBroker = mode === "broker";

  const handleTurnResult = useCallback((result: TurnResult) => {
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
      onComplete?.();
    } finally {
      setIsCompleting(false);
    }
  };

  // Derived coverage counts
  const coveredCount = sectionCoverage.filter(
    (s) => s.status === "well_covered",
  ).length;
  const partialCount = sectionCoverage.filter(
    (s) => s.status === "partial",
  ).length;
  const missingCount = sectionCoverage.filter(
    (s) => s.status === "missing",
  ).length;
  const progressPercent =
    sectionCoverage.length > 0
      ? Math.round((coveredCount / sectionCoverage.length) * 100)
      : 0;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* ── Main conversation ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0 bg-card/50">
          {onBack && (
            <>
              <button
                onClick={onBack}
                className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                Back
              </button>
              <span className="text-muted-foreground/30">·</span>
            </>
          )}
          <span className="text-sm font-semibold truncate">
            {businessName ?? "AI Interview"}
          </span>
          {industryContext.identified && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span className="text-xs text-teal font-medium">
                {industryContext.industry}
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2">
            {/* Broker: fields captured + coverage panel toggle */}
            {isBroker && (
              <>
                <span className="text-2xs text-muted-foreground tabular-nums hidden sm:block">
                  {capturedTotal} fields captured
                </span>
                <button
                  onClick={() => setPanelOpen((p) => !p)}
                  className={`h-7 w-7 flex items-center justify-center rounded-md transition-colors ${
                    panelOpen
                      ? "bg-teal/10 text-teal"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
                  title="Toggle coverage panel"
                >
                  <PanelRight className="h-3.5 w-3.5" />
                </button>
              </>
            )}
            {/* Seller: simple progress dots + percentage */}
            {!isBroker && sectionCoverage.length > 0 && (
              <div className="flex items-center gap-2">
                <div className="flex gap-0.5">
                  {sectionCoverage.map((s) => (
                    <div
                      key={s.key}
                      className={`h-1.5 w-3 rounded-full transition-colors ${
                        s.status === "well_covered"
                          ? "bg-success"
                          : s.status === "partial"
                            ? "bg-teal/60"
                            : "bg-muted"
                      }`}
                    />
                  ))}
                </div>
                <span className="text-2xs text-muted-foreground tabular-nums">
                  {progressPercent}%
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Chat */}
        <div className="flex-1 overflow-hidden">
          <AIConversationInterface
            dealId={dealId}
            businessName={businessName}
            onTurnResult={handleTurnResult}
            onComplete={handleComplete}
          />
        </div>

        {/* Bottom status bar — broker only: "Return to Deal" */}
        {interviewEnded && isBroker && (
          <div className="border-t border-border px-4 py-2.5 bg-card shrink-0">
            <div className="max-w-3xl mx-auto flex justify-end">
              <Button
                onClick={handleComplete}
                disabled={isCompleting}
                size="sm"
                className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90"
                data-testid="button-complete"
              >
                <CheckCircle className="h-3.5 w-3.5 mr-1.5" />
                {isCompleting ? "Saving..." : "Return to Deal"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Coverage panel — broker only ── */}
      {isBroker && panelOpen && (
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
                    style={{
                      width: `${(coveredCount / sectionCoverage.length) * 100}%`,
                    }}
                  />
                  <div
                    className="bg-teal/60 rounded-full transition-all"
                    style={{
                      width: `${(partialCount / sectionCoverage.length) * 100}%`,
                    }}
                  />
                  <div className="bg-muted rounded-full flex-1 transition-all" />
                </div>
                <div className="flex gap-3 mb-3 text-2xs text-muted-foreground">
                  <span>
                    <span className="text-success font-medium">
                      {coveredCount}
                    </span>{" "}
                    covered
                  </span>
                  <span>
                    <span className="text-teal font-medium">
                      {partialCount}
                    </span>{" "}
                    partial
                  </span>
                  <span>
                    <span className="font-medium">{missingCount}</span> missing
                  </span>
                </div>
                <div className="space-y-0.5">
                  {sectionCoverage.map((section) => (
                    <div
                      key={section.key}
                      className="flex items-center gap-2 px-1 py-1 rounded text-xs"
                    >
                      {section.status === "well_covered" ? (
                        <CheckCircle className="h-3 w-3 text-success shrink-0" />
                      ) : section.status === "partial" ? (
                        <Clock className="h-3 w-3 text-teal shrink-0" />
                      ) : (
                        <AlertCircle className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                      )}
                      <span
                        className={
                          section.status === "well_covered"
                            ? "text-foreground"
                            : section.status === "partial"
                              ? "text-muted-foreground"
                              : "text-muted-foreground/40"
                        }
                      >
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
              <p className="text-sm font-medium mb-2 text-teal">
                {industryContext.industry}
              </p>
              {industryContext.activeTopics.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-2xs text-muted-foreground uppercase tracking-widest">
                    Active topics
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {industryContext.activeTopics.map((topic) => (
                      <span
                        key={topic}
                        className="text-2xs px-1.5 py-0.5 rounded bg-teal/10 text-teal"
                      >
                        {topic.replace(/_/g, " ")}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              {industryContext.coveredTopics.length > 0 && (
                <div className="mt-2 space-y-1.5">
                  <p className="text-2xs text-muted-foreground uppercase tracking-widest">
                    Covered
                  </p>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {industryContext.coveredTopics.map((topic) => (
                      <span
                        key={topic}
                        className="text-2xs px-1.5 py-0.5 rounded bg-success/10 text-success flex items-center gap-1"
                      >
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
                  <div
                    key={idx}
                    className="flex items-start gap-1.5 text-xs text-muted-foreground"
                  >
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
