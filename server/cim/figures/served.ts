/**
 * served — what buyers of each CIM version are actually served of the figure
 * layer right now (checker r1 F3; spec §4.8 "Kept copy of a live CIM under
 * review": anchors are computed on the sections buyers are served).
 *
 * The workspace and the CIM tab must never say "Shown to buyers" about a note
 * buyers don't read. While a live CIM's update waits for the broker, buyers
 * read the kept copy (or a section's last approved version), whose pages can
 * differ from the working copy: a row relabelled "General & administrative
 * expenses" anchors nothing, so its notes and checks reach nobody until the
 * update is published. So each version is built exactly as the view room
 * builds it (buyerCimRows → buildBuyerCim with the buyer's figure inputs) and
 * read back: the figures on its pages, the notes it serves, the DD checks it
 * serves and its check page's counts — and, while buyers read something other
 * than the working copy, the same for the update once published.
 *
 *   levelServing(mode)                  a stored level that reads as that version (no literals)
 *   servedFiguresOf(deal, raw, rows)    pure
 *   servedFigures(deal, raw)            loads the rows (IO)
 */
import type { CimSection, CimSectionOverride, Deal } from "@shared/schema";
import { buildBuyerCim, cimHeldFromBuyers } from "@shared/cim-buyer-view";
import { cimModeForAccessLevel as servedModeOf } from "@shared/cim-layouts";
import { BLIND_ACCESS_LEVEL, DD_ACCESS_LEVEL, LEGACY_ACCESS_LEVELS, NAMED_ACCESS_LEVEL } from "@shared/access-levels";
import { anchorFigures } from "@shared/figure-anchors";
import { DD_SOURCE_CHECK_PAGE_ID, type FigureInputs, type FigureLayer } from "@shared/figure-layer";
import type { WorkspaceServed, WorkspaceServedSummary } from "@shared/figure-workspace";
import { figureIdFor, figureInputsFor, type FigureRaw } from "./serve";

export type CimVersion = "normal" | "blind" | "dd";
export const CIM_VERSIONS: readonly CimVersion[] = ["normal", "blind", "dd"];

/**
 * A level `buildBuyerCim` reads as this version, before and after the
 * access-level registry merges (INTEGRATION §2.1: no level literals — the
 * legacy keys come from the registry's own table).
 */
export function levelServing(mode: CimVersion): string {
  const want = mode === "dd" ? DD_ACCESS_LEVEL : mode === "normal" ? NAMED_ACCESS_LEVEL : BLIND_ACCESS_LEVEL;
  const legacy = Object.entries(LEGACY_ACCESS_LEVELS).filter(([, v]) => v === want).map(([k]) => k);
  return [want, ...legacy].find((l) => servedModeOf(l) === mode) ?? want;
}

export interface ServedVersion {
  /** Figure keys on the pages buyers of this version read (the DD check page excluded). */
  anchored: Set<string>;
  /** Note rows buyers of this version read (worked-out check text has no row). */
  noteIds: Set<string>;
  /** DD: the checks buyers read. */
  checkKeys: Set<string>;
  /** DD: the check page's counts as buyers read it (null when the checks are off or there are none). */
  summary: FigureLayer["summary"] | null;
  /** The Blind CIM's notes were held back by the identity check (why), or null. */
  dropped: string | null;
}

export interface ServedFigures {
  /** Buyers read the kept copy of a live CIM while its update waits for the broker. */
  keptCopy: boolean;
  /** The CIM is held from every buyer (an update failed its checks): nothing is served. */
  held: boolean;
  now: Record<CimVersion, ServedVersion>;
  /** The same once the update is published (the working copy) — null when buyers already read it. */
  afterPublish: Record<CimVersion, ServedVersion> | null;
  /** DD: what turning the checks on would show on the pages DD buyers read now. */
  ddIfOn: NonNullable<FigureLayer["summary"]> | null;
}

/** The rows one version is built from (what buyerCimRows returns). */
export interface VersionRows {
  sections: CimSection[];
  overrides: CimSectionOverride[];
  published: CimSectionOverride[] | null;
  missing?: boolean;
}

export interface ServedRows {
  keptCopy: boolean;
  /** The codename buyers of the kept copy know the deal by (else the deal's own). */
  keptCodename: string | null;
  askingPrice: string | null | undefined;
  now: Record<CimVersion, VersionRows>;
  /** The working copy per version (sections + that version's overrides), when buyers read something else. */
  update: Record<CimVersion, VersionRows> | null;
}

const empty = (): ServedVersion => ({ anchored: new Set(), noteIds: new Set(), checkKeys: new Set(), summary: null, dropped: null });

type DealLike = Pick<Deal, "id" | "businessName" | "blindCodename" | "extractedInfo"> & { isLive?: boolean | null; cimGeneration?: unknown };

