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
import {
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  FileText,
  Upload,
  X,
} from "lucide-react";

interface DocRequirement {
  id: string;
  name: string;
  category: string;
  isRequired: boolean;
  status: "missing" | "uploaded" | "verified";
  notes: string | null;
}

interface SellerProgressData {
  businessName: string;
  documents: {
    requiredTotal: number;
    requiredUploaded: number;
    percentage: number;
    totalUploaded: number;
    requirements: DocRequirement[];
  };
}

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
  const [uploadingFor, setUploadingFor] = useState<string | null>(null);
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(
    new Set(CATEGORY_ORDER),
  );

  // Get invite data for dealId
  const { data: inviteData } = useQuery<{ invite: any; deal: any }>({
    queryKey: ["/api/invites", token],
    enabled: !!token,
  });
  const dealId = inviteData?.deal?.id;

  // Get progress data with document requirements
  const { data: progress, isLoading } = useQuery<SellerProgressData>({
    queryKey: [`/api/seller/${token}/progress`],
    enabled: !!token,
  });

  // Upload mutation
  const uploadMutation = useMutation({
    mutationFn: async ({ file, requirementId }: { file: File; requirementId?: string }) => {
      if (!dealId) throw new Error("No deal ID");

      // 1. Upload the file
      const formData = new FormData();
      formData.append("file", file);
      const uploadRes = await fetch(`/api/deals/${dealId}/documents/upload`, {
        method: "POST",
        body: formData,
      });
      if (!uploadRes.ok) throw new Error("Upload failed");
      const doc = await uploadRes.json();

      // 2. If matching a requirement, link them
      if (requirementId) {
        await fetch(`/api/deals/${dealId}/document-requirements/${requirementId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: "uploaded",
            uploadedFileId: doc.id,
            uploadedBy: "seller",
            uploadedAt: new Date().toISOString(),
          }),
        });
      }

      return doc;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: [`/api/seller/${token}/progress`] });
      setUploadingFor(null);
    },
  });

  const handleFileSelect = useCallback(
    (files: FileList | null, requirementId?: string) => {
      if (!files || files.length === 0) return;
      for (const file of Array.from(files)) {
        uploadMutation.mutate({ file, requirementId });
      }
    },
    [uploadMutation],
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

  const requirements = progress?.documents?.requirements || [];
  const docs = progress?.documents;

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
          PDF, Excel, Word, PowerPoint, CSV — up to 20MB
        </p>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          multiple
          accept=".pdf,.xlsx,.xls,.docx,.doc,.pptx,.ppt,.csv,.txt,.md"
          onChange={(e) => handleFileSelect(e.target.files, uploadingFor || undefined)}
        />
      </div>

      {/* Upload status */}
      {uploadMutation.isPending && (
        <div className="rounded-lg border border-teal/20 bg-teal/5 p-3 flex items-center gap-3">
          <div className="h-4 w-4 border-2 border-teal border-t-transparent rounded-full animate-spin" />
          <span className="text-sm">Uploading...</span>
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

              {/* Items */}
              {expandedCategories.has(group.category) && (
                <div className="border-t border-border divide-y divide-border">
                  {group.items.map((req) => (
                    <div key={req.id} className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 min-w-0">
                        {req.status === "verified" ? (
                          <div className="h-5 w-5 rounded-full bg-teal/15 flex items-center justify-center shrink-0">
                            <Check className="h-3 w-3 text-teal" />
                          </div>
                        ) : req.status === "uploaded" ? (
                          <div className="h-5 w-5 rounded-full bg-amber-400/15 flex items-center justify-center shrink-0">
                            <Clock className="h-3 w-3 text-amber-500" />
                          </div>
                        ) : (
                          <div className="h-5 w-5 rounded-full border border-border shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-sm truncate">
                            {req.name}
                            {req.isRequired && req.status === "missing" && (
                              <span className="text-xs text-destructive ml-1.5">Required</span>
                            )}
                          </p>
                          {req.notes && (
                            <p className="text-xs text-muted-foreground mt-0.5 truncate">{req.notes}</p>
                          )}
                        </div>
                      </div>
                      <div className="shrink-0">
                        {req.status === "missing" ? (
                          <button
                            className="text-xs text-teal hover:underline flex items-center gap-1"
                            onClick={() => {
                              setUploadingFor(req.id);
                              fileInputRef.current?.click();
                            }}
                          >
                            <Upload className="h-3 w-3" />
                            Upload
                          </button>
                        ) : req.status === "uploaded" ? (
                          <span className="text-xs text-amber-500">Pending review</span>
                        ) : (
                          <span className="text-xs text-teal">Verified</span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Empty state when no requirements exist */}
      {grouped.length === 0 && (
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
