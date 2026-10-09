/**
 * TeaserPages — a teaser drawn on real pages (Letter 816 × 1056 or A4
 * 794 × 1123 CSS px, 48 px margins), with the CIM's own renderers on the
 * deal's theme-locked paper (.cim-doc).
 *
 * How: every item (the header, then each block) is rendered once in a hidden
 * layer at the page's text width and measured (ResizeObserver, after the
 * fonts load); paginateTeaser() then places them greedily — a block never
 * splits across pages unless it is taller than a page. The visible pages are
 * drawn at real size and scaled to fit the column.
 *
 * Modes:
 *   editor  — click a block to select it; held / placeholder decorations
 *   buyer   — the view room (reading analytics inside CimBlocksProvider)
 *   seller  — the seller's review page (no analytics)
 *   print   — true size, one page per printed page, a footer on each
 *   thumb   — a small live thumbnail (the template picker)
 * Narrow screens (and buyer columns too narrow for a readable page) draw one
 * continuous sheet; the editor marks where page 2 starts.
 *
 * The measuring layer sits OUTSIDE CimBlocksProvider, so the reading
 * tracker never sees the hidden copies.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { CimSection } from "@shared/schema";
import type { TeaserPageSize } from "@shared/teaser";
import type { BuyerSection } from "@shared/cim-buyer-view";
import { CimDesignProvider, type CimDesign } from "@/components/cim/CimDesignContext";
import { CimSheet } from "@/components/cim/CimSheet";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { CimBlockScope, CimBlocksProvider, type CimBlockHost } from "@/components/cim/blocks";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { READING_SHEET_ATTR } from "@/lib/cim-reading";
import { cn } from "@/lib/utils";
import { TeaserHeader, type TeaserHeaderView } from "./TeaserHeader";
import { TeaserModeProvider } from "./teaser-mode";
import { pageBox, paginateTeaser, printedPageCount, type TeaserPagination } from "./paginate";

export type TeaserPagesMode = "editor" | "buyer" | "seller" | "print" | "thumb";

/** Space between blocks on a teaser page (tighter than the CIM's 40 px). */
export const TEASER_BLOCK_GAP = 11;
/** Editor: how far a block's selection / warning outline reaches above and below it (Tailwind `before:-inset-y-1`). */
export const EDITOR_RING_INSET_Y = 4;
/**
 * Editor: where a block's warning chip sits — inside its own outline at the
 * top-right (never above it: with an 11 px gap the outline of the block
 * above is only 3 px away, so a chip lifted any higher sat on it).
 */
export const EDITOR_CHIP_POSITION = { top: -EDITOR_RING_INSET_Y + 2, right: 4 } as const;

export interface TeaserLayoutInfo {
  /** Printed pages (an oversized block spills onto more). */
  pages: number;
  /** Height used on the last page (CSS px). */
  lastPageUsed: number;
  contentHeight: number;
  /** The id of the first item on each page (index 0 = page 1). */
  pageStarts: string[];
}

export interface TeaserPagesProps {
  header: TeaserHeaderView | null;
  sections: BuyerSection[];
  pageSize: TeaserPageSize;
  design: CimDesign;
  mode: TeaserPagesMode;
  /** Thumbnail scale (thumb mode). */
  thumbScale?: number;
  /** Editor: the selected item ("header" or a block id). */
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Editor: a block drawn as held back / a stand-in / hidden (decorations only — never changes its height). */
  decorate?: (id: string) => { tone: "held" | "placeholder" | "pinpoint" | null; label?: string | null } | null;
  /** Editor: the header names the business. */
  headerWarning?: string | null;
  /** Buyer: the reading tracker. */
  readingHost?: CimBlockHost | null;
  /** Called whenever the pagination changes. */
  onLayout?: (info: TeaserLayoutInfo) => void;
  /** Print: the footer line on every page ("Brassline · Confidential · Oct 9, 2026"). */
  printFooter?: string | null;
  /** Force one continuous sheet (true) or pages (false); default: by width. */
  continuous?: boolean;
  /** Thumbnails: draw the first page only. */
  firstPageOnly?: boolean;
  className?: string;
}

