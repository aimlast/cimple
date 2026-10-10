/**
 * GlRoomLinkProvider — the data room fills gl's link slots on the CIM paper
 * (gl's GlLinkProvider; INTEGRATION §2.6–2.7, gl ship notes "integrator
 * wiring"). Mounted inside VdrLinkProvider, around the CIM:
 *
 *  - `ledger(documentId, rows)` → "Open the general ledger in the data room →"
 *    when this buyer can open the ledger (it opens beside the CIM with the
 *    add-back's entries highlighted); otherwise gl's plain sentence and the
 *    room's neutral "General ledger" chip with "Ask your broker for it".
 *  - `doc(documentId, label)` → a VdrCitationChip. gl's neutral label only
 *    picks the chip's kind and year (the chip itself never carries a title;
 *    a document the buyer can open shows its room title).
 *
 * Outside a VdrLinkProvider (previews, print, the seller's review) gl shows
 * plain words, so this renders its children untouched there. Inside a broker
 * VdrLinkProvider (the CIM builder preview, mounted at the dd merge) both
 * slots render the room's broker chip (the document's name, a link into the
 * Data room tab).
 */
import { useEffect, type ReactNode } from "react";
import { BookOpen } from "lucide-react";
import { GlLinkProvider, type GlLinkRenderers } from "@/components/cim/gl/GlLinks";
import type { VdrDocKind } from "@shared/vdr";
import type { ResolvedDocument } from "@shared/vdr-api";
import { VdrCitationChip } from "./VdrCitationChip";
import { useVdrLinks } from "./VdrLinkContext";

const BRASS = "#9E752E";

/** gl's neutral document label ("T4 2024", "Invoice or letter (2024)", "Financial statements 2023") → the room's kind + year. */
export function glDocRef(documentId: string, label: string): { documentId: string; kind: VdrDocKind; period: string | null } {
  const year = label.match(/\b(19|20)\d{2}\b/)?.[0] ?? null;
  const l = label.toLowerCase();
  const kind: VdrDocKind = /financial statements?/.test(l)
    ? "financial_statements"
    : /\b(t4|t4a|w-?2|1099|payroll|pay stub|pay slip|paystub)\b/.test(l)
      ? "payroll_report"
      : /invoice/.test(l)
        ? "invoice"
        : "other";
  return { documentId, kind, period: year };
}

function LedgerLink({ documentId, rows }: { documentId: string; rows: number[] }) {
  const links = useVdrLinks();
  useEffect(() => { if (links && documentId) links.request(documentId); }, [links?.request, documentId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The broker's own CIM preview (once a broker VdrLinkProvider wraps it): the room's chip — the
  // ledger's own name and a link into the Data room tab (never the buyer's "ask your broker" words).
  if (links && links.source.kind === "broker") return <VdrCitationChip docRef={{ documentId, kind: "general_ledger" }} />;
  const res = links?.resolved(documentId) as ResolvedDocument | undefined;
  if (links && res && res.available) {
    return (
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:underline"
        style={{ color: BRASS }}
        onClick={() => links.open({ itemId: res.itemId, title: res.title, number: res.number, page: null, needle: null, sheet: null, rows: rows.length ? rows : null, replaced: !!res.replaced })}
        data-testid="gl-ledger-room-link"
      >
        <BookOpen className="h-3 w-3 shrink-0" /> Open the general ledger in the data room →
      </button>
    );
  }
  return (
    <span data-testid="gl-ledger-room-unavailable">
      <span className="text-[hsl(var(--cim-ink-muted))]">The full general ledger is in the data room — ask your broker for access. </span>
      {links && res && <VdrCitationChip docRef={{ documentId, kind: "general_ledger" }} />}
    </span>
  );
}

const RENDERERS: GlLinkRenderers = {
  ledger: (documentId, rows) => <LedgerLink documentId={documentId} rows={rows} />,
  doc: (documentId, label) => <VdrCitationChip docRef={glDocRef(documentId, label)} />,
};

export function GlRoomLinkProvider({ children }: { children: ReactNode }) {
  return <GlLinkProvider value={RENDERERS}>{children}</GlLinkProvider>;
}
