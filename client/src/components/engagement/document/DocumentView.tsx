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
 * Blind versions render what the blind buyer saw (codename, redacted
 * titles); the rail adds "Buyer saw: …" under the real title, and a switch
 * shows the named version of the same page. Part-by-part heat is drawn on the
 * named version only when both versions have the same parts.
 *
 * Phones: chips instead of the rail, the page full width, a peek bar at the
 * bottom that opens "This page" as a sheet, and a tapped part opens its
 * details as a sheet. Swipe left/right changes page.
 *
 * Owned by the VIEWER stream.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "wouter";
import { ChevronLeft, ChevronRight, ChevronUp, Eye, EyeOff, FileSearch, LayoutList, Rows3 } from "lucide-react";
import {
  formatReadingTime,
  viewerPageKey,
  type DocumentPage,
  type EngagementDocumentResponse,
  type EngagementRenditionResponse,
} from "@shared/analytics-v2";
import { useEngagementDocument, useEngagementRendition } from "@/hooks/useEngagement";
import { useIsMobile } from "@/hooks/use-mobile";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import type { EngagementViewProps } from "../types";
import { Segmented } from "../FilterBar";
import { BlockDetails, PageCanvas } from "./PageCanvas";
import { PagePanel, ReadLabelChip } from "./PagePanel";
import { PageChips, PageRail } from "./PageRail";
import { PageTable } from "./PageTable";
import { ReachChart } from "./ReachChart";
import { effectiveScope, heatMaxMs, legendTicks, paperTint, readersText, selectPageIndex, unreadBlocks, type HeatScope, type PageOrder } from "./viewer-model";

export interface DocumentViewProps extends EngagementViewProps {
  /** The open page from the URL ("<pageId>#<part>"), or null for the default. */
  page: string | null;
  onPageChange(page: string | null): void;
  /** Buyers who have opened the CIM at all (the pulse), to explain an empty view honestly. */
  openedSoFar?: number;
}

