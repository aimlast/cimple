/**
 * TeaserTemplatePicker — where a teaser starts: "Your templates" (the
 * broker's saved house styles) first, then the four built-in starting
 * points, each with a live thumbnail of its shape and length. Wide screens:
 * one row of cards; phones: a horizontal strip that snaps.
 */
import { useMemo } from "react";
import { Check, Star } from "lucide-react";
import { TEASER_TEMPLATES, TEASER_TEMPLATE_KEYS_ORDER } from "./template-order";
import { buildCimDesign } from "@/components/cim/CimDesignContext";
import { cn } from "@/lib/utils";
import type { SavedTemplateItem } from "./api";
import { sampleFor } from "./samples";
import { TeaserPages } from "./TeaserPages";

function Thumb({ templateKey, pages }: { templateKey: string; pages: number }) {
  const sample = useMemo(() => sampleFor(templateKey), [templateKey]);
  const design = useMemo(() => buildCimDesign(null, "blind"), []);
  const scale = 0.2;
  return (
    <div className="relative mx-auto" style={{ width: 816 * scale + (pages > 1 ? 8 : 0), height: 1056 * scale + (pages > 1 ? 8 : 0) }} aria-hidden>
      {pages > 1 && (
        <div className="absolute rounded-[3px] border" style={{ left: 8, top: 8, width: 816 * scale, height: 1056 * scale, background: "#F4EFE4", borderColor: "#E3DED0" }} />
      )}
      <div className="absolute left-0 top-0 overflow-hidden rounded-[3px]" style={{ width: 816 * scale, height: 1056 * scale }}>
        <TeaserPages header={sample.header} sections={sample.sections} pageSize="letter" design={design} mode="thumb" thumbScale={scale} firstPageOnly />
      </div>
    </div>
  );
}

export function TeaserTemplatePicker({
  value, onChange, saved, defaultKey,
}: {
  value: string;
  onChange: (key: string) => void;
  saved: SavedTemplateItem[];
  defaultKey: string | null;
}) {
  return (
    <div className="space-y-4" data-testid="teaser-template-picker">
      {saved.length > 0 && (
        <div className="space-y-2">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Your templates</p>
          <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">
            {saved.map((t) => {
              const on = value === t.key;
              const base = t.basedOn && TEASER_TEMPLATES[t.basedOn as keyof typeof TEASER_TEMPLATES];
              return (
                <button
                  key={t.key}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange(t.key)}
                  className={cn(
                    "w-[78%] shrink-0 snap-start rounded-lg border p-3 text-left transition-colors sm:w-auto",
                    on ? "border-teal bg-teal/10" : "border-border bg-card hover:border-teal/40",
                  )}
                  data-testid={`teaser-template-${t.key}`}
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {t.name}
                    {defaultKey === t.key && <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-px text-[10px] font-normal text-muted-foreground"><Star className="h-2.5 w-2.5" /> Default</span>}
                    {on && <Check className="ml-auto h-3.5 w-3.5 text-teal" />}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {base ? `Based on the ${base.name}` : "Your own layout"} · {t.blocks} block{t.blocks === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      <div className="space-y-2">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Start from</p>
        <div className="-mx-4 flex snap-x snap-mandatory scroll-px-4 gap-3 overflow-x-auto px-4 pb-2 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 xl:grid-cols-4" role="radiogroup" aria-label="Teaser templates">
          {TEASER_TEMPLATE_KEYS_ORDER.map((key) => {
            const t = TEASER_TEMPLATES[key];
            const on = value === key;
            return (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => onChange(key)}
                className={cn(
                  "flex w-[72%] shrink-0 snap-start flex-col gap-2.5 rounded-xl border p-3 text-left transition-colors sm:w-auto",
                  on ? "border-teal bg-teal/10 ring-1 ring-teal/40" : "border-border bg-card hover:border-teal/40",
                )}
                data-testid={`teaser-template-${key}`}
              >
                <span className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{t.name}</span>
                  {defaultKey === key && <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-px text-[10px] text-muted-foreground"><Star className="h-2.5 w-2.5" /> Default</span>}
                  <span className={cn("ml-auto flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", on ? "border-teal bg-teal text-teal-foreground" : "border-muted-foreground/40")}>
                    {on && <Check className="h-2.5 w-2.5" />}
                  </span>
                </span>
                <span className="rounded-md bg-muted/30 py-2.5"><Thumb templateKey={key} pages={t.targetPages} /></span>
                <span className="text-xs leading-snug text-muted-foreground">{t.description}</span>
                <span className="text-[11px] font-medium text-foreground/80">{t.lengthLabel}</span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
