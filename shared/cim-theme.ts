/**
 * cim-theme — the CIM's visual system: design templates, brokerage and
 * business branding, and how they resolve into one theme.
 *
 * Pure and shared: the server validates custom-template tokens and names the
 * built-ins with it; the browser resolves the theme every renderer reads
 * (client/src/components/cim/CimDesignContext.tsx) and turns it into CSS
 * variables on the paper sheet (`--cimt-*`, read by `.cim-doc` in index.css).
 *
 * Resolution order (later wins):
 *   1. the template's tokens (built-in or the broker's custom template)
 *   2. brokerage branding — colours and fonts, when the broker switched them on
 *   3. the business's own colours — Normal/DD CIMs only, never Blind
 * Every brand colour passes a contrast check against the paper and is
 * darkened until it reads; the adjustment is reported so the UI can say so.
 */

// ── Enums ────────────────────────────────────────────────────────────────

export const COVER_STYLES = ["dark", "light", "brand", "photo"] as const;
export type CimCoverStyle = (typeof COVER_STYLES)[number];

export const HEADER_STYLES = ["plain", "rule", "band", "numbered"] as const;
export type CimHeaderStyle = (typeof HEADER_STYLES)[number];

export const DENSITIES = ["compact", "comfortable", "airy"] as const;
export type CimDensity = (typeof DENSITIES)[number];

export const COVER_STYLE_LABELS: Record<CimCoverStyle, string> = {
  dark: "Dark",
  light: "Light",
  brand: "Brand colour",
  photo: "Photo",
};
export const HEADER_STYLE_LABELS: Record<CimHeaderStyle, string> = {
  plain: "Plain",
  rule: "Underlined",
  band: "Colour band",
  numbered: "Numbered",
};
export const DENSITY_LABELS: Record<CimDensity, string> = {
  compact: "Compact",
  comfortable: "Comfortable",
  airy: "Airy",
};

// ── Fonts (Google Fonts, loaded on demand) ───────────────────────────────

export interface CimFontDef {
  family: string;
  category: "sans" | "serif";
  /** Weights Google serves for this family (requesting others fails the whole CSS). */
  weights: number[];
}

export const CIM_FONTS: readonly CimFontDef[] = [
  { family: "Plus Jakarta Sans", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "Inter", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "Manrope", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "DM Sans", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "Work Sans", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "Source Sans 3", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "Open Sans", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "Lato", category: "sans", weights: [400, 700, 900] },
  { family: "Roboto", category: "sans", weights: [400, 500, 700, 900] },
  { family: "Montserrat", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "Poppins", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "Raleway", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "IBM Plex Sans", category: "sans", weights: [400, 500, 600, 700] },
  { family: "Nunito Sans", category: "sans", weights: [400, 600, 700, 800] },
  { family: "Space Grotesk", category: "sans", weights: [400, 500, 600, 700] },
  { family: "Outfit", category: "sans", weights: [400, 500, 600, 700, 800] },
  { family: "Playfair Display", category: "serif", weights: [400, 500, 600, 700, 800] },
  { family: "Merriweather", category: "serif", weights: [400, 700, 900] },
  { family: "Lora", category: "serif", weights: [400, 500, 600, 700] },
  { family: "Libre Baskerville", category: "serif", weights: [400, 700] },
  { family: "EB Garamond", category: "serif", weights: [400, 500, 600, 700, 800] },
  { family: "Cormorant Garamond", category: "serif", weights: [400, 500, 600, 700] },
  { family: "Source Serif 4", category: "serif", weights: [400, 500, 600, 700, 800] },
  { family: "DM Serif Display", category: "serif", weights: [400] },
];

const FONT_BY_NAME = new Map(CIM_FONTS.map((f) => [f.family.toLowerCase(), f]));
export const DEFAULT_FONT = "Plus Jakarta Sans";

export function getCimFont(family: string | null | undefined): CimFontDef | undefined {
  return family ? FONT_BY_NAME.get(family.trim().toLowerCase()) : undefined;
}

