/**
 * DesignPanel — the CIM builder's "Design" drawer: which template this
 * deal's CIM uses, the business's own branding (logo, cover photo,
 * colours — named CIMs only), and the brokerage branding it inherits.
 * Every change saves at once and the page behind re-themes immediately.
 */
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, EyeOff, ImageIcon, Loader2, Printer, Settings2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { resolveCimTheme, type CimBusinessBranding } from "@shared/cim-theme";
import { builderRequest, errorText } from "@/components/cim-builder/api";
import { UploadDropzone } from "@/components/cim-builder/media/UploadDropzone";
import type { MediaLibraryApi } from "@/components/cim-builder/media/api";
import { dealDesignKey, useTemplates, type DealDesignResponse, type TemplateView } from "./api";
import { TemplateSwatch } from "./TemplateSwatch";
import { ColorField } from "./fields";

interface Props {
  dealId: string;
  design: DealDesignResponse | undefined;
  loading: boolean;
  library: MediaLibraryApi;
  onPrintPreview: () => void;
}

export function DesignPanel({ dealId, design, loading, library, onPrintPreview }: Props) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const templates = useTemplates();

  const save = useMutation({
    mutationFn: (body: { templateId?: string | null; business?: Partial<CimBusinessBranding> }) =>
      builderRequest<Pick<DealDesignResponse, "templateId" | "template" | "business">>("PATCH", `/api/deals/${dealId}/design`, body),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: dealDesignKey(dealId) });
      const prev = qc.getQueryData<DealDesignResponse>(dealDesignKey(dealId));
      if (prev) {
        const all = templates.data?.templates ?? [];
        const nextTemplateId = body.templateId !== undefined ? body.templateId : prev.templateId;
        const tpl = all.find((t) => t.id === (nextTemplateId ?? prev.defaultTemplateId)) ?? prev.template;
        qc.setQueryData<DealDesignResponse>(dealDesignKey(dealId), {
          ...prev,
          templateId: nextTemplateId,
          template: tpl,
          business: body.business ? { ...prev.business, ...body.business } : prev.business,
        });
      }
      return { prev };
    },
    onError: (err, _b, ctx) => {
      if (ctx?.prev) qc.setQueryData(dealDesignKey(dealId), ctx.prev);
      toast({ title: "Couldn't save the design", description: errorText(err), variant: "destructive" });
    },
    onSuccess: (r) => {
      qc.setQueryData<DealDesignResponse>(dealDesignKey(dealId), (cur) => (cur ? { ...cur, ...r } : cur));
    },
  });

  if (loading || !design) {
    return (
      <div className="space-y-3">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}
      </div>
    );
  }

  const list = templates.data?.templates ?? [];
  const defaultTpl = list.find((t) => t.id === design.defaultTemplateId);
  const business = design.business;

  return (
    <div className="space-y-7">
      {/* ── Template ── */}
      <section className="space-y-2.5">
        <div className="flex items-end justify-between gap-2">
          <div>
            <p className="text-sm font-semibold">Template</p>
            <p className="text-[11px] text-muted-foreground">Fonts, colours, cover and headings for this CIM.</p>
          </div>
          <a href="/broker/settings?tab=brand" className="text-[11px] text-teal hover:underline inline-flex items-center gap-1 shrink-0">
            <Settings2 className="h-3 w-3" /> Manage templates
          </a>
        </div>
        {templates.isLoading ? (
          <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 rounded-lg" />)}</div>
        ) : templates.isError ? (
          <p className="text-xs text-red-400">Couldn't load templates. <button className="underline" onClick={() => templates.refetch()}>Try again</button></p>
        ) : (
          <div className="space-y-1.5" role="radiogroup" aria-label="Template">
            <TemplateOption
              label={`Brokerage default${defaultTpl ? ` — ${defaultTpl.name}` : ""}`}
              hint="Follows your default template, even if you change it later"
              template={defaultTpl}
              brokerage={design.brokerage}
              selected={design.templateId === null}
              onSelect={() => save.mutate({ templateId: null })}
              testId="design-template-default"
            />
            {list.map((t) => (
              <TemplateOption
                key={t.id}
                label={t.name}
                hint={t.builtIn ? undefined : t.sectionOutline ? `Your template · follows ${t.sectionOutline.sections.length} sections` : "Your template"}
                template={t}
                brokerage={design.brokerage}
                selected={design.templateId === t.id}
                onSelect={() => save.mutate({ templateId: t.id })}
                testId={`design-template-${t.id}`}
              />
            ))}
          </div>
        )}
        {design.template.sectionOutline && (
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            “{design.template.name}” carries your house structure ({design.template.sectionOutline.sections.length} sections).
            It's followed the next time the whole CIM is generated.
          </p>
        )}
      </section>

      {/* ── The business's branding ── */}
      <section className="space-y-3">
        <div>
          <p className="text-sm font-semibold">The business's branding</p>
          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5 mt-0.5">
            <EyeOff className="h-3 w-3 mt-0.5 shrink-0" />
            Shown in the named CIM (LOI and due-diligence buyers). Never in the blind CIM.
          </p>
        </div>
        <ImagePick
          dealId={dealId}
          label="Logo"
          hint="On the cover, beside the business name."
          value={business.logoMediaId ?? null}
          library={library}
          busy={save.isPending}
          onChange={(id) => save.mutate({ business: { logoMediaId: id } })}
          testId="design-business-logo"
        />
        <ImagePick
          dealId={dealId}
          label="Cover photo"
          hint="Fills the cover behind the business name."
          value={business.coverPhotoMediaId ?? null}
          library={library}
          busy={save.isPending}
          onChange={(id) => save.mutate({ business: { coverPhotoMediaId: id } })}
          testId="design-cover-photo"
        />
        <div className="rounded-lg border border-border p-3 space-y-3">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span>
              <span className="text-xs font-medium block">Use the business's colours</span>
              <span className="text-[11px] text-muted-foreground">Replaces the template and brokerage colours in the named CIM.</span>
            </span>
            <Switch
              checked={!!business.useBusinessColors}
              onCheckedChange={(v) => save.mutate({ business: { useBusinessColors: v, primaryColor: business.primaryColor ?? (v ? "#1f3a68" : null) } })}
              data-testid="design-use-business-colors"
            />
          </label>
          {business.useBusinessColors && (
            <div className="grid grid-cols-2 gap-3">
              <ColorField
                label="Main colour"
                value={business.primaryColor ?? null}
                against={design.template.tokens.paper}
                onChange={(hex) => save.mutate({ business: { primaryColor: hex } })}
                testId="design-business-primary"
              />
              <ColorField
                label="Second colour"
                value={business.accentColor ?? null}
                onChange={(hex) => save.mutate({ business: { accentColor: hex } })}
                onClear={() => save.mutate({ business: { accentColor: null } })}
                testId="design-business-accent"
              />
            </div>
          )}
        </div>
      </section>

      {/* ── Brokerage branding (inherited) ── */}
      <section className="space-y-2">
        <p className="text-sm font-semibold">Your brokerage</p>
        <div className="rounded-lg border border-border p-3 flex items-center gap-3">
          {design.brokerage.logoUrl ? (
            <img src={design.brokerage.logoUrl} alt="" className="h-9 max-w-[90px] object-contain rounded bg-white p-1" />
          ) : (
            <div className="h-9 w-9 rounded bg-muted flex items-center justify-center"><ImageIcon className="h-4 w-4 text-muted-foreground" /></div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium truncate">{design.brokerage.firmName || "No firm name yet"}</p>
            <p className="text-[11px] text-muted-foreground">
              {design.brokerage.useBrandColors ? "Brand colours on" : "Template colours"} ·{" "}
              {[design.brokerage.showDisclaimerPage && "disclaimer page", design.brokerage.showContactPage && "contact page"].filter(Boolean).join(" + ") || "no extra pages"}
            </p>
          </div>
          <a href="/broker/settings?tab=brand" className="text-[11px] text-teal hover:underline shrink-0">Edit</a>
        </div>
        <p className="text-[11px] text-muted-foreground">Your logo, contact page and disclaimer appear in every version, including the blind CIM.</p>
      </section>

      <Button variant="outline" className="w-full gap-1.5" onClick={onPrintPreview} data-testid="design-print-preview">
        <Printer className="h-4 w-4" /> Print preview
      </Button>
    </div>
  );
}

function TemplateOption({
  label, hint, template, brokerage, selected, onSelect, testId,
}: {
  label: string;
  hint?: string;
  template: TemplateView | undefined;
  brokerage: DealDesignResponse["brokerage"];
  selected: boolean;
  onSelect: () => void;
  testId?: string;
}) {
  const theme = template ? resolveCimTheme({ tokens: template.tokens, templateId: template.id, brokerage }) : null;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "w-full flex items-center gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors",
        selected ? "border-teal bg-teal/10" : "border-border hover:border-teal/40 hover:bg-muted/40",
      )}
      data-testid={testId}
    >
      {theme ? <TemplateSwatch theme={theme} className="h-11 w-9" /> : <div className="h-11 w-9 rounded-md bg-muted" />}
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium truncate">{label}</span>
        {hint && <span className="block text-[10px] text-muted-foreground truncate">{hint}</span>}
      </span>
      {selected && <Check className="h-4 w-4 text-teal shrink-0" />}
    </button>
  );
}

