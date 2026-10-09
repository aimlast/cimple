/**
 * Document view — the heat map on the real CIM.
 *
 *   top      "How far buyers got": buyers who reached each page, with the
 *            steepest drop named in a sentence
 *   left     the page rail (tiles, document order or most time first)
 *   centre   the selected page exactly as buyers saw it, its parts glowing
 *            by reading time (PageCanvas), with one sentence on what matters
 *            and Prev / Next
 *   right    "This page": totals, buyers, parts ranked, what they did,
 *            questions, what holds attention
 *   table    every page in one table (switch above the rail)
 *
 * A section buyers could collapse (a long income statement) opens as they
 * first saw it — collapsed, its summary painted — with a "Collapsed |
 * Opened" switch; the opened view shows what the buyers who opened it read.
 *
 * Blind versions render what the blind buyer saw (codename, redacted
 * titles); the rail adds "Buyer saw: …" under the real title, and a switch
 * shows the named version of the same page. Part-by-part heat is drawn on the
 * named version only when both versions have the same parts.
 *
 * A page whose reading is known only as a total (recorded before Cimple
 * tracked each part, or on a version with different parts) is never blank:
 * the whole page is shaded by its reading time with its rank on it
 * (drawMode "wash"). One status line above the page says how the colours
 * were made; "Why?" holds every note (StatusLine).
 *
 * Phones: chips (with heat swatches) instead of the rail, the page full
 * width, a collapsed "How far buyers got" row, the chrome above the paper
 * kept under ~280 px (the layout switch and the named-version switch become
 * icons; the page headline moves into the "This page" sheet), a peek bar at
 * the bottom that opens "This page" as a sheet, and a tapped part (or the
 * tapped whole page) opens its details as a sheet. Swipe left/right changes
 * page.
 *
 * Owned by the heatmap stream.
 */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { AlertCircle, ChevronLeft, ChevronRight, ChevronUp, Eye, EyeOff, FileSearch, LayoutList, RefreshCw, Rows3, Users } from "lucide-react";
import {
  formatReadingTime,
  viewerPageKey,
  type DocumentPage,
  type EngagementDocumentResponse,
  type EngagementRenditionResponse,
} from "@shared/analytics-v2";
import { useEngagementBuyers, useEngagementDocument, useEngagementRendition } from "@/hooks/useEngagement";
import { useIsMobile } from "@/hooks/use-mobile";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { EngagementViewProps } from "../types";
import { Segmented } from "../FilterBar";
import { BlockDetails, PageCanvas, WashDetails, type WashCard } from "./PageCanvas";
import { PagePanel, ReadLabelChip } from "./PagePanel";
import { PageChips, PageRail } from "./PageRail";
import { PageTable } from "./PageTable";
import { ReachChart } from "./ReachChart";
import { StatusLine } from "./StatusLine";
import { HeatLegend, PageLegend } from "./Legends";
import { CompareBar, CompareCanvases, compareBuyersOf, useMinWidth } from "./CompareView";
import { heatChrome } from "../heat";
import {
  compareParam, compareReaders, compareReducer, compareStart, defaultSectionView, drawMode, effectiveScope, expandCount, firstName, heatIntensity, heatMaxMs,
  pageHeatMaxMs, pageInView, pageOfText, pageRank, parseCompareParam, readersText, selectPageIndex, unreadBlocks, validCompare,
  type HeatScope, type PageOrder, type SectionView,
} from "./viewer-model";

export interface DocumentViewProps extends EngagementViewProps {
  /** The open page from the URL ("<pageId>#<part>"), or null for the default. */
  page: string | null;
  onPageChange(page: string | null): void;
  /** Buyers who have opened the CIM at all (the pulse), to explain an empty view honestly. */
  openedSoFar?: number;
}

