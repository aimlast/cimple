/**
 * SellerDocuments — Document checklist and upload page for sellers.
 *
 * Route: /seller/:token/documents (rendered inside SellerLayout)
 * Shows required vs uploaded documents based on deal_document_requirements.
 * Sellers upload files and match them to requirements.
 */
import { useState, useRef, useCallback } from "react";
import { useParams, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  HelpCircle,
  RefreshCw,
  Upload,
  X,
} from "lucide-react";
import { Textarea } from "@/components/ui/textarea";
import { sellerUnavailableReason, withoutSellerUnavailableNote } from "@shared/seller-portal";
import { GL_REQUIREMENT_NAME } from "@shared/gl-copy";
import { SellerGlRow } from "@/components/gl/SellerGlRow";

interface DocRequirement {
  id: string;
  name: string;
  category: string;
  isRequired: boolean;
  /** "unavailable" = the seller told their broker they don't have it. */
  status: "missing" | "uploaded" | "verified" | "unavailable";
  notes: string | null;
  uploadedFileId?: string | null;
  uploadedFileName?: string | null;
  uploadedBy?: "broker" | "seller" | null;
  uploadedAt?: string | null;
}

interface UploadedDoc {
  id: string;
  name: string;
  linkedRequirement?: { id: string; documentName: string; category: string } | null;
}

interface SellerProgressData {
  businessName: string;
  documents: {
    requiredTotal: number;
    requiredUploaded: number;
    requiredUnavailable?: number;
    percentage: number;
    totalUploaded: number;
    requirements: DocRequirement[];
  };
  /** The conversation's to-dos — the documents it asked for are rows here. */
  todo?: Array<{ id: string; kind: "document" | "follow_up"; title: string }>;
}

/** Where a picked file goes: a checklist row, or a document the conversation asked for. */
type UploadTarget = { requirementId?: string; taskId?: string };

const CATEGORY_LABELS: Record<string, string> = {
  financial: "Financial",
  legal: "Legal",
  operational: "Operational",
  tax: "Tax",
  compliance: "Compliance",
};

const CATEGORY_ORDER = ["financial", "tax", "legal", "compliance", "operational"];