const HEADER_ID = "header";

/** Heights of the measured children (re-read on any resize and once the fonts are in). */
function useMeasured(count: number, key: string) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [heights, setHeights] = useState<number[] | null>(null);
  const read = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const kids = Array.from(el.children) as HTMLElement[];
    const next = kids.map((k) => Math.ceil(k.getBoundingClientRect().height));
    setHeights((prev) => (prev && prev.length === next.length && prev.every((v, i) => Math.abs(v - next[i]) < 2) ? prev : next));
  }, []);
  useLayoutEffect(() => {
    read();
  }, [read, count, key]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => read());
    Array.from(el.children).forEach((c) => ro.observe(c));
    ro.observe(el);
    let alive = true;
    (document as Document & { fonts?: { ready: Promise<unknown> } }).fonts?.ready.then(() => alive && read()).catch(() => undefined);
    // Charts settle after their first frame.
    const t = window.setTimeout(read, 400);
    return () => {
      alive = false;
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [read, count, key]);
  return { ref, heights };
}

/** The container's width (to scale the pages to fit). */
function useWidth() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => setWidth(entries[0]?.contentRect.width ?? el.getBoundingClientRect().width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

/** A teaser block (BuyerSection) as the renderers take it: never collapsed, no repeated "expandable". */
function forRenderer(s: BuyerSection): CimSection {
  const data = s.layoutData && typeof s.layoutData === "object" ? { ...(s.layoutData as Record<string, unknown>) } : {};
  delete data.expandable;
  return { ...(s as unknown as CimSection), layoutData: data, isVisible: true };
}

export function TeaserPages(props: TeaserPagesProps) {
  const {
    header, sections, pageSize, design, mode, thumbScale = 0.22, selectedId, onSelect, decorate, headerWarning,
    readingHost, onLayout, printFooter, continuous, firstPageOnly, className,
  } = props;
  const box = pageBox(pageSize);
  const branding = useMemo(() => buildBranding(null, { businessName: header?.codename ?? "" }), [header?.codename]);

  // Items: the header first (when there is one), then the blocks.
  const items = useMemo(() => [
    ...(header ? [{ id: HEADER_ID, section: null as BuyerSection | null }] : []),
    ...sections.map((s) => ({ id: s.id, section: s as BuyerSection | null })),
  ], [header, sections]);
  const contentKey = useMemo(() => JSON.stringify([header, sections.map((s) => [s.id, s.sectionTitle, s.layoutType, s.layoutData]), design.templateId, pageSize]), [header, sections, design.templateId, pageSize]);

  const measured = useMeasured(items.length, contentKey);
  const pagination: TeaserPagination | null = useMemo(() => {
    if (!measured.heights || measured.heights.length !== items.length) return null;
    return paginateTeaser(measured.heights, box.contentHeight, TEASER_BLOCK_GAP);
  }, [measured.heights, items.length, box.contentHeight]);

  // Report the pagination (the editor's fit indicator).
  const lastInfo = useRef<string>("");
  useEffect(() => {
    if (!pagination || !onLayout) return;
    const info: TeaserLayoutInfo = {
      pages: printedPageCount(pagination, box.contentHeight),
      lastPageUsed: (() => {
        const u = pagination.used[pagination.used.length - 1] ?? 0;
        return u > box.contentHeight ? u % box.contentHeight : u;
      })(),
      contentHeight: box.contentHeight,
      pageStarts: pagination.pages.map((p) => items[p[0]]?.id ?? ""),
    };
    const k = JSON.stringify(info);
    if (k !== lastInfo.current) {
      lastInfo.current = k;
      onLayout(info);
    }
  }, [pagination, onLayout, box.contentHeight, items]);

  const width = useWidth();
  const isNarrow = typeof window !== "undefined" && window.innerWidth < 768;
  const asSheet = mode === "thumb" || mode === "print"
    ? false
    : continuous ?? (isNarrow || (mode === "buyer" && width.width > 0 && width.width < box.width * 0.8));
  const scale = mode === "thumb" ? thumbScale : mode === "print" ? 1 : width.width > 0 ? Math.min(1, width.width / box.width) : 1;

  const renderItem = (id: string, section: BuyerSection | null, measuring: boolean) => {
    if (!section) {
      return header ? <TeaserHeader header={header} warning={!measuring && mode === "editor" ? headerWarning : null} /> : null;
    }
    const s = forRenderer(section);
    // "Interested?": the contact is a plain line under the numbered steps, never a step of its own.
    const note = section.layoutType === "numbered_list" && typeof (section.layoutData as { note?: unknown } | null)?.note === "string"
      ? ((section.layoutData as { note: string }).note).trim()
      : "";
    return (
      <CimBlockScope pageId={id}>
        <CimSectionRenderer section={s} branding={branding} hideTitle={!section.sectionTitle} />
        {note && <p className="mt-3 pl-12 text-xs leading-relaxed text-muted-foreground" data-testid="teaser-next-step-note">{note}</p>}
      </CimBlockScope>
    );
  };

  const editorWrap = (id: string, child: ReactNode) => {
    if (mode !== "editor") return child;
    const deco = decorate?.(id) ?? null;
    const selected = selectedId === id;
    return (
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onSelect?.(id)}
        onKeyDown={(e) => { if (e.key === "Enter") onSelect?.(id); }}
        data-teaser-block={id}
        className={cn(
          "relative cursor-pointer rounded-[6px] outline-none transition-shadow",
          "before:absolute before:-inset-x-2 before:-inset-y-1 before:rounded-[8px] before:pointer-events-none before:content-['']",
          selected ? "before:ring-2 before:ring-[#9E752E]" : "hover:before:ring-1 hover:before:ring-[#9E752E]/40 focus-visible:before:ring-2 focus-visible:before:ring-[#9E752E]/60",
          deco?.tone === "held" && "before:ring-2 before:ring-red-500/70 before:bg-red-500/[0.04]",
          deco?.tone === "placeholder" && "before:border before:border-dashed before:border-amber-600/70",
        )}
      >
        {deco?.label && (
          <span
            className={cn(
              "pointer-events-none absolute z-10 rounded-full px-2 py-0.5 text-[10px] font-semibold leading-[14px] shadow-sm",
              deco.tone === "held" ? "bg-red-600 text-white" : deco.tone === "placeholder" ? "bg-amber-500 text-black" : "bg-amber-100 text-amber-900",
            )}
            style={EDITOR_CHIP_POSITION}
            data-testid="teaser-block-chip"
          >
            {deco.label}
          </span>
        )}
        {child}
      </div>
    );
  };

  // ── The hidden measuring layer (page text width; no reading attributes) ──
  const measureLayer = (
    <div aria-hidden className="pointer-events-none absolute left-0 top-0 h-0 overflow-hidden" style={{ visibility: "hidden", width: box.contentWidth }}>
      <CimSheet flow={false} className="teaser-sheet teaser-paper" style={{ width: box.contentWidth, border: "none", boxShadow: "none", borderRadius: 0, padding: 0 }}>
        <div ref={measured.ref}>
          {items.map((it) => (
            <div key={it.id} className="flow-root">{renderItem(it.id, it.section, true)}</div>
          ))}
        </div>
      </CimSheet>
    </div>
  );

  const allGroups = pagination?.pages ?? [items.map((_, i) => i)];
  const pageGroups = firstPageOnly ? allGroups.slice(0, 1) : allGroups;
  const pageCount = allGroups.length;

  const pagesView = (
    <div className={cn("flex", mode === "thumb" ? "flex-row items-start gap-3" : mode === "print" ? "flex-col items-center gap-6 print:gap-0" : "flex-col items-center gap-6")}>
      {pageGroups.map((group, pi) => {
        const used = pagination?.used[pi] ?? 0;
        const pageH = Math.max(box.height, used + 2 * 48 + 4);
        return (
          <div
            key={pi}
            className={cn(mode === "print" && "teaser-print-page")}
            style={mode === "print" ? undefined : { width: box.width * scale, height: pageH * scale }}
            data-teaser-page={pi + 1}
          >
            <div style={mode === "print" ? undefined : { width: box.width, transform: `scale(${scale})`, transformOrigin: "top left" }}>
              <CimSheet
                flow={false}
                className={cn("teaser-sheet teaser-paper relative", mode === "print" ? "teaser-print-sheet" : "")}
                // Print: a page is at least one sheet tall; a block taller than a page flows onto the next sheet (never clipped).
                style={{ width: box.width, minHeight: box.height, height: mode === "print" ? undefined : pageH, padding: 48, borderRadius: mode === "thumb" ? 4 : 6 }}
              >
                {group.map((idx, j) => {
                  const it = items[idx];
                  if (!it) return null;
                  return (
                    <div key={it.id} className="flow-root" style={j === 0 ? undefined : { marginTop: TEASER_BLOCK_GAP }}>
                      {editorWrap(it.id, renderItem(it.id, it.section, false))}
                    </div>
                  );
                })}
                {mode === "print" && printFooter && (
                  <p className="absolute bottom-5 left-12 right-12 flex justify-between text-[9px] tracking-wide" style={{ color: "#8C8779" }}>
                    <span>{printFooter}</span>
                    <span>Page {pi + 1} of {pageCount}</span>
                  </p>
                )}
                {(mode === "editor" || mode === "seller") && pageCount > 1 && (
                  <p className="absolute bottom-4 right-6 text-[10px]" style={{ color: "#8C8779" }}>Page {pi + 1} of {pageCount}</p>
                )}
              </CimSheet>
            </div>
          </div>
        );
      })}
    </div>
  );

  // One continuous sheet (phones): page breaks shown as thin dividers in the editor.
  const pageStartIdx = new Set(allGroups.slice(1).map((g) => g[0]));
  const sheetView = (
    <CimSheet flow={false} className="teaser-sheet teaser-flow px-5 py-6 sm:px-8 sm:py-8" style={{ borderRadius: 8 }}>
      {items.map((it, i) => (
        <div key={it.id} className="flow-root" style={i === 0 ? undefined : { marginTop: TEASER_BLOCK_GAP }}>
          {mode === "editor" && pageStartIdx.has(i) && (
            <div className="-mx-5 sm:-mx-8 mb-5 flex items-center gap-2" aria-hidden>
              <span className="h-px flex-1 border-t border-dashed" style={{ borderColor: "#C9C2B0" }} />
              <span className="text-[10px] font-medium" style={{ color: "#8C8779" }}>Page {allGroups.findIndex((g) => g[0] === i) + 1}</span>
              <span className="h-px flex-1 border-t border-dashed" style={{ borderColor: "#C9C2B0" }} />
            </div>
          )}
          {editorWrap(it.id, renderItem(it.id, it.section, false))}
        </div>
      ))}
    </CimSheet>
  );

  const visible = asSheet ? sheetView : pagesView;
  return (
    <TeaserModeProvider>
      <CimDesignProvider design={design}>
        <div ref={width.ref} className={cn("relative w-full", className)}>
          {measureLayer}
          {mode === "buyer" && readingHost !== undefined ? (
            <CimBlocksProvider host={readingHost ?? undefined}>
              <div {...{ [READING_SHEET_ATTR]: "" }}>{visible}</div>
            </CimBlocksProvider>
          ) : (
            visible
          )}
        </div>
      </CimDesignProvider>
    </TeaserModeProvider>
  );
}