export function DocumentView({ dealId, filters, onFiltersChange, page: pageParam, onPageChange, openedSoFar = 0 }: DocumentViewProps) {
  const { data: doc, isLoading, error, refetch, isFetching } = useEngagementDocument(dealId, filters);
  const renditionId = doc?.rendition?.id ?? null;
  const { data: rendition, isLoading: rLoading } = useEngagementRendition(dealId, renditionId);
  const isMobile = useIsMobile();

  const [layout, setLayout] = useState<"pages" | "table">("pages");
  const [order, setOrder] = useState<PageOrder>("document");
  const [showHeat, setShowHeat] = useState(true);
  const [showUnread, setShowUnread] = useState(false);
  // "Where they spent the most time on each page": the shades compare the parts of
  // the open page by default; "Across the CIM" compares with the busiest part anywhere.
  const [scope, setScope] = useState<HeatScope>("page");
  const [namedWanted, setNamedWanted] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(false);
  const [washSheet, setWashSheet] = useState(false);
  // A collapsible section's view (null = its default: see defaultSectionView).
  const [viewWanted, setViewWanted] = useState<SectionView | null>(null);
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const wide = useMinWidth(1280) && !isMobile;

  // Compare buyers (§3.7): held here, so a page turn, arrow key, swipe or
  // filter change never closes it; mirrored in ?compare=<A>~<B> for links.
  // The buyers come from the Buyers list without the segment or buyer filter
  // (an outer filter must never empty a side).
  const { data: buyerList } = useEngagementBuyers(dealId, { range: filters.range, device: filters.device, segment: "all", buyers: [] });
  const cbuyers = useMemo(() => compareBuyersOf(buyerList?.buyers ?? []), [buyerList]);
  const [compare, dispatchCompare] = useReducer(compareReducer, null);
  const search = useSearch();
  const [location, setLocation] = useLocation();
  const compareInit = useRef(false);
  useEffect(() => {
    if (compareInit.current || !buyerList) return;
    compareInit.current = true;
    const s = validCompare(cbuyers, parseCompareParam(new URLSearchParams(search).get("compare")));
    if (s) dispatchCompare({ type: "start", state: s });
  }, [buyerList, cbuyers, search]);
  useEffect(() => {
    if (!compareInit.current) return;
    const q = new URLSearchParams(search);
    const want = compare ? compareParam(compare) : null;
    if ((q.get("compare") ?? null) === want) return;
    if (want) q.set("compare", want); else q.delete("compare");
    const qs = q.toString();
    setLocation(`${location}${qs ? `?${qs}` : ""}`, { replace: true });
  }, [compare, search, location, setLocation]);

  const pages = doc?.pages ?? [];
  const index = selectPageIndex(pages, pageParam);
  const current: DocumentPage | null = index >= 0 ? pages[index] : null;

  // The named version, for "Show the named version" on a blind rendition.
  const namedId = useMemo(() => {
    if (!doc || rendition?.mode !== "blind") return null;
    return [...doc.renditions].filter((r) => r.mode !== "blind").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]?.id ?? null;
  }, [doc, rendition?.mode]);
  // Only on a blind version that has a named one beside it (switching version turns it off).
  const showNamed = namedWanted && !!namedId;
  const { data: named, error: namedError } = useEngagementRendition(dealId, showNamed ? namedId : null);

  const go = useCallback((i: number) => {
    const p = pages[i];
    if (!p) return;
    dispatchCompare({ type: "page" });
    setSelectedKey(null);
    setHoveredKey(null);
    setViewWanted(null);
    setWashSheet(false);
    onPageChange(viewerPageKey(p.pageId, p.part));
  }, [pages, onPageChange]);

  // ←/→ change page anywhere in the view (not while typing or in a dialog).
  useEffect(() => {
    if (layout !== "pages") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.metaKey || e.ctrlKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [contenteditable=true], [role=dialog], [role=menu]"))) return;
      if (e.key === "ArrowRight") go(Math.min(pages.length - 1, index + 1));
      else if (e.key === "ArrowLeft") go(Math.max(0, index - 1));
      else if (e.key === "Escape") setSelectedKey(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, index, pages.length, layout]);

  if (isLoading) return <DocumentSkeleton />;
  if (error || !doc) return <DocumentError onRetry={() => refetch()} retrying={isFetching} />;
  const filtered = filters.buyers.length > 0 || filters.segment !== "all" || filters.range !== "all" || filters.device !== "all";
  // Buyers read it, but the version they read can't be drawn right now (e.g. a blind version still being prepared).
  if (pages.length === 0 && (doc.totals?.visits ?? 0) > 0) return <DocumentCantDraw visits={doc.totals.visits} buyers={doc.openedTotal ?? doc.openedBy} onRetry={() => refetch()} retrying={isFetching} />;
  if (pages.length === 0 || (doc.openedBy === 0 && doc.totals.attentionMs === 0)) return <DocumentEmpty dealId={dealId} openedSoFar={openedSoFar} filtered={filtered} />;

  const shown: EngagementRenditionResponse | undefined = showNamed && named ? named : rendition;
  const servedPage = rendition?.pages.find((p) => p.pageId === current?.pageId);
  const shownPage = shown?.pages.find((p) => p.pageId === current?.pageId);
  const sameLayout = !showNamed || !servedPage || !shownPage || servedPage.blockFingerprint === shownPage.blockFingerprint;
  // Each part painted, the whole page washed (only its total is known), or nothing.
  const mode = drawMode(current, sameLayout);
  const paint = mode === "parts";
  const maxPageMs = pageHeatMaxMs(pages);
  const washT = current ? heatIntensity(current.attentionMs, maxPageMs) : 0;
  const rank = current ? pageRank(pages, current) : null;
  const washCard: WashCard | null = current && mode === "wash"
    ? { time: formatReadingTime(current.attentionMs), buyers: current.buyers.length, rankText: rank?.text ?? null }
    : null;
  const statusCtx = { blind: rendition?.mode === "blind", showNamed, sameLayout };
  const sectionDefault = current ? defaultSectionView(current, servedPage) : null;
  const sectionView: SectionView | null = sectionDefault ? viewWanted ?? sectionDefault : null;
  const currentInView = current ? pageInView(current, sectionView) : null;
  const maxMs = heatMaxMs(pages, scope, currentInView);
  const unreadCount = current && paint ? unreadBlocks(current, servedPage?.blocks, sectionView).length : 0;
  const filteredToOne = filters.buyers.length === 1;
  const comparing = !!compare && !!current && !!rendition && layout === "pages";
  const compareFrom = compareStart(cbuyers, filteredToOne ? filters.buyers[0] : null);
  const canCompare = !!compareFrom && compareReaders(cbuyers).length >= 2 && (doc.openedBy >= 2 || filteredToOne);
  const compareName = filteredToOne ? cbuyers.find((b) => b.accessId === filters.buyers[0])?.name ?? null : null;
  const onOnlyBuyer = (accessId: string) => onFiltersChange({ ...filters, buyers: [accessId], segment: "all" });

  const panel = current ? (
    <PagePanel
      page={current}
      doc={doc}
      dealId={dealId}
      renditionPage={servedPage}
      selectedKey={selectedKey}
      onHoverKey={setHoveredKey}
      onSelectKey={(k) => { setSelectedKey(k); if (k) scrollToBlock(k); }}
      onOnlyBuyer={onOnlyBuyer}
      filteredToOne={filteredToOne}
      paint={paint}
      sectionView={paint ? sectionView : null}
      headline={isMobile ? current.headline : null}
    />
  ) : null;

  return (
    <div className={cn(isMobile ? "space-y-2.5 pb-20" : "space-y-4")} data-testid="engagement-document">
      <ReachChart
        reach={doc.reach}
        pages={pages}
        headline={doc.reachHeadline}
        openedBy={doc.openedBy}
        openedTotal={doc.openedTotal ?? doc.openedBy}
        oldTracking={doc.reachBasis === "old_tracking"}
        maxPageMs={maxPageMs}
        selectedIndex={index}
        onOpen={(i) => { setLayout("pages"); go(i); }}
        compact={isMobile}
      />

      {!isMobile && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Segmented<"pages" | "table">
            label="Layout"
            value={layout}
            onChange={setLayout}
            options={[
              { value: "pages", label: "Page by page", icon: <Rows3 className="h-3 w-3" /> },
              { value: "table", label: "All pages in a table", icon: <LayoutList className="h-3 w-3" /> },
            ]}
          />
          <Segmented<PageOrder>
            label="Order of pages"
            size="xs"
            value={order}
            onChange={setOrder}
            options={[{ value: "document", label: "Pages in order" }, { value: "time", label: "Most time first" }]}
          />
        </div>
      )}

      {layout === "table" ? (
        <div className="space-y-2">
          {isMobile && (
            <button type="button" onClick={() => setLayout("pages")} className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-foreground/85" data-testid="layout-pages">
              <Rows3 className="h-3.5 w-3.5" /> Page by page
            </button>
          )}
          <PageTable pages={pages} order={order} openedBy={doc.openedBy} onOpen={(i) => { setLayout("pages"); go(i); }} />
        </div>
      ) : (
        <div className={cn("grid", isMobile ? "gap-2.5" : "gap-5", "md:grid-cols-[210px_minmax(0,1fr)]", comparing ? "xl:grid-cols-[220px_minmax(0,1fr)]" : "xl:grid-cols-[220px_minmax(0,1fr)_300px]")}>
          {isMobile ? (
            <PageChips pages={pages} selectedIndex={index} onSelect={go} />
          ) : (
            <aside className="md:sticky md:top-3 md:self-start md:max-h-[calc(100vh-7rem)] md:flex md:flex-col">
              <PageRail
                pages={pages}
                selectedIndex={index}
                onSelect={go}
                order={order}
                openedBy={doc.openedBy}
                totalMs={doc.totals.attentionMs}
              />
            </aside>
          )}

          <div className={cn("min-w-0", isMobile ? "space-y-2" : "space-y-3")}>
            {current && (
              <PageHeader
                page={current}
                pageOf={pageOfText(current.label, pages)}
                onPrev={index > 0 ? () => go(index - 1) : null}
                onNext={index < pages.length - 1 ? () => go(index + 1) : null}
                showHeadline={!isMobile}
              />
            )}

            {current && <StatusLine page={current} doc={doc} ctx={statusCtx} />}

            {comparing && compare && (
              <CompareBar buyers={cbuyers} state={compare} dispatch={dispatchCompare} filters={filters} compact={isMobile} />
            )}

            {current && !comparing && (
              <div className={cn("flex flex-wrap items-center text-xs text-muted-foreground", isMobile ? "gap-x-2 gap-y-1.5" : "gap-x-4 gap-y-2")} data-testid="heat-toggles">
                <label className="inline-flex items-center gap-2">
                  <Switch checked={showHeat} onCheckedChange={setShowHeat} aria-label="Show reading time colours" />
                  Reading-time colours
                </label>
                {isMobile && (
                  <button
                    type="button"
                    onClick={() => setLayout("table")}
                    aria-label="All pages in a table"
                    title="All pages in a table"
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground/80"
                    data-testid="layout-table"
                  >
                    <LayoutList className="h-4 w-4" />
                  </button>
                )}
                {paint && showHeat && (
                  <Segmented<HeatScope>
                    label="Compare parts with"
                    size="xs"
                    value={scope}
                    onChange={setScope}
                    options={[{ value: "page", label: "Within this page" }, { value: "document", label: "Across the whole CIM" }]}
                  />
                )}
                {paint && showHeat && scope === "page" && effectiveScope(scope, current) === "document" && (
                  <span className="text-[11px]">This page has only one or two parts, so its colours compare with the whole CIM.</span>
                )}
                {sectionView && paint && (
                  <Segmented<SectionView>
                    label="How this section is shown"
                    size="xs"
                    value={sectionView}
                    onChange={(v) => { setViewWanted(v); setSelectedKey(null); setShowUnread(false); }}
                    options={[{ value: "collapsed", label: "Collapsed" }, { value: "opened", label: "Opened" }]}
                  />
                )}
                {paint && unreadCount > 0 && (
                  <label className="inline-flex items-center gap-2">
                    <Switch checked={showUnread} onCheckedChange={setShowUnread} aria-label="Outline parts nobody read" />
                    Parts nobody read ({unreadCount})
                  </label>
                )}
                {rendition?.mode === "blind" && namedId && (
                  <button
                    type="button"
                    onClick={() => setNamedWanted(!showNamed)}
                    aria-label={showNamed ? "Show what the buyer saw" : "Show the named version"}
                    title={showNamed ? "Show what the buyer saw" : "Show the named version"}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border border-border text-xs text-foreground/85 hover:text-foreground",
                      isMobile ? "h-8 w-8 justify-center" : "px-2 py-1",
                    )}
                    data-testid="toggle-named-version"
                  >
                    {showNamed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {!isMobile && (showNamed ? "Show what the buyer saw" : "Show the named version")}
                  </button>
                )}
                {canCompare && compareFrom && (
                  <button
                    type="button"
                    onClick={() => { setNamedWanted(false); setShowUnread(false); dispatchCompare({ type: "start", state: compareFrom }); }}
                    aria-label={compareName ? `Compare ${firstName(compareName)} with others` : "Compare buyers"}
                    title={compareName ? `Compare ${firstName(compareName)} with others` : "Compare one buyer's reading with others"}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border border-border text-xs text-foreground/85 hover:text-foreground",
                      isMobile ? "h-8 w-8 justify-center" : "px-2 py-1",
                    )}
                    data-testid="compare-start"
                  >
                    <Users className="h-3.5 w-3.5" />
                    {!isMobile && (compareName ? `Compare ${firstName(compareName)} with others` : "Compare")}
                  </button>
                )}
              </div>
            )}

            {sectionView && paint && current && !comparing && (
              <p className="text-xs text-muted-foreground" data-testid="section-view-note">
                {sectionView === "collapsed"
                  ? `Buyers first see this section collapsed, as shown. ${expandCount(current) === 0 ? "Nobody has opened it yet." : `Opened ${expandCount(current)} time${expandCount(current) === 1 ? "" : "s"} — switch to Opened to see what they read.`}${current.part > 0 ? " Collapsed, the whole section sits on its first page." : ""}`
                  : expandCount(current) === 0
                    ? "Nobody has opened this section yet, so its full view has no reading time."
                    : `The full section, as the buyers who opened it saw it (opened ${expandCount(current)} time${expandCount(current) === 1 ? "" : "s"}).`}
              </p>
            )}


            <div
              className="relative"
              onClick={() => setSelectedKey(null)}
              onTouchStart={(e) => { touchStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }}
              onTouchEnd={(e) => {
                const s = touchStart.current;
                touchStart.current = null;
                if (!s) return;
                const dx = e.changedTouches[0].clientX - s.x;
                const dy = e.changedTouches[0].clientY - s.y;
                if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) go(dx < 0 ? Math.min(pages.length - 1, index + 1) : Math.max(0, index - 1));
              }}
            >
              {comparing && compare && current && rendition ? (
                <CompareCanvases
                  dealId={dealId}
                  filters={filters}
                  doc={doc}
                  buyers={cbuyers}
                  state={compare}
                  current={current}
                  rendition={rendition}
                  renditionPage={servedPage}
                  showHeat={showHeat}
                  scope={scope}
                  sectionView={sectionView}
                  onViewChange={(v) => { setViewWanted(v); setSelectedKey(null); }}
                  selectedKey={selectedKey}
                  hoveredKey={hoveredKey}
                  onSelectKey={setSelectedKey}
                  onHoverKey={setHoveredKey}
                  touch={isMobile}
                  wide={wide}
                />
              ) : showNamed && namedError ? (
                <p className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">Couldn&apos;t load the named version. Use “Show what the buyer saw” above to go back.</p>
              ) : rLoading || (showNamed && !named) ? (
                <Skeleton className="h-[70vh] w-full rounded-[3px]" />
              ) : !shown || !current ? (
                <p className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">This version of the CIM is no longer available to show.</p>
              ) : (
                <PageCanvas
                  rendition={shown}
                  pageId={current.pageId}
                  part={current.part}
                  renditionPage={shownPage}
                  page={current}
                  paint={paint}
                  showHeat={showHeat}
                  showUnread={showUnread}
                  maxMs={maxMs}
                  selectedKey={selectedKey}
                  hoveredKey={hoveredKey}
                  onSelectKey={setSelectedKey}
                  onHoverKey={setHoveredKey}
                  touch={isMobile}
                  view={sectionView}
                  onViewChange={(v) => { setViewWanted(v); setSelectedKey(null); }}
                  mode={mode}
                  washT={washT}
                  washCard={washCard}
                  onWashTap={() => setWashSheet(true)}
                />
              )}
            </div>

            {current && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                {comparing
                  ? <span />
                  : paint && showHeat
                  ? <HeatLegend maxMs={maxMs} scope={effectiveScope(scope, current)} />
                  : mode === "wash" && showHeat ? <PageLegend maxPageMs={maxPageMs} /> : <span />}
                <PagerButtons pageOf={pageOfText(current.label, pages)} onPrev={index > 0 ? () => go(index - 1) : null} onNext={index < pages.length - 1 ? () => go(index + 1) : null} />
              </div>
            )}
          </div>

          {!isMobile && !comparing && (
            <aside className="md:col-span-2 xl:col-span-1 xl:sticky xl:top-3 xl:self-start xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto rounded-lg border border-border bg-card p-4">
              {panel}
            </aside>
          )}
        </div>
      )}

      {isMobile && current && layout === "pages" && !comparing && (
        <>
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            className="fixed inset-x-3 bottom-3 z-30 flex items-center gap-2 rounded-xl border border-border bg-card/95 px-4 py-3 text-left text-xs shadow-2xl backdrop-blur"
            data-testid="engagement-peek"
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: heatChrome(washT) }} aria-hidden data-heat-swatch />
            <span className="font-semibold tabular-nums">{formatReadingTime(current.attentionMs)}</span>
            <span className="text-muted-foreground">·</span>
            <span className="tabular-nums">{readersText(current.readers, doc.openedBy)} read</span>
            <ReadLabelChip label={current.readLabel} />
            <span className="ml-auto inline-flex items-center gap-1 text-teal">This page <ChevronUp className="h-3.5 w-3.5" /></span>
          </button>
          <Sheet open={panelOpen} onOpenChange={setPanelOpen}>
            <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-2xl">
              <SheetHeader className="mb-3 text-left">
                <SheetTitle className="text-base">Page {current.label} · {current.title}</SheetTitle>
              </SheetHeader>
              {panel}
            </SheetContent>
          </Sheet>
          <Sheet open={washSheet && !!washCard} onOpenChange={setWashSheet}>
            <SheetContent side="bottom" className="rounded-t-2xl" data-testid="engagement-wash-sheet">
              <SheetHeader className="mb-2 text-left">
                <SheetTitle className="text-sm">Page {current.label} · {current.title}</SheetTitle>
              </SheetHeader>
              {washCard && <WashDetails card={washCard} />}
            </SheetContent>
          </Sheet>
          <Sheet open={!!selectedKey} onOpenChange={(o) => { if (!o) setSelectedKey(null); }}>
            <SheetContent side="bottom" className="rounded-t-2xl">
              <SheetHeader className="mb-2 text-left">
                <SheetTitle className="text-sm">Page {current.label} · {current.title}</SheetTitle>
              </SheetHeader>
              {(() => {
                const b = pageInView(current, sectionView).blocks.find((x) => x.key === selectedKey);
                return b ? <BlockDetails block={b} page={current} expectedMs={servedPage?.blocks.find((x) => x.key === b.key)?.expectedMs ?? null} /> : null;
              })()}
            </SheetContent>
          </Sheet>
        </>
      )}
    </div>
  );
}

