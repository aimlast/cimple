/**
 * Teaser templates (pure data). Four built-in starting points named for who
 * they're for, plus the broker's saved templates (teaser_templates rows).
 *
 * Every template starts with the header (not a block) and ends with Next
 * step and Confidentiality. Each slot says who writes it:
 *   fixed = deterministic, from the facts or the settings (never the AI);
 *   ai    = the AI writes it (from the anonymous Blind CIM, figures removed);
 *   mixed = fixed lines plus AI text.
 */
import type { NumberStyle } from "./deal-bands";
import { isBuiltInTeaserTemplate, isTeaserLayout, type TeaserLayout, type TeaserTemplateKey } from "./teaser";

export interface TeaserSlotDef {
  slot: string;
  title: string;
  layoutType: TeaserLayout;
  src: "fixed" | "ai" | "mixed";
  /** Shown only when the facts support it (trend: ≥ 3 printed years). */
  conditional?: boolean;
}

export interface TeaserLengths {
  /** Overview sentences [min, max]. */
  overview: [number, number];
  highlights: number;
  growth: number;
  whoItSuits: [number, number];
}

export interface TeaserTemplateDef {
  key: string;
  name: string;
  /** One line on the picker card. */
  description: string;
  /** "1 page" | "2 pages" | "About 2 pages". */
  lengthLabel: string;
  targetPages: number;
  numbers: NumberStyle;
  slots: TeaserSlotDef[];
  lengths: TeaserLengths;
  /** Saved templates: the built-in it started from. */
  basedOn?: string | null;
  /** Saved templates: the broker's own fixed wording per slot (kept verbatim, still guarded). */
  fixedText?: Record<string, string>;
  saved?: boolean;
}

const NEXT_STEP: TeaserSlotDef = { slot: "next_step", title: "Interested?", layoutType: "numbered_list", src: "fixed" };
const CONFIDENTIALITY: TeaserSlotDef = { slot: "confidentiality", title: "", layoutType: "prose_highlight", src: "fixed" };
const KEY_NUMBERS: TeaserSlotDef = { slot: "key_numbers", title: "", layoutType: "metric_grid", src: "fixed" };
const OVERVIEW: TeaserSlotDef = { slot: "overview", title: "The business", layoutType: "prose_highlight", src: "ai" };
const OPPORTUNITY: TeaserSlotDef = { slot: "opportunity", title: "The opportunity", layoutType: "two_column", src: "mixed" };
const TREND: TeaserSlotDef = { slot: "trend", title: "Revenue trend (first year = 100)", layoutType: "line_chart", src: "fixed", conditional: true };
const GROWTH: TeaserSlotDef = { slot: "growth", title: "Room to grow", layoutType: "callout_list", src: "ai" };

