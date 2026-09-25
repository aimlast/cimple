/**
 * LayoutGallery — every CIM layout from the registry, grouped by category,
 * each with a small icon, its name and one line on what it's for.
 */
import {
  AlignLeft, BarChart3, BookOpen, Columns2, FileText, GanttChart, Grid2x2, Hash, LayoutList,
  LineChart, ListOrdered, MapPin, Minus, Network, PieChart, Scale, Sparkles, Table2, Tags,
  TrendingDown, Gauge, CircleDot, BarChartHorizontal, type LucideIcon,
} from "lucide-react";
import { layoutsByCategory, type CimLayoutDef } from "@shared/cim-layouts";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  cover_page: BookOpen,
  divider: Minus,
  metric_grid: Grid2x2,
  stat_callout: Hash,
  icon_stat_row: Sparkles,
  scorecard: Gauge,
  bar_chart: BarChart3,
  horizontal_bar_chart: BarChartHorizontal,
  line_chart: LineChart,
  pie_chart: PieChart,
  donut_chart: CircleDot,
  waterfall_chart: TrendingDown,
  financial_table: Table2,
  comparison_table: Scale,
  prose_highlight: AlignLeft,
  two_column: Columns2,
  callout_list: LayoutList,
  numbered_list: ListOrdered,
  timeline: GanttChart,
  tag_cloud: Tags,
  org_chart: Network,
  location_card: MapPin,
};

export function LayoutIcon({ layoutType, className }: { layoutType: string; className?: string }) {
  const Icon = ICONS[layoutType] ?? FileText;
  return <Icon className={className} />;
}

interface Props {
  value: string | null;
  onSelect: (layout: CimLayoutDef) => void;
  /** Layouts to mark as the section's current one. */
  currentLayout?: string | null;
  className?: string;
  columns?: 2 | 3;
}

export function LayoutGallery({ value, onSelect, currentLayout, className, columns = 2 }: Props) {
  return (
    <div className={cn("space-y-5", className)} role="listbox" aria-label="Layouts">
      {layoutsByCategory().map((group) => (
        <div key={group.key}>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">{group.label}</p>
          <div className={cn("grid gap-2", columns === 3 ? "grid-cols-1 sm:grid-cols-2 lg:grid-cols-3" : "grid-cols-1 sm:grid-cols-2")}>
            {group.layouts.map((l) => {
              const selected = value === l.key;
              const current = currentLayout === l.key;
              return (
                <button
                  key={l.key}
                  type="button"
                  role="option"
                  aria-selected={selected}
                  onClick={() => onSelect(l)}
                  className={cn(
                    "group flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-teal",
                    selected ? "border-teal bg-teal/10" : "border-border hover:border-teal/40 hover:bg-muted/40",
                  )}
                  data-testid={`layout-option-${l.key}`}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md border",
                      selected ? "border-teal/50 bg-teal/15 text-teal" : "border-border bg-muted/40 text-muted-foreground group-hover:text-foreground",
                    )}
                  >
                    <LayoutIcon layoutType={l.key} className="h-4 w-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-foreground">{l.label}</span>
                      {current && <span className="text-[10px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">current</span>}
                    </span>
                    <span className="block text-xs text-muted-foreground leading-snug mt-0.5">{l.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