export default function SellerDocuments() {
  const { token } = useParams<{ token: string }>();
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploadingFor, setUploadingFor] = useState<UploadTarget | null>(null);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  // "I don't have this" — the row whose note is open, and the note.
  const [unavailableFor, setUnavailableFor] = useState<string | null>(null);
  const [unavailableReason, setUnavailableReason] = useState("");
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(CATEGORY_ORDER),
  );

  // Get invite data for dealId
  const {
    data: inviteData,
    isLoading: isLoadingInvite,
    error: inviteError,
    refetch: refetchInvite,
    isFetching: isFetchingInvite,
  } = useQuery<{ invite: any; deal: any }>({
    queryKey: ["/api/invites", token],
    enabled: !!token,
  });
  const dealId = inviteData?.deal?.id;
  const { toast } = useToast();

  // Get progress data with document requirements
  const {
    data: progress,
    isLoading: isLoadingProgress,
    error: progressError,
    refetch: refetchProgress,
    isFetching: isFetchingProgress,
  } = useQuery<SellerProgressData>({
    queryKey: [`/api/seller/${token}/progress`],
    enabled: !!token,
  });
  const isLoading = isLoadingInvite || isLoadingProgress;
  const isRetrying = isFetchingInvite || isFetchingProgress;
  // Either query can be the one that failed, so a retry must refetch both —
  // refetching only progress left an invite-query error stuck on screen.
  const retryLoad = () => Promise.all([refetchInvite(), refetchProgress()]);

  const sellerHeaders = (): Record<string, string> => (token ? { "X-Seller-Token": token } : {});
  const refreshProgress = () =>
    queryClient.invalidateQueries({ queryKey: [`/api/seller/${token}/progress`] });

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: async ({ file, requirementId, taskId }: { file: File; requirementId?: string; taskId?: string }) => {
      if (!dealId) throw new Error("No deal ID");

      // 1. Upload the file. Naming the checklist row lets the server link
      //    it, derive the document category from it, and replace an earlier
      //    upload of ours on the same row in one step. A document the
      //    conversation asked for closes that request.
      const formData = new FormData();
      formData.append("file", file);
      if (requirementId) formData.append("requirementId", requirementId);
      if (taskId) formData.append("taskId", taskId);
      const uploadRes = await fetch(`/api/deals/${dealId}/documents/upload`, {
        method: "POST",
        headers: sellerHeaders(),
        body: formData,
      });
      if (!uploadRes.ok) {
        const body = await uploadRes.json().catch(() => ({}));
        throw new Error(body.error || `"${file.name}" could not be uploaded`);
      }
      const doc = (await uploadRes.json()) as UploadedDoc;

      // 2. Explicit link only if the server didn't already do it.
      if (requirementId && !doc.linkedRequirement) {
        const patchRes = await fetch(`/api/deals/${dealId}/document-requirements/${requirementId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json", ...sellerHeaders() },
          body: JSON.stringify({
            status: "uploaded",
            uploadedFileId: doc.id,
            uploadedBy: "seller",
          }),
        });
        if (!patchRes.ok) {
          const body = await patchRes.json().catch(() => ({}));
          throw new Error(
            body.error ||
              `"${file.name}" was uploaded but could not be matched to the checklist item`,
          );
        }
      }

      const matchedName =
        doc.linkedRequirement?.documentName ??
        (requirementId
          ? progress?.documents.requirements.find((r) => r.id === requirementId)?.name
          : taskId
            ? progress?.todo?.find((t) => t.id === taskId)?.title
            : undefined);
      return { doc, file, matchedName };
    },
    onSuccess: ({ file, matchedName }) => {
      refreshProgress();
      setUploadingFor(null);
      toast({
        title: "Uploaded",
        description: matchedName
          ? `"${file.name}" now covers "${matchedName}". Your broker will review it.`
          : `"${file.name}" is saved for your broker to review.`,
      });
    },
    onError: (err: Error) => {
      setUploadingFor(null);
      // Refresh so a file that landed but failed to link still shows up.
      queryClient.invalidateQueries({ queryKey: [`/api/seller/${token}/progress`] });
      // Silent-failure fix: unsupported/oversized files used to just vanish
      toast({
        title: "Upload failed",
        description: err.message + " Accepted formats: PDF, Excel, Word (.docx), PowerPoint (.pptx), CSV, text — up to 20MB.",
        variant: "destructive",
      });
    },
  });

  // Taking a file back off a row. The server deletes our own upload with it;
  // a broker's file is only unlinked.
  const removeMutation = useMutation({
    mutationFn: async (req: DocRequirement) => {
      if (!dealId) throw new Error("No deal ID");
      const res = await fetch(`/api/deals/${dealId}/document-requirements/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...sellerHeaders() },
        body: JSON.stringify({ status: "missing" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `Couldn't remove "${req.uploadedFileName ?? "the file"}"`);
      }
      return req;
    },
    onSuccess: (req) => {
      refreshProgress();
      setConfirmRemoveId(null);
      toast({
        title: "Removed",
        description: req.uploadedFileName
          ? `"${req.uploadedFileName}" is off "${req.name}". Upload a replacement when ready.`
          : `"${req.name}" is open again.`,
      });
    },
    onError: (err: Error) => {
      setConfirmRemoveId(null);
      toast({ title: "Couldn't remove", description: err.message, variant: "destructive" });
    },
  });

  // "I don't have this — tell my broker": the row stops counting against the
  // seller, and the broker decides (not needed, or ask again). Also undone.
  const unavailableMutation = useMutation({
    mutationFn: async ({ req, unavailable, reason }: { req: DocRequirement; unavailable: boolean; reason?: string }) => {
      if (!dealId) throw new Error("No deal ID");
      const res = await fetch(`/api/deals/${dealId}/document-requirements/${req.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...sellerHeaders() },
        body: JSON.stringify(unavailable ? { status: "unavailable", reason: reason ?? "" } : { status: "missing" }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || "Couldn't tell your broker");
      }
      return { req, unavailable };
    },
    onSuccess: ({ req, unavailable }) => {
      refreshProgress();
      setUnavailableFor(null);
      setUnavailableReason("");
      toast(
        unavailable
          ? { title: "Your broker will see it", description: `"${req.name}" no longer holds you up — your broker decides whether it's needed.` }
          : { title: "Back on your list", description: `"${req.name}" is open again.` },
      );
    },
    onError: (err: Error) => toast({ title: "Couldn't save that", description: err.message, variant: "destructive" }),
  });

  // Best-effort match of a dropped file to an open checklist requirement by
  // name/category keywords, so a drag-and-dropped "2023 Tax Return.pdf"
  // counts toward "Tax Returns (3 Years)" instead of silently not counting.
  const guessRequirement = useCallback(
    (file: File): string | undefined => {
      const open = (progress?.documents.requirements ?? []).filter(
        (r) => r.status === "missing",
      );
      if (open.length === 0) return undefined;
      const name = file.name.toLowerCase();
      const scored = open
        .map((r) => {
          const words = r.name
            .toLowerCase()
            .split(/[^a-z0-9]+/)
            .filter((w: string) => w.length >= 3 && !["the", "and", "years", "year", "months", "current"].includes(w));
          const hits = words.filter((w: string) => name.includes(w)).length;
          return { id: r.id, hits };
        })
        .sort((a, b) => b.hits - a.hits);
      return scored[0] && scored[0].hits > 0 ? scored[0].id : undefined;
    },
    [progress],
  );

  const handleFileSelect = useCallback(
    (files: FileList | null, target?: UploadTarget) => {
      if (!files || files.length === 0) return;
      for (const file of Array.from(files)) {
        if (target?.taskId) {
          uploadMutation.mutate({ file, taskId: target.taskId });
          continue;
        }
        uploadMutation.mutate({ file, requirementId: target?.requirementId ?? guessRequirement(file) });
      }
    },
    [uploadMutation, guessRequirement],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      handleFileSelect(e.dataTransfer.files);
    },
    [handleFileSelect],
  );

  const toggleCategory = (cat: string) => {
    setExpandedCategories((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="p-6 max-w-3xl mx-auto space-y-6">
        <div className="h-8 w-48 bg-muted animate-pulse rounded" />
        <div className="h-24 bg-muted animate-pulse rounded-lg" />
        <div className="h-64 bg-muted animate-pulse rounded-lg" />
      </div>
    );
  }

  // Error states — distinct from "no requirements yet". A 404 means the
  // invite link itself is bad; anything else is transient and retryable.
  const loadError = inviteError || progressError;
  if (!token || loadError || !inviteData?.deal || !progress) {
    const isInvalidLink =
      !token ||
      (loadError instanceof Error && /^404:/.test(loadError.message)) ||
      (!loadError && !inviteData?.deal);
    return (
      <div className="p-6 max-w-3xl mx-auto">
        <div className="rounded-lg border border-border bg-card p-8 text-center space-y-3">
          <AlertCircle className="h-8 w-8 mx-auto text-destructive/70" />
          {isInvalidLink ? (
            <>
              <h2 className="text-lg font-semibold">Invalid invite link</h2>
              <p className="text-sm text-muted-foreground">
                This invite link is not valid or has expired. Contact your broker for a new link.
              </p>
            </>
          ) : (
            <>
              <h2 className="text-lg font-semibold">Couldn't load your document checklist</h2>
              <p className="text-sm text-muted-foreground">
                {loadError instanceof Error
                  ? loadError.message.replace(/^\d{3}:\s*/, "")
                  : "Something went wrong while loading."}
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={isRetrying}
                onClick={() => void retryLoad()}
                data-testid="button-retry-documents"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-2 ${isRetrying ? "animate-spin" : ""}`} />
                Try again
              </Button>
            </>
          )}
        </div>
      </div>
    );
  }

  const requirements = progress.documents?.requirements || [];
  const docs = progress.documents;
  const requestedDocs = (progress.todo ?? []).filter((t) => t.kind === "document");

  // Group by category
  const grouped = CATEGORY_ORDER.map((cat) => ({
    category: cat,
    label: CATEGORY_LABELS[cat] || cat,
    items: requirements.filter((r) => r.category === cat),
  })).filter((g) => g.items.length > 0);

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/seller/${token}/progress`}>
          <div className="h-8 w-8 rounded-lg border border-border flex items-center justify-center hover:bg-muted/50 cursor-pointer transition-colors">
            <ArrowLeft className="h-4 w-4 text-muted-foreground" />
          </div>
        </Link>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Documents</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Upload the documents your broker needs to build your CIM.
          </p>
        </div>
      </div>

      {/* Progress summary */}
      {docs && docs.requiredTotal > 0 && (
        <div className="rounded-lg border border-border bg-card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-sm">
              {docs.requiredUploaded} of {docs.requiredTotal} required documents
              {(docs.requiredUnavailable ?? 0) > 0 && (
                <span className="text-muted-foreground"> · {docs.requiredUnavailable} you don't have</span>
              )}
            </span>
            <span className="text-xs text-muted-foreground">{docs.percentage}%</span>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-teal rounded-full transition-all duration-500"
              style={{ width: `${docs.percentage}%` }}
            />
          </div>
        </div>
      )}

      {/* Drop zone for general uploads */}
      <div
        className={`rounded-lg border-2 border-dashed p-8 text-center transition-colors ${
          isDragging
            ? "border-teal bg-teal/5"
            : "border-border hover:border-teal/30"
        }`}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
      >
        <Upload className="h-8 w-8 mx-auto text-muted-foreground/50 mb-3" />
        <p className="text-sm text-muted-foreground mb-2">
          Drag and drop files here, or{" "}
          <button
            className="text-teal hover:underline"
            onClick={() => {
              setUploadingFor(null);
              fileInputRef.current?.click();
            }}
          >
            browse
          </button>
        </p>
        <p className="text-xs text-muted-foreground/60">
          PDF, Excel, Word (.docx), PowerPoint (.pptx), CSV — up to 20MB
        </p>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          accept=".pdf,.xlsx,.xls,.docx,.pptx,.csv,.txt,.md"
          onChange={(e) => {
            handleFileSelect(e.target.files, uploadingFor ?? undefined);
            // Reset so re-selecting the same file (retry, or assigning it to
            // a second checklist row) fires onChange again.
            e.target.value = "";
          }}
        />
      </div>

      {/* Upload status */}
      {uploadMutation.isPending && (
        <div className="rounded-lg border border-teal/20 bg-teal/5 p-3 flex items-center gap-3">
          <div className="h-4 w-4 border-2 border-teal border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Uploading...</span>
        </div>
      )}

      {/* Documents the conversation asked for — upload to answer the request */}
      {requestedDocs.length > 0 && (
        <div className="space-y-3" data-testid="section-requested-in-conversation">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Asked for in your conversation
          </h2>
          <div className="rounded-lg border border-border bg-card divide-y divide-border">
            {requestedDocs.map((t) => (
              <div key={t.id} className="px-4 py-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between" data-testid={`requested-doc-${t.id}`}>
                <div className="flex items-start gap-3 min-w-0">
                  <div className="h-5 w-5 rounded-full border border-border shrink-0 mt-0.5" />
                  <p className="text-sm break-words line-clamp-2">{t.title}</p>
                </div>
                <div className="flex items-center gap-3 pl-8 sm:pl-0 shrink-0">
                  <button
                    className="text-xs text-teal hover:underline flex items-center gap-1"
                    onClick={() => {
                      setUploadingFor({ taskId: t.id });
                      fileInputRef.current?.click();
                    }}
                    data-testid={`button-upload-requested-${t.id}`}
                  >
                    <Upload className="h-3 w-3" />
                    Upload
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Requirements checklist by category */}
      {grouped.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Document Checklist
          </h2>
          {grouped.map((group) => (
            <div key={group.category} className="rounded-lg border border-border bg-card overflow-hidden">
              {/* Category header */}
              <button
                className="w-full flex items-center justify-between px-4 py-3 hover:bg-muted/30 transition-colors"
                onClick={() => toggleCategory(group.category)}
              >
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{group.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {group.items.filter((i) => i.status !== "missing").length}/{group.items.length}
                  </span>
                </div>
                {expandedCategories.has(group.category) ? (
                  <ChevronDown className="h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                )}
              </button>

              {/* Items — on a phone the actions sit under the name, so the
                  name is never cut to "Fi…" and "Required" stays readable. */}
              {expandedCategories.has(group.category) && (
                <div className="border-t border-border divide-y divide-border">
                  {group.items.map((req) => {
                    // The general ledger: uploaded through the ledger reader, its status set by it (gl spec §3.1).
                    if (req.name === GL_REQUIREMENT_NAME && token) {
                      return <SellerGlRow key={req.id} token={token} name={req.name} isRequired={req.isRequired} />;
                    }
                    const reason = req.status === "unavailable" ? sellerUnavailableReason(req.notes) : null;
                    const brokerNote = withoutSellerUnavailableNote(req.notes);
                    const openUpload = () => {
                      setUploadingFor({ requirementId: req.id });
                      fileInputRef.current?.click();
                    };
                    return (
                      <div key={req.id} className="px-4 py-3" data-testid={`requirement-row-${req.id}`}>
                        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
                          <div className="flex items-start gap-3 min-w-0">
                            {req.status === "verified" ? (
                              <div className="h-5 w-5 rounded-full bg-teal/15 flex items-center justify-center shrink-0 mt-0.5">
                                <Check className="h-3 w-3 text-teal" />
                              </div>
                            ) : req.status === "uploaded" ? (
                              <div className="h-5 w-5 rounded-full bg-amber-400/15 flex items-center justify-center shrink-0 mt-0.5">
                                <Clock className="h-3 w-3 text-amber-500" />
                              </div>
                            ) : req.status === "unavailable" ? (
                              <div className="h-5 w-5 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                                <HelpCircle className="h-3 w-3 text-muted-foreground" />
                              </div>
                            ) : (
                              <div className="h-5 w-5 rounded-full border border-border shrink-0 mt-0.5" />
                            )}
                            <div className="min-w-0">
                              <p className="text-sm break-words line-clamp-2">
                                {req.name}
                                {req.isRequired && req.status === "missing" && (
                                  <span className="text-xs text-destructive ml-1.5 whitespace-nowrap">Required</span>
                                )}
                              </p>
                              {req.status !== "missing" && req.status !== "unavailable" && req.uploadedFileName && (
                                <p className="text-xs text-muted-foreground mt-0.5 flex items-start gap-1 min-w-0">
                                  <FileText className="h-3 w-3 shrink-0 mt-0.5" />
                                  <span className="min-w-0 break-words line-clamp-2">
                                    {req.uploadedFileName}
                                    {req.uploadedBy === "broker" && (
                                      <span className="text-muted-foreground/60 whitespace-nowrap"> · added by your broker</span>
                                    )}
                                  </span>
                                </p>
                              )}
                              {req.status === "unavailable" && (
                                <p className="text-xs text-muted-foreground mt-0.5 break-words">
                                  You told your broker you don't have this — they'll let you know if it's still needed.{reason ? ` Your note: “${reason}”` : ""}
                                </p>
                              )}
                              {brokerNote && (
                                <p className="text-xs text-muted-foreground mt-0.5 break-words">{brokerNote}</p>
                              )}
                            </div>
                          </div>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-8 sm:pl-0 sm:shrink-0">
                            {req.status === "missing" ? (
                              <>
                                <button className="text-xs text-teal hover:underline flex items-center gap-1" onClick={openUpload} data-testid={`button-upload-${req.id}`}>
                                  <Upload className="h-3 w-3" />
                                  Upload
                                </button>
                                <button
                                  className="text-xs text-muted-foreground hover:text-foreground"
                                  onClick={() => {
                                    setUnavailableFor(unavailableFor === req.id ? null : req.id);
                                    setUnavailableReason("");
                                  }}
                                  data-testid={`button-dont-have-${req.id}`}
                                >
                                  I don't have this
                                </button>
                              </>
                            ) : req.status === "unavailable" ? (
                              <>
                                <button className="text-xs text-teal hover:underline flex items-center gap-1" onClick={openUpload}>
                                  <Upload className="h-3 w-3" />
                                  Found it — upload
                                </button>
                                <button
                                  className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                                  disabled={unavailableMutation.isPending}
                                  onClick={() => unavailableMutation.mutate({ req, unavailable: false })}
                                >
                                  Undo
                                </button>
                              </>
                            ) : req.status === "uploaded" ? (
                              confirmRemoveId === req.id ? (
                                <>
                                  <span className="text-xs text-muted-foreground">Remove this file?</span>
                                  <button
                                    className="text-xs text-destructive hover:underline disabled:opacity-50"
                                    disabled={removeMutation.isPending}
                                    onClick={() => removeMutation.mutate(req)}
                                    data-testid={`button-confirm-remove-${req.id}`}
                                  >
                                    Remove
                                  </button>
                                  <button
                                    className="text-xs text-muted-foreground hover:underline"
                                    onClick={() => setConfirmRemoveId(null)}
                                  >
                                    Keep
                                  </button>
                                </>
                              ) : (
                                <>
                                  <span className="text-xs text-amber-500">Waiting for your broker's review</span>
                                  <button
                                    className="text-xs text-teal hover:underline flex items-center gap-1"
                                    onClick={openUpload}
                                    data-testid={`button-replace-${req.id}`}
                                  >
                                    <RefreshCw className="h-3 w-3" />
                                    Replace
                                  </button>
                                  <button
                                    className="text-xs text-muted-foreground hover:text-destructive flex items-center gap-1"
                                    onClick={() => setConfirmRemoveId(req.id)}
                                    aria-label={`Remove ${req.uploadedFileName ?? "file"}`}
                                    data-testid={`button-remove-${req.id}`}
                                  >
                                    <X className="h-3 w-3" />
                                    Remove
                                  </button>
                                </>
                              )
                            ) : (
                              <span className="text-xs text-teal">Verified</span>
                            )}
                          </div>
                        </div>
                        {unavailableFor === req.id && req.status === "missing" && (
                          <div className="mt-2 pl-8 space-y-2" data-testid={`form-dont-have-${req.id}`}>
                            <Textarea
                              value={unavailableReason}
                              onChange={(e) => setUnavailableReason(e.target.value)}
                              rows={2}
                              maxLength={500}
                              className="text-sm"
                              placeholder="Optional — e.g. “We own the building, so there's no lease” or “We have no debt”"
                            />
                            <div className="flex flex-wrap gap-2">
                              <Button
                                size="sm"
                                className="bg-teal text-teal-foreground hover:bg-teal/90"
                                disabled={unavailableMutation.isPending}
                                onClick={() => unavailableMutation.mutate({ req, unavailable: true, reason: unavailableReason })}
                                data-testid={`button-tell-broker-${req.id}`}
                              >
                                Tell my broker
                              </Button>
                              <Button size="sm" variant="ghost" onClick={() => setUnavailableFor(null)}>
                                Cancel
                              </Button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Empty state when no requirements exist */}
      {grouped.length === 0 && requestedDocs.length === 0 && (
        <div className="rounded-lg border border-border bg-card p-8 text-center">
          <FileText className="h-8 w-8 mx-auto text-muted-foreground/40 mb-3" />
          <p className="text-sm text-muted-foreground">
            No specific documents have been requested yet. You can still upload files above — they'll be available for your broker to review.
          </p>
        </div>
      )}
    </div>
  );
}
