/**
 * cim-page-role — what a CIM page is about ("financials", "customers"…),
 * decided deterministically from its layout, its REAL title and labels, and
 * the legacy section keys. Broker side only (it reads real titles); the
 * role itself is generic, so it is also what cross-deal learning stores
 * instead of any title or key (never "kitchener_clinic_team").
 *
 * Owned by the intelligence stream (keyword lists can grow); the signature
 * and the PageRole set (shared/analytics-v2.ts) are the contract.
 */
import type { PageRole } from "./analytics-v2";

export interface PageRoleInput {
  layoutType: string;
  /** The real (named) title — never the blind one. */
  title?: string | null;
  sectionKey?: string | null;
  layoutData?: unknown;
  /** "cim-disclaimer" / "cim-contact" pages. */
  pageId?: string;
}

const RULES: Array<[PageRole, RegExp]> = [
  ["normalization", /\b(add[- ]?backs?|normali[sz]|adjusted ebitda|sde\b|seller'?s discretionary|recast|bridge)/i],
  ["financials", /\b(financial|income statement|p&l|profit|revenue (?:and|&) (?:ebitda|earnings)|balance sheet|cash ?flow|working capital|margin|ebitda|earnings|historical performance)/i],
  ["customers", /\b(customer|client|patient|concentration|contract|retention|churn|account)/i],
  ["revenue_mix", /\b(revenue (?:by|mix|breakdown|streams?|sources?)|sources of revenue|service lines?|product mix|segments?)/i],
  ["employees", /\b(employee|staff|team|people|workforce|management|leadership|personnel|org(?:anization(?:al)?)? chart|key person)/i],
  ["owner_transition", /\b(transition|reason for sale|owner|succession|training|handover|continuity)/i],
  ["location", /\b(location|facilit|real estate|lease|premises|property|site|warehouse|plant|office)/i],
  ["growth", /\b(growth|opportunit|expansion|pipeline|future|initiative|upside|strategy|strategies)/i],
  ["market", /\b(market|industry|compet|landscape|position|swot|target market)/i],
  ["transaction", /\b(transaction|asking price|price|deal structure|terms|offer|next steps|ideal buyer|process|valuation)/i],
  ["operations", /\b(operations?|operational|process|equipment|fleet|technology|systems|suppliers?|vendors?|capacity|permits?|licen[cs]|compliance|safety|seasonal)/i],
  ["overview", /\b(overview|summary|highlights?|at a glance|history|milestones|company|about|introduction|snapshot)/i],
];

/** Layouts whose role is fixed whatever the title says. */
const BY_LAYOUT: Record<string, PageRole> = {
  cover_page: "front_matter",
  divider: "front_matter",
  waterfall_chart: "normalization",
  org_chart: "employees",
  location_card: "location",
  location_map: "location",
};

/** Legacy default CIM section keys (CLAUDE.md "CIM document structure"). */
const BY_KEY: Record<string, PageRole> = {
  executiveSummary: "overview",
  companyOverview: "overview",
  historyMilestones: "overview",
  uniqueSellingPropositions: "overview",
  sourcesOfRevenue: "revenue_mix",
  growthStrategies: "growth",
  targetMarket: "market",
  permitsLicenses: "operations",
  seasonality: "operations",
  locationSite: "location",
  employeeOverview: "employees",
  transactionOverview: "transaction",
  financialOverview: "financials",
};

export function pageRole(input: PageRoleInput): PageRole {
  if (input.pageId === "cim-disclaimer" || input.pageId === "cim-contact") return "front_matter";
  const fixed = BY_LAYOUT[input.layoutType];
  if (fixed) return fixed;
  const title = (input.title || "").trim();
  for (const [role, re] of RULES) if (re.test(title)) return role;
  if (input.sectionKey && BY_KEY[input.sectionKey]) return BY_KEY[input.sectionKey];
  if (input.layoutType === "financial_table") return "financials";
  return "other";
}
