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
 *  "% collected" + quality │ Shown (coverage board)      │ Shown (coverage board)
 *  Coverage panel toggle   │ Shown (PanelRight button)   │ Hidden
 *
 *  COVERAGE SIDE PANEL
 *  Visibility              │ Shown (togglable, default   │ Never shown. Sellers open
 *                          │ open): the coverage board's │ "What we've covered" —
 *                          │ panel variant.              │ statuses only, no values.
 *
 *  PROGRESS INDICATOR
 *  Broker view             │ The board panel: headline,  │ N/A
 *                          │ sections, items             │
 *  Seller view             │ N/A                         │ "{p}% collected · quality"
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
 *  onComplete?: () => void | Promise<void>
 *  onBack?: () => void
 */

import { useState, useCallback } from "react";
import { AIConversationInterface } from "@/components/AIConversationInterface";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  CheckCircle,
  ChevronRight,
  ArrowLeft,
  ListChecks,
  Loader2,
  PanelRight,
} from "lucide-react";
import { useCoverageBoard, useSellerCoverage, invalidateCoverage, sellerCoverageKey } from "@/hooks/useCoverageBoard";
import { CoverageBoardView } from "@/components/coverage/CoverageBoardView";
import { queryClient } from "@/lib/queryClient";
import { useIsMobile } from "@/hooks/use-mobile";
import type { CoverageSummary } from "@shared/coverage-board";

interface SectionCoverage {
  key: string;
  title: string;
  status: "well_covered" | "partial" | "missing";
  importance?: "critical" | "important" | "helpful";
  importanceReason?: string;
  totalItems?: number;
  openItems?: number;
  openCriticalItems?: number;
  unverifiedItems?: number;
  sellerSourcedItems?: number;
  documentedItems?: number;
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
  /** The coverage board's seller numbers (shared/coverage-board.ts) — the seller's header. */
  coverageSummary?: CoverageSummary;
}

/** How a broker-led ("together") interview is happening. */
export type TogetherVia = "person" | "zoom" | "meet" | "teams" | "cimple";

export const VIA_LABEL: Record<TogetherVia, string> = {
  person: "In person",
  zoom: "Zoom",
  meet: "Google Meet",
  teams: "Microsoft Teams",
  cimple: "Cimple call",
};

interface InterviewProps {
  /** broker = broker alone; seller = seller alone; together = broker with the seller on a call / in person */
  mode: "broker" | "seller" | "together";
  /** together mode: where the conversation happens */
  via?: TogetherVia;
  meetingLink?: string;
  dealId: string;
  businessName?: string;
  /** Seller invite token — authenticates seller-mode interview API calls */
  sellerToken?: string;
  /** May be async — the completion button stays in its "Saving..." state until it settles */
  onComplete?: () => void | Promise<void>;
  onBack?: () => void;
  /** Continue a finished interview right away (the caller's "Add more detail"). */
  resume?: boolean;
  /** Where the finished interview's transcript can be read (broker). */
  transcriptHref?: string;
}

