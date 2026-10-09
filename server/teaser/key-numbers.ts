/**
 * The teaser's numbers — from code only, never the AI (E2).
 *
 *  - teaserFigures(deal): what the deal's facts and earnings canon say
 *    (revenue, the headline metric SDE or Adjusted EBITDA and its latest
 *    full year, margins, the listed asking price, headcount, years in
 *    business, largest customer, recurring share, locations, sale type,
 *    real estate, FF&E, inventory). A metric the canon withholds
 *    (`unconfirmed`) is left out. With no canon, the facts' annualRevenue /
 *    sde / ebitda are used.
 *  - figuresFrom(...): the same, pure (tests, the offline proof).
 *  - keyCellsFor / listingRowsFor / fixed blocks: KeyCell[] in the teaser's
 *    number style (shared/deal-bands.ts). Headcount and years are always
 *    ranges. The price is the serve-time token {price}.
 */
import { carriesPrivateDetail, getSellerKeepOut } from "../interview/seller-keep-out";
import type { Deal } from "@shared/schema";
import {
  customerRange,
  customerShare,
  headcountRange,
  indexedTrend,
  marginRange,
  moneyIn,
  parseMoney,
  recurringRange,
  revenueTrendWords,
  yearsRange,
  type NumberStyle,
} from "@shared/deal-bands";
import { TEASER_TOKENS, type KeyCell } from "@shared/teaser";
import { dealBlindRegion } from "@shared/cim-media";
import type { EarningsCanon } from "../cim/earnings-canon";
import { regionOf } from "../buyers/blind-deal-summary";
import { parseHeadcount } from "../matching/fact-numbers";

export interface TeaserFigures {
  industry: string | null;
  /** Province or state only. */
  region: string | null;
  revenue: number | null;
  revenueYear: string | null;
  revenueByYear: Record<string, number>;
  headline: "sde" | "ebitda" | null;
  /** The headline earnings figure: SDE, or Adjusted EBITDA (EBITDA from the facts when there's no canon). */
  earnings: { label: "SDE" | "Adjusted EBITDA" | "EBITDA"; value: number; year: string | null } | null;
  marginPct: number | null;
  /** The broker's listed price text (listedAskingPrice), or null. */
  askingPrice: string | null;
  employees: number | null;
  yearsInBusiness: number | null;
  largestCustomerPct: number | null;
  recurringPct: number | null;
  locations: number | null;
  saleType: "Share sale" | "Asset sale" | null;
  realEstate: "Leased" | "Owned — included" | "Owned — available separately" | null;
  ffe: { value: number | null; included: boolean } | null;
  inventory: { value: number | null; included: "included" | "extra" } | null;
  /** Fact keys each figure came from (staleness). */
  sources: Record<string, string[]>;
  /**
   * Short deal phrases read from the facts by code, from a fixed wording only
   * (never the facts' own words): the template start and the fallback when
   * the AI didn't write one. Null when the facts don't say it plainly.
   */
  phrases?: FactPhrases;
}

export interface FactPhrases {
  reasonForSale: string | null;
  transition: string | null;
  financing: string | null;
  supportTraining: string | null;
}

type Info = Record<string, unknown>;

function text(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(text).filter(Boolean).join("; ");
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o.value === "string" || typeof o.value === "number") return String(o.value);
    return Object.values(o).map(text).filter(Boolean).join("; ");
  }
  return "";
}

/** The first non-empty fact among `keys`: [key, text]. */
function fact(info: Info, keys: readonly string[]): [string, string] | null {
  for (const k of keys) {
    const t = text(info[k]).trim();
    if (t) return [k, t];
  }
  return null;
}

