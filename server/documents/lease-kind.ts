/**
 * Which lease a source is about, by its title / type.
 *
 * "Lease" alone does not make a document the business's premises lease: a
 * forklift, truck, van or copier lease is an equipment lease. Its term and
 * payment must never become the premises lease's expiry and rent (the CIM's
 * location section), and it is not the "Commercial Lease Agreement" the
 * checklist asks for.
 */

const LEASE_WORD = /\bleas(?:e|es|ed|ing)\b/i;

/** Things a business leases that are not its premises (one word, lower-case letters). */
const EQUIPMENT_NOUN =
  "equipment|vehicles?|trucks?|tractors?|trailers?|reefers?|forklifts?|lift trucks?|copiers?|photocopiers?|printers?|autos?|automobiles?|cars?|vans?|pickups?|fleet|machines?|machinery|presses|press|excavators?|loaders?|compressors?|telematics|pos terminals?|chattel";

/** Lease kinds that are always equipment ("capital lease schedule", "finance lease"). */
const EQUIPMENT_LEASE_KIND = /\b(?:capital|finance|chattel)\s+leas(?:e|es|ing)\b/i;

/** The equipment word says what the lease is for: "forklift lease", "fleet financing/lease", "lease of two delivery vans". */
const EQUIPMENT_BESIDE_LEASE = new RegExp(
  `\\b(${EQUIPMENT_NOUN})(?:[\\s_-]+(?:financing|finance|rental))?(?:\\s*[/&]\\s*|[\\s_-]+(?:and\\s+)?)leas(?:e|es|ing)\\b` +
  `|\\bleas(?:e|es|ing)(?:[\\s_-]+(?:agreements?|schedules?|contracts?))?[\\s_-]+(?:of|for|on|covering)[\\s_-]+(?:[\\w'’.-]+[\\s_-]+){0,4}?(${EQUIPMENT_NOUN})\\b`,
  "gi");

/** Any equipment word, as written. */
const EQUIPMENT_ANYWHERE = new RegExp(`\\b(${EQUIPMENT_NOUN})\\b`, "gi");

/**
 * Words that make an equipment word part of a business's name ("Kingsway
 * Auto Body", "Sparkle Car Wash", "Precision Machine Works Inc", "Fleet
 * Services Depot", "Main Street Printers Ltd") — the landlord or tenant a
 * premises lease is titled by, not a thing being leased.
 */
const NAME_WORD_AFTER =
  /^[\s_-]*(?:&|and\b|body|wash|washes|centre|center|repair|repairs|works|service|services|depot|sales|shop|shops|parts|clinic|dealership|dealer|rentals?|supply|supplies|world|mart|plaza|mall|hub|care|detailing|glass|collision|spa|electric|electrical|ltd|limited|inc|incorporated|corp|corporation|co|company|llc|llp|group|holdings|enterprises|industries|solutions)\b/i;

/** A capitalised word before an equipment word that describes the equipment, not a business's name: its maker or kind. */
const DESCRIBING_WORD =
  /^(?:Equipment|Vehicles?|Fleet|Office|Shop|Warehouse|Delivery|Service|Company|Leased?|Leasing|New|Used|Heavy|Light|Commercial|Toyota|Ford|Freightliner|Volvo|Kenworth|Peterbilt|Mack|International|Western|Hino|Isuzu|Ram|Gmc|Chevrolet|Chevy|Dodge|Nissan|Mercedes|Sprinter|Transit|Canon|Xerox|Ricoh|Konica|Minolta|Sharp|Kyocera|Brother|Lexmark|Caterpillar|Deere|Kubota|Bobcat|Hyster|Yale|Clark|Crown|Komatsu|Doosan|Hyundai|Kia|Honda|Wabash|Manac|Utility|Dane|Linde|Jungheinrich|Raymond|Hitachi|Case|Mitsubishi|Kalmar|Tennant|Heidelberg|Takeuchi|Genie|Skyjack|Terex|Navistar|Ryder|Penske|Cat)$/;

/** Words that say the lease is for a place (a truck yard lease is still premises). */
const PREMISES_WORD =
  /\b(?:premises|shop|office|offices|warehouse|building|retail|suite|property|store|facility|space|land|yard|real estate|site|clinic|restaurant|storefront|head lease|sublease|plaza|mall|landlord)\b/i;

