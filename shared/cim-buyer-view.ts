/**
 * cim-buyer-view — exactly which CIM sections a buyer may receive, and in
 * which form. The single authority for the view room (GET /api/view/:token)
 * and the buyer Q&A chatbot, so the two can never disagree.
 *
 * Rules (server-side — the browser is never trusted to hide anything):
 *   - Hidden sections, sections the AI is still writing, and placeholders
 *     for sections it couldn't write (CIM_FALLBACK_REASONING) never leave
 *     the server.
 *   - A live CIM serves each section as last approved (shared/cim-published.ts):
 *     a change waits for the broker's approval. A blank layout's sample
 *     data is never served.
 *   - Access level → version (shared/access-levels.ts): a Teaser link
 *     (teaser_only) gets NO CIM at all — the teaser is its own document;
 *     Blind CIM (blind; legacy teaser/full) → Blind, Full CIM (named; legacy
 *     loi) → Normal, due_diligence → DD. Every CIM buyer gets the whole CIM
 *     of their version: per-section "Full access only" locks are retired.
 *   - Blind: a section is served only with an up-to-date redacted override
 *     (override present AND blindStaleAt null). Anything else is held back
 *     (and the caller triggers re-redaction). No override at all for the deal
 *     → the "preparing" holding state. Layouts whose blind policy is
 *     "exclude" are never served blind.
 *   - Fail closed: a blind section that still contains
 *     anything identifying from the deal's facts — business name, a person,
 *     the city or street, contacts (shared/blind-guard.ts) — or an unfilled
 *     template placeholder ("[Province/State]") is held back and reported
 *     in `leaked` (why in `leakReasons`) so the caller re-redacts it. A
 *     blind map's region is deterministic (shared/cim-media.ts) and is not
 *     re-checked: only its redacted words are.
 *   - Blind section keys are always neutral (`s_<id prefix>`): keys reach
 *     the page as data attributes and analytics ids, and broker- or
 *     AI-made keys are slugs of the title ("kitchener_clinic_team").
 *     Analytics map them back with realSectionKeyMap().
 *   - NDA: ndaBlocksBuyer() is the one rule every buyer path uses (view
 *     room, Q&A chatbot, Q&A feed, media) — nothing CIM-derived before a
 *     required NDA is signed.
 *   - Media sections (gallery, video, map) are rebuilt deterministically
 *     (shared/cim-media.ts): only this deal's uploads, only blind-safe media
 *     and region-only maps in the Blind CIM; a media section with nothing
 *     left to show is dropped.
 */
import type { CimSection, CimSectionOverride } from "./schema";
import {
  applySectionOverride,
  hasSampleData,
  isCimFallbackSection,
  getCimLayout,
} from "./cim-layouts";
import { cimModeForAccessLevel, seesCim } from "./access-levels";
import { servedVersions } from "./cim-published";
import { blindIdentifiers, blindTitleRedactor } from "./blind-identifiers";
import { blindLeakTerms, blindPlaceholders, collectStrings, findBlindLeaks } from "./blind-guard";
import { buyerMediaLayoutData, dealAddressFragments, isMediaLayout, type MediaAssetRef } from "./cim-media";
import { factAmounts, parseChartNumber, withStatedChartTotal } from "./cim-chart-values";

export interface BuyerSection {
  id: string;
  dealId: string;
  sectionKey: string;
  sectionTitle: string;
  order: number;
  layoutType: string;
  layoutData: unknown;
  aiDraftContent: string | null;
  brokerEditedContent: string | null;
  isVisible: true;
  /** Present (true) on stubs for sections above the buyer's access level. */
  locked?: true;
}

export interface BuyerCim {
  mode: "blind" | "normal" | "dd";
  sections: BuyerSection[];
  /** Blind version not generated yet — serve the holding state. */
  preparing: boolean;
  /** Blind sections held back until their redaction catches up. */
  heldBack: number;
  /**
   * Blind sections held back because their redacted version still names
   * something identifying — the caller should re-redact them.
   */
  leaked: string[];
  /** Per leaked section: what it still contained (for the broker, never the buyer). */
  leakReasons: Record<string, string>;
}

/**
 * True when a buyer must not receive anything CIM-derived yet: the deal
 * requires an NDA and this buyer hasn't signed it.
 */
export function ndaBlocksBuyer(
  deal: { ndaRequired?: boolean | null },
  access: { ndaSigned?: boolean | null },
): boolean {
  return !!deal.ndaRequired && !access.ndaSigned;
}

/**
 * True while a regenerated CIM waits for the broker to publish it and
 * buyers get nothing meanwhile: it replaced one buyers could open on a deal
 * that wasn't live, so no buyer path (view room, Q&A chatbot, media) serves
 * anything from it until then (server/cim/generation-jobs.ts). A live deal's
 * buyers keep the version last published instead (servesPublishedSnapshot).
 */
