/**
 * cim-blocks — the parts of a CIM page that reading time is measured on.
 *
 * One registry, pure, used by:
 *   - the CIM renderers (client/src/components/cim/**), which put
 *     `data-cim-block="<key>"` on exactly these parts (the DOM consistency
 *     test, tests/unit/cim-blocks-dom.test.ts, holds them to it);
 *   - the view room's reading tracker, which credits time to the keys it
 *     finds in the DOM;
 *   - the server, which validates the keys a buyer sends, labels them for
 *     the broker ("Row: Adjusted EBITDA") and stores each served CIM's page
 *     index (cim_renditions.page_index);
 *   - the broker's heat-map viewer, which pages the CIM and ranks the parts.
 *
 * BLOCK KEYS are structural and NEVER contain text from the CIM:
 *   kind[:index] segments joined by "/", at most 3 segments, ≤ 40 chars,
 *   e.g. "heading", "row:3", "metric:0", "left/para:2", "chart/point:4".
 * A blind buyer's browser therefore sends nothing that identifies the
 * business: page ids are section UUIDs (already served) and block keys are
 * positions. Labels (which DO quote the CIM) are computed server-side, for
 * the broker only, from the sections that buyer was actually served.
 *
 * Keys per layout (every section also has "heading" unless noted):
 *   BlockTitle            caption, intro
 *   metric_grid           metric:i
 *   stat_callout          primary, stat:i, desc
 *   icon_stat_row         item:i   (kind metric)
 *   callout_list          item:i   (kind highlight)
 *   numbered_list         item:i   (kind list)
 *   timeline              event:i
 *   scorecard             row:i
 *   financial_table       head, row:i (Normalized view: nrow:i), foot
 *   comparison_table      head, row:i
 *   bar/hbar/line/pie/donut/waterfall   chart (+ virtual chart/point:i, reported on hover)
 *   prose_highlight       para:i, quote, highlight:i
 *   two_column            left, right (containers) + their parts under
 *                         "left/…" / "right/…"; broker prose above the columns: para:i
 *   tag_cloud             tags
 *   org_chart             node:i, foot
 *   location_card         loc:i, foot
 *   image_gallery         gallery
 *   video                 video:i
 *   location_map          map
 *   cover_page / divider  page     (no heading)
 *   locked stub           locked
 *   collapsed summary     summary  (ExpandableSection, while collapsed)
 *   empty structured data with prose content → para:i (ProseFallback)
 */
import {
  LOCKED_LAYOUT_TYPE,
  isParagraphTitle,
  resolveTwoColumnColumn,
  getCimLayout,
  type CimLayoutKey,
  type TwoColumnColumn,
} from "./cim-layouts";
import { parseProseBlocks, proseBlockText } from "./cim-prose";
import { financialLabelHeader, normalizeFinancialTable } from "./financial-table";
import { comparisonTableView } from "./cim-chart-values";
import { normalizeGallery, normalizeLocationMap, normalizeVideo } from "./cim-media";

// ── Keys ─────────────────────────────────────────────────────────────────

/** A valid block key (see file header). The empty string means "the page itself, outside any block". */
export const BLOCK_KEY_RE = /^[a-z_]+(:\d{1,3})?(\/[a-z_]+(:\d{1,3})?){0,2}$/;
export const BLOCK_KEY_MAX = 40;
/** Rollups for time on a page that fell outside every block. */
export const PAGE_REMAINDER_KEY = "";

export function isValidBlockKey(key: unknown): key is string {
  return typeof key === "string" && (key === PAGE_REMAINDER_KEY || (key.length <= BLOCK_KEY_MAX && BLOCK_KEY_RE.test(key)));
}

/** "left" + "row:3" → "left/row:3"; "" + "row:3" → "row:3". */
export function joinBlockKey(prefix: string, key: string): string {
  return prefix ? (key ? `${prefix}/${key}` : prefix) : key;
}

/** The hovered datum of a chart block: "chart" → "chart/point:4". */
export function chartPointKey(chartKey: string, index: number): string {
  return `${chartKey}/point:${Math.max(0, Math.min(999, Math.floor(index)))}`;
}

/** The first segment ("left/row:3" → "left"): what pagination and "parts of this page" group by. */
export function topSegment(key: string): string {
  const i = key.indexOf("/");
  return i === -1 ? key : key.slice(0, i);
}

/** "left/chart/point:2" → "left/chart"; null when the key is not a chart point. */
export function chartOfPoint(key: string): string | null {
  const m = /^(.*)\/point:\d{1,3}$/.exec(key);
  return m ? m[1] : null;
}

// ── Kinds ────────────────────────────────────────────────────────────────

