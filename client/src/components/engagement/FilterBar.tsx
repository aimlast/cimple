/**
 * The Engagement tab's filters, kept in the URL by the shell:
 *
 *   Buyers   All / Interested / Still deciding / a buyer type / one buyer
 *   When     All time / Last 7 days / Last 30 days
 *   Device   Any device / Computer / Phone
 *   Version  "Which CIM version": only when buyers were served more than one
 *
 * ≥ md: four compact dropdown buttons (brass when set) and "Clear".
 * < md: one "Filters" button that opens a bottom sheet (changes apply when it
 * closes); the active filters show as removable chips (FilterChips).
 * Each view declares which filters it uses (`show`). Plain words, no jargon.
 */
import { forwardRef, useMemo, useState } from "react";
import { Check, ChevronDown, Monitor, Search, SlidersHorizontal, Smartphone, Users, X } from "lucide-react";
import {
  DEFAULT_ENGAGEMENT_FILTERS,
  type EngagementDevice,
  type EngagementFilters,
  type EngagementRange,
  type RenditionSummary,
} from "@shared/analytics-v2";
import { rangeLabel } from "@shared/analytics-dashboard";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useEngagementBuyers } from "@/hooks/useEngagement";
import { cn } from "@/lib/utils";
import type { EngagementFilterKey } from "./extra-views";

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

/** A small segmented control (used by the heat map's own controls). */
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

export const ALL_FILTERS: EngagementFilterKey[] = ["buyers", "when", "device", "version"];
const DEVICE_WORDS: Record<EngagementDevice, string> = { all: "Any device", desktop: "Computer", phone: "Phone" };
const RANGES: EngagementRange[] = ["all", "7d", "30d"];

interface Person { id: string; name: string; company: string | null; type: string | null }

/** Every buyer on the deal (unfiltered), for the names and types in the Buyers menu. */
function usePeople(dealId: string) {
  const { data } = useEngagementBuyers(dealId, {});
  return useMemo(() => {
    const opened: Person[] = (data?.buyers ?? []).map((b) => ({ id: b.accessId, name: b.name, company: b.company, type: b.buyerType }));
    const unopened: Person[] = (data?.notOpened ?? []).map((b) => ({ id: b.accessId, name: b.name, company: b.company, type: null }));
    const people = [...opened, ...unopened];
    const types = Array.from(new Set(people.map((p) => p.type).filter((t): t is string => !!t))).sort();
    return { people, types };
  }, [data]);
}

/** The Buyers filter in words ("All buyers", "Interested buyers", a name, "3 buyers"). */
export function buyersLabel(f: EngagementFilters, people: Person[]): string {
  if (f.buyers.length === 1) return people.find((p) => p.id === f.buyers[0])?.name ?? "One buyer";
  if (f.buyers.length > 1) return `${f.buyers.length} buyers`;
  if (f.segment === "interested") return "Interested buyers";
  if (f.segment === "undecided") return "Buyers still deciding";
  if (f.segment.startsWith("type:")) return buyerTypeWords(f.segment.slice(5));
  return "All buyers";
}

const buyersSet = (f: EngagementFilters) => f.buyers.length > 0 || f.segment !== "all";

/** How many of the shown filters are set (the phone button's count). */
export function activeFilterCount(f: EngagementFilters, show: EngagementFilterKey[] = ALL_FILTERS): number {
  return (show.includes("buyers") && buyersSet(f) ? 1 : 0)
    + (show.includes("when") && f.range !== "all" ? 1 : 0)
    + (show.includes("device") && f.device !== "all" ? 1 : 0)
    + (show.includes("version") && !!f.rendition ? 1 : 0);
}

/** The filters with only the shown ones kept (a view's hidden filters never apply). */
export function onlyShown(f: EngagementFilters, show: EngagementFilterKey[]): EngagementFilters {
  return {
    range: show.includes("when") ? f.range : "all",
    device: show.includes("device") ? f.device : "all",
    buyers: show.includes("buyers") ? f.buyers : [],
    segment: show.includes("buyers") ? f.segment : "all",
    rendition: show.includes("version") ? f.rendition : null,
  };
}

