/**
 * generation-shortfall — is a finished CIM generation good enough to replace
 * what the deal has?
 *
 * The layout engine never throws for a section it couldn't write: the section
 * becomes a hidden "could not be generated" placeholder. That is right for
 * one or two sections, but when the AI service fails mid-run (credits run
 * out, a 529 overload burst) EVERY section can come back as a placeholder —
 * and saving that document deleted the broker's CIM, edits, approvals, access
 * tiers and Blind/DD versions, then toasted "CIM ready".
 *
 * Rules (pure — the job decides what to do with the answer):
 *   - Nothing written at all (or nothing planned) → never saved.
 *   - The deal already has a CIM → saved only if at most a quarter of the
 *     sections are placeholders AND no key section (executive summary,
 *     financial statements, earnings build, transaction terms — see
 *     isKeySection) is one. Otherwise the current CIM stays.
 *   - First CIM for the deal → saved as long as something was written: there
 *     is nothing to lose, and each placeholder can be regenerated on its own.
 */
import { isCimFallbackSection } from "@shared/cim-layouts";
import { describeAiFailure } from "../ai-retry";

/** Largest share of placeholders allowed when a CIM already exists. */
export const MAX_PLACEHOLDER_SHARE = 0.25;

interface SectionLike {
  sectionKey?: string | null;
  sectionTitle?: string | null;
  tags?: unknown;
  aiLayoutReasoning?: string | null;
}

/**
 * Sections a buyer can't do without: the executive summary, the headline
 * financial statements, the earnings build (SDE / EBITDA normalisation) and
 * the transaction / asking-price terms.
 *
 * Matched on the section's key and title only, never its tags: the layout
 * engine tags a third to a half of every CIM "financials" or "transaction"
 * (Ideal Buyer Profile, Next Steps & Contact, Seasonality & Project Revenue,
 * Capital Expenditures…), so a tag rule made one isolated failure throw away
 * a whole "Regenerate all". A key section that failed still refuses the run;
 * any other lone placeholder is kept and regenerated on its own.
 */
export function isKeySection(s: SectionLike): boolean {
  const text = ` ${s.sectionKey ?? ""} ${s.sectionTitle ?? ""} `
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ");
  if (/ executive summary /.test(text)) return true;
  if (/ (financial (performance|summary|statements?|overview|results)|income statement|(three|3) year financials?) /.test(text)) return true;
  if (/ (transaction (overview|structure|summary|terms)|deal structure|asking price) /.test(text)) return true;
  // The earnings build (normalisation, bridge, add-backs) — not a growth
  // chart or a narrative about earnings.
  return / (sde|ebitda|discretionary earnings) /.test(text) && /normali[sz]|calculation| build|bridge|reconcil|waterfall|add ?backs?|adjust/.test(text);
}

export interface GenerationShortfall {
  /** Honest message for the broker (the job's error). */
  message: string;
  failed: number;
  total: number;
}

/**
 * Null when the document may be saved; otherwise why it must not replace
 * what the deal has.
 */
export function generationShortfall(
  sections: readonly SectionLike[],
  opts: { hasExistingCim: boolean; aiError?: unknown },
): GenerationShortfall | null {
  const total = sections.length;
  // Why the sections failed, when the service said (credits out or a
  // rejected key won't come right by trying again in a few minutes).
  const why = opts.aiError ? describeAiFailure(opts.aiError) : null;
  const cause = why ? ` (${why.reason})` : "";
  const retry = why ? `${why.advice[0].toUpperCase()}${why.advice.slice(1)}.` : "Try again in a few minutes.";
  const failedSections = sections.filter((s) => isCimFallbackSection(s));
  const failed = failedSections.length;
  const kept = opts.hasExistingCim ? "Your current CIM was not changed." : "Nothing was saved.";
  if (total === 0) {
    return { failed: 0, total: 0, message: `The AI planned no sections, so nothing was written. ${kept} Try again.` };
  }
  if (failed === total) {
    return {
      failed,
      total,
      message: `The AI service failed${cause} while writing all ${total} sections. ${kept} ${retry}`,
    };
  }
  if (!opts.hasExistingCim || failed === 0) return null;
  const keyFailed = failedSections.filter(isKeySection).map((s) => s.sectionTitle || s.sectionKey || "a key section");
  if (failed / total > MAX_PLACEHOLDER_SHARE || keyFailed.length > 0) {
    const which = keyFailed.length > 0 ? ` (including ${keyFailed.slice(0, 3).map((t) => `"${t}"`).join(", ")})` : "";
    return {
      failed,
      total,
      message: `The AI service failed${cause} while writing ${failed} of ${total} sections${which}. ${kept} ${retry}`,
    };
  }
  return null;
}