export const BLOCK_KINDS = [
  "heading",   // section heading, block caption
  "text",      // paragraphs, intros, descriptions
  "quote",     // pull quote
  "highlight", // highlight cards / callouts
  "metric",    // metric cards, stat figures
  "table",     // table header, rows, footnotes
  "chart",     // a whole chart
  "point",     // one chart datum (virtual: hover only)
  "list",      // list items, tags
  "timeline",  // timeline events
  "org",       // org-chart people
  "location",  // location cards, map
  "media",     // photos, video
  "column",    // a two-column side (container)
  "page",      // a page drawn as one piece (cover, divider, disclaimer, contact)
  "locked",    // a locked teaser stub
  "summary",   // a collapsed section's summary
] as const;
export type BlockKind = (typeof BLOCK_KINDS)[number];

/** The groups "What holds attention" compares. */
export const KIND_GROUPS = [
  { key: "tables", label: "Tables" },
  { key: "text", label: "Text" },
  { key: "charts", label: "Charts" },
  { key: "highlights", label: "Highlight cards" },
  { key: "metrics", label: "Key figures" },
  { key: "lists", label: "Lists" },
  { key: "media", label: "Photos, video & maps" },
  { key: "other", label: "Other" },
] as const;
export type KindGroup = (typeof KIND_GROUPS)[number]["key"];

const GROUP_OF: Record<BlockKind, KindGroup> = {
  heading: "other", text: "text", quote: "text", highlight: "highlights", metric: "metrics",
  table: "tables", chart: "charts", point: "charts", list: "lists", timeline: "lists", org: "lists",
  location: "media", media: "media", column: "other", page: "other", locked: "other", summary: "other",
};
export function kindGroupOf(kind: BlockKind): KindGroup {
  return GROUP_OF[kind] ?? "other";
}

// ── Blocks ───────────────────────────────────────────────────────────────

export interface CimBlock {
  key: string;
  kind: BlockKind;
  /** Broker-facing words ("Row: Adjusted EBITDA"). May quote the CIM — never sent by or to buyers. */
  label: string;
  /** Expected reading time for an attentive reader (see READING_MODEL). */
  expectedMs: number;
  /** Rough height on the paper sheet, px — pagination only. */
  height: number;
  /** Which printed part of the section it falls on ("7a" = 0, "7b" = 1). */
  part: number;
  /** Only reported on pointer hover (chart points); has no element of its own. */
  virtual?: true;
  /** Only in the DOM in another view of the section: "normalized" (Normalized table), "collapsed" (summary). */
  when?: "normalized" | "collapsed";
}

/** The section fields the registry reads (a CimSection, a served BuyerSection, a stored rendition section). */
export interface CimBlockSource {
  id?: string;
  layoutType: string;
  layoutData?: unknown;
  sectionTitle?: string | null;
  aiDraftContent?: string | null;
  brokerEditedContent?: string | null;
  locked?: boolean;
}

/**
 * Reading-time model (ms). Deliberately simple and marked for tuning with
 * the capture proof and the first real buyers — the intelligence stream
 * owns the numbers, not the shape.
 */
export const READING_MODEL = {
  msPerWord: 250,          // 240 wpm
  heading: 500,
  metric: 2500,
  highlightMin: 4000,
  listItemBase: 1000,
  tableRowBase: 1000,
  tableNumericCell: 400,
  chartBase: 6000,
  chartPoint: 500,
  image: 3000,
  map: 5000,
  video: 30000,
  orgNode: 2000,
  location: 5000,
  tag: 300,
  cover: 5000,
  locked: 1000,
  quoteExtra: 1000,
} as const;

const PAGE_HEIGHT = 1056;       // US Letter at 96 dpi
const SPLIT_OVER = PAGE_HEIGHT * 1.5;

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const words = (t: string): number => (t.trim() ? t.trim().split(/\s+/).length : 0);
const readMs = (t: string): number => words(t) * READING_MODEL.msPerWord;
const lines = (t: string, perLine = 14): number => Math.max(1, Math.ceil(words(t) / perLine));
const numericCells = (cells: Array<string | null>): number => cells.filter((c) => c != null && /\d/.test(c)).length;
/** A short quote of text for a label: the first few words. */
export function quoteStart(text: string, n = 6): string {
  const w = text.replace(/\s+/g, " ").trim().split(" ");
  return w.length <= n ? w.join(" ") : `${w.slice(0, n).join(" ")}…`;
}

type Raw = Omit<CimBlock, "part">;

function b(key: string, kind: BlockKind, label: string, expectedMs: number, height: number, extra: Partial<Raw> = {}): Raw {
  return { key, kind, label, expectedMs: Math.round(expectedMs), height: Math.round(height), ...extra };
}

/** Caption + intro drawn by BlockTitle (renderers/BlockTitle.tsx). */
function titleBlocks(title: unknown, intro: unknown): Raw[] {
  const t = typeof title === "string" ? title.trim() : "";
  const i = typeof intro === "string" ? intro.trim() : "";
  const paragraph = !!t && isParagraphTitle(t);
  const out: Raw[] = [];
  if (t && !paragraph) out.push(b("caption", "heading", `Caption: ${quoteStart(t, 8)}`, READING_MODEL.heading, 28));
  if (paragraph || i) {
    const text = [paragraph ? t : "", i].filter(Boolean).join(" ");
    out.push(b("intro", "text", `Introduction: "${quoteStart(text)}"`, readMs(text), lines(text) * 22 + 12));
  }
  return out;
}

