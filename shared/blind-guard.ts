/**
 * blind-guard — the deterministic identity check for everything a Blind
 * (pre-NDA / teaser / full-access) buyer can receive.
 *
 * The AI redactor is the first line of defence; this is the backstop that
 * lets every blind path FAIL CLOSED: a redaction that still names the
 * business, a person, the city or the street is never committed, a blind
 * section that still does is never served, and a Q&A answer or an outreach
 * draft that does is never shared.
 *
 * Terms come from the deal's facts (extractedInfo, employeeChart) — never
 * guessed from the text being checked, so a clean blind text can't trip it.
 * The one exception is a number a label calls a registration, licence or
 * permit number: no blind text may carry one. Two tiers:
 *
 *   CERTAIN (fail-closed) — what the facts say outright:
 *     - every business-name variant (blindIdentifiers) and its distinctive
 *       core ("Harbourline Dental Group" → "Harbourline"), owners, website,
 *       email domains and social handles;
 *     - the people in people facts (owner, staff, key employees, office
 *       manager, associates, contacts…) and dedicated name fields;
 *     - city, street, postal code from location facts, street lines and
 *       postal codes anywhere in the facts;
 *     - email addresses and phone numbers anywhere in the facts;
 *     - the staff list (deals.employeeChart);
 *     - the organisations counterparty facts name — customers, landlord,
 *       suppliers, lenders, advisers ("Alderbrook", "Silvergate",
 *       "Westshore Commercial Bank") — never a national brand the business
 *       uses or sells ("Lexus", "authorized Lennox dealer");
 *     - registration, licence and permit numbers in the facts, matched on
 *       their digits in any format, and ANY labelled public identifier in
 *       the text checked ("USDOT 9318842", "MC-123456", "NSC BC 20-487-316").
 *   People named in passing in any other fact are read as prose (a title
 *   or a known given name: "VP Doug Fairweather").
 *   A person in a people fact is read from its structure, whatever follows
 *   the name: "Carlos Reyes (12)", "Hygienists: Priya (7), Thomas (3)",
 *   "Chris Jones: 6 yrs", "Maria Teller (bookkeeper)", "Anita Patel 51%".
 *
 *   CONSERVATIVE (heuristic) — a capitalised phrase is a person only when it
 *   is very likely one: it starts with a known given name ("Amy Evans"), it
 *   follows a title ("Dr. Frost"), or it stands alone as a list entry
 *   ("Xiaoling Wu (12)"). Job titles and staffing phrases are never people:
 *   "Patient Care Coordinator", "Lawn Care Technician", "Accounts Payable",
 *   "Licensed Plumbers: 4", "Registered Massage Therapists (6)".
 *
 * A single everyday word ("Frost", "Normal", "Bill", "Market") is never an
 * identifier on its own merely because it appears inside a longer name —
 * "Emma Winter" is caught as "Emma Winter" or "Ms. Winter", not as
 * "winter". When the fact itself IS that one word (a town called Normal,
 * a driver called Bill), it counts only capitalised or in capitals: the
 * all-lowercase form is the word ("a normal week", "pay the bill").
 *
 * Matching is whole-word on accent-, punctuation- and whitespace-folded
 * text and ignores case otherwise: "KITCHENER", "Kitchener" and "kitchener"
 * are all the city; "KITCHENER'S" and "Carlos (12)" are caught too. Phone
 * numbers also match digit-for-digit ("5195550142"). Pure — used by the
 * server (redaction, view room, Q&A, outreach) and the broker's preview.
 */
import { blindIdentifiers } from "./blind-identifiers";
import { REGION_NAMES, isRegionLabel, isRegionWord } from "./cim-media";
import { GIVEN_NAMES } from "./blind-given-names";
import {
  EVERYDAY_NAME_WORDS,
  isCommonWord,
  isOccupationWord,
  isPluralRole,
  isRoleWord,
  isNationalBrand,
  isSurnameOccupation,
} from "./blind-vocabulary";

export type BlindTermKind = "name" | "person" | "place" | "contact" | "registry";

export interface BlindTerm {
  /** The identifying text as it appears in the facts. */
  text: string;
  kind: BlindTermKind;
  /**
   * A one-word name that is also an everyday word: an all-lowercase
   * occurrence is the word, not the name. Every other term matches in any
   * case.
   */
  common: boolean;
  /**
   * A surname that is also an everyday word ("Ms. Winter" for Emma Winter):
   * it counts only with a title in front ("Mr. Winter", "DR WINTER") or
   * "family" after it — never as the word on its own.
   */
  titled?: boolean;
  /**
   * A one-word surname that is also part of a province, state or country
   * name ("Dana Washington", "Joe Montana", "Lisa York"): it counts
   * wherever it stands for the person — everywhere except where the text
   * uses it as the place ("Washington State lanes", "customers in
   * Montana", "New York").
   */
  regionWord?: boolean;
  /**
   * A registration, licence or permit number from the facts ("NSC BC
   * 20-487-316", "BC0571234"): its longest digit run, matched digit for
   * digit wherever it is written ("20 487 316", "#20487316").
   */
  digits?: string;
  /**
   * The built-in check for ANY labelled public identifier in the text —
   * "USDOT 9318842", "MC-123456", "Business Number 81234 5678 RC0001",
   * "Licence No. 44721" — whether or not the facts hold it: a regulator's
   * lookup names the company. A hit reports the identifier as written.
   */
  anyRegistryId?: boolean;
  /**
   * A term that is also a word of the deal's codename ("Kestrel" as a
   * customer of "Project Kestrel"): the codename itself doesn't count, any
   * other mention does. Folded.
   */
  codename?: string;
}

type AnyRecord = Record<string, unknown>;
const isObj = (v: unknown): v is AnyRecord => !!v && typeof v === "object" && !Array.isArray(v);

/** Letters NFKD doesn't decompose into a base letter + accent. */
const TRANSLITERATE: Record<string, string> = {
  ø: "o", Ø: "O", æ: "ae", Æ: "AE", œ: "oe", Œ: "OE", ß: "ss", ł: "l", Ł: "L", đ: "d", Đ: "D", ð: "d", Ð: "D", þ: "th", Þ: "TH", ı: "i",
};

/**
 * Accent-, punctuation- and whitespace-folded text with single spaces
 * between words (ASCII letters and digits only), lowercased unless
 * `keepCase`. Invisible characters (soft hyphen, zero-width space) are
 * dropped, so "Kitch­ener" is "Kitchener".
 */
export function foldForMatch(s: string, keepCase = false): string {
  const t = s
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[øØæÆœŒßłŁđĐðÐþÞı]/g, (c) => TRANSLITERATE[c] ?? c)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
  return keepCase ? t : t.toLowerCase();
}

// ── Vocabulary ────────────────────────────────────────────────────────────

/**
 * Capitalised words that are roles, generic nouns or sentence starters —
 * never part of a person's name. Stops "Office Manager" or "Two hygienists"
 * being read as people (the redactor writes exactly those role labels).
 */
const NOT_NAME_WORDS = new Set([
  // roles & titles
  "owner", "owners", "founder", "cofounder", "partner", "partners", "principal", "president", "vice", "chief",
  "executive", "officer", "director", "directors", "manager", "managers", "management", "supervisor", "foreman",
  "lead", "head", "senior", "junior", "associate", "associates", "assistant", "assistants", "coordinator",
  "administrator", "admin", "receptionist", "bookkeeper", "controller", "accountant", "accountants", "lawyer",
  "attorney", "counsel", "advisor", "adviser", "consultant", "technician", "technicians", "hygienist", "hygienists",
  "dentist", "dentists", "doctor", "doctors", "physician", "nurse", "nurses", "chef", "cook", "driver", "drivers",
  "operator", "operators", "installer", "installers", "estimator", "dispatcher", "sales", "marketing", "finance",
  "financial", "operations", "operational", "general", "office", "front", "desk", "clinical", "clinic", "practice",
  "staff", "team", "employee", "employees", "crew", "family", "spouse", "wife", "husband", "son", "daughter",
  "brother", "sister", "father", "mother", "ceo", "cfo", "coo", "cto", "vp", "hr", "it", "gm",
  // organisations & places (words that sit next to names)
  "company", "corporation", "corp", "inc", "ltd", "llc", "group", "holdings", "enterprises", "services", "service",
  "solutions", "partners", "cpa", "llp", "bank", "trust", "insurance", "dental", "medical", "health", "plaza",
  "road", "street", "avenue", "drive", "boulevard", "unit", "suite", "centre", "center", "mall", "building",
  // generic words that start sentences or list items
  "the", "a", "an", "and", "or", "of", "for", "with", "in", "on", "at", "to", "by", "from", "about", "approx",
  "approximately", "around", "roughly", "including", "includes", "plus", "also", "both", "all", "none", "each",
  "every", "neither", "either", "several", "multiple", "various", "many", "few", "some", "other", "others", "total",
  "full", "part", "time", "new", "current", "former", "previous", "prior", "existing", "key", "main", "primary",
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "first",
  "second", "third", "yes", "no", "not", "unknown", "none", "tbd", "see", "note", "notes", "per", "year", "years",
  "month", "months", "week", "weeks", "day", "days", "he", "she", "they", "his", "her", "their", "we", "our",
  "this", "that", "these", "those", "is", "was", "has", "have", "will", "would", "may", "might", "can", "could",
  "if", "when", "after", "before", "since", "until", "while", "during", "only", "just", "mostly", "mainly",
  "willing", "open", "plans", "plan", "low", "high", "turnover", "tenure", "people", "person", "persons",
  "since", "joined", "hired", "left", "retired", "retiring", "remains", "stays", "staying", "leaving", "handles",
  "vacant", "tbd", "tba", "pending", "hiring", "open", "position", "role", "contract", "contractor", "temp", "various",
]);

