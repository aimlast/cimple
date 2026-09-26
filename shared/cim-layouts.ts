/**
 * CIM layout registry — the single source of truth for every CIM layout type.
 *
 * Before this file the list of layout types was copied in five places (server
 * union, AI prompt, renderer switch, Designer dropdown, editableText, chatbot
 * flattener) and they disagreed: a type with no renderer printed raw JSON to
 * buyers. Everything now reads from here:
 *   - server/cim/layout-types.ts   → the LayoutType union
 *   - server/cim/layout-engine.ts  → the AI prompt's layout spec + manifest enum
 *   - CimSectionRenderer           → a renderer map typed against these keys
 *   - the CIM builder              → the layout gallery, blank-section data
 *   - editableText.ts              → which editor a layout gets
 *   - server/qa/cim-context.ts     → presentation-only keys the chatbot skips
 *
 * Adding a layout = add an entry here + a renderer (TypeScript then refuses
 * to compile until CimSectionRenderer has one). Pure — used by server and client.
 */
import { comparisonAsFinancialTable, comparisonPacksSeries } from "./cim-chart-values";

export const CIM_LAYOUT_CATEGORIES = [
  { key: "text", label: "Text" },
  { key: "numbers", label: "Numbers" },
  { key: "charts", label: "Charts" },
  { key: "tables", label: "Tables" },
  { key: "people_places", label: "People & places" },
  { key: "media", label: "Media" },
  { key: "structure", label: "Structure" },
] as const;

export type CimLayoutCategory = (typeof CIM_LAYOUT_CATEGORIES)[number]["key"];

export interface CimLayoutDefaultContext {
  businessName?: string | null;
  industry?: string | null;
  title?: string | null;
  /** The premises' street address, when the deal has one (location map). */
  address?: string | null;
}

export interface CimLayoutDef {
  key: string;
  /** Short broker-facing name ("Key numbers"). */
  label: string;
  /** One line: what this layout is good for. */
  description: string;
  category: CimLayoutCategory;
  /** Where the words live: a prose string (brokerEditedContent) or layoutData. */
  content: "prose" | "structured";
  /** Which editor the builder offers ("media" = the photo/video/map editors). */
  editor: "text" | "data" | "media";
  /**
   * Blind CIM handling.
   *  "redact"  — the AI redaction pass rewrites every identifying string.
   *  "exclude" — never shown in the Blind CIM (e.g. media that pixels could
   *              identify, an exact-address map). The view route drops it.
   */
  blind: "redact" | "exclude";
  /**
   * Layouts in the same family share a layoutData shape, so the broker can
   * switch between them instantly without an AI conversion.
   */
  family: string;
  /** Offered to the AI planner when it designs a whole CIM. */
  planner: boolean;
  /**
   * The AI can write / regenerate / convert into this layout from the deal's
   * facts (default true). False for photos and videos — only the broker can
   * choose those.
   */
  aiWrite?: boolean;
  /** The AI writer may rewrite this layout's content (default true). */
  aiRewrite?: boolean;
  /** The layoutData shape as written into the AI prompt. */
  aiSpec: string;
  /** "Use for: …" guidance (+ any extra rule lines) for the AI prompt. */
  aiUse: string;
  /** Starting layoutData for a blank section of this type. */
  defaultData: (ctx: CimLayoutDefaultContext) => Record<string, unknown>;
  /** Presentation-only keys (URLs, colours…) the Q&A flattener skips. */
  presentationKeys?: string[];
}

