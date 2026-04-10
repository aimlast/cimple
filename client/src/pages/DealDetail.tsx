import { useState } from "react";
import { useRoute, useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import type { Deal, Task, Document as DocType } from "@shared/schema";
import { CIM_SECTIONS } from "@shared/schema";
import {
  ArrowLeft, CheckCircle2, Circle, ChevronRight, MessageSquare, FileText,
  Upload, Trash2, AlertCircle, Loader2, Globe,
  Pencil, RefreshCw, X, Check, Wand2, Mail, Phone, Database, Plug,
  Eye, Clock, ThumbsUp, ThumbsDown, Timer, ExternalLink,
} from "lucide-react";
import { FinancialAnalysisCenter } from "@/components/financial/FinancialAnalysisCenter";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { DiscrepancyPanel } from "@/components/deal/DiscrepancyPanel";
import { BuyerQAPanel } from "@/components/deal/BuyerQAPanel";
import { TeamPanel } from "@/components/deal/TeamPanel";
import { DealAnalyticsWidget } from "@/components/deal/DealAnalyticsWidget";
import { ActivityTimeline } from "@/components/deal/ActivityTimeline";
import { BuyerMatchingPanel } from "@/components/deal/BuyerMatchingPanel";
import { BuyerApprovalsPanel } from "@/components/deal/BuyerApprovalsPanel";
import { SuggestedBuyersPanel } from "@/components/deal/SuggestedBuyersPanel";
import type { CimSection, BrandingSettings, Discrepancy } from "@shared/schema";

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
  { value: "financials",  label: "Financials" },
  { value: "legal",       label: "Legal" },
  { value: "marketing",   label: "Marketing" },
  { value: "operations",  label: "Operations" },
  { value: "transcripts", label: "Call Transcripts" },
  { value: "other",       label: "Other" },
];

// CIM_SECTIONS imported from @shared/schema — authoritative 15-section list with correct snake_case keys

