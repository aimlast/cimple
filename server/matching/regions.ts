/**
 * The broad region (province / state + country) of a deal, for the
 * outside-buyer research brief. Pre-NDA material: never the city.
 *
 * Read in order of reliability:
 *   1. the premises facts (address, head office, location…) — dealBlindRegion;
 *   2. the deal's own "City, Province/State" as the broker entered it;
 *   3. a well-known city named in either ("Calgary" → Alberta, "Toledo" → Ohio);
 *   4. a province/state name or code anywhere in the location text.
 */
import { dealBlindRegion, regionFromAddress } from "@shared/cim-media";

const CA: Record<string, string> = {
  AB: "Alberta", BC: "British Columbia", MB: "Manitoba", NB: "New Brunswick", NL: "Newfoundland and Labrador",
  NS: "Nova Scotia", NT: "Northwest Territories", NU: "Nunavut", ON: "Ontario", PE: "Prince Edward Island",
  QC: "Quebec", SK: "Saskatchewan", YT: "Yukon",
};
const US: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland", MA: "Massachusetts", MI: "Michigan",
  MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada", NH: "New Hampshire",
  NJ: "New Jersey", NM: "New Mexico", NY: "New York", NC: "North Carolina", ND: "North Dakota", OH: "Ohio",
  OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota",
  TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia",
  WI: "Wisconsin", WY: "Wyoming",
};

/**
 * Cities and towns a location fact often names on its own. Only places
 * whose name is unambiguous enough to settle the region (no "London",
 * "Richmond", "Kingston", "Portland"…).
 */
const CITY_REGION: Record<string, string> = {
  // Canada
  toronto: "ON", mississauga: "ON", brampton: "ON", markham: "ON", vaughan: "ON", oakville: "ON",
  hamilton: "ON", ottawa: "ON", kitchener: "ON", waterloo: "ON", guelph: "ON", "st. catharines": "ON", "st catharines": "ON",
  niagara: "ON", barrie: "ON", oshawa: "ON", whitby: "ON", ajax: "ON", pickering: "ON", sudbury: "ON", "thunder bay": "ON",
  "sault ste. marie": "ON", peterborough: "ON", scarborough: "ON", etobicoke: "ON", "north york": "ON", "richmond hill": "ON",
  newmarket: "ON", milton: "ON", brantford: "ON", sarnia: "ON", "ottawa-gatineau": "ON",
  montreal: "QC", "montréal": "QC", laval: "QC", gatineau: "QC", longueuil: "QC", sherbrooke: "QC", "trois-rivières": "QC",
  "trois-rivieres": "QC", saguenay: "QC", "quebec city": "QC", "québec city": "QC",
  vancouver: "BC", burnaby: "BC", surrey: "BC", coquitlam: "BC", langley: "BC", abbotsford: "BC", kelowna: "BC",
  kamloops: "BC", nanaimo: "BC", victoria: "BC", chilliwack: "BC", "prince george": "BC", "north vancouver": "BC",
  "new westminster": "BC", "maple ridge": "BC",
  calgary: "AB", edmonton: "AB", "red deer": "AB", lethbridge: "AB", "medicine hat": "AB", airdrie: "AB",
  "fort mcmurray": "AB", "grande prairie": "AB", "st. albert": "AB", okotoks: "AB",
  winnipeg: "MB", brandon: "MB", saskatoon: "SK", regina: "SK", halifax: "NS", dartmouth: "NS", moncton: "NB",
  fredericton: "NB", "saint john": "NB", "st. john's": "NL", charlottetown: "PE", whitehorse: "YT", yellowknife: "NT",
  // United States
  "new york city": "NY", brooklyn: "NY", buffalo: "NY", albany: "NY", syracuse: "NY",
  "los angeles": "CA", "san francisco": "CA", "san diego": "CA", "san jose": "CA", sacramento: "CA", fresno: "CA", oakland: "CA",
  chicago: "IL", houston: "TX", dallas: "TX", austin: "TX", "san antonio": "TX", "fort worth": "TX", "el paso": "TX",
  phoenix: "AZ", tucson: "AZ", scottsdale: "AZ", philadelphia: "PA", pittsburgh: "PA", seattle: "WA", spokane: "WA", tacoma: "WA",
  denver: "CO", boulder: "CO", "colorado springs": "CO", boston: "MA", detroit: "MI", "grand rapids": "MI", "ann arbor": "MI",
  minneapolis: "MN", "st. paul": "MN", atlanta: "GA", savannah: "GA", miami: "FL", orlando: "FL", tampa: "FL", jacksonville: "FL",
  charlotte: "NC", raleigh: "NC", nashville: "TN", memphis: "TN", knoxville: "TN", toledo: "OH", cleveland: "OH",
  cincinnati: "OH", columbus: "OH", akron: "OH", dayton: "OH", indianapolis: "IN", milwaukee: "WI", madison: "WI",
  "kansas city": "MO", "st. louis": "MO", omaha: "NE", "las vegas": "NV", reno: "NV", "salt lake city": "UT", boise: "ID",
  "new orleans": "LA", "baton rouge": "LA", louisville: "KY", baltimore: "MD", "oklahoma city": "OK", tulsa: "OK",
  albuquerque: "NM", anchorage: "AK", honolulu: "HI", "des moines": "IA", "sioux falls": "SD", fargo: "ND", billings: "MT",
  bozeman: "MT", cheyenne: "WY", "virginia beach": "VA", providence: "RI", hartford: "CT", newark: "NJ",
  "jersey city": "NJ", "little rock": "AR",

};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CITY_RE = new RegExp(
  `(?<![A-Za-z])(${Object.keys(CITY_REGION).sort((a, b) => b.length - a.length).map(esc).join("|")})(?![A-Za-z])`,
  "i",
);
const NAME_RE = new RegExp(`\\b(${[...Object.values(CA), ...Object.values(US)].sort((a, b) => b.length - a.length).map(esc).join("|")})\\b`, "i");
const CODE_RE = new RegExp(`(?:^|[\\s,(])(${[...Object.keys(CA), ...Object.keys(US)].join("|")})(?=$|[\\s,).;]|\\s+\\d|\\s+[A-Z]\\d)`);

