/**
 * cim-published — on a live CIM, buyers keep the last APPROVED version of a
 * section until the broker approves the change.
 *
 * Why (free round 2, C1): on a live CIM an AI regenerate, a layout convert,
 * "Start it blank", an undo or the broker's own edit wrote straight onto the
 * section buyers were reading. The section was un-ticked, but the view room
 * served every visible section whatever its tick said, so LOI and DD buyers
 * got unreviewed AI text on their next load — or a donut titled "Revenue by
 * customer" reading "Category A 60% / Category B 40%" (the blank layout's
 * sample data) — while the Overview still said the CIM was live and
 * approved. The "awaiting approval" tick changed nothing buyers received.
 *
 * The rule now:
 *   - Whenever a section is approved (the broker's tick, "Approve all", the
 *     design approval, the pre-rule backfill) the version it was approved
 *     in is recorded (server/cim/published-versions.ts): its content
 *     ("published"), its redacted Blind version when that is up to date
 *     ("published_blind") and its DD version when that is up to date
 *     ("published_dd"). A Blind or DD version written later for a section
 *     still approved as it stands is recorded then. They are rows of
 *     cim_section_overrides under those modes (no schema change).
 *   - On a LIVE CIM, a shown section that isn't approved as it stands is
 *     served from that record: the same version the buyer already had.
 *     With no record (a section never approved) it isn't served at all.
 *     Blind buyers without a recorded Blind version get it held back, as
 *     while any redaction is catching up; DD buyers without a recorded DD
 *     version get the recorded named version.
 *   - Approving the section again serves the change (and records it).
 *   - A section of a CIM that went live before the per-section rule, and
 *     untouched since, counts as approved (shared/cim-approvals
 *     legacyLiveApprovedIds) and is served as it stands.
 *
 * Pure — no server or browser dependencies.
 */
import type { CimSection, CimSectionOverride } from "./schema";
import { legacyLiveApprovedIds } from "./cim-approvals";

export const PUBLISHED_MODE = "published" as const;
export const PUBLISHED_BLIND_MODE = "published_blind" as const;
export const PUBLISHED_DD_MODE = "published_dd" as const;
export const PUBLISHED_MODES = [PUBLISHED_MODE, PUBLISHED_BLIND_MODE, PUBLISHED_DD_MODE] as const;

/** The approved named version of a section (stored in the override row's layoutData). */
export interface PublishedSection {
  sectionTitle: string;
  layoutType: string;
  layoutData: unknown;
  aiDraftContent: string | null;
  brokerEditedContent: string | null;
  aiLayoutReasoning: string | null;
  /** When it was recorded (ISO). */
  at: string;
}

/** The approved Blind / DD version (stored in the override row's layoutData). */
export interface PublishedOverride {
  layoutData: unknown;
  contentOverride: string | null;
  /** Blind only: the redacted title that went with it. */
  blindTitle?: string | null;
  at: string;
}

/** The record of a section's approved named version. */
export function publishedSectionOf(s: Pick<CimSection, "sectionTitle" | "layoutType" | "layoutData" | "aiDraftContent" | "brokerEditedContent" | "aiLayoutReasoning">, at: Date = new Date()): PublishedSection {
  return {
    sectionTitle: s.sectionTitle,
    layoutType: s.layoutType,
    layoutData: s.layoutData ?? null,
    aiDraftContent: s.aiDraftContent ?? null,
    brokerEditedContent: s.brokerEditedContent ?? null,
    aiLayoutReasoning: s.aiLayoutReasoning ?? null,
    at: at.toISOString(),
  };
}

