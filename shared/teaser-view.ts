/**
 * Serving the teaser (pure; server, client previews and tests).
 *
 * buildBuyerTeaser turns a stored TeaserDoc into what a buyer receives:
 *  - the codename blind buyers are served (a different one in the stored
 *    doc is swapped), or "Confidential Opportunity";
 *  - {price} / {contact} / {firm} filled from the settings and the
 *    brokerage brand (the price in the teaser's number style);
 *  - EVERY block re-checked with the CURRENT identity terms (a fact added
 *    after publishing, a new staff name, a rename): a block that fails is
 *    not served and is reported in leaked/leakReasons (fail closed). There
 *    is no automatic AI redo — the teaser is the broker's text;
 *  - neutral block keys (blindSectionKey), so analytics never carry slugs.
 */
import { blindLeakTerms, collectStrings, mapStrings, type BlindTerm } from "./blind-guard";
import { blindSectionKey, type BuyerSection } from "./cim-buyer-view";
import { hasSampleData } from "./cim-layouts";
import { moneyIn, parseMoney, type NumberStyle } from "./deal-bands";
import {
  TEASER_TOKENS,
  blockCells,
  blockTexts,
  validateTeaserLayout,
  withCellsApplied,
  type KeyCell,
  type TeaserBlock,
  type TeaserBlockCheck,
  type TeaserDoc,
  type TeaserHeader,
} from "./teaser";
import { guardTeaserText, heldReason, pinpointWarnings } from "./teaser-guard";
import { DEFAULT_TEASER_WORDING } from "./teaser-templates";

export const NO_CODENAME = "Confidential Opportunity";

export interface TeaserDealLike {
  id: string;
  businessName?: string | null;
  extractedInfo?: unknown;
  employeeChart?: unknown;
  industry?: string | null;
  subIndustry?: string | null;
}

export interface TeaserContact {
  firm: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
}

export interface ServedTeaserHeader {
  label: string;
  codename: string;
  tagline: string;
  chips: string[];
}

/** The identity terms a teaser is checked against (the Blind CIM's, with the served codename). */
export function teaserTerms(deal: TeaserDealLike, codename: string | null | undefined): BlindTerm[] {
  return blindLeakTerms(deal as never, { codename: codename || NO_CODENAME });
}

/** Swap one codename for another in every string of a doc (a rename, or the served codename). */
export function swapCodename<T>(value: T, from: string | null | undefined, to: string | null | undefined): T {
  if (!from || !to || from === to) return value;
  const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  return mapStrings(value, (s) => s.replace(re, to));
}

/**
 * The checks for one block (computed on every read, never stored): held
 * (names the business / kept a stand-in), pinpointing wording (AI and broker
 * text only), the layout check and sample rows.
 */
export function checkTeaserBlock(block: TeaserBlock, terms: BlindTerm[]): TeaserBlockCheck {
  const texts = blockTexts(block);
  const g = guardTeaserText(texts, terms);
  const pinpoint = block.origin === "fixed" ? [] : pinpointWarnings(collectStrings(texts).join("\n"));
  return {
    blockId: block.id,
    held: !g.ok,
    reason: heldReason(g, terms),
    leaks: g.leaks,
    pinpoint,
    layoutProblem: validateTeaserLayout(block),
    sample: hasSampleData(block),
  };
}

export function checkTeaserDoc(doc: TeaserDoc | null | undefined, terms: BlindTerm[]): TeaserBlockCheck[] {
  return (doc?.blocks ?? []).map((b) => checkTeaserBlock(b, terms));
}

/** The header as a buyer sees it: chips and tagline re-checked (a failing chip is dropped; a failing tagline becomes the industry). */
export function servedHeader(header: TeaserHeader | null, codename: string, terms: BlindTerm[], industry: string | null | undefined): ServedTeaserHeader {
  const label = header?.label && guardTeaserText(header.label, terms).ok ? header.label : DEFAULT_TEASER_WORDING.label;
  const tagline = header?.tagline && guardTeaserText(header.tagline, terms).ok ? header.tagline : industry && guardTeaserText(industry, terms).ok ? industry : "";
  const chips = chipsBesideTagline((header?.chips ?? []).filter((c) => typeof c === "string" && c.trim() && guardTeaserText(c, terms).ok), tagline).slice(0, 5);
  return { label, codename, tagline, chips };
}

