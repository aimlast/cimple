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
  // Document-extractor vocabulary (server/documents/extractor.ts) — the doc
  // pipeline routes its keys through canonicalFieldName too, so its emitted
  // names must land on the canonical spellings the coverage classifier and
  // the interview prompt read. Without these, document extractions were
  // invisible to coverage and the agent re-asked answered questions.
  totalEmployees: "employees",
  permits: "permitsLicenses",
  equipment: "assetsIncluded",
  propertyNotes: "propertyInfo",
  ownerHoursPerWeek: "ownerInvolvement",
  // Key-sprawl families observed in stress-test transcripts (pipeline vs
  // clientPipeline, capex vs capexRequirements, clientChurn vs
  // customerRetention vs logoRetention, four overlapping lottery fields,
  // atmRevenue vs ATMrevenue). Each family lands on one stable spelling.
  clientPipeline: "pipeline",
  salesPipeline: "pipeline",
  capex: "capexRequirements",
  capitalExpenditures: "capexRequirements",
  clientChurn: "customerRetention",
  customerChurn: "customerRetention",
  churnRate: "customerRetention",
  logoRetention: "customerRetention",
  clientRetention: "customerRetention",
  retentionRate: "customerRetention",
  lotteryCommission: "lotteryRevenue",
  lotterySales: "lotteryRevenue",
  lotteryIncome: "lotteryRevenue",
  atmIncome: "atmRevenue",
  insuranceCarrier: "insuranceCoverage",
  insuranceCarriers: "insuranceCoverage",
  insurancePolicies: "insuranceCoverage",
  clients: "customerBase",
  customers: "customerBase",
};

// Case-insensitive alias lookup — "ATMrevenue" and "atmRevenue" must resolve
// identically. Built once from FIELD_ALIASES (keys AND canonical values, so a
// wrong-cased canonical name still lands on the canonical spelling).
const LOWER_ALIAS_MAP: Record<string, string> = (() => {
  const map: Record<string, string> = {};
  for (const canonical of Object.values(FIELD_ALIASES)) {
    map[canonical.toLowerCase()] = canonical;
  }
  for (const [alias, canonical] of Object.entries(FIELD_ALIASES)) {
    map[alias.toLowerCase()] = canonical;
  }
  return map;
})();

/**
 * Resolve a field name to its canonical spelling (case-insensitive).
 *
 * When `existingKeys` is provided, a name that matches an existing
 * extractedInfo key case-insensitively reuses THAT key — so the model minting
 * "ATMrevenue" next to an existing "atmRevenue" merges instead of forking.
 */