const LAYOUTS = [
  // ── Structure ──────────────────────────────────────────────────────────
  {
    key: "cover_page",
    label: "Cover page",
    description: "The first page: business name, headline figures and who prepared it.",
    category: "structure",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "cover",
    planner: true,
    aiSpec: "cover_page: { businessName, tagline?, industry?, location?, askingPrice?, revenue?, ebitda?, earningsLabel?, confidentialLabel? }",
    aiUse: "— ebitda holds the headline earnings figure; earningsLabel says what it is (\"SDE\", \"EBITDA\", \"Adjusted EBITDA\") and MUST match the figure. Never put an SDE number under an EBITDA label. Put only the number in ebitda (e.g. \"$628,000\"), the name in earningsLabel. The date and \"Prepared by\" are added by the system (the month it is written; the brokerage) — never include them.",
    defaultData: (ctx) => ({
      businessName: ctx.businessName || "Business name",
      tagline: "",
      industry: ctx.industry || "",
      confidentialLabel: "CONFIDENTIAL BUSINESS OVERVIEW",
    }),
    presentationKeys: ["preparedByLogo", "businessLogo"],
  },
  {
    key: "divider",
    label: "Divider",
    description: "A labelled break between major parts of the CIM.",
    category: "structure",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "divider",
    planner: true,
    aiSpec: "divider: { label?, style?: \"line\"|\"section-break\"|\"page-break\" }",
    aiUse: "— Use for: visual separation between major document sections",
    defaultData: () => ({ label: "", style: "section-break" }),
  },

  // ── Numbers ────────────────────────────────────────────────────────────
  {
    key: "metric_grid",
    label: "Key numbers",
    description: "A grid of headline figures — revenue, earnings, customers, staff.",
    category: "numbers",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "metric_grid",
    planner: true,
    aiSpec: "metric_grid: { metrics: [{label, value, unit?, trend?, delta?, highlight?, footnote?}], columns?: 2|3|4, title? }",
    aiUse: "— Use for: KPIs, key financial figures, key operational metrics, snapshot stats",
    defaultData: () => ({
      metrics: [
        { label: "Metric", value: "—" },
        { label: "Metric", value: "—" },
        { label: "Metric", value: "—" },
      ],
      columns: 3,
    }),
  },
  {
    key: "stat_callout",
    label: "Big number",
    description: "One standout figure that defines the business, with supporting stats.",
    category: "numbers",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "stat_callout",
    planner: true,
    aiSpec: "stat_callout: { primaryValue, primaryLabel, secondaryStats?: [{label, value}], description?, accentColor? }",
    aiUse: "— Use for: one standout number that defines the business — leading metric on a major section",
    defaultData: () => ({ primaryValue: "—", primaryLabel: "Headline figure", secondaryStats: [], description: "" }),
    presentationKeys: ["accentColor"],
  },
  {
    key: "icon_stat_row",
    label: "Stat row",
    description: "A compact row of quick facts with icons.",
    category: "numbers",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "icon_stat_row",
    planner: true,
    aiSpec: "icon_stat_row: { stats: [{icon?, label, value, unit?, description?}], title? }",
    aiUse: "— Use for: compact stats that don't warrant a full metric grid — operational facts, headcounts, key numbers",
    defaultData: () => ({
      stats: [
        { label: "Fact", value: "—" },
        { label: "Fact", value: "—" },
        { label: "Fact", value: "—" },
      ],
    }),
  },
  {
    key: "scorecard",
    label: "Scorecard",
    description: "Scored bars for health, risk or readiness factors.",
    category: "numbers",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "scorecard",
    planner: true,
    aiSpec: "scorecard: { items: [{label, score: number (0..maxScore), benchmark?: number (0..maxScore), description?}], title?, maxScore?: number (default 100) }",
    aiUse: "— Use for: business health assessment, risk factors, readiness indicators — ONLY when every item has a real numeric score on one shared scale. Ratings, statuses, percentages of different things or counts (\"Satisfactory\", \"PIP\", \"9.4%\", \"4 claims\") are NOT scores: use callout_list or comparison_table for those.",
    defaultData: () => ({ items: [{ label: "Factor", score: 50, description: "" }], maxScore: 100 }),
  },

  // ── Charts ─────────────────────────────────────────────────────────────
  {
    key: "bar_chart",
    label: "Bar chart",
    description: "Compare values side by side — revenue by year, by month, by stream.",
    category: "charts",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "series",
    planner: true,
    aiSpec: "bar_chart: { data: [{name, value, secondaryValue?, color?}], xLabel?, yLabel?, secondaryLabel?, unit?, title?, stacked? }",
    aiUse: "— Use for: revenue by year, revenue by stream, seasonality by month, headcount growth",
    defaultData: () => ({
      data: [{ name: "2023", value: 0 }, { name: "2024", value: 0 }, { name: "2025", value: 0 }],
      unit: "",
    }),
  },
  {
    key: "horizontal_bar_chart",
    label: "Ranked bars",
    description: "Horizontal bars for long labels — customers, products, shares.",
    category: "charts",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "series",
    planner: true,
    aiSpec: "horizontal_bar_chart: { data: [{name, value, unit?}], yLabel?, unit?, title?, showPercentages? }",
    aiUse: "— Use for: revenue by customer, revenue by product line, time allocation, % breakdowns where labels are long",
    defaultData: () => ({
      data: [{ name: "Item A", value: 50 }, { name: "Item B", value: 30 }, { name: "Item C", value: 20 }],
      showPercentages: true,
    }),
  },
  {
    key: "line_chart",
    label: "Trend line",
    description: "How a figure moved over time — revenue or earnings trend.",
    category: "charts",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "line",
    planner: true,
    aiSpec: "line_chart: { data: [{name, [seriesKey]: value}], series: [{key, label, color?}], xLabel?, yLabel?, unit?, title? }",
    aiUse: "— Use for: revenue trend over years, EBITDA trend, growth over time",
    defaultData: () => ({
      data: [{ name: "2023", value: 0 }, { name: "2024", value: 0 }, { name: "2025", value: 0 }],
      series: [{ key: "value", label: "Value" }],
    }),
  },
  {
    key: "pie_chart",
    label: "Pie chart",
    description: "How a whole splits into parts — revenue mix, ownership (up to 6 parts).",
    category: "charts",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "slices",
    planner: true,
    aiSpec: "pie_chart: { data: [{name, value, color?}], totalLabel?, unit?, title? }",
    aiUse: "— Use for: ownership breakdown, customer concentration, revenue mix (when ≤6 categories)",
    defaultData: () => ({ data: [{ name: "Category A", value: 60 }, { name: "Category B", value: 40 }] }),
  },
  {
    key: "donut_chart",
    label: "Donut chart",
    description: "A pie with a headline figure in the centre.",
    category: "charts",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "slices",
    planner: true,
    aiSpec: "donut_chart: { data: [{name, value, color?}], totalLabel?, unit?, title?, centerLabel?, centerValue? }",
    aiUse: "— Use for: same as pie_chart but when you want to show a central metric",
    defaultData: () => ({
      data: [{ name: "Category A", value: 60 }, { name: "Category B", value: 40 }],
      centerLabel: "",
      centerValue: "",
    }),
  },
  {
    key: "waterfall_chart",
    label: "Earnings bridge",
    description: "Step from one figure to another — e.g. net income to adjusted SDE.",
    category: "charts",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "waterfall",
    planner: true,
    aiSpec: "waterfall_chart: { items: [{label, value, type?: \"start\"|\"add\"|\"subtract\"|\"total\"}], title?, unit?, currency? }",
    aiUse: "— Use for: SDE normalization build-up, EBITDA walk, asking price build-up — any stepped financial calculation. Shows starting point, each addback/adjustment as green (add) or red (subtract) steps, and final total. Excellent for showing how you get from net income to adjusted SDE/EBITDA.",
    defaultData: () => ({
      items: [
        { label: "Net income", value: 0, type: "start" },
        { label: "Adjustment", value: 0, type: "add" },
        { label: "Adjusted total", value: 0, type: "total" },
      ],
    }),
  },

  // ── Tables ─────────────────────────────────────────────────────────────
  {
    key: "financial_table",
    label: "Financial table",
    description: "Rows and years — P&L summary, SDE normalization, balance sheet.",
    category: "tables",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "financial_table",
    planner: true,
    aiSpec: "financial_table: { headers: string[] — FIRST entry is the label-column header (\"\" or e.g. \"Line item\"), then one header per value column, oldest year first, rows: [{label, values: string[] — one per value column, same order as headers[1..]; \"\" when a year has no figure}, isTotal?, isSectionHeader?, indent?, bold?}], caption?, currency?, footnotes? }",
    aiUse: "— Use for: P&L summary, SDE normalization, balance sheet highlights, asking price build-up",
    defaultData: () => ({
      headers: ["", "2023", "2024", "2025"],
      rows: [
        { label: "Revenue", values: ["", "", ""] },
        { label: "Net income", values: ["", "", ""], isTotal: true },
      ],
      currency: "",
    }),
  },
  {
    key: "comparison_table",
    label: "Comparison",
    description: "Two columns side by side — this business vs. the industry, before vs. after.",
    category: "tables",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "comparison_table",
    planner: true,
    aiSpec: "comparison_table: { leftLabel, rightLabel, rows: [{label, left, right, highlight?}], title? } — leftLabel/rightLabel name the two value columns (never \"Metric\": the label column already has that header); left and right are ONE short value each, never a series — a figure over several years (\"589 → 711 → 646\") belongs in a financial_table with one column per year",
    aiUse: "— Use for: business vs. industry benchmarks, current vs. prior year, pre-sale vs. post-sale",
    defaultData: () => ({
      leftLabel: "This business",
      rightLabel: "Industry",
      rows: [{ label: "", left: "", right: "" }],
    }),
  },

  // ── Text ───────────────────────────────────────────────────────────────
  {
    key: "prose_highlight",
    label: "Narrative",
    description: "Written paragraphs, with an optional pull quote and highlights.",
    category: "text",
    content: "prose",
    editor: "text",
    blind: "redact",
    family: "prose",
    planner: true,
    aiSpec: "prose_highlight: { body, pullQuote?, highlights?: string[], subheading? }",
    aiUse: "— Use for: company narrative, reason for sale, owner story, transition plan — anything deeply human",
    defaultData: () => ({ body: "" }),
  },
  {
    key: "two_column",
    label: "Two columns",
    description: "A story on one side, a list or figures on the other.",
    category: "text",
    content: "prose",
    editor: "text",
    blind: "redact",
    family: "two_column",
    planner: true,
    aiSpec: "two_column: { left: {title?, content, layoutType?}, right: {title?, content, layoutType?}, title? } — each column's layoutType is \"prose\" (content = paragraphs), \"list\" (content = one item per line), \"metric\" (content = \"Label: value\" lines), or one of metric_grid | icon_stat_row | callout_list | numbered_list | stat_callout | bar_chart | pie_chart | donut_chart | line_chart | financial_table | comparison_table | scorecard, in which case content is an OBJECT of exactly that layout's shape (e.g. {stats: [{label, value}]} for icon_stat_row, {items: [{title, description}]} for callout_list) — never a word such as \"stats\".",
    aiUse: "— Use for: pairing complementary information — narrative + stats, overview + highlights",
    defaultData: () => ({
      left: { title: "", content: "", layoutType: "prose" },
      right: { title: "", content: "", layoutType: "list" },
    }),
  },
  {
    key: "callout_list",
    label: "Highlight cards",
    description: "Cards for strengths, advantages and opportunities.",
    category: "text",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "items",
    planner: true,
    aiSpec: "callout_list: { items: [{title, description?, icon?, highlight?, badge?}], columns?: 1|2|3, style?: \"card\"|\"list\"|\"icon-row\", title? }",
    aiUse: "— Use for: USPs, growth opportunities, competitive advantages, buyer requirements, key differentiators",
    defaultData: () => ({
      items: [
        { title: "Point", description: "" },
        { title: "Point", description: "" },
      ],
      columns: 2,
      style: "card",
    }),
  },
  {
    key: "numbered_list",
    label: "Numbered list",
    description: "Ordered points — reasons to buy, steps, priorities.",
    category: "text",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "items",
    planner: true,
    aiSpec: "numbered_list: { items: [{title, description?}], title?, ordered? }",
    aiUse: "— Use for: process steps, reasons to buy, ranked priorities, ordered action items",
    defaultData: () => ({ items: [{ title: "Point", description: "" }], ordered: true }),
  },
  {
    key: "timeline",
    label: "Timeline",
    description: "History and milestones in date order.",
    category: "text",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "timeline",
    planner: true,
    aiSpec: "timeline: { events: [{date?, year?, title, description?, highlight?, category?}], title? }",
    aiUse: "— Use for: company history, milestones, expansion history, ownership transitions",
    defaultData: () => ({ events: [{ year: "", title: "Milestone", description: "" }] }),
  },
  {
    key: "tag_cloud",
    label: "Keyword tags",
    description: "Short tags — services offered, markets served, certifications.",
    category: "text",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "tag_cloud",
    // Broker-only for now: the AI planner has not been tuned for it.
    planner: false,
    aiSpec: "tag_cloud: { tags: [{label, weight?: 1-5, category?}], title? }",
    aiUse: "— Use for: services offered, markets served, certifications, equipment — short keyword sets",
    defaultData: () => ({ tags: [{ label: "Keyword" }, { label: "Keyword" }] }),
  },

  // ── People & places ────────────────────────────────────────────────────
  {
    key: "org_chart",
    label: "Team chart",
    description: "Who does what and who reports to whom.",
    category: "people_places",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "org_chart",
    planner: true,
    aiSpec: "org_chart: { nodes: [{id, name, role, reportsTo?, isKeyPerson?, isOwner?, yearsAtCompany?, notes?}], title?, totalHeadcount?, ownerDependency? } — ids are neutral (\"n1\", \"n2\"…), never a person's name; reportsTo holds the manager's id",
    aiUse: "— Use for: team structure, management hierarchy, key personnel",
    defaultData: () => ({ nodes: [{ id: "1", name: "Owner", role: "Owner", isOwner: true }] }),
  },
  {
    key: "location_card",
    label: "Locations & lease",
    description: "Premises, square footage and lease terms.",
    category: "people_places",
    content: "structured",
    editor: "data",
    blind: "redact",
    family: "location_card",
    planner: true,
    aiSpec: "location_card: { locations: [{label?, address?, sqft?, leaseType?, leaseExpiry?, monthlyRent?, annualRent?, renewalOptions?, notes?}], totalSqft?, title? }",
    aiUse: "— Use for: physical location details, lease terms, real estate included in sale",
    defaultData: () => ({ locations: [{ label: "Main location", address: "", leaseType: "leased" }] }),
  },

  // ── Media (blind-safety rules: shared/cim-media.ts) ───────────────────
  {
    key: "image_gallery",
    label: "Photo gallery",
    description: "Photos of the premises, equipment or work — a grid or a slideshow.",
    category: "media",
    content: "structured",
    editor: "media",
    // Captions are AI-redacted; WHICH photos a blind buyer sees is decided
    // deterministically (uploads marked blind-safe only) — never by the AI.
    blind: "redact",
    family: "image_gallery",
    planner: false,
    aiWrite: false,
    aiRewrite: false,
    aiSpec: "image_gallery: { images: [{mediaId?, url?, caption?, alt?}], style?: \"grid\"|\"carousel\", columns?: 2|3|4, title? }",
    aiUse: "— Photos the broker adds. Never produce this layout yourself.",
    defaultData: () => ({ images: [], style: "grid" }),
    presentationKeys: ["mediaId", "blindSafe", "style"],
  },
  {
    key: "video",
    label: "Video",
    description: "A YouTube or Vimeo video, or one you upload — a walkthrough or the owner's story.",
    category: "media",
    content: "structured",
    editor: "media",
    blind: "redact",
    family: "video",
    planner: false,
    aiWrite: false,
    aiRewrite: false,
    aiSpec: "video: { items: [{source: \"youtube\"|\"vimeo\"|\"upload\", url?, mediaId?, title?, caption?}], title? }",
    aiUse: "— Videos the broker adds. Never produce this layout yourself.",
    defaultData: () => ({ items: [] }),
    presentationKeys: ["mediaId", "source", "blindSafe"],
  },
  {
    key: "location_map",
    label: "Map",
    description: "An interactive map of the premises, with the address beside it.",
    category: "media",
    content: "structured",
    editor: "media",
    blind: "redact",
    family: "location_map",
    planner: true,
    aiRewrite: false,
    aiSpec: "location_map: { locations: [{label, address, note? (one short line)}], zoom?: 3-20, caption? (one short line, under 120 characters), title? }",
    aiUse: "— Use for: an interactive map of where the business operates, next to the premises/location content. ONLY when the knowledge base gives a real street address for the business's premises: copy each address exactly as written there (street, city, province/state, postal code) — never invent, complete or approximate one. At most one location_map per CIM. The blind version automatically shows only the province/state.",
    defaultData: (ctx) => ({
      locations: [{ label: "Main location", address: ctx.address || "" }],
      zoom: 14,
      blindMap: "region",
    }),
    presentationKeys: ["zoom", "blindMap", "regionOnly"],
  },
] as const satisfies readonly CimLayoutDef[];

