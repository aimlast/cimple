/**
 * Suggested ways to ask, and plain labels, for the GENERIC CIM data points
 * (the industry checklist's items get theirs from the phrasing pass —
 * plan-phrasing.ts — or a template). Code, not a data file: the esbuild
 * bundle only ships server/interview/prompts/ (CLAUDE.md "Runtime data
 * files").
 *
 * GENERIC_ASKS is keyed by `${sectionKey}:${firstKeyOfTheGroup}` — one entry
 * per SECTION_FIELD_GROUPS group (knowledge-base.ts). MEMBER_LABELS gives
 * every group member its own meaning, so a filing or an edit always names
 * the right key ("net income" is never written under EBITDA).
 */
import type { InterviewPlan } from "@shared/schema";

export interface GenericAsk {
  /** The item's label on the board. */
  label: string;
  /** One spoken sentence the broker can say. */
  ask: string;
  /** Why buyers care, ≤ 20 words. */
  why: string;
  /** What an answer looks like, ≤ 12 words (the capture catalogue). */
  answers: string;
}

export const GENERIC_ASKS: Record<string, GenericAsk> = {
  "overview:businessName": { label: "Business name", ask: "What's the business's legal name, and does it trade under another name?", why: "Buyers and lenders check the legal entity first.", answers: "legal name, trade name" },
  "overview:industry": { label: "What the business does", ask: "How would you describe what the business does, in a sentence?", why: "Frames the whole CIM.", answers: "one-line description of the business" },
  "overview:companyHistory": { label: "History and ownership", ask: "When did the business start, and how did it come to you?", why: "A long, clean track record is worth more.", answers: "year founded, how the owner came to own it" },
  "overview:entityType": { label: "Legal structure", ask: "Is it a corporation, and who owns the shares?", why: "Decides share vs asset sale and who signs.", answers: "corporation, partnership, sole proprietor; shareholders" },
  "overview:brandIdentity": { label: "Brand and identity", ask: "What are you known for with customers?", why: "Shows what goodwill a buyer keeps.", answers: "what customers know the business for" },
  "overview:industryPerception": { label: "Reputation and reviews", ask: "How do customers and others in the trade see the business — reviews, awards, referrals?", why: "Reputation is goodwill a buyer pays for.", answers: "reviews, ratings, awards, referral reputation" },
  "strengths:competitiveAdvantage": { label: "What makes it different", ask: "Why do customers choose you over competitors?", why: "Buyers pay more for an edge that lasts after you leave.", answers: "reasons customers choose this business" },
  "growth_potential:growthOpportunities": { label: "Growth opportunities", ask: "If you had more time or money, where would you grow the business?", why: "Buyers price in upside they can see.", answers: "new services, areas, customers, capacity" },
  "target_market:targetMarket": { label: "Customers and market", ask: "Who are your customers, and roughly how does it split — homes, businesses, government?", why: "Shows how broad and steady demand is.", answers: "customer types and their shares" },
  "permits_licenses:permitsLicenses": { label: "Permits and licences", ask: "What licences or permits does the business need, and who holds them?", why: "A licence held personally may not transfer.", answers: "licences, permits, who holds each" },
  "seasonality:seasonality": { label: "Busy and slow months", ask: "Which months are your busiest, and which are the quietest?", why: "Buyers plan cash and staffing around slow months.", answers: "busiest months, quietest months" },
  "revenue_sources:revenueStreams": { label: "Revenue streams", ask: "What are the main things you sell, and roughly how much does each bring in?", why: "Recurring, varied revenue is worth more.", answers: "products or services and their share of sales" },
  "revenue_sources:customerConcentration": { label: "Customer concentration", ask: "How much of revenue comes from your largest customer, and from your top five?", why: "A big customer leaving is a buyer's first worry.", answers: "% of revenue from largest customer and top five" },
  "revenue_sources:annualRevenue": { label: "Revenue and growth", ask: "What was revenue for the last full year, and how has it grown?", why: "The headline figure.", answers: "revenue, growth rate" },
  "real_estate:leaseDetails": { label: "Premises and lease", ask: "Do you own or lease the premises — and when does the lease end, with what options?", why: "A buyer needs to know they can stay.", answers: "own or lease, rent, end date, renewal options" },
  "employees:employees": { label: "Number of staff", ask: "How many people work in the business, full-time and part-time?", why: "Sizes payroll and management depth.", answers: "full-time and part-time headcount" },
  "employees:employeeStructure": { label: "Team and key people", ask: "Who are the key people, and what does each look after?", why: "Buyers need to know who keeps it running.", answers: "key roles and who fills them" },
  "employees:ownerInvolvement": { label: "Owner's role", ask: "What do you do day to day, and how many hours a week?", why: "The more you do, the more a buyer must replace.", answers: "owner's duties and weekly hours" },
  "operations:suppliers": { label: "Suppliers", ask: "Who are your main suppliers, and could you switch if you had to?", why: "Supplier dependence is a risk buyers check.", answers: "main suppliers, alternatives, terms" },
  "operations:technologySystems": { label: "Systems and software", ask: "What software runs the business — accounting, scheduling, customer records?", why: "Good systems make a handover easier.", answers: "accounting, scheduling, CRM, other software" },
  "buyer_profile:idealBuyer": { label: "Ideal buyer", ask: "What kind of buyer would you like to take over — and anyone you'd rule out?", why: "Steers who the broker approaches.", answers: "preferred buyer types, buyers ruled out" },
  "training_support:trainingSupport": { label: "Training and handover", ask: "How long would you stay to help a new owner, and doing what?", why: "Buyers want a smooth handover.", answers: "weeks or months of help, what it covers" },
  "reason_for_sale:reasonForSale": { label: "Reason for sale", ask: "What's prompting the sale now?", why: "Every buyer asks; a clear answer builds trust.", answers: "why the owner is selling now" },
  "financials:annualRevenue": { label: "Revenue, last full year", ask: "What was revenue for the last full year?", why: "The headline figure.", answers: "revenue for the last full fiscal year" },
  "financials:revenueByYear": { label: "Revenue by year and growth", ask: "What were sales in each of the last three years?", why: "Shows the trend.", answers: "revenue per year, growth rate" },
  "financials:ebitda": { label: "Profit", ask: "What did the business earn before tax last year?", why: "Buyers value the business on earnings.", answers: "EBITDA, net income, gross profit, margin" },
  "financials:addbacks": { label: "Owner's personal and one-time costs", ask: "Which personal or one-time costs run through the business?", why: "Shows what a new owner would really earn.", answers: "personal or one-time costs and amounts" },
  "financials:workingCapital": { label: "Working capital and debt", ask: "Is there any bank debt or a line of credit, and what's usually in receivables?", why: "Affects the price at closing.", answers: "bank debt, line of credit, receivables" },
  "asking_price:askingPrice": { label: "Price expectation", ask: "What price do you have in mind?", why: "Sets expectations early.", answers: "the seller's price expectation" },
  "asking_price:saleType": { label: "Share or asset sale", ask: "Are you thinking of selling the shares or the assets?", why: "Changes tax and what transfers.", answers: "share sale or asset sale" },
  "asking_price:assetsIncluded": { label: "What's included", ask: "What comes with the sale — equipment, vehicles, inventory, the building?", why: "Buyers need to know what they get.", answers: "equipment, vehicles, inventory, property included" },
};

