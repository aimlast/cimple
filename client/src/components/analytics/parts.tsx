/** Small shared pieces of the analytics dashboards: deal chips, the tab description line. */
import type { ReactNode } from "react";
import { linkRanOutWords, whenWords } from "@shared/analytics-dashboard";
import { cn } from "@/lib/utils";
import { InfoDot } from "./Explain";

export const EXAMPLE_TIP = "Example deals are the made-up showcase deals. Their numbers are in these totals and marked 'Example' wherever they appear.";
export const NOT_LIVE_TIP = "Buyers can't open it right now";

export function Chip({ children, tone = "muted", title, className, testId }: { children: ReactNode; tone?: "muted" | "live" | "example" | "brass" | "warning"; title?: string; className?: string; testId?: string }) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-1.5 py-px text-[10px] font-medium leading-4",
        tone === "live" && "border-success/30 bg-success/10 text-success",
        tone === "muted" && "border-border bg-muted/40 text-muted-foreground",
        tone === "example" && "border-dashed border-border text-muted-foreground",
        tone === "brass" && "border-teal/40 bg-teal/10 text-teal",
        tone === "warning" && "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
        className,
      )}
      data-testid={testId}
    >
      {tone === "live" && <span className="h-1.5 w-1.5 rounded-full bg-success" />}
      {children}
    </span>
  );
}

/** "Live" / "Not live" and "Example" for one deal. `showLive` adds the green Live chip (the Deals table); elsewhere only Not live shows. */
export function DealChips({ live, demo, showLive = false }: { live: boolean; demo: boolean; showLive?: boolean }) {
  return (
    <>
      {live ? showLive && <Chip tone="live" testId="chip-live">Live</Chip> : <Chip title={NOT_LIVE_TIP} testId="chip-not-live">Not live</Chip>}
      {demo && <Chip tone="example" title={EXAMPLE_TIP} testId="chip-example">Example</Chip>}
    </>
  );
}

/** "Link ran out" (a CIM link past its expiry; the tooltip says when and what to do). */
export function LinkRanOutChip({ at, testId = "chip-link-ran-out" }: { at: string; testId?: string }) {
  return <Chip tone="warning" title={linkRanOutWords(at)} testId={testId}>Link ran out</Chip>;
}

/** The one muted sentence under the tab bar that says what the tab shows. */
export function TabDescription({ children, info }: { children: ReactNode; info?: string }) {
  return (
    <p className="flex items-start gap-1.5 text-xs text-muted-foreground sm:text-sm" data-testid="tab-description">
      <span className="min-w-0">{children}</span>
      {info && <InfoDot text={info} className="mt-0.5" />}
    </p>
  );
}

/** A titled radio list for a phone filter sheet. */
export function OptionGroup<T extends string>({ title, value, options, onChange, testId }: {
  title: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; hint?: string }>;
  onChange(v: T): void;
  testId?: string;
}) {
  return (
    <fieldset className="space-y-1" data-testid={testId}>
      <legend className="mb-1 font-mono text-2xs uppercase tracking-[0.14em] text-muted-foreground">{title}</legend>
      <div role="radiogroup" aria-label={title} className="overflow-hidden rounded-lg border border-border">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex w-full items-center gap-3 border-b border-border/70 px-3 py-2.5 text-left text-sm last:border-0",
              value === o.value ? "bg-teal/10 text-teal" : "text-foreground hover:bg-muted/30",
            )}
          >
            <span className={cn("h-3.5 w-3.5 shrink-0 rounded-full border", value === o.value ? "border-teal bg-teal shadow-[inset_0_0_0_2px_hsl(var(--background))]" : "border-muted-foreground/50")} />
            <span className="min-w-0 flex-1 truncate">{o.label}</span>
            {o.hint && <span className="shrink-0 text-xs text-muted-foreground">{o.hint}</span>}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** A removable active-filter chip. */
export function FilterChip({ children, onRemove, testId }: { children: ReactNode; onRemove(): void; testId?: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full border border-teal/40 bg-teal/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-teal" data-testid={testId}>
      <span className="truncate">{children}</span>
      <button type="button" onClick={onRemove} aria-label="Remove this filter" className="rounded-full p-0.5 hover:bg-teal/20">
        <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      </button>
    </span>
  );
}

/**
 * "just now", "3 h ago", "yesterday", "4 days ago", then "23 Sept": the
 * dashboards' one date style, on the broker's calendar (Toronto), the same
 * rule as the buyer cards' "why" lines (shared/analytics-dashboard.ts).
 */
export const whenText = whenWords;