function ImagePick({
  dealId, label, hint, value, library, busy, onChange, testId,
}: {
  dealId: string;
  label: string;
  hint: string;
  value: string | null;
  library: MediaLibraryApi;
  busy: boolean;
  onChange: (id: string | null) => void;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const images = library.items.filter((m) => m.kind === "image");
  const current = value ? images.find((m) => m.id === value) : null;
  return (
    <div className="rounded-lg border border-border p-3 space-y-2" data-testid={testId}>
      <div className="flex items-center gap-3">
        <div className="h-12 w-16 shrink-0 overflow-hidden rounded bg-muted flex items-center justify-center">
          {current ? <img src={current.url} alt="" className="h-full w-full object-contain bg-white" /> : <ImageIcon className="h-4 w-4 text-muted-foreground" />}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium">{label}</p>
          <p className="text-[11px] text-muted-foreground">{value && !current && library.query.isLoading ? "Loading…" : current ? current.originalName || "From the media library" : hint}</p>
        </div>
        <div className="flex gap-1 shrink-0">
          <Button size="sm" variant="outline" className="h-7 text-[11px]" onClick={() => setOpen((o) => !o)} disabled={busy}>
            {current ? "Change" : "Choose"}
          </Button>
          {value && (
            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => onChange(null)} disabled={busy} aria-label={`Remove ${label.toLowerCase()}`}>
              <X className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div className="space-y-2 pt-1">
          {images.length > 0 && (
            <div className="grid grid-cols-4 gap-1.5 max-h-44 overflow-y-auto scrollbar-thin">
              {images.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => { onChange(m.id); setOpen(false); }}
                  className={cn("relative aspect-square overflow-hidden rounded border bg-white", m.id === value ? "border-teal ring-2 ring-teal/40" : "border-border hover:border-teal/50")}
                  title={m.originalName || m.caption || "Photo"}
                >
                  <img src={m.url} alt={m.caption || ""} className="h-full w-full object-cover" loading="lazy" />
                  {busy && m.id === value && <Loader2 className="absolute inset-0 m-auto h-4 w-4 animate-spin" />}
                </button>
              ))}
            </div>
          )}
          <UploadDropzone
            dealId={dealId}
            kind="image"
            multiple={false}
            compact
            onUploaded={(item) => {
              library.addUploaded(item);
              onChange(item.id);
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}
