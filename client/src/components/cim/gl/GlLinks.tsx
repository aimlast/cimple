/**
 * GlLinks — how the add-back evidence links out of the CIM paper (gl spec
 * §3.6, INTEGRATION §2.6–2.7): to the general ledger in the data room and
 * to supporting documents. The data room fills this context (its
 * VdrLinkProvider: `ledger` renders "Open the general ledger in the data
 * room →" when the ledger is visible to this buyer, else its "Ask your
 * broker for it" state; `doc` renders a VdrCitationChip). Without it —
 * previews, print, the seller's review — plain words are shown, never a
 * file's own name.
 *
 * GlMarks: which add-back lines carry the "Found in the books" mark, for
 * row chips placed elsewhere in the CIM (GlMark variant="row").
 */
import { createContext, useContext, type ReactNode } from "react";
import { GL_EVIDENCE_LAYOUT, glNoteOf, isGlEvidencePayload } from "@shared/gl-evidence";

export interface GlLinkRenderers {
  /** The ledger link for one add-back (rows = the entries' row numbers, highlighted in the viewer). */
  ledger?: (documentId: string, rows: number[]) => ReactNode;
  /** A citation for a supporting document (neutral label in; the room's title out when the buyer may open it). */
  doc?: (documentId: string, label: string) => ReactNode;
}

const LinkContext = createContext<GlLinkRenderers>({});

export function GlLinkProvider({ value, children }: { value: GlLinkRenderers; children: ReactNode }) {
  return <LinkContext.Provider value={value}>{children}</LinkContext.Provider>;
}

export function useGlLinks(): GlLinkRenderers {
  return useContext(LinkContext);
}

const MarksContext = createContext<ReadonlySet<string> | null>(null);

/** The lines whose mark is on (from the DD page's payload, or the Full/Blind note's lineIds). */
export function GlMarksProvider({ marks, children }: { marks: ReadonlySet<string>; children: ReactNode }) {
  return <MarksContext.Provider value={marks}>{children}</MarksContext.Provider>;
}

export function useGlMarks(): ReadonlySet<string> | null {
  return useContext(MarksContext);
}

/**
 * The lines whose mark is on, read from the sections a reader is served: the
 * DD page's payload (`mark` per line) and the Full/Blind note's `lineIds`.
 * The figure layer only says WHERE a bridge row's line is; whether it may say
 * "Found in the books" is gl's published decision, carried here.
 */
export function glMarkedLineIds(sections: ReadonlyArray<{ layoutType: string; layoutData: unknown }>): Set<string> {
  const out = new Set<string>();
  for (const s of sections) {
    if (s.layoutType === GL_EVIDENCE_LAYOUT && isGlEvidencePayload(s.layoutData)) {
      for (const l of s.layoutData.lines) if (l.mark && typeof l.lineId === "string") out.add(l.lineId);
    }
    const note = glNoteOf(s.layoutData);
    if (note) for (const id of note.lineIds) out.add(id);
  }
  return out;
}