export function FilterBar({
  dealId, filters, onChange, renditions, show = ALL_FILTERS,
}: {
  dealId: string;
  filters: EngagementFilters;
  onChange(next: EngagementFilters): void;
  renditions: RenditionSummary[];
  show?: EngagementFilterKey[];
}) {
  const { people, types } = usePeople(dealId);
  const [sheet, setSheet] = useState(false);
  if (show.length === 0) return null;
  const hasVersions = renditions.length > 1;
  const n = activeFilterCount(filters, show);
  const setBuyers = (patch: Partial<EngagementFilters>) => onChange({ ...filters, buyers: [], segment: "all", ...patch });
  const current = renditions.find((r) => r.id === filters.rendition) ?? null;

  return (
    <>
      {/* ≥ md: compact dropdowns */}
      <div className="hidden flex-wrap items-center gap-1.5 md:flex" data-testid="engagement-filters">
        {show.includes("buyers") && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterButton on={buyersSet(filters)} testId="filter-buyers" icon={<Users className="h-3.5 w-3.5 shrink-0" />}>
                {buyersLabel(filters, people)}
              </FilterButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-[60vh] w-64 overflow-y-auto">
              <MenuPick on={!buyersSet(filters)} onSelect={() => setBuyers({})}>All buyers</MenuPick>
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
        )}
        {show.includes("when") && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterButton on={filters.range !== "all"} testId="filter-when">{rangeLabel(filters.range)}</FilterButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {RANGES.map((r) => <MenuPick key={r} on={filters.range === r} onSelect={() => onChange({ ...filters, range: r })}>{rangeLabel(r)}</MenuPick>)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {show.includes("device") && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterButton
                on={filters.device !== "all"}
                testId="filter-device"
                icon={filters.device === "phone" ? <Smartphone className="h-3.5 w-3.5 shrink-0" /> : filters.device === "desktop" ? <Monitor className="h-3.5 w-3.5 shrink-0" /> : null}
              >
                {DEVICE_WORDS[filters.device]}
              </FilterButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              {(["all", "desktop", "phone"] as const).map((d) => <MenuPick key={d} on={filters.device === d} onSelect={() => onChange({ ...filters, device: d })}>{DEVICE_WORDS[d]}</MenuPick>)}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {show.includes("version") && hasVersions && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <FilterButton on={!!current} testId="filter-version">{current ? current.label : "Which CIM version"}</FilterButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-muted-foreground">Which CIM version</DropdownMenuLabel>
              <MenuPick on={!filters.rendition} onSelect={() => onChange({ ...filters, rendition: null })}>The latest version they read</MenuPick>
              {renditions.map((r) => (
                <MenuPick key={r.id} on={filters.rendition === r.id} onSelect={() => onChange({ ...filters, rendition: r.id })}>
                  <span className="truncate">{r.label}</span>
                  <span className="ml-auto pl-2 text-[10px] text-muted-foreground">{r.visitCount} visit{r.visitCount === 1 ? "" : "s"}</span>
                </MenuPick>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {n > 0 && (
          <button
            type="button"
            onClick={() => onChange({ ...DEFAULT_ENGAGEMENT_FILTERS })}
            className="inline-flex items-center gap-1 px-1 text-xs text-muted-foreground hover:text-foreground"
            data-testid="filter-clear"
          >
            <X className="h-3 w-3" /> Clear
          </button>
        )}
      </div>

      {/* < md: one button and a sheet */}
      <Button
        size="sm"
        variant="outline"
        className={cn("h-8 gap-1.5 text-xs md:hidden", n > 0 && "border-teal/40 bg-teal/10 text-teal")}
        onClick={() => setSheet(true)}
        data-testid="filters-open"
      >
        <SlidersHorizontal className="h-3.5 w-3.5" /> Filters{n > 0 ? ` ${n}` : ""}
      </Button>
      {sheet && (
        <FilterSheet
          open={sheet}
          onClose={(next) => { setSheet(false); if (next) onChange(next); }}
          filters={filters}
          people={people}
          types={types}
          renditions={hasVersions ? renditions : []}
          show={show}
        />
      )}
    </>
  );
}

type FilterButtonProps = { on: boolean; testId: string; icon?: React.ReactNode; children: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>;
const FilterButton = forwardRef<HTMLButtonElement, FilterButtonProps>(({ on, testId, icon, children, className, ...rest }, ref) => (
  <button
    ref={ref}
    type="button"
    {...rest}
    className={cn(
      "inline-flex max-w-[15rem] items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
      on ? "border-teal/40 bg-teal/10 text-teal" : "border-border text-foreground/80 hover:text-foreground",
      className,
    )}
    data-testid={testId}
  >
    {icon}
    <span className="truncate">{children}</span>
    <ChevronDown className="h-3 w-3 shrink-0 opacity-60" />
  </button>
));
FilterButton.displayName = "FilterButton";

/** The phone's active filters, as removable chips (under the view bar). */
export function FilterChips({ dealId, filters, onChange, renditions, show = ALL_FILTERS }: {
  dealId: string;
  filters: EngagementFilters;
  onChange(next: EngagementFilters): void;
  renditions: RenditionSummary[];
  show?: EngagementFilterKey[];
}) {
  const { people } = usePeople(dealId);
  if (activeFilterCount(filters, show) === 0) return null;
  const chip = (label: string, patch: Partial<EngagementFilters>, testId: string) => (
    <span key={testId} className="inline-flex max-w-full items-center gap-1 rounded-full border border-teal/40 bg-teal/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-teal" data-testid={testId}>
      <span className="truncate">{label}</span>
      <button type="button" aria-label={`Remove ${label}`} onClick={() => onChange({ ...filters, ...patch })} className="rounded-full p-0.5 hover:bg-teal/20">
        <X className="h-3 w-3" />
      </button>
    </span>
  );
  const current = renditions.find((r) => r.id === filters.rendition);
  return (
    <div className="flex flex-wrap gap-1.5 md:hidden" data-testid="filter-chips">
      {show.includes("buyers") && buyersSet(filters) && chip(buyersLabel(filters, people), { buyers: [], segment: "all" }, "chip-buyers")}
      {show.includes("when") && filters.range !== "all" && chip(rangeLabel(filters.range), { range: "all" }, "chip-when")}
      {show.includes("device") && filters.device !== "all" && chip(DEVICE_WORDS[filters.device], { device: "all" }, "chip-device")}
      {show.includes("version") && current && chip(current.label, { rendition: null }, "chip-version")}
    </div>
  );
}

function FilterSheet({ open, onClose, filters, people, types, renditions, show }: {
  open: boolean;
  onClose(next: EngagementFilters | null): void;
  filters: EngagementFilters;
  people: Person[];
  types: string[];
  renditions: RenditionSummary[];
  show: EngagementFilterKey[];
}) {
  const [draft, setDraft] = useState<EngagementFilters>(filters);
  const [pickOne, setPickOne] = useState(filters.buyers.length === 1);
  const [q, setQ] = useState("");
  const set = (patch: Partial<EngagementFilters>) => setDraft((d) => ({ ...d, ...patch }));
  const buyersValue = draft.buyers.length === 1 || pickOne ? "one" : draft.segment;
  const buyerOptions: Array<{ value: string; label: string }> = [
    { value: "all", label: "All buyers" },
    { value: "interested", label: "Interested buyers" },
    { value: "undecided", label: "Buyers still deciding" },
    ...types.map((t) => ({ value: `type:${t}`, label: buyerTypeWords(t) })),
    ...(people.length > 0 ? [{ value: "one", label: "One buyer…" }] : []),
  ];
  const matches = people.filter((p) => `${p.name} ${p.company ?? ""}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Sheet open={open} onOpenChange={(o) => { if (!o) onClose(draft); }}>
      <SheetContent side="bottom" className="max-h-[88vh] overflow-y-auto rounded-t-xl px-4 pb-6 pt-5" data-testid="filters-sheet">
        <SheetHeader className="mb-3 text-left"><SheetTitle className="text-base">Filters</SheetTitle></SheetHeader>
        <div className="space-y-4">
          {show.includes("buyers") && (
            <SheetGroup title="Buyers">
              {buyerOptions.map((o) => (
                <SheetRadio
                  key={o.value}
                  on={buyersValue === o.value}
                  onClick={() => {
                    if (o.value === "one") { setPickOne(true); return; }
                    setPickOne(false);
                    set({ buyers: [], segment: o.value as EngagementFilters["segment"] });
                  }}
                >
                  {o.label}
                </SheetRadio>
              ))}
              {buyersValue === "one" && (
                <div className="space-y-1 border-t border-border/70 p-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a buyer" className="h-9 pl-8 text-sm" />
                  </div>
                  <ul className="max-h-48 overflow-y-auto">
                    {matches.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => set({ buyers: [p.id], segment: "all" })}
                          className={cn("flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm", draft.buyers[0] === p.id ? "bg-teal/10 text-teal" : "hover:bg-muted/30")}
                        >
                          <Check className={cn("h-3.5 w-3.5 shrink-0", draft.buyers[0] === p.id ? "opacity-100" : "opacity-0")} />
                          <span className="truncate">{p.name}</span>
                          {p.company && <span className="truncate text-xs text-muted-foreground">{p.company}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </SheetGroup>
          )}
          {show.includes("when") && (
            <SheetGroup title="When">
              {RANGES.map((r) => <SheetRadio key={r} on={draft.range === r} onClick={() => set({ range: r })}>{rangeLabel(r)}</SheetRadio>)}
            </SheetGroup>
          )}
          {show.includes("device") && (
            <SheetGroup title="Device">
              {(["all", "desktop", "phone"] as const).map((d) => <SheetRadio key={d} on={draft.device === d} onClick={() => set({ device: d })}>{DEVICE_WORDS[d]}</SheetRadio>)}
            </SheetGroup>
          )}
          {show.includes("version") && renditions.length > 1 && (
            <SheetGroup title="Which CIM version">
              <SheetRadio on={!draft.rendition} onClick={() => set({ rendition: null })}>The latest version they read</SheetRadio>
              {renditions.map((r) => <SheetRadio key={r.id} on={draft.rendition === r.id} onClick={() => set({ rendition: r.id })}>{r.label}</SheetRadio>)}
            </SheetGroup>
          )}
        </div>
        <div className="sticky -bottom-6 -mx-4 mt-5 flex gap-2 border-t border-border bg-background px-4 pb-6 pt-3">
          <Button variant="outline" className="flex-1" onClick={() => { setDraft({ ...DEFAULT_ENGAGEMENT_FILTERS }); setPickOne(false); }}>Clear</Button>
          <Button className="flex-1" onClick={() => onClose(draft)} data-testid="filters-apply">Show results</Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function SheetGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <fieldset>
      <legend className="mb-1 font-mono text-2xs uppercase tracking-[0.14em] text-muted-foreground">{title}</legend>
      <div role="radiogroup" aria-label={title} className="overflow-hidden rounded-lg border border-border">{children}</div>
    </fieldset>
  );
}

function SheetRadio({ on, onClick, children }: { on: boolean; onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={on}
      onClick={onClick}
      className={cn("flex w-full items-center gap-3 border-b border-border/70 px-3 py-2.5 text-left text-sm last:border-0", on ? "bg-teal/10 text-teal" : "text-foreground hover:bg-muted/30")}
    >
      <span className={cn("h-3.5 w-3.5 shrink-0 rounded-full border", on ? "border-teal bg-teal shadow-[inset_0_0_0_2px_hsl(var(--background))]" : "border-muted-foreground/50")} />
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
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
