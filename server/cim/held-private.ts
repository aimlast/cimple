/**
 * held-private — what the CIM holds back about the deal's staff, as the
 * broker sees it on the CIM tab ("Held back from the CIM: … — Include").
 *
 * The list is read live from the facts (the deterministic screen, so it is
 * there before the first generation and follows every edit), plus what the
 * last generation's AI review held on top (kept on `cimGeneration`), while
 * those words are still on file. Each item carries the broker's include
 * decision; switching one on puts its words back into the CIM inputs on the
 * next generation (STAFF_PRIVATE_INCLUDED_KEY on the deal's facts).
 *
 * No model call here.
 */
import type { CimGenerationStatus, CimSection, CimSectionOverride, Deal } from "@shared/schema";
import { STAFF_PRIVATE_INCLUDED_KEY, type StaffPrivateItem, type StaffPrivateListItem } from "@shared/staff-private";
import { servesPublishedSnapshot } from "@shared/cim-buyer-view";
import { servedVersions } from "@shared/cim-published";
import { brokerFactsView, factDisplayLabel, mutateDealInfo } from "../information/facts";
import { splitFactsForCim } from "../information/cim-facts";
import { includedStaffPrivate, screenStaffPrivatePairs, staffContextFrom } from "./staff-private";

type Info = Record<string, unknown>;

/** The held items for a deal's current facts (pure over the info + last generation). */
export function heldPrivateItems(info: Info, lastRun: ReadonlyArray<StaffPrivateItem> = []): StaffPrivateListItem[] {
  const included = includedStaffPrivate(info);
  const split = splitFactsForCim(info);
  const pairs = [...split.confirmed, ...split.leads];
  // Everything the screen would hold, whatever the broker decided — an
  // included item stays listed, switched on.
  const { items } = screenStaffPrivatePairs(pairs, { ctx: staffContextFrom(info) });
  const out: StaffPrivateItem[] = [...items];
  // What the last generation held on top (the AI review's finds, or words
  // it cut differently), while those words are still in that fact — every
  // passage a generation held is shown, with the id its switch works on.
  const factText = (key: string) => {
    const pair = pairs.find(([k]) => k === key);
    return pair ? JSON.stringify(pair[1]).toLowerCase().replace(/\s+/g, " ") : "";
  };
  for (const item of lastRun) {
    if (out.some((o) => o.id === item.id)) continue;
    if (factText(item.key).includes(item.text.toLowerCase().replace(/\s+/g, " ").slice(0, 60))) out.push(item);
  }
  return out.map((i) => ({ ...i, included: included.has(i.id), label: factDisplayLabel(info, i.key) }));
}

/** The list for a deal, as the CIM tab shows it. */
export function heldPrivateForDeal(deal: Deal): StaffPrivateListItem[] {
  const info = (brokerFactsView(deal).extractedInfo as Info | null) || {};
  const lastRun = (deal.cimGeneration as CimGenerationStatus | null | undefined)?.heldPrivate ?? [];
  return heldPrivateItems(info, lastRun);
}

/** Switch one item into (or back out of) the CIM inputs. Kept with the deal's facts. */
export async function setHeldPrivateIncluded(dealId: string, id: string, include: boolean): Promise<void> {
  await mutateDealInfo(dealId, (info) => {
    const current = Array.from(includedStaffPrivate(info));
    const next = include ? Array.from(new Set([...current, id])) : current.filter((x) => x !== id);
    if (next.length > 0) info[STAFF_PRIVATE_INCLUDED_KEY] = next;
    else delete info[STAFF_PRIVATE_INCLUDED_KEY];
  });
}

/** A written CIM section, as far as the scan needs it. */
export interface HeldScanSection {
  id: string;
  sectionTitle: string;
  layoutData?: unknown;
  aiDraftContent?: string | null;
  brokerEditedContent?: string | null;
  isVisible?: boolean | null;
}

export interface SectionShowingPrivate {
  id: string;
  title: string;
  /** What it still states, in the broker's words ("Daniel Okafor's interest in an ownership stake"). */
  descriptions: string[];
}

/**
 * The texts of a section's layout: an object's own strings read as one
 * passage ({ name: "Daniel Okafor", note: "Asked about equity…" } — the note
 * is about the name), nested values on their own.
 */