export function canonicalFieldName(fieldName: string, existingKeys?: Iterable<string>): string {
  const direct = FIELD_ALIASES[fieldName];
  if (direct) return direct;
  const lower = fieldName.toLowerCase();
  const ciAlias = LOWER_ALIAS_MAP[lower];
  if (ciAlias) return ciAlias;
  if (existingKeys) {
    const match = Array.from(existingKeys).find((key) => key.toLowerCase() === lower);
    if (match) return match;
  }
  return fieldName;
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
    const fieldName = canonicalFieldName(rawFieldName, Object.keys(merged));

    const existingValue = merged[fieldName as keyof ExtractedInfo];
    const existingConf = existingConfidence[fieldName];

    // No-op suppression: an identical value at the same confidence is not a
    // change — recording it produced phantom updatedFields in the broker UI.
    if (
      existingValue !== undefined &&
      existingValue !== null &&
      String(existingValue) === field.value &&
      existingConf === field.confidence
    ) {
      continue;
    }

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
// Grounding guard
// =====================

/**
 * High-stakes fields where a fabricated "confirmed" value would put a false
 * claim into a CIM. Grounding is checked mechanically after every merge.
 */
export const HIGH_STAKES_FIELDS = new Set([
  "customerConcentration",
  "annualRevenue",
  "askingPrice",
  "operatingMargins",
  "revenueGrowth",
  "debt",
]);

/**
 * Typed numbers extracted from a field value, used to detect material
 * conflicts between a seller's verbal figure and a value already on file.
 * Only unambiguous kinds are compared:
 * - "currency": $-prefixed, magnitude-suffixed ("2.3M", "500k"), or ≥ 1000
 * - "percent": immediately followed by % / "percent"
 * Everything else (small counts like "top 5 clients", "3 major accounts")
 * is too ambiguous to compare and is dropped, as are bare year-like tokens
 * ("FY2023") which would otherwise mask or fake conflicts.
 */
export interface TypedNumber {
  value: number;
  kind: "currency" | "percent";
}

const MAGNITUDE: Record<string, number> = {
  k: 1_000, thousand: 1_000,
  m: 1_000_000, mm: 1_000_000, million: 1_000_000,
  b: 1_000_000_000, billion: 1_000_000_000,
};

export function typedNumericValues(text: string): TypedNumber[] {
  // Shared-suffix ranges ("1.5-2M", "$1.5 to 2 million") leave the first
  // bound bare — copy the suffix onto it so both parse at the right scale.
  const expanded = text.replace(
    /(\d+(?:\.\d+)?)(\s*(?:-|–|—|to)\s*)(\$?\s*\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|million|thousand|b|billion)\b/gi,
    (_, a, sep, b, suf) => `${a}${suf}${sep}${b}${suf}`,
  );
  const out: TypedNumber[] = [];
  // Suffix must end at a word boundary — without (?![a-z]) "3 major" parsed
  // as 3 million and "12 month lease" as 12 million (review-caught).
  const re = /(\$)?\s*([\d][\d,]*(?:\.\d+)?)\s*(k|mm?|million|thousand|b|billion)?(?![a-z0-9])\s*(%|percent\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(expanded)) !== null) {
    let n = parseFloat(m[2].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    const dollar = !!m[1];
    const suffix = (m[3] || "").toLowerCase();
    const pct = !!m[4];
    if (suffix) n *= MAGNITUDE[suffix] ?? 1;
    if (pct && !suffix) {
      out.push({ value: n, kind: "percent" });
      continue;
    }
    // Bare year-like tokens are labels, not quantities
    if (!dollar && !suffix && Number.isInteger(n) && n >= 1900 && n <= 2099) continue;
    if (dollar || suffix || n >= 1000) {
      out.push({ value: n, kind: "currency" });
    }
    // Small unadorned numbers ("top 5", "3 locations") are ignored
  }
  return out;
}

/** First comparable number in a string, or null when none present. */
export function firstNumericValue(text: string): number | null {
  const all = typedNumericValues(text);
  return all.length > 0 ? all[0].value : null;
}

/**
 * True when two field values materially disagree numerically: both contain
 * comparable numbers of the same kind, and NO same-kind pair is within the
 * tolerance. Two same-kind numbers on one side are treated as a range —
 * the other side's value landing inside (with tolerance) is agreement.
 */
export function numbersMateriallyConflict(a: string, b: string, tolerance = 0.1): boolean {
  const as = typedNumericValues(a);
  const bs = typedNumericValues(b);
  for (const kind of ["currency", "percent"] as const) {
    const xs = as.filter((t) => t.kind === kind).map((t) => t.value);
    const ys = bs.filter((t) => t.kind === kind).map((t) => t.value);
    if (xs.length === 0 || ys.length === 0) continue;
    const close = (x: number, y: number) => {
      const base = Math.max(Math.abs(x), Math.abs(y));
      return base === 0 || Math.abs(x - y) / base <= tolerance;
    };
    const inRange = (v: number, range: number[]) =>
      range.length === 2 &&
      v >= Math.min(...range) * (1 - tolerance) &&
      v <= Math.max(...range) * (1 + tolerance);
    const anyAgreement =
      xs.some((x) => ys.some((y) => close(x, y))) ||
      xs.some((x) => inRange(x, ys)) ||
      ys.some((y) => inRange(y, xs));
    if (!anyAgreement) return true;
  }
  return false;
}

// Spelled-out quantities parsed to values ("forty" → 40, "two million" →
// 2,000,000) so the fidelity guard can legitimize model-normalized figures
// ("forty percent" spoken → "40%" captured). Simple sequences only.
const SPELLED_UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70,
  eighty: 80, ninety: 90, half: 0.5, quarter: 0.25,
};
const SPELLED_MAGS: Record<string, number> = {
  hundred: 100, thousand: 1_000, million: 1_000_000, billion: 1_000_000_000,
};

