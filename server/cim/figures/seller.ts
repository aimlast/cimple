/**
 * What buyers will read about the owner's figures, in the owner's words
 * (spec D22, §6): the seller's CIM review page lists the approved notes whose
 * basis is the owner ("From the owner") or a conversation with the owner,
 * under the CIM section they attach to. The owner's link can flag one
 * ("Change this"): the note is hidden from buyers at once and the broker sees
 * why (store.flagNoteBySeller → stale_reason 'seller_flagged').
 *
 * Only what buyers are actually served counts: the same buyer-side layer as
 * the view room (approved, current, not held), Full CIM wording, plus the
 * due-diligence notes once its checks are on. The seller payload carries the
 * note's text, its figure and its section — never hints, source quotes,
 * suggested notes or anyone else's notes.
 */
import type { Deal } from "@shared/schema";
import { buildBuyerCim } from "@shared/cim-buyer-view";
import { levelServing } from "./served";
import { DD_SOURCE_CHECK_PAGE_ID, type FigureInputs, type FigureLayer, type FigureNoteView } from "@shared/figure-layer";
import { figureInputsFor, loadFigureRaw, type FigureRaw } from "./serve";
import { flagNoteBySeller } from "./store";

export interface SellerFigureNote {
  id: string;
  sectionId: string;
  sectionTitle: string;
  /** "Operating expenses, 2023" (the figure the note is on). */
  label: string;
  text: string;
  /** "From what you told us" / "From a conversation with you". */
  basisLabel: string;
}

type SectionLike = { id: string; sectionTitle?: string | null; layoutType: string; layoutData: unknown; sectionKey?: string | null; order?: number };

/** The owner's own words count; the documents, the broker and worked-out notes don't. */
const OWNER_BASIS: Record<string, string> = {
  owner: "From what you told us",
  conversation: "From a conversation with you",
};

/**
 * Pure: the owner-quoted notes the layers serve, one per note, under the
 * first section (in reading order) that shows its figure. The DD check page
 * lists figures shown elsewhere, so it is never the section.
 */
export function sellerFigureNotesOf(sections: SectionLike[], layers: Array<FigureLayer | null | undefined>): SellerFigureNote[] {
  const order = new Map(sections.map((s, i) => [s.id, i]));
  const title = new Map(sections.map((s) => [s.id, String(s.sectionTitle ?? "").trim() || "This section"]));
  const out = new Map<string, SellerFigureNote>();
  for (const layer of layers) {
    if (!layer) continue;
    for (const a of layer.anchors) {
      if (a.pageId === DD_SOURCE_CHECK_PAGE_ID || !order.has(a.pageId)) continue;
      const f = layer.figures[a.fig];
      if (!f) continue;
      const notes: FigureNoteView[] = [];
      if (f.why) notes.push(f.why);
      for (const p of f.parts ?? []) if (p.why) notes.push(p.why);
      for (const c of f.checks ?? []) if (c.note) notes.push(c.note);
      for (const n of notes) {
        const basis = OWNER_BASIS[n.basis];
        if (!basis || n.id.includes("#")) continue; // worked-out text has no row of its own
        const prior = out.get(n.id);
        if (prior && (order.get(prior.sectionId) ?? 0) <= (order.get(a.pageId) ?? 0)) continue;
        out.set(n.id, {
          id: n.id,
          sectionId: a.pageId,
          sectionTitle: title.get(a.pageId) ?? "This section",
          label: f.label ? `${f.label}, ${f.year}` : `A figure, ${f.year}`,
          text: n.text,
          basisLabel: basis,
        });
      }
    }
  }
  return Array.from(out.values()).sort((a, b) => (order.get(a.sectionId) ?? 0) - (order.get(b.sectionId) ?? 0));
}

// ── IO (seams for tests) ─────────────────────────────────────────────────

interface SellerDeps {
  loadRaw(dealId: string): Promise<FigureRaw>;
  flag(dealId: string, noteId: string, comment: string): Promise<boolean>;
}
const realDeps: SellerDeps = { loadRaw: (id) => loadFigureRaw(id), flag: (d, n, c) => flagNoteBySeller(d, n, c) };
let deps: SellerDeps = realDeps;
export function _setSellerFigureDepsForTests(d: Partial<SellerDeps> | null): void {
  deps = d ? { ...realDeps, ...d } : realDeps;
}

/** The layers buyers are served over these (named) sections: Full CIM, and DD once its checks are on. */
function buyerLayers(deal: Pick<Deal, "id" | "businessName" | "blindCodename" | "extractedInfo">, sections: SectionLike[], raw: FigureRaw): FigureLayer[] {
  const out: FigureLayer[] = [];
  // levelServing: the level buildBuyerCim reads as that version on either side of the access-level merge
  // (the new "named" key read as the Blind CIM here before teaser's registry lands).
  for (const mode of ["normal", "dd"] as const) {
    const inputs: FigureInputs | null = figureInputsFor(raw, { audience: "buyer", mode });
    if (!inputs) continue;
    const cim = buildBuyerCim({ deal: deal as any, accessLevel: levelServing(mode), sections: sections as any, overrides: [], media: [], figures: inputs });
    if (cim.figureLayer) out.push(cim.figureLayer);
  }
  return out;
}

/**
 * The owner-quoted notes on the CIM the seller is reviewing (`sections` =
 * the named CIM as the seller sees it). [] on any failure: the review page
 * then reads as it did before.
 */
export async function sellerFigureNotes(deal: Pick<Deal, "id" | "businessName" | "blindCodename" | "extractedInfo">, sections: SectionLike[]): Promise<SellerFigureNote[]> {
  if (sections.length === 0) return [];
  try {
    const raw = await deps.loadRaw(deal.id);
    return sellerFigureNotesOf(sections, buyerLayers(deal, sections, raw));
  } catch (err) {
    console.warn("[figures] seller notes:", (err as Error)?.message);
    return [];
  }
}

/** The owner's "Change this": hides the note from buyers at once. False when it isn't one they can see. */
export async function flagSellerFigureNote(
  deal: Pick<Deal, "id" | "businessName" | "blindCodename" | "extractedInfo">,
  sections: SectionLike[],
  noteId: string,
  comment: string,
): Promise<SellerFigureNote | null> {
  const visible = (await sellerFigureNotes(deal, sections)).find((n) => n.id === noteId);
  if (!visible) return null;
  const ok = await deps.flag(deal.id, noteId, comment);
  if (!ok) return null;
  const { invalidateFigureRaw } = await import("./serve");
  invalidateFigureRaw(deal.id);
  return visible;
}
