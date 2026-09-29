/**
 * PageCanvas — one page of the CIM exactly as the buyers were served it, with
 * the reading-time heat painted over its parts.
 *
 * The page is rendered from the stored rendition with the same components the
 * view room uses (CimMediaProvider → CimDesignProvider → CimSheet →
 * CimSectionRenderer — through FinancialToggle for a financial table, as in the
 * view room — or the disclaimer / contact page) inside a
 * <CimBlocksProvider> with no callbacks, so every measured part carries its
 * data-cim-block key. The overlay then measures those elements (after fonts
 * load, on resize, and whenever the page re-renders — charts animate in) and
 * draws one tint per part:
 *
 *   - colour = reading time on the brass→amber paper ramp (heatPaper, drawn
 *     with mix-blend-mode: multiply so the text stays readable);
 *   - a bar on the left edge whose thickness also grows with the time, so the
 *     view never relies on colour alone;
 *   - numbered pins 1–3 on the parts with the most time on this page;
 *   - optionally a dashed outline on the parts nobody read.
 *
 * A split section ("7b") renders whole and hides the other part's blocks
 * (viewer-model partVisibility). The CIM paper is theme-locked (.cim-doc):
 * every colour drawn on it is an explicit hex/rgba, never an app token.
 */
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  CONTACT_PAGE_ID as _CONTACT,
  DISCLAIMER_PAGE_ID as _DISCLAIMER,
} from "@shared/cim-blocks";
import {
  CIM_BLOCK_ATTR,
  formatReadingTime,
  type BlockAttention,
  type DocumentPage,
  type EngagementRenditionResponse,
  type RenditionPage,
} from "@shared/analytics-v2";
import type { CimSection } from "@shared/schema";
import { CimBlocksProvider } from "@/components/cim/blocks";
import { buildBranding } from "@/components/cim/CimBrandingContext";
import { CimDesignProvider, buildCimDesign, type CimDesignPayload } from "@/components/cim/CimDesignContext";
import { CimMediaProvider } from "@/components/cim/CimMediaContext";
import { CimSheet } from "@/components/cim/CimSheet";
import { CimSectionRenderer } from "@/components/cim/CimSectionRenderer";
import { CimContactPage, CimDisclaimerPage } from "@/components/cim/CimFrontBackPages";
import { FinancialToggle } from "@/components/cim/FinancialToggle";
import { HEAT_PAPER_STOPS } from "../heat";
import { heatIntensity, paperTint, partVisibility, partVisibilityCss, topBlocks, unreadBlocks } from "./viewer-model";

/** Paper-side colours (theme-locked, like the CIM itself). */
const INK = "#201D18";
const PAPER = "#FBF9F4";
const BRASS = "#9E752E";

interface Rect { top: number; left: number; width: number; height: number }

/** Layout effect in the browser, plain effect when rendered on the server (tests). */
const useIsoLayoutEffect = typeof document !== "undefined" ? useLayoutEffect : useEffect;

export interface PageCanvasProps {
  rendition: EngagementRenditionResponse;
  pageId: string;
  part: number;
  /** The page as stored in the rendition (parts, block keys, expected time). */
  renditionPage: RenditionPage | undefined;
  /** Reading on this page (null = nothing to paint, e.g. the page isn't in the numbers). */
  page: DocumentPage | null;
  /** Paint per-part heat (false when only page totals exist for this layout). */
  paint: boolean;
  showHeat: boolean;
  showUnread: boolean;
  /** The reading time the darkest shade stands for. */
  maxMs: number;
  selectedKey: string | null;
  hoveredKey: string | null;
  onSelectKey(key: string | null): void;
  onHoverKey(key: string | null): void;
  /** Phones: no hover card (a tap opens the bottom sheet instead). */
  touch: boolean;
}

