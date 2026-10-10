/**
 * Blind-safe description of a deal for pre-NDA buyer emails.
 *
 * Nothing here can identify the business: no name, owner, street or city,
 * and no exact figures — only the codename, industry, province/state and
 * size bands. Shared by the deal's outreach drafts and the buyer profile's
 * "Email this buyer" draft.
 */
import type { Deal } from "@shared/schema";
import { typedNumericValues } from "../interview/info-merger";
import { moneyRange, yearsRange } from "@shared/deal-bands";

export interface BlindDealSummary {
  codename: string;
  industry: string | null;
  subIndustry: string | null;
  region: string | null;
  revenueBand: string | null;
  sdeBand: string | null;
  tenure: string | null;
}

/**
 * A money fact as a range — the ONE ladder the teaser uses too
 * (shared/deal-bands.ts), so a buyer never sees two ranges for one deal.
 */
export function moneyBand(raw: unknown): string | null {
  const n = typeof raw === "string" ? typedNumericValues(raw).find((t) => t.kind === "currency")?.value : typeof raw === "number" ? raw : null;
  if (!n || !(n > 0)) return null;
  return moneyRange(n) || null;
}

const US_STATES = "Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|Wisconsin|Wyoming";
const PROVINCE_ABBR: Record<string, string> = { ON: "Ontario", QC: "Quebec", BC: "British Columbia", AB: "Alberta", MB: "Manitoba", SK: "Saskatchewan", NS: "Nova Scotia", NB: "New Brunswick", NL: "Newfoundland", PE: "Prince Edward Island" };

/** Province / state only — never the city. */
export function regionOf(loc: unknown): string | null {
  const text = typeof loc === "string" ? loc : loc && typeof loc === "object" ? Object.values(loc as Record<string, unknown>).filter((v) => typeof v === "string").join(" ") : "";
  const m = new RegExp("\\b(Ontario|Quebec|British Columbia|Alberta|Manitoba|Saskatchewan|Nova Scotia|New Brunswick|Newfoundland|Prince Edward Island|" + US_STATES + "|\\bON\\b|\\bQC\\b|\\bBC\\b|\\bAB\\b|\\bMB\\b|\\bSK\\b|\\bNS\\b|\\bNB\\b|\\bNL\\b|\\bPE\\b)").exec(text);
  return m ? (PROVINCE_ABBR[m[1]] ?? m[1]) : null;
}

function yearsBand(raw: unknown): string | null {
  const n = typeof raw === "string" ? parseInt((raw.match(/\d+/) || [""])[0], 10) : typeof raw === "number" ? raw : NaN;
  const r = yearsRange(Number.isFinite(n) ? n : null);
  return r ? `${r} established` : null;
}

export function blindDealSummary(deal: Deal): BlindDealSummary {
  const extracted: any = (deal as any).extractedInfo || {};
  return {
    codename: (deal as any).blindCodename || "a confidential opportunity",
    industry: deal.industry || null,
    subIndustry: (deal as any).subIndustry || null,
    region: regionOf(extracted.locationSite || extracted.location || (deal as any).location),
    revenueBand: moneyBand(extracted.annualRevenue),
    sdeBand: moneyBand(extracted.sde),
    tenure: yearsBand(extracted.yearsOperating),
  };
}