function stringsOf(v: unknown, out: string[]): string[] {
  if (typeof v === "string") {
    if (v.trim()) out.push(v);
  } else if (Array.isArray(v)) for (const x of v) stringsOf(x, out);
  else if (v && typeof v === "object") {
    const own: string[] = [];
    for (const x of Object.values(v as Record<string, unknown>)) {
      if (typeof x === "string") {
        if (x.trim()) own.push(x.trim().replace(/[.;,:]+$/, ""));
      } else stringsOf(x, out);
    }
    if (own.length > 0) out.push(own.join(". ") + ".");
  }
  return out;
}

/**
 * Sections of the CIM as written that still state a staff-private matter
 * the broker hasn't included — a CIM written before the screen (the live
 * Beacon CIM printed the pharmacist's equity ask in Key Personnel and the
 * Ideal Buyer Profile), or words typed into a section. The broker is told
 * to regenerate or edit them; nothing is changed here. Pure.
 */
export function sectionsShowingStaffPrivate(
  sections: ReadonlyArray<HeldScanSection>,
  info: Info,
  items: ReadonlyArray<Pick<StaffPrivateListItem, "kind" | "person" | "included"> & { text?: string }>,
): SectionShowingPrivate[] {
  const ctx = staffContextFrom(info);
  const firstName = (p: string | null | undefined) => (p ? p.split(/\s+/)[0].toLowerCase() : null);
  const words = (t: string) => new Set(t.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
  // A matter the broker included is meant to be there: every held item of
  // that kind about that person is switched on, or the passage is (mostly)
  // the words of one the broker included.
  const meant = (kind: string, person: string | null, text: string) => {
    const same = items.filter((i) => i.kind === kind && (!person || !i.person || firstName(i.person) === firstName(person)));
    if (same.length > 0 && same.every((i) => i.included)) return true;
    const w = words(text);
    return same.some((i) => {
      if (!i.included) return false;
      const iw = words(i.text ?? "");
      if (iw.size === 0) return false;
      let hit = 0;
      iw.forEach((x) => { if (w.has(x)) hit++; });
      return hit / iw.size >= 0.6;
    });
  };
  const out: SectionShowingPrivate[] = [];
  for (const s of sections) {
    if (s.isVisible === false) continue;
    const texts = stringsOf(s.layoutData ?? null, []);
    const prose = s.brokerEditedContent?.trim() || s.aiDraftContent?.trim();
    if (prose) texts.push(prose);
    const descriptions = new Set<string>();
    for (const t of texts) {
      // A section title is not a fact key: a staff section reads as a staff fact, anything else as neutral text
      // (a "Transition" section is not the owner's own topic the way the transitionPlan fact is).
      const key = /personnel|team|employee|staff|management|people|succession|retention|org(?:ani[sz]ation)?\b/i.test(s.sectionTitle) ? "keyPersonnel" : "cimSection";
      const r = screenStaffPrivatePairs([[key, t]], { ctx });
      for (const item of r.items) if (!meant(item.kind, item.person ?? null, item.text)) descriptions.add(item.description);
    }
    if (descriptions.size > 0) out.push({ id: s.id, title: s.sectionTitle, descriptions: Array.from(descriptions) });
  }
  return out;
}

/** The deal's held items and the written sections that still state one (the CIM tab and the builder). */
export function heldPrivateStateForDeal(deal: Deal, sections: ReadonlyArray<HeldScanSection>): { items: StaffPrivateListItem[]; showing: SectionShowingPrivate[] } {
  const info = (brokerFactsView(deal).extractedInfo as Info | null) || {};
  const items = heldPrivateForDeal(deal);
  return { items, showing: sections.length > 0 ? sectionsShowingStaffPrivate(sections, info, items) : [] };
}

// ── What buyers are served now (final review PRIV-3) ────────────────────
//
// The scan above reads the DRAFT. Buyers of a live CIM are not always served
// the draft: while a regenerated CIM waits for the broker's review they read
// the kept copy (published-snapshot.ts), and a section changed since its
// approval is served in its approved version (shared/cim-published.ts). So a
// matter the broker regenerated or edited out of the draft can still be in
// front of every buyer — DD included — until the update is published. These
// helpers scan what is served (its named, Blind and DD texts) so the CIM tab
// can say so.

/** Where the served text that isn't the draft comes from. */
export type ServedSource = "kept_copy" | "approved_version";

export interface ServedRows {
  source: ServedSource;
  /** The served named sections that differ from the draft (all of the kept copy's). */
  sections: CimSection[];
  /** Their served Blind / DD versions. */
  overrides: Array<Pick<CimSectionOverride, "cimSectionId" | "layoutData" | "contentOverride">>;
}

/**
 * The rows buyers are served that are NOT the draft, or null when buyers
 * read the draft (or nothing). Pure.
 */
export function servedRowsNotDraft(input: {
  deal: { isLive?: boolean | null; cimGeneration?: unknown };
  draft: CimSection[];
  snapshot: { sections: CimSection[]; blindOverrides: CimSectionOverride[]; ddOverrides: CimSectionOverride[] } | null;
  published: CimSectionOverride[] | null;
}): ServedRows | null {
  const { deal, draft, snapshot, published } = input;
  if (!deal.isLive) return null;
  if (servesPublishedSnapshot(deal)) {
    if (!snapshot) return null;
    return { source: "kept_copy", sections: snapshot.sections, overrides: [...snapshot.blindOverrides, ...snapshot.ddOverrides] };
  }
  if (!published || published.length === 0) return null;
  const named = servedVersions({ deal, mode: "normal", sections: draft, overrides: [], published });
  if (named.kept.length === 0) return null;
  const kept = new Set(named.kept);
  const blind = servedVersions({ deal, mode: "blind", sections: draft, overrides: [], published });
  const dd = servedVersions({ deal, mode: "dd", sections: draft, overrides: [], published });
  return {
    source: "approved_version",
    sections: named.sections.filter((s) => kept.has(s.id)),
    overrides: [...blind.overrides, ...dd.overrides].filter((o) => kept.has(String(o.cimSectionId))),
  };
}

/**
 * Served sections (not the draft) that state a held staff matter: each
 * section's named text, and its Blind / DD versions read under the same
 * title. Pure.
 */
export function servedShowingStaffPrivate(rows: ServedRows, info: Info, items: ReadonlyArray<StaffPrivateListItem>): SectionShowingPrivate[] {
  // A hidden section reaches no buyer in any version.
  const titleOf = new Map(rows.sections.filter((s) => s.isVisible !== false).map((s) => [s.id, s.sectionTitle]));
  const scan: HeldScanSection[] = [
    ...rows.sections,
    ...rows.overrides
      .filter((o) => titleOf.has(String(o.cimSectionId)))
      .map((o) => ({ id: String(o.cimSectionId), sectionTitle: titleOf.get(String(o.cimSectionId))!, layoutData: o.layoutData, aiDraftContent: o.contentOverride ?? null })),
  ];
  const byId = new Map<string, SectionShowingPrivate>();
  for (const hit of sectionsShowingStaffPrivate(scan, info, items)) {
    const prev = byId.get(hit.id);
    if (prev) prev.descriptions = Array.from(new Set([...prev.descriptions, ...hit.descriptions]));
    else byId.set(hit.id, { ...hit, descriptions: [...hit.descriptions] });
  }
  return Array.from(byId.values());
}

/** What buyers are still served that states a held matter (the draft aside), with where it comes from. */
export async function servedHeldPrivateForDeal(
  deal: Deal,
  draft: CimSection[],
  items: ReadonlyArray<StaffPrivateListItem> = heldPrivateForDeal(deal),
): Promise<{ source: ServedSource | null; showing: SectionShowingPrivate[] }> {
  if (!deal.isLive) return { source: null, showing: [] };
  const [{ getPublishedSnapshot }, { loadPublishedVersions }] = await Promise.all([import("./published-snapshot"), import("./published-versions")]);
  const snapshot = servesPublishedSnapshot(deal) ? await getPublishedSnapshot(deal.id) : null;
  const published = servesPublishedSnapshot(deal) ? null : await loadPublishedVersions(deal);
  const rows = servedRowsNotDraft({ deal, draft, snapshot, published });
  if (!rows) return { source: null, showing: [] };
  const info = (brokerFactsView(deal).extractedInfo as Info | null) || {};
  return { source: rows.source, showing: servedShowingStaffPrivate(rows, info, items) };
}
