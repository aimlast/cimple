/**
 * The broker's view of a teaser draft (pure; no DOM): what the editor draws
 * on the pages, what each block is called in the list, and its checks.
 *
 * The editor fills {price} / {contact} / {firm} exactly as buyers get them
 * (TeaserState.fill, from shared/teaser-view teaserFill), so the broker reads
 * what buyers will read. Hidden blocks aren't drawn (buyers never see them);
 * a block Cimple couldn't write ("Write this") is drawn as a stand-in.
 */
import { blockCells, type TeaserBlock, type TeaserBlockCheck, type TeaserDoc } from "@shared/teaser";
import { fillTeaserTokens, teaserBlockToSection, type TeaserFill } from "@shared/teaser-view";
import type { BuyerSection } from "@shared/cim-buyer-view";
import { layoutLabel } from "@shared/cim-layouts";

const SLOT_NAMES: Record<string, string> = {
  key_numbers: "Key numbers",
  listing_facts: "At a glance",
  overview: "The business",
  highlights: "Highlights",
  opportunity: "The opportunity",
  operations: "At a glance",
  trend: "Revenue trend",
  growth: "Room to grow",
  financial_snapshot: "Financial picture",
  management: "Management & transition",
  deal_structure: "Deal structure",
  next_step: "Interested?",
  confidentiality: "Confidentiality line",
};

/** What a block is called in the list: its title, else its slot's name, else its layout. */
export function blockName(b: Pick<TeaserBlock, "title" | "slot" | "layoutType">): string {
  if (b.title && b.title.trim()) return b.title.trim();
  return SLOT_NAMES[b.slot] ?? layoutLabel(b.layoutType) ?? "Block";
}

/** A block made from the deal's information (key numbers, the facts grid, next step…). */
export function isFixedBlock(b: Pick<TeaserBlock, "origin" | "slot" | "layoutData">): boolean {
  return b.origin === "fixed" || blockCells(b as TeaserBlock).length > 0 || b.slot === "next_step" || b.slot === "confidentiality" || b.slot === "trend";
}

/** The editor's fill when the server couldn't work it out (never shown to buyers). */
export const FALLBACK_FILL: TeaserFill = { price: "Price on request", contact: null, firm: "your brokerage" };

const STAND_IN_TEXT = "Cimple didn't write this block — write it yourself, or use Rewrite with AI. Buyers don't see it until it has words.";

/** The blocks the editor draws (filled like the buyer's), in order. */
export function draftSections(doc: TeaserDoc | null | undefined, dealId: string, fill: TeaserFill | null): BuyerSection[] {
  const f = fill ?? FALLBACK_FILL;
  const out: BuyerSection[] = [];
  for (const b of doc?.blocks ?? []) {
    if (b.hidden && !b.placeholder) continue;
    if (b.placeholder) {
      out.push({
        id: b.id,
        dealId,
        sectionKey: `s_${b.id}`,
        sectionTitle: b.title,
        order: out.length,
        layoutType: "prose_highlight",
        layoutData: { body: STAND_IN_TEXT },
        aiDraftContent: STAND_IN_TEXT,
        brokerEditedContent: null,
        isVisible: true,
      });
      continue;
    }
    out.push(teaserBlockToSection(fillTeaserTokens(b, f), dealId, out.length));
  }
  return out;
}

export function checkFor(checks: TeaserBlockCheck[] | null | undefined, id: string): TeaserBlockCheck | null {
  return checks?.find((c) => c.blockId === id) ?? null;
}

/** The broker's sentence for a held block: "Buyers won't see this block: it names “Surrey” (the town). Reword it and save." */
export function heldSentence(c: TeaserBlockCheck | null): string | null {
  if (!c) return null;
  if (c.held) return `Buyers won't see this block: ${c.reason ?? "it names something that could identify the business"}. Reword it and save.`;
  if (c.layoutProblem) return `Buyers won't see this block: ${c.layoutProblem}`;
  if (c.sample) return "Buyers won't see this block: it still shows sample text. Replace it with this deal's information.";
  return null;
}

/** "“the only…” may let someone recognise the business. Buyers will see it — reword it if it's too specific." */
export function pinpointSentence(phrase: string): string {
  return `“${phrase}” may let someone recognise the business. Buyers will see it — reword it if it's too specific.`;
}

export const CHECK_LINE = "No names, places or contacts found";
export const CHECK_HELP = "Cimple checks names, places and contact details. Read it for anything that describes the business so precisely someone could recognise it.";

/** Blocks a buyer would not see right now (held, a layout problem, sample text) — drafts only. */
export function heldBlocks(doc: TeaserDoc | null | undefined, checks: TeaserBlockCheck[] | null | undefined): TeaserBlock[] {
  return (doc?.blocks ?? []).filter((b) => !b.hidden && !b.placeholder && !!heldSentence(checkFor(checks, b.id)));
}

/** Visible blocks with pinpointing wording. */
export function pinpointBlocks(doc: TeaserDoc | null | undefined, checks: TeaserBlockCheck[] | null | undefined): Array<{ block: TeaserBlock; phrases: string[] }> {
  return (doc?.blocks ?? [])
    .filter((b) => !b.hidden)
    .map((b) => ({ block: b, phrases: checkFor(checks, b.id)?.pinpoint ?? [] }))
    .filter((x) => x.phrases.length > 0);
}
