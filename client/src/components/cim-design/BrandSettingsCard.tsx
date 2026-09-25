/**
 * BrandSettingsCard — the brokerage's brand as every CIM shows it: logo,
 * firm name, colours and fonts (each switched on explicitly), the contact
 * block for the contact page, the disclaimer page, and which extra pages
 * appear. A live mini-CIM beside the form shows the result in the default
 * template. Saved to /api/branding (one row per broker).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ImageIcon, Loader2, Save, Trash2, Upload } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import type { BrandingSettings } from "@shared/schema";
import {
  COVER_STYLES,
  COVER_STYLE_LABELS,
  DEFAULT_DISCLAIMER,
  brandColorToHex,
  cleanFontFamily,
  type CimBrokerageBrand,
  type CimCoverStyle,
} from "@shared/cim-theme";
import { buildCimDesign } from "@/components/cim/CimDesignContext";
import { builderRequest, errorText } from "@/components/cim-builder/api";
import { brandingKey, templatesKey, uploadForm, useTemplates } from "./api";
import { ColorField, FontSelect } from "./fields";
import { CimPreview, Scaled } from "./CimPreview";
import { SAMPLE_CHART, SAMPLE_COVER, SAMPLE_METRICS } from "./sampleCim";

/** The schema defaults every legacy row carries — not a colour anyone chose. */
const LEGACY_DEFAULT_COLORS = new Set(["218 70% 47%", "25 95% 53%", "162 65% 38%"]);

interface Form {
  companyName: string;
  logoUrl: string | null;
  useBrandColors: boolean;
  primaryColor: string | null;
  accentColor: string | null;
  useBrandFonts: boolean;
  headingFont: string;
  bodyFont: string;
  firmAddress: string;
  firmPhone: string;
  firmEmail: string;
  firmWebsite: string;
  disclaimer: string;
  showDisclaimerPage: boolean;
  showContactPage: boolean;
  coverStyle: CimCoverStyle | null;
}

function fromRow(row: BrandingSettings | null | undefined): Form {
  const color = (v: string | null | undefined) => (v && !LEGACY_DEFAULT_COLORS.has(v.trim()) ? brandColorToHex(v) : null);
  return {
    companyName: row?.companyName ?? "",
    logoUrl: row?.logoUrl ?? null,
    useBrandColors: !!row?.useBrandColors,
    primaryColor: color(row?.primaryColor),
    accentColor: color(row?.accentColor),
    useBrandFonts: !!row?.useBrandFonts,
    headingFont: cleanFontFamily(row?.headingFont, "Plus Jakarta Sans"),
    bodyFont: cleanFontFamily(row?.bodyFont, "Plus Jakarta Sans"),
    firmAddress: row?.firmAddress ?? "",
    firmPhone: row?.firmPhone ?? "",
    firmEmail: row?.firmEmail ?? "",
    firmWebsite: row?.firmWebsite ?? "",
    disclaimer: row?.disclaimer ?? "",
    showDisclaimerPage: row ? row.showDisclaimerPage !== false : true,
    showContactPage: row ? row.showContactPage !== false : true,
    coverStyle: row?.coverStyle && (COVER_STYLES as readonly string[]).includes(row.coverStyle) ? (row.coverStyle as CimCoverStyle) : null,
  };
}

