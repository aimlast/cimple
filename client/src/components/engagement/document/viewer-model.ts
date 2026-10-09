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
 *     they first saw it, or opened) and which parts belong to it;
 *   - how a page is drawn when only its total reading time is known (a
 *     whole-page wash with its rank), the one status line above the page and
 *     the "Why?" notes behind it (heat-map spec §3.3–3.4).
 *
 * Words: "reading time", seconds and minutes — never percent-of-max. Never
 * "legacy", "rendition" or "dwell" on screen.
 */
import {
  READING_RULES,
  formatReadingTime,
  type BlockAttention,
  type DocumentPage,
  type EngagementDocumentResponse,
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
  vdr_open: ["Opened a data-room document", "Opened data-room documents"],
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
  // (Pass recordedReach(...): pages the old tracking never recorded are never a drop.)
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


// ── Whole-page heat (only page totals known) ─────────────────────────────

/** The busiest page's reading time: the darkest whole-page shade. */
export function pageHeatMaxMs(pages: ReadonlyArray<Pick<DocumentPage, "attentionMs">>): number {
  return pages.reduce((m, p) => Math.max(m, p.attentionMs), 0);
}

/** 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th", 22 → "22nd". */
export function ordinal(n: number): string {
  const t = n % 100;
  if (t >= 11 && t <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? "st" : n % 10 === 2 ? "nd" : n % 10 === 3 ? "rd" : "th"}`;
}

/**
 * Where a page ranks by reading time among the CIM's pages: rank (1 = most
 * read; ties go to the earlier page), out of how many, and the words ("3rd
 * most-read of 29", "Most-read of 29"). A long section printed as parts
 * ("7a", "7b") is one page here, with its parts' time together, so the count
 * matches "Page 12 of 28". Null for a page nobody read.
 */
export function pageRank(
  pages: ReadonlyArray<Pick<DocumentPage, "pageId" | "part" | "index" | "attentionMs">>,
  page: Pick<DocumentPage, "pageId" | "part" | "attentionMs">,
): { rank: number; of: number; text: string } | null {
  if (!(page.attentionMs > 0)) return null;
  const byPage = new Map<string, { ms: number; first: number }>();
  for (const p of pages) {
    const e = byPage.get(p.pageId) ?? { ms: 0, first: p.index };
    e.ms += p.attentionMs;
    e.first = Math.min(e.first, p.index);
    byPage.set(p.pageId, e);
  }
  const sorted = Array.from(byPage.entries()).sort((a, b) => b[1].ms - a[1].ms || a[1].first - b[1].first);
  const rank = sorted.findIndex(([id]) => id === page.pageId) + 1;
  if (rank <= 0) return null;
  const of = byPage.size;
  return { rank, of, text: rank === 1 ? `Most-read of ${of}` : `${ordinal(rank)} most-read of ${of}` };
}

/** The ramp colour at t as rgb (the paper stops, theme-locked). */
function rampRgb(t: number): [number, number, number] | null {
  const c = heatPaper(t);
  const m = c ? /rgba\((\d+), (\d+), (\d+)/.exec(c) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * The whole-page wash on paper for intensity t: the paper ramp colour at t,
 * alpha 0.10 + 0.27·t (at most 0.37 — body text stays easy to read), drawn
 * with mix-blend-mode: multiply. Null when there is nothing to draw.
 */
export const WASH_MAX_ALPHA = 0.37;
export function washFill(t: number): string | null {
  if (!(t > 0)) return null;
  const rgb = rampRgb(t);
  if (!rgb) return null;
  const a = Math.min(WASH_MAX_ALPHA, 0.1 + 0.27 * Math.min(1, t));
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${a.toFixed(3)})`;
}

/** The ramp colour at full strength (the wash's edge bar and badge border). */
export function washEdge(t: number): string {
  const rgb = rampRgb(Math.max(0.05, t)) ?? [231, 194, 122];
  return `rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`;
}

/** A rail tile's background for intensity t (app chrome: the brass token, both themes). */
export function railTint(t: number): string | null {
  if (!(t > 0)) return null;
  return `hsl(var(--teal) / ${(0.05 + 0.25 * Math.min(1, t)).toFixed(3)})`;
}

/** What is drawn on the paper: each part, the whole page, or nothing. */
export type DrawMode = "parts" | "wash" | "none";
export function drawMode(page: Pick<DocumentPage, "attentionMs" | "heat"> | null | undefined, sameLayout = true): DrawMode {
  if (!page || page.heat.basis === "none" || !(page.attentionMs >= 1000)) return "none";
  if (!sameLayout || page.heat.basis === "page") return "wash";
  return "parts";
}

/** Legend ticks for the whole-page shade (seconds of page reading time). */
export function pageLegendTicks(maxPageMs: number, steps = 4): Array<{ t: number; label: string }> {
  return legendTicks(maxPageMs, steps);
}

/**
 * The reach points the old tracking recorded (DocumentPage.reachRecorded):
 * pages nobody has any reading on — anywhere, trailing or in between — are
 * left out of the drop. Indexes here are positions in the returned list;
 * use recordedDrop for a drop at a page's own index.
 */
export function recordedReach<T extends Pick<ReachPoint, "buyers">>(reach: readonly T[], pages: ReadonlyArray<Pick<DocumentPage, "reachRecorded">>): T[] {
  return reach.filter((_, i) => pages[i]?.reachRecorded !== false);
}

/**
 * The steepest marked drop between recorded pages, at the page's own index
 * in `reach` (the ▼ on the chart): a drop is measured from the previous
 * recorded page, never onto a page nobody's reading was recorded on.
 */
export function recordedDrop(reach: ReadonlyArray<Pick<ReachPoint, "buyers">>, pages: ReadonlyArray<Pick<DocumentPage, "reachRecorded">>): { index: number; from: number; to: number } | null {
  const at = reach.map((_, i) => i).filter((i) => pages[i]?.reachRecorded !== false);
  const d = steepestDrop(at.map((i) => reach[i]));
  return d ? { ...d, index: at[d.index] } : null;
}

/** "4a–4b, 8, 11 and 25–28": viewer pages as runs of neighbouring pages (by index); past maxRuns, "… and 7 more". */
export function pageRunsText(pages: ReadonlyArray<Pick<DocumentPage, "index" | "label">>, maxRuns = 6): string {
  const sorted = [...pages].sort((a, b) => a.index - b.index);
  const runs: Array<{ text: string; n: number }> = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].index === sorted[j].index + 1) j++;
    runs.push({ text: j > i ? `${sorted[i].label}–${sorted[j].label}` : sorted[i].label, n: j - i + 1 });
    i = j;
  }
  // The rest as a count of pages (never of runs).
  const shown = runs.length > maxRuns
    ? [...runs.slice(0, maxRuns - 1).map((r) => r.text), `${runs.slice(maxRuns - 1).reduce((s, r) => s + r.n, 0)} more`]
    : runs.map((r) => r.text);
  return shown.length <= 1 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

