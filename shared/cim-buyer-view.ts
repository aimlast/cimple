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
 *   - Blind section keys that contain a known business name are replaced
 *     (keys reach the page as data attributes and analytics ids).
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
}

type DealLike = { id: string; businessName?: string | null; extractedInfo?: unknown; blindCodename?: string | null };

function writingInProgress(s: CimSection): boolean {
  const t = s.aiTask as { kind?: string; status?: string } | null;
  return !!t && t.kind === "write" && t.status !== "ready";
}

const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");

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
    layoutData: s.layoutData,
    aiDraftContent: s.aiDraftContent ?? null,
    brokerEditedContent: s.brokerEditedContent ?? null,
    isVisible: true,
  });

  if (mode === "normal") {
    const sections: BuyerSection[] = [];
    for (const s of visible) {
      const data = mediaData(s, null);
      if (data) sections.push({ ...base(s), layoutData: data });
    }
    return { mode, sections, preparing: false, heldBack: 0 };
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
      const o = overrideMap.get(s.id);
      sections.push(o ? { ...base(s), ...pick(applySectionOverride(s, o, "dd")) } : base(s));
    }
    return { mode, sections, preparing: false, heldBack: 0 };
  }

  // ── Blind ──
  if (input.overrides.length === 0) {
    return { mode, sections: [], preparing: visible.length > 0, heldBack: 0 };
  }
  const codename = deal.blindCodename || "Confidential Opportunity";
  const redactTitle = blindTitleRedactor(deal as any, codename);
  const identifiers = blindIdentifiers(deal as any).map(norm).filter((n) => n.length >= 4);
  const teaser = (accessLevel ?? "teaser") === "teaser";

  const out: BuyerSection[] = [];
  let heldBack = 0;
  const keyMap = new Map<string, string>();
  visible.forEach((s, i) => {
    if (getCimLayout(s.layoutType)?.blind === "exclude") return;
    const o = overrideMap.get(s.id);
    if (!o || s.blindStaleAt) {
      heldBack++;
      return;
    }
    const nk = norm(s.sectionKey);
    const safeKey = identifiers.some((id) => nk.includes(id)) ? `section_${i + 1}` : s.sectionKey;
    if (safeKey !== s.sectionKey) keyMap.set(s.sectionKey, safeKey);
    const title = redactTitle((s.blindTitle || s.sectionTitle || "").trim());
    if (teaser && sectionTier(s) === "full") {
      out.push({
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
      out.push({ ...base(s), layoutData: data, aiDraftContent: null, brokerEditedContent: null, sectionKey: safeKey, sectionTitle: title });
      return;
    }
    out.push({ ...base(s), ...pick(applySectionOverride(s, o, "blind")), sectionKey: safeKey, sectionTitle: title });
  });

  // relatedSections links follow renamed keys; links to sections the buyer
  // can't see are dropped.
  const servedKeys = new Set(out.filter((s) => !s.locked).map((s) => s.sectionKey));
  for (const s of out) {
    const data = s.layoutData as Record<string, unknown> | null;
    if (!data || !Array.isArray(data.relatedSections)) continue;
    const related = (data.relatedSections as unknown[])
      .map((k) => (typeof k === "string" ? keyMap.get(k) ?? k : null))
      .filter((k): k is string => !!k && servedKeys.has(k));
    s.layoutData = { ...data, relatedSections: related };
  }

  return { mode, sections: out, preparing: false, heldBack };
}

function pick(s: { layoutData?: unknown; aiDraftContent?: string | null; brokerEditedContent?: string | null }) {
  return {
    layoutData: s.layoutData,
    aiDraftContent: s.aiDraftContent ?? null,
    brokerEditedContent: s.brokerEditedContent ?? null,
  };
}