export type CimLayoutKey = (typeof LAYOUTS)[number]["key"];

/** Every registered layout, in gallery order. */
export const CIM_LAYOUTS: readonly CimLayoutDef[] = LAYOUTS;

export const CIM_LAYOUT_KEYS: readonly CimLayoutKey[] = LAYOUTS.map((l) => l.key);

const BY_KEY = new Map<string, CimLayoutDef>(LAYOUTS.map((l) => [l.key, l]));

/** The registered layout for a key, or undefined for unknown/legacy types. */
export function getCimLayout(key: string | null | undefined): CimLayoutDef | undefined {
  return key ? BY_KEY.get(key) : undefined;
}

export function isCimLayoutKey(key: unknown): key is CimLayoutKey {
  return typeof key === "string" && BY_KEY.has(key);
}

/** Map an arbitrary (AI- or client-supplied) layout type onto a registered one. */
export function normalizeLayoutType(key: unknown, fallback: CimLayoutKey = "prose_highlight"): CimLayoutKey {
  return isCimLayoutKey(key) ? key : fallback;
}

export function layoutLabel(key: string | null | undefined): string {
  return getCimLayout(key)?.label ?? "Custom layout";
}

/** Layouts offered to the AI planner (whole-CIM generation). */
export function plannerLayouts(): CimLayoutDef[] {
  return LAYOUTS.filter((l) => l.planner);
}