/** A known font family (canonical spelling), or the fallback. */
export function cleanFontFamily(family: unknown, fallback = DEFAULT_FONT): string {
  return (typeof family === "string" && getCimFont(family)?.family) || fallback;
}

export function fontStack(family: string): string {
  const def = getCimFont(family);
  const generic = def?.category === "serif"
    ? "Georgia, 'Times New Roman', serif"
    : "system-ui, -apple-system, 'Segoe UI', sans-serif";
  return `'${(def?.family ?? family).replace(/'/g, "")}', ${generic}`;
}

/** The nearest weight the family actually has. */
export function snapFontWeight(family: string, weight: number): number {
  const ws = getCimFont(family)?.weights ?? [400, 700];
  return ws.reduce((best, w) => (Math.abs(w - weight) < Math.abs(best - weight) ? w : best), ws[0]);
}

/** One stylesheet URL per family (a bad family never breaks the others). */
export function googleFontHref(family: string): string | null {
  const def = getCimFont(family);
  if (!def) return null;
  return `https://fonts.googleapis.com/css2?family=${encodeURIComponent(def.family).replace(/%20/g, "+")}:wght@${def.weights.join(";")}&display=swap`;
}

// ── Colour utilities ─────────────────────────────────────────────────────

const HEX_RE = /^#([0-9a-f]{6})$/i;

export function isHexColor(v: unknown): v is string {
  return typeof v === "string" && HEX_RE.test(v.trim());
}

/** "#abc" / "abc" / "#AABBCC" → "#aabbcc"; anything else → null. */
export function normalizeHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  let s = v.trim().toLowerCase();
  if (!s.startsWith("#")) s = `#${s}`;
  if (/^#[0-9a-f]{3}$/.test(s)) s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return HEX_RE.test(s) ? s : null;
}

function rgb(hex: string): [number, number, number] {
  const h = (normalizeHex(hex) ?? "#000000").slice(1);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Linear blend: t=0 → a, t=1 → b. */
export function mixHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  return toHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
}

export function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const [r, g, b] = rgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: s * 100, l: l * 100 };
}

