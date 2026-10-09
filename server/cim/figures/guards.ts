/**
 * guards — what may never reach a buyer through a figure note or any string
 * of the figure layer (spec §9.5, D23). No AI here, ever: edit and serve
 * paths use only these rules plus the last build's stored keep-out snapshot
 * (cim_figure_state.keep_out); they never call keepOutFor (a paid review).
 *
 * The screen context: the keep-out names from the broker's private notes,
 * the last build's AI keep-out names, the seller's keep-out requests,
 * the confidential holds of the facts, the deal's staff (staff-private
 * matters and staff names), and sensitive (health / personal) detail.
 */
import { keepOutFromNotes, mentionsHeldPerson, hasSensitiveDetail, screenFactsForCim } from "../sensitive-facts";
import { includedStaffPrivate, screenStaffPrivateText, staffContextFrom, type StaffContext } from "../staff-private";
import { carriesPrivateDetail, getSellerKeepOut, type SellerKeepOutEntry } from "../../interview/seller-keep-out";
import type { StringScreen } from "@shared/figure-strings";

export interface FigureScreenCtx {
  heldNames: string[];
  keepOut: SellerKeepOutEntry[];
  staff: StaffContext;
  included: Set<string>;
}

/** The screen context for a deal, from its facts and the last build's stored keep-out names. No AI. */
export function screenCtxFor(info: Record<string, unknown> | null | undefined, stored?: { names?: string[] } | null): FigureScreenCtx {
  const facts = (info ?? {}) as Record<string, unknown>;
  const fromNotes = keepOutFromNotes(facts);
  let heldNames: string[] = [];
  try {
    const pairs = Object.entries(facts).filter(([k]) => !k.startsWith("_"));
    heldNames = screenFactsForCim(pairs, fromNotes).heldNames;
  } catch {
    heldNames = [];
  }
  return {
    heldNames: Array.from(new Set([...(fromNotes.names ?? []), ...(stored?.names ?? []), ...heldNames].filter((n) => typeof n === "string" && n.trim().length > 1))),
    keepOut: getSellerKeepOut(facts),
    staff: staffContextFrom(facts),
    included: includedStaffPrivate(facts),
  };
}

function wordRe(name: string): RegExp {
  return new RegExp(`(?:^|[^A-Za-z])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:[^A-Za-z]|$)`);
}

/**
 * Why a text must not reach a buyer, or null when it may. `owners` = the
 * owner's own name is allowed (Full / DD notes; never in the Blind CIM).
 */
export function holdsText(text: string, ctx: FigureScreenCtx, opts: { owners?: boolean } = {}): string | null {
  const t = String(text ?? "");
  if (!t.trim()) return null;
  const held = mentionsHeldPerson(t, ctx.heldNames);
  if (held) return `names someone kept out of the CIM (${held})`;
  for (const e of ctx.keepOut) if (carriesPrivateDetail(t, e)) return "carries a detail the seller asked to keep out of the CIM";
  if (screenStaffPrivateText(t, ctx.staff, ctx.included).held.length > 0) return "carries a private staff matter";
  const ownerWords = new Set(ctx.staff.ownerNames);
  for (const name of ctx.staff.staffNames) {
    const words = name.toLowerCase().split(/\s+/);
    if (opts.owners && words.every((w) => ownerWords.has(w))) continue;
    if (wordRe(name).test(t)) return `names a staff member (${name})`;
  }
  if (hasSensitiveDetail(t)) return "carries a personal or health detail";
  return null;
}

/** The D23 string pipeline's screen for buyer strings of this deal. */
export function stringScreenFor(ctx: FigureScreenCtx, opts: { owners?: boolean } = {}): StringScreen {
  return { keep: (text: string) => holdsText(text, ctx, opts) === null };
}
