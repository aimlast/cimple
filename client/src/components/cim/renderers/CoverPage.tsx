/**
 * CoverPage renderer — the CIM's first page, in the template's cover style:
 *
 *   dark   premium pitch-book cover (Classic Paper, Executive Navy)
 *   light  paper cover with ink type and accent rules (Modern Slate, Minimal White)
 *   brand  full-bleed brand colour (Bold Brand)
 *   photo  the business's cover photo under a dark wash (named CIMs only)
 *
 * Logos: the brokerage's logo sits in the "Prepared by" footer in every
 * version; the business's own logo appears in Normal/DD CIMs only — the
 * design context never carries business branding in Blind mode, so the
 * Blind cover cannot show it. Colours are the resolved theme's (literal
 * strings, never app tokens) so the cover is identical in both app themes.
 */
import { useState } from "react";
import type { CimBranding } from "../CimBrandingContext";
import type { CimSection } from "@shared/schema";
import { useCimDesign } from "../CimDesignContext";
import { useCimMedia } from "../CimMediaContext";
import { mixHex } from "@shared/cim-theme";

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

/** A logo image; on a dark cover it sits on a light chip so any logo reads. */
function CoverLogo({ src, alt, onDark, size }: { src: string; alt: string; onDark: boolean; size: "lg" | "sm" }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  const img = (
    <img
      src={src}
      alt={alt}
      onError={() => setFailed(true)}
      className={size === "lg" ? "max-h-12 sm:max-h-14 max-w-[180px] sm:max-w-[220px] w-auto object-contain" : "max-h-7 max-w-[130px] w-auto object-contain"}
      draggable={false}
    />
  );
  if (!onDark) return img;
  return (
    <span className={size === "lg" ? "inline-flex rounded-md bg-white/95 px-3 py-2 shadow-sm" : "inline-flex rounded bg-white/95 px-2 py-1"}>
      {img}
    </span>
  );
}