/** Bring a part into view (clicked in the panel's "Parts of this page"). */
function scrollToBlock(key: string) {
  const el = document.querySelector<HTMLElement>(`[data-heat-block="${CSS.escape(key)}"]`);
  el?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function PageHeader({ page, pageOf, onPrev, onNext, showHeadline = true }: { page: DocumentPage; pageOf: string; onPrev: (() => void) | null; onNext: (() => void) | null; showHeadline?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{pageOf}</p>
          <h3 className="text-lg font-semibold leading-tight">{page.title}</h3>
          {page.servedTitle && <p className="mt-0.5 text-xs italic text-muted-foreground">Buyer saw: “{page.servedTitle}”</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          <PagerButton dir="prev" onClick={onPrev} />
          <PagerButton dir="next" onClick={onNext} />
        </div>
      </div>
      {showHeadline && page.headline && (
        <p className="border-l-2 border-teal/70 bg-teal/5 py-1.5 pl-3 pr-2 text-sm text-foreground/90" data-testid="engagement-page-headline">
          {page.headline}
        </p>
      )}
    </div>
  );
}

function PagerButton({ dir, onClick }: { dir: "prev" | "next"; onClick: (() => void) | null }) {
  const Icon = dir === "prev" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      onClick={onClick ?? undefined}
      disabled={!onClick}
      aria-label={dir === "prev" ? "Previous page" : "Next page"}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border text-foreground/80 hover:bg-muted/60 disabled:opacity-30"
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function PagerButtons({ pageOf, onPrev, onNext }: { pageOf: string; onPrev: (() => void) | null; onNext: (() => void) | null }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <PagerButton dir="prev" onClick={onPrev} />
      <span className="tabular-nums">{pageOf}</span>
      <PagerButton dir="next" onClick={onNext} />
    </div>
  );
}

function DocumentError({ onRetry, retrying }: { onRetry(): void; retrying: boolean }) {
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-border bg-card px-4 py-5 sm:flex-row sm:items-center" data-testid="engagement-document-error">
      <AlertCircle className="h-4 w-4 shrink-0 text-amber-500" aria-hidden />
      <p className="flex-1 text-sm text-muted-foreground">Couldn't load reading by page. Try again in a moment.</p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-60"
        data-testid="engagement-document-retry"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} aria-hidden /> Retry
      </button>
    </div>
  );
}

