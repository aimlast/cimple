/**
 * matching/engine.ts — Deep buyer-deal matching engine
 *
 * Scores buyers against a deal using two phases:
 *
 * Phase 1 — Deterministic scoring (fast, no AI):
 *   Financial fit, location, industry, qualification signals, operational criteria
 *   Each criterion scores points if data is available on both sides.
 *
 * Phase 2 — AI qualitative scoring (Claude Sonnet):
 *   Evaluates soft criteria that can't be matched mechanically: growth potential,
 *   competitive moat, management depth, brand strength, reason for sale alignment,
 *   customer/supplier diversification, ideal buyer profile match.
 *
 * The final score is a weighted blend: 60% deterministic + 40% AI qualitative.
 */
import { effectiveAskingPrice } from "../information/deal-mirror";
import Anthropic from "@anthropic-ai/sdk";
import { agentConfig } from "../interview/config/load-config";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
type AiCreate = (params: any) => Promise<{ content: any[] }>;
let aiCreate: AiCreate = (params) => anthropic.messages.create(params) as any;
/** Tests replace the model call (no network). */
export function setMatchingAiForTests(fn: AiCreate | null): void {
  aiCreate = fn ?? ((params) => anthropic.messages.create(params) as any);
}

export interface BuyerCriteria {
  // Financial
  revenueMin?: string;
  revenueMax?: string;
  ebitdaMin?: string;
  ebitdaMax?: string;
  sdeMin?: string;
  sdeMax?: string;
  askingPriceMin?: string;
  askingPriceMax?: string;
  grossMarginMin?: string;
  ebitdaMarginMin?: string;
  revenueGrowthMin?: string;
  recurringRevenueMin?: string;
  maxCustomerConcentration?: string;
  multipleMax?: string;
  workingCapitalPref?: string;
  debtTolerance?: string;

  // Operational
  ownerInvolvementMax?: string;
  minEmployees?: string;
  maxEmployees?: string;
  managementTeamRequired?: boolean;
  employeeRetentionImportance?: string;
  systemsMaturity?: string;
  realEstatePreference?: string;
  leaseLengthMin?: string;

  // Business quality
  targetIndustries?: string[];
  excludedIndustries?: string[];
  targetLocations?: string[];
  yearsInBusinessMin?: string;
  customerDiversification?: string;
  supplierDiversification?: string;
  ipRequired?: boolean;
  brandStrengthMin?: string;
  competitiveMoat?: string;
  licensingRequired?: boolean;

  // Deal structure
  acceptableReasons?: string[];
  sellerFinancingRequired?: boolean;
  sellerFinancingMin?: string;
  transitionPeriodMax?: string;
  earnoutAcceptable?: boolean;
  assetVsSharePref?: string;
  nonCompeteRequired?: boolean;

  // Growth & strategic
  growthPotentialMin?: string;
  scalabilityRequired?: boolean;
  geographicExpansion?: boolean;
  productExpansion?: boolean;
  addOnAcquisition?: boolean;
  platformAcquisition?: boolean;
  industryTailwinds?: boolean;
  techEnabled?: boolean;
}

export interface MatchBreakdown {
  // Deterministic scores (each 0-100 within category)
  financialFit: { score: number; max: number; details: Record<string, { score: number; max: number; note: string }> };
  locationFit: { score: number; max: number; details: Record<string, { score: number; max: number; note: string }> };
  industryFit: { score: number; max: number; details: Record<string, { score: number; max: number; note: string }> };
  operationalFit: { score: number; max: number; details: Record<string, { score: number; max: number; note: string }> };
  dealStructureFit: { score: number; max: number; details: Record<string, { score: number; max: number; note: string }> };
  qualificationFit: { score: number; max: number; details: Record<string, { score: number; max: number; note: string }> };

  // AI qualitative scores
  aiQualitative?: {
    growthAlignment: number;       // 0-10
    competitiveMoat: number;       // 0-10
    managementDepth: number;       // 0-10
    customerHealth: number;        // 0-10
    strategicFit: number;          // 0-10
    reasonForSaleRisk: number;     // 0-10
    overallAssessment: string;     // 1-2 sentence AI summary
    score: number;                 // 0-100 overall AI score
  };
  /** Set when the AI qualitative pass ran but produced no usable score. */
  aiQualitativeUnavailable?: string;

  // Meta
  deterministicScore: number;
  aiScore: number;
  finalScore: number;
  criteriaMatched: number;
  criteriaTested: number;
  dataCompleteness: number;  // 0-100 — how much deal data was available to match
}

// ── Helpers ──────────────────────────────────────────────────────────────────
// Take the FIRST figure in a string. Stripping every non-digit turned a
// multi-year value like "$2,013,000 (2025); $2,202,520 (2024)" into 2e16 and
// zeroed every range score.
function firstNumber(val: string | number | undefined | null): number | null {
  if (val === null || val === undefined || val === "") return null;
  if (typeof val === "number") return Number.isFinite(val) ? val : null;
  const m = String(val).match(/-?\d[\d,]*(?:\.\d+)?\s*([MmKk])?(?![\d,])/);
  if (!m) return null;
  let num = parseFloat(m[0].replace(/[,\sMmKk]/g, ""));
  if (isNaN(num)) return null;
  const suffix = (m[1] || "").toLowerCase();
  if (suffix === "m") num *= 1_000_000;
  else if (suffix === "k") num *= 1_000;
  return num;
}
function parseCurrency(val: string | undefined | null): number | null {
  return firstNumber(val);
}

