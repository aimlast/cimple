/**
 * LocationCard renderer
 * Grid of location cards with lease term pills and key:value details.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface Location {
  label?: string;
  address?: string;
  sqft?: string | number;
  leaseType?: string;
  leaseExpiry?: string;
  monthlyRent?: string;
  annualRent?: string;
  renewalOptions?: string;
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
        ? "bg-amber-50 text-amber-700 border border-amber-200"
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
      <span className="text-xs font-medium text-foreground text-right">{value}</span>
    </div>
  );
}

export function LocationCardRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: LocationCardLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};
  const locations = data.locations || [];

  if (locations.length === 0) {
    if (!content) return null;
    return <p className="text-sm text-foreground/70 leading-relaxed">{content}</p>;
  }

  const gridClass = locations.length === 1
    ? "grid-cols-1 max-w-md"
    : locations.length === 2
    ? "grid-cols-1 sm:grid-cols-2"
    : "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3";

  return (
    <div>
      {data.title && (
        <h3 className="text-sm font-semibold text-foreground/60 uppercase tracking-widest mb-4">
          {data.title}
        </h3>
      )}
      <div className={cn("grid gap-4", gridClass)}>
        {locations.map((loc, i) => (
          <div key={i} className="bg-card border border-card-border rounded-lg p-4">
            {/* Header */}
            <div className="flex items-start justify-between gap-2 mb-3">
              <div className="flex-1 min-w-0">
                {loc.label && (
                  <p className="text-xs font-semibold text-teal mb-1">{loc.label}</p>
                )}
                {loc.address && (
                  <p className="text-sm font-medium text-foreground leading-snug">{loc.address}</p>
                )}
              </div>
              {loc.leaseType && <LeaseTypePill type={loc.leaseType} />}
            </div>

            {/* Details */}
            <div className="space-y-0">
              {loc.sqft && (
                <KVRow
                  label="Size"
                  value={`${typeof loc.sqft === "number" ? loc.sqft.toLocaleString() : loc.sqft} sq ft`}
                />
              )}
              {loc.leaseExpiry && <KVRow label="Lease Expiry" value={loc.leaseExpiry} />}
              {loc.monthlyRent && <KVRow label="Monthly Rent" value={loc.monthlyRent} />}
              {loc.annualRent && <KVRow label="Annual Rent" value={loc.annualRent} />}
              {loc.renewalOptions && <KVRow label="Renewal Options" value={loc.renewalOptions} />}
            </div>

            {/* Notes */}
            {loc.notes && (
              <p className="text-2xs text-muted-foreground mt-2 pt-2 border-t border-border/30 leading-snug">
                {loc.notes}
              </p>
            )}
          </div>
        ))}
      </div>

      {/* Footer: total sqft */}
      {data.totalSqft != null && (
        <div className="mt-4 pt-3 border-t border-border flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Total Space:</span>
          <span className="text-sm font-semibold tabular-nums">
            {typeof data.totalSqft === "number" ? data.totalSqft.toLocaleString() : data.totalSqft} sq ft
          </span>
        </div>
      )}
    </div>
  );
}
