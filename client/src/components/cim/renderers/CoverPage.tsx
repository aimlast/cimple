/**
 * CoverPage renderer
 * Full-bleed premium pitch-book cover — deep warm ink with cream type.
 *
 * THEME-LOCKED: every color here is a deliberate literal (see CIM_DOC).
 * The old version used `bg-foreground` + `text-white`, which inverted to a
 * bright-cream background with white type in the dark app theme. The cover
 * must look identical in dark mode, light mode, and print.
 */
import { cn } from "@/lib/utils";
import { CIM_DOC } from "../CimBrandingContext";
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

const CREAM = CIM_DOC.coverCream;

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

  const accentHex = branding.accentHex || branding.primaryHex || CIM_DOC.brass;

  return (
    <div
      className="relative min-h-[680px] flex flex-col justify-between overflow-hidden rounded-lg select-none"
      style={{
        background: `linear-gradient(165deg, ${CIM_DOC.coverInkHi} 0%, ${CIM_DOC.coverInk} 55%, #131009 130%)`,
        color: CREAM,
      }}
    >
      {/* Subtle texture overlay */}
      <div className="absolute inset-0 opacity-[0.03]"
        style={{ backgroundImage: `repeating-linear-gradient(45deg, ${CREAM} 0, ${CREAM} 1px, transparent 0, transparent 50%)`, backgroundSize: "6px 6px" }} />

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
          <span className="text-2xs tracking-wide" style={{ color: `${CREAM}4D` }}>{data.date}</span>
        )}
      </div>

      {/* Main content */}
      <div className="relative z-10 flex-1 flex flex-col justify-center px-12 py-16">
        {/* Industry / location badge */}
        {(data.industry || data.location) && (
          <div className="flex items-center gap-3 mb-8">
            {data.industry && (
              <span
                className="text-xs font-medium px-3 py-1 rounded-full border"
                style={{ borderColor: `${CREAM}26`, color: `${CREAM}99` }}
              >
                {data.industry}
              </span>
            )}
            {data.location && (
              <span
                className="text-xs font-medium px-3 py-1 rounded-full border"
                style={{ borderColor: `${CREAM}26`, color: `${CREAM}99` }}
              >
                {data.location}
              </span>
            )}
          </div>
        )}

        {/* Business name */}
        <h1
          className="text-5xl font-semibold tracking-tight leading-tight mb-4 max-w-2xl"
          style={{ color: CREAM }}
        >
          {businessName}
        </h1>

        {/* Tagline */}
        {data.tagline && (
          <p className="text-lg font-normal mt-2 max-w-xl leading-relaxed" style={{ color: `${CREAM}99` }}>
            {data.tagline}
          </p>
        )}

        {/* Metrics row */}
        {metrics.length > 0 && (
          <div className="flex items-center gap-6 mt-12">
            {metrics.map((m, i) => (
              <div key={i} className="flex flex-col">
                <span className="text-xl font-semibold tabular-nums" style={{ color: CREAM }}>{m.value}</span>
                <span className="text-2xs uppercase tracking-widest mt-0.5" style={{ color: `${CREAM}66` }}>{m.label}</span>
              </div>
            ))}
            {metrics.length > 0 && (
              <div className="h-8 w-px mx-1 first:hidden" style={{ backgroundColor: `${CREAM}1A` }} />
            )}
          </div>
        )}

        {/* Prose fallback */}
        {metrics.length === 0 && content && (
          <p className="text-sm mt-8 max-w-lg leading-relaxed" style={{ color: `${CREAM}80` }}>{content}</p>
        )}
      </div>

      {/* Footer — firm name */}
      <div className="relative z-10 flex items-end justify-between px-12 pb-10">
        <div>
          {firmName && (
            <p className="text-sm font-semibold" style={{ color: `${CREAM}B3` }}>{firmName}</p>
          )}
          <p className="text-2xs mt-1 tracking-wide" style={{ color: `${CREAM}40` }}>
            This document is strictly confidential and intended solely for the named recipient.
          </p>
        </div>
        {/* Accent mark */}
        <div className="w-8 h-8 rounded-full border-2 opacity-25" style={{ borderColor: accentHex }} />
      </div>

      {/* Bottom accent line */}
      <div className="absolute bottom-0 left-0 right-0 h-[1px]" style={{ backgroundColor: `${CREAM}0D` }} />
    </div>
  );
}