/** Layouts grouped for the builder's gallery (empty categories dropped). */
export function layoutsByCategory(): Array<{ key: CimLayoutCategory; label: string; layouts: CimLayoutDef[] }> {
  return CIM_LAYOUT_CATEGORIES.map((c) => ({
    key: c.key,
    label: c.label,
    layouts: CIM_LAYOUTS.filter((l) => l.category === c.key),
  })).filter((g) => g.layouts.length > 0);
}

/** Blank-section data for a layout (a fresh object every call). */
export function defaultLayoutData(key: string, ctx: CimLayoutDefaultContext = {}): Record<string, unknown> {
  const def = getCimLayout(key);
  return def ? def.defaultData(ctx) : { body: "" };
}

/** True when switching between the two layouts needs no data conversion. */
export function sameLayoutFamily(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = getCimLayout(a);
  const db = getCimLayout(b);
  return !!da && !!db && da.family === db.family;
}

/** Can the AI write / regenerate / convert into this layout from the deal's facts? */
export function canAiWriteLayout(key: string | null | undefined): boolean {
  const def = getCimLayout(key);
  return !def || def.aiWrite !== false;
}

/** Can the AI writer rewrite this layout's content? */
export function canAiRewriteLayout(key: string | null | undefined): boolean {
  const def = getCimLayout(key);
  return !def || def.aiRewrite !== false;
}

