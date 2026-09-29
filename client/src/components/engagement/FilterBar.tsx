/**
 * The Engagement tab's filter bar — one set of filters for both views
 * (Buyers and Document), kept in the URL by the tab:
 *
 *   Buyers   All / Interested / Undecided / a buyer type / one buyer
 *   Dates    All time / Last 7 days / Last 30 days
 *   Device   All / Desktop / Phone
 *   Version  only when buyers were served more than one version of the CIM
 *            ("Blind · published 12 Sep")
 *
 * Plain words, no jargon. On a phone the chips wrap under each other.
 */
import { useMemo } from "react";
import { Check, ChevronDown, Monitor, Smartphone, Users, X } from "lucide-react";
import {
  DEFAULT_ENGAGEMENT_FILTERS,
  type EngagementDevice,
  type EngagementFilters,
  type EngagementRange,
  type RenditionSummary,
} from "@shared/analytics-v2";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useEngagementBuyers } from "@/hooks/useEngagement";
import { cn } from "@/lib/utils";

const BUYER_TYPE_WORDS: Record<string, string> = {
  individual: "Individual buyers",
  strategic: "Strategic buyers",
  financial: "Financial buyers",
  private_equity: "Private equity",
  search_fund: "Search funds",
  family_office: "Family offices",
};
export function buyerTypeWords(t: string): string {
  return BUYER_TYPE_WORDS[t] ?? `${t.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())} buyers`;
}

/** A small segmented control (the same look as the Buyers | Document switch). */
export function Segmented<T extends string>({
  value, options, onChange, label, size = "sm",
}: {
  value: T;
  options: Array<{ value: T; label: string; icon?: React.ReactNode }>;
  onChange(v: T): void;
  label: string;
  size?: "sm" | "xs";
}) {
  return (
    <div className="inline-flex shrink-0 rounded-md border border-border bg-background/40 p-0.5" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            "inline-flex items-center gap-1 rounded-[5px] font-medium transition-colors whitespace-nowrap",
            size === "xs" ? "px-2 py-0.5 text-[11px]" : "px-2.5 py-1 text-xs",
            value === o.value ? "bg-teal/15 text-teal" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {o.icon}
          {o.label}
        </button>
      ))}
    </div>
  );
}

function isDefault(f: EngagementFilters): boolean {
  return f.range === "all" && f.device === "all" && f.buyers.length === 0 && f.segment === "all" && !f.rendition;
}

