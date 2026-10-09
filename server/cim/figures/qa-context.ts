/**
 * The figure notes in the buyer Q&A's context (dd spec §9.3, P2): the
 * chatbot reads the same approved notes the buyer reads — in their version's
 * wording (Blind: the blind wording, no line labels) — so its answers agree
 * with the notes instead of guessing at why a figure moved. Built from the
 * buyer's own figure layer (buyerCimExtras → buildBuyerCim), never from the
 * broker's preview: suggested notes, hints and "no reason on file" never
 * reach it. Pure.
 */
import type { FigureLayer, FigureNoteView } from "@shared/figure-layer";
import { DD_SOURCE_CHECK_PAGE_ID } from "@shared/figure-layer";
import { STATE_WORDS } from "@shared/figure-states";

const MAX_CHARS = 4000;

export function figureNotesContext(layer: FigureLayer | null | undefined, sections: ReadonlyArray<{ id: string; sectionTitle?: string | null }>): string {
  if (!layer) return "";
  const blind = layer.mode === "blind";
  const titleOf = new Map(sections.map((s) => [s.id, String(s.sectionTitle ?? "").trim()]));
  const lines: string[] = [];
  const seen = new Set<string>();
  const note = (n: FigureNoteView | null | undefined) => (n ? `${n.text}${blind ? "" : ` (${n.basisLabel.replace(/\.$/, "")})`}` : "");
  for (const a of layer.anchors) {
    if (a.pageId === DD_SOURCE_CHECK_PAGE_ID || seen.has(a.fig)) continue;
    const f = layer.figures[a.fig];
    if (!f) continue;
    seen.add(a.fig);
    const what = blind || !f.label
      ? `A figure on "${titleOf.get(a.pageId) || "a page"}", FY${f.year} (${f.display})`
      : `${f.label}, FY${f.year} (${f.display})`;
    if (f.why) lines.push(`- ${what}: ${f.change ? `${f.change.line}. ` : ""}${note(f.why)}`);
    for (const c of f.checks ?? []) {
      if (c.kindLabel.startsWith("Financial statements")) continue;
      lines.push(`- ${what} vs ${c.kindLabel} ${c.value}: ${STATE_WORDS[c.state]}${c.note ? `. ${note(c.note)}` : ""}`);
    }
  }
  if (lines.length === 0) return "";
  let out = "";
  for (const l of lines) {
    if (out.length + l.length + 1 > MAX_CHARS) break;
    out += `${l}\n`;
  }
  return `\n\n## Notes on the figures (what this buyer can read)\n${out.trimEnd()}`;
}