export function BrandSettingsCard({
  branding,
  account,
  contactName,
}: {
  branding: BrandingSettings | null | undefined;
  /** Account-tab firm details, used when the brand fields are blank. */
  account: { firmName?: string; firmEmail?: string; firmPhone?: string };
  contactName: string | null;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const templates = useTemplates();
  const [form, setForm] = useState<Form>(() => fromRow(branding));
  const [dirty, setDirty] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!dirty) setForm(fromRow(branding));
  }, [branding]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        companyName: form.companyName.trim() || null,
        logoUrl: form.logoUrl,
        useBrandColors: form.useBrandColors && !!form.primaryColor,
        useBrandFonts: form.useBrandFonts,
        headingFont: form.headingFont,
        bodyFont: form.bodyFont,
        firmAddress: form.firmAddress.trim() || null,
        firmPhone: form.firmPhone.trim() || null,
        firmEmail: form.firmEmail.trim() || null,
        firmWebsite: form.firmWebsite.trim() || null,
        disclaimer: form.disclaimer.trim() || null,
        showDisclaimerPage: form.showDisclaimerPage,
        showContactPage: form.showContactPage,
        coverStyle: form.coverStyle,
      };
      if (form.primaryColor) body.primaryColor = form.primaryColor;
      if (form.accentColor) body.accentColor = form.accentColor;
      return builderRequest<BrandingSettings>("POST", "/api/branding", body);
    },
    onSuccess: (row) => {
      qc.setQueryData(brandingKey, row);
      qc.invalidateQueries({ queryKey: ["/api/deals"] });
      qc.invalidateQueries({ queryKey: templatesKey });
      setDirty(false);
      toast({ title: "Brand saved", description: "Every CIM now uses it — including ones already published." });
    },
    onError: (e) => toast({ title: "Couldn't save your brand", description: errorText(e), variant: "destructive" }),
  });

  const uploadLogo = async (file: File) => {
    if (file.type === "image/svg+xml" || /\.svg$/i.test(file.name)) {
      toast({ title: "SVG logos aren't supported", description: "Export the logo as a PNG (transparent background works best).", variant: "destructive" });
      return;
    }
    setUploading(true);
    try {
      const { url } = await uploadForm<{ url: string }>("/api/cim-templates/brand-logo", file);
      set("logoUrl", url);
    } catch (e) {
      toast({ title: "Logo upload failed", description: errorText(e), variant: "destructive" });
    } finally {
      setUploading(false);
    }
  };

  // The live preview: this form's brand on the brokerage's default template.
  const defaultTemplate = templates.data?.templates.find((t) => t.id === templates.data?.defaultTemplateId);
  const brokerage: CimBrokerageBrand = {
    firmName: form.companyName.trim() || account.firmName?.trim() || null,
    logoUrl: form.logoUrl,
    primaryColor: form.primaryColor,
    accentColor: form.accentColor,
    useBrandColors: form.useBrandColors && !!form.primaryColor,
    headingFont: form.headingFont,
    bodyFont: form.bodyFont,
    useBrandFonts: form.useBrandFonts,
    disclaimer: form.disclaimer.trim() || null,
    address: form.firmAddress.trim() || null,
    phone: form.firmPhone.trim() || account.firmPhone?.trim() || null,
    email: form.firmEmail.trim() || account.firmEmail?.trim() || null,
    website: form.firmWebsite.trim() || null,
    contactName,
    showDisclaimerPage: form.showDisclaimerPage,
    showContactPage: form.showContactPage,
    coverStyle: form.coverStyle,
  };
  const design = useMemo(
    () => buildCimDesign(defaultTemplate ? { template: defaultTemplate, brokerage } : { brokerage }, "normal"),
    [defaultTemplate, JSON.stringify(brokerage)], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Your brokerage brand</CardTitle>
        <CardDescription>
          Shown on every CIM you make, in every template — including the blind CIM. The business's own branding is set per deal in the CIM builder.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
          {/* ── Form ── */}
          <div className="space-y-6 min-w-0">
            {/* Logo + name */}
            <div className="space-y-3">
              <Label className="text-xs">Logo</Label>
              <div className="flex items-center gap-3">
                <div className="h-16 w-28 shrink-0 rounded-md border border-border bg-white flex items-center justify-center overflow-hidden">
                  {form.logoUrl ? <img src={form.logoUrl} alt="Your logo" className="max-h-14 max-w-[104px] object-contain" /> : <ImageIcon className="h-5 w-5 text-neutral-400" />}
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex gap-2">
                    <Button size="sm" variant="outline" className="h-8 gap-1.5" onClick={() => fileRef.current?.click()} disabled={uploading} data-testid="button-upload-brand-logo">
                      {uploading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
                      {form.logoUrl ? "Replace" : "Upload logo"}
                    </Button>
                    {form.logoUrl && (
                      <Button size="sm" variant="ghost" className="h-8 gap-1 text-muted-foreground" onClick={() => set("logoUrl", null)}>
                        <Trash2 className="h-3.5 w-3.5" /> Remove
                      </Button>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground">PNG, JPG or WebP up to 5 MB. A transparent PNG looks best.</p>
                </div>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) uploadLogo(f);
                  }}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="brand-firm-name" className="text-xs">Firm name</Label>
                <Input
                  id="brand-firm-name"
                  value={form.companyName}
                  placeholder={account.firmName || "Harbour & Pine Business Advisors"}
                  onChange={(e) => set("companyName", e.target.value)}
                  data-testid="input-brand-firm-name"
                />
              </div>
            </div>

            {/* Colours */}
            <div className="rounded-lg border border-border p-4 space-y-4">
              <label className="flex items-start justify-between gap-3 cursor-pointer">
                <span>
                  <span className="text-sm font-medium block">Use my brand colours</span>
                  <span className="text-xs text-muted-foreground">Your colours lead the charts, accents and colour covers in every template. Off: each template uses its own.</span>
                </span>
                <Switch checked={form.useBrandColors} onCheckedChange={(v) => { set("useBrandColors", v); if (v && !form.primaryColor) set("primaryColor", "#1f3a68"); }} data-testid="switch-brand-colors" />
              </label>
              {form.useBrandColors && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <ColorField label="Main colour" value={form.primaryColor} against="#fbf8f2" onChange={(v) => set("primaryColor", v)} testId="input-brand-primary" />
                  <ColorField label="Second colour" value={form.accentColor} onChange={(v) => set("accentColor", v)} onClear={() => set("accentColor", null)} hint="Second chart series and highlights." testId="input-brand-accent" />
                </div>
              )}
            </div>

            {/* Fonts */}
            <div className="rounded-lg border border-border p-4 space-y-4">
              <label className="flex items-start justify-between gap-3 cursor-pointer">
                <span>
                  <span className="text-sm font-medium block">Use my brand fonts</span>
                  <span className="text-xs text-muted-foreground">Off: each template uses its own typefaces.</span>
                </span>
                <Switch checked={form.useBrandFonts} onCheckedChange={(v) => set("useBrandFonts", v)} data-testid="switch-brand-fonts" />
              </label>
              {form.useBrandFonts && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <FontSelect label="Headings" value={form.headingFont} onChange={(v) => set("headingFont", v)} testId="select-brand-heading-font" />
                  <FontSelect label="Body text" value={form.bodyFont} onChange={(v) => set("bodyFont", v)} testId="select-brand-body-font" />
                </div>
              )}
            </div>

            {/* Contact block */}
            <div className="space-y-3">
              <div>
                <p className="text-sm font-medium">Contact page</p>
                <p className="text-xs text-muted-foreground">The last page of every CIM. Blank fields use your Account settings.</p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="brand-phone">Phone</Label>
                  <Input id="brand-phone" value={form.firmPhone} placeholder={account.firmPhone || "(416) 555-0142"} onChange={(e) => set("firmPhone", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="brand-email">Email</Label>
                  <Input id="brand-email" type="email" value={form.firmEmail} placeholder={account.firmEmail || "deals@yourfirm.com"} onChange={(e) => set("firmEmail", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="brand-website">Website</Label>
                  <Input id="brand-website" value={form.firmWebsite} placeholder="yourfirm.com" onChange={(e) => set("firmWebsite", e.target.value)} />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs" htmlFor="brand-address">Office address</Label>
                  <Input id="brand-address" value={form.firmAddress} placeholder="100 King St W, Suite 5600, Toronto ON" onChange={(e) => set("firmAddress", e.target.value)} />
                </div>
              </div>
            </div>

            {/* Disclaimer */}
            <div className="space-y-1.5">
              <Label className="text-sm font-medium" htmlFor="brand-disclaimer">Confidentiality & disclaimer</Label>
              <p className="text-xs text-muted-foreground">The page right after the cover. Leave blank to use the standard wording (shown greyed).</p>
              <Textarea
                id="brand-disclaimer"
                rows={5}
                value={form.disclaimer}
                placeholder={DEFAULT_DISCLAIMER}
                onChange={(e) => set("disclaimer", e.target.value)}
                className="text-xs leading-relaxed"
                data-testid="input-brand-disclaimer"
              />
            </div>

            {/* Pages + cover */}
            <div className="rounded-lg border border-border divide-y divide-border">
              <label className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer">
                <span className="text-sm">Disclaimer page after the cover</span>
                <Switch checked={form.showDisclaimerPage} onCheckedChange={(v) => set("showDisclaimerPage", v)} data-testid="switch-disclaimer-page" />
              </label>
              <label className="flex items-center justify-between gap-3 px-4 py-3 cursor-pointer">
                <span className="text-sm">Contact page at the end</span>
                <Switch checked={form.showContactPage} onCheckedChange={(v) => set("showContactPage", v)} data-testid="switch-contact-page" />
              </label>
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="text-sm">Cover style</span>
                <Select value={form.coverStyle ?? "template"} onValueChange={(v) => set("coverStyle", v === "template" ? null : (v as CimCoverStyle))}>
                  <SelectTrigger className="h-8 w-[170px] text-xs" data-testid="select-cover-style"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="template" className="text-xs">Each template's own</SelectItem>
                    {COVER_STYLES.filter((c) => c !== "photo").map((c) => (
                      <SelectItem key={c} value={c} className="text-xs">{COVER_STYLE_LABELS[c]}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex items-center justify-end gap-3">
              {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
              <Button onClick={() => save.mutate()} disabled={save.isPending || !dirty} className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5" data-testid="button-save-brand">
                {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save brand
              </Button>
            </div>
          </div>

          {/* ── Live preview ── */}
          <div className="min-w-0">
            <div className="lg:sticky lg:top-4 space-y-2">
              <p className="text-[11px] uppercase tracking-wider text-muted-foreground">
                Preview · {defaultTemplate?.name ?? "Classic Paper"} (your default)
              </p>
              <div className="rounded-xl bg-muted/40 p-3 lg:max-h-[calc(100vh-7rem)] overflow-y-auto scrollbar-thin" data-testid="brand-live-preview">
                <Scaled baseWidth={760}>
                  <CimPreview design={design} sections={[SAMPLE_COVER, SAMPLE_METRICS, SAMPLE_CHART]} />
                </Scaled>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
