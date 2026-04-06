/**
 * CIMDesigner — Broker-facing CIM editor
 *
 * Three-panel layout:
 *   Left: section list with visibility toggles + drag-to-reorder
 *   Center: live CIM preview rendered via CimSectionRenderer
 *   Right: per-section inspector (AI reasoning, layout override, content edit, approve/hide)
 */
import { useState, useCallback } from "react";
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
  ArrowLeft, Wand2, Eye, EyeOff, CheckCircle2, Circle,
  Loader2, RefreshCw, ChevronUp, ChevronDown, LayoutTemplate,
  Lightbulb, Pencil, Lock, Unlock, GripVertical,
} from "lucide-react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import type { Deal, CimSection, CimSectionOverride, BrandingSettings } from "@shared/schema";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { useLocation } from "wouter";

// All layout types the AI can produce
const LAYOUT_TYPES = [
  "cover_page", "metric_grid", "bar_chart", "horizontal_bar_chart",
  "pie_chart", "donut_chart", "line_chart", "timeline",
  "financial_table", "comparison_table", "callout_list", "icon_stat_row",
  "prose_highlight", "two_column", "org_chart", "location_card",
  "stat_callout", "numbered_list", "scorecard", "divider",
] as const;

export default function CIMDesigner() {
  const params = useParams<{ dealId?: string; id?: string }>();
  const dealId = params.dealId || params.id || "";
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [selectedSectionId, setSelectedSectionId] = useState<string | null>(null);
  const [editedContent, setEditedContent] = useState<string>("");
  const [contentDirty, setContentDirty] = useState(false);
  const [previewMode, setPreviewMode] = useState<"normal" | "blind" | "dd">("normal");

  // ── Data queries ──────────────────────────────────────────────────────────
  const { data: deal, isLoading: dealLoading } = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    queryFn: () => apiRequest("GET", `/api/deals/${dealId}`).then(r => r.json()),
  });

  const { data: sections = [], isLoading: sectionsLoading } = useQuery<CimSection[]>({
    queryKey: ["/api/deals", dealId, "cim-sections"],
    queryFn: () => apiRequest("GET", `/api/deals/${dealId}/cim-sections`).then(r => r.json()),
  });

  const { data: branding } = useQuery<BrandingSettings>({
    queryKey: ["/api/branding"],
    queryFn: () => apiRequest("GET", "/api/branding").then(r => r.json()),
  });

  // ── CIM version overrides ──────────────────────────────────────────────────
  const { data: overrides = [] } = useQuery<CimSectionOverride[]>({
    queryKey: ["/api/deals", dealId, "cim-overrides", previewMode],
    queryFn: () => apiRequest("GET", `/api/deals/${dealId}/cim-overrides/${previewMode}`).then(r => r.json()),
    enabled: previewMode !== "normal",
  });

  // ── Derived ───────────────────────────────────────────────────────────────
  const selectedSection = sections.find(s => s.id === selectedSectionId) ?? null;
  const brandingCtx = buildBranding(branding, deal ?? null);
  const approvedCount = sections.filter(s => (s as any).isApproved).length;
  const visibleCount = sections.filter(s => s.isVisible).length;

  // Apply overrides for preview mode
  const previewSections = previewMode === "normal" ? sections : sections.map(s => {
    const override = overrides.find(o => o.cimSectionId === String(s.id));
    if (!override) return s;
    return {
      ...s,
      layoutData: override.layoutData || s.layoutData,
      aiDraftContent: override.contentOverride || s.aiDraftContent,
      brokerEditedContent: override.contentOverride || s.brokerEditedContent,
    };
  });

  // ── Mutations ─────────────────────────────────────────────────────────────
  const generateLayout = useMutation({
    mutationFn: () => apiRequest("POST", `/api/deals/${dealId}/generate-layout`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] });
      toast({ title: "Layout generated", description: "AI has created a bespoke section layout for this deal." });
    },
    onError: () => toast({ title: "Generation failed", variant: "destructive" }),
  });

  const generateBlind = useMutation({
    mutationFn: () => apiRequest("POST", `/api/deals/${dealId}/generate-blind`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-overrides", "blind"] });
      toast({ title: "Blind CIM generated", description: "All identifying info redacted." });
      setPreviewMode("blind");
    },
    onError: (e: Error) => toast({ title: "Failed to generate blind CIM", description: e.message, variant: "destructive" }),
  });

  const generateDd = useMutation({
    mutationFn: () => apiRequest("POST", `/api/deals/${dealId}/generate-dd`).then(r => r.json()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-overrides", "dd"] });
      toast({ title: "DD CIM generated", description: "Due diligence details added." });
      setPreviewMode("dd");
    },
    onError: (e: Error) => toast({ title: "Failed to generate DD CIM", description: e.message, variant: "destructive" }),
  });

  const updateSection = useMutation({
    mutationFn: (patch: { id: string | number; [k: string]: unknown }) => {
      const { id: sectionId, ...body } = patch;
      return apiRequest("PATCH", `/api/cim-sections/${sectionId}`, body).then(r => r.json());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] }),
    onError: () => toast({ title: "Save failed", variant: "destructive" }),
  });

  const reorderSections = useMutation({
    mutationFn: (orderedIds: (string | number)[]) =>
      apiRequest("POST", `/api/deals/${dealId}/cim-sections/reorder`, { orderedIds }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/deals", dealId, "cim-sections"] }),
  });

  // ── Section selection ─────────────────────────────────────────────────────
  const selectSection = useCallback((section: CimSection) => {
    setSelectedSectionId(section.id);
    setEditedContent(section.brokerEditedContent || section.aiDraftContent || "");
    setContentDirty(false);
  }, []);

  // ── Content save ──────────────────────────────────────────────────────────
  const saveContent = () => {
    if (!selectedSection) return;
    updateSection.mutate({ id: selectedSection.id, brokerEditedContent: editedContent });
    setContentDirty(false);
    toast({ title: "Content saved" });
  };

  // ── Reorder helpers ───────────────────────────────────────────────────────
  const moveSection = (idx: number, dir: -1 | 1) => {
    const newOrder = [...sections];
    const target = idx + dir;
    if (target < 0 || target >= newOrder.length) return;
    [newOrder[idx], newOrder[target]] = [newOrder[target], newOrder[idx]];
    reorderSections.mutate(newOrder.map(s => s.id));
  };

  // ── Loading state ─────────────────────────────────────────────────────────
  if (dealLoading) {
    return (
      <div className="h-screen flex items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!deal) return <div className="p-8 text-muted-foreground">Deal not found.</div>;

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
            {previewMode === "blind" && (
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1"
                onClick={() => generateBlind.mutate()} disabled={generateBlind.isPending}>
                {generateBlind.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Lock className="h-3 w-3" />}
                Generate Blind
              </Button>
            )}
            {previewMode === "dd" && (
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1"
                onClick={() => generateDd.mutate()} disabled={generateDd.isPending}>
                {generateDd.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlock className="h-3 w-3" />}
                Generate DD
              </Button>
            )}

            <Button
              size="sm"
              className="ml-1 h-7 bg-teal text-teal-foreground hover:bg-teal/90 text-xs gap-1.5"
              onClick={() => generateLayout.mutate()}
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
                      idx={idx}
                      total={sections.length}
                      isSelected={selectedSectionId === section.id}
                      onSelect={() => selectSection(section)}
                      onToggleVisible={() => updateSection.mutate({ id: section.id, isVisible: !section.isVisible })}
                      onMoveUp={() => moveSection(idx, -1)}
                      onMoveDown={() => moveSection(idx, 1)}
                    />
                  ))}
                </div>
              )}
            </ScrollArea>
            {sections.length > 0 && (
              <div className="p-2 border-t border-border">
                <Button
                  variant="ghost"
                  size="sm"
                  className="w-full h-7 text-xs text-teal hover:text-teal"
                  onClick={() => {
                    const unApproved = sections.filter(s => !(s as any).isApproved);
                    unApproved.forEach(s => updateSection.mutate({ id: s.id, isApproved: true }));
                  }}
                >
                  <CheckCircle2 className="h-3 w-3 mr-1.5" />
                  Approve All
                </Button>
              </div>
            )}
          </div>

          {/* CENTER: CIM preview ───────────────────────────────────────────── */}
          <div className="flex-1 overflow-hidden bg-muted/20">
            <ScrollArea className="h-full">
              {previewSections.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full min-h-[400px] text-center p-8">
                  <Wand2 className="h-10 w-10 mb-4 opacity-20" />
                  <p className="text-sm font-medium mb-1">No CIM layout yet</p>
                  <p className="text-xs text-muted-foreground max-w-xs">
                    Click "Generate Layout" to have the AI create a bespoke presentation for this deal.
                  </p>
                </div>
              ) : (
                <div className="max-w-[860px] mx-auto py-8 px-6 space-y-8">
                  {/* Mode indicator banner */}
                  {previewMode !== "normal" && (
                    <div className={`rounded-lg border px-4 py-2 text-xs flex items-center gap-2 ${
                      previewMode === "blind"
                        ? "bg-amber-500/5 border-amber-500/20 text-amber-400"
                        : "bg-blue-500/5 border-blue-500/20 text-blue-400"
                    }`}>
                      {previewMode === "blind" ? <Lock className="h-3.5 w-3.5" /> : <Unlock className="h-3.5 w-3.5" />}
                      <span className="font-medium">
                        {previewMode === "blind" ? "Blind CIM Preview" : "Due Diligence CIM Preview"}
                      </span>
                      <span className="text-muted-foreground">
                        {previewMode === "blind"
                          ? "— All identifying information redacted"
                          : "— Sensitive data revealed and highlighted"}
                      </span>
                    </div>
                  )}
                  {previewSections.map(section => (
                    <div
                      key={section.id}
                      className={`rounded-xl transition-all cursor-pointer ${
                        selectedSectionId === section.id
                          ? "ring-2 ring-teal ring-offset-2 ring-offset-background"
                          : "hover:ring-1 hover:ring-border"
                      }`}
                      onClick={() => selectSection(section)}
                    >
                      <CimSectionRenderer
                        section={section}
                        branding={brandingCtx}
                        brokerMode
                      />
                    </div>
                  ))}
                </div>
              )}
            </ScrollArea>
          </div>

          {/* RIGHT: inspector ─────────────────────────────────────────────── */}
          <div className="w-[300px] shrink-0 border-l border-border flex flex-col bg-card">
            {selectedSection ? (
              <SectionInspector
                section={selectedSection}
                editedContent={editedContent}
                contentDirty={contentDirty}
                onContentChange={(v) => { setEditedContent(v); setContentDirty(true); }}
                onSaveContent={saveContent}
                onUpdate={(patch) => updateSection.mutate({ id: selectedSection.id, ...patch })}
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
    </TooltipProvider>
  );
}

