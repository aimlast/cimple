/**
 * The buyer profile a buyer fills in as part of signing the NDA.
 *
 * Signing the NDA and building the buyer profile are one step (founder,
 * 2026-09-24): every buyer who asks to see a CIM tells us who they are and
 * what they're looking for, and that profile feeds matching for every future
 * listing. The questions change with the buyer type — an individual is asked
 * about their operating background and whether they'll run the business, a
 * strategic buyer about their company and the fit, a financial buyer about
 * their firm, cheque size and platform vs add-on.
 *
 * Pure (no server imports) — used by the view room form and the server.
 */
import { z } from "zod";

export const NDA_BUYER_TYPES = [
  { value: "individual", label: "Individual buyer", hint: "Buying a business to own and run" },
  { value: "strategic", label: "Company (strategic)", hint: "An operating business adding to what it does" },
  { value: "financial", label: "Investor (financial)", hint: "Private equity, family office, search fund" },
] as const;
export type NdaBuyerType = (typeof NDA_BUYER_TYPES)[number]["value"];

export const FINANCIAL_KINDS = [
  { value: "private_equity", label: "Private equity" },
  { value: "family_office", label: "Family office" },
  { value: "search_fund", label: "Search fund" },
  { value: "independent_sponsor", label: "Independent sponsor" },
  { value: "other", label: "Other investor" },
] as const;

export const FUNDING_OPTIONS = [
  { value: "cash", label: "Cash / own equity" },
  { value: "bank_loan", label: "Bank or SBA / BDC loan" },
  { value: "investors", label: "Investors or partners" },
  { value: "fund", label: "Committed fund" },
  { value: "combination", label: "A combination" },
] as const;

export const PROOF_OF_FUNDS_OPTIONS = [
  { value: "yes", label: "Yes, available now" },
  { value: "can_provide", label: "Can provide on request" },
  { value: "no", label: "Not yet" },
] as const;

export const TIMELINE_OPTIONS = [
  { value: "0_3", label: "Within 3 months" },
  { value: "3_6", label: "3–6 months" },
  { value: "6_12", label: "6–12 months" },
  { value: "12_plus", label: "More than a year" },
] as const;

export const OPERATE_OPTIONS = [
  { value: "yes", label: "Yes, I'll run it" },
  { value: "hire_manager", label: "I'll hire a manager" },
  { value: "no", label: "Passive / not decided" },
] as const;

export const DEAL_ROLE_OPTIONS = [
  { value: "platform", label: "Platform" },
  { value: "add_on", label: "Add-on" },
  { value: "either", label: "Either" },
] as const;

const vals = <T extends readonly { value: string }[]>(o: T) => o.map((x) => x.value) as [T[number]["value"], ...T[number]["value"][]];
const str = (max: number) => z.string().trim().max(max);

export const ndaBuyerProfileSchema = z.object({
  buyerType: z.enum(vals(NDA_BUYER_TYPES)),
  financialKind: z.enum(vals(FINANCIAL_KINDS)).optional().nullable(),
  name: str(120).min(1, "Your name is required"),
  phone: str(40).min(5, "A phone number is required"),
  company: str(160).optional().nullable(),
  companyWebsite: str(200).optional().nullable(),
  title: str(120).optional().nullable(),
  background: str(2000).min(10, "Tell us a little about your background"),
  lookingFor: str(2000).min(10, "Tell us what you're looking for"),
  priceMin: z.number().nonnegative().optional().nullable(),
  priceMax: z.number().positive().optional().nullable(),
  funding: z.enum(vals(FUNDING_OPTIONS)),
  proofOfFunds: z.enum(vals(PROOF_OF_FUNDS_OPTIONS)),
  timeline: z.enum(vals(TIMELINE_OPTIONS)),
  operateSelf: z.enum(vals(OPERATE_OPTIONS)).optional().nullable(),
  fitReason: str(1500).optional().nullable(),
  dealRole: z.enum(vals(DEAL_ROLE_OPTIONS)).optional().nullable(),
  checkSize: str(120).optional().nullable(),
  appealedTo: str(1500).optional().nullable(),
  bestTimeToContact: str(120).optional().nullable(),
}).superRefine((p, ctx) => {
  if (p.priceMin == null && p.priceMax == null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["priceMax"], message: "Give a price range you're considering" });
  }
  if (p.priceMin != null && p.priceMax != null && p.priceMin > p.priceMax) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["priceMax"], message: "The maximum is below the minimum" });
  }
  if ((p.buyerType === "strategic" || p.buyerType === "financial") && !p.company) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["company"], message: p.buyerType === "strategic" ? "Your company name is required" : "Your firm's name is required" });
  }
});
export type NdaBuyerProfile = z.infer<typeof ndaBuyerProfileSchema>;

/** buyer_users.buyerType value for an NDA answer. */
export function storedBuyerType(p: Pick<NdaBuyerProfile, "buyerType" | "financialKind">): string {
  if (p.buyerType !== "financial") return p.buyerType;
  return p.financialKind === "private_equity" || p.financialKind === "family_office" || p.financialKind === "search_fund"
    ? p.financialKind
    : "financial";
}

/** Map a stored buyerType back to the three NDA choices. */
export function ndaTypeFromStored(t: string | null | undefined): NdaBuyerType | null {
  if (!t) return null;
  if (t === "individual" || t === "strategic") return t;
  return "financial";
}

/**
 * Enough on file that a returning buyer can just confirm instead of
 * re-answering: who they are, what they want, and what they can spend.
 */
export function hasMatchableProfile(u: {
  buyerType?: string | null; background?: string | null; phone?: string | null;
  targetIndustries?: unknown; buyerCriteria?: unknown;
}): boolean {
  const c = (u.buyerCriteria as Record<string, unknown>) || {};
  const hasBudget = !!(c.askingPriceMax || c.askingPriceMin || c.sdeMax || c.revenueMax || c.ebitdaMax);
  const hasWants = (Array.isArray(u.targetIndustries) && u.targetIndustries.length > 0) || !!c.lookingFor;
  return !!u.buyerType && !!u.background && u.background.length > 10 && !!u.phone && hasBudget && hasWants;
}

/** Budget presets for the price-range pickers (USD/CAD agnostic). */
export const PRICE_STEPS = [
  100_000, 250_000, 500_000, 750_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000,
  5_000_000, 7_500_000, 10_000_000, 15_000_000, 25_000_000, 50_000_000, 100_000_000,
] as const;

export function formatPrice(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  return `$${Math.round(n / 1000)}K`;
}
