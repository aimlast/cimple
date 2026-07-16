/**
 * OverviewTab — Phase workflow, documents, scrape, discrepancies.
 *
 * Contains the 4-phase accordion with inline phase center components,
 * document upload/table, website scrape card, integration prompts,
 * and deal analytics summary.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PanelError } from "@/components/deal/PanelError";
import { useDeal } from "@/contexts/DealContext";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  CheckCircle2,
  Circle,
  ChevronRight,
  ChevronDown,
  MessageSquare,
  FileText,
  Upload,
  Trash2,
  AlertCircle,
  Loader2,
  Globe,
  Pencil,
  RefreshCw,
  X,
  Check,
  Wand2,
  Mail,
  Phone,
  Database,
  Plug,
  Copy,
  ExternalLink,
  Send,
  Eye,
  Undo2,
} from "lucide-react";
import { PHASES, getPhaseIndex, DOC_CATEGORIES } from "./phases";
import { FinancialAnalysisCenter } from "@/components/financial/FinancialAnalysisCenter";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { DiscrepancyPanel } from "@/components/deal/DiscrepancyPanel";
import { DealAnalyticsWidget } from "@/components/deal/DealAnalyticsWidget";
import type {
  Deal,
  SellerInvite,
  Document as DocType,
  CimSection,
  BrandingSettings,
  Discrepancy,
} from "@shared/schema";
import { CIM_SECTIONS } from "@shared/schema";

/* ═══════════════════════════════════════════
   SHARED HELPERS
═══════════════════════════════════════════ */
/** "Who does this" badge shown next to each checklist item. */
function ActorBadge({ who }: { who: "broker" | "seller" | "auto" }) {
  const map = {
    broker: { label: "You", cls: "bg-teal/10 text-teal" },
    seller: { label: "Waiting on seller", cls: "bg-amber-500/10 text-amber-600" },
    auto: { label: "Automatic", cls: "bg-muted text-muted-foreground" },
  } as const;
  const m = map[who];
  return (
    <span
      className={`text-2xs font-medium px-1.5 py-0.5 rounded ${m.cls} shrink-0`}
    >
      {m.label}
    </span>
  );
}