/** Presentation-only keys across all layouts (colours, icons, URLs, flags). */
export const CIM_PRESENTATION_KEYS: ReadonlySet<string> = new Set<string>([
  "color", "icon", "highlight", "columns", "style", "accentColor", "relatedSections",
  "url", "alt", "isTotal", "isSectionHeader", "indent", "bold", "trend", "weight",
  "category", "layoutType", "id", "reportsTo", "isKeyPerson", "ordered", "stacked",
  "showPercentages", "xLabel", "yLabel",
  ...LAYOUTS.flatMap((l) => ("presentationKeys" in l ? [...l.presentationKeys] : [])),
]);

/** The layout-spec block of the AI design prompt, generated from the registry. */
export function layoutSpecsForPrompt(layouts: readonly CimLayoutDef[] = plannerLayouts()): string {
  return layouts.map((l) => `${l.aiSpec}\n${l.aiUse}`).join("\n\n");
}

// ── Section access tiers & buyer access levels ─────────────────────────────

/**
 * Per-section access tier. "teaser" sections are shown to every buyer; "full"
 * sections are shown as locked stubs to buyers whose access level is teaser.
 * A missing value (older rows) means teaser — every existing CIM is unchanged.
 */
export const CIM_ACCESS_TIERS = ["teaser", "full"] as const;
export type CimAccessTier = (typeof CIM_ACCESS_TIERS)[number];

