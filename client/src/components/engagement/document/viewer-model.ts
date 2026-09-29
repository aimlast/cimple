/**
 * viewer-model — the pure rules behind the document heat map (no React).
 *
 * The Document view pages through the CIM exactly as buyers were served it
 * and paints each measured part (data-cim-block) by its reading time. Every
 * decision the screen makes that isn't layout lives here, so it can be
 * unit-tested (tests/unit/engagement-viewer.test.ts):
 *
 *   - which viewer page is open (the ?page=<pageId#part> URL value);
 *   - the heat scale (busiest part in the whole CIM, or on this page) and the
 *     seconds legend that reads it;
 *   - which parts are drawn on a split page ("7b" shows only its own parts);
 *   - the top-3 pins, "Nobody read this", the words for what buyers did;
 *   - a section buyers could collapse: which view to draw (collapsed, as
 *     they first saw it, or opened) and which parts belong to it.
 *
 * Words: "reading time", seconds and minutes — never percent-of-max.
 */
import {
  READING_RULES,
  formatReadingTime,
  type BlockAttention,
  type DocumentPage,
  type InteractionCounts,
  type ReachPoint,
  type ReadingInteractionType,
  type RenditionPage,
} from "@shared/analytics-v2";
import { topSegment } from "@shared/cim-blocks";
import { heatPaper } from "../heat";

// ── Which page is open ───────────────────────────────────────────────────

/** "<pageId>#<part>" → { pageId, part }; null for a missing or malformed value. */
export function parsePageParam(v: string | null | undefined): { pageId: string; part: number } | null {
  if (!v) return null;
  const m = /^([A-Za-z0-9_-]{1,64})(?:#(\d{1,2}))?$/.exec(v);
  return m ? { pageId: m[1], part: m[2] ? Number(m[2]) : 0 } : null;
}

/**
 * Index of the page to show. The URL wins when it names a page of this
 * version; a page the version doesn't have falls back to its first part, then
 * to the default: the most-read page (so the first look lands on something
 * worth seeing), or page 1 when nothing was read.
 */
export function selectPageIndex(pages: ReadonlyArray<Pick<DocumentPage, "pageId" | "part" | "attentionMs">>, param: string | null | undefined): number {
  if (pages.length === 0) return -1;
  const want = parsePageParam(param);
  if (want) {
    const exact = pages.findIndex((p) => p.pageId === want.pageId && p.part === want.part);
    if (exact !== -1) return exact;
    const first = pages.findIndex((p) => p.pageId === want.pageId);
    if (first !== -1) return first;
  }
  let best = 0;
  pages.forEach((p, i) => { if (p.attentionMs > pages[best].attentionMs) best = i; });
  return best;
}

export type PageOrder = "document" | "time";

/** Rail order: document order, or most reading time first (ties keep document order). */
export function orderPages<T extends Pick<DocumentPage, "index" | "attentionMs">>(pages: readonly T[], order: PageOrder): T[] {
  const out = [...pages];
  if (order === "time") out.sort((a, b) => b.attentionMs - a.attentionMs || a.index - b.index);
  else out.sort((a, b) => a.index - b.index);
  return out;
}

// ── The heat scale ───────────────────────────────────────────────────────

export type HeatScope = "document" | "page";

/** Parts that can be painted: real elements of the default view (no chart points, no column containers). */
export function paintable(b: Pick<BlockAttention, "kind" | "key">): boolean {
  return b.kind !== "point" && b.kind !== "column";
}

/**
 * The comparison actually used. "Within this page" needs a few parts to
 * compare: a page drawn as one or two parts (the disclaimer, a single chart)
 * would always come out at full strength, so it falls back to the whole CIM.
 */
export function effectiveScope(scope: HeatScope, current: Pick<DocumentPage, "blocks"> | null): HeatScope {
  if (scope === "document" || !current) return "document";
  const parts = current.blocks.filter((b) => paintable(b) && b.kind !== "heading").length;
  return parts >= 3 ? "page" : "document";
}

/** The reading time the darkest colour stands for: the busiest part in the whole CIM, or on this page. */
export function heatMaxMs(pages: ReadonlyArray<Pick<DocumentPage, "blocks">>, scope: HeatScope, current: Pick<DocumentPage, "blocks"> | null): number {
  const pool = effectiveScope(scope, current) === "page" ? [current!] : pages;
  let max = 0;
  for (const p of pool) for (const b of p.blocks) if (paintable(b) && b.attentionMs > max) max = b.attentionMs;
  return max;
}

/**
 * Colour intensity 0–1 of a part. A gentle curve (t^0.6) so parts with a
 * fraction of the busiest part's time still show; the legend below the page
 * prints the seconds each shade stands for, so the colours stay honest.
 */
export const HEAT_GAMMA = 0.6;
export function heatIntensity(ms: number, maxMs: number): number {
  if (!(maxMs > 0) || !(ms > 0)) return 0;
  return Math.pow(Math.min(1, ms / maxMs), HEAT_GAMMA);
}

/**
 * The tint drawn over a part on the paper: the shared paper ramp (heatPaper)
 * at a lighter strength, so a whole page of well-read text stays easy to read
 * under its colour. The legend uses the same function.
 */
export const TINT_STRENGTH = 0.62;
export function paperTint(t: number): string | null {
  const c = heatPaper(t);
  if (!c) return null;
  return c.replace(/rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/, (_m, r, g, b, a) => `rgba(${r}, ${g}, ${b}, ${(Number(a) * TINT_STRENGTH).toFixed(2)})`);
}

/** The reading time a given intensity stands for (inverse of heatIntensity). */
export function msAtIntensity(t: number, maxMs: number): number {
  return maxMs * Math.pow(Math.max(0, Math.min(1, t)), 1 / HEAT_GAMMA);
}

/** Legend ticks: [intensity, "label"] from the faintest to the darkest shade, labelled in seconds. */
export function legendTicks(maxMs: number, steps = 4): Array<{ t: number; label: string }> {
  if (!(maxMs > 0)) return [];
  const out: Array<{ t: number; label: string }> = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    out.push({ t, label: formatReadingTime(msAtIntensity(t, maxMs)) });
  }
  return out;
}

