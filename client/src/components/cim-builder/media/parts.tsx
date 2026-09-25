/** Small shared pieces of the media editors. */
import type { ReactNode } from "react";
import { ArrowDown, ArrowUp, X } from "lucide-react";
import { cn } from "@/lib/utils";

export function FieldLabel({ children }: { children: ReactNode }) {
  return <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{children}</p>;
}

export function Segmented<T extends string>({
  value, options, onChange, disabled,
}: { value: T; options: Array<{ key: T; label: string }>; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="grid gap-1 rounded-md border border-border p-0.5 bg-muted/30" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          disabled={disabled}
          aria-pressed={value === o.key}
          onClick={() => value !== o.key && onChange(o.key)}
          className={cn(
            "rounded px-2 py-1 text-[11px] transition-colors",
            value === o.key ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Move up / move down / remove, for one row of a list. */
export function RowActions({
  index, count, onMove, onRemove, disabled, noun,
}: { index: number; count: number; onMove: (from: number, to: number) => void; onRemove: () => void; disabled?: boolean; noun: string }) {
  const btn = "flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-30 disabled:hover:bg-transparent";
  return (
    <div className="flex items-center gap-0.5 shrink-0">
      <button type="button" className={btn} disabled={disabled || index === 0} onClick={() => onMove(index, index - 1)} aria-label={`Move ${noun} up`}>
        <ArrowUp className="h-3 w-3" />
      </button>
      <button type="button" className={btn} disabled={disabled || index === count - 1} onClick={() => onMove(index, index + 1)} aria-label={`Move ${noun} down`}>
        <ArrowDown className="h-3 w-3" />
      </button>
      <button type="button" className={cn(btn, "hover:text-red-500")} disabled={disabled} onClick={onRemove} aria-label={`Remove ${noun}`}>
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  const [it] = next.splice(from, 1);
  next.splice(to, 0, it);
  return next;
}