function parsePercent(val: string | undefined | null): number | null {
  return firstNumber(val);
}

function parseNum(val: string | undefined | null): number | null {
  return firstNumber(val);
}

function rangeScore(value: number, min: number | null, max: number | null): { score: number; note: string } {
  if (min !== null && max !== null) {
    if (value >= min && value <= max) return { score: 100, note: "Within range" };
    if (value < min) {
      const pctBelow = ((min - value) / min) * 100;
      if (pctBelow <= 10) return { score: 70, note: "Slightly below range" };
      if (pctBelow <= 25) return { score: 40, note: "Below range" };
      return { score: 0, note: "Well below range" };
    }
    const pctAbove = ((value - max) / max) * 100;
    if (pctAbove <= 10) return { score: 70, note: "Slightly above range" };
    if (pctAbove <= 25) return { score: 40, note: "Above range" };
    return { score: 0, note: "Well above range" };
  }
  if (min !== null) {
    if (value >= min) return { score: 100, note: "Meets minimum" };
    const pctBelow = ((min - value) / min) * 100;
    if (pctBelow <= 15) return { score: 60, note: "Slightly below minimum" };
    return { score: 0, note: "Below minimum" };
  }
  if (max !== null) {
    if (value <= max) return { score: 100, note: "Within maximum" };
    const pctAbove = ((value - max) / max) * 100;
    if (pctAbove <= 15) return { score: 60, note: "Slightly above maximum" };
    return { score: 0, note: "Exceeds maximum" };
  }
  return { score: 50, note: "No criteria specified" };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whole-word / whole-phrase match between a value and any target. The old
 * naive substring test (`a.includes(b) || b.includes(a)`) produced false
 * matches — e.g. deal industry "IT" matched target "capital" because
 * "capital".includes("it"). Now a target only matches when it appears as a
 * bounded word/phrase in the text (or vice versa), so "IT" matches
 * "IT Services" but not "capital".
 */
function textMatchesAny(text: string, targets: string[]): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower) return false;
  return targets.some(t => {
    const tl = t.toLowerCase().trim();
    if (!tl) return false;
    if (lower === tl) return true;
    const targetInText = new RegExp(`\\b${escapeRegex(tl)}\\b`).test(lower);
    const textInTarget = new RegExp(`\\b${escapeRegex(lower)}\\b`).test(tl);
    return targetInText || textInTarget;
  });
}

// ── Industry / location matching ────────────────────────────────────────────
// Buyer criteria come from people and CRM notes ("dental", "GTA", "southern
// Ontario", "home services"), deals are filed under broad labels
// ("Healthcare", "Unit 4, 210 Fairway Rd S, Kitchener, Ontario"). Plain
// substring matching missed most real matches, so both sides are compared on
// meaningful words, with a small taxonomy of parent industries and regions.

const INDUSTRY_FILLER = new Set([
  "business", "businesses", "company", "companies", "industry", "industries", "sector", "sectors", "service", "services",
  "practice", "practices", "firm", "firms", "shop", "shops", "store", "stores", "and", "the", "of", "or", "related", "type",
  "small", "medium", "large", "established", "profitable", "any", "other", "general", "local", "based", "provider", "providers",
]);
/** Parent industry → words that belong to it (both directions count as a match). */
const INDUSTRY_FAMILIES: Record<string, string[]> = {
  healthcare: ["health", "healthcare", "medical", "dental", "dentist", "orthodont", "clinic", "physio", "physiotherapy", "chiropract", "pharmacy", "optometr", "optical", "veterinar", "vet", "home care", "homecare", "senior care", "massage", "rehab"],
  "home services": ["hvac", "heating", "cooling", "air conditioning", "plumbing", "plumber", "electrical", "electrician", "roofing", "landscap", "lawn", "cleaning", "janitorial", "pest", "restoration", "garage door", "pool", "handyman", "renovation"],
  construction: ["construction", "contractor", "contracting", "general contractor", "renovation", "electrical", "plumbing", "roofing", "excavat", "paving", "concrete", "framing", "drywall"],
  "food service": ["restaurant", "cafe", "café", "coffee", "bakery", "bar", "pub", "catering", "food service", "franchise restaurant", "pizza", "fast food", "tavern"],
  "professional services": ["accounting", "bookkeeping", "payroll", "tax", "legal", "law", "consulting", "marketing agency", "agency", "insurance brokerage", "engineering", "architecture", "staffing"],
  manufacturing: ["manufactur", "fabrication", "welding", "machining", "machine shop", "metal", "plastics", "printing", "packaging"],
  retail: ["retail", "boutique", "florist", "convenience", "grocery", "butcher", "vape", "cannabis", "liquor", "pet store", "hardware", "e-commerce", "ecommerce"],
  automotive: ["automotive", "auto repair", "mechanic", "car dealership", "dealership", "collision", "body shop", "car wash", "tire"],
  "business services": ["b2b", "business services", "it services", "managed services", "msp", "logistics", "courier", "trucking", "transportation", "distribution", "wholesale"],
};

