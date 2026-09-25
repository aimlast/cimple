/**
 * templates — CIM design templates and branding, server side.
 *
 * Which template a deal uses (its own pick → the brokerage's default →
 * Classic Paper), the brokerage brand as the CIM may show it (a whitelist —
 * never the settings row), and the business's own branding, which only
 * reaches Normal/DD CIMs. The browser resolves the final theme with
 * shared/cim-theme.ts resolveCimTheme().
 */
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import {
  brandingSettings,
  cimTemplates,
  dealMedia,
  type BrandingSettings,
  type CimTemplateRow,
  type Deal,
} from "@shared/schema";
import {
  BUILTIN_TEMPLATES,
  COVER_STYLES,
  DEFAULT_TEMPLATE_ID,
  EMPTY_BROKERAGE,
  brandColorToHex,
  cleanFontFamily,
  getBuiltinTemplate,
  sanitizeBusinessBranding,
  sanitizeOutline,
  sanitizeTokens,
  type CimBrokerageBrand,
  type CimBusinessBranding,
  type CimCoverStyle,
  type CimSectionOutline,
  type CimThemeTokens,
  type CimVersionMode,
} from "@shared/cim-theme";

export interface TemplateView {
  id: string;
  name: string;
  description: string | null;
  builtIn: boolean;
  tokens: CimThemeTokens;
  sectionOutline: CimSectionOutline | null;
  basedOn: string | null;
  updatedAt: string | null;
}

export function builtinView(id: string): TemplateView | null {
  const t = getBuiltinTemplate(id);
  if (!t) return null;
  return { id: t.id, name: t.name, description: t.description, builtIn: true, tokens: t.tokens, sectionOutline: null, basedOn: null, updatedAt: null };
}

export function customView(row: CimTemplateRow): TemplateView {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    builtIn: false,
    tokens: sanitizeTokens(row.tokens),
    sectionOutline: sanitizeOutline(row.sectionOutline),
    basedOn: row.basedOn ?? null,
    updatedAt: row.updatedAt ? new Date(row.updatedAt).toISOString() : null,
  };
}

export async function listCustomTemplates(brokerId: string): Promise<CimTemplateRow[]> {
  return db.select().from(cimTemplates).where(eq(cimTemplates.brokerId, brokerId)).orderBy(asc(cimTemplates.createdAt));
}

export async function getCustomTemplate(brokerId: string, id: string): Promise<CimTemplateRow | null> {
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) return null;
  const [row] = await db
    .select()
    .from(cimTemplates)
    .where(and(eq(cimTemplates.id, id), eq(cimTemplates.brokerId, brokerId)));
  return row ?? null;
}

/** A built-in, or one of this broker's own templates; null for anything else. */
export async function findTemplate(brokerId: string, id: string | null | undefined): Promise<TemplateView | null> {
  if (!id) return null;
  const builtin = builtinView(id);
  if (builtin) return builtin;
  const row = await getCustomTemplate(brokerId, id);
  return row ? customView(row) : null;
}

/** The brokerage's default template id (validated), or Classic Paper. */
export async function brokerDefaultTemplateId(brokerId: string, branding?: BrandingSettings | null): Promise<string> {
  const b = branding === undefined ? await storage.getBrandingByBroker(brokerId) : branding;
  const id = b?.defaultTemplateId;
  if (id && (getBuiltinTemplate(id) || (await getCustomTemplate(brokerId, id)))) return id;
  return DEFAULT_TEMPLATE_ID;
}

/**
 * The template a deal's CIM uses: the deal's own pick, else the brokerage
 * default, else Classic Paper. A stale id (deleted template) falls through.
 */
export async function templateForDeal(deal: Pick<Deal, "brokerId" | "designTemplateId">, branding?: BrandingSettings | null): Promise<TemplateView> {
  const brokerId = deal.brokerId;
  if (brokerId) {
    const own = await findTemplate(brokerId, deal.designTemplateId);
    if (own) return own;
    const def = await findTemplate(brokerId, await brokerDefaultTemplateId(brokerId, branding));
    if (def) return def;
  }
  return builtinView(DEFAULT_TEMPLATE_ID)!;
}

