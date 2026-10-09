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
  // Keep acronyms ("WSIB rating", "EMR") and proper names ("Comfort Club
  // membership trend" — the next word is capitalised too) as they are.
  const words = s.split(/\s+/);
  // (Two capitals in the first word: "WSIB", "A/R", "T&M", "3PL", "CyberSecure".)
  if (/^[^\s]*[A-Z][^\s]*[A-Z]/.test(words[0])) return s;
  if (words.length > 1 && /^[A-Z][a-z]/.test(words[0]) && /^[A-Z][a-z]/.test(words[1])) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

export const FALLBACK_WHY = "Buyers in this industry check this.";

const NUMBER_WORDS: Record<string, string> = { "2": "two", "3": "three", "4": "four", "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine", "10": "ten", "12": "twelve" };
const numberWord = (n: string) => NUMBER_WORDS[n] ?? n;
const capitalise = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
/** "a, b and c" */
const listWords = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`);
/** "How do sales …" / "How does revenue …": a plural last word takes "do". */
const doOrDoes = (phrase: string) => (/(?:[^su]s|sales)$/i.test(phrase.trim().split(/\s+/).pop() ?? "") ? "do" : "does");
/** Unit hints in brackets at the end: "(%)", "(years)" — read as words or dropped. */
const UNIT_TAIL: Array<[RegExp, string]> = [
  [/\s*\((?:%|percent)\)$/i, ""],
  [/\s*\(annual %\)$/i, " per year"],
  [/\s*\((?:in )?years\)$/i, ", in years"],
  [/\s*\((?:in )?months\)$/i, ", in months"],
  [/\s*\((?:if any|if held|if applicable)\)$/i, ""],
];
function dropUnitTail(s: string): string {
  for (const [re, words] of UNIT_TAIL) if (re.test(s)) return s.replace(re, words);
  return s;
}
/** Splits "A vs B vs C" into its parts (null unless there are 2–4 short ones). */
function versusParts(s: string): string[] | null {
  const parts = s.split(/\s+vs\.?\s+|\s+versus\s+/i).map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2 || parts.length > 4 || parts.some((p) => p.split(/\s+/).length > 5)) return null;
  return parts.map(lowerFirst);
}

/**
 * A spoken question from a checklist label, by a few safe patterns (the
 * phrasing pass replaces these once it has run — this is what every deal
 * shows until then). Only the label's own words are used; nothing is
 * invented. Null when no pattern fits. Pure.
 */
function patternAsk(raw: string): string | null {
  // Already a question.
  if (/^(who|what|how|is|are|does|do|did|when|where|which|why|can|could|will|has|have)\b/i.test(raw)) return `${capitalise(raw)}?`;
  // "Comfort Club membership trend (last 3 years)", "PT and RMT turnover last 3 years", "… (next 24 months)".
  const period = raw.match(/^(.+?)\s*\(?\s*\b(?:over the |in the )?(last|past|next) (\d+|two|three|five|ten|twelve) (years?|months?)\s*\)?$/i);
  if (period && period[1].trim().length > 2) {
    const subject = period[1].trim().replace(/[,:;–—-]+$/, "").trim();
    const span = `${period[2].toLowerCase() === "next" ? "the next" : "the last"} ${numberWord(period[3])} ${period[4].toLowerCase()}`;
    const trendOf = subject.replace(/\s*\btrend$/i, "");
    if (trendOf !== subject && !/\b(and|or)$/i.test(trendOf)) return `How has ${lowerFirst(trendOf)} trended over ${span}?`;
    if (period[2].toLowerCase() === "next") return `${capitalise(subject)} over ${span} — what do you expect?`;
    return `${capitalise(subject)} over ${span} — what does that look like?`;
  }
  // "Revenue split: installations vs service/repair", "Gross margin: installs vs service vs plumbing".
  const colon = raw.match(/^([^:]{2,60}):\s*(.+)$/);
  if (colon) {
    const parts = versusParts(dropUnitTail(colon[2]));
    const head = colon[1].trim().replace(/\s+(split|mix|breakdown)$/i, "");
    if (parts && head) return `How ${doOrDoes(head)} ${lowerFirst(head)} break down between ${listWords(parts)}?`;
  }
  // "Commercial vs residential revenue split", "Custom/job shop vs production work mix (%)".
  const mix = dropUnitTail(raw).match(/^(.+?)\s+(split|mix)$/i);
  if (mix) {
    const words = mix[1].trim().split(/\s+/);
    if (/^(percentage|percent|%)$/i.test(words[words.length - 1] ?? "")) words.pop();
    const nounRe = /^(revenue|sales|work|business|customers?|clients?|products?|services?|jobs?|patients?)$/i;
    const noun = words.length > 2 && nounRe.test(words[words.length - 1]) ? words.pop()!.toLowerCase() : null;
    const parts = versusParts(words.join(" "));
    if (parts) return noun ? `How ${doOrDoes(noun)} ${noun} break down between ${listWords(parts)}?` : `How does it split between ${listWords(parts)}?`;
  }
  // "Revenue breakdown (dry van, reefer, drayage, 3PL)", "Revenue breakdown by industry segment (%)".
  const breakdown = dropUnitTail(raw).match(/^(.+?)\s+breakdown(?:\s+(by .+?))?(?:\s*\((.+)\))?$/i);
  if (breakdown) {
    const inParens = (breakdown[3] ?? "").replace(/\s*%\s*/g, " ").trim();
    const across = inParens ? (versusParts(inParens) ?? inParens.split(/\s*[,/]\s*/).filter(Boolean)) : [];
    const tail = breakdown[2]
      ? ` ${breakdown[2]}${inParens ? ` (${inParens})` : ""}`
      : across.length >= 2 && across.length <= 6 ? ` across ${listWords(across)}` : "";
    const head = breakdown[1].trim();
    return `How ${doOrDoes(head)} ${lowerFirst(head)} break down${tail}?`;
  }
  // "Compounding revenue as percentage of total", "ODB percentage of Rx revenue", "Private-pay revenue percentage".
  const pct = raw.match(/^(.+?)\s+(?:as (?:a )?)?(percentage|percent|share|%)(?:\s+of\s+(.+))?$/i);
  if (pct && pct[1].trim().length > 2 && !(pct[2].toLowerCase() === "share" && pct[3])) {
    const subject = pct[1].trim();
    // A rate on its own ("utilization percentage") is not a share of a total.
    if (!pct[3] && /\b(utili[sz]ation|rate|margin|growth|occupancy|turnover|retention)$/i.test(subject)) return `What's the ${lowerFirst(subject)} as a percentage?`;
    if (pct[3] || !/\s(and|or)\s/i.test(subject)) {
      const of = pct[3] ? (/^total$/i.test(pct[3].trim()) ? "the total" : pct[3].trim()) : "the total";
      const word = pct[2].toLowerCase() === "share" ? "share" : "percentage";
      return `${capitalise(subject)} — what ${word} of ${of} is that?`;
    }
  }
  // "Number of licensed pharmacists on staff" → "How many …?"
  const num = raw.match(/^number of (.+)$/i);
  if (num && !/\s(and|or)\s/i.test(num[1])) return `How many ${dropUnitTail(num[1])}?`;
  // "Average fuel cost per mile/km", "Current backlog value".
  const what = raw.match(/^(average|current|typical)\s+(.+)$/i);
  if (what) return `What's the ${what[1].toLowerCase()} ${lowerFirst(dropUnitTail(what[2]))}?`;
  // "Any lanes or accounts currently out for rebid"
  if (/^any\s+\S/i.test(raw)) return `${capitalise(dropUnitTail(raw))}?`;
  // "Lease assignment requires landlord consent", "Landlord consent required for ownership change".
  const requires = raw.match(/^(.+?)\s+requires\s+(.+)$/i);
  if (requires) return `Does ${lowerFirst(requires[1])} require ${requires[2]}?`;
  const required = raw.match(/^(.+?)\s+required\s+(for|to|on)\s+(.+)$/i);
  if (required) return `Is ${lowerFirst(required[1])} required ${required[2].toLowerCase()} ${required[3]}?`;
  if (/\brequiring\b/i.test(raw)) return `Are there any ${lowerFirst(raw)}?`;
  // "Direct billing credentials transferable to buyer", "Vehicle leases/loans assignable to buyer".
  const transfer = raw.match(/^(.+?)\s+(transferable|assignable)\s+to\s+(?:a |the )?buyer$/i);
  if (transfer) return transfer[2].toLowerCase() === "transferable" ? `Can ${lowerFirst(transfer[1])} transfer to a buyer?` : `Can ${lowerFirst(transfer[1])} be assigned to a buyer?`;
  // "Names of all master license holders", "List of technician certifications by employee".
  const list = raw.match(/^(?:names|list) of (.+)$/i);
  if (list) return `Can you list ${list[1]}?`;
  // "Retention plan for licensed technicians", "Plan to transition owner's personal patient base".
  const plan = raw.match(/^(.*\bplan)\s+(for|to|post-sale)\b(.*)$/i);
  if (plan) return `What's the ${lowerFirst(plan[1])} ${plan[2]}${plan[3]}?`;
  // "Status of upcoming season orders", "Percentage of annual revenue in peak season/Q4".
  const statusOf = raw.match(/^status of (.+)$/i);
  if (statusOf) return `Where do things stand with ${statusOf[1]}?`;
  const pctOf = raw.match(/^(?:percentage|share) of (.+?)\s+(in|from|during)\s+(.+)$/i);
  if (pctOf) return `What percentage of ${pctOf[1]} comes ${pctOf[2].toLowerCase()} ${pctOf[3]}?`;
  // "Last RCDSO inspection date and outcome" → "When was the last RCDSO inspection, and how did it go?"
  const lastDate = raw.match(/^last (.+?) dates?( and (?:outcome|result|findings))?$/i);
  if (lastDate) return `When was the last ${lastDate[1]}${lastDate[2] ? ", and how did it go" : ""}?`;
  // "Buyer must be licensed PT (Alberta restriction)", "Dental Professional Corporation structure confirmed".
  const must = raw.match(/^(.+?)\s+must\s+(.+)$/i);
  if (must) return `Does ${lowerFirst(must[1])} have to ${must[2]}?`;
  const confirmed = raw.match(/^(.+?)\s+confirmed$/i);
  if (confirmed) return `Is the ${lowerFirst(confirmed[1])} confirmed?`;
  // "CTPAT certification status" → "Where do things stand with CTPAT certification?"
  const status = dropUnitTail(raw).match(/^(.+?)\s+status(\s*\(.+\))?$/i);
  if (status && status[1].trim().length > 2) return `Where do things stand with ${lowerFirst(status[1].trim().replace(/\s+current$/i, ""))}${status[2] ?? ""}?`;
  return null;
}

/** The template ask for an item with no hand-written or phrased one. */
export function templateAsk(label: string): string {
  const raw = label.trim().replace(/[.?!]+$/, "").replace(/\s+/g, " ");
  if (!raw) return "What can you tell me about this?";
  return patternAsk(raw) ?? `Can you tell me about ${lowerFirst(raw)}?`;
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
