/**
 * TeaserHeader — the top of a teaser's first page: "CONFIDENTIAL
 * OPPORTUNITY", the codename, the one-line description and the chips
 * (industry, province or state, "Established 20+ years"), with the
 * BROKERAGE's logo only (never the business's, never Cimple's — brand rule).
 *
 * Reading analytics: the page "teaser_header" with one block, "heading"
 * (server/analytics/renditions.ts teaserHeaderPage) — attributes are written
 * only inside the buyer view room's CimBlocksProvider.
 */
import { useBlockAttrs, usePageAttrs } from "@/components/cim/blocks";
import { useCimDesign, useCimTheme } from "@/components/cim/CimDesignContext";
import { cn } from "@/lib/utils";

export const TEASER_HEADER_PAGE_ID = "teaser_header";

export interface TeaserHeaderView {
  label: string;
  codename: string;
  tagline: string;
  chips: string[];
}

export function TeaserHeader({ header, className, warning }: { header: TeaserHeaderView; className?: string; warning?: string | null }) {
  const theme = useCimTheme();
  const design = useCimDesign();
  const pageAttrs = usePageAttrs(TEASER_HEADER_PAGE_ID);
  const ba = useBlockAttrs();
  const logo = design.brokerage.logoUrl;
  const firm = design.brokerage.firmName;
  return (
    <div className={cn("cim-doc relative", className)} {...pageAttrs} data-teaser-header="">
      <div {...ba("heading")}>
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em]" style={{ color: theme.accentText }}>
              {header.label}
            </p>
            <h1 className="cim-display mt-1.5 text-[30px] leading-[1.08] tracking-tight break-words" style={{ color: theme.heading }}>
              {header.codename}
            </h1>
          </div>
          {logo ? (
            <img src={logo} alt={firm ? `${firm} logo` : "Brokerage logo"} className="h-10 max-w-[150px] w-auto object-contain shrink-0" />
          ) : firm ? (
            <p className="text-xs font-semibold shrink-0 text-right max-w-[180px]" style={{ color: theme.inkSoft }}>{firm}</p>
          ) : null}
        </div>
        {header.tagline && (
          <p className="mt-2 text-[14px] leading-snug max-w-[60ch]" style={{ color: theme.inkSoft }}>{header.tagline}</p>
        )}
        {header.chips.length > 0 && (
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {header.chips.map((c, i) => (
              <span
                key={`${c}-${i}`}
                className="rounded-full px-2.5 py-1 text-[11px] font-medium"
                style={{ backgroundColor: theme.accentSoft, color: theme.accentSoftText }}
              >
                {c}
              </span>
            ))}
          </div>
        )}
        <div className="mt-3 h-px w-full" style={{ backgroundColor: theme.line }} />
      </div>
      {warning && (
        <p className="mt-2 rounded-md border border-red-500/40 bg-red-500/10 px-2.5 py-1.5 text-[11px] text-red-700" role="alert">{warning}</p>
      )}
    </div>
  );
}