export function hslToHex(h: number, s: number, l: number): string {
  const sat = Math.max(0, Math.min(100, s)) / 100;
  const lig = Math.max(0, Math.min(100, l)) / 100;
  const c = (1 - Math.abs(2 * lig - 1)) * sat;
  const hh = ((h % 360) + 360) % 360;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = lig - c / 2;
  let r = 0, g = 0, b = 0;
  if (hh < 60) { r = c; g = x; }
  else if (hh < 120) { r = x; g = c; }
  else if (hh < 180) { g = c; b = x; }
  else if (hh < 240) { g = x; b = c; }
  else if (hh < 300) { r = x; b = c; }
  else { r = c; b = x; }
  return toHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** "#9e752e" → "38 55% 40%" (the triplet format the CSS tokens use). */
export function hexToHslTriplet(hex: string): string {
  const { h, s, l } = hexToHsl(hex);
  return `${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%`;
}

/** Legacy branding HSL string ("218 70% 47%") → hex, or null if unreadable. */
export function hslStringToHex(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const parts = v.trim().replace(/,/g, " ").split(/\s+/).map((p) => parseFloat(p.replace("%", "")));
  if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
  return hslToHex(parts[0], parts[1], parts[2]);
}

/** A brand colour as stored (hex or the legacy HSL triplet) → hex. */
export function brandColorToHex(v: unknown): string | null {
  return normalizeHex(v) ?? hslStringToHex(v);
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * `color`, darkened (or lightened on a dark background) in small steps until
 * it reaches `min` contrast against `bg`. Hue and saturation are kept, so a
 * brand colour stays recognisably itself.
 */
export function ensureContrast(color: string, bg: string, min: number): { color: string; adjusted: boolean } {
  if (contrastRatio(color, bg) >= min) return { color, adjusted: false };
  const { h, s, l } = hexToHsl(color);
  const darker = luminance(bg) > 0.4;
  for (let step = 1; step <= 100; step++) {
    const next = hslToHex(h, s, darker ? l - step : l + step);
    if (contrastRatio(next, bg) >= min) return { color: next, adjusted: true };
  }
  return { color: darker ? "#000000" : "#ffffff", adjusted: true };
}

/** White or near-black text, whichever reads better on `bg`. */
export function readableOn(bg: string, dark = "#1a1a1a", light = "#ffffff"): string {
  return contrastRatio(light, bg) >= contrastRatio(dark, bg) ? light : dark;
}

// ── Template tokens ──────────────────────────────────────────────────────

export interface CimThemeTokens {
  paper: string;
  card: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  inkFaint: string;
  line: string;
  stripe: string;
  accent: string;
  accent2: string;
  positive: string;
  negative: string;
  neutral: string;
  /** At least six series colours; brand colours are put in front when used. */
  chart: string[];
  /** Section headings in ink, or in the accent colour. */
  headingTone: "ink" | "accent";
  headingFont: string;
  bodyFont: string;
  headingWeight: number;
  coverStyle: CimCoverStyle;
  /** Background of the dark cover (the brand cover uses the accent). */
  coverBg: string;
  headerStyle: CimHeaderStyle;
  /** Corner radius of cards and panels, in px (0–20). */
  radius: number;
  density: CimDensity;
}

export interface CimTemplateDef {
  id: string;
  name: string;
  description: string;
  builtIn: true;
  tokens: CimThemeTokens;
}

export const DEFAULT_TEMPLATE_ID = "classic-paper";

/** Today's paper CIM — the look every CIM had before templates existed. */
const CLASSIC_PAPER: CimThemeTokens = {
  paper: "#fbf8f2",
  card: "#fefdfb",
  ink: "#201d18",
  inkSoft: "#46423b",
  inkMuted: "#6b665c",
  inkFaint: "#8c8779",
  line: "#e3ded0",
  stripe: "#f2eee3",
  accent: "#9e752e",
  accent2: "#3f5e73",
  positive: "#2e7d5b",
  negative: "#b4483e",
  neutral: "#8a8475",
  chart: ["#9e752e", "#3f5e73", "#7a8f6a", "#b4683e", "#6b5b7b", "#c9b98f", "#8a8475"],
  headingTone: "ink",
  headingFont: "Plus Jakarta Sans",
  bodyFont: "Plus Jakarta Sans",
  headingWeight: 700,
  coverStyle: "dark",
  coverBg: "#1e1b17",
  headerStyle: "plain",
  radius: 8,
  density: "comfortable",
};

export const BUILTIN_TEMPLATES: readonly CimTemplateDef[] = [
  {
    id: "classic-paper",
    name: "Classic Paper",
    description: "Warm paper, near-black ink and a brass accent behind a dark pitch-book cover. Cimple's original look.",
    builtIn: true,
    tokens: CLASSIC_PAPER,
  },
  {
    id: "modern-slate",
    name: "Modern Slate",
    description: "Cool grey paper, steel-blue accents and crisp sans-serif type. A light cover and underlined headings.",
    builtIn: true,
    tokens: {
      paper: "#f6f7f9",
      card: "#ffffff",
      ink: "#172231",
      inkSoft: "#3a4757",
      inkMuted: "#5f6b7a",
      inkFaint: "#8b95a3",
      line: "#dde2e8",
      stripe: "#edf0f4",
      accent: "#2e5e8c",
      accent2: "#e07a5f",
      positive: "#1f8a5b",
      negative: "#c2413a",
      neutral: "#8b95a3",
      chart: ["#2e5e8c", "#e07a5f", "#4e9bb9", "#3d405b", "#81b29a", "#f2cc8f", "#8fb3cf"],
      headingTone: "ink",
      headingFont: "Manrope",
      bodyFont: "Inter",
      headingWeight: 800,
      coverStyle: "light",
      coverBg: "#172231",
      headerStyle: "rule",
      radius: 12,
      density: "comfortable",
    },
  },
  {
    id: "executive-navy",
    name: "Executive Navy",
    description: "Ivory paper, deep navy and antique gold with serif headlines and numbered chapters. Investment-bank formal.",
    builtIn: true,
    tokens: {
      paper: "#fdfcf8",
      card: "#ffffff",
      ink: "#14213d",
      inkSoft: "#33415c",
      inkMuted: "#5c677d",
      inkFaint: "#8d96a8",
      line: "#dcdfe6",
      stripe: "#f1f2f6",
      accent: "#1f3a68",
      accent2: "#b08d57",
      positive: "#2d6a4f",
      negative: "#a63d40",
      neutral: "#8d96a8",
      chart: ["#1f3a68", "#b08d57", "#5c7aa8", "#2f4858", "#d4b98c", "#a3b8d8", "#8d96a8"],
      headingTone: "accent",
      headingFont: "Playfair Display",
      bodyFont: "Source Sans 3",
      headingWeight: 700,
      coverStyle: "dark",
      coverBg: "#14213d",
      headerStyle: "numbered",
      radius: 4,
      density: "airy",
    },
  },
  {
    id: "minimal-white",
    name: "Minimal White",
    description: "Pure white, black type and generous space. Monochrome charts that let the numbers speak.",
    builtIn: true,
    tokens: {
      paper: "#ffffff",
      card: "#ffffff",
      ink: "#111111",
      inkSoft: "#3d3d3d",
      inkMuted: "#6b6b6b",
      inkFaint: "#9a9a9a",
      line: "#e7e7e7",
      stripe: "#f5f5f5",
      accent: "#111111",
      accent2: "#8a8a8a",
      positive: "#2f7a4f",
      negative: "#b23b3b",
      neutral: "#a3a3a3",
      chart: ["#1a1a1a", "#6b6b6b", "#a3a3a3", "#d1d1d1", "#404040", "#8a8a8a"],
      headingTone: "ink",
      headingFont: "Inter",
      bodyFont: "Inter",
      headingWeight: 600,
      coverStyle: "light",
      coverBg: "#111111",
      headerStyle: "plain",
      radius: 2,
      density: "airy",
    },
  },
  {
    id: "bold-brand",
    name: "Bold Brand",
    description: "Your brokerage colour front and centre: a full-colour cover, colour-band headings and confident type.",
    builtIn: true,
    tokens: {
      paper: "#ffffff",
      card: "#fafafa",
      ink: "#1a1a1a",
      inkSoft: "#404040",
      inkMuted: "#666666",
      inkFaint: "#999999",
      line: "#e5e5e5",
      stripe: "#f4f4f4",
      accent: "#c2410c",
      accent2: "#1e293b",
      positive: "#15803d",
      negative: "#b91c1c",
      neutral: "#94a3b8",
      chart: ["#c2410c", "#1e293b", "#f59e0b", "#0ea5e9", "#64748b", "#fdba74"],
      headingTone: "ink",
      headingFont: "Montserrat",
      bodyFont: "Open Sans",
      headingWeight: 800,
      coverStyle: "brand",
      coverBg: "#1e293b",
      headerStyle: "band",
      radius: 14,
      density: "comfortable",
    },
  },
];

const BUILTIN_BY_ID = new Map(BUILTIN_TEMPLATES.map((t) => [t.id, t]));

export function getBuiltinTemplate(id: string | null | undefined): CimTemplateDef | undefined {
  return id ? BUILTIN_BY_ID.get(id) : undefined;
}

export function isBuiltinTemplateId(id: unknown): id is string {
  return typeof id === "string" && BUILTIN_BY_ID.has(id);
}

export const DEFAULT_TOKENS: CimThemeTokens = CLASSIC_PAPER;

/**
 * Tokens as they may be stored for a custom template: every field present
 * and valid, unknown keys dropped. Missing/invalid values come from `base`.
 */
export function sanitizeTokens(raw: unknown, base: CimThemeTokens = DEFAULT_TOKENS): CimThemeTokens {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hex = (k: keyof CimThemeTokens) => normalizeHex(r[k]) ?? (base[k] as string);
  const pick = <T extends string>(v: unknown, allowed: readonly T[], fb: T): T =>
    typeof v === "string" && (allowed as readonly string[]).includes(v) ? (v as T) : fb;
  const chartIn = Array.isArray(r.chart) ? r.chart.map(normalizeHex).filter((c): c is string => !!c) : [];
  const chart = (chartIn.length >= 6 ? chartIn : [...chartIn, ...base.chart.filter((c) => !chartIn.includes(c))]).slice(0, 10);
  const headingFont = cleanFontFamily(r.headingFont, base.headingFont);
  const weight = typeof r.headingWeight === "number" && Number.isFinite(r.headingWeight) ? r.headingWeight : base.headingWeight;
  const radius = typeof r.radius === "number" && Number.isFinite(r.radius) ? r.radius : base.radius;
  return {
    paper: hex("paper"),
    card: hex("card"),
    ink: hex("ink"),
    inkSoft: hex("inkSoft"),
    inkMuted: hex("inkMuted"),
    inkFaint: hex("inkFaint"),
    line: hex("line"),
    stripe: hex("stripe"),
    accent: hex("accent"),
    accent2: hex("accent2"),
    positive: hex("positive"),
    negative: hex("negative"),
    neutral: hex("neutral"),
    chart: chart.length >= 6 ? chart : base.chart,
    headingTone: pick(r.headingTone, ["ink", "accent"] as const, base.headingTone),
    headingFont,
    bodyFont: cleanFontFamily(r.bodyFont, base.bodyFont),
    headingWeight: snapFontWeight(headingFont, Math.max(300, Math.min(900, Math.round(weight / 100) * 100))),
    coverStyle: pick(r.coverStyle, COVER_STYLES, base.coverStyle),
    coverBg: hex("coverBg"),
    headerStyle: pick(r.headerStyle, HEADER_STYLES, base.headerStyle),
    radius: Math.max(0, Math.min(20, Math.round(radius))),
    density: pick(r.density, DENSITIES, base.density),
  };
}

// ── Section outline ("Match my existing CIM") ────────────────────────────

export interface CimOutlineEntry {
  title: string;
  /** What the section covers in the broker's past CIM. */
  notes?: string;
  /** A layout the planner should prefer, when the past CIM made it obvious. */
  layoutHint?: string;
}

export interface CimSectionOutline {
  sections: CimOutlineEntry[];
  /** How the past CIM reads (voice, length, formality) — guides the writer. */
  toneNotes?: string;
  /** Where the outline came from ("Harbour Ridge CIM 2024.pdf"). */
  sourceName?: string;
}

export function sanitizeOutline(raw: unknown): CimSectionOutline | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const list = Array.isArray(r.sections) ? r.sections : [];
  const sections: CimOutlineEntry[] = [];
  for (const it of list) {
    if (!it || typeof it !== "object") continue;
    const e = it as Record<string, unknown>;
    const title = typeof e.title === "string" ? e.title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    if (!title) continue;
    const notes = typeof e.notes === "string" ? e.notes.replace(/\s+/g, " ").trim().slice(0, 400) : "";
    const layoutHint = typeof e.layoutHint === "string" ? e.layoutHint.trim().slice(0, 40) : "";
    sections.push({ title, ...(notes ? { notes } : {}), ...(layoutHint ? { layoutHint } : {}) });
    if (sections.length >= 40) break;
  }
  if (sections.length === 0) return null;
  const toneNotes = typeof r.toneNotes === "string" ? r.toneNotes.replace(/\s+/g, " ").trim().slice(0, 800) : "";
  const sourceName = typeof r.sourceName === "string" ? r.sourceName.trim().slice(0, 200) : "";
  return { sections, ...(toneNotes ? { toneNotes } : {}), ...(sourceName ? { sourceName } : {}) };
}

// ── Branding inputs ──────────────────────────────────────────────────────

/** The brokerage's brand as the CIM uses it (never the raw settings row). */
export interface CimBrokerageBrand {
  firmName: string | null;
  logoUrl: string | null;
  /** Hex; only applied when useBrandColors. */
  primaryColor: string | null;
  accentColor: string | null;
  useBrandColors: boolean;
  headingFont: string | null;
  bodyFont: string | null;
  useBrandFonts: boolean;
  disclaimer: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  /** The deal's broker, for the contact page. */
  contactName: string | null;
  showDisclaimerPage: boolean;
  showContactPage: boolean;
  /** Forces a cover style whatever the template says. */
  coverStyle: CimCoverStyle | null;
}

/** The business being sold (deals.business_branding). Normal/DD CIMs only. */
export interface CimBusinessBranding {
  logoMediaId?: string | null;
  primaryColor?: string | null;
  accentColor?: string | null;
  coverPhotoMediaId?: string | null;
  useBusinessColors?: boolean;
}

export function sanitizeBusinessBranding(raw: unknown): CimBusinessBranding {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const id = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9-]{8,64}$/.test(v) ? v : null);
  return {
    logoMediaId: id(r.logoMediaId),
    coverPhotoMediaId: id(r.coverPhotoMediaId),
    primaryColor: normalizeHex(r.primaryColor),
    accentColor: normalizeHex(r.accentColor),
    useBusinessColors: r.useBusinessColors === true,
  };
}