/** Paragraph blocks of prose (renderProse / ProseFallback). */
function proseBlocks(text: string, perLine = 14): Raw[] {
  return parseProseBlocks(text).map((blk, i) => {
    const t = proseBlockText(blk);
    const label = blk.kind === "p" ? `Paragraph ${i + 1}: "${quoteStart(t)}"`
      : blk.kind === "h" ? `Subheading: ${quoteStart(t, 8)}`
      : `List: "${quoteStart(t)}"`;
    const list = blk.kind === "ul" || blk.kind === "ol";
    const ms = list ? readMs(t) + blk.items.length * READING_MODEL.listItemBase : blk.kind === "h" ? READING_MODEL.heading : readMs(t);
    const h = list ? blk.items.reduce((s, it) => s + lines(it, perLine) * 24 + 6, 0) : lines(t, perLine) * 26 + 12;
    return b(`para:${i}`, blk.kind === "h" ? "heading" : list ? "list" : "text", label, ms, h);
  });
}

function chartBlocks(title: unknown, intro: unknown, pointNames: string[], chartHeight: number, fallbackName: string): Raw[] {
  const name = str(title).trim() || fallbackName;
  return [
    ...titleBlocks(title, intro),
    b("chart", "chart", `Chart: ${quoteStart(name, 8)}`, READING_MODEL.chartBase + pointNames.length * READING_MODEL.chartPoint, chartHeight),
    ...pointNames.map((p, i) => b(`chart/point:${i}`, "point", `${quoteStart(p || `Point ${i + 1}`, 6)}`, 0, 0, { virtual: true as const })),
  ];
}

interface LayoutCtx {
  section: CimBlockSource;
  content: string;
}