export function PageCanvas(props: PageCanvasProps) {
  const { rendition, pageId, part, renditionPage } = props;
  const scope = `ev-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const sections = rendition.sections as unknown as CimSection[];
  const design = useMemo(
    () => buildCimDesign((rendition.design ?? null) as CimDesignPayload | null, rendition.mode === "dd" ? "dd" : rendition.mode),
    [rendition.design, rendition.mode],
  );
  const branding = useMemo(() => buildBranding(null, null), []);
  const section = sections.find((s) => s.id === pageId) ?? null;
  const css = renditionPage ? partVisibilityCss(`#${scope}`, partVisibility(renditionPage, part)) : "";

  const rects = useBlockRects(hostRef, wrapRef, `${rendition.id}|${pageId}|${part}`);

  let content: React.ReactNode;
  if (pageId === _DISCLAIMER) content = <CimDisclaimerPage />;
  else if (pageId === _CONTACT) content = <CimContactPage />;
  else if (section) {
    // As the view room shows it: a financial table with a Normalized view keeps
    // its "As reported | Normalized" switch (outside every measured part, so the
    // broker can flip it and see the Normalized rows' reading). A section the
    // buyer could collapse is shown open, with every part painted; its
    // collapsed summary's reading is listed under "Parts of this page".
    const shown = { ...section, isVisible: true };
    const expandable = !!(section.layoutData as { expandable?: unknown } | null)?.expandable;
    content = section.layoutType === "financial_table" && !expandable
      ? <FinancialToggle section={shown} branding={branding} />
      : <CimSectionRenderer section={shown} branding={branding} />;
  }
  else content = <p className="py-16 text-center text-sm" style={{ color: INK, opacity: 0.6 }}>This page isn't in this version of the CIM.</p>;

  return (
    <div ref={wrapRef} className="relative" data-testid="engagement-page-canvas">
      {css && <style>{css}</style>}
      <div id={scope} ref={hostRef}>
        <CimMediaProvider value={{}}>
          <CimDesignProvider design={design} sections={sections}>
            <CimBlocksProvider>
              <CimSheet className="px-6 py-7 sm:px-12 sm:py-12 shadow-[0_1px_0_rgba(0,0,0,0.04),0_12px_40px_-12px_rgba(0,0,0,0.45)] rounded-[3px]">
                {content}
              </CimSheet>
            </CimBlocksProvider>
          </CimDesignProvider>
        </CimMediaProvider>
      </div>
      <HeatOverlay {...props} rects={rects} wrapRef={wrapRef} />
    </div>
  );
}

/**
 * Where each measured part sits, relative to the wrapper. Innermost blocks
 * only (a two-column side's paragraphs, not the side itself); elements with
 * the same key (rare) are united. Re-measured on resize, after fonts load,
 * on any re-render of the page (charts, images) and a couple of times while
 * charts animate in. The overlay lives outside the observed element, so
 * painting never triggers another measurement.
 */
function useBlockRects(hostRef: RefObject<HTMLDivElement>, wrapRef: RefObject<HTMLDivElement>, key: string): Map<string, Rect> {
  const [rects, setRects] = useState<Map<string, Rect>>(() => new Map());
  useIsoLayoutEffect(() => {
    const host = hostRef.current;
    const wrap = wrapRef.current;
    if (!host || !wrap) return;
    let raf = 0;
    let alive = true;
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!alive) return;
        const c = wrap.getBoundingClientRect();
        const out = new Map<string, Rect>();
        host.querySelectorAll<HTMLElement>(`[${CIM_BLOCK_ATTR}]`).forEach((el) => {
          if (el.querySelector(`[${CIM_BLOCK_ATTR}]`)) return;
          const k = el.getAttribute(CIM_BLOCK_ATTR);
          if (k == null) return;
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return;
          const rect = { top: r.top - c.top, left: r.left - c.left, width: r.width, height: r.height };
          const prev = out.get(k);
          if (prev) {
            const top = Math.min(prev.top, rect.top);
            const left = Math.min(prev.left, rect.left);
            out.set(k, {
              top, left,
              width: Math.max(prev.left + prev.width, rect.left + rect.width) - left,
              height: Math.max(prev.top + prev.height, rect.top + rect.height) - top,
            });
          } else out.set(k, rect);
        });
        setRects((old) => (sameRects(old, out) ? old : out));
      });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    const mo = new MutationObserver(measure);
    mo.observe(host, { subtree: true, childList: true, characterData: true });
    const timers = [250, 700, 1500].map((ms) => window.setTimeout(measure, ms));
    document.fonts?.ready.then(measure).catch(() => {});
    window.addEventListener("resize", measure);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      mo.disconnect();
      timers.forEach(clearTimeout);
      window.removeEventListener("resize", measure);
    };
  }, [hostRef, wrapRef, key]);
  return rects;
}

