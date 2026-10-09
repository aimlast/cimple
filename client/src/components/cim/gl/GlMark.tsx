/**
 * GlMark — the add-backs' "found in the books" marks on the CIM paper (gl
 * spec §3.6, INTEGRATION §2.7 rule 6).
 *
 *   variant="footnote"  the Full/Blind note under the earnings-bridge
 *                       section (layoutData._glNote), rendered by
 *                       CimSectionRenderer. Constants, counts and years.
 *   variant="row"       a small chip on one bridge row — placed by the dd
 *                       stream where a bridge figure maps to an add-back
 *                       (CimBridgeLine.addbackId → glLineIdsForDeal); shown
 *                       only when that line's mark is on.
 *
 * Paper colours only (.cim-doc is theme-locked).
 */
import { BookCheck } from "lucide-react";
import type { GlNoteData } from "@shared/gl-evidence";
import { useGlMarks } from "./GlLinks";

/** Theme-locked ink for "found" (a deep green that reads on the paper in every app theme). */
export const GL_FOUND_INK = "#2F6B45";

type FootnoteProps = { variant: "footnote"; note: GlNoteData; preview?: boolean };
type RowProps = { variant: "row"; lineId: string; mark?: boolean; href?: string | null };

export function GlMark(props: FootnoteProps | RowProps) {
  if (props.variant === "footnote") return <GlFootnote note={props.note} preview={props.preview} />;
  return <GlRowMark lineId={props.lineId} mark={props.mark} href={props.href} />;
}

function GlFootnote({ note, preview }: { note: GlNoteData; preview?: boolean }) {
  return (
    <div className="mt-4 border-t border-[hsl(var(--cim-line))] pt-3" data-testid="gl-note">
      {preview && (
        <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-[hsl(var(--cim-brass))]" data-testid="gl-note-preview">
          Not shown to buyers yet — publish it on Financials → Add-backs in the books
        </p>
      )}
      <p className="flex items-start gap-2 text-xs leading-relaxed text-[hsl(var(--cim-ink-soft))]">
        <BookCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: GL_FOUND_INK }} aria-hidden />
        <span>{note.text}</span>
      </p>
    </div>
  );
}

function GlRowMark({ lineId, mark, href }: { lineId: string; mark?: boolean; href?: string | null }) {
  const marks = useGlMarks();
  const on = mark ?? !!marks?.has(lineId);
  if (!on) return null;
  const chip = (
    <span
      className="ml-1.5 inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium align-middle"
      style={{ color: GL_FOUND_INK, borderColor: `${GL_FOUND_INK}55`, backgroundColor: `${GL_FOUND_INK}0f` }}
      data-testid={`gl-row-mark-${lineId}`}
      title="The entries behind this add-back were found in the company's general ledger. Matched by the owner and reviewed by the broker; not an audit."
    >
      <BookCheck className="h-3 w-3" aria-hidden /> Found in the books
    </span>
  );
  return href ? <a href={href} className="no-underline">{chip}</a> : chip;
}