/**
 * Words that place a lease only when the title doesn't say outright that it
 * is of equipment: a fleet has numbered units ("Tractor lease - Unit 14",
 * "Truck lease (Unit #22)"), and a lessor's form may be headed "commercial
 * lease" or speak of the lessee as a tenant. Beside a description ("Lease -
 * Toyota forklift (Unit 4)"), a unit is the premises'.
 */
const SOFT_PREMISES_WORD =
  /\b(?:tenant|tenancy|(?:commercial|industrial|ground|net|triple[\s-]net)[\s_-]+leas(?:e|es|ing)|unit\s*#?\s*\d+|(?<!\bpos\s)terminal(?!\s+(?:tractors?|trucks?))|garage|depot)\b/i;

/** A model year and maker describe a vehicle ("Lease - 2022 Ford F-150", "Lease agreement - 2023 Kenworth T680"). */
const VEHICLE_YEAR_MAKE =
  /\b(?:19|20)\d{2}\s+(?:Ford|Chevrolet|Chevy|GMC|Ram|Dodge|Toyota|Nissan|Honda|Hyundai|Kia|Mercedes(?:-Benz)?|Freightliner|Kenworth|Peterbilt|Volvo|Mack|International|Western Star|Hino|Isuzu|Sprinter|Mitsubishi|Tesla|BMW|Audi|Lexus|Jeep|Subaru|Mazda|Volkswagen|VW)\b/;

/** Point-of-sale terminals, written the usual way ("POS terminals"). */
const POS_TERMINALS = /\bpos\s+terminals?\b/i;

/** A street address ("240 Bayfront Commerce Dr", "12-45 King St W"). */
const ADDRESS =
  /\b\d{1,6}(?:[-–]\d{1,6})?\s+(?:[A-Z][\w'’.-]*\s+){1,4}(?:st|street|rd|road|ave|avenue|dr|drive|blvd|boulevard|way|hwy|highway|cres|crescent|ct|court|pl|place|ln|lane|pkwy|parkway|line|sideroad|concession|terrace|trail|gate|circle|close|square|sq|landing|grove|mews|row)\b\.?/i;

/** A Canadian postal code or a US state + ZIP ("L8H 0A7", "OH 44114"). */
const POSTAL_CODE = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\b[A-Z]{2}\s+\d{5}(?:-\d{4})?\b/;

/** What a premises lease's own terms talk about (an equipment lease has a lessee, not a tenant). */
const PREMISES_TERMS =
  /\b(?:premises|tenant|tenancy|landlord|square (?:feet|foot|metres?|meters?)|sq\.?\s?ft|sf\b|base rent|basic rent|additional rent|common area|cam\b|tmi\b|triple[\s-]net|nnn\b|leasable area|rentable area|occupancy|use clause|permitted use)/i;

/** The street address a source's title names ("Lease - Seton clinic (118 Hollowbrook Gate SE)" → "118 Hollowbrook Gate"), if any. */
export function addressInTitle(title: string | null | undefined): string | undefined {
  return title ? title.match(ADDRESS)?.[0] : undefined;
}

/** A lease extraction's own facts that say it is a lease of premises. */
export interface LeaseFacts {
  leaseAddress?: unknown;
  leaseDetails?: unknown;
  propertyInfo?: unknown;
  [key: string]: unknown;
}

/** True when a lease extraction's facts place it at premises: a street address, or a tenant / landlord / floor-area term. */
export function factsSayPremises(facts: LeaseFacts | null | undefined): boolean {
  if (!facts) return false;
  const address = typeof facts.leaseAddress === "string" ? facts.leaseAddress : "";
  if (address && (ADDRESS.test(address) || POSTAL_CODE.test(address) || /\b(?:unit|suite)\s*#?\s*\d/i.test(address))) return true;
  const terms = [facts.leaseDetails, facts.propertyInfo].filter((v): v is string => typeof v === "string").join(" ");
  return PREMISES_TERMS.test(terms);
}

/** An equipment word inside a business's name: capitalised and run into the name ("Kingsway Auto Body", "Main Street Printers lease"). */
function inBusinessName(title: string, index: number, word: string): boolean {
  if (NAME_WORD_AFTER.test(title.slice(index + word.length))) return true;
  if (!/^[A-Z]/.test(word)) return false;
  // Capitalised and after another capitalised word of a name ("Main Street
  // Printers", "Kingsway Auto") — not after a model number ("F-150 Truck")
  // or a maker ("Toyota Forklift", "Ford Van").
  const before = title.slice(0, index).match(/([A-Za-z][\w'’.]*)[\s_-]+$/);
  return !!before && /^[A-Z][a-z]/.test(before[1]) && !DESCRIBING_WORD.test(before[1]);
}

/**
 * How strongly a title says its lease is of equipment or vehicles:
 * "strong" when the title says so outright ("Forklift lease", "Equipment
 * Lease Agreements", "Lease of two delivery vans", "Capital lease schedule"),
 * "weak" when an equipment word only describes it elsewhere ("Lease - Toyota
 * forklift"), else "none". An equipment word inside a business's name
 * ("Lease - Kingsway Auto Body", "Main Street Printers lease") is not
 * evidence.
 */
function equipmentEvidence(title: string): "strong" | "weak" | "none" {
  if (EQUIPMENT_LEASE_KIND.test(title)) return "strong";
  for (const m of Array.from(title.matchAll(EQUIPMENT_BESIDE_LEASE))) {
    const word = m[1] ?? m[2];
    const at = (m.index ?? 0) + m[0].indexOf(word);
    if (!inBusinessName(title, at, word)) return "strong";
  }
  // Elsewhere: only a lower-case equipment word in a title that uses capitals
  // (a description, "Lease - Toyota forklift"); an all-lower-case file name
  // ("lease-sparkle-car-wash.pdf") can't tell a description from a name.
  const hasCapitals = /[A-Z]/.test(title);
  for (const m of Array.from(title.matchAll(EQUIPMENT_ANYWHERE))) {
    const word = m[1];
    if (!hasCapitals || /[A-Z]/.test(word) || inBusinessName(title, m.index ?? 0, word)) continue;
    return "weak";
  }
  // A model year and maker, or POS terminals, describe what is leased.
  if (VEHICLE_YEAR_MAKE.test(title) || POS_TERMINALS.test(title)) return "weak";
  return "none";
}

/**
 * True when a source (by its title / type, and the lease facts read from it
 * when given) is a lease of equipment or vehicles, not of premises. A place
 * in the title (a premises word, a street address) always makes it premises;
 * "commercial lease", a tenant or a numbered unit do unless the title says
 * outright what equipment is leased ("Truck lease - Unit 7" is a fleet
 * unit); the lease's own facts (a street address, tenant / landlord /
 * floor-area terms) outweigh an equipment word that only describes it, not a
 * title that says outright what is leased.
 */
export function isEquipmentLeaseTitle(title: string | null | undefined, facts?: LeaseFacts | null): boolean {
  if (!title) return false;
  if (!LEASE_WORD.test(title) && !/\b(?:lessor|lessee)\b/i.test(title)) return false;
  const evidence = equipmentEvidence(title);
  if (evidence === "none") return false;
  // "Office equipment", "warehouse forklift", "shop trucks": the place word
  // describes the equipment, not a premises lease.
  const placeWords = title.replace(
    /\b(?:office|shop|store|retail|warehouse|site|yard|facility|building)\s+(?:equipment|copiers?|photocopiers?|printers?|machines?|machinery|forklifts?|lift trucks?|furniture|fixtures|trucks?|vehicles?|vans?|fleet)\b/gi, " ");
  if (PREMISES_WORD.test(placeWords) || ADDRESS.test(title)) return false;
  if (evidence === "strong") return true;
  return !SOFT_PREMISES_WORD.test(placeWords) && !factsSayPremises(facts);
}

/** True when the title names the business's premises lease (a lease that isn't equipment or vehicles). */
export function isPremisesLeaseTitle(title: string | null | undefined, facts?: LeaseFacts | null): boolean {
  if (!title || !/\blease\b/i.test(title)) return false;
  return !isEquipmentLeaseTitle(title, facts);
}

/** "vehicleLeases" for cars, trucks, vans and tractors; else "equipmentLeases". */
export function equipmentLeaseKey(title: string): "vehicleLeases" | "equipmentLeases" {
  return /\b(?:vehicles?|trucks?|tractors?|trailers?|reefers?|autos?|automobiles?|cars?|vans?|pickups?|fleet)\b/i.test(title) && !/\bforklifts?|lift trucks?\b/i.test(title)
    ? "vehicleLeases"
    : "equipmentLeases";
}

/** Premises-lease fact keys (the ones an equipment lease must not write). */
export const PREMISES_LEASE_KEY = /^(?:lease\w*|monthlyRent|annualRent|rent|landlord|propertyInfo)$/;
