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

/** Things a business leases that are not its premises. */
const EQUIPMENT_WORD =
  /\b(?:equipment|vehicles?|trucks?|tractors?|trailers?|reefers?|forklifts?|lift trucks?|copiers?|photocopiers?|printers?|autos?|automobiles?|cars?|vans?|pickups?|fleet|machines?|machinery|presses|press|excavators?|loaders?|compressors?|telematics|pos terminals?|capital lease|finance lease|chattel)\b/i;

/** Words that say the lease is for a place (a truck yard lease is still premises). */
const PREMISES_WORD =
  /\b(?:premises|shop|office|offices|warehouse|building|retail|suite|property|store|facility|space|land|yard|real estate|site|clinic|restaurant|storefront|head lease|sublease|plaza|mall|landlord)\b/i;

/** A street address ("240 Bayfront Commerce Dr", "12-45 King St W"). */
const ADDRESS =
  /\b\d{1,6}(?:[-–]\d{1,6})?\s+(?:[A-Z][\w'’.-]*\s+){1,4}(?:st|street|rd|road|ave|avenue|dr|drive|blvd|boulevard|way|hwy|highway|cres|crescent|ct|court|pl|place|ln|lane|pkwy|parkway|line|sideroad|concession|terrace|trail|gate|circle|close|square|sq|landing|grove|mews|row)\b\.?/i;

/** The street address a source's title names ("Lease - Seton clinic (118 Hollowbrook Gate SE)" → "118 Hollowbrook Gate"), if any. */
export function addressInTitle(title: string | null | undefined): string | undefined {
  return title ? title.match(ADDRESS)?.[0] : undefined;
}

/** True when the title names a lease of equipment or vehicles, not of premises. */
export function isEquipmentLeaseTitle(title: string | null | undefined): boolean {
  if (!title) return false;
  if (!LEASE_WORD.test(title) && !/\b(?:lessor|lessee)\b/i.test(title)) return false;
  if (!EQUIPMENT_WORD.test(title)) return false;
  // "Office equipment", "warehouse forklift", "shop trucks": the place word
  // describes the equipment, not a premises lease.
  const placeWords = title.replace(
    /\b(?:office|shop|store|retail|warehouse|site|yard|facility|building)\s+(?:equipment|copiers?|photocopiers?|printers?|machines?|machinery|forklifts?|lift trucks?|furniture|fixtures|trucks?|vehicles?|vans?|fleet)\b/gi, " ");
  return !PREMISES_WORD.test(placeWords) && !ADDRESS.test(title);
}

/** True when the title names the business's premises lease (a lease that isn't equipment or vehicles). */
export function isPremisesLeaseTitle(title: string | null | undefined): boolean {
  if (!title || !/\blease\b/i.test(title)) return false;
  return !isEquipmentLeaseTitle(title);
}

/** "vehicleLeases" for cars, trucks, vans and tractors; else "equipmentLeases". */
export function equipmentLeaseKey(title: string): "vehicleLeases" | "equipmentLeases" {
  return /\b(?:vehicles?|trucks?|tractors?|trailers?|reefers?|autos?|automobiles?|cars?|vans?|pickups?|fleet)\b/i.test(title) && !/\bforklifts?|lift trucks?\b/i.test(title)
    ? "vehicleLeases"
    : "equipmentLeases";
}

/** Premises-lease fact keys (the ones an equipment lease must not write). */
export const PREMISES_LEASE_KEY = /^(?:lease\w*|monthlyRent|annualRent|rent|landlord|propertyInfo)$/;