/** Same-origin upload path or an https URL — nothing else is rendered as a logo. */
export function safeLogoUrl(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (/^\/uploads\/[A-Za-z0-9_./-]+\.(png|jpe?g|webp|gif)$/i.test(s) && !s.includes("..") && !/^\/uploads\/private-media\//i.test(s)) return s;
  if (/^https:\/\/[^\s"'<>]+$/i.test(s) && !/\.svg(\?|#|$)/i.test(s)) return s.slice(0, 500);
  return null;
}

function text(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

/**
 * The brokerage brand as a CIM (and a buyer) may see it. Firm contact
 * details fall back to the broker's Account settings when the brand
 * settings leave them blank.
 */
export async function brokerageBrand(brokerId: string | null | undefined, branding?: BrandingSettings | null): Promise<CimBrokerageBrand> {
  if (!brokerId) return { ...EMPTY_BROKERAGE };
  const [b, user] = await Promise.all([
    branding === undefined ? storage.getBrandingByBroker(brokerId) : Promise.resolve(branding ?? undefined),
    storage.getUser(brokerId),
  ]);
  const acct = ((user?.settings as Record<string, unknown> | null) ?? {}) as Record<string, unknown>;
  const cover = b?.coverStyle && (COVER_STYLES as readonly string[]).includes(b.coverStyle) ? (b.coverStyle as CimCoverStyle) : null;
  return {
    firmName: text(b?.companyName, 160) ?? text(acct.firmName, 160),
    logoUrl: safeLogoUrl(b?.logoUrl),
    primaryColor: brandColorToHex(b?.primaryColor),
    accentColor: brandColorToHex(b?.accentColor),
    useBrandColors: !!b?.useBrandColors,
    headingFont: b?.headingFont ? cleanFontFamily(b.headingFont) : null,
    bodyFont: b?.bodyFont ? cleanFontFamily(b.bodyFont) : null,
    useBrandFonts: !!b?.useBrandFonts,
    disclaimer: text(b?.disclaimer, 6000),
    address: text(b?.firmAddress, 300),
    phone: text(b?.firmPhone, 60) ?? text(acct.firmPhone, 60),
    email: text(b?.firmEmail, 160) ?? text(acct.firmEmail, 160),
    website: text(b?.firmWebsite, 200),
    contactName: text(user?.name, 120),
    showDisclaimerPage: b ? b.showDisclaimerPage !== false : true,
    showContactPage: b ? b.showContactPage !== false : true,
    coverStyle: cover,
  };
}

/** The business branding a CIM version may use: none at all in Blind. */
export function businessBrandingFor(deal: Pick<Deal, "businessBranding">, mode: CimVersionMode): CimBusinessBranding | null {
  if (mode === "blind") return null;
  const b = sanitizeBusinessBranding(deal.businessBranding);
  const any = b.logoMediaId || b.coverPhotoMediaId || b.useBusinessColors;
  return any ? b : null;
}

/** Media ids the business branding points at (for the buyer media gate). */
export function businessBrandingMediaIds(deal: Pick<Deal, "businessBranding">): string[] {
  const b = sanitizeBusinessBranding(deal.businessBranding);
  return [b.logoMediaId, b.coverPhotoMediaId].filter((x): x is string => !!x);
}

export interface CimDesignPayload {
  template: { id: string; name: string; tokens: CimThemeTokens };
  brokerage: CimBrokerageBrand;
  business: CimBusinessBranding | null;
}

/** Everything the page needs to theme a CIM version — whitelisted, blind-safe. */
export async function designPayload(deal: Deal, mode: CimVersionMode): Promise<CimDesignPayload> {
  const branding = deal.brokerId ? (await storage.getBrandingByBroker(deal.brokerId)) ?? null : null;
  const [template, brokerage] = await Promise.all([
    templateForDeal(deal, branding),
    brokerageBrand(deal.brokerId, branding),
  ]);
  return {
    // A custom template's name is broker-typed free text (it could name the
    // business), so Blind buyers never receive it.
    template: { id: template.id, name: mode === "blind" && !template.builtIn ? "" : template.name, tokens: template.tokens },
    brokerage,
    business: businessBrandingFor(deal, mode),
  };
}

/** The deal's own image uploads (business logo / cover photo must be one of these). */
export async function dealImageIds(dealId: string): Promise<Set<string>> {
  const rows = await db
    .select({ id: dealMedia.id, kind: dealMedia.kind })
    .from(dealMedia)
    .where(eq(dealMedia.dealId, dealId));
  return new Set(rows.filter((r) => r.kind === "image").map((r) => r.id));
}

/** The broker's settings row, creating an empty one on first use. */
export async function ensureBrandingRow(brokerId: string): Promise<BrandingSettings> {
  const existing = await storage.getBrandingByBroker(brokerId);
  if (existing) return existing;
  return storage.createBrandingSettings({ brokerId } as any);
}

export async function setBrokerDefaultTemplate(brokerId: string, templateId: string | null): Promise<void> {
  const row = await ensureBrandingRow(brokerId);
  await db
    .update(brandingSettings)
    .set({ defaultTemplateId: templateId, updatedAt: new Date() })
    .where(eq(brandingSettings.id, row.id));
}

/**
 * Validates the CIM-facing fields of a branding write (POST/PATCH
 * /api/branding). Returns the cleaned partial, or an error message.
 * Only keys present in the body are returned (a PATCH stays partial).
 */
export async function cleanBrandingWrite(
  brokerId: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const data: Record<string, unknown> = { ...body };
  delete data.id;
  delete data.brokerId;
  delete data.createdAt;
  delete data.updatedAt;
  if ("logoUrl" in body && body.logoUrl !== null && body.logoUrl !== "") {
    const url = safeLogoUrl(body.logoUrl);
    if (!url) return { ok: false, error: "Upload the logo as a PNG, JPG, WebP or GIF image (SVG isn't supported)." };
    data.logoUrl = url;
  } else if ("logoUrl" in body) data.logoUrl = null;
  for (const k of ["primaryColor", "accentColor"] as const) {
    if (!(k in body)) continue;
    const hex = brandColorToHex(body[k]);
    if (!hex) return { ok: false, error: "Colours must be hex values like #1F3A68." };
    data[k] = hex;
  }
  for (const k of ["headingFont", "bodyFont"] as const) {
    if (k in body) data[k] = cleanFontFamily(body[k], "Inter");
  }
  if ("coverStyle" in body) {
    const v = body.coverStyle;
    if (v !== null && !(typeof v === "string" && (COVER_STYLES as readonly string[]).includes(v))) {
      return { ok: false, error: "Unknown cover style." };
    }
  }
  if ("defaultTemplateId" in body && body.defaultTemplateId !== null) {
    const id = typeof body.defaultTemplateId === "string" ? body.defaultTemplateId : "";
    if (!(await findTemplate(brokerId, id))) return { ok: false, error: "That template doesn't exist." };
  }
  for (const k of ["firmAddress", "firmPhone", "firmEmail", "firmWebsite", "companyName"] as const) {
    if (k in body) data[k] = text(body[k], k === "firmAddress" ? 300 : 200);
  }
  if ("firmWebsite" in body && data.firmWebsite && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/[^\s]*)?$/i.test(String(data.firmWebsite))) {
    return { ok: false, error: "The website doesn't look like a web address." };
  }
  if ("firmEmail" in body && data.firmEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(data.firmEmail))) {
    return { ok: false, error: "The email address doesn't look right." };
  }
  if ("disclaimer" in body) data.disclaimer = text(body.disclaimer, 6000);
  return { ok: true, data };
}

export { BUILTIN_TEMPLATES };
