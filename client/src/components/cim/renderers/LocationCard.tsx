/**
 * LocationCard renderer
 * Grid of location cards with lease term pills and key:value details.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { formatSqft, rentLabel, splitLeaseType } from "@shared/cim-location";
import { ProseFallback, renderInline } from "../richText";
import { BlockTitle } from "./BlockTitle";

interface Location {
  label?: string;
  address?: string;
  sqft?: string | number;
  leaseType?: string;
  leaseExpiry?: string;
  monthlyRent?: string;
  annualRent?: string;
  renewalOptions?: string;
  /** The lease's terms in words, when leaseType is only the short kind ("Triple-net lease"). */
  leaseTerms?: string;
  notes?: string;
}

interface LocationCardLayoutData {
  locations?: Location[];
  totalSqft?: string | number;
  title?: string;
}

interface RendererProps {
  layoutData: LocationCardLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

function LeaseTypePill({ type }: { type: string }) {
  const lower = type.toLowerCase();
  const isOwned = lower.includes("own") || lower === "freehold";
  const isMtm = lower.includes("month") || lower === "mtm";

  return (
    <span className={cn(
      "text-2xs font-semibold px-2 py-0.5 rounded-full",
      isOwned
        ? "bg-teal-muted text-teal-muted-foreground"
        : isMtm
        ? "bg-[hsl(var(--cim-caution)/0.1)] text-[hsl(var(--cim-caution))] border border-[hsl(var(--cim-caution)/0.3)]"
        : "bg-muted text-muted-foreground"
    )}>
      {type}
    </span>
  );
}

function KVRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1 border-b border-border/30 last:border-0">
      <span className="text-2xs text-muted-foreground flex-shrink-0">{label}</span>
      <span className="text-xs font-medium text-foreground text-right min-w-0 break-words">{value}</span>
    </div>
  );
}

// The wording helpers live in shared/ so the buyer chatbot describes the card
// the way it renders (server/qa/cim-context.ts).
export { formatSqft, splitLeaseType, rentLabel };

export function LocationCardRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: LocationCardLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const locations = data.locations || [];

  if (locations.length === 0) {
    if (!content) return null;
    return <ProseFallback content={content} />;
  }

  const gridClass = locations.length === 1
    ? "grid-cols-1 max-w-md"
    : locations.length === 2
    ? "grid-cols-1 sm:grid-cols-2"
    : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";

  return (
    <div>
      <BlockTitle title={data.title} intro={(data as { intro?: unknown }).intro} />
      <div className={cn("grid gap-4", gridClass)}>
        {locations.map((loc, i) => {
          const lease = splitLeaseType(loc.leaseType);
          const terms = [lease.terms, typeof loc.leaseTerms === "string" ? loc.leaseTerms.trim() : ""].filter(Boolean).join(" ");
          return (
          <div key={i} className="bg-card border border-card-border rounded-lg p-4 min-w-0">
            {/* Header — the lease badge sits under the address, never beside
                it, so a long label can't squeeze the address or cover the name. */}
            <div className="mb-3 min-w-0">
              {loc.label && (
                <p className="text-xs font-semibold text-teal mb-1 break-words">{loc.label}</p>
              )}
              {loc.address && (
                <p className="text-sm font-medium text-foreground leading-snug break-words">{loc.address}</p>
              )}
              {lease.badge && (
                <div className="mt-2">
                  <LeaseTypePill type={lease.badge} />
                </div>
              )}
            </div>

            {/* Details */}
            <div className="space-y-0">
              {loc.sqft && (
                <KVRow
                  label="Size"
                  value={formatSqft(loc.sqft)}
                />
              )}
              {loc.leaseExpiry && <KVRow label="Lease Expiry" value={loc.leaseExpiry} />}
              {loc.monthlyRent && <KVRow label={rentLabel("monthlyRent", loc.monthlyRent)} value={loc.monthlyRent} />}
              {loc.annualRent && <KVRow label={rentLabel("annualRent", loc.annualRent)} value={loc.annualRent} />}
              {loc.renewalOptions && <KVRow label="Renewal Options" value={loc.renewalOptions} />}
            </div>

            {/* The lease's terms in words (from a long lease type) */}
            {terms && (
              <p className="text-2xs text-muted-foreground mt-2 pt-2 border-t border-border/30 leading-snug break-words">
                <span className="font-semibold text-foreground/70">Lease terms: </span>
                {renderInline(terms, "terms")}
              </p>
            )}

            {/* Notes */}
            {loc.notes && (
              <p className="text-2xs text-muted-foreground mt-2 pt-2 border-t border-border/30 leading-snug">
                {renderInline(loc.notes, "notes")}
              </p>
            )}
          </div>
          );
        })}
      </div>

      {/* Footer: total sqft */}
      {data.totalSqft != null && (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Total Space:</span>
          <span className="text-sm font-semibold tabular-nums">
            {formatSqft(data.totalSqft)}
          </span>
        </div>
      )}
    </div>
  );
}
