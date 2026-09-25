/**
 * TemplateEditor — edit one custom template's tokens with a live preview
 * of the sample CIM (real renderers). Built-ins are copied first.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ListOrdered, Loader2, Save, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Slider } from "@/components/ui/slider";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  COVER_STYLES,
  COVER_STYLE_LABELS,
  DENSITIES,
  DENSITY_LABELS,
  HEADER_STYLES,
  HEADER_STYLE_LABELS,
  getCimFont,
  mixHex,
  snapFontWeight,
  type CimBrokerageBrand,
  type CimSectionOutline,
  type CimThemeTokens,
} from "@shared/cim-theme";
import { buildCimDesign } from "@/components/cim/CimDesignContext";
import { builderRequest, errorText } from "@/components/cim-builder/api";
import { templatesKey, type TemplateView } from "./api";
import { ColorField, FontSelect, Segmented } from "./fields";
import { CimPreview, Scaled } from "./CimPreview";

export function TemplateEditor({
  template,
  brokerage,
  open,
  onOpenChange,
}: {
  template: TemplateView | null;
  brokerage: Partial<CimBrokerageBrand> | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tokens, setTokens] = useState<CimThemeTokens | null>(null);
  const [outline, setOutline] = useState<CimSectionOutline | null>(null);
  const [more, setMore] = useState(false);

  useEffect(() => {
    if (!template || !open) return;
    setName(template.name);
    setDescription(template.description ?? "");
    setTokens(template.tokens);
    setOutline(template.sectionOutline);
    setMore(false);
  }, [template?.id, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useMutation({
    mutationFn: () =>
      builderRequest<TemplateView>("PATCH", `/api/cim-templates/${template!.id}`, {
        name,
        description,
        tokens,
        sectionOutline: outline && outline.sections.length > 0 ? outline : null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: templatesKey });
      qc.invalidateQueries({ queryKey: ["/api/deals"] });
      toast({ title: "Template saved", description: "CIMs using it update straight away." });
      onOpenChange(false);
    },
    onError: (e) => toast({ title: "Couldn't save the template", description: errorText(e), variant: "destructive" }),
  });

  const design = useMemo(
    () => (tokens && template ? buildCimDesign({ template: { id: template.id, name, tokens }, brokerage }, "normal") : null),
    [tokens, template, name, brokerage],
  );

  if (!template || !tokens) return null;

  const set = <K extends keyof CimThemeTokens>(k: K, v: CimThemeTokens[K]) => setTokens((t) => (t ? { ...t, [k]: v } : t));
  /** Ink or paper changed: re-derive the in-between greys so text stays readable. */
  const setBase = (k: "ink" | "paper", v: string) =>
    setTokens((t) => {
      if (!t) return t;
      const ink = k === "ink" ? v : t.ink;
      const paper = k === "paper" ? v : t.paper;
      return {
        ...t,
        [k]: v,
        inkSoft: mixHex(ink, paper, 0.2),
        inkMuted: mixHex(ink, paper, 0.4),
        inkFaint: mixHex(ink, paper, 0.52),
        line: mixHex(ink, paper, 0.86),
        stripe: mixHex(ink, paper, 0.93),
        card: k === "paper" ? mixHex(paper, "#ffffff", 0.6) : t.card,
      };
    });
  const weights = getCimFont(tokens.headingFont)?.weights ?? [400, 700];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl w-[calc(100vw-1.5rem)] h-[92vh] p-0 gap-0 flex flex-col overflow-hidden">
        <DialogHeader className="px-5 py-4 border-b border-border shrink-0">
          <DialogTitle>Edit template</DialogTitle>
          <DialogDescription>Changes preview on a sample CIM. Deals using this template update when you save.</DialogDescription>
        </DialogHeader>
        <div className="flex-1 min-h-0 grid md:grid-cols-[340px_minmax(0,1fr)]">
          {/* Controls */}
          <div className="min-h-0 overflow-y-auto scrollbar-thin border-b md:border-b-0 md:border-r border-border p-5 space-y-6">
            <div className="space-y-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Template name" className="font-medium" data-testid="input-template-name" />
              <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Short description (optional)" className="text-xs" />
            </div>

            <Group title="Colours">
              <div className="grid grid-cols-2 gap-3">
                <ColorField label="Page" value={tokens.paper} onChange={(v) => setBase("paper", v)} testId="token-paper" />
                <ColorField label="Text" value={tokens.ink} onChange={(v) => setBase("ink", v)} testId="token-ink" />
                <ColorField label="Accent" value={tokens.accent} against={tokens.paper} onChange={(v) => set("accent", v)} testId="token-accent" />
                <ColorField label="Second colour" value={tokens.accent2} onChange={(v) => set("accent2", v)} testId="token-accent2" />
              </div>
              {brokerage?.useBrandColors && (
                <p className="text-[11px] text-muted-foreground">Your brand colours are on, so they replace the accent and second colour in CIMs.</p>
              )}
              <button type="button" onClick={() => setMore((m) => !m)} className="text-[11px] text-teal hover:underline inline-flex items-center gap-1">
                <ChevronDown className={cn("h-3 w-3 transition-transform", more && "rotate-180")} /> {more ? "Fewer colours" : "More colours"}
              </button>
              {more && (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <ColorField label="Cards" value={tokens.card} onChange={(v) => set("card", v)} />
                    <ColorField label="Lines" value={tokens.line} onChange={(v) => set("line", v)} />
                    <ColorField label="Muted text" value={tokens.inkMuted} onChange={(v) => set("inkMuted", v)} />
                    <ColorField label="Table stripe" value={tokens.stripe} onChange={(v) => set("stripe", v)} />
                    <ColorField label="Positive" value={tokens.positive} onChange={(v) => set("positive", v)} />
                    <ColorField label="Negative" value={tokens.negative} onChange={(v) => set("negative", v)} />
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium">Chart colours</span>
                    <div className="flex flex-wrap gap-1.5">
                      {tokens.chart.map((c, i) => (
                        <label key={i} className="relative h-8 w-8 overflow-hidden rounded-md border border-border cursor-pointer" style={{ backgroundColor: c }} title={`Series ${i + 1}`}>
                          <input
                            type="color"
                            value={c}
                            onChange={(e) => set("chart", tokens.chart.map((x, j) => (j === i ? e.target.value : x)))}
                            className="absolute inset-0 opacity-0 cursor-pointer"
                            aria-label={`Chart colour ${i + 1}`}
                          />
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </Group>

            <Group title="Type">
              <FontSelect label="Headings" value={tokens.headingFont} onChange={(v) => setTokens((t) => (t ? { ...t, headingFont: v, headingWeight: snapFontWeight(v, t.headingWeight) } : t))} testId="token-heading-font" />
              <FontSelect label="Body text" value={tokens.bodyFont} onChange={(v) => set("bodyFont", v)} testId="token-body-font" />
              <Segmented
                label="Heading weight"
                value={String(tokens.headingWeight)}
                options={weights.filter((w) => w >= 400).map((w) => ({ value: String(w), label: w === 400 ? "Regular" : w === 500 ? "Medium" : w === 600 ? "Semibold" : w === 700 ? "Bold" : w === 800 ? "Extra bold" : "Black" }))}
                onChange={(v) => set("headingWeight", Number(v))}
              />
              <Segmented
                label="Heading colour"
                value={tokens.headingTone}
                options={[{ value: "ink", label: "Text colour" }, { value: "accent", label: "Accent" }]}
                onChange={(v) => set("headingTone", v)}
              />
            </Group>

            <Group title="Layout">
              <Segmented
                label="Cover"
                value={tokens.coverStyle}
                options={COVER_STYLES.map((c) => ({ value: c, label: COVER_STYLE_LABELS[c] }))}
                onChange={(v) => set("coverStyle", v)}
                testId="token-cover-style"
              />
              {tokens.coverStyle === "photo" && (
                <p className="text-[11px] text-muted-foreground">Uses the cover photo you pick for each deal (named CIM only). Without one — and always in the blind CIM — the dark cover is used.</p>
              )}
              {(tokens.coverStyle === "dark" || tokens.coverStyle === "photo") && (
                <ColorField label="Dark cover colour" value={tokens.coverBg} onChange={(v) => set("coverBg", v)} />
              )}
              <Segmented
                label="Section headings"
                value={tokens.headerStyle}
                options={HEADER_STYLES.map((h) => ({ value: h, label: HEADER_STYLE_LABELS[h] }))}
                onChange={(v) => set("headerStyle", v)}
                testId="token-header-style"
              />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium">Corner rounding</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">{tokens.radius}px</span>
                </div>
                <Slider value={[tokens.radius]} min={0} max={20} step={1} onValueChange={([v]) => set("radius", v)} aria-label="Corner rounding" />
              </div>
              <Segmented
                label="Spacing"
                value={tokens.density}
                options={DENSITIES.map((d) => ({ value: d, label: DENSITY_LABELS[d] }))}
                onChange={(v) => set("density", v)}
              />
            </Group>

            {outline && (
              <Group title="House structure">
                <p className="text-[11px] text-muted-foreground">
                  CIMs generated with this template follow these sections{outline.sourceName ? ` (from ${outline.sourceName})` : ""}. Remove any you don't want.
                </p>
                <ol className="space-y-1">
                  {outline.sections.map((s, i) => (
                    <li key={`${s.title}-${i}`} className="group flex items-start gap-2 rounded-md border border-border px-2 py-1.5">
                      <span className="text-[10px] text-muted-foreground tabular-nums w-4 pt-0.5">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-medium">{s.title}</span>
                        {s.notes && <span className="block text-[10px] text-muted-foreground leading-snug">{s.notes}</span>}
                      </span>
                      <button
                        type="button"
                        className="opacity-60 hover:opacity-100 p-0.5"
                        onClick={() => setOutline({ ...outline, sections: outline.sections.filter((_, j) => j !== i) })}
                        aria-label={`Remove ${s.title}`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ol>
                <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground" onClick={() => setOutline(null)}>
                  <ListOrdered className="h-3.5 w-3.5 mr-1" /> Stop following a structure
                </Button>
              </Group>
            )}
          </div>

          {/* Preview */}
          <div className="min-h-0 overflow-y-auto scrollbar-thin bg-muted/30 p-4 sm:p-6" data-testid="template-editor-preview">
            {design && (
              <Scaled baseWidth={820}>
                <CimPreview design={design} />
              </Scaled>
            )}
          </div>
        </div>
        <div className="shrink-0 border-t border-border px-5 py-3 flex items-center justify-end gap-2">
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || !name.trim()} className="bg-teal text-teal-foreground hover:bg-teal/90 gap-1.5" data-testid="button-save-template">
            {save.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save template
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      {children}
    </div>
  );
}
