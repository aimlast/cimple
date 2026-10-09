/**
 * The Teaser — a short anonymous summary a broker sends before the NDA
 * (server/teaser/*). One document per deal: a header plus blocks, kept as
 * a draft and a published snapshot. Blocks use a teaser-safe subset of the
 * CIM layouts and render with the CIM renderers on theme-locked paper.
 *
 * Pure types and checks, shared by the server and the client.
 */
import { resolveTwoColumnColumn } from "./cim-layouts";
import type { NumberStyle } from "./deal-bands";
import { BLIND_ACCESS_LEVEL, NAMED_ACCESS_LEVEL, sameAccessLevel } from "./access-levels";

/** Layouts a teaser block may use: no tables, money charts, maps, photos or org charts. */
export const TEASER_LAYOUTS = [
  "metric_grid",
  "icon_stat_row",
  "stat_callout",
  "callout_list",
  "numbered_list",
  "prose_highlight",
  "tag_cloud",
  "divider",
  "two_column",
  "line_chart",
] as const;
export type TeaserLayout = (typeof TEASER_LAYOUTS)[number];

/** What a two-column teaser column may hold: text, a list, figures, or a teaser layout other than two columns or a chart. */
export const TEASER_COLUMN_TYPES: readonly string[] = ["prose", "list", "metric", ...TEASER_LAYOUTS.filter((l) => l !== "two_column" && l !== "line_chart")];

export function isTeaserLayout(v: unknown): v is TeaserLayout {
  return typeof v === "string" && (TEASER_LAYOUTS as readonly string[]).includes(v);
}

export interface TeaserHeader {
  /** "CONFIDENTIAL OPPORTUNITY". */
  label: string;
  /** One line, ≤ 140 characters. */
  tagline: string;
  /** ≤ 5 chips: industry, region, "Established 20+ years". */
  chips: string[];
}

/** A key number made from the facts (fixed blocks). Typed over by the broker = `edited`. */
export interface KeyCell {
  key: string;
  label: string;
  value: string;
  edited?: boolean;
  editedAt?: string;
}

export interface TeaserBlock {
  /** Stable uuid: the analytics page id and lineage. */
  id: string;
  /** The template slot key, or "custom". */
  slot: string;
  /** "" = no heading. */
  title: string;
  layoutType: TeaserLayout;
  /** Fixed blocks keep KeyCell[] in layoutData.cells. */
  layoutData: Record<string, unknown>;
  /** Prose (prose_highlight body mirror). */
  body: string | null;
  hidden: boolean;
  origin: "ai" | "fixed" | "broker";
  /** The AI couldn't write it anonymously (or wasn't used): hidden, the broker writes it. */
  placeholder?: boolean;
  /** Fact keys it was made from (staleness). */
  facts: string[];
  updatedAt: string;
}

export interface TeaserDoc {
  header: TeaserHeader | null;
  blocks: TeaserBlock[];
}

export const EMPTY_TEASER_DOC: TeaserDoc = { header: null, blocks: [] };

export const TEASER_LIMITS = { blocks: 30, title: 120, text: 4000, tagline: 140, chips: 5, cell: 40 } as const;

/** Filled at serve time, in fixed blocks only. */
export const TEASER_TOKENS = { price: "{price}", contact: "{contact}", firm: "{firm}" } as const;

export type TeaserTemplateKey = "listing" | "one_page" | "two_page" | "investor";
export const TEASER_TEMPLATE_KEYS: readonly TeaserTemplateKey[] = ["listing", "one_page", "two_page", "investor"];
export function isBuiltInTeaserTemplate(v: unknown): v is TeaserTemplateKey {
  return typeof v === "string" && (TEASER_TEMPLATE_KEYS as readonly string[]).includes(v);
}

export type TeaserPageSize = "letter" | "a4";
/** CSS px at 96 dpi; 48 px margins. */
export const TEASER_PAGE_SIZES: Record<TeaserPageSize, { width: number; height: number; label: string }> = {
  letter: { width: 816, height: 1056, label: "Letter" },
  a4: { width: 794, height: 1123, label: "A4" },
};
export const TEASER_PAGE_MARGIN = 48;

export type TeaserLinkLifetime = "until_offline" | "30" | "90";
export const TEASER_LINK_LIFETIMES: readonly TeaserLinkLifetime[] = ["until_offline", "30", "90"];
/** What a buyer gets automatically after confirming their email and signing the NDA from the teaser. */
export type TeaserAutoGrant = "off" | typeof BLIND_ACCESS_LEVEL | typeof NAMED_ACCESS_LEVEL;
export const TEASER_AUTO_GRANTS: readonly TeaserAutoGrant[] = ["off", BLIND_ACCESS_LEVEL, NAMED_ACCESS_LEVEL];
/** The level an auto_grant setting gives (null = off / unreadable). */
export function autoGrantLevel(v: unknown): typeof BLIND_ACCESS_LEVEL | typeof NAMED_ACCESS_LEVEL | null {
  if (sameAccessLevel(v, BLIND_ACCESS_LEVEL)) return BLIND_ACCESS_LEVEL;
  if (sameAccessLevel(v, NAMED_ACCESS_LEVEL)) return NAMED_ACCESS_LEVEL;
  return null;
}