function sameRects(a: Map<string, Rect>, b: Map<string, Rect>): boolean {
  if (a.size !== b.size) return false;
  for (const [k, r] of Array.from(b.entries())) {
    const o = a.get(k);
    if (!o || Math.abs(o.top - r.top) > 0.5 || Math.abs(o.left - r.left) > 0.5 || Math.abs(o.width - r.width) > 0.5 || Math.abs(o.height - r.height) > 0.5) return false;
  }
  return true;
}

/** A solid ramp colour for the edge bar (the darker half of the paper stops, so it reads on paper). */
function edgeColour(t: number): string {
  const stops = HEAT_PAPER_STOPS;
  return stops[Math.min(stops.length - 1, 1 + Math.round(t * (stops.length - 2)))];
}

const HeatOverlay = memo(function HeatOverlay({
  page, paint, showHeat, showUnread, maxMs, rects, selectedKey, hoveredKey, onSelectKey, onHoverKey, touch, renditionPage, wrapRef,
}: PageCanvasProps & { rects: Map<string, Rect>; wrapRef: RefObject<HTMLDivElement> }) {
  const blocks = useMemo(() => new Map((page?.blocks ?? []).map((b) => [b.key, b])), [page]);
  const pins = useMemo(() => (page && paint ? topBlocks(page) : []), [page, paint]);
  const unread = useMemo(() => new Set(page && paint && showUnread ? unreadBlocks(page, renditionPage?.blocks) : []), [page, paint, showUnread, renditionPage]);
  // The card follows the pointer (a tall paragraph would push a card anchored
  // to the part off screen); a clicked part keeps its card where it was clicked.
  const [pointer, setPointer] = useState<{ x: number; y: number } | null>(null);
  const [pinnedAt, setPinnedAt] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { if (!selectedKey) setPinnedAt(null); }, [selectedKey]);
  void wrapRef;

  if (!page || !paint) return null;
  const hoverCard = !touch && hoveredKey && pointer ? { key: hoveredKey, at: pointer } : null;
  const pinnedCard = !touch && selectedKey && pinnedAt ? { key: selectedKey, at: pinnedAt } : null;
  const card = hoverCard ?? pinnedCard;
  const cardBlock = card ? blocks.get(card.key) : undefined;

  return (
    <div className="pointer-events-none absolute inset-0" data-heat-overlay aria-hidden={false}>
      {Array.from(rects.entries()).map(([key, r]) => {
        const b = blocks.get(key);
        if (!b || b.kind === "column" || b.kind === "point") return null;
        const t = heatIntensity(b.attentionMs, maxMs);
        const fill = showHeat ? paperTint(t) : null;
        const pin = pins.indexOf(key);
        const isUnread = unread.has(key);
        const active = key === selectedKey || key === hoveredKey;
        return (
          <button
            key={key}
            type="button"
            data-heat-block={key}
            aria-label={`${b.label}: ${formatReadingTime(b.attentionMs)} of reading time`}
            className="pointer-events-auto absolute block cursor-pointer rounded-[3px] outline-none focus-visible:ring-2 focus-visible:ring-offset-0"
            style={{
              top: r.top - 2, left: r.left - 3, width: r.width + 6, height: r.height + 4,
              boxShadow: active ? `0 0 0 2px ${INK}` : isUnread ? `inset 0 0 0 1.5px ${BRASS}` : undefined,
              outline: isUnread && !active ? `1.5px dashed ${BRASS}` : undefined,
              outlineOffset: isUnread ? -1.5 : undefined,
              background: "transparent",
            }}
            onMouseEnter={(e) => { if (!touch) { onHoverKey(key); setPointer({ x: e.clientX, y: e.clientY }); } }}
            onMouseMove={(e) => { if (!touch) setPointer({ x: e.clientX, y: e.clientY }); }}
            onMouseLeave={() => { if (!touch) { onHoverKey(null); setPointer(null); } }}
            onClick={(e) => {
              e.stopPropagation();
              const off = key === selectedKey && !touch;
              setPinnedAt(off ? null : { x: e.clientX, y: e.clientY });
              onSelectKey(off ? null : key);
            }}
          >
            {fill && (
              <span className="absolute inset-0 rounded-[3px]" style={{ background: fill, mixBlendMode: "multiply" }} />
            )}
            {showHeat && t > 0 && (
              <span
                className="absolute rounded-full"
                style={{ left: -7, top: 2, bottom: 2, width: 2 + Math.round(t * 4), background: edgeColour(t) }}
              />
            )}
            {showHeat && pin !== -1 && (
              <span
                className="absolute flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold"
                style={{ top: -9, right: -9, background: INK, color: PAPER, boxShadow: `0 0 0 2px ${PAPER}` }}
              >
                {pin + 1}
              </span>
            )}
            {isUnread && (
              <span
                className="absolute rounded-sm px-1.5 py-[1px] text-[10px] font-medium"
                style={{ right: 4, bottom: 4, background: PAPER, color: BRASS, border: `1px solid ${BRASS}` }}
              >
                Nobody read this
              </span>
            )}
          </button>
        );
      })}
      {card && cardBlock && (
        <BlockHoverCard
          block={cardBlock}
          page={page}
          expectedMs={renditionPage?.blocks.find((x) => x.key === card.key)?.expectedMs ?? null}
          at={card.at}
        />
      )}
    </div>
  );
});

