/**
 * VdrCitationChip — a DD CIM figure's source document (vdr spec §6.6,
 * §11.1.2; INTEGRATION §2.6). Placed by dd; owned by vdr.
 *
 * It takes NO title: the text always comes from the data room.
 *  - The reader can open the document → the room's title (+ " · p. 3"),
 *    and a click opens it beside the CIM (VdrViewerDrawer). One shared with
 *    them that is still being prepared reads "· getting it ready" and opens
 *    the same way (the viewer waits for it) — never the lock.
 *  - Anything else (not shared, no data room, private, unknown, a ledger
 *    that isn't ready, a new version not shared yet) → the neutral label from
 *    a fixed vocabulary ("Tax return 2023", else "A supporting document")
 *    and "This document isn't in your data room yet. · Ask your broker for
 *    it". The cases look the same, and no document name ever appears.
 *  - Outside a VdrLinkProvider (print preview, the heat map's page canvas,
 *    the seller's review page) → the neutral label as plain text.
 *  - Broker preview → the document's own name and a link into the Data room
 *    tab (private files are marked as such; they never reach buyers).
 * Theme-locked to the CIM paper (it lives inside `.cim-doc`).
 */
import { useEffect, useState } from "react";
import { FileText, Lock } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { citationLabel, vdrBrokerHref, type VdrDocRef } from "@shared/vdr";
import type { BrokerResolvedDocument, ResolvedDocument } from "@shared/vdr-api";
import { useVdrLinks } from "./VdrLinkContext";

const BRASS = "#9E752E";
const INK = "#201D18";
const MUTED = "#6B655B";

/** The chip's words for a visible document: its room title and the page. */
export function visibleChipText(title: string, page: number | null | undefined, replaced?: boolean): string {
  return `${title}${!replaced && page && page > 0 ? ` · p. ${Math.floor(page)}` : ""}`;
}

export function VdrCitationChip({ docRef, className }: { docRef: VdrDocRef; className?: string }) {
  const links = useVdrLinks();
  const neutral = citationLabel(docRef);
  const id = docRef.documentId;
  useEffect(() => { if (links && id) links.request(id); }, [links?.request, id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!links || !id) {
    return <span className={className} data-vdr-chip="plain" style={{ color: MUTED }}>{neutral}</span>;
  }
  const r = links.resolved(id);
  if (links.source.kind === "broker") return <BrokerChip dealId={links.source.dealId} r={r as BrokerResolvedDocument | undefined} docRef={docRef} neutral={neutral} className={className} />;
  const res = r as ResolvedDocument | undefined;
  if (res && res.available) {
    return (
      <button
        type="button"
        className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 align-baseline hover:underline ${className ?? ""}`}
        style={{ color: BRASS, borderColor: `${BRASS}55`, background: `${BRASS}0F` }}
        onClick={() => links.open({ itemId: res.itemId, title: res.title, number: res.number, page: res.replaced ? null : docRef.page ?? null, needle: docRef.needle ?? null, sheet: docRef.sheet ?? null, rows: docRef.rows ?? null, replaced: !!res.replaced })}
        data-vdr-chip="open"
        data-testid="vdr-citation-open"
      >
        <FileText className="h-3 w-3 shrink-0" />
        <span className="truncate">{visibleChipText(res.title, docRef.page, res.replaced)}</span>
        {res.replaced && <span style={{ color: MUTED }}>· updated</span>}
        {res.preparing && <span className="shrink-0" style={{ color: MUTED }} data-testid="vdr-citation-preparing">· getting it ready</span>}
      </button>
    );
  }
  return <UnavailableChip neutral={neutral} loading={!res} onAsk={() => links.askFor(id, neutral)} className={className} />;
}

function UnavailableChip({ neutral, loading, onAsk, className }: { neutral: string; loading: boolean; onAsk: () => Promise<"asked" | "asked_room" | "failed">; className?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "asked" | "asked_room" | "failed">("idle");
  const chip = (
    <span
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 align-baseline ${className ?? ""}`}
      style={{ color: MUTED, borderColor: "#D9D3C7" }}
      data-vdr-chip="neutral"
      data-testid="vdr-citation-neutral"
    >
      {!loading && <Lock className="h-3 w-3 shrink-0" />}
      <span className="truncate">{neutral}</span>
    </span>
  );
  if (loading) return chip;
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className="inline-flex max-w-full align-baseline" aria-label={`${neutral}: not in your data room yet`}>{chip}</button>
      </PopoverTrigger>
      <PopoverContent className="w-64 space-y-2 p-3 text-xs" style={{ background: "#FBF9F4", color: INK, borderColor: "#E2DED5" }}>
        <p>This document isn't in your data room yet.</p>
        {state === "asked" ? (
          <p style={{ color: MUTED }}>Asked. Your broker will see it.</p>
        ) : state === "asked_room" ? (
          <p style={{ color: MUTED }}>Asked for the data room. Your broker decides who gets it.</p>
        ) : state === "failed" ? (
          <p style={{ color: MUTED }}>That didn't go through. Ask your broker in the questions box.</p>
        ) : (
          <button
            type="button"
            className="rounded-md border px-2.5 py-1 font-medium"
            style={{ borderColor: `${BRASS}66`, color: BRASS }}
            disabled={state === "busy"}
            onClick={async () => { setState("busy"); setState(await onAsk()); }}
            data-testid="vdr-citation-ask"
          >
            {state === "busy" ? "Asking…" : "Ask your broker for it"}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function BrokerChip({ dealId, r, docRef, neutral, className }: { dealId: string; r: BrokerResolvedDocument | undefined; docRef: VdrDocRef; neutral: string; className?: string }) {
  if (!r || !r.available) return <span className={className} style={{ color: MUTED }} data-vdr-chip="broker-missing">{neutral}{r ? " (no longer in the deal)" : ""}</span>;
  const href = r.itemId ? vdrBrokerHref(dealId, { itemId: r.itemId }) : `/deal/${encodeURIComponent(dealId)}/data-room?folder=not_placed`;
  return (
    <a
      href={href}
      className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] leading-4 align-baseline hover:underline ${className ?? ""}`}
      style={{ color: BRASS, borderColor: `${BRASS}55`, background: `${BRASS}0F` }}
      data-vdr-chip="broker"
      title={r.brokerOnly ? "A private file: buyers never see it" : r.inRoom ? "Open it in the Data room tab" : "Not in the data room yet"}
    >
      <FileText className="h-3 w-3 shrink-0" />
      <span className="truncate">{visibleChipText(r.title, docRef.page, r.replaced)}</span>
      {r.brokerOnly ? <span style={{ color: MUTED }}>· private</span> : !r.inRoom ? <span style={{ color: MUTED }}>· not in the room</span> : null}
    </a>
  );
}