function words(t: string): string[] {
  return t.toLowerCase().replace(/[^a-z0-9éè&\s-]/g, " ").split(/[\s/,&-]+/).filter(Boolean);
}
function stem(w: string): string {
  return w.length > 4 ? w.replace(/(ies)$/, "y").replace(/(es|s)$/, "") : w;
}
function containsTerm(haystack: string, term: string): boolean {
  const t = term.toLowerCase().trim();
  if (!t) return false;
  if (t.includes(" ")) return haystack.includes(t);
  return new RegExp(`\\b${escapeRegex(stem(t))}`).test(haystack);
}
function familiesOf(text: string): Set<string> {
  const out = new Set<string>();
  for (const [family, members] of Object.entries(INDUSTRY_FAMILIES)) {
    if (containsTerm(text, family) || members.some((m) => containsTerm(text, m))) out.add(family);
  }
  return out;
}

/** Does any buyer target industry fit this deal? */
export function industryMatches(dealText: string, targets: string[]): boolean {
  const hay = dealText.toLowerCase();
  if (!hay.trim()) return false;
  if (textMatchesAny(hay, targets)) return true;
  const dealFamilies = familiesOf(hay);
  return targets.some((target) => {
    const meaningful = words(target).filter((w) => w.length >= 3 && !INDUSTRY_FILLER.has(w));
    // Specific term found in the deal ("dental" ⊂ "Harbourline Dental … dental practice").
    if (meaningful.some((w) => containsTerm(hay, w))) return true;
    // A broad target covers its family ("Healthcare" buyer ↔ dental practice;
    // "home services" ↔ HVAC). Specific targets don't widen: an HVAC buyer is
    // not automatically a plumbing buyer.
    const tl = target.toLowerCase();
    return Object.keys(INDUSTRY_FAMILIES).some((f) => dealFamilies.has(f) && (containsTerm(tl, f) || (f === "healthcare" && /\b(health|medical)\b/.test(tl))));
  });
}

// Words that narrow an exclusion without naming an industry ("New-build
// construction", "pure-play retail") — dropped before the all-words test.
const EXCLUSION_QUALIFIERS = new Set([
  "new", "build", "built", "newbuild", "ground", "up", "only", "pure", "play", "primarily", "mainly", "mostly",
  "heavy", "focused", "focus", "based", "type", "style", "commercial-only", "residential-only",
]);

/**
 * Exclusions that are nothing but a sector's name ("Healthcare", "Healthcare
 * services", "Home services", "Food & beverage") — written with the filler
 * words ("services", "business", "and") taken out. Such an exclusion covers
 * the whole family: a buyer who rules out "Healthcare" is ruling out a
 * pharmacy. Anything more specific ("Healthcare delivery", "New-build
 * construction", "Home care") is not a bare sector name and stays strict.
 */
const SECTOR_NAMES: Record<string, string[]> = {
  healthcare: ["healthcare", "health", "health care", "medical", "medicine", "healthcare medical", "health wellness", "health care medical", "healthcare delivery", "health care delivery", "care delivery"],
  "home services": ["home", "home services", "home service", "home trades", "home improvement"],
  construction: ["construction", "contracting", "construction contracting", "construction trades", "trades construction"],
  "food service": ["food", "food service", "food beverage", "f b", "hospitality", "restaurant food"],
  "professional services": ["professional", "professional services"],
  manufacturing: ["manufacturing", "manufacturer", "manufacturers"],
  retail: ["retail", "retailer", "retailers", "retail trade"],
  automotive: ["automotive", "auto"],
  "business services": ["business services", "b2b", "b2b services"],
};

/**
 * The families a deal belongs to, for exclusions. Same as `familiesOf`, except
 * that trades which are usually service businesses (plumbing, electrical,
 * roofing, renovation) don't make a deal "construction": a buyer who rules out
 * construction means project-based building, not a residential HVAC and
 * plumbing service company.
 */
const CONSTRUCTION_FOR_EXCLUSION = ["construction", "contractor", "contracting", "general contractor", "homebuild", "home builder", "excavat", "paving", "concrete", "framing", "drywall"];
function exclusionFamiliesOf(text: string): Set<string> {
  const out = familiesOf(text);
  out.delete("construction");
  if (CONSTRUCTION_FOR_EXCLUSION.some((m) => containsTerm(text, m))) out.add("construction");
  return out;
}

/** The family an exclusion names outright, if it is just a sector name. */
function bareSector(phrase: string): string | null {
  const all = words(phrase);
  const core = all.filter((w) => !INDUSTRY_FILLER.has(w)).join(" ");
  const full = all.join(" ");
  for (const [family, names] of Object.entries(SECTOR_NAMES)) {
    if (names.includes(core) || names.includes(full)) return family;
  }
  return null;
}

/**
 * Does a buyer's EXCLUDED industry rule this deal out? Stricter than
 * `industryMatches` (which suits targets): the whole exclusion phrase must
 * appear in the deal's industry label, or every one of its meaningful words
 * must — qualifiers like "new"/"build" ignored. Industry-family widening
 * applies only when the exclusion is just a sector's name. "New-build
 * construction" does not exclude a residential HVAC service business;
 * "construction" excludes a general contractor; "Healthcare" excludes a
 * pharmacy; "Home services" excludes an HVAC business.
 */
export function excludedIndustryMatches(dealIndustryText: string, exclusions: string[]): boolean {
  const hay = dealIndustryText.toLowerCase();
  if (!hay.trim()) return false;
  let dealFamilies: Set<string> | null = null;
  return exclusions.some((raw) => {
    const phrase = String(raw || "").toLowerCase().trim();
    if (!phrase) return false;
    if (new RegExp(`\\b${escapeRegex(phrase)}\\b`).test(hay)) return true;
    const sector = bareSector(phrase);
    if (sector && (dealFamilies ??= exclusionFamiliesOf(hay)).has(sector)) return true;
    const meaningful = words(phrase).filter((w) => w.length >= 3 && !INDUSTRY_FILLER.has(w) && !EXCLUSION_QUALIFIERS.has(w));
    return meaningful.length > 0 && meaningful.every((w) => containsTerm(hay, w));
  });
}

