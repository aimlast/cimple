/**
 * CimDesignContext — the resolved CIM design every renderer reads.
 *
 * A design = the template's theme (after brokerage and business branding,
 * shared/cim-theme.ts resolveCimTheme) + the brokerage's contact/logo block
 * + the business's own branding (named CIMs only) + which version this is.
 *
 * Hosts (builder canvas, view room, print preview, settings previews) wrap
 * the paper in <CimDesignProvider>. Renderers call useCimTheme() for colours
 * that must be literal strings (Recharts) and rely on the `--cimt-*` CSS
 * variables (set by <CimSheet> and by every section root) for everything
 * styled with token classes. Without a provider, renderers get Classic Paper
 * — exactly the paper CIM as it looked before templates.
 */
import { createContext, useContext, useEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import {
  DEFAULT_TEMPLATE_ID,
  EMPTY_BROKERAGE,
  getBuiltinTemplate,
  googleFontHref,
  resolveCimTheme,
  themeCssVars,
  type CimBrokerageBrand,
  type CimBusinessBranding,
  type CimThemeTokens,
  type CimVersionMode,
  type ResolvedCimTheme,
} from "@shared/cim-theme";

/** What the server sends (GET /api/deals/:id/design, GET /api/view/:token → design). */
export interface CimDesignPayload {
  template?: { id: string; name: string; tokens: CimThemeTokens } | null;
  brokerage?: Partial<CimBrokerageBrand> | null;
  business?: CimBusinessBranding | null;
}

export interface CimDesign {
  theme: ResolvedCimTheme;
  templateId: string;
  templateName: string;
  brokerage: CimBrokerageBrand;
  /** Null in the Blind CIM, always. */
  business: CimBusinessBranding | null;
  mode: CimVersionMode;
}

export function buildCimDesign(payload: CimDesignPayload | null | undefined, mode: CimVersionMode = "normal"): CimDesign {
  const fallback = getBuiltinTemplate(DEFAULT_TEMPLATE_ID)!;
  const template = payload?.template ?? { id: fallback.id, name: fallback.name, tokens: fallback.tokens };
  const brokerage: CimBrokerageBrand = { ...EMPTY_BROKERAGE, ...(payload?.brokerage ?? {}) };
  const business = mode === "blind" ? null : payload?.business ?? null;
  const theme = resolveCimTheme({
    tokens: template.tokens,
    templateId: template.id,
    brokerage,
    business,
    mode,
    hasCoverPhoto: !!business?.coverPhotoMediaId,
  });
  return { theme, templateId: template.id, templateName: template.name, brokerage, business, mode };
}

const DEFAULT_DESIGN = buildCimDesign(null, "normal");

interface CtxValue {
  design: CimDesign;
  /** Section id → chapter number (numbered headings). */
  numbers: ReadonlyMap<string, number>;
}

const Ctx = createContext<CtxValue>({ design: DEFAULT_DESIGN, numbers: new Map() });

/** Chapter numbers: every shown section except the cover and dividers. */
export function sectionNumbers(sections: ReadonlyArray<{ id: string; layoutType: string; isVisible?: boolean | null }>): Map<string, number> {
  const map = new Map<string, number>();
  let n = 0;
  for (const s of sections) {
    if (s.layoutType === "cover_page" || s.layoutType === "divider") continue;
    if (s.isVisible === false) continue;
    map.set(s.id, ++n);
  }
  return map;
}

export function CimDesignProvider({
  design,
  sections,
  children,
}: {
  design: CimDesign;
  sections?: ReadonlyArray<{ id: string; layoutType: string; isVisible?: boolean | null }>;
  children: ReactNode;
}) {
  useCimFonts(design.theme);
  const sectionKey = sections?.map((s) => `${s.id}:${s.layoutType}:${s.isVisible === false ? 0 : 1}`).join("|") ?? "";
  const numbers = useMemo(() => sectionNumbers(sections ?? []), [sectionKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const value = useMemo(() => ({ design, numbers }), [design, numbers]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useCimDesign(): CimDesign {
  return useContext(Ctx).design;
}

export function useCimTheme(): ResolvedCimTheme {
  return useContext(Ctx).design.theme;
}

export function useSectionNumber(sectionId: string | undefined): number | undefined {
  const { numbers } = useContext(Ctx);
  return sectionId ? numbers.get(sectionId) : undefined;
}

/** The `--cimt-*` variables as an inline style. */
export function themeStyle(theme: ResolvedCimTheme): CSSProperties {
  return themeCssVars(theme) as unknown as CSSProperties;
}

/** Inline style for a `.cim-doc` root from the current design. */
export function useThemeStyle(): CSSProperties {
  const theme = useCimTheme();
  return useMemo(() => themeStyle(theme), [theme]);
}

// ── Fonts ────────────────────────────────────────────────────────────────

const requested = new Set<string>();

/** Adds the Google Fonts stylesheet for a family once per page. */
export function loadCimFont(family: string) {
  if (typeof document === "undefined") return;
  const href = googleFontHref(family);
  if (!href || requested.has(href)) return;
  requested.add(href);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset.cimFont = family;
  document.head.appendChild(link);
}

export function useCimFonts(theme: Pick<ResolvedCimTheme, "headingFont" | "bodyFont">) {
  useEffect(() => {
    loadCimFont(theme.headingFont);
    loadCimFont(theme.bodyFont);
  }, [theme.headingFont, theme.bodyFont]);
}