export type CimVersionMode = "normal" | "blind" | "dd";

export const EMPTY_BROKERAGE: CimBrokerageBrand = {
  firmName: null,
  logoUrl: null,
  primaryColor: null,
  accentColor: null,
  useBrandColors: false,
  headingFont: null,
  bodyFont: null,
  useBrandFonts: false,
  disclaimer: null,
  address: null,
  phone: null,
  email: null,
  website: null,
  contactName: null,
  showDisclaimerPage: true,
  showContactPage: true,
  coverStyle: null,
};

export const DEFAULT_DISCLAIMER =
  "This Confidential Information Memorandum has been prepared solely to assist prospective purchasers in deciding whether to pursue an acquisition of the business. " +
  "It is provided under the non-disclosure agreement you signed and may not be copied, shared or used for any other purpose.\n\n" +
  "The information in this memorandum was provided by the owner and has not been independently verified. It does not claim to be complete, and no representation or warranty, express or implied, is made as to its accuracy. " +
  "Prospective purchasers should conduct their own due diligence and rely only on the representations and warranties in a definitive purchase agreement.\n\n" +
  "Do not contact the owner, employees, customers, suppliers or landlord of the business. All enquiries and requests for further information must go through the broker named in this document.";

// ── Resolution ───────────────────────────────────────────────────────────

