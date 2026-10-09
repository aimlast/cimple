/**
 * TeaserEditor — /deal/:dealId/teaser (broker only), the teaser's builder.
 *
 *   Left (260 px):  the blocks — drag to reorder, "+" between rows, a menu per block.
 *   Centre:         real pages (Letter or A4) with the fit indicator above
 *                   ("Fits on 1 page" / "Runs onto page 3 by about 6 lines").
 *   Right (340 px): the inspector — words, key numbers, layout, Rewrite with AI.
 * Top: Template · Look · Page · Numbers, Undo, Preview as a buyer, Print
 * preview, ⋯ (Save as my teaser template, Ask the seller to check it, Teaser
 * settings, Take it offline, Delete) and Publish.
 *
 * Below 1024 px: tabs Blocks · Page · Edit; on phones the top bar keeps Back,
 * the title and a ⋯ menu, and the pages are one continuous sheet.
 * ?block=<id> keeps the selected block in the URL; ?preview=1 opens the
 * buyer's view (read-only).
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, Eye, Loader2, MoreHorizontal, PauseCircle, Pencil, Printer, Save, Settings2, Trash2, Undo2, UserCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { PanelError } from "@/components/deal/PanelError";
import { buildCimDesign } from "@/components/cim/CimDesignContext";
import { useTemplates } from "@/components/cim-design/api";
import { cn } from "@/lib/utils";
import { TEASER_PAGE_SIZES, type TeaserBlock } from "@shared/teaser";
import { useTeaser } from "@/components/teaser/useTeaser";
import {
  hasTeaser, shortDay, teaserPreviewKey, teaserRequest, teaserTemplatesKey,
  type SavedTemplateItem, type TeaserPreviewPayload, type TeaserState,
} from "@/components/teaser/api";
import { TeaserPages, type TeaserLayoutInfo } from "@/components/teaser/TeaserPages";
import { TeaserFitIndicator } from "@/components/teaser/TeaserFitIndicator";
import { TeaserBlockList } from "@/components/teaser/TeaserBlockList";
import { TeaserInspector } from "@/components/teaser/TeaserInspector";
import { TeaserSettingsFields } from "@/components/teaser/TeaserSettings";
import { TeaserPublishButton } from "@/components/teaser/TeaserPublishDialog";
import { SaveTeaserTemplateDialog } from "@/components/teaser/SaveTeaserTemplateDialog";
import { AddTeaserBlockDialog, ChangeTeaserLayoutDialog } from "@/components/teaser/TeaserBlockDialogs";
import { blockName, checkFor, draftSections, heldSentence } from "@/components/teaser/draft-view";
import { TEASER_TEMPLATES, TEASER_TEMPLATE_KEYS_ORDER, templateTargetPages } from "@/components/teaser/template-order";

type Pane = "blocks" | "page" | "edit";

function useQueryParam(name: string): [string | null, (v: string | null) => void] {
  const [, navigate] = useLocation();
  const [value, setValue] = useState<string | null>(() => new URLSearchParams(window.location.search).get(name));
  const set = useCallback((v: string | null) => {
    setValue(v);
    const q = new URLSearchParams(window.location.search);
    if (v) q.set(name, v);
    else q.delete(name);
    const qs = q.toString();
    navigate(`${window.location.pathname}${qs ? `?${qs}` : ""}`, { replace: true });
  }, [name, navigate]);
  return [value, set];
}

export default function TeaserEditor() {
  const { dealId = "" } = useParams<{ dealId: string }>();
  const [, navigate] = useLocation();
  const api = useTeaser(dealId);
  const [selectedId, setSelectedId] = useQueryParam("block");
  const [previewParam, setPreviewParam] = useQueryParam("preview");
  const preview = previewParam === "1";
  const [pane, setPane] = useState<Pane>(() => (new URLSearchParams(window.location.search).get("block") ? "edit" : "page"));
  const [layout, setLayout] = useState<TeaserLayoutInfo | null>(null);
  const [addAfter, setAddAfter] = useState<{ open: boolean; after: string | null }>({ open: false, after: null });
  const [layoutFor, setLayoutFor] = useState<TeaserBlock | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<TeaserBlock | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [offlineOpen, setOfflineOpen] = useState(false);
  const [deleteTeaserOpen, setDeleteTeaserOpen] = useState(false);
  const [sellerOpen, setSellerOpen] = useState(false);

  const state = api.state;
  const read = api.query.data;
  const backToTab = useCallback(() => navigate(`/deal/${dealId}/cim?view=teaser`), [navigate, dealId]);

  // No teaser (or deleted from another tab) → back to the Teaser tab.
  const empty = !!read && (!hasTeaser(read) || (read.teaser.draft.blocks.length === 0 && read.teaser.generation?.status !== "running"));
  useEffect(() => {
    if (empty) backToTab();
  }, [empty, backToTab]);

  if (api.query.isLoading) {
    return (
      <div className="flex h-screen flex-col bg-background" data-testid="teaser-editor-loading">
        <div className="flex h-12 items-center gap-3 border-b border-border px-3"><Skeleton className="h-6 w-56" /></div>
        <div className="grid flex-1 gap-4 p-4 lg:grid-cols-[260px_minmax(0,1fr)_340px]">
          <Skeleton className="hidden h-full lg:block" />
          <Skeleton className="h-full" />
          <Skeleton className="hidden h-full lg:block" />
        </div>
      </div>
    );
  }
  if (api.query.error) {
    return <div className="p-6"><PanelError what="the teaser" onRetry={() => api.query.refetch()} /></div>;
  }
  if (!state || empty) {
    return <div className="flex h-screen items-center justify-center text-sm text-muted-foreground"><Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening the Teaser tab…</div>;
  }
  return (
    <EditorBody
      dealId={dealId}
      api={api}
      state={state}
      selectedId={selectedId}
      setSelectedId={setSelectedId}
      preview={preview}
      setPreview={(on) => setPreviewParam(on ? "1" : null)}
      pane={pane}
      setPane={setPane}
      layout={layout}
      setLayout={setLayout}
      onBack={backToTab}
      dialogs={{ addAfter, setAddAfter, layoutFor, setLayoutFor, deleteTarget, setDeleteTarget, settingsOpen, setSettingsOpen, saveOpen, setSaveOpen, offlineOpen, setOfflineOpen, deleteTeaserOpen, setDeleteTeaserOpen, sellerOpen, setSellerOpen }}
    />
  );
}

interface Dialogs {
  addAfter: { open: boolean; after: string | null };
  setAddAfter: (v: { open: boolean; after: string | null }) => void;
  layoutFor: TeaserBlock | null;
  setLayoutFor: (b: TeaserBlock | null) => void;
  deleteTarget: TeaserBlock | null;
  setDeleteTarget: (b: TeaserBlock | null) => void;
  settingsOpen: boolean;
  setSettingsOpen: (o: boolean) => void;
  saveOpen: boolean;
  setSaveOpen: (o: boolean) => void;
  offlineOpen: boolean;
  setOfflineOpen: (o: boolean) => void;
  deleteTeaserOpen: boolean;
  setDeleteTeaserOpen: (o: boolean) => void;
  sellerOpen: boolean;
  setSellerOpen: (o: boolean) => void;
}

function EditorBody({
  dealId, api, state, selectedId, setSelectedId, preview, setPreview, pane, setPane, layout, setLayout, onBack, dialogs: d,
}: {
  dealId: string;
  api: ReturnType<typeof useTeaser>;
  state: TeaserState;
  selectedId: string | null;
  setSelectedId: (v: string | null) => void;
  preview: boolean;
  setPreview: (on: boolean) => void;
  pane: Pane;
  setPane: (p: Pane) => void;
  layout: TeaserLayoutInfo | null;
  setLayout: (l: TeaserLayoutInfo | null) => void;
  onBack: () => void;
  dialogs: Dialogs;
}) {
  const [, navigate] = useLocation();
  const t = state.teaser;
  const s = state.summary;
  const design = useMemo(() => buildCimDesign(state.design ?? null, "blind"), [state.design]);
  const sections = useMemo(() => draftSections(t.draft, dealId, state.fill), [t.draft, dealId, state.fill]);
  const header = t.draft.header ? { ...t.draft.header, codename: t.codename } : null;
  const running = t.generation?.status === "running";
  const writing = useMemo(() => {
    if (!running) return new Set<string>();
    const owned = t.generation?.ownedBlockIds ?? [];
    return new Set(t.generation?.fullRewrite || owned.length === 0 ? t.draft.blocks.map((b) => b.id) : owned);
  }, [running, t.generation, t.draft.blocks]);
  const sellerFlagged = useMemo(() => {
    const note = (s.seller.state === "changes_requested" ? s.seller.note : null)?.toLowerCase() ?? "";
    if (!note) return new Set<string>();
    return new Set(t.draft.blocks.filter((b) => {
      const n = blockName(b).toLowerCase();
      return n.length > 3 && note.includes(n);
    }).map((b) => b.id));
  }, [s.seller, t.draft.blocks]);
  const { data: saved } = useQuery<{ templates: SavedTemplateItem[] }>({
    queryKey: teaserTemplatesKey,
    queryFn: () => teaserRequest("GET", "/api/broker/teaser-templates"),
  });
  const looks = useTemplates();
  const target = templateTargetPages(t.templateKey, saved?.templates.find((x) => x.key === t.templateKey)?.basedOn);

  const select = (id: string | null) => {
    setSelectedId(id);
    if (id) setPane("edit");
  };
  const decorate = (id: string) => {
    if (id === "header") return t.headerProblem ? { tone: "held" as const, label: "Names the business" } : null;
    const b = t.draft.blocks.find((x) => x.id === id);
    if (!b) return null;
    if (b.placeholder) return { tone: "placeholder" as const, label: "Write this" };
    if (writing.has(id)) return { tone: "pinpoint" as const, label: "Writing…" };
    const held = heldSentence(checkFor(t.checks, id));
    if (held) return { tone: "held" as const, label: "Hidden from buyers" };
    if ((checkFor(t.checks, id)?.pinpoint.length ?? 0) > 0) return { tone: "pinpoint" as const, label: "May be recognisable" };
    return null;
  };
  const statusChip = s.status === "published" ? { text: s.changedSincePublish > 0 ? "Published · changes not shared yet" : `Published ${shortDay(s.publishedAt)}`, cls: "bg-success-muted text-success-muted-foreground" }
    : s.status === "offline" ? { text: "Offline", cls: "bg-muted text-muted-foreground" }
    : { text: "Draft", cls: "bg-amber-500/10 text-amber-500" };

  const templateSelect = (
    <Select value={t.templateKey} onValueChange={(v) => v !== t.templateKey && api.settings.mutate({ templateKey: v })} disabled={running || api.settings.isPending}>
      <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="Template" data-testid="select-teaser-template"><SelectValue /></SelectTrigger>
      <SelectContent>
        {(saved?.templates ?? []).map((x) => <SelectItem key={x.key} value={x.key} className="text-xs">{x.name}</SelectItem>)}
        {TEASER_TEMPLATE_KEYS_ORDER.map((k) => <SelectItem key={k} value={k} className="text-xs">{TEASER_TEMPLATES[k].name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
  const lookSelect = (
    <Select value={t.designTemplateId ?? "__cim"} onValueChange={(v) => api.settings.mutate({ designTemplateId: v === "__cim" ? null : v })} disabled={api.settings.isPending}>
      <SelectTrigger className="h-8 w-[160px] text-xs" aria-label="Look" data-testid="select-teaser-look"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="__cim" className="text-xs">Same as the CIM</SelectItem>
        {(looks.data?.templates ?? []).map((x) => <SelectItem key={x.id} value={x.id} className="text-xs">{x.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
  const pageSelect = (
    <Select value={t.pageSize} onValueChange={(v) => v !== t.pageSize && api.settings.mutate({ pageSize: v })} disabled={api.settings.isPending}>
      <SelectTrigger className="h-8 w-[92px] text-xs" aria-label="Page size" data-testid="select-teaser-page"><SelectValue /></SelectTrigger>
      <SelectContent>
        {(["letter", "a4"] as const).map((k) => <SelectItem key={k} value={k} className="text-xs">{TEASER_PAGE_SIZES[k].label}</SelectItem>)}
      </SelectContent>
    </Select>
  );
  const numbersSelect = (
    <Select value={t.numbers} onValueChange={(v) => v !== t.numbers && api.settings.mutate({ numbers: v })} disabled={api.settings.isPending}>
      <SelectTrigger className="h-8 w-[150px] text-xs" aria-label="Numbers" data-testid="select-teaser-numbers"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="ranges" className="text-xs">Ranges ($1M–$2M)</SelectItem>
        <SelectItem value="rounded" className="text-xs">Rounded ($1.3M)</SelectItem>
      </SelectContent>
    </Select>
  );

  const moreMenu = (phone: boolean) => (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="More" data-testid={phone ? "button-teaser-editor-more-phone" : "button-teaser-editor-more"}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        {phone && (
          <>
            <DropdownMenuItem onSelect={() => d.setSettingsOpen(true)}><Settings2 className="mr-2 h-3.5 w-3.5" /> Template, look, page and numbers</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setPreview(!preview)}><Eye className="mr-2 h-3.5 w-3.5" /> {preview ? "Back to editing" : "Preview as a buyer"}</DropdownMenuItem>
            <DropdownMenuItem onSelect={() => navigate(`/deal/${dealId}/teaser/print`)}><Printer className="mr-2 h-3.5 w-3.5" /> Print preview</DropdownMenuItem>
            <DropdownMenuItem disabled={!t.canUndo || api.undo.isPending} onSelect={() => api.undo.mutate()}><Undo2 className="mr-2 h-3.5 w-3.5" /> Undo</DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem onSelect={() => d.setSaveOpen(true)}><Save className="mr-2 h-3.5 w-3.5" /> Save as my teaser template</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => d.setSellerOpen(true)} disabled={!state.sellerOwner}><UserCheck className="mr-2 h-3.5 w-3.5" /> Ask the seller to check it</DropdownMenuItem>
        {!phone && <DropdownMenuItem onSelect={() => d.setSettingsOpen(true)}><Settings2 className="mr-2 h-3.5 w-3.5" /> Teaser settings</DropdownMenuItem>}
        <DropdownMenuSeparator />
        {s.status === "published" && <DropdownMenuItem onSelect={() => d.setOfflineOpen(true)}><PauseCircle className="mr-2 h-3.5 w-3.5" /> Take it offline</DropdownMenuItem>}
        <DropdownMenuItem className="text-red-500 focus:text-red-500" onSelect={() => d.setDeleteTeaserOpen(true)}><Trash2 className="mr-2 h-3.5 w-3.5" /> Delete the teaser</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background" data-testid="teaser-editor">
      {/* ── Top bar ── */}
      <div className="shrink-0 border-b border-border">
        <div className="flex h-12 items-center gap-1 px-2 sm:gap-2 sm:px-3">
          <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={onBack} aria-label="Back to the CIM tab">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="flex min-w-0 items-center gap-2 text-sm font-semibold">
              <span className="truncate">Teaser — {t.codename}</span>
              <span className={cn("hidden shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium sm:inline", statusChip.cls)} data-testid="teaser-editor-status">{statusChip.text}</span>
            </p>
            <p className="hidden text-[10px] uppercase tracking-wider text-muted-foreground sm:block">{t.templateName}</p>
          </div>
          <div className="hidden items-center gap-1.5 lg:flex">
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground" onClick={() => api.undo.mutate()} disabled={!t.canUndo || api.undo.isPending || running} data-testid="button-teaser-undo">
              <Undo2 className="h-3.5 w-3.5" /> Undo
            </Button>
            <Button variant="ghost" size="sm" className={cn("h-8 gap-1.5 text-xs", preview ? "bg-teal/10 text-teal" : "text-muted-foreground")} onClick={() => setPreview(!preview)} data-testid="button-teaser-preview-toggle">
              {preview ? <Pencil className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />} {preview ? "Back to editing" : "Preview as a buyer"}
            </Button>
            <Button variant="ghost" size="sm" className="h-8 gap-1.5 text-xs text-muted-foreground" onClick={() => navigate(`/deal/${dealId}/teaser/print`)} data-testid="button-teaser-print">
              <Printer className="h-3.5 w-3.5" /> Print preview
            </Button>
            {moreMenu(false)}
          </div>
          <div className="lg:hidden">{moreMenu(true)}</div>
          <TeaserPublishButton api={api} state={state} />
        </div>
        {/* Settings strip (wide screens) */}
        <div className="hidden flex-wrap items-center gap-x-4 gap-y-2 px-3 pb-2 lg:flex">
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">Template {templateSelect}</label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">Look {lookSelect}</label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">Page {pageSelect}</label>
          <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">Numbers {numbersSelect}</label>
        </div>
        {/* Narrow screens: one pane at a time */}
        <div className="grid grid-cols-3 gap-1 px-3 pb-2 lg:hidden" role="tablist">
          {(["blocks", "page", "edit"] as const).map((p) => (
            <button
              key={p}
              role="tab"
              aria-selected={pane === p}
              onClick={() => setPane(p)}
              className={cn("rounded-md py-1.5 text-xs font-medium transition-colors", pane === p ? "bg-teal/15 text-foreground" : "text-muted-foreground hover:bg-muted/60")}
            >
              {p === "blocks" ? `Blocks (${t.draft.blocks.length})` : p === "page" ? "Page" : "Edit"}
            </button>
          ))}
        </div>
      </div>

      {running && (
        <div className="flex shrink-0 items-center gap-2 border-b border-teal/30 bg-teal/5 px-4 py-2 text-xs" role="status" data-testid="teaser-editor-writing">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-teal" /> Writing your teaser — about 30 seconds. {t.generation?.fullRewrite ? "Editing waits until it's done." : "The blocks it's filling are marked."}
        </div>
      )}
      {preview && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-4 py-2 text-xs" data-testid="teaser-preview-banner">
          <Eye className="h-3.5 w-3.5 text-amber-500" />
          <span><span className="font-medium">Previewing what a buyer sees</span> <span className="text-muted-foreground">— the draft, exactly as it would be served. Read-only.</span></span>
          <button type="button" className="ml-auto text-teal hover:underline" onClick={() => setPreview(false)}>Back to editing</button>
        </div>
      )}

      {/* ── Body ── */}
      <div className="min-h-0 flex-1 lg:grid lg:grid-cols-[260px_minmax(0,1fr)_340px]">
        <div className={cn("h-full min-h-0 overflow-y-auto border-border lg:border-r", pane === "blocks" ? "block" : "hidden lg:block")}>
          <TeaserBlockList
            blocks={t.draft.blocks}
            checks={t.checks}
            selectedId={selectedId}
            headerProblem={t.headerProblem}
            writing={writing}
            sellerFlagged={sellerFlagged}
            disabled={running && !!t.generation?.fullRewrite}
            onSelect={(id) => select(id)}
            onReorder={(ids) => api.reorder.mutate(ids)}
            onAddAfter={(after) => d.setAddAfter({ open: true, after })}
            onRename={(id, title) => api.patchBlock.mutate({ id, title })}
            onDuplicate={(id) => api.duplicate.mutate(id)}
            onToggleHidden={(b) => api.patchBlock.mutate({ id: b.id, hidden: !b.hidden })}
            onDelete={(b) => d.setDeleteTarget(b)}
          />
        </div>
        <div className={cn("h-full min-h-0 overflow-y-auto bg-muted/20", pane === "page" ? "block" : "hidden lg:block")}>
          <div className="mx-auto max-w-[860px] px-3 py-4 sm:px-6">
            {preview ? (
              <BuyerPreview dealId={dealId} rev={t.draftRev} />
            ) : (
              <>
                <div className="mb-3 flex items-center justify-center">
                  <TeaserFitIndicator info={layout} targetPages={target} />
                </div>
                <TeaserPages
                  header={header}
                  sections={sections}
                  pageSize={t.pageSize}
                  design={design}
                  mode="editor"
                  selectedId={selectedId}
                  onSelect={select}
                  decorate={decorate}
                  headerWarning={t.headerProblem}
                  onLayout={setLayout}
                  className={cn(running && "animate-pulse")}
                />
              </>
            )}
          </div>
        </div>
        <div className={cn("h-full min-h-0 overflow-y-auto border-border lg:border-l", pane === "edit" ? "block" : "hidden lg:block")}>
          {preview ? (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-2 p-6 text-center">
              <Eye className="h-7 w-7 opacity-25" />
              <p className="max-w-[240px] text-xs text-muted-foreground">You're previewing what a buyer sees. Go back to editing to change blocks.</p>
              <Button size="sm" variant="outline" className="mt-1 h-7 text-xs" onClick={() => setPreview(false)}>Back to editing</Button>
            </div>
          ) : (
            <TeaserInspector
              api={api}
              state={state}
              selectedId={selectedId}
              writing={writing}
              onChangeLayout={(b) => d.setLayoutFor(b)}
              onDelete={(b) => d.setDeleteTarget(b)}
              onSelect={select}
            />
          )}
        </div>
      </div>

      {/* ── Dialogs ── */}
      <AddTeaserBlockDialog
        open={d.addAfter.open}
        onOpenChange={(open) => d.setAddAfter({ ...d.addAfter, open })}
        busy={api.addBlock.isPending}
        onSubmit={(v) => api.addBlock.mutate({ after: d.addAfter.after, ...v }, {
          onSuccess: (st) => {
            d.setAddAfter({ open: false, after: null });
            const known = new Set(t.draft.blocks.map((b) => b.id));
            const added = st.teaser.draft.blocks.find((b) => !known.has(b.id));
            if (added) select(added.id);
          },
        })}
      />
      {d.layoutFor && (
        <ChangeTeaserLayoutDialog
          open={!!d.layoutFor}
          onOpenChange={(o) => !o && d.setLayoutFor(null)}
          current={d.layoutFor.layoutType}
          title={blockName(d.layoutFor)}
          busy={api.setLayout.isPending}
          onChoose={(layoutType, convert) => api.setLayout.mutate({ id: d.layoutFor!.id, layoutType, convert }, { onSuccess: () => d.setLayoutFor(null) })}
        />
      )}
      <AlertDialog open={!!d.deleteTarget} onOpenChange={(o) => !o && d.setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{d.deleteTarget ? blockName(d.deleteTarget) : ""}”?</AlertDialogTitle>
            <AlertDialogDescription>It comes out of the teaser. Undo brings it back. To keep it but not show it, hide it instead.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            {d.deleteTarget && !d.deleteTarget.hidden && (
              <Button variant="outline" onClick={() => { api.patchBlock.mutate({ id: d.deleteTarget!.id, hidden: true }); d.setDeleteTarget(null); }}>Hide instead</Button>
            )}
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => { if (d.deleteTarget) { api.removeBlock.mutate(d.deleteTarget.id); if (selectedId === d.deleteTarget.id) select(null); } d.setDeleteTarget(null); }}
              data-testid="button-confirm-delete-teaser-block"
            >
              Delete block
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Sheet open={d.settingsOpen} onOpenChange={d.setSettingsOpen}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader className="mb-4">
            <SheetTitle>Teaser settings</SheetTitle>
            <SheetDescription>How this teaser looks and how its links behave.</SheetDescription>
          </SheetHeader>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 lg:hidden">
              <label className="space-y-1 text-xs"><span className="block text-muted-foreground">Template</span>{templateSelect}</label>
              <label className="space-y-1 text-xs"><span className="block text-muted-foreground">Look</span>{lookSelect}</label>
              <label className="space-y-1 text-xs"><span className="block text-muted-foreground">Page</span>{pageSelect}</label>
            </div>
            <TeaserSettingsFields api={api} state={state} />
          </div>
        </SheetContent>
      </Sheet>
      <SaveTeaserTemplateDialog api={api} open={d.saveOpen} onOpenChange={d.setSaveOpen} />
      <AlertDialog open={d.sellerOpen} onOpenChange={d.setSellerOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Send the teaser draft to {state.sellerOwner ?? "the seller"} to check?</AlertDialogTitle>
            <AlertDialogDescription>They'll see it on their review page and can approve it or ask for changes. Nothing goes to buyers until you publish.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => api.sellerCheck.mutate()}>Send it</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={d.offlineOpen} onOpenChange={d.setOfflineOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Take the teaser offline?</AlertDialogTitle>
            <AlertDialogDescription>Buyers with a teaser link will see “not available right now” until you publish it again. Buyers who have the CIM aren't affected.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it online</AlertDialogCancel>
            <AlertDialogAction onClick={() => api.unpublish.mutate()}>Take it offline</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={d.deleteTeaserOpen} onOpenChange={d.setDeleteTeaserOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the teaser?</AlertDialogTitle>
            <AlertDialogDescription>Buyers with a teaser link will see “not available right now”. Buyers who have the CIM aren't affected. This can't be undone.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" onClick={() => api.remove.mutate()}>Delete the teaser</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** The draft exactly as a buyer would be served it (GET …/teaser/preview?draft=1). */
function BuyerPreview({ dealId, rev }: { dealId: string; rev: number }) {
  const q = useQuery<TeaserPreviewPayload>({
    queryKey: [...teaserPreviewKey(dealId, true), rev],
    queryFn: () => teaserRequest("GET", `/api/deals/${dealId}/teaser/preview?draft=1`),
  });
  const design = useMemo(() => buildCimDesign(q.data?.design ?? null, "blind"), [q.data?.design]);
  if (q.isLoading) return <Skeleton className="mx-auto h-[70vh] max-w-[816px] rounded-md" />;
  if (q.error || !q.data) return <PanelError what="the preview" onRetry={() => q.refetch()} />;
  return (
    <div className="space-y-3">
      {q.data.heldBack.length > 0 && (
        <p className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs" role="status">
          {q.data.heldBack.length === 1 ? "1 block isn't" : `${q.data.heldBack.length} blocks aren't`} in this preview — buyers won't see {q.data.heldBack.length === 1 ? "it" : "them"} until reworded.
        </p>
      )}
      <TeaserPages header={q.data.teaser.header} sections={q.data.teaser.blocks} pageSize={q.data.teaser.pageSize} design={design} mode="seller" />
    </div>
  );
}