/** Every group member's own meaning (lower-case, as it reads inside a sentence). */
export const MEMBER_LABELS: Record<string, string> = {
  businessName: "legal business name",
  industry: "what the business does",
  companyHistory: "the company's history",
  yearsOperating: "years in operation",
  ownershipHistory: "ownership history",
  entityType: "legal structure",
  brandIdentity: "brand and what it's known for",
  missionStatement: "mission statement",
  coreValues: "core values",
  industryPerception: "reputation in the trade",
  customerPerception: "reputation with customers",
  accolades: "awards and recognition",
  competitiveAdvantage: "competitive advantage",
  uniqueSellingProposition: "what makes it different",
  strengths: "key strengths",
  growthOpportunities: "growth opportunities",
  expansionPlans: "expansion plans",
  targetMarket: "target market",
  primaryMarket: "main market",
  secondaryMarket: "secondary market",
  b2bBreakdown: "business vs consumer split",
  customerDemographics: "who the customers are",
  customerBase: "customer base",
  permitsLicenses: "permits and licences",
  complianceRequirements: "compliance requirements",
  seasonality: "seasonality overall",
  peakPeriods: "busiest months",
  slowPeriods: "quietest months",
  revenueStreams: "revenue streams",
  keyProducts: "main products and services",
  customerConcentration: "share of revenue from the largest customers",
  annualRevenue: "revenue, last full year",
  revenueGrowth: "revenue growth %",
  operatingMargins: "operating margin %",
  leaseDetails: "lease terms",
  propertyInfo: "the premises",
  realEstateIncluded: "real estate in the sale",
  employees: "number of staff",
  employeeStructure: "staff structure",
  keyEmployees: "key employees",
  managementTeam: "management team",
  ownerInvolvement: "owner's day-to-day role",
  suppliers: "main suppliers",
  supplyChain: "supply chain",
  technologySystems: "software and systems",
  operationalSystems: "operational systems",
  idealBuyer: "ideal buyer",
  trainingSupport: "training offered to the buyer",
  transitionPlan: "handover plan",
  reasonForSale: "reason for sale",
  revenueByYear: "revenue by year",
  ebitda: "EBITDA as the statements show it",
  sde: "SDE (your own calculation)",
  netIncome: "net income (after tax)",
  grossProfit: "gross profit",
  addbacks: "the seller's personal and one-time costs",
  workingCapital: "working capital",
  debt: "bank debt and loans",
  askingPrice: "the seller's price expectation",
  saleType: "share or asset sale",
  assetsIncluded: "assets included",
  inventory: "inventory",
};

/**
 * Keys that sit in two sections' groups: counted once, in their home
 * section; the other section shows a reference row.
 */
export const SHARED_KEY_HOME: Record<string, string> = {
  annualRevenue: "financials",
  revenueGrowth: "financials",
  operatingMargins: "financials",
  revenueByYear: "financials",
};

export function lowerFirst(s: string): string {
  if (!s) return s;
  // Keep acronyms ("WSIB rating", "EMR") as they are.
  return /^[A-Z]{2}/.test(s) ? s : s.charAt(0).toLowerCase() + s.slice(1);
}

export const FALLBACK_WHY = "Buyers in this industry check this.";

/** The template ask for an item with no hand-written or phrased one. */
export function templateAsk(label: string): string {
  return `Can you tell me about ${lowerFirst(label.trim().replace(/[.?!]+$/, ""))}?`;
}

/** The ask + why for an industry checklist item: the phrasing pass's, else the template. */
export function planItemAsk(
  plan: Pick<InterviewPlan, "items"> | null | undefined,
  key: string,
  label: string,
  sectionReason: string,
): { ask: string; why: string } {
  const item = plan?.items.find((i) => i.key === key);
  const askAs = (item as { askAs?: string } | undefined)?.askAs;
  const why = (item as { whyItMatters?: string } | undefined)?.whyItMatters;
  return { ask: askAs?.trim() || templateAsk(label), why: why?.trim() || sectionReason || FALLBACK_WHY };
}
