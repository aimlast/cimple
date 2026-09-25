/**
 * A small, fictional CIM used to preview templates and brand settings with
 * the real renderers (Settings → Brand & templates). Not a real business.
 */
import type { CimSection } from "@shared/schema";

function section(id: string, order: number, layoutType: string, sectionTitle: string, layoutData: Record<string, unknown>, aiDraftContent: string | null = null): CimSection {
  return {
    id,
    dealId: "sample",
    sectionKey: id,
    sectionTitle,
    order,
    layoutType,
    layoutData,
    aiLayoutReasoning: null,
    tags: [],
    aiDraftContent,
    brokerEditedContent: null,
    sellerEditedContent: null,
    finalContent: null,
    brokerApproved: true,
    sellerApproved: false,
    isVisible: true,
    layoutOverride: null,
    charts: null,
    images: null,
  } as unknown as CimSection;
}

export const SAMPLE_COVER = section("sample-cover", 0, "cover_page", "Northwind Mechanical", {
  businessName: "Northwind Mechanical",
  tagline: "Commercial HVAC service with 68% recurring maintenance revenue",
  industry: "Commercial HVAC",
  location: "Ontario, Canada",
  askingPrice: "$4,200,000",
  revenue: "$6,850,000",
  ebitda: "$1,180,000",
  earningsLabel: "Adj. EBITDA",
  date: "September 2026",
});

export const SAMPLE_METRICS = section("sample-metrics", 1, "metric_grid", "Investment Highlights", {
  columns: 3,
  metrics: [
    { label: "Recurring maintenance revenue", value: "68", unit: "%", highlight: true },
    { label: "Revenue growth, 3-year CAGR", value: "14.2", unit: "%", trend: "up", delta: "+2.1 pts" },
    { label: "Service agreements", value: "412", trend: "up", delta: "+38 this year" },
  ],
});

export const SAMPLE_CHART = section("sample-chart", 2, "bar_chart", "Revenue & EBITDA", {
  yLabel: "Revenue",
  secondaryLabel: "Adj. EBITDA",
  unit: "$K",
  data: [
    { name: "2022", value: 4640, secondaryValue: 690 },
    { name: "2023", value: 5480, secondaryValue: 870 },
    { name: "2024", value: 6120, secondaryValue: 1010 },
    { name: "2025", value: 6850, secondaryValue: 1180 },
  ],
});

export const SAMPLE_PIE = section("sample-pie", 3, "donut_chart", "Revenue Mix", {
  unit: "%",
  centerValue: "$6.85M",
  centerLabel: "2025 revenue",
  data: [
    { name: "Maintenance contracts", value: 46 },
    { name: "Service & repair", value: 22 },
    { name: "Replacements", value: 18 },
    { name: "New installations", value: 9 },
    { name: "Controls & monitoring", value: 5 },
  ],
});

export const SAMPLE_TABLE = section("sample-table", 4, "financial_table", "Income Statement Summary", {
  currency: "CAD",
  headers: ["", "FY2023", "FY2024", "FY2025"],
  rows: [
    { label: "Revenue", values: ["$5,480,000", "$6,120,000", "$6,850,000"], bold: true },
    { label: "Cost of sales", values: ["$3,180,000", "$3,490,000", "$3,860,000"], indent: 1 },
    { label: "Gross profit", values: ["$2,300,000", "$2,630,000", "$2,990,000"], isTotal: true },
    { label: "Operating expenses", values: ["$1,560,000", "$1,760,000", "$1,960,000"], indent: 1 },
    { label: "Adjusted EBITDA", values: ["$870,000", "$1,010,000", "$1,180,000"], isTotal: true },
  ],
  caption: "Adjusted for owner compensation above market and one-time items.",
});

export const SAMPLE_CALLOUTS = section("sample-callouts", 5, "callout_list", "Why It Stands Out", {
  columns: 2,
  style: "card",
  items: [
    { title: "Contracted, recurring base", description: "412 multi-year service agreements renew at 94%.", icon: "shield", highlight: true },
    { title: "Licensed, tenured team", description: "22 technicians, average tenure of 9 years, all G2/G1 certified.", icon: "users" },
    { title: "Blue-chip customers", description: "Property managers, schools and municipal buildings; no customer above 7%.", icon: "building" },
    { title: "Room to grow", description: "Controls retrofits and a second branch are both untouched.", icon: "trending-up" },
  ],
});

/** The whole sample, in order. */
export const SAMPLE_CIM: CimSection[] = [SAMPLE_COVER, SAMPLE_METRICS, SAMPLE_CHART, SAMPLE_TABLE, SAMPLE_PIE, SAMPLE_CALLOUTS];
