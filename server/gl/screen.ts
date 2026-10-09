/**
 * screen.ts — text that may reach due-diligence buyers (the "Why it's added
 * back" line, a seller's or broker's note shown to buyers): screened with the
 * same rules the CIM writer uses (gl spec §9.2). Anything held → the text is
 * not shown at all (null), never shown half-cut. Pure apart from the
 * screening rules it imports.
 */
import { screenText, keepOutFromNotes, mentionsHeldName } from "../cim/sensitive-facts";
import { screenStaffPrivateText, staffContextFrom, includedStaffPrivate } from "../cim/staff-private";
import { mentionsPrivateSource } from "@shared/discrepancy-sides";

/** Internal sourcing ("per an email from Denise", "per the broker's note") — the broker's working notes, not a buyer's reason. */
const SOURCING_RE = /\b(?:per|from|in)\s+(?:an?\s+|the\s+)?(?:e-?mail|text message|call|crm|pipedrive|private note|broker'?s?\s+(?:private\s+)?note)s?\b/i;

/**
 * The text as buyers may read it, or null when anything in it had to be
 * held (a sensitive detail, a staff-private matter, a held or kept-out name,
 * the broker's private material). Sentences that only say where the broker
 * heard something are dropped quietly — they are not reasons.
 */
export function screenForBuyers(text: string | null | undefined, info: Record<string, unknown> | null | undefined): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  const sentences = raw.split(/(?<=[.!?])\s+/).filter((s) => !SOURCING_RE.test(s));
  if (sentences.some((s) => mentionsPrivateSource(s))) return null;
  const kept = sentences.join(" ").trim();
  if (!kept) return null;
  if (screenText(kept) !== kept) return null;
  const facts = (info ?? {}) as Record<string, unknown>;
  const staff = screenStaffPrivateText(kept, staffContextFrom(facts), includedStaffPrivate(facts));
  if (staff.held.length > 0) return null;
  const keepOut = keepOutFromNotes(facts);
  if (mentionsHeldName(kept, keepOut.names)) return null;
  if (keepOut.pairs.some((p) => mentionsHeldName(kept, [p.name]))) return null;
  return kept.slice(0, 1200);
}