export function spelledNumbers(text: string): number[] {
  // Proper additive composition: "six hundred eighteen thousand" → 618,000
  // (a naive per-word walk yielded [600, 18000] and falsely flagged the
  // correctly captured $618,000 — QA-caught). Standard accumulator: units
  // add, "hundred" multiplies the running group, big magnitudes bank it.
  const words = text.toLowerCase().split(/[^a-z0-9.]+/);
  const out: number[] = [];
  let current = 0;
  let total = 0;
  let inNumber = false;
  const flush = () => {
    if (inNumber && total + current > 0) out.push(total + current);
    current = 0;
    total = 0;
    inNumber = false;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const unit = SPELLED_UNITS[w];
    const isDigit = /^\d+(?:\.\d+)?$/.test(w);
    if (unit !== undefined) {
      current += unit;
      inNumber = true;
    } else if (isDigit) {
      // Digit tokens only participate when a magnitude word follows
      // ("1.2 million"); bare digits are handled by the caller's tokenizer.
      flush();
      if (SPELLED_MAGS[words[i + 1]] !== undefined) {
        current = parseFloat(w);
        inNumber = true;
      }
    } else if (w === "hundred" && inNumber) {
      current = (current || 1) * 100;
    } else if (SPELLED_MAGS[w] !== undefined && w !== "hundred" && inNumber) {
      total += (current || 1) * SPELLED_MAGS[w];
      current = 0;
    } else if (w === "and" && inNumber) {
      continue; // "one hundred and forty"
    } else {
      flush();
    }
  }
  flush();
  return out;
}

// Quantities can be spelled out ("one-point-one million", "half", "forty percent")
const SPELLED_QUANTITY_RE =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|dozen|half|third|quarter|percent|point)\b/i;

/** True when text plausibly contains a quantity (digits or spelled numbers). */
function containsQuantity(text: string): boolean {
  return /\d/.test(text) || SPELLED_QUANTITY_RE.test(text);
}