export interface ResolvedCimTheme {
  templateId: string;
  paper: string;
  card: string;
  ink: string;
  inkSoft: string;
  inkMuted: string;
  inkFaint: string;
  line: string;
  stripe: string;
  /** Accent for graphics (≥3:1 on paper). */
  accent: string;
  /** Accent when used as text (≥4.5:1 on paper). */
  accentText: string;
  /** Text colour on a solid accent fill. */
  onAccent: string;
  /** A soft accent tint for chips and highlights, and the text that sits on it. */
  accentSoft: string;
  accentSoftText: string;
  accent2: string;
  accent2Soft: string;
  accent2SoftText: string;
  positive: string;
  negative: string;
  neutral: string;
  caution: string;
  heading: string;
  chart: string[];
  headingFont: string;
  bodyFont: string;
  headingWeight: number;
  coverStyle: CimCoverStyle;
  coverBg: string;
  coverInk: string;
  coverAccent: string;
  headerStyle: CimHeaderStyle;
  radius: number;
  density: CimDensity;
  /** Plain-English notes about colours changed for readability. */
  adjustments: string[];
}

export interface ResolveThemeInput {
  tokens?: CimThemeTokens | null;
  templateId?: string | null;
  brokerage?: Partial<CimBrokerageBrand> | null;
  business?: CimBusinessBranding | null;
  mode?: CimVersionMode;
  /** The cover has a photo to show (Normal/DD, business cover photo set). */
  hasCoverPhoto?: boolean;
}

