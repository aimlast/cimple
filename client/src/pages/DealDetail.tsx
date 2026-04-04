import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Deal, Task, Document as DocType } from "@shared/schema";
import {
  ArrowLeft, CheckCircle2, Circle, ChevronRight, MessageSquare, FileText,
  Upload, Users, Send, Trash2, Eye, PanelRightOpen, PanelRightClose,
  Edit3, Plus, AlertCircle, Loader2, ExternalLink, Copy, Zap, Globe,
  Pencil, RefreshCw, X, Check
} from "lucide-react";

/* ══════════════════════════════════════════════
   PHASE CONFIGURATION
══════════════════════════════════════════════ */
const PHASES = [
  {
    key: "phase1_info_collection",
    label: "Info Collection",
    short: "Phase 1",
    items: (deal: Deal) => [
      { label: "NDA signed",                done: !!deal.ndaSigned },
      { label: "Seller questionnaire",      done: !!deal.sqCompleted },
      { label: "Valuation",                 done: !!deal.valuationCompleted },
    ],
  },
  {
    key: "phase2_platform_intake",
    label: "Platform Intake",
    short: "Phase 2",
    items: (deal: Deal) => [
      { label: "Onboarding complete",  done: !!deal.questionnaireData },
      { label: "AI interview",         done: !!deal.interviewCompleted },
    ],
  },
  {
    key: "phase3_content_creation",
    label: "Content Creation",
    short: "Phase 3",
    items: (deal: Deal) => [
      { label: "CIM draft generated",  done: !!deal.cimContent },
      { label: "Broker reviewed",      done: !!deal.contentApprovedByBroker },
      { label: "Seller approved",      done: !!deal.contentApprovedBySeller },
    ],
  },
  {
    key: "phase4_design_finalization",
    label: "Design & Final",
    short: "Phase 4",
    items: (deal: Deal) => [
      { label: "Design generated",     done: !!deal.cimDesignData },
      { label: "Broker approved",      done: !!deal.designApprovedByBroker },
      { label: "Seller approved",      done: !!deal.designApprovedBySeller },
    ],
  },
];

function getPhaseIndex(key: string) {
  return PHASES.findIndex(p => p.key === key);
}

/* ══════════════════════════════════════════════
   DOCUMENT CATEGORIES
══════════════════════════════════════════════ */
const DOC_CATEGORIES = [
  { value: "financials", label: "Financials" },
  { value: "legal",      label: "Legal" },
  { value: "marketing",  label: "Marketing" },
  { value: "operations", label: "Operations" },
  { value: "other",      label: "Other" },
];

const CIM_SECTIONS = [
  { key: "executiveSummary",         title: "Executive Summary" },
  { key: "businessDescription",      title: "Business Description" },
  { key: "marketAnalysis",           title: "Market Analysis" },
  { key: "financialOverview",        title: "Financial Overview" },
  { key: "operations",               title: "Operations" },
  { key: "growthOpportunities",      title: "Growth Opportunities" },
];