// ── The status line and "Why?" ──────────────────────────────────────────

/** What the page canvas shows right now (broker's switches). */
export interface StatusContext {
  /** The drawn version is blind. */
  blind: boolean;
  /** "Show the named version" is on. */
  showNamed: boolean;
  /** The shown version has the same parts as the one buyers read. */
  sameLayout: boolean;
  /**
   * Who the view shows (shared engagementViewScope): "one" = a single buyer's
   * whole reading (e.g. from "See where they read"); "some" = any narrower
   * view — several buyers, a segment, a device or a date range.
   */
  filter?: "one" | "some" | null;
  /**
   * Phones: "Within this page" fell back to the whole CIM (a page with only
   * one or two parts). The note moves from the switch row into "Why?".
   */
  fewPartsNote?: boolean;
}

/**
 * "Nobody …" said for the view shown: every buyer (null), one buyer's whole
 * reading ("one"), or a narrower view ("some": several buyers, a segment, a
 * device, a date range) — where other buyers may well have done it.
 */
export function scopedNobody(scope: "one" | "some" | null | undefined, words: { all: string; one: string; some: string }): string {
  return scope === "one" ? words.one : scope === "some" ? words.some : words.all;
}

/** Why a page with only one or two parts compares with the whole CIM (inline on wide screens, in "Why?" on phones). */
export const FEW_PARTS_NOTE = "This page has only one or two parts, so its colours compare with the whole CIM.";

