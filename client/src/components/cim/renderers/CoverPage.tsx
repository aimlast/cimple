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
  /** Label for the `ebitda` figure — "SDE", "EBITDA", "Adjusted EBITDA". */
  earningsLabel?: string;
  /** Some manifests emit `sde` instead of `ebitda`. */
  sde?: string;
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

/**
 * The cover's earnings metric must be labelled with what the number is.
 * "$628,000 SDE" under an "EBITDA" label is a credibility hit with buyers,
 * so: explicit earningsLabel wins, then a label embedded in the value
 * ("$628K SDE" → SDE), then a dedicated `sde` field, then EBITDA.
 */
function resolveEarnings(data: CoverPageLayoutData): { label: string; value: string } | null {
  const raw = (data.ebitda || data.sde || "").trim();
  if (!raw) return null;
  const embedded = raw.match(/\b(adjusted\s+ebitda|normalized\s+ebitda|sde|ebitda)\b/i);
  let label = data.earningsLabel?.trim() || "";
  if (!label && embedded) label = embedded[1].replace(/\s+/g, " ");
  if (!label && !data.ebitda && data.sde) label = "SDE";
  if (!label) label = "EBITDA";
  label = label.toUpperCase() === label ? label : label.replace(/\b(sde|ebitda)\b/gi, (m) => m.toUpperCase());
  // Drop the duplicated label from the value so it doesn't read "$628K SDE / SDE".
  const value = embedded ? raw.replace(embedded[0], "").replace(/\s{2,}/g, " ").replace(/^\s*[-–(]\s*|\s*[)]\s*$/g, "").trim() || raw : raw;
  return { label, value };
}

export function CoverPageRenderer({ layoutData, content, branding, section }: RendererProps) {
  const data: CoverPageLayoutData = layoutData && Object.keys(layoutData).length > 0
    ? layoutData
    : {};

  const businessName = data.businessName || (section as any).sectionTitle || "Business Overview";
  const confidentialLabel = data.confidentialLabel || "CONFIDENTIAL BUSINESS OVERVIEW";
  const firmName = branding.firmName || data.preparedBy || "";
  const earnings = resolveEarnings(data);
  const metrics = [
    data.askingPrice && { label: "Asking Price", value: data.askingPrice },
    data.revenue && { label: "Annual Revenue", value: data.revenue },
    earnings,
  ].filter(Boolean) as { label: string; value: string }[];

  const accentHex = branding.accentHex || branding.primaryHex || CIM_DOC.brass;

  return (
    <div
      className="relative min-h-[560px] sm:min-h-[680px] flex flex-col justify-between overflow-hidden rounded-lg select-none"
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

      {/* Header — confidential label + date. The label may be a full
          disclaimer sentence, so it wraps in its own column and the date
          sits on its own line on narrow covers (never side-by-side overlap). */}
      <div className="relative z-10 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-8 px-6 pt-8 sm:px-12 sm:pt-12">
        <span
          className="text-2xs font-semibold tracking-[0.2em] uppercase leading-relaxed min-w-0 break-words sm:max-w-[75%]"
          style={{ color: accentHex }}
        >
          {confidentialLabel}
        </span>
        {data.date && (
          <span className="text-2xs tracking-wide shrink-0 whitespace-nowrap" style={{ color: `${CREAM}4D` }}>{data.date}</span>
        )}
      </div>

      {/* Main content */}
      <div className="relative z-10 flex-1 flex flex-col justify-center px-6 py-10 sm:px-12 sm:py-16">
        {/* Industry / location badge */}
        {(data.industry || data.location) && (
          <div className="flex flex-wrap items-center gap-3 mb-8">
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
          className="text-3xl sm:text-5xl font-semibold tracking-tight leading-tight mb-4 max-w-2xl break-words"
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
          <div className="flex flex-wrap items-center gap-x-6 gap-y-4 mt-12">
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
      <div className="relative z-10 flex items-end justify-between gap-6 px-6 pb-8 sm:px-12 sm:pb-10">
        <div className="min-w-0 flex-1">
          {firmName && (
            <p className="text-sm font-semibold" style={{ color: `${CREAM}B3` }}>{firmName}</p>
          )}
          <p className="text-2xs mt-1 tracking-wide" style={{ color: `${CREAM}40` }}>
            This document is strictly confidential and intended solely for the named recipient.
          </p>
        </div>
        {/* Accent mark */}
        <div className="w-8 h-8 shrink-0 rounded-full border-2 opacity-25" style={{ borderColor: accentHex }} />
      </div>

      {/* Bottom accent line */}
      <div className="absolute bottom-0 left-0 right-0 h-[1px]" style={{ backgroundColor: `${CREAM}0D` }} />
    </div>
  );
}
