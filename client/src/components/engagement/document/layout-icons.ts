/**
 * A small icon per CIM layout for the page rail (what kind of page it is at a
 * glance: a table, a chart, text, highlight cards…). Generic fallback for
 * anything unregistered.
 */
import {
  AlignLeft, BarChart3, BookOpen, Columns2, FileText, Film, Images, LayoutGrid, LineChart, ListOrdered,
  Lock, Mail, MapPin, Milestone, Network, PieChart, ScrollText, ShieldCheck, Sparkles, Table2, Tags,
  TrendingUp, type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  cover_page: BookOpen,
  divider: ScrollText,
  metric_grid: LayoutGrid,
  stat_callout: TrendingUp,
  icon_stat_row: LayoutGrid,
  scorecard: Table2,
  bar_chart: BarChart3,
  horizontal_bar_chart: BarChart3,
  line_chart: LineChart,
  pie_chart: PieChart,
  donut_chart: PieChart,
  waterfall_chart: BarChart3,
  financial_table: Table2,
  comparison_table: Table2,
  prose_highlight: AlignLeft,
  two_column: Columns2,
  callout_list: Sparkles,
  numbered_list: ListOrdered,
  timeline: Milestone,
  tag_cloud: Tags,
  org_chart: Network,
  location_card: MapPin,
  location_map: MapPin,
  image_gallery: Images,
  video: Film,
  disclaimer_page: ShieldCheck,
  contact_page: Mail,
  locked: Lock,
};

export function layoutIcon(layoutType: string): LucideIcon {
  return ICONS[layoutType] ?? FileText;
}