export const TEASER_TEMPLATES: Record<TeaserTemplateKey, TeaserTemplateDef> = {
  listing: {
    key: "listing",
    name: "Main-street listing",
    description: "Like a listing site: price, cash flow, revenue, FF&E, training, reason.",
    lengthLabel: "1 page",
    targetPages: 1,
    numbers: "rounded",
    lengths: { overview: [2, 3], highlights: 4, growth: 0, whoItSuits: [0, 0] },
    slots: [
      { slot: "listing_facts", title: "At a glance", layoutType: "metric_grid", src: "fixed" },
      OVERVIEW,
      { slot: "highlights", title: "Highlights", layoutType: "callout_list", src: "ai" },
      NEXT_STEP,
      CONFIDENTIALITY,
    ],
  },
  one_page: {
    key: "one_page",
    name: "One-page teaser",
    description: "The essentials: key numbers, highlights, who it suits.",
    lengthLabel: "1 page",
    targetPages: 1,
    numbers: "ranges",
    lengths: { overview: [2, 3], highlights: 5, growth: 0, whoItSuits: [2, 3] },
    slots: [
      KEY_NUMBERS,
      OVERVIEW,
      { slot: "highlights", title: "Investment highlights", layoutType: "callout_list", src: "ai" },
      OPPORTUNITY,
      NEXT_STEP,
      CONFIDENTIALITY,
    ],
  },
  two_page: {
    key: "two_page",
    name: "Two-page teaser",
    description: "Adds the business, operations, growth and the revenue trend.",
    lengthLabel: "2 pages",
    targetPages: 2,
    numbers: "ranges",
    lengths: { overview: [4, 6], highlights: 6, growth: 3, whoItSuits: [2, 3] },
    slots: [
      KEY_NUMBERS,
      OVERVIEW,
      { slot: "highlights", title: "Investment highlights", layoutType: "callout_list", src: "ai" },
      { slot: "operations", title: "At a glance", layoutType: "icon_stat_row", src: "mixed" },
      TREND,
      GROWTH,
      OPPORTUNITY,
      NEXT_STEP,
      CONFIDENTIALITY,
    ],
  },
  investor: {
    key: "investor",
    name: "Investor brief",
    description: "For financial buyers: financial picture, people, deal structure.",
    lengthLabel: "About 2 pages",
    targetPages: 2,
    numbers: "ranges",
    lengths: { overview: [3, 4], highlights: 5, growth: 3, whoItSuits: [2, 3] },
    slots: [
      KEY_NUMBERS,
      OVERVIEW,
      { slot: "financial_snapshot", title: "Financial picture", layoutType: "icon_stat_row", src: "fixed" },
      TREND,
      { slot: "highlights", title: "Investment highlights", layoutType: "callout_list", src: "ai" },
      { slot: "management", title: "Management & transition", layoutType: "prose_highlight", src: "ai" },
      GROWTH,
      { slot: "deal_structure", title: "Deal structure", layoutType: "two_column", src: "mixed" },
      NEXT_STEP,
      CONFIDENTIALITY,
    ],
  },
};

/** The Main-street listing's facts grid, in order. A row with no fact on file hides itself. */
export const LISTING_FIELDS = [
  { key: "askingPrice", label: "Asking price" },
  { key: "cashFlow", label: "Cash flow (SDE)" },
  { key: "grossRevenue", label: "Gross revenue" },
  { key: "ffe", label: "FF&E" },
  { key: "inventory", label: "Inventory" },
  { key: "realEstate", label: "Real estate" },
  { key: "employees", label: "Employees" },
  { key: "established", label: "Established" },
  { key: "financing", label: "Financing" },
  { key: "supportTraining", label: "Support & training" },
  { key: "reasonForSale", label: "Reason for selling" },
] as const;
export type ListingFieldKey = (typeof LISTING_FIELDS)[number]["key"];

/** Slots for a template key (built-in, or a resolved saved template). */
export function slotsFor(key: string, saved?: TeaserTemplateDef | null): TeaserSlotDef[] {
  if (isBuiltInTeaserTemplate(key)) return TEASER_TEMPLATES[key].slots;
  return saved?.slots ?? TEASER_TEMPLATES.one_page.slots;
}

export function templateDef(key: string, saved?: TeaserTemplateDef | null): TeaserTemplateDef {
  if (isBuiltInTeaserTemplate(key)) return TEASER_TEMPLATES[key];
  return saved ?? TEASER_TEMPLATES.one_page;
}

/**
 * In a saved template, where the deal it was saved from used its codename:
 * filled with the new deal's codename when the template is used (never
 * served as it is — assembly always fills it).
 */
export const CODENAME_TOKEN = "{codename}";

/** A saved template's titles and wording with {codename} filled in. */
export function withCodenameFilled(def: TeaserTemplateDef, codename: string): TeaserTemplateDef {
  if (!def.saved) return def;
  const fill = (s: string) => s.split(CODENAME_TOKEN).join(codename);
  return {
    ...def,
    slots: def.slots.map((s) => (s.title.includes(CODENAME_TOKEN) ? { ...s, title: fill(s.title) } : s)),
    fixedText: def.fixedText ? Object.fromEntries(Object.entries(def.fixedText).map(([k, v]) => [k, fill(v)])) : def.fixedText,
  };
}