export function cimHeldFromBuyers(deal: { cimGeneration?: unknown }): boolean {
  const g = deal.cimGeneration as { buyerHold?: { servingPublished?: boolean } | null } | null | undefined;
  return !!g?.buyerHold && !g.buyerHold.servingPublished;
}

/**
 * True while a live deal's regenerated CIM waits for the broker's review:
 * every buyer path serves the version last published (the snapshot in
 * cim_published_snapshots), never the draft, until the broker publishes.
 */
export function servesPublishedSnapshot(deal: { isLive?: boolean | null; cimGeneration?: unknown }): boolean {
  const g = deal.cimGeneration as { buyerHold?: { servingPublished?: boolean } | null } | null | undefined;
  return !!deal.isLive && !!g?.buyerHold?.servingPublished;
}

/**
 * Buyers read the working copy right now: the CIM is live and not waiting
 * for the broker's review of an update. A section added (or duplicated)
 * then would reach buyers at once, so it starts hidden; while buyers read
 * the kept copy, a new section is part of the draft like any other.
 */
export function buyersReadWorkingCopy(deal: { isLive?: boolean | null; cimGeneration?: unknown }): boolean {
  return !!deal.isLive && !servesPublishedSnapshot(deal) && !cimHeldFromBuyers(deal);
}

/**
 * The listed asking price, written as a figure ("$4,500,000"); null when
 * there is none. Text that isn't one number is used as written.
 */
export function listedPriceText(price: string | null | undefined): string | null {
  const t = (price ?? "").trim();
  if (!t) return null;
  const n = parseChartNumber(t);
  return n !== null && n >= 1000 ? `$${Math.round(n).toLocaleString("en-US")}` : t;
}

/**
 * A label that IS the asking price — "Asking Price", "List price (CAD)",
 * "Listed price:" — and nothing else. "Asking Price / SDE" (9.4×), "Asking
 * price as a multiple of SDE" and "List price per sq ft" are other figures
 * that only mention the price; rewriting them showed buyers "$3,200,000" in
 * place of a multiple.
 */
const ASKING_LABEL = /^\s*(?:the\s+)?(?:asking|list(?:ing|ed)?)\s+price\s*(?:\(\s*(?:cad|usd|c\$|us\$|\$)\s*\))?\s*[:*]?\s*$/i;

/** The value shown is a dollar amount (never a multiple, a percentage or a rate). */
function isPriceValue(v: unknown): boolean {
  const t = String(v ?? "").trim();
  if (!t || /[x×%]\s*\)?\s*$/i.test(t) || /\bper\b|\/\s*(?:sq|ft|yr|year|month)/i.test(t)) return false;
  const n = parseChartNumber(t);
  return /\$/.test(t) || (n !== null && n >= 1000) || /price upon request|offers?\b/i.test(t);
}

/**
 * A section with its asking price shown as the broker lists it now: the
 * cover's price and an "Asking price" key number or callout. The figure is
 * stored when the CIM is written; a price the broker changed afterwards on
 * the Information tab never reached buyers (Lakeshore scenario, 2026-09-26).
 * Other sections' wording is the staleness check's to flag for the broker.
 */
export function withListedAskingPrice<T extends { layoutType: string; layoutData: unknown }>(section: T, price: string | null): T {
  if (!price || !section.layoutData || typeof section.layoutData !== "object") return section;
  const d = section.layoutData as Record<string, unknown>;
  if (section.layoutType === "cover_page" && typeof d.askingPrice === "string" && d.askingPrice.trim()) {
    return { ...section, layoutData: { ...d, askingPrice: price } };
  }
  if (section.layoutType === "metric_grid" && Array.isArray(d.metrics)) {
    const metrics = (d.metrics as unknown[]).map((m) =>
      m && typeof m === "object" && ASKING_LABEL.test(String((m as Record<string, unknown>).label ?? "")) && isPriceValue((m as Record<string, unknown>).value)
        ? { ...(m as object), value: price }
        : m,
    );
    return { ...section, layoutData: { ...d, metrics } };
  }
  if (section.layoutType === "stat_callout" && ASKING_LABEL.test(String(d.primaryLabel ?? "")) && isPriceValue(d.primaryValue)) {
    return { ...section, layoutData: { ...d, primaryValue: price } };
  }
  return section;
}

/** What an asking-price callout says when the deal has no listed price. */
export const PRICE_ON_REQUEST = "Price on request";

/**
 * A section with the stored asking price taken off: the cover's price, an
 * "Asking price" key number (dropped), an "Asking price" callout ("Price on
 * request"). For a deal whose listed price was removed (free round 2, C7).
 */