type DocForStatus = Pick<EngagementDocumentResponse, "versionNote" | "sampleReading" | "reachBasis" | "lastRecordedIndex" | "legacyUnmatched" | "pages">;
type PageForStatus = Pick<DocumentPage, "heat" | "attentionMs"> & { reachRecorded?: boolean };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-09-29T14:02:17Z" → "29 Sep" (null when it isn't a date). */
export function shortDate(iso: string | null | undefined): string | null {
  const t = iso ? Date.parse(iso) : NaN;
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

const s_ = (n: number) => (n === 1 ? "" : "s");

/**
 * The one sentence above the page (first match wins), or null — then the
 * line shows only "Why?" when there are notes. Exact copy: heat-map spec §3.4.
 */
export function statusSentence(page: PageForStatus | null, doc: DocForStatus, ctx: StatusContext): string | null {
  if (page) {
    const mode = drawMode(page, ctx.sameLayout);
    if (page.heat.basis === "none" || mode === "none") {
      // In a filtered view other buyers may have read it; a page nobody's reading was recorded on is unread by all.
      if (page.reachRecorded !== false && ctx.filter === "one") return "This buyer hasn't read this page.";
      if (page.reachRecorded !== false && ctx.filter === "some") return "No buyer in this view has read this page.";
      return "Nobody has read this page yet.";
    }
    if (page.heat.basis === "page") {
      if (page.heat.reason === "before_part_tracking") return "Shaded as a whole page: read before Cimple tracked each part of a page.";
      if (page.heat.reason === "other_layout") return "Shaded as a whole page: buyers read a version of it with different parts.";
      return "Shaded as a whole page: only its total reading time is known.";
    }
    if (mode === "wash") return "Shaded as a whole page: the named version's parts differ from what blind buyers saw.";
    if (page.heat.basis === "mixed") {
      const k = page.heat.partBuyers;
      const m = page.heat.pageOnlyBuyers;
      return `Colours show where ${k} buyer${s_(k)} read; ${m} more read it as a whole page (${formatReadingTime(page.heat.pageOnlyMs)}).`;
    }
  }
  const v = doc.versionNote;
  if (v?.kind === "held") return "Buyers can't open this CIM until you publish your update.";
  if (v?.kind === "kept_copy") {
    const d = shortDate(v.since);
    return d ? `Buyers are still reading the version from before your ${d} update.` : "Buyers are still reading the version from before your latest update.";
  }
  if (v?.kind === "older_version") return "This is the version these buyers read; your CIM has changed since.";
  if (ctx.blind && !ctx.showNamed) return "Blind version: exactly what blind buyers saw.";
  return null;
}

export interface WhyNote {
  key: "basis" | "scope" | "version" | "blind" | "not_recorded" | "unmatched" | "sample";
  title: string;
  text: string;
}

/** Every note that applies, each a short paragraph (the "Why?" popover). Exact copy: heat-map spec §3.4. */
export function whyNotes(page: PageForStatus | null, doc: DocForStatus, ctx: StatusContext): WhyNote[] {
  const out: WhyNote[] = [];
  const mode = page ? drawMode(page, ctx.sameLayout) : "none";
  if (page && page.heat.basis === "page") {
    if (page.heat.reason === "other_layout") {
      out.push({ key: "basis", title: "Why the whole page is shaded", text: "These buyers read a version of this page with different parts (an earlier layout, or the named version), so their time can't be placed on today's parts." });
    } else {
      out.push({ key: "basis", title: "Why the whole page is shaded", text: "Cimple recorded these visits before it tracked each part of a page, so only each page's total reading time is known. The whole page is shaded by that total: the darker, the more time. New visits show exactly which parts buyers read." });
    }
  } else if (page && page.heat.basis === "mixed" && mode === "parts") {
    const k = page.heat.partBuyers;
    const m = page.heat.pageOnlyBuyers;
    out.push({
      key: "basis",
      title: "Parts and whole pages",
      text: `${k} buyer${s_(k)} read this page part by part, and the colours show where. ${m} more read it as a whole page (${formatReadingTime(page.heat.pageOnlyMs)}): before Cimple tracked each part of a page, or on a version with different parts. Their time counts in the page's total, not in the colours.`,
    });
  }
  if (page && ctx.fewPartsNote && mode === "parts") {
    out.push({ key: "scope", title: "Why the colours compare with the whole CIM", text: FEW_PARTS_NOTE });
  }
  const v = doc.versionNote;
  if (v?.kind === "kept_copy") {
    const d = shortDate(v.since);
    out.push({ key: "version", title: "Which version this is", text: `Buyers are still reading the version that was live before your ${d ? `${d} ` : ""}update, while the update waits for your review. The colours are their reading on that version.` });
  } else if (v?.kind === "held") {
    out.push({
      key: "version",
      title: "Which version this is",
      text: v.sample
        ? "Buyers haven't seen this version yet. This sample reading is drawn on the version they'll get when you publish."
        : "Buyers haven't seen this version yet. Shading shows the time they spent on the matching page of the version they read.",
    });
  } else if (v?.kind === "older_version") {
    out.push({ key: "version", title: "Which version this is", text: `This is the version these buyers read. Your CIM has changed since (${v.changedPages} page${s_(v.changedPages)}).` });
  }
  if (ctx.blind) {
    out.push({
      key: "blind",
      title: "Blind version",
      text: ctx.showNamed && !ctx.sameLayout
        ? "The named version's parts differ from what blind buyers saw, so the whole page is shaded by its reading time."
        : ctx.showNamed
          ? "Named version, for your reference. Blind buyers saw the codename version of this page; the colours are theirs."
          : v?.kind === "held"
            ? "Blind version: what blind buyers will see when you publish. Page titles in the list are the real ones, for you."
            : "Blind version: exactly what blind buyers saw. Page titles in the list are the real ones, for you.",
    });
  }
  if (doc.reachBasis === "old_tracking") {
    const missing = doc.pages.filter((p) => p.reachRecorded === false);
    if (missing.length > 0) {
      const last = doc.lastRecordedIndex != null ? doc.pages.find((p) => p.index === doc.lastRecordedIndex) : null;
      const titles = Array.from(new Set(missing.map((p) => p.title)));
      const list = `${pageRunsText(missing)} (${titles.slice(0, 3).join(", ")}${titles.length > 3 ? ", …" : ""})`;
      const many = missing.length !== 1;
      // Only after the last page with reading: "stops at page 27" says it all.
      const trailing = !!last && missing.every((p) => p.index > last.index);
      const so = trailing
        ? `"how far buyers got" stops at page ${last!.label}`
        : `${many ? "they're" : "it's"} hatched and left out of "how far buyers got"`;
      out.push({
        key: "not_recorded",
        title: "Pages with no reading recorded",
        // Drawn on a version buyers haven't been served yet: a page with no reading is most likely new in the update.
        text: v?.kind === "held"
          ? `No reading was recorded on page${s_(missing.length)} ${list}: ${many ? "they were" : "it was"} added after these buyers read, or Cimple's earlier tracking didn't record ${many ? "them" : "it"}. So ${so}.`
          : `Cimple's earlier tracking didn't record page${s_(missing.length)} ${list}, so ${so}.`,
      });
    }
  }
  const u = doc.legacyUnmatched;
  if (u && u.attentionMs >= 1000) {
    out.push({
      key: "unmatched",
      title: "Reading on pages this version doesn't have",
      text: `${formatReadingTime(u.attentionMs)} of earlier reading was on ${u.pages.length === 1 ? "a page" : "pages"} this version of the CIM doesn't show (${u.pages.slice(0, 4).map((p) => p.label).join(", ")}${u.pages.length > 4 ? ", …" : ""}). It still counts in each buyer's visits.`,
    });
  }
  if (doc.sampleReading) {
    out.push({ key: "sample", title: "Sample reading", text: "This is an example deal. Its buyers and their reading are made up, to show what the heat map does. Real deals only ever show what buyers actually did." });
  }
  return out;
}

// ── "How far buyers got": the counts line ────────────────────────────────

/**
 * "13 opened it · 12 with reading recorded · 6 got to page 27, the last
 * page recorded": the middle part only when the two numbers differ; the
 * last part only when the sentence above doesn't already say it (a marked
 * drop). `inView` (a narrower view: buyers, a segment, a device, a date
 * range): "5 opened it in this view" — never read as the whole deal's count.
 */
export function reachCountsLine(input: {
  openedTotal: number;
  openedBy: number;
  reach: ReadonlyArray<Pick<ReachPoint, "buyers" | "label">>;
  pages: ReadonlyArray<Pick<DocumentPage, "reachRecorded">>;
  oldTracking: boolean;
  inView?: boolean;
}): string {
  const parts = [`${input.openedTotal} opened it${input.inView ? " in this view" : ""}`];
  if (input.openedBy !== input.openedTotal) parts.push(`${input.openedBy} with reading recorded`);
  const recorded = recordedReach(input.reach, input.pages);
  const last = recorded[recorded.length - 1];
  if (last && steepestDrop(recorded)) parts.push(`${last.buyers} got to page ${last.label}${input.oldTracking ? ", the last page recorded" : ""}`);
  return parts.join(" · ");
}

// ── Compare buyers (heat-map spec §3.7) ──────────────────────────────────

/** The groups side B can be. */
export type CompareGroup = "all-others" | "interested" | "passed" | "undecided";
export const COMPARE_GROUPS: readonly CompareGroup[] = ["interested", "all-others", "passed", "undecided"];
const GROUP_LABEL: Record<CompareGroup, string> = {
  interested: "Interested buyers",
  "all-others": "Everyone else",
  passed: "Buyers who passed",
  undecided: "Undecided buyers",
};
/** The filter parser's cap on buyer ids per query (shared/analytics-v2.ts parseEngagementFilters). */
export const COMPARE_GROUP_MAX = 200;

export interface CompareState {
  /** Side A: one buyer link. */
  a: string;
  /** Side B: a group, or another buyer link. */
  b: CompareGroup | string;
}

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isGroup = (v: string): v is CompareGroup => (COMPARE_GROUPS as readonly string[]).includes(v);

/** "?compare=<accessIdA>~<all-others|interested|passed|undecided|accessId>" → state; null for anything else. */
export function parseCompareParam(v: string | null | undefined): CompareState | null {
  const m = /^([A-Za-z0-9_-]{1,64})~([A-Za-z0-9_-]{1,64})$/.exec(String(v ?? ""));
  if (!m || m[1] === m[2]) return null;
  return { a: m[1], b: m[2] };
}
export function compareParam(s: CompareState): string {
  return `${s.a}~${s.b}`;
}

/** A buyer as compare sees it (from the Buyers list: call order, decision, reading). */
export interface CompareBuyer {
  accessId: string;
  name: string;
  decision: string | null;
  rank: number;
  activeMs: number;
  visits: number;
}

const hasReading = (b: CompareBuyer) => b.visits > 0 && b.activeMs >= READING_RULES.readerMinMs;
const decided = (d: string | null) => d === "interested" || d === "not_interested";

/** Buyers who can be side A: every buyer with reading, in call-list order. */
export function compareReaders(buyers: readonly CompareBuyer[]): CompareBuyer[] {
  return buyers.filter(hasReading).sort((x, y) => x.rank - y.rank || x.name.localeCompare(y.name));
}

export interface CompareGroupOption {
  key: CompareGroup;
  label: string;
  ids: string[];
  /** Why it can't be picked (shown in the menu), or null. */
  disabled: string | null;
}

/** Side B's groups for this A: A is never in them; empty or over-large groups are disabled. The outer segment filter is ignored. */
export function compareGroups(buyers: readonly CompareBuyer[], a: string): CompareGroupOption[] {
  const others = compareReaders(buyers).filter((b) => b.accessId !== a);
  const pick: Record<CompareGroup, (b: CompareBuyer) => boolean> = {
    interested: (b) => b.decision === "interested",
    "all-others": () => true,
    passed: (b) => b.decision === "not_interested",
    undecided: (b) => !decided(b.decision),
  };
  return COMPARE_GROUPS.map((key) => {
    const ids = others.filter(pick[key]).map((b) => b.accessId);
    const disabled = ids.length === 0 ? "nobody yet" : ids.length > COMPARE_GROUP_MAX ? `over ${COMPARE_GROUP_MAX} buyers, pick a smaller group` : null;
    return { key, label: GROUP_LABEL[key], ids, disabled };
  });
}

/** Default side B: the interested buyers when A hasn't decided and another interested buyer read it, else everyone else. */
export function defaultCompareB(buyers: readonly CompareBuyer[], a: string): CompareGroup {
  const me = buyers.find((b) => b.accessId === a);
  const interested = compareGroups(buyers, a).find((g) => g.key === "interested")!;
  return me && !decided(me.decision) && interested.ids.length > 0 ? "interested" : "all-others";
}

/** The ids and words for side B ("Interested buyers", or one buyer's name). */
export function compareSideB(buyers: readonly CompareBuyer[], s: CompareState): { ids: string[]; label: string; group: boolean } {
  if (isGroup(s.b)) {
    const g = compareGroups(buyers, s.a).find((x) => x.key === s.b)!;
    return { ids: g.disabled ? [] : g.ids, label: g.label, group: true };
  }
  const one = buyers.find((b) => b.accessId === s.b);
  return { ids: one ? [one.accessId] : [], label: one?.name ?? "That buyer", group: false };
}

/** A valid state for these buyers (unknown ids are dropped), or null. */
export function validCompare(buyers: readonly CompareBuyer[], s: CompareState | null): CompareState | null {
  if (!s) return null;
  const readers = compareReaders(buyers);
  if (!readers.some((b) => b.accessId === s.a)) return null;
  if (isGroup(s.b)) return s;
  return ID_RE.test(s.b) && s.b !== s.a && readers.some((b) => b.accessId === s.b) ? s : { a: s.a, b: defaultCompareB(buyers, s.a) };
}

/** How to start comparing: the one filtered buyer (or the first to call) against the default group. */
export function compareStart(buyers: readonly CompareBuyer[], filteredTo: string | null): CompareState | null {
  const readers = compareReaders(buyers);
  if (readers.length < 2) return null;
  const a = (filteredTo && readers.find((b) => b.accessId === filteredTo)?.accessId) || readers[0].accessId;
  return { a, b: defaultCompareB(buyers, a) };
}

export type CompareAction =
  | { type: "start"; state: CompareState }
  | { type: "setA"; a: string; buyers: readonly CompareBuyer[] }
  | { type: "setB"; b: CompareGroup | string }
  | { type: "done" }
  /** A page turn, an arrow key, a swipe or a filter change: compare stays open. */
  | { type: "page" }
  | { type: "filters" };

export function compareReducer(state: CompareState | null, action: CompareAction): CompareState | null {
  switch (action.type) {
    case "start": return action.state;
    case "done": return null;
    case "setA": {
      if (!state) return null;
      // B stays unless it is now A (then the default group for the new A).
      const b = state.b === action.a ? defaultCompareB(action.buyers, action.a) : state.b;
      return { a: action.a, b };
    }
    case "setB": return state && action.b !== state.a ? { ...state, b: action.b } : state;
    default: return state;
  }
}

/** A side's page as an average per reader (side B: divided by its readers of the page). */
export function perBuyerPage<T extends Pick<DocumentPage, "attentionMs" | "skimMs" | "blocks">>(page: T, divisor: number): T {
  if (!(divisor > 1)) return page;
  const d = (x: number) => Math.round(x / divisor);
  return {
    ...page,
    attentionMs: d(page.attentionMs),
    skimMs: d(page.skimMs),
    blocks: page.blocks.map((b) => ({ ...b, attentionMs: d(b.attentionMs), skimMs: d(b.skimMs), visibleMs: d(b.visibleMs), pointerMs: d(b.pointerMs) })),
  };
}

/** One shared scale for both sides: the busiest part on either side, on this page or across the whole CIM. */
export function sharedMaxMs(
  a: { pages: ReadonlyArray<Pick<DocumentPage, "blocks">>; current: Pick<DocumentPage, "blocks"> | null },
  b: { pages: ReadonlyArray<Pick<DocumentPage, "blocks">>; current: Pick<DocumentPage, "blocks"> | null },
  scope: HeatScope,
): number {
  const ref = a.current ?? b.current;
  const s = effectiveScope(scope, ref);
  return Math.max(heatMaxMs(a.pages, s, a.current ?? ref), heatMaxMs(b.pages, s, b.current ?? ref));
}

/** "Lillian Cho" → "Lillian" (for "Compare Lillian with others"). */
export function firstName(name: string): string {
  const w = name.trim().split(/\s+/)[0] ?? "";
  return w || name;
}