// ── Collapsible sections ─────────────────────────────────────────────────

/** How a section buyers could collapse is drawn: as they first saw it, or opened. */
export type SectionView = "collapsed" | "opened";

/** The page is a section buyers first saw collapsed (its registry has a collapsed "summary" block). */
export function isCollapsible(rp: Pick<RenditionPage, "blocks"> | undefined | null): boolean {
  return !!rp?.blocks.some((b) => b.key === "summary" && b.when === "collapsed");
}

/** Buyers who opened this section (expand clicks on the page). */
export function expandCount(page: Pick<DocumentPage, "interactions">): number {
  return page.interactions.expand ?? 0;
}

/**
 * The view to draw first: collapsed (as every buyer first saw it) unless
 * buyers opened the section and read more in it opened than in the
 * collapsed summary. Null for a page that can't collapse.
 */
export function defaultSectionView(
  page: Pick<DocumentPage, "blocks" | "interactions">,
  rp: Pick<RenditionPage, "blocks"> | undefined | null,
): SectionView | null {
  if (!isCollapsible(rp)) return null;
  const summary = page.blocks.find((b) => b.key === "summary")?.attentionMs ?? 0;
  const opened = page.blocks.filter((b) => b.key !== "summary" && paintable(b) && b.kind !== "heading").reduce((s, b) => s + b.attentionMs, 0);
  return expandCount(page) > 0 && opened > summary ? "opened" : "collapsed";
}

/** Whether a part belongs to the drawn view (every part when the page can't collapse). */
export function inView(key: string, view: SectionView | null): boolean {
  if (!view) return true;
  return view === "collapsed" ? key === "summary" : key !== "summary";
}

/** The page with only the parts of the drawn view (pins, outlines, the panel's list and the shades use this). */
export function pageInView<T extends Pick<DocumentPage, "blocks">>(page: T, view: SectionView | null): T {
  return view ? { ...page, blocks: page.blocks.filter((b) => inView(b.key, view)) } : page;
}

/** The parts of this page with the most reading time (pins 1–3). Titles never get a pin. */
export function topBlocks(page: Pick<DocumentPage, "blocks">, n = 3): string[] {
  return page.blocks
    .filter((b) => paintable(b) && b.kind !== "heading" && b.attentionMs >= READING_RULES.unreadBlockMs)
    .sort((a, b) => b.attentionMs - a.attentionMs)
    .slice(0, n)
    .map((b) => b.key);
}