export function withoutAskingPrice<T extends { layoutType: string; layoutData: unknown }>(section: T): T {
  const cleaned = withoutPriceMentions(section);
  if (!cleaned.layoutData || typeof cleaned.layoutData !== "object") return cleaned;
  const d = cleaned.layoutData as Record<string, unknown>;
  // "Contact broker" / "Offers invited" on the cover isn't a price: it stays.
  if (cleaned.layoutType === "cover_page" && "askingPrice" in d && isPriceValue(d.askingPrice) && !/offers?\b|request|contact/i.test(String(d.askingPrice))) {
    const { askingPrice: _p, ...rest } = d;
    return { ...cleaned, layoutData: rest };
  }
  if (cleaned.layoutType === "metric_grid" && Array.isArray(d.metrics)) {
    const metrics = (d.metrics as unknown[]).filter((m) =>
      !(m && typeof m === "object" && ASKING_LABEL.test(String((m as Record<string, unknown>).label ?? "")) && isPriceValue((m as Record<string, unknown>).value)),
    );
    return metrics.length === (d.metrics as unknown[]).length ? cleaned : { ...cleaned, layoutData: { ...d, metrics } };
  }
  if (cleaned.layoutType === "stat_callout" && ASKING_LABEL.test(String(d.primaryLabel ?? "")) && isPriceValue(d.primaryValue)) {
    return { ...cleaned, layoutData: { ...d, primaryValue: PRICE_ON_REQUEST } };
  }
  return cleaned;
}

/**
 * Wording that states the asking price or a multiple worked out from it:
 * "asking price", "listed at", "purchase price", "Price / SDE", "implied
 * multiple". With the price removed, "Asking Price / SDE 3.8x" next to SDE
 * $1,263,000 let a buyer work the price back out, and "The asking price of
 * $4.8M represents 3.8x SDE" stayed in the prose (free round 2 check, C7).
 */
const PRICE_MENTION =
  /\b(?:asking|list(?:ing|ed)?|offering|purchase)\s+(?:price|multiple)\b|\b(?:listed|priced|offered)\s+(?:at|for)\b|\bprice\s*(?:\/|to|-to-)\s*(?:sde|ebitda|earnings|revenue|sales|cash\s*flow)\b|\bimplied\s+(?:price|multiple|valuation)\b/i;
/**
 * A valuation multiple of THIS deal — "SDE Multiple 5.2x", "Revenue Multiple
 * 1.45x", "EBITDA Multiple", "Implied EV / EBITDA 6.1x", "Price to EBITDA",
 * "Implied SDE multiple": with the SDE or revenue beside it, a buyer works the
 * removed price straight back out. PRICE_MENTION only knew labels that say
 * "price", so the multiples this app actually wrote (Harborview's "Asking
 * Price & Valuation" section) stayed (free round 2 check, C7).
 */
const MULTIPLE_MENTION =
  /\b(?:sde|ebitda|ebit|revenue|sales|earnings|cash[- ]?flow|ev|enterprise[- ]value|valuation|price)\s*(?:\/\s*)?multiples?\b|\bmultiples?\s+(?:of|on|to)\s+(?:sde|ebitda|ebit|revenue|sales|earnings|cash\s*flow)\b|\b(?:ev|enterprise\s+value|valuation|price)\s*(?:\/|to|-to-)\s*(?:sde|ebitda|ebit|earnings|revenue|sales|cash\s*flow)\b|\bimplied\s+(?:[\w/-]+\s+){0,3}?(?:multiple|valuation)\b|\b\d+(?:\.\d+)?\s?[x×]\s+(?:sde|ebitda|ebit|earnings|revenue|sales|cash\s*flow)\b/i;
/** A multiple written as one ("5.2x", "1.45×", "4.6 times"). */
const MULTIPLE_FIGURE = /\b\d+(?:\.\d+)?\s?(?:[x×](?![a-z])|times\b)/i;
/**
 * Wording about the market, not this deal: "Industry SDE multiple 2.5–3.5x",
 * "comparable transactions sold at 4x" — no price can be worked out from it.
 */
const MARKET_WORDING = /\b(?:industry|comparable|comparables|comps?|market|sector|peers?|typical(?:ly)?|average|median|benchmark|precedent|transactions?|range)\b/i;
/** Wording that ties a multiple to this deal even beside market words ("the implied multiple of 5.2x is below the industry average"). */
const DEAL_MULTIPLE = /\b(?:implied|this\s+(?:deal|transaction|opportunity|offering|price|valuation|business|company)|asking|purchase\s+price|listed|represents?|reflects?|equates?\s+to|works?\s+out\s+to)\b/i;

