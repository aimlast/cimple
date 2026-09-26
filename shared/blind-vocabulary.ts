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
  "bookkeeper", "accountant", "controller", "comptroller", "paralegal", "lawyer", "attorney", "barrister", "solicitor", "notary", "secretary",
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

// ── Occupations as words ─────────────────────────────────────────────────

const OCCUPATION_FORMS = new Set<string>(ROLE_QUALIFIERS);
for (const stem of OCCUPATIONS) {
  OCCUPATION_FORMS.add(stem);
  for (const f of roleForms(stem)) OCCUPATION_FORMS.add(f);
}

/** Any form of an occupation or role qualifier, including the ones that are also surnames ("baker", "Tellers"). */
export function isOccupationWord(w: string): boolean {
  const l = bare(w);
  return OCCUPATION_FORMS.has(l) || (ROLE_SUFFIX.test(l) && !SURNAME_ENDING.test(l));
}

/**
 * Occupations that are also common surnames. Right after a given name they
 * are the surname ("Maria Teller", "Tom Baker", "Ann Broker"), not the job —
 * a job next to a first name is written apart from it ("Maria, teller").
 */
const SURNAME_OCCUPATIONS = new Set<string>([
  ...Array.from(NAME_OCCUPATIONS),
  "teller", "broker", "buyer", "agent", "server", "driver", "dyer", "butler", "walker", "taylor", "marshall",
  "sargent", "sheriff", "bishop", "dean", "judge", "reeve", "knight", "squire", "page", "spencer", "chamberlain",
  "stewart", "ward", "warden", "fowler", "fletcher", "archer", "bowman", "fuller", "glover", "hooper", "brewer",
  "cutler", "dexter", "forester", "gardner", "harper", "joiner", "lister", "mercer", "potter", "roper", "salter",
  "saddler", "sawyer", "spinner", "thatcher", "tucker", "waller", "webster", "wheeler", "banker", "cook", "palmer",
  "parker", "piper", "rider", "singer", "skinner", "shoemaker", "stringer", "trainer", "weaver", "woodman",
]);
export function isSurnameOccupation(w: string): boolean {
  return SURNAME_OCCUPATIONS.has(bare(w));
}

// ── Everyday English ─────────────────────────────────────────────────────

/**
 * Everyday English words that turn up in business facts and CIM copy —
 * departments, functions, industries, places of work, seasons and weather,
 * common adjectives and verbs. Used two ways by the guard:
 *   - a one-word person or place name that is one of these ("Frost",
 *     "Normal", "Reading") counts only when capitalised, never as the word,
 *     and a surname that is one ("Emma Winter") is caught only with its
 *     first name or a title ("Ms. Winter"), never alone;
 *   - a staffing phrase built from them ("Patient Care", "Accounts
 *     Payable", "Night Shift") is never read as an unfamiliar person's name.
 * Plurals are derived (accounts → account, resources → resource).
 */