/** Buyers read the CIM, but the version they read can't be drawn right now (never "no reading recorded"). */
function DocumentCantDraw({ visits, buyers, onRetry, retrying }: { visits: number; buyers: number; onRetry(): void; retrying: boolean }) {
  const n = Math.max(1, buyers);
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center" data-testid="engagement-document-cant-draw">
      <p className="flex items-center justify-center gap-2 text-sm font-medium">
        <FileSearch className="h-4 w-4 text-teal" aria-hidden /> We can't show the pages right now
      </p>
      <p className="max-w-md text-sm text-muted-foreground">
        {n} buyer{n === 1 ? "" : "s"} read this CIM ({visits} visit{visits === 1 ? "" : "s"}), but the version they read can't be drawn at the moment
        (the blind version may still be being prepared). Try again in a few minutes.
      </p>
      <button
        type="button"
        onClick={onRetry}
        disabled={retrying}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted/60 disabled:opacity-60"
      >
        <RefreshCw className={cn("h-3.5 w-3.5", retrying && "animate-spin")} aria-hidden /> Try again
      </button>
    </div>
  );
}

function DocumentSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-28 w-full" />
      <div className="grid gap-5 md:grid-cols-[210px_minmax(0,1fr)] xl:grid-cols-[220px_minmax(0,1fr)_300px]">
        <Skeleton className="hidden h-[60vh] md:block" />
        <Skeleton className="h-[70vh]" />
        <Skeleton className="hidden h-[50vh] xl:block" />
      </div>
    </div>
  );
}

