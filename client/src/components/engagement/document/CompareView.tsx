/**
 * Compare buyers (heat-map spec §3.7): one buyer's reading of a page beside
 * another buyer's, or beside a group's average — "Is Lillian reading like
 * the buyers who said yes?".
 *
 *   bar      Compare [A ▾] with [B ▾] · average per buyer · {filters} · Done
 *   ≥ 1280   the two pages side by side (the rail stays, the panel goes);
 *            hovering a part outlines the same part on the other side
 *   < 1280   an "A | B" switch above one page; the selected part stays
 *            selected when switching
 *
 * Data: two document loads of the same version (no server change) — side
 * A's buyer, and side B's buyers — both ignoring the outer segment filter
 * (it must never empty a side) but keeping the date range and device. Side
 * B is drawn as an average per reader of that page; one shared scale.
 * Compare state lives in DocumentView (a page turn or filter change never
 * closes it). Owned by the heatmap stream.
 */
import { useEffect, useMemo, useState } from "react";
import { Users, X } from "lucide-react";
import {
  formatReadingTime,
  type DocumentPage,
  type EngagementDocumentResponse,
  type EngagementFilters,
  type EngagementRenditionResponse,
  type RenditionPage,
} from "@shared/analytics-v2";
import { useEngagementDocument } from "@/hooks/useEngagement";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Segmented } from "../FilterBar";
import { PageCanvas, type WashCard } from "./PageCanvas";
import { HeatLegend, PageLegend } from "./Legends";
import {
  compareGroups, compareReaders, compareSideB, drawMode, effectiveScope, heatIntensity, pageHeatMaxMs, pageInView, pageRank, perBuyerPage, sharedMaxMs,
  type CompareAction, type CompareBuyer, type CompareState, type HeatScope, type SectionView,
} from "./viewer-model";

/** True at and above `px` wide (the side-by-side layout needs ≥ 1280). */
export function useMinWidth(px: number): boolean {
  const query = `(min-width: ${px}px)`;
  const [ok, setOk] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.(query).matches);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const m = window.matchMedia(query);
    const on = () => setOk(m.matches);
    on();
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, [query]);
  return ok;
}

const RANGE_WORDS: Record<string, string> = { "7d": "Last 7 days", "30d": "Last 30 days" };
const DEVICE_WORDS: Record<string, string> = { desktop: "Computer", phone: "Phone" };
/** The outer filters compare keeps ("Last 7 days · Computer"), or "" when none. */
export function compareFiltersText(f: Pick<EngagementFilters, "range" | "device">): string {
  return [RANGE_WORDS[f.range], DEVICE_WORDS[f.device]].filter(Boolean).join(" · ");
}

export interface CompareBarProps {
  buyers: CompareBuyer[];
  state: CompareState;
  dispatch(a: CompareAction): void;
  filters: EngagementFilters;
  compact: boolean;
}

