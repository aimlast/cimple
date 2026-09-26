/**
 * cim-buyer-view — exactly which CIM sections a buyer may receive, and in
 * which form. The single authority for the view room (GET /api/view/:token)
 * and the buyer Q&A chatbot, so the two can never disagree.
 *
 * Rules (server-side — the browser is never trusted to hide anything):
 *   - Hidden sections, and sections the AI is still writing, never leave
 *     the server.
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
  cimModeForAccessLevel,
  getCimLayout,
  sectionTier,
} from "./cim-layouts";
import { blindIdentifiers, blindTitleRedactor } from "./blind-identifiers";
import { blindLeakTerms, blindPlaceholders, collectStrings, findBlindLeaks } from "./blind-guard";
import { buyerMediaLayoutData, dealAddressFragments, isMediaLayout, type MediaAssetRef } from "./cim-media";

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

/** The neutral key a blind buyer sees for a section (never derived from its title). */
export function blindSectionKey(sectionId: string): string {
  return `s_${String(sectionId).replace(/[^a-z0-9]/gi, "").slice(0, 12).toLowerCase()}`;
}

/** Neutral blind key → the section's real key, for analytics sent from a blind view. */
export function realSectionKeyMap(sections: Array<{ id: string; sectionKey: string }>): Map<string, string> {
  return new Map(sections.map((s) => [blindSectionKey(s.id), s.sectionKey]));
}

type DealLike = { id: string; businessName?: string | null; extractedInfo?: unknown; blindCodename?: string | null };

function writingInProgress(s: CimSection): boolean {
  const t = s.aiTask as { kind?: string; status?: string } | null;
  return !!t && t.kind === "write" && t.status !== "ready";
}

/**
 * Pure: build the buyer's sections from the deal's rows. `overrides` must be
 * the rows for the buyer's mode (blind or dd; ignored for normal).
 */
export function buildBuyerCim(input: {
  deal: DealLike;
  accessLevel: string | null | undefined;
  sections: CimSection[];
  overrides: CimSectionOverride[];
  /**
   * The deal's media library (id, kind, blind-safe). Omitted = unknown: the
   * Blind CIM then shows no uploads at all.
   */
  media?: MediaAssetRef[] | null;
}): BuyerCim {
  const { deal, accessLevel } = input;
  const mode = cimModeForAccessLevel(accessLevel);
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
    .filter((s) => s.isVisible !== false && !writingInProgress(s))
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
      if (data) sections.push({ ...base(s), layoutData: withoutAiPreparedBy(s.layoutType, data) });
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
        if (data) sections.push({ ...base(s), layoutData: data, aiDraftContent: null, brokerEditedContent: null });
        continue;
      }
      // A DD version written before the section's last edit is stale: the
      // current named content is served until the broker refreshes it.
      const o = s.ddStaleAt ? undefined : overrideMap.get(s.id);
      sections.push(o ? { ...base(s), ...pick(applySectionOverride(s, o, "dd")) } : base(s));
    }
    return { mode, sections, preparing: false, heldBack: 0, leaked: [], leakReasons: {} };
  }

  // ── Blind ──
  if (input.overrides.length === 0) {
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
  const serve = (s: CimSection, section: BuyerSection) => {
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
