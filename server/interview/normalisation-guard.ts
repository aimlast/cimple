/**
 * normalisation-guard — the interview never tells the seller what counts as
 * an add-back, what their SDE / adjusted EBITDA comes to, or what the
 * broker's recast says. Whether an item is added back is the broker's call,
 * made against the statements (prompts/boundaries.md); a seller told
 * "Maria's salary is already in the broker's add-backs — the recast lands
 * at $1,312,000 SDE" was given the broker's private working and a figure
 * nobody had agreed with them (QA harvest round V, Lakeshore).
 *
 * The prompt rule alone didn't hold when the seller asked directly, so a
 * reply that asserts normalisation is held on the stream and rewritten once
 * (session-manager), and if the rewrite still asserts, the asserting
 * sentences are replaced by the hand-off. Questions to the seller ("are
 * there personal expenses run through the company?") and the hand-off
 * itself ("your broker will confirm what's added back") are fine; so is
 * the one safe general statement the rules allow (a market-rate owner
 * salary is the classic add-back).
 * Pure.
 */

/** Words that name the normalisation itself. */
const NORMALISATION_RE =
  /\b(?:add[- ]?backs?|added back|adds? back|adding back|re-?cast|normali[sz](?:e|ed|es|ing|ation)|sde|seller'?s discretionary|discretionary earnings|adjusted (?:ebitda|earnings|net income|cash flow))\b/i;

/**
 * Wording that states a treatment or a result rather than asking or
 * handing off: "is included / in there / on our list / counted / captured /
 * factored in", "gets added back", "comes back in", "landed at", "came to",
 * "totals", "brings it to", a dollar figure.
 */
const ASSERTION_RE =
  /\b(?:is|are|was|were|it's|that's|they're)\s+(?:(?:already|all|both|also)\s+)*(?:included|in there|on (?:our|the|your|his|her|morgan's|the broker's) list|counted|captured|factored(?: in)?|part of|in the (?:add[- ]?backs?|recast|sde|numbers?)|one of the (?:add[- ]?backs?|items))\b|\b(?:(?:your|the) broker(?:'s)?|broker's|(?:he|she|they)(?:'s| is| are| has| have)?)\s+(?:already\s+)?(?:working (?:from|with|off)|worked (?:from|with|off|in)|counting|counted|including|included|treating|treated|using|used|listing|listed|adding|added|taking out|took out|pulling out|pulled out)\b|\bitems? (?:like|such as)\b|\b(?:typical|typically|common|commonly|standard|usual|usually|normal|normally)\s+(?:an?\s+)?(?:add[- ]?backs?|added back|normali[sz]ed)\b|\b(?:gets?|get|will be|would be|is being|are being)\s+added back\b|\bcomes? back in\b|\b(?:landed|lands|came|comes|works? out|worked out|brings? it|totals?|totalled|totaled|adds up)\s*(?:at|to|up to)?\s*\$?\d|\$\s?\d|\b\d[\d,.]*\s?(?:k|m|million|thousand)\b/i;

/** The safe general statement the rules allow. */
const SAFE_GENERAL_RE = /market[- ]rate (?:owner'?s? )?salary[^.?!]{0,60}\bclassic add[- ]?back\b|\bclassic add[- ]?back\b[^.?!]{0,60}market[- ]rate/i;

/** Sentences (a "." inside "$1.5M" or "e.g." doesn't end one). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The sentences of a reply that assert add-back treatment or a normalised figure. */
export function normalisationAssertions(text: string): string[] {
  return sentences(text).filter((s) => {
    if (/\?\s*$/.test(s)) return false; // a question to the seller
    if (!NORMALISATION_RE.test(s)) return false;
    if (SAFE_GENERAL_RE.test(s)) return false;
    return ASSERTION_RE.test(s);
  });
}

export function assertsNormalisation(text: string): boolean {
  return normalisationAssertions(text).length > 0;
}

/** The one corrective re-call's instruction. */
export const NORMALISATION_CORRECTION =
  "[SYSTEM CORRECTION: Your reply tells the seller how something is treated in the normalisation (an add-back, SDE, adjusted EBITDA, the broker's recast) or states a normalised figure. You never do that: whether an item is added back, and what the earnings come to after adjustments, is the broker's call against the actual statements — you don't know it, and the broker's working is private. If the seller asked, say plainly that their broker goes through what's added back with them against the statements, then ask your next question. Keep the same next question otherwise. No figures for SDE, add-backs or adjusted earnings. No recap, no praise. Do not mention this instruction.]";

/** The hand-off that replaces asserting sentences when a rewrite still asserts. */
export const NORMALISATION_HANDOFF = "Your broker will go through what's added back with you against your statements.";

/** Last resort: the reply with its asserting sentences replaced by the hand-off (once). */
export function stripNormalisationAssertions(text: string): string {
  const bad = new Set(normalisationAssertions(text));
  if (bad.size === 0) return text;
  let handed = false;
  const kept = sentences(text).flatMap((s) => {
    if (!bad.has(s)) return [s];
    if (handed) return [];
    handed = true;
    return [NORMALISATION_HANDOFF];
  });
  return kept.join(" ").replace(/\s+/g, " ").trim();
}