/** The record of a section's approved Blind or DD version. */
export function publishedOverrideOf(o: Pick<CimSectionOverride, "layoutData" | "contentOverride">, blindTitle?: string | null, at: Date = new Date()): PublishedOverride {
  return {
    layoutData: o.layoutData ?? null,
    contentOverride: o.contentOverride ?? null,
    ...(blindTitle !== undefined ? { blindTitle } : {}),
    at: at.toISOString(),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function readSection(row: CimSectionOverride | undefined): PublishedSection | null {
  const d = row?.layoutData;
  if (!isRecord(d) || typeof d.layoutType !== "string" || typeof d.sectionTitle !== "string") return null;
  return d as unknown as PublishedSection;
}

function readOverride(row: CimSectionOverride | undefined): PublishedOverride | null {
  const d = row?.layoutData;
  return isRecord(d) && "layoutData" in d ? (d as unknown as PublishedOverride) : null;
}

type LiveDeal = { isLive?: boolean | null };

/** Is this section approved as it stands (ticked, or an untouched pre-rule section of a live CIM)? */
export function approvedAsItStands(section: CimSection, legacyIds: ReadonlySet<string>): boolean {
  return !!section.brokerApproved || legacyIds.has(section.id);
}

/**
 * The sections and mode overrides a buyer is served on a live CIM: every
 * shown section that isn't approved as it stands is swapped for its
 * recorded approved version (or left out when there is none). Off a live
 * CIM, or with no records passed (a broker preview), nothing changes.
 * `mode` is the buyer's version; `overrides` its override rows.
 */
export function servedVersions(input: {
  deal: LiveDeal;
  mode: "blind" | "normal" | "dd";
  sections: CimSection[];
  overrides: CimSectionOverride[];
  published?: CimSectionOverride[] | null;
}): { sections: CimSection[]; overrides: CimSectionOverride[]; kept: string[] } {
  const { deal, mode, sections, overrides, published } = input;
  if (!deal.isLive || !published) return { sections, overrides, kept: [] };
  const legacy = new Set(legacyLiveApprovedIds(deal, sections));
  const byMode = (m: string) => new Map(published.filter((p) => p.mode === m).map((p) => [String(p.cimSectionId), p]));
  const named = byMode(PUBLISHED_MODE);
  const blind = byMode(PUBLISHED_BLIND_MODE);
  const dd = byMode(PUBLISHED_DD_MODE);
  const outSections: CimSection[] = [];
  const replaced = new Map<string, CimSectionOverride | null>();
  const kept: string[] = [];
  for (const s of sections) {
    if (s.isVisible === false || approvedAsItStands(s, legacy)) {
      outSections.push(s);
      continue;
    }
    const record = readSection(named.get(s.id));
    // Never approved: not served until it is.
    if (!record) continue;
    kept.push(s.id);
    const modeRecord = mode === "blind" ? readOverride(blind.get(s.id)) : mode === "dd" ? readOverride(dd.get(s.id)) : null;
    outSections.push({
      ...s,
      sectionTitle: record.sectionTitle,
      layoutType: record.layoutType,
      layoutData: record.layoutData as CimSection["layoutData"],
      aiDraftContent: record.aiDraftContent,
      brokerEditedContent: record.brokerEditedContent,
      aiLayoutReasoning: record.aiLayoutReasoning,
      aiTask: null,
      // The recorded Blind / DD version is up to date with the recorded content.
      blindStaleAt: mode === "blind" && modeRecord ? null : s.blindStaleAt,
      blindTitle: mode === "blind" && modeRecord ? modeRecord.blindTitle ?? null : s.blindTitle,
      ddStaleAt: mode === "dd" && modeRecord ? null : s.ddStaleAt,
    });
    if (mode !== "normal") {
      replaced.set(
        s.id,
        modeRecord
          ? ({ id: `published:${s.id}`, dealId: s.dealId, cimSectionId: s.id, mode, layoutData: modeRecord.layoutData, contentOverride: modeRecord.contentOverride, createdAt: new Date(modeRecord.at) } as CimSectionOverride)
          : null,
      );
    }
  }
  if (replaced.size === 0) return { sections: outSections, overrides, kept };
  const outOverrides = overrides.filter((o) => !replaced.has(String(o.cimSectionId)));
  for (const o of Array.from(replaced.values())) if (o) outOverrides.push(o);
  // A Blind section with no recorded version is held back like any section
  // whose redaction is catching up (its current override, if any, is for
  // the unapproved change and must not be served).
  const outFinal = mode === "blind"
    ? outSections.map((s) => (replaced.has(s.id) && !replaced.get(s.id) ? { ...s, blindStaleAt: s.blindStaleAt ?? new Date(0) } : s))
    : mode === "dd"
      ? outSections.map((s) => (replaced.has(s.id) && !replaced.get(s.id) ? { ...s, ddStaleAt: s.ddStaleAt ?? new Date(0) } : s))
      : outSections;
  return { sections: outFinal, overrides: outOverrides, kept };
}