// Values that assert an absence/negative claim (e.g. "no single customer
// exceeds 20%") — the classic fabricated-diversification pattern.
const NEGATIVE_ASSERTION_RE =
  /\b(no (single|one|customer|client|gc|supplier)|none of (our|the)|does ?n[o']t exceed|not exceed|no concentration|diversified|well[- ]diversified)\b/i;

const NEGATION_RE = /\b(no|not|none|nothing|never|nobody|isn't|doesn't|don't|aren't|won't)\b/i;

export interface GroundingFlag {
  fieldName: string;
  reason: string;
}

/**
 * Post-merge grounding check for high-stakes writes sourced from the seller's
 * turn. If the model wrote a value asserting a quantity the seller's message
 * doesn't contain (or a negative claim the seller never negated), the write is
 * downgraded to "approximate" confidence and flagged so the caller can queue
 * the topic on the deferral ledger for a proper circle-back.
 *
 * Mutates `updatedConfidence` in place (the merged value itself is kept — it
 * may still be a useful lead — but it can never masquerade as confirmed).
 */
export function applyGroundingGuard(
  changes: FieldChange[],
  updatedConfidence: Record<string, string>,
  sellerMessage: string,
): GroundingFlag[] {
  const flags: GroundingFlag[] = [];
  const sellerHasQuantity = containsQuantity(sellerMessage);

  for (const change of changes) {
    if (!HIGH_STAKES_FIELDS.has(change.fieldName)) continue;
    if (change.source !== "seller_statement") continue;
    if (change.newConfidence !== "confirmed") continue;

    const valueAssertsQuantity = /\d/.test(change.newValue);
    const valueAssertsNegative = NEGATIVE_ASSERTION_RE.test(change.newValue);
    const sellerNegated = NEGATION_RE.test(sellerMessage);

    let reason: string | null = null;
    if (valueAssertsQuantity && !sellerHasQuantity) {
      reason = `value asserts a number but the seller's message contains none`;
    } else if (valueAssertsNegative && !sellerNegated) {
      reason = `value asserts a negative claim the seller never made`;
    }

    if (reason) {
      updatedConfidence[change.fieldName] = "approximate";
      change.newConfidence = "approximate";
      flags.push({ fieldName: change.fieldName, reason });
    }
  }

  return flags;
}

/**
 * NUMERIC-FIDELITY GUARD — the grounding guard's sibling, covering ALL fields
 * (not just high-stakes ones). A "confirmed" seller-statement write must not
 * contain numbers the seller didn't say: observed in live QA, a seller's
 * "$6,000 up to $14,000" was stored as "$4,000 up to $18,000" confirmed.
 * Every comparable number in the value must match a number in the seller's
 * message (or carry over from the previous value); otherwise the write is
 * downgraded to approximate and flagged for reconciliation. Skipped when the
 * seller's message contains no digits (spelled-out quantities are handled
 * leniently — the grounding guard already polices pure fabrication).
 */
export function applyNumericFidelityGuard(
  changes: FieldChange[],
  updatedConfidence: Record<string, string>,
  sellerMessage: string,
  /** The previous turn's suggestedAnswers — an unmatched number that matches
   *  a chip is the chip-anchoring bug (typed "$2M" captured as the chip's
   *  "$1.5M") and gets named explicitly so the agent recaptures correctly. */
  priorChips: string[] = [],
): GroundingFlag[] {
  const flags: GroundingFlag[] = [];
  // Strict typed extraction on the CLAIMED side; permissive on the SPOKEN
  // side. The model normalizes units the seller left bare ("food cost runs
  // 32" → "32%", "about 1.2" → "$1.2M"), so every bare digit token in the
  // message legitimizes its value at any standard magnitude. Only when the
  // seller gave typed (currency/percent) figures do we enforce at all —
  // spelled-out quantities ("two million") stay the grounding guard's job.
  const spokenTyped = typedNumericValues(sellerMessage).map((t) => t.value);
  const spokenSpelled = spelledNumbers(sellerMessage);
  const bareTokens: number[] = [];
  for (const m of Array.from(sellerMessage.matchAll(/\d[\d,]*(?:\.\d+)?/g))) {
    const n = parseFloat(m[0].replace(/,/g, ""));
    if (!Number.isNaN(n)) bareTokens.push(n);
  }
  if (spokenTyped.length === 0 && spokenSpelled.length === 0 && bareTokens.length === 0) {
    return flags;
  }
  const MAGNITUDES = [1, 1_000, 1_000_000, 1_000_000_000];
  const close = (a: number, b: number) => {
    const base = Math.max(Math.abs(a), Math.abs(b));
    return base === 0 || Math.abs(a - b) / base <= 0.01;
  };

  for (const change of changes) {
    if (change.source !== "seller_statement") continue;
    if (change.newConfidence !== "confirmed") continue;
    const claimed = typedNumericValues(change.newValue).map((t) => t.value);
    if (claimed.length === 0) continue;
    const carried = change.previousValue
      ? typedNumericValues(String(change.previousValue)).map((t) => t.value)
      : [];
    const matches = (n: number) =>
      [...spokenTyped, ...spokenSpelled, ...carried].some((s) => close(n, s)) ||
      [...bareTokens, ...spokenSpelled].some((b) =>
        MAGNITUDES.some((mag) => close(n, b * mag)),
      ) ||
      // Arithmetic complements: "80% is recurring, the rest is seasonal"
      // legitimizes a derived 20% — flagging strictly-implied percentages
      // just pollutes the ledger with verify-noise.
      (n > 0 &&
        n < 100 &&
        [...spokenTyped, ...spokenSpelled, ...bareTokens].some(
          (s) => s > 0 && s < 100 && Math.abs(n - (100 - s)) <= 1,
        ));
    const unmatched = claimed.filter((n) => !matches(n));
    if (unmatched.length > 0) {
      updatedConfidence[change.fieldName] = "approximate";
      change.newConfidence = "approximate";
      const chipNumbers = typedNumericValues(priorChips.join(" | ")).map((t) => t.value);
      const fromChip = unmatched.some((n) => chipNumbers.some((c) => close(n, c)));
      flags.push({
        fieldName: change.fieldName,
        reason: fromChip
          ? `the captured value matches an ANSWER CHIP from the previous question, not the seller's words (${unmatched.slice(0, 3).join(", ")}) — recapture the figure the seller actually stated`
          : `value contains number(s) not present in the seller's message (${unmatched.slice(0, 3).join(", ")})`,
      });
    }
  }

  return flags;
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
