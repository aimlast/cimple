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
import Anthropic from "@anthropic-ai/sdk";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

  // Meta
  deterministicScore: number;
  aiScore: number;
  finalScore: number;
  criteriaMatched: number;
  criteriaTested: number;
  dataCompleteness: number;  // 0-100 — how much deal data was available to match
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function parseCurrency(val: string | undefined | null): number | null {
  if (!val) return null;
  const cleaned = String(val).replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parsePercent(val: string | undefined | null): number | null {
  if (!val) return null;
  const cleaned = String(val).replace(/[^0-9.-]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseNum(val: string | undefined | null): number | null {
  if (!val) return null;
  const num = parseFloat(String(val).replace(/[^0-9.-]/g, ""));
  return isNaN(num) ? null : num;
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

function textMatchesAny(text: string, targets: string[]): boolean {
  const lower = text.toLowerCase();
  return targets.some(t => {
    const tl = t.toLowerCase().trim();
    return lower.includes(tl) || tl.includes(lower);
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

// ── Main matching function ──────────────────────────────────────────────────
export async function matchBuyerToDeal(
  criteria: BuyerCriteria,
  deal: {
    industry: string;
    subIndustry?: string | null;
    askingPrice?: string | null;
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

  // Asking price
  const dealPrice = parseCurrency(deal.askingPrice) || parseCurrency(info.askingPrice);
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

  if (criteria.targetIndustries && criteria.targetIndustries.length > 0) {
    const match = textMatchesAny(dealIndustry, criteria.targetIndustries) ||
      (deal.subIndustry ? textMatchesAny(deal.subIndustry, criteria.targetIndustries) : false);
    industryDetails.industry = match
      ? { score: 100, max: 100, note: `${dealIndustry} — matches target` }
      : { score: 0, max: 100, note: `${dealIndustry} — not in target list` };
  }

  if (criteria.excludedIndustries && criteria.excludedIndustries.length > 0) {
    const excluded = textMatchesAny(dealIndustry, criteria.excludedIndustries);
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
    const match = textMatchesAny(dealLocation, criteria.targetLocations);
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

      const response = await anthropic.messages.create({
        model: "claude-sonnet-4-5",
        max_tokens: 600,
        system: `You are an M&A analyst scoring how well a business matches a buyer's qualitative criteria. Score each dimension 0-10. Be critical — only give 8+ for genuinely strong matches. Return ONLY valid JSON.`,
        messages: [{
          role: "user",
          content: `Score this deal against the buyer's qualitative criteria.

DEAL PROFILE:
${dealProfile}

BUYER QUALITATIVE CRITERIA:
${buyerProfile}

Return JSON:
{
  "growthAlignment": <0-10 how well growth potential matches buyer expectations>,
  "competitiveMoat": <0-10 strength of competitive advantages and defensibility>,
  "managementDepth": <0-10 management team strength and owner dependency risk>,
  "customerHealth": <0-10 customer diversification, retention, recurring revenue quality>,
  "strategicFit": <0-10 how well this fits as platform/add-on/strategic acquisition>,
  "reasonForSaleRisk": <0-10 how clean and low-risk the reason for sale is>,
  "overallAssessment": "<1-2 sentence summary of match quality>"
}`,
        }],
      });

      const raw = response.content[0].type === "text" ? response.content[0].text : "";
      const parsed = JSON.parse(raw.replace(/```json\s*/gi, "").replace(/```/g, "").trim());
      aiQualitative = parsed;
      aiScore = Math.round(
        ((parsed.growthAlignment + parsed.competitiveMoat + parsed.managementDepth +
          parsed.customerHealth + parsed.strategicFit + parsed.reasonForSaleRisk) / 60) * 100
      );
      aiQualitative!.score = aiScore;
    } catch (err) {
      console.error("[matching] AI qualitative scoring failed:", err);
    }
  }

  // ── FINAL BLEND ────────────────────────────────────────────────────────────
  const finalScore = aiQualitative
    ? Math.round(deterministicScore * 0.6 + aiScore * 0.4)
    : deterministicScore;

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
    deterministicScore,
    aiScore,
    finalScore,
    criteriaMatched: Object.values(financialDetails).concat(Object.values(industryDetails), Object.values(locationDetails), Object.values(opDetails), Object.values(dsDetails))
      .filter(d => d.score >= 60).length,
    criteriaTested,
    dataCompleteness,
  };
}
