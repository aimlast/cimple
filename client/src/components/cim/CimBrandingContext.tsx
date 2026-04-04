/**
 * CimBrandingContext
 *
 * Provides branding values (broker + business) to all CIM renderer components.
 * Renderers consume this via the `branding` prop rather than calling hooks directly.
 */
import { createContext, useContext } from "react";
import type { BrandingSettings } from "@shared/schema";

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

export function buildBranding(
  settings: BrandingSettings | null | undefined,
  deal: { businessName: string; industry?: string | null } | null | undefined
): CimBranding {
  const primary = settings?.primaryColor || "218 70% 47%";
  const accent  = settings?.accentColor  || "162 65% 38%";

  return {
    firmName:     settings?.companyName  || "Your Brokerage",
    firmLogo:     settings?.logoUrl      || undefined,
    primaryColor: primary,
    accentColor:  accent,
    headingFont:  settings?.headingFont  || "Inter",
    bodyFont:     settings?.bodyFont     || "Inter",
    disclaimer:   settings?.disclaimer   || undefined,

    businessName: deal?.businessName || "",
    businessLogo: undefined,
    industry:     deal?.industry     || undefined,

    primaryHex:   hslToHex(primary),
    accentHex:    hslToHex(accent),
    headingColor: `hsl(${primary})`,
  };
}

/** Minimal HSL → hex for inline style usage in renderers */
function hslToHex(hsl: string): string {
  try {
    const parts = hsl.trim().split(/\s+/);
    if (parts.length < 3) return "#000000";
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r = 0, g = 0, b = 0;
    if (h < 60)       { r = c; g = x; }
    else if (h < 120) { r = x; g = c; }
    else if (h < 180) { g = c; b = x; }
    else if (h < 240) { g = x; b = c; }
    else if (h < 300) { r = x; b = c; }
    else              { r = c; b = x; }
    const toHex = (v: number) => Math.round((v + m) * 255).toString(16).padStart(2, "0");
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  } catch {
    return "#000000";
  }
}

const CimBrandingContext = createContext<CimBranding | null>(null);

export const CimBrandingProvider = CimBrandingContext.Provider;

export function useCimBranding(): CimBranding {
  const ctx = useContext(CimBrandingContext);
  if (!ctx) throw new Error("useCimBranding used outside CimBrandingProvider");
  return ctx;
}
