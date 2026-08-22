/**
 * CIMDesigner — Broker-facing CIM editor
 *
 * Three-panel layout:
 *   Left: section list with visibility toggles + move up/down reordering
 *   Center: live CIM preview rendered via CimSectionRenderer
 *   Right: per-section inspector (AI reasoning, layout override, content edit, approve/hide)
 *
 * Blind / DD preview modes are read-only: overrides are generated from the
 * Normal version, and there is no endpoint to edit an override directly. The
 * inspector never writes redacted/enriched text back into the base section.
 */
import { useState, useCallback, useMemo } from "react";
import { useParams } from "wouter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft, Wand2, Eye, EyeOff, CheckCircle2,
  Loader2, RefreshCw, ChevronUp, ChevronDown, LayoutTemplate,
  Lightbulb, Pencil, Lock, Unlock, AlertTriangle, Info,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Deal, CimSection, CimSectionOverride, BrandingSettings } from "@shared/schema";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { SectionBoundary } from "@/components/cim/SectionBoundary";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { useLocation } from "wouter";

// All layout types the AI can produce
const LAYOUT_TYPES = [
  "cover_page", "metric_grid", "bar_chart", "horizontal_bar_chart",
  "pie_chart", "donut_chart", "line_chart", "timeline",
  "financial_table", "comparison_table", "callout_list", "icon_stat_row",
  "prose_highlight", "two_column", "org_chart", "location_card",
  "stat_callout", "numbered_list", "scorecard", "waterfall_chart", "divider",
] as const;

type PreviewMode = "normal" | "blind" | "dd";

/**
 * apiRequest throws `Error("<status>: <body>")` where body is usually the
 * server's JSON `{ error }`. Pull the human message out so toasts show what
 * the server actually said instead of a raw status line.
 */
function apiErrorMessage(err: unknown, fallback: string): string {
  if (!(err instanceof Error) || !err.message) return fallback;
  const raw = err.message.replace(/^\d{3}:\s*/, "").trim();
  if (!raw || raw.startsWith("<")) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const msg = parsed.error || parsed.message;
      if (typeof msg === "string" && msg) return msg;
    }
  } catch {
    // not JSON — fall through and show the raw text
  }
  return raw;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && /^404:/.test(err.message);
}

