/**
 * CIMDesigner — the CIM builder (routes /deal/:dealId/design and
 * /broker/cim/:dealId/design).
 *
 *   Left:   the outline — drag to reorder, "+" between sections, a menu per
 *           section (rename, duplicate, move, hide, access tier, delete).
 *   Centre: the paper CIM exactly as buyers see it (same wrappers as the
 *           view room); "Preview as" switches to a teaser / full / LOI / DD
 *           buyer's view, computed with the server's own rules.
 *   Right:  the inspector — title, layout, content, AI writer, who can see
 *           it, approve / regenerate / undo / delete.
 *   Design: a drawer for the deal's template and the business's branding
 *           (cim-design/DesignPanel), plus the print preview.
 *
 * Below 1024px the three panes become tabs (Sections · Page · Edit).
 * Pieces live in client/src/components/cim-builder/.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle, ArrowLeft, Eye, Images, Loader2, Lock, Palette, Pencil, Plus, Printer, RefreshCw, Sparkles, Unlock, Wand2,
} from "lucide-react";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { CimMediaProvider } from "@/components/cim/CimMediaContext";
import { useMediaLibrary } from "@/components/cim-builder/media/api";
import { MediaLibrary } from "@/components/cim-builder/media/MediaLibrary";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { useCimGeneration, cimGenerationKey } from "@/hooks/useCimGeneration";
import { CimGenerationProgress } from "@/components/deal/CimGenerationProgress";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import type { BrandingSettings, CimSectionOverride, Deal } from "@shared/schema";
import { cn } from "@/lib/utils";
import { useCimBuilder } from "@/components/cim-builder/useCimBuilder";
import { useAiGate } from "@/components/cim-builder/useAiGate";
import { SectionList } from "@/components/cim-builder/SectionList";
import { SectionInspector } from "@/components/cim-builder/SectionInspector";
import { CimCanvas, type PreviewAs } from "@/components/cim-builder/CimCanvas";
import { AddSectionDialog } from "@/components/cim-builder/AddSectionDialog";
import { ChangeLayoutDialog } from "@/components/cim-builder/ChangeLayoutDialog";
import { builderRequest, errorText, type BuilderSection } from "@/components/cim-builder/api";
import { useDealDesign } from "@/components/cim-design/api";
import { DesignPanel } from "@/components/cim-design/DesignPanel";
import { cimModeForAccessLevel } from "@shared/cim-layouts";

const PREVIEWS: Array<{ key: PreviewAs; label: string; hint: string }> = [
  { key: "editor", label: "Editing", hint: "Everything, with your edit controls" },
  { key: "teaser", label: "Teaser buyer", hint: "Blind CIM; “Full access” sections locked" },
  { key: "full", label: "Full-access buyer", hint: "Blind CIM, every section" },
  { key: "loi", label: "LOI buyer", hint: "The named CIM" },
  { key: "due_diligence", label: "Due-diligence buyer", hint: "Named CIM + DD details" },
];

type Pane = "sections" | "page" | "edit";

function isUnauthorized(err: unknown) {
  return err instanceof Error && /^401:|session has ended/i.test(err.message);
}

export default function CIMDesigner() {
  const params = useParams<{ dealId?: string; id?: string }>();
  const dealId = params.dealId || params.id || "";
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  // ?preview=teaser|full|loi|due_diligence opens straight into a buyer preview
  // (the CIM tab's version cards link here).
  const [previewAs, setPreviewAs] = useState<PreviewAs>(() => {
    const p = new URLSearchParams(window.location.search).get("preview");
    return PREVIEWS.some((x) => x.key === p) ? (p as PreviewAs) : "editor";
  });
  const [pane, setPane] = useState<Pane>(() => (new URLSearchParams(window.location.search).get("design") === "1" ? "edit" : "page"));
  const [addAt, setAddAt] = useState<{ open: boolean; afterId?: string | null }>({ open: false });
  const [layoutOpen, setLayoutOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<BuilderSection | null>(null);
  const [regenTarget, setRegenTarget] = useState<BuilderSection | null>(null);
  const [regenBrief, setRegenBrief] = useState("");
  const [regenAllOpen, setRegenAllOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const [designOpen, setDesignOpen] = useState(() => new URLSearchParams(window.location.search).get("design") === "1");
  // Unsaved photo/video/map edits, previewed live on the page.
  const [draft, setDraft] = useState<{ id: string; layoutData: Record<string, any> } | null>(null);
  const onDraftChange = useCallback((id: string, layoutData: Record<string, any> | null) => {
    setDraft((cur) => (layoutData ? { id, layoutData } : cur?.id === id ? null : cur));
  }, []);

  // ── Data ──────────────────────────────────────────────────────────────
  const dealQuery = useQuery<Deal>({
    queryKey: ["/api/deals", dealId],
    queryFn: () => builderRequest<Deal>("GET", `/api/deals/${dealId}`),
    enabled: !!dealId,
  });
  const deal = dealQuery.data;
  const { data: brandingSettings } = useQuery<BrandingSettings | null>({
    queryKey: ["/api/branding"],
    queryFn: async () => {
      const r = await fetch("/api/branding", { credentials: "include" });
      if (!r.ok) return null;
      const body = await r.json();
      return Array.isArray(body) ? body[0] || null : body;
    },
  });
  const builder = useCimBuilder(dealId);
  const state = builder.query.data;
  const sections = state?.sections ?? [];
  const gate = useAiGate(dealId);
  const media = useMediaLibrary(dealId);
  const dealDesign = useDealDesign(dealId);
  const designPayload = dealDesign.data
    ? { template: dealDesign.data.template, brokerage: dealDesign.data.brokerage, business: dealDesign.data.business }
    : null;
  const generation = useCimGeneration(dealId);

  const overrideMode = previewAs === "teaser" || previewAs === "full" ? "blind" : previewAs === "due_diligence" ? "dd" : null;
  const { data: overrides = [], isLoading: overridesLoading } = useQuery<CimSectionOverride[]>({
    queryKey: ["/api/deals", dealId, "cim-overrides", overrideMode ?? "none", state?.blind.updating ?? 0, sections.length],
    queryFn: () => builderRequest<CimSectionOverride[]>("GET", `/api/deals/${dealId}/cim-overrides/${overrideMode}`),
    enabled: !!dealId && !!overrideMode,
  });

  const branding = buildBranding(brandingSettings as any, deal ?? null);
  const selected = sections.find((s) => s.id === selectedId) ?? null;
  const approvedCount = sections.filter((s) => s.brokerApproved).length;
  const hiddenCount = sections.filter((s) => s.isVisible === false).length;
  const lockedCount = sections.filter((s) => s.accessTier === "full").length;
  const readOnly = previewAs !== "editor";

  // Keep the selection valid (deleted section, fresh CIM) — but not while a
  // refetch is in flight: a just-added section isn't in the old list yet.
  const fetching = builder.query.isFetching;
  useEffect(() => {
    if (fetching) return;
    if (selectedId && state && !sections.some((s) => s.id === selectedId)) setSelectedId(null);
  }, [sections, selectedId, state, fetching]);

  const select = (id: string, from: "list" | "page") => {
    setSelectedId(id);
    setDesignOpen(false);
    if (from === "list") {
      // Bring the section into view on the page.
      requestAnimationFrame(() => document.getElementById(`section-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }
    if (!readOnly) setPane("edit");
  };

  // ── Whole-CIM actions ────────────────────────────────────────────────
  const generateAll = useMutation({
    mutationFn: () =>
      builderRequest("POST", `/api/deals/${dealId}/${sections.length > 0 ? "generate-layout" : "generate-content"}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: cimGenerationKey(dealId) });
      toast({ title: "Generating the CIM", description: "This runs in the background — you can keep working or leave this page." });
    },
    onError: (e) => toast({ title: "Couldn't start generating", description: errorText(e), variant: "destructive" }),
  });
  const generateVersion = useMutation({
    mutationFn: (mode: "blind" | "dd") => builderRequest("POST", `/api/deals/${dealId}/generate-${mode}`),
    onSuccess: (_r, mode) => {
      builder.refresh();
      qc.invalidateQueries({ queryKey: ["/api/deals", dealId] });
      toast({ title: mode === "blind" ? "Blind version ready" : "Due-diligence version ready" });
    },
    onError: (e) => toast({ title: "Couldn't generate that version", description: errorText(e), variant: "destructive" }),
  });

  const generating = generation.isRunning || generateAll.isPending;

  // ── Auth / loading / errors ──────────────────────────────────────────
  const loadError = dealQuery.error || builder.query.error;
  useEffect(() => {
    if (isUnauthorized(loadError)) qc.invalidateQueries({ queryKey: ["/api/broker-auth/me"] });
  }, [loadError, qc]);

  if (dealQuery.isLoading || (builder.query.isLoading && !state)) {
    return (
      <div className="h-screen flex flex-col">
        <div className="h-12 border-b border-border" />
        <div className="flex-1 grid lg:grid-cols-[280px_1fr_360px]">
          <div className="hidden lg:block border-r border-border p-3 space-y-2">{[...Array(9)].map((_, i) => <Skeleton key={i} className="h-9" />)}</div>
          <div className="p-8"><Skeleton className="h-[70vh] max-w-[860px] mx-auto rounded-xl" /></div>
          <div className="hidden lg:block border-l border-border" />
        </div>
      </div>
    );
  }
  if (loadError || !deal) {
    const notFound = loadError instanceof Error && /not found/i.test(loadError.message);
    return (
      <div className="h-screen flex flex-col items-center justify-center text-center p-8 gap-3">
        <AlertTriangle className="h-8 w-8 text-destructive" />
        <p className="text-sm font-medium">{isUnauthorized(loadError) ? "Your session has ended" : notFound ? "Deal not found" : "Couldn't load the CIM builder"}</p>
        <p className="text-xs text-muted-foreground max-w-sm">{errorText(loadError, "The server returned an error.")}</p>
        <div className="flex gap-2 mt-2">
          <Button variant="outline" size="sm" onClick={() => navigate("/broker/deals")}><ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to deals</Button>
          {!notFound && <Button size="sm" onClick={() => { dealQuery.refetch(); builder.query.refetch(); }}><RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Retry</Button>}
        </div>
      </div>
    );
  }

  const openAdd = (afterId?: string | null) => setAddAt({ open: true, afterId });
  // Print preview of the version on screen (editing = the named CIM).
  const openPrintPreview = () => {
    const version = previewAs === "editor" ? "normal" : cimModeForAccessLevel(previewAs);
    window.open(`/deal/${dealId}/print?version=${version}`, "_blank", "noopener");
  };
  const blind = state?.blind;
  const previewMeta = PREVIEWS.find((p) => p.key === previewAs)!;

  // ── Panes ────────────────────────────────────────────────────────────
  const listPane = (
    <div className="flex flex-col h-full min-h-0 bg-card">
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-border shrink-0">
        <div>
          <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Sections</p>
          <p className="text-[10px] text-muted-foreground/70">
            {sections.length} · {approvedCount} approved{hiddenCount ? ` · ${hiddenCount} hidden` : ""}{lockedCount ? ` · ${lockedCount} full-access` : ""}
          </p>
        </div>
        {!readOnly && (
          <Button size="sm" variant="outline" className="h-7 text-xs gap-1 border-teal/40 text-teal hover:bg-teal/10" onClick={() => openAdd(undefined)} data-testid="button-add-section">
            <Plus className="h-3.5 w-3.5" /> Add
          </Button>
        )}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <SectionList
          sections={sections}
          selectedId={selectedId}
          showBlindStatus={!!blind?.generated}
          readOnly={readOnly}
          onSelect={(id) => select(id, "list")}
          onReorder={(ids) => builder.reorder.mutate(ids)}
          onAddAfter={(afterId) => openAdd(afterId)}
          onRename={(id, t) => builder.patch.mutate({ id, sectionTitle: t })}
          onDuplicate={(id) => builder.duplicate.mutate(id)}
          onToggleVisible={(s) => builder.patch.mutate({ id: s.id, isVisible: s.isVisible === false })}
          onSetTier={(id, tier) => builder.patch.mutate({ id, accessTier: tier })}
          onDelete={(s) => setDeleteTarget(s)}
        />
        {!readOnly && sections.length > 0 && (
          <div className="px-3 pb-4">
            <button
              type="button"
              onClick={() => openAdd(undefined)}
              className="w-full flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border py-2 text-xs text-muted-foreground hover:text-foreground hover:border-teal/50"
            >
              <Plus className="h-3.5 w-3.5" /> Add a section at the end
            </button>
          </div>
        )}
      </div>
      {!readOnly && sections.length > 0 && approvedCount < sections.length && (
        <div className="p-2 border-t border-border shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="w-full h-7 text-xs text-teal hover:text-teal"
            onClick={() => sections.filter((s) => !s.brokerApproved).forEach((s) => builder.patch.mutate({ id: s.id, brokerApproved: true }))}
          >
            Approve all sections
          </Button>
        </div>
      )}
    </div>
  );

  const pagePane = (
    <div className="h-full min-h-0 overflow-y-auto scrollbar-thin bg-muted/20" id="cim-builder-page">
      <div className="max-w-[900px] mx-auto px-3 py-5 sm:px-6 sm:py-8 space-y-4">
        {/* App chrome above the paper: what this preview is */}
        {readOnly && (
          <PreviewBanner
            previewAs={previewAs}
            hint={previewMeta.hint}
            blindGenerated={!!blind?.generated}
            blindUpdating={blind?.updating ?? 0}
            blindError={blind?.error ?? null}
            ddGenerated={!!state?.dd.generated}
            loading={overridesLoading}
            busy={generateVersion.isPending}
            onGenerate={(m) => generateVersion.mutate(m)}
            onRetryBlind={() => builder.refreshBlind.mutate(undefined as never)}
            onBackToEditing={() => setPreviewAs("editor")}
          />
        )}
        <CimMediaProvider value={{ assets: media.assets }}>
        {sections.length === 0 ? (
          <EmptyCim
            generating={generating}
            blockedReason={gate.blockedReason}
            onGenerate={() => generateAll.mutate()}
            onAddBlank={() => openAdd(undefined)}
            generationView={generation}
          />
        ) : (
          <CimCanvas
            sections={sections}
            media={media.refs}
            draft={readOnly ? null : draft}
            previewAs={previewAs}
            overrides={overrides}
            deal={deal}
            branding={branding}
            design={designPayload}
            selectedId={selectedId}
            onSelect={(id) => select(id, "page")}
            onAddAfter={(id) => openAdd(id)}
            onApplyRewrite={(id) => builder.applyRewrite.mutate(id)}
            onDiscardRewrite={(id) => builder.discardTask.mutate(id)}
            applying={builder.applyRewrite.isPending}
          />
        )}
        </CimMediaProvider>
      </div>
    </div>
  );

  const editPane = (
    <div className="h-full min-h-0 overflow-y-auto scrollbar-thin bg-card">
      {designOpen ? (
        // The design panel sits where the inspector is, so the page stays
        // fully visible and re-themes as the broker clicks.
        <div className="p-4 space-y-4" data-testid="design-pane">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-sm font-semibold flex items-center gap-1.5"><Palette className="h-4 w-4 text-teal" /> Design</p>
              <p className="text-[11px] text-muted-foreground">How this CIM looks. Changes save and show on the page straight away.</p>
            </div>
            <Button variant="ghost" size="sm" className="h-7 text-xs shrink-0" onClick={() => setDesignOpen(false)} data-testid="button-close-design">Done</Button>
          </div>
          <DesignPanel
            dealId={dealId}
            design={dealDesign.data}
            loading={dealDesign.isLoading}
            library={media}
            onPrintPreview={openPrintPreview}
          />
        </div>
      ) : selected && !readOnly ? (
        <SectionInspector
          key={selected.id}
          section={selected}
          api={builder}
          aiBlockedReason={gate.blockedReason}
          onChangeLayout={() => setLayoutOpen(true)}
          onRegenerate={() => { setRegenBrief(""); setRegenTarget(selected); }}
          onDelete={() => setDeleteTarget(selected)}
          onDraftChange={onDraftChange}
        />
      ) : (
        <div className="flex flex-col items-center justify-center h-full min-h-[240px] text-center p-6 gap-2">
          {readOnly ? <Eye className="h-7 w-7 opacity-25" /> : <Pencil className="h-7 w-7 opacity-25" />}
          <p className="text-xs text-muted-foreground max-w-[240px]">
            {readOnly
              ? "You're previewing what a buyer sees. Switch back to Editing to change sections."
              : "Select a section — on the page or in the list — to edit its title, layout and content, or to rewrite it with AI."}
          </p>
          {readOnly && <Button size="sm" variant="outline" className="h-7 text-xs mt-1" onClick={() => setPreviewAs("editor")}>Back to editing</Button>}
        </div>
      )}
    </div>
  );

  return (
    <div className="h-screen flex flex-col bg-background overflow-hidden">
      {/* ── Top bar ── */}
      <div className="border-b border-border shrink-0">
        <div className="flex items-center gap-1 sm:gap-2 px-2 sm:px-3 h-12">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => navigate(`/deal/${dealId}/cim`)} aria-label="Back to the deal">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold truncate" title={deal.businessName}>{deal.businessName}</p>
            <p className="hidden sm:block text-[10px] text-muted-foreground uppercase tracking-wider whitespace-nowrap">CIM builder</p>
          </div>
          {generation.isRunning && <CimGenerationProgress view={generation} compact className="hidden md:flex" />}
          {blind?.generated && (blind.running || blind.updating > 0) && (
            <span className="hidden md:inline-flex items-center gap-1.5 text-[11px] text-amber-500" title="Blind buyers see these sections once they're redacted">
              <Loader2 className="h-3 w-3 animate-spin" /> Blind version updating ({blind.updating})
            </span>
          )}
          <Select value={previewAs} onValueChange={(v) => setPreviewAs(v as PreviewAs)}>
            <SelectTrigger className="h-8 w-[58px] sm:w-[190px] shrink-0 text-xs" data-testid="select-preview-as" aria-label="Preview as">
              {/* div, not span: the trigger line-clamps direct span children */}
              <div className="flex items-center gap-1.5 min-w-0">
                {previewAs === "editor" ? <Pencil className="h-3 w-3 shrink-0" /> : <Eye className="h-3 w-3 shrink-0 text-amber-500" />}
                {/* Phones: icon only (pencil = editing, amber eye = previewing), so the deal name has room */}
                <span className="hidden sm:inline truncate">{previewAs === "editor" ? "Editing" : `Preview: ${previewMeta.label}`}</span>
                <span className="hidden"><SelectValue /></span>
              </div>
            </SelectTrigger>
            <SelectContent align="end">
              {PREVIEWS.map((p) => (
                <SelectItem key={p.key} value={p.key} className="text-xs">
                  <span className="block">{p.key === "editor" ? p.label : `Preview: ${p.label}`}</span>
                  <span className="block text-[10px] text-muted-foreground">{p.hint}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="ghost"
            size="sm"
            className={cn("h-8 text-xs gap-1.5 px-2 sm:px-3", designOpen ? "text-teal bg-teal/10" : "text-muted-foreground")}
            onClick={() => { setDesignOpen((o) => !o); setPane("edit"); }}
            title="Template, colours, logos and print preview"
            data-testid="button-cim-design"
          >
            <Palette className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Design</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="hidden md:inline-flex h-8 text-xs gap-1.5 text-muted-foreground px-2 sm:px-3"
            onClick={openPrintPreview}
            disabled={sections.length === 0}
            title="A print-friendly version of this CIM (broker only)"
            data-testid="button-print-preview"
          >
            <Printer className="h-3.5 w-3.5" />
            <span className="hidden xl:inline">Print</span>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-8 text-xs gap-1.5 text-muted-foreground px-2 sm:px-3"
            onClick={() => setMediaOpen(true)}
            title="Photos and videos uploaded for this deal"
            data-testid="button-media-library"
          >
            <Images className="h-3.5 w-3.5" />
            <span className="hidden sm:inline">Media{media.items.length ? ` (${media.items.length})` : ""}</span>
          </Button>
          {sections.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              className="hidden lg:inline-flex h-8 text-xs gap-1.5 text-muted-foreground"
              onClick={() => setRegenAllOpen(true)}
              disabled={generating || !!gate.blockedReason}
              title={gate.blockedReason ?? "Rebuild every section from scratch"}
            >
              {generating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
              Regenerate all
            </Button>
          )}
          <Button
            size="sm"
            className="h-8 text-xs gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90 shrink-0"
            onClick={() => { setPreviewAs("editor"); openAdd(selectedId ?? undefined); }}
            data-testid="button-add-section-top"
          >
            <Plus className="h-3.5 w-3.5" /> <span className="hidden sm:inline">Add section</span>
          </Button>
        </div>
        {/* Narrow screens: one pane at a time */}
        <div className="lg:hidden grid grid-cols-3 gap-1 px-3 pb-2" role="tablist">
          {(["sections", "page", "edit"] as const).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={pane === p}
              onClick={() => setPane(p)}
              className={cn(
                "rounded-md py-1.5 text-xs font-medium transition-colors",
                pane === p ? "bg-teal/15 text-foreground" : "text-muted-foreground hover:bg-muted/60",
              )}
            >
              {p === "sections" ? `Sections (${sections.length})` : p === "page" ? "Page" : designOpen ? "Design" : "Edit"}
            </button>
          ))}
        </div>
        {generation.isRunning && <div className="md:hidden px-3 pb-2"><CimGenerationProgress view={generation} compact /></div>}
      </div>

      {/* ── Body ── */}
      <div className="flex-1 min-h-0 lg:grid lg:grid-cols-[280px_minmax(0,1fr)_360px]">
        <div className={cn("h-full min-h-0 lg:border-r border-border", pane === "sections" ? "block" : "hidden lg:block")}>{listPane}</div>
        <div className={cn("h-full min-h-0", pane === "page" ? "block" : "hidden lg:block")}>{pagePane}</div>
        <div className={cn("h-full min-h-0 lg:border-l border-border", pane === "edit" ? "block" : "hidden lg:block")}>{editPane}</div>
      </div>

      {/* ── Media library ── */}
      <Sheet open={mediaOpen} onOpenChange={setMediaOpen}>
        <SheetContent side="right" className="w-full sm:max-w-xl overflow-y-auto">
          <SheetHeader className="mb-4">
            <SheetTitle>Media library</SheetTitle>
            <SheetDescription>
              Photos and videos for this deal. Use them in any photo gallery or video section — add one from the “Media” group of Add section.
            </SheetDescription>
          </SheetHeader>
          <MediaLibrary dealId={dealId} library={media} mode="manage" />
        </SheetContent>
      </Sheet>

      {/* ── Dialogs ── */}
      <AddSectionDialog
        open={addAt.open}
        onOpenChange={(open) => setAddAt((a) => ({ ...a, open }))}
        sections={sections}
        afterSectionId={addAt.afterId}
        aiBlockedReason={gate.blockedReason}
        busy={builder.add.isPending}
        onSubmit={(input) =>
          builder.add.mutate(input, {
            onSuccess: (r: any) => {
              setAddAt({ open: false });
              if (r?.section?.id) {
                setSelectedId(r.section.id);
                setPane("edit");
                setTimeout(() => document.getElementById(`section-${r.section.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 400);
              }
            },
          })
        }
      />
      {selected && (
        <ChangeLayoutDialog
          open={layoutOpen}
          onOpenChange={setLayoutOpen}
          currentLayout={selected.layoutType}
          sectionTitle={selected.sectionTitle}
          aiBlockedReason={gate.blockedReason}
          busy={builder.setLayout.isPending}
          onChoose={(layoutType, convert) =>
            builder.setLayout.mutate({ id: selected.id, layoutType, convert }, { onSuccess: () => setLayoutOpen(false) })
          }
        />
      )}

      <AlertDialog open={!!deleteTarget} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleteTarget?.sectionTitle}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The section is removed from the CIM, along with its blind and due-diligence versions. This can't be undone —
              if you only want buyers not to see it, hide it instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            {deleteTarget?.isVisible !== false && (
              <Button variant="outline" onClick={() => { if (deleteTarget) builder.patch.mutate({ id: deleteTarget.id, isVisible: false }); setDeleteTarget(null); }}>
                Hide instead
              </Button>
            )}
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (deleteTarget) builder.remove.mutate(deleteTarget.id); setDeleteTarget(null); }}
              data-testid="button-confirm-delete-section"
            >
              Delete section
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={!!regenTarget} onOpenChange={(o) => !o && setRegenTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate “{regenTarget?.sectionTitle}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The AI rebuilds this section from the deal's information. Your current version is kept — Undo brings it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            value={regenBrief}
            onChange={(e) => setRegenBrief(e.target.value)}
            maxLength={1500}
            rows={3}
            className="text-sm resize-none"
            placeholder="Optional: anything it should focus on?"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-teal text-teal-foreground hover:bg-teal/90"
              onClick={() => { if (regenTarget) builder.regenerate.mutate({ id: regenTarget.id, brief: regenBrief.trim() || undefined }); setRegenTarget(null); }}
            >
              <Sparkles className="h-3.5 w-3.5 mr-1.5" /> Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={regenAllOpen} onOpenChange={setRegenAllOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate the whole CIM?</AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>This rebuilds every section from scratch. These are discarded and can't be undone:</p>
                <ul className="list-disc pl-5 space-y-1">
                  <li>Sections you added, edited, rewrote or reordered</li>
                  <li>Approvals ({approvedCount} of {sections.length}), hidden sections and access settings</li>
                  <li>The blind and due-diligence versions</li>
                </ul>
                <p>To redo one section, select it and choose “Regenerate from the deal's information”.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep my CIM</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { setRegenAllOpen(false); generateAll.mutate(); }}
            >
              Discard and regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Preview banner (app chrome above the paper) ─────────────────────────
function PreviewBanner({
  previewAs, hint, blindGenerated, blindUpdating, blindError, ddGenerated, loading, busy, onGenerate, onRetryBlind, onBackToEditing,
}: {
  previewAs: PreviewAs;
  hint: string;
  blindGenerated: boolean;
  blindUpdating: number;
  blindError: string | null;
  ddGenerated: boolean;
  loading: boolean;
  busy: boolean;
  onGenerate: (m: "blind" | "dd") => void;
  onRetryBlind: () => void;
  onBackToEditing: () => void;
}) {
  const blindView = previewAs === "teaser" || previewAs === "full";
  const label = PREVIEWS.find((p) => p.key === previewAs)?.label ?? "";
  return (
    <div className="space-y-2">
      <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs flex flex-wrap items-center gap-x-3 gap-y-1.5">
        {blindView ? <Lock className="h-3.5 w-3.5 text-amber-500" /> : <Unlock className="h-3.5 w-3.5 text-teal" />}
        <span><span className="font-medium">Previewing as a {label.toLowerCase()}</span> <span className="text-muted-foreground">— {hint}. Read-only.</span></span>
        {loading && <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />}
        <button type="button" onClick={onBackToEditing} className="ml-auto text-teal hover:underline">Back to editing</button>
      </div>
      {blindView && !blindGenerated && (
        <Notice tone="amber" action={<Button size="sm" className="h-7 text-xs bg-amber-500 text-black hover:bg-amber-400" disabled={busy} onClick={() => onGenerate("blind")}>{busy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}Generate blind version</Button>}>
          No blind version yet. Buyers on teaser or full links see “Preparing your confidential view” until it exists (it's also created automatically on the first visit).
        </Notice>
      )}
      {blindView && blindGenerated && blindUpdating > 0 && (
        <Notice tone="amber" action={blindError ? <Button size="sm" variant="outline" className="h-7 text-xs" onClick={onRetryBlind}>Retry</Button> : undefined}>
          {blindError
            ? blindError
            : `${blindUpdating} section${blindUpdating === 1 ? " is" : "s are"} being redacted. Blind buyers see ${blindUpdating === 1 ? "it" : "them"} as soon as ${blindUpdating === 1 ? "it's" : "they're"} ready — never the un-redacted text.`}
        </Notice>
      )}
      {previewAs === "due_diligence" && !ddGenerated && (
        <Notice tone="blue" action={<Button size="sm" className="h-7 text-xs bg-blue-500 text-white hover:bg-blue-400" disabled={busy} onClick={() => onGenerate("dd")}>{busy ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}Generate DD version</Button>}>
          No due-diligence version yet — DD buyers currently see the named CIM without the extra detail.
        </Notice>
      )}
    </div>
  );
}

function Notice({ tone, children, action }: { tone: "amber" | "blue"; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={cn(
      "rounded-lg border px-3 py-2.5 text-xs flex flex-col sm:flex-row sm:items-center gap-2",
      tone === "amber" ? "border-amber-500/40 bg-amber-500/10" : "border-blue-500/40 bg-blue-500/10",
    )}>
      <p className="flex-1 text-foreground/85 leading-relaxed">{children}</p>
      {action}
    </div>
  );
}

function EmptyCim({
  generating, blockedReason, onGenerate, onAddBlank, generationView,
}: {
  generating: boolean;
  blockedReason: string | null;
  onGenerate: () => void;
  onAddBlank: () => void;
  generationView: ReturnType<typeof useCimGeneration>;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center max-w-lg mx-auto mt-10 space-y-3">
      <Wand2 className="h-8 w-8 mx-auto text-teal/60" />
      <p className="text-sm font-medium">No CIM yet</p>
      <p className="text-xs text-muted-foreground">
        Let the AI design a complete CIM from the deal's information — charts, tables and narrative — then shape it here.
        Or start with a blank section.
      </p>
      {generationView.isRunning ? (
        <CimGenerationProgress view={generationView} className="text-left" />
      ) : (
        <>
          {generationView.job?.status === "failed" && <CimGenerationProgress view={generationView} className="text-left" />}
          {blockedReason && <p className="text-xs text-red-400">{blockedReason}</p>}
          <div className="flex flex-col sm:flex-row gap-2 justify-center pt-1">
            <Button className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5" onClick={onGenerate} disabled={generating || !!blockedReason}>
              {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Generate the CIM
            </Button>
            <Button variant="outline" onClick={onAddBlank}><Plus className="h-4 w-4 mr-1.5" /> Add a section</Button>
          </div>
        </>
      )}
    </div>
  );
}
