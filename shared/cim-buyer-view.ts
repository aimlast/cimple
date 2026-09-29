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
 *   - Access level → version: teaser/full → Blind, loi → Normal,
 *     due_diligence → DD.
 *   - Blind: a section is served only with an up-to-date redacted override
 *     (override present AND blindStaleAt null). Anything else is held back
 *     (and the caller triggers re-redaction). No override at all for the deal
 *     → the "preparing" holding state. Layouts whose blind policy is
 *     "exclude" are never served blind.
 *   - Tiers: a teaser buyer gets sections marked "full" as locked stubs —
 *     redacted title only, no content.
 *   - Fail closed: a blind section (or stub title) that still contains
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
  LOCKED_LAYOUT_TYPE,
  applySectionOverride,
  hasSampleData,
  isCimFallbackSection,
  cimModeForAccessLevel,
  getCimLayout,
  sectionTier,
} from "./cim-layouts";
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
 * True while a regenerated CIM waits for the broker to publish it: it
 * replaced one buyers could open, so no buyer path (view room, Q&A chatbot,
 * media) serves anything from it until then (server/cim/generation-jobs.ts).
 */
export function cimHeldFromBuyers(deal: { cimGeneration?: unknown }): boolean {
  const g = deal.cimGeneration as { buyerHold?: unknown } | null | undefined;
  return !!g?.buyerHold;
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
/** A figure such wording can give away: an amount or a multiple. */
const PRICE_FIGURE = /\$\s?\d|\b\d[\d,.]*\s?(?:k|m|mm|million|thousand)\b|\b\d+(?:\.\d+)?\s?[x×](?![a-z])|\b\d{1,3}(?:,\d{3})+\b/i;
/** Arrays whose entries are columns (a table's cells): emptied in place, never dropped. */
const POSITIONAL = new Set(["values", "headers", "columns", "cells"]);
const ROW_LABEL_KEYS = ["label", "name", "title", "term", "metric", "key", "primaryLabel"];

const statesPrice = (s: string) => PRICE_MENTION.test(s) && PRICE_FIGURE.test(s);

/** Text without the sentences that state the price or its multiple. */
function withoutPriceSentences(text: string): string {
  if (!PRICE_MENTION.test(text)) return text;
  return text
    .split(/(\n+)/)
    .map((part) => (/^\n+$/.test(part) ? part : part.split(/(?<=[.!?])\s+/).filter((s) => !statesPrice(s)).join(" ")))
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A row (key number, table row, term) whose label is the price or its multiple and that shows a figure. */
function isPriceRow(row: Record<string, unknown>): boolean {
  const label = ROW_LABEL_KEYS.map((k) => row[k]).find((v) => typeof v === "string" && PRICE_MENTION.test(v)) as string | undefined;
  if (!label) return false;
  return Object.entries(row).some(([k, v]) => !ROW_LABEL_KEYS.includes(k) && PRICE_FIGURE.test(Array.isArray(v) ? v.join(" ") : String(v ?? ""))) || PRICE_FIGURE.test(label);
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

/** A section with every statement of the price, or of a multiple of it, taken out (its data and its prose). */
function withoutPriceMentions<T extends { layoutType: string; layoutData: unknown }>(section: T): T {
  const s = section as T & { aiDraftContent?: unknown; brokerEditedContent?: unknown };
  const json = JSON.stringify([s.layoutData ?? null, s.aiDraftContent ?? null, s.brokerEditedContent ?? null]);
  if (!PRICE_MENTION.test(json)) return section;
  const out = { ...section, layoutData: s.layoutData && typeof s.layoutData === "object" ? scrubPrice(s.layoutData, "", 0) : s.layoutData } as T & {
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
  const mode = cimModeForAccessLevel(raw.accessLevel);
  // On a live CIM, changes the broker hasn't approved yet stay off buyers:
  // the section's last approved version is served instead (cim-published).
  const served = servedVersions({ deal: raw.deal, mode, sections: raw.sections, overrides: raw.overrides, published: raw.published });
  const input: BuyerCimInput = { ...raw, sections: served.sections, overrides: served.overrides };
  const { deal, accessLevel } = input;
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
  const teaser = (accessLevel ?? "teaser") === "teaser";

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
    if (teaser && sectionTier(s) === "full") {
      serve(s, {
        id: s.id,
        dealId: s.dealId,
        sectionKey: safeKey,
        sectionTitle: title,
        order: s.order,
        layoutType: LOCKED_LAYOUT_TYPE,
        layoutData: {},
        aiDraftContent: null,
        brokerEditedContent: null,
        isVisible: true,
        locked: true,
      });
      return;
    }
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