const COMMON = `
able about above access account accounting accredited acquisition across action active activity actual add addition additional address adjacent admin administration administrative adult advance advanced advantage advertising advice advisory affairs after afternoon age agency agreement ahead aid air airport alarm all allied almost alone along alternative always ambulatory american amount analysis analytics ancillary and animal annual answer any apartment apparel appliance application applied appointment approval approved approximately april architectural area around arrangement art arts asphalt assembly asset assist assistance assisted association assurance athletic atlantic audio audit august auto automated automation automotive autumn available average avenue award away
baby back background bad bag bagel bakery bakeshop balance ball band bank banking banquet bar barbershop base based basement basic basin bath bathroom bay beach bean bear beauty bed bedroom beef beer before begin behavioural being bell below belt benefit best better beverage beyond bicycle big bike bill billing bin bird birth bistro black blade blend block blue board boat body boiler bond bonus book booking bookkeeping boot border both bottle bottom boutique bowl box boy branch brand bread break breakfast brewery brick bridge bright bring broad broadcast brook brother brown budget build builder building built bulk bus business busy button buy
cabinet cable cafe cafeteria cake calendar call camera camp campus can canadian candle cannabis capacity capital car card cardiology care career cargo carpet carriage carry cart case cash casino casual catalogue catering cattle cedar ceiling cell cellar cement center centre central ceramic certificate certification chain chair challenge chamber champion chance change channel chapter charge charity chart check chemical chest chicken chief child childcare childhood children chiropractic choice christian christmas church cinema circle circuit citizen city civic civil claim class classic clean cleaning clear clearance client clinic clinical clock close closed closing cloth clothing cloud club coast coastal coat code coffee cold collection college collision colour color column combined comfort commerce commercial common communication community companion company compensation competition competitive complete compliance component computer concept concierge concrete condition conditioning conference connection construction consulting consumer contact content continental continuing contract contracting control convenience cooking cool cooling copy core corner corporate cost cottage council counter country county couple course court cover coverage craft create creative credit crew crop cross crown cuisine culture cup current curriculum custom customer cut cutting cycle
daily dairy damage dance dark data date day daycare dead deal dealer dealership dear debt deck decor decorating deep defence delivery deli dental dentistry department deposit depot design desk dessert detail detailing development device diagnostic diagnostics diamond diesel diet digital dining dinner direct direction discount dispatch display distribution district diversity division dock document dog dollar domestic door double down downtown draft drain drainage dream dress drink drive drug dry drywall due duty
each early earth east eastern easy eat eco economic economy edge education educational effect efficiency eight elder elderly electric electrical electronic electronics elementary elevator else emergency employment empty end energy engine engineering enterprise entertainment entrance entry environment environmental equipment estate estimate estimating europe evening event every exam excavation excellence exchange exercise exhibit existing exit expansion experience expert export express extended exterior external extra eye eyewear freelance remote onsite offsite virtual
fabric fabrication face facial facilities facility factory fair faith fall family fan fancy farm farming fashion fast father feature federal fee feed feet fence fertility festival field file film final finance financial finishing fire firm first fiscal fish fishing fit fitness five fix fixed flat fleet flight floor flooring floral florist flow flower fly focus food foot football force forest forestry form formal formula fort forward foundation four frame franchise free freight fresh friday friend front frost frozen fruit fuel full fun fund funding funeral furnace furniture future
gallery game garage garden gas gate gear general generation gift girl glass global go goal gold golf good goods government grade grain grand grant graphic grass great green grey grill grocery gross ground group grow growth guard guest guide gym
hair hall hand handling happy harbour harbor hard hardware harvest hazard head health healthcare heart heat heating heavy help heritage high highway hill historic history hold holding holiday home homecare honey hospital hospitality host hot hotel hour house household housing human hunting hydraulic hygiene
ice idea image imaging import improvement inbound income independent index indoor industrial industry infant information infrastructure inn innovation input inside inspection install installation institute insurance integrated intensive interior internal international internet intake inventory investment iron island
jewelry jewellery job join joint journal juice junior justice
keep kennel key kid kids kind king kitchen knowledge
lab label labour labor lake land landscape landscaping lane language large laser last late launch laundry law lawn layout lead leader leadership learning lease leasehold freehold leasing leather left legacy legal leisure lens level liberty library licence license life lift light lighting limited line linen link liquor list live living load loan local location lock lodge log logistics long loss lot love low lower loyalty lumber lunch luxury
machine machinery machining magazine mail main maintenance major make making mall man managed management manor manufacturing map maple marble marine mark market marketing marketplace mart massage master material maternity matter meadow meal means measure meat mechanical media medical medicine medium meeting member membership memory mental menu merchandise metal method metro middle mild mile military milk mill mind mini mining minor mint mission mix mobile mode model modern monday money month monthly more morning mortgage mother motion motor mountain mouth move moving multi municipal music
nail name nation national natural nature near network new news next nice night nine noble none normal north northern note nursery nursing nutrition
oak oasis ocean office official oil old olds on one online open opening operating operation operational operations optical optometry oral orange orchard order organic origin other outdoor outdoors outlet outpatient output outreach outside oven over overhead own
pacific pack package packaging page paint painting pair palace panel paper park parking part party pass passenger past pasta pastry path patient patio pay payable payment payroll peace peak pediatric pension people performance period personal pest pet pharmacy phase phone photo photography physical physio physiotherapy pick piece pine pipe pizza pizzeria place plan planning plant plastic plate platinum play plaza plumbing plus point police policy polish pool popular port portable portfolio post power practice premier premium prep prepaid presence press prestige prevention price pricing pride primary prime print printing priority private pro process processing produce product production professional program progress project property protection provincial public pub pump purchase purchasing pure purpose
quality quarter quick quiet
race radio rail rain ranch range rate raw reading ready real realty rear receivable reception record recovery recreation recruiting recycling red referral region regional regular rehab rehabilitation relations relief remodeling renewal rent rental repair report reporting research reservation residential resort resource restaurant restoration retail retirement return revenue review ridge right ring risk river road rock roof roofing room root rose round route routine royal rural
safe safety sale salon salt sand sandwich saturday sauce savings school science screen sea seafood seal search season seasonal seat second secondary secure security seed select senior sense septic series service session set settlement seven shade shape share sharp sheet shelf shell shelter shield shift ship shipping shoe shop shore short show shower side sign silver simple single site six size skill skin sky sleep small smart smile smith smoke snow social soft software soil solar sole solid solution sound source south southern space spa special specialty speed sport spring square staff stage standard star start state station steel step stock stone storage store storm story strategic strategy street strength strong structure student studio study style success suite summer summit sun sunday sunrise sunset super supply support surface surgery surgical survey sustainable sweet swim system
table take talent tank target tax taxi tea teaching team tech technical technology telecom temple ten tenant term terminal test testing textile theatre therapy thermal third three thrift thursday tile timber time tire title today together tool top total tour tourism tower town toy track trade trading traffic trail trailer training transfer transit transport transportation travel treatment tree trend trial trip triple truck trucking trust tuesday turf twin two type
union unit united unity universal university upper urban urgent used utility
vacation valley value van vapor vape variety vehicle vending venture vet veterinary video view village vintage vision visit visual vital voice volume
wage walk wall warehouse warm warranty wash waste watch water way wealth wear weather web website wedding wednesday week weekend weekly weight welcome well wellness west western wet wheel white whole wholesale wide wild wind window wine winery winter wire wise wood work workforce working workshop world worship
yard year yellow yoga young youth
zone
ask asks brings cares covers does done gets goes has have helps holds keeps leads made makes manages meets needs offers plans provides runs said says serves shows takes uses will may might must shall should would could
jan feb mar apr jun jul aug sep sept oct nov dec january february march june july
`;