function dedupeColors(list: string[]): string[] {
  const out: string[] = [];
  for (const c of list) {
    if (out.some((o) => contrastRatio(o, c) < 1.12)) continue;
    out.push(c);
  }
  return out;
}

export function resolveCimTheme(input: ResolveThemeInput = {}): ResolvedCimTheme {
  const t = input.tokens ? sanitizeTokens(input.tokens) : DEFAULT_TOKENS;
  const mode = input.mode ?? "normal";
  const brokerage = input.brokerage ?? null;
  const business = mode === "blind" ? null : input.business ?? null;
  const adjustments: string[] = [];

  let accent = t.accent;
  let accent2 = t.accent2;
  let brandLed = false;

  if (brokerage?.useBrandColors) {
    const p = brandColorToHex(brokerage.primaryColor);
    const a = brandColorToHex(brokerage.accentColor);
    if (p) { accent = p; brandLed = true; }
    if (a) accent2 = a;
  }
  if (business?.useBusinessColors) {
    const p = normalizeHex(business.primaryColor);
    const a = normalizeHex(business.accentColor);
    if (p) { accent = p; brandLed = true; }
    if (a) accent2 = a;
  }

  const graphic = ensureContrast(accent, t.paper, 3);
  if (graphic.adjusted) adjustments.push("The main colour was too light to read on the page, so it's darkened slightly in the CIM.");
  accent = graphic.color;
  const g2 = ensureContrast(accent2, t.paper, 2.2);
  if (g2.adjusted) adjustments.push("The second colour was too light for charts, so it's darkened slightly.");
  accent2 = g2.color;
  const accentText = ensureContrast(accent, t.paper, 4.5).color;

  const accentSoft = mixHex(t.paper, accent, 0.14);
  const accent2Soft = mixHex(t.paper, accent2, 0.14);
  const chart = brandLed ? dedupeColors([accent, accent2, ...t.chart]).slice(0, 8) : t.chart;
  while (chart.length < 6) chart.push(mixHex(accent, t.paper, 0.2 * chart.length));

  const headingFont = brokerage?.useBrandFonts && brokerage.headingFont ? cleanFontFamily(brokerage.headingFont, t.headingFont) : t.headingFont;
  const bodyFont = brokerage?.useBrandFonts && brokerage.bodyFont ? cleanFontFamily(brokerage.bodyFont, t.bodyFont) : t.bodyFont;

  let coverStyle: CimCoverStyle = brokerage?.coverStyle && (COVER_STYLES as readonly string[]).includes(brokerage.coverStyle) ? brokerage.coverStyle : t.coverStyle;
  // A cover photo is the business's own and the broker chose it for this
  // deal, so it wins in the named CIMs. It is never shown in the Blind CIM,
  // where a photo-style cover falls back to the dark one.
  if (input.hasCoverPhoto && mode !== "blind") coverStyle = "photo";
  if (coverStyle === "photo" && (!input.hasCoverPhoto || mode === "blind")) coverStyle = "dark";

  const coverBg = coverStyle === "brand" ? accent : coverStyle === "light" ? t.paper : t.coverBg;
  const coverInk = coverStyle === "light" ? t.ink : coverStyle === "photo" ? "#f7f3ea" : readableOn(coverBg, t.ink, "#f5f1e6");
  const coverAccent = (() => {
    if (coverStyle === "light") return accent;
    if (coverStyle === "brand") return coverInk;
    const pick = contrastRatio(accent, coverBg) >= contrastRatio(accent2, coverBg) ? accent : accent2;
    return ensureContrast(pick, coverStyle === "photo" ? "#111111" : coverBg, 3).color;
  })();

  return {
    templateId: input.templateId ?? DEFAULT_TEMPLATE_ID,
    paper: t.paper,
    card: t.card,
    ink: t.ink,
    inkSoft: t.inkSoft,
    inkMuted: t.inkMuted,
    inkFaint: t.inkFaint,
    line: t.line,
    stripe: t.stripe,
    accent,
    accentText,
    onAccent: readableOn(accent, t.ink, "#ffffff"),
    accentSoft,
    accentSoftText: ensureContrast(accent, accentSoft, 5).color,
    accent2,
    accent2Soft,
    accent2SoftText: ensureContrast(accent2, accent2Soft, 5).color,
    positive: ensureContrast(t.positive, t.paper, 3).color,
    negative: ensureContrast(t.negative, t.paper, 3).color,
    neutral: t.neutral,
    caution: ensureContrast("#b7791f", t.paper, 3).color,
    heading: t.headingTone === "accent" ? accentText : t.ink,
    chart,
    headingFont,
    bodyFont,
    headingWeight: snapFontWeight(headingFont, t.headingWeight),
    coverStyle,
    coverBg,
    coverInk,
    coverAccent,
    headerStyle: t.headerStyle,
    radius: t.radius,
    density: t.density,
    adjustments,
  };
}