export function sectionTier(section: { accessTier?: string | null }): CimAccessTier {
  return section.accessTier === "full" ? "full" : "teaser";
}

/** Buyer access levels (buyer_access.access_level) with plain-English meaning. */
export const BUYER_ACCESS_LEVELS = [
  { key: "teaser", label: "Teaser", version: "blind", description: "Blind CIM; sections you mark “Full access” show as locked." },
  { key: "full", label: "Full", version: "blind", description: "Blind CIM with every section unlocked." },
  { key: "loi", label: "LOI", version: "normal", description: "The named CIM — business name, people and places shown." },
  { key: "due_diligence", label: "Due diligence", version: "dd", description: "Named CIM plus due-diligence detail (customer names, verification notes)." },
] as const;
export type BuyerAccessLevel = (typeof BUYER_ACCESS_LEVELS)[number]["key"];

export function isBuyerAccessLevel(v: unknown): v is BuyerAccessLevel {
  return typeof v === "string" && BUYER_ACCESS_LEVELS.some((l) => l.key === v);
}

/** Buyer-facing name of an access level ("Full CIM", "LOI", "Due diligence") — never the raw key. */
export function buyerAccessLabel(level: string | null | undefined): string {
  if (level === "full") return "Full CIM";
  const known = BUYER_ACCESS_LEVELS.find((l) => l.key === level);
  if (known) return known.label;
  const s = String(level ?? "").replace(/_/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "—";
}

/** The same name inside a sentence: "Given LOI access", "Given due diligence access", "Given full CIM access". */
export function buyerAccessPhrase(level: string | null | undefined): string {
  const label = buyerAccessLabel(level);
  // Keep acronyms ("LOI"); lower-case the first letter of words.
  return /^[A-Z]{2,}\b/.test(label) ? label : label.charAt(0).toLowerCase() + label.slice(1);
}

/** Which CIM version a buyer access level sees. */
export function cimModeForAccessLevel(level: string | null | undefined): "blind" | "normal" | "dd" {
  if (level === "due_diligence") return "dd";
  if (level === "loi") return "normal";
  return "blind"; // teaser, full (and anything unknown) → blind
}

/** Layout type the view room uses for a section a buyer can't open yet. */
export const LOCKED_LAYOUT_TYPE = "locked";
export const LOCKED_SECTION_MESSAGE = "Available once the broker upgrades your access";

// ── Applying a blind/DD override to a section ───────────────────────────────

interface OverrideLike {
  layoutData?: unknown;
  contentOverride?: string | null;
}
interface SectionLike {
  layoutData?: unknown;
  aiDraftContent?: string | null;
  brokerEditedContent?: string | null;
}

/**
 * Merge a blind/DD override onto its base section — the exact rule the view
 * room, the chatbot and the builder preview share.
 *
 * The override's contentOverride is the redacted/enriched version of the
 * text the renderer showed (broker edit → layoutData.body → AI draft). It only
 * replaces brokerEditedContent when the base had one: otherwise a two-column
 * section's prose column would be swapped for the AI draft, and a narrative's
 * body would show different text than the Normal CIM. In blind mode the base
 * text is never used as a fallback (it is un-redacted).
 */
export function applySectionOverride<T extends SectionLike>(
  section: T,
  override: OverrideLike | undefined,
  mode: "blind" | "dd",
): T {
  if (!override) return section;
  const blind = mode === "blind";
  const text = override.contentOverride || null;
  return {
    ...section,
    layoutData: override.layoutData || (blind ? {} : section.layoutData),
    aiDraftContent: text || (blind ? null : section.aiDraftContent ?? null),
    brokerEditedContent: section.brokerEditedContent
      ? text || (blind ? null : section.brokerEditedContent)
      : null,
  };
}

// ── Generated-data hygiene (layout engine, redactor, renderers) ─────────────

type AnyRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is AnyRecord => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Org chart node ids rewritten to neutral "n1", "n2"… (reportsTo / parentId
 * follow). The AI often uses first names as ids ("dave", reportsTo:
 * "kevin"): harmless in the named CIM, but those strings would reach a
 * blind buyer's browser, and the identity guard (rightly) rejected every
 * blind version that kept them. Data without nodes is returned unchanged;
 * a reportsTo that points at no node is dropped.
 */
export function neutralOrgChartIds<T>(data: T): T {
  if (!isRecord(data) || !Array.isArray(data.nodes)) return data;
  const nodes = data.nodes as unknown[];
  const ids = new Map<string, string>();
  nodes.forEach((n, i) => {
    if (isRecord(n) && (typeof n.id === "string" || typeof n.id === "number")) {
      const key = String(n.id);
      if (!ids.has(key)) ids.set(key, `n${i + 1}`);
    }
  });
  const remap = (v: unknown) => (typeof v === "string" || typeof v === "number" ? ids.get(String(v)) : undefined);
  return {
    ...data,
    nodes: nodes.map((n, i) => {
      if (!isRecord(n)) return n;
      const out: AnyRecord = { ...n, id: remap(n.id) ?? `n${i + 1}` };
      for (const k of ["reportsTo", "parentId"]) {
        if (!(k in n)) continue;
        const to = remap(n[k]);
        if (to && to !== out.id) out[k] = to;
        else delete out[k];
      }
      return out;
    }),
  } as T;
}

/** A score the scorecard can draw as a bar: a number, or a plain number in a string ("85"). */
export function numericScore(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v)) return Number(v);
  return null;
}