// ── Section list item ──────────────────────────────────────────────────────
interface SectionListItemProps {
  section: CimSection;
  idx: number;
  total: number;
  isSelected: boolean;
  onSelect: () => void;
  onToggleVisible: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}

function SectionListItem({ section, idx, total, isSelected, onSelect, onToggleVisible, onMoveUp, onMoveDown }: SectionListItemProps) {
  const isApproved = (section as any).isApproved;

  return (
    <div
      className={`group flex items-center gap-1.5 px-2 py-1.5 cursor-pointer transition-colors ${
        isSelected ? "bg-teal/10 text-foreground" : "hover:bg-muted/60 text-muted-foreground"
      }`}
      onClick={onSelect}
    >
      <GripVertical className="h-3 w-3 opacity-30 shrink-0" />
      <div className="flex-1 min-w-0">
        <p className={`text-xs truncate leading-tight ${isSelected ? "font-medium text-foreground" : ""}`}>
          {section.sectionTitle}
        </p>
        <p className="text-[10px] text-muted-foreground/60 truncate font-mono">{section.layoutType}</p>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          className="p-0.5 rounded hover:bg-muted"
          onClick={(e) => { e.stopPropagation(); onMoveUp(); }}
          disabled={idx === 0}
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          className="p-0.5 rounded hover:bg-muted"
          onClick={(e) => { e.stopPropagation(); onMoveDown(); }}
          disabled={idx === total - 1}
        >
          <ChevronDown className="h-3 w-3" />
        </button>
        <button
          className="p-0.5 rounded hover:bg-muted"
          onClick={(e) => { e.stopPropagation(); onToggleVisible(); }}
        >
          {section.isVisible ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3 opacity-40" />}
        </button>
      </div>
      {isApproved && <CheckCircle2 className="h-3 w-3 text-teal shrink-0" />}
    </div>
  );
}

// ── Section inspector ──────────────────────────────────────────────────────
interface SectionInspectorProps {
  section: CimSection;
  editedContent: string;
  contentDirty: boolean;
  onContentChange: (v: string) => void;
  onSaveContent: () => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  isSaving: boolean;
}

function SectionInspector({
  section, editedContent, contentDirty, onContentChange, onSaveContent, onUpdate, isSaving,
}: SectionInspectorProps) {
  const isApproved = (section as any).isApproved;
  const reasoning = (section as any).aiLayoutReasoning as string | undefined;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Inspector header */}
      <div className="px-3 py-2 border-b border-border shrink-0">
        <p className="text-xs font-semibold truncate">{section.sectionTitle}</p>
        <p className="text-[10px] font-mono text-muted-foreground">{section.layoutType}</p>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-3 space-y-4">

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
              onValueChange={(v) => onUpdate({ layoutType: v, layoutOverride: true })}
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
            {(section as any).layoutOverride && (
              <p className="text-[10px] text-amber-400 mt-1">Layout manually overridden</p>
            )}
          </div>

          <Separator />

          {/* Content editor */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wide">Content</p>
              {section.brokerEditedContent && (
                <Badge variant="outline" className="text-[9px] h-4">edited</Badge>
              )}
            </div>
            <Textarea
              value={editedContent}
              onChange={e => onContentChange(e.target.value)}
              className="text-xs min-h-[140px] resize-none font-mono leading-relaxed"
              placeholder="Section content..."
            />
            {contentDirty && (
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

            <Button
              variant={isApproved ? "outline" : "default"}
              size="sm"
              className={`w-full h-7 text-xs gap-1.5 ${!isApproved ? "bg-teal text-teal-foreground hover:bg-teal/90" : ""}`}
              onClick={() => onUpdate({ isApproved: !isApproved })}
            >
              {isApproved ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {isApproved ? "Unapprove" : "Approve Section"}
            </Button>

            <Button
              variant="outline"
              size="sm"
              className="w-full h-7 text-xs gap-1.5"
              onClick={() => onUpdate({ isVisible: !section.isVisible })}
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
