/**
 * Deal list toolbar: search, group, sort, filters, "Show archived" and the
 * card / table switch, plus the chips that show (and clear) active filters.
 */
import { Filter, LayoutGrid, List, Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEAL_PHASES } from "@shared/deal-progress";
import {
  GROUP_OPTIONS,
  SORT_OPTIONS,
  type DealListPrefs,
  type GroupBy,
  type SortBy,
} from "./deal-list-model";

interface Props {
  prefs: DealListPrefs;
  onChange: (patch: Partial<DealListPrefs>) => void;
  search: string;
  onSearch: (q: string) => void;
  /** Industries present in the broker's deals, with counts. */
  industries: { name: string; count: number }[];
  archivedCount: number;
}

const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

export function DealListToolbar({ prefs, onChange, search, onSearch, industries, archivedCount }: Props) {
  const filterCount = prefs.phases.length + prefs.industries.length + (prefs.liveOnly ? 1 : 0);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Search */}
      <div className="relative w-full sm:w-auto sm:flex-1 sm:max-w-xs">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/50 pointer-events-none" />
        <Input
          placeholder="Search name, industry, region, seller…"
          value={search}
          onChange={(e) => onSearch(e.target.value)}
          className="pl-8 pr-8 h-8 text-sm bg-muted/60 border-0 focus-visible:ring-1 focus-visible:ring-teal/40 placeholder:text-muted-foreground/50"
          data-testid="input-search"
        />
        {search && (
          <button
            type="button"
            onClick={() => onSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-muted-foreground/60 hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {/* Group */}
      <Select value={prefs.groupBy} onValueChange={(v) => onChange({ groupBy: v as GroupBy })}>
        <SelectTrigger className="h-8 w-auto gap-1.5 text-xs border-border/70 bg-transparent px-2.5" data-testid="select-group">
          <span className="text-muted-foreground">Group:</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GROUP_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.value === "none" ? "None" : o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Sort */}
      <Select value={prefs.sort} onValueChange={(v) => onChange({ sort: v as SortBy })}>
        <SelectTrigger className="h-8 w-auto gap-1.5 text-xs border-border/70 bg-transparent px-2.5" data-testid="select-sort">
          <span className="text-muted-foreground">Sort:</span>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SORT_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value} className="text-xs">
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {/* Filters */}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={`h-8 gap-1.5 text-xs font-normal px-2.5 ${filterCount > 0 ? "text-teal border-teal/40" : "border-border/70"}`}
            data-testid="button-filters"
          >
            <Filter className="h-3.5 w-3.5" />
            Filters
            {filterCount > 0 && (
              <span className="ml-0.5 rounded-full bg-teal/15 px-1.5 text-2xs tabular-nums">{filterCount}</span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-72 p-0">
          <div className="p-3 border-b border-border/60">
            <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Phase</p>
            <div className="space-y-1.5">
              {DEAL_PHASES.map((p) => (
                <label key={p.key} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Checkbox
                    checked={prefs.phases.includes(p.key)}
                    onCheckedChange={() => onChange({ phases: toggle(prefs.phases, p.key) })}
                  />
                  <span className="text-muted-foreground text-xs w-14">{p.short}</span>
                  {p.label}
                </label>
              ))}
            </div>
          </div>
          <div className="p-3 border-b border-border/60">
            <p className="text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground mb-2">Industry</p>
            {industries.length === 0 ? (
              <p className="text-xs text-muted-foreground">No industries yet.</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto scrollbar-thin pr-1">
                {industries.map((i) => (
                  <label key={i.name} className="flex items-center gap-2 text-sm cursor-pointer">
                    <Checkbox
                      checked={prefs.industries.includes(i.name)}
                      onCheckedChange={() => onChange({ industries: toggle(prefs.industries, i.name) })}
                    />
                    <span className="flex-1 truncate">{i.name}</span>
                    <span className="text-2xs text-muted-foreground tabular-nums">{i.count}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="p-3 flex items-center justify-between">
            <label htmlFor="filter-live-only" className="text-sm cursor-pointer">Live deals only</label>
            <Switch
              id="filter-live-only"
              checked={prefs.liveOnly}
              onCheckedChange={(v) => onChange({ liveOnly: v })}
            />
          </div>
          {filterCount > 0 && (
            <div className="px-3 pb-3">
              <Button
                variant="ghost"
                size="sm"
                className="h-7 w-full text-xs"
                onClick={() => onChange({ phases: [], industries: [], liveOnly: false })}
              >
                Clear filters
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      <div className="flex items-center gap-2 ml-auto">
        {/* Show archived */}
        <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer select-none" htmlFor="show-archived">
          <Switch
            id="show-archived"
            checked={prefs.showArchived}
            onCheckedChange={(v) => onChange({ showArchived: v })}
            data-testid="switch-show-archived"
          />
          <span><span className="hidden sm:inline">Show </span>archived{archivedCount > 0 ? ` (${archivedCount})` : ""}</span>
        </label>

        {/* View */}
        <div className="flex items-center rounded-md border border-border/70 p-0.5" role="group" aria-label="View">
          {([
            { value: "cards", icon: LayoutGrid, label: "Cards" },
            { value: "table", icon: List, label: "Table" },
          ] as const).map(({ value, icon: Icon, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => onChange({ view: value })}
              aria-pressed={prefs.view === value}
              title={`${label} view`}
              className={`h-6 w-7 flex items-center justify-center rounded-sm transition-colors ${
                prefs.view === value ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
              data-testid={`view-${value}`}
            >
              <Icon className="h-3.5 w-3.5" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Removable chips for the active filters (under the toolbar). */
export function ActiveFilterChips({
  prefs,
  onChange,
}: {
  prefs: DealListPrefs;
  onChange: (patch: Partial<DealListPrefs>) => void;
}) {
  const chips: { key: string; label: string; clear: () => void }[] = [
    ...prefs.phases.map((key) => {
      const p = DEAL_PHASES.find((x) => x.key === key);
      return {
        key: `phase-${key}`,
        label: p ? `${p.short} · ${p.label}` : key,
        clear: () => onChange({ phases: prefs.phases.filter((x) => x !== key) }),
      };
    }),
    ...prefs.industries.map((name) => ({
      key: `ind-${name}`,
      label: name,
      clear: () => onChange({ industries: prefs.industries.filter((x) => x !== name) }),
    })),
    ...(prefs.liveOnly ? [{ key: "live", label: "Live only", clear: () => onChange({ liveOnly: false }) }] : []),
  ];
  if (chips.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={c.clear}
          className="inline-flex items-center gap-1.5 h-6 pl-2.5 pr-1.5 rounded-full bg-teal/10 text-teal text-xs font-medium hover:bg-teal/15 transition-colors"
          data-testid={`chip-${c.key}`}
        >
          {c.label}
          <X className="h-3 w-3" />
        </button>
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          onClick={() => onChange({ phases: [], industries: [], liveOnly: false })}
          className="text-xs text-muted-foreground hover:text-foreground px-1.5"
        >
          Clear all
        </button>
      )}
    </div>
  );
}