/** True when every scorecard item has a numeric score (and there is at least one). */
export function scorecardIsNumeric(data: unknown): boolean {
  const items = isRecord(data) && Array.isArray(data.items) ? (data.items as unknown[]) : [];
  return items.length > 0 && items.every((it) => isRecord(it) && numericScore(it.score) !== null);
}

/** Column types drawn as text inside a two-column section. */
const TEXT_COLUMN_TYPES = new Set(["prose", "list", "metric"]);

/** The list each structured sub-layout needs ({stats: […]} for icon_stat_row…). */
const SUB_LAYOUT_LIST_KEY: Record<string, string> = {
  metric_grid: "metrics", icon_stat_row: "stats", callout_list: "items", numbered_list: "items", scorecard: "items",
  bar_chart: "data", horizontal_bar_chart: "data", pie_chart: "data", donut_chart: "data", line_chart: "data",
  financial_table: "rows", comparison_table: "rows", timeline: "events",
};

/** Sub-layouts a two-column column can hold (each has a renderer inside TwoColumn). */
export const TWO_COLUMN_SUB_LAYOUTS: readonly string[] = [...Object.keys(SUB_LAYOUT_LIST_KEY), "stat_callout"];

export interface TwoColumnColumn {
  title?: string;
  content: unknown;
  layoutType: string;
}

/**
 * How a two-column column should be drawn, or null when it holds nothing
 * real. Repairs the shapes the AI produced on real deals:
 *   - {content: "stats", layoutType: "icon_stat_row"} — a placeholder word
 *     where the data should be → null (nothing to show; never the word);
 *   - {content: [{title, description}…]} with no layoutType → callout_list;
 *   - {content: {stats: […]}} with no layoutType → icon_stat_row (and the
 *     other list shapes likewise);
 *   - a structured type whose content is a bare list → wrapped in its shape.
 */
export function resolveTwoColumnColumn(raw: unknown): TwoColumnColumn | null {
  if (!isRecord(raw)) return null;
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title : undefined;
  const content = raw.content;
  const type = typeof raw.layoutType === "string" && raw.layoutType.trim() ? raw.layoutType.trim() : "";
  if (!type || TEXT_COLUMN_TYPES.has(type)) {
    if (Array.isArray(content)) {
      if (content.length === 0) return null;
      if (content.every((x) => typeof x === "string")) return { title, layoutType: "list", content: (content as string[]).join("\n") };
      if (content.every((x) => isRecord(x) && (typeof x.title === "string" || typeof x.label === "string"))) {
        const items = (content as AnyRecord[]).map((x) => ({ ...x, title: (x.title ?? x.label) as string }));
        const style = raw.style === "card" || raw.style === "list" || raw.style === "icon-row" ? raw.style : "list";
        return { title, layoutType: "callout_list", content: { items, columns: 1, style } };
      }
      return null;
    }
    if (isRecord(content)) {
      for (const [key, layout] of [["stats", "icon_stat_row"], ["metrics", "metric_grid"], ["items", "callout_list"], ["rows", "financial_table"], ["events", "timeline"], ["data", "bar_chart"]] as const) {
        if (Array.isArray(content[key]) && (content[key] as unknown[]).length > 0) return { title, layoutType: layout, content };
      }
      return null;
    }
    const text = typeof content === "string" ? content : content == null ? "" : String(content);
    return text.trim() ? { title, layoutType: type || "prose", content: text } : null;
  }
  // A structured sub-layout.
  const listKey = SUB_LAYOUT_LIST_KEY[type];
  if (isRecord(content)) {
    if (listKey && !(Array.isArray(content[listKey]) && (content[listKey] as unknown[]).length > 0)) return null;
    if (type === "stat_callout" && !content.primaryValue) return null;
    return { title, layoutType: type, content };
  }
  if (Array.isArray(content) && listKey && content.length > 0) return { title, layoutType: type, content: { [listKey]: content } };
  // A string where the data should be: a placeholder word ("stats") is
  // nothing; real prose is shown as prose rather than lost.
  if (typeof content === "string" && content.trim().split(/\s+/).length >= 6) return { title, layoutType: "prose", content };
  return null;
}

