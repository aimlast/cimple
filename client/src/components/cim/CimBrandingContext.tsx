/**
 * CimBrandingContext
 *
 * The `branding` prop passed to CIM renderers (names; legacy colour fields).
 * The visual system — template, colours, fonts — lives in CimDesignContext.
 */
import { createContext, useContext } from "react";
import type { BrandingSettings } from "@shared/schema";
import { brandColorToHex } from "@shared/cim-theme";

/**
 * Classic Paper's palette as literal hex (see `.cim-doc` in index.css). The
 * renderers read the active template through useCimTheme() instead; these
 * remain the Classic Paper reference values and a fallback for old callers.
 */
export const CIM_DOC = {
  paper: "#FBF8F2",        // warm paper background
  card: "#FEFDFB",         // elevated card on paper
  ink: "#201D18",          // near-black text
  inkSoft: "#46423B",      // secondary text
  inkMuted: "#6B665C",     // axis labels, captions
  inkFaint: "#8C8779",     // faintest annotations
  line: "#E3DED0",         // hairline borders / chart grid
  stripe: "#F2EEE3",       // table stripe / hover cursor fill
  brass: "#9E752E",        // brand-brass accent on paper
  // Chart semantic colors — tuned for paper (softer than UI status colors)
  positive: "#2E7D5B",     // additions / good
  negative: "#B4483E",     // deductions / bad
  neutral: "#8A8475",      // warm neutral gray for base bars
  // Cover page (deliberately dark — premium pitch-book cover)
  coverInk: "#191713",     // deep warm near-black
  coverInkHi: "#23201B",   // gradient top
  coverCream: "#F5F1E6",   // cream type on the cover
} as const;

export interface CimBranding {
  // Broker/firm brand (from BrandingSettings)
  firmName: string;
  firmLogo?: string;
  primaryColor: string;       // HSL string e.g. "218 70% 47%"
  accentColor: string;
  headingFont: string;
  bodyFont: string;
  disclaimer?: string;

  // Business-for-sale brand (from deal)
  businessName: string;
  businessLogo?: string;
  industry?: string;

  // Computed CSS values (derived from primaryColor)
  primaryHex: string;
  accentHex: string;
  headingColor: string;       // CSS color string for headings
}

/**
 * The legacy `branding` prop every renderer still receives. Colours and
 * fonts now come from the design template (CimDesignContext / useCimTheme);
 * this carries the names. primaryHex/accentHex are kept for old callers and
 * follow the brokerage colours only when the broker switched them on.
 */
export function buildBranding(
  settings: Partial<BrandingSettings> | null | undefined,
  deal: { businessName: string; industry?: string | null } | null | undefined
): CimBranding {
  const useColors = !!settings?.useBrandColors;
  const primaryHex = (useColors && brandColorToHex(settings?.primaryColor)) || CIM_DOC.brass;
  const accentHex = (useColors && brandColorToHex(settings?.accentColor)) || CIM_DOC.brass;

  return {
    firmName:     settings?.companyName  || "",
    firmLogo:     settings?.logoUrl      || undefined,
    primaryColor: settings?.primaryColor || "",
    accentColor:  settings?.accentColor  || "",
    headingFont:  settings?.headingFont  || "",
    bodyFont:     settings?.bodyFont     || "",
    disclaimer:   settings?.disclaimer   || undefined,

    businessName: deal?.businessName || "",
    businessLogo: undefined,
    industry:     deal?.industry     || undefined,

    primaryHex,
    accentHex,
    headingColor: CIM_DOC.ink,
  };
}

const CimBrandingContext = createContext<CimBranding | null>(null);

export const CimBrandingProvider = CimBrandingContext.Provider;

export function useCimBranding(): CimBranding {
  const ctx = useContext(CimBrandingContext);
  if (!ctx) throw new Error("useCimBranding used outside CimBrandingProvider");
  return ctx;
}
