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
 * Terms come from the deal's facts (extractedInfo) — never guessed from the
 * text being checked, so a clean blind text can't trip it:
 *   - names:    every business-name variant, owners, website (blindIdentifiers)
 *   - people:   names in people facts (owner, staff, key employees, contacts…):
 *               "Dr. Anita Patel" → "Anita Patel", "Patel"; "Maria, 9 years" → "Maria"
 *   - places:   street lines, distinctive street words, cities, postal codes —
 *               provinces/states/countries are allowed in a Blind CIM and skipped
 *   - contacts: email addresses and phone numbers
 *
 * Role and profession phrases ("Licensed Plumbers: 4", "Registered Massage
 * Therapists (6)", "Certified Welders") are never read as people — a Blind
 * CIM must be able to say what the team does.
 *
 * Matching is whole-word on accent-, punctuation- and whitespace-folded text
 * and ignores case: "KITCHENER", "Kitchener" and "kitchener" are all the
 * city. The one exception is a person or place whose name is also an
 * everyday word ("Market" Street, "Bill" the driver): its all-lowercase form
 * is the word ("the market", "the bill"), so only a capitalised or all-caps
 * occurrence counts. Pure — used by the server (redaction, view room, Q&A,
 * outreach) and the broker's client-side preview.
 */
import { blindIdentifiers } from "./blind-identifiers";
import { isRegionLabel } from "./cim-media";
import { EVERYDAY_NAME_WORDS, isPluralRole, isRoleWord } from "./blind-vocabulary";

export type BlindTermKind = "name" | "person" | "place" | "contact";

export interface BlindTerm {
  /** The identifying text as it appears in the facts. */
  text: string;
  kind: BlindTermKind;
  /**
   * A one-word person or place name that is also an everyday word: an
   * all-lowercase occurrence is the word, not the name. Every other term
   * matches in any case.
   */
  common: boolean;
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
 * dropped, so "Kitch\u00ADener" is "Kitchener".
 */
export function foldForMatch(s: string, keepCase = false): string {
  const t = s
    .replace(/[\u00AD\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/[øØæÆœŒßłŁđĐðÐþÞı]/g, (c) => TRANSLITERATE[c] ?? c)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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

// Letters, including accented ones ("Émilie", "Åberg"). JS \b is ASCII-only,
// so word edges are written out as "not a letter" instead.
const LETTER = "A-Za-zÀ-ÖØ-öø-ÿ";
const UPPER = "A-ZÀ-ÖØ-Þ";
const LOWER = "a-zà-öø-ÿ";
const UPPER_START = new RegExp(`^[${UPPER}]`);
const startsUpper = (w: string) => UPPER_START.test(w);
const HONORIFIC = new RegExp(
  `\\b(?:Dr|Dre|Mr|Mrs|Ms|Miss|Mx|Prof|Sir|Dame)\\.?[ \\t]+((?:[${UPPER}]\\.[ \\t]*)*[${UPPER}][${LETTER}'’-]+(?:[ \\t]+[${UPPER}][${LETTER}'’-]+){0,2})`,
  "g",
);
/** One capitalised name word: "Anita", "McDonald", "O'Brien", "Jean-Luc". */
const WORD = `[${UPPER}][${LOWER}]*(?:[${UPPER}][${LOWER}]+)?(?:['’-][${LETTER}][${LOWER}]*)*`;
/** A run of capitalised words ("Office Manager Sandra Lee", "Licensed Plumbers"). */
const CAP_RUN = new RegExp(`(^|[^${LETTER}'’-])(${WORD}(?:[ \\t]+${WORD})*)(?![${LETTER}])`, "g");
/** "Maria (office manager…", "Priya 7 years", "Maria, 9 years". */
const SINGLE_NAME = new RegExp(`(^|[^${LETTER}'’-])(${WORD})(?=[ \\t]*\\(|,?[ \\t]+\\d+[ \\t]*(?:years?|yrs?)\\b)`, "g");

/** Words that follow an organisation's or a place's name ("Kowalski Hospitality Inc", "Fairway Plaza"). */
const ORG_WORDS = new Set([
  "company", "co", "corporation", "corp", "inc", "incorporated", "ltd", "limited", "llc", "llp", "lp", "ulc", "group",
  "holdings", "enterprises", "services", "solutions", "partners", "associates", "cpa", "bank", "trust", "insurance",
  "dental", "medical", "health", "clinic", "practice", "plaza", "centre", "center", "mall", "building", "road",
  "street", "avenue", "drive", "boulevard",
]);

const isNameWord = (w: string) => w.length >= 2 && !NOT_NAME_WORDS.has(w.toLowerCase()) && !isRoleWord(w);

const NUMBER_WORDS = /^(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple|many|few|some)$/i;
/** A head count just before the words: "4 ", "four ", "x3 ". */
const COUNT_BEFORE = /(?:\b\d{1,4}|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|several|multiple|many|few))[ \t]*[x×]?[ \t]*$/i;
/** A head count just after the words: " (6)", ": 4", " x 3" — not a share, tenure or hours. */
const COUNT_AFTER = /^[ \t]*(?:\([ \t]*\d{1,4}[ \t]*\)|[:=][ \t]*\d{1,4}(?![\d.,]|[ \t]*(?:%|percent|years?|yrs?|months?|hours?|hrs?)\b)|[x×][ \t]*\d{1,4}\b)/i;
const pluralish = (w: string) => /s$/i.test(w) || isPluralRole(w);

// ── Term extraction ───────────────────────────────────────────────────────

/** People named after an honorific — "Dr. Anita Patel", "Mr. Lee". High precision. */
export function honorificNames(text: string): string[] {
  const out: string[] = [];
  for (const m of Array.from(text.matchAll(HONORIFIC))) {
    const words = m[1].split(/\s+/).filter((w) => !/^[A-ZÀ-ÖØ-Þ]\.$/.test(w)).filter(isNameWord);
    if (words.length === 0) continue;
    if (words.length >= 2) out.push(words.join(" "));
    const surname = words[words.length - 1];
    if (surname.length >= 3 && !COMMON_WORD_SURNAMES.has(surname.toLowerCase())) out.push(surname);
  }
  return out;
}

/**
 * A counted group of people — "4 Licensed Plumbers", "Registered Massage
 * Therapists (6)", "Framers: 3". A person is never counted, so the words are
 * a role, whatever they are.
 */
function isCountedGroup(text: string, at: number, run: string): boolean {
  const words = run.split(/[ \t]+/);
  if (!pluralish(words[words.length - 1])) return false;
  if (NUMBER_WORDS.test(words[0])) return true;
  const end = at + run.length;
  return COUNT_BEFORE.test(text.slice(Math.max(0, at - 16), at)) || COUNT_AFTER.test(text.slice(end, end + 24));
}

/** People in a free-text people fact (plus the honorific names). */
function peopleIn(text: string): string[] {
  const out = honorificNames(text);
  for (const m of Array.from(text.matchAll(CAP_RUN))) {
    const words = m[2].split(/[ \t]+/);
    if (words.length < 2 || isCountedGroup(text, (m.index ?? 0) + m[1].length, m[2])) continue;
    // Split the run at role words: "Office Manager Sandra Lee" → "Sandra Lee".
    // Words just before a plural role describe it ("Early Childhood
    // Educators", "Massage Therapists") — a group, not a person. Words just
    // before "Inc"/"Group"/"Plaza"… name an organisation or a place: the
    // whole name identifies, its last word alone ("Hospitality") doesn't.
    let seg: string[] = [];
    const flush = (next: string | undefined) => {
      const describesGroup = next !== undefined && isPluralRole(next);
      const namesOrg = next !== undefined && ORG_WORDS.has(next.toLowerCase());
      if (seg.length >= 2 && seg.length <= 4 && !describesGroup) {
        out.push(seg.join(" "));
        const surname = seg[seg.length - 1];
        if (!namesOrg && surname.length >= 3 && !COMMON_WORD_SURNAMES.has(surname.toLowerCase())) out.push(surname);
      }
      seg = [];
    };
    for (const w of words) {
      if (isNameWord(w)) seg.push(w);
      else flush(w);
    }
    flush(undefined);
  }
  for (const m of Array.from(text.matchAll(SINGLE_NAME))) {
    const w = m[2];
    if (w.length < 3 || !isNameWord(w) || COMMON_WORD_SURNAMES.has(w.toLowerCase())) continue;
    const at = (m.index ?? 0) + m[1].length;
    // "Framers (4)" — a head count, not a person.
    if (isCountedGroup(text, at, w)) continue;
    // Part of a capitalised title ("Lead Programmer (Miguel…") — not a name.
    if (/[A-ZÀ-ÖØ-Þ][A-Za-zÀ-ÖØ-öø-ÿ'’-]*[ \t]+$/.test(text.slice(Math.max(0, at - 40), at))) continue;
    // "Controller (Jennifer Wu, …)" — the name is inside the brackets, the word is a role.
    if (/^[ \t]*\([ \t]*[A-ZÀ-ÖØ-Þ]/.test(text.slice(at + w.length, at + w.length + 6))) continue;
    out.push(w);
  }
  return out;
}

/** A person's name held in a dedicated name field ({ name: "Maria" }). */
function personField(v: string): string[] {
  const words = v.replace(/\b(?:Dr|Dre|Mr|Mrs|Ms|Miss|Mx|Prof)\.?\s+/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4 || !words.every((w) => startsUpper(w) && isNameWord(w))) return peopleIn(v);
  const out = [words.join(" ")];
  const last = words[words.length - 1];
  if (words.length > 1 && last.length >= 3 && !COMMON_WORD_SURNAMES.has(last.toLowerCase())) out.push(last);
  if (words.length === 1 && (last.length < 3 || COMMON_WORD_SURNAMES.has(last.toLowerCase()))) return [];
  return out;
}

const CA_POSTAL = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi;
const UNIT_LINE = /^(?:unit|suite|ste|apt|apartment|floor|fl|bay|#)\b/i;

/**
 * Identifying pieces of a place fact: street lines and postal codes
 * (`lines`), place names and distinctive street words (`names`). A dedicated
 * city/town field (`anyCase`) is a place name however it was typed.
 */
function placesIn(value: string, anyCase = false): { names: string[]; lines: string[] } {
  const names: string[] = [];
  const lines: string[] = [];
  const capital = (w: string) => startsUpper(w) || (anyCase && /^[a-zà-öø-ÿ]/.test(w));
  for (const line of value.split(/\n/)) {
    for (const m of Array.from(line.matchAll(CA_POSTAL))) lines.push(m[0]);
    const segs = line.replace(CA_POSTAL, "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const seg of segs) {
      if (seg.length < 3 || isRegionLabel(seg) || UNIT_LINE.test(seg)) continue;
      if (/\d/.test(seg)) {
        // A street line — the line itself, and its distinctive words.
        if (/[A-Za-z]{3,}/.test(seg)) lines.push(seg.replace(/^#?\s*/, ""));
        for (const w of seg.match(/[A-Za-zÀ-ÖØ-öø-ÿ]{5,}/g) || []) {
          if (capital(w) && !GENERIC_STREET_WORDS.has(w.toLowerCase()) && !isRegionLabel(w)) names.push(w);
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

const PERSON_KEY = /(owner|founder|partner|shareholder|principal|employee|staff|team|manager|management|director|president|ceo|cfo|coo|officer|supervisor|foreman|dentist|doctor|physician|hygienist|assistant|technician|contact|accountant|lawyer|attorney|people|personnel|successor|spouse|family|chef|associate|advisor|banker|landlord)/i;
const PLACE_KEY = /(address|street|city|town|municipality|postal|zip)/i;
const PLACE_KEYS = new Set(["locations", "location", "primarylocation", "businesslocation", "headquarters", "headoffice", "premises", "sitelocation"]);
const CONTACT_KEY = /(email|phone|fax|mobile|cell)/i;
const NAME_FIELDS = new Set(["name", "fullname", "firstname", "lastname", "contactname", "personname"]);

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
      if (typeof x === "string" && NAME_FIELDS.has(k.toLowerCase())) out.push({ text: x, nameField: true });
      else out.push(...factStrings(x, depth + 1));
    }
    return out;
  }
  return [];
}

/**
 * Everything that would identify this deal in a Blind CIM. `codename` is
 * never treated as identifying (nor is anything inside it).
 */
export function blindLeakTerms(
  deal: { businessName?: string | null; extractedInfo?: unknown },
  opts: { codename?: string | null; extraPeople?: string[] } = {},
): BlindTerm[] {
  const info = isObj(deal.extractedInfo) ? deal.extractedInfo : {};
  const terms: Array<{ text: string; kind: BlindTermKind }> = [];
  const add = (text: string, kind: BlindTermKind) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 3 || t.length > 160) return;
    terms.push({ text: t, kind });
  };

  for (const id of blindIdentifiers({ businessName: deal.businessName, extractedInfo: info as Record<string, any> })) add(id, "name");

  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("_")) continue;
    const strings = factStrings(value);
    if (strings.length === 0) continue;
    if (PERSON_KEY.test(key) && !/(salary|salaries|wages?|fees?|costs?|comp|compensation|pay|payroll|count|number|tenure|hours|involvement)$/i.test(key)) {
      for (const s of strings) for (const p of s.nameField ? personField(s.text) : peopleIn(s.text)) add(p, "person");
    } else if (/involvement/i.test(key)) {
      // Free prose about the owner — honorific names only.
      for (const s of strings) for (const p of honorificNames(s.text)) add(p, "person");
    }
    if (PLACE_KEY.test(key) || PLACE_KEYS.has(key.toLowerCase())) {
      for (const s of strings) {
        // A city/town field ("city", "businessCity" — not "capacity"): a place however it's typed.
        const cityField = /^(?:city|town|municipality)$|[a-z](?:City|Town|Municipality)$/.test(key);
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
  }
  for (const p of opts.extraPeople ?? []) add(p, "person");

  // De-duplicate on the folded form (the stricter reading wins); drop
  // anything inside the codename.
  const code = opts.codename ? ` ${foldForMatch(opts.codename)} ` : "";
  const byFold = new Map<string, BlindTerm>();
  for (const t of terms) {
    const folded = foldForMatch(t.text);
    const letters = folded.replace(/ /g, "").length;
    if (letters < 3) continue;
    // Business names and contacts need 4+ characters ("Inc" alone isn't a name).
    if ((t.kind === "name" || t.kind === "contact") && letters < 4) continue;
    if (code && code.includes(` ${folded} `)) continue;
    const common = (t.kind === "person" || t.kind === "place") && isEverydayWord(folded);
    const prev = byFold.get(folded);
    if (prev && (!prev.common || common)) continue;
    byFold.set(folded, { text: t.text, kind: t.kind, common });
  }
  return Array.from(byFold.values());
}

/** One-word person/place names that are also everyday words ("Bill", "Market", "Hope"). */
function isEverydayWord(folded: string): boolean {
  return !folded.includes(" ") &&
    (EVERYDAY_NAME_WORDS.has(folded) || COMMON_WORD_SURNAMES.has(folded) || GENERIC_STREET_WORDS.has(folded) || NOT_NAME_WORDS.has(folded));
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
 * The terms (their fact text) that appear in the given text(s), in any case
 * ("KITCHENER", "kitchener"), across accents, punctuation and line breaks.
 * An everyday-word term (`common`) counts only where it is capitalised or in
 * capitals. Empty = nothing identifying found.
 */
export function findBlindLeaks(texts: string | string[] | unknown, terms: BlindTerm[]): string[] {
  if (terms.length === 0) return [];
  const all = typeof texts === "string" ? texts : collectStrings(texts).join("\n");
  if (!all) return [];
  // Folded text is plain ASCII, so the lowercase copy lines up character for character.
  const cased = ` ${foldForMatch(all, true)} `;
  const lower = cased.toLowerCase();
  const hits: string[] = [];
  for (const t of terms) {
    const f = foldForMatch(t.text);
    if (!f) continue;
    const needle = ` ${f} `;
    let at = lower.indexOf(needle);
    if (at < 0) continue;
    if (!t.common) {
      hits.push(t.text);
      continue;
    }
    for (; at >= 0; at = lower.indexOf(needle, at + 1)) {
      if (cased.slice(at + 1, at + 1 + f.length) !== f) {
        hits.push(t.text);
        break;
      }
    }
  }
  return hits;
}

/** Convenience: is this text free of the deal's identifying terms? */
export function isBlindSafe(texts: unknown, terms: BlindTerm[]): boolean {
  return findBlindLeaks(texts, terms).length === 0;
}