function firstNumber(t: string): number | null {
  const m = /(\d[\d,]*(?:\.\d+)?)/.exec(t);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** "34 years in trucking (since 1991)" → 34; "since 1998" → years since; a bare year → years since. */
export function yearsFromText(t: string, now: Date): number | null {
  const y = /(\d{1,3})\s*\+?\s*(?:years?|yrs?)\b/i.exec(t);
  if (y) return Number(y[1]);
  const since = /\b(1[89]\d{2}|20\d{2})\b/.exec(t);
  if (since) {
    const n = now.getUTCFullYear() - Number(since[1]);
    return n >= 0 ? n : null;
  }
  const lone = /^\s*(\d{1,3})\s*$/.exec(t);
  return lone ? Number(lone[1]) : null;
}

/** An EBITDA fact: the adjusted figure when the text gives one ("reported $660K; adjusted EBITDA $780K"). */
export function ebitdaFromText(key: string, t: string): { value: number; adjusted: boolean } | null {
  // A dollar figure right after "adjusted EBITDA" (never the "FY2024" that may sit between), or right before it.
  const adj = /adjusted\s+ebitda[^$]{0,24}?(\$\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand)?)/i.exec(t)
    ?? /(\$\s*\d[\d,]*(?:\.\d+)?\s*(?:k|m|mm|million|thousand)?)\s*(?:\(?\s*)?adjusted\s+ebitda/i.exec(t);
  if (adj) {
    const v = parseMoney(adj[1]);
    if (v) return { value: v, adjusted: true };
  }
  const v = parseMoney(t);
  if (!v) return null;
  return { value: v, adjusted: key === "adjustedEbitda" || /\b(?:adjusted|normali[sz]ed)\b/i.test(t) && !/\breported\b/i.test(t) };
}

function firstPercent(t: string): number | null {
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(t) ?? /(\d{1,3}(?:\.\d+)?)\s*(?:percent|per cent)\b/i.exec(t);
  return m ? Number(m[1]) : null;
}

const EMPLOYEE_KEYS = ["employees", "employeeCount", "numberOfEmployees", "totalEmployees", "headcount", "totalHeadcount", "staffCount"];
const YEARS_KEYS = ["yearsOperating", "yearsInBusiness", "businessAge"];
const FOUNDED_KEYS = ["yearFounded", "yearEstablished", "foundedYear", "dateOfIncorporation", "incorporationDate"];
const LOCATION_KEYS = ["locationSite", "businessLocation", "location", "address", "headOffice", "city", "province", "state"];
const CUSTOMER_KEYS = ["customerConcentration", "largestCustomerShare", "topCustomerShare"];
const RECURRING_KEYS = ["recurringRevenuePercent", "recurringRevenueShare", "recurringRevenue", "recurringRevenuePct"];
const LOCATIONS_COUNT_KEYS = ["numberOfLocations", "locationCount", "locationsCount", "numberOfSites"];
const SALE_KEYS = ["saleType", "dealStructure", "transactionType", "transactionStructure", "structure"];
const RE_KEYS = ["realEstateIncluded", "realEstate", "propertyInfo", "leaseDetails", "premises"];
const FFE_KEYS = ["ffe", "ffeValue", "equipmentValue", "furnitureFixturesEquipment"];
const INVENTORY_KEYS = ["inventory", "inventoryValue", "inventoryIncluded"];

/** "Share sale" / "Asset sale" from the sale-type wording (null when unclear or both). */
export function saleTypeOf(t: string): TeaserFigures["saleType"] {
  const deal = /\b(?:sale|purchase|deal|transaction|sell)\b/i.test(t);
  const share = deal && /\b(?:shares?|stock)\b/i.test(t);
  const asset = deal && /\bassets?\b/i.test(t);
  if (share && !asset) return "Share sale";
  if (asset && !share) return "Asset sale";
  return null;
}

/** "Leased" / "Owned — included" / "Owned — available separately" from the real-estate wording. Never an address. */
export function realEstateOf(t: string): TeaserFigures["realEstate"] {
  if (!t) return null;
  const owned = /\b(?:owns?|owned|ownership of)\b.{0,40}\b(?:building|property|premises|land|real estate)\b|\b(?:building|property|premises|real estate)\b.{0,30}\bowned\b/i.test(t);
  const separately = /\b(?:separately|not included|excluded|available for (?:purchase|sale)|optional|can be (?:purchased|bought)|lease(?:d)? back|sale[- ]leaseback)\b/i.test(t);
  const included = /\b(?:included|includes|part of the sale|comes with)\b/i.test(t);
  const leased = /\b(?:lease|leased|leases|rent|rented|landlord|tenancy)\b/i.test(t);
  if (owned && included && !separately) return "Owned — included";
  if (owned) return "Owned — available separately";
  if (leased) return "Leased";
  return null;
}

/** FF&E: a printed money value, else "Included" when the assets name equipment, furniture or fixtures. */
export function ffeOf(info: Info): TeaserFigures["ffe"] {
  const f = fact(info, FFE_KEYS);
  if (f) {
    const n = parseMoney(f[1]);
    if (n) return { value: n, included: true };
  }
  const assets = text(info.assetsIncluded);
  if (/\b(?:equipment|furniture|fixtures|ff&e|tools|machinery|vehicles|fleet)\b/i.test(assets)) return { value: null, included: true };
  return null;
}

/** Inventory: only when the fact says whether it is included or in addition to the price. */
export function inventoryOf(info: Info): TeaserFigures["inventory"] {
  const f = fact(info, INVENTORY_KEYS);
  if (!f) return null;
  const t = f[1];
  // Only wording about the PRICE counts ("plus van stock" is not "in addition to the price").
  const extra = /\bin addition to (?:the )?(?:purchase |asking |sale )?price\b|\bon top of (?:the )?(?:purchase |asking )?price\b|\bnot included\b|\bexcluded\b|\bpurchased separately\b|\bsold separately\b|\bplus inventory\b|\bextra to the price\b/i.test(t);
  const included = !extra && /\b(?:is |are )?included\b|\bincludes inventory\b|\bincluded in (?:the )?price\b/i.test(t);
  if (!extra && !included) return null;
  return { value: parseMoney(t), included: extra ? "extra" : "included" };
}

export interface FiguresInput {
  deal: Pick<Deal, "industry"> & { extractedInfo?: unknown };
  /** The broker's facts with resolved discrepancies applied. */
  info: Info;
  canon: EarningsCanon | null;
  askingPrice: string | null;
  now?: Date;
}

/** Pure: the teaser's figures from the facts and the earnings canon. */
// ── Deal phrases from the facts (fixed wording only) ────────────────────────

const REASON_KEYS = ["reasonForSale", "reasonForSelling", "saleReason", "sellerMotivation", "reasonForExit"];
const TRANSITION_KEYS = ["transitionPlan", "ownerTransition", "transition", "trainingPeriod", "transitionPeriod", "supportTraining", "trainingAndSupport", "postSaleSupport"];
const FINANCING_KEYS = ["sellerFinancing", "vendorFinancing", "vendorTakeBack", "financing", "financingAvailable", "dealStructure", "saleType", "transactionStructure", "proposedStructure"];

/** Reasons a teaser never states on its own (the broker decides): health, family, disputes, money trouble. */
const SENSITIVE_REASON = /\b(?:health|ill(?:ness)?|sick|cancer|diagnos|surgery|medical|stroke|heart|divorc|separat|death|died|passed away|estate of|bereave|widow|disput|lawsuit|litigat|partner(?:ship)? (?:split|break)|fall(?:ing)?[- ]out|bankrupt|insolven|debt|creditor|financial (?:difficult|trouble|pressure)|cash[- ]?flow (?:problem|issue)|burn(?:ed|t)?[- ]?out|stress|exhaust|lost (?:the|a|its) (?:contract|customer|lease))/i;

/** Why the owner is selling, in one of a few plain phrases — or null. */
export function reasonForSalePhrase(t: string | null | undefined): string | null {
  const s = (t ?? "").trim();
  if (!s || SENSITIVE_REASON.test(s)) return null;
  if (/\bretir/i.test(s)) return "Owner retiring";
  if (/\b(?:no (?:family )?successor|succession|no one (?:in the family )?to take over|children (?:are|aren't|are not) (?:not )?interested)/i.test(s)) return "Owner succession";
  if (/\b(?:relocat|moving (?:to|away|abroad|out of)|leaving the (?:province|state|country|area))/i.test(s)) return "Owner relocating";
  if (/\b(?:other (?:business(?:es)?|ventures?|interests|opportunit\w*|projects?)|new (?:venture|business|opportunit\w*)|focus(?:ing)? on (?:another|other|a new)|pursu\w* other)/i.test(s)) return "Owner pursuing other interests";
  return null;
}

const SHORT_SPAN = /\b(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?[\s-]+(week|month)s?\b/i;

/** The owner's handover, in plain words ("6-month handover", "Handover available") — or null. Labelled "Owner transition" / "Support & training". */
export function transitionPhrase(t: string | null | undefined): string | null {
  const s = (t ?? "").trim();
  if (!s || /\b(?:no (?:transition|training|handover|support)|not available|won't|will not|unavailable)\b/i.test(s)) return null;
  const about = /\b(?:handover|hand-over|hand over|transition|training|train|support|stay(?:s|ing)? on|available|consult|introduc|shadow)/i.test(s);
  if (!about) return null;
  // The owner's own span: the duration next to the handover/transition/training words.
  const owner = /\b(?:owner|seller|vendor|founder|principal|i|he|she|they)\b[^.;]*?/i.exec(s);
  const scope = owner ? s.slice(owner.index) : s;
  const m = SHORT_SPAN.exec(scope);
  if (m && Number(m[2] ?? m[1]) <= 24) {
    const span = m[2] ? `${m[1]}–${m[2]}` : m[1];
    return `${span}-${m[3].toLowerCase()} handover`;
  }
  return "Handover available";
}

/** Vendor financing, when the facts say it is offered — or null. */
export function financingPhrase(t: string | null | undefined): string | null {
  const s = (t ?? "").trim();
  if (!s) return null;
  if (!/\b(?:vendor (?:take[- ]?back|financ\w*|note|loan)|seller (?:financ\w*|note|carry|take[- ]?back)|owner financ\w*|\bVTB\b|seller carry)/i.test(s)) return null;
  if (/\b(?:no|not|won't|will not|unwilling|isn't|is not|without)\b[^.;]{0,30}\b(?:vendor|seller|owner|VTB)/i.test(s)) return null;
  return "Vendor financing available";
}

/** The first fact (in key order) the reader can turn into a phrase — never one carrying a detail the seller asked to keep out. */
function firstPhrase(info: Info, keys: readonly string[], read: (t: string) => string | null): string | null {
  const keepOut = getSellerKeepOut(info);
  for (const k of keys) {
    const t = text(info[k]).trim();
    if (!t || keepOut.some((e) => carriesPrivateDetail(t, e))) continue;
    const v = read(t);
    if (v) return v;
  }
  return null;
}

/** The deal phrases from the facts (fixed wording; nothing of the facts' own words travels). */
export function factPhrases(info: Info): FactPhrases {
  const transition = firstPhrase(info, TRANSITION_KEYS, transitionPhrase);
  return {
    reasonForSale: firstPhrase(info, REASON_KEYS, reasonForSalePhrase),
    transition,
    financing: firstPhrase(info, FINANCING_KEYS, financingPhrase),
    supportTraining: transition,
  };
}

/** The AI's phrase when it wrote one, else the facts' fixed phrase. */
export function phraseOr(ai: string | null | undefined, fromFacts: string | null | undefined): string | null {
  return ai && ai.trim() ? ai : fromFacts ?? null;
}

export function figuresFrom(input: FiguresInput): TeaserFigures {
  const { info, canon } = input;
  const now = input.now ?? new Date();
  const sources: Record<string, string[]> = {};
  const note = (what: string, ...keys: string[]) => {
    sources[what] = keys;
  };

  // Revenue and earnings — the canon (latest full fiscal year), else the facts.
  let revenueByYear: Record<string, number> = {};
  let revenue: number | null = null;
  let revenueYear: string | null = null;
  let earnings: TeaserFigures["earnings"] = null;
  let headline: TeaserFigures["headline"] = null;
  let marginPct: number | null = null;
  if (canon) {
    revenueByYear = { ...canon.revenue };
    headline = canon.headline;
    const year = canon.latestYear;
    if (typeof canon.revenue[year] === "number") {
      revenue = canon.revenue[year];
      revenueYear = year;
    }
    const metric = canon.headline === "sde" ? "sde" : "adjusted";
    const series = metric === "sde" ? canon.sde : canon.adjustedEbitda;
    if (!canon.unconfirmed.includes(metric) && typeof series[year] === "number") {
      earnings = { label: metric === "sde" ? "SDE" : "Adjusted EBITDA", value: series[year], year };
      const m = canon.margins.find((x) => x.kind === (metric === "sde" ? "sde" : "adjusted") && x.year === year);
      marginPct = m ? m.pct : null;
    }
    note("revenue", "annualRevenue");
    note("earnings", metric === "sde" ? "sde" : "adjustedEbitda", "ebitda");
  }
  if (revenue === null) {
    const f = fact(info, ["annualRevenue", "revenue", "grossRevenue", "totalRevenue"]);
    if (f) {
      revenue = parseMoney(f[1]);
      note("revenue", f[0]);
    }
  }
  if (!earnings && !(canon && canon.unconfirmed.length > 0)) {
    const sde = fact(info, ["sde", "sellersDiscretionaryEarnings", "cashFlow"]);
    const ebitda = fact(info, ["adjustedEbitda", "ebitda"]);
    const sdeN = sde ? parseMoney(sde[1]) : null;
    const eb = ebitda ? ebitdaFromText(ebitda[0], ebitda[1]) : null;
    // No analysis: SDE leads for a main-street size (under $5M revenue) or when there's no EBITDA.
    if (sdeN && (!eb || (revenue !== null && revenue < 5_000_000))) {
      earnings = { label: "SDE", value: sdeN, year: null };
      headline = "sde";
      note("earnings", sde![0]);
    } else if (eb) {
      earnings = { label: eb.adjusted ? "Adjusted EBITDA" : "EBITDA", value: eb.value, year: null };
      headline = "ebitda";
      note("earnings", ebitda![0]);
    }
    if (earnings && revenue) marginPct = (earnings.value / revenue) * 100;
  }

  // People and years — always ranges. ("since 2014" is never a headcount.)
  const emp = fact(info, EMPLOYEE_KEYS);
  const employees = emp ? parseHeadcount(emp[1]) : null;
  if (emp && employees !== null) note("employees", emp[0]);
  let yearsInBusiness: number | null = null;
  const yrs = fact(info, YEARS_KEYS);
  if (yrs) {
    yearsInBusiness = yearsFromText(yrs[1], now);
    if (yearsInBusiness !== null) note("years", yrs[0]);
  }
  if (yearsInBusiness === null) {
    const fy = fact(info, FOUNDED_KEYS);
    const y = fy ? /\b(1[89]\d{2}|20\d{2})\b/.exec(fy[1]) : null;
    if (y) {
      yearsInBusiness = now.getUTCFullYear() - Number(y[1]);
      note("years", fy![0]);
    }
  }

  const loc = fact(info, LOCATION_KEYS);
  const region = (dealBlindRegion(info) ?? "").split(",")[0].trim() || (loc ? regionOf(loc[1]) : null);

  const cust = fact(info, CUSTOMER_KEYS);
  const largestCustomerPct = cust ? firstPercent(cust[1]) : null;
  if (cust && largestCustomerPct !== null) note("customers", cust[0]);
  const rec = fact(info, RECURRING_KEYS);
  const recurringPct = rec ? firstPercent(rec[1]) : null;
  if (rec && recurringPct !== null) note("recurring", rec[0]);
  const locs = fact(info, LOCATIONS_COUNT_KEYS);
  const locations = locs ? firstNumber(locs[1]) : null;

  // The first fact that says it (a premises fact that only gives an address doesn't).
  const firstClassified = <T>(keys: readonly string[], read: (t: string) => T | null): [string, T] | null => {
    for (const k of keys) {
      const t = text(info[k]).trim();
      const v = t ? read(t) : null;
      if (v) return [k, v];
    }
    return null;
  };
  const sale = firstClassified(SALE_KEYS, saleTypeOf);
  const saleType = sale ? sale[1] : null;
  if (sale) note("saleType", sale[0]);
  const re = firstClassified(RE_KEYS, realEstateOf);
  const realEstate = re ? re[1] : null;
  if (re) note("realEstate", re[0]);

  return {
    industry: input.deal.industry ?? null,
    region: region || null,
    revenue,
    revenueYear,
    revenueByYear,
    headline,
    earnings,
    marginPct,
    askingPrice: input.askingPrice,
    employees,
    yearsInBusiness,
    largestCustomerPct,
    recurringPct,
    locations,
    saleType,
    realEstate,
    ffe: ffeOf(info),
    inventory: inventoryOf(info),
    sources,
    phrases: factPhrases(info),
  };
}

/** The deal's teaser figures from its facts, resolved discrepancies and financial analysis. */
export async function teaserFigures(deal: Deal): Promise<TeaserFigures> {
  const { storage } = await import("../storage");
  const { brokerFactsView } = await import("../information/facts");
  const { settleResolvedFacts, resolvedNotes, currentResolvedNotes } = await import("../cim/resolved-block");
  const { cimFinancialsFor } = await import("../cim/cim-financials");
  const { earningsCanon } = await import("../cim/earnings-canon");
  const { listedAskingPrice } = await import("../information/deal-mirror");
  const settled = settleResolvedFacts(
    (brokerFactsView(deal).extractedInfo as Record<string, unknown>) || {},
    resolvedNotes(await storage.getResolvedDiscrepancies(deal.id).catch(() => [])),
  );
  const resolved = currentResolvedNotes(settled.notes);
  const [analyses, docs] = await Promise.all([
    storage.getFinancialAnalysesByDeal(deal.id).catch(() => []),
    storage.getDocumentsByDeal(deal.id).catch(() => []),
  ]);
  let fin = null;
  try {
    fin = cimFinancialsFor(analyses as never, docs as never);
  } catch {
    // A statement it was built from was deleted: no canon (the facts stand).
    fin = null;
  }
  const askingPrice = listedAskingPrice(deal);
  const canon = earningsCanon(fin, askingPrice, { extractedInfo: settled.facts, resolved });
  return figuresFrom({ deal, info: settled.facts, canon, askingPrice });
}

export interface CellSettings {
  numbers: NumberStyle;
  showAskingPrice: boolean;
}

const cell = (key: string, label: string, value: string | null): KeyCell | null => (value ? { key, label, value } : null);
const money = (n: number | null, style: NumberStyle) => (n ? moneyIn(style, n) : null);
/** "10–24" under the label "Employees" (never "10–24 employees · Employees"). */
const employeesWords = (n: number | null) => headcountRange(n);

/** The Key numbers row (One page, Two page, Investor): Revenue · SDE/Adjusted EBITDA · Asking price · Employees (+ margin for the Investor brief). */
export function keyCellsFor(templateKey: string, f: TeaserFigures, s: CellSettings): KeyCell[] {
  const out: Array<KeyCell | null> = [
    cell("revenue", "Revenue", money(f.revenue, s.numbers)),
    f.earnings ? cell("earnings", f.earnings.label, money(f.earnings.value, s.numbers)) : null,
    f.askingPrice ? cell("askingPrice", "Asking price", TEASER_TOKENS.price) : null,
    cell("employees", "Employees", employeesWords(f.employees)),
  ];
  if (templateKey === "investor" && f.earnings) out.push(cell("margin", `${f.earnings.label} margin`, marginRange(f.marginPct)));
  return out.filter((c): c is KeyCell => !!c);
}

export interface ListingPhrases {
  financing?: string | null;
  supportTraining?: string | null;
  reasonForSale?: string | null;
}

/** The Main-street listing's facts grid. A row with no fact hides itself (never a placeholder). */
export function listingRowsFor(f: TeaserFigures, s: CellSettings, phrases: ListingPhrases = {}): KeyCell[] {
  const years = yearsRange(f.yearsInBusiness);
  const rows: Array<KeyCell | null> = [
    f.askingPrice ? cell("askingPrice", "Asking price", TEASER_TOKENS.price) : null,
    f.headline === "sde" && f.earnings?.label === "SDE" ? cell("cashFlow", "Cash flow (SDE)", money(f.earnings.value, s.numbers)) : null,
    cell("grossRevenue", "Gross revenue", money(f.revenue, s.numbers)),
    f.ffe ? cell("ffe", "FF&E", f.ffe.value ? money(f.ffe.value, s.numbers) : "Included") : null,
    f.inventory ? cell("inventory", "Inventory", `${f.inventory.included === "extra" ? "In addition to the price" : "Included"}${f.inventory.value ? ` (${money(f.inventory.value, s.numbers)})` : ""}`) : null,
    cell("realEstate", "Real estate", f.realEstate),
    cell("employees", "Employees", employeesWords(f.employees)),
    cell("established", "Established", years),
    cell("financing", "Financing", clip(phrases.financing)),
    cell("supportTraining", "Support & training", clip(phrases.supportTraining)),
    cell("reasonForSale", "Reason for selling", clip(phrases.reasonForSale)),
  ];
  return rows.filter((c): c is KeyCell => !!c);
}

/** Shorten at a word boundary ("The owner stays as designated…"), never mid-word. */
function clip(s: string | null | undefined, n = 60): string | null {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (t.length <= n) return t;
  const cut = t.slice(0, n - 1);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > n * 0.5 ? cut.slice(0, sp) : cut).replace(/[,;:.\-–— ]+$/, "")}…`;
}

/** Locations as a range ("1 location", "2–3 locations", "4–9 locations", "10+ locations"). */
export function locationsRange(n: number | null): string | null {
  if (!n || n < 1) return null;
  if (n === 1) return "1 location";
  if (n <= 3) return "2–3 locations";
  if (n <= 9) return "4–9 locations";
  return "10+ locations";
}

/** "At a glance" (Two-page): Team · Locations · Years · Customers/recurring — ranges only. */
export function operationsCells(f: TeaserFigures): KeyCell[] {
  return [
    cell("team", "Team", employeesWords(f.employees)),
    cell("locations", "Locations", locationsRange(f.locations)),
    cell("years", "In business", yearsRange(f.yearsInBusiness)),
    cell("customers", "Customers", f.recurringPct !== null ? recurringRange(f.recurringPct) : customerRange(f.largestCustomerPct)),
  ].filter((c): c is KeyCell => !!c);
}

/** "Financial picture" (Investor): revenue trend in words, margin, recurring share, largest customer. */
export function financialSnapshotCells(f: TeaserFigures): KeyCell[] {
  return [
    cell("trend", "Revenue trend", revenueTrendWords(f.revenueByYear)),
    f.earnings ? cell("margin", `${f.earnings.label} margin`, marginRange(f.marginPct)) : null,
    cell("recurring", "Recurring revenue", recurringRange(f.recurringPct)),
    cell("largestCustomer", "Largest customer", customerShare(f.largestCustomerPct)),
  ].filter((c): c is KeyCell => !!c);
}

/** "Deal at a glance" lines (fixed parts; the AI adds reason for sale and transition). */
export function dealCells(f: TeaserFigures, phrases: { reasonForSale?: string | null; transition?: string | null; financing?: string | null } = {}, withFinancing = false): KeyCell[] {
  return [
    cell("saleType", "Sale type", f.saleType),
    cell("reasonForSale", "Reason for sale", clip(phrases.reasonForSale, 80)),
    cell("transition", "Owner transition", clip(phrases.transition, 80)),
    cell("realEstate", "Real estate", f.realEstate),
    withFinancing ? cell("financing", "Financing", clip(phrases.financing, 60)) : null,
  ].filter((c): c is KeyCell => !!c);
}

/** The indexed revenue line (first printed full year = 100), from ≥ 3 years. Never a money axis. */
export function trendLayoutData(f: TeaserFigures): Record<string, unknown> | null {
  const t = indexedTrend(f.revenueByYear);
  if (!t) return null;
  return {
    indexed: true,
    data: t.map((p) => ({ name: p.year, index: p.index })),
    series: [{ key: "index", label: "Revenue (first year = 100)" }],
    yLabel: "Index",
  };
}

/** The header chips: industry, region, "Established 20+ years". */
export function headerChips(f: TeaserFigures): string[] {
  const years = yearsRange(f.yearsInBusiness);
  return [f.industry, f.region, years ? `Established ${years}` : null].filter((c): c is string => !!c && !!c.trim());
}

/** Fixed recompute of a block's cells, skipping cells the broker typed over. */
export function mergeCells(current: KeyCell[], fresh: KeyCell[]): KeyCell[] {
  const edited = new Map(current.filter((c) => c.edited).map((c) => [c.key, c]));
  const out = fresh.map((c) => edited.get(c.key) ?? c);
  // A cell the broker typed whose fact is gone stays (it's theirs).
  for (const c of current) if (c.edited && !out.some((x) => x.key === c.key)) out.push(c);
  return out;
}

export { parseMoney };