/**
 * Surnames that are also everyday English words — checked only as part of a
 * full name, never on their own ("asking Price", "Young team").
 */
const COMMON_WORD_SURNAMES = new Set([
  "price", "young", "green", "brown", "white", "black", "gray", "grey", "rich", "long", "king", "hill", "wood",
  "woods", "cook", "best", "bell", "hall", "ward", "wells", "banks", "lane", "stone", "rivers", "may", "march",
  "frank", "grant", "chase", "hunter", "fisher", "baker", "walker", "turner", "carter", "parker", "cooper",
  "miller", "taylor", "mason", "porter", "archer", "bishop", "butler", "page", "law", "lord", "love", "moss",
  "reed", "rose", "west", "east", "north", "south", "sharp", "short", "strong", "sweet", "swift", "day", "knight",
  "little", "field", "fields", "ford", "gold", "golden", "marsh", "park", "pope", "power", "powers", "rice",
  "root", "salt", "sands", "small", "snow", "spring", "steel", "summers", "waters", "wolf", "fox", "lamb", "bird",
  "crane", "drake", "finch", "hawk", "swan", "hope", "joy", "faith", "grace", "will", "case", "cash", "dean",
  "major", "mark", "rich", "noble", "sterling", "chance", "bond", "street", "church", "english", "french",
  "german", "welsh", "england", "holland", "wall", "gates", "fair", "free", "good", "hardy", "wise", "bright",
  "frost", "winter", "summer", "spring", "autumn", "storm", "rain", "cloud", "sun", "moon", "star", "stars",
]);

/** Street words too generic to identify anything on their own. */
const GENERIC_STREET_WORDS = new Set([
  "street", "avenue", "drive", "boulevard", "court", "crescent", "place", "parkway", "highway", "road", "lane",
  "south", "north", "east", "west", "suite", "floor", "plaza", "centre", "center", "route", "square", "terrace",
  "trail", "circle", "building", "level", "industrial", "unit", "units", "mall", "park", "business", "commercial",
  "suburban", "downtown", "main", "strip", "shopping", "office", "offices", "tower", "towers", "block",
]);

/** Connector words allowed inside a place name ("Plaza on Fairway Road", "Niagara-on-the-Lake"). */
const PLACE_CONNECTORS = new Set(["on", "of", "the", "de", "du", "la", "le", "les", "des", "and", "at", "sur", "upon", "in"]);

/** Words that follow an organisation's or a place's name ("Kowalski Hospitality Inc", "Fairway Plaza"). */
const ORG_WORDS = new Set([
  "company", "co", "corporation", "corp", "inc", "incorporated", "ltd", "limited", "llc", "llp", "lp", "ulc", "group",
  "holdings", "enterprises", "services", "solutions", "partners", "associates", "cpa", "bank", "trust", "insurance",
  "dental", "medical", "health", "clinic", "practice", "plaza", "centre", "center", "mall", "building", "road",
  "street", "avenue", "drive", "boulevard", "pllc", "pc",
]);

/**
 * A one-word name that is also an everyday word ("Bill", "Market", "Frost",
 * "Normal", "Teller"). Takes a folded (lowercase ASCII) word.
 */
function isEverydayWord(folded: string): boolean {
  if (!folded || folded.includes(" ")) return false;
  return EVERYDAY_NAME_WORDS.has(folded) || COMMON_WORD_SURNAMES.has(folded) || GENERIC_STREET_WORDS.has(folded) ||
    NOT_NAME_WORDS.has(folded) || ORG_WORDS.has(folded) || isCommonWord(folded);
}

// ── Reading people out of a people fact ───────────────────────────────────

// Letters, including accented ones ("Émilie", "Åberg"). JS \b is ASCII-only,
// so word edges are written out as "not a letter" instead.
const LETTER = "A-Za-zÀ-ÖØ-öø-ÿ";
const UPPER = "A-ZÀ-ÖØ-Þ";
const UPPER_START = new RegExp(`^[${UPPER}]`);
const ALL_CAPS = new RegExp(`^[${UPPER}'’-]+$`);
const startsUpper = (w: string) => UPPER_START.test(w);
/** A word: "Anita", "O'Brien", "Jean-Luc", "Patel's". */
const WORD_RE = new RegExp(`[${LETTER}](?:[${LETTER}]|['’](?=[${LETTER}])|-(?=[${LETTER}]))*`, "g");

const HONORIFICS = new Set(["dr", "dre", "mr", "mrs", "ms", "miss", "mx", "prof", "sir", "dame"]);
/** Lowercase name particles inside a name ("Maria de la Cruz", "Ludwig van Dyke"). */
const PARTICLES = new Set(["de", "del", "della", "der", "den", "di", "da", "dos", "das", "du", "la", "le", "van", "von", "ter", "ten", "bin", "ibn", "al", "el"]);
const NUMBER_WORD = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple|many|few|some|both|all)$/;

interface Tok {
  /** The word as written, possessive dropped ("Patel's" → "Patel"). */
  text: string;
  /** Folded lowercase form ("brodeur lefevre" for "Brodeur-Lefèvre"). */
  key: string;
  /** Folded first part — the given-name check ("jean" for "Jean-Luc"). */
  head: string;
  cap: boolean;
  allCaps: boolean;
  initial: boolean;
  /** Written with a possessive ("Maria's") — a name ends there. */
  poss: boolean;
  start: number;
  end: number;
}