const COMMON_WORDS = new Set(COMMON.split(/\s+/).filter(Boolean));

/** An everyday English word (lowercase, folded), including simple plurals and possessives. */
export function isCommonWord(w: string): boolean {
  const l = bare(w);
  if (COMMON_WORDS.has(l) || EVERYDAY_NAME_WORDS.has(l) || isOccupationWord(l)) return true;
  if (l.length > 3 && l.endsWith("s")) {
    const stems = [l.slice(0, -1)];
    if (l.endsWith("es")) stems.push(l.slice(0, -2));
    if (l.endsWith("ies")) stems.push(`${l.slice(0, -3)}y`);
    return stems.some((s) => COMMON_WORDS.has(s) || EVERYDAY_NAME_WORDS.has(s));
  }
  return false;
}

/**
 * National and global brands a business buys, drives or sells — vehicle
 * makes, equipment and HVAC manufacturers, software, big-box retailers and
 * national distributors. Thousands of businesses use each one, so "leased
 * Lexus", "authorized Lennox dealer" or "Samsara dash cams" names nothing:
 * never read as one of the deal's counterparties. (A local supplier,
 * landlord or customer still is.) Folded, lowercase.
 */
const NATIONAL_BRAND_LIST = `
ford chevrolet chevy gmc ram dodge chrysler jeep toyota lexus honda acura nissan infiniti hyundai kia mazda subaru volkswagen vw audi bmw mercedes benz porsche tesla volvo buick cadillac mitsubishi isuzu hino sprinter
freightliner kenworth peterbilt mack navistar international western star paccar cummins detroit bendix wabash utility manac stoughton hyundai translead thermo king carrier transicold great dane
caterpillar cat deere kubota bobcat komatsu doosan hitachi jcb takeuchi genie skyjack jlg hyster yale toyota husqvarna stihl toro exmark scag hustler
lennox trane goodman amana daikin rheem ruud york bryant payne heil tempstar napoleon fujitsu mitsubishi lg samsung bosch navien rinnai viessmann honeywell ecobee nest
microsoft google apple amazon adobe oracle intuit quickbooks sage xero freshbooks ceridian adp paychex dayforce wagepoint shopify square clover lightspeed toast moneris stripe paypal salesforce hubspot zoho
samsara geotab motive keeptruckin omnitracs fleetio axon magaya mcleod trimble verizon
sysco gfs costco walmart target loblaw sobeys metro safeway kroger amazon homedepot lowes rona wolseley emco grainger fastenal uline staples
dentsply sirona schein straumann invisalign
mckesson amerisourcebergen cencora
connectwise kaseya datto ninjaone ninjarmm nable sentinelone crowdstrike sophos huntress fortinet sonicwall cisco meraki ubiquiti veeam barracuda mimecast proofpoint webroot pax8 ingram synnex itglue dell lenovo 3cx ringcentral zoom dropbox autodesk procore crown case
`;
const NATIONAL_BRANDS = new Set(NATIONAL_BRAND_LIST.split(/\s+/).filter(Boolean));

