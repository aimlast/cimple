/**
 * Small form controls for CIM design: colour, font, segmented choice.
 */
import { useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { CIM_FONTS, contrastRatio, fontStack, normalizeHex } from "@shared/cim-theme";
import { loadCimFont } from "@/components/cim/CimDesignContext";

/** A colour: swatch picker + hex field. `against` shows a readability hint. */
export function ColorField({
  label,
  value,
  onChange,
  against,
  onClear,
  hint,
  testId,
}: {
  label: string;
  value: string | null;
  onChange: (hex: string) => void;
  /** Background it must read on (e.g. the paper) — warns when too light. */
  against?: string;
  onClear?: () => void;
  hint?: string;
  testId?: string;
}) {
  const [text, setText] = useState(value ?? "");
  useEffect(() => setText(value ?? ""), [value]);
  const hex = normalizeHex(value);
  const weak = hex && against ? contrastRatio(hex, against) < 3 : false;
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        {onClear && hex && (
          <button type="button" onClick={onClear} className="text-[10px] text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5">
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>
      <div className="flex items-center gap-2">
        <label
          className="relative h-9 w-11 shrink-0 cursor-pointer overflow-hidden rounded-md border border-border"
          style={{ background: hex ?? "repeating-linear-gradient(45deg, transparent 0 4px, hsl(var(--muted)) 4px 8px)" }}
          title="Pick a colour"
        >
          <input
            type="color"
            value={hex ?? "#888888"}
            onChange={(e) => onChange(e.target.value)}
            className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
            data-testid={testId ? `${testId}-picker` : undefined}
            aria-label={label}
          />
        </label>
        <Input
          value={text}
          placeholder="#1F3A68"
          onChange={(e) => {
            setText(e.target.value);
            const n = normalizeHex(e.target.value);
            if (n) onChange(n);
          }}
          className="h-9 font-mono text-xs uppercase"
          data-testid={testId}
        />
      </div>
      {weak ? (
        <p className="text-[11px] text-amber-500 flex items-start gap-1">
          <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" /> Light on the page — the CIM darkens it a little so text and charts stay readable.
        </p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Font picker; each option is shown in its own typeface. */
export function FontSelect({ value, onChange, label, testId }: { value: string; onChange: (v: string) => void; label: string; testId?: string }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    loadCimFont(value);
  }, [value]);
  useEffect(() => {
    if (open) CIM_FONTS.forEach((f) => loadCimFont(f.family));
  }, [open]);
  return (
    <div className="space-y-1.5">
      <span className="text-xs font-medium">{label}</span>
      <Select value={value} onValueChange={onChange} onOpenChange={setOpen}>
        <SelectTrigger className="h-9" data-testid={testId}>
          <SelectValue>
            <span style={{ fontFamily: fontStack(value) }}>{value}</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="max-h-72">
          {(["sans", "serif"] as const).map((cat) => (
            <SelectGroup key={cat}>
              <SelectLabel className="text-[10px] uppercase tracking-wider">{cat === "sans" ? "Sans-serif" : "Serif"}</SelectLabel>
              {CIM_FONTS.filter((f) => f.category === cat).map((f) => (
                <SelectItem key={f.family} value={f.family}>
                  <span style={{ fontFamily: fontStack(f.family) }}>{f.family}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** A row of mutually exclusive options. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
  testId,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  label?: string;
  testId?: string;
}) {
  return (
    <div className="space-y-1.5">
      {label && <span className="text-xs font-medium">{label}</span>}
      <div className="flex flex-wrap gap-1 rounded-md border border-border p-0.5 bg-muted/30" role="radiogroup" data-testid={testId}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex-1 min-w-[64px] rounded px-2 py-1.5 text-[11px] transition-colors",
              value === o.value ? "bg-background text-foreground shadow-sm font-medium" : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