/* ══════════════════════════════════════════════
   HEADER — Horizontal phase stepper
══════════════════════════════════════════════ */
function PhaseStepperHorizontal({ deal, onPhaseClick }: { deal: Deal; onPhaseClick: (key: string) => void }) {
  const currentIdx = getPhaseIndex(deal.phase);

  return (
    <div className="flex items-center">
      {PHASES.map((phase, idx) => {
        const isComplete = currentIdx > idx;
        const isActive = deal.phase === phase.key;

        return (
          <div key={phase.key} className="flex items-center">
            {idx > 0 && (
              <div className={`h-px w-5 ${idx <= currentIdx ? "bg-teal" : "bg-border"}`} />
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

/* ══════════════════════════════════════════════
   REUSABLE COMPONENTS
══════════════════════════════════════════════ */

/* ── Document Upload Card ── */
function DocumentUploadCard({ dealId, toast }: { dealId: string; toast: any }) {
  const [uploadOpen, setUploadOpen] = useState(false);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docCategory, setDocCategory] = useState("financials");

  const { data: docs = [] } = useQuery<DocType[]>({
    queryKey: ["/api/deals", dealId, "documents"],
    queryFn: async () => { const r = await fetch(`/api/deals/${dealId}/documents`); return r.ok ? r.json() : []; },
  });

  const uploadDoc = useMutation({
    mutationFn: async () => {
      if (!docFile) throw new Error("No file selected");
      const formData = new FormData();
      formData.append("file", docFile);
      formData.append("category", docCategory);
      const r = await fetch(`/api/deals/${dealId}/documents/upload`, { method: "POST", body: formData });
      if (!r.ok) throw new Error("Upload failed");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] });
      toast({ title: "Document uploaded", description: "Parsing will begin automatically." });
      setDocFile(null);
      setUploadOpen(false);
    },
    onError: (err: Error) => {
      toast({ title: "Upload failed", description: err.message, variant: "destructive" });
    },
  });

  const parsedCount = docs.filter((d: any) => (d.status as string) === "extracted").length;

  return (
    <>
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <Upload className="h-[1.125rem] w-[1.125rem] text-teal mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Upload Documents</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Upload financials, P&L, tax returns, leases, and other key documents.
              The AI will extract structured data automatically.
            </p>
            {docs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {docs.slice(0, 5).map((d: any) => (
                  <span key={d.id} className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium ${
                    (d.status as string) === "extracted" ? "bg-emerald-50 text-emerald-600" :
                    (d.status as string) === "parsing" ? "bg-amber-50 text-amber-600" :
                    "bg-neutral-100 text-neutral-500"
                  }`}>
                    <FileText className="h-2.5 w-2.5" />
                    {d.name?.split(".")[0]?.slice(0, 15) || "doc"}
                  </span>
                ))}
                {docs.length > 5 && <span className="text-2xs text-muted-foreground">+{docs.length - 5} more</span>}
              </div>
            )}
            <div className="mt-3 flex items-center gap-2">
              <Button
                size="sm"
                className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
                onClick={() => setUploadOpen(true)}
              >
                <Upload className="h-3 w-3" /> Upload File
              </Button>
              {docs.length > 0 && (
                <span className="text-2xs text-muted-foreground">
                  {docs.length} uploaded{parsedCount > 0 && ` · ${parsedCount} parsed`}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <Dialog open={uploadOpen} onOpenChange={setUploadOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Upload Document</DialogTitle>
            <DialogDescription>
              Supported: PDF, Excel (.xlsx/.xls), Word (.docx), PowerPoint (.pptx), text files
            </DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">File</Label>
              <Input
                type="file"
                accept=".pdf,.xlsx,.xls,.docx,.doc,.pptx,.ppt,.txt,.csv,.md"
                onChange={(e) => setDocFile(e.target.files?.[0] || null)}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Category</Label>
              <Select value={docCategory} onValueChange={setDocCategory}>
                <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOC_CATEGORIES.map(c => (
                    <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setUploadOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => uploadDoc.mutate()}
              disabled={!docFile || uploadDoc.isPending}
            >
              {uploadDoc.isPending ? "Uploading..." : "Upload & Parse"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ── Integration Prompt Card ── */
function IntegrationPromptCard({ context }: { context: "phase1" | "phase2" }) {
  const [dismissed, setDismissed] = useState(() =>
    localStorage.getItem(`cimple_integration_prompt_${context}`) === "dismissed"
  );
  const [, setLocation] = useLocation();

  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(`cimple_integration_prompt_${context}`, "dismissed");
    setDismissed(true);
  };

  const integrations = [
    { icon: Mail, label: "Email", desc: "Read seller communications" },
    { icon: Database, label: "CRM", desc: "Import deal notes & contacts" },
    { icon: Phone, label: "Calls", desc: "Transcripts from seller calls" },
  ];

  return (
    <div className="rounded-lg border border-dashed border-teal/30 bg-teal-muted/20 p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-teal" />
          <p className="text-sm font-medium text-teal">Connect your data sources</p>
        </div>
        <button onClick={dismiss} className="text-muted-foreground/40 hover:text-muted-foreground p-1">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        The more context the AI has before the interview, the less the seller needs to repeat.
        Connect email, CRM, or call recordings so the AI starts smarter.
      </p>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {integrations.map(({ icon: Icon, label, desc }) => (
          <div key={label} className="rounded-md border border-border bg-card p-2.5 text-center">
            <Icon className="h-4 w-4 text-muted-foreground mx-auto mb-1" />
            <p className="text-2xs font-medium">{label}</p>
            <p className="text-[10px] text-muted-foreground">{desc}</p>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1 border-teal/30 text-teal hover:bg-teal/10"
          onClick={() => setLocation("/integrations")}
        >
          <Plug className="h-3 w-3" /> Set up integrations
        </Button>
        <button onClick={dismiss} className="text-2xs text-muted-foreground/50 hover:text-muted-foreground">
          Skip for now
        </button>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   PHASE CENTER COMPONENTS
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
        <h2 className="text-lg font-semibold tracking-tight">Phase 1 — Info Collection</h2>
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

      {/* Document upload — always visible */}
      <DocumentUploadCard dealId={dealId} toast={toast} />

      {/* Integration prompt */}
      <IntegrationPromptCard context="phase1" />

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
  const scrapeSource = (deal as any).scrapeSource as "website" | "internet_search" | "website_and_internet" | null;
  const scrapedFieldCount = deal.scrapedData ? Object.keys(deal.scrapedData as object).length : 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Phase 2 — Platform Intake</h2>
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
                ? `${scrapedFieldCount} fields found via ${scrapeSource === "website_and_internet" ? "website + internet search" : scrapeSource === "internet_search" ? "internet search" : "website"} on ${scrapedDate} — AI will verify with seller during interview`
                : "Pulls publicly available info from the business website or internet before the interview starts."}
            </p>
            {!isScraped && (
              <div className="mt-3 flex gap-2">
                <Input
                  value={websiteInput}
                  onChange={(e) => setWebsiteInput(e.target.value)}
                  placeholder="https://businesswebsite.com (optional — we also search the internet)"
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

      {/* Document upload */}
      <DocumentUploadCard dealId={dealId} toast={toast} />

      {/* Integration prompt */}
      <IntegrationPromptCard context="phase2" />

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
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  // Fetch visual CIM sections
  const { data: cimSections = [] } = useQuery<CimSection[]>({
    queryKey: ["/api/deals", dealId, "cim-sections"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/cim-sections`);
      if (!r.ok) return [];
      return r.json();
    },
  });

  // Fetch branding for renderer
  const { data: brandingSettings } = useQuery<BrandingSettings | null>({
    queryKey: ["/api/branding"],
    queryFn: async () => {
      const r = await fetch("/api/branding");
      if (!r.ok) return null;
      const arr = await r.json();
      return Array.isArray(arr) ? arr[0] || null : arr;
    },
  });

  const branding = buildBranding(brandingSettings, deal);
  const hasVisualSections = cimSections.length > 0;

  // Fetch discrepancies for verification gate
  const { data: discrepancyList = [] } = useQuery<Discrepancy[]>({
    queryKey: ["/api/deals", dealId, "discrepancies"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/discrepancies`);
      if (!r.ok) return [];
      return r.json();
    },
  });
  const criticalUnresolved = discrepancyList.filter(d => d.severity === "critical" && d.status === "open");
  const hasDiscrepancies = discrepancyList.length > 0;

  // Count available data fields as a readiness indicator
  const extractedCount = Object.keys((deal.extractedInfo as object) || {}).length;
  const scrapedCount = Object.keys(((deal as any).scrapedData as object) || {}).length;
  const totalDataFields = extractedCount + scrapedCount;

  // Generate all sections (now uses layout engine)
  const generate = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/generate-content`);
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] });
      toast({ title: "CIM generated", description: "Visual sections created. Review and edit below." });
    },
    onError: (e: Error) => toast({ title: "Generation failed", description: e.message, variant: "destructive" }),
  });

  // Save broker edit to a visual section
  const saveEdit = useMutation({
    mutationFn: async ({ sectionId, content }: { sectionId: string; content: string }) => {
      const r = await apiRequest("PATCH", `/api/cim-sections/${sectionId}`, {
        brokerEditedContent: content,
      });
      if (!r.ok) { const e = await r.json(); throw new Error(e.error); }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] });
      setEditingSection(null);
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
  if (!cimContent && !hasVisualSections) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Phase 3 — Content Creation</h2>
          <p className="text-sm text-muted-foreground mt-0.5">The AI designs a complete visual CIM from your collected data.</p>
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

        {/* Discrepancy verification */}
        <DiscrepancyPanel dealId={dealId} />

        {/* Generate CIM button */}
        <div className="rounded-lg border border-teal/30 bg-teal-muted/40 p-5 text-center">
          <Wand2 className="h-6 w-6 text-teal/60 mx-auto mb-3" />
          <p className="text-sm font-medium mb-1">AI-Designed CIM</p>
          <p className="text-xs text-muted-foreground mb-4 max-w-md mx-auto">
            The AI will analyze your data and design a bespoke CIM with charts, infographics, financial tables, and dynamic layouts — not just text.
          </p>
          {criticalUnresolved.length > 0 && (
            <p className="text-xs text-red-400 mb-3">
              Resolve {criticalUnresolved.length} critical discrepanc{criticalUnresolved.length === 1 ? "y" : "ies"} above before generating.
            </p>
          )}
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90"
            onClick={() => generate.mutate()}
            disabled={generate.isPending || criticalUnresolved.length > 0}
            data-testid="button-generate-content"
          >
            {generate.isPending
              ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" />Designing CIM...</>
              : "Generate CIM"}
          </Button>
        </div>
      </div>
    );
  }

  // ── Content review state — visual sections ──
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">CIM Preview</h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {cimSections.length} sections · Click any section to edit
          </p>
        </div>
        <div className="flex items-center gap-2">
          {deal.contentApprovedByBroker && deal.contentApprovedBySeller ? (
            <span className="text-xs font-medium text-success flex items-center gap-1">
              <CheckCircle2 className="h-3.5 w-3.5" /> Both approved
            </span>
          ) : deal.contentApprovedByBroker ? (
            <Button size="sm" variant="outline" className="h-8 text-xs"
              onClick={() => approve.mutate("seller")} disabled={approve.isPending}>
              Approve as Seller
            </Button>
          ) : (
            <Button size="sm" variant="outline" className="h-8 text-xs"
              onClick={() => approve.mutate("broker")} disabled={approve.isPending}>
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

      {/* Visual sections */}
      {hasVisualSections ? (
        <div className="space-y-6 rounded-lg border border-border bg-card/50 p-6">
          {cimSections.map((section) => {
            const isEditing = editingSection === String(section.id);
            return (
              <div key={section.id} className="group relative">
                {/* Edit overlay on hover */}
                {!isEditing && (
                  <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex gap-1">
                    <button
                      onClick={() => {
                        setEditingSection(String(section.id));
                        setEditDraft(section.brokerEditedContent || section.aiDraftContent || "");
                      }}
                      className="h-7 px-2 rounded bg-background/90 border border-border text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 backdrop-blur-sm"
                    >
                      <Pencil className="h-3 w-3" /> Edit text
                    </button>
                  </div>
                )}

                {isEditing ? (
                  <div className="rounded-lg border-2 border-teal/40 bg-card p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                        {section.sectionTitle}
                      </p>
                      <span className="text-2xs text-muted-foreground bg-muted px-2 py-0.5 rounded">
                        {section.layoutType}
                      </span>
                    </div>
                    <Textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      className="resize-none text-sm min-h-[140px] font-normal"
                      autoFocus
                    />
                    <div className="flex items-center gap-2">
                      <Button size="sm" className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1"
                        onClick={() => saveEdit.mutate({ sectionId: String(section.id), content: editDraft })}
                        disabled={saveEdit.isPending}>
                        {saveEdit.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                        Save
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 text-xs gap-1"
                        onClick={() => setEditingSection(null)}>
                        <X className="h-3 w-3" /> Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <CimSectionRenderer section={section} branding={branding} brokerMode />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        /* Legacy text fallback when cimContent exists but no visual sections */
        <div className="space-y-3">
          {CIM_SECTIONS.map(section => {
            const content = cimContent?.[section.key] || "";
            return (
              <div key={section.key} className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">{section.title}</p>
                </div>
                <div className="px-4 py-3">
                  {content ? (
                    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{content}</p>
                  ) : (
                    <p className="text-sm text-muted-foreground/40 italic py-2">Not yet generated.</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Phase4Center({ deal, dealId, toast }: { deal: Deal; dealId: string; toast: any }) {
  const [, navigate] = useLocation();
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
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">Phase 4 — Design & Finalization</h2>
          <p className="text-sm text-muted-foreground mt-0.5">Final design pass and publication.</p>
        </div>
        <Button
          size="sm"
          className="shrink-0 bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
          onClick={() => navigate(`/deal/${dealId}/design`)}
        >
          <Wand2 className="h-3.5 w-3.5" />
          Open CIM Designer
        </Button>
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
   MAIN COMPONENT — Tabbed layout
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
  const { data: buyerAccessList = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "buyers"],
    queryFn: async () => { const r = await fetch(`/api/deals/${dealId}/buyers`); return r.ok ? r.json() : []; },
    enabled: !!dealId,
  });
  const { data: buyerScores = [] } = useQuery<any[]>({
    queryKey: ["/api/deals", dealId, "analytics/buyer-scores"],
    queryFn: async () => { const r = await fetch(`/api/deals/${dealId}/analytics/buyer-scores`); return r.ok ? r.json() : []; },
    enabled: !!dealId,
  });

  const [activeTab, setActiveTab] = useState("workflow");
  const [viewPhase, setViewPhase] = useState<string | null>(null);

  const deleteDoc = useMutation({
    mutationFn: async (id: string) => { await apiRequest("DELETE", `/api/documents/${id}`); },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId, "documents"] }),
  });

  const handlePhaseClick = (key: string) => {
    setViewPhase(key);
    setActiveTab("workflow");
  };

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

  const currentPhase = viewPhase ?? deal.phase;

  const workflowContent = () => {
    switch (currentPhase) {
      case "phase1_info_collection":    return <Phase1Center deal={deal} dealId={dealId!} toast={toast} />;
      case "phase2_platform_intake":    return <Phase2Center deal={deal} dealId={dealId!} toast={toast} />;
      case "phase3_content_creation":   return <Phase3Center deal={deal} dealId={dealId!} toast={toast} />;
      case "phase4_design_finalization": return <Phase4Center deal={deal} dealId={dealId!} toast={toast} />;
      default:                          return <Phase1Center deal={deal} dealId={dealId!} toast={toast} />;
    }
  };

  const tabTriggerClass = "rounded-none border-b-2 border-transparent data-[state=active]:border-teal data-[state=active]:text-teal data-[state=active]:shadow-none data-[state=active]:bg-transparent px-4 py-2.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors";

  return (
    <div className="flex flex-col h-full overflow-hidden">

      {/* ── Deal header ── */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border shrink-0 bg-card">
        <button
          onClick={() => setLocation("/")}
          className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors shrink-0"
          data-testid="button-back"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> Deals
        </button>
        <div className="h-4 w-px bg-border shrink-0" />
        <span className="text-sm font-semibold truncate">{deal.businessName}</span>
        {deal.industry && (
          <span className="shrink-0 text-2xs font-medium px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
            {deal.industry}
          </span>
        )}
        <div className="ml-auto flex items-center gap-4 shrink-0">
          <PhaseStepperHorizontal deal={deal} onPhaseClick={handlePhaseClick} />
          {deal.isLive && (
            <span className="inline-flex items-center gap-1 text-2xs font-medium px-2 py-0.5 rounded-full bg-success/10 text-success">
              <span className="h-1.5 w-1.5 rounded-full bg-success" /> Live
            </span>
          )}
        </div>
      </div>

      {/* ── Tab layout ── */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="flex-1 flex flex-col min-h-0">
        <TabsList className="flex bg-transparent border-b border-border rounded-none h-auto p-0 w-full justify-start px-5 shrink-0">
          <TabsTrigger value="workflow" className={tabTriggerClass}>Workflow</TabsTrigger>
          <TabsTrigger value="buyers" className={tabTriggerClass}>Buyers</TabsTrigger>
          <TabsTrigger value="financials" className={tabTriggerClass}>Financials</TabsTrigger>
          <TabsTrigger value="documents" className={tabTriggerClass}>
            Documents{documents.length > 0 ? ` (${documents.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="analytics" className={tabTriggerClass}>Analytics</TabsTrigger>
          <TabsTrigger value="team" className={tabTriggerClass}>Team</TabsTrigger>
        </TabsList>

        <div className="flex-1 overflow-y-auto scrollbar-thin">

          {/* ── Workflow ── */}
          <TabsContent value="workflow" className="mt-0 outline-none">
            <div className="max-w-4xl mx-auto px-6 py-6">
              {workflowContent()}
            </div>
          </TabsContent>

          {/* ── Buyers ── */}
          <TabsContent value="buyers" className="mt-0 outline-none">
            <div className="max-w-4xl mx-auto px-6 py-6 space-y-8">

              {/* Active Buyers — status + engagement */}
              <section>
                <div className="mb-3">
                  <h2 className="text-base font-semibold">Active Buyers</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">Buyers with CIM access — their decision status and engagement.</p>
                </div>
                {(() => {
                  const activeBuyers = buyerAccessList.filter((b: any) => !b.revokedAt);
                  if (activeBuyers.length === 0) {
                    return (
                      <div className="rounded-lg border border-dashed border-border p-6 text-center">
                        <Eye className="h-5 w-5 mx-auto text-muted-foreground/40 mb-2" />
                        <p className="text-sm text-muted-foreground">No buyers have access yet.</p>
                        <p className="text-xs text-muted-foreground/60 mt-1">Approve a buyer below to grant CIM access.</p>
                      </div>
                    );
                  }

                  // Build a lookup map from buyer-scores for engagement data
                  const scoreMap = new Map(buyerScores.map((s: any) => [s.buyerId, s]));

                  return (
                    <div className="rounded-lg border border-border overflow-hidden">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-border bg-muted/30">
                            <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Buyer</th>
                            <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
                            <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Engagement</th>
                            <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">NDA</th>
                            <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Activity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {activeBuyers.map((buyer: any) => {
                            const decision = buyer.decision || "under_review";
                            const statusConfig: Record<string, { label: string; icon: any; className: string }> = {
                              under_review:    { label: "Under Review",    icon: Clock,      className: "text-amber-600 bg-amber-50" },
                              interested:      { label: "Interested",      icon: ThumbsUp,   className: "text-emerald-600 bg-emerald-50" },
                              not_interested:  { label: "Not Interested",  icon: ThumbsDown, className: "text-red-500 bg-red-50" },
                              lapsed:          { label: "Lapsed",          icon: Timer,      className: "text-muted-foreground bg-muted" },
                            };
                            const status = statusConfig[decision] || statusConfig.under_review;
                            const StatusIcon = status.icon;

                            // Engagement data from buyer-scores endpoint
                            const score = scoreMap.get(buyer.id);
                            const engagementScore = score?.engagementScore ?? 0;
                            const intent = score?.intent ?? "minimal";
                            const intentConfig: Record<string, { label: string; className: string }> = {
                              high:    { label: "High",    className: "text-emerald-600" },
                              medium:  { label: "Medium",  className: "text-amber-600" },
                              low:     { label: "Low",     className: "text-muted-foreground" },
                              minimal: { label: "Minimal", className: "text-muted-foreground/50" },
                            };
                            const intentCfg = intentConfig[intent] || intentConfig.minimal;

                            const views = score?.viewCount ?? buyer.viewCount ?? 0;
                            const totalMin = Math.round((score?.totalTimeSeconds ?? buyer.totalTimeSeconds ?? 0) / 60);
                            const timeLabel = totalMin < 1 ? "<1m" : `${totalMin}m`;
                            const lastActive = buyer.lastAccessedAt
                              ? new Date(buyer.lastAccessedAt).toLocaleDateString("en-US", { month: "short", day: "numeric" })
                              : "—";

                            return (
                              <tr key={buyer.id} className="border-b border-border last:border-0 hover:bg-muted/20 transition-colors">
                                <td className="px-4 py-3">
                                  <div>
                                    <p className="font-medium text-foreground">{buyer.buyerName || buyer.buyerEmail}</p>
                                    {buyer.buyerCompany && (
                                      <p className="text-xs text-muted-foreground mt-0.5">{buyer.buyerCompany}</p>
                                    )}
                                    {buyer.buyerName && (
                                      <p className="text-xs text-muted-foreground/60">{buyer.buyerEmail}</p>
                                    )}
                                  </div>
                                </td>
                                <td className="px-4 py-3">
                                  <span className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium ${status.className}`}>
                                    <StatusIcon className="h-3 w-3" />
                                    {status.label}
                                  </span>
                                  {decision === "interested" && buyer.decisionNextStep && (
                                    <p className="text-xs text-muted-foreground mt-1">
                                      Next: {buyer.decisionNextStep.replace(/_/g, " ")}
                                    </p>
                                  )}
                                </td>
                                <td className="px-4 py-3">
                                  <div className="flex items-center gap-2">
                                    <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                                      <div
                                        className="h-full rounded-full bg-teal transition-all"
                                        style={{ width: `${Math.min(engagementScore, 100)}%` }}
                                      />
                                    </div>
                                    <span className="text-xs tabular-nums text-muted-foreground">{engagementScore}</span>
                                  </div>
                                  <p className={`text-xs mt-0.5 ${intentCfg.className}`}>{intentCfg.label} intent</p>
                                </td>
                                <td className="px-4 py-3">
                                  {buyer.ndaSigned
                                    ? <span className="text-xs text-emerald-600 font-medium">Signed</span>
                                    : <span className="text-xs text-muted-foreground">Pending</span>
                                  }
                                </td>
                                <td className="px-4 py-3">
                                  <p className="text-xs text-muted-foreground">{views} views · {timeLabel}</p>
                                  <p className="text-xs text-muted-foreground/60">{lastActive}</p>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  );
                })()}
              </section>

              {/* Pending Approvals */}
              <section className="pt-4 border-t border-border">
                <div className="mb-3">
                  <h2 className="text-base font-semibold">Pending Approvals</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">Buyers awaiting broker and seller sign-off before CIM access.</p>
                </div>
                <BuyerApprovalsPanel dealId={dealId!} />
              </section>

              {/* Outreach & Matching */}
              <section className="pt-4 border-t border-border">
                <div className="mb-3">
                  <h2 className="text-base font-semibold">Outreach & Matching</h2>
                  <p className="text-sm text-muted-foreground mt-0.5">Find buyers by criteria match, then draft and send outreach emails.</p>
                </div>
                <div className="space-y-6">
                  <SuggestedBuyersPanel dealId={dealId!} />
                  <BuyerMatchingPanel dealId={dealId!} />
                </div>
              </section>
            </div>
          </TabsContent>

          {/* ── Financials ── */}
          <TabsContent value="financials" className="mt-0 outline-none">
            <div className="px-6 py-6">
              <FinancialAnalysisCenter dealId={dealId!} />
            </div>
          </TabsContent>

          {/* ── Documents ── */}
          <TabsContent value="documents" className="mt-0 outline-none">
            <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
              <DocumentUploadCard dealId={dealId!} toast={toast} />

              {documents.length > 0 && (
                <div className="rounded-lg border border-border overflow-hidden">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-border bg-muted/30">
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Name</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Category</th>
                        <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Status</th>
                        <th className="w-10" />
                      </tr>
                    </thead>
                    <tbody>
                      {documents.map(doc => (
                        <tr key={doc.id} className="border-b border-border last:border-0 group hover:bg-muted/20">
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                              <span className="truncate">{doc.name}</span>
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-muted-foreground capitalize">{doc.category}</td>
                          <td className="px-4 py-2.5">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium ${
                              (doc.status as string) === "extracted" ? "bg-emerald-50 text-emerald-600" :
                              (doc.status as string) === "parsing" ? "bg-amber-50 text-amber-600" :
                              "bg-neutral-100 text-neutral-500"
                            }`}>
                              {doc.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5">
                            <button
                              onClick={() => deleteDoc.mutate(doc.id)}
                              className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </TabsContent>

          {/* ── Analytics ── */}
          <TabsContent value="analytics" className="mt-0 outline-none">
            <div className="px-6 py-6">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <DealAnalyticsWidget dealId={dealId!} />
                <ActivityTimeline dealId={dealId!} />
              </div>
            </div>
          </TabsContent>

          {/* ── Team ── */}
          <TabsContent value="team" className="mt-0 outline-none">
            <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
              <TeamPanel dealId={dealId!} />

              <div className="pt-2 border-t border-border">
                <BuyerQAPanel dealId={dealId!} />
              </div>

              {faqs.length > 0 && (
                <div className="pt-2 border-t border-border space-y-2">
                  <h3 className="text-sm font-semibold">FAQ</h3>
                  {faqs.map((faq: any) => (
                    <div key={faq.id} className="p-3 rounded-lg bg-card border border-border">
                      <p className="text-sm font-medium">{faq.question}</p>
                      <p className="text-xs text-muted-foreground mt-1">{faq.answer}</p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </TabsContent>

        </div>
      </Tabs>
    </div>
  );
}