/** The deal's own multiple is stated: a multiple wording with a multiple figure, not about the market alone. */
function statesDealMultiple(label: string, figureText: string): boolean {
  if (!MULTIPLE_MENTION.test(label) || !MULTIPLE_FIGURE.test(figureText)) return false;
  return !MARKET_WORDING.test(label) || DEAL_MULTIPLE.test(label);
}

/** A figure such wording can give away: an amount or a multiple. */
const PRICE_FIGURE = /\$\s?\d|\b\d[\d,.]*\s?(?:k|m|mm|million|thousand)\b|\b\d+(?:\.\d+)?\s?[x×](?![a-z])|\b\d{1,3}(?:,\d{3})+\b/i;
/** Arrays whose entries are columns (a table's cells): emptied in place, never dropped. */
const POSITIONAL = new Set(["values", "headers", "columns", "cells"]);
const ROW_LABEL_KEYS = ["label", "name", "title", "term", "metric", "key", "primaryLabel"];

/** Wording that can only be about this deal's price: "asking price", "listing price", "Price / SDE". */
const DEAL_PRICE_TERM =
  /\b(?:asking|listing|listed|offering)\s+(?:price|multiple)\b|\bprice\s*(?:\/|to|-to-)\s*(?:sde|ebitda|earnings|revenue|sales|cash\s*flow)\b|\bimplied\s+(?:price|multiple|valuation)\b/i;
/**
 * Wording that is the deal's price only when a price figure goes with it:
 * "purchase price", "list price", "listed at", "priced at", "offered at".
 * "Memberships are priced at $189 per year", "the manufacturer's list price
 * of $12,500", "the 2012 purchase price of the building", "listed at #42 on
 * the Growth 500 with revenue of $6.2M" and "vendor financing of 10% of the
 * purchase price and the $250,000 of inventory" each lost their sentence
 * when any figure anywhere in it counted (free round 2 check, C7).
 */
