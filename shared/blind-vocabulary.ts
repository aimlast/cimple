/**
 * Word lists for the Blind-CIM identity guard (shared/blind-guard.ts).
 *
 *   - Roles and professions: the nouns and qualifiers of a staffing fact
 *     ("Licensed Plumbers: 4", "Registered Massage Therapists (6)",
 *     "Certified Welders"). They say what the team does, which a Blind CIM
 *     must be able to say, so they are never read as a person's name.
 *   - Everyday words that are also names, streets or towns ("Bill",
 *     "Market", "Hope"): in all-lowercase they are the word, not the name.
 *
 * Pure data + tiny helpers; embedded in code (no runtime files).
 */

/** Occupations and trades (singular). Plurals and -man → -men are derived. */
const OCCUPATIONS = [
  // trades & construction
  "plumber", "electrician", "welder", "fabricator", "machinist", "mechanic", "millwright", "pipefitter", "steamfitter",
  "ironworker", "boilermaker", "framer", "roofer", "drywaller", "plasterer", "bricklayer", "stonemason", "tiler",
  "insulator", "labourer", "laborer", "apprentice", "journeyman", "journeyperson", "tradesman", "tradesperson",
  "craftsman", "craftsperson", "handyman", "repairman", "serviceman", "lineman", "landscaper", "arborist",
  "groundskeeper", "janitor", "custodian", "cleaner", "housekeeper", "mover", "trucker", "courier", "hauler",
  "surveyor", "engineer", "architect", "drafter", "draftsman", "designer", "developer", "programmer", "coder",
  "analyst", "tester", "inspector", "auditor", "estimator", "installer", "operator", "assembler", "upholsterer",
  "finisher", "polisher", "detailer", "worker", "helper", "subcontractor", "contractor", "sub", "tech",
  "technician", "technologist", "specialist", "generalist", "scientist", "chemist", "biologist", "glazier",
  "carpenter", "painter", "gardener", "fitter", "mason", "tailor", "packer", "baker", "butcher", "barber", "turner",
  "cooper", "porter", "fisher", "hunter", "miller", "sawyer", "smith", "wright", "weaver", "farmer", "slater",
  "tanner", "chandler", "collier", "carter", "thatcher", "draper", "fowler", "shepherd", "steward", "hand",
  // health & care
  "dentist", "hygienist", "therapist", "physiotherapist", "chiropractor", "optometrist", "optician", "pharmacist",
  "physician", "surgeon", "doctor", "nurse", "practitioner", "paramedic", "medic", "caregiver", "aide", "attendant",
  "orderly", "counsellor", "counselor", "psychologist", "psychotherapist", "kinesiologist", "dietitian",
  "nutritionist", "veterinarian", "vet", "groomer", "midwife", "doula", "denturist", "orthodontist", "radiologist",
  "sonographer", "phlebotomist", "receptionist", "scheduler",
  // hospitality, retail & services
  "chef", "cook", "server", "waiter", "waitress", "bartender", "barista", "host", "hostess", "dishwasher", "busser",
  "cashier", "teller", "clerk", "stocker", "merchandiser", "salesperson", "salesman", "saleswoman",
  "representative", "rep", "agent", "broker", "realtor", "underwriter", "adjuster", "appraiser", "stylist",
  "hairstylist", "hairdresser", "esthetician", "aesthetician", "cosmetologist", "manicurist", "tattooist",
  "photographer", "videographer", "editor", "writer", "copywriter", "marketer", "recruiter", "trainer", "instructor",
  "teacher", "tutor", "educator", "coach", "guide", "lifeguard", "guard", "valet", "driver", "chauffeur",
  "dispatcher", "planner", "coordinator", "buyer", "purchaser", "picker", "loader", "shipper", "receiver",
  "warehouseman",
  // office & professional
  "bookkeeper", "accountant", "controller", "comptroller", "paralegal", "lawyer", "attorney", "notary", "secretary",
  "typist", "administrator", "assistant", "associate", "consultant", "advisor", "adviser", "manager", "supervisor",
  "director", "officer", "executive", "foreman", "forewoman", "foreperson", "superintendent", "leadhand",
  "principal", "partner", "owner", "founder", "employee", "staffer", "volunteer", "intern", "trainee", "student",
  "temp", "freelancer", "member", "hire",
];

/** Occupations that are also surnames or first names: only the plural is a role ("Bakers", but "John Baker"). */
const NAME_OCCUPATIONS = new Set([
  "mason", "tailor", "packer", "baker", "butcher", "barber", "turner", "cooper", "porter", "fisher", "hunter", "miller",
  "sawyer", "smith", "wright", "weaver", "farmer", "slater", "tanner", "chandler", "collier", "carter", "thatcher",
  "draper", "fowler", "shepherd", "steward", "carpenter", "painter", "gardener", "glazier", "fitter", "cook", "hand",
  "guide", "host", "member", "partner", "coach", "guard", "clerk",
]);

/** Words that qualify a role ("Licensed", "Red Seal", "Senior") — never a name. */
const ROLE_QUALIFIERS = [
  "licensed", "licenced", "certified", "registered", "accredited", "qualified", "unqualified", "skilled", "unskilled",
  "semi", "trained", "experienced", "master", "red", "seal", "unionized", "unionised", "salaried", "hourly",
  "bilingual", "seasonal", "casual", "temporary", "permanent", "frontline", "journeyman", "apprentice",
];