/** "saved:<id>" for a saved template. */
export const SAVED_PREFIX = "saved:";
export function savedTemplateKey(id: string): string {
  return `${SAVED_PREFIX}${id}`;
}
export function savedTemplateId(key: string | null | undefined): string | null {
  return typeof key === "string" && key.startsWith(SAVED_PREFIX) ? key.slice(SAVED_PREFIX.length) || null : null;
}

/** One block of a saved template: no deal text — a layout skeleton and the broker's fixed wording. */
export interface SavedTeaserBlock {
  slot: string;
  title: string;
  layoutType: string;
  /** The block's layoutData with every deal value blanked (structure only). */
  skeleton: Record<string, unknown>;
  /** The broker's own wording for a fixed slot (next step, confidentiality) or a custom block. */
  fixedText?: string;
}

export interface SavedTeaserTemplateRow {
  id: string;
  name: string;
  basedOn?: string | null;
  blocks: unknown;
  settings: unknown;
}

const BUILT_IN_SLOTS = new Map<string, TeaserSlotDef>();
for (const t of Object.values(TEASER_TEMPLATES)) for (const s of t.slots) if (!BUILT_IN_SLOTS.has(s.slot)) BUILT_IN_SLOTS.set(s.slot, s);

/** A saved template row → a template definition (block order, titles, fixed wording). */
export function templateFromSaved(row: SavedTeaserTemplateRow): TeaserTemplateDef {
  const base = isBuiltInTeaserTemplate(row.basedOn) ? TEASER_TEMPLATES[row.basedOn] : TEASER_TEMPLATES.one_page;
  const settings = (row.settings && typeof row.settings === "object" ? row.settings : {}) as { numbers?: NumberStyle };
  const blocks = Array.isArray(row.blocks) ? (row.blocks as SavedTeaserBlock[]) : [];
  const fixedText: Record<string, string> = {};
  const slots: TeaserSlotDef[] = [];
  for (const b of blocks) {
    if (!b || typeof b.slot !== "string" || !isTeaserLayout(b.layoutType)) continue;
    const builtIn = BUILT_IN_SLOTS.get(b.slot);
    // A custom block keeps the broker's wording as a fixed block; a known slot is written as that slot.
    slots.push({ slot: b.slot, title: typeof b.title === "string" ? b.title : "", layoutType: b.layoutType, src: builtIn?.src ?? "fixed", ...(builtIn?.conditional ? { conditional: true } : {}) });
    if (typeof b.fixedText === "string" && b.fixedText.trim()) fixedText[b.slot] = b.fixedText;
  }
  return {
    key: savedTemplateKey(row.id),
    name: row.name,
    description: `Your template${base ? `, based on the ${base.name}` : ""}.`,
    lengthLabel: base.lengthLabel,
    targetPages: base.targetPages,
    numbers: settings.numbers === "rounded" || settings.numbers === "ranges" ? settings.numbers : base.numbers,
    lengths: base.lengths,
    slots: slots.length > 0 ? slots : base.slots,
    basedOn: row.basedOn ?? null,
    fixedText,
    saved: true,
  };
}

/** The default wording of the fixed blocks (Settings → Brand & templates can replace it). */
export const DEFAULT_TEASER_WORDING = {
  label: "CONFIDENTIAL OPPORTUNITY",
  nextStep: [
    "Ask for the CIM from this page",
    "Confirm your email, tell us about you and sign the NDA online",
    "{firm} reviews your request and opens the CIM for you",
  ],
  contactLine: "Questions? {contact}",
  confidentiality: "This summary doesn't name the business. Please don't contact the business, its staff, customers or suppliers. All questions go to {firm}.",
} as const;
