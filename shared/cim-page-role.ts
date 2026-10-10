/**
 * cim-page-role — what a CIM page is about ("financials", "customers"…),
 * decided deterministically from its layout, its REAL title and labels, and
 * the legacy section keys. Broker side only (it reads real titles); the
 * role itself is generic, so it is also what cross-deal learning stores
 * instead of any title or key (never "kitchener_clinic_team").
 *
 * Owned by the intelligence stream (keyword lists can grow); the signature
 * and the PageRole set (shared/analytics-v2.ts) are the contract.
 *
 * Order matters: the first rule that matches the title wins, so the narrow
 * roles (add-backs before financials, suppliers before customers, staff
 * retention before customers, reason for sale before employees) come first. Words are matched on word starts,
 * so "contract" never matches "contractors" and "account" never matches
 * "accounting".
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
  ["front_matter", /^\s*(confidentiality|disclaimer|table of contents|contents)\b/i],
  ["normalization", /\b(add[- ]?backs?|normali[sz]|adjusted ebitda|adjusted earnings|owner'?s? (?:salary|compensation|wages?)|sde\b|seller'?s discretionary|recast|ebitda bridge|earnings bridge|bridge)/i],
  ["transaction", /\b(transaction|non[- ]?compet|non[- ]?solicit|asking price|purchase price|deal structure|deal terms|terms of sale|offers?\b|next steps|sale process|process letter|valuation|financing|seller financing|vendor take[- ]?back|vtb|earn[- ]?out)/i],
  ["owner_transition", /\b(reason for (?:sale|selling)|transition|succession|owner'?s? (?:role|involvement|time)|owner\b|training|handover|continuity|retirement)/i],
  ["financials", /\b(financial|income statement|p&l|profit|revenue (?:and|&) (?:ebitda|earnings|profit)|balance sheet|cash ?flow|working capital|margins?\b|ebitda|earnings|historical performance|revenue (?:trend|growth|history)|operating results|receivables?|payables?|expenses?\b|cost structure|capex|capital expenditure)/i],
  ["operations", /\b(suppliers?|vendors?|supply chain|procurement|inventory)\b/i],
  ["revenue_mix", /\b(revenue (?:by|mix|breakdown|streams?|sources?|split|composition)|revenue composition|sources of revenue|service lines?|product (?:mix|lines?)|products (?:and|&) services|services (?:and|&) products|offerings?|segments?\b|payer mix|insurance mix|recurring revenue|pricing)/i],
  // Keeping staff is about the team, not customers ("Driver Workforce & Retention").
  ["employees", /\b(drivers?|staff|employees?|workforce|technicians?|nurses?)\b[^.]*\bretention\b|\bretention of (drivers|staff|employees|technicians|nurses)\b/i],
  ["customers", /\b(customers?\b|clients?\b|client base|patients?\b|patient base|concentration|contracts?\b|retention|churn|accounts?\b|key accounts|payers?\b|referral sources?)/i],
  ["employees", /\b(employees?|(?:sub)?contractors?|staff(?:ing)?|team\b|people\b|workforce|management|leadership|personnel|org(?:ani[sz]ation(?:al)?)? chart|key (?:person|people|staff)|labou?r|human resources|hr\b|compensation)/i],
  ["location", /\b(locations?|facilit|real estate|lease|premises|property|site\b|sites\b|warehouse|plant\b|offices?\b|service area|territor|geograph|footprint|square f(?:ee|oo)t)/i],
  ["growth", /\b(growth|opportunit|expansion|pipeline|future|initiatives?|upside|strateg(?:y|ies|ic plan)|outlook|forecast|projections?|backlog)/i],
  ["market", /\b(market|industry|compet|landscape|position(?:ing)?|swot|target market|trends?|risks?\b|regulatory environment)/i],
  ["operations", /\b(operations?|operational|processes|equipment|fleet|technology|systems?\b|capacity|permits?|licen[cs]|compliance|safety|seasonal|quality|certifications?|workflow|hours of operation)/i],
  ["overview", /\b(overview|summary|highlights?|at a glance|history|milestones|company|about|introduction|snapshot|profile|business description|mission|investment thesis|why (?:buy|invest))/i],
];

/** Labels that make a table or card page's role clear when its title doesn't. */
const LABEL_RULES: Array<[PageRole, RegExp]> = [
  ["normalization", /\b(add[- ]?backs?|adjusted ebitda|normali[sz]ed|owner'?s? (?:salary|compensation)|one[- ]time)/i],
  ["financials", /\b(revenue|gross profit|ebitda|net income|cost of (?:goods|sales)|total assets|total liabilities|operating expenses)\b/i],
  ["customers", /\b(customer|client|patient)s?\b/i],
  ["employees", /\b(employees?|staff|full[- ]time|part[- ]time|tenure|headcount)\b/i],
  ["location", /\b(lease|square f(?:ee|oo)t|rent|landlord)\b/i],
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

/** A few label strings from a section's layoutData (row labels, card labels) — bounded. */
function layoutLabels(data: unknown): string {
  const out: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (out.length >= 40 || depth > 3 || v == null) return;
    if (Array.isArray(v)) { for (const x of v.slice(0, 30)) walk(x, depth + 1); return; }
    if (typeof v !== "object") return;
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (typeof x === "string" && /^(label|name|title|metric|category)$/i.test(k) && x.length <= 80) out.push(x);
      else if (typeof x === "object") walk(x, depth + 1);
    }
  };
  walk(data, 0);
  return out.join(" · ");
}

export function pageRole(input: PageRoleInput): PageRole {
  if (input.pageId === "cim-disclaimer" || input.pageId === "cim-contact") return "front_matter";
  const fixed = BY_LAYOUT[input.layoutType];
  if (fixed) return fixed;
  const title = (input.title || "").trim();
  for (const [role, re] of RULES) if (re.test(title)) return role;
  const labels = layoutLabels(input.layoutData);
  if (labels) {
    // The strongest label signal wins: count matches per role.
    let best: PageRole | null = null;
    let bestN = 0;
    for (const [role, re] of LABEL_RULES) {
      const n = labels.split(" · ").filter((l) => re.test(l)).length;
      if (n > bestN) { best = role; bestN = n; }
    }
    if (best && bestN >= 2) return best;
  }
  if (input.sectionKey && BY_KEY[input.sectionKey]) return BY_KEY[input.sectionKey];
  if (input.layoutType === "financial_table") return "financials";
  return "other";
}

/** Plain words for a role (broker side). */
export const PAGE_ROLE_TEXT: Record<PageRole, string> = {
  front_matter: "Front pages",
  overview: "Overview",
  financials: "Financials",
  normalization: "Add-backs & adjusted earnings",
  customers: "Customers",
  revenue_mix: "Revenue mix",
  operations: "Operations",
  employees: "Team & staff",
  owner_transition: "Owner & transition",
  location: "Location & lease",
  growth: "Growth",
  market: "Market & competition",
  transaction: "Price & deal terms",
  other: "Other pages",
};