export interface TeaserSettings {
  templateKey: string;
  designTemplateId: string | null;
  pageSize: TeaserPageSize;
  numbers: NumberStyle;
  showAskingPrice: boolean;
  linkLifetime: TeaserLinkLifetime;
  autoGrant: TeaserAutoGrant;
}

export type TeaserBasis = "blind_cim" | "redacted_facts" | "template";

export interface TeaserGeneration {
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string | null;
  /** A plain sentence for the broker. */
  error?: string | null;
  warnings: string[];
  basis?: TeaserBasis | null;
  /** The slots/blocks this run was asked to fill. */
  ownedBlockIds: string[];
  /** A full "Write my teaser" (every mutation waits) vs filling some slots. */
  fullRewrite?: boolean;
  /** The confidentiality review couldn't run (publishing then needs a later review or the broker's confirmation). */
  reviewFailed?: boolean;
  model?: string | null;
  usage?: { input: number; output: number } | null;
}

export interface TeaserSellerCheck {
  status: "sent" | "approved" | "changes_requested";
  sentAt: string;
  sentRev: number;
  doc: TeaserDoc;
  at?: string | null;
  byName?: string | null;
  note?: string | null;
}

/** Per-block results, computed on every read (never stored). */
export interface TeaserBlockCheck {
  blockId: string;
  /** Held back from buyers: it names the business (or kept a placeholder). */
  held: boolean;
  /** Plain words for the broker ("it names “Surrey” (the town)"). */
  reason: string | null;
  leaks: string[];
  /** Wording that may let someone recognise the business (never blocks). */
  pinpoint: string[];
  /** The layout can't be used in a teaser as it stands. */
  layoutProblem: string | null;
  /** Still made-up sample rows (blocks publishing). */
  sample: boolean;
}

export type TeaserStatus = "none" | "draft" | "published" | "offline";

export type TeaserRequestState = "none" | "requested" | "approved_waiting" | "declined" | "granted";

/** The light summary (CIM tab strip, Buyers tab, dashboard, the 2 s poll while writing). */
export interface TeaserSummary {
  status: TeaserStatus;
  templateKey: string | null;
  publishedAt: string | null;
  unpublishedAt: string | null;
  draftRev: number;
  publishedRev: number;
  /** Blocks whose draft differs from the published version. */
  changedSincePublish: number;
  /** Visible published blocks held back from buyers right now (current identity terms). */
  heldBlocks: Array<{ blockId: string; title: string; reason: string }>;
  /** Draft blocks held back (they'd be held at publish). */
  draftHeldBlocks: Array<{ blockId: string; title: string; reason: string }>;
  pinpointCount: number;
  seller: { state: "none" | "sent" | "approved" | "approved_earlier" | "changes_requested"; at: string | null; note: string | null };
  generation: { status: TeaserGeneration["status"]; error: string | null; basis: TeaserBasis | null; startedAt: string; reviewFailed: boolean; warnings: string[] } | null;
  /** The confidentiality review couldn't run at the last write and the broker hasn't confirmed. */
  reviewNeeded: boolean;
  counts: {
    links: number;
    opened: number;
    openedToday: number;
    asked: number;
    granted: number;
    passed: number;
    worthACall: number;
    freshLinkRequests: number;
  };
}

export interface TeaserEngagementBuyer {
  accessId: string;
  name: string | null;
  company: string | null;
  email: string;
  sentAt: string | null;
  via: "email" | "link";
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  activeMs: number;
  /** The furthest block reached (its title), null = not opened. */
  furthestBlock: string | null;
  readToEnd: boolean;
  request: { state: TeaserRequestState; at: string | null; level?: string | null; grantedBy?: string | null; requestId?: string | null } ;
  passed: { at: string; reasons: string[]; note: string | null } | null;
  freshLinkRequestedAt: string | null;
  worthACall: boolean;
  /** Still a teaser link (not revoked or upgraded). */
  active: boolean;
  expired: boolean;
}

export interface TeaserEngagement {
  funnel: { sent: number; opened: number; readToEnd: number; asked: number; granted: number; passed: number };
  buyers: TeaserEngagementBuyer[];
  blocks: Array<{ blockId: string; title: string; readers: number; attentionMs: number; avgMs: number }>;
  openedToday: number;
}