/** One version as buyers get it from these rows. */
function versionOf(deal: DealLike, raw: FigureRaw, mode: CimVersion, rows: VersionRows, opts: { askingPrice?: string | null; codename?: string | null; inputs?: FigureInputs | null }): ServedVersion {
  if (rows.missing) return empty();
  const inputs = opts.inputs !== undefined ? opts.inputs : figureInputsFor(raw, { audience: "buyer", mode });
  const servedDeal = opts.codename ? { ...deal, blindCodename: opts.codename } : deal;
  const cim = buildBuyerCim({
    deal: servedDeal as any, accessLevel: levelServing(mode), sections: rows.sections, overrides: rows.overrides, media: [],
    ...(opts.askingPrice !== undefined ? { askingPrice: opts.askingPrice } : {}), published: rows.published, figures: inputs,
  });
  const out = empty();
  if (cim.preparing) return out;
  for (const s of cim.sections) {
    if (s.id === DD_SOURCE_CHECK_PAGE_ID || (s as { locked?: boolean }).locked) continue;
    for (const a of anchorFigures(s as any, raw.registry)) out.anchored.add(a.figureKey);
  }
  out.dropped = cim.figureLayerDropped ?? null;
  const layer = cim.figureLayer;
  if (!layer) return out;
  const checkIds = new Map(raw.checks.checks.map((c) => [figureIdFor(raw.dealId, c.key), c.key]));
  for (const f of Object.values(layer.figures)) {
    if (f.why && !f.why.id.includes("#")) out.noteIds.add(f.why.id);
    for (const p of f.parts ?? []) if (p.why && !p.why.id.includes("#")) out.noteIds.add(p.why.id);
    for (const c of f.checks ?? []) {
      const key = checkIds.get(c.id);
      if (key) out.checkKeys.add(key);
      if (c.note && !c.note.id.includes("#")) out.noteIds.add(c.note.id);
    }
  }
  out.summary = mode === "dd" && layer.ddChecksOn && (layer.summary?.checked ?? 0) > 0 ? layer.summary! : null;
  return out;
}

/** Pure: each version as buyers are served it now, and once the update is published. */
export function servedFiguresOf(deal: DealLike, raw: FigureRaw, rows: ServedRows): ServedFigures {
  const held = cimHeldFromBuyers(deal);
  const now = {} as Record<CimVersion, ServedVersion>;
  for (const mode of CIM_VERSIONS) {
    now[mode] = held ? empty() : versionOf(deal, raw, mode, rows.now[mode], { askingPrice: rows.askingPrice, codename: rows.keptCopy ? rows.keptCodename : null });
  }
  let afterPublish: ServedFigures["afterPublish"] = null;
  if (rows.update) {
    afterPublish = {} as Record<CimVersion, ServedVersion>;
    for (const mode of CIM_VERSIONS) afterPublish[mode] = versionOf(deal, raw, mode, rows.update[mode], { askingPrice: rows.askingPrice });
  }
  // DD with the checks on, on the pages DD buyers read now (the CIM tab's count while they're off).
  let ddIfOn: ServedFigures["ddIfOn"] = null;
  const ddInputs = figureInputsFor(raw, { audience: "buyer", mode: "dd" });
  if (!held && ddInputs) {
    const on = versionOf(deal, raw, "dd", rows.now.dd, {
      askingPrice: rows.askingPrice, codename: rows.keptCopy ? rows.keptCodename : null,
      inputs: { ...ddInputs, ddShownAt: ddInputs.ddShownAt ?? new Date().toISOString() },
    });
    ddIfOn = on.summary ?? null;
  }
  return { keptCopy: rows.keptCopy, held, now, afterPublish, ddIfOn };
}

/** The rows of every version, as the view room reads them (IO). */
export async function loadServedRows(deal: Deal): Promise<ServedRows> {
  const [{ buyerCimRows, servedBlindCodename }, { storage }, { listedAskingPrice }] = await Promise.all([
    import("../published-snapshot"),
    import("../../storage"),
    import("../../information/deal-mirror"),
  ]);
  const [normal, blind, dd, keptCodename] = await Promise.all([
    buyerCimRows(deal, levelServing("normal")),
    buyerCimRows(deal, levelServing("blind")),
    buyerCimRows(deal, levelServing("dd")),
    servedBlindCodename(deal),
  ]);
  const now = { normal, blind, dd };
  // Buyers read something other than the working copy (the kept copy, or a live CIM's last
  // approved versions): the update, as it will serve once published.
  const differs = normal.fromSnapshot || !!deal.isLive;
  let update: ServedRows["update"] = null;
  if (differs) {
    const [sections, blindOverrides, ddOverrides] = await Promise.all([
      storage.getCimSectionsByDeal(deal.id),
      storage.getCimSectionOverrides(deal.id, "blind"),
      storage.getCimSectionOverrides(deal.id, "dd"),
    ]);
    update = {
      normal: { sections: sections as CimSection[], overrides: [], published: null },
      blind: { sections: sections as CimSection[], overrides: blindOverrides as CimSectionOverride[], published: null },
      dd: { sections: sections as CimSection[], overrides: ddOverrides as CimSectionOverride[], published: null },
    };
  }
  return { keptCopy: normal.fromSnapshot, keptCodename, askingPrice: listedAskingPrice(deal), now, update };
}

/** Every version as buyers are served it now (null on any failure: the workspace then reads the working copy). */
export async function servedFigures(deal: Deal, raw: FigureRaw): Promise<ServedFigures | null> {
  try {
    return servedFiguresOf(deal, raw, await loadServedRows(deal));
  } catch (err) {
    console.warn(`[figures] served versions for deal ${deal.id}:`, (err as Error)?.message);
    return null;
  }
}

/** The workspace's summary of what each version serves (counts only; broker-only payload). */
export function servedSummary(s: ServedFigures): WorkspaceServed {
  const later = (mode: CimVersion) => s.afterPublish
    ? Array.from(s.afterPublish[mode].noteIds).filter((id) => !s.now[mode].noteIds.has(id)).length
    : 0;
  const sum = (x: FigureLayer["summary"] | null | undefined): WorkspaceServedSummary | null => x ? { ...x } : null;
  return {
    keptCopy: s.keptCopy,
    held: s.held,
    normal: { notes: s.now.normal.noteIds.size, afterPublish: later("normal"), dropped: null },
    blind: { notes: s.now.blind.noteIds.size, afterPublish: later("blind"), dropped: s.now.blind.dropped },
    dd: { notes: s.now.dd.noteIds.size, afterPublish: later("dd"), dropped: null, summary: sum(s.now.dd.summary), summaryIfOn: sum(s.ddIfOn) },
  };
}