/** Blocks for one layout's data. Exhaustive over the layout registry: a new layout without a spec does not compile. */
const BLOCK_SPEC: Record<CimLayoutKey, (L: AnyRecord, ctx: LayoutCtx) => Raw[]> = {
  cover_page: () => [b("page", "page", "Cover page", READING_MODEL.cover, PAGE_HEIGHT * 0.85)],
  divider: (L) => [b("page", "page", str(L.label) ? `Divider: ${quoteStart(str(L.label), 6)}` : "Divider", READING_MODEL.heading, 40)],

  metric_grid: (L, ctx) => {
    const metrics = Array.isArray(L.metrics) ? L.metrics : [];
    if (metrics.length === 0) return fallback(ctx);
    const cols = Number(L.columns) || 3;
    return [
      ...titleBlocks(L.title, L.intro),
      ...metrics.map((m, i) => {
        const r = isRecord(m) ? m : {};
        return b(`metric:${i}`, "metric", `Card: ${quoteStart(`${str(r.label)} ${str(r.value)}`.trim(), 8)}`, READING_MODEL.metric, 120 / cols);
      }),
    ];
  },

  stat_callout: (L, ctx) => {
    if (!str(L.primaryValue)) return fallback(ctx);
    const stats = Array.isArray(L.secondaryStats) ? L.secondaryStats : [];
    const out: Raw[] = [b("primary", "metric", `Headline figure: ${quoteStart(`${str(L.primaryValue)} ${str(L.primaryLabel)}`.trim(), 8)}`, READING_MODEL.metric, 150)];
    stats.forEach((s, i) => {
      const r = isRecord(s) ? s : {};
      out.push(b(`stat:${i}`, "metric", `Figure: ${quoteStart(`${str(r.label)} ${str(r.value)}`.trim(), 8)}`, READING_MODEL.metric, 70 / Math.max(1, stats.length)));
    });
    if (str(L.description)) out.push(b("desc", "text", `Description: "${quoteStart(str(L.description))}"`, readMs(str(L.description)), lines(str(L.description), 12) * 22 + 20));
    return out;
  },

  icon_stat_row: (L, ctx) => calloutBlocks(L, ctx, "metric"),
  callout_list: (L, ctx) => calloutBlocks(L, ctx, "highlight"),

  scorecard: (L, ctx) => {
    const items = (Array.isArray(L.items) ? L.items : []).filter((it) => it && typeof it === "object") as AnyRecord[];
    if (items.length === 0) return fallback(ctx);
    return [
      ...titleBlocks(L.title, L.intro),
      ...items.map((it, i) => b(`row:${i}`, "table", `Row: ${quoteStart(str(it.label), 8)}`,
        READING_MODEL.tableRowBase + READING_MODEL.tableNumericCell * 2 + readMs(str(it.description)), 56)),
    ];
  },

  bar_chart: (L, ctx) => {
    const data = Array.isArray(L.data) ? L.data : [];
    if (data.length === 0) return fallback(ctx);
    return chartBlocks(L.title, L.intro, data.map((d) => str(isRecord(d) ? d.name : "")), 300, ctx.section.sectionTitle || "Bar chart");
  },
  horizontal_bar_chart: (L, ctx) => {
    const data = Array.isArray(L.data) ? L.data : [];
    if (data.length === 0) return fallback(ctx);
    return chartBlocks(L.title, L.intro, data.map((d) => str(isRecord(d) ? d.name : "")), Math.max(200, data.length * 44 + 40), ctx.section.sectionTitle || "Bar chart");
  },
  line_chart: (L, ctx) => {
    const data = Array.isArray(L.data) ? L.data : [];
    const series = Array.isArray(L.series) ? L.series : [];
    if (data.length === 0 || series.length === 0) return fallback(ctx);
    return chartBlocks(L.title, L.intro, data.map((d) => str(isRecord(d) ? d.name : "")), 300, ctx.section.sectionTitle || "Line chart");
  },
  pie_chart: (L, ctx) => pieBlocks(L, ctx),
  donut_chart: (L, ctx) => pieBlocks(L, ctx),
  waterfall_chart: (L, ctx) => {
    const items = Array.isArray(L.items) ? L.items : [];
    if (items.length === 0) return fallback(ctx);
    return chartBlocks(L.title, L.intro, items.map((d) => str(isRecord(d) ? d.label : "")), Math.max(280, items.length * 32) + 60, ctx.section.sectionTitle || "Earnings bridge");
  },

  financial_table: (L, ctx) => {
    const table = normalizeFinancialTable(L as { headers?: unknown; rows?: unknown });
    if (table.rows.length === 0) return fallback(ctx);
    const labelHeader = financialLabelHeader(table.labelHeader, L.currency);
    const showHeader = table.columns.some((c) => c) || !!labelHeader;
    const out: Raw[] = [...titleBlocks(L.caption, L.intro)];
    if (showHeader) out.push(b("head", "table", "Table header", READING_MODEL.tableRowBase, 40));
    const rowBlocks = (rows: typeof table.rows, kind: "row" | "nrow", when?: "normalized") =>
      rows.map((r, i) => b(`${kind}:${i}`, "table",
        `${r.isSectionHeader ? "Heading row" : "Row"}: ${quoteStart(r.label, 8)}${kind === "nrow" ? " (normalized)" : ""}`,
        r.isSectionHeader ? READING_MODEL.heading : READING_MODEL.tableRowBase + READING_MODEL.tableNumericCell * numericCells(r.cells),
        r.isSectionHeader ? 34 : 40, when ? { when } : {}));
    out.push(...rowBlocks(table.rows, "row"));
    const footnotes = Array.isArray(L.footnotes) ? L.footnotes.filter((f) => str(f).trim()) : [];
    if (footnotes.length > 0) out.push(b("foot", "table", "Footnotes", readMs(footnotes.map(str).join(" ")), footnotes.length * 20 + 12));
    // The Normalized view (FinancialToggle) — its own rows, and always a footnote.
    const normalized = Array.isArray(L.normalizedRows) ? L.normalizedRows : [];
    if (normalized.length > 0) {
      const nt = normalizeFinancialTable({ headers: L.headers, rows: normalized });
      out.push(...rowBlocks(nt.rows, "nrow", "normalized"));
      if (footnotes.length === 0) out.push(b("foot", "table", "Footnotes", READING_MODEL.heading * 2, 32, { when: "normalized" }));
    }
    return out;
  },

  comparison_table: (L, ctx) => {
    const rows = Array.isArray(L.rows) ? L.rows : [];
    if (rows.length === 0) return fallback(ctx);
    const view = comparisonTableView(L);
    return [
      ...titleBlocks(L.title, L.intro),
      b("head", "table", "Table header", READING_MODEL.tableRowBase, 40),
      ...view.rows.map((r, i) => b(`row:${i}`, "table", `Row: ${quoteStart(r.label, 8)}`,
        READING_MODEL.tableRowBase + READING_MODEL.tableNumericCell * numericCells(r.cells) + readMs(r.note ?? ""), 40)),
    ];
  },

  prose_highlight: (L, ctx) => {
    const body = ctx.section.brokerEditedContent || str(L.body) || ctx.content || "";
    const highlights = Array.isArray(L.highlights) ? L.highlights : [];
    const hasRight = !!(L.pullQuote || highlights.length > 0);
    if (!body && !hasRight) return [];
    const out = body ? proseBlocks(body, hasRight ? 9 : 14) : [];
    if (L.pullQuote) out.push(b("quote", "quote", `Pull quote: "${quoteStart(str(L.pullQuote))}"`, readMs(str(L.pullQuote)) + READING_MODEL.quoteExtra, 0));
    highlights.forEach((h, i) => out.push(b(`highlight:${i}`, "highlight", `Highlight: "${quoteStart(str(h))}"`, Math.max(READING_MODEL.highlightMin, readMs(str(h))), 0)));
    return out;
  },

  two_column: (L, ctx) => {
    if (!L.left && !L.right) return fallback(ctx);
    let left = resolveTwoColumnColumn(L.left);
    let right = resolveTwoColumnColumn(L.right);
    const edited = ctx.section.brokerEditedContent || "";
    const proseIdx = edited ? proseColumnIndex(L) : -1;
    if (edited && proseIdx === 0) left = { ...(left ?? { layoutType: "prose" }), layoutType: "prose", content: edited };
    if (edited && proseIdx === 1) right = { ...(right ?? { layoutType: "prose" }), layoutType: "prose", content: edited };
    const editedAbove = !!edited && proseIdx === -1;
    const sides = ([["left", left], ["right", right]] as const).filter((s): s is readonly ["left" | "right", TwoColumnColumn] => !!s[1]);
    if (sides.length === 0 && !editedAbove) return fallback(ctx);
    const out: Raw[] = [...titleBlocks(L.title, L.intro)];
    if (editedAbove) out.push(...proseBlocks(edited));
    const inners = sides.map(([, col]) => columnBlocks(col, ctx, sides.length === 2));
    const heights = sides.map(([, col], i) => inners[i].reduce((s, x) => s + x.height, 0) + (col.title ? 24 : 0));
    sides.forEach(([side, col], i) => {
      const title = col.title ? `: ${quoteStart(col.title, 6)}` : "";
      // Side by side: the pair is as tall as the taller column, and the
      // second never starts a printed part of its own.
      const height = sides.length === 2 ? (i === 0 ? Math.max(...heights) : 0) : heights[i];
      out.push(b(side, "column", `${side === "left" ? "Left" : "Right"} column${title}`, 0, height));
      out.push(...inners[i].map((x) => ({ ...x, key: joinBlockKey(side, x.key), label: `${side === "left" ? "Left" : "Right"} · ${x.label}` })));
    });
    return out;
  },

  numbered_list: (L, ctx) => {
    const items = Array.isArray(L.items) ? L.items : [];
    if (items.length === 0) return fallback(ctx);
    return [
      ...titleBlocks(L.title, L.intro),
      ...items.map((it, i) => {
        const r = isRecord(it) ? it : {};
        const t = `${str(r.title)} ${str(r.description)}`.trim();
        return b(`item:${i}`, "list", `Item ${i + 1}: ${quoteStart(str(r.title), 8)}`, readMs(t) + READING_MODEL.listItemBase, lines(t, 12) * 22 + 20);
      }),
    ];
  },

  timeline: (L, ctx) => {
    const events = Array.isArray(L.events) ? L.events : [];
    if (events.length === 0) return fallback(ctx);
    return [
      ...titleBlocks(L.title, L.intro),
      ...events.map((e, i) => {
        const r = isRecord(e) ? e : {};
        const when = str(r.date) || str(r.year);
        const t = `${str(r.title)} ${str(r.description)}`.trim();
        return b(`event:${i}`, "timeline", `Milestone: ${quoteStart(`${when ? `${when} ` : ""}${str(r.title)}`, 8)}`, readMs(t) + READING_MODEL.listItemBase, lines(t, 10) * 22 + 34);
      }),
    ];
  },

  tag_cloud: (L, ctx) => {
    const tags = (Array.isArray(L.tags) ? L.tags : []).filter((t) => isRecord(t) && typeof t.label === "string" && t.label.trim());
    // TagCloud draws ProseFallback when there are no tags (nothing when there is no prose either).
    if (tags.length === 0) return fallback(ctx);
    return [b("tags", "list", `Tags (${tags.length})`, tags.length * READING_MODEL.tag, 40 + Math.ceil(tags.length / 5) * 36)];
  },

  org_chart: (L, ctx) => {
    const nodes = (Array.isArray(L.nodes) ? L.nodes : []).filter((n) => n && typeof n === "object") as AnyRecord[];
    if (nodes.length === 0) return fallback(ctx);
    const seen = new Set<string>();
    const out: Raw[] = [...titleBlocks(L.title, L.intro)];
    nodes.forEach((n, i) => {
      const id = n.id != null && String(n.id) ? String(n.id) : `__${i}`;
      if (seen.has(id)) return;          // buildOrgTree draws the first node with an id only
      seen.add(id);
      out.push(b(`node:${i}`, "org", `Person: ${quoteStart(str(n.role) || str(n.name), 6)}`, READING_MODEL.orgNode, 30));
    });
    if (L.totalHeadcount != null || str(L.ownerDependency)) out.push(b("foot", "text", "Headcount & owner dependency", READING_MODEL.metric + readMs(str(L.ownerDependency)), 60));
    return out;
  },

  location_card: (L, ctx) => {
    const locations = Array.isArray(L.locations) ? L.locations : [];
    if (locations.length === 0) return fallback(ctx);
    const out: Raw[] = [...titleBlocks(L.title, L.intro)];
    locations.forEach((loc, i) => {
      const r = isRecord(loc) ? loc : {};
      const t = [r.leaseTerms, r.notes, r.renewalOptions].map(str).join(" ");
      out.push(b(`loc:${i}`, "location", `Location: ${quoteStart(str(r.label) || str(r.address) || `${i + 1}`, 6)}`,
        READING_MODEL.location + readMs(t), 280 / Math.min(3, Math.max(1, locations.length))));
    });
    if (L.totalSqft != null) out.push(b("foot", "metric", "Total space", READING_MODEL.metric, 40));
    return out;
  },

  image_gallery: (L) => {
    const g = normalizeGallery(L);
    if (g.images.length === 0) return [];
    return [...titleBlocks(g.title, undefined), b("gallery", "media", `Photos (${g.images.length})`, g.images.length * READING_MODEL.image, 380)];
  },

  video: (L) => {
    const v = normalizeVideo(L);
    if (v.items.length === 0) return [];
    return [
      ...titleBlocks(v.title, undefined),
      ...v.items.map((it, i) => b(`video:${i}`, "media", `Video: ${quoteStart(it.title || it.caption || `${i + 1}`, 6)}`, READING_MODEL.video, 400 / (v.items.length > 1 ? 2 : 1))),
    ];
  },

  location_map: (L) => {
    const regionOnly = L.regionOnly === true;
    const rows = (Array.isArray(L.locations) ? L.locations : []).filter(isRecord)
      .filter((l) => (regionOnly ? !!str(l.region).trim() : !!str(l.address).trim()));
    if (rows.length === 0) return [];
    const m = normalizeLocationMap(L);
    return [...titleBlocks(m.title, undefined), b("map", "location", regionOnly ? "Map (general area)" : "Map", READING_MODEL.map, 380)];
  },

  // "Where each add-back is in the books" (due diligence, shared/gl-evidence.ts;
  // GlEvidenceBlock): an intro, whether the ledger agrees with the statements,
  // then one block per add-back (item:i, in the payload's order). Keys come
  // from the order of the lines, never from values.
  gl_evidence: (L) => {
    const lines = (Array.isArray(L.lines) ? L.lines : []).filter(isRecord);
    if (lines.length === 0) return [];
    return [
      b("intro", "text", "Introduction", readMs("Each add-back below is matched to entries in the company's general ledger. This shows where each cost is recorded. It was matched by the owner and reviewed by the broker; it is not an audit or a quality-of-earnings review."), 88),
      b("summary", "text", "Does the ledger match the statements?", READING_MODEL.heading * 4, 60),
      ...lines.map((l, i) => {
        const years = Array.isArray(l.years) ? l.years.filter(isRecord) : [];
        const entries = years.reduce((n: number, y) => n + Math.min(12, Array.isArray(y.entries) ? y.entries.length : 0), 0);
        return b(`item:${i}`, "table", `Add-back: ${quoteStart(str(l.label) || "an add-back", 6)}`, READING_MODEL.tableRowBase * (2 + entries) + READING_MODEL.heading, 120 + entries * 26);
      }),
    ];
  },
};