export function Interview({
  mode,
  via,
  meetingLink,
  dealId,
  businessName,
  sellerToken,
  onComplete,
  onBack,
  resume,
  transcriptHref,
}: InterviewProps) {
  const isTogether = mode === "together";
  const [, setSectionCoverage] = useState<SectionCoverage[]>([]);
  const [industryContext, setIndustryContext] = useState<IndustryContext>({
    identified: false,
    industry: "",
    activeTopics: [],
    coveredTopics: [],
  });
  const [deferredTopics, setDeferredTopics] = useState<string[]>([]);
  const [coverageSummary, setCoverageSummary] = useState<CoverageSummary | null>(null);
  const [coveredOpen, setCoveredOpen] = useState(false);
  const isPhone = useIsMobile();
  const [isCompleting, setIsCompleting] = useState(false);
  const [interviewEnded, setInterviewEnded] = useState(false);
  // The coverage panel starts closed on a phone — at 256px it would leave the
  // conversation a sliver (it opens from the header button).
  const [panelOpen, setPanelOpen] = useState(
    () => mode === "broker" && (typeof window === "undefined" || window.matchMedia("(min-width: 768px)").matches),
  );

  const isBroker = mode !== "seller";
  // The coverage board — the same items and numbers as "Interview together",
  // the Overview and the seller's own pages (shared/coverage-board.ts).
  const brokerBoard = useCoverageBoard(dealId, "broker", { enabled: isBroker });
  const sellerBoard = useSellerCoverage(sellerToken, { enabled: !isBroker && !!sellerToken });

  const handleTurnResult = useCallback((result: TurnResult) => {
    setSectionCoverage(result.sectionCoverage);
    setIndustryContext(result.industryContext);
    setDeferredTopics(result.deferredTopics);
    if (result.coverageSummary) setCoverageSummary(result.coverageSummary);
    if (isBroker) invalidateCoverage(dealId);
    else if (sellerToken) queryClient.invalidateQueries({ queryKey: sellerCoverageKey(sellerToken) });
    if (result.shouldEnd) {
      setInterviewEnded(true);
    }
  }, [dealId, isBroker, sellerToken]);

  const handleComplete = useCallback(async () => {
    if (isCompleting) return;
    setIsCompleting(true);
    try {
      await onComplete?.();
    } finally {
      setIsCompleting(false);
    }
  }, [onComplete, isCompleting]);

  // The seller's header: the turn's summary once there is one, else the
  // seller board (the same numbers as their progress page).
  const sellerSummary: CoverageSummary | null =
    coverageSummary ?? (sellerBoard.data ? { percentCollected: sellerBoard.data.percentCollected, totals: sellerBoard.data.totals, quality: { label: sellerBoard.data.quality.label } } : null);
  const board = brokerBoard.data;

  return (
    <div className="flex h-screen bg-background overflow-hidden">
      {/* ── Main conversation ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0 bg-card/50">
          {!isBroker && (
            <div
              role="img"
              aria-label="Cimple"
              className="h-3.5 w-14 shrink-0"
              style={{
                backgroundColor: "hsl(42, 26%, 92%)",
                WebkitMaskImage: "url('/cimple-text.png')",
                WebkitMaskSize: "contain",
                WebkitMaskRepeat: "no-repeat",
                maskImage: "url('/cimple-text.png')",
                maskSize: "contain",
                maskRepeat: "no-repeat",
              }}
            />
          )}
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
          <span className="text-sm font-semibold truncate min-w-0">
            {businessName ?? "Business Overview"}
          </span>
          {industryContext.identified && (
            <>
              <span className="hidden sm:inline text-muted-foreground/30">·</span>
              <span className="hidden sm:inline text-xs text-teal font-medium truncate min-w-0">
                {industryContext.industry}
              </span>
            </>
          )}
          {isTogether && (
            <>
              <span className="text-muted-foreground/30">·</span>
              <span className="text-xs text-muted-foreground inline-flex items-center gap-1" data-testid="label-together-mode">
                Interview together · {VIA_LABEL[via ?? "person"]}
              </span>
            </>
          )}
          <div className="ml-auto flex items-center gap-2 shrink-0">
            {/* Broker: % collected + quality + coverage panel toggle */}
            {isBroker && (
              <>
                {board && (
                  <span className="text-2xs text-muted-foreground tabular-nums hidden sm:block" data-testid="broker-interview-collected">
                    <span className="text-foreground font-medium">{board.percentCollected}% collected</span>
                    <span className="hidden md:inline"> · Quality: <span className="text-teal">{board.quality.label}</span></span>
                  </span>
                )}
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
            {/* Seller: "{p}% collected · {quality}" and "What we've covered" */}
            {!isBroker && sellerSummary && (
              <div className="flex items-center gap-2 min-w-0 shrink-0" data-testid="seller-interview-progress">
                <span className="text-2xs text-muted-foreground tabular-nums">
                  <span className="text-foreground">{sellerSummary.percentCollected}% collected</span>
                  <span className="hidden sm:inline text-muted-foreground/80"> · {sellerSummary.quality.label}</span>
                </span>
              </div>
            )}
            {!isBroker && sellerToken && (
              <button
                type="button"
                onClick={() => setCoveredOpen(true)}
                className="inline-flex items-center gap-1.5 h-7 px-2 rounded-md text-2xs text-muted-foreground hover:text-foreground hover:bg-accent"
                data-testid="button-what-we-covered"
              >
                <ListChecks className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">What we've covered</span>
                <span className="sm:hidden">Covered</span>
              </button>
            )}
          </div>
        </div>

        {/* Chat */}
        <div className="flex-1 overflow-hidden">
          <AIConversationInterface
            dealId={dealId}
            businessName={businessName}
            sellerToken={sellerToken}
            onTurnResult={handleTurnResult}
            onComplete={handleComplete}
            variant={isTogether ? "together" : "chat"}
            // The broker's own page: a session of their own, recorded as
            // the broker's word — never resumed or read by the seller.
            conductedBy={mode === "broker" ? "broker" : undefined}
            via={via}
            meetingLink={meetingLink}
            resume={resume}
            transcriptHref={transcriptHref}
          />
        </div>

        {/* Bottom status bar — shown after interview ends */}
        {interviewEnded && (
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
                {isCompleting ? "Saving..." : isBroker ? "Return to Deal" : "Continue"}
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* ── Coverage panel — broker only: the coverage board ── */}
      {isBroker && panelOpen && (
        <div className="w-72 border-l border-border overflow-y-auto bg-card shrink-0 scrollbar-thin" data-testid="interview-coverage-panel">
          {board ? (
            <CoverageBoardView variant="panel" dealId={dealId} board={board} />
          ) : (
            <div className="p-4 text-xs text-muted-foreground flex items-center gap-1.5">
              {brokerBoard.error ? "Couldn't load the checklist." : <><Loader2 className="h-3 w-3 animate-spin" /> Getting the checklist…</>}
            </div>
          )}

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
      {/* ── The seller's "What we've covered" (statuses only — never a value) ── */}
      {!isBroker && sellerToken && (
        <Sheet open={coveredOpen} onOpenChange={setCoveredOpen}>
          <SheetContent side={isPhone ? "bottom" : "right"} className={isPhone ? "max-h-[85vh] overflow-y-auto rounded-t-xl" : "w-[26rem] sm:max-w-[26rem] overflow-y-auto"}>
            <SheetHeader className="text-left">
              <SheetTitle>What we've covered</SheetTitle>
              <SheetDescription>Your business overview, section by section.</SheetDescription>
            </SheetHeader>
            <div className="mt-4">
              {sellerBoard.data ? (
                <CoverageBoardView variant="seller" board={sellerBoard.data} />
              ) : sellerBoard.error ? (
                <p className="text-sm text-muted-foreground">Couldn't load this right now — it updates as you go.</p>
              ) : (
                <p className="text-sm text-muted-foreground inline-flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…</p>
              )}
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
