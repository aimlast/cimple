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
 *     financials, transaction) is one. Otherwise the current CIM stays.
 *   - First CIM for the deal → saved as long as something was written: there
 *     is nothing to lose, and each placeholder can be regenerated on its own.
 */
import { isCimFallbackSection } from "@shared/cim-layouts";

/** Largest share of placeholders allowed when a CIM already exists. */
export const MAX_PLACEHOLDER_SHARE = 0.25;

interface SectionLike {
  sectionKey?: string | null;
  sectionTitle?: string | null;
  tags?: unknown;
  aiLayoutReasoning?: string | null;
}

/** Sections a buyer can't do without: the summary, the financials, the deal terms. */
export function isKeySection(s: SectionLike): boolean {
  const tags = Array.isArray(s.tags) ? (s.tags as unknown[]).map((t) => String(t).toLowerCase()) : [];
  if (tags.some((t) => t === "financial" || t === "financials" || t === "transaction")) return true;
  const text = `${s.sectionKey ?? ""} ${s.sectionTitle ?? ""}`.toLowerCase().replace(/[_-]+/g, " ");
  return /financ|transaction|deal structure|executive summary/.test(text);
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
  opts: { hasExistingCim: boolean },
): GenerationShortfall | null {
  const total = sections.length;
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
      message: `The AI service failed while writing all ${total} sections. ${kept} Try again in a few minutes.`,
    };
  }
  if (!opts.hasExistingCim || failed === 0) return null;
  const keyFailed = failedSections.filter(isKeySection).map((s) => s.sectionTitle || s.sectionKey || "a key section");
  if (failed / total > MAX_PLACEHOLDER_SHARE || keyFailed.length > 0) {
    const which = keyFailed.length > 0 ? ` (including ${keyFailed.slice(0, 3).map((t) => `"${t}"`).join(", ")})` : "";
    return {
      failed,
      total,
      message: `The AI service failed while writing ${failed} of ${total} sections${which}. ${kept} Try again in a few minutes.`,
    };
  }
  return null;
}