// ── AI qualitative scoring ─────────────────────────────────────────────────

export const AI_DIMENSIONS = [
  "growthAlignment", "competitiveMoat", "managementDepth", "customerHealth", "strategicFit", "reasonForSaleRisk",
] as const;

const AI_SCORE_TOOL = {
  name: "score_match",
  description: "Scores for how well the business matches the buyer's qualitative criteria.",
  input_schema: {
    type: "object",
    properties: {
      growthAlignment: { type: "number", description: "0-10 how well growth potential matches buyer expectations" },
      competitiveMoat: { type: "number", description: "0-10 strength of competitive advantages and defensibility" },
      managementDepth: { type: "number", description: "0-10 management team strength and owner dependency risk" },
      customerHealth: { type: "number", description: "0-10 customer diversification, retention, recurring revenue quality" },
      strategicFit: { type: "number", description: "0-10 how well this fits as platform/add-on/strategic acquisition" },
      reasonForSaleRisk: { type: "number", description: "0-10 how clean and low-risk the reason for sale is" },
      overallAssessment: { type: "string", description: "1-2 sentence summary of match quality" },
    },
    required: [...AI_DIMENSIONS, "overallAssessment"],
  },
};

/**
 * The first complete JSON object in a model reply — tolerant of code fences
 * and of prose before or after it ("{…}\n\nNote: …").
 */
