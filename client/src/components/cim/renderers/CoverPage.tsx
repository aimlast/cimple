/**
 * CoverPage renderer
 * Full-bleed dark cover page — Goldman Sachs pitch book style.
 */
import { cn } from "@/lib/utils";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";

interface CoverPageLayoutData {
  businessName?: string;
  tagline?: string;
  industry?: string;
  location?: string;
  askingPrice?: string;
  revenue?: string;
  ebitda?: string;
  preparedBy?: string;
  date?: string;
  confidentialLabel?: string;
}

interface RendererProps {
  layoutData: CoverPageLayoutData;
  content: string;
  branding: CimBranding;
  section: CimSection;
}

export function CoverPageRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: CoverPageLayoutData = layoutData && Object.keys(layoutData).length > 0
    ? layoutData
    : {};

  const businessName = data.businessName || (section as any).sectionTitle || "Business Overview";
  const confidentialLabel = data.confidentialLabel || "CONFIDENTIAL BUSINESS OVERVIEW";
  const firmName = branding.firmName || data.preparedBy || "";
  const metrics = [
    data.askingPrice && { label: "Asking Price", value: data.askingPrice },
    data.revenue && { label: "Annual Revenue", value: data.revenue },
    data.ebitda && { label: "EBITDA", value: data.ebitda },
  ].filter(Boolean) as { label: string; value: string }[];

  const accentHex = branding.accentHex || branding.primaryHex || "#2dc88e";

  return (
    <div className="relative min-h-[680px] bg-foreground flex flex-col justify-between overflow-hidden rounded-lg select-none">
      {/* Subtle texture overlay */}
      <div className="absolute inset-0 opacity-[0.03]"
        style={{ backgroundImage: "repeating-linear-gradient(45deg, #fff 0, #fff 1px, transparent 0, transparent 50%)", backgroundSize: "6px 6px" }} />

      {/* Accent line at top */}
      <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ backgroundColor: accentHex }} />

      {/* Header — confidential label */}
      <div className="relative z-10 flex items-center justify-between px-12 pt-12">
        <span
          className="text-2xs font-semibold tracking-[0.2em] uppercase"
          style={{ color: accentHex }}
        >
          {confidentialLabel}
        </span>
        {data.date && (
          <span className="text-2xs text-white/30 tracking-wide">{data.date}</span>
        )}
      </div>

      {/* Main content */}
      <div className="relative z-10 flex-1 flex flex-col justify-center px-12 py-16">
        {/* Industry / location badge */}
        {(data.industry || data.location) && (
          <div className="flex items-center gap-3 mb-8">
            {data.industry && (
              <span className="text-xs font-medium px-3 py-1 rounded-full border border-white/10 text-white/50">
                {data.industry}
              </span>
            )}
            {data.location && (
              <span className="text-xs font-medium px-3 py-1 rounded-full border border-white/10 text-white/50">
                {data.location}
              </span>
            )}
          </div>
        )}

        {/* Business name */}
        <h1 className="text-5xl font-semibold tracking-tight text-white leading-tight mb-4 max-w-2xl">
          {businessName}
        </h1>

        {/* Tagline */}
        {data.tagline && (
          <p className="text-lg text-white/50 font-normal mt-2 max-w-xl leading-relaxed">
            {data.tagline}
          </p>
        )}

        {/* Metrics row */}
        {metrics.length > 0 && (
          <div className="flex items-center gap-6 mt-12">
            {metrics.map((m, i) => (
              <div key={i} className="flex flex-col">
                <span className="text-xl font-semibold text-white">{m.value}</span>
                <span className="text-2xs uppercase tracking-widest text-white/35 mt-0.5">{m.label}</span>
              </div>
            ))}
            {metrics.length > 0 && (
              <div className="h-8 w-px bg-white/10 mx-1 first:hidden" />
            )}
          </div>
        )}

        {/* Prose fallback */}
        {metrics.length === 0 && content && (
          <p className="text-sm text-white/40 mt-8 max-w-lg leading-relaxed">{content}</p>
        )}
      </div>

      {/* Footer — firm name */}
      <div className="relative z-10 flex items-end justify-between px-12 pb-10">
        <div>
          {firmName && (
            <p className="text-sm font-semibold text-white/70">{firmName}</p>
          )}
          <p className="text-2xs text-white/20 mt-1 tracking-wide">
            This document is strictly confidential and intended solely for the named recipient.
          </p>
        </div>
        {/* Accent mark */}
        <div className="w-8 h-8 rounded-full border-2 opacity-20" style={{ borderColor: accentHex }} />
      </div>

      {/* Bottom accent line */}
      <div className="absolute bottom-0 left-0 right-0 h-[1px] bg-white/5" />
    </div>
  );
}