const OTHER_PRICE_TERM = /\b(?:purchase|list)\s+price\b|\b(?:listed|priced|offered)(?:\s+for\s+sale)?\s+(?:at|for)\b/gi;
/** A price of something else: "…'s list price", "the 2012 purchase price", "purchase price of the building". */
const OTHER_THING_BEFORE = /(?:['’]s|\b(?:19|20)\d{2}|\b(?:its|their|his|her|original|historical|historic|equipment|building|property|vehicle|unit|retail|manufacturer|wholesale|member|membership|ticket|menu|product))\s*$/i;
const OTHER_THING_AFTER = /^\s+(?:of|for)\s+(?:the\s+|its\s+|their\s+|a\s+|an\s+|each\s+)?(?!business\b|company\b|shares?\b|deal\b|transaction\b|opportunity\b|practice\b|assets\b)[a-z]/i;
/** An amount a business sells for, or a multiple: "$4.8M", "$4,800,000", "4.8 million", "3.8x" — never "$189 per year". */
function isDealFigure(text: string): boolean {
  const m = text.match(/\$\s?(\d[\d,.]*)\s?(k|m|mm|million|thousand|b|billion)?\b|\b(\d[\d,.]*)\s?(million|mm|m)\b|\b\d+(?:\.\d+)?\s?[x×](?![a-z])/i);
  if (!m) return false;
  const after = text.slice((m.index ?? 0) + m[0].length);
  if (/^\s*(?:\/|per\b|a\s+(?:year|month|week|day|hour|visit|unit|member)|each\b|an\s+hour)/i.test(after)) return false;
  if (m[1] !== undefined && !m[2]) return Number(m[1].replace(/,/g, "")) >= 10000;
  return true;
}

/** The sentence states the deal's price, or a multiple of it. */
function statesPrice(sentence: string): boolean {
  if (DEAL_PRICE_TERM.test(sentence) && PRICE_FIGURE.test(sentence)) return true;
  if (statesDealMultiple(sentence, sentence)) return true;
  for (const m of Array.from(sentence.matchAll(OTHER_PRICE_TERM))) {
    const at = m.index ?? 0;
    const before = sentence.slice(0, at);
    const after = sentence.slice(at + m[0].length);
    if (/price$/i.test(m[0]) && (OTHER_THING_BEFORE.test(before) || OTHER_THING_AFTER.test(after))) continue;
    // "listed at $18M", "offered for sale at $4.8M": the figure follows at once.
    if (!/price$/i.test(m[0])) {
      if (/^\s*(?:about|approximately|roughly|around|just\s+(?:under|over)|under|over|an?\s+(?:asking\s+)?price\s+of)?\s*\$?\s?\d/i.test(after) && isDealFigure(after.slice(0, 40))) return true;
      continue;
    }
    // "the purchase price of $4.8M", "a purchase price is $4.8M", "a $4.8M purchase price": in the same clause.
    const clause = after.split(/[;:]|,\s|\s+(?:and|but|while|plus)\s+/)[0].slice(0, 60); // "$4,800,000" keeps its commas
    if (isDealFigure(clause) || isDealFigure(before.slice(-20))) return true;
  }
  return false;
}

/** Sentences of a paragraph: never split after "Ltd." / "Inc." / "St." ("Pacific Coast Logistics Ltd. is offered …" is one). */
const SENTENCE_BREAK = /(?<!\b(?:Ltd|Inc|Co|Corp|Ltée|Ltee|LLC|LLP|St|Ste|Dr|Mr|Mrs|Ms|Jr|Sr|No|vs|approx|est|[A-Z])\.)(?<=[.!?])\s+/;

/** Text without the sentences that state the price or its multiple. */
function withoutPriceSentences(text: string): string {
  if (!PRICE_MENTION.test(text) && !MULTIPLE_MENTION.test(text)) return text;
  return text
    .split(/(\n+)/)
    .map((part) => (/^\n+$/.test(part) ? part : part.split(SENTENCE_BREAK).filter((s) => !statesPrice(s)).join(" ")))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A row (key number, table row, term) whose label is the price or its multiple and that shows a figure. */
function isPriceRow(row: Record<string, unknown>): boolean {
  const labels = ROW_LABEL_KEYS.map((k) => row[k]).filter((v): v is string => typeof v === "string");
  const figures = Object.entries(row)
    .filter(([k]) => !ROW_LABEL_KEYS.includes(k))
    .map(([, v]) => (Array.isArray(v) ? v.join(" ") : String(v ?? "")))
    .join(" ");
  // "Revenue Multiple 1.45x", "SDE multiple | 3.8x | 2.5-3.5x" (this deal's column states it).
  if (labels.some((l) => statesDealMultiple(l, `${figures} ${l}`))) return true;
  // "Asking price", "Purchase price" rows with a price figure; never "Membership price $189/yr" or "Equipment purchase price".
  const label = labels.find((v) => DEAL_PRICE_TERM.test(v) || (PRICE_MENTION.test(v) && !/\bper\b|\/\s*(?:sq|ft|yr|year|month|unit)/i.test(v) && statesPrice(`${v} ${figures}`)));
  if (!label) return false;
  return PRICE_FIGURE.test(figures) || PRICE_FIGURE.test(label);
}

function scrubPrice(v: unknown, key: string, depth: number): unknown {
  if (depth > 8) return v;
  if (typeof v === "string") return withoutPriceSentences(v);
  if (Array.isArray(v)) {
    if (POSITIONAL.has(key)) return v.map((x) => scrubPrice(x, "", depth + 1));
    const out: unknown[] = [];
    for (const x of v) {
      if (x && typeof x === "object" && !Array.isArray(x) && isPriceRow(x as Record<string, unknown>)) continue;
      const next = scrubPrice(x, "", depth + 1);
      if (typeof x === "string" && x.trim() && next === "") continue;
      out.push(next);
    }
    return out;
  }
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = scrubPrice(x, k, depth + 1);
    return out;
  }
  return v;
}

/**
 * A key figure a callout shows on its own (primaryLabel / primaryValue):
 * "Asking Price / SDE 3.8x" or "Implied SDE multiple 3.8x" in a stat_callout
 * isn't a row, so the row check never saw it (free round 2 check, C7). The
 * first other stat takes its place; with none, the callout says the price is
 * on request.
 */
function withoutPriceCallout(d: Record<string, unknown>): Record<string, unknown> {
  const label = String(d.primaryLabel ?? "");
  const value = String(d.primaryValue ?? "");
  const states = statesDealMultiple(label, `${value} ${label}`) || ((DEAL_PRICE_TERM.test(label) || statesPrice(`${label} ${value}`)) && PRICE_FIGURE.test(`${value} ${label}`) && !ASKING_LABEL.test(label));
  if (!states) return d;
  const stats = Array.isArray(d.secondaryStats) ? (d.secondaryStats as unknown[]) : [];
  const next = stats.findIndex((x) => x && typeof x === "object" && String((x as Record<string, unknown>).label ?? "").trim() && String((x as Record<string, unknown>).value ?? "").trim());
  if (next >= 0) {
    const promoted = stats[next] as Record<string, unknown>;
    return withoutPriceCallout({ ...d, primaryLabel: promoted.label, primaryValue: promoted.value, secondaryStats: stats.filter((_x, i) => i !== next) });
  }
  if (typeof d.secondaryLabel === "string" && d.secondaryLabel.trim() && d.secondaryValue != null && String(d.secondaryValue).trim()) {
    const { secondaryLabel, secondaryValue, ...rest } = d;
    return { ...rest, primaryLabel: secondaryLabel, primaryValue: secondaryValue };
  }
  return { ...d, primaryLabel: "Asking price", primaryValue: PRICE_ON_REQUEST };
}

/** A section with every statement of the price, or of a multiple of it, taken out (its data and its prose). */
function withoutPriceMentions<T extends { layoutType: string; layoutData: unknown }>(section: T): T {
  const s = section as T & { aiDraftContent?: unknown; brokerEditedContent?: unknown };
  const json = JSON.stringify([s.layoutData ?? null, s.aiDraftContent ?? null, s.brokerEditedContent ?? null]);
  if (!PRICE_MENTION.test(json) && !MULTIPLE_MENTION.test(json)) return section;
  const data = s.layoutData && typeof s.layoutData === "object" && !Array.isArray(s.layoutData) && "primaryLabel" in (s.layoutData as object)
    ? withoutPriceCallout(s.layoutData as Record<string, unknown>)
    : s.layoutData;
  const out = { ...section, layoutData: data && typeof data === "object" ? scrubPrice(data, "", 0) : data } as T & {
    aiDraftContent?: unknown;
    brokerEditedContent?: unknown;
  };
  if (typeof s.aiDraftContent === "string") out.aiDraftContent = withoutPriceSentences(s.aiDraftContent);
  if (typeof s.brokerEditedContent === "string") out.brokerEditedContent = withoutPriceSentences(s.brokerEditedContent);
  return out;
}

/** The neutral key a blind buyer sees for a section (never derived from its title). */
export function blindSectionKey(sectionId: string): string {
  return `s_${String(sectionId).replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase()}`;
}

/** Neutral blind key → the section's real key, for analytics sent from a blind view. */
export function realSectionKeyMap(sections: Array<{ id: string; sectionKey: string }>): Map<string, string> {
  return new Map(sections.map((s) => [blindSectionKey(s.id), s.sectionKey]));
}

type DealLike = { id: string; businessName?: string | null; extractedInfo?: unknown; blindCodename?: string | null; isLive?: boolean | null };

function writingInProgress(s: CimSection): boolean {
  const t = s.aiTask as { kind?: string; status?: string } | null;
  return !!t && t.kind === "write" && t.status !== "ready";
}

/**
 * Pure: build the buyer's sections from the deal's rows. `overrides` must be
 * the rows for the buyer's mode (blind or dd; ignored for normal).
 */
export function buildBuyerCim(input: BuyerCimInput): BuyerCim {
  return buildBuyerSections(input);
}

interface BuyerCimInput {
  deal: DealLike;
  accessLevel: string | null | undefined;
  sections: CimSection[];
  overrides: CimSectionOverride[];
  /**
   * The deal's media library (id, kind, blind-safe). Omitted = unknown: the
   * Blind CIM then shows no uploads at all.
   */
  media?: MediaAssetRef[] | null;
  /**
   * The broker's listed asking price now (server: listedAskingPrice) — the
   * cover and key numbers show it. `null` means the deal has no listed price
   * any more: a price the CIM stored is taken off them. Omitted = unknown
   * (the CIM's own figures are shown).
   */
  askingPrice?: string | null;
  /**
   * The recorded approved versions of the deal's sections (overrides under
   * the "published*" modes — shared/cim-published.ts). On a live CIM a
   * section changed since its approval is served from them. Omitted (a
   * broker preview) = every section as it stands.
   */
  published?: CimSectionOverride[] | null;
}

function buildBuyerSections(raw: BuyerCimInput): BuyerCim {
  // A Teaser link reads the teaser only — never a CIM section (the single
  // authority: every buyer path builds through here). Unknown / empty levels
  // normalise to teaser_only, so they get nothing too.
  if (!seesCim(raw.accessLevel)) return { mode: "blind", sections: [], preparing: false, heldBack: 0, leaked: [], leakReasons: {} };
  const mode = cimModeForAccessLevel(raw.accessLevel);
  // On a live CIM, changes the broker hasn't approved yet stay off buyers:
  // the section's last approved version is served instead (cim-published).
  const served = servedVersions({ deal: raw.deal, mode, sections: raw.sections, overrides: raw.overrides, published: raw.published });
  const input: BuyerCimInput = { ...raw, sections: served.sections, overrides: served.overrides };
  const { deal } = input;
  // The figures as they stand now, applied to each section BEFORE the Blind
  // identity check so the check sees exactly what the buyer receives:
  // charts written before they carried their stated total get it back when
  // the facts state the whole their slices make (withStatedChartTotal), and
  // the cover / key numbers show the broker's listed price. In the Blind CIM
  // a listed price the broker typed as words that identify the business
  // ("$2.1M plus Harbourline Dental Group's building") is never injected —
  // the redacted section keeps its own figure.
  const amounts = factAmounts(deal.extractedInfo);
  let price = listedPriceText(input.askingPrice);
  if (price && mode === "blind") {
    const terms = blindLeakTerms(deal as any, { codename: deal.blindCodename || "Confidential Opportunity" });
    if (findBlindLeaks(price, terms).length > 0 || blindPlaceholders(price).length > 0) price = null;
  }
  // No listed price any more (the broker deleted it — the seller went
  // unpriced): the figure the CIM stored is taken off the cover and the key
  // numbers, never left in front of buyers until a regenerate.
  const priceRemoved = input.askingPrice === null;
  const withCurrentFigures = (s: BuyerSection): BuyerSection => {
    if (s.locked) return s;
    const withTotal = withStatedChartTotal(s, amounts);
    if (priceRemoved) return withoutAskingPrice(withTotal);
    return price ? withListedAskingPrice(withTotal, price) : withTotal;
  };
  const assets = input.media ? new Map(input.media.map((m) => [m.id, m])) : null;
  const mediaIdentifiers = mode === "blind"
    ? [...blindIdentifiers(deal as any), ...dealAddressFragments((deal as any).extractedInfo)]
    : [];
  /** A media section's buyer data, or null when it has nothing to show. */
  const mediaData = (s: CimSection, override: unknown): unknown | null =>
    isMediaLayout(s.layoutType)
      ? buyerMediaLayoutData(s.layoutType, s.layoutData, override, mode, { assets, identifiers: mediaIdentifiers })
      : s.layoutData;
  const visible = [...input.sections]
    // A placeholder for a section the AI couldn't write is broker
    // instructions, not content — never served, even if made visible. Nor is
    // a blank layout's sample data ("Category A 60 / B 40" reads as a real split).
    .filter((s) => s.isVisible !== false && !writingInProgress(s) && !isCimFallbackSection(s) && !hasSampleData(s))
    .sort((a, b) => a.order - b.order);

  const base = (s: CimSection): BuyerSection => ({
    id: s.id,
    dealId: s.dealId,
    sectionKey: s.sectionKey,
    sectionTitle: s.sectionTitle,
    order: s.order,
    layoutType: s.layoutType,
    layoutData: withoutAiPreparedBy(s.layoutType, s.layoutData),
    aiDraftContent: s.aiDraftContent ?? null,
    brokerEditedContent: s.brokerEditedContent ?? null,
    isVisible: true,
  });

  if (mode === "normal") {
    const sections: BuyerSection[] = [];
    for (const s of visible) {
      const data = mediaData(s, null);
      if (data) sections.push(withCurrentFigures({ ...base(s), layoutData: withoutAiPreparedBy(s.layoutType, data) }));
    }
    return { mode, sections, preparing: false, heldBack: 0, leaked: [], leakReasons: {} };
  }

  const overrideMap = new Map(input.overrides.map((o) => [String(o.cimSectionId), o]));

  if (mode === "dd") {
    // A due-diligence buyer has full-identity access: a section without a DD
    // override (e.g. edited since DD was generated) is served as Normal.
    // Media sections are served from their base data (DD adds nothing to a
    // photo or a map, and the enricher must not touch their references).
    const sections: BuyerSection[] = [];
    for (const s of visible) {
      if (isMediaLayout(s.layoutType)) {
        const data = mediaData(s, null);
        if (data) sections.push(withCurrentFigures({ ...base(s), layoutData: data, aiDraftContent: null, brokerEditedContent: null }));
        continue;
      }
      // A DD version written before the section's last edit is stale: the
      // current named content is served until the broker refreshes it.
      const o = s.ddStaleAt ? undefined : overrideMap.get(s.id);
      sections.push(withCurrentFigures(o ? { ...base(s), ...pick(applySectionOverride(s, o, "dd")) } : base(s)));
    }
    return { mode, sections, preparing: false, heldBack: 0, leaked: [], leakReasons: {} };
  }

  // ── Blind ──
  // No Blind version at all yet (a live CIM's section held back for want of
  // an approved Blind version is not that — raw.overrides has the deal's).
  if (input.overrides.length === 0 && raw.overrides.length === 0) {
    return { mode, sections: [], preparing: visible.length > 0, heldBack: 0, leaked: [], leakReasons: {} };
  }
  const codename = deal.blindCodename || "Confidential Opportunity";
  const redactTitle = blindTitleRedactor(deal as any, codename);
  const leakTerms = blindLeakTerms(deal as any, { codename });

  const out: BuyerSection[] = [];
  let heldBack = 0;
  const leaked: string[] = [];
  const leakReasons: Record<string, string> = {};
  // Real key → neutral key, for every section (relatedSections point at keys).
  const keyMap = new Map(visible.map((s) => [s.sectionKey, blindSectionKey(s.id)]));
  /** Serve it only if nothing identifying is left in what the buyer receives. */
  const serve = (s: CimSection, served: BuyerSection) => {
    const section = withCurrentFigures(served);
    // relatedSections carry the real (title-derived) keys — switch them to
    // neutral ones before the check; unknown keys are dropped.
    const data = section.layoutData as Record<string, unknown> | null;
    if (data && Array.isArray(data.relatedSections)) {
      section.layoutData = {
        ...data,
        relatedSections: (data.relatedSections as unknown[])
          .map((k) => (typeof k === "string" ? keyMap.get(k) ?? null : null))
          .filter((k): k is string => !!k),
      };
    }
    const texts = [section.sectionTitle, section.aiDraftContent ?? "", section.brokerEditedContent ?? "", checkedData(s, section.layoutData)];
    const leaks = findBlindLeaks(texts, leakTerms);
    const placeholders = leaks.length ? [] : blindPlaceholders(texts, [s.sectionTitle, s.aiDraftContent ?? "", s.brokerEditedContent ?? "", ...collectStrings(s.layoutData)]);
    if (leaks.length > 0 || placeholders.length > 0) {
      heldBack++;
      leaked.push(s.id);
      leakReasons[s.id] = leaks.length > 0
        ? `it still named ${leaks.slice(0, 3).map((l) => `"${l}"`).join(", ")}`
        : `it kept placeholders such as ${placeholders.slice(0, 2).join(", ")}`;
      return;
    }
    out.push(section);
  };
  visible.forEach((s) => {
    if (getCimLayout(s.layoutType)?.blind === "exclude") return;
    const o = overrideMap.get(s.id);
    if (!o || s.blindStaleAt) {
      heldBack++;
      return;
    }
    const safeKey = blindSectionKey(s.id);
    const title = redactTitle((s.blindTitle || s.sectionTitle || "").trim());
    if (isMediaLayout(s.layoutType)) {
      // Built from the base items + the redacted words, never the AI's refs.
      const data = mediaData(s, o.layoutData);
      if (!data) return;
      serve(s, { ...base(s), layoutData: data, aiDraftContent: null, brokerEditedContent: null, sectionKey: safeKey, sectionTitle: title });
      return;
    }
    serve(s, { ...base(s), ...pick(applySectionOverride(s, o, "blind")), sectionKey: safeKey, sectionTitle: title });
  });

  // relatedSections links to sections the buyer can't open are dropped.
  const servedKeys = new Set(out.filter((s) => !s.locked).map((s) => s.sectionKey));
  for (const s of out) {
    const data = s.layoutData as Record<string, unknown> | null;
    if (!data || !Array.isArray(data.relatedSections)) continue;
    s.layoutData = { ...data, relatedSections: (data.relatedSections as string[]).filter((k) => servedKeys.has(k)) };
  }

  return { mode, sections: out, preparing: false, heldBack, leaked, leakReasons };
}

/**
 * What of a served blind section the identity check reads: everything,
 * except a map's regions — those are computed from the address
 * (regionFromAddress: a province/state or country only), never written by
 * the AI, and "British Columbia" must not hold the map back forever.
 */
function checkedData(s: CimSection, data: unknown): unknown {
  if (s.layoutType !== "location_map" || !data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.locations)) return data;
  return {
    ...d,
    locations: (d.locations as unknown[]).map((l) => {
      if (!l || typeof l !== "object") return l;
      const { region: _r, ...rest } = l as Record<string, unknown>;
      return rest;
    }),
  };
}

/**
 * Cover "Prepared by" is presentation-only (the renderer shows the
 * brokerage from its settings). Older covers carry an AI-filled value —
 * once the seller's accountant — so it never leaves the server.
 */
function withoutAiPreparedBy(layoutType: string, layoutData: unknown): unknown {
  if (layoutType !== "cover_page" || !layoutData || typeof layoutData !== "object" || !("preparedBy" in (layoutData as object))) return layoutData;
  const { preparedBy: _p, ...rest } = layoutData as Record<string, unknown>;
  return rest;
}

function pick(s: { layoutType?: string; layoutData?: unknown; aiDraftContent?: string | null; brokerEditedContent?: string | null }) {
  return {
    layoutData: withoutAiPreparedBy(s.layoutType ?? "", s.layoutData),
    aiDraftContent: s.aiDraftContent ?? null,
    brokerEditedContent: s.brokerEditedContent ?? null,
  };
}
