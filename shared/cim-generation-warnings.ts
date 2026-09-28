/**
 * cim-generation-warnings — what a CIM generation's warnings mean for the
 * broker, and what "Regenerate all" does to buyers. Pure; used by the CIM
 * tab, the builder header and the app-wide "CIM ready" toast.
 *
 * The layout engine reports everything the broker must review as plain
 * lines (layout-engine.ts, generation-jobs.ts): sections it couldn't write,
 * figures it couldn't trace, confidential names or untraced figures it took
 * out, sections it rebuilt or held back. Only the toast ever read them — and
 * it called every one "fell back to a placeholder" (Pacific: "23 sections
 * generated, 4 fell back to a placeholder" when none had).
 */

export type CimWarningKind =
  /** A section the AI couldn't write — saved as a hidden placeholder. */
  | "placeholder"
  /** Figures or names the check couldn't trace — the section says what they are. */
  | "figures"
  /** Something was taken out (a confidential name, an untraced figure, a working-capital line). */
  | "removed"
  /** A section is hidden from buyers until the broker fixes it. */
  | "hidden"
  /** Anything else to read before publishing. */
  | "review";

export interface CimGenerationWarning {
  text: string;
  kind: CimWarningKind;
  /** The section the warning names (its first quoted title), when there is one. */
  sectionTitle: string | null;
}

const PLACEHOLDER = /could not be generated/i;
const FIGURES = /^Check the figures in "/;
const REMOVED = /^(?:Removed from|Taken out of) "|taken out:|Kept out of the CIM/i;
const HIDDEN = /is hidden from buyers/i;

export function classifyGenerationWarning(text: string): CimGenerationWarning {
  const kind: CimWarningKind = PLACEHOLDER.test(text)
    ? "placeholder"
    : HIDDEN.test(text)
      ? "hidden"
      : FIGURES.test(text)
        ? "figures"
        : REMOVED.test(text)
          ? "removed"
          : "review";
  const quoted = /"([^"]{1,120})"/.exec(text);
  return { text, kind, sectionTitle: quoted ? quoted[1] : null };
}

export function classifyGenerationWarnings(warnings: readonly string[] | null | undefined): CimGenerationWarning[] {
  return (warnings ?? []).filter((w) => typeof w === "string" && w.trim()).map(classifyGenerationWarning);
}

/** The "CIM ready" toast line: sections written, and what needs review — placeholders counted apart. */
export function generationSummary(sectionCount: number, warnings: readonly string[] | null | undefined): { text: string; attention: boolean } {
  const all = classifyGenerationWarnings(warnings);
  const placeholders = all.filter((w) => w.kind === "placeholder").length;
  const notes = all.length - placeholders;
  const written = sectionCount - placeholders;
  const parts = [`${written} section${written === 1 ? "" : "s"} written`];
  if (placeholders > 0) parts.push(`${placeholders} couldn't be written (hidden until you regenerate ${placeholders === 1 ? "it" : "them"})`);
  if (notes > 0) parts.push(`${notes} note${notes === 1 ? "" : "s"} to review before publishing`);
  return {
    text: all.length > 0 ? `${parts.join(" · ")}. Open the CIM tab to see them.` : `${written} sections designed. Review and edit them on the deal.`,
    attention: placeholders > 0,
  };
}

/**
 * Why a regenerated CIM is held, in the broker's words: it replaced one
 * buyers could open, the live one, or one that had been approved (a hold
 * with no buyer links said "replaced the one buyers could open").
 */
export function heldReplacedText(hold: { buyers: number; wasLive: boolean }): string {
  if (hold.buyers > 0) return `It was regenerated and replaced the one ${hold.buyers} buyer${hold.buyers === 1 ? "" : "s"} could open.`;
  if (hold.wasLive) return "It was regenerated and replaced the live one.";
  return "It was regenerated and replaced the approved one, so its approvals were cleared.";
}

/**
 * What "Regenerate all" does to buyers, for the confirm dialogs — null when
 * no buyer can open the CIM and it isn't live or approved.
 */
export function regenerateBuyerImpact(state: { isLive?: boolean | null; openBuyers?: number | null; approved?: boolean | null }): string | null {
  const buyers = Math.max(0, state.openBuyers ?? 0);
  if (!state.isLive && buyers === 0 && !state.approved) return null;
  const who = buyers > 0 ? `the ${buyers === 1 ? "buyer" : `${buyers} buyers`} with access` : "buyers";
  return [
    `The new CIM is not shown to ${who} until you review it, approve it and publish it again — until then they see a notice that the document is being updated.`,
    state.isLive ? "The deal comes off live, and its content and design approvals are cleared." : "Its content and design approvals are cleared.",
  ].join(" ");
}
