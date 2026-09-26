/**
 * normalisation-guard — the broker's normalisation WORK stated to the seller:
 * what is on the add-back list, what the recast or SDE came to ("Maria's
 * salary is already in the broker's add-backs — the recast lands at
 * $1,312,000 SDE"). Whether an item is added back is the broker's call, made
 * against the statements (prompts/boundaries.md), and the broker's working
 * is private: a seller told this was given a figure nobody had agreed with
 * them (QA harvest round V, Lakeshore).
 *
 * These patterns are one half of the ONE add-back guard: reply-guards.ts
 * assertsNormalisation folds them in next to its treatment-call patterns,
 * and everything downstream (the stream gate's hold, the output guard's
 * single corrective rewrite, the polish pass's removal and hand-off line,
 * chips, rationale) runs on that one detector. Questions to the seller
 * ("are there personal expenses run through the company?") are never
 * matched here; hand-off lines and the one safe general statement the
 * rules allow are excepted in reply-guards.
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

/**
 * The one safe general statement the rules allow (prompts/boundaries.md:
 * "a market-rate owner salary on the P&L is the classic addback").
 */
export const SAFE_GENERAL_RE = /market[- ]rate (?:owner'?s? )?salary[^.?!]{0,60}\bclassic add[- ]?back\b|\bclassic add[- ]?back\b[^.?!]{0,60}market[- ]rate/i;

/** Sentences (a "." inside "$1.5M" or "e.g." doesn't end one). */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The sentences of a text that state the broker's normalisation work or a normalised figure. */
export function brokerWorkAssertions(text: string): string[] {
  return sentences(text).filter((s) => {
    if (/\?\s*$/.test(s)) return false; // a question to the seller
    if (!NORMALISATION_RE.test(s)) return false;
    if (SAFE_GENERAL_RE.test(s)) return false;
    return ASSERTION_RE.test(s);
  });
}