function fallback(ctx: LayoutCtx): Raw[] {
  return ctx.content ? proseBlocks(ctx.content) : [];
}

function calloutBlocks(L: AnyRecord, ctx: LayoutCtx, kind: "metric" | "highlight"): Raw[] {
  // Mirrors CalloutListRenderer: `items`, else `stats` rows with a label or a value.
  const rawStats = Array.isArray(L.stats) ? L.stats : [];
  const stats = rawStats.filter((s) => isRecord(s) && (s.label || s.value != null)) as AnyRecord[];
  const items = Array.isArray(L.items) && L.items.length > 0 ? (L.items as unknown[]) : stats;
  if (items.length === 0) return fallback(ctx);
  const cols = kind === "metric" ? Math.min(items.length, 4) : Number(L.columns) || (items.length > 4 ? 2 : 1);
  return [
    ...titleBlocks(L.title, L.intro),
    ...items.map((it, i) => {
      const r = isRecord(it) ? it : {};
      // `stats` rows: the figure then what it counts ("71 Power units").
      const fromStats = !(Array.isArray(L.items) && L.items.length > 0);
      const title = fromStats
        ? [str(r.value), str(r.unit), str(r.label)].filter(Boolean).join(" ")
        : str(r.title);
      const t = `${title} ${str(r.description)}`.trim();
      const ms = kind === "metric" ? READING_MODEL.metric + readMs(str(r.description)) : Math.max(READING_MODEL.highlightMin, readMs(t));
      return b(`item:${i}`, kind, `${kind === "metric" ? "Figure" : "Card"}: ${quoteStart(title, 8)}`, ms, (lines(t, 10) * 22 + 36) / cols);
    }),
  ];
}

