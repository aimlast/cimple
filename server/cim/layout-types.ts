/**
 * CIM Layout Types
 *
 * The AI layout engine generates a bespoke array of CimLayoutSection[]
 * for each deal. The section count, titles, order, and layout types
 * are all AI-determined — nothing is fixed or template-driven.
 *
 * Each layoutType maps to a specific renderer component on the client.
 * The layoutData shape is typed per layout type below.
 */

// ─────────────────────────────────────────────
// Layout type registry
// Add new types here as the renderer library grows
// ─────────────────────────────────────────────
export type LayoutType =
  | "cover_page"
  | "metric_grid"
  | "bar_chart"
  | "horizontal_bar_chart"
  | "pie_chart"
  | "donut_chart"
  | "line_chart"
  | "timeline"
  | "financial_table"
  | "comparison_table"
  | "callout_list"
  | "icon_stat_row"
  | "prose_highlight"
  | "two_column"
  | "org_chart"
  | "location_card"
  | "stat_callout"
  | "image_gallery"
  | "numbered_list"
  | "tag_cloud"
  | "scorecard"
  | "divider"
  | "unknown"; // fallback — renders raw JSON gracefully

// ─────────────────────────────────────────────
// Per-layout data shapes
// ─────────────────────────────────────────────

export interface CoverPageData {
  businessName: string;
  tagline?: string;
  industry?: string;
  location?: string;
  askingPrice?: string;
  revenue?: string;
  ebitda?: string;
  preparedBy?: string;      // broker firm name
  preparedByLogo?: string;  // broker logo URL
  businessLogo?: string;
  date?: string;
  confidentialLabel?: string; // default "CONFIDENTIAL BUSINESS OVERVIEW"
}

export interface MetricGridData {
  metrics: Array<{
    label: string;
    value: string;
    unit?: string;
    trend?: "up" | "down" | "neutral";
    delta?: string;      // e.g. "+12% YoY"
    highlight?: boolean; // makes the card prominent
    footnote?: string;
  }>;
  columns?: 2 | 3 | 4;
  title?: string;
}

export interface BarChartData {
  data: Array<{ name: string; value: number; secondaryValue?: number; color?: string }>;
  xLabel?: string;
  yLabel?: string;
  secondaryLabel?: string;
  unit?: string;
  title?: string;
  stacked?: boolean;
}

export interface HorizontalBarChartData {
  data: Array<{ name: string; value: number; unit?: string }>;
  yLabel?: string;
  unit?: string;
  title?: string;
  showPercentages?: boolean;
}

export interface PieChartData {
  data: Array<{ name: string; value: number; color?: string }>;
  totalLabel?: string;
  unit?: string;
  title?: string;
}

export interface DonutChartData extends PieChartData {
  centerLabel?: string;
  centerValue?: string;
}

export interface LineChartData {
  data: Array<{ name: string; [series: string]: string | number }>;
  series: Array<{ key: string; label: string; color?: string }>;
  xLabel?: string;
  yLabel?: string;
  unit?: string;
  title?: string;
}

export interface TimelineData {
  events: Array<{
    date?: string;
    year?: string;
    title: string;
    description?: string;
    highlight?: boolean;
    category?: string; // e.g. "milestone", "acquisition", "expansion"
  }>;
  title?: string;
}

export interface FinancialTableData {
  headers: string[];                // e.g. ["", "2022", "2023", "2024"]
  rows: Array<{
    label: string;
    values: string[];
    isTotal?: boolean;
    isSectionHeader?: boolean;
    indent?: 0 | 1 | 2;
    bold?: boolean;
  }>;
  caption?: string;
  currency?: string;               // e.g. "CAD", "USD"
  footnotes?: string[];
}

export interface ComparisonTableData {
  leftLabel: string;
  rightLabel: string;
  rows: Array<{
    label: string;
    left: string;
    right: string;
    highlight?: boolean;
  }>;
  title?: string;
}

export interface CalloutListData {
  items: Array<{
    title: string;
    description?: string;
    icon?: string;        // lucide icon name, e.g. "TrendingUp", "Shield", "Users"
    highlight?: boolean;
    badge?: string;       // small label badge
  }>;
  columns?: 1 | 2 | 3;
  style?: "card" | "list" | "icon-row";
  title?: string;
}

