/**
 * OverviewTab — Phase workflow, documents, scrape, discrepancies.
 *
 * Contains the 4-phase accordion with inline phase center components,
 * document upload/table, website scrape card, integration prompts,
 * and deal analytics summary.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { PanelError } from "@/components/deal/PanelError";
import { useDeal } from "@/contexts/DealContext";
import { queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCimGeneration, cimGenerationKey } from "@/hooks/useCimGeneration";
import { useCimGenerationGate } from "@/hooks/useCimGenerationGate";
import { CimGenerationProgress } from "@/components/deal/CimGenerationProgress";
import { CimReadinessBadge, CimReadinessCard } from "@/components/deal/CimReadinessCard";
import { InterviewOutlineCard } from "@/components/deal/InterviewOutlineCard";
import { ReopenInterviewButton } from "@/components/deal/ReopenInterviewButton";
import { TogetherSetupDialog } from "@/components/deal/TogetherSetupDialog";
import { AddSourceDialog, type AddSourcePreset } from "@/components/information/AddSourceDialog";
import { CrmLinkCard } from "@/components/crm/CrmLinkCard";
import type { DealSellerContact } from "@shared/schema";
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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  RefreshCw,
  X,
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
  Users,
  Library,
  ArrowRight,
  Pencil,
} from "lucide-react";
import { PHASES, getPhaseIndex } from "./phases";
import { FinancialAnalysisCenter } from "@/components/financial/FinancialAnalysisCenter";
import { CimSummaryCard } from "@/components/cim-builder/CimSummaryCard";
import { DiscrepancyPanel } from "@/components/deal/DiscrepancyPanel";
import { ReadyToBuildCta } from "@/components/deal/ReadyToBuildCta";
import { DiscrepancyCheckNotice } from "@/components/deal/DiscrepancyCheckNotice";
import { DealAnalyticsWidget } from "@/components/deal/DealAnalyticsWidget";
import type {
  Deal,
  SellerInvite,
  Document as DocType,
  CimSection,
  Discrepancy,
} from "@shared/schema";
import { CIM_SECTIONS } from "@shared/schema";

// A document is "in flight" from upload until the parser writes a terminal
// status; the document lists poll while any row is in this state.
const isDocProcessing = (d: { status?: string | null }) =>
  d.status === "pending" || d.status === "parsing";
const DOC_POLL_MS = 2500;
const plural = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const stripExt = (name?: string | null) => (name || "").replace(/\.[a-z0-9]{1,5}$/i, "");

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

/**
 * Error carrying the server's parsed `{ error, ... }` body. Mutations throw
 * this so every onError toast can show the real reason (e.g. the 409
 * discrepancy block on generate-content) instead of a raw "500: {...}" string.
 */
class ApiError extends Error {
  status: number;
  body: Record<string, any> | null;
  constructor(message: string, status: number, body: Record<string, any> | null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Copy with feedback. A failed clipboard write (blocked permission, insecure
 * context) must never be silent — the fallback toast carries the text so the
 * broker can still grab it by hand.
 */
async function copyWithFeedback(
  toast: ReturnType<typeof useToast>["toast"],
  text: string,
  title = "Link copied",
) {
  try {
    await navigator.clipboard.writeText(text);
    toast({ title });
  } catch {
    toast({ title: "Copy failed — link:", description: text });
  }
}

/** JSON request that resolves to the parsed body and throws ApiError on !ok. */
async function apiJson<T = any>(
  method: string,
  url: string,
  data?: unknown,
  fallback = "Request failed",
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: data !== undefined ? { "Content-Type": "application/json" } : {},
    body: data !== undefined ? JSON.stringify(data) : undefined,
    credentials: "include",
  });
  const text = await res.text();
  let body: Record<string, any> | null = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!res.ok) {
    const message =
      body && typeof body.error === "string"
        ? body.error
        : res.status === 401
          ? "Your session has expired — please sign in again."
          : `${fallback} (${res.status})`;
    throw new ApiError(message, res.status, body);
  }
  return (body ?? {}) as T;
}