/** The chips without one that only repeats the one-line description (an industry tagline and the industry chip). */
export function chipsBesideTagline(chips: string[], tagline: string | null | undefined): string[] {
  const t = (tagline ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return t ? chips.filter((c) => c.replace(/\s+/g, " ").trim().toLowerCase() !== t) : chips;
}

export interface TeaserFill {
  /** The price in the number style, "Price on request", or null (dropped). */
  price: string | null;
  contact: string | null;
  firm: string;
}

/**
 * The {price} slot: the listed price in the teaser's number style when shown
 * and listed; "Price on request" when listed but hidden, or when its text
 * names the business; nothing (dropped) when there is no price.
 */
export function priceForTeaser(askingPrice: string | null | undefined, opts: { show: boolean; numbers: NumberStyle; terms: BlindTerm[] }): string | null {
  if (!askingPrice || !askingPrice.trim()) return null;
  if (!opts.show) return "Price on request";
  if (!guardTeaserText(askingPrice, opts.terms).ok) return "Price on request";
  const n = parseMoney(askingPrice);
  return n ? moneyIn(opts.numbers, n) : "Price on request";
}

export function contactLine(c: TeaserContact): string | null {
  const parts = [c.name, c.email, c.phone].map((x) => (x ?? "").trim()).filter(Boolean);
  if (parts.length === 0) return c.firm?.trim() || null;
  return parts.join(" · ");
}

const hasToken = (s: string, t: string) => s.includes(t);

/** Fill the serve-time tokens in a block. Cells / lines whose token has no value are dropped. */
export function fillTeaserTokens(block: TeaserBlock, fill: TeaserFill): TeaserBlock {
  const firm = fill.firm;
  const replaceAll = (s: string) => {
    const out = s.split(TEASER_TOKENS.firm).join(firm).split(TEASER_TOKENS.price).join(fill.price ?? "").split(TEASER_TOKENS.contact).join(fill.contact ?? "");
    // "{firm} reviews your request" with no firm name on file: "The broker reviews…", never "the broker…" at the start.
    return s.startsWith(TEASER_TOKENS.firm) ? out.charAt(0).toUpperCase() + out.slice(1) : out;
  };
  // Cells first: a price cell with no price is dropped (never "—").
  let b = block;
  const cells = blockCells(b);
  if (cells.length > 0) {
    const kept: KeyCell[] = [];
    for (const c of cells) {
      if (hasToken(c.value, TEASER_TOKENS.price) && !fill.price) continue;
      if (hasToken(c.value, TEASER_TOKENS.contact) && !fill.contact) continue;
      kept.push({ ...c, value: replaceAll(c.value), label: replaceAll(c.label) });
    }
    b = withCellsApplied({ ...b, layoutData: { ...b.layoutData, cells: kept } });
  }
  const dropLine = (s: string) => (hasToken(s, TEASER_TOKENS.price) && !fill.price) || (hasToken(s, TEASER_TOKENS.contact) && !fill.contact);
  // Lists: an item whose token has no value is dropped.
  const data = { ...b.layoutData } as Record<string, unknown>;
  if (Array.isArray(data.items)) {
    data.items = (data.items as unknown[]).filter((it) => !collectStrings(it).some(dropLine));
  }
  const filled = mapStrings({ ...b, layoutData: data }, (s) =>
    s.includes("{") ? s.split("\n").filter((line) => !dropLine(line)).map(replaceAll).join("\n") : s,
  );
  return { ...filled, id: block.id, slot: block.slot, origin: block.origin };
}

/** A teaser block as the CIM renderers and the reading tracker take it (neutral key). */
export function teaserBlockToSection(block: TeaserBlock, dealId: string, order: number): BuyerSection {
  const b = withCellsApplied(block);
  const data = { ...b.layoutData } as Record<string, unknown>;
  delete data.cells;
  if (b.layoutType === "prose_highlight" && typeof b.body === "string" && typeof data.body !== "string") data.body = b.body;
  return {
    id: b.id,
    dealId,
    sectionKey: blindSectionKey(b.id),
    sectionTitle: b.title,
    order,
    layoutType: b.layoutType,
    layoutData: data,
    aiDraftContent: b.layoutType === "prose_highlight" ? (b.body ?? (typeof data.body === "string" ? data.body : null)) : null,
    brokerEditedContent: null,
    isVisible: true,
  };
}

export interface BuyerTeaserInput {
  deal: TeaserDealLike;
  doc: TeaserDoc;
  /** The codename blind buyers are served now (servedBlindCodename ?? deal.blindCodename). */
  codename: string | null;
  /** The codename the doc was written under (deal_teasers.codename_used). */
  codenameUsed?: string | null;
  askingPrice: string | null;
  showAskingPrice: boolean;
  numbers: NumberStyle;
  contact: TeaserContact;
}

export interface BuyerTeaser {
  header: ServedTeaserHeader;
  blocks: BuyerSection[];
  heldBack: number;
  /** Blocks held back from buyers (ids) and why — for the broker, never the buyer. */
  leaked: string[];
  leakReasons: Record<string, string>;
}

/**
 * What the serve-time tokens become ({price} in the number style, {contact},
 * {firm}) — the buyer's teaser and the broker's editor fill them the same way.
 */
export function teaserFill(input: Pick<BuyerTeaserInput, "askingPrice" | "showAskingPrice" | "numbers" | "contact">, terms: BlindTerm[]): TeaserFill {
  return {
    price: priceForTeaser(input.askingPrice, { show: input.showAskingPrice, numbers: input.numbers, terms }),
    contact: (() => {
      const line = contactLine(input.contact);
      return line && guardTeaserText(line, terms).leaks.length === 0 ? line : input.contact.firm;
    })(),
    firm: input.contact.firm?.trim() || "the broker",
  };
}

export function buildBuyerTeaser(input: BuyerTeaserInput): BuyerTeaser {
  const codename = input.codename || NO_CODENAME;
  const terms = teaserTerms(input.deal, codename);
  const doc = swapCodename(input.doc, input.codenameUsed, codename);
  const header = servedHeader(doc.header, codename, terms, input.deal.industry ?? null);
  const fill = teaserFill(input, terms);
  const blocks: BuyerSection[] = [];
  const leaked: string[] = [];
  const leakReasons: Record<string, string> = {};
  let heldBack = 0;
  for (const raw of doc.blocks) {
    if (raw.hidden || raw.placeholder) continue;
    const block = fillTeaserTokens(raw, fill);
    const check = checkTeaserBlock(block, terms);
    if (check.held || check.layoutProblem || check.sample) {
      heldBack++;
      leaked.push(raw.id);
      leakReasons[raw.id] = check.reason ?? check.layoutProblem ?? "it still shows sample data";
      continue;
    }
    blocks.push(teaserBlockToSection(block, input.deal.id, blocks.length));
  }
  return { header, blocks, heldBack, leaked, leakReasons };
}

/** How many blocks differ between the draft and the published version (visible blocks, ids matched). */
export function teaserDocDiff(draft: TeaserDoc | null | undefined, published: TeaserDoc | null | undefined): { changed: number; added: number; removed: number; headerChanged: boolean } {
  const key = (b: TeaserBlock) => JSON.stringify([b.title, b.layoutType, b.layoutData, b.body]);
  const d = new Map((draft?.blocks ?? []).filter((b) => !b.hidden && !b.placeholder).map((b) => [b.id, key(b)]));
  const p = new Map((published?.blocks ?? []).map((b) => [b.id, key(b)]));
  let changed = 0;
  let added = 0;
  let removed = 0;
  d.forEach((v, id) => {
    if (!p.has(id)) added++;
    else if (p.get(id) !== v) changed++;
  });
  p.forEach((_v, id) => {
    if (!d.has(id)) removed++;
  });
  const order = (doc: TeaserDoc | null | undefined, only?: Map<string, string>) => (doc?.blocks ?? []).filter((b) => (only ? only.has(b.id) : true)).map((b) => b.id).join(",");
  const reordered = order(draft, p) !== order(published, d) ? 1 : 0;
  const headerChanged = JSON.stringify(draft?.header ?? null) !== JSON.stringify(published?.header ?? null);
  return { changed: changed + reordered, added, removed, headerChanged };
}