export function CoverPageRenderer({ layoutData, content, branding, section }: RendererProps) {
  const design = useCimDesign();
  const media = useCimMedia();
  const t = design.theme;
  const data: CoverPageLayoutData = layoutData && Object.keys(layoutData).length > 0 ? layoutData : {};

  const businessName = data.businessName || (section as any).sectionTitle || "Business Overview";
  const confidentialLabel = data.confidentialLabel || "CONFIDENTIAL BUSINESS OVERVIEW";
  // The AI sometimes fills preparedBy with a document title — never show
  // that under "Prepared by".
  const aiPreparedBy = data.preparedBy && !/memorandum|confidential|overview|\bcim\b/i.test(data.preparedBy) ? data.preparedBy : "";
  const firmName = design.brokerage.firmName || branding.firmName || aiPreparedBy;
  const firmLogo = design.brokerage.logoUrl;
  // Business branding is null in the Blind CIM (CimDesign never carries it there).
  const businessLogoId = design.business?.logoMediaId || null;
  const coverPhotoId = t.coverStyle === "photo" ? design.business?.coverPhotoMediaId || null : null;
  const earnings = resolveEarnings(data);
  const metrics = [
    data.askingPrice && { label: "Asking Price", value: data.askingPrice },
    data.revenue && { label: "Annual Revenue", value: data.revenue },
    earnings,
  ].filter(Boolean) as { label: string; value: string }[];

  const style = t.coverStyle;
  const light = style === "light";
  const ink = t.coverInk;
  // Ink at an alpha (hex suffix). A mid-tone brand-colour cover needs more
  // opacity than a near-black one for the quiet type to stay readable.
  const BRAND_ALPHA: Record<string, string> = { "0D": "1A", "1A": "33", "26": "40", "40": "8C", "4D": "A6", "59": "A6", "66": "B3", "80": "CC", "99": "D9", B3: "E6" };
  const a = (alpha: string) => `${ink}${style === "brand" || style === "photo" ? BRAND_ALPHA[alpha] ?? alpha : alpha}`;
  const accent = t.coverAccent;
  const titleWeight = t.headingWeight >= 800 ? 800 : t.headingWeight === 700 ? 600 : t.headingWeight;

  const background =
    style === "light"
      ? t.paper
      : style === "brand"
        ? `linear-gradient(160deg, ${mixHex(t.coverBg, "#ffffff", 0.08)} 0%, ${t.coverBg} 55%, ${mixHex(t.coverBg, "#000000", 0.28)} 130%)`
        : style === "photo"
          ? "#111111"
          : `linear-gradient(165deg, ${mixHex(t.coverBg, "#ffffff", 0.04)} 0%, ${t.coverBg} 55%, ${mixHex(t.coverBg, "#000000", 0.35)} 130%)`;

  return (
    <div
      className="cim-print-cover relative min-h-[560px] sm:min-h-[680px] flex flex-col justify-between overflow-hidden rounded-lg select-none"
      style={{ background, color: ink, border: light ? `1px solid ${t.line}` : undefined }}
      data-cover-style={style}
    >
      {/* Photo cover: the business's photo under a dark wash */}
      {coverPhotoId && (
        <>
          <img src={media.src(coverPhotoId)} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
          <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, rgba(10,9,8,0.62) 0%, rgba(10,9,8,0.52) 45%, rgba(10,9,8,0.88) 100%)" }} />
        </>
      )}

      {/* Texture (dark / brand covers) */}
      {(style === "dark" || style === "brand") && (
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{ backgroundImage: `repeating-linear-gradient(45deg, ${ink} 0, ${ink} 1px, transparent 0, transparent 50%)`, backgroundSize: "6px 6px" }}
        />
      )}

      {/* Light cover: a vertical accent rule down the left edge */}
      {light && <div className="absolute top-0 bottom-0 left-0 w-[6px]" style={{ backgroundColor: t.accent }} />}

      {/* Accent line at top */}
      {!light && <div className="absolute top-0 left-0 right-0 h-[3px]" style={{ backgroundColor: accent }} />}

      {/* Header — confidential label + date. The label may be a full
          disclaimer sentence, so it wraps in its own column and the date
          sits on its own line on narrow covers (never side-by-side overlap). */}
      <div className="relative z-10 flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-8 px-6 pt-8 sm:px-12 sm:pt-12">
        <span
          className="text-2xs font-semibold tracking-[0.2em] uppercase leading-relaxed min-w-0 break-words sm:max-w-[75%]"
          style={{ color: light ? t.accentText : accent }}
        >
          {confidentialLabel}
        </span>
        {data.date && (
          <span className="text-2xs tracking-wide shrink-0 whitespace-nowrap" style={{ color: a(light ? "99" : "4D") }}>{data.date}</span>
        )}
      </div>

      {/* Main content */}
      <div className="relative z-10 flex-1 flex flex-col justify-center px-6 py-10 sm:px-12 sm:py-16">
        {businessLogoId && (
          <div className="mb-8" data-testid="cover-business-logo">
            <CoverLogo src={media.src(businessLogoId)} alt={`${businessName} logo`} onDark={!light} size="lg" />
          </div>
        )}

        {/* Industry / location badge */}
        {(data.industry || data.location) && (
          <div className="flex flex-wrap items-center gap-3 mb-8">
            {[data.industry, data.location].filter(Boolean).map((chip, i) => (
              <span
                key={i}
                className="text-xs font-medium px-3 py-1 rounded-full border"
                style={{ borderColor: light ? t.line : a("26"), color: light ? t.inkSoft : a("99") }}
              >
                {chip}
              </span>
            ))}
          </div>
        )}

        {/* Business name */}
        <h1
          className="cim-display text-3xl sm:text-5xl tracking-tight leading-tight mb-4 max-w-2xl break-words"
          style={{ color: ink, fontWeight: titleWeight }}
        >
          {businessName}
        </h1>

        {/* Tagline */}
        {data.tagline && (
          <p className="text-lg font-normal mt-2 max-w-xl leading-relaxed" style={{ color: light ? t.inkSoft : a("99") }}>
            {data.tagline}
          </p>
        )}

        {/* Metrics row */}
        {metrics.length > 0 && (
          <div className="flex flex-wrap items-stretch gap-x-6 gap-y-4 mt-12">
            {metrics.map((m, i) => (
              <div
                key={i}
                className={i < metrics.length - 1 ? "flex flex-col pr-6 sm:border-r" : "flex flex-col pr-6"}
                style={{ borderColor: light ? t.line : a("1A") }}
              >
                <span className="text-xl font-semibold tabular-nums" style={{ color: ink }}>{m.value}</span>
                <span className="text-2xs uppercase tracking-widest mt-0.5" style={{ color: light ? t.inkMuted : a("66") }}>{m.label}</span>
              </div>
            ))}
          </div>
        )}

        {/* Prose fallback */}
        {metrics.length === 0 && content && (
          <p className="text-sm mt-8 max-w-lg leading-relaxed" style={{ color: light ? t.inkSoft : a("80") }}>{content}</p>
        )}
      </div>

      {/* Footer — prepared by (brokerage logo + name) */}
      <div className="relative z-10 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between sm:gap-6 px-6 pb-8 sm:px-12 sm:pb-10">
        <div className="min-w-0 flex-1" style={light ? { borderTop: `1px solid ${t.line}`, paddingTop: "1.5rem" } : undefined}>
          {(firmName || firmLogo) && (
            <div className="flex flex-col gap-1.5">
              <span className="text-[9px] uppercase tracking-[0.22em]" style={{ color: light ? t.inkFaint : a("59") }}>Prepared by</span>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 min-w-0">
                {firmLogo && <CoverLogo src={firmLogo} alt={firmName ? `${firmName} logo` : "Brokerage logo"} onDark={!light} size="sm" />}
                {firmName && <p className="text-sm font-semibold min-w-0 break-words" style={{ color: light ? t.ink : a("B3") }}>{firmName}</p>}
              </div>
            </div>
          )}
          <p className="text-2xs mt-2 tracking-wide" style={{ color: light ? t.inkFaint : a("40") }}>
            This document is strictly confidential and intended solely for the named recipient.
          </p>
        </div>
        {/* Accent mark */}
        {!light && <div className="hidden sm:block w-8 h-8 shrink-0 rounded-full border-2 opacity-25" style={{ borderColor: accent }} />}
      </div>

      {/* Bottom accent line */}
      {!light && <div className="absolute bottom-0 left-0 right-0 h-[1px]" style={{ backgroundColor: a("0D") }} />}
    </div>
  );
}