function BlockHoverCard({ block, page, expectedMs, at }: {
  block: BlockAttention; page: DocumentPage; expectedMs: number | null; at: { x: number; y: number };
}) {
  const W = 280;
  const H = 170;
  const vw = typeof window !== "undefined" ? window.innerWidth : 1280;
  const vh = typeof window !== "undefined" ? window.innerHeight : 800;
  const left = at.x + 16 + W > vw - 8 ? Math.max(8, at.x - 16 - W) : at.x + 16;
  const top = at.y + 16 + H > vh - 8 ? Math.max(8, at.y - 16 - H) : at.y + 16;
  return (
    <div
      className="pointer-events-none fixed z-50 rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
      style={{ top, left, width: W }}
      role="tooltip"
      data-testid="engagement-block-card"
    >
      <BlockDetails block={block} page={page} expectedMs={expectedMs} />
    </div>
  );
}

/** What the broker learns about one part: used by the hover card and the phone bottom sheet. */
export function BlockDetails({ block, page, expectedMs }: { block: BlockAttention; page: DocumentPage; expectedMs: number | null }) {
  const nobody = block.attentionMs < 1000;
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] leading-snug text-muted-foreground line-clamp-2">{block.label}</p>
      {nobody ? (
        <p className="text-sm font-medium">Nobody read this part</p>
      ) : (
        <p className="text-sm">
          <span className="text-lg font-semibold tabular-nums">{formatReadingTime(block.attentionMs)}</span>
          <span className="text-muted-foreground"> reading time in total</span>
        </p>
      )}
      <ul className="space-y-0.5 text-xs text-foreground/85">
        {block.readers > 0 && page.readers > 0 && (
          <li>{block.readers} of {Math.max(page.readers, block.readers)} buyer{page.readers === 1 ? "" : "s"} on this page read it</li>
        )}
        {block.topBuyer && !nobody && <li>Longest: {block.topBuyer.name} · {formatReadingTime(block.topBuyer.attentionMs)}</li>}
        {block.topPoint && <li>Most pointed at: {block.topPoint.label} ({formatReadingTime(block.topPoint.pointerMs)})</li>}
        {expectedMs != null && expectedMs > 0 && <li className="text-muted-foreground">One careful read takes about {formatReadingTime(expectedMs)}</li>}
        {block.skimShare >= 0.6 && !nobody && <li className="text-muted-foreground">Mostly scrolled past</li>}
      </ul>
    </div>
  );
}
