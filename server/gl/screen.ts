/**
 * screen.ts — text that may reach due-diligence buyers (the "Why it's added
 * back" line, a seller's or broker's note shown to buyers): screened with the
 * same rules the CIM writer uses (gl spec §9.2). Anything held → the text is
 * not shown at all (null), never shown half-cut. Pure apart from the
 * screening rules it imports.
 */
import { screenText, keepOutFromNotes, mentionsHeldName, mentionsHeldPerson } from "../cim/sensitive-facts";
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

/**
 * screenForBuyers, plus the deal's held names (staff-private people whose
 * matter is held back, keep-out parties): text that mentions one — even by
 * the given name alone — is not shown at all. Used at publish AND every time
 * the published snapshot is served (gl spec §9.2): a name held back after
 * publishing takes the text off what buyers see at once.
 */
export function screenForBuyersWith(
  text: string | null | undefined,
  info: Record<string, unknown> | null | undefined,
  heldNames: readonly string[],
): string | null {
  const kept = screenForBuyers(text, info);
  if (!kept) return null;
  if (heldNames.length > 0 && mentionsHeldPerson(kept, heldNames)) return null;
  return kept;
}

/**
 * The analyst's working notes in an add-back's description — how it's
 * treated ("counts for EBITDA and SDE", "the market salary is added back for
 * SDE only", "market replacement cost") and the owner's own plans ("plans to
 * exit within 6-12 months post-sale") — are not a buyer's reason: such
 * sentences are dropped before the description is offered as "Why it's added
 * back" (the broker still sees and can edit it before publishing).
 */
const TREATMENT_RE = /\b(?:ebitda|sde|seller'?s discretionary|discretionary earnings|market (?:salary|wage|rate|replacement|compensation|pay)|replacement cost|added back for|add(?:ed)?[- ]?backs? (?:for|to|of)|counts? (?:for|toward|towards|as)|normali[sz]|recast|adjusted (?:earnings|net income)|the difference|excess (?:pay|compensation|salary)|treated as)\b/i;
const OWNER_PLAN_RE = /\b(?:plans?|planning|intends?|intending|intention|wants?|wishes|hopes?|expects?) to\b|\b(?:retir(?:e|es|ing|ement)|exit(?:s|ing)?|step(?:s|ping)? (?:back|down|away)|succession|post[- ]?(?:sale|closing|close)|after (?:the )?(?:sale|closing|close)|transition period|stay(?:s|ing)? on|will (?:stay|remain|leave|retire|exit|work))\b/i;

export function stripWorkingNotes(text: string | null | undefined): string {
  const raw = (text ?? "").trim();
  if (!raw) return "";
  const keep = (part: string) => !TREATMENT_RE.test(part) && !OWNER_PLAN_RE.test(part);
  return raw
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => {
      // Clause by clause ("…; the market salary is added back for SDE only."), the rest of the sentence kept.
      const clauses = sentence.replace(/[.!?]+$/, "").split(/\s*;\s*/).map((c) => c.trim()).filter(Boolean);
      const kept = clauses.filter(keep);
      if (kept.length === 0) return "";
      const text = kept.join("; ");
      return `${text.charAt(0).toUpperCase()}${text.slice(1)}${/[.!?]$/.test(sentence) ? sentence.match(/[.!?]+$/)![0] : "."}`;
    })
    .filter(Boolean)
    .join(" ")
    .trim();
}

/** "Why it's added back" as Cimple offers it from the analysis: working notes dropped, then screened. null when nothing is left. */
export function buyerReasonFor(description: string | null | undefined, info: Record<string, unknown> | null | undefined): string | null {
  return screenForBuyers(stripWorkingNotes(description), info);
}