export interface IconStatRowData {
  stats: Array<{
    icon?: string;
    label: string;
    value: string;
    unit?: string;
    description?: string;
  }>;
  title?: string;
}

export interface ProseHighlightData {
  body: string;
  pullQuote?: string;
  highlights?: string[];  // bullet callouts shown alongside prose
  subheading?: string;
}

export interface TwoColumnData {
  left: {
    title?: string;
    content: string;
    layoutType?: "prose" | "list" | "metric";
  };
  right: {
    title?: string;
    content: string;
    layoutType?: "prose" | "list" | "metric";
  };
  title?: string;
}

export interface OrgChartData {
  nodes: Array<{
    id: string;
    name: string;
    role: string;
    reportsTo?: string;
    isKeyPerson?: boolean;
    isOwner?: boolean;
    yearsAtCompany?: string;
    notes?: string;       // e.g. "staying post-sale"
  }>;
  title?: string;
  totalHeadcount?: number;
  ownerDependency?: string; // describes how reliant the business is on the owner
}

export interface LocationCardData {
  locations: Array<{
    label?: string;         // e.g. "Head Office", "Warehouse"
    address?: string;
    sqft?: number;
    leaseType?: "owned" | "leased" | "month_to_month";
    leaseExpiry?: string;
    monthlyRent?: string;
    annualRent?: string;
    renewalOptions?: string;
    notes?: string;
  }>;
  totalSqft?: number;
  title?: string;
}

export interface StatCalloutData {
  primaryValue: string;
  primaryLabel: string;
  secondaryStats?: Array<{ label: string; value: string }>;
  description?: string;
  accentColor?: string;
}

export interface ImageGalleryData {
  images: Array<{
    url: string;
    caption?: string;
    alt?: string;
  }>;
  columns?: 2 | 3 | 4;
  title?: string;
}

export interface NumberedListData {
  items: Array<{
    title: string;
    description?: string;
  }>;
  title?: string;
  ordered?: boolean;
}

export interface TagCloudData {
  tags: Array<{
    label: string;
    weight?: number; // 1–5, drives font size
    category?: string;
  }>;
  title?: string;
}

export interface ScorecardData {
  items: Array<{
    label: string;
    score: number;     // 0–100
    benchmark?: number;
    description?: string;
  }>;
  title?: string;
  maxScore?: number;
}

export interface DividerData {
  label?: string;
  style?: "line" | "section-break" | "page-break";
}

// Union of all layout data types
export type LayoutData =
  | CoverPageData
  | MetricGridData
  | BarChartData
  | HorizontalBarChartData
  | PieChartData
  | DonutChartData
  | LineChartData
  | TimelineData
  | FinancialTableData
  | ComparisonTableData
  | CalloutListData
  | IconStatRowData
  | ProseHighlightData
  | TwoColumnData
  | OrgChartData
  | LocationCardData
  | StatCalloutData
  | ImageGalleryData
  | NumberedListData
  | TagCloudData
  | ScorecardData
  | DividerData
  | Record<string, unknown>; // fallback for unknown types

// ─────────────────────────────────────────────
// The core section manifest type
// ─────────────────────────────────────────────
export interface CimLayoutSection {
  sectionKey: string;           // AI-generated unique key, snake_case
  sectionTitle: string;         // Display title
  order: number;
  layoutType: LayoutType;
  layoutData: LayoutData;
  aiDraftContent?: string;      // Prose content for prose-heavy sections
  aiLayoutReasoning: string;    // Why this layout was chosen (shown to broker)
  tags: string[];               // e.g. ["financial", "operations", "team"]
  isVisible: boolean;           // Broker can hide sections
  layoutOverride?: string;      // Set if broker changed the AI-chosen layout
  brokerApproved: boolean;
  brokerEditedContent?: string;
  // Computed after analytics
  engagementScore?: number;     // 0–100, populated from analytics
}

// ─────────────────────────────────────────────
// The full bespoke CIM document
// ─────────────────────────────────────────────
export interface CimDocument {
  dealId: string;
  sections: CimLayoutSection[];
  generatedAt: string;
  version: number;
  // Branding applied at render time (not stored here)
}