function pieBlocks(L: AnyRecord, ctx: LayoutCtx): Raw[] {
  const data = Array.isArray(L.data) ? L.data : [];
  if (data.length === 0) return fallback(ctx);
  return chartBlocks(L.title, L.intro, data.map((d) => str(isRecord(d) ? d.name : "")), Math.max(220, data.length * 28), ctx.section.sectionTitle || "Pie chart");
}

/** editableText.findProseColumnIndex (mirrored: shared code can't import the client). */
function proseColumnIndex(L: AnyRecord): number {
  const cols = [L.left, L.right];
  for (let i = 0; i < cols.length; i++) {
    const c = cols[i];
    if (!isRecord(c) || typeof c.content !== "string") continue;
    if ((str(c.layoutType) || "prose") === "prose") return i;
  }
  return -1;
}

/** The sub-renderers a two-column column can draw (TwoColumn.tsx SUB_RENDERERS). */
const COLUMN_SUB_LAYOUTS = new Set([
  "bar_chart", "horizontal_bar_chart", "pie_chart", "donut_chart", "line_chart", "metric_grid", "financial_table",
  "comparison_table", "callout_list", "icon_stat_row", "numbered_list", "stat_callout", "scorecard", "timeline",
]);

function columnBlocks(col: TwoColumnColumn, ctx: LayoutCtx, half: boolean): Raw[] {
  const type = col.layoutType || "prose";
  const content = col.content;
  if (COLUMN_SUB_LAYOUTS.has(type)) {
    const data = isRecord(content) ? content : {};
    const spec = BLOCK_SPEC[type as CimLayoutKey];
    // Sub-renderers get content="" — no prose fallback inside a column.
    return spec(data, { section: { ...ctx.section, layoutType: type, brokerEditedContent: null }, content: "" })
      .map((x) => ({ ...x, height: x.height * (half ? 1.3 : 1) }));
  }
  const text = typeof content === "string" ? content : "";
  if (type === "list") {
    let rows = text.split("\n").map((l) => l.trim()).filter(Boolean);
    if (rows.length === 1 && rows[0].includes("|")) rows = rows[0].split("|").map((l) => l.trim()).filter(Boolean);
    return rows.map((line, i) => b(`item:${i}`, "list", `Item: "${quoteStart(line)}"`, readMs(line) + READING_MODEL.listItemBase, lines(line, 8) * 22 + 6));
  }
  if (type === "metric") {
    return text.split("\n").filter(Boolean).map((line, i) => b(`metric:${i}`, "metric", `Figure: ${quoteStart(line, 8)}`, READING_MODEL.metric, 34));
  }
  return proseBlocks(text, half ? 7 : 14);
}