/* ══════════════════════════════════════════════
   LEFT RAIL — Phase timeline nav
══════════════════════════════════════════════ */
function PhaseNav({
  deal,
  selectedPhase,
  onSelectPhase,
  onOpenRight,
  docCount,
  taskCount,
  buyerCount,
  faqCount,
}: {
  deal: Deal;
  selectedPhase: string | null;
  onSelectPhase: (key: string) => void;
  onOpenRight: (tab: string) => void;
  docCount: number;
  taskCount: number;
  buyerCount: number;
  faqCount: number;
}) {
  const currentIdx = getPhaseIndex(deal.phase);

  return (
    <div className="flex flex-col h-full overflow-y-auto scrollbar-thin">
      {/* Deal identity */}
      <div className="px-4 py-4 border-b border-border">
        <p className="text-xs font-semibold text-foreground truncate">{deal.businessName}</p>
        <p className="text-2xs text-muted-foreground mt-0.5 truncate">{deal.industry || "No industry set"}</p>
        {deal.isLive && (
          <span className="inline-flex items-center gap-1 mt-2 text-2xs font-medium text-success px-1.5 py-0.5 bg-success-muted rounded">
            <span className="h-1.5 w-1.5 rounded-full bg-success" /> Live
          </span>
        )}
      </div>

      {/* Phase timeline */}
      <div className="px-3 py-3 space-y-0.5 flex-1">
        {PHASES.map((phase, idx) => {
          const isActive   = deal.phase === phase.key;
          const isComplete = currentIdx > idx;
          const isLocked   = currentIdx < idx;
          const isSelected = selectedPhase === phase.key;
          const items = phase.items(deal);

          return (
            <div key={phase.key} className="relative">
              {/* Connector line */}
              {idx < PHASES.length - 1 && (
                <div className="absolute left-[1.125rem] top-8 bottom-0 w-px bg-border" />
              )}

              {/* Phase row */}
              <button
                onClick={() => onSelectPhase(phase.key)}
                className={`w-full flex items-start gap-3 px-2 py-2.5 rounded-md text-left transition-colors
                  ${isSelected || isActive
                    ? "bg-teal/8 text-foreground"
                    : isLocked
                      ? "text-muted-foreground/40 cursor-default"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  }`}
              >
                {/* Icon */}
                <div className="shrink-0 mt-0.5">
                  {isComplete ? (
                    <CheckCircle2 className="h-4.5 w-4.5 text-success" style={{ width: "1.125rem", height: "1.125rem" }} />
                  ) : isActive ? (
                    <div className="h-[1.125rem] w-[1.125rem] rounded-full border-2 border-teal bg-teal/10 flex items-center justify-center">
                      <div className="h-1.5 w-1.5 rounded-full bg-teal" />
                    </div>
                  ) : (
                    <Circle className="text-border" style={{ width: "1.125rem", height: "1.125rem" }} />
                  )}
                </div>

                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-medium leading-tight ${isActive ? "text-teal" : ""}`}>
                    {phase.short}
                    {isActive && <span className="ml-1 text-2xs text-teal/70">← here</span>}
                  </p>
                  <p className="text-2xs text-muted-foreground/70 mt-0.5">{phase.label}</p>

                  {/* Sub-items — show for active + complete phases */}
                  {(isActive || isComplete || isSelected) && (
                    <div className="mt-1.5 space-y-0.5">
                      {items.map(item => (
                        <div key={item.label} className="flex items-center gap-1.5">
                          {item.done ? (
                            <CheckCircle2 className="h-3 w-3 text-success shrink-0" />
                          ) : (
                            <Circle className="h-3 w-3 text-muted-foreground/30 shrink-0" />
                          )}
                          <span className={`text-2xs ${item.done ? "text-muted-foreground" : "text-muted-foreground/50"}`}>
                            {item.label}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </button>
            </div>
          );
        })}

        {/* Live */}
        <button
          onClick={() => onSelectPhase("live")}
          className={`w-full flex items-center gap-3 px-2 py-2.5 rounded-md text-left transition-colors
            ${deal.isLive
              ? "text-success hover:bg-success-muted"
              : "text-muted-foreground/40 cursor-default"
            }`}
        >
          <div className={`h-[1.125rem] w-[1.125rem] rounded-full border-2 flex items-center justify-center ${deal.isLive ? "border-success bg-success/10" : "border-border"}`}>
            {deal.isLive && <div className="h-1.5 w-1.5 rounded-full bg-success" />}
          </div>
          <div>
            <p className="text-xs font-medium">Live</p>
            <p className="text-2xs text-muted-foreground/50">Published to buyers</p>
          </div>
        </button>
      </div>

      {/* Supporting links */}
      <div className="px-3 pb-3 border-t border-border pt-3 space-y-0.5">
        {[
          { label: "Documents", count: docCount,  tab: "documents" },
          { label: "Tasks",     count: taskCount, tab: "tasks" },
          { label: "Buyers",    count: buyerCount, tab: "buyers" },
          { label: "FAQ",       count: faqCount,  tab: "faq" },
        ].map(({ label, count, tab }) => (
          <button
            key={tab}
            onClick={() => onOpenRight(tab)}
            className="w-full flex items-center justify-between px-2 py-1.5 rounded text-xs text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <span>{label}</span>
            {count > 0 && (
              <span className="text-2xs bg-muted text-muted-foreground px-1.5 py-0.5 rounded-full">{count}</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   CENTER — Phase-adaptive content areas
══════════════════════════════════════════════ */

function Phase1Center({ deal, dealId, toast }: { deal: Deal; dealId: string; toast: any }) {
  const [inviteOpen, setInviteOpen] = useState(false);
  const [sellerEmail, setSellerEmail] = useState("");
  const [sellerName, setSellerName] = useState("");
  const [askingPrice, setAskingPrice] = useState(deal.askingPrice || "");

  const update = useMutation({
    mutationFn: async (data: Partial<Deal>) => {
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, data);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Updated" });
    },
  });

  const invite = useMutation({
    mutationFn: async (data: { sellerEmail: string; sellerName: string }) => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/invites`, data);
      return r.json();
    },
    onSuccess: (data) => {
      const url = `${window.location.origin}/invite/${data.token}`;
      navigator.clipboard.writeText(url);
      toast({ title: "Invite link copied", description: "Send it to the seller." });
      setInviteOpen(false);
    },
  });

  const steps = [
    {
      key: "nda",
      label: "NDA",
      desc: "Non-Disclosure Agreement signed by seller",
      done: !!deal.ndaSigned,
      testId: "button-mark-nda-signed",
      action: () => update.mutate({ ndaSigned: true, ndaSignedAt: new Date() }),
      actionLabel: "Mark as Signed",
    },
    {
      key: "sq",
      label: "Seller Questionnaire",
      desc: "Initial business information from seller",
      done: !!deal.sqCompleted,
      testId: "button-mark-questionnaire-complete",
      action: () => setInviteOpen(true),
      actionLabel: "Send to Seller",
      secondaryAction: () => update.mutate({ sqCompleted: true }),
      secondaryLabel: "Mark as Received",
    },
    {
      key: "valuation",
      label: "Valuation",
      desc: "Business valuation and asking price established",
      done: !!deal.valuationCompleted,
      testId: "button-mark-valuation-complete",
      action: () => update.mutate({ valuationCompleted: true, askingPrice: askingPrice || undefined }),
      actionLabel: "Complete Valuation",
      input: (
        <Input
          placeholder="Asking price (e.g. $2,500,000)"
          value={askingPrice}
          onChange={e => setAskingPrice(e.target.value)}
          className="h-8 text-sm"
          data-testid="input-asking-price"
        />
      ),
    },
  ];

  const allDone = steps.every(s => s.done);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-semibold">Phase 1 — Info Collection</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Complete these steps before beginning the AI-powered intake.
        </p>
      </div>

      {steps.map(step => (
        <div key={step.key} className={`rounded-lg border p-4 ${step.done ? "border-success/30 bg-success-muted/40" : "border-border bg-card"}`}>
          <div className="flex items-start gap-3">
            {step.done
              ? <CheckCircle2 className="h-4.5 w-4.5 text-success mt-0.5 shrink-0" style={{ width: "1.125rem", height: "1.125rem" }} />
              : <Circle className="h-4.5 w-4.5 text-muted-foreground/30 mt-0.5 shrink-0" style={{ width: "1.125rem", height: "1.125rem" }} />
            }
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${step.done ? "line-through text-muted-foreground" : ""}`}>{step.label}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{step.desc}</p>
              {!step.done && (
                <div className="mt-2.5 space-y-2">
                  {step.input}
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant={step.secondaryAction ? "outline" : "default"}
                      className={`h-7 text-xs ${!step.secondaryAction ? "bg-teal text-teal-foreground hover:bg-teal/90" : ""}`}
                      onClick={step.action}
                      disabled={update.isPending}
                      data-testid={step.testId}
                    >
                      {step.actionLabel}
                    </Button>
                    {step.secondaryAction && (
                      <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground"
                        onClick={step.secondaryAction} disabled={update.isPending}
                        data-testid={`${step.testId}-secondary`}>
                        {step.secondaryLabel}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      ))}

      {allDone && (
        <div className="rounded-lg border border-teal/30 bg-teal-muted/40 p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-teal">Phase 1 complete</p>
            <p className="text-xs text-muted-foreground mt-0.5">Ready to advance to Platform Intake.</p>
          </div>
          <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90 shrink-0" data-testid="button-advance-phase-2">
            Advance to Phase 2 <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Send Questionnaire to Seller</DialogTitle>
            <DialogDescription>Generate a secure intake link for the seller.</DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Seller name</Label>
              <Input placeholder="Jane Smith" value={sellerName} onChange={e => setSellerName(e.target.value)} className="h-9" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Seller email</Label>
              <Input type="email" placeholder="jane@example.com" value={sellerEmail} onChange={e => setSellerEmail(e.target.value)} className="h-9" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setInviteOpen(false)}>Cancel</Button>
            <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => invite.mutate({ sellerEmail, sellerName })}
              disabled={!sellerName.trim() || !sellerEmail.trim() || invite.isPending}
              data-testid="button-generate-invite"
            >
              {invite.isPending ? "Generating..." : "Copy Invite Link"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Phase2Center({ deal, dealId, toast }: { deal: Deal; dealId: string; toast: any }) {
  const [, setLocation] = useLocation();
  const [websiteInput, setWebsiteInput] = useState(deal.websiteUrl || "");

  const scrapeMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/scrape`, {
        websiteUrl: websiteInput.trim() || undefined,
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Scrape failed");
      }
      return r.json() as Promise<{ fieldsExtracted: string[]; fieldCount: number; websiteUrl: string }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: "Scrape complete",
        description: `${result.fieldCount} fields extracted from ${result.websiteUrl}`,
      });
    },
    onError: (err: Error) => {
      toast({ title: "Scrape failed", description: err.message, variant: "destructive" });
    },
  });

  const isScraped = !!deal.scrapedAt;
  const scrapedDate = deal.scrapedAt ? new Date(deal.scrapedAt).toLocaleDateString() : null;
  const scrapeSource = (deal as any).scrapeSource as "website" | "internet_search" | null;
  const scrapedFieldCount = deal.scrapedData ? Object.keys(deal.scrapedData as object).length : 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Phase 2 — Platform Intake</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          The seller completes onboarding, then the AI conducts the interview.
        </p>
      </div>

      {/* Onboarding */}
      <div className={`rounded-lg border p-4 ${deal.questionnaireData ? "border-success/30 bg-success-muted/40" : "border-border bg-card"}`}>
        <div className="flex items-center gap-3">
          {deal.questionnaireData
            ? <CheckCircle2 className="h-[1.125rem] w-[1.125rem] text-success shrink-0" />
            : <Circle className="h-[1.125rem] w-[1.125rem] text-muted-foreground/30 shrink-0" />}
          <div>
            <p className={`text-sm font-medium ${deal.questionnaireData ? "line-through text-muted-foreground" : ""}`}>Seller onboarding</p>
            <p className="text-xs text-muted-foreground">Systems, key people, business basics</p>
          </div>
        </div>
      </div>

      {/* Public data scrape */}
      <div className={`rounded-lg border p-5 ${isScraped ? "border-success/30 bg-success-muted/40" : "border-border bg-card"}`}>
        <div className="flex items-start gap-3">
          {isScraped
            ? <CheckCircle2 className="h-[1.125rem] w-[1.125rem] text-success mt-0.5 shrink-0" />
            : <Globe className="h-[1.125rem] w-[1.125rem] text-muted-foreground/40 mt-0.5 shrink-0" />}
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">
              {isScraped ? "Public data scraped" : "Public data scrape"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {isScraped
                ? `${scrapedFieldCount} fields found via ${scrapeSource === "internet_search" ? "internet search" : "website"} on ${scrapedDate} — AI will verify with seller during interview`
                : "Pulls publicly available info from the business website or internet before the interview starts."}
            </p>
            {!isScraped && (
              <div className="mt-3 flex gap-2">
                <Input
                  value={websiteInput}
                  onChange={(e) => setWebsiteInput(e.target.value)}
                  placeholder="https://businesswebsite.com (leave blank to search internet)"
                  className="h-8 text-xs flex-1"
                />
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8 text-xs shrink-0 gap-1.5"
                  onClick={() => scrapeMutation.mutate()}
                  disabled={scrapeMutation.isPending}
                  data-testid="button-scrape"
                >
                  {scrapeMutation.isPending ? (
                    <><Loader2 className="h-3 w-3 animate-spin" /> Searching...</>
                  ) : (
                    <><Globe className="h-3 w-3" /> {websiteInput.trim() ? "Scrape" : "Search"}</>
                  )}
                </Button>
              </div>
            )}
            {isScraped && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2 h-7 text-xs text-muted-foreground/60 hover:text-muted-foreground px-0 gap-1.5"
                onClick={() => scrapeMutation.mutate()}
                disabled={scrapeMutation.isPending}
              >
                {scrapeMutation.isPending ? (
                  <><Loader2 className="h-3 w-3 animate-spin" /> Re-scraping...</>
                ) : (
                  "Re-scrape"
                )}
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* AI Interview — primary action */}
      <div className={`rounded-lg border p-5 ${deal.interviewCompleted ? "border-success/30 bg-success-muted/40" : "border-teal/30 bg-teal-muted/40"}`}>
        <div className="flex items-start gap-3">
          {deal.interviewCompleted
            ? <CheckCircle2 className="h-[1.125rem] w-[1.125rem] text-success mt-0.5 shrink-0" />
            : <div className="h-[1.125rem] w-[1.125rem] rounded-full border-2 border-teal bg-teal/10 flex items-center justify-center mt-0.5 shrink-0">
                <div className="h-1.5 w-1.5 rounded-full bg-teal" />
              </div>
          }
          <div className="flex-1">
            <p className={`text-sm font-medium ${deal.interviewCompleted ? "line-through text-muted-foreground" : "text-teal"}`}>
              AI interview
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {deal.interviewCompleted
                ? "Completed — business profile built"
                : "The AI conducts an adaptive interview to build the full business profile."}
            </p>
            {!deal.interviewCompleted && (
              <Button
                size="sm"
                className="mt-3 bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
                onClick={() => setLocation(`/deal/${dealId}/interview`)}
                data-testid="button-start-interview"
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Start AI Interview
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Phase3Center({ deal, dealId, toast }: { deal: Deal; dealId: string; toast: any }) {
  const cimContent = deal.cimContent as Record<string, string> | null;
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [regeneratingKey, setRegeneratingKey] = useState<string | null>(null);

  // Count available data fields as a readiness indicator
  const extractedCount = Object.keys((deal.extractedInfo as object) || {}).length;
  const scrapedCount = Object.keys(((deal as any).scrapedData as object) || {}).length;
  const totalDataFields = extractedCount + scrapedCount;

  // Generate all sections
  const generate = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/generate-content`);
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "CIM content generated", description: "All sections drafted. Review and edit below." });
    },
    onError: (e: Error) => toast({ title: "Generation failed", description: e.message, variant: "destructive" }),
  });

  // Regenerate a single section
  const regenerateSection = async (sectionKey: string) => {
    setRegeneratingKey(sectionKey);
    try {
      const r = await apiRequest("POST", `/api/deals/${dealId}/generate-content`, { sectionKey });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Section regenerated" });
    } catch (e: any) {
      toast({ title: "Regeneration failed", description: e.message, variant: "destructive" });
    } finally {
      setRegeneratingKey(null);
    }
  };

  // Save broker edit to a section
  const saveEdit = useMutation({
    mutationFn: async ({ key, content }: { key: string; content: string }) => {
      const existing = (deal.cimContent as Record<string, string>) || {};
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, {
        cimContent: { ...existing, [key]: content },
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      setEditingKey(null);
      toast({ title: "Section saved" });
    },
    onError: (e: Error) => toast({ title: "Save failed", description: e.message, variant: "destructive" }),
  });

  // Approve all
  const approve = useMutation({
    mutationFn: async (role: "broker" | "seller") => {
      const data = role === "broker" ? { contentApprovedByBroker: true } : { contentApprovedBySeller: true };
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, data);
      return r.json();
    },
    onSuccess: (_, role) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: `${role === "broker" ? "Broker" : "Seller"} approval recorded` });
    },
  });

  // Require interview completion
  if (!deal.interviewCompleted) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">Interview required first</p>
        <p className="text-xs text-muted-foreground/60 mt-1">Complete the AI interview in Phase 2 before generating content.</p>
      </div>
    );
  }

  // Pre-generation state
  if (!cimContent) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-base font-semibold">Phase 3 — Content Creation</h2>
          <p className="text-sm text-muted-foreground mt-0.5">The AI drafts all CIM sections from the collected data.</p>
        </div>

        {/* Data readiness indicator */}
        <div className={`rounded-lg border p-4 ${totalDataFields >= 8 ? "border-success/30 bg-success/5" : "border-teal/30 bg-teal/5"}`}>
          <div className="flex items-start gap-3">
            {totalDataFields >= 8
              ? <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
              : <AlertCircle className="h-4 w-4 text-teal mt-0.5 shrink-0" />}
            <div>
              <p className="text-sm font-medium">
                {totalDataFields} data fields available
                {totalDataFields < 5 && " — limited data"}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {totalDataFields >= 8
                  ? `${extractedCount} from interview, ${scrapedCount} from public scrape. Ready to generate.`
                  : "More interview data will produce better content. You can still generate and edit manually."}
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg border border-teal/30 bg-teal-muted/40 p-5 text-center">
          <Edit3 className="h-6 w-6 text-teal/60 mx-auto mb-3" />
          <p className="text-sm text-muted-foreground mb-4">
            Generates all {CIM_SECTIONS.length} CIM sections. Takes ~60 seconds.
          </p>
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            data-testid="button-generate-content"
          >
            {generate.isPending
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Generating sections...</>
              : "Generate CIM Content"}
          </Button>
        </div>
      </div>
    );
  }

  // Content review state
  const populatedCount = CIM_SECTIONS.filter(s => cimContent[s.key]).length;

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">CIM Content</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {populatedCount}/{CIM_SECTIONS.length} sections drafted · Edit any section inline
          </p>
        </div>
        <div className="flex items-center gap-2">
          {deal.contentApprovedByBroker && deal.contentApprovedBySeller ? (
            <span className="text-xs font-medium text-success flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Both approved
            </span>
          ) : deal.contentApprovedByBroker ? (
            <Button size="sm" variant="outline" className="h-8 text-xs"
              onClick={() => approve.mutate("seller")} disabled={approve.isPending}
              data-testid="button-approve-seller">
              Approve as Seller
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-8 text-xs"
              onClick={() => approve.mutate("broker")} disabled={approve.isPending}
              data-testid="button-approve-broker">
              Approve as Broker
            </Button>
          )}
          <Button variant="ghost" size="sm" className="h-8 text-xs text-muted-foreground gap-1.5"
            onClick={() => generate.mutate()} disabled={generate.isPending}
            data-testid="button-regenerate-content">
            <RefreshCw className={`h-3 w-3 ${generate.isPending ? "animate-spin" : ""}`} />
            Regenerate All
          </Button>
        </div>
      </div>

      {/* Sections */}
      {CIM_SECTIONS.map(section => {
        const content = cimContent[section.key] || "";
        const isEditing = editingKey === section.key;
        const isRegenerating = regeneratingKey === section.key;

        return (
          <div key={section.key} className="rounded-lg border border-border bg-card overflow-hidden">
            {/* Section header */}
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                {section.title}
              </p>
              {!isEditing && (
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => regenerateSection(section.key)}
                    disabled={!!regeneratingKey || generate.isPending}
                    className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors disabled:opacity-30"
                    title="Regenerate this section"
                  >
                    <RefreshCw className={`h-3 w-3 ${isRegenerating ? "animate-spin" : ""}`} />
                  </button>
                  <button
                    onClick={() => { setEditingKey(section.key); setEditDraft(content); }}
                    className="h-6 w-6 flex items-center justify-center rounded text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent transition-colors"
                    title="Edit this section"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                </div>
              )}
            </div>

            {/* Section body */}
            <div className="px-4 py-3">
              {isEditing ? (
                <>
                  <Textarea
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    className="resize-none text-sm min-h-[140px] font-normal"
                    autoFocus
                  />
                  <div className="flex items-center gap-2 mt-2">
                    <Button size="sm" className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1"
                      onClick={() => saveEdit.mutate({ key: section.key, content: editDraft })}
                      disabled={saveEdit.isPending}>
                      {saveEdit.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                      Save
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 text-xs gap-1"
                      onClick={() => setEditingKey(null)}>
                      <X className="h-3 w-3" /> Cancel
                    </Button>
                  </div>
                </>
              ) : isRegenerating ? (
                <div className="flex items-center gap-2 py-4 text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span className="text-sm">Regenerating...</span>
                </div>
              ) : content ? (
                <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{content}</p>
              ) : (
                <p className="text-sm text-muted-foreground/40 italic py-2">Not yet generated.</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Phase4Center({ deal, dealId, toast }: { deal: Deal; dealId: string; toast: any }) {
  const publish = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, { isLive: true });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "CIM published", description: "Now live for invited buyers." });
    },
  });

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Phase 4 — Design & Finalization</h2>
        <p className="text-sm text-muted-foreground mt-0.5">Final design pass and publication.</p>
      </div>
      <div className="grid gap-3">
        {[
          { label: "Design generated",  done: !!deal.cimDesignData    },
          { label: "Broker approved",   done: !!deal.designApprovedByBroker  },
          { label: "Seller approved",   done: !!deal.designApprovedBySeller  },
        ].map(item => (
          <div key={item.label} className={`rounded-lg border p-4 flex items-center gap-3 ${item.done ? "border-success/30 bg-success-muted/40" : "border-border bg-card"}`}>
            {item.done
              ? <CheckCircle2 className="h-[1.125rem] w-[1.125rem] text-success shrink-0" />
              : <Circle className="h-[1.125rem] w-[1.125rem] text-muted-foreground/30 shrink-0" />}
            <span className={`text-sm ${item.done ? "line-through text-muted-foreground" : ""}`}>{item.label}</span>
          </div>
        ))}
      </div>
      {deal.designApprovedByBroker && deal.designApprovedBySeller && !deal.isLive && (
        <div className="rounded-lg border border-teal/30 bg-teal-muted/40 p-4 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium text-teal">Ready to publish</p>
            <p className="text-xs text-muted-foreground mt-0.5">All approvals received.</p>
          </div>
          <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90"
            onClick={() => publish.mutate()} disabled={publish.isPending}>
            Publish CIM
          </Button>
        </div>
      )}
      {deal.isLive && (
        <div className="rounded-lg border border-success/30 bg-success-muted/40 p-4 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div>
            <p className="text-sm font-medium text-success">CIM is live</p>
            <p className="text-xs text-muted-foreground">Shared with invited buyers.</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════
   RIGHT PANEL — Documents, Tasks, Buyers, FAQ
══════════════════════════════════════════════ */
function RightPanel({
  deal, dealId, tab, onTabChange, documents, tasks, faqs, toast
}: {
  deal: Deal; dealId: string; tab: string; onTabChange: (t: string) => void;
  documents: DocType[]; tasks: Task[]; faqs: any[]; toast: any;
}) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [docName, setDocName] = useState("");
  const [docCategory, setDocCategory] = useState("financials");
  const [addBuyerOpen, setAddBuyerOpen] = useState(false);
  const [buyerName, setBuyerName] = useState("");
  const [buyerEmail, setBuyerEmail] = useState("");

  const { data: buyers = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "buyers"],
    enabled: !!dealId,
  });

  const uploadDoc = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/documents`, { name: docName, category: docCategory, status: "pending" });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] });
      setUploadOpen(false); setDocName("");
      toast({ title: "Document added" });
    },
  });

  const deleteDoc = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/documents/${id}`); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] }),
  });

  const addBuyer = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/buyers`, {
        buyerName, buyerEmail,
        expiresAt: new Date(Date.now() + 30 * 86400 * 1000).toISOString(),
      });
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "buyers"] });
      navigator.clipboard.writeText(`${window.location.origin}/view/${data.accessToken}`);
      toast({ title: "Buyer link copied" });
      setAddBuyerOpen(false); setBuyerName(""); setBuyerEmail("");
    },
  });

  const TABS = [
    { id: "documents", label: `Docs${documents.length > 0 ? ` (${documents.length})` : ""}` },
    { id: "tasks",     label: `Tasks${tasks.length > 0 ? ` (${tasks.length})` : ""}` },
    { id: "buyers",    label: `Buyers${buyers.length > 0 ? ` (${buyers.length})` : ""}` },
    { id: "faq",       label: `FAQ${faqs.length > 0 ? ` (${faqs.length})` : ""}` },
  ];

  return (
    <div className="flex flex-col h-full">
      {/* Tab bar */}
      <div className="flex border-b border-border shrink-0">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => onTabChange(t.id)}
            className={`flex-1 text-2xs font-medium py-2.5 border-b-2 transition-colors ${
              tab === t.id
                ? "border-teal text-teal"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto scrollbar-thin p-3">
        {/* Documents */}
        {tab === "documents" && (
          <div className="space-y-2">
            <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1.5 justify-start"
              onClick={() => setUploadOpen(true)}>
              <Upload className="h-3.5 w-3.5" /> Add Document
            </Button>
            {documents.length === 0 ? (
              <p className="text-2xs text-muted-foreground/60 text-center py-4">No documents yet</p>
            ) : (
              documents.map(doc => (
                <div key={doc.id} className="flex items-center gap-2 p-2 rounded-md bg-card border border-border group">
                  <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{doc.name}</p>
                    <p className="text-2xs text-muted-foreground">{doc.category}</p>
                  </div>
                  <button
                    onClick={() => deleteDoc.mutate(doc.id)}
                    className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* Tasks */}
        {tab === "tasks" && (
          <div className="space-y-1.5">
            {tasks.length === 0 ? (
              <p className="text-2xs text-muted-foreground/60 text-center py-4">No tasks</p>
            ) : (
              tasks.map(task => (
                <div key={task.id} className="flex items-start gap-2 p-2 rounded-md bg-card border border-border">
                  <div className={`h-1.5 w-1.5 rounded-full mt-1.5 shrink-0 ${task.status === "completed" ? "bg-success" : task.status === "in_progress" ? "bg-teal" : "bg-muted-foreground/30"}`} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs">{task.description || task.title}</p>
                    <p className="text-2xs text-muted-foreground capitalize">{task.status}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {/* Buyers */}
        {tab === "buyers" && (
          <div className="space-y-2">
            <Button size="sm" variant="outline" className="w-full h-8 text-xs gap-1.5 justify-start"
              onClick={() => setAddBuyerOpen(true)}>
              <Users className="h-3.5 w-3.5" /> Add Buyer
            </Button>
            {buyers.length === 0 ? (
              <p className="text-2xs text-muted-foreground/60 text-center py-4">No buyers yet</p>
            ) : (
              buyers.map((b: any) => (
                <div key={b.id} className="flex items-center gap-2 p-2 rounded-md bg-card border border-border group">
                  <Users className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium truncate">{b.buyerName}</p>
                    <p className="text-2xs text-muted-foreground truncate">{b.buyerEmail}</p>
                  </div>
                  <button
                    onClick={() => { navigator.clipboard.writeText(`${window.location.origin}/view/${b.accessToken}`); toast({ title: "Link copied" }); }}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
        )}

        {/* FAQ */}
        {tab === "faq" && (
          <div className="space-y-1.5">
            {faqs.length === 0 ? (
              <p className="text-2xs text-muted-foreground/60 text-center py-4">No FAQ items</p>
            ) : (
              faqs.map((faq: any) => (
                <div key={faq.id} className="p-2.5 rounded-md bg-card border border-border">
                  <p className="text-xs font-medium">{faq.question}</p>
                  <p className="text-2xs text-muted-foreground mt-1">{faq.answer}</p>
                </div>
              ))
            )}
          </div>
        )}
      </div>

      {/* Dialogs */}
      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Document</DialogTitle></DialogHeader>
          <div className="py-3 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Document name</Label>
              <Input className="h-9" value={docName} onChange={e => setDocName(e.target.value)} placeholder="e.g. 2023 P&L Statement" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Category</Label>
              <Select value={docCategory} onValueChange={setDocCategory}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOC_CATEGORIES.map(c => <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => uploadDoc.mutate()} disabled={!docName.trim() || uploadDoc.isPending}
              data-testid="button-add-document">
              Add
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={addBuyerOpen} onOpenChange={setAddBuyerOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add Buyer</DialogTitle><DialogDescription>Generate a secure 30-day viewing link.</DialogDescription></DialogHeader>
          <div className="py-3 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Name</Label>
              <Input className="h-9" value={buyerName} onChange={e => setBuyerName(e.target.value)} placeholder="John Smith" data-testid="input-buyer-name" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Email</Label>
              <Input type="email" className="h-9" value={buyerEmail} onChange={e => setBuyerEmail(e.target.value)} placeholder="john@example.com" data-testid="input-buyer-email" />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setAddBuyerOpen(false)}>Cancel</Button>
            <Button size="sm" className="bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => addBuyer.mutate()} disabled={!buyerName.trim() || !buyerEmail.trim() || addBuyer.isPending}
              data-testid="button-confirm-add-buyer">
              {addBuyer.isPending ? "Adding..." : "Add & Copy Link"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ══════════════════════════════════════════════
   MAIN COMPONENT
══════════════════════════════════════════════ */
export default function DealDetail() {
  const [, params] = useRoute("/deal/:id");
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const dealId = params?.id;

  const { data: deal, isLoading } = useQuery<Deal>({ queryKey: ["/api/deals", dealId], enabled: !!dealId });
  const { data: tasks = []     } = useQuery<Task[]>({ queryKey: ["/api/deals", dealId, "tasks"],     enabled: !!dealId });
  const { data: documents = [] } = useQuery<DocType[]>({ queryKey: ["/api/deals", dealId, "documents"], enabled: !!dealId });
  const { data: faqs = []      } = useQuery<any[]>({ queryKey: ["/api/deals", dealId, "faq"],       enabled: !!dealId });

  const [selectedPhase, setSelectedPhase] = useState<string | null>(null);
  const [rightOpen, setRightOpen] = useState(false);
  const [rightTab, setRightTab] = useState("documents");

  const openRight = (tab: string) => { setRightTab(tab); setRightOpen(true); };

  if (isLoading || !deal) {
    return (
      <div className="flex h-full items-center justify-center">
        {isLoading
          ? <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          : <div className="text-center">
              <AlertCircle className="h-8 w-8 text-muted-foreground/30 mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">Deal not found</p>
              <Button variant="ghost" size="sm" className="mt-2" onClick={() => setLocation("/")}>Back to Deals</Button>
            </div>
        }
      </div>
    );
  }

  // Determine center content: selected phase overrides current phase
  const viewPhase = selectedPhase ?? deal.phase;

  const centerContent = () => {
    switch (viewPhase) {
      case "phase1_info_collection":   return <Phase1Center deal={deal} dealId={dealId!} toast={toast} />;
      case "phase2_platform_intake":   return <Phase2Center deal={deal} dealId={dealId!} toast={toast} />;
      case "phase3_content_creation":  return <Phase3Center deal={deal} dealId={dealId!} toast={toast} />;
      case "phase4_design_finalization": return <Phase4Center deal={deal} dealId={dealId!} toast={toast} />;
      default: return <Phase1Center deal={deal} dealId={dealId!} toast={toast} />;
    }
  };

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left rail — 200px ── */}
      <div className="w-[200px] shrink-0 border-r border-border bg-card overflow-hidden flex flex-col">
        {/* Back */}
        <button
          onClick={() => setLocation("/")}
          className="flex items-center gap-1.5 px-4 py-3 text-xs text-muted-foreground hover:text-foreground transition-colors border-b border-border"
          data-testid="button-back"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Deals
        </button>
        <PhaseNav
          deal={deal}
          selectedPhase={selectedPhase}
          onSelectPhase={key => setSelectedPhase(key === selectedPhase ? null : key)}
          onOpenRight={openRight}
          docCount={documents.length}
          taskCount={tasks.filter(t => t.status !== "completed").length}
          buyerCount={0}
          faqCount={faqs.length}
        />
      </div>

      {/* ── Center — main work area ── */}
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {/* Mini header */}
        <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-medium truncate">{deal.businessName}</span>
            <span className="text-2xs text-muted-foreground shrink-0">
              {PHASES.find(p => p.key === deal.phase)?.short ?? "—"}
            </span>
          </div>
          <button
            onClick={() => setRightOpen(!rightOpen)}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          >
            {rightOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
            <span className="hidden sm:inline">{rightOpen ? "Hide" : "Show"} Panel</span>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto scrollbar-thin px-5 py-5">
          {centerContent()}
        </div>
      </div>

      {/* ── Right panel — 260px, collapsible ── */}
      {rightOpen && (
        <div className="w-[260px] shrink-0 border-l border-border bg-card overflow-hidden flex flex-col">
          <RightPanel
            deal={deal}
            dealId={dealId!}
            tab={rightTab}
            onTabChange={setRightTab}
            documents={documents}
            tasks={tasks}
            faqs={faqs}
            toast={toast}
          />
        </div>
      )}
    </div>
  );
}
