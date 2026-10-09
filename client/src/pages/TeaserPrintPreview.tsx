/**
 * TeaserPrintPreview — /deal/:dealId/teaser/print (broker only, no app chrome).
 *
 * The teaser exactly as a buyer is served it (the published version, or the
 * draft before it's published — GET …/teaser/preview), on true-size pages:
 * `@page { size: letter | A4; margin: 0 }`, one teaser page per printed page,
 * a buyer-safe footer "{Brokerage} · Confidential · {date}" on every page
 * (a printed copy may be handed to a buyer). The "ask from this page" step
 * becomes "Ask {firm} for the CIM: {contact}" (sectionsForPaper). Links stay the way buyers get
 * the teaser — there is no PDF download (CLAUDE.md: export strategy TBD).
 */
import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Printer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelError } from "@/components/deal/PanelError";
import { buildCimDesign } from "@/components/cim/CimDesignContext";
import { cn } from "@/lib/utils";
import { TeaserPages } from "@/components/teaser/TeaserPages";
import { teaserPreviewKey, teaserRequest, type TeaserPreviewPayload } from "@/components/teaser/api";
import { contactLine, type TeaserContact } from "@shared/teaser-view";
import type { BuyerSection } from "@shared/cim-buyer-view";

/**
 * On paper there's no page to ask from: the "Ask for the CIM from this page"
 * step becomes "Ask {firm} for the CIM: {contact}" (and the separate
 * "Questions?" line goes, since the step now carries the contact).
 */
export function sectionsForPaper(sections: BuyerSection[], contact: TeaserContact): BuyerSection[] {
  const firm = contact.firm?.trim() || null;
  const name = contact.name?.trim() || null;
  // Who to ask: the firm, else the broker's name; the rest of the contact after the colon.
  const who = firm ?? name ?? "the broker";
  const rest = contactLine({ firm: null, name: firm ? name : null, email: contact.email, phone: contact.phone });
  const line = rest && rest !== who ? rest : null;
  const withContact = !!line || (!firm && !!name);
  return sections.map((s) => {
    if (s.layoutType !== "numbered_list") return s;
    const d = (s.layoutData ?? {}) as { items?: Array<{ title?: string; description?: string }>; note?: string };
    const items = Array.isArray(d.items) ? d.items : [];
    const i = items.findIndex((it) => /\bfrom this page\b/i.test(it?.title ?? ""));
    if (i < 0) return s;
    const ask = `Ask ${who} for the CIM${line ? `: ${line}` : ""}`;
    const { note, ...rest } = d;
    return { ...s, layoutData: { ...rest, items: items.map((it, j) => (j === i ? { ...it, title: ask } : it)), ...(!withContact && note ? { note } : {}) } };
  });
}

export function printFooterText(firm: string | null | undefined, date = new Date()): string {
  const d = date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return [firm?.trim() || null, "Confidential", d].filter(Boolean).join(" · ");
}

export default function TeaserPrintPreview() {
  const { dealId = "" } = useParams<{ dealId: string }>();
  const [, navigate] = useLocation();
  const [which, setWhich] = useState<"published" | "draft">("published");
  const q = useQuery<TeaserPreviewPayload>({
    queryKey: teaserPreviewKey(dealId, which === "draft"),
    queryFn: () => teaserRequest("GET", `/api/deals/${dealId}/teaser/preview${which === "draft" ? "?draft=1" : ""}`),
    enabled: !!dealId,
  });
  const data = q.data;
  const design = useMemo(() => buildCimDesign(data?.design ?? null, "blind"), [data?.design]);
  const size = data?.teaser.pageSize === "a4" ? "A4" : "letter";
  const footer = printFooterText(data?.contact.firm ?? data?.branding?.companyName ?? null);
  const isDraft = !!data?.draft;
  const paper = useMemo(() => (data ? sectionsForPaper(data.teaser.blocks, data.contact) : []), [data]);

  return (
    <div className="min-h-screen bg-muted/30 print:bg-white" data-testid="teaser-print-preview">
      <style>{`
        @page { size: ${size}; margin: 0; }
        @media print {
          .teaser-print-page { break-after: page; page-break-after: always; }
          .teaser-print-page:last-child { break-after: auto; page-break-after: auto; }
          .teaser-print-sheet { border: none !important; box-shadow: none !important; border-radius: 0 !important; }
        }
      `}</style>
      <div className="sticky top-0 z-50 border-b border-border bg-background/95 backdrop-blur print:hidden">
        <div className="mx-auto flex max-w-[900px] flex-wrap items-center gap-2 px-3 py-2.5 sm:px-6">
          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => navigate(`/deal/${dealId}/cim?view=teaser`)} aria-label="Back to the teaser">
            <ArrowLeft className="h-4 w-4" />
          </Button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">Teaser{data ? ` — ${data.deal.businessName}` : ""}</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Print preview · broker only</p>
          </div>
          <div className="flex rounded-md border border-border bg-muted/30 p-0.5" role="tablist">
            {(["published", "draft"] as const).map((w) => (
              <button
                key={w}
                role="tab"
                aria-selected={which === w}
                onClick={() => setWhich(w)}
                className={cn("rounded px-2.5 py-1 text-[11px]", which === w ? "bg-background font-medium text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}
              >
                {w === "published" ? "What buyers see" : "The draft"}
              </button>
            ))}
          </div>
          <Button size="sm" className="h-8 gap-1.5 bg-teal text-teal-foreground hover:bg-teal/90" onClick={() => window.print()} disabled={!data || data.teaser.blocks.length === 0} data-testid="button-print-teaser">
            <Printer className="h-3.5 w-3.5" /> Print
          </Button>
        </div>
        <p className="mx-auto max-w-[900px] px-3 pb-2 text-[11px] text-muted-foreground sm:px-6">
          {isDraft && which === "published" ? "Not published yet — this is the draft. " : ""}
          Every page carries “{footer}”. Tip: turn on “Background graphics” in the print dialog.
        </p>
      </div>
      <div className="mx-auto max-w-[900px] px-3 py-6 print:max-w-none print:p-0 sm:px-6">
        {q.isLoading ? (
          <Skeleton className="mx-auto h-[80vh] max-w-[816px] rounded-md" />
        ) : q.error || !data ? (
          <PanelError what="the teaser" onRetry={() => q.refetch()} />
        ) : data.teaser.blocks.length === 0 ? (
          <div className="rounded-lg border border-border bg-card p-8 text-center text-sm text-muted-foreground">Nothing to print yet — write the teaser first.</div>
        ) : (
          <div className="overflow-x-auto print:overflow-visible">
            <TeaserPages header={data.teaser.header} sections={paper} pageSize={data.teaser.pageSize} design={design} mode="print" printFooter={footer} />
          </div>
        )}
      </div>
    </div>
  );
}