/** "Compare [A ▾] with [B ▾] · average per buyer · Last 7 days · Done" (replaces the toggle row). */
export function CompareBar({ buyers, state, dispatch, filters, compact }: CompareBarProps) {
  const readers = compareReaders(buyers);
  const groups = compareGroups(buyers, state.a);
  const extra = compareFiltersText(filters);
  return (
    <div
      className={cn("flex flex-wrap items-center rounded-lg border border-teal/40 bg-teal/5 text-xs", compact ? "gap-x-1.5 gap-y-1.5 px-2 py-1.5" : "gap-x-2 gap-y-2 px-3 py-2")}
      data-testid="compare-bar"
    >
      <Users className="h-3.5 w-3.5 shrink-0 text-teal" aria-hidden />
      <span className="text-foreground/85">Compare</span>
      <Select value={state.a} onValueChange={(a) => dispatch({ type: "setA", a, buyers })}>
        <SelectTrigger className={cn("h-7 text-xs", compact ? "w-[8.5rem]" : "w-[11rem]")} aria-label="Buyer to compare" data-testid="compare-a">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {readers.map((b) => <SelectItem key={b.accessId} value={b.accessId} className="text-xs">{b.name}</SelectItem>)}
        </SelectContent>
      </Select>
      <span className="text-foreground/85">with</span>
      <Select value={state.b} onValueChange={(b) => dispatch({ type: "setB", b })}>
        <SelectTrigger className={cn("h-7 text-xs", compact ? "w-[11rem]" : "w-[12.5rem]")} aria-label="Who to compare with" data-testid="compare-b">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel className="text-[11px]">Groups (average per buyer)</SelectLabel>
            {groups.map((g) => (
              <SelectItem key={g.key} value={g.key} disabled={!!g.disabled} className="text-xs">
                {g.label}{g.disabled ? ` (${g.disabled})` : ` (${g.ids.length})`}
              </SelectItem>
            ))}
          </SelectGroup>
          <SelectSeparator />
          <SelectGroup>
            <SelectLabel className="text-[11px]">One buyer</SelectLabel>
            {readers.filter((b) => b.accessId !== state.a).map((b) => (
              <SelectItem key={b.accessId} value={b.accessId} className="text-xs">{b.name}</SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
      {!compact && <span className="text-muted-foreground">· average per buyer</span>}
      {extra && <span className="text-muted-foreground">· {extra}</span>}
      <button
        type="button"
        onClick={() => dispatch({ type: "done" })}
        className={cn("ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background/60 px-2 py-1 font-medium text-foreground hover:bg-muted/60")}
        data-testid="compare-done"
      >
        <X className="h-3.5 w-3.5" aria-hidden /> Done
      </button>
    </div>
  );
}

export interface CompareCanvasesProps {
  dealId: string;
  filters: EngagementFilters;
  doc: EngagementDocumentResponse;
  buyers: CompareBuyer[];
  state: CompareState;
  /** The page open in the main view. */
  current: DocumentPage;
  rendition: EngagementRenditionResponse;
  renditionPage: RenditionPage | undefined;
  showHeat: boolean;
  scope: HeatScope;
  sectionView: SectionView | null;
  onViewChange(v: SectionView): void;
  selectedKey: string | null;
  hoveredKey: string | null;
  onSelectKey(k: string | null): void;
  onHoverKey(k: string | null): void;
  touch: boolean;
  /** Two pages side by side (≥ 1280); else one page with an A | B switch. */
  wide: boolean;
}

interface Side {
  key: "a" | "b";
  heading: string;
  /** Short name for the A | B switch. */
  short: string;
  page: DocumentPage | null;
  pages: DocumentPage[];
  empty: string | null;
  loading: boolean;
  error: boolean;
}

/** The two sides of a comparison, drawn on the same page of the same version. */
export function CompareCanvases(props: CompareCanvasesProps) {
  const { dealId, filters, doc, buyers, state, current, wide } = props;
  const rid = doc.rendition?.id ?? null;
  const b = compareSideB(buyers, state);
  const aName = buyers.find((x) => x.accessId === state.a)?.name ?? "This buyer";
  const base = { range: filters.range, device: filters.device, segment: "all" as const, rendition: rid };
  const qa = useEngagementDocument(dealId, { ...base, buyers: [state.a] });
  // An empty group loads nothing (an empty buyer list would mean "everyone").
  const qb = useEngagementDocument(b.ids.length > 0 ? dealId : undefined, { ...base, buyers: b.ids });
  const [side, setSide] = useState<"a" | "b">("a");

  const sides = useMemo(() => {
    const find = (d: EngagementDocumentResponse | undefined) => d?.pages.find((p) => p.pageId === current.pageId && p.part === current.part) ?? null;
    const aPage = find(qa.data);
    const bRaw = find(qb.data);
    const bPages = (qb.data?.pages ?? []).map((p) => perBuyerPage(p, p.readers));
    const bPage = bRaw ? perBuyerPage(bRaw, bRaw.readers) : null;
    const aRead = !!aPage && aPage.attentionMs >= 1000;
    const bRead = !!bPage && (bRaw?.readers ?? 0) > 0 && bPage.attentionMs >= 1000;
    const bLabelLower = b.label.charAt(0).toLowerCase() + b.label.slice(1);
    const A: Side = {
      key: "a", short: aName,
      heading: aRead ? `${aName}: ${formatReadingTime(aPage!.attentionMs)} on this page` : `${aName} didn't read this page`,
      page: aPage, pages: qa.data?.pages ?? [], loading: qa.isLoading, error: !!qa.error,
      empty: aRead ? null : `${aName} hasn't read this page.`,
    };
    const B: Side = {
      key: "b", short: b.label,
      heading: b.ids.length === 0
        ? `${b.label}: nobody to compare with`
        : bRead
          ? b.group
            ? `${b.label} (${bRaw!.readers}): ${formatReadingTime(bPage!.attentionMs)} average per buyer`
            : `${b.label}: ${formatReadingTime(bPage!.attentionMs)} on this page`
          : b.group ? `${b.label}: nobody read this page` : `${b.label} didn't read this page`,
      page: bPage, pages: bPages, loading: b.ids.length > 0 && qb.isLoading, error: !!qb.error,
      empty: bRead ? null : b.ids.length === 0 ? "Nobody in this group has read the CIM yet." : b.group ? `None of the ${bLabelLower} read this page.` : `${b.label} hasn't read this page.`,
    };
    return [A, B];
  }, [qa.data, qb.data, qa.isLoading, qb.isLoading, qa.error, qb.error, current.pageId, current.part, aName, b.label, b.group, b.ids.length]);

  const [A, B] = sides;
  const view = props.sectionView;
  const maxMs = sharedMaxMs(
    { pages: A.pages, current: A.page ? pageInView(A.page, view) : null },
    { pages: B.pages, current: B.page ? pageInView(B.page, view) : null },
    props.scope,
  );
  const maxPageMs = Math.max(pageHeatMaxMs(A.pages), pageHeatMaxMs(B.pages));

  const canvas = (s: Side) => {
    if (s.loading) return <Skeleton className="h-[70vh] w-full rounded-[3px]" />;
    if (s.error) return <p className="rounded-lg border border-border p-8 text-center text-sm text-muted-foreground">Couldn&apos;t load this side. Try again in a moment.</p>;
    const mode = s.page && !s.empty ? drawMode(s.page) : "none";
    const washT = s.page ? heatIntensity(s.page.attentionMs, maxPageMs) : 0;
    const rank = s.page ? pageRank(s.pages, s.page) : null;
    const washCard: WashCard | null = s.page && mode === "wash" ? { time: formatReadingTime(s.page.attentionMs), buyers: s.page.buyers.length, rankText: rank?.text ?? null } : null;
    return (
      <div className="relative">
        <PageCanvas
          rendition={props.rendition}
          pageId={current.pageId}
          part={current.part}
          renditionPage={props.renditionPage}
          page={s.empty ? null : s.page}
          paint={mode === "parts"}
          showHeat={props.showHeat}
          showUnread={false}
          maxMs={maxMs}
          selectedKey={props.selectedKey}
          hoveredKey={props.hoveredKey}
          onSelectKey={props.onSelectKey}
          onHoverKey={props.onHoverKey}
          touch={props.touch}
          view={view}
          onViewChange={props.onViewChange}
          mode={mode}
          washT={washT}
          washCard={washCard}
          outlineKey={props.hoveredKey ?? props.selectedKey}
        />
        {s.empty && (
          <div className="pointer-events-none absolute inset-x-0 top-24 flex justify-center px-6" data-testid={`compare-empty-${s.key}`}>
            <p className="rounded-md px-3 py-2 text-center text-sm shadow-sm" style={{ background: "#FBF9F4", color: "#201D18", border: "1px solid #E4DDCF" }}>{s.empty}</p>
          </div>
        )}
      </div>
    );
  };

  // One key for both sides (they share one scale), right under the pages.
  const drawn = [A, B].filter((x) => !!x.page && !x.empty).map((x) => drawMode(x.page));
  const legend = !props.showHeat
    ? null
    : drawn.includes("parts") && maxMs > 0
      ? <HeatLegend maxMs={maxMs} scope={effectiveScope(props.scope, A.page ?? B.page)} perBuyer={b.group} note="Same scale on both sides" />
      : drawn.includes("wash") && maxPageMs > 0
        ? <PageLegend maxPageMs={maxPageMs} note="Same scale on both sides" />
        : null;
  if (wide) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-4" data-testid="compare-side-by-side">
          {[A, B].map((s) => (
            <div key={s.key} className="min-w-0 space-y-2">
              <p className={cn("text-sm font-medium", s.empty && "text-muted-foreground")} data-testid={`compare-heading-${s.key}`}>{s.heading}</p>
              {canvas(s)}
            </div>
          ))}
        </div>
        {legend}
      </div>
    );
  }
  const shown = side === "a" ? A : B;
  return (
    <div className="space-y-2" data-testid="compare-switch">
      <Segmented<"a" | "b">
        label="Which side"
        size="xs"
        value={side}
        onChange={setSide}
        options={[{ value: "a", label: A.short }, { value: "b", label: B.short }]}
      />
      <p className={cn("text-sm font-medium", shown.empty && "text-muted-foreground")} data-testid={`compare-heading-${shown.key}`}>{shown.heading}</p>
      {canvas(shown)}
      {legend}
    </div>
  );
}

/** Buyers list → what compare needs (call order, decision, reading). */
export function compareBuyersOf(cards: ReadonlyArray<{ accessId: string; name: string; decision: string; rank: number; activeMs: number; visits: number }>): CompareBuyer[] {
  return cards.map((c) => ({ accessId: c.accessId, name: c.name, decision: c.decision || null, rank: c.rank, activeMs: c.activeMs, visits: c.visits }));
}