function roleForms(stem: string): string[] {
  const out = [`${stem}s`];
  if (/(?:s|x|ch|sh)$/.test(stem)) out.push(`${stem}es`);
  if (/[^aeiou]y$/.test(stem)) out.push(`${stem.slice(0, -1)}ies`);
  if (/woman$/.test(stem)) out.push(`${stem.slice(0, -5)}women`);
  else if (/man$/.test(stem)) out.push(`${stem.slice(0, -3)}men`);
  if (/person$/.test(stem)) out.push(`${stem.slice(0, -6)}people`);
  return out;
}

const ROLE_WORDS = new Set<string>(ROLE_QUALIFIERS);
const PLURAL_ROLE_WORDS = new Set<string>();
for (const stem of OCCUPATIONS) {
  if (!NAME_OCCUPATIONS.has(stem)) ROLE_WORDS.add(stem);
  for (const f of roleForms(stem)) {
    ROLE_WORDS.add(f);
    PLURAL_ROLE_WORDS.add(f);
  }
}

/**
 * Professions by their ending: "Therapists", "Electricians", "Kinesiologist".
 * A consonant before "-ist" and 7+ letters keeps surnames out ("Feist",
 * "Priest", "Holmquist"); Nordic "-qvist" surnames ("Lindqvist") are excluded.
 */
const ROLE_SUFFIX = /^[a-z]{3,}[^aeiou](?:ist|ists)$|^[a-z]{2,}(?:ician|icians|ologist|ologists)$/;
const PLURAL_ROLE_SUFFIX = /^[a-z]{3,}[^aeiou]ists$|^[a-z]{2,}(?:icians|ologists)$/;
const SURNAME_ENDING = /qvists?$/;

const bare = (w: string) => w.toLowerCase().replace(/['’]s$/, "");

/** A capitalised word that names a role, a profession or its qualifier — never a person. */
export function isRoleWord(w: string): boolean {
  const l = bare(w);
  return ROLE_WORDS.has(l) || (ROLE_SUFFIX.test(l) && !SURNAME_ENDING.test(l));
}

/** A plural role noun ("Plumbers", "Therapists", "Tradesmen", "Salespeople") — a group, never a person. */
export function isPluralRole(w: string): boolean {
  const l = bare(w);
  return PLURAL_ROLE_WORDS.has(l) || (PLURAL_ROLE_SUFFIX.test(l) && !SURNAME_ENDING.test(l));
}

/**
 * Everyday words that are also first names, streets or towns. Checked on
 * one-word person/place terms, together with the guard's own lists of
 * surname-words and generic street words.
 */
export const EVERYDAY_NAME_WORDS = new Set([
  // first names / nicknames that are words
  "bill", "rob", "sue", "pat", "art", "don", "ray", "jay", "guy", "max", "bob", "kit", "van", "dawn", "summer",
  "autumn", "april", "june", "august", "sky", "river", "brook", "cliff", "glen", "dale", "heath", "sandy", "misty",
  "crystal", "amber", "ruby", "pearl", "iris", "lily", "holly", "ivy", "violet", "daisy", "angel", "chip", "sage",
  "star", "storm", "gene", "drew", "penny", "jack", "rusty", "buck", "rocky", "robin", "jewel", "hazel", "olive",
  "rosemary", "heather", "ginger", "honey", "candy", "destiny", "harmony", "trinity", "patience", "prudence",
  "mercy", "earnest", "wade", "miles", "carol", "terry", "nick", "dick", "sunny",
  // street, place and landmark words
  "queen", "water", "market", "mill", "mills", "springs", "lake", "lakes", "station", "maple", "oak", "pine",
  "cedar", "birch", "willow", "poplar", "ash", "spruce", "walnut", "chestnut", "cherry", "apple", "orchard",
  "garden", "gardens", "meadow", "meadows", "forest", "grove", "ridge", "valley", "hills", "mountain", "summit",
  "harbour", "harbor", "bay", "beach", "shore", "ocean", "sea", "island", "canal", "dock", "wharf", "pier", "port",
  "front", "high", "college", "university", "school", "hospital", "railway", "rail", "union", "commerce",
  "enterprise", "industry", "technology", "research", "innovation", "progress", "victory", "liberty", "freedom",
  "independence", "unity", "pioneer", "frontier", "heritage", "legacy", "century", "millennium", "crown", "royal",
  "regent", "prince", "princess", "duke", "earl", "castle", "palace", "abbey", "temple", "chapel", "parish",
  "mission", "gateway", "horizon", "sunset", "sunrise", "silver", "diamond", "emerald", "coral", "jade", "iron",
  "rock", "granite", "marble", "clay", "sand", "forge", "foundry", "factory", "farm", "ranch", "prairie",
  "plains", "fairway", "greens", "links", "vale", "creek", "falls", "rapids", "well", "fountain", "pond", "moor",
  "downs", "crest", "peak", "point", "cape", "haven", "landing", "crossing", "junction", "corners", "common",
  "commons", "exchange", "trade", "merchant", "mint", "fort", "airport", "terminal", "transit", "metro", "central",
  "civic", "municipal", "federal", "national", "provincial", "colonial", "dominion", "empire", "parliament",
  "senate", "council", "assembly", "justice", "peace", "concord", "welcome", "paradise", "eden", "delta", "orange",
  "mount", "bear", "eagle", "falcon", "raven", "heron", "deer", "elk", "moose", "beaver", "otter", "buffalo",
  "bison", "mustang", "red", "blue", "division", "upper", "lower", "old", "new", "grand", "great", "broad", "wide",
  "deep", "clear", "pleasant", "prospect", "view", "vista", "cross", "gate", "manor", "lodge", "cottage", "barn",
  "tower", "towers", "industrial", "commercial", "business", "harvest", "sterling", "orchid",
]);