export interface BriefRegion {
  /** "Alberta", "Ohio". */
  region: string;
  country: "Canada" | "United States";
}

function fromCode(code: string): BriefRegion | null {
  if (CA[code]) return { region: CA[code], country: "Canada" };
  if (US[code]) return { region: US[code], country: "United States" };
  return null;
}

function fromName(name: string): BriefRegion | null {
  const n = name.toLowerCase();
  for (const [code, full] of Object.entries(CA)) if (full.toLowerCase() === n) return fromCode(code);
  for (const [code, full] of Object.entries(US)) if (full.toLowerCase() === n) return fromCode(code);
  if (n === "québec") return fromCode("QC");
  return null;
}

/** "Ontario, Canada" / "Ohio, USA" (shared/cim-media format) → BriefRegion. */
function fromLabel(label: string | null): BriefRegion | null {
  if (!label) return null;
  const [region] = label.split(",").map((s) => s.trim());
  return region ? fromName(region) : null;
}

/** The region named in one piece of location text, or null. */
export function regionInText(text: string | null | undefined): BriefRegion | null {
  const t = (text || "").trim();
  if (!t) return null;
  const labelled = fromLabel(regionFromAddress(t));
  if (labelled) return labelled;
  const name = NAME_RE.exec(t);
  if (name) {
    const r = fromName(name[1]);
    if (r) return r;
  }
  const code = CODE_RE.exec(t);
  if (code) {
    const r = fromCode(code[1]);
    if (r) return r;
  }
  const city = CITY_RE.exec(t);
  if (city) return fromCode(CITY_REGION[city[1].toLowerCase()]);
  return null;
}

/**
 * The deal's region for the research brief. `facts` must already be the
 * facts the brief may use (no broker-only sources).
 */
export function briefRegion(deal: { location?: string | null }, facts: Record<string, unknown>): BriefRegion | null {
  const fromFacts = fromLabel(dealBlindRegion(facts));
  if (fromFacts) return fromFacts;
  const fromDeal = regionInText(deal.location);
  if (fromDeal) return fromDeal;
  const text = (v: unknown): string =>
    typeof v === "string" ? v : v && typeof v === "object" && "value" in (v as any) ? text((v as any).value) : "";
  for (const key of ["location", "locationSite", "headOffice", "headquarters", "city", "address", "leaseAddress"]) {
    const r = regionInText(text(facts[key]));
    if (r) return r;
  }
  return null;
}