const GAP: Record<CimDensity, string> = { compact: "2rem", comfortable: "2.5rem", airy: "3.5rem" };

/**
 * The CSS custom properties `.cim-doc` reads (index.css). Set on the sheet
 * and on every standalone section, so nested `.cim-doc` scopes resolve to
 * the same theme.
 */
export function themeCssVars(theme: ResolvedCimTheme): Record<string, string> {
  const hsl = hexToHslTriplet;
  return {
    "--cimt-paper": hsl(theme.paper),
    "--cimt-card": hsl(theme.card),
    "--cimt-ink": hsl(theme.ink),
    "--cimt-ink-soft": hsl(theme.inkSoft),
    "--cimt-ink-muted": hsl(theme.inkMuted),
    "--cimt-ink-faint": hsl(theme.inkFaint),
    "--cimt-line": hsl(theme.line),
    "--cimt-line-soft": hsl(mixHex(theme.line, theme.paper, 0.4)),
    "--cimt-stripe": hsl(theme.stripe),
    "--cimt-accent": hsl(theme.accent),
    "--cimt-accent-text": hsl(theme.accentText),
    "--cimt-on-accent": hsl(theme.onAccent),
    "--cimt-accent-muted": hsl(theme.accentSoft),
    "--cimt-accent-muted-fg": hsl(theme.accentSoftText),
    "--cimt-accent2": hsl(theme.accent2),
    "--cimt-accent2-muted": hsl(theme.accent2Soft),
    "--cimt-accent2-muted-fg": hsl(theme.accent2SoftText),
    "--cimt-positive": hsl(theme.positive),
    "--cimt-positive-muted": hsl(mixHex(theme.paper, theme.positive, 0.14)),
    "--cimt-negative": hsl(theme.negative),
    "--cimt-caution": hsl(theme.caution),
    "--cimt-heading": hsl(theme.heading),
    "--cimt-shadow": hsl(mixHex(theme.ink, "#000000", 0.3)),
    ...Object.fromEntries(theme.chart.slice(0, 5).map((c, i) => [`--cimt-chart-${i + 1}`, hsl(c)])),
    "--cimt-font-body": fontStack(theme.bodyFont),
    "--cimt-font-heading": fontStack(theme.headingFont),
    "--cimt-heading-weight": String(theme.headingWeight),
    "--cimt-radius": `${theme.radius}px`,
    "--cimt-gap": GAP[theme.density],
  };
}