/** A national or global brand (folded, lowercase) — never a local counterparty. */
export function isNationalBrand(w: string): boolean {
  return NATIONAL_BRANDS.has(w.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

/**
 * Regions wider than one province or state ("the Midwest", "the Maritime
 * provinces", "Atlantic Canada", "the Prairies", "the Pacific Northwest").
 * A Blind CIM may name them, so a customer or supplier named after one
 * ("Midwest Polymer", "Maritime Smiles") is caught by its full name, never by
 * the region word alone. Folded, lowercase.
 */
const BROAD_REGION_WORDS = new Set(`
midwest midwestern maritime maritimes atlantic pacific prairie prairies northeast northeastern northwest northwestern
southeast southeastern southwest southwestern midatlantic gulf appalachia appalachian rockies cascadia heartland
sunbelt lowcountry tristate panhandle interior northern southern eastern western central coastal canadian american
`.split(/\s+/).filter(Boolean));

/** A word naming a region wider than a province or state ("Midwest", "Maritime", "Mid-Atlantic"). */
export function isBroadRegionWord(w: string): boolean {
  const f = w.toLowerCase().normalize("NFKD").replace(/[^a-z]/g, "");
  return BROAD_REGION_WORDS.has(f) || BROAD_REGION_WORDS.has(f.replace(/s$/, ""));
}

/**
 * What a software product, a tool or a vendor service is — "NinjaOne RMM",
 * "SentinelOne EDR", "Datto (on-site backup appliances)", "Fortinet
 * (standard firewall)", "CareMAR eMAR interface". A tool the business runs
 * on is used by thousands of others and names nothing (redaction rule 5
 * keeps such brands). Read from the words right after a name in a supplier,
 * vendor or contract fact — never in a customer fact. Folded, lowercase.
 */
export const TOOL_CATEGORY_WORDS = new Set(`
rmm psa edr xdr mdr siem soc bcdr bdr erp crm pos ehr emr emar tms wms eld pms hris lms dms voip saas
software platform app apps firewall firewalls antivirus ticketing documentation telematics dashcam dashcams
backup backups scanner scanners dispensing packager packagers plugin
`.split(/\s+/).filter(Boolean));
/** Tool acronyms that are also everyday words in lowercase ("MAR" medication record vs "Mar 2026", "CAD"): capitals only. */
export const TOOL_CATEGORY_ACRONYMS = new Set(["MAR", "CAD", "CAM", "MES", "CMMS"]);
