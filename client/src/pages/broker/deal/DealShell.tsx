/**
 * DealShell — Tabbed deal layout.
 *
 * Renders the deal header (back button, business name, phase stepper)
 * and a tab bar. Active tab is derived from the URL:
 *   /deal/:id           → redirects to /deal/:id/overview
 *   /deal/:id/overview  → OverviewTab
 *   /deal/:id/buyers    → BuyersTab
 *   etc.
 *
 * Deal data is provided to all tabs via DealContext.
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { DealProvider, useDeal } from "@/contexts/DealContext";
import {
  ArrowLeft,
  CheckCircle2,
  Circle,
} from "lucide-react";
import { PHASES, getPhaseIndex } from "./phases";
import { OverviewTab, type PhaseFocus } from "./OverviewTab";
import { BuyersTab } from "./BuyersTab";
import { QATab } from "./QATab";
import { TeamTab } from "./TeamTab";
import { FinancialsTab } from "./FinancialsTab";
import { InterviewReviewTab } from "./InterviewReviewTab";
import { InformationTab } from "./InformationTab";
import { CimTab } from "./CimTab";
import type { Deal } from "@shared/schema";

/* ═══════════════════════════════════════════
   TAB DEFINITIONS
═══════════════════════════════════════════ */
const TABS = [
  { key: "overview", label: "Overview" },
  { key: "information", label: "Information" },
  { key: "cim", label: "CIM" },
  { key: "buyers", label: "Buyers" },
  { key: "qa", label: "Q&A" },
  { key: "team", label: "Team" },
  { key: "financials", label: "Financials" },
  { key: "interview-review", label: "Interview" },
] as const;

type TabKey = (typeof TABS)[number]["key"];

const TAB_TRIGGER_CLASS =
  "shrink-0 whitespace-nowrap rounded-none border-b-2 border-transparent data-[active=true]:border-teal data-[active=true]:text-teal px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors cursor-pointer";

/* ═══════════════════════════════════════════
   PHASE STEPPER (horizontal — header)
═══════════════════════════════════════════ */
function PhaseStepperHorizontal({
  deal,
  onPhaseClick,
}: {
  deal: Deal;
  onPhaseClick: (key: string) => void;
}) {
  const currentIdx = getPhaseIndex(deal.phase);

  return (
    <div className="flex items-center">
      {PHASES.map((phase, idx) => {
        const isComplete = currentIdx > idx;
        const isActive = deal.phase === phase.key;

        return (
          <div key={phase.key} className="flex items-center">
            {idx > 0 && (
              <div
                className={`h-px w-5 ${idx <= currentIdx ? "bg-teal" : "bg-border"}`}
              />
            )}
            <button
              onClick={() => onPhaseClick(phase.key)}
              className="relative group flex items-center justify-center"
              title={phase.label}
            >
              {isComplete ? (
                <CheckCircle2 className="h-5 w-5 text-success" />
              ) : isActive ? (
                <div className="h-5 w-5 rounded-full border-2 border-teal bg-teal/10 flex items-center justify-center">
                  <div className="h-1.5 w-1.5 rounded-full bg-teal" />
                </div>
              ) : (
                <Circle className="h-5 w-5 text-border" />
              )}
              <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                {phase.short}
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

/* ═══════════════════════════════════════════
   DEAL SHELL INNER (needs DealContext)
═══════════════════════════════════════════ */
function DealShellInner({ activeTab }: { activeTab: TabKey }) {
  const { deal, dealId } = useDeal();
  const [, setLocation] = useLocation();
  // The phase the broker asked to see via the header stepper. OverviewTab
  // owns the accordion, so it expands + scrolls from an effect once it is
  // mounted — a fixed timeout here fired before the tab existed when
  // navigating from another tab, and never expanded the collapsed card.
  const [phaseFocus, setPhaseFocus] = useState<PhaseFocus | null>(null);

  const handlePhaseClick = (key: string) => {
    if (activeTab !== "overview") {
      setLocation(`/deal/${dealId}/overview`);
    }
    setPhaseFocus({ key, nonce: Date.now() });
  };

  const navigateTab = (tab: string) => {
    setLocation(`/deal/${dealId}/${tab}`);
  };

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* ── Deal header ── */}
      <div className="flex items-center gap-2 sm:gap-3 px-4 sm:px-5 py-3 border-b border-border shrink-0 bg-card">
        <button
          onClick={() => setLocation("/broker/deals")}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          data-testid="button-back"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Deals
        </button>
        <div className="h-4 w-px bg-border shrink-0" />
        {/* The name gets the room on phones: the industry chip hides and the
            stepper collapses to "Phase n/4". */}
        <span className="min-w-0 flex-1 sm:flex-initial text-sm font-semibold truncate" title={deal.businessName} data-testid="text-deal-name">
          {deal.businessName}
        </span>
        {deal.industry && (
          <span className="hidden sm:inline-flex shrink-0 text-2xs font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            {deal.industry}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2 sm:gap-4 shrink-0">
          <div className="hidden sm:block">
            <PhaseStepperHorizontal
              deal={deal}
              onPhaseClick={handlePhaseClick}
            />
          </div>
          {getPhaseIndex(deal.phase) >= 0 && (
            <button
              onClick={() => handlePhaseClick(deal.phase)}
              className="sm:hidden whitespace-nowrap text-2xs font-medium px-2 py-0.5 rounded-full border border-teal/40 text-teal"
              title={PHASES[getPhaseIndex(deal.phase)]?.label}
              data-testid="button-phase-compact"
            >
              Phase {getPhaseIndex(deal.phase) + 1}/{PHASES.length}
            </button>
          )}
          {deal.isLive && (
            <span className="inline-flex items-center gap-1 text-2xs font-medium px-2 py-0.5 rounded-full bg-success/10 text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" /> Live
            </span>
          )}
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="flex bg-transparent border-b border-border h-auto p-0 w-full justify-start px-5 shrink-0 overflow-x-auto scrollbar-thin">
        {TABS.map((tab) => (
          <button
            key={tab.key}
            data-active={activeTab === tab.key}
            className={TAB_TRIGGER_CLASS}
            onClick={() => navigateTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ── Tab content ── */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {activeTab === "overview" && <OverviewTab phaseFocus={phaseFocus} />}
        {activeTab === "information" && <InformationTab />}
        {activeTab === "cim" && <CimTab />}
        {activeTab === "buyers" && <BuyersTab />}
        {activeTab === "qa" && <QATab />}
        {activeTab === "team" && <TeamTab />}
        {activeTab === "financials" && <FinancialsTab />}
        {activeTab === "interview-review" && <InterviewReviewTab />}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   ENTRY POINT (parses URL, wraps in provider)
═══════════════════════════════════════════ */
export default function DealShell() {
  const [location, setLocation] = useLocation();

  // Parse /deal/:id/:tab from the URL
  const segments = location.split("/").filter(Boolean);
  // segments: ['deal', 'abc123'] or ['deal', 'abc123', 'overview']
  const dealId = segments[1];
  const rawTab = segments[2];

  // Validate tab — fall back to overview
  const validTabs = new Set<string>(TABS.map((t) => t.key));
  const activeTab: TabKey = validTabs.has(rawTab)
    ? (rawTab as TabKey)
    : "overview";

  // Redirect bare /deal/:id to /deal/:id/overview
  if (dealId && !rawTab) {
    setLocation(`/deal/${dealId}/overview`, { replace: true });
    return null;
  }

  if (!dealId) return null;

  return (
    <DealProvider dealId={dealId}>
      <DealShellInner activeTab={activeTab} />
    </DealProvider>
  );
}
