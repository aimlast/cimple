import type { ExtractedInfo } from "@shared/schema";
import type { ExtractedField, InterviewReasoning } from "./response-schema";
import type { IndustryContext, LocationContext } from "./knowledge-base";

/**
 * Canonical spellings for extractedInfo fields.
 *
 * The model (and the intake questionnaire) sometimes use variant key names —
 * "reasonForSelling" instead of "reasonForSale", "employeeCount" instead of
 * "employees". Those variants were stored verbatim, so section coverage never
 * credited them and the agent would RE-ASK questions the seller had already
 * answered. Every write now lands on the canonical key.
 */
const FIELD_ALIASES: Record<string, string> = {
  // Reason for sale
  reasonForSelling: "reasonForSale",
  sellingReason: "reasonForSale",
  reasonToSell: "reasonForSale",
  // Company age
  yearsInBusiness: "yearsOperating",
  yearsInOperation: "yearsOperating",
  yearsEstablished: "yearsOperating",
  // Transition / training
  transitionAvailability: "transitionPlan",
  transitionSupport: "transitionPlan",
  trainingPlan: "trainingSupport",
  // People
  employeeCount: "employees",
  numberOfEmployees: "employees",
  staffCount: "employees",
  headcount: "employees",
  staff: "employees",
  keyStaff: "keyEmployees",
  keyPersonnel: "keyEmployees",
  // Financials
  revenue: "annualRevenue",
  annualSales: "annualRevenue",
  totalRevenue: "annualRevenue",
  yearlyRevenue: "annualRevenue",
  salesGrowth: "revenueGrowth",
  margins: "operatingMargins",
  profitMargins: "operatingMargins",
  // Structure & premises
  ownershipStructure: "entityType",
  legalStructure: "entityType",
  leaseTerms: "leaseDetails",
  leaseInfo: "leaseDetails",
  lease: "leaseDetails",
  // Positioning
  uniqueSellingPoint: "uniqueSellingProposition",
  usp: "uniqueSellingProposition",
  competitiveAdvantages: "competitiveAdvantage",
  growthPotential: "growthOpportunities",
  growthOpportunity: "growthOpportunities",
  // Compliance & sale terms
  permitsAndLicenses: "permitsLicenses",
  licenses: "permitsLicenses",
  askingPriceExpectation: "askingPrice",
  priceExpectation: "askingPrice",
};

/** Resolve a field name to its canonical spelling. */
export function canonicalFieldName(fieldName: string): string {
  return FIELD_ALIASES[fieldName] ?? fieldName;
}

/**
 * Merges newly extracted fields from an interview turn into the
 * existing extractedInfo on the deal.
 *
 * Rules:
 * - Field names are canonicalised first (see FIELD_ALIASES)
 * - Confirmed data overwrites everything
 * - Inferred data only overwrites if no confirmed data exists
 * - Approximate data only overwrites if the field is empty
 * - Null/undefined values are never written
 */
export function mergeExtractedFields(
  existing: Partial<ExtractedInfo>,
  newFields: Record<string, ExtractedField>,
  existingConfidence: Record<string, string>,
): {
  merged: Partial<ExtractedInfo>;
  updatedConfidence: Record<string, string>;
  changes: FieldChange[];
} {
  const merged = { ...existing };
  const updatedConfidence = { ...existingConfidence };
  const changes: FieldChange[] = [];

  for (const [rawFieldName, field] of Object.entries(newFields)) {
    if (!field.value) continue;
    const fieldName = canonicalFieldName(rawFieldName);

    const existingValue = merged[fieldName as keyof ExtractedInfo];
    const existingConf = existingConfidence[fieldName];

    // Determine if this new value should overwrite
    const shouldOverwrite = getShouldOverwrite(existingValue, existingConf, field.confidence);

    if (shouldOverwrite) {
      const change: FieldChange = {
        fieldName,
        previousValue: existingValue ?? null,
        previousConfidence: existingConf ?? null,
        newValue: field.value,
        newConfidence: field.confidence,
        source: field.source,
      };
      changes.push(change);

      (merged as Record<string, unknown>)[fieldName] = field.value;
      updatedConfidence[fieldName] = field.confidence;
    }
  }

  return { merged, updatedConfidence, changes };
}

/**
 * Builds or updates the IndustryContext from the AI's reasoning output.
 * Called after each turn — if the AI has identified the industry context,
 * we persist it so it's available on subsequent turns.
 */
export function updateIndustryContext(
  existing: IndustryContext | null,
  reasoning: InterviewReasoning,
  location: LocationContext | null,
): IndustryContext | null {
  if (!reasoning.industryContext.identified) {
    return existing;
  }

  // If we already have an industry context, update the topic lists.
  // Covered topics accumulate across turns (union) so the agent and the
  // broker UI both see what has already been handled.
  if (existing) {
    return {
      ...existing,
      industrySpecificAreas: reasoning.industryContext.activeIndustryTopics,
      coveredIndustryTopics: Array.from(new Set([
        ...(existing.coveredIndustryTopics ?? []),
        ...reasoning.industryContext.coveredIndustryTopics,
      ])),
      regulatoryNotes: reasoning.industryContext.regulatoryNotes,
    };
  }

  // First time identifying — create a new context
  return {
    industry: reasoning.industryContext.industry,
    subIndustry: reasoning.industryContext.subIndustry || null,
    location,
    industrySpecificAreas: reasoning.industryContext.activeIndustryTopics,
    coveredIndustryTopics: reasoning.industryContext.coveredIndustryTopics ?? [],
    regulatoryNotes: reasoning.industryContext.regulatoryNotes,
  };
}

// =====================
// Types
// =====================

export interface FieldChange {
  fieldName: string;
  previousValue: string | null;
  previousConfidence: string | null;
  newValue: string;
  newConfidence: string;
  source: string;
}

// =====================
// Internal helpers
// =====================

function getShouldOverwrite(
  existingValue: string | undefined | null,
  existingConfidence: string | undefined,
  newConfidence: string,
): boolean {
  // No existing value — always write
  if (!existingValue) return true;

  // Confidence hierarchy: confirmed > inferred > approximate
  const confidenceRank: Record<string, number> = {
    confirmed: 3,
    inferred: 2,
    approximate: 1,
  };

  const existingRank = confidenceRank[existingConfidence ?? "approximate"] ?? 0;
  const newRank = confidenceRank[newConfidence] ?? 0;

  // New data is same or higher confidence — overwrite
  return newRank >= existingRank;
}