export function DocumentView({ dealId, filters, onFiltersChange, page: pageParam, onPageChange, openedSoFar = 0 }: DocumentViewProps) {
  const { data: doc, isLoading, error } = useEngagementDocument(dealId, filters);
  const renditionId = doc?.rendition?.id ?? null;
  const { data: rendition, isLoading: rLoading } = useEngagementRendition(dealId, renditionId);
  const isMobile = useIsMobile();

  const [mode, setMode] = useState<"pages" | "table">("pages");
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
  const touchStart = useRef<{ x: number; y: number } | null>(null);

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
    setSelectedKey(null);
    setHoveredKey(null);
    onPageChange(viewerPageKey(p.pageId, p.part));
  }, [pages, onPageChange]);

  // ←/→ change page anywhere in the view (not while typing or in a dialog).
  useEffect(() => {
    if (mode !== "pages") return;
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
  }, [go, index, pages.length, mode]);

  if (isLoading) return <DocumentSkeleton />;
  if (error || !doc) return <p className="text-sm text-muted-foreground">Couldn't load reading by page. Try again in a moment.</p>;
  if (pages.length === 0 || doc.openedBy === 0) return <DocumentEmpty dealId={dealId} openedSoFar={openedSoFar} filtered={filters.buyers.length > 0 || filters.segment !== "all" || filters.range !== "all" || filters.device !== "all"} />;

  const shown: EngagementRenditionResponse | undefined = showNamed && named ? named : rendition;
  const servedPage = rendition?.pages.find((p) => p.pageId === current?.pageId);
  const shownPage = shown?.pages.find((p) => p.pageId === current?.pageId);
  const sameLayout = !showNamed || !servedPage || !shownPage || servedPage.blockFingerprint === shownPage.blockFingerprint;
  const paint = !!current && !current.pageLevelOnly && !doc.legacyOnly && sameLayout;
  const maxMs = heatMaxMs(pages, scope, current);
  const unreadCount = current && paint ? unreadBlocks(current, servedPage?.blocks).length : 0;
  const filteredToOne = filters.buyers.length === 1;
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
    />
  ) : null;

  return (
    <div className={cn("space-y-4", isMobile && "pb-20")} data-testid="engagement-document">
      <ReachChart
        reach={doc.reach}
        headline={doc.reachHeadline}
        openedBy={doc.openedBy}
        selectedIndex={index}
        onOpen={(i) => { setMode("pages"); go(i); }}
        compact={isMobile}
      />

      {doc.legacyOnly && (
        <p className="rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          Page-level only: this reading was recorded before part-by-part tracking.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmented<"pages" | "table">
          label="Layout"
          value={mode}
          onChange={setMode}
          options={[
            { value: "pages", label: "Page by page", icon: <Rows3 className="h-3 w-3" /> },
            { value: "table", label: "All pages in a table", icon: <LayoutList className="h-3 w-3" /> },
          ]}
        />
        {!isMobile && (
          <Segmented<PageOrder>
            label="Order of pages"
            size="xs"
            value={order}
            onChange={setOrder}
            options={[{ value: "document", label: "Pages in order" }, { value: "time", label: "Most time first" }]}
          />
        )}
      </div>

      {mode === "table" ? (
        <PageTable pages={pages} order={order} openedBy={doc.openedBy} onOpen={(i) => { setMode("pages"); go(i); }} />
      ) : (
        <div className={cn("grid gap-5", "md:grid-cols-[210px_minmax(0,1fr)]", "xl:grid-cols-[220px_minmax(0,1fr)_300px]")}>
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

          <div className="min-w-0 space-y-3">
            {current && (
              <PageHeader
                page={current}
                total={pages.length}
                onPrev={index > 0 ? () => go(index - 1) : null}
                onNext={index < pages.length - 1 ? () => go(index + 1) : null}
              />
            )}

            {current && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground">
                <label className="inline-flex items-center gap-2">
                  <Switch checked={showHeat} onCheckedChange={setShowHeat} aria-label="Show reading time colours" />
                  Reading-time colours
                </label>
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
                    className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-foreground/85 hover:text-foreground"
                    data-testid="toggle-named-version"
                  >
                    {showNamed ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    {showNamed ? "Show what the buyer saw" : "Show the named version"}
                  </button>
                )}
              </div>
            )}

            {rendition?.mode === "blind" && (
              <p className="text-xs text-muted-foreground" data-testid="blind-note">
                {showNamed
                  ? sameLayout
                    ? "Named version, for your reference. Blind buyers saw the codename version of this page; the colours are theirs."
                    : "Named version, for your reference. Its parts differ from what blind buyers saw, so only the page totals apply."
                  : "Blind version: exactly what blind buyers saw."}
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
              {showNamed && namedError ? (
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
                />
              )}
            </div>

            {current && (
              <div className="flex flex-wrap items-center justify-between gap-3">
                {paint && showHeat ? <HeatLegend maxMs={maxMs} scope={effectiveScope(scope, current)} /> : <span />}
                <PagerButtons index={index} total={pages.length} label={current.label} onPrev={index > 0 ? () => go(index - 1) : null} onNext={index < pages.length - 1 ? () => go(index + 1) : null} />
              </div>
            )}
          </div>

          {!isMobile && (
            <aside className="md:col-span-2 xl:col-span-1 xl:sticky xl:top-3 xl:self-start xl:max-h-[calc(100vh-7rem)] xl:overflow-y-auto rounded-lg border border-border bg-card p-4">
              {panel}
            </aside>
          )}
        </div>
      )}

      {isMobile && current && mode === "pages" && (
        <>
          <button
            type="button"
            onClick={() => setPanelOpen(true)}
            className="fixed inset-x-3 bottom-3 z-30 flex items-center gap-2 rounded-xl border border-border bg-card/95 px-4 py-3 text-left text-xs shadow-2xl backdrop-blur"
            data-testid="engagement-peek"
          >
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
          <Sheet open={!!selectedKey} onOpenChange={(o) => { if (!o) setSelectedKey(null); }}>
            <SheetContent side="bottom" className="rounded-t-2xl">
              <SheetHeader className="mb-2 text-left">
                <SheetTitle className="text-sm">Page {current.label} · {current.title}</SheetTitle>
              </SheetHeader>
              {(() => {
                const b = current.blocks.find((x) => x.key === selectedKey);
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

function PageHeader({ page, total, onPrev, onNext }: { page: DocumentPage; total: number; onPrev: (() => void) | null; onNext: (() => void) | null }) {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Page {page.label} of {total}</p>
          <h3 className="text-lg font-semibold leading-tight">{page.title}</h3>
          {page.servedTitle && <p className="mt-0.5 text-xs italic text-muted-foreground">Buyer saw: “{page.servedTitle}”</p>}
        </div>
        <div className="flex shrink-0 gap-1">
          <PagerButton dir="prev" onClick={onPrev} />
          <PagerButton dir="next" onClick={onNext} />
        </div>
      </div>
      {page.headline && (
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

function PagerButtons({ index, total, label, onPrev, onNext }: { index: number; total: number; label: string; onPrev: (() => void) | null; onNext: (() => void) | null }) {
  void index;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <PagerButton dir="prev" onClick={onPrev} />
      <span className="tabular-nums">Page {label} of {total}</span>
      <PagerButton dir="next" onClick={onNext} />
    </div>
  );
}

/** Seconds legend for the paper colours (drawn on a paper swatch so the shades match the page). */
function HeatLegend({ maxMs, scope }: { maxMs: number; scope: HeatScope }) {
  const ticks = legendTicks(maxMs);
  if (ticks.length === 0) return <span />;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground" data-testid="engagement-heat-legend">
      <span>Reading time on each part{scope === "page" ? " (this page)" : ""}:</span>
      <span className="inline-flex items-stretch overflow-hidden rounded-sm border border-border" style={{ background: "#FBF9F4" }}>
        {ticks.map((t) => (
          <span key={t.t} className="flex flex-col items-center px-1.5 pt-1 pb-0.5">
            <span className="h-2.5 w-8 rounded-[2px]" style={{ background: paperTint(t.t) ?? "transparent", mixBlendMode: "multiply" }} />
            <span className="mt-0.5 text-[10px] tabular-nums" style={{ color: "#201D18" }}>{t.label}</span>
          </span>
        ))}
      </span>
      <span className="inline-flex items-center gap-1">
        <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-semibold" style={{ background: "#201D18", color: "#FBF9F4" }}>1</span>
        most time on this page
      </span>
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
          {filtered ? "No reading for these filters" : earlier ? "No page-by-page reading recorded yet" : "No buyer has opened the CIM yet"}
        </p>
        <p className="text-sm text-muted-foreground">
          {filtered
            ? "Try a longer date range or all buyers."
            : earlier
              ? `${openedSoFar} buyer${openedSoFar === 1 ? " has" : "s have"} opened the CIM, but before reading was recorded part by part. Their next visits will show here: which pages and numbers they study, drawn on the CIM itself.`
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
