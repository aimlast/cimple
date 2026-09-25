/**
 * CIM design — templates, brokerage brand and a deal's design
 * (server/routes/cim-templates.ts, /api/branding).
 */
import { useQuery } from "@tanstack/react-query";
import type { BrandingSettings } from "@shared/schema";
import type {
  CimBrokerageBrand,
  CimBusinessBranding,
  CimSectionOutline,
  CimThemeTokens,
} from "@shared/cim-theme";
import { BuilderApiError, builderRequest } from "@/components/cim-builder/api";

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

export interface TemplatesResponse {
  templates: TemplateView[];
  defaultTemplateId: string;
  /** The saved brokerage brand (templates are previewed wearing it). */
  brokerage: CimBrokerageBrand;
}

export interface DealDesignResponse {
  /** The deal's own pick (null = follows the brokerage default). */
  templateId: string | null;
  defaultTemplateId: string;
  /** The template actually applied. */
  template: TemplateView;
  brokerage: CimBrokerageBrand;
  business: CimBusinessBranding;
}

export const templatesKey = ["/api/cim-templates"] as const;
export const brandingKey = ["/api/branding"] as const;
export const dealDesignKey = (dealId: string) => ["/api/deals", dealId, "design"] as const;

export function useTemplates() {
  return useQuery<TemplatesResponse>({
    queryKey: templatesKey,
    queryFn: () => builderRequest<TemplatesResponse>("GET", "/api/cim-templates"),
  });
}

export function useDealDesign(dealId: string, enabled = true) {
  return useQuery<DealDesignResponse>({
    queryKey: dealDesignKey(dealId),
    queryFn: () => builderRequest<DealDesignResponse>("GET", `/api/deals/${dealId}/design`),
    enabled: !!dealId && enabled,
  });
}

export function useBrandingSettings() {
  return useQuery<BrandingSettings | null>({
    queryKey: brandingKey,
    queryFn: async () => {
      const body = await builderRequest<BrandingSettings | BrandingSettings[] | null>("GET", "/api/branding");
      return Array.isArray(body) ? body[0] ?? null : body;
    },
  });
}

/** multipart upload that throws the server's own error message. */
export async function uploadForm<T = any>(url: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append("file", file);
  const res = await fetch(url, { method: "POST", credentials: "include", body: form });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new BuilderApiError((data && data.error) || "Upload failed. Please try again.", res.status);
  return data as T;
}
