import type { ExtractedInfo } from "@shared/schema";
import { SOURCE_KINDS, type SourceKind } from "@shared/schema";
import { sameNoteContent, isHousekeepingNote } from "@shared/private-notes";
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
  /**
   * The value only restates the figure already on file (the change's
   * previous value) — nothing new, nothing fabricated. The caller drops the
   * change instead of downgrading it; confidence is left untouched.
   */
  restatement?: boolean;
  change?: FieldChange;
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
      if (restatesPreviousFigure(change)) {
        flags.push({ fieldName: change.fieldName, reason: "restates the figure already on file", restatement: true, change });
        continue;
      }
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
 * True when every typed figure in the change's new value is a figure its
 * previous value already states (same amount within 1%) — the model
 * repeating what is on file, e.g. "$1.2M" for "$1,200,000".
 */
function restatesPreviousFigure(change: FieldChange): boolean {
  if (change.previousValue === null || change.previousValue === undefined) return false;
  const claimed = typedNumericValues(change.newValue).map((t) => t.value);
  const onFile = typedNumericValues(String(change.previousValue)).map((t) => t.value);
  if (claimed.length === 0 || onFile.length === 0) return false;
  const close = (a: number, b: number) => {
    const base = Math.max(Math.abs(a), Math.abs(b));
    return base === 0 || Math.abs(a - b) / base <= 0.01;
  };
  return claimed.every((n) => onFile.some((f) => close(n, f)));
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

// ── Field provenance (v2) ──────────────────────────────────────────────
// Who asserted each extractedInfo value, and exactly where. Lives under
// underscore keys so it is excluded from every CIM/analysis path.
//
// Authority (higher wins): broker 7 > interview 6 > call 5 = video_call 5 >
// questionnaire 4 = email 4 > document 3 > crm 2 > website 1 = social 1 >
// system 0. An unknown kind ranks 0 (never NaN). The broker's own edit is
// final; the seller's words outrank anything a model read; second-hand notes
// (CRM) and public marketing (website, social) rank lowest.
//
// Old entries ({source:"interview"|"questionnaire"|"document", documentId?,
// years?}) are a strict subset of this shape and read unchanged.
export type { SourceKind };
export { SOURCE_KINDS };
/** @deprecated use SourceKind — kept so older imports keep compiling. */
export type FieldSourceKind = SourceKind;

export interface FieldSource {
  source: SourceKind;
  /** The documents row (document, email, call transcript, CRM note, …) that asserted it. */
  documentId?: string;
  /** Map fields (revenueByYear): which document asserted each sub-key. */
  years?: Record<string, string>;
  /** Interview / call session that captured it, and the seller turn number. */
  sessionId?: string;
  turn?: number;
  /** ISO timestamp of the write. */
  at?: string;
  /** Short human note ("Resolved discrepancy", "Accepted from website"). */
  note?: string;
  /** The words the value came from, when known. */
  excerpt?: string;
  /**
   * The broker explicitly accepted this value into the facts ("Accept into
   * facts" on a website claim): the kind still ranks as its source, but the
   * broker vouched for it, so CIM writers treat it as a fact, not a lead.
   */
  acceptedByBroker?: boolean;
}
export const FIELD_SOURCES_KEY = "_fieldSources";
export const FIELD_ALTERNATES_KEY = "_fieldAlternates";
/**
 * Other sources that state the SAME value as the one on file, keyed like
 * alternates ("annualRevenue", or "revenueByYear.2024" for one year). When
 * the recorded source is deleted, a surviving corroboration takes over and
 * the fact stays — two agreeing sources never depend on one of them.
 */
export const FIELD_CORROBORATIONS_KEY = "_fieldCorroborations";
/** Note on a source entry that stands for a value recorded before sources were tracked. */
export const LEGACY_SOURCE_NOTE = "Recorded before sources were tracked";
/** Note the website "Accept into facts" action writes (re-exported as WEBSITE_ACCEPTED_NOTE by information/cim-facts). */
export const WEBSITE_ACCEPTED_SOURCE_NOTE = "Accepted by you from the website";

/**
 * Per-source notes the extractor records (summaries, call logistics, red
 * flags, to-dos). About a source rather than the business: they stay on the
 * source row (documents.extractedData, shown in the Sources panel) and are
 * never deal-level facts, never CIM input, never interview "known facts".
 */
export const SOURCE_META_KEYS: ReadonlySet<string> = new Set([
  "summary", "keyFacts", "redFlags", "callNotes", "sellerConcerns", "actionItems",
  "buyerInterests", "followUpNeeded", "keyTopics", "callDate", "callDuration", "callParticipants",
]);

/** True for extractedInfo keys that are real business facts (not "_" bookkeeping, not per-source notes). */
export function isFactKey(key: string): boolean {
  return !key.startsWith("_") && !SOURCE_META_KEYS.has(key);
}
/** Keys the broker deleted — merges from non-broker sources skip them. */
export const BROKER_SUPPRESSED_KEY = "_brokerSuppressed";

export const SOURCE_RANK: Record<SourceKind, number> = {
  broker: 7,
  interview: 6,
  call: 5,
  video_call: 5,
  questionnaire: 4,
  email: 4,
  document: 3,
  crm: 2,
  website: 1,
  social: 1,
  system: 0,
};

export function isSourceKind(kind: unknown): kind is SourceKind {
  return typeof kind === "string" && (SOURCE_KINDS as readonly string[]).includes(kind);
}

/** Authority of a source kind; anything unknown (or missing) ranks 0. */
export function sourceRank(kind: unknown): number {
  return isSourceKind(kind) ? SOURCE_RANK[kind] : 0;
}

/**
 * Kinds that are never a documents row — the broker's own edit, the live
 * interview, the intake form, the system. A source of one of these kinds
 * never "belongs" to a document, whatever documentId an older bug stamped
 * on it, so deleting a document can't take its value away.
 */
const NON_ROW_KINDS: ReadonlySet<string> = new Set(["broker", "interview", "questionnaire", "system"]);

/** True when this source entry was asserted by a documents row (document, email, transcript, CRM note, …). */
export function isRowBackedSource(src: Partial<FieldSource> | null | undefined): boolean {
  return !!src && !!src.documentId && !NON_ROW_KINDS.has(String(src.source));
}

/** A value with no recorded source, or one explicitly marked as recorded before tracking. */
export function isUntrackedSource(src: Partial<FieldSource> | null | undefined): boolean {
  return !src || (src.source === "system" && src.note === LEGACY_SOURCE_NOTE);
}

/** True for kinds that are the seller speaking live (typed or spoken). */
export function isLiveSellerKind(kind: unknown): boolean {
  return kind === "interview" || kind === "call" || kind === "video_call";
}

const KIND_LABEL: Record<SourceKind, string> = {
  interview: "Seller interview",
  call: "Call",
  video_call: "Video call",
  questionnaire: "Questionnaire",
  email: "Email",
  document: "Document",
  crm: "CRM note",
  website: "Website",
  social: "Social media",
  broker: "Broker edit",
  system: "System",
};

function shortDate(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/**
 * One-line, broker-facing description of a fact's source:
 * "Seller interview · turn 12", "Document · 2024 Compilation.pdf",
 * "Email · Mar 3", "CRM note", "Website", "Broker edit · Sep 24".
 * `documentName` resolves a documentId to the source's title.
 */
export function describeSource(
  src: Partial<FieldSource> | null | undefined,
  documentName?: (id: string) => string | undefined,
): string {
  if (!src || !isSourceKind(src.source)) return "Source not recorded";
  const kind = src.source;
  const base = KIND_LABEL[kind];
  const name = src.documentId && documentName ? documentName(src.documentId) : undefined;
  switch (kind) {
    case "interview":
    case "call":
    case "video_call":
      if (name) return `${base} · ${name}`;
      return typeof src.turn === "number" ? `${base} · turn ${src.turn}` : base;
    case "email": {
      const when = shortDate(src.at);
      return name ? `${base} · ${name}` : when ? `${base} · ${when}` : base;
    }
    case "website":
    case "social":
    case "crm":
      // The broker vouched for it ("Accept into facts") — say so, not just "Website".
      if (src.acceptedByBroker || src.note === WEBSITE_ACCEPTED_SOURCE_NOTE) return `${name ? `${base} · ${name}` : base} · accepted by you`;
      return name ? `${base} · ${name}` : base;
    case "broker": {
      const when = shortDate(src.at);
      return src.note ? `${base} · ${src.note}` : when ? `${base} · ${when}` : base;
    }
    default:
      return name ? `${base} · ${name}` : base;
  }
}

export function getFieldSources(info: Record<string, unknown>): Record<string, FieldSource> {
  const raw = info[FIELD_SOURCES_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, FieldSource>) : {};
}
export function setFieldSource(info: Record<string, unknown>, key: string, src: FieldSource): void {
  info[FIELD_SOURCES_KEY] = { ...getFieldSources(info), [key]: src };
}

export function getSuppressedKeys(info: Record<string, unknown>): string[] {
  const raw = info[BROKER_SUPPRESSED_KEY];
  return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === "string") : [];
}
/** True when the broker deleted this fact — only the broker (or the seller, live) may bring it back. */
export function isSuppressed(info: Record<string, unknown>, key: string): boolean {
  const base = key.includes(".") ? key.slice(0, key.indexOf(".")) : key;
  return getSuppressedKeys(info).includes(base);
}

/** True when an incoming write of kind `incoming` may replace the current value of `key`. */
export function sourceAllowsOverwrite(info: Record<string, unknown>, key: string, incoming: SourceKind): boolean {
  if (incoming !== "broker" && isSuppressed(info, key)) return false;
  const cur = getFieldSources(info)[key];
  // Untracked legacy value (captured before provenance existed): it was most
  // likely the seller's own interview answer, so only a fresh interview
  // statement (or the broker) may replace it — never a document, a call
  // transcript or the older intake form.
  if (isUntrackedSource(cur)) return sourceRank(incoming) >= SOURCE_RANK.interview;
  return sourceRank(incoming) >= sourceRank(cur.source);
}

export interface FieldAlternate extends FieldSource {
  /** The losing value — JSON-stringified when it wasn't a string. */
  value: string;
}

export function getFieldAlternates(info: Record<string, unknown>): Record<string, FieldAlternate[]> {
  const raw = info[FIELD_ALTERNATES_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, FieldAlternate[]>) : {};
}

/** Stored form of a value in alternates / corroborations (objects are JSON). */
export function serializeFactValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

/**
 * Identity of the source behind an alternate or corroboration: the documents
 * row when there is one, else the kind (+ session). Two different sources
 * stating the same value are both kept — deleting one must not take the
 * other's word with it.
 */
function originKey(src: Partial<FieldSource>): string {
  return src.documentId ? `doc:${src.documentId}` : `${String(src.source ?? "")}:${src.sessionId ?? ""}`;
}

/** Records a value that lost the precedence contest so nothing is silently discarded. */
export function recordAlternate(info: Record<string, unknown>, key: string, value: unknown, src: FieldSource): void {
  if (value === null || value === undefined || value === "") return;
  const alts = { ...getFieldAlternates(info) } as Record<string, unknown[]>;
  const list = Array.isArray(alts[key]) ? [...(alts[key] as unknown[])] : [];
  // A legacy character-indexed map is stored repaired, never as the soup.
  const serialized = serializeFactValue(repairCharIndexedValue(value));
  const origin = originKey(src);
  const { value: _drop, ...cleanSrc } = src as FieldSource & { value?: unknown };
  if (!list.some((a) => (a as FieldAlternate).value === serialized && originKey(a as FieldAlternate) === origin)) {
    list.push({ ...cleanSrc, value: serialized });
  }
  alts[key] = list;
  info[FIELD_ALTERNATES_KEY] = alts;
}

export function getFieldCorroborations(info: Record<string, unknown>): Record<string, FieldAlternate[]> {
  const raw = info[FIELD_CORROBORATIONS_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, FieldAlternate[]>) : {};
}

function setCorroborations(info: Record<string, unknown>, key: string, list: FieldAlternate[]): void {
  const all = { ...getFieldCorroborations(info) };
  if (list.length > 0) all[key] = list;
  else delete all[key];
  if (Object.keys(all).length > 0) info[FIELD_CORROBORATIONS_KEY] = all;
  else delete info[FIELD_CORROBORATIONS_KEY];
}

function addCorroboration(info: Record<string, unknown>, key: string, value: string, src: FieldSource): void {
  const { value: _drop, ...cleanSrc } = src as FieldSource & { value?: unknown };
  const existing = getFieldCorroborations(info)[key] ?? [];
  if (existing.some((c) => originKey(c) === originKey(cleanSrc) && c.value === value)) return; // already on record
  const list = existing.filter((c) => originKey(c) !== originKey(cleanSrc));
  list.push({ ...cleanSrc, value });
  setCorroborations(info, key, list);
}

/**
 * Another source states exactly the value already on file for `key` (a fact
 * key, or "map.subKey" for one year of a map fact — pass `current` and
 * `recorded` then). The higher-ranked of the two becomes the recorded source
 * and the other is kept as a corroboration, so deleting either one leaves
 * the fact standing. An untracked legacy value is left untracked (never
 * re-labelled).
 */
export function noteSameValue(
  info: Record<string, unknown>,
  key: string,
  src: FieldSource,
  opts: { current?: unknown; recorded?: FieldSource | null; setRecorded?: (s: FieldSource) => void } = {},
): void {
  const cur = opts.recorded !== undefined ? opts.recorded : getFieldSources(info)[key];
  if (isUntrackedSource(cur)) return;
  if (originKey(cur!) === originKey(src)) return; // the same source re-read
  const value = serializeFactValue(repairCharIndexedValue(opts.current !== undefined ? opts.current : info[key]));
  if (sourceRank(src.source) > sourceRank(cur!.source)) {
    if (opts.setRecorded) opts.setRecorded(src);
    else setFieldSource(info, key, src);
    addCorroboration(info, key, value, cur!);
  } else {
    addCorroboration(info, key, value, src);
  }
}

/**
 * The value of `key` was replaced: every corroboration that stated the OLD
 * value is now a differing value, so it moves to the alternates (nothing is
 * lost); those that happen to state the new value stay corroborations.
 */
export function displaceCorroborations(info: Record<string, unknown>, key: string, newValue: unknown): void {
  const list = getFieldCorroborations(info)[key];
  if (!list || list.length === 0) return;
  const now = serializeFactValue(repairCharIndexedValue(newValue));
  const keep: FieldAlternate[] = [];
  for (const c of list) {
    if (c.value === now) keep.push(c);
    else {
      const { value, ...src } = c;
      recordAlternate(info, key, parseAlternateValue(value), src as FieldSource);
    }
  }
  setCorroborations(info, key, keep);
}

/**
 * Legacy repair: an old merge bug spread a string into an object, leaving
 * values like {"0":"{","1":"\"","2":"2",…} on some deals (seen on
 * revenueByYear). Rebuilds the original string — and parses it back into a
 * map when it was JSON — so readers never show the character soup.
 */
export function repairCharIndexedValue(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const map = value as Record<string, unknown>;
  const indexed: string[] = [];
  for (let i = 0; Object.prototype.hasOwnProperty.call(map, String(i)); i++) {
    const ch = map[String(i)];
    if (typeof ch !== "string" || ch.length > 1) return value;
    indexed.push(ch);
  }
  if (indexed.length < 2) return value;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(map)) if (!/^\d+$/.test(k) || Number(k) >= indexed.length) rest[k] = v;
  const text = indexed.join("");
  let repaired: unknown = text;
  if (/^[\[{]/.test(text)) {
    try { repaired = JSON.parse(text); } catch { /* keep the text */ }
  }
  if (Object.keys(rest).length === 0) return repaired;
  return repaired && typeof repaired === "object" && !Array.isArray(repaired) ? { ...(repaired as object), ...rest } : rest;
}

/** Parses an alternate's stored value back (objects were JSON-stringified). */
export function parseAlternateValue(value: string): unknown {
  if (/^[\[{]/.test(value)) {
    try { return JSON.parse(value); } catch { /* keep string */ }
  }
  return value;
}

/** Merges two alternates (or corroborations) maps key by key (union by value + source) — no list is lost. */
export function mergeAlternateMaps(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const src of [a || {}, b || {}]) {
    for (const [k, list] of Object.entries(src)) {
      if (!Array.isArray(list)) continue;
      const cur = out[k] ?? [];
      for (const entry of list) {
        const e = entry as FieldAlternate;
        if (!cur.some((c) => (c as FieldAlternate).value === e.value && originKey(c as FieldAlternate) === originKey(e))) cur.push(entry);
      }
      out[k] = cur;
    }
  }
  return out;
}

/**
 * Removes every field (and alternate) that a deleted source asserted — any
 * documents-backed kind (document, email, call / video-call transcript, CRM
 * note, website/social item) — then:
 * - a surviving source that stated the SAME value (a corroboration) takes
 *   over and the fact stays (a CRM re-import retiring the old version of a
 *   note keeps every fact the new version repeats);
 * - otherwise the best surviving alternate is promoted.
 * The broker's own values, interview answers and intake answers are never
 * removed, even when an older merge bug stamped a documentId on their
 * source. Broker-private notes that came from the source go too.
 * `changed` is true whenever anything was cleaned up — callers must save
 * then, even when no field was removed (e.g. only alternates were dropped).
 */
export function removeDocumentFields(
  info: Record<string, unknown>,
  documentId: string,
): { info: Record<string, unknown>; removed: string[]; changed: boolean } {
  const out = { ...info };
  const sources = { ...getFieldSources(out) };
  const corr: Record<string, FieldAlternate[]> = { ...getFieldCorroborations(out) };
  const removed: string[] = [];
  let changed = false;

  /** Best surviving corroboration of `corrKey` stating `serialized` — taken off its list. */
  const takeCorroboration = (corrKey: string, serialized: string): FieldAlternate | null => {
    const list = (corr[corrKey] ?? []).filter((c) => c.documentId !== documentId);
    const candidates = list.filter((c) => c.value === serialized);
    if (candidates.length === 0) return null;
    const best = [...candidates].sort((a, b) => sourceRank(b.source) - sourceRank(a.source))[0];
    corr[corrKey] = list.filter((c) => c !== best);
    return best;
  };

  for (const [key, src] of Object.entries(sources)) {
    const ownsWhole = isRowBackedSource(src) && src.documentId === documentId;
    // Map field with per-sub-key contributors: strip only this document's
    // years (unlisted years belong to the recorded source).
    if (src.years && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) {
      const map = { ...(repairCharIndexedValue(out[key]) as Record<string, unknown>) };
      const years = { ...src.years };
      let touched = false;
      // Only years whose figure actually went count as removed — a year
      // another source also stated stays on file under that source.
      let yearRemoved = false;
      for (const y of Object.keys(map)) {
        const contributor = years[y] ?? (ownsWhole ? documentId : undefined);
        if (contributor !== documentId) continue;
        touched = true;
        const other = takeCorroboration(`${key}.${y}`, serializeFactValue(map[y]));
        if (other) {
          // Another source gave the same figure for this year — it stays.
          if (other.documentId) years[y] = other.documentId;
          else delete years[y];
          continue;
        }
        delete map[y];
        delete years[y];
        yearRemoved = true;
      }
      for (const [y, docId] of Object.entries(years)) if (docId === documentId && !(y in map)) delete years[y];
      if (!touched) {
        if (src.documentId === documentId) { sources[key] = stripDocumentId(src); changed = true; }
        continue;
      }
      changed = true;
      if (Object.keys(map).length === 0) { delete out[key]; delete sources[key]; removed.push(key); continue; }
      out[key] = map;
      const next: FieldSource = { ...src, years };
      if (Object.keys(years).length === 0) delete next.years;
      if (src.documentId === documentId) {
        const remaining = Object.values(years);
        if (ownsWhole && remaining[0]) next.documentId = remaining[0];
        else delete next.documentId;
      }
      sources[key] = next;
      if (yearRemoved) removed.push(`${key}:${documentId}`);
      continue;
    }
    if (src.documentId !== documentId) continue;
    changed = true;
    if (!ownsWhole) {
      // A broker edit / interview answer carrying a stray documentId (older
      // merge bug): the value is not the document's — keep it, drop the link.
      sources[key] = stripDocumentId(src);
      continue;
    }
    const other = out[key] !== undefined && out[key] !== null
      ? takeCorroboration(key, serializeFactValue(repairCharIndexedValue(out[key])))
      : null;
    if (other) {
      const { value: _v, ...otherSrc } = other;
      sources[key] = otherSrc as FieldSource;
      continue;
    }
    delete out[key];
    delete sources[key];
    removed.push(key);
  }
  out[FIELD_SOURCES_KEY] = sources;

  // The deleted source's corroborations are gone everywhere.
  const cleanCorr: Record<string, FieldAlternate[]> = {};
  for (const [k, list] of Object.entries(corr)) {
    const kept = (Array.isArray(list) ? list : []).filter((c) => c.documentId !== documentId);
    if (kept.length > 0) cleanCorr[k] = kept;
  }
  if (JSON.stringify(cleanCorr) !== JSON.stringify(getFieldCorroborations(info))) changed = true;
  if (Object.keys(cleanCorr).length > 0) out[FIELD_CORROBORATIONS_KEY] = cleanCorr;
  else delete out[FIELD_CORROBORATIONS_KEY];

  const rawAlts = out[FIELD_ALTERNATES_KEY];
  if (rawAlts && typeof rawAlts === "object" && !Array.isArray(rawAlts)) {
    const alts: Record<string, unknown[]> = {};
    for (const [k, list] of Object.entries(rawAlts as Record<string, unknown[]>)) {
      const kept = (Array.isArray(list) ? list : []).filter((a) => (a as { documentId?: string }).documentId !== documentId);
      if (kept.length > 0) alts[k] = kept;
    }
    if (JSON.stringify(alts) !== JSON.stringify(rawAlts)) changed = true;
    // Promote the best surviving alternate for every field this delete
    // emptied, so a second P&L's revenue figure steps in instead of the
    // field going blank and the interview re-asking it.
    for (const key of removed) {
      if (key.includes(":") || out[key] !== undefined) continue;
      if (isSuppressed(out, key)) continue;
      const list = alts[key] as FieldAlternate[] | undefined;
      if (!list || list.length === 0) continue;
      const best = [...list].sort((a, b) => sourceRank(b.source) - sourceRank(a.source))[0];
      const { value, ...bestSrc } = best;
      out[key] = parseAlternateValue(value);
      sources[key] = bestSrc as FieldSource;
      alts[key] = list.filter((a) => a !== best);
      if ((alts[key] as unknown[]).length === 0) delete alts[key];
    }
    out[FIELD_SOURCES_KEY] = sources;
    out[FIELD_ALTERNATES_KEY] = alts;
  }

  // Broker-private notes the deleted source contributed (CRM notes, emails).
  // A note another source also states (a re-imported CRM note, the seller in
  // the interview) stays, credited to that source.
  if (removePrivateNoteSource(out, documentId)) changed = true;
  if (removed.length > 0) changed = true;
  return { info: out, removed, changed };
}

// ─── Broker-private notes ────────────────────────────────────────────────────
// `_brokerPrivateNotes`: sensitive matters (health, family, the broker's own
// negotiation notes) kept out of every CIM path. Each note records every
// source that stated it — the first on the entry itself (documentId / reason
// / turn / brokerOnly, the shape older rows already have), others in
// `alsoFrom` — so deleting or re-importing one source never drops a note
// another source still states.

export const BROKER_PRIVATE_NOTES_KEY = "_brokerPrivateNotes";

/** One source of a broker-private note. No documentId = the seller said it in a session. */
export interface PrivateNoteSource {
  /** The documents row (CRM note, email, transcript…) it came from. */
  documentId?: string;
  /** From a broker-only source: the broker's own note, never the agent's. */
  brokerOnly?: boolean;
  reason?: string;
  /** Interview turn it was recorded on. */
  turn?: number;
  /** The seller typed it in the intake questionnaire. */
  questionnaire?: boolean;
}

export interface BrokerPrivateNote extends PrivateNoteSource {
  note: string;
  /** Other sources that state the same note. */
  alsoFrom?: PrivateNoteSource[];
}

const SOURCE_FIELDS = ["documentId", "brokerOnly", "reason", "turn", "questionnaire"] as const;

function pickNoteSource(n: PrivateNoteSource): PrivateNoteSource {
  const out: PrivateNoteSource = {};
  for (const f of SOURCE_FIELDS) if (n[f] !== undefined && n[f] !== null) (out as Record<string, unknown>)[f] = n[f];
  return out;
}

/** Same note, however the extractor punctuated or capitalised it. */
export function privateNoteText(note: string): string {
  return note.toLowerCase().replace(/\s+/g, " ").replace(/[.!\s]+$/, "").trim();
}

/** One identity per source: the document, the intake questionnaire, or the seller's own sessions. */
function noteSourceId(s: PrivateNoteSource): string {
  return s.documentId ? `doc:${s.documentId}` : s.questionnaire ? "questionnaire" : "session";
}

/** A (note, source) pair's identity — what a turn save compares against the snapshot. */
export function privateNoteSourceKey(note: string, s: PrivateNoteSource): string {
  return `${privateNoteText(note)}|${noteSourceId(s)}`;
}

export function getPrivateNotes(info: Record<string, unknown>): BrokerPrivateNote[] {
  const raw = info[BROKER_PRIVATE_NOTES_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((n): n is BrokerPrivateNote => !!n && typeof (n as BrokerPrivateNote).note === "string");
}

/** Every source of a note, the entry's own first. */
export function privateNoteSources(n: BrokerPrivateNote): PrivateNoteSource[] {
  return [pickNoteSource(n), ...(Array.isArray(n.alsoFrom) ? n.alsoFrom.map(pickNoteSource) : [])];
}

function withSources(n: BrokerPrivateNote, sources: PrivateNoteSource[]): BrokerPrivateNote {
  const rest: Record<string, unknown> = { ...n };
  for (const f of SOURCE_FIELDS) delete rest[f];
  delete rest.alsoFrom;
  return {
    ...(rest as { note: string }),
    ...sources[0],
    ...(sources.length > 1 ? { alsoFrom: sources.slice(1) } : {}),
  };
}

/**
 * Records `note` from `src` on `info` (mutates). A note already on file that
 * says the same thing — the same text, or the same content in other words
 * (sameNoteContent: "Owner had a cardiac event in 2024" / "Seller disclosed a
 * 2024 heart event") — gains `src` as another source instead of a second
 * entry; the old skip left the note depending on its first source alone.
 * Returns true when anything changed.
 */
export function addPrivateNote(info: Record<string, unknown>, note: string, src: PrivateNoteSource): boolean {
  const text = note.trim();
  if (!text || isHousekeepingNote(text)) return false; // "Sample document — fictional business" is not a note
  const notes = getPrivateNotes(info);
  const key = privateNoteText(text);
  let idx = notes.findIndex((n) => privateNoteText(n.note) === key);
  // A restatement merges only with a note worded by the same side: the note
  // keeps its first source's words, and a broker-only CRM note's wording
  // must never become what the seller-side (interview) view shows.
  if (idx === -1) idx = notes.findIndex((n) => !!n.brokerOnly === !!src.brokerOnly && sameNoteContent(n.note, text));
  const source = pickNoteSource(src);
  if (idx === -1) {
    info[BROKER_PRIVATE_NOTES_KEY] = [...notes, { note: text, ...source }];
    return true;
  }
  const sources = privateNoteSources(notes[idx]);
  if (sources.some((s) => noteSourceId(s) === noteSourceId(source))) return false;
  const next = [...notes];
  next[idx] = withSources(notes[idx], [...sources, source]);
  info[BROKER_PRIVATE_NOTES_KEY] = next;
  return true;
}

/**
 * Folds notes on file that say the same thing (recorded before restatements
 * were merged on write) into one entry each, keeping every source (mutates).
 * Returns true when anything changed.
 */
export function compactPrivateNotes(info: Record<string, unknown>): boolean {
  const notes = getPrivateNotes(info);
  if (notes.length < 2) return false;
  const scratch: Record<string, unknown> = {};
  for (const n of notes) for (const s of privateNoteSources(n)) addPrivateNote(scratch, n.note, s);
  const next = getPrivateNotes(scratch);
  if (next.length === notes.length) return false;
  info[BROKER_PRIVATE_NOTES_KEY] = next;
  return true;
}

/**
 * Drops `documentId` as a source of every private note (mutates). A note no
 * other source states goes; one another source states stays, now credited to
 * the first surviving source. Returns true when anything changed.
 */
export function removePrivateNoteSource(info: Record<string, unknown>, documentId: string): boolean {
  const notes = getPrivateNotes(info);
  if (!Array.isArray(info[BROKER_PRIVATE_NOTES_KEY])) return false;
  let changed = false;
  const kept: BrokerPrivateNote[] = [];
  for (const n of notes) {
    const sources = privateNoteSources(n);
    const surviving = sources.filter((s) => s.documentId !== documentId);
    if (surviving.length === sources.length) { kept.push(n); continue; }
    changed = true;
    if (surviving.length > 0) kept.push(withSources(n, surviving));
  }
  if (!changed) return false;
  if (kept.length > 0) info[BROKER_PRIVATE_NOTES_KEY] = kept;
  else delete info[BROKER_PRIVATE_NOTES_KEY];
  return true;
}

function stripDocumentId(src: FieldSource): FieldSource {
  const { documentId: _d, ...rest } = src;
  return rest;
}