/** The deal's seller invites — one secure link per seller for the whole flow. */
function useInvites(dealId: string) {
  return useQuery<SellerInvite[]>({
    queryKey: ["/api/deals", dealId, "invites"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/invites`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load seller invites");
      return r.json();
    },
  });
}

/**
 * The invite that actually represents the seller. The list arrives
 * newest-first, and sending the NDA to a different address (e.g. the seller's
 * attorney) creates a second invite — so `invites[0]` silently switched the
 * status card and "Copy invite link" to the wrong person. Prefer the invite
 * furthest along (opened > emailed > created), NEWEST on ties — a re-invite
 * sent to a corrected email must win over the typo'd one it replaced.
 */
function pickPrimaryInvite(invites: SellerInvite[]): SellerInvite | undefined {
  if (invites.length === 0) return undefined;
  const newestFirst = [...invites].sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return (
    newestFirst.find((i) => !!i.acceptedAt) ??
    newestFirst.find((i) => !!i.sentAt) ??
    newestFirst[0]
  );
}

/* ═══════════════════════════════════════════
   DOCUMENT UPLOAD CARD
═══════════════════════════════════════════ */
function DocumentUploadCard({
  openSignal,
}: {
  openSignal?: AddSourcePreset | null;
}) {
  const { dealId } = useDeal();
  const [, setLocation] = useLocation();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [preset, setPreset] = useState<AddSourcePreset | null>(null);

  // Other cards (e.g. the Calls tile) can pop the dialog open pre-configured.
  useEffect(() => {
    if (!openSignal) return;
    setPreset(openSignal);
    setUploadOpen(true);
  }, [openSignal]);

  const { data: docs = [], error: docsError, refetch: refetchDocs } = useQuery<DocType[]>({
    queryKey: ["/api/deals", dealId, "documents"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/documents`);
      if (!r.ok) throw new Error("Failed to load documents");
      return r.json();
    },
    // Poll while anything is still parsing so status badges flip on their
    // own instead of waiting for a manual reload.
    refetchInterval: (query) =>
      query.state.data?.some(isDocProcessing) ? DOC_POLL_MS : false,
  });

  // When a document finishes parsing, the deal's extractedInfo changed too —
  // refresh it so coverage and the interview pick up the new fields.
  const processingIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const stillProcessing = new Set(docs.filter(isDocProcessing).map((d) => d.id));
    const finished = Array.from(processingIdsRef.current).some((id) => !stillProcessing.has(id));
    processingIdsRef.current = stillProcessing;
    if (finished) {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
    }
  }, [docs, dealId]);

  const parsedCount = docs.filter(
    (d: any) => (d.status as string) === "extracted",
  ).length;

  return (
    <>
      <div className="rounded-lg border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          <Upload className="h-[1.125rem] w-[1.125rem] text-teal mt-0.5 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium">Add information</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Documents, emails, call or video-call transcripts, CRM notes, web
              pages — the AI reads each one and records where every fact came from.
            </p>
            {/* A failed list fetch must not read as "nothing uploaded yet". */}
            {docsError && (
              <div
                className="mt-2 flex items-center gap-2 text-xs text-red-400"
                role="alert"
                data-testid="text-documents-load-error"
              >
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                <span>Couldn't load your documents.</span>
                <button
                  type="button"
                  onClick={() => refetchDocs()}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Retry
                </button>
              </div>
            )}
            {docs.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {docs.slice(0, 5).map((d: any) => (
                  <span
                    key={d.id}
                    className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-medium ${
                      (d.status as string) === "extracted"
                        ? "bg-success-muted text-success-muted-foreground"
                        : (d.status as string) === "parsing"
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    <FileText className="h-2.5 w-2.5" />
                    {stripExt(d.name).slice(0, 15) || "doc"}
                  </span>
                ))}
                {docs.length > 5 && (
                  <span className="text-2xs text-muted-foreground">
                    +{docs.length - 5} more
                  </span>
                )}
              </div>
            )}
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                className="h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
                onClick={() => {
                  setPreset({ kind: "document", tab: "file", nonce: Date.now() });
                  setUploadOpen(true);
                }}
                data-testid="button-open-upload"
              >
                <Upload className="h-3 w-3" /> Add a source
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1 text-muted-foreground hover:text-foreground"
                onClick={() => setLocation(`/deal/${dealId}/information`)}
              >
                <Library className="h-3 w-3" /> Collected information
              </Button>
              {docs.length > 0 && (
                <span className="text-2xs text-muted-foreground">
                  {/* Documents, emails, transcripts and notes on file — the Information tab also counts interview sessions, the questionnaire and your edits as sources. */}
                  {docs.length} document{docs.length === 1 ? "" : "s"}
                  {parsedCount > 0 && ` · ${parsedCount} read`}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      <AddSourceDialog dealId={dealId} open={uploadOpen} onOpenChange={setUploadOpen} preset={preset} />
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
  const { dealId } = useDeal();
  // Dismissal is per deal — "Skip for now" on one deal must not hide the
  // card on every other deal. Older builds wrote one global key (shared /
  // phase1 / phase2); clear it so only the per-deal choice counts.
  const storageKey = `cimple_integration_prompt_${dealId}`;
  const readDismissed = () => {
    for (const k of ["shared", "phase1", "phase2"]) {
      localStorage.removeItem(`cimple_integration_prompt_${k}`);
    }
    return localStorage.getItem(storageKey) === "dismissed";
  };
  const [dismissed, setDismissed] = useState(readDismissed);
  useEffect(() => {
    setDismissed(readDismissed());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);
  const [, setLocation] = useLocation();

  if (dismissed) return null;

  const dismiss = () => {
    localStorage.setItem(storageKey, "dismissed");
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
      desc: "Import the seller's Pipedrive record",
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

  const {
    data: invites = [],
    error: invitesError,
    refetch: refetchInvites,
  } = useInvites(dealId);
  const activeInvite = pickPrimaryInvite(invites);
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

  const copyInviteLink = () => {
    if (!inviteUrl) return;
    return copyWithFeedback(toast, inviteUrl, "Invite link copied");
  };

  const update = useMutation({
    mutationFn: (data: Partial<Deal>) =>
      apiJson("PATCH", `/api/deals/${dealId}`, data, "Couldn't update the deal"),
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
    mutationFn: (data: { sellerEmail: string; sellerName: string }) =>
      apiJson("POST", `/api/deals/${dealId}/invites`, data, "Couldn't send the invite"),
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
    mutationFn: (data: { sellerEmail: string; ndaText: string }) =>
      apiJson("POST", `/api/deals/${dealId}/nda/send`, data, "Couldn't send the NDA"),
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
        // Start from the seller's details on file (CRM / Information tab).
        const contact = deal.sellerContact as DealSellerContact | null;
        if (contact) {
          setSellerName((v) => v || contact.name || "");
          setSellerEmail((v) => v || contact.email || "");
        }
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
        ? deal.ndaSignedBy === "broker" && !deal.ndaSignerName
          ? `Marked as signed${deal.ndaSignedAt ? ` on ${new Date(deal.ndaSignedAt).toLocaleDateString()}` : ""}`
          : `Signed${deal.ndaSignerName ? ` by ${deal.ndaSignerName}` : ""}${deal.ndaSignedAt ? ` on ${new Date(deal.ndaSignedAt).toLocaleDateString()}` : ""}`
        : deal.ndaSentAt
          ? `Sent${deal.ndaSentTo ? ` to ${deal.ndaSentTo}` : ""} on ${new Date(deal.ndaSentAt).toLocaleDateString()} — awaiting signature`
          : "Send it for e-signature through Cimple, or handle it your usual way and mark it signed.",
      who: "broker",
      done: !!deal.ndaSigned,
      testId: "button-send-nda",
      action: () => {
        setNdaEmail(deal.ndaSentTo || activeInvite?.sellerEmail || "");
        setNdaText(deal.ndaText || defaultNdaText);
        setNdaOpen(true);
      },
      actionLabel: deal.ndaSentAt ? "Re-send" : "Send for E-Signature",
      secondaryAction: () => update.mutate({ ndaSigned: true }),
      secondaryLabel: "Mark as Signed",
      undo: () => update.mutate({ ndaSigned: false } as Partial<Deal>),
    },
    {
      key: "sq",
      label: "Seller Questionnaire",
      desc: deal.questionnaireData
        ? "Completed by the seller"
        : deal.sqCompleted
          ? "Received outside Cimple — marked by you"
          : "The seller fills this in from their invite link — it completes automatically.",
      who: deal.sqCompleted && !deal.questionnaireData ? "broker" : "seller",
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
      desc: deal.valuationCompleted
        ? deal.askingPrice
          ? `Asking price ${deal.askingPrice}`
          : "Completed — no asking price entered"
        : "Optional here — finish it any time before generating the CIM.",
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

      {/* A failed invites fetch must not masquerade as "no seller invited". */}
      {invitesError && (
        <PanelError what="seller invite status" onRetry={() => refetchInvites()} />
      )}

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
                {/* "Waiting on seller" is only true while the step is open —
                    a received questionnaire is not waiting on anyone. */}
                {!step.done && <ActorBadge who={step.who} />}
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

      {/* Only on a Phase 1 deal — on a later deal this expanded accordion
          would move it backwards (the server refuses that anyway). */}
      {requiredDone && deal.phase === "phase1_info_collection" && (
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
                    onClick={() => copyWithFeedback(toast, inviteResult.url)}
                    data-testid="button-copy-invite-link-dialog"
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
  const [togetherOpen, setTogetherOpen] = useState(false);
  const [websiteInput, setWebsiteInput] = useState(deal.websiteUrl || "");
  const [showScraped, setShowScraped] = useState(false);
  const [reviewingDiscrepancies, setReviewingDiscrepancies] = useState(false);
  // The "next step" card must not say "Ready to build" while a critical
  // discrepancy blocks generation (same rule as the server and Phase 3).
  const { criticalUnresolved, discrepanciesError } = useDiscrepancyGate(dealId);

  const { data: invites = [], error: invitesError } = useInvites(dealId);
  const activeInvite = pickPrimaryInvite(invites);
  const inviteUrl = activeInvite
    ? `${window.location.origin}/seller/${activeInvite.token}`
    : null;

  // Advance Platform Intake → Content Creation. Without this, a broker who
  // finished the interview had no visible way to reach the Generate CIM step
  // (it lived inside the collapsed Phase 3 accordion).
  const advanceToContent = useMutation({
    mutationFn: () =>
      apiJson(
        "PATCH",
        `/api/deals/${dealId}`,
        { phase: "phase3_content_creation" },
        "Couldn't advance the deal",
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Moved to Content Creation" });
    },
    onError: (err: Error) => {
      toast({
        title: "Couldn't advance to Content Creation",
        description: err.message,
        variant: "destructive",
      });
    },
  });

  const scrapeMutation = useMutation({
    mutationFn: () =>
      apiJson<{
        fieldsExtracted: string[];
        fieldCount: number;
        source: string;
      }>(
        "POST",
        `/api/deals/${dealId}/scrape`,
        { websiteUrl: websiteInput.trim() || undefined },
        "Scrape failed",
      ),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: "Scrape complete",
        description: `${plural(result.fieldCount, "field")} found — tap "View scraped data" to review ${result.fieldCount === 1 ? "it" : "them"}.`,
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
              {/* Same rule as Phase 1: a finished step isn't waiting on anyone. */}
              {!deal.questionnaireData && <ActorBadge who="seller" />}
            </div>
            <p className="text-xs text-muted-foreground">
              {deal.questionnaireData
                ? "Systems, key people, business basics — completed by the seller"
                : activeInvite
                  ? activeInvite.acceptedAt
                    ? "Seller opened their link and is working through onboarding."
                    : `Invite ${activeInvite.sentAt ? "emailed" : "created"}${activeInvite.sellerEmail ? ` for ${activeInvite.sellerEmail}` : ""} — waiting on the seller to start.`
                  : invitesError
                    ? "Couldn't load the seller's invite status — retry from Phase 1."
                    : "No seller invited yet — invite them from Phase 1 to unlock onboarding."}
            </p>
            {activeInvite && !deal.questionnaireData && (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => copyWithFeedback(toast, inviteUrl!, "Invite link copied")}
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
                ? `${plural(scrapedFieldCount, "field")} found via ${scrapeSource === "website_and_internet" ? "website + internet search" : scrapeSource === "internet_search" ? "internet search" : "website"} on ${scrapedDate} — AI will verify with seller during interview`
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
              {plural(scrapedFieldCount, "field")} found
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

      {/* Interview outline — what the interviewer will cover; editable in plain language */}
      <InterviewOutlineCard dealId={dealId} interviewStarted={!!deal.interviewCompleted || (deal as any).interviewStartedAt != null} />

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
              className={`text-sm font-medium ${deal.interviewCompleted ? "text-foreground" : "text-teal"}`}
            >
              {deal.interviewCompleted ? "Interview complete" : "AI interview"}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {deal.interviewCompleted
                ? "The business profile is built — you can keep adding to it."
                : "The AI conducts an adaptive interview to build the full business profile."}
            </p>
            {deal.interviewCompleted && (
              <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="interview-complete-links">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => setLocation(`/deal/${dealId}/information`)}
                  data-testid="button-view-collected-information"
                >
                  <Library className="h-3 w-3" /> View collected information
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs gap-1.5"
                  onClick={() => setLocation(`/deal/${dealId}/interview-review`)}
                  data-testid="button-view-transcript"
                >
                  <MessageSquare className="h-3 w-3" /> View transcript
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs gap-1.5 text-muted-foreground hover:text-foreground"
                  onClick={() => setLocation(`/deal/${dealId}/interview`)}
                  data-testid="button-add-more-detail"
                >
                  <Pencil className="h-3 w-3" /> Add more detail
                </Button>
                <ReopenInterviewButton dealId={dealId} />
              </div>
            )}
            {!deal.interviewCompleted && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5"
                  onClick={() => setLocation(`/deal/${dealId}/interview`)}
                  data-testid="button-start-interview"
                >
                  <MessageSquare className="h-3.5 w-3.5" />
                  Start AI Interview
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5"
                  onClick={() => setTogetherOpen(true)}
                  data-testid="button-interview-together"
                >
                  <Users className="h-3.5 w-3.5" />
                  Interview together
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  Run it with the seller on a call or in person — you ask, they answer, Cimple fills it in.
                </span>
              </div>
            )}
            <TogetherSetupDialog dealId={dealId} open={togetherOpen} onOpenChange={setTogetherOpen} />
          </div>
        </div>
      </div>

      {/* Advance to Content Creation — the clear next step once the interview
          is done. Previously there was no path from here to CIM generation.
          Hidden once the deal is past Seller Intake (it would move it back). */}
      {deal.interviewCompleted && deal.phase === "phase2_platform_intake" && (
        <div className="space-y-3">
          <ReadyToBuildCta
            criticalCount={criticalUnresolved.length}
            gateError={!!discrepanciesError}
            pending={advanceToContent.isPending}
            onContinue={() => advanceToContent.mutate()}
            onReview={() => setReviewingDiscrepancies((v) => !v)}
            reviewing={reviewingDiscrepancies}
          />
          {reviewingDiscrepancies && (criticalUnresolved.length > 0 || !!discrepanciesError) && (
            <DiscrepancyPanel dealId={dealId} />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Unresolved critical discrepancies lock every CIM-producing step — generate,
 * approve, advance to design, publish. The server enforces the same rule with
 * a 409 on the deal PATCH and the generate endpoints; this mirrors it so the
 * buttons explain themselves instead of failing.
 *
 * Mirrors the server's status list exactly: only "open" and "seller_responded"
 * block. "ask_seller" is routed to the interview and counts as handled (the
 * interview hands it back as seller_responded when it ends, which re-blocks
 * until the broker resolves it).
 */
function useDiscrepancyGate(dealId: string) {
  const {
    data: discrepancyList = [],
    error: discrepanciesError,
    refetch: refetchDiscrepancies,
  } = useQuery<Discrepancy[]>({
    queryKey: ["/api/deals", dealId, "discrepancies"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/discrepancies`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load discrepancies");
      return r.json();
    },
  });
  const criticalUnresolved = discrepancyList.filter(
    (d) =>
      d.severity === "critical" &&
      (d.status === "open" || d.status === "seller_responded"),
  );
  // If the gate itself couldn't load we can't prove it's clear — block, and
  // say so, rather than letting a failed fetch unlock the step.
  const blocked = criticalUnresolved.length > 0 || !!discrepanciesError;
  const reasonFor = (verb: string): string | null =>
    discrepanciesError
      ? "Couldn't load discrepancies — this step stays locked until they load."
      : criticalUnresolved.length > 0
        ? `Resolve ${criticalUnresolved.length} critical discrepanc${criticalUnresolved.length === 1 ? "y" : "ies"} before ${verb}.`
        : null;
  return { discrepancyList, criticalUnresolved, discrepanciesError, refetchDiscrepancies, blocked, reasonFor };
}

/* ═══════════════════════════════════════════
   PHASE 3 CENTER — Content Creation
═══════════════════════════════════════════ */
function Phase3Center() {
  const { deal, dealId } = useDeal();
  const { toast } = useToast();
  const cimContent = deal.cimContent as Record<string, string> | null;
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);

  // Throws on failure: returning [] here would drop the broker into the
  // "nothing generated yet" branch with a live Generate button — a loading
  // error must never look like an empty CIM.
  const {
    data: cimSections = [],
    error: sectionsError,
    refetch: refetchSections,
  } = useQuery<CimSection[]>({
    queryKey: ["/api/deals", dealId, "cim-sections"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/cim-sections`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load CIM sections");
      return r.json();
    },
  });

  const hasVisualSections = cimSections.length > 0;

  const {
    discrepanciesError,
    refetchDiscrepancies,
    blocked: generationBlocked,
    reasonFor,
  } = useDiscrepancyGate(dealId);
  const blockReason = reasonFor("generating");

  const extractedCount = Object.keys(
    (deal.extractedInfo as object) || {},
  ).filter((k) => !k.startsWith("_")).length;
  const scrapedCount = Object.keys(
    ((deal as any).scrapedData as object) || {},
  ).length;
  const totalDataFields = extractedCount + scrapedCount;

  // Generation is a background job on the server (survives leaving the
  // page). This tab follows it via useCimGeneration for the progress bar;
  // the "CIM ready" toast comes from the app-wide CimGenerationWatcher.
  const generation = useCimGeneration(dealId);
  // Importance-weighted information quality — replaces the raw field count —
  // and the shared "enough information to write the CIM?" rule: a finished
  // interview, or enough collected from any source (calls, CRM, documents,
  // the Information tab). Same rule as the CIM tab, the builder, the deal
  // list and the server.
  const infoGate = useCimGenerationGate(dealId, deal.interviewCompleted);
  const readiness = infoGate.readiness;
  const infoBlockReason = infoGate.allowed ? null : infoGate.reason;
  const generate = useMutation({
    mutationFn: () =>
      apiJson<{ started: boolean }>(
        "POST",
        `/api/deals/${dealId}/generate-content`,
        undefined,
        "CIM generation failed",
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: cimGenerationKey(dealId) });
    },
    onError: (e: Error) => {
      // The server is the authority on the discrepancy gate. If it 409s
      // (e.g. a discrepancy was opened since this page loaded), name the
      // blocking fields and refresh the list so the UI locks too.
      const blocking =
        e instanceof ApiError && e.status === 409
          ? ((e.body?.blockingDiscrepancies ?? []) as { id: string; field: string }[])
          : null;
      if (blocking) {
        queryClient.invalidateQueries({
          queryKey: ["/api/deals", dealId, "discrepancies"],
        });
      }
      toast({
        title: blocking ? "CIM generation blocked" : "Generation failed",
        description:
          blocking && blocking.length > 0
            ? `${e.message}. Blocking: ${blocking.map((b) => b.field).join(", ")}.`
            : e.message,
        variant: "destructive",
      });
    },
  });

  const approve = useMutation({
    mutationFn: (role: "broker" | "seller") =>
      apiJson(
        "PATCH",
        `/api/deals/${dealId}`,
        role === "broker"
          ? { contentApprovedByBroker: true }
          : { contentApprovedBySeller: true },
        "Couldn't record the approval",
      ),
    onSuccess: (_, role) => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: `${role === "broker" ? "Broker" : "Seller"} approval recorded`,
      });
    },
    onError: (e: Error, role) =>
      toast({
        title: `${role === "broker" ? "Broker" : "Seller"} approval failed`,
        description: e.message,
        variant: "destructive",
      }),
  });

  const advancePhase = useMutation({
    mutationFn: (phase: string) =>
      apiJson("PATCH", `/api/deals/${dealId}`, { phase }, "Couldn't advance the deal"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Moved to Design & Finalization" });
    },
    onError: (e: Error) =>
      toast({ title: "Couldn't advance", description: e.message, variant: "destructive" }),
  });

  // Without the sections list we can't tell "not generated yet" from "failed
  // to load" — and the former branch offers a Generate button that would
  // wipe and rebuild an existing CIM. Show the error instead.
  if (sectionsError) {
    return (
      <div className="space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">
            Phase 3 — Content Creation
          </h2>
        </div>
        <PanelError what="CIM sections" onRetry={() => refetchSections()} />
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

        {readiness ? (
          <CimReadinessCard
            readiness={readiness}
            hint={`${totalDataFields} data fields on file (${extractedCount} from the interview and documents, ${scrapedCount} from the public scrape). ${!infoGate.allowed ? "Add more before generating — see below." : readiness.criticalGap ? "Closing the critical gaps before generating will produce a stronger CIM; you can still generate now and edit." : "Ready to generate."}`}
          />
        ) : (
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
        )}

        {discrepanciesError ? (
          <PanelError what="discrepancies" onRetry={() => refetchDiscrepancies()} />
        ) : (
          <DiscrepancyPanel dealId={dealId} />
        )}

        <div className="rounded-lg border border-teal/30 bg-teal-muted/40 p-5 text-center">
          <Wand2 className="h-6 w-6 text-teal/60 mx-auto mb-3" />
          <p className="text-sm font-medium mb-1">AI-Designed CIM</p>
          <p className="text-xs text-muted-foreground mb-4 max-w-md mx-auto">
            The AI will analyze your data and design a bespoke CIM with
            charts, infographics, financial tables, and dynamic layouts — not
            just text.
          </p>
          {blockReason && (
            <p className="text-xs text-red-400 mb-3" data-testid="text-generate-blocked">
              {blockReason}
            </p>
          )}
          {!blockReason && infoBlockReason && (
            <p className="text-xs text-amber-500 mb-3 max-w-md mx-auto" data-testid="text-generate-needs-information">
              {infoBlockReason}
            </p>
          )}
          {!blockReason && !infoBlockReason && infoGate.allowed && !deal.interviewCompleted && (
            <p className="text-xs text-muted-foreground mb-3 max-w-md mx-auto" data-testid="text-generate-without-interview">
              The seller interview isn't finished — the CIM will be written from what you've collected so far. You can regenerate after the interview.
            </p>
          )}
          {generation.isRunning ? (
            <CimGenerationProgress view={generation} className="max-w-md mx-auto" />
          ) : (
            <>
              {generation.job?.status === "failed" && (
                <CimGenerationProgress view={generation} className="max-w-md mx-auto mb-3" />
              )}
              <Button
                className="bg-teal text-teal-foreground hover:bg-teal/90"
                onClick={() => generate.mutate()}
                disabled={generate.isPending || generationBlocked || !infoGate.allowed}
                title={blockReason ?? infoBlockReason ?? undefined}
                data-testid="button-generate-content"
              >
                {generate.isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Starting…
                  </>
                ) : generation.job?.status === "failed" ? (
                  "Try again"
                ) : (
                  "Generate CIM"
                )}
              </Button>
              {!blockReason && <DiscrepancyCheckNotice dealId={dealId} className="mt-3" />}
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">
            Your CIM
          </h2>
          <p className="text-sm text-muted-foreground mt-0.5">
            {hasVisualSections
              ? `${cimSections.length} section${cimSections.length === 1 ? "" : "s"} · Edit, add and rearrange them in the CIM builder`
              : "Legacy text CIM — regenerate to enable visual editing"}
          </p>
          {readiness && <CimReadinessBadge readiness={readiness} className="mt-1" />}
          {blockReason && (
            <p className="text-xs text-red-400 mt-1" data-testid="text-regenerate-blocked">
              {blockReason.replace(/before generating\.$/, "before regenerating.")}
            </p>
          )}
          {!blockReason && infoBlockReason && (
            <p className="text-xs text-amber-500 mt-1 max-w-xl" data-testid="text-regenerate-needs-information">
              Regenerating is off for now. {infoBlockReason} You can still edit, approve and advance this CIM.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end">
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
                // Approvals and the move to Design share the generate gate —
                // a CIM with open critical conflicts must not get closer to
                // buyers. The server 409s on the same condition.
                disabled={advancePhase.isPending || generationBlocked}
                title={reasonFor("advancing to Design") ?? undefined}
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
              disabled={approve.isPending || generationBlocked}
              title={reasonFor("approving") ?? undefined}
              data-testid="button-content-approve-seller"
            >
              Approve as Seller
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              className="h-8 text-xs"
              onClick={() => approve.mutate("broker")}
              disabled={approve.isPending || generationBlocked}
              title={reasonFor("approving") ?? undefined}
              data-testid="button-content-approve-broker"
            >
              Approve as Broker
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs text-muted-foreground gap-1.5"
            // Destructive: rebuilds every section and discards edits,
            // approvals and the Blind/DD versions — always confirm first.
            onClick={() => setRegenConfirmOpen(true)}
            // Same gate as the first Generate button — critical discrepancies
            // block every generation, not just the first.
            disabled={generate.isPending || generation.isRunning || generationBlocked || !infoGate.allowed}
            title={blockReason ?? infoBlockReason ?? undefined}
            data-testid="button-regenerate-content"
          >
            <RefreshCw
              className={`h-3 w-3 ${generate.isPending || generation.isRunning ? "animate-spin" : ""}`}
            />
            Regenerate All
          </Button>
        </div>
      </div>

      {(generation.isRunning || generation.job?.status === "failed") && (
        <CimGenerationProgress view={generation} />
      )}
      {!generation.isRunning && !blockReason && <DiscrepancyCheckNotice dealId={dealId} className="sm:justify-end" />}

      <AlertDialog open={regenConfirmOpen} onOpenChange={setRegenConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate the entire CIM?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  This rebuilds every section from scratch. The following will be
                  permanently discarded and cannot be undone:
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>All edited section content and data</li>
                  <li>Section approvals, hidden/visible choices and custom order</li>
                  <li>Any generated Blind and DD versions</li>
                </ul>
                <p>To redo one section, hover it and choose Regenerate instead.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current CIM</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setRegenConfirmOpen(false);
                generate.mutate();
              }}
              data-testid="button-regenerate-confirm"
            >
              Discard and regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* The message above says "resolve N critical discrepancies" — give the
          broker the panel to resolve them (or take one back from the seller)
          right here instead of sending them hunting for it. */}
      {/* Also after a run stopped to show new conflicts — the broker reviews them right here. */}
      {(generationBlocked || (!generation.isRunning && generation.job?.stoppedBy === "discrepancies")) && (
        discrepanciesError ? (
          <PanelError what="discrepancies" onRetry={() => refetchDiscrepancies()} />
        ) : (
          <DiscrepancyPanel dealId={dealId} />
        )
      )}

      {hasVisualSections ? (
        // The CIM builder is the one editor for sections (add, delete,
        // reorder, rewrite with AI, access tiers) — Overview shows a summary.
        <CimSummaryCard dealId={dealId} />
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
  // Same gate as Phase 3: design approvals and Publish stay locked while a
  // critical discrepancy is unresolved (the server 409s on the same rule).
  const {
    discrepanciesError,
    refetchDiscrepancies,
    blocked: publishBlocked,
    reasonFor,
  } = useDiscrepancyGate(dealId);

  const publish = useMutation({
    mutationFn: () =>
      apiJson("PATCH", `/api/deals/${dealId}`, { isLive: true }, "Couldn't publish the CIM"),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({
        title: "CIM published",
        description: "Now live for invited buyers.",
      });
    },
    onError: (e: Error) =>
      toast({
        title: "Publish failed",
        description: e.message,
        variant: "destructive",
      }),
  });

  const designApprove = useMutation({
    mutationFn: (role: "broker" | "seller") =>
      apiJson(
        "PATCH",
        `/api/deals/${dealId}`,
        role === "broker"
          ? { designApprovedByBroker: true }
          : { designApprovedBySeller: true },
        "Couldn't record the approval",
      ),
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
          Open CIM builder
        </Button>
      </div>
      {publishBlocked && (
        <div className="space-y-3">
          <p className="text-xs text-red-400" data-testid="text-publish-blocked">
            {reasonFor("approving or publishing")}
          </p>
          {discrepanciesError ? (
            <PanelError what="discrepancies" onRetry={() => refetchDiscrepancies()} />
          ) : (
            <DiscrepancyPanel dealId={dealId} />
          )}
        </div>
      )}
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
                disabled={designApprove.isPending || publishBlocked}
                title={reasonFor("approving the design") ?? undefined}
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
              disabled={publish.isPending || publishBlocked}
              title={reasonFor("publishing") ?? undefined}
              data-testid="button-publish-cim"
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
  const { toast } = useToast();
  // Deletion is permanent and the trash icon only appears on hover — always
  // confirm before removing an uploaded financial document.
  const [pendingDelete, setPendingDelete] = useState<DocType | null>(null);

  const { data: documents = [], error: docsError, refetch: refetchDocs } = useQuery<DocType[]>({
    queryKey: ["/api/deals", dealId, "documents"],
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/documents`);
      if (!r.ok) throw new Error("Failed to load documents");
      return r.json();
    },
    refetchInterval: (query) =>
      query.state.data?.some(isDocProcessing) ? DOC_POLL_MS : false,
  });

  const deleteDoc = useMutation({
    mutationFn: (doc: DocType) =>
      apiJson("DELETE", `/api/documents/${doc.id}`, undefined, "Couldn't delete the document"),
    onSuccess: (_, doc) => {
      queryClient.invalidateQueries({
        queryKey: ["/api/deals", dealId, "documents"],
      });
      setPendingDelete(null);
      toast({ title: "Document deleted", description: doc.name });
    },
    onError: (e: Error) =>
      toast({
        title: "Delete failed",
        description: e.message,
        variant: "destructive",
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
                        ? "bg-success-muted text-success-muted-foreground"
                        : (doc.status as string) === "parsing"
                          ? "bg-amber-500/10 text-amber-600"
                          : "bg-muted text-muted-foreground"
                    }`}
                  >
                    {doc.status}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <button
                    onClick={() => setPendingDelete(doc)}
                    className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                    aria-label={`Delete ${doc.name}`}
                    data-testid={`button-delete-document-${doc.id}`}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <AlertDialog
        open={!!pendingDelete}
        onOpenChange={(open) => {
          if (!open && !deleteDoc.isPending) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this document?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.name
                ? `"${pendingDelete.name}" and any data extracted from it will be permanently removed from this deal. This cannot be undone.`
                : "This document will be permanently removed from this deal. This cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteDoc.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteDoc.isPending}
              onClick={(e) => {
                // Keep the dialog open while the request runs so a failure
                // can be shown in place.
                e.preventDefault();
                if (pendingDelete) deleteDoc.mutate(pendingDelete);
              }}
              data-testid="button-confirm-delete-document"
            >
              {deleteDoc.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Deleting...
                </>
              ) : (
                "Delete"
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/* ═══════════════════════════════════════════
   OVERVIEW TAB — Phase accordion + documents
═══════════════════════════════════════════ */
/** A request (from the DealShell header stepper) to open and scroll to a phase. */
export interface PhaseFocus {
  key: string;
  /** Changes on every click so re-clicking the same phase re-scrolls. */
  nonce: number;
}

export function OverviewTab({ phaseFocus }: { phaseFocus?: PhaseFocus | null } = {}) {
  const { deal, dealId } = useDeal();
  const [, setLocation] = useLocation();
  // Open/closed per phase. The current phase starts open and every other one
  // closed, but all of them can be toggled — including the current one.
  const [phaseOpen, setPhaseOpen] = useState<Record<string, boolean>>({});
  const isPhaseOpen = (key: string) => phaseOpen[key] ?? deal.phase === key;
  // Header stepper → expand the target phase, then scroll once it has
  // rendered. Runs here (not on a timer in DealShell) so it also works when
  // the click navigated from another tab and this component mounted later.
  const pendingScrollRef = useRef<string | null>(null);
  useEffect(() => {
    if (!phaseFocus) return;
    pendingScrollRef.current = phaseFocus.key;
    setPhaseOpen((prev) => (prev[phaseFocus.key] ? prev : { ...prev, [phaseFocus.key]: true }));
  }, [phaseFocus]);
  useEffect(() => {
    const key = pendingScrollRef.current;
    if (!key) return;
    // Wait for the card to actually be open so we scroll to the expanded
    // content, not a collapsed header.
    if (!isPhaseOpen(key)) return;
    const el = document.getElementById(`phase-section-${key}`);
    if (!el) return;
    pendingScrollRef.current = null;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  // Set by the Calls tile to pop the shared Add source dialog pre-configured.
  const [uploadSignal, setUploadSignal] = useState<AddSourcePreset | null>(null);

  const { data: invites = [], error: invitesError } = useInvites(dealId);
  const currentPhaseIdx = getPhaseIndex(deal.phase);
  // A CIM made only in the builder (sections, no generation stamp) is still
  // a draft — the checklist counts it like the deal list does. Only fetched
  // when the deal row alone can't tell.
  const needsSectionCount =
    (deal.phase === "phase3_content_creation" || deal.phase === "phase4_design_finalization") &&
    !deal.cimContent && !deal.cimLayoutGeneratedAt;
  const { data: checklistSections } = useQuery<CimSection[]>({
    queryKey: ["/api/deals", dealId, "cim-sections"],
    enabled: needsSectionCount,
    queryFn: async () => {
      const r = await fetch(`/api/deals/${dealId}/cim-sections`, { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load CIM sections");
      return r.json();
    },
  });
  const checklistGeneration = useCimGeneration(dealId);

  const phaseComponents: Record<string, React.ReactNode> = {
    phase1_info_collection: <Phase1Center />,
    phase2_platform_intake: <Phase2Center />,
    phase3_content_creation: <Phase3Center />,
    phase4_design_finalization: <Phase4Center />,
  };

  const togglePhase = (key: string) => {
    setPhaseOpen((prev) => ({ ...prev, [key]: !(prev[key] ?? deal.phase === key) }));
  };

  return (
    <div className="max-w-4xl mx-auto px-6 py-6 space-y-3">
      {PHASES.map((phase, idx) => {
        const isCurrentPhase = deal.phase === phase.key;
        const isComplete = currentPhaseIdx > idx;
        const isExpanded = isPhaseOpen(phase.key);
        // On a failed invites fetch, fall back to questionnaire evidence
        // (phases.ts) rather than asserting "not invited".
        const items = phase.items(deal, {
          invited: invitesError ? undefined : invites.length > 0,
          hasCimSections: checklistSections ? checklistSections.length > 0 : undefined,
          cimGenerating: checklistGeneration.isRunning,
        });
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
            <div className="flex items-center rounded-lg hover:bg-muted/30 transition-colors">
            <button
              onClick={() => togglePhase(phase.key)}
              aria-expanded={isExpanded}
              className="flex-1 min-w-0 flex items-center gap-3 px-4 py-3 text-left cursor-pointer rounded-lg"
              data-testid={`phase-toggle-${phase.key}`}
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

            </button>
            {phase.key === "phase3_content_creation" && (
              <button
                type="button"
                onClick={() => setLocation(`/deal/${dealId}/information`)}
                className="shrink-0 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-teal hover:bg-teal/10 transition-colors"
                data-testid="link-phase3-collected-information"
              >
                <Library className="h-3 w-3" />
                <span className="hidden sm:inline">Collected information</span>
                <span className="sm:hidden">Information</span>
                <ArrowRight className="h-3 w-3" />
              </button>
            )}
            <button
              type="button"
              onClick={() => togglePhase(phase.key)}
              aria-label={isExpanded ? `Collapse ${phase.label}` : `Expand ${phase.label}`}
              className="shrink-0 p-2 mr-2 rounded-md text-muted-foreground hover:text-foreground"
            >
              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </button>
            </div>

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
          <CrmLinkCard dealId={dealId} variant="compact" />
          <DocumentUploadCard openSignal={uploadSignal} />
          <IntegrationPromptCard
            onOpenTranscripts={() =>
              setUploadSignal({
                kind: "call",
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