/**
 * A part nobody read: under a second of reading time AND hardly on screen
 * (under 3 s in view in all). A small KPI item that sat on screen for a
 * minute while its neighbours took the reading time was seen — it is not
 * "nobody read this".
 */
export function isUnread(b: Pick<BlockAttention, "attentionMs" | "visibleMs">): boolean {
  return b.attentionMs < READING_RULES.unreadBlockMs && b.visibleMs < READING_RULES.readerMinMs;
}

/**
 * Parts nobody read on a page that buyers reached. Headings don't count,
 * and only parts buyers could have had on screen: a table's Normalized rows
 * only after a switch; for a section buyers first saw collapsed, the
 * collapsed view is its summary, and the opened view's parts count only
 * when some buyer opened it — pass the page's rendition blocks and the
 * drawn view to say which.
 */
export function unreadBlocks(
  page: Pick<DocumentPage, "blocks" | "reachedBy"> & Partial<Pick<DocumentPage, "interactions">>,
  renditionBlocks?: ReadonlyArray<Pick<RenditionPage["blocks"][number], "key" | "virtual" | "when">>,
  view: SectionView | null = null,
): string[] {
  if (page.reachedBy <= 0) return [];
  if (view === "opened" && (page.interactions?.expand ?? 0) <= 0) return [];
  const otherView = new Set((renditionBlocks ?? []).filter((b) => b.virtual || (b.when && !(view === "collapsed" && b.when === "collapsed"))).map((b) => b.key));
  return page.blocks
    .filter((b) => paintable(b) && b.kind !== "heading" && inView(b.key, view) && !otherView.has(b.key) && isUnread(b))
    .map((b) => b.key);
}

// ── Split pages ("7a" / "7b") ────────────────────────────────────────────

/**
 * How the rendered section is trimmed to one printed part. The section
 * renders whole; the top-level parts that belong to another part are hidden,
 * and on a later part the section heading and table header stay visible
 * (faded, unpainted) so the page still reads as a continuation.
 */
export function partVisibility(page: Pick<RenditionPage, "parts" | "blocks">, part: number): { hide: string[]; fade: string[] } {
  if (page.parts <= 1) return { hide: [], fade: [] };
  const hide = new Set<string>();
  const fade = new Set<string>();
  for (const b of page.blocks) {
    if (b.virtual || b.when) continue;
    const top = topSegment(b.key);
    if (top !== b.key) continue; // children follow their top-level part
    if (b.part === part) continue;
    if (part > 0 && (b.key === "heading" || b.key === "head")) fade.add(b.key);
    else hide.add(b.key);
  }
  return { hide: Array.from(hide), fade: Array.from(fade) };
}

/** A CSS rule set hiding/fading those parts inside one container (keys are structural, safe in a quoted selector). */
export function partVisibilityCss(scopeSelector: string, v: { hide: string[]; fade: string[] }): string {
  const sel = (k: string) => `${scopeSelector} [data-cim-block="${k.replace(/["\\]/g, "")}"]`;
  const rules: string[] = [];
  if (v.hide.length) rules.push(`${v.hide.map(sel).join(",")}{display:none !important}`);
  if (v.fade.length) rules.push(`${v.fade.map(sel).join(",")}{opacity:.45}`);
  return rules.join("\n");
}

// ── Words ────────────────────────────────────────────────────────────────

const INTERACTION_WORDS: Partial<Record<ReadingInteractionType, [string, string]>> = {
  financial_view: ["Switched a table to Normalized", "Switched a table to Normalized"],
  expand: ["Opened the full section", "Opened the full section"],
  collapse: ["Closed the section again", "Closed the section again"],
  nav: ["Jumped here from the contents or a link", "Jumped here from the contents or a link"],
  locked_click: ["Tried to open a locked page", "Tried to open a locked page"],
  media_play: ["Played the video", "Played the video"],
  media_progress: ["Watched part of the video", "Watched part of the video"],
  gallery_open: ["Opened a photo", "Opened photos"],
  map_interact: ["Used the map", "Used the map"],
  contact_click: ["Clicked your email or phone", "Clicked your email or phone"],
  copy: ["Tried to copy text", "Tried to copy text"],
  print_attempt: ["Tried to print", "Tried to print"],
  download_attempt: ["Tried to download", "Tried to download"],
  chat_open: ["Opened the question box", "Opened the question box"],
};