export function FilterBar({
  dealId, filters, onChange, renditions,
}: {
  dealId: string;
  filters: EngagementFilters;
  onChange(next: EngagementFilters): void;
  renditions: RenditionSummary[];
}) {
  // Every buyer on the deal (unfiltered), for the names and types in the menu.
  const { data } = useEngagementBuyers(dealId, {});
  const people = useMemo(() => {
    const opened = (data?.buyers ?? []).map((b) => ({ id: b.accessId, name: b.name, company: b.company, type: b.buyerType }));
    const unopened = (data?.notOpened ?? []).map((b) => ({ id: b.accessId, name: b.name, company: b.company, type: null as string | null }));
    return [...opened, ...unopened];
  }, [data]);
  const types = useMemo(() => Array.from(new Set(people.map((p) => p.type).filter((t): t is string => !!t))).sort(), [people]);

  const one = filters.buyers.length === 1 ? people.find((p) => p.id === filters.buyers[0]) : null;
  const buyersLabel = filters.buyers.length === 1
    ? one?.name ?? "One buyer"
    : filters.buyers.length > 1
      ? `${filters.buyers.length} buyers`
      : filters.segment === "interested"
        ? "Interested buyers"
        : filters.segment === "undecided"
          ? "Buyers still deciding"
          : filters.segment.startsWith("type:")
            ? buyerTypeWords(filters.segment.slice(5))
            : "All buyers";

  const setBuyers = (patch: Partial<EngagementFilters>) => onChange({ ...filters, buyers: [], segment: "all", ...patch });
  const current = renditions.find((r) => r.id === filters.rendition) ?? null;

  return (
    <div
      className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0 sm:pb-0"
      data-testid="engagement-filters"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              "inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
              filters.buyers.length || filters.segment !== "all"
                ? "border-teal/40 bg-teal/10 text-teal"
                : "border-border text-foreground/80 hover:text-foreground",
            )}
            data-testid="filter-buyers"
          >
            <Users className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{buyersLabel}</span>
            <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64 max-h-[60vh] overflow-y-auto">
          <MenuPick on={filters.buyers.length === 0 && filters.segment === "all"} onSelect={() => setBuyers({})}>All buyers</MenuPick>
          <MenuPick on={filters.buyers.length === 0 && filters.segment === "interested"} onSelect={() => setBuyers({ segment: "interested" })}>Interested buyers</MenuPick>
          <MenuPick on={filters.buyers.length === 0 && filters.segment === "undecided"} onSelect={() => setBuyers({ segment: "undecided" })}>Buyers still deciding</MenuPick>
          {types.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">By type</DropdownMenuLabel>
              {types.map((t) => (
                <MenuPick key={t} on={filters.buyers.length === 0 && filters.segment === `type:${t}`} onSelect={() => setBuyers({ segment: `type:${t}` })}>
                  {buyerTypeWords(t)}
                </MenuPick>
              ))}
            </>
          )}
          {people.length > 0 && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">One buyer</DropdownMenuLabel>
              {people.map((p) => (
                <MenuPick key={p.id} on={filters.buyers.length === 1 && filters.buyers[0] === p.id} onSelect={() => setBuyers({ buyers: [p.id] })}>
                  <span className="truncate">{p.name}</span>
                  {p.company && <span className="ml-1 truncate text-muted-foreground">· {p.company}</span>}
                </MenuPick>
              ))}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Segmented<EngagementRange>
        label="Dates"
        value={filters.range}
        onChange={(range) => onChange({ ...filters, range })}
        options={[{ value: "all", label: "All time" }, { value: "7d", label: "7 days" }, { value: "30d", label: "30 days" }]}
      />
      <Segmented<EngagementDevice>
        label="Device"
        value={filters.device}
        onChange={(device) => onChange({ ...filters, device })}
        options={[
          { value: "all", label: "Any device" },
          { value: "desktop", label: "Computer", icon: <Monitor className="h-3 w-3" /> },
          { value: "phone", label: "Phone", icon: <Smartphone className="h-3 w-3" /> },
        ]}
      />
      {renditions.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(
                "inline-flex max-w-[16rem] items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium",
                current ? "border-teal/40 bg-teal/10 text-teal" : "border-border text-foreground/80 hover:text-foreground",
              )}
              data-testid="filter-version"
            >
              <span className="truncate">{current ? current.label : "Latest version read"}</span>
              <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Version buyers saw</DropdownMenuLabel>
            <MenuPick on={!filters.rendition} onSelect={() => onChange({ ...filters, rendition: null })}>Latest version read</MenuPick>
            {renditions.map((r) => (
              <MenuPick key={r.id} on={filters.rendition === r.id} onSelect={() => onChange({ ...filters, rendition: r.id })}>
                <span className="truncate">{r.label}</span>
                <span className="ml-auto pl-2 text-[10px] text-muted-foreground">{r.visitCount} visit{r.visitCount === 1 ? "" : "s"}</span>
              </MenuPick>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {!isDefault(filters) && (
        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_ENGAGEMENT_FILTERS })}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          data-testid="filter-clear"
        >
          <X className="h-3 w-3" /> Clear filters
        </button>
      )}
    </div>
  );
}

function MenuPick({ on, onSelect, children }: { on: boolean; onSelect(): void; children: React.ReactNode }) {
  return (
    <DropdownMenuItem onSelect={onSelect} className="gap-2 text-xs">
      <Check className={cn("h-3.5 w-3.5 shrink-0", on ? "text-teal" : "opacity-0")} />
      <span className="flex min-w-0 flex-1 items-center">{children}</span>
    </DropdownMenuItem>
  );
}