/** The deal's seller invites — one secure link per seller for the whole flow. */
function useInvites(dealId: string) {
  return useQuery<SellerInvite[]>({
    queryKey: ["/api/deals", dealId, "invites"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/invites`);
      if (!r.ok) return [];
      return r.json();
    },
  });
}

/* ═══════════════════════════════════════════
   DOCUMENT UPLOAD CARD
═══════════════════════════════════════════ */
function DocumentUploadCard({
  openSignal,
}: {
  openSignal?: { category: string; tab: "file" | "paste"; nonce: number } | null;
}) {
  const { dealId } = useDeal();
  const { toast } = useToast();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docCategory, setDocCategory] = useState("financials");
  const [uploadTab, setUploadTab] = useState<"file" | "paste">("file");
  const [pasteText, setPasteText] = useState("");
  const [pasteTitle, setPasteTitle] = useState("");

  // Other cards (e.g. the Calls tile) can pop this dialog open pre-configured.
  useEffect(() => {
    if (!openSignal) return;
    setDocCategory(openSignal.category);
    setUploadTab(openSignal.tab);
    setUploadOpen(true);
  }, [openSignal]);

  const { data: docs = [], error: docsError, refetch: refetchDocs } = useQuery<DocType[]>({
    queryKey: ["/api/deals", dealId, "documents"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/documents`);
      if (!r.ok) throw new Error("Failed to load documents");
      return r.json();
    },
  });

  const uploadDoc = useMutation({
    mutationFn: async () => {
      // Pasted text becomes a plain .txt upload — same pipeline, zero server changes.
      const file =
        uploadTab === "paste"
          ? new File(
              [pasteText],
              `${(pasteTitle.trim() || "call-transcript").replace(/[^a-zA-Z0-9-_ ]/g, "")}.txt`,
              { type: "text/plain" },
            )
          : docFile;
      if (!file || (uploadTab === "paste" && !pasteText.trim()))
        throw new Error(uploadTab === "paste" ? "Nothing pasted" : "No file selected");
      const formData = new FormData();
      formData.append("file", file);
      formData.append("category", docCategory);
      const r = await fetch(`/api/deals/${dealId}/documents/upload`, {
        method: "POST",
        body: formData,
      });
      if (!r.ok) throw new Error("Upload failed");
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/deals", dealId, "documents"],
      });
      toast({
        title: "Document uploaded",
        description: "Parsing will begin automatically.",
      });
      setDocFile(null);
      setPasteText("");
      setPasteTitle("");
      setUploadOpen(false);
    },
    onError: (err: Error) => {
      toast({
        title: "Upload failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const parsedCount = docs.filter(
    (d: any) => (d.status as string) === "extracted",
  ).length;

  return (
    <>
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <Upload className="h-[1.125rem] w-[1.125rem] text-teal mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Upload Documents</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Upload financials, P&L, tax returns, leases, and other key
              documents. The AI will extract structured data automatically.
            </p>
            {docs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {docs.slice(0, 5).map((d: any) => (
                  <span
                    key={d.id}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium ${
                      (d.status as string) === "extracted"
                        ? "bg-emerald-50 text-emerald-600"
                        : (d.status as string) === "parsing"
                          ? "bg-amber-50 text-amber-600"
                          : "bg-neutral-100 text-neutral-500"
                    }`}
                  >
                    <FileText className="h-2.5 w-2.5" />
                    {d.name?.split(".")[0]?.slice(0, 15) || "doc"}
                  </span>
                ))}
                {docs.length > 5 && (
                  <span className="text-2xs text-muted-foreground">
                    +{docs.length - 5} more
                  </span>
                )}
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
                  {docs.length} uploaded
                  {parsedCount > 0 && ` · ${parsedCount} parsed`}
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
              Supported: PDF, Excel (.xlsx/.xls), Word (.docx), PowerPoint
              (.pptx), text files
            </DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <div className="flex gap-1 rounded-md bg-muted p-0.5 w-fit">
              {(["file", "paste"] as const).map((t) => (
                <button
                  key={t}
                  onClick={() => setUploadTab(t)}
                  className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                    uploadTab === t
                      ? "bg-card shadow-sm"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {t === "file" ? "Upload file" : "Paste text"}
                </button>
              ))}
            </div>
            {uploadTab === "file" ? (
              <div className="space-y-1.5">
                <Label className="text-xs">File</Label>
                <Input
                  type="file"
                  accept=".pdf,.xlsx,.xls,.docx,.doc,.pptx,.ppt,.txt,.csv,.md"
                  onChange={(e) => setDocFile(e.target.files?.[0] || null)}
                  className="h-9"
                />
              </div>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label className="text-xs">Title (optional)</Label>
                  <Input
                    placeholder="e.g. Seller call — July 15"
                    value={pasteTitle}
                    onChange={(e) => setPasteTitle(e.target.value)}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Text</Label>
                  <Textarea
                    placeholder="Paste a call transcript, meeting notes, or any text — the AI extracts the key facts into the deal profile."
                    value={pasteText}
                    onChange={(e) => setPasteText(e.target.value)}
                    className="min-h-[10rem] text-sm"
                  />
                </div>
              </>
            )}
            <div className="space-y-1.5">
              <Label className="text-xs">Category</Label>
              <Select value={docCategory} onValueChange={setDocCategory}>
                <SelectTrigger className="h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {DOC_CATEGORIES.map((c) => (
                    <SelectItem key={c.value} value={c.value}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setUploadOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => uploadDoc.mutate()}
              disabled={
                (uploadTab === "file" ? !docFile : !pasteText.trim()) ||
                uploadDoc.isPending
              }
            >
              {uploadDoc.isPending ? "Uploading..." : "Upload & Parse"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ═══════════════════════════════════════════
   INTEGRATION PROMPT CARD
═══════════════════════════════════════════ */
function IntegrationPromptCard({
  onOpenTranscripts,
}: {
  onOpenTranscripts: () => void;
}) {
  // Single shared card. It used to be mounted once per phase with per-phase
  // dismissal keys — treat any legacy key as dismissed.
  const [dismissed, setDismissed] = useState(() =>
    ["shared", "phase1", "phase2"].some(
      (k) =>
        localStorage.getItem(`cimple_integration_prompt_${k}`) === "dismissed",
    ),
  );
  const [, setLocation] = useLocation();

  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem("cimple_integration_prompt_shared", "dismissed");
    setDismissed(true);
  };

  const tiles: {
    icon: typeof Mail;
    label: string;
    desc: string;
    badge: string;
    badgeCls: string;
    onClick?: () => void;
  }[] = [
    {
      icon: Phone,
      label: "Calls",
      desc: "Upload or paste call transcripts",
      badge: "Works now",
      badgeCls: "bg-success/10 text-success",
      onClick: onOpenTranscripts,
    },
    {
      icon: Database,
      label: "CRM",
      desc: "Connect Pipedrive for buyer prefill",
      badge: "Available",
      badgeCls: "bg-teal/10 text-teal",
      onClick: () => setLocation("/broker/integrations"),
    },
    {
      icon: Mail,
      label: "Email",
      desc: "Read seller communications",
      badge: "Coming soon",
      badgeCls: "bg-muted text-muted-foreground",
    },
  ];

  return (
    <div className="rounded-lg border border-dashed border-teal/30 bg-teal-muted/20 p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-2">
          <Plug className="h-4 w-4 text-teal" />
          <p className="text-sm font-medium text-teal">
            Connect your data sources
          </p>
        </div>
        <button
          onClick={dismiss}
          className="text-muted-foreground/40 hover:text-muted-foreground p-1"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        The more context the AI has before the interview, the less the seller
        needs to repeat. Add call transcripts or connect your CRM so the AI
        starts smarter.
      </p>
      <div className="grid grid-cols-3 gap-2 mb-3">
        {tiles.map(({ icon: Icon, label, desc, badge, badgeCls, onClick }) =>
          onClick ? (
            <button
              key={label}
              onClick={onClick}
              className="rounded-md border border-border bg-card p-2.5 text-center hover:border-teal/40 hover:bg-teal/5 transition-colors cursor-pointer"
            >
              <Icon className="h-4 w-4 text-muted-foreground mx-auto mb-1" />
              <p className="text-2xs font-medium">{label}</p>
              <p className="text-[10px] text-muted-foreground">{desc}</p>
              <span
                className={`inline-block mt-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded ${badgeCls}`}
              >
                {badge}
              </span>
            </button>
          ) : (
            <div
              key={label}
              className="rounded-md border border-border bg-card/50 p-2.5 text-center opacity-70"
            >
              <Icon className="h-4 w-4 text-muted-foreground mx-auto mb-1" />
              <p className="text-2xs font-medium">{label}</p>
              <p className="text-[10px] text-muted-foreground">{desc}</p>
              <span
                className={`inline-block mt-1.5 text-[10px] font-medium px-1.5 py-0.5 rounded ${badgeCls}`}
              >
                {badge}
              </span>
            </div>
          ),
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1 border-teal/30 text-teal hover:bg-teal/10"
          onClick={() => setLocation("/broker/integrations")}
        >
          <Plug className="h-3 w-3" /> Set up integrations
        </Button>
        <button
          onClick={dismiss}
          className="text-2xs text-muted-foreground/50 hover:text-muted-foreground"
        >
          Skip for now
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════
   PHASE 1 CENTER — Broker Prep
═══════════════════════════════════════════ */
function Phase1Center() {
  const { deal, dealId } = useDeal();
  const { toast } = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [sellerEmail, setSellerEmail] = useState("");
  const [sellerName, setSellerName] = useState("");
  const [inviteResult, setInviteResult] = useState<{
    url: string;
    emailSent: boolean;
    email: string;
  } | null>(null);
  const [askingPrice, setAskingPrice] = useState(deal.askingPrice || "");
  const [ndaOpen, setNdaOpen] = useState(false);
  const [ndaEmail, setNdaEmail] = useState("");
  const [ndaText, setNdaText] = useState("");

  const { data: invites = [] } = useInvites(dealId);
  const activeInvite = invites[0];
  const inviteUrl = activeInvite
    ? `${window.location.origin}/seller/${activeInvite.token}`
    : null;

  const defaultNdaText = `CONFIDENTIALITY AGREEMENT

This agreement is between the broker engaged to market ${deal.businessName} and the undersigned seller representative, in connection with the preparation of a Confidential Information Memorandum ("CIM").

The undersigned agrees that:

1. All information exchanged during this engagement — including financial statements, customer and supplier details, employee information, and business operations — is confidential.
2. Confidential information will be used solely for preparing and reviewing the sale materials for the business.
3. Confidential information will not be shared with any third party without prior written consent, except professional advisors bound by equivalent confidentiality obligations.
4. These obligations survive the end of the engagement.

Signed electronically via the Cimple platform.`;

  const copyInviteLink = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      toast({ title: "Invite link copied" });
    } catch {
      toast({ title: "Copy failed — link:", description: inviteUrl });
    }
  };

  const update = useMutation({
    mutationFn: async (data: Partial<Deal>) => {
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, data);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Updated" });
    },
    onError: (err: Error) => {
      toast({
        title: "Update failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const invite = useMutation({
    mutationFn: async (data: { sellerEmail: string; sellerName: string }) => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/invites`, data);
      return r.json();
    },
    onSuccess: (data) => {
      const url =
        data.inviteUrl || `${window.location.origin}/seller/${data.token}`;
      queryClient.invalidateQueries({
        queryKey: ["/api/deals", dealId, "invites"],
      });
      // Keep the dialog open in a success state — the link must never be
      // lost to a missed toast or a failed clipboard write.
      setInviteResult({
        url,
        emailSent: !!data.emailSent,
        email: data.sellerEmail || sellerEmail,
      });
      navigator.clipboard.writeText(url).catch(() => {});
    },
    onError: (err: Error) => {
      toast({
        title: "Invite failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const sendNda = useMutation({
    mutationFn: async (data: { sellerEmail: string; ndaText: string }) => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/nda/send`, data);
      return r.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      queryClient.invalidateQueries({
        queryKey: ["/api/deals", dealId, "invites"],
      });
      setNdaOpen(false);
      toast({
        title: data.emailSent
          ? "NDA sent for signature"
          : "NDA ready — email not sent",
        description: data.emailSent
          ? "The seller will get an email with a signing link."
          : `Send this link to the seller: ${data.url}`,
      });
      if (!data.emailSent && data.url)
        navigator.clipboard.writeText(data.url).catch(() => {});
    },
    onError: (err: Error) => {
      toast({
        title: "Could not send NDA",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const inviteStatus = !activeInvite
    ? null
    : deal.questionnaireData
      ? "Seller active — onboarding complete"
      : activeInvite.acceptedAt
        ? "Link opened — seller in progress"
        : activeInvite.sentAt
          ? `Invite emailed${activeInvite.sellerEmail ? ` to ${activeInvite.sellerEmail}` : ""} — waiting on seller`
          : "Link created — not emailed yet";

  type Step = {
    key: string;
    label: string;
    desc: string;
    who: "broker" | "seller" | "auto";
    done: boolean;
    optional?: boolean;
    testId: string;
    action?: () => void;
    actionLabel?: string;
    secondaryAction?: () => void;
    secondaryLabel?: string;
    input?: React.ReactNode;
    /** Rendered when the step is done (status, links, undo…). */
    doneExtra?: React.ReactNode;
    undo?: () => void;
  };

  const sellerLinkButtons = activeInvite && (
    <div className="flex flex-wrap items-center gap-2 mt-2">
      {!deal.questionnaireData && (
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs gap-1.5 border-teal/30 text-teal hover:bg-teal/10"
          disabled={invite.isPending}
          onClick={() => {
            // Re-send (or first-send) the email for the existing invite —
            // the server reuses the same token.
            if (activeInvite.sellerEmail) {
              setInviteResult(null);
              setInviteOpen(true);
              invite.mutate({
                sellerEmail: activeInvite.sellerEmail,
                sellerName: activeInvite.sellerName || "",
              });
            } else {
              setInviteResult(null);
              setInviteOpen(true);
            }
          }}
          data-testid="button-email-invite"
        >
          <Send className="h-3 w-3" />
          {invite.isPending
            ? "Sending..."
            : activeInvite.sentAt
              ? "Re-send email"
              : "Email invite to seller"}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        className="h-7 text-xs gap-1.5"
        onClick={copyInviteLink}
        data-testid="button-copy-invite-link"
      >
        <Copy className="h-3 w-3" /> Copy invite link
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="h-7 text-xs gap-1.5 text-muted-foreground"
        onClick={() => window.open(inviteUrl!, "_blank")}
        data-testid="button-open-seller-view"
      >
        <ExternalLink className="h-3 w-3" /> Preview seller view
      </Button>
    </div>
  );

  const steps: Step[] = [
    {
      key: "invite",
      label: "Invite Seller",
      desc: activeInvite
        ? inviteStatus!
        : "One secure link covers the seller's questionnaire, document uploads, and the AI interview.",
      who: "broker",
      done: !!activeInvite,
      testId: "button-invite-seller",
      action: () => {
        setInviteResult(null);
        setInviteOpen(true);
      },
      actionLabel: "Invite Seller",
      doneExtra: (
        <div className="mt-1">
          {sellerLinkButtons}
        </div>
      ),
    },
    {
      key: "nda",
      label: "NDA",
      desc: deal.ndaSigned
        ? `Signed${deal.ndaSignerName ? ` by ${deal.ndaSignerName}` : ""}${deal.ndaSignedAt ? ` on ${new Date(deal.ndaSignedAt).toLocaleDateString()}` : ""}`
        : "Send it for e-signature through Cimple, or handle it your usual way and mark it signed.",
      who: "broker",
      done: !!deal.ndaSigned,
      testId: "button-send-nda",
      action: () => {
        setNdaEmail(activeInvite?.sellerEmail || "");
        setNdaText(deal.ndaText || defaultNdaText);
        setNdaOpen(true);
      },
      actionLabel: "Send for E-Signature",
      secondaryAction: () => update.mutate({ ndaSigned: true }),
      secondaryLabel: "Mark as Signed",
      undo: () => update.mutate({ ndaSigned: false } as Partial<Deal>),
    },
    {
      key: "sq",
      label: "Seller Questionnaire",
      desc: deal.questionnaireData
        ? "Completed by the seller"
        : "The seller fills this in from their invite link — it completes automatically.",
      who: "seller",
      done: !!deal.questionnaireData || !!deal.sqCompleted,
      testId: "button-mark-questionnaire-complete",
      secondaryAction: () => update.mutate({ sqCompleted: true }),
      secondaryLabel: "Mark as Received (collected outside Cimple)",
      // Only manually-set completion can be undone — real seller data can't.
      undo:
        deal.sqCompleted && !deal.questionnaireData
          ? () => update.mutate({ sqCompleted: false })
          : undefined,
    },
    {
      key: "valuation",
      label: "Valuation",
      desc: "Optional here — finish it any time before generating the CIM.",
      who: "broker",
      optional: true,
      done: !!deal.valuationCompleted,
      testId: "button-mark-valuation-complete",
      action: () =>
        update.mutate({
          valuationCompleted: true,
          askingPrice: askingPrice || undefined,
        }),
      actionLabel: "Complete Valuation",
      input: (
        <Input
          placeholder="Asking price (e.g. $2,500,000)"
          value={askingPrice}
          onChange={(e) => setAskingPrice(e.target.value)}
          className="h-8 text-sm"
          data-testid="input-asking-price"
        />
      ),
      undo: () => update.mutate({ valuationCompleted: false }),
    },
  ];

  const requiredDone = steps.filter((s) => !s.optional).every((s) => s.done);
  const valuationOpen = !deal.valuationCompleted;

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Phase 1 — Broker Prep
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Your prep work. Invite the seller when ready — one secure link covers
          their questionnaire, documents, and the AI interview.
        </p>
      </div>

      {steps.map((step) => (
        <div
          key={step.key}
          className={`rounded-lg border p-4 ${step.done ? "border-success/30 bg-success-muted/40" : "border-border bg-card"}`}
        >
          <div className="flex items-start gap-3">
            {step.done ? (
              <CheckCircle2
                className="text-success mt-0.5 shrink-0"
                style={{ width: "1.125rem", height: "1.125rem" }}
              />
            ) : (
              <Circle
                className="text-muted-foreground/30 mt-0.5 shrink-0"
                style={{ width: "1.125rem", height: "1.125rem" }}
              />
            )}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p
                  className={`text-sm font-medium ${step.done ? "line-through text-muted-foreground" : ""}`}
                >
                  {step.label}
                </p>
                <ActorBadge who={step.who} />
                {step.optional && !step.done && (
                  <span className="text-2xs text-muted-foreground/60">
                    optional
                  </span>
                )}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {step.desc}
              </p>
              {!step.done && (
                <div className="mt-2.5 space-y-2">
                  {step.input}
                  <div className="flex items-center gap-2 flex-wrap">
                    {step.action && (
                      <Button
                        size="sm"
                        className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90"
                        onClick={step.action}
                        disabled={update.isPending}
                        data-testid={step.testId}
                      >
                        {step.actionLabel}
                      </Button>
                    )}
                    {step.secondaryAction && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs text-muted-foreground"
                        onClick={step.secondaryAction}
                        disabled={update.isPending}
                        data-testid={`${step.testId}-secondary`}
                      >
                        {step.secondaryLabel}
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {step.done && (
                <div className="mt-1">
                  {step.doneExtra}
                  {step.undo && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 mt-1 px-1.5 text-2xs text-muted-foreground/60 hover:text-muted-foreground gap-1"
                      onClick={step.undo}
                      disabled={update.isPending}
                      data-testid={`${step.testId}-undo`}
                    >
                      <Undo2 className="h-3 w-3" /> Undo
                    </Button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      ))}

      {requiredDone && (
        <div className="rounded-lg border border-teal/30 bg-teal-muted/40 p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-teal">
              Ready for Seller Intake
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {valuationOpen
                ? "Valuation is still open — you can finish it any time before the CIM."
                : "Ready to advance to Seller Intake."}
            </p>
          </div>
          <Button
            size="sm"
            className="bg-teal text-teal-foreground hover:bg-teal/90 shrink-0"
            data-testid="button-advance-phase-2"
            disabled={update.isPending}
            onClick={() =>
              update.mutate({ phase: "phase2_platform_intake" } as Partial<Deal>)
            }
          >
            Advance to Phase 2 <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
      )}

      <Dialog open={inviteOpen} onOpenChange={setInviteOpen}>
        <DialogContent>
          {inviteResult ? (
            <>
              <DialogHeader>
                <DialogTitle>Seller invited</DialogTitle>
                <DialogDescription>
                  {inviteResult.emailSent
                    ? `An invite email is on its way to ${inviteResult.email}.`
                    : "The email could not be sent — share the link below with the seller directly."}
                </DialogDescription>
              </DialogHeader>
              <div className="py-3 space-y-2">
                <Label className="text-xs">Seller's secure link</Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={inviteResult.url}
                    className="h-9 text-xs font-mono"
                    onFocus={(e) => e.target.select()}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-9 shrink-0 gap-1.5"
                    onClick={() => {
                      navigator.clipboard
                        .writeText(inviteResult.url)
                        .then(() => toast({ title: "Link copied" }))
                        .catch(() => {});
                    }}
                  >
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </Button>
                </div>
                <p className="text-2xs text-muted-foreground">
                  This one link covers the seller's questionnaire, document
                  uploads, and the AI interview.
                </p>
              </div>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  className="bg-teal text-teal-foreground hover:bg-teal/90"
                  onClick={() => setInviteOpen(false)}
                >
                  Done
                </Button>
              </div>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Invite Seller</DialogTitle>
                <DialogDescription>
                  Emails the seller a secure link for their questionnaire,
                  documents, and the AI interview.
                </DialogDescription>
              </DialogHeader>
              <div className="py-3 space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Seller name</Label>
                  <Input
                    placeholder="Jane Smith"
                    value={sellerName}
                    onChange={(e) => setSellerName(e.target.value)}
                    className="h-9"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Seller email</Label>
                  <Input
                    type="email"
                    placeholder="jane@example.com"
                    value={sellerEmail}
                    onChange={(e) => setSellerEmail(e.target.value)}
                    className="h-9"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setInviteOpen(false)}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
                  onClick={() => invite.mutate({ sellerEmail, sellerName })}
                  disabled={
                    !sellerName.trim() || !sellerEmail.trim() || invite.isPending
                  }
                  data-testid="button-generate-invite"
                >
                  <Send className="h-3.5 w-3.5" />
                  {invite.isPending ? "Sending..." : "Send Invite"}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={ndaOpen} onOpenChange={setNdaOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Send NDA for E-Signature</DialogTitle>
            <DialogDescription>
              The seller gets an email with a signing page — their typed name,
              date, and IP are recorded. Edit the template below or paste your
              brokerage's own NDA text.
            </DialogDescription>
          </DialogHeader>
          <div className="py-3 space-y-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Seller email</Label>
              <Input
                type="email"
                placeholder="jane@example.com"
                value={ndaEmail}
                onChange={(e) => setNdaEmail(e.target.value)}
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Agreement text</Label>
              <Textarea
                value={ndaText}
                onChange={(e) => setNdaText(e.target.value)}
                className="min-h-[14rem] text-xs font-mono"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setNdaOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
              onClick={() =>
                sendNda.mutate({ sellerEmail: ndaEmail, ndaText })
              }
              disabled={
                !ndaEmail.trim() || !ndaText.trim() || sendNda.isPending
              }
              data-testid="button-send-nda-confirm"
            >
              <Send className="h-3.5 w-3.5" />
              {sendNda.isPending ? "Sending..." : "Send for Signature"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ═══════════════════════════════════════════
   PHASE 2 CENTER — Seller Intake
═══════════════════════════════════════════ */
/** Friendly labels for the scraper's known field keys (server/scraper/index.ts). */
const SCRAPED_FIELD_LABELS: Record<string, string> = {
  businessDescription: "Business description",
  yearFounded: "Year founded",
  yearsOperating: "Years operating",
  numberOfLocations: "Number of locations",
  locationSite: "Location",
  website: "Website",
  keyProducts: "Key products / services",
  revenueStreams: "Revenue streams",
  targetMarket: "Target market",
  competitiveAdvantage: "Competitive advantage",
  uniqueSellingProposition: "Unique selling proposition",
  brandIdentity: "Brand identity",
  awards: "Awards & recognition",
  managementTeam: "Management team",
  employees: "Employees",
};

function Phase2Center() {
  const { deal, dealId } = useDeal();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [websiteInput, setWebsiteInput] = useState(deal.websiteUrl || "");
  const [showScraped, setShowScraped] = useState(false);

  const { data: invites = [] } = useInvites(dealId);
  const activeInvite = invites[0];
  const inviteUrl = activeInvite
    ? `${window.location.origin}/seller/${activeInvite.token}`
    : null;

  // Advance Platform Intake → Content Creation. Without this, a broker who
  // finished the interview had no visible way to reach the Generate CIM step
  // (it lived inside the collapsed Phase 3 accordion).
  const advanceToContent = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, {
        phase: "phase3_content_creation",
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
    },
  });

  const scrapeMutation = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("POST", `/api/deals/${dealId}/scrape`, {
        websiteUrl: websiteInput.trim() || undefined,
      });
      if (!r.ok) {
        const err = await r.json();
        throw new Error(err.error || "Scrape failed");
      }
      return r.json() as Promise<{
        fieldsExtracted: string[];
        fieldCount: number;
        source: string;
      }>;
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: "Scrape complete",
        description: `${result.fieldCount} fields found — tap "View scraped data" to review them.`,
      });
    },
    onError: (err: Error) => {
      toast({
        title: "Scrape failed",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const isScraped = !!deal.scrapedAt;
  const scrapedDate = deal.scrapedAt
    ? new Date(deal.scrapedAt).toLocaleDateString()
    : null;
  const scrapeSource = (deal as any).scrapeSource as
    | "website"
    | "internet_search"
    | "website_and_internet"
    | null;
  const scrapedFieldCount = deal.scrapedData
    ? Object.keys(deal.scrapedData as object).length
    : 0;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">
          Phase 2 — Seller Intake
        </h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Mostly the seller's turn — they work through their invite link while
          you watch progress here.
        </p>
      </div>

      {/* Onboarding */}
      <div
        className={`rounded-lg border p-4 ${deal.questionnaireData ? "border-success/30 bg-success-muted/40" : "border-border bg-card"}`}
      >
        <div className="flex items-center gap-3">
          {deal.questionnaireData ? (
            <CheckCircle2 className="h-[1.125rem] w-[1.125rem] text-success shrink-0" />
          ) : (
            <Circle className="h-[1.125rem] w-[1.125rem] text-muted-foreground/30 shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <p
                className={`text-sm font-medium ${deal.questionnaireData ? "line-through text-muted-foreground" : ""}`}
              >
                Seller onboarding
              </p>
              <ActorBadge who="seller" />
            </div>
            <p className="text-xs text-muted-foreground">
              {deal.questionnaireData
                ? "Systems, key people, business basics — completed by the seller"
                : activeInvite
                  ? activeInvite.acceptedAt
                    ? "Seller opened their link and is working through onboarding."
                    : `Invite ${activeInvite.sentAt ? "emailed" : "created"}${activeInvite.sellerEmail ? ` for ${activeInvite.sellerEmail}` : ""} — waiting on the seller to start.`
                  : "No seller invited yet — invite them from Phase 1 to unlock onboarding."}
            </p>
            {activeInvite && !deal.questionnaireData && (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => {
                    navigator.clipboard
                      .writeText(inviteUrl!)
                      .then(() => toast({ title: "Invite link copied" }))
                      .catch(() => toast({ title: "Link", description: inviteUrl! }));
                  }}
                >
                  <Copy className="h-3 w-3" /> Copy invite link
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1.5 text-muted-foreground"
                  onClick={() => window.open(inviteUrl!, "_blank")}
                >
                  <ExternalLink className="h-3 w-3" /> Preview seller view
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Public data scrape */}
      <div
        className={`rounded-lg border p-5 ${isScraped ? "border-success/30 bg-success-muted/40" : "border-border bg-card"}`}
      >
        <div className="flex items-start gap-3">
          {isScraped ? (
            <CheckCircle2 className="h-[1.125rem] w-[1.125rem] text-success mt-0.5 shrink-0" />
          ) : (
            <Globe className="h-[1.125rem] w-[1.125rem] text-muted-foreground/40 mt-0.5 shrink-0" />
          )}
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
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />{" "}
                      Searching...
                    </>
                  ) : (
                    <>
                      <Globe className="h-3 w-3" />{" "}
                      {websiteInput.trim() ? "Scrape" : "Search"}
                    </>
                  )}
                </Button>
              </div>
            )}
            {isScraped && (
              <div className="mt-2 flex items-center gap-1">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => setShowScraped(true)}
                  data-testid="button-view-scraped-data"
                >
                  <Eye className="h-3 w-3" /> View scraped data
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground/60 hover:text-muted-foreground gap-1.5"
                  onClick={() => scrapeMutation.mutate()}
                  disabled={scrapeMutation.isPending}
                >
                  {scrapeMutation.isPending ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin" />{" "}
                      Re-scraping...
                    </>
                  ) : (
                    "Re-scrape"
                  )}
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      <Dialog open={showScraped} onOpenChange={setShowScraped}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>Scraped public data</DialogTitle>
            <DialogDescription>
              {scrapedFieldCount} fields found
              {scrapedDate ? ` on ${scrapedDate}` : ""} —{" "}
              <span className="text-amber-600">
                unverified: the AI confirms each item with the seller during
                the interview.
              </span>
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-[60vh] overflow-y-auto space-y-3 py-2 pr-1">
            {Object.entries(
              (deal.scrapedData as Record<string, string>) || {},
            ).map(([key, value]) => (
              <div key={key}>
                <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                  {SCRAPED_FIELD_LABELS[key] ||
                    key
                      .replace(/([A-Z])/g, " $1")
                      .replace(/^./, (c) => c.toUpperCase())}
                </p>
                {key === "website" ? (
                  <a
                    href={/^https?:/.test(value) ? value : `https://${value}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-sm text-teal hover:underline break-all"
                  >
                    {value}
                  </a>
                ) : (
                  <p className="text-sm whitespace-pre-wrap">{value}</p>
                )}
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      {/* AI Interview */}
      <div
        className={`rounded-lg border p-5 ${deal.interviewCompleted ? "border-success/30 bg-success-muted/40" : "border-teal/30 bg-teal-muted/40"}`}
      >
        <div className="flex items-start gap-3">
          {deal.interviewCompleted ? (
            <CheckCircle2 className="h-[1.125rem] w-[1.125rem] text-success mt-0.5 shrink-0" />
          ) : (
            <div className="h-[1.125rem] w-[1.125rem] rounded-full border-2 border-teal bg-teal/10 flex items-center justify-center mt-0.5 shrink-0">
              <div className="h-1.5 w-1.5 rounded-full bg-teal" />
            </div>
          )}
          <div className="flex-1">
            <p
              className={`text-sm font-medium ${deal.interviewCompleted ? "line-through text-muted-foreground" : "text-teal"}`}
            >
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

      {/* Advance to Content Creation — the clear next step once the interview
          is done. Previously there was no path from here to CIM generation. */}
      {deal.interviewCompleted && (
        <div className="rounded-lg border border-teal/30 bg-teal/5 p-5 flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div>
            <p className="text-sm font-medium">Ready to build the CIM</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              The interview is complete. Move to Content Creation to generate
              the CIM from everything you've collected.
            </p>
          </div>
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5 shrink-0"
            onClick={() => advanceToContent.mutate()}
            disabled={advanceToContent.isPending}
            data-testid="button-advance-phase-3"
          >
            {advanceToContent.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <>
                Continue to Content Creation
                <ChevronRight className="h-3.5 w-3.5" />
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   PHASE 3 CENTER — Content Creation
═══════════════════════════════════════════ */
function Phase3Center() {
  const { deal, dealId } = useDeal();
  const { toast } = useToast();
  const cimContent = deal.cimContent as Record<string, string> | null;
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  const { data: cimSections = [] } = useQuery<CimSection[]>({
    queryKey: ["/api/deals", dealId, "cim-sections"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/cim-sections`);
      if (!r.ok) return [];
      return r.json();
    },
  });

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

  const { data: discrepancyList = [] } = useQuery<Discrepancy[]>({
    queryKey: ["/api/deals", dealId, "discrepancies"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/discrepancies`);
      if (!r.ok) return [];
      return r.json();
    },
  });
  const criticalUnresolved = discrepancyList.filter(
    (d) => d.severity === "critical" && d.status === "open",
  );

  const extractedCount = Object.keys(
    (deal.extractedInfo as object) || {},
  ).length;
  const scrapedCount = Object.keys(
    ((deal as any).scrapedData as object) || {},
  ).length;
  const totalDataFields = extractedCount + scrapedCount;

  const generate = useMutation({
    mutationFn: async () => {
      const r = await apiRequest(
        "POST",
        `/api/deals/${dealId}/generate-content`,
      );
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.error);
      }
      return r.json();
    },
    onSuccess: (data: { sectionCount?: number; warnings?: string[] }) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      queryClient.invalidateQueries({
        queryKey: ["/api/deals", dealId, "cim-sections"],
      });
      const warnings = data?.warnings ?? [];
      if (warnings.length > 0) {
        // Partial success is shown honestly — never a clean "success" toast
        // when sections fell back to placeholders.
        toast({
          title: `CIM generated with ${warnings.length} warning${warnings.length > 1 ? "s" : ""}`,
          description: warnings.join(" "),
          variant: "destructive",
        });
      } else {
        toast({
          title: "CIM generated",
          description: "Visual sections created. Review and edit below.",
        });
      }
    },
    onError: (e: Error) =>
      toast({
        title: "Generation failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  const saveEdit = useMutation({
    mutationFn: async ({
      sectionId,
      content,
    }: {
      sectionId: string;
      content: string;
    }) => {
      const r = await apiRequest("PATCH", `/api/cim-sections/${sectionId}`, {
        brokerEditedContent: content,
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.error);
      }
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["/api/deals", dealId, "cim-sections"],
      });
      setEditingSection(null);
      toast({ title: "Section saved" });
    },
    onError: (e: Error) =>
      toast({
        title: "Save failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  const approve = useMutation({
    mutationFn: async (role: "broker" | "seller") => {
      const data =
        role === "broker"
          ? { contentApprovedByBroker: true }
          : { contentApprovedBySeller: true };
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, data);
      return r.json();
    },
    onSuccess: (_, role) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: `${role === "broker" ? "Broker" : "Seller"} approval recorded`,
      });
    },
  });

  const advancePhase = useMutation({
    mutationFn: async (phase: string) => {
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, { phase });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Moved to Design & Finalization" });
    },
    onError: (e: Error) =>
      toast({ title: "Couldn't advance", description: e.message, variant: "destructive" }),
  });

  if (!deal.interviewCompleted) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground/30 mb-3" />
        <p className="text-sm font-medium text-muted-foreground">
          Interview required first
        </p>
        <p className="text-xs text-muted-foreground/60 mt-1">
          Complete the AI interview in Phase 2 before generating content.
        </p>
      </div>
    );
  }

  if (!cimContent && !hasVisualSections) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Phase 3 — Content Creation
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            The AI designs a complete visual CIM from your collected data.
          </p>
        </div>

        <div
          className={`rounded-lg border p-4 ${totalDataFields >= 8 ? "border-success/30 bg-success/5" : "border-teal/30 bg-teal/5"}`}
        >
          <div className="flex items-start gap-3">
            {totalDataFields >= 8 ? (
              <CheckCircle2 className="h-4 w-4 text-success mt-0.5 shrink-0" />
            ) : (
              <AlertCircle className="h-4 w-4 text-teal mt-0.5 shrink-0" />
            )}
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

        <DiscrepancyPanel dealId={dealId} />

        <div className="rounded-lg border border-teal/30 bg-teal-muted/40 p-5 text-center">
          <Wand2 className="h-6 w-6 text-teal/60 mx-auto mb-3" />
          <p className="text-sm font-medium mb-1">AI-Designed CIM</p>
          <p className="text-xs text-muted-foreground mb-4 max-w-md mx-auto">
            The AI will analyze your data and design a bespoke CIM with
            charts, infographics, financial tables, and dynamic layouts — not
            just text.
          </p>
          {criticalUnresolved.length > 0 && (
            <p className="text-xs text-red-400 mb-3">
              Resolve {criticalUnresolved.length} critical discrepanc
              {criticalUnresolved.length === 1 ? "y" : "ies"} above before
              generating.
            </p>
          )}
          <Button
            className="bg-teal text-teal-foreground hover:bg-teal/90"
            onClick={() => generate.mutate()}
            disabled={generate.isPending || criticalUnresolved.length > 0}
            data-testid="button-generate-content"
          >
            {generate.isPending ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Designing CIM...
              </>
            ) : (
              "Generate CIM"
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            CIM Preview
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {cimSections.length} sections · Click any section to edit
          </p>
        </div>
        <div className="flex items-center gap-2">
          {deal.contentApprovedByBroker && deal.contentApprovedBySeller ? (
            deal.phase === "phase4_design_finalization" ? (
              <span className="text-xs font-medium text-success flex items-center gap-1">
                <CheckCircle2 className="h-3.5 w-3.5" /> Both approved
              </span>
            ) : (
              <Button
                size="sm"
                className="h-8 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
                onClick={() => advancePhase.mutate("phase4_design_finalization")}
                disabled={advancePhase.isPending}
                data-testid="button-advance-phase-4"
              >
                Advance to Design <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            )
          ) : deal.contentApprovedByBroker ? (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => approve.mutate("seller")}
              disabled={approve.isPending}
            >
              Approve as Seller
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => approve.mutate("broker")}
              disabled={approve.isPending}
            >
              Approve as Broker
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground gap-1.5"
            onClick={() => generate.mutate()}
            disabled={generate.isPending}
            data-testid="button-regenerate-content"
          >
            <RefreshCw
              className={`h-3 w-3 ${generate.isPending ? "animate-spin" : ""}`}
            />
            Regenerate All
          </Button>
        </div>
      </div>

      {hasVisualSections ? (
        <div className="space-y-6 rounded-lg border border-border bg-card/50 p-6">
          {cimSections.map((section) => {
            const isEditing = editingSection === String(section.id);
            return (
              <div key={section.id} className="group relative">
                {!isEditing && (
                  <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity z-10 flex gap-1">
                    <button
                      onClick={() => {
                        setEditingSection(String(section.id));
                        setEditDraft(
                          section.brokerEditedContent ||
                            section.aiDraftContent ||
                            "",
                        );
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
                      <Button
                        size="sm"
                        className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1"
                        onClick={() =>
                          saveEdit.mutate({
                            sectionId: String(section.id),
                            content: editDraft,
                          })
                        }
                        disabled={saveEdit.isPending}
                      >
                        {saveEdit.isPending ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <Check className="h-3 w-3" />
                        )}
                        Save
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-xs gap-1"
                        onClick={() => setEditingSection(null)}
                      >
                        <X className="h-3 w-3" /> Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <CimSectionRenderer
                    section={section}
                    branding={branding}
                    brokerMode
                  />
                )}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="space-y-3">
          {CIM_SECTIONS.map((section) => {
            const content = cimContent?.[section.key] || "";
            return (
              <div
                key={section.key}
                className="rounded-lg border border-border bg-card overflow-hidden"
              >
                <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/30">
                  <p className="text-xs font-semibold text-muted-foreground uppercase tracking-widest">
                    {section.title}
                  </p>
                </div>
                <div className="px-4 py-3">
                  {content ? (
                    <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">
                      {content}
                    </p>
                  ) : (
                    <p className="text-sm text-muted-foreground/40 italic py-2">
                      Not yet generated.
                    </p>
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

/* ═══════════════════════════════════════════
   PHASE 4 CENTER — Design & Finalization
═══════════════════════════════════════════ */
function Phase4Center() {
  const { deal, dealId } = useDeal();
  const { toast } = useToast();
  const [, navigate] = useLocation();

  const publish = useMutation({
    mutationFn: async () => {
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, {
        isLive: true,
      });
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: "CIM published",
        description: "Now live for invited buyers.",
      });
    },
  });

  const designApprove = useMutation({
    mutationFn: async (role: "broker" | "seller") => {
      const data =
        role === "broker"
          ? { designApprovedByBroker: true }
          : { designApprovedBySeller: true };
      const r = await apiRequest("PATCH", `/api/deals/${dealId}`, data);
      return r.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Design approved" });
    },
    onError: (e: Error) =>
      toast({ title: "Approval failed", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Phase 4 — Design & Finalization
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            Final design pass and publication.
          </p>
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
          {
            label: "Design generated",
            // The layout engine stamps cimLayoutGeneratedAt; cimDesignData is
            // the legacy field and is usually null on current deals.
            done: !!deal.cimLayoutGeneratedAt || !!deal.cimDesignData,
            action: null as null | "broker" | "seller",
          },
          {
            label: "Broker approved",
            done: !!deal.designApprovedByBroker,
            action: "broker" as const,
          },
          {
            label: "Seller approved",
            done: !!deal.designApprovedBySeller,
            action: "seller" as const,
          },
        ].map((item) => (
          <div
            key={item.label}
            className={`rounded-lg border p-4 flex items-center gap-3 ${item.done ? "border-success/30 bg-success-muted/40" : "border-border bg-card"}`}
          >
            {item.done ? (
              <CheckCircle2 className="h-[1.125rem] w-[1.125rem] text-success shrink-0" />
            ) : (
              <Circle className="h-[1.125rem] w-[1.125rem] text-muted-foreground/30 shrink-0" />
            )}
            <span
              className={`text-sm flex-1 ${item.done ? "line-through text-muted-foreground" : ""}`}
            >
              {item.label}
            </span>
            {!item.done && item.action && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs shrink-0"
                onClick={() => designApprove.mutate(item.action!)}
                disabled={designApprove.isPending}
                data-testid={`button-design-approve-${item.action}`}
              >
                Approve as {item.action === "broker" ? "Broker" : "Seller"}
              </Button>
            )}
          </div>
        ))}
      </div>
      {deal.designApprovedByBroker &&
        deal.designApprovedBySeller &&
        !deal.isLive && (
          <div className="rounded-lg border border-teal/30 bg-teal-muted/40 p-4 flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-teal">
                Ready to publish
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                All approvals received.
              </p>
            </div>
            <Button
              size="sm"
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => publish.mutate()}
              disabled={publish.isPending}
            >
              Publish CIM
            </Button>
          </div>
        )}
      {deal.isLive && (
        <div className="rounded-lg border border-success/30 bg-success-muted/40 p-4 flex items-center gap-3">
          <CheckCircle2 className="h-5 w-5 text-success" />
          <div>
            <p className="text-sm font-medium text-success">CIM is live</p>
            <p className="text-xs text-muted-foreground">
              Shared with invited buyers.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ═══════════════════════════════════════════
   DOCUMENT TABLE (full list below phases)
═══════════════════════════════════════════ */
function DocumentTable() {
  const { dealId } = useDeal();

  const { data: documents = [], error: docsError, refetch: refetchDocs } = useQuery<DocType[]>({
    queryKey: ["/api/deals", dealId, "documents"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/documents`);
      if (!r.ok) throw new Error("Failed to load documents");
      return r.json();
    },
  });

  const deleteDoc = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest("DELETE", `/api/documents/${id}`);
    },
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["/api/deals", dealId, "documents"],
      }),
  });

  if (docsError) {
    return <PanelError what="documents" onRetry={() => refetchDocs()} />;
  }
  if (documents.length === 0) return null;

  return (
    <div className="mt-6 pt-6 border-t border-border">
      <h3 className="text-sm font-semibold mb-3">
        All Documents ({documents.length})
      </h3>
      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30">
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                Name
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                Category
              </th>
              <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">
                Status
              </th>
              <th className="w-10" />
            </tr>
          </thead>
          <tbody>
            {documents.map((doc) => (
              <tr
                key={doc.id}
                className="border-b border-border last:border-0 group hover:bg-muted/20"
              >
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="truncate">{doc.name}</span>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-muted-foreground capitalize">
                  {doc.category}
                </td>
                <td className="px-4 py-2.5">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium ${
                      (doc.status as string) === "extracted"
                        ? "bg-emerald-50 text-emerald-600"
                        : (doc.status as string) === "parsing"
                          ? "bg-amber-50 text-amber-600"
                          : "bg-neutral-100 text-neutral-500"
                    }`}
                  >
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
    </div>
  );
}

/* ═══════════════════════════════════════════
   OVERVIEW TAB — Phase accordion + documents
═══════════════════════════════════════════ */
export function OverviewTab() {
  const { deal, dealId } = useDeal();
  const [expandedPhases, setExpandedPhases] = useState<Set<string>>(
    new Set(),
  );
  // Set by the Calls tile to pop the shared upload dialog pre-configured.
  const [uploadSignal, setUploadSignal] = useState<{
    category: string;
    tab: "file" | "paste";
    nonce: number;
  } | null>(null);

  const { data: invites = [] } = useInvites(dealId);
  const currentPhaseIdx = getPhaseIndex(deal.phase);

  const phaseComponents: Record<string, React.ReactNode> = {
    phase1_info_collection: <Phase1Center />,
    phase2_platform_intake: <Phase2Center />,
    phase3_content_creation: <Phase3Center />,
    phase4_design_finalization: <Phase4Center />,
  };

  const togglePhase = (key: string) => {
    setExpandedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-3">
      {PHASES.map((phase, idx) => {
        const isCurrentPhase = deal.phase === phase.key;
        const isComplete = currentPhaseIdx > idx;
        const isExpanded = isCurrentPhase || expandedPhases.has(phase.key);
        const items = phase.items(deal, { invited: invites.length > 0 });
        const required = items.filter((i) => !i.optional);
        const doneCount = required.filter((i) => i.done).length;

        return (
          <div
            key={phase.key}
            id={`phase-section-${phase.key}`}
            className={`rounded-lg border transition-colors ${
              isCurrentPhase
                ? "border-teal/30 bg-card"
                : isComplete
                  ? "border-border bg-card/50"
                  : "border-border/60 bg-muted/20"
            }`}
          >
            <button
              onClick={() => !isCurrentPhase && togglePhase(phase.key)}
              className={`w-full flex items-center gap-3 px-4 py-3 text-left ${
                !isCurrentPhase
                  ? "cursor-pointer hover:bg-muted/30 transition-colors"
                  : ""
              } rounded-lg`}
            >
              {isComplete ? (
                <CheckCircle2 className="h-4.5 w-4.5 text-success shrink-0" />
              ) : isCurrentPhase ? (
                <div className="h-4.5 w-4.5 rounded-full border-2 border-teal bg-teal/10 flex items-center justify-center shrink-0">
                  <div className="h-1.5 w-1.5 rounded-full bg-teal" />
                </div>
              ) : (
                <Circle className="h-4.5 w-4.5 text-muted-foreground/40 shrink-0" />
              )}

              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span
                    className={`text-sm font-medium ${
                      isCurrentPhase
                        ? "text-foreground"
                        : isComplete
                          ? "text-foreground/80"
                          : "text-muted-foreground"
                    }`}
                  >
                    {phase.short} — {phase.label}
                  </span>
                  {isCurrentPhase && (
                    <span className="text-2xs font-medium px-1.5 py-0.5 rounded bg-teal/10 text-teal">
                      Current
                    </span>
                  )}
                  {isComplete && (
                    <span className="text-2xs font-medium px-1.5 py-0.5 rounded bg-success/10 text-success">
                      Complete
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">
                  {isComplete
                    ? "Phase complete"
                    : `${doneCount}/${required.length} tasks done`}
                </span>
              </div>

              {!isCurrentPhase &&
                (isExpanded ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                ))}
            </button>

            {isExpanded && (
              <div className="px-4 pb-4 pt-1 border-t border-border/50">
                {phaseComponents[phase.key]}
              </div>
            )}
          </div>
        );
      })}

      {/* Shared inputs — documents + data sources feed the AI in every
          phase (late lease amendments, new transcripts), so they render
          once here instead of per-phase. */}
      {(
        <div className="pt-3 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">Ongoing inputs</h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              Documents and data sources feed the AI throughout intake — you or
              the seller can add them at any time.
            </p>
          </div>
          <DocumentUploadCard openSignal={uploadSignal} />
          <IntegrationPromptCard
            onOpenTranscripts={() =>
              setUploadSignal({
                category: "transcripts",
                tab: "paste",
                nonce: Date.now(),
              })
            }
          />
        </div>
      )}

      {/* Document table below phases */}
      <DocumentTable />

      {/* Quick analytics summary */}
      <div className="mt-6 pt-6 border-t border-border">
        <DealAnalyticsWidget dealId={dealId} />
      </div>
    </div>
  );
}