/** The section heading, as CimSectionRenderer prints it (cover and divider have none). */
const UNTITLED = new Set(["cover_page", "divider"]);

/** Case/punctuation-insensitive heading form (CimSectionRenderer.dropRepeatedCaption). */
export function headingKey(v: unknown): string {
  return typeof v === "string" ? v.toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "") : "";
}

/** The layoutData a renderer receives: a caption repeating the section heading is dropped. */
export function withoutRepeatedCaption<T extends AnyRecord>(layoutData: T, sectionTitle: string | null | undefined): T {
  const key = headingKey(sectionTitle);
  if (!key || !layoutData || typeof layoutData !== "object") return layoutData;
  let out = layoutData;
  for (const field of ["title", "caption"] as const) {
    if (headingKey(out[field]) === key) {
      if (out === layoutData) out = { ...layoutData };
      delete (out as AnyRecord)[field];
    }
  }
  return out;
}

/**
 * Every block of a section in reading order, with the printed part each
 * falls on. Includes virtual chart points and the blocks of other views
 * (`when`); the DOM of the default view carries exactly the others.
 */
export function blocksOf(section: CimBlockSource): CimBlock[] {
  const layoutType = section.layoutType;
  const title = section.sectionTitle || "";
  const content = section.brokerEditedContent || section.aiDraftContent || "";
  const raw: Raw[] = [];
  const locked = section.locked || layoutType === LOCKED_LAYOUT_TYPE;
  const def = getCimLayout(layoutType);
  if (locked) {
    raw.push(b("heading", "heading", `Title: ${quoteStart(title, 8)}`, READING_MODEL.heading, 56));
    raw.push(b("locked", "locked", "Locked page", READING_MODEL.locked, 220));
  } else if (!def) {
    // Unregistered layout: its prose (CimSectionRenderer's ProseFallback), else not shown.
    if (content) {
      raw.push(b("heading", "heading", `Title: ${quoteStart(title, 8)}`, READING_MODEL.heading, 56));
      raw.push(...proseBlocks(content));
    }
  } else {
    const L = withoutRepeatedCaption(isRecord(section.layoutData) ? section.layoutData : {}, UNTITLED.has(layoutType) ? "" : title);
    if (!UNTITLED.has(layoutType)) raw.push(b("heading", "heading", `Title: ${quoteStart(title, 8)}`, READING_MODEL.heading, 56));
    raw.push(...BLOCK_SPEC[def.key as CimLayoutKey](L, { section, content }));
    if (isRecord(section.layoutData) && section.layoutData.expandable) {
      const summary = str(section.layoutData.summary);
      raw.push(b("summary", "summary", "Summary (collapsed view)", Math.max(2000, readMs(summary)), 140, { when: "collapsed" }));
    }
  }
  const parts = paginate(raw);
  return raw.map((x, i) => ({ ...x, part: parts[i] }));
}

