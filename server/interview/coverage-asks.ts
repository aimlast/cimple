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

const PROPER_FIRST_RE = /^(Canadian|Canada|American|America|Ontario|Alberta|Quebec|Québec|British|Manitoba|Saskatchewan|Atlantic|Nova|Yukon|Nunavut|Federal|Microsoft|Google|Amazon|Apple|Shopify|Intuit|Sage|Xero|QuickBooks|Salesforce|HubSpot|Pipedrive|Red|English|French|European|Mexican)$/;

export function lowerFirst(s: string): string {
  if (!s) return s;
  // Keep acronyms ("WSIB rating", "EMR") and proper names ("Comfort Club
  // membership trend" — the next word is capitalised too) as they are.
  const words = s.split(/\s+/);
  // (Two capitals in the first word: "WSIB", "A/R", "T&M", "3PL", "CyberSecure".)
  if (/^[^\s]*[A-Z][^\s]*[A-Z]/.test(words[0])) return s;
  if (words.length > 1 && /^[A-Z][a-z]/.test(words[0]) && /^[A-Z][a-z]/.test(words[1])) return s;
  // (Places, nationalities and brands: "Canadian customs", "Ontario licence", "Microsoft partner tier";
  // a name before a year: "Larkspur 2026 vendor consolidation".)
  if (PROPER_FIRST_RE.test(words[0]) || (words.length > 1 && /^[A-Z][a-z]/.test(words[0]) && /^(19|20)\d\d$/.test(words[1]))) return s;
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

// ─────────────────────────────────────────────────────────────────────────
// Template asks: a checklist label → one spoken question
// ─────────────────────────────────────────────────────────────────────────
//
// What every deal shows until the phrasing pass (plan-phrasing.ts) has run.
// Only the label's own words are used — nothing is invented. Asides in
// brackets are dropped from the spoken ask ("(EMR)", "(MC/DOT, CVOR, etc.)"),
// except the few that change the question ("(if any)", "(% of revenue)",
// "(yes/no and which union)", "(last 3 years)"). A label that states a rule
// ("Buyer must be a licensed pharmacist", "… requires landlord consent")
// never becomes a question asking the seller to state the law — it asks
// about their situation. Pure.

/** Words after which a noun phrase's head ends ("rate | per mile", "agreements | with suppliers"). */
const PREPS = new Set(["of", "for", "by", "per", "on", "in", "with", "to", "at", "from", "under", "within", "between", "across", "against", "through", "during", "into", "over", "affecting", "including"]);
/** Singular words that end in s. */
const S_SINGULAR = new Set(["status", "process", "business", "access", "gas", "class", "analysis", "basis", "bonus", "census", "focus", "lens", "bus", "address", "progress", "success", "loss", "gross", "glass", "mass", "pass", "press", "stress", "logistics", "means", "news", "series", "emissions", "corpus", "campus", "thesis", "diagnosis", "prognosis", "chassis", "canvas", "atlas", "alias", "plus", "minus", "versus", "this", "its", "his", "us", "yes", "physics", "ethics", "economics", "analytics", "operations", "relations", "earnings", "proceeds"]);
const PLURAL_ANYWAY = new Set(["premises", "sales", "operations", "earnings", "proceeds", "goods", "people", "staff", "personnel", "data", "media", "criteria"]);
function isPluralWord(word: string): boolean {
  const w = word.replace(/[^A-Za-z'-]/g, "");
  if (!w) return false;
  const lower = w.toLowerCase();
  if (PLURAL_ANYWAY.has(lower)) return true;
  if (S_SINGULAR.has(lower)) return false;
  // Acronyms in the plural: "PTs", "RMTs", "ECAs".
  if (/^[A-Z0-9]{2,}s$/.test(w)) return true;
  if (/(ss|us|is|'s)$/i.test(w)) return false;
  return /s$/i.test(w);
}
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const lastWord = (s: string) => words(s).pop() ?? "";
/** The head of a noun phrase (before its first preposition) and the rest. */
function headTail(phrase: string): { head: string; tail: string } {
  const ws = words(phrase);
  for (let i = 1; i < ws.length; i++) {
    if (PREPS.has(ws[i].toLowerCase())) return { head: ws.slice(0, i).join(" ").replace(/[,;:]+$/, ""), tail: ws.slice(i).join(" ") };
  }
  return { head: phrase.trim(), tail: "" };
}
/**
 * Is the phrase's subject plural? Its first part before "and" / "or" / a
 * comma decides ("Supplier rebate programs and annual value" → plural);
 * `pair` counts "Digital x-ray and charting" as two things (a predicate's
 * "Are … in use?").
 */
function phrasePlural(phrase: string, pair = false): boolean {
  const { head } = headTail(phrase);
  const first = head.split(/\s+(?:and|or|&)\s+|,\s*|\//)[0];
  if (pair && /\s(and|&)\s/.test(head)) return true;
  return isPluralWord(lastWord(first));
}
/** The head noun's number ("pension and benefit trust fund obligations" → plural). */
const headPlural = (phrase: string) => isPluralWord(lastWord(headTail(phrase).head));
const DETERMINER_RE = /^(the|a|an|each|every|all|any|our|your|their|its|his|her|this|that|these|those)\s/i;
const OTHER_PARTY_RE = /^(owner|owner's|seller|seller's|buyer|buyer's|landlord|landlord's|associate|associates)\b/i;
/** "your …" for the business's own things, "the …" for someone else's ("the owner's …", "the associate dentist …"), nothing after a determiner. */
function yourOf(phrase: string): string {
  if (DETERMINER_RE.test(phrase)) return phrase;
  if (OTHER_PARTY_RE.test(phrase)) return `the ${lowerFirst(phrase)}`;
  return `your ${lowerFirst(phrase)}`;
}
function theOf(phrase: string): string {
  if (DETERMINER_RE.test(phrase)) return phrase;
  // (A proper name or an acronym first word reads without "the" too: "the TSSA gas licence" is fine either way.)
  return `the ${lowerFirst(phrase)}`;
}
function aOrAn(phrase: string): string {
  const w = words(phrase)[0] ?? "";
  if (/^[A-Z0-9]{2,}/.test(w)) return /^[AEFHILMNORSX8]/.test(w) ? "an" : "a";
  return /^[aeiou]/i.test(w) && !/^(uni|use|usu|eu|one)/i.test(w) ? "an" : "a";
}
/** Telegraphic labels drop "the" ("in sale", "to buyer", "on owner exit"): put the common ones back. */
function fixArticles(s: string): string {
  return s
    .replace(/\bon owner exit\b/gi, "when you leave")
    .replace(/\bon (?:an? )?ownership change\b/gi, "if ownership changes")
    .replace(/\bpost-sale(?=[?,]|$)/i, "after the sale")
    .replace(/\b(in|to|for|on|from|affecting|through|against|by|with|of) (sale|buyer|premises|fleet|lease|landlord|company|facility|store|brand|same|first|current|business)\b/gi, (_m, p: string, n: string) => `${p} the ${n}`);
}
/**
 * The ask is spoken TO the seller (the owner): "the owner's patient base" →
 * "your patient base", "on owner personally" → "on you personally". Never
 * "owner-operator" (a kind of trucker).
 */
function toSeller(s: string): string {
  return s
    .replace(/\b(?:the )?(?:owner|seller)'s\b(?!-)/gi, "your")
    .replace(/\b(on|by|from|with|to|for) (?:the )?(?:owner|seller)\b(?![-'])/gi, "$1 you")
    .replace(/\bwith the company or (?:the )?owner\b(?![-'])/gi, "with the company or with you");
}
const finish = (s: string) => toSeller(fixArticles(s.replace(/\s+/g, " ").replace(/\s+([,?])/g, "$1").trim()));

/** Asides in brackets and what they change. */
interface Asides {
  /** The label without any bracketed aside. */
  core: string;
  ifAny: boolean;
  /** "(% of revenue)" → "revenue". */
  pctOf: string | null;
  /** "(yes/no and which union)" → "union". */
  which: string | null;
  /** "(employees vs temp agency)" → ["employees", "temp agency"]. */
  versus: [string, string] | null;
}
function readAsides(raw: string): Asides {
  let ifAny = false;
  let pctOf: string | null = null;
  let which: string | null = null;
  let versus: [string, string] | null = null;
  for (const m of Array.from(raw.matchAll(/\s\(([^()]*)\)/g))) {
    const t = m[1].trim();
    if (/^if (any|applicable|held|unionized|unionised|so)$/i.test(t)) ifAny = true;
    const p = t.match(/^%\s*of\s+(.+)$/i);
    if (p) pctOf = p[1].trim();
    const w = t.match(/^yes\/no(?:,)? and which (.+)$/i);
    if (w) which = w[1].trim();
    const v = t.split(/\s+vs\.?\s+/i);
    if (v.length === 2 && v.every((x) => x && words(x).length <= 3)) versus = [v[0].trim(), v[1].trim()];
  }
  // (Unit hints read as words first — "(annual %)" → "per year", "(years)" → ", in years" — then every other aside goes.)
  const core = dropUnitTail(raw).replace(/\s+\([^()]*\)/g, "").replace(/\s+/g, " ").replace(/\s+,/g, ",").trim();
  return { core, ifAny, pctOf, which, versus };
}

const INCIDENT_RE = /\b(complaints?|violations?|claims?|incidents?|disputes?|grievances?|audits?|discipline|disciplinary|lawsuits?|accidents?|injuries|injury|infringements?|breaches|breach|recalls?|citations?|penalties|fines?|orders|liens?|liens filed|claims filed)$/i;
const PEOPLE_RE = /^(workers?|managers?|supervisors?|staff|employees?|technicians?|pharmacists?|dentists?|hygienists?|subcontractors?|customers?|clients?|suppliers?|competitors?|partners?|operators?|drivers?|estimators?|practitioners?|clinicians?|physicians?|associates?|owners?|shareholders?|directors?)$/i;
const SOFTWARE_RE = /\b(software|system|systems|platform|platforms|tools?|solutions?|stack|app|apps|crm|erp|pos|emr|pms)$/i;
const HOLDINGS_RE = /^(permits?|licen[cs]es?|certifications?|certificates?|registrations?|patents?|trademarks?|agreements?|contracts?|policies|policy|clauses?|programs?|programmes?|accreditations?|approvals?|authori[sz]ations?|warranties|guarantees?|insurance|coverage|capability|capabilities)$/i;
const WALK_RE = /\b(process|processes|methodology|structure|model|mechanisms?|arrangements?|terms|conditions|provisions|schedule|timeline|approach|procedures?|workflow|setup|set-up|usage|history|plan|plans|strategy|requirements|verification|story|entry|risk|dependencies)$/i;
const METRIC_RE = /\b(value|values|cost|costs|balance|amount|count|counts|capacity|height|volume|size|price|prices|premium|rate|rates|ratio|percentage|margin|margins|tenure|age|turnover|turns|utili[sz]ation|spend|revenue|fees?|hours|flow|visits|footage|level|levels|liability|liabilities|obligations|date|dates|area|channels?|sources|segments?|mix|distribution|split|headcount|following|follower|followers|score|rating|tier|figure|figures|frequency|backlog|pipeline|days|DSO|ROAS|CAC|ARR|MRR|LTV|EBITDA|scope|division|profile|exposure|impact|presence|adequacy|demand|engagement|classification|designation|production|detail|status|quantities|times|dates|counts|numbers?|ownership)$/i;
const OPPORTUNITY_RE = /\b(opportunity|opportunities|potential|feasibility|upside|outlook)$/i;
const RULE_RE = /\b(restriction|restrictions|rule|rules|prohibition)$/i;

/** Asks for labels with a shape the old patterns handle (some with their brackets). */
function bracketPatterns(raw: string): string | null {
  // "Comfort Club membership trend (last 3 years)", "PT and RMT turnover last 3 years", "… (next 24 months)".
  const period = raw.match(/^(.+?)\s*\(?\s*\b(?:over the |in the )?(last|past|next) (\d+|two|three|five|ten|twelve) (years?|months?)\s*\)?$/i);
  if (period && period[1].trim().length > 2) {
    const subject = readAsides(period[1].trim().replace(/[,:;–—-]+$/, "").trim()).core;
    const next = period[2].toLowerCase() === "next";
    const span = `${next ? "the next" : "the last"} ${numberWord(period[3])} ${period[4].toLowerCase()}`;
    const trendOf = subject.replace(/\s*\b(?:level and )?trend$/i, "");
    if (trendOf !== subject && !/\b(and|or)$/i.test(trendOf)) return `How has ${lowerFirst(trendOf)} trended over ${span}?`;
    if (INCIDENT_RE.test(subject) || /\/(injuries|accidents|incidents)$/i.test(subject) || /\b(filed|issued|raised)$/i.test(subject)) return `Have there been any ${lowerFirst(subject)} over ${span}?`;
    const required = subject.match(/^(.+?)\s+(required|needed)$/i);
    if (required) return `How much ${lowerFirst(required[1])} will be ${required[2].toLowerCase()} over ${span}?`;
    // "Equipment approaching end-of-life (next 3 years)".
    const approaching = subject.match(/^(.+?)\s+((?:approaching|nearing|due for|needing|coming up for)\b.*)$/i);
    if (approaching) return `What ${lowerFirst(approaching[1])} ${headPlural(approaching[1]) ? "are" : "is"} ${approaching[2]} over ${span}?`;
    if (next) return `What do you expect for ${yourOf(subject)} over ${span}?`;
    if (METRIC_RE.test(subject) || /\b(expenditure|capex|growth)$/i.test(subject)) return `What has ${yourOf(subject)} been over ${span}?`;
    return `What has ${lowerFirst(subject)} looked like over ${span}?`;
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
    const ws = mix[1].trim().split(/\s+/);
    if (/^(percentage|percent|%)$/i.test(ws[ws.length - 1] ?? "")) ws.pop();
    const nounRe = /^(revenue|sales|work|business|customers?|clients?|products?|services?|jobs?|patients?)$/i;
    const noun = ws.length > 2 && nounRe.test(ws[ws.length - 1]) ? ws.pop()!.toLowerCase() : null;
    const parts = versusParts(ws.join(" "));
    if (parts) return noun ? `How ${doOrDoes(noun)} ${noun} break down between ${listWords(parts)}?` : `How does it split between ${listWords(parts)}?`;
  }
  // "Revenue split (commercial/residential/institutional/industrial)".
  const listed = raw.match(/^(.+?)\s+(?:split|mix)\s*\(([^()]+)\)$/i);
  if (listed && /[/,]/.test(listed[2])) {
    const across = listed[2].split(/\s*[,/]\s*/).filter(Boolean).map(lowerFirst);
    if (across.length >= 2 && across.length <= 6) return `How ${doOrDoes(listed[1])} ${lowerFirst(listed[1].trim())} break down across ${listWords(across)}?`;
  }
  // "Revenue split between EV and ICE automotive programs".
  const between = raw.match(/^(.+?)\s+(?:split|mix) between (.+)$/i);
  if (between) return `How ${doOrDoes(between[1])} ${lowerFirst(between[1].trim())} split between ${readAsides(between[2]).core}?`;
  // "Revenue breakdown (dry van, reefer, drayage, 3PL)", "Revenue breakdown by industry segment (%)".
  const breakdown = dropUnitTail(raw).match(/^(.+?)\s+breakdown(?:\s+(by .+?))?(?:\s*\((.+)\))?$/i);
  if (breakdown) {
    const inParens = (breakdown[3] ?? "").replace(/\s*%\s*/g, " ").trim();
    const across = inParens ? (versusParts(inParens) ?? inParens.split(/\s*[,/]\s*/).filter(Boolean)) : [];
    const tail = breakdown[2] ? ` ${breakdown[2]}` : across.length >= 2 && across.length <= 6 ? ` across ${listWords(across)}` : "";
    const head = breakdown[1].trim();
    return `How ${doOrDoes(head)} ${lowerFirst(head)} break down${tail}?`;
  }
  return null;
}

/**
 * "What percentage of Rx revenue comes from ODB?", "What percentage of the
 * total is long-term care revenue?", "What's your labour cost as a
 * percentage of revenue?". Pure.
 */
function percentAsk(subjectRaw: string, ofRaw: string): string {
  const subject = subjectRaw.trim();
  const ofTotal = /^(the )?total$/i.test(ofRaw.trim());
  // A cost or a rate is measured against the total, not drawn from it.
  if (/\b(costs?|expenses?|spend|rent|payroll|wages|rate|ratio|margin|utili[sz]ation|turnover|retention|growth)$/i.test(subject)) {
    return `What's ${yourOf(subject)} as a percentage of ${ofTotal ? "revenue" : ofRaw.replace(/^the /i, "")}?`;
  }
  // "Owner dentist production as % of total" → your own production.
  const own = subject.match(/^owner(?:'s)?((?: (?:personal|own|dentist|pharmacist|clinical|dispensing))*) (production|revenue|sales|billings)$/i);
  if (own) {
    const kind = own[1].replace(/\b(personal|own|dentist|pharmacist)\b/gi, "").trim().toLowerCase();
    return `What percentage of the total is your own ${kind ? `${kind} ` : ""}${own[2].toLowerCase()}?`;
  }
  const itself = /\b(revenue|sales|income|production|billings|inventory|work)$/i.test(subject);
  const of = ofTotal ? (itself ? "the total" : "total revenue") : ofRaw.replace(/^the /i, "");
  const who = /^(largest|biggest|top|single)\b/i.test(subject) ? `your ${lowerFirst(subject)}` : lowerFirst(subject);
  return itself ? `What percentage of ${of} is ${who}?` : `What percentage of ${of} comes from ${who}?`;
}

/** "How many …" for a count. */
function howMany(things: string, tail = "", competing = false): string {
  const t = tail ? ` ${tail}` : "";
  return competing ? `How many ${things} are there${t}?` : `How many ${things} do you have${t}?`;
}
const pluralise = (w: string) => (isPluralWord(w) ? w : /(s|x|ch|sh)$/i.test(w) ? `${w}es` : /[^aeiou]y$/i.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`);
const pluraliseLast = (phrase: string) => {
  const ws = words(phrase);
  if (ws.length === 0) return phrase;
  ws[ws.length - 1] = pluralise(ws[ws.length - 1]);
  return ws.join(" ");
};

/** Asks from the label without its brackets. */
function corePatterns(raw: string, a: Asides): string | null {
  const core = a.core;
  const lc = lowerFirst(core);
  // "Does lease require landlord consent for ownership change" — their situation, not the lease law.
  const consentD = core.match(/^does (?:the )?(.+?) require (?:the )?(landlord|lessor|franchisor|lender|bank|customer|client|supplier|licensor|insurer)(?:'s)? consent (?:for|to|on) (.+)$/i);
  if (consentD) return `Has the ${consentD[2].toLowerCase()} said whether they'd need to consent to ${theOf(consentD[3])}?`;
  // Already a question.
  if (/^(who|what|how|is|are|does|do|did|when|where|which|why|can|could|will|has|have)\b/i.test(core)) return `${capitalise(core)}?`;

  // ── Rules and legal requirements: ask about the seller's situation, never the law ──
  // "Lease assignment requires landlord consent", "Landlord consent required for ownership change",
  // "Equipment/trailer leases requiring lessor consent to assign".
  const consentA = core.match(/^(.+?)\s+requires?\s+(?:the )?(landlord|lessor|franchisor|lender|bank|customer|client|supplier|licensor|insurer)(?:'s)? consent$/i);
  if (consentA) return `Has the ${consentA[2].toLowerCase()} said whether they'd need to consent to ${theOf(consentA[1])}?`;
  const consentB = core.match(/^(?:the )?(landlord|lessor|franchisor|lender|bank|customer|client|supplier|licensor|insurer) consent required (?:for|on|to) (.+)$/i);
  if (consentB) return `Has the ${consentB[1].toLowerCase()} said whether they'd need to consent to ${theOf(consentB[2])}?`;
  const consentC = core.match(/^(.+?)\s+requiring\s+(?:the )?(landlord|lessor|franchisor|lender|customer|client|supplier|licensor)(?:'s)? consent(?: to (?:assign|transfer))?$/i);
  if (consentC) return `Are there any ${lowerFirst(consentC[1])} where the ${consentC[2].toLowerCase()} would need to consent to a transfer?`;
  // "Buyer must be licensed pharmacist (Ontario ownership restriction)" — the rule is the broker's to know.
  const must = core.match(/^(.+?)\s+must\s+(.+)$/i);
  if (must) {
    const pred = must[2].replace(/^be (?!a |an |the )((?:licen[cs]ed|registered|certified|qualified|practising|practicing) [A-Za-z]+)$/i, (_m, rest: string) => `be ${aOrAn(rest)} ${rest}`);
    return `How would the rule that ${theOf(must[1])} must ${pred} affect your sale?`;
  }
  if (RULE_RE.test(core)) return `How would the ${lowerFirst(core)} affect your sale?`;
  // "Regulatory compliance experience required for buyer".
  const buyerNeeds = core.match(/^(.+?)\s+required (?:for|of|from) (?:a |the )?buyers?$/i);
  if (buyerNeeds) return `What ${lowerFirst(buyerNeeds[1])} would a buyer need?`;

  // ── Counts ──
  // "Number of setup technicians and average tenure".
  const numAvg = core.match(/^number of (.+?) and (average|typical) (.+)$/i);
  if (numAvg) return `How many ${numAvg[1]} do you have, and what's their ${numAvg[2].toLowerCase()} ${numAvg[3]}?`;
  // "Number of licensed pharmacists on staff", "Number of competing stores within 1km and 5km".
  const num = core.match(/^number of (.+)$/i);
  if (num) {
    const { head, tail } = headTail(dropUnitTail(num[1]));
    // "PTs rostered for dry needling", "molds owned by company" → "How many PTs are rostered for …?"
    const hw = words(head);
    if (hw.length >= 2 && /^(rostered|certified|employed|licen[cs]ed|owned|registered|trained|enrolled|qualified|assigned|leased|financed)$/i.test(hw[hw.length - 1])) {
      return `How many ${hw.slice(0, -1).join(" ")} are ${hw[hw.length - 1].toLowerCase()}${tail ? ` ${tail}` : ""}?`;
    }
    return howMany(head, tail, /\b(competing|competitor|competitors)\b/i.test(head));
  }
  // "Power units count by ownership type", "Trailer count by type".
  const countBy = core.match(/^(.+?)\s+count\s+by\s+(.+)$/i);
  if (countBy) return `How many ${pluraliseLast(lowerFirst(countBy[1]))} do you have, by ${countBy[2]}?`;
  // "Total managed endpoints count", "Total LTC/retirement beds under contract", "Total value of …".
  const total = core.match(/^total (.+)$/i);
  if (total) {
    const rest = total[1];
    const valueOf = rest.match(/^(value|cost|number) of (.+)$/i);
    if (valueOf) return valueOf[1].toLowerCase() === "number" ? howMany(valueOf[2]) : `What's the total ${valueOf[1].toLowerCase()} of ${yourOf(valueOf[2])}?`;
    const counted = rest.match(/^(.+?)\s+count$/i);
    if (counted) return `How many ${counted[1]} do you have in total?`;
    const { head, tail } = headTail(rest);
    if (isPluralWord(lastWord(head))) return howMany(head, tail);
    return `What's your total ${rest}?`;
  }
  // "New patients per month", "Active community patients".
  const perPeriod = core.match(/^(.+?)\s+per\s+(day|week|month|year)$/i);
  if (perPeriod && isPluralWord(lastWord(perPeriod[1])) && !METRIC_RE.test(perPeriod[1])) return `How many ${lowerFirst(perPeriod[1])} do you get per ${perPeriod[2].toLowerCase()}?`;
  const active = core.match(/^active (.+)$/i);
  if (active && isPluralWord(lastWord(headTail(active[1]).head))) return `How many active ${active[1]} do you have?`;
  // "Unfilled clinician hours available for hire".
  const availHours = core.match(/^(.+?\bhours) available (.+)$/i);
  if (availHours) return `How many ${lowerFirst(availHours[1])} are available ${availHours[2]}?`;
  // "Drivers employed vs owner-operators" — how many of each.
  const employedVs = core.match(/^(\w+) employed vs (.+)$/i);
  if (employedVs) return `How many ${employedVs[1].toLowerCase()} are employees, and how many are ${employedVs[2]}?`;
  // "Work done by employees vs subcontractors".
  const workBy = core.match(/^work done by (.+?) vs (.+)$/i);
  if (workBy) return `How much of the work is done by ${workBy[1]} versus ${workBy[2]}?`;

  // ── Percentages ──
  // "Largest single customer (% of revenue)", "Owner's personal clinical revenue (% of total)".
  if (a.pctOf) return percentAsk(core, a.pctOf);
  // "Compounding revenue as percentage of total", "ODB percentage of Rx revenue", "Private-pay revenue percentage".
  const pct = core.match(/^(.+?)\s+(?:as (?:a )?)?(percentage|percent|share|%)(?:\s+of\s+(.+))?$/i);
  if (pct && pct[1].trim().length > 1 && !(pct[2].toLowerCase() === "share" && pct[3])) {
    const subject = pct[1].trim();
    // A rate on its own ("utilization percentage") is not a share of a total.
    if (!pct[3] && /\b(utili[sz]ation|rate|margin|growth|occupancy|turnover|retention)$/i.test(subject)) return `What's ${yourOf(subject)} as a percentage?`;
    if (pct[3] || !/\s(and|or)\s/i.test(subject)) return percentAsk(subject, pct[3] ? pct[3].trim() : "total");
  }
  // "Percentage of annual revenue in peak season/Q4".
  const pctOf = core.match(/^(?:percentage|share) of (.+?)\s+(in|from|during)\s+(.+)$/i);
  if (pctOf) return `What percentage of ${pctOf[1]} comes ${pctOf[2].toLowerCase()} ${pctOf[3]}?`;
  // "Owner's personal share of total dispensing/clinical production".
  const shareOf = core.match(/^(.+?)'s\s+(?:personal\s+)?share of (.+)$/i);
  if (shareOf) return `What share of ${shareOf[2]} is ${OTHER_PARTY_RE.test(shareOf[1]) ? `the ${lowerFirst(shareOf[1])}` : lowerFirst(shareOf[1])}'s own?`;
  // "Ratio of technicians to managed endpoints".
  const ratioOf = core.match(/^ratio of (.+)$/i);
  if (ratioOf) return `What's your ratio of ${ratioOf[1]}?`;

  // ── Existence ──
  // "Workforce unionized (yes/no and which union)".
  if (a.which) {
    const pred = core.match(/^(.+?)\s+(\w+(?:ed|ised|ized))$/i);
    if (pred) return `${phrasePlural(pred[1]) ? "Are" : "Is"} ${theOf(pred[1])} ${pred[2].toLowerCase()}, and if so, which ${a.which}?`;
  }
  // "Any lanes or accounts currently out for rebid", "Any revocation or suspension in authority history".
  const any = core.match(/^any\s+(.+)$/i);
  if (any) {
    const rest = dropUnitTail(any[1]);
    const plural = words(headTail(rest).head).some((w) => isPluralWord(w));
    return `${plural ? "Are there any" : "Is there any"} ${rest}?`;
  }
  // "Known competitor openings or area changes", "Known or suspected environmental contamination".
  const known = core.match(/^known (or suspected )?(.+)$/i);
  if (known) return `Are you aware of any ${known[2]}${known[1] ? ", known or suspected" : ""}?`;
  // "Outstanding OHS orders or violations", "Ongoing labour disputes or grievances", "Disputed or long-outstanding holdbacks".
  const open = core.match(/^(outstanding|ongoing|open|pending|unresolved|disputed|current)\b(.+)$/i);
  if (open && !/\bby\b/i.test(core) && isPluralWord(lastWord(headTail(core).head)) && !METRIC_RE.test(headTail(core).head)) return `Are there any ${lc}?`;
  // "Recent insurer fee-cap or delisting changes".
  if (/^recent\s/i.test(core) && isPluralWord(lastWord(core))) return `Have there been any ${lc}?`;
  // "Deferred maintenance on facility and equipment".
  const deferred = core.match(/^deferred (.+)$/i);
  if (deferred) return `Is there any deferred ${deferred[1]}?`;
  // "Available land for future building expansion".
  const avail = core.match(/^available (.+?) for (.+)$/i);
  if (avail) return `Is there ${avail[1]} available for ${avail[2]}?`;
  // "Bond claims made against the business".
  if (/\b(made|filed|raised|brought) against\b/i.test(core)) return `Have there been any ${lc}?`;
  // "Customers exceeding 20% of revenue", "Bottleneck processes constraining output", "Security incidents affecting clients".
  const part = core.match(/^(.+?)\s+(exceeding|preventing|affecting|requiring|constraining|limiting|restricting|transferring|covering|blocking|delaying|threatening)\s+(.+)$/i);
  if (part && isPluralWord(lastWord(part[1]))) return `${INCIDENT_RE.test(part[1]) ? "Have there been any" : "Are there any"} ${lc}?`;
  // "Pre-paid treatment packages not yet delivered".
  if (/\bnot yet\b/i.test(core) && isPluralWord(lastWord(headTail(core.replace(/\s+not yet.*$/i, "")).head))) return `Are there any ${lc}?`;
  // "Copyright or trademark infringement issues".
  if (/\b(issues|problems|concerns)$/i.test(core)) return `Are there any ${lc}?`;
  // "Single-source suppliers for critical materials".
  const single = core.match(/^single-source (.+)$/i);
  if (single) return `Do you rely on any single-source ${single[1]}?`;
  // "Minimum purchase requirements with suppliers", "Purchase commitments or minimum order quantities".
  if (/^(minimum|purchase)\b/i.test(core) && isPluralWord(lastWord(headTail(core).head))) return `Do you have any ${lc}?`;

  // "Exposure if contractors reclassified as employees" → "What would it cost if contractors were reclassified as employees?"
  const exposure = core.match(/^(?:exposure|liability|cost|risk) if (.+)$/i);
  if (exposure) {
    const ws = words(exposure[1]);
    const i = ws.findIndex((w, k) => k > 0 && /ed$/i.test(w));
    const clause = i > 0 ? [...ws.slice(0, i), isPluralWord(ws[i - 1]) ? "were" : "was", ...ws.slice(i)].join(" ") : exposure[1];
    return `What would it cost the business if ${lowerFirst(clause)}?`;
  }

  // ── History and incidents ──
  // "Date and outcome of most recent IATF and ISO certification audits".
  const dateOutcome = core.match(/^date and outcome of (?:the )?(most recent|last|latest) (.+)$/i);
  if (dateOutcome) {
    const pl = isPluralWord(lastWord(dateOutcome[2]));
    return `When ${pl ? "were" : "was"} the ${dateOutcome[1].toLowerCase()} ${dateOutcome[2]}, and how did ${pl ? "they" : "it"} go?`;
  }
  // "Last RCDSO inspection date and outcome" → "When was the last RCDSO inspection, and how did it go?"
  const lastDate = core.match(/^last (.+?) dates?( and (?:outcome|result|findings))?$/i);
  if (lastDate) return `When was the last ${lastDate[1]}${lastDate[2] ? ", and how did it go" : ""}?`;
  // "History and timeline of IATF 16949 and ISO 13485 certifications".
  const historyOf = core.match(/^history(?: and timeline)? of (.+)$/i);
  if (historyOf) return `Can you walk me through the history of ${yourOf(historyOf[1])}?`;
  // "ODB or private-payer billing audit history and outcome", "RCDSO complaints or disciplinary history".
  const history = core.match(/^(.+?)\s+history(?: and (outcomes?|results?))?$/i);
  if (history) {
    let subject = history[1].trim().replace(/\bdisciplinary$/i, "disciplinary actions").replace(/\bdiscipline$/i, "disciplinary actions");
    if (INCIDENT_RE.test(subject) || /disciplinary actions$/i.test(subject)) {
      const w = lastWord(subject);
      if (!isPluralWord(w)) subject = `${subject.slice(0, subject.length - w.length)}${pluralise(w)}`;
      return `Have there been any ${lowerFirst(subject)}${history[2] ? ", and how did they turn out" : ""}?`;
    }
    return `Can you walk me through ${yourOf(`${subject} history`)}${history[2] ? " and how it turned out" : ""}?`;
  }

  // ── Who / how much depends on whom ──
  // "Revenue/relationship dependency on Daniel", "Temporary Foreign Worker program dependencies", "CNC programmer dependency and replaceability".
  const depOn = core.match(/^(?:.*?\b)?(?:dependency|dependence|reliance) on (.+)$/i);
  if (depOn) return `How much does the business depend on ${depOn[1]}?`;
  const dep = core.match(/^(.+?)\s+(?:dependency|dependencies|dependence)( and replaceability)?$/i);
  if (dep && !/\b(and|or)\b/i.test(dep[1]) && !/\b(usage|key)\b/i.test(dep[1])) return `How much does the business depend on ${theOf(dep[1])}${dep[2] ? ", and could they be replaced" : ""}?`;
  // "Revenue dependent on owner personally".
  const depRev = core.match(/^(revenue|sales|business|income) dependent on (.+)$/i);
  if (depRev) return `How much ${depRev[1].toLowerCase()} depends on ${depRev[2]}?`;
  // "Key subcontractors business depends on".
  const dependsOn = core.match(/^(.+?)\s+(?:the )?business depends on$/i);
  if (dependsOn) return `Which ${lowerFirst(dependsOn[1])} does the business depend on?`;
  // "Key technicians with deep client relationships", "Irreplaceable technical employees".
  const keyPeople = core.match(/^(key|irreplaceable|critical) (.+)$/i);
  if (keyPeople && isPluralWord(lastWord(headTail(keyPeople[2]).head)) && PEOPLE_RE.test(lastWord(headTail(keyPeople[2]).head).replace(/[^A-Za-z]/g, ""))) return `Who are the ${lc}?`;
  // "Associate dentist intent to stay post-sale".
  const intent = core.match(/^(.+?)\s+(?:intent|intention|plans?) to (.+)$/i);
  if (intent) return `Does ${theOf(intent[1])} intend to ${intent[2]}?`;
  // "Staff awareness of potential sale".
  const aware = core.match(/^(staff|employees?|team|managers?) awareness of (.+)$/i);
  if (aware) return `Do the ${aware[1].toLowerCase()} know about ${theOf(aware[2])}?`;
  // "Seller support through first post-sale certification audits", "Seller transition commitment".
  const sellerSupport = core.match(/^seller support (through|during|for|with) (.+)$/i);
  if (sellerSupport) return `What support would the seller give ${sellerSupport[1].toLowerCase()} ${sellerSupport[2]}?`;
  // "Owner's weekly hours working in store" → "How many hours a week do you work in the store?"
  const hours = core.match(/^(?:owner|seller)(?:'s)? (weekly|daily) hours(?: working)?(.*)$/i);
  if (hours) return `How many hours a ${hours[1].toLowerCase() === "weekly" ? "week" : "day"} do you work${hours[2]}?`;
  // "Owner clinical transition period (months/years)", "Seller transition commitment (duration and schedule)".
  const transition = core.match(/^(?:owner|seller)(?:'s)?(?: (\w+))? (?:transition|handover) (?:period|commitment)$/i);
  if (transition) return `How long would you stay on to help with the ${transition[1] ? `${transition[1].toLowerCase()} ` : ""}transition after the sale${/schedule/i.test(raw) ? ", and on what schedule" : ""}?`;
  // "Personal guarantee on lease by owner".
  const guaranteed = core.match(/^personal guarantee on (.+?) by (?:the )?(?:owner|seller)$/i);
  if (guaranteed) return `Have you personally guaranteed ${theOf(guaranteed[1])}?`;
  // "Operating authority held in company or owner name".
  const heldName = core.match(/^(.+?)\s+held in (?:the )?company or (?:the )?owner(?:'s)? name$/i);
  if (heldName) return `Is ${theOf(heldName[1])} held in the company's name or yours?`;
  // "Pharmacist-in-charge (designated manager) and transition plan".
  const roleAndPlan = core.match(/^(.+?-in-charge|designated manager|.+? manager) and (transition|succession) plan$/i);
  if (roleAndPlan) return `Who is ${theOf(roleAndPlan[1])}, and what's the ${roleAndPlan[2].toLowerCase()} plan?`;
  const ownerThing = core.match(/^(owner|seller|buyer)'s (.+)$/i);
  if (ownerThing) return `${phrasePlural(ownerThing[2]) ? "What are" : "What's"} the ${ownerThing[1].toLowerCase()}'s ${ownerThing[2]}?`;
  const roleThing = core.match(/^(.+?\b(?:manager|supervisor|director|lead|controller|bookkeeper|dentist|pharmacist|technician|foreman|estimator)) (tenure and role|role and tenure|tenure|role|responsibilities)$/i);
  if (roleThing) return `What's the ${lowerFirst(roleThing[1])}'s ${roleThing[2]}?`;
  const each = core.match(/^each (.+?)'s (.+)$/i);
  if (each) return `What are each ${each[1]}'s ${each[2]}?`;
  // "Owner assessment of third-location opportunity".
  const assess = core.match(/^(?:owner|seller)(?:'s)? (?:assessment|view|take) of (.+)$/i);
  if (assess) return `How do you see ${theOf(assess[1])}?`;
  // "Warehouse workers (employees vs temp agency)".
  if (a.versus && headPlural(core) && words(core).length <= 4) {
    const [x, y] = a.versus;
    return /agency|contract/i.test(y) ? `Are ${yourOf(core)} ${lowerFirst(x)}, or do they come through ${aOrAn(y)} ${lowerFirst(y)}?` : `Are ${yourOf(core)} ${lowerFirst(x)} or ${lowerFirst(y)}?`;
  }

  // "Project managers and site supervisors", "Medical device OEM customers".
  if (PEOPLE_RE.test(lastWord(headTail(core).head).replace(/[^A-Za-z]/g, "")) && isPluralWord(lastWord(headTail(core).head)) && words(headTail(core).head).length <= 6 && !/\b(if|segments?|markets?)\b/i.test(core) && !/\bcustomer relationships\b/i.test(core)) return `Who are ${yourOf(core)}?`;

  // ── Predicates: "All drivers properly licensed", "Premises medically zoned for pharmacy use" ──
  // "Certifications held by company vs individuals".
  const heldVs = core.match(/^(.+?)\s+held by (\w+) vs (\w+)$/i);
  if (heldVs) return `Which ${lowerFirst(heldVs[1])} are held by the ${heldVs[2].toLowerCase()}, and which by ${heldVs[3].toLowerCase()}?`;
  // "Customer relationships with company vs owner".
  const withVs = core.match(/^(.+?)\s+(with|by|in) (\w+) vs (\w+)$/i);
  if (withVs) return `${phrasePlural(withVs[1]) ? "Are" : "Is"} ${lowerFirst(withVs[1])} ${withVs[2].toLowerCase()} the ${withVs[3].toLowerCase()} or the ${withVs[4].toLowerCase()}?`;
  // "Cloud-based vs server-based infrastructure".
  const adjVs = core.match(/^(\S+) vs (\S+) (\S+)$/i);
  if (adjVs && /-(based|hosted|owned|run)$/i.test(adjVs[1])) return `${isPluralWord(adjVs[3]) ? "Are" : "Is"} your ${adjVs[3].toLowerCase()} ${adjVs[1].toLowerCase()} or ${adjVs[2].toLowerCase()}?`;
  // "Wage rates vs local market for operators", "Electrical capacity vs current demand".
  const bench = core.match(/^(.+?)\s+vs\s+((?:the )?(?:local |current |industry )?(?:market|demand|average|budget|benchmark|plan|prior year|last year))(.*)$/i);
  if (bench) return `How ${phrasePlural(bench[1]) ? "do" : "does"} ${yourOf(bench[1])} compare with ${theOf(bench[2])}${bench[3]}?`;
  // "Backlog comparison to same point last year".
  const comparison = core.match(/^(.+?)\s+comparison (?:to|with) (.+)$/i);
  if (comparison) return `How does ${yourOf(comparison[1])} compare to ${comparison[2]}?`;
  // "Revenue impact of annual automotive shutdowns".
  const impact = core.match(/^(.+?)\s+impact of (.+)$/i);
  if (impact) return `How ${isPluralWord(lastWord(impact[2])) ? "do" : "does"} ${lowerFirst(impact[2])} affect ${yourOf(impact[1])}?`;
  // "POS system integration with e-commerce platform".
  const integ = core.match(/^(.+?)\s+integration with (.+)$/i);
  if (integ) return `How does ${yourOf(integ[1])} integrate with ${theOf(integ[2])}?`;
  // "License transferability on owner exit", "Vendor partnership transfer on ownership change".
  const transferable = core.match(/^(.+?)\s+(?:transferability|transfer)(?:\s+(on .+))?$/i);
  if (transferable && !/\b(and|requirements)\b/i.test(transferable[1])) return `Can ${theOf(transferable[1])} transfer to a buyer${transferable[2] ? ` ${transferable[2]}` : ""}?`;
  // "Direct billing credentials transferable to buyer", "Vehicle leases/loans assignable to buyer".
  const transfer = core.match(/^(.+?)\s+(transferable|assignable)\s+to\s+(?:a |the )?buyer$/i);
  if (transfer) return transfer[2].toLowerCase() === "transferable" ? `Can ${lowerFirst(transfer[1])} transfer to a buyer?` : `Can ${lowerFirst(transfer[1])} be assigned to a buyer?`;
  // "Names of all master license holders", "List of key suppliers and their terms".
  const listOf = core.match(/^(?:names|list) of (.+)$/i);
  if (listOf) {
    const served = /\s+served$/i.test(listOf[1]);
    const what = listOf[1].replace(/\s+served$/i, "");
    return `Can you list ${DETERMINER_RE.test(what) ? what : served ? theOf(what) : yourOf(what)}${served ? " you serve" : ""}?`;
  }
  // "TSSA gas license holder and transferability", "Plumbing 306A certification holders", "ESA electrical license (if any) and holder".
  const holder = core.match(/^(.+?\b(?:licen[cs]e|certification|certificate|permit|registration|ticket))\s+(holders?)(?: and (transferability))?$/i);
  if (holder) return `Who ${holder[2].toLowerCase() === "holders" ? "on your team holds" : "holds"} ${theOf(holder[1])}${holder[3] ? ", and can it transfer to a buyer" : ""}?`;
  const andHolder = core.match(/^(.+?\b(?:licen[cs]e|certification|certificate|permit|registration))\s+and holders?$/i);
  if (andHolder) return `Do you have ${aOrAn(andHolder[1])} ${andHolder[1]}, and who holds it?`;
  // "Product patents held", "Trade certifications held by key employees".
  const heldBy = core.match(/^(.+?)\s+held by (.+)$/i);
  if (heldBy && !/\b(in|under)\b/i.test(heldBy[1])) return `What ${lowerFirst(heldBy[1])} ${isPluralWord(lastWord(heldBy[2])) ? "do" : "does"} ${heldBy[2]} hold?`;
  const heldEnd = core.match(/^(.+?)\s+held$/i);
  if (heldEnd) return `What ${lowerFirst(heldEnd[1])} do you hold?`;
  // "Documentation platform used", "EMR/practice management software in use", "Backup … solutions deployed", "Security stack offered".
  const used = core.match(/^(.+?)\s+(used|in use|deployed|offered|provided)$/i);
  if (used && (SOFTWARE_RE.test(used[1]) || /^(used|offered|provided|deployed)$/i.test(used[2]))) {
    const verb = { offered: "offer", provided: "provide" }[used[2].toLowerCase() as "offered" | "provided"] ?? "use";
    return `What ${lowerFirst(used[1])} do you ${verb}?`;
  }
  // "Inventory held or dropshipped".
  const either = core.match(/^(\w+) (\w+ed|held|kept|sold|built|made|bought) or (\w+ed|held|kept|sold|built|made|bought)$/i);
  if (either) return `Is your ${either[1].toLowerCase()} ${either[2].toLowerCase()} or ${either[3].toLowerCase()}?`;
  // "Product listing images and copy original or stock".
  const origStock = core.match(/^(.+?)\s+(original or stock|owned or leased|owned or rented)$/i);
  if (origStock) return `Are ${yourOf(origStock[1])} ${origStock[2]}?`;
  // "Products proprietary/branded or resale of other brands".
  const products = core.match(/^(products|services|brands) (.+?) or (.+)$/i);
  if (products) return `Are your ${products[1].toLowerCase()} ${products[2]} or ${products[3]}?`;
  // "Personal guarantee on lease by owner", "Owner personal indemnity on surety bonds".
  const guarantee = core.match(/^(.*?)(personal guarantee|personal indemnity|guarantee|indemnity) on (.+)$/i);
  if (guarantee) {
    const pre = guarantee[1].trim();
    const what = pre ? `${pre.toLowerCase()} ${guarantee[2].toLowerCase()}` : guarantee[2].toLowerCase();
    return `Is there ${aOrAn(what)} ${what} on ${theOf(guarantee[3])}?`;
  }
  // "Practitioner fees payable at year-end".
  const payable = core.match(/^(.+?)\s+payable (.+)$/i);
  if (payable) return `What ${lowerFirst(payable[1])} ${isPluralWord(lastWord(payable[1])) ? "are" : "is"} payable ${payable[2]}?`;
  // "Compounding room compliance with NAPRA standards".
  const complyWith = core.match(/^(.+?)\s+compliance with (.+)$/i);
  if (complyWith) return `${isPluralWord(lastWord(complyWith[1])) ? "Do" : "Does"} ${theOf(complyWith[1])} comply with ${complyWith[2]}?`;
  // "Workforce unionized", "All drivers properly licensed", "Owner-operator agreements written and compliant",
  // "Premises medically zoned for pharmacy use", "Written subcontractor agreements in place", "Trademarks registered for brand name".
  // (The participle ends the label, or is followed by "and …" or a preposition — never a noun: "licensed technicians" is not a predicate.)
  const predicate = core.match(/^(.+?)\s+((?:properly |medically |fully |currently |still |all )?(?:licen[cs]ed|zoned|written|compliant|registered|insured|bonded|certified|enrolled|documented|included|excluded|confirmed|unioni[sz]ed|in place|in use|up to date|filed|approved|signed|held)(?:\s+(?:and|or)\s+[\w-]+)?(?:\s+(?:for|in|to|with|by|on|under|at|from|as|of)\b.*)?)$/i);
  if (predicate && !/^(number|total|average|current|annual|monthly)\b/i.test(predicate[1]) && words(predicate[1]).length <= 6) {
    const subj = predicate[1];
    const plural = phrasePlural(subj, true) || /^all\b/i.test(subj);
    const det = /^premises$/i.test(subj) ? "the premises" : /^(all|each|every|any|written)\b/i.test(subj) || plural ? lowerFirst(subj) : theOf(subj);
    return `${plural ? "Are" : "Is"} ${det} ${predicate[2]}?`;
  }
  // "Same-day CEREC crown capability".
  if (/\bcapability$/i.test(core)) return `Do you have ${lowerFirst(core.replace(/\s+capability$/i, ""))} capability?`;
  // "Age and condition of shockwave and modality units", "Major equipment age and condition", "Condition of leasehold improvements and HVAC".
  const ageOf = core.match(/^(?:age and condition|age|condition) of (.+)$/i);
  if (ageOf) {
    const pl = phrasePlural(ageOf[1]) || /\band\b/i.test(ageOf[1]);
    return /^condition/i.test(core)
      ? `What condition ${pl ? "are" : "is"} ${theOf(ageOf[1])} in?`
      : `How old ${pl ? "are" : "is"} ${theOf(ageOf[1])}, and what condition ${pl ? "are they" : "is it"} in?`;
  }
  const ageEnd = core.match(/^(.+?)\s+age and condition$/i);
  if (ageEnd) {
    const pl = phrasePlural(ageEnd[1]) || isPluralWord(lastWord(ageEnd[1]));
    return `How old ${pl ? "are" : "is"} ${theOf(ageEnd[1])}, and what condition ${pl ? "are they" : "is it"} in?`;
  }
  // "Operating authority type" → "What type of operating authority do you have?"
  const type = core.match(/^(.+?)\s+type$/i);
  if (type && words(type[1]).length <= 4) return `What type of ${lowerFirst(type[1])} do you have?`;
  // "Patient record ownership", "Yard ownership".
  const owns = core.match(/^(.+?)\s+ownership$/i);
  if (owns && !/\b(and|or)\b/i.test(owns[1])) return `Who owns ${theOf(/\b(record|file|chart)$/i.test(owns[1]) ? pluraliseLast(owns[1]) : owns[1])}?`;
  // "Supplier concentration".
  const conc = core.match(/^(supplier|customer|client|payer|vendor) concentration$/i);
  if (conc) return `How concentrated are your ${pluralise(conc[1].toLowerCase())}?`;
  // "Accounts receivable aging by payer type".
  const aging = core.match(/^(.+?)\s+aging(?:\s+(by .+))?$/i);
  if (aging && !/\s(by|and)\s/i.test(aging[1])) return `What does ${yourOf(aging[1])} aging look like${aging[2] ? ` ${aging[2]}` : ""}?`;
  // "Consignment inventory arrangements (if any)", "Pre-paid or pre-sold service liability (if any)".
  if (a.ifAny && !/\b(holders?|status|transferability)$/i.test(core)) return `${headPlural(core) ? "Are there any" : "Is there any"} ${lc}?`;
  // "Contract termination clauses summary", "Project revenue seasonal pattern detail".
  const summaryOf = core.match(/^(.+?)\s+(summary|detail|details|overview)$/i);
  if (summaryOf) return `Can you walk me through ${yourOf(summaryOf[1])}?`;

  // ── The older shapes ──
  // "Average fuel cost per mile/km", "Current backlog value".
  const what = core.match(/^(average|current|typical|annual|monthly|weekly|daily|overall)\s+(.+)$/i);
  // "Average age of power units and trailers" → "What's the average age of your power units and trailers?"
  const whatOf = what && what[2].match(/^([\w-]+(?: [\w-]+)?) of (.+)$/i);
  if (whatOf && METRIC_RE.test(whatOf[1])) return `What's the ${what![1].toLowerCase()} ${whatOf[1]} of ${yourOf(whatOf[2])}?`;
  if (what && METRIC_RE.test(headTail(dropUnitTail(what[2])).head) && !/\b(and|or)\b/i.test(headTail(what[2]).head)) return `What's ${yourOf(dropUnitTail(core))}?`;
  if (what && /^(average|current|typical)$/i.test(what[1])) return `What's the ${what[1].toLowerCase()} ${lowerFirst(dropUnitTail(what[2]))}?`;
  // "Retention plan for licensed technicians", "Plan to transition owner's personal patient base".
  const plan = core.match(/^(.*\bplan)\s+(for|to|post-sale)\b(.*)$/i);
  if (plan) return `What's the ${lowerFirst(plan[1])} ${plan[2]}${plan[3]}?`;
  // "Status of upcoming season orders".
  const statusOf = core.match(/^status of (.+)$/i);
  if (statusOf) return `Where do things stand with ${statusOf[1]}?`;
  const confirmed = core.match(/^(.+?)\s+confirmed$/i);
  if (confirmed) return `Is the ${lowerFirst(confirmed[1])} confirmed?`;
  // "CTPAT certification status", "CPSA practice permit status for all 11 PTs".
  const status = dropUnitTail(core).match(/^(.+?)\s+status(?:\s+((?:for|of) .+))?$/i);
  if (status && status[1].trim().length > 2 && !/\band\b/i.test(status[1])) {
    const what = status[1].trim().replace(/\s+current$/i, "");
    // "CISC certification status (if held)" → "Do you have CISC certification, and where does it stand?"
    if (a.ifAny) return `Do you have ${lowerFirst(what)}, and where does it stand?`;
    if (status[2] && /^of\b/i.test(status[2])) return `Where do things stand with the ${lowerFirst(what)} ${status[2].replace(/^of (?!the |your )/i, "of your ")}?`;
    if (status[2]) return `What's ${yourOf(`${what} status`)} ${status[2]}?`;
    return `Where do things stand with ${lowerFirst(what)}?`;
  }
  // "HARP radiation safety compliance", "Zoning designation and use compliance".
  if (/\bcompliance(?:\s+(?:for|on|in) .+)?$/i.test(core)) return `Where do things stand with ${lowerFirst(core)}?`;
  void raw;
  return null;
}

/** A natural question for a noun-phrase label no pattern fits. Never "Can you tell me about …?". */
function nounPhraseAsk(core: string): string {
  const { head } = headTail(core);
  const plural = phrasePlural(core);
  const last = lastWord(head).replace(/[^A-Za-z/%-]/g, "");
  const firstPart = head.split(/\s+(?:and|or|&)\s+|,\s*/)[0];
  // Software and systems: "What practice management software system do you use?"
  if (SOFTWARE_RE.test(head) && !/\b(and)\b.*\b(process|plan)\b/i.test(core)) return `What ${lowerFirst(core)} do you use?`;
  // Opportunities: "How do you see the in-house orthodontics opportunity?"
  if (OPPORTUNITY_RE.test(core) || /\b(opportunity|opportunities|potential|feasibility|risk)\b/i.test(head) && OPPORTUNITY_RE.test(head)) return `How do you see ${theOf(core)}?`;
  // Holdings: permits, licences, agreements, programs, insurance.
  if (HOLDINGS_RE.test(last) && !METRIC_RE.test(firstPart)) {
    if (headPlural(core)) {
      const { head: h, tail } = headTail(core);
      return `What ${lowerFirst(h)} do you have${tail ? ` ${tail}` : ""}?`;
    }
    return `Do you have ${aOrAn(lowerFirst(core))} ${lowerFirst(core)}?`;
  }
  // Processes, structures, terms, plans, history: "Can you walk me through your estimating process and methodology?"
  if (WALK_RE.test(head) || /\bhistory and\b/i.test(head)) return `Can you walk me through ${yourOf(core)}?`;
  // Figures and descriptions: "What's your warehouse clear height?" / "What are your platform fees and app subscription costs?"
  if (METRIC_RE.test(head) || METRIC_RE.test(core)) return `${plural ? "What are" : "What's"} ${yourOf(core)}?`;
  return `${plural ? "What are" : "What's"} ${yourOf(core)}?`;
}

/** The template ask for an item with no hand-written or phrased one. */
export function templateAsk(label: string): string {
  const raw = label.trim().replace(/[.?!]+$/, "").replace(/\s+/g, " ");
  if (!raw) return "What can you tell me about this?";
  const bracketed = bracketPatterns(raw);
  if (bracketed) return finish(bracketed);
  const asides = readAsides(raw);
  if (!asides.core) return `What can you tell me about ${lowerFirst(raw)}?`;
  return finish(corePatterns(raw, asides) ?? nounPhraseAsk(asides.core));
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