function tokens(text: string): Tok[] {
  const out: Tok[] = [];
  for (const m of Array.from(text.matchAll(WORD_RE))) {
    const raw = m[0];
    const t = raw.replace(/['’][sS]$/, "");
    const key = foldForMatch(t);
    if (!key) continue;
    out.push({
      text: t,
      key,
      head: key.split(" ")[0],
      cap: startsUpper(t),
      allCaps: t.length > 1 && ALL_CAPS.test(t),
      initial: t.length === 1 && startsUpper(t),
      poss: t !== raw,
      start: m.index ?? 0,
      end: (m.index ?? 0) + raw.length,
    });
  }
  return out;
}

const isHonorific = (t: Tok) => t.cap && HONORIFICS.has(t.key);
const isGiven = (t: Tok) => GIVEN_NAMES.has(t.head) || GIVEN_NAMES.has(t.key.replace(/ /g, ""));
const everyday = (t: Tok) => t.key.split(" ").every((p) => isEverydayWord(p));
/** Words that are never (part of) a person's name. */
const isStop = (t: Tok) =>
  isHonorific(t) || NUMBER_WORD.test(t.key) || (NOT_NAME_WORDS.has(t.key) && !isGiven(t)) || isRoleWord(t.text);
/** Title words that may precede a name ("Office Manager Sandra Lee", "Lead Plumber"). */
const isTitle = (t: Tok) => isHonorific(t) || NOT_NAME_WORDS.has(t.key) || isOccupationWord(t.text) || t.initial;

/**
 * Runs of capitalised words, as written ("Office Manager Sandra Lee",
 * "Dr. A. Patel", "Maria de la Cruz"). A run breaks at any punctuation,
 * digit or lowercase word, except the dot after a title or an initial.
 */
function capitalRuns(text: string): Tok[][] {
  const toks = tokens(text);
  const runs: Tok[][] = [];
  let run: Tok[] = [];
  const flush = () => {
    while (run.length && !run[run.length - 1].cap) run.pop(); // a trailing particle
    if (run.length) runs.push(run);
    run = [];
  };
  toks.forEach((t, i) => {
    const prev = run[run.length - 1];
    const gap = prev ? text.slice(prev.end, t.start) : "";
    // "Maria's Lexus": a possessive ends the name before it.
    const joins = !!prev && !prev.poss && (/^[ \t]+$/.test(gap) || (/^\.[ \t]*$/.test(gap) && (isHonorific(prev) || prev.initial)));
    // A particle joins when more particles and then a capitalised word follow ("de la Cruz").
    let k = i;
    while (k < toks.length && !toks[k].cap && PARTICLES.has(toks[k].key) && !!toks[k + 1] && /^[ \t]+$/.test(text.slice(toks[k].end, toks[k + 1].start))) k++;
    const particle = !t.cap && k > i && !!toks[k]?.cap;
    if (t.cap || (particle && joins)) {
      if (!joins) flush();
      run.push(t);
    } else flush();
  });
  flush();
  return runs;
}

/** The run is a whole list entry on its own: after a line start, comma, colon, bracket, "and"… */
function entryStartsAt(text: string, at: number): boolean {
  const before = text.slice(0, at);
  if (/^[ \t]*$/.test(before)) return true;
  return /(?:[,;:(\[\n•·|/&–—*-]|\d[.)]|\band)[ \t]*$/.test(before.slice(-24));
}
/** …and ends one: end of text, punctuation, a bracket, a number ("Anita Patel 51%", "Carlos (12)"). */
function entryEndsAt(text: string, at: number): boolean {
  return /^[ \t]*(?:$|[,;:()\[\]\n•·|/&–—.!?-]|and\b|\d)/.test(text.slice(at, at + 24));
}
/** "Receptionist: Bree", "Estimator – Chen": a job label, then the person. */
function afterRoleLabel(text: string, at: number): boolean {
  const m = text.slice(Math.max(0, at - 40), at).match(/([A-Za-zÀ-ÖØ-öø-ÿ'’]+)[ \t]*[:–—-][ \t]*$/);
  if (!m) return false;
  const f = foldForMatch(m[1]);
  return isRoleWord(m[1]) || (NOT_NAME_WORDS.has(f) && /(?:er|or|ist|ian|ant|ent|staff|team|crew|head|lead|admin)$/.test(f));
}
/** A lone unfamiliar word counts only with a tell-tale after it: "Xiaoling (7 years)", "Xiaoling, 9 years", "Xiaoling: 12". */
const LONE_NAME_TELL = /^(?:[ \t]*\(|,?[ \t]*\d+\+?[ \t]*(?:years?|yrs?)\b|[ \t]*[:–—-][ \t]*\d)/i;

/** English word endings no personal name has — "Ownership (100%)", "Maintenance (2)" are not people. */
const STRONG_NOT_A_NAME_ENDING = /(?:ship|tion|sion|ment|ness|ity|ance|ence|ics|ism|ware|hood)$/i;
/** …and, for a lone unfamiliar word, a wider set ("Scheduling (2)", "Procedure (1)"). */
const NOT_A_NAME_ENDING = /(?:ship|tion|sion|ment|ness|ity|ance|ence|ing|ics|ism|ware|hood|ure|ery|ory|ary|ive|ous|ful|less|able|ible|ize|ise|ized|ised|ed)$/i;

/**
 * Record a person: the full name, and the surname alone when it can't be an
 * everyday word. An everyday surname ("Emma Winter", "Dr. Frost") is
 * recorded only with a title or as "<surname> family" — never as the word.
 */
function pushPerson(out: string[], name: Tok[], opts: { surnameAlone: boolean; title?: Tok }) {
  const parts = name.filter((t) => !t.initial);
  if (parts.length === 0) return;
  const last = parts[parts.length - 1];
  const lastOk = last.key.replace(/ /g, "").length >= 3 && !everyday(last);
  if (parts.length === 1 && !opts.title) {
    out.push(last.text); // "Carlos (12)", "Bill (driver)" — the fact itself is the one word
    return;
  }
  if (parts.length >= 2) out.push(parts.map((t) => t.text).join(" "));
  if (lastOk && (opts.surnameAlone || opts.title)) out.push(last.text);
  else out.push(`${opts.title ? capitalise(opts.title.text) : "Ms"}. ${last.text}`); // a titled term — see TITLED
}
const capitalise = (w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();

/**
 * "Ms. Winter", "Dr. Frost": a surname that counts only with a title in
 * front of it (any title — "Mr. Winter", "DR WINTER") or "family" after it.
 */
const TITLED = /^(?:Dr|Dre|Mr|Mrs|Ms|Miss|Mx|Prof|Sir|Dame)\. (.+)$/;
const TITLE_WORDS = new Set(["dr", "dre", "mr", "mrs", "ms", "miss", "mx", "prof", "sir", "dame"]);

/**
 * Extend a name from `i`: words that can be part of a name, up to four. An
 * occupation that is also a surname counts right after a given name
 * ("Maria Teller"); an everyday word ends the name ("Emma Winter").
 */
function extendName(run: Tok[], i: number, afterGiven: boolean): number {
  let j = i;
  let n = 0;
  while (j < run.length && n < 4) {
    const t = run[j];
    if (t.initial || (!t.cap && PARTICLES.has(t.key))) {
      j++;
      continue;
    }
    if (n > 0) {
      if (isHonorific(t) || NUMBER_WORD.test(t.key) || isPluralRole(t.text)) break;
      if (NOT_NAME_WORDS.has(t.key) && !isGiven(t)) break;
      if (isRoleWord(t.text) && !(afterGiven && isSurnameOccupation(t.text))) break;
      // A second given name after a full name starts the next person.
      if (n >= 2 && isGiven(t) && !everyday(t)) break;
    }
    j++;
    n++;
    if (n > 1 && everyday(t)) break;
  }
  return j;
}

/**
 * How much to read from a text: `titles` — only people named after a title
 * ("Dr. Frost"); `prose` — also names that start with a known given name
 * (free prose about the owner); `people` — also an unfamiliar name that
 * stands alone as a list entry (a staffing fact).
 */
type ReadMode = "titles" | "prose" | "people";

/** Landforms and place words after a given name make a place, not a person ("Fraser Valley"). */
const GEO_WORDS = new Set([
  "valley", "river", "lake", "lakes", "park", "heights", "hill", "hills", "bay", "falls", "island", "islands", "mountain",
  "mountains", "creek", "point", "beach", "harbour", "harbor", "county", "township", "springs", "crossing", "landing",
  "village", "junction", "corner", "corners", "square", "gardens", "estates", "district", "region", "coast", "shore",
]);

function readRun(text: string, run: Tok[], out: string[], mode: ReadMode) {
  const runStart = run[0].start;
  const runEnd = run[run.length - 1].end;
  const wholeEntryEnd = entryEndsAt(text, runEnd);
  let i = 0;
  while (i < run.length) {
    const t = run[i];
    const titlesBefore = run.slice(0, i).every(isTitle);
    const startsEntry = i === 0 ? entryStartsAt(text, runStart) : titlesBefore;

    // Title + name: "Dr. Anita Patel", "Mr Lee", "DR. FROST".
    if (isHonorific(t)) {
      const j = extendName(run, i + 1, true);
      const name = run.slice(i + 1, j);
      const first = name.find((x) => !x.initial);
      // "MS Office", "Dr Office Hours" — a title word before a non-name.
      if (first && (!isStop(first) || isGiven(first) || isSurnameOccupation(first.text))) pushPerson(out, name, { surnameAlone: true, title: t });
      i = Math.max(j, i + 1);
      continue;
    }
    if (mode === "titles") {
      i++;
      continue;
    }

    // A known given name: "Carlos Reyes", "Maria Teller", "Priya".
    if (isGiven(t) && !t.initial) {
      const j = extendName(run, i, true);
      const name = run.slice(i, j).filter((x) => !x.initial);
      const next = run[j];
      const ambiguous = everyday(t); // "Will", "Grace", "Summer", "May"
      const reachesEnd = !next && wholeEntryEnd;
      let ok: boolean;
      if (next && isPluralRole(next.text)) ok = false; // "Summer Students" — a group
      // In prose, a given name before a landform is a place: "Fraser Valley", "Victoria Park".
      else if (mode === "prose" && run.slice(i + 1, j + 1).some((x) => GEO_WORDS.has(x.key))) ok = false;
      else if (name.length === 1) {
        ok = ambiguous
          ? reachesEnd && startsEntry && !/^[ \t]*\d/.test(text.slice(runEnd, runEnd + 8)) // "Bill (driver)", not "May 2019"
          : !next || isStop(next); // "Carlos", "Sandra Office Manager"
      } else {
        ok = !(ambiguous && everyday(name[1])) || (reachesEnd && startsEntry); // not "Will Assist", "Grace Period"
      }
      if (ok) pushPerson(out, name, { surnameAlone: true });
      i = Math.max(j, i + 1);
      continue;
    }

    // An unfamiliar name standing alone as a list entry: "Xiaoling Wu (12)",
    // "Office Manager: Oluwaseun Adeyemi". Never a phrase made of everyday
    // words or one that ends in a job ("Patient Care Coordinator").
    if (mode === "people" && !isStop(t) && !everyday(t) && !t.initial) {
      const j = extendName(run, i, false);
      const name = run.slice(i, j).filter((x) => !x.initial);
      const next = run[j];
      const groupWord = /(?:er|or|ist|ian|ant|ent)s$/i.test(name[name.length - 1].text) && !isGiven(name[name.length - 1]);
      // "Handles Scheduling", "Oversees Estimating" — a verb, not a first name.
      const wordy = name.some((x) => STRONG_NOT_A_NAME_ENDING.test(x.key)) || /s$/i.test(name[0].text);
      let ok = false;
      // Two or more unfamiliar capitalised words in a people fact are a name
      // wherever they sit — mid-sentence too ("our hygienist Xiaoling Wu has
      // been with us 12 years"). Phrases with any everyday or job word never
      // qualify here ("Patient Care Coordinator", "Kitchen Staff").
      const unfamiliarRun = name.length >= 2 && name.every((x) => !everyday(x) && !isStop(x));
      if (!startsEntry && !groupWord && !wordy && unfamiliarRun && (!next || isStop(next))) {
        ok = true;
      } else if (startsEntry && !groupWord && !wordy) {
        if (name.length >= 2) {
          // Followed by a job ("Xiaoling Wu Office Manager") only when every word is unfamiliar.
          ok = next ? name.every((x) => !everyday(x)) && isStop(next) : wholeEntryEnd;
        } else {
          const w = name[0];
          ok = !next && !/s$/i.test(w.text) && !(w.allCaps && w.text.length <= 5) && w.key.length >= 3 &&
            !NOT_A_NAME_ENDING.test(w.key) &&
            (LONE_NAME_TELL.test(text.slice(runEnd, runEnd + 24)) || (i === 0 && afterRoleLabel(text, runStart)));
        }
      }
      const last = name[name.length - 1];
      if (ok) pushPerson(out, name, { surnameAlone: !next && name.length >= 2 && !NOT_A_NAME_ENDING.test(last.key) });
      i = Math.max(j, i + 1);
      continue;
    }
    i++;
  }
}

/** People named after a title — "Dr. Anita Patel", "Mr. Lee", "Ms. Winter". High precision. */
export function honorificNames(text: string): string[] {
  const out: string[] = [];
  for (const run of capitalRuns(text)) readRun(text, run, out, "titles");
  return Array.from(new Set(out));
}

/** The people in a people fact ("Staff: Carlos Reyes (12), Ana Torres (4)"), or in prose about people. */
export function peopleInFact(text: string, mode: ReadMode = "people"): string[] {
  const out: string[] = [];
  // "British Columbia (100%)" is a province, never "Mr. Columbia".
  const masked = maskRegionNames(text);
  for (const run of capitalRuns(masked)) readRun(masked, run, out, mode);
  return Array.from(new Set(out));
}

/** A dedicated name field ({ name: "Maria" }) — the value is a person, however it is written. */
function personField(v: string): string[] {
  const clean = v.replace(/\b(?:Dr|Dre|Mr|Mrs|Ms|Miss|Mx|Prof)\.?\s+/gi, "").trim();
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4 || /[\d@(),;:]/.test(clean)) return peopleInFact(v);
  // A job or a placeholder in the name slot ("Office Manager", "Vacant", "TBD") is not a person.
  const toks = tokens(clean);
  if (/^(?:vacant|tbd|tba|none|unknown|n\/?a|open|hiring|pending|various)$/i.test(clean)) return [];
  if (toks.some((t) => isStop(t) && !isGiven(t)) || toks.every((t) => everyday(t) && !isGiven(t))) {
    // One everyday word as the whole name ("Frost") still counts — capitalised (see `common`).
    return toks.length === 1 && !isStop(toks[0]) ? [words[0]] : [];
  }
  if (words.length === 1) return [words[0]];
  const out = [words.join(" ")];
  const last = foldForMatch(words[words.length - 1]);
  if (last.length >= 3 && !isEverydayWord(last)) out.push(words[words.length - 1]);
  else out.push(`Ms. ${words[words.length - 1]}`);
  return out;
}

// ── Places, contacts and web identity ────────────────────────────────────

const CA_POSTAL = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi;
const UNIT_LINE = /^(?:unit|suite|ste|apt|apartment|floor|fl|bay|#)\b/i;
const STREET_SUFFIX =
  "Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Boulevard|Blvd|Crescent|Cres|Court|Ct|Lane|Ln|Way|Place|Pl|Parkway|Pkwy|Highway|Hwy|Line|Sideroad|Concession|Trail|Terrace|Circle|Square|Row|Close|Gate";
/** "210 Fairway Road South", "45 Market St." anywhere in the facts. */
const STREET_LINE = new RegExp(
  `(?:^|[^\\w])(\\d{1,6}[A-Za-z]?[ \\t]+((?:[${UPPER}][${LETTER}'’.-]*[ \\t]+){1,4})(?:${STREET_SUFFIX})\\b\\.?(?:[ \\t]+(?:North|South|East|West|N|S|E|W))?)`,
  "g",
);
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const PHONE = /(?:\+?1[ .-]?)?\(?\b\d{3}\)?[ .-]?\d{3}[ .-]\d{4}\b/g;
const URL = /\b(?:https?:\/\/|www\.)[^\s,;)"'<>]+/gi;
const BARE_DOMAIN = /\b((?:[a-z0-9-]+\.)+(?:ca|com|net|org|biz|info|co|io|us|shop|store|dental|health|clinic))\b(?:\/[^\s,;)"'<>]*)?/gi;
/** Mail and social platforms: their own names identify nothing. */
const PLATFORM_HOSTS = /^(?:gmail|googlemail|outlook|hotmail|live|msn|yahoo|icloud|me|mac|aol|protonmail|proton|shaw|rogers|bell|sympatico|telus|cogeco|videotron|eastlink|facebook|fb|instagram|linkedin|twitter|x|tiktok|youtube|youtu|yelp|google|goo|maps|bit|linktr|wa|pinterest|threads|square|squareup|wixsite|wordpress|shopify|godaddy)$/i;

/**
 * Province, state and country names blanked out with "~" so they are never
 * read as a person, a street word or a town: every multi-word name
 * ("British Columbia", "New York") and a one-word name ("Ontario", "Texas")
 * standing on its own — not one inside a longer capitalised name ("Ontario
 * Plumbing", "Georgia Wells") or one that is also a given name. Same length,
 * so positions still line up with the original text.
 */
const REGION_MASK_RE = new RegExp(
  `(?<![${LETTER}])(?:${[...REGION_NAMES]
    .sort((a, b) => b.length - a.length)
    .map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "[ \\t]+"))
    .join("|")})(?![${LETTER}])`,
  "g",
);
export function maskRegionNames(text: string): string {
  return text.replace(REGION_MASK_RE, (m: string, offset: number, whole: string) => {
    if (!/\s/.test(m)) {
      const before = whole.slice(Math.max(0, offset - 40), offset);
      const after = whole.slice(offset + m.length, offset + m.length + 40);
      if (new RegExp(`[${UPPER}][${LETTER}'’.-]*[ \\t]+$`).test(before) || new RegExp(`^[ \\t]+[${UPPER}]`).test(after)) return m;
      if (GIVEN_NAMES.has(foldForMatch(m))) return m;
    }
    return "~".repeat(m.length);
  });
}

/**
 * Identifying pieces of a place fact: street lines and postal codes
 * (`lines`), place names and distinctive street words (`names`). A dedicated
 * city/town field (`anyCase`) is a place name however it was typed.
 */
function placesIn(value: string, anyCase = false): { names: string[]; lines: string[] } {
  const names: string[] = [];
  const lines: string[] = [];
  const capital = (w: string) => startsUpper(w) || (anyCase && /^[a-zà-öø-ÿ]/.test(w));
  // "Surrey, British Columbia (head office … 19220 Campbell Ridge Drive; …)":
  // the province is blanked first and brackets split segments, so neither
  // "British" nor "Columbia" can ever become a street word or a town.
  for (const line of maskRegionNames(value).split(/\n/)) {
    for (const m of Array.from(line.matchAll(CA_POSTAL))) lines.push(m[0]);
    const segs = line
      .replace(CA_POSTAL, "")
      .split(/[,;()\[\]]/)
      .map((s) => s.replace(/~+/g, " ").replace(/\s+/g, " ").trim())
      .filter(Boolean);
    for (const seg of segs) {
      if (seg.length < 3 || isRegionLabel(seg) || UNIT_LINE.test(seg)) continue;
      if (/\d/.test(seg)) {
        // A street line — the line itself, and its distinctive words.
        if (/[A-Za-z]{3,}/.test(seg)) lines.push(seg.replace(/^#?\s*/, ""));
        for (const w of seg.match(/[A-Za-zÀ-ÖØ-öø-ÿ]{5,}/g) || []) {
          if (capital(w) && !GENERIC_STREET_WORDS.has(w.toLowerCase()) && !isRegionLabel(w) && !isRegionWord(w)) names.push(w);
        }
        continue;
      }
      // A proper place name: capitalised words (with connectors), ≤ 5 words.
      const words = seg.split(/[\s-]+/).filter(Boolean);
      if (words.length > 5 || !capital(words[0])) continue;
      if (!words.every((w) => capital(w) || PLACE_CONNECTORS.has(w.toLowerCase()))) continue;
      if (words.length === 1 && GENERIC_STREET_WORDS.has(words[0].toLowerCase())) continue;
      names.push(seg);
    }
  }
  return { names, lines };
}

/** A web host's name terms: "harbourlinedental.ca" → itself and "harbourlinedental". */
function hostTerms(host: string): string[] {
  const h = host.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  const labels = h.split(".");
  if (labels.length < 2) return [];
  const stem = labels[labels.length - 2];
  if (PLATFORM_HOSTS.test(stem)) return [];
  const out = [h];
  if (stem.length >= 5 && !isEverydayWord(stem)) out.push(stem);
  return out;
}

/** A social profile's handle: "facebook.com/harbourlinedental" → "harbourlinedental". */
function handleOf(url: string): string | null {
  const m = url.replace(/^https?:\/\//i, "").replace(/^www\./i, "").match(/^[^/]+\/(?:@)?([A-Za-z0-9._-]{5,})/);
  if (!m || /^(?:pages|groups|people|in|company|profile|channel|user|c|p|watch|reel|share|photo|photos|maps|search)$/i.test(m[1])) return null;
  const h = m[1].replace(/[._-]+$/, "");
  return isEverydayWord(h.toLowerCase()) ? null : h;
}

/**
 * The distinctive part of a business name, which identifies it on its own:
 * generic words dropped from the end ("Harbourline Dental Group" →
 * "Harbourline", "Frostline HVAC Services" → "Frostline"), and for a longer
 * name its lead words ("Nonna Lucia's Trattoria" → "Nonna Lucia"). Never a
 * phrase of everyday words ("Main Street", "Family Dental").
 */
function distinctiveCores(name: string): string[] {
  if (/[\n,;@/]|\s[—–-]\s|\.[a-z]{2,}\b/i.test(name)) return [];
  const all = name.replace(/['’]s\b/g, "").split(/\s+/).filter(Boolean);
  const generic = (w: string) => {
    const f = foldForMatch(w);
    // Trailing trade acronyms ("HVAC", "RV", "IT") describe the business too.
    return !f || f === "and" || isEverydayWord(f) || ORG_WORDS.has(f) || /^[A-Z]{2,5}$/.test(w);
  };
  const trim = (words: string[]) => {
    const w = [...words];
    while (w.length > 1 && generic(w[w.length - 1])) w.pop();
    while (w.length > 1 && /^(?:the|le|la|les|l)$/i.test(w[0])) w.shift();
    return w;
  };
  const out: string[] = [];
  const consider = (words: string[]) => {
    if (words.length === all.length) return;
    // A business named after its province/state/country ("Ontario Plumbing
    // Services") — the region may stay in a Blind CIM, so it is never a core.
    if (isRegionLabel(words.join(" "))) return;
    const folded = words.map((w) => foldForMatch(w)).filter(Boolean);
    if (folded.length === 0 || folded.every((f) => isEverydayWord(f))) return;
    if (folded.length === 1 && folded[0].length < 5) return;
    out.push(words.join(" "));
  };
  consider(trim(all));
  if (all.length >= 3) {
    const lead = trim(all.slice(0, -1));
    if (lead.length >= 2) consider(lead);
  }
  return Array.from(new Set(out));
}

// ── Public identifiers (registration, licence and permit numbers) ─────────

/**
 * A regulator's or registry's number for the business — a USDOT, MC, NSC or
 * CVOR number, a CRA business number, an incorporation or licence number.
 * Any of them names the company in one public lookup, so none may reach a
 * Blind CIM (2026-09-26: Pacific's blind "Permits" section served
 * "USDOT 9318842" and "NSC BC 20-487-316"). The credential itself ("holds
 * a USDOT number", "NSC certificate, Satisfactory rating") is fine.
 *
 * Read only where a label says what the number is, so a revenue figure,
 * a year or a phone number is never one: each pattern's group 1 is the
 * identifier.
 */
const ID_BODY = String.raw`([A-Z]{0,3}[ \t-]?\d[\dA-Z]*(?:[ \t./-]+[\dA-Z]*\d[\dA-Z]*)*)`;
const REGISTRY_PATTERNS: RegExp[] = [
  // Acronym labels, case-sensitive ("USDOT 9318842", "US DOT # 1234567", "MC-123456", "NSC BC 20-487-316", "CVOR 123-456-789", "EIN 12-3456789").
  new RegExp(String.raw`(?<![A-Za-z])(?:U\.?[ \t]?S\.?[ \t]?DOT|DOT|MC|MX|FF|NSC|CVOR|IFTA|IRP|SCAC|EIN|FEIN|TIN|BN|GST|HST|QST|PST|WSIB|WCB|DUNS|D-U-N-S|NPI|DEA|NABP|NCPDP|CLIA|CAGE|UEI|OCP|CPSO)(?:[ \t]*(?:#|No\.?|Number|number|Cert(?:ificate)?|certificate)\.?)?[ \t]*[:#]?[ \t]*(?:(?:BC|AB|SK|MB|ON|QC|NB|NS|PE|NL|YT|NT|NU)[ \t]+)?` + ID_BODY, "g"),
  // Word labels + "number / no. / #" ("Business Number 81234 5678 RC0001", "Licence No. 44721", "Permit #P-2231").
  new RegExp(String.raw`(?<![A-Za-z])(?:licen[cs]e|permit|registration|registry|certificate|cert|incorporation|corporation|corporate|company|business|entity|charter|accreditation|membership|member|dealer|vendor|carrier|operating authority|authority|tax|account|policy|file)[ \t]*(?:number|no\.?|num\.?|#|id)[ \t]*[:#.]?[ \t]*` + ID_BODY, "gi"),
  // A certificate, licence, permit or registration followed straight by its number ("Safety Certificate BC 20-487-316").
  new RegExp(String.raw`(?<![A-Za-z])(?:certificate|licen[cs]e|permit|registration)[ \t]+(?:(?:[A-Z]{2,3})[ \t]+)?#?[ \t]*(\d[\d-]{5,}\d)(?![\d])`, "gi"),
  // A CRA business number on its own ("81234 5678 RC0001", "812345678RT0001").
  /(?<![\dA-Za-z])(\d{5}[ \t]?\d{4}[ \t]?(?:RC|RT|RP|RR|RZ|RM)[ \t]?\d{4})(?![\dA-Za-z])/g,
];
/** A year or a year range ("2019", "2019-2024") — never an identifier. */
const YEARISH = /^(?:19|20)\d{2}(?:[ \t]*[-–][ \t]*(?:19|20)?\d{2})?$/;

/** The digits of an identifier, separators dropped; its longest run is what identifies it. */
function longestDigitRun(id: string): string {
  const runs = id.replace(/(\d)[ \t./-]+(?=\d)/g, "$1").match(/\d+/g) || [];
  return runs.reduce((a, b) => (b.length > a.length ? b : a), "");
}

/**
 * Every labelled public identifier in a text, as written ("USDOT 9318842",
 * "NSC BC 20-487-316", "Business Number 81234 5678 RC0001"). Needs five or
 * more digits; years and year ranges are never one.
 */
export function registryIdsIn(text: string): string[] {
  const out: string[] = [];
  for (const re of REGISTRY_PATTERNS) {
    re.lastIndex = 0;
    for (const m of Array.from(text.matchAll(re))) {
      const id = (m[1] ?? "").trim().replace(/[ \t./-]+$/, "");
      if (YEARISH.test(id)) continue;
      const digits = id.replace(/\D/g, "");
      if (digits.length < 5 || longestDigitRun(id).length < 4) continue;
      out.push(m[0].trim().replace(/[ \t./-]+$/, ""));
    }
  }
  return Array.from(new Set(out));
}

/** Fact keys that name an identifier ("businessNumber", "usdotNumber", "incorporationNo", "licenceId"). */
const REGISTRY_KEY = /(?:usdot|dotnumber|mcnumber|nscnumber|cvor|businessnumber|bnnumber|craNumber|ein$|fein|taxid|gstnumber|hstnumber|duns|npinumber|deanumber|(?:licen[cs]e|permit|registration|registry|incorporation|corporation|corporate|company|entity|certificate|charter|accreditation|authority|filing|file|policy)(?:number|no|num|id)s?$)/i;
/** A value that is only an identifier ("BC0571234", "81234 5678 RC0001", "#20-487-316"). */
const ID_SHAPED = /^[#:\sA-Z.-]{0,12}\d[\dA-Z\s./#-]{3,}$/i;

// ── Organisations the business deals with ──────────────────────────────

/**
 * Facts about the business's counterparties — customers, landlord,
 * suppliers, lenders, advisers, contracts. The organisations they name
 * identify the business as surely as its staff do ("Alderbrook's hauler
 * since 2009", "the Silvergate lease").
 */
const COUNTERPARTY_KEY = /(customer|client|account(?!ing|s?receivable|s?payable)|payor|payer|landlord|lessor|lease(?!hold|sqft|sq|term|length|expir|start|end|rate|rent|cost)|tenant|supplier|vendor|lender|bank|creditor|financing|financier|loan|contract|agreement|partner|distributor|wholesaler|franchis|insur|accountant|auditor|lawyer|legal|counsel|notary|relationship|subcontract|affiliate|holding|parent|shareholder|sponsor|principal)/i;
/**
 * Facts about the sale itself — the broker, the brokerage, who referred the
 * seller. The brokerage is named in every Blind CIM (its contact page), so
 * nothing is read from these as an identifier of the business.
 */
const BROKER_KEY = /(broker|saleadvis|dealadvis|listing|intermediar|referr)/i;
/** Words right before a capitalised word that make it a place, not an organisation ("customers in Calgary"). */
const PLACE_PREPOSITION = /(?:^|[^A-Za-z])(?:in|near|from|to|across|around|throughout|within|outside|into|between|via|serving)[ \t]+$/i;
/** Titles that end an organisation's name when a person follows ("Alderbrook VP Doug Fairweather"). */
const ORG_CUT_WORDS = /^(?:vp|svp|evp|ceo|cfo|coo|cto|gm|president|owner|founder|manager|director|chair|chairman|principal|partner)$/;
const MONTH_OR_DAY = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
]);
/** Words that end an organisation's name ("Kestrel Building Supply Inc.", "Silvergate Industrial Properties"). */
const ORG_SUFFIX = new Set([
  ...Array.from(ORG_WORDS),
  "co", "cooperative", "co operative", "coop", "industries", "properties", "supply", "supplies", "distributors", "distribution",
  "leasing", "finance", "financial", "capital", "markets", "foods", "logistics", "transport", "brands", "products",
  "manufacturing", "systems", "technologies", "labs", "realty", "investments", "ventures", "agency", "firm", "bancorp",
]);

/** A capitalised word that can carry an organisation's name on its own ("Alderbrook", "Silvergate", "Westline"). */
function distinctiveWord(t: Tok, lowerWords?: Set<string>): boolean {
  if (t.initial || t.key.replace(/ /g, "").length < 4) return false;
  if (t.allCaps) return false; // acronyms: "MSA", "CVSA", "EBITDA"
  // A word the facts also write in lowercase is a word ("Largest", "Interest").
  if (lowerWords?.has(t.key)) return false;
  if (everyday(t) || isStop(t) || isOccupationWord(t.text) || isRoleWord(t.text)) return false;
  if (MONTH_OR_DAY.has(t.key) || isRegionLabel(t.text) || isRegionWord(t.text)) return false;
  // "leased Lexus RX", "authorized Lennox dealer": a national brand names nothing.
  if (isNationalBrand(t.key)) return false;
  return !NOT_A_NAME_ENDING.test(t.key);
}

/** The start of a sentence or a list entry ("… payroll. Leasehold improvements", "; Suppliers want…"). */
function sentenceStartsAt(text: string, at: number): boolean {
  return entryStartsAt(text, at) || /[.!?]["'’”)\]]?[ \t]+$/.test(text.slice(Math.max(0, at - 6), at));
}

/**
 * A product brand the business carries or installs, described as such
 * ("Mitsubishi (cold-climate heat pumps, HVAC Elite dealer)", "Lennox
 * (authorized dealer)"): what it sells, not who it deals with.
 */
const CARRIED_BRAND = /^[ \t]*(?:[(,:–—-][^;)\n]{0,80})?\b(?:dealer|dealers|dealership|authori[sz]ed|brands?|installs?|manufacturer|oem|franchise|licensed products)\b/i;

/**
 * The organisations a counterparty fact names: "Master agreement with
 * Alderbrook" → Alderbrook; "Kestrel Building Supply rates reset" →
 * "Kestrel Building Supply" (and "Kestrel"); "landlord Silvergate" →
 * Silvergate. A capitalised phrase counts when it ends in a company word
 * (Ltd., Bank, Properties…) or holds a word no dictionary list knows — never
 * a phrase of everyday words ("Master Service Agreement"), a month, an
 * acronym or a place after "in"/"from" ("customers in Calgary").
 */
export function organisationsIn(text: string, lowerWords?: Set<string>): string[] {
  const out: string[] = [];
  const masked = maskRegionNames(text);
  for (const run of capitalRuns(masked)) {
    let words = run;
    // Sentence starters and titles in front ("The", "VP", "Key")…
    while (words.length > 0 && (isStop(words[0]) || words[0].initial)) words = words.slice(1);
    // …and the name ends at a title or role ("Alderbrook VP Doug Fairweather").
    const cut = words.findIndex((t, i) => i > 0 && (isHonorific(t) || isRoleWord(t.text) || ORG_CUT_WORDS.test(t.key)));
    const beforeTitle = cut > 0;
    if (cut > 0) words = words.slice(0, cut);
    if (words.length === 0) continue;
    const start = words[0].start;
    const end = words[words.length - 1].end;
    if (PLACE_PREPOSITION.test(masked.slice(Math.max(0, start - 24), start))) continue;
    if (CARRIED_BRAND.test(masked.slice(end, end + 100).split(/[;\n]/)[0])) continue;
    const suffixed = words.length >= 2 && ORG_SUFFIX.has(words[words.length - 1].key);
    const distinctive = words.filter((t) => distinctiveWord(t, lowerWords));
    if (!suffixed && distinctive.length === 0) continue;
    const phrase = masked.slice(start, end).replace(/\s+/g, " ").trim();
    if (words.length >= 2) {
      out.push(phrase);
      for (const core of distinctiveCores(phrase)) out.push(core);
      // "Alderbrook MSA", "Tidewater Beverage" — the distinctive lead word alone
      // (not a person's first name: people are read as people).
      if (distinctiveWord(words[0], lowerWords) && !isGiven(words[0])) out.push(words[0].text);
    } else if (!sentenceStartsAt(masked, start) || /^[ \t]*\(/.test(masked.slice(end)) || beforeTitle) {
      // One word at the start of a sentence or list entry is usually just a
      // capitalised word ("Capex: …", "Linehaul drivers …"), unless a
      // description or a title follows it ("Westline (operating lease …)",
      // "Alderbrook VP Doug Fairweather").
      out.push(words[0].text);
    }
  }
  return Array.from(new Set(out));
}

// ── Terms ────────────────────────────────────────────────────────────────

const PERSON_KEY = /(owner|founder|partner|shareholder|principal|employee|staff|team|manager|management|director|president|officer|supervisor|foreman|dentist|doctor|physician|hygienist|assistant|technician|contact|accountant|lawyer|attorney|people|personnel|successor|spouse|family|chef|associate|advisor|banker|landlord|seller|bookkeeper|receptionist|nurse|crew|worker|heir)/i;
/** "ceoName", "CFO", "coo_contact" — the acronyms as their own word only ("provinceOfOperation" holds "ceO"). */
function hasExecutiveAcronym(key: string): boolean {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[^A-Za-z0-9]+/g, " ").toLowerCase().split(" ");
  return words.some((w) => /^(?:ceo|cfo|coo|cto)s?$/.test(w));
}
const NOT_PEOPLE_KEY = /(salary|salaries|wages?|fees?|costs?|comp|compensation|pay|payroll|count|number|tenure|hours|involvement)$/i;
const PLACE_KEY = /(address|street|city|town|municipality|postal|zip)/i;
const PLACE_KEYS = new Set([
  "locations", "location", "primarylocation", "businesslocation", "headquarters", "headoffice", "premises", "sitelocation",
  "locationsite", "facilitylocation", "officelocation", "headofficelocation", "storelocation", "shoplocation",
  "plantlocation", "warehouselocation", "clinicallocation", "cliniclocation",
]);
const CONTACT_KEY = /(email|phone|fax|mobile|cell)/i;
const WEB_KEY = /(website|web|url|domain|site|social|facebook|instagram|linkedin|twitter|tiktok|youtube|handle)/i;
const NAME_FIELDS = new Set(["name", "fullname", "firstname", "lastname", "contactname", "personname", "ownername", "employeename", "staffname"]);

/** Every string in a fact value ({ value } wrappers, arrays, objects). */
function factStrings(v: unknown, depth = 0): { text: string; nameField: boolean }[] {
  if (depth > 4 || v == null) return [];
  if (typeof v === "string") return v.trim() ? [{ text: v, nameField: false }] : [];
  if (Array.isArray(v)) return v.flatMap((x) => factStrings(x, depth + 1));
  if (isObj(v)) {
    if ("value" in v && Object.keys(v).every((k) => ["value", "confidence", "source", "sources", "unit", "note"].includes(k))) {
      return factStrings(v.value, depth + 1);
    }
    const out: { text: string; nameField: boolean }[] = [];
    for (const [k, x] of Object.entries(v)) {
      // A written-out key is data too ({ "Carlos Reyes": "12 years" }); a camelCase field name isn't.
      if (/\s/.test(k.trim()) || /^[A-ZÀ-ÖØ-Þ]/.test(k)) out.push({ text: k, nameField: false });
      if (typeof x === "string" && NAME_FIELDS.has(k.toLowerCase())) out.push({ text: x, nameField: true });
      else out.push(...factStrings(x, depth + 1));
    }
    return out;
  }
  return [];
}

/**
 * Everything that would identify this deal in a Blind CIM: from its facts
 * (extractedInfo) and its staff list (employeeChart). The codename itself is
 * never identifying; a word inside it still is everywhere else.
 */
export function blindLeakTerms(
  deal: { businessName?: string | null; extractedInfo?: unknown; employeeChart?: unknown; industry?: string | null; subIndustry?: string | null },
  opts: { codename?: string | null; extraPeople?: string[] } = {},
): BlindTerm[] {
  const info = isObj(deal.extractedInfo) ? deal.extractedInfo : {};
  const terms: Array<{ text: string; kind: BlindTermKind; common?: boolean; regionWord?: boolean; digits?: string }> = [];
  const add = (text: string, kind: BlindTermKind, common?: boolean) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 3 || t.length > 160) return;
    // A person's one-word name that is also a place ("Washington", "York",
    // "Wales" as a surname; "Georgia", "Victoria" as a given name) still
    // identifies them: kept, but not matched where the text means the
    // place ("Washington State lanes", "customers in Georgia" — see
    // `regionWord`). "Georgia runs the front office" is the person.
    if (kind === "person" && !t.includes(" ") && (isRegionWord(t) || isRegionLabel(t))) {
      terms.push({ text: t, kind, common, regionWord: true });
      return;
    }
    // A province, state or country may stay in a Blind CIM (and the blind
    // map shows exactly that) — it is never a person, place or company term.
    if ((kind === "person" || kind === "place" || kind === "name") && isRegionLabel(t)) return;
    terms.push({ text: t, kind, common });
  };
  const addRegistry = (id: string) => {
    const digits = longestDigitRun(id);
    // Six digits at least for a bare match: shorter runs occur in ordinary figures.
    if (digits.length >= 6) terms.push({ text: id.trim(), kind: "registry", digits });
  };

  // Business names — every variant, and each one's distinctive core.
  const ids = blindIdentifiers({ businessName: deal.businessName, extractedInfo: info as Record<string, any> });
  for (const id of ids) add(id, "name");
  for (const id of ids) {
    // A one-word core ("Harbourline", "Precision") may be an English word
    // the lists don't know: it counts capitalised or in capitals only.
    for (const core of distinctiveCores(id)) add(core, "name", !core.includes(" ") || undefined);
  }

  const industryLabel = ` ${foldForMatch(`${deal.industry ?? ""} ${deal.subIndustry ?? ""}`)} `;
  // Every word the facts write in lowercase: a capitalised copy of one of
  // them is a word, not a company ("Largest customer", "Interest rate").
  const lowerWords = new Set<string>();
  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("_")) continue;
    for (const s of factStrings(value)) for (const m of s.text.match(/(?<![A-Za-z])[a-z][a-z'’-]+/g) || []) lowerWords.add(foldForMatch(m));
  }

  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("_")) continue;
    const strings = factStrings(value);
    if (strings.length === 0) continue;
    const peopleFact = (PERSON_KEY.test(key) || hasExecutiveAcronym(key)) && !NOT_PEOPLE_KEY.test(key);
    const aboutTheSale = BROKER_KEY.test(key);
    for (const s of strings) {
      if (peopleFact || s.nameField) {
        for (const p of s.nameField ? personField(s.text) : peopleInFact(s.text)) add(p, "person");
      } else {
        // Any other fact: people it names in passing ("VP Doug Fairweather",
        // "engagement partner Ranjit Bains retired") — titled names and
        // known given names only. Never a brand ("Tim Hortons franchise",
        // or one the deal's industry label names: "Wendy's franchise"), a
        // place ("Alberta expansion", "Fraser Valley farms") or the broker
        // ("sold through Morgan Ellis").
        const found = peopleInFact(s.text, "prose").filter((p) => !industryLabel.includes(` ${foldForMatch(p)} `));
        // The broker's surname alone ("Ellis") goes with the full name.
        const brokers = found.filter((p) => viaBroker(s.text, p)).map((p) => ` ${foldForMatch(p)} `);
        for (const p of found) {
          if (brandInText(s.text, p) || brokers.some((b) => b.includes(` ${foldForMatch(p)} `))) continue;
          if (!p.includes(" ") && (isRegionLabel(p) || isRegionWord(p))) continue;
          add(p, "person");
        }
      }
    }
    // Customers, landlord, suppliers, lenders, advisers: the organisations named.
    if (COUNTERPARTY_KEY.test(key) && !NOT_PEOPLE_KEY.test(key) && !aboutTheSale) {
      for (const s of strings) for (const o of organisationsIn(s.text, lowerWords)) add(o, "name", !o.includes(" ") || undefined);
    }
    // Registration, licence and permit numbers.
    for (const s of strings) for (const id of registryIdsIn(s.text)) addRegistry(id);
    if (REGISTRY_KEY.test(key)) {
      for (const s of strings) {
        const v = s.text.trim();
        if (v.length <= 40 && ID_SHAPED.test(v) && !/[$%]/.test(v)) addRegistry(v);
      }
    }
    if (PLACE_KEY.test(key) || PLACE_KEYS.has(key.toLowerCase())) {
      // A city/town field ("city", "businessCity" — not "capacity"): a place however it's typed.
      const cityField = /^(?:city|town|municipality)$|[a-z](?:City|Town|Municipality)$/.test(key);
      for (const s of strings) {
        const { names, lines } = placesIn(s.text, cityField);
        [...names, ...lines].forEach((p) => add(p, "place"));
      }
    }
    if (CONTACT_KEY.test(key)) {
      for (const s of strings) {
        const t = s.text.trim();
        if (/@/.test(t)) add(t, "contact");
        else if ((t.match(/\d/g) || []).length >= 7) add(t, "contact");
      }
    }
    // Anywhere in the facts: street lines, postal codes, emails, phones, web addresses.
    for (const s of strings) {
      for (const m of Array.from(s.text.matchAll(STREET_LINE))) {
        add(m[1].replace(/\.$/, ""), "place");
        for (const w of m[2].split(/[ \t]+/)) {
          const f = foldForMatch(w);
          if (f.length >= 4 && !GENERIC_STREET_WORDS.has(f) && !isEverydayWord(f) && !isRegionLabel(w)) add(w, "place");
        }
      }
      for (const m of Array.from(s.text.matchAll(CA_POSTAL))) add(m[0], "place");
      for (const m of Array.from(s.text.matchAll(EMAIL))) {
        add(m[0], "contact");
        for (const h of hostTerms(m[0].split("@")[1])) add(h, "name");
      }
      for (const m of Array.from(s.text.matchAll(PHONE))) add(m[0], "contact");
      for (const m of Array.from(s.text.matchAll(URL))) {
        const host = m[0].replace(/^https?:\/\//i, "").split(/[/?#]/)[0];
        for (const h of hostTerms(host)) add(h, "name");
        const handle = handleOf(m[0]);
        if (handle && PLATFORM_HOSTS.test(host.replace(/^www\./i, "").split(".")[0])) add(handle, "name");
      }
      if (WEB_KEY.test(key)) {
        for (const m of Array.from(s.text.matchAll(BARE_DOMAIN))) {
          const host = m[1];
          for (const h of hostTerms(host)) add(h, "name");
          const handle = handleOf(m[0]);
          if (handle && PLATFORM_HOSTS.test(host.split(".").slice(-2)[0])) add(handle, "name");
        }
        for (const m of Array.from(s.text.matchAll(/(?:^|\s)@([A-Za-z0-9._]{5,})/g))) {
          if (!isEverydayWord(m[1].toLowerCase())) add(m[1], "name");
        }
      }
    }
  }
  // The staff list (deals.employeeChart): each name, and any person its roles mention.
  for (const s of factStrings(deal.employeeChart)) {
    for (const p of s.nameField ? personField(s.text) : peopleInFact(s.text, "prose")) add(p, "person");
  }
  for (const p of opts.extraPeople ?? []) add(p, "person");

  // De-duplicate on the folded form. A term that is part of the codename
  // ("Kestrel", a customer, in "Project Kestrel") is kept: only the
  // codename itself is exempt, never another mention of the word.
  const code = opts.codename ? foldForMatch(opts.codename) : "";
  const byFold = new Map<string, BlindTerm>();
  for (const t of terms) {
    const folded = foldForMatch(t.text);
    const letters = folded.replace(/ /g, "").length;
    if (letters < 3) continue;
    // Business names and contacts need 4+ characters ("Inc" alone isn't a name).
    if ((t.kind === "name" || t.kind === "contact") && letters < 4) continue;
    // The codename itself (or a phrase holding it) is what the Blind CIM is called.
    if (code && ` ${folded} `.includes(` ${code} `)) continue;
    const inCodename = !!code && ` ${code} `.includes(` ${folded} `);
    if (t.kind === "registry") {
      const key = `registry:${t.digits}`;
      if (!byFold.has(key)) byFold.set(key, { text: t.text, kind: "registry", common: false, digits: t.digits });
      continue;
    }
    const titled = t.kind === "person" ? TITLED.exec(t.text) : null;
    if (titled) {
      // One titled term per surname, whichever title the facts used.
      const key = `titled:${foldForMatch(titled[1])}`;
      if (!byFold.has(key) && !byFold.has(foldForMatch(titled[1]))) byFold.set(key, { text: t.text, kind: t.kind, common: false, titled: true });
      continue;
    }
    const prev = byFold.get(folded);
    if (prev) {
      // The same word also as a plain term (a town, a business name) → matched everywhere.
      if (prev.regionWord && !t.regionWord) delete prev.regionWord;
      continue;
    }
    byFold.set(folded, {
      text: t.text,
      kind: t.kind,
      common: t.common ?? (t.kind !== "contact" && isEverydayWord(folded)),
      ...(t.regionWord ? { regionWord: true } : {}),
      ...(inCodename ? { codename: code } : {}),
    });
  }
  // Any labelled public identifier, whether the facts hold it or not.
  byFold.set("registry:*", { text: "a registration, licence or permit number", kind: "registry", common: false, anyRegistryId: true });
  return Array.from(byFold.values());
}

/** "sold through Morgan Ellis", "broker Morgan Ellis": the person selling the business, not in it. */
function viaBroker(text: string, name: string): boolean {
  const i = text.indexOf(name);
  return i >= 0 && /(?:through|via|broker|brokerage|advisor|adviser|agent|listed with)[ \t]+$/i.test(text.slice(Math.max(0, i - 30), i));
}

/** "Tim Hortons franchise", "Mr. Lube dealer": a brand that looks like a person. */
function brandInText(text: string, name: string): boolean {
  const i = text.indexOf(name);
  return i >= 0 && /^(?:['’]s)?(?:[ \t]+[A-Z][A-Za-z'’-]*)?[ \t]+(?:franchis\w*|dealer\w*|distributor\w*|licensee\w*|brand|banner|outlet\w*)\b/i.test(text.slice(i + name.length));
}

// ── Matching ──────────────────────────────────────────────────────────────

/** Every string inside a value (layoutData, overrides…), for checking. */
export function collectStrings(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 12 || value == null) return out;
  if (typeof value === "string") {
    if (value) out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStrings(v, out, depth + 1);
  } else if (typeof value === "object") {
    for (const v of Object.values(value as AnyRecord)) collectStrings(v, out, depth + 1);
  }
  return out;
}

/**
 * Every string inside a value rewritten (keys kept). Used instead of
 * rewriting the value's JSON text: JSON writes a paragraph break as a
 * backslash and the letter n, so a codename right after one ("…lanes.
 * [break] Project Coastline has…") followed a letter and never matched —
 * a codename rename left the old name in the blind CIM (2026-09-26).
 */
export function mapStrings<T>(value: T, fn: (s: string) => string, depth = 0): T {
  if (depth > 20 || value == null) return value;
  if (typeof value === "string") return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn, depth + 1)) as unknown as T;
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = mapStrings(v, fn, depth + 1);
    return out as T;
  }
  return value;
}

/** Digit runs that could be a phone number ("(519) 555-0142", "+1 519.555.0142", "5195550142"). */
const DIGIT_RUN = /\+?\d[\d \t().-]{5,}\d/g;

/**
 * The terms (their fact text) that appear in the given text(s), in any case
 * ("KITCHENER", "kitchener"), across accents, punctuation and line breaks.
 * An everyday-word term (`common`) counts only where it is capitalised or in
 * capitals. A phone number also matches on its digits alone. Empty =
 * nothing identifying found.
 */
export function findBlindLeaks(texts: string | string[] | unknown, terms: BlindTerm[]): string[] {
  if (terms.length === 0) return [];
  const all = typeof texts === "string" ? texts : collectStrings(texts).join("\n");
  if (!all) return [];
  // Folded text is plain ASCII, so the lowercase copy lines up character for character.
  const cased = ` ${foldForMatch(all, true)} `;
  const lower = cased.toLowerCase();
  let digitRuns: string[] | null = null;
  const hits: string[] = [];
  /** The folded text with one codename's occurrences blanked (same length, so positions hold). */
  const withoutCodename = new Map<string, { cased: string; lower: string }>();
  const blanked = (code: string) => {
    let v = withoutCodename.get(code);
    if (!v) {
      const needle = ` ${code} `;
      let c = cased;
      let l = lower;
      for (let at = l.indexOf(needle); at >= 0; at = l.indexOf(needle, at + 1)) {
        const fill = " " + "_".repeat(code.length) + " ";
        c = c.slice(0, at) + fill + c.slice(at + fill.length);
        l = l.slice(0, at) + fill + l.slice(at + fill.length);
      }
      v = { cased: c, lower: l };
      withoutCodename.set(code, v);
    }
    return v;
  };
  for (const t of terms) {
    if (t.kind === "registry") {
      if (t.anyRegistryId) {
        hits.push(...registryIdsIn(all));
        continue;
      }
      if (!t.digits) continue;
      digitRuns ??= (all.match(DIGIT_RUN) || []).map((r) => r.replace(/\D/g, ""));
      const bare = all.match(/\d+/g) || [];
      if (digitRuns.some((r) => r.includes(t.digits!)) || bare.some((r) => r.includes(t.digits!))) hits.push(t.text);
      continue;
    }
    const f = foldForMatch(t.text);
    if (!f) continue;
    if (t.kind === "contact" && !/[a-z]/i.test(t.text)) {
      const digits = t.text.replace(/\D/g, "");
      if (digits.length >= 7) {
        const core = digits.length > 10 ? digits.slice(-10) : digits;
        digitRuns ??= (all.match(DIGIT_RUN) || []).map((r) => r.replace(/\D/g, ""));
        if (digitRuns.some((r) => r.includes(core))) {
          hits.push(t.text);
          continue;
        }
      }
    }
    if (t.titled) {
      if (titledSurnameIn(lower, foldForMatch(TITLED.exec(t.text)?.[1] ?? t.text))) hits.push(t.text);
      continue;
    }
    const text = t.codename ? blanked(t.codename) : { cased, lower };
    const needle = ` ${f} `;
    let at = text.lower.indexOf(needle);
    if (at < 0) continue;
    if (t.regionWord) {
      for (; at >= 0; at = text.lower.indexOf(needle, at + 1)) {
        if (!usedAsPlace(text.lower, at, f)) {
          hits.push(t.text);
          break;
        }
      }
      continue;
    }
    if (!t.common) {
      hits.push(t.text);
      continue;
    }
    for (; at >= 0; at = text.lower.indexOf(needle, at + 1)) {
      if (text.cased.slice(at + 1, at + 1 + f.length) !== f) {
        hits.push(t.text);
        break;
      }
    }
  }
  return Array.from(new Set(hits));
}

/** Every multi-word province, state or country name, folded ("british columbia", "new york"). */
const MULTI_WORD_REGIONS = REGION_NAMES.map((n) => foldForMatch(n)).filter((n) => n.includes(" "));
/** A word right before a place that makes it the place: "in Montana", "across Washington". ("to" is not one: "reports to Washington".) */
const PLACE_BEFORE = new Set(["in", "across", "throughout", "within", "into", "from", "outside", "northern", "southern", "eastern", "western", "central", "upstate", "downstate"]);
/** What right after it names the place itself: "Washington State", "Washington DC", "Montana, USA". */
const PLACE_AFTER = /^(?:state|province|dc|d c|usa|us|u s|u s a|canada|uk)(?: |$)/;

/**
 * Is the region-word surname `f`, found at `at` (the space before it in
 * folded lowercase text), used as the place rather than the person? Yes
 * inside a longer place name ("new york", "british columbia"), before
 * "State"/"DC"/"USA", after "in"/"across"/"state of", or listed with
 * another province or state ("Oregon and Washington"). Anything else —
 * "Washington manages the service team", "York handles the books" — is
 * the person. A city before it ("Seattle, Washington") proves nothing,
 * so it still counts.
 */
function usedAsPlace(lower: string, at: number, f: string): boolean {
  const start = at + 1;
  const end = start + f.length;
  for (const r of MULTI_WORD_REGIONS) {
    if (!` ${r} `.includes(` ${f} `)) continue;
    for (let i = lower.indexOf(` ${r} `, Math.max(0, start - r.length - 1)); i >= 0 && i < end; i = lower.indexOf(` ${r} `, i + 1)) {
      if (i + 1 <= start && i + 1 + r.length >= end) return true;
    }
  }
  const after = lower.slice(end + 1).split(" ");
  if (PLACE_AFTER.test(after.slice(0, 3).join(" "))) return true;
  const before = lower.slice(0, at).trim().split(" ");
  const w1 = before[before.length - 1] ?? "";
  const w2 = before[before.length - 2] ?? "";
  if (PLACE_BEFORE.has(w1)) return true;
  if (w1 === "of" && (w2 === "state" || w2 === "province" || w2 === "commonwealth")) return true;
  const region = (...words: Array<string | undefined>) => {
    const t = words.filter(Boolean).join(" ");
    return !!t && isRegionLabel(t);
  };
  // Listed with another province or state: "Oregon and Washington", "Washington or Idaho".
  if ((w1 === "and" || w1 === "or") && (region(w2) || region(before[before.length - 3], w2))) return true;
  if ((after[0] === "and" || after[0] === "or") && (region(after[1]) || region(after[1], after[2]))) return true;
  return false;
}

/** " dr winter ", " winter family ", " winter s family " in folded lowercase text. */
function titledSurnameIn(lower: string, surname: string): boolean {
  if (!surname) return false;
  const needle = ` ${surname} `;
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
    const before = lower.slice(0, at).split(" ").pop() ?? "";
    const after = lower.slice(at + needle.length);
    if (TITLE_WORDS.has(before) || /^(?:s )?family\b/.test(after)) return true;
  }
  return false;
}

/** The only bracketed stand-ins a Blind CIM may carry. */
const ALLOWED_PLACEHOLDERS = new Set(["address withheld", "contact info withheld"]);
const PLACEHOLDER = /\[([A-Z][A-Za-z0-9 /&'’.,-]{0,58})\]/g;

/**
 * Unfilled template placeholders in a blind text — "[Province/State]",
 * "[City]", "[Customer Name]" — that the redactor copied from its
 * instructions instead of writing real words. Brackets already in the
 * section's own text (`original`) and the two sanctioned stand-ins
 * ([Address Withheld], [Contact Info Withheld]) don't count. A blind
 * section with any of these is a failed redaction: retried, never served.
 */
export function blindPlaceholders(texts: unknown, original?: unknown): string[] {
  const all = typeof texts === "string" ? texts : collectStrings(texts).join("\n");
  if (!all.includes("[")) return [];
  const before = original === undefined ? "" : typeof original === "string" ? original : collectStrings(original).join("\n");
  const out = new Set<string>();
  for (const m of Array.from(all.matchAll(PLACEHOLDER))) {
    if (ALLOWED_PLACEHOLDERS.has(m[1].trim().toLowerCase())) continue;
    if (before.includes(m[0])) continue;
    out.add(m[0]);
  }
  return Array.from(out);
}

/** Convenience: is this text free of the deal's identifying terms? */
export function isBlindSafe(texts: unknown, terms: BlindTerm[]): boolean {
  return findBlindLeaks(texts, terms).length === 0;
}