export function firstJsonObject(text: string): any {
  const t = (text || "").replace(/```[a-zA-Z]*\r?\n?/g, "");
  const start = t.indexOf("{");
  if (start < 0) throw new Error("No JSON object in reply");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(t.slice(start, i + 1));
  }
  throw new Error("Unterminated JSON object in reply");
}

/**
 * The AI's six 0-10 dimensions, coerced and clamped. A dimension the model
 * left out, nulled or wrote as "N/A" is skipped; with fewer than 4 usable
 * dimensions there is no AI score at all (null) — never NaN.
 */
export function scoreAiDimensions(parsed: any): { dims: Partial<Record<(typeof AI_DIMENSIONS)[number], number>>; score: number } | null {
  if (!parsed || typeof parsed !== "object") return null;
  const dims: Partial<Record<(typeof AI_DIMENSIONS)[number], number>> = {};
  let sum = 0, n = 0;
  for (const k of AI_DIMENSIONS) {
    const raw = parsed[k];
    if (raw === null || raw === undefined || typeof raw === "boolean") continue;
    if (typeof raw === "string" && !/\d/.test(raw)) continue;
    const v = typeof raw === "number" ? raw : parseFloat(String(raw));
    if (!Number.isFinite(v)) continue;
    const c = Math.min(10, Math.max(0, v));
    dims[k] = c;
    sum += c;
    n++;
  }
  if (n < 4) return null;
  const score = Math.round((sum / (n * 10)) * 100);
  return Number.isFinite(score) ? { dims, score } : null;
}

/** Only finite integers 0-100 may be persisted as a match score. */
export function finiteScore(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, Math.round(n))) : null;
}

const LOCATION_FILLER = new Set(["north", "northern", "south", "southern", "east", "eastern", "west", "western", "central", "greater", "area", "region", "metro", "the", "and", "of", "near", "around", "within", "anywhere", "in", "province", "state"]);
const CA_PROVINCES: Record<string, string> = {
  on: "ontario", bc: "british columbia", ab: "alberta", qc: "quebec", mb: "manitoba", sk: "saskatchewan",
  ns: "nova scotia", nb: "new brunswick", nl: "newfoundland", pe: "prince edward island", yt: "yukon", nt: "northwest territories", nu: "nunavut",
};
const REGION_ALIASES: Record<string, string[]> = {
  gta: ["toronto", "mississauga", "brampton", "markham", "vaughan", "richmond hill", "oakville", "pickering", "ajax", "whitby", "oshawa", "burlington", "milton", "newmarket", "aurora", "scarborough", "etobicoke", "north york"],
  "greater toronto": ["toronto", "mississauga", "brampton", "markham", "vaughan", "richmond hill", "oakville"],
  "lower mainland": ["vancouver", "burnaby", "surrey", "richmond", "coquitlam", "langley", "abbotsford", "delta"],
  "kitchener-waterloo": ["kitchener", "waterloo", "cambridge"],
  "golden horseshoe": ["toronto", "hamilton", "burlington", "oakville", "mississauga", "st. catharines", "niagara", "oshawa"],
};
const US_STATES = ["alabama","alaska","arizona","arkansas","california","colorado","connecticut","delaware","florida","georgia","hawaii","idaho","illinois","indiana","iowa","kansas","kentucky","louisiana","maine","maryland","massachusetts","michigan","minnesota","mississippi","missouri","montana","nebraska","nevada","new hampshire","new jersey","new mexico","new york","north carolina","north dakota","ohio","oklahoma","oregon","pennsylvania","rhode island","south carolina","south dakota","tennessee","texas","utah","vermont","virginia","washington","west virginia","wisconsin","wyoming"];

/** Does any buyer target location cover this deal's location? */
export function locationMatches(dealLocation: string, targets: string[]): boolean {
  let hay = ` ${dealLocation.toLowerCase().replace(/[.,]/g, " ")} `;
  // Expand province abbreviations ("Kitchener, ON") so "Ontario" targets match.
  for (const [abbr, name] of Object.entries(CA_PROVINCES)) {
    if (new RegExp(`\\b${abbr}\\b`).test(hay)) hay += ` ${name} `;
  }
  if (textMatchesAny(hay, targets)) return true;
  const isCanada = hay.includes("canada") || Object.values(CA_PROVINCES).some((p) => hay.includes(p));
  const isUS = /\b(usa|united states)\b/.test(hay) || US_STATES.some((st) => hay.includes(` ${st} `) || hay.includes(` ${st}`));
  return targets.some((raw) => {
    const t = raw.toLowerCase().trim();
    if (!t) return false;
    if (/\bcanada\b/.test(t) && isCanada) return true;
    if (/\b(us|usa|united states|america)\b/.test(t) && isUS) return true;
    for (const [alias, cities] of Object.entries(REGION_ALIASES)) {
      if (t.includes(alias) && cities.some((c) => hay.includes(c))) return true;
    }
    const abbr = CA_PROVINCES[t];
    if (abbr && hay.includes(abbr)) return true;
    const meaningful = words(t).filter((w) => w.length >= 3 && !LOCATION_FILLER.has(w));
    return meaningful.length > 0 && meaningful.every((w) => hay.includes(w));
  });
}

type CatScore = { score: number; max: number; details: Record<string, { score: number; max: number; note: string }> };

function buildCatScore(details: Record<string, { score: number; max: number; note: string }>): CatScore {
  let total = 0, max = 0;
  for (const d of Object.values(details)) {
    total += d.score;
    max += d.max;
  }
  return { score: total, max, details };
}

/**
 * Everything that says what the business does, for industry matching — the
 * broad industry label alone ("Healthcare") can't tell a dental buyer this is
 * a dental practice. Stable sources only: the deal's labels and the broker's
 * description, then the business facts that describe it (overview, history,
 * products and services, revenue streams). Per-source summaries are no longer
 * deal facts (they stay on each source), so a legacy deal-level `summary` is
 * only a last resort.
 */
export function dealBusinessText(
  deal: { industry?: string | null; subIndustry?: string | null; description?: string | null },
  info: Record<string, any>,
): string {
  const asText = (v: unknown) => (typeof v === "string" ? v : v && typeof v === "object" && "value" in (v as any) ? String((v as any).value ?? "") : "");
  return [
    deal.industry || "", deal.subIndustry, asText(info.industry), asText(info.subIndustry), asText(info.businessType),
    asText(info.companyName), asText(deal.description).slice(0, 400),
    asText(info.businessDescription).slice(0, 400), asText(info.companyOverview).slice(0, 300),
    asText(info.companyHistory).slice(0, 300), asText(info.keyProducts).slice(0, 200),
    asText(info.servicesOffered ?? info.services).slice(0, 200), asText(info.revenueStreams).slice(0, 200),
    asText(info.summary).slice(0, 400),
  ].filter(Boolean).join(" · ");
}

// ── Main matching function ──────────────────────────────────────────────────
export async function matchBuyerToDeal(
  criteria: BuyerCriteria,
  deal: {
    industry: string;
    subIndustry?: string | null;
    askingPrice?: string | null;
    /** The broker's description of the business (deal creation). */
    description?: string | null;
    extractedInfo: Record<string, any>;
    financialAnalysis?: any;
  },
  options?: { skipAI?: boolean }
): Promise<MatchBreakdown> {
  const info = deal.extractedInfo || {};
  const fa = deal.financialAnalysis;

  // ── FINANCIAL FIT ──────────────────────────────────────────────────────────
  const financialDetails: Record<string, { score: number; max: number; note: string }> = {};

  // Revenue
  const dealRevenue = parseCurrency(info.annualRevenue) || parseCurrency(fa?.reclassifiedPnl?.totalRevenue);
  if (dealRevenue && (criteria.revenueMin || criteria.revenueMax)) {
    const r = rangeScore(dealRevenue, parseCurrency(criteria.revenueMin), parseCurrency(criteria.revenueMax));
    financialDetails.revenue = { score: r.score, max: 100, note: `$${(dealRevenue / 1e6).toFixed(1)}M — ${r.note}` };
  }

  // EBITDA
  const dealEbitda = parseCurrency(fa?.normalization?.adjustedEbitda) || parseCurrency(info.ebitda);
  if (dealEbitda && (criteria.ebitdaMin || criteria.ebitdaMax)) {
    const r = rangeScore(dealEbitda, parseCurrency(criteria.ebitdaMin), parseCurrency(criteria.ebitdaMax));
    financialDetails.ebitda = { score: r.score, max: 100, note: `$${(dealEbitda / 1e3).toFixed(0)}K — ${r.note}` };
  }

  // SDE
  const dealSde = parseCurrency(fa?.normalization?.adjustedSde) || parseCurrency(info.sde);
  if (dealSde && (criteria.sdeMin || criteria.sdeMax)) {
    const r = rangeScore(dealSde, parseCurrency(criteria.sdeMin), parseCurrency(criteria.sdeMax));
    financialDetails.sde = { score: r.score, max: 100, note: `$${(dealSde / 1e3).toFixed(0)}K — ${r.note}` };
  }

  // Asking price — the broker's listed price (a broker correction on the
  // Information tab wins over a stale deal column), else the price on file.
  const dealPrice = parseCurrency(effectiveAskingPrice({ askingPrice: deal.askingPrice ?? null, extractedInfo: info }));
  if (dealPrice && (criteria.askingPriceMin || criteria.askingPriceMax)) {
    const r = rangeScore(dealPrice, parseCurrency(criteria.askingPriceMin), parseCurrency(criteria.askingPriceMax));
    financialDetails.askingPrice = { score: r.score, max: 100, note: `$${(dealPrice / 1e6).toFixed(2)}M — ${r.note}` };
  }

  // Gross margin
  const dealGrossMargin = parsePercent(info.operatingMargins) || (fa?.reclassifiedPnl?.grossProfit && dealRevenue ? (parseCurrency(fa.reclassifiedPnl.grossProfit)! / dealRevenue) * 100 : null);
  if (dealGrossMargin && criteria.grossMarginMin) {
    const minGm = parsePercent(criteria.grossMarginMin)!;
    financialDetails.grossMargin = dealGrossMargin >= minGm
      ? { score: 100, max: 100, note: `${dealGrossMargin.toFixed(1)}% — meets minimum ${minGm}%` }
      : { score: dealGrossMargin >= minGm * 0.85 ? 50 : 0, max: 100, note: `${dealGrossMargin.toFixed(1)}% — below ${minGm}%` };
  }

  // EBITDA margin
  const dealEbitdaMargin = parsePercent(fa?.normalization?.ebitdaMargin);
  if (dealEbitdaMargin && criteria.ebitdaMarginMin) {
    const min = parsePercent(criteria.ebitdaMarginMin)!;
    financialDetails.ebitdaMargin = dealEbitdaMargin >= min
      ? { score: 100, max: 100, note: `${dealEbitdaMargin.toFixed(1)}% — meets minimum ${min}%` }
      : { score: dealEbitdaMargin >= min * 0.85 ? 50 : 0, max: 100, note: `${dealEbitdaMargin.toFixed(1)}% — below ${min}%` };
  }

  // Revenue growth
  const dealGrowth = parsePercent(info.revenueGrowth);
  if (dealGrowth !== null && criteria.revenueGrowthMin) {
    const min = parsePercent(criteria.revenueGrowthMin)!;
    financialDetails.revenueGrowth = dealGrowth >= min
      ? { score: 100, max: 100, note: `${dealGrowth.toFixed(1)}% growth — meets minimum` }
      : { score: dealGrowth >= 0 ? 40 : 0, max: 100, note: `${dealGrowth.toFixed(1)}% growth — below ${min}%` };
  }

  // Customer concentration
  const dealConcentration = parsePercent(info.customerConcentration);
  if (dealConcentration !== null && criteria.maxCustomerConcentration) {
    const max = parsePercent(criteria.maxCustomerConcentration)!;
    financialDetails.customerConcentration = dealConcentration <= max
      ? { score: 100, max: 100, note: `${dealConcentration}% — within acceptable range` }
      : { score: dealConcentration <= max * 1.2 ? 50 : 0, max: 100, note: `${dealConcentration}% — exceeds ${max}% max` };
  }

  // Recurring revenue
  const dealRecurring = parsePercent(info.recurringRevenue);
  if (dealRecurring !== null && criteria.recurringRevenueMin) {
    const min = parsePercent(criteria.recurringRevenueMin)!;
    financialDetails.recurringRevenue = dealRecurring >= min
      ? { score: 100, max: 100, note: `${dealRecurring}% recurring — meets minimum` }
      : { score: dealRecurring >= min * 0.5 ? 40 : 0, max: 100, note: `${dealRecurring}% recurring — below ${min}%` };
  }

  // Asking multiple
  if (dealPrice && dealEbitda && criteria.multipleMax) {
    const multiple = dealPrice / dealEbitda;
    const max = parseNum(criteria.multipleMax)!;
    financialDetails.askingMultiple = multiple <= max
      ? { score: 100, max: 100, note: `${multiple.toFixed(1)}x — within ${max}x max` }
      : { score: multiple <= max * 1.15 ? 50 : 0, max: 100, note: `${multiple.toFixed(1)}x — exceeds ${max}x max` };
  }

  const financialFit = buildCatScore(financialDetails);

  // ── INDUSTRY FIT ───────────────────────────────────────────────────────────
  const industryDetails: Record<string, { score: number; max: number; note: string }> = {};
  const dealIndustry = deal.industry || "";
  const dealIndustryText = dealBusinessText(deal, info);

  if (criteria.targetIndustries && criteria.targetIndustries.length > 0) {
    const match = industryMatches(dealIndustryText, criteria.targetIndustries);
    industryDetails.industry = match
      ? { score: 100, max: 100, note: `${dealIndustry} — matches target` }
      : { score: 0, max: 100, note: `${dealIndustry} — not in target list` };
  }

  if (criteria.excludedIndustries && criteria.excludedIndustries.length > 0) {
    const excluded = excludedIndustryMatches([dealIndustry, deal.subIndustry].filter(Boolean).join(" · "), criteria.excludedIndustries);
    if (excluded) {
      industryDetails.excluded = { score: 0, max: 100, note: `${dealIndustry} — EXCLUDED industry` };
    }
  }

  if (criteria.yearsInBusinessMin) {
    const dealYears = parseNum(info.yearsOperating);
    const minYears = parseNum(criteria.yearsInBusinessMin)!;
    if (dealYears !== null) {
      industryDetails.yearsInBusiness = dealYears >= minYears
        ? { score: 100, max: 100, note: `${dealYears} years — meets ${minYears} year minimum` }
        : { score: dealYears >= minYears * 0.7 ? 50 : 0, max: 100, note: `${dealYears} years — below ${minYears} minimum` };
    }
  }

  const industryFit = buildCatScore(industryDetails);

  // ── LOCATION FIT ───────────────────────────────────────────────────────────
  const locationDetails: Record<string, { score: number; max: number; note: string }> = {};
  const dealLocation = info.locationSite || info.location || info.leaseAddress || "";

  if (criteria.targetLocations && criteria.targetLocations.length > 0 && dealLocation) {
    const match = locationMatches(String(dealLocation), criteria.targetLocations);
    locationDetails.location = match
      ? { score: 100, max: 100, note: `${dealLocation.slice(0, 50)} — matches target` }
      : { score: 0, max: 100, note: `${dealLocation.slice(0, 50)} — not in target locations` };
  }

  const locationFit = buildCatScore(locationDetails);

  // ── OPERATIONAL FIT ────────────────────────────────────────────────────────
  const opDetails: Record<string, { score: number; max: number; note: string }> = {};

  // Owner involvement
  if (criteria.ownerInvolvementMax) {
    const dealOwnerHrs = parseNum(info.ownerInvolvement) || parseNum(info.ownerHoursPerWeek);
    const maxHrs = parseNum(criteria.ownerInvolvementMax)!;
    if (dealOwnerHrs !== null) {
      opDetails.ownerInvolvement = dealOwnerHrs <= maxHrs
        ? { score: 100, max: 100, note: `${dealOwnerHrs}hrs/wk — within ${maxHrs}hr max` }
        : { score: dealOwnerHrs <= maxHrs * 1.25 ? 50 : 0, max: 100, note: `${dealOwnerHrs}hrs/wk — exceeds ${maxHrs}hr max` };
    }
  }

  // Employee count
  const dealEmployees = parseNum(info.employees) || parseNum(info.totalEmployees);
  if (dealEmployees !== null && (criteria.minEmployees || criteria.maxEmployees)) {
    const r = rangeScore(dealEmployees, parseNum(criteria.minEmployees), parseNum(criteria.maxEmployees));
    opDetails.employees = { score: r.score, max: 100, note: `${dealEmployees} employees — ${r.note}` };
  }

  // Management team
  if (criteria.managementTeamRequired) {
    const hasMgmt = !!(info.managementTeam && String(info.managementTeam).length > 20);
    opDetails.managementTeam = hasMgmt
      ? { score: 100, max: 100, note: "Management team in place" }
      : { score: 20, max: 100, note: "No clear management team identified" };
  }

  // Lease length
  if (criteria.leaseLengthMin) {
    const leaseInfo = info.leaseDetails || info.leaseExpiry || "";
    const minYears = parseNum(criteria.leaseLengthMin)!;
    if (leaseInfo) {
      // Try to extract years from lease info
      const yearMatch = String(leaseInfo).match(/(\d+)\s*year/i);
      if (yearMatch) {
        const years = parseInt(yearMatch[1]);
        opDetails.leaseLength = years >= minYears
          ? { score: 100, max: 100, note: `${years} year lease — meets ${minYears} year minimum` }
          : { score: 30, max: 100, note: `${years} year lease — below ${minYears} year minimum` };
      }
    }
  }

  const operationalFit = buildCatScore(opDetails);

  // ── DEAL STRUCTURE FIT ─────────────────────────────────────────────────────
  const dsDetails: Record<string, { score: number; max: number; note: string }> = {};

  // Reason for sale
  if (criteria.acceptableReasons && criteria.acceptableReasons.length > 0 && !criteria.acceptableReasons.includes("any")) {
    const dealReason = (info.reasonForSale || "").toLowerCase();
    if (dealReason) {
      const match = criteria.acceptableReasons.some(r => dealReason.includes(r.replace(/_/g, " ")));
      dsDetails.reasonForSale = match
        ? { score: 100, max: 100, note: `"${dealReason.slice(0, 40)}" — acceptable reason` }
        : { score: 30, max: 100, note: `"${dealReason.slice(0, 40)}" — may not align with buyer preferences` };
    }
  }

  // Asset vs share preference
  if (criteria.assetVsSharePref && criteria.assetVsSharePref !== "either") {
    const dealSaleType = (info.saleType || "").toLowerCase();
    if (dealSaleType) {
      const match = (criteria.assetVsSharePref === "asset_only" && dealSaleType.includes("asset")) ||
                    (criteria.assetVsSharePref === "share_only" && dealSaleType.includes("share"));
      dsDetails.dealType = match
        ? { score: 100, max: 100, note: `${dealSaleType} — matches preference` }
        : { score: 30, max: 100, note: `${dealSaleType} — buyer prefers ${criteria.assetVsSharePref.replace(/_/g, " ")}` };
    }
  }

  const dealStructureFit = buildCatScore(dsDetails);

  // ── QUALIFICATION FIT ──────────────────────────────────────────────────────
  const qualDetails: Record<string, { score: number; max: number; note: string }> = {};
  // This is buyer-side data, not deal data — scored in the route based on buyer profile flags

  const qualificationFit = buildCatScore(qualDetails);

  // ── DETERMINISTIC TOTAL ────────────────────────────────────────────────────
  const allCats = [financialFit, industryFit, locationFit, operationalFit, dealStructureFit];
  const totalScore = allCats.reduce((s, c) => s + c.score, 0);
  const totalMax = allCats.reduce((s, c) => s + c.max, 0);
  const deterministicScore = totalMax > 0 ? Math.round((totalScore / totalMax) * 100) : 0;
  const criteriaTested = Object.values(financialDetails).length + Object.values(industryDetails).length +
    Object.values(locationDetails).length + Object.values(opDetails).length + Object.values(dsDetails).length;

  // ── AI QUALITATIVE SCORING ─────────────────────────────────────────────────
  let aiQualitative: MatchBreakdown["aiQualitative"];
  let aiQualitativeUnavailable: string | undefined;
  let aiScore = 0;

  if (!options?.skipAI && criteriaTested > 0 && process.env.ANTHROPIC_API_KEY) {
    try {
      const dealProfile = JSON.stringify({
        industry: dealIndustry,
        subIndustry: deal.subIndustry,
        revenue: info.annualRevenue,
        revenueGrowth: info.revenueGrowth,
        customerConcentration: info.customerConcentration,
        recurringRevenue: info.recurringRevenue,
        competitiveAdvantage: info.competitiveAdvantage,
        growthOpportunities: info.growthOpportunities,
        managementTeam: info.managementTeam,
        ownerInvolvement: info.ownerInvolvement,
        employees: info.employees,
        keyEmployees: info.keyEmployees,
        reasonForSale: info.reasonForSale,
        idealBuyer: info.idealBuyer,
        transitionPlan: info.transitionPlan,
        customerBase: info.customerBase,
        suppliers: info.suppliers,
        technologySystems: info.technologySystems,
        strengths: info.strengths,
        uniqueSellingProposition: info.uniqueSellingProposition,
      }, null, 0);

      const buyerProfile = JSON.stringify({
        buyerType: criteria,
        growthPotentialMin: criteria.growthPotentialMin,
        scalabilityRequired: criteria.scalabilityRequired,
        competitiveMoat: criteria.competitiveMoat,
        managementTeamRequired: criteria.managementTeamRequired,
        customerDiversification: criteria.customerDiversification,
        supplierDiversification: criteria.supplierDiversification,
        brandStrengthMin: criteria.brandStrengthMin,
        techEnabled: criteria.techEnabled,
        addOnAcquisition: criteria.addOnAcquisition,
        platformAcquisition: criteria.platformAcquisition,
      }, null, 0);

      const response = await aiCreate({
        model: agentConfig.models.supportingAgents,
        max_tokens: 1000,
        temperature: 0,
        system: `You are an M&A analyst scoring how well a business matches a buyer's qualitative criteria. Score each dimension 0-10. Be critical — only give 8+ for genuinely strong matches. When the buyer states nothing for a dimension, score how attractive the business is on it for a typical buyer of this kind. Always give a number.`,
        tools: [AI_SCORE_TOOL as any],
        tool_choice: { type: "tool", name: AI_SCORE_TOOL.name },
        messages: [{
          role: "user",
          content: `Score this deal against the buyer's qualitative criteria.

DEAL PROFILE:
${dealProfile}

BUYER QUALITATIVE CRITERIA:
${buyerProfile}`,
        }],
      });

      const toolBlock = response.content.find((b: any) => b.type === "tool_use");
      const textBlock = response.content.find((b: any) => b.type === "text");
      const parsed: any = toolBlock && toolBlock.type === "tool_use"
        ? toolBlock.input
        : firstJsonObject(textBlock && textBlock.type === "text" ? textBlock.text : "");
      const scored = scoreAiDimensions(parsed);
      if (scored) {
        aiScore = scored.score;
        aiQualitative = {
          ...(scored.dims as any),
          overallAssessment: typeof parsed.overallAssessment === "string" ? parsed.overallAssessment.slice(0, 500) : "",
          score: aiScore,
        };
      } else {
        aiQualitativeUnavailable = "AI scoring unavailable — the reply had too few usable scores.";
      }
    } catch (err) {
      console.error("[matching] AI qualitative scoring failed:", (err as Error)?.message ?? err);
      aiQualitativeUnavailable = "AI scoring unavailable — the AI didn't answer.";
    }
  }

  // ── FINAL BLEND ────────────────────────────────────────────────────────────
  const safeDeterministic = finiteScore(deterministicScore) ?? 0;
  const finalScore = finiteScore(
    aiQualitative ? safeDeterministic * 0.6 + aiScore * 0.4 : safeDeterministic,
  ) ?? safeDeterministic;

  // Data completeness — how many deal fields were available
  const keyFields = ["annualRevenue", "ebitda", "sde", "operatingMargins", "revenueGrowth",
    "customerConcentration", "ownerInvolvement", "employees", "managementTeam", "reasonForSale",
    "locationSite", "yearsOperating", "competitiveAdvantage", "growthOpportunities"];
  const available = keyFields.filter(f => info[f] && String(info[f]).length > 2).length;
  const dataCompleteness = Math.round((available / keyFields.length) * 100);

  return {
    financialFit,
    locationFit,
    industryFit,
    operationalFit,
    dealStructureFit,
    qualificationFit,
    aiQualitative,
    ...(aiQualitativeUnavailable ? { aiQualitativeUnavailable } : {}),
    deterministicScore: safeDeterministic,
    aiScore,
    finalScore,
    criteriaMatched: Object.values(financialDetails).concat(Object.values(industryDetails), Object.values(locationDetails), Object.values(opDetails), Object.values(dsDetails))
      .filter(d => d.score >= 60).length,
    criteriaTested,
    dataCompleteness,
  };
}