export default function CIMDesigner() {
  const params = useParams<{ dealId?: string; id?: string }>();
  const dealId = params.dealId || params.id || "";
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string>("");
  const [contentDirty, setContentDirty] = useState(false);
  const [previewMode, setPreviewMode] = useState<PreviewMode>("normal");
  const [regenConfirmOpen, setRegenConfirmOpen] = useState(false);

  // ── Data queries ──────────────────────────────────────────────────────────
  const {
    data: deal, isLoading: dealLoading, isError: dealIsError, error: dealError, refetch: refetchDeal,
  } = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    queryFn: () => apiRequest("GET", `/api/deals/${dealId}`).then(r => r.json()),
    enabled: !!dealId,
  });

  const {
    data: sections = [], isLoading: sectionsLoading, isError: sectionsIsError, error: sectionsError, refetch: refetchSections,
  } = useQuery<CimSection[]>({
    queryKey: ["/api/deals", dealId, "cim-sections"],
    queryFn: () => apiRequest("GET", `/api/deals/${dealId}/cim-sections`).then(r => r.json()),
    enabled: !!dealId,
  });

  const { data: branding } = useQuery<BrandingSettings>({
    queryKey: ["/api/branding"],
    queryFn: () => apiRequest("GET", "/api/branding").then(r => r.json()),
  });

  // ── CIM version overrides ──────────────────────────────────────────────────
  const {
    data: overrides = [], isLoading: overridesLoading, isError: overridesIsError, error: overridesError, refetch: refetchOverrides,
  } = useQuery<CimSectionOverride[]>({
    queryKey: ["/api/deals", dealId, "cim-overrides", previewMode],
    queryFn: () => apiRequest("GET", `/api/deals/${dealId}/cim-overrides/${previewMode}`).then(r => r.json()),
    enabled: !!dealId && previewMode !== "normal",
  });

  // ── Derived ───────────────────────────────────────────────────────────────
  const selectedSection = sections.find(s => s.id === selectedSectionId) ?? null;
  const brandingCtx = buildBranding(branding, deal ?? null);
  const approvedCount = sections.filter(s => s.brokerApproved).length;
  const visibleCount = sections.filter(s => s.isVisible).length;

  // Overrides that actually point at a current section. Stale overrides (left
  // behind by an older layout) must not count as "this version exists".
  const matchedOverrides = useMemo(() => {
    if (previewMode === "normal") return new Map<string, CimSectionOverride>();
    const ids = new Set(sections.map(s => String(s.id)));
    const map = new Map<string, CimSectionOverride>();
    for (const o of overrides) {
      if (ids.has(String(o.cimSectionId))) map.set(String(o.cimSectionId), o);
    }
    return map;
  }, [overrides, sections, previewMode]);

  // A blind/dd version "exists" only when at least one override matches a
  // current section. Otherwise the preview is showing unredacted base content.
  const versionExists = previewMode === "normal" || matchedOverrides.size > 0;

  // Title redaction mirrors the server's view-room logic (routes: /api/view/:token).
  // Overrides only hold layoutData + content, so titles are redacted here with
  // the same codename the content was redacted to.
  const redactTitle = useMemo(() => {
    if (previewMode !== "blind" || !versionExists || !deal) return (t: string) => t;
    const codename = deal.blindCodename || null;
    const info = (deal.extractedInfo as Record<string, any> | null) ?? null;
    const identifiers = [deal.businessName, info?.ownerName, info?.locations]
      .filter((v): v is string => typeof v === "string" && v.length > 0);
    if (!codename || identifiers.length === 0) return (t: string) => t;
    const nameRegex = new RegExp(
      identifiers.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "gi",
    );
    return (t: string) => t.replace(nameRegex, codename);
  }, [deal, previewMode, versionExists]);

  // Apply overrides for preview mode
  const previewSections: CimSection[] = previewMode === "normal" || !versionExists
    ? sections
    : sections.map(s => {
        const sectionTitle = redactTitle(s.sectionTitle || "");
        const override = matchedOverrides.get(String(s.id));
        if (!override) return { ...s, sectionTitle };
        return {
          ...s,
          sectionTitle,
          layoutData: override.layoutData || s.layoutData,
          aiDraftContent: override.contentOverride || s.aiDraftContent,
          brokerEditedContent: override.contentOverride || s.brokerEditedContent,
        };
      });

  const selectedPreviewSection = previewSections.find(s => s.id === selectedSectionId) ?? null;
  const isReadOnlyMode = previewMode !== "normal";

  // ── Mutations ─────────────────────────────────────────────────────────────
  const generateLayout = useMutation({
    mutationFn: () => apiRequest("POST", `/api/deals/${dealId}/generate-layout`).then(r => r.json()),
    onSuccess: (result: { sectionCount?: number; warnings?: string[] }) => {
      // The server rebuilds every section and clears blind/dd overrides, so
      // every derived cache is stale — including the deal (layout version).
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] });
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-overrides"] });
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      setSelectedSectionId(null);
      setEditedContent("");
      setContentDirty(false);
      setPreviewMode("normal");
      const warnings = result?.warnings ?? [];
      toast({
        title: "Layout generated",
        description: warnings.length > 0
          ? `${warnings.length} section${warnings.length === 1 ? "" : "s"} fell back to a placeholder — review them in the list.`
          : "AI has created a bespoke section layout for this deal.",
        variant: warnings.length > 0 ? "destructive" : undefined,
      });
    },
    onError: (e: unknown) => toast({
      title: "Layout generation failed",
      description: apiErrorMessage(e, "The layout engine returned an error. Please try again."),
      variant: "destructive",
    }),
  });

  const generateBlind = useMutation({
    mutationFn: () => apiRequest("POST", `/api/deals/${dealId}/generate-blind`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-overrides", "blind"] });
      // blindCodename lives on the deal — refetch so title redaction picks it up
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: "Blind CIM generated", description: "Identifying information has been redacted." });
      setPreviewMode("blind");
    },
    onError: (e: unknown) => toast({
      title: "Failed to generate blind CIM",
      description: apiErrorMessage(e, "Redaction failed. Please try again."),
      variant: "destructive",
    }),
  });

  const generateDd = useMutation({
    mutationFn: () => apiRequest("POST", `/api/deals/${dealId}/generate-dd`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-overrides", "dd"] });
      toast({ title: "DD CIM generated", description: "Due diligence details added." });
      setPreviewMode("dd");
    },
    onError: (e: unknown) => toast({
      title: "Failed to generate DD CIM",
      description: apiErrorMessage(e, "Enrichment failed. Please try again."),
      variant: "destructive",
    }),
  });

  const updateSection = useMutation({
    mutationFn: (patch: { id: string | number; [k: string]: unknown }) => {
      const { id: sectionId, ...body } = patch;
      return apiRequest("PATCH", `/api/cim-sections/${sectionId}`, body).then(r => r.json());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] }),
    onError: (e: unknown) => toast({
      title: "Save failed",
      description: apiErrorMessage(e, "The section could not be updated."),
      variant: "destructive",
    }),
  });

  const reorderSections = useMutation({
    mutationFn: (orderedIds: (string | number)[]) =>
      apiRequest("POST", `/api/deals/${dealId}/cim-sections/reorder`, { orderedIds }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] }),
    onError: (e: unknown) => toast({
      title: "Reorder failed",
      description: apiErrorMessage(e, "The new section order could not be saved."),
      variant: "destructive",
    }),
  });

  // ── Section selection ─────────────────────────────────────────────────────
  // Always seed the editor from the BASE section, never the override-merged
  // preview copy — otherwise a save in blind/dd mode would write redacted text
  // into the Normal CIM.
  const selectSection = useCallback((sectionId: string) => {
    const base = sections.find(s => s.id === sectionId);
    if (!base) return;
    setSelectedSectionId(base.id);
    setEditedContent(base.brokerEditedContent || base.aiDraftContent || "");
    setContentDirty(false);
  }, [sections]);

  // ── Content save ──────────────────────────────────────────────────────────
  const saveContent = () => {
    if (!selectedSection || isReadOnlyMode) return;
    updateSection.mutate(
      { id: selectedSection.id, brokerEditedContent: editedContent },
      {
        onSuccess: () => {
          setContentDirty(false);
          toast({ title: "Content saved" });
        },
      },
    );
  };

  // ── Reorder helpers ───────────────────────────────────────────────────────
  const moveSection = (idx: number, dir: -1 | 1) => {
    const newOrder = [...sections];
    const target = idx + dir;
    if (target < 0 || target >= newOrder.length) return;
    [newOrder[idx], newOrder[target]] = [newOrder[target], newOrder[idx]];
    reorderSections.mutate(newOrder.map(s => s.id));
  };

  // ── Regenerate guard ──────────────────────────────────────────────────────
  const requestGenerateLayout = () => {
    if (generateLayout.isPending) return;
    if (sections.length > 0) {
      setRegenConfirmOpen(true);
      return;
    }
    generateLayout.mutate();
  };

  // ── Loading / error states ────────────────────────────────────────────────
  if (dealLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (dealIsError) {
    const notFound = isNotFound(dealError);
    return (
      <div className="h-screen flex flex-col items-center justify-center text-center p-8 gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">
          {notFound ? "Deal not found" : "Couldn't load this deal"}
        </p>
        <p className="text-xs text-muted-foreground max-w-sm">
          {notFound
            ? "This deal doesn't exist or isn't in your account."
            : apiErrorMessage(dealError, "The server returned an error.")}
        </p>
        <div className="flex gap-2 mt-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/broker/deals")}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to deals
          </Button>
          {!notFound && (
            <Button size="sm" onClick={() => refetchDeal()}>
              <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
            </Button>
          )}
        </div>
      </div>
    );
  }

  if (!deal) return <div className="p-8 text-muted-foreground">Deal not found.</div>;

  const generateVersionButton = previewMode === "blind" ? (
    <Button
      size="sm"
      variant={versionExists ? "outline" : "default"}
      className={`h-7 text-xs gap-1 ${!versionExists ? "bg-amber-500 text-black hover:bg-amber-400" : ""}`}
      onClick={() => generateBlind.mutate()}
      disabled={generateBlind.isPending}
    >
      {generateBlind.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Lock className="h-3 w-3" />}
      {versionExists ? "Regenerate Blind" : "Generate Blind"}
    </Button>
  ) : previewMode === "dd" ? (
    <Button
      size="sm"
      variant={versionExists ? "outline" : "default"}
      className={`h-7 text-xs gap-1 ${!versionExists ? "bg-blue-500 text-white hover:bg-blue-400" : ""}`}
      onClick={() => generateDd.mutate()}
      disabled={generateDd.isPending}
    >
      {generateDd.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlock className="h-3 w-3" />}
      {versionExists ? "Regenerate DD" : "Generate DD"}
    </Button>
  ) : null;

  return (
    <TooltipProvider>
      <div className="h-screen flex flex-col bg-background overflow-hidden">

        {/* ── Top bar ─────────────────────────────────────────────────────── */}
        <div className="flex items-center justify-between px-4 h-12 border-b border-border shrink-0">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => navigate(`/deal/${dealId}`)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <span className="text-sm font-semibold">{deal.businessName}</span>
            <Badge variant="outline" className="text-[10px] font-mono">CIM Designer</Badge>
          </div>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{visibleCount} sections</span>
            <span className="text-border">·</span>
            <span>{approvedCount}/{sections.length} approved</span>

            {/* CIM version toggle */}
            {sections.length > 0 && (
              <div className="flex items-center gap-0.5 ml-2 rounded-md border border-border bg-muted/30 p-0.5">
                {(["normal", "blind", "dd"] as const).map((mode) => (
                  <button
                    key={mode}
                    className={`px-2 py-0.5 rounded text-[10px] font-medium transition-colors ${
                      previewMode === mode
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground"
                    }`}
                    onClick={() => setPreviewMode(mode)}
                  >
                    {mode === "normal" ? "Normal" : mode === "blind" ? "Blind" : "DD"}
                  </button>
                ))}
              </div>
            )}

            {/* Generate version buttons */}
            {generateVersionButton}

            <Button
              size="sm"
              className="ml-1 h-7 bg-teal text-teal-foreground hover:bg-teal/90 text-xs gap-1.5"
              onClick={requestGenerateLayout}
              disabled={generateLayout.isPending}
            >
              {generateLayout.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Wand2 className="h-3 w-3" />}
              {sections.length > 0 ? "Regenerate Layout" : "Generate Layout"}
            </Button>
          </div>
        </div>

        {/* ── Three-panel body ─────────────────────────────────────────────── */}
        <div className="flex flex-1 overflow-hidden">

          {/* LEFT: section list ────────────────────────────────────────────── */}
          <div className="w-[220px] shrink-0 border-r border-border flex flex-col bg-card">
            <div className="px-3 py-2 border-b border-border">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Sections</p>
            </div>
            <ScrollArea className="flex-1">
              {sectionsLoading ? (
                <div className="p-3 space-y-2">
                  {[...Array(8)].map((_, i) => <Skeleton key={i} className="h-8 rounded" />)}
                </div>
              ) : sectionsIsError ? (
                <div className="p-4 text-center">
                  <AlertTriangle className="h-6 w-6 mx-auto mb-2 text-destructive" />
                  <p className="text-xs font-medium mb-1">Couldn't load sections</p>
                  <p className="text-[11px] text-muted-foreground mb-2">
                    {apiErrorMessage(sectionsError, "The server returned an error.")}
                  </p>
                  <Button variant="outline" size="sm" className="h-7 text-xs" onClick={() => refetchSections()}>
                    <RefreshCw className="h-3 w-3 mr-1.5" /> Retry
                  </Button>
                </div>
              ) : sections.length === 0 ? (
                <div className="p-4 text-center">
                  <LayoutTemplate className="h-8 w-8 mx-auto mb-2 opacity-20" />
                  <p className="text-xs text-muted-foreground">No layout yet. Click Generate Layout to begin.</p>
                </div>
              ) : (
                <div className="py-1">
                  {sections.map((section, idx) => (
                    <SectionListItem
                      key={section.id}
                      section={section}
                      displayTitle={redactTitle(section.sectionTitle || "")}
                      idx={idx}
                      total={sections.length}
                      isSelected={selectedSectionId === section.id}
                      readOnly={isReadOnlyMode}
                      onSelect={() => selectSection(section.id)}
                      onToggleVisible={() => updateSection.mutate({ id: section.id, isVisible: !section.isVisible })}
                      onMoveUp={() => moveSection(idx, -1)}
                      onMoveDown={() => moveSection(idx, 1)}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>
            {sections.length > 0 && !isReadOnlyMode && (
              <div className="p-2 border-t border-border">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs text-teal hover:text-teal"
                  disabled={updateSection.isPending || approvedCount === sections.length}
                  onClick={() => {
                    const unApproved = sections.filter(s => !s.brokerApproved);
                    unApproved.forEach(s => updateSection.mutate({ id: s.id, brokerApproved: true }));
                  }}
                >
                  <CheckCircle2 className="h-3 w-3 mr-1.5" />
                  {approvedCount === sections.length ? "All approved" : "Approve All"}
                </Button>
              </div>
            )}
          </div>

          {/* CENTER: CIM preview ───────────────────────────────────────────── */}
          <div className="flex-1 overflow-hidden bg-muted/20">
            {/* Radix wraps ScrollArea content in a `display: table` div, which
                sizes to max-content and lets the document sheet overflow
                horizontally in narrow panes — force it back to block so the
                sheet shrinks to the available width. */}
            <ScrollArea className="h-full [&>[data-radix-scroll-area-viewport]>div]:!block">
              {sectionsIsError ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center p-8">
                  <AlertTriangle className="h-10 w-10 mb-4 text-destructive" />
                  <p className="text-sm font-medium mb-1">Couldn't load the CIM</p>
                  <p className="text-xs text-muted-foreground max-w-xs mb-3">
                    {apiErrorMessage(sectionsError, "The server returned an error.")}
                  </p>
                  <Button variant="outline" size="sm" onClick={() => refetchSections()}>
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry
                  </Button>
                </div>
              ) : previewSections.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center p-8">
                  <Wand2 className="h-10 w-10 mb-4 opacity-20" />
                  <p className="text-sm font-medium mb-1">No CIM layout yet</p>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    Click "Generate Layout" to have the AI create a bespoke presentation for this deal.
                  </p>
                </div>
              ) : (
                <div className="max-w-[880px] mx-auto py-8 px-6 space-y-4">
                  {/* Mode indicator banner — app chrome, stays outside the document */}
                  {previewMode !== "normal" && (
                    <PreviewModeBanner
                      mode={previewMode}
                      loading={overridesLoading}
                      isError={overridesIsError}
                      errorMessage={apiErrorMessage(overridesError, "The server returned an error.")}
                      versionExists={versionExists}
                      isGenerating={previewMode === "blind" ? generateBlind.isPending : generateDd.isPending}
                      onGenerate={() => (previewMode === "blind" ? generateBlind.mutate() : generateDd.mutate())}
                      onRetry={() => refetchOverrides()}
                    />
                  )}
                  {/* The document itself: theme-locked paper sheet, WYSIWYG with
                      what buyers see in the view room regardless of app theme. */}
                  <div className="cim-doc cim-sheet px-5 py-6 sm:px-10 sm:py-12 space-y-10">
                    {previewSections.map(section => {
                      const hidden = section.isVisible === false;
                      return (
                        <div
                          key={section.id}
                          className={`relative rounded-xl transition-all cursor-pointer ${
                            selectedSectionId === section.id
                              ? "ring-2 ring-teal ring-offset-2 ring-offset-background"
                              : "hover:ring-1 hover:ring-border"
                          } ${hidden ? "opacity-40 grayscale" : ""}`}
                          onClick={() => selectSection(section.id)}
                        >
                          {hidden && (
                            <div className="absolute top-2 right-2 z-10">
                              <Badge variant="outline" className="text-[10px] gap-1 bg-background/90">
                                <EyeOff className="h-3 w-3" /> Hidden — not shown to buyers
                              </Badge>
                            </div>
                          )}
                          <SectionBoundary sectionTitle={section.sectionTitle}>
                            <CimSectionRenderer
                              section={section}
                              branding={brandingCtx}
                              brokerMode
                            />
                          </SectionBoundary>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </ScrollArea>
          </div>

          {/* RIGHT: inspector ─────────────────────────────────────────────── */}
          <div className="w-[300px] shrink-0 border-l border-border flex flex-col bg-card">
            {selectedSection ? (
              <SectionInspector
                section={selectedSection}
                previewMode={previewMode}
                // In blind/dd the editor shows what the buyer sees, read-only.
                displayContent={
                  isReadOnlyMode && selectedPreviewSection
                    ? (selectedPreviewSection.brokerEditedContent || selectedPreviewSection.aiDraftContent || "")
                    : editedContent
                }
                displayTitle={
                  isReadOnlyMode && selectedPreviewSection
                    ? selectedPreviewSection.sectionTitle
                    : selectedSection.sectionTitle
                }
                contentDirty={contentDirty}
                onContentChange={(v) => { setEditedContent(v); setContentDirty(true); }}
                onSaveContent={saveContent}
                onUpdate={(patch) => updateSection.mutate({ id: selectedSection.id, ...patch })}
                onSwitchToNormal={() => setPreviewMode("normal")}
                isSaving={updateSection.isPending}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-6">
                <Pencil className="h-8 w-8 mb-3 opacity-20" />
                <p className="text-xs text-muted-foreground">Select a section to edit content, change layout, or review AI reasoning.</p>
              </div>
            )}
          </div>

        </div>
      </div>

      {/* ── Regenerate confirmation ─────────────────────────────────────── */}
      <AlertDialog open={regenConfirmOpen} onOpenChange={setRegenConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate the entire layout?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>
                  This rebuilds every section from scratch. The following will be
                  permanently discarded and cannot be undone:
                </p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>All edited section content</li>
                  <li>Section approvals ({approvedCount} of {sections.length} currently approved)</li>
                  <li>Hidden/visible choices and custom section order</li>
                  <li>Any generated Blind and DD versions</li>
                </ul>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep current layout</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                setRegenConfirmOpen(false);
                generateLayout.mutate();
              }}
            >
              Discard and regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </TooltipProvider>
  );
}

// ── Preview mode banner ────────────────────────────────────────────────────
interface PreviewModeBannerProps {
  mode: Exclude<PreviewMode, "normal">;
  loading: boolean;
  isError: boolean;
  errorMessage: string;
  versionExists: boolean;
  isGenerating: boolean;
  onGenerate: () => void;
  onRetry: () => void;
}

function PreviewModeBanner({
  mode, loading, isError, errorMessage, versionExists, isGenerating, onGenerate, onRetry,
}: PreviewModeBannerProps) {
  const isBlind = mode === "blind";
  const label = isBlind ? "Blind CIM Preview" : "Due Diligence CIM Preview";
  const Icon = isBlind ? Lock : Unlock;

  if (loading) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-2 text-xs flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="font-medium">{label}</span>
        <span>— checking for a generated version…</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-2.5 text-xs flex items-start gap-2 text-destructive">
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium">Couldn't load the {isBlind ? "Blind" : "DD"} version</p>
          <p className="text-muted-foreground mt-0.5">
            {errorMessage} The content below is the unmodified Normal CIM.
          </p>
        </div>
        <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={onRetry}>
          <RefreshCw className="h-3 w-3 mr-1.5" /> Retry
        </Button>
      </div>
    );
  }

  if (!versionExists) {
    return (
      <div className={`rounded-lg border px-4 py-2.5 text-xs flex items-start gap-2 ${
        isBlind
          ? "bg-amber-500/10 border-amber-500/40 text-amber-400"
          : "bg-blue-500/10 border-blue-500/40 text-blue-400"
      }`}>
        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="font-medium">
            {isBlind ? "No Blind version generated yet" : "No DD version generated yet"}
          </p>
          <p className="text-muted-foreground mt-0.5">
            {isBlind
              ? "The content below is NOT redacted — business name, owner, and locations are all visible. Generate the Blind version before sharing teaser or blind links."
              : "The content below is the standard CIM with no due diligence enrichment. Generate the DD version to reveal customer names and verification details."}
          </p>
        </div>
        <Button
          size="sm"
          className={`h-7 text-xs shrink-0 gap-1 ${isBlind ? "bg-amber-500 text-black hover:bg-amber-400" : "bg-blue-500 text-white hover:bg-blue-400"}`}
          onClick={onGenerate}
          disabled={isGenerating}
        >
          {isGenerating ? <Loader2 className="h-3 w-3 animate-spin" /> : <Icon className="h-3 w-3" />}
          {isBlind ? "Generate Blind" : "Generate DD"}
        </Button>
      </div>
    );
  }

  return (
    <div className={`rounded-lg border px-4 py-2 text-xs flex items-center gap-2 ${
      isBlind
        ? "bg-amber-500/5 border-amber-500/20 text-amber-400"
        : "bg-blue-500/5 border-blue-500/20 text-blue-400"
    }`}>
      <Icon className="h-3.5 w-3.5" />
      <span className="font-medium">{label}</span>
      <span className="text-muted-foreground">
        {isBlind
          ? "— Identifying information redacted. Read-only: switch to Normal to edit."
          : "— Sensitive data revealed and highlighted. Read-only: switch to Normal to edit."}
      </span>
    </div>
  );
}

// ── Section list item ──────────────────────────────────────────────────────
interface SectionListItemProps {
  section: CimSection;
  displayTitle: string;
  idx: number;
  total: number;
  isSelected: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onToggleVisible: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function SectionListItem({
  section, displayTitle, idx, total, isSelected, readOnly, onSelect, onToggleVisible, onMoveUp, onMoveDown,
}: SectionListItemProps) {
  const approved = !!section.brokerApproved;
  const hidden = section.isVisible === false;

  return (
    <div
      className={`group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition-colors ${
        isSelected ? "bg-teal/10 text-foreground" : "hover:bg-muted/60 text-muted-foreground"
      } ${hidden ? "opacity-60" : ""}`}
      onClick={onSelect}
    >
      <div className="flex-1 min-w-0">
        <p className={`text-xs truncate leading-tight ${isSelected ? "font-medium text-foreground" : ""} ${hidden ? "line-through" : ""}`}>
          {displayTitle}
        </p>
        <p className="text-[10px] text-muted-foreground/60 truncate font-mono">{section.layoutType}</p>
      </div>
      {!readOnly && (
        <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100 transition-opacity">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
                onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
                disabled={idx === 0}
                aria-label="Move section up"
              >
                <ChevronUp className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">Move up</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-0.5 rounded hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent"
                onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
                disabled={idx === total - 1}
                aria-label="Move section down"
              >
                <ChevronDown className="h-3 w-3" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">Move down</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="p-0.5 rounded hover:bg-muted"
                onClick={(e) => { e.stopPropagation(); onToggleVisible(); }}
                aria-label={hidden ? "Show in CIM" : "Hide from CIM"}
              >
                {hidden ? <EyeOff className="h-3 w-3 opacity-40" /> : <Eye className="h-3 w-3" />}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="text-xs">{hidden ? "Show in CIM" : "Hide from CIM"}</TooltipContent>
          </Tooltip>
        </div>
      )}
      {approved && <CheckCircle2 className="h-3 w-3 text-teal shrink-0" />}
    </div>
  );
}

// ── Section inspector ──────────────────────────────────────────────────────
interface SectionInspectorProps {
  section: CimSection;
  previewMode: PreviewMode;
  displayContent: string;
  displayTitle: string;
  contentDirty: boolean;
  onContentChange: (v: string) => void;
  onSaveContent: () => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onSwitchToNormal: () => void;
  isSaving: boolean;
}

function SectionInspector({
  section, previewMode, displayContent, displayTitle, contentDirty,
  onContentChange, onSaveContent, onUpdate, onSwitchToNormal, isSaving,
}: SectionInspectorProps) {
  const approved = !!section.brokerApproved;
  const reasoning = section.aiLayoutReasoning ?? undefined;
  const readOnly = previewMode !== "normal";
  const modeLabel = previewMode === "blind" ? "Blind" : "DD";

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Inspector header */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <p className="text-xs font-semibold truncate">{displayTitle}</p>
        <p className="text-[10px] font-mono text-muted-foreground">{section.layoutType}</p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">

          {/* Read-only notice for generated versions */}
          {readOnly && (
            <div className="rounded-md border border-border bg-muted/40 p-2.5 text-[11px] text-muted-foreground leading-relaxed flex gap-2">
              <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-teal" />
              <div className="space-y-1.5">
                <p>
                  You're viewing the <span className="font-medium text-foreground">{modeLabel}</span> version.
                  It's generated from the Normal CIM and can't be edited directly — saving here
                  would overwrite your real content with {previewMode === "blind" ? "redacted" : "enriched"} text.
                </p>
                <p>Edit the Normal version, then regenerate {modeLabel}.</p>
                <Button variant="outline" size="sm" className="h-6 text-[11px] mt-1" onClick={onSwitchToNormal}>
                  Switch to Normal to edit
                </Button>
              </div>
            </div>
          )}

          {/* AI reasoning */}
          {reasoning && (
            <div>
              <div className="flex items-center gap-1.5 mb-1.5">
                <Lightbulb className="h-3 w-3 text-amber-400" />
                <span className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">AI Reasoning</span>
              </div>
              <p className="text-[11px] text-muted-foreground leading-relaxed bg-muted/40 rounded p-2">
                {reasoning}
              </p>
            </div>
          )}

          <Separator />

          {/* Layout override */}
          <div>
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide mb-1.5">Layout Type</p>
            <Select
              value={section.layoutType || ""}
              disabled={readOnly || isSaving}
              onValueChange={(v) => {
                if (v === section.layoutType) return;
                // layoutOverride is a text column recording the AI's original
                // choice; keep the first AI value across repeated changes.
                onUpdate({ layoutType: v, layoutOverride: section.layoutOverride || section.layoutType });
              }}
            >
              <SelectTrigger className="h-7 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {LAYOUT_TYPES.map(lt => (
                  <SelectItem key={lt} value={lt} className="text-xs font-mono">{lt}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            {section.layoutOverride && section.layoutOverride !== section.layoutType && (
              <p className="text-[10px] text-amber-400 mt-1">
                Layout manually overridden (AI chose <span className="font-mono">{section.layoutOverride}</span>)
              </p>
            )}
          </div>

          <Separator />

          {/* Content editor */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">
                {readOnly ? `${modeLabel} Content (read-only)` : "Content"}
              </p>
              {!readOnly && section.brokerEditedContent && (
                <Badge variant="outline" className="text-[9px] h-4">edited</Badge>
              )}
            </div>
            <Textarea
              value={displayContent}
              readOnly={readOnly}
              onChange={e => { if (!readOnly) onContentChange(e.target.value); }}
              className={`text-xs min-h-[140px] resize-none font-mono leading-relaxed ${readOnly ? "opacity-70 cursor-default" : ""}`}
              placeholder={readOnly ? `No ${modeLabel} content for this section.` : "Section content..."}
            />
            {!readOnly && contentDirty && (
              <Button
                size="sm"
                className="w-full mt-2 h-7 text-xs bg-teal text-teal-foreground hover:bg-teal/90"
                onClick={onSaveContent}
                disabled={isSaving}
              >
                {isSaving ? <Loader2 className="h-3 w-3 animate-spin mr-1.5" /> : null}
                Save Content
              </Button>
            )}
          </div>

          <Separator />

          {/* Actions */}
          <div className="space-y-2">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Actions</p>
            {readOnly && (
              <p className="text-[10px] text-muted-foreground">
                Approval and visibility apply to the base section. Switch to Normal to change them.
              </p>
            )}

            <Button
              variant={approved ? "outline" : "default"}
              size="sm"
              className={`w-full h-7 text-xs gap-1.5 ${!approved ? "bg-teal text-teal-foreground hover:bg-teal/90" : ""}`}
              onClick={() => onUpdate({ brokerApproved: !approved })}
              disabled={readOnly || isSaving}
            >
              {approved ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {approved ? "Unapprove" : "Approve Section"}
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="w-full h-7 text-xs gap-1.5"
              onClick={() => onUpdate({ isVisible: !section.isVisible })}
              disabled={readOnly || isSaving}
            >
              {section.isVisible ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
              {section.isVisible ? "Hide from CIM" : "Show in CIM"}
            </Button>
          </div>

        </div>
      </ScrollArea>
    </div>
  );
}