/** "Switched a table to Normalized · 3 times", most frequent first; media_progress folds into plays. */
export function interactionLines(counts: InteractionCounts): Array<{ type: ReadingInteractionType; text: string; count: number }> {
  const out: Array<{ type: ReadingInteractionType; text: string; count: number }> = [];
  for (const [type, n] of Object.entries(counts) as Array<[ReadingInteractionType, number]>) {
    if (!n || n <= 0) continue;
    if (type === "media_progress" && (counts.media_play ?? 0) > 0) continue;
    const words = INTERACTION_WORDS[type];
    if (!words) continue;
    out.push({ type, count: n, text: n === 1 ? words[0] : `${words[1]} · ${n} times` });
  }
  return out.sort((a, b) => b.count - a.count);
}

/** "5 of 6" — buyers who read the page out of those who opened the CIM. */
export function readersText(readers: number, openedBy: number): string {
  return `${readers} of ${Math.max(openedBy, readers)}`;
}

/** Average reading time per buyer who read the page (null with no readers). */
export function perReaderMs(page: Pick<DocumentPage, "attentionMs" | "readers">): number | null {
  return page.readers > 0 ? page.attentionMs / page.readers : null;
}


// ── How far buyers got ───────────────────────────────────────────────────

/**
 * The steepest drop between neighbouring pages (for the chart's marker), or
 * null when no drop is worth pointing at: a drop must be at least 2 buyers
 * AND at least 10% of those who opened the CIM (one buyer stopping is not a
 * pattern) — the same rule as the headline (server insights isMarkedDrop).
 */
export function steepestDrop(reach: ReadonlyArray<Pick<ReachPoint, "buyers">>): { index: number; from: number; to: number } | null {
  const n = reach.reduce((m, r) => Math.max(m, r.buyers), 0);
  let best: { index: number; from: number; to: number } | null = null;
  for (let i = 1; i < reach.length; i++) {
    const d = reach[i - 1].buyers - reach[i].buyers;
    if (d >= 2 && d >= 0.1 * n && (!best || d > best.from - best.to)) best = { index: i, from: reach[i - 1].buyers, to: reach[i].buyers };
  }
  return best;
}

/**
 * "Page 19 of 32", and "Page 19 of 32 (19a)" for a printed part: the count
 * is the CIM's page numbers (a long section's parts 19a/19b are one page
 * number), not the number of viewer pages.
 */
export function pageOfText(label: string, pages: ReadonlyArray<Pick<DocumentPage, "label">>): string {
  const num = (l: string) => { const m = /^(\d+)/.exec(l); return m ? Number(m[1]) : NaN; };
  const total = pages.reduce((m, p) => (Number.isFinite(num(p.label)) ? Math.max(m, num(p.label)) : m), 0) || pages.length;
  const n = num(label);
  if (!Number.isFinite(n)) return `Page ${label} of ${total}`;
  return `Page ${n} of ${total}${String(n) !== label ? ` (${label})` : ""}`;
}

/** A plain fallback sentence when no computed headline came back: facts only. */
export function reachFallback(reach: ReadonlyArray<Pick<ReachPoint, "buyers">>, openedBy: number): string | null {
  if (openedBy <= 0 || reach.length === 0) return null;
  const last = reach[reach.length - 1].buyers;
  if (last >= openedBy) return `All ${openedBy} buyer${openedBy === 1 ? "" : "s"} who opened the CIM reached the last page.`;
  return `${openedBy} buyer${openedBy === 1 ? "" : "s"} opened the CIM; ${last} reached the last page.`;
}

// ── Journeys ─────────────────────────────────────────────────────────────

/** Widths (share of the strip, summing to 1) for a visit's path segments; every segment keeps a sliver so short stops stay visible. */
export function pathWidths(durations: readonly number[], minShare = 0.012): number[] {
  const n = durations.length;
  if (n === 0) return [];
  const total = durations.reduce((s, d) => s + Math.max(0, d), 0);
  if (!(total > 0)) return durations.map(() => 1 / n);
  const floor = Math.min(minShare, 1 / n);
  const raw = durations.map((d) => Math.max(0, d) / total);
  const small = raw.filter((w) => w < floor).length;
  const bigTotal = raw.filter((w) => w >= floor).reduce((s, w) => s + w, 0);
  const room = 1 - small * floor;
  return raw.map((w) => (w < floor ? floor : bigTotal > 0 ? (w / bigTotal) * room : floor));
}