export const TEASER_PASS_REASONS = ["size", "location", "industry", "price", "timing", "other"] as const;
export type TeaserPassReason = (typeof TEASER_PASS_REASONS)[number];
export const TEASER_PASS_REASON_WORDS: Record<TeaserPassReason, string> = {
  size: "size",
  location: "location",
  industry: "industry",
  price: "price",
  timing: "timing",
  other: "something else",
};

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Does a value carry money ($, €, £) or a currency word? */
const MONEY = /[$€£¥]|\b(?:usd|cad|dollars?)\b/i;

/**
 * Can this block be drawn in a teaser as it stands? Null = fine; otherwise
 * a plain sentence for the broker. Two-column columns may hold only text,
 * lists, figures or highlights (never a chart or a table); a line chart
 * only the indexed revenue trend (first year = 100), with no money values.
 */
export function validateTeaserLayout(block: Pick<TeaserBlock, "layoutType" | "layoutData">): string | null {
  if (!isTeaserLayout(block.layoutType)) return "This layout can't be used in a teaser — pick another one.";
  const data = isRecord(block.layoutData) ? block.layoutData : {};
  if (block.layoutType === "two_column") {
    for (const side of ["left", "right"] as const) {
      const raw = data[side];
      if (raw === undefined || raw === null) continue;
      const declared = isRecord(raw) && typeof raw.layoutType === "string" && raw.layoutType.trim() ? raw.layoutType.trim() : "prose";
      if (!TEASER_COLUMN_TYPES.includes(declared)) return "A teaser column can hold text, a list, figures or highlights — not a chart or a table.";
      const resolved = resolveTwoColumnColumn(raw);
      if (resolved && !TEASER_COLUMN_TYPES.includes(resolved.layoutType)) return "A teaser column can hold text, a list, figures or highlights — not a chart or a table.";
    }
  }
  if (block.layoutType === "line_chart") {
    const bad = "A chart in a teaser can only show the revenue trend as an index (first year = 100).";
    if (data.indexed !== true) return bad;
    if (typeof data.unit === "string" && MONEY.test(data.unit)) return bad;
    if (typeof data.yLabel === "string" && MONEY.test(data.yLabel)) return bad;
    const rows = Array.isArray(data.data) ? data.data : [];
    for (const r of rows) {
      if (!isRecord(r)) return bad;
      for (const [k, v] of Object.entries(r)) {
        if (k === "name") continue;
        if (typeof v === "string" && MONEY.test(v)) return bad;
        if (typeof v === "number" && (v < 0 || v > 10_000)) return bad;
      }
    }
  }
  return null;
}

/** The cells of a fixed block (layoutData.cells), validated. */
export function blockCells(block: Pick<TeaserBlock, "layoutData">): KeyCell[] {
  const cells = isRecord(block.layoutData) ? block.layoutData.cells : null;
  if (!Array.isArray(cells)) return [];
  return cells.filter((c): c is KeyCell => isRecord(c) && typeof c.key === "string" && typeof c.label === "string" && typeof c.value === "string");
}

/**
 * Rebuild what the renderer reads from a fixed block's cells: metric_grid
 * `metrics`, icon_stat_row `stats`, two_column right-hand "Label: value"
 * lines. Cells are the source of truth; this keeps the drawn data in step.
 */
export function withCellsApplied(block: TeaserBlock): TeaserBlock {
  const cells = blockCells(block);
  if (cells.length === 0 && !Array.isArray((block.layoutData as Record<string, unknown>)?.cells)) return block;
  const data = { ...block.layoutData };
  if (block.layoutType === "metric_grid") data.metrics = cells.map((c) => ({ label: c.label, value: c.value }));
  else if (block.layoutType === "icon_stat_row") data.stats = cells.map((c) => ({ label: c.label, value: c.value }));
  else if (block.layoutType === "two_column") {
    const right: Record<string, unknown> = isRecord(data.right) ? { ...data.right } : { title: "" };
    right.layoutType = "metric";
    right.content = cells.map((c) => `${c.label}: ${c.value}`).join("\n");
    data.right = right;
  }
  return { ...block, layoutData: data };
}

/** Every string a buyer could read in a block (title, body, layout data). */
export function blockTexts(block: Pick<TeaserBlock, "title" | "body" | "layoutData">): unknown[] {
  return [block.title, block.body ?? "", block.layoutData];
}

/** Two docs show buyers the same thing (visible blocks only, ids and timestamps aside). */
export function sameTeaserContent(a: TeaserDoc | null | undefined, b: TeaserDoc | null | undefined): boolean {
  const strip = (d: TeaserDoc | null | undefined) =>
    JSON.stringify({
      header: d?.header ?? null,
      blocks: (d?.blocks ?? []).filter((x) => !x.hidden).map((x) => ({ id: x.id, title: x.title, layoutType: x.layoutType, layoutData: x.layoutData, body: x.body })),
    });
  return strip(a) === strip(b);
}