/** Nobody has read yet (or nobody in this filter): what the view will show, drawn as a small paper page. */
function DocumentEmpty({ dealId, filtered, openedSoFar }: { dealId: string; filtered: boolean; openedSoFar: number }) {
  const earlier = !filtered && openedSoFar > 0;
  return (
    <div className="flex flex-col items-center gap-5 rounded-lg border border-dashed border-border px-6 py-12 text-center" data-testid="engagement-document-empty">
      <svg width="132" height="160" viewBox="0 0 132 160" aria-hidden className="drop-shadow-lg">
        <rect x="0.5" y="0.5" width="131" height="159" rx="3" fill="#FBF9F4" stroke="#E4DDCF" />
        <rect x="14" y="16" width="70" height="8" rx="2" fill="#201D18" opacity="0.8" />
        <rect x="14" y="34" width="104" height="26" rx="3" fill="#D18E3A" opacity="0.55" />
        <rect x="14" y="68" width="104" height="5" rx="2" fill="#201D18" opacity="0.25" />
        <rect x="14" y="78" width="96" height="5" rx="2" fill="#201D18" opacity="0.25" />
        <rect x="12" y="92" width="108" height="22" rx="3" fill="#E7C27A" opacity="0.5" />
        <rect x="14" y="122" width="48" height="24" rx="3" fill="#F3E6C4" opacity="0.8" />
        <rect x="70" y="122" width="48" height="24" rx="3" fill="#B4582A" opacity="0.45" />
        <rect x="8" y="34" width="3" height="26" rx="1.5" fill="#B4582A" />
        <circle cx="118" cy="34" r="7" fill="#201D18" />
        <text x="118" y="37.5" textAnchor="middle" fontSize="9" fontWeight="600" fill="#FBF9F4">1</text>
      </svg>
      <div className="max-w-md space-y-1.5">
        <p className="flex items-center justify-center gap-2 text-sm font-medium">
          <FileSearch className="h-4 w-4 text-teal" />
          {filtered ? "No reading for these filters" : earlier ? "No reading recorded on the pages yet" : "No buyer has opened the CIM yet"}
        </p>
        <p className="text-sm text-muted-foreground">
          {filtered
            ? "Try a longer date range or all buyers."
            : earlier
              ? `${openedSoFar} buyer${openedSoFar === 1 ? " has" : "s have"} opened the CIM, but no time on its pages was recorded yet. Their next visits will show here: which pages and numbers they study, drawn on the CIM itself.`
              : "When buyers open the CIM, you'll see which pages and numbers they study, drawn on the CIM itself, page by page."}
        </p>
        {!filtered && !earlier && (
          <p className="text-xs text-muted-foreground">
            Share the CIM from the <Link href={`/deal/${dealId}/buyers`} className="text-teal hover:underline">Buyers tab</Link>.
          </p>
        )}
      </div>
    </div>
  );
}