/**
 * Printed parts of a long section: a section taller than 1.5 Letter pages is
 * split at top-level block boundaries into parts of about one page ("7a",
 * "7b"). Uses registry heights, never the DOM, so parts are identical on
 * every device. Returns the part index of each block (same order).
 * The heading stays with the first block; a two-column side, a chart's
 * points and a prose section's quote/highlights stay with their part.
 */
export function paginate(blocks: ReadonlyArray<Pick<CimBlock, "key" | "height" | "virtual" | "when">>): number[] {
  const counted = (x: Pick<CimBlock, "key" | "height" | "virtual" | "when">) => !x.virtual && !x.when && !x.key.includes("/");
  const total = blocks.reduce((s, x) => s + (counted(x) ? x.height : 0), 0);
  const out = new Array<number>(blocks.length).fill(0);
  if (total <= SPLIT_OVER) return out;
  const partOfTop = new Map<string, number>();
  let part = 0;
  let used = 0;
  blocks.forEach((x, i) => {
    const top = topSegment(x.key);
    // A prose section's quote and highlights sit beside its first paragraphs.
    if (x.key === "quote" || x.key.startsWith("highlight:")) {
      out[i] = 0;
      return;
    }
    // A collapsed section's summary is where the section starts: its first part.
    if (x.when === "collapsed") {
      out[i] = 0;
      return;
    }
    if (x.key.includes("/") || !counted(x)) {
      // Children, chart points and other-view blocks follow their parent's part
      // (the Normalized rows follow the reported rows' split by index).
      out[i] = partOfTop.get(top) ?? partOfTop.get(x.key.replace(/^nrow:/, "row:")) ?? part;
      return;
    }
    if (x.height > 0 && used > 0 && used + x.height > PAGE_HEIGHT && x.key !== "heading" && i > 1) {
      part += 1;
      used = 0;
    }
    used += x.height;
    out[i] = part;
    partOfTop.set(top, part);
  });
  return out;
}

/** Number of printed parts of a section. */
export function partCount(blocks: ReadonlyArray<Pick<CimBlock, "part">>): number {
  return blocks.reduce((m, x) => Math.max(m, x.part + 1), 1);
}

/** The broker-facing label of a block key ("Row: Adjusted EBITDA"), or a neutral fallback. */
export function blockLabel(section: CimBlockSource, key: string): string {
  if (key === PAGE_REMAINDER_KEY) return "Elsewhere on this page";
  const found = blocksOf(section).find((x) => x.key === key);
  if (found) return found.label;
  const point = chartOfPoint(key);
  if (point) return `Chart point ${Number(key.split(":").pop()) + 1}`;
  return "Part of this page";
}

/**
 * The block structure of a page — its layout plus the ordered keys the
 * buyer's DOM had. Two renditions (blind and named, or before/after an
 * edit) with the same fingerprint have comparable block heat.
 */
export function blockFingerprint(layoutType: string, blocks: ReadonlyArray<Pick<CimBlock, "key">>): string {
  return `${layoutType}|${blocks.map((x) => x.key).join(",")}`;
}

/** Expected reading time of a set of blocks (default view only). */
export function expectedMsOf(blocks: ReadonlyArray<CimBlock>, part?: number): number {
  return blocks.filter((x) => !x.virtual && !x.when && (part === undefined || x.part === part)).reduce((s, x) => s + x.expectedMs, 0);
}

// ── Pages outside the sections ───────────────────────────────────────────

/** Page ids of the brokerage pages (CimFrontBackPages). Sections use their UUID. */
export const DISCLAIMER_PAGE_ID = "cim-disclaimer";
export const CONTACT_PAGE_ID = "cim-contact";

/** Blocks of the disclaimer / contact pages: each is read as one piece. */
export function brokeragePageBlocks(pageId: typeof DISCLAIMER_PAGE_ID | typeof CONTACT_PAGE_ID): CimBlock[] {
  return pageId === DISCLAIMER_PAGE_ID
    ? [{ key: "page", kind: "page", label: "Confidentiality & disclaimer", expectedMs: 20000, height: 700, part: 0 }]
    : [{ key: "page", kind: "page", label: "Contact details", expectedMs: 5000, height: 420, part: 0 }];
}
