/**
 * LevelRadio — "What should they get?" as radio cards (the grant dialog, the
 * teaser request's Give access / Ask the seller first, Give the CIM…). Labels
 * and lines come from the access-level registry (shared/access-levels.ts);
 * a level that can't be given right now is disabled with the reason.
 */
import { ACCESS_LEVELS, DD_ACCESS_LEVEL, type AccessLevel } from "@shared/access-levels";
import { DD_NAMES_PENDING_GRANT } from "@shared/figure-copy";
import { useBuilderState } from "@/components/cim-builder/CimSummaryCard";
import { cn } from "@/lib/utils";

export interface LevelOption {
  level: AccessLevel;
  /** The one-line terms ("Whole CIM, anonymous · NDA first · 30 days"). */
  line: string;
  disabled?: string | null;
  /** A link beside the disabled reason ("Go to the teaser"). */
  action?: { label: string; onClick: () => void } | null;
}

export function LevelRadio({
  options, value, onChange, columns = 2, name, dealId,
}: {
  options: LevelOption[];
  value: AccessLevel | null;
  onChange: (l: AccessLevel) => void;
  columns?: 1 | 2 | 3;
  name: string;
  /** The deal: Due diligence says in words when its names aren't revealed yet (release fix F9). */
  dealId?: string;
}) {
  const builder = useBuilderState(dealId ?? "");
  const ddNote = dealId && builder.data && builder.data.sections.length > 0 && !builder.data.dd?.generated ? DD_NAMES_PENDING_GRANT : null;
  return (
    <div
      role="radiogroup"
      aria-label={name}
      className={cn("grid gap-2", columns === 3 ? "grid-cols-1 sm:grid-cols-3" : columns === 2 ? "grid-cols-1 sm:grid-cols-2" : "grid-cols-1")}
      data-testid={`level-radio-${name.replace(/\W+/g, "-").toLowerCase()}`}
    >
      {options.map((o) => {
        const def = ACCESS_LEVELS.find((l) => l.key === o.level)!;
        const on = value === o.level;
        const off = !!o.disabled;
        return (
          <div
            key={o.level}
            role="radio"
            aria-checked={on}
            aria-disabled={off}
            tabIndex={off ? -1 : 0}
            onClick={() => !off && onChange(o.level)}
            onKeyDown={(e) => { if (!off && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onChange(o.level); } }}
            className={cn(
              "rounded-lg border px-3 py-2.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-teal/60",
              off ? "cursor-not-allowed border-border opacity-60" : "cursor-pointer",
              on ? "border-teal bg-teal/10" : !off && "border-border hover:border-teal/40",
            )}
            data-testid={`level-option-${o.level}`}
          >
            <span className="flex items-center gap-2">
              <span className={cn("flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border", on ? "border-teal" : "border-muted-foreground/50")}>
                {on && <span className="h-1.5 w-1.5 rounded-full bg-teal" />}
              </span>
              <span className="text-sm font-medium">{def.label}</span>
            </span>
            <span className="mt-0.5 block pl-5 text-xs text-muted-foreground">{o.disabled ?? o.line}</span>
            {!off && o.level === DD_ACCESS_LEVEL && ddNote && (
              <span className="mt-0.5 block pl-5 text-xs text-amber-500" data-testid="level-dd-names-pending">{ddNote}</span>
            )}
            {off && o.action && (
              <button type="button" className="mt-0.5 block pl-5 text-xs text-teal hover:underline" onClick={(e) => { e.stopPropagation(); o.action!.onClick(); }}>
                {o.action.label}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The terms line for each level in the grant dialog. */
export const LEVEL_TERMS: Record<AccessLevel, string> = {
  teaser_only: "Short anonymous summary · no NDA · lasts until you take the teaser offline",
  blind: "Whole CIM, anonymous · NDA first · 30 days",
  named: "Whole CIM with the name · NDA first · 30 days",
  due_diligence: "Full CIM + due-diligence detail · NDA first · 30 days",
};