/**
 * Problems in a generated section's data that the renderer can't draw
 * truthfully. Empty = fine. The layout engine retries a section once when
 * this isn't empty, then falls back to tidyGeneratedLayout().
 */
export function layoutDataProblems(layoutType: string, data: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(data)) return problems;
  if (layoutType === "two_column") {
    for (const side of ["left", "right"] as const) {
      const col = data[side];
      if (col === undefined) continue;
      const declared = isRecord(col) && typeof col.layoutType === "string" ? col.layoutType : "";
      const resolved = resolveTwoColumnColumn(col);
      if (!resolved) {
        problems.push(`the ${side} column has no real content${declared ? ` for its ${declared} layout` : ""}`);
      } else if (resolved.layoutType !== (declared || "prose") && !(declared === "" && resolved.layoutType === "prose")) {
        problems.push(`the ${side} column's content doesn't match its layout (${declared || "no layoutType"})`);
      }
    }
  }
  if (layoutType === "scorecard" && Array.isArray(data.items) && data.items.length > 0 && !scorecardIsNumeric(data)) {
    problems.push("scorecard scores must be numbers — ratings, statuses and mixed units belong in a callout list");
  }
  return problems;
}

/**
 * Deterministic clean-up of a generated section before it is saved:
 * neutral org chart ids; financial-table "section header" rows that carry
 * figures become bold rows (their figures were hidden); a scorecard without
 * numeric scores becomes highlight cards (it drew "Satisfactory/100");
 * two-column columns repaired or emptied (never a placeholder word).
 */
export function tidyGeneratedLayout(layoutType: string, data: unknown): { layoutType: string; layoutData: AnyRecord } {
  const layoutData: AnyRecord = isRecord(data) ? { ...data } : {};
  if (layoutType === "org_chart") return { layoutType, layoutData: neutralOrgChartIds(layoutData) };
  if (layoutType === "financial_table") {
    const fix = (rows: unknown) => Array.isArray(rows)
      ? rows.map((r) => {
          if (!isRecord(r) || !r.isSectionHeader) return r;
          const values = Array.isArray(r.values) ? r.values : [];
          if (!values.some((v) => (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.trim()))) return r;
          const { isSectionHeader: _h, ...rest } = r;
          return { ...rest, bold: true };
        })
      : rows;
    if (Array.isArray(layoutData.rows)) layoutData.rows = fix(layoutData.rows);
    if (Array.isArray(layoutData.normalizedRows)) layoutData.normalizedRows = fix(layoutData.normalizedRows);
    return { layoutType, layoutData };
  }
  if (layoutType === "scorecard" && Array.isArray(layoutData.items) && layoutData.items.length > 0 && !scorecardIsNumeric(layoutData)) {
    const items = (layoutData.items as unknown[]).filter(isRecord).map((it) => {
      const benchmark = it.benchmark != null && String(it.benchmark).trim() ? String(it.benchmark).trim() : "";
      const description = [typeof it.description === "string" ? it.description : "", benchmark ? `Benchmark: ${benchmark}.` : ""]
        .filter(Boolean).join(" ");
      const score = it.score != null ? String(it.score).trim() : "";
      return { title: String(it.label ?? ""), ...(score ? { badge: score } : {}), ...(description ? { description } : {}) };
    });
    const { items: _i, maxScore: _m, ...rest } = layoutData;
    return { layoutType: "callout_list", layoutData: { ...rest, items, columns: 2, style: "card" } };
  }
  // A series packed into a comparison table's cells ("589 → 711 → 646") is
  // a financial table with one column per year — it overflowed its column.
  if (layoutType === "comparison_table" && comparisonPacksSeries(layoutData)) {
    return { layoutType: "financial_table", layoutData: comparisonAsFinancialTable(layoutData) };
  }
  if (layoutType === "two_column") {
    for (const side of ["left", "right"] as const) {
      if (layoutData[side] === undefined) continue;
      const col = resolveTwoColumnColumn(layoutData[side]) ?? { content: "", layoutType: "prose" };
      layoutData[side] = col.layoutType === "comparison_table" && comparisonPacksSeries(col.content)
        ? { ...col, layoutType: "financial_table", content: comparisonAsFinancialTable(col.content) }
        : col;
    }
    return { layoutType, layoutData };
  }
  return { layoutType, layoutData };
}
