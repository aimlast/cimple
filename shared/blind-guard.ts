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
 * Matching is whole-word on accent- and punctuation-folded text. Proper
 * nouns (people, places) match case-sensitively so "Hope" the receptionist
 * doesn't trip on "we hope"; business names and contacts match in any case.
 * Pure — used by the server (redaction, view room, Q&A, outreach) and the
 * broker's client-side preview.
 */
import { blindIdentifiers } from "./blind-identifiers";
import { isRegionLabel } from "./cim-media";

export type BlindTermKind = "name" | "person" | "place" | "contact";

export interface BlindTerm {
  /** The identifying text as it appears in the facts. */
  text: string;
  kind: BlindTermKind;
  caseSensitive: boolean;
}

type AnyRecord = Record<string, unknown>;
const isObj = (v: unknown): v is AnyRecord => !!v && typeof v === "object" && !Array.isArray(v);

/** Accent- and punctuation-folded text with single spaces between words. */
export function foldForMatch(s: string, caseSensitive: boolean): string {
  const t = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .trim();
  return caseSensitive ? t : t.toLowerCase();
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

const HONORIFIC = /\b(?:Dr|Dre|Mr|Mrs|Ms|Miss|Mx|Prof|Sir|Dame)\.?[ \t]+((?:[A-Z]\.[ \t]*)*[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]+(?:[ \t]+[A-Z][A-Za-zÀ-ÖØ-öø-ÿ'’-]+){0,2})/g;
/** One capitalised name word: "Anita", "McDonald", "O'Brien", "Jean-Luc". */
const WORD = "[A-Z][a-zà-öø-ÿ]*(?:[A-Z][a-zà-öø-ÿ]+)?(?:['’-][A-Za-zà-öø-ÿ][a-zà-öø-ÿ]*)*";
const NAME_RUN = new RegExp(`\\b${WORD}(?:[ \\t]+${WORD}){1,2}\\b`, "g");
/** "Maria (office manager…", "Priya 7 years", "Maria, 9 years". */
const SINGLE_NAME = new RegExp(`\\b(${WORD})(?=[ \\t]*\\(|,?[ \\t]+\\d+[ \\t]*(?:years?|yrs?)\\b)`, "g");

const isNameWord = (w: string) => w.length >= 2 && !NOT_NAME_WORDS.has(w.toLowerCase());

// ── Term extraction ───────────────────────────────────────────────────────

/** People named after an honorific — "Dr. Anita Patel", "Mr. Lee". High precision. */
export function honorificNames(text: string): string[] {
  const out: string[] = [];
  for (const m of Array.from(text.matchAll(HONORIFIC))) {
    const words = m[1].split(/\s+/).filter((w) => !/^[A-Z]\.$/.test(w)).filter(isNameWord);
    if (words.length === 0) continue;
    if (words.length >= 2) out.push(words.join(" "));
    const surname = words[words.length - 1];
    if (surname.length >= 3 && !COMMON_WORD_SURNAMES.has(surname.toLowerCase())) out.push(surname);
  }
  return out;
}

/** People in a free-text people fact (plus the honorific names). */
function peopleIn(text: string): string[] {
  const out = honorificNames(text);
  for (const m of Array.from(text.matchAll(NAME_RUN))) {
    const words = m[0].split(/\s+/);
    if (!words.every(isNameWord)) continue;
    out.push(words.join(" "));
    const surname = words[words.length - 1];
    if (surname.length >= 3 && !COMMON_WORD_SURNAMES.has(surname.toLowerCase())) out.push(surname);
  }
  for (const m of Array.from(text.matchAll(SINGLE_NAME))) {
    const w = m[1];
    if (w.length < 3 || !isNameWord(w) || COMMON_WORD_SURNAMES.has(w.toLowerCase())) continue;
    const at = m.index ?? 0;
    // Part of a capitalised title ("Lead Programmer (Miguel…") — not a name.
    if (/[A-Z][A-Za-zà-öø-ÿ'’-]*[ \t]+$/.test(text.slice(Math.max(0, at - 40), at))) continue;
    // "Controller (Jennifer Wu, …)" — the name is inside the brackets, the word is a role.
    if (/^[ \t]*\([ \t]*[A-Z]/.test(text.slice(at + w.length, at + w.length + 6))) continue;
    out.push(w);
  }
  return out;
}

/** A person's name held in a dedicated name field ({ name: "Maria" }). */
function personField(v: string): string[] {
  const words = v.replace(/\b(?:Dr|Dre|Mr|Mrs|Ms|Miss|Mx|Prof)\.?\s+/g, "").split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 4 || !words.every((w) => /^[A-Z]/.test(w) && isNameWord(w))) return peopleIn(v);
  const out = [words.join(" ")];
  const last = words[words.length - 1];
  if (words.length > 1 && last.length >= 3 && !COMMON_WORD_SURNAMES.has(last.toLowerCase())) out.push(last);
  if (words.length === 1 && (last.length < 3 || COMMON_WORD_SURNAMES.has(last.toLowerCase()))) return [];
  return out;
}

const CA_POSTAL = /\b[ABCEGHJ-NPRSTVXY]\d[ABCEGHJ-NPRSTV-Z] ?\d[ABCEGHJ-NPRSTV-Z]\d\b/gi;
const UNIT_LINE = /^(?:unit|suite|ste|apt|apartment|floor|fl|bay|#)\b/i;

/** Identifying pieces of a place fact: street line, street words, city, postal code. */
function placesIn(value: string): { cs: string[]; ci: string[] } {
  const cs: string[] = [];
  const ci: string[] = [];
  for (const line of value.split(/\n/)) {
    for (const m of Array.from(line.matchAll(CA_POSTAL))) ci.push(m[0]);
    const segs = line.replace(CA_POSTAL, "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    for (const seg of segs) {
      if (seg.length < 3 || isRegionLabel(seg) || UNIT_LINE.test(seg)) continue;
      if (/\d/.test(seg)) {
        // A street line — the line itself, and its distinctive words.
        if (/[A-Za-z]{3,}/.test(seg)) ci.push(seg.replace(/^#?\s*/, ""));
        for (const w of seg.match(/[A-Za-zÀ-ÖØ-öø-ÿ]{5,}/g) || []) {
          if (/^[A-Z]/.test(w) && !GENERIC_STREET_WORDS.has(w.toLowerCase()) && !isRegionLabel(w)) cs.push(w);
        }
        continue;
      }
      // A proper place name: capitalised words (with connectors), ≤ 5 words.
      const words = seg.split(/[\s-]+/).filter(Boolean);
      if (words.length > 5 || !/^[A-Z]/.test(words[0])) continue;
      if (!words.every((w) => /^[A-Z]/.test(w) || PLACE_CONNECTORS.has(w.toLowerCase()))) continue;
      if (words.length === 1 && GENERIC_STREET_WORDS.has(words[0].toLowerCase())) continue;
      cs.push(seg);
    }
  }
  return { cs, ci };
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
  const terms: BlindTerm[] = [];
  const add = (text: string, kind: BlindTermKind, caseSensitive: boolean) => {
    const t = text.replace(/\s+/g, " ").trim();
    if (t.length < 3 || t.length > 160) return;
    terms.push({ text: t, kind, caseSensitive });
  };

  for (const id of blindIdentifiers({ businessName: deal.businessName, extractedInfo: info as Record<string, any> })) add(id, "name", false);

  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("_")) continue;
    const strings = factStrings(value);
    if (strings.length === 0) continue;
    if (PERSON_KEY.test(key) && !/(salary|salaries|wages?|fees?|costs?|comp|compensation|pay|payroll|count|number|tenure|hours|involvement)$/i.test(key)) {
      for (const s of strings) for (const p of s.nameField ? personField(s.text) : peopleIn(s.text)) add(p, "person", true);
    } else if (/involvement/i.test(key)) {
      // Free prose about the owner — honorific names only.
      for (const s of strings) for (const p of honorificNames(s.text)) add(p, "person", true);
    }
    if (PLACE_KEY.test(key) || PLACE_KEYS.has(key.toLowerCase())) {
      for (const s of strings) {
        const { cs, ci } = placesIn(s.text);
        cs.forEach((p) => add(p, "place", true));
        ci.forEach((p) => add(p, "place", false));
      }
    }
    if (CONTACT_KEY.test(key)) {
      for (const s of strings) {
        const t = s.text.trim();
        if (/@/.test(t)) add(t, "contact", false);
        else if ((t.match(/\d/g) || []).length >= 7) add(t, "contact", false);
      }
    }
  }
  for (const p of opts.extraPeople ?? []) add(p, "person", true);

  // De-duplicate on the folded form; drop anything inside the codename.
  const code = opts.codename ? ` ${foldForMatch(opts.codename, false)} ` : "";
  const seen = new Set<string>();
  const out: BlindTerm[] = [];
  for (const t of terms) {
    const folded = foldForMatch(t.text, t.caseSensitive);
    if (folded.replace(/ /g, "").length < 3) continue;
    if (!t.caseSensitive && folded.replace(/ /g, "").length < 4) continue;
    if (code && code.includes(` ${folded.toLowerCase()} `)) continue;
    const k = `${t.caseSensitive ? "s" : "i"}:${folded}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
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
 * The terms (their fact text) that appear in the given text(s). Empty =
 * nothing identifying found.
 */
export function findBlindLeaks(texts: string | string[] | unknown, terms: BlindTerm[]): string[] {
  if (terms.length === 0) return [];
  const all = typeof texts === "string" ? texts : collectStrings(texts).join("\n");
  if (!all) return [];
  const cs = ` ${foldForMatch(all, true)} `;
  const ci = cs.toLowerCase();
  const hits: string[] = [];
  for (const t of terms) {
    const f = foldForMatch(t.text, t.caseSensitive);
    if (!f) continue;
    if ((t.caseSensitive ? cs : ci).includes(` ${f} `)) hits.push(t.text);
  }
  return hits;
}

/** Convenience: is this text free of the deal's identifying terms? */
export function isBlindSafe(texts: unknown, terms: BlindTerm[]): boolean {
  return findBlindLeaks(texts, terms).length === 0;
}
