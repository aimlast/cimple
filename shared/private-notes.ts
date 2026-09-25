/**
 * Broker-private notes — when two notes say the same thing, and what is not
 * a private note at all.
 *
 * Every source that mentions the owner's heart episode (the CRM note, the
 * intro call, the video call, the interview) used to add its own note in its
 * own words, so one deal carried the same health note four times. Two notes
 * are the same note when their content words overlap by at least
 * SAME_NOTE_OVERLAP (overlap coefficient: shared words ÷ words of the
 * shorter note), after dropping filler ("owner", "seller", "had",
 * "disclosed"…) and folding synonyms (cardiac → heart, surgery → procedure).
 * Notes that name different figures ($60K vs $80K, 2023 vs 2024), different
 * people ("Gord" vs "Luis") or different relatives ("the owner" vs "the
 * owner's wife", "his son") are never the same note — a heart attack and the
 * wife's heart surgery are two matters.
 *
 * A merge never loses words: the source that restated a note keeps its own
 * wording on the note (info-merger.ts addPrivateNote), so a wrong merge
 * costs a grouping, never the text.
 *
 * Pure — shared by the server (addPrivateNote merges a restatement into the
 * note on file as another source) and the broker's Interview tab (older
 * duplicates are shown once).
 */

export const SAME_NOTE_OVERLAP = 0.6;

/** Words that carry no content in a private note. */
const FILLER = new Set([
  "a", "an", "the", "and", "or", "but", "of", "to", "in", "on", "at", "for", "from", "with", "by", "as", "is", "are",
  "was", "were", "be", "been", "being", "has", "have", "had", "his", "her", "their", "its", "he", "she", "they", "him",
  "them", "it", "this", "that", "these", "those", "there", "which", "who", "whom", "what", "when", "where", "about",
  "last", "year", "years", "ago", "per", "also", "just", "very", "some", "any", "all", "not", "no", "only", "into",
  "owner", "owners", "seller", "sellers", "founder", "vendor", "client", "said", "says", "say", "mentioned", "mentions",
  "disclosed", "discloses", "noted", "notes", "note", "stated", "states", "reported", "reports", "told", "tells",
  "shared", "shares", "confirmed", "confirms", "indicated", "indicates", "revealed", "reveals", "explained", "raised",
  "private", "privately", "confidential", "confidentially", "marked", "keep", "kept", "cim", "brochure", "broker",
  "do", "does", "did", "put", "want", "wants", "wanted", "would", "will", "should", "could", "may", "might", "must",
  "recent", "recently", "earlier", "since", "had", "having", "get", "got", "gets", "went",
]);

/** Folds different words for the same thing onto one stem. */
const SYNONYMS: Record<string, string> = {
  cardiac: "heart", cardiology: "heart", coronary: "heart", stent: "heart", angioplasty: "heart", bypass: "heart",
  surgery: "procedure", surgical: "procedure", operation: "procedure", operated: "procedure",
  episode: "event", incident: "event", attack: "event", scare: "event", issue: "event", issues: "event", problem: "event",
  problems: "event", condition: "event",
  health: "health", medical: "health", illness: "health", ill: "health", sick: "health", sickness: "health",
  cancer: "cancer", oncology: "cancer", tumour: "cancer", tumor: "cancer", chemo: "cancer", chemotherapy: "cancer",
  wife: "spouse", husband: "spouse", spouse: "spouse", partner: "spouse", bizpartner: "bizpartner",
  kids: "children", kid: "children", child: "children", children: "children", son: "children", daughter: "children",
  sons: "children", daughters: "children",
  grandkids: "grandchildren", grandchildren: "grandchildren", grandson: "grandchildren", granddaughter: "grandchildren",
  mother: "parent", father: "parent", mom: "parent", dad: "parent", parents: "parent", parent: "parent",
  brother: "sibling", sister: "sibling", sibling: "sibling", siblings: "sibling",
  divorce: "divorce", divorced: "divorce", divorcing: "divorce", separation: "divorce", separated: "divorce",
  retire: "retire", retiring: "retire", retired: "retire", retirement: "retire",
  relocate: "move", relocating: "move", relocation: "move", move: "move", moving: "move",
  guarantee: "guarantee", guarantees: "guarantee", guaranteed: "guarantee", guarantor: "guarantee",
  dividend: "dividend", dividends: "dividend",
  floor: "price", bottom: "price", minimum: "price", lowest: "price", walk: "price", walkaway: "price",
};

/**
 * Specific personal matters: two notes naming the same one about the same
 * person are about the same thing. (Relatives are who, not what — two notes
 * mentioning the grandchildren can be about different things.)
 */
const TOPIC_STEMS: ReadonlySet<string> = new Set(["heart", "cancer", "divorce", "stroke", "dementia", "alzheimer", "parkinson"]);

/** Relatives and associates a note can be about — they say whose matter it is. */
const RELATION_STEMS: ReadonlySet<string> = new Set(["spouse", "children", "grandchildren", "parent", "sibling", "bizpartner", "inlaw", "nephew", "niece", "cousin"]);

/**
 * What the extractor sometimes files as a "private note" that is neither a
 * personal matter nor a negotiation position — no note at all (the source
 * itself still says it, on its row in the Information tab):
 *   - document housekeeping: a sample/fictional label, a confidentiality stamp;
 *   - who took part ("Email participants: Morgan Ellis, Heather Kwan");
 *   - contact details only (a phone number, an office address);
 *   - deal-process status ("NDA in place", "Engagement letter signed") —
 *     engagement TERMS (a fee, a commission) stay notes;
 *   - the broker's to-dos ("Ask for WIP report", "Follow up on the lease").
 * A note that ADDS something to a stamp ("Document marked CONFIDENTIAL -
 * staff are not aware of the sale process") keeps what it adds
 * (withoutHousekeeping).
 */
export function isHousekeepingNote(note: string): boolean {
  return withoutHousekeeping(note) === null;
}

/** A sample/fictional label or a confidentiality stamp on the source itself. */
function isStampClause(clause: string): boolean {
  return (
    /\b(sample|fictional|demonstration|demo|placeholder)\b[^.]{0,60}\b(document|business|company|data)\b/i.test(clause) ||
    /\b(document|extract|file|statement)s?\b[^.]{0,40}\b(marked|stamped|labell?ed)\b[^.]{0,20}\bconfidential\b/i.test(clause)
  );
}

/**
 * The note without source housekeeping, or null when nothing is left (see
 * isHousekeepingNote): stamp clauses are cut out of a longer note, and a
 * note that is only process status, a to-do or contact details goes whole.
 */
export function withoutHousekeeping(note: string): string | null {
  const whole = note.trim();
  if (!whole) return null;
  const clauses = whole.split(/\s+[-–—]\s+|;\s+|(?<=[.!?])\s+/).map((c) => c.trim()).filter(Boolean);
  const kept = clauses.filter((c) => !isStampClause(c));
  if (kept.length === 0) return null;
  const t = kept.length === clauses.length ? whole : kept.join("; ");
  return isProcessOrContact(t) ? null : t;
}

function isProcessOrContact(t: string): boolean {
  // "Email participants: …", "Call attendees: …", "Participants — …".
  if (/^(?:[\w-]+\s){0,2}(?:participants?|attendees?|recipients?|cc'?d?)\s*[:—–-]/i.test(t)) return true;
  // Deal-process status, short and with no terms in it.
  if (
    t.length <= 90 &&
    /^(?:an?\s+|the\s+|mutual\s+|signed\s+)*(?:nda|non-disclosure agreement|confidentiality agreement|engagement letter|listing agreement|letter of engagement)\b[^.;]{0,40}\b(?:signed|executed|in place|sent|received|returned|on file|countersigned)\b[.\s]*$/i.test(t) &&
    !/\bfee|commission|%|\$|\bexclusiv/i.test(t)
  ) return true;
  // A to-do: "Ask for WIP report", "Follow up with the accountant", "Need to request the lease".
  if (/^(?:to-?do\s*[:—–-]\s*)?(?:(?:need|needs|remember) to\s+)?(?:ask (?:for|about|him|her|them|the|if|whether)|request|follow[ -]?up|chase|obtain|get (?:the|a|copies|copy)|send (?:the|him|her|them)|check (?:whether|if|on)|confirm whether|book (?:a|the))\b/i.test(t)) return true;
  if (isContactOnly(t)) return true;
  return false;
}

/** Words that, with a phone number, e-mail or street address, make a note nothing but contact details. */
const CONTACT_WORDS = new Set([
  "address", "addresses", "phone", "cell", "mobile", "number", "email", "e-mail", "contact", "contacts", "details",
  "office", "business", "personal", "home", "firm", "accountant", "accounting", "lawyer", "bookkeeper", "cpa", "llp",
  "inc", "ltd", "professional", "corporation", "located", "location", "suite", "unit", "street", "st", "avenue",
  "ave", "road", "rd", "drive", "dr", "way", "blvd", "boulevard", "crescent", "lane", "ln", "floor", "provided",
  "given", "is", "at", "the", "and", "of", "a", "an", "his", "her", "their", "on", "for", "with", "disclosed",
  "shared", "listed", "via", "reachable", "reach", "can", "be", "reached", "direct", "line", "fax", "po", "box",
  "gave", "own", "company", "co", "partners", "associates", "chartered", "professional", "accountants",
]);
const PHONE_RE = /\(?\b\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/g;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.]+\b/g;
const STREET_RE = /\b\d{1,6}[a-z]?\s+(?:[A-Z][\w'-]*\s+){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Way|Blvd|Boulevard|Crescent|Cres|Lane|Ln|Court|Ct|Place|Pl|Parkway|Pkwy|Highway|Hwy|Trail|Tr)\b\.?/g;
const POSTAL_RE = /\b[A-Z]\d[A-Z]\s?\d[A-Z]\d\b|\b[A-Z]{2}\s\d{5}(?:-\d{4})?\b/g;

/** True when the note is only a phone number, e-mail or address (plus labels and names). */
function isContactOnly(note: string): boolean {
  if (!(PHONE_RE.test(note) || EMAIL_RE.test(note) || STREET_RE.test(note))) {
    PHONE_RE.lastIndex = EMAIL_RE.lastIndex = STREET_RE.lastIndex = 0;
    return false;
  }
  PHONE_RE.lastIndex = EMAIL_RE.lastIndex = STREET_RE.lastIndex = 0;
  const rest = note.replace(PHONE_RE, " ").replace(EMAIL_RE, " ").replace(STREET_RE, " ").replace(POSTAL_RE, " ");
  // Whatever is left: labels, names (capitalised) and city/province names only.
  const words = rest.replace(/[’']s\b/g, "").split(/[^A-Za-z-]+/).filter(Boolean);
  // A capitalised content word ("Heart Surgery") is not a name.
  return words.every((w) => CONTACT_WORDS.has(w.toLowerCase()) || (/^[A-Z]/.test(w) && !SYNONYMS[w.toLowerCase()] && !TOPIC_STEMS.has(w.toLowerCase())));
}

/** Suffix folding so "procedures"/"procedure", "moved"/"move" meet. */
function stem(word: string): string {
  const w = SYNONYMS[word] ?? word;
  if (SYNONYMS[word]) return w;
  if (w.length > 5 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 4 && w.endsWith("es") && !w.endsWith("ses")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  return w;
}

const MONTHS = new Set(["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);

export interface NoteContent {
  /** Content words, stemmed (names excluded). */
  words: Set<string>;
  /** Names of people and places ("Gord", "Kelowna") — they say who, not what. */
  names: Set<string>;
  /** Figures and years the note names ("60k", "2024"). */
  numbers: Set<string>;
  /**
   * Whose matter the note is about: a relative or associate when the note
   * opens with one ("Owner's wife had…", "His son is…" → "spouse",
   * "children"), else "self" (the owner, or the person the note names).
   */
  subject: string;
}

/** The content words, names and figures of a note. */
export function noteContent(note: string): NoteContent {
  const words = new Set<string>();
  const names = new Set<string>();
  const numbers = new Set<string>();
  let subject: string | null = null;
  const text = note
    .replace(/[’']s\b/g, "")
    .replace(/\bbusiness partners?\b/gi, "bizpartner")
    .replace(/\b(?:mother|father|brother|sister|son|daughter)s?-in-law\b/gi, "inlaw");
  for (const m of Array.from(text.toLowerCase().matchAll(/\$?\d[\d,.]*\s?[km]?\b/g))) {
    const n = m[0].replace(/[$,\s]/g, "").replace(/\.$/, "");
    if (n) numbers.add(n);
  }
  // A capitalised word inside a sentence is a name. The note's first word is
  // usually its subject — a name ("Luis confirmed…") or a generic noun — so
  // unless it is a known content word it counts as neither.
  const tokens = text.split(/([.!?;:—–-]\s+|\s+|[^A-Za-z]+)/).filter((t) => t !== undefined);
  let sentenceStart = true;
  let first = true;
  for (const tok of tokens) {
    if (!tok) continue;
    if (/^[.!?;:—–-]\s+$/.test(tok) || /[.!?]/.test(tok)) { sentenceStart = true; continue; }
    if (!/^[A-Za-z]+$/.test(tok)) continue;
    const lower = tok.toLowerCase();
    const wasStart = sentenceStart;
    const wasFirst = first;
    sentenceStart = false;
    first = false;
    if (lower.length < 2 || FILLER.has(lower) || MONTHS.has(lower)) continue;
    if (wasFirst && /^[A-Z]/.test(tok) && !SYNONYMS[lower] && !RELATION_STEMS.has(lower)) continue;
    if (!wasStart && /^[A-Z][a-z]+$/.test(tok) && !SYNONYMS[lower] && !RELATION_STEMS.has(lower)) { names.add(lower); continue; }
    const w = stem(lower);
    // The first content word says whose matter it is.
    if (subject === null) subject = RELATION_STEMS.has(w) ? w : "self";
    words.add(w);
  }
  return { words, names, numbers, subject: subject ?? "self" };
}

/** True when the two notes say the same thing (see the module comment). */
export function sameNoteContent(a: string, b: string): boolean {
  const x = noteContent(a);
  const y = noteContent(b);
  // Different figures (and neither note's figures contained in the other's) → different notes.
  if (x.numbers.size > 0 && y.numbers.size > 0) {
    const shared = Array.from(x.numbers).some((n) => y.numbers.has(n));
    if (!shared) return false;
  }
  // About different people or places → different notes.
  const sharedNames = Array.from(x.names).filter((n) => y.names.has(n)).length;
  if (x.names.size > 0 && y.names.size > 0 && sharedNames === 0) return false;
  // About different relatives ("the owner" vs "the owner's wife") → different notes.
  if (x.subject !== y.subject) return false;
  // Two notes about the same specific condition or life event (the owner's
  // heart, a divorce) are the same note, however much detail each adds.
  if (Array.from(TOPIC_STEMS).some((t) => x.words.has(t) && y.words.has(t))) return true;
  const small = x.words.size <= y.words.size ? x.words : y.words;
  const large = small === x.words ? y.words : x.words;
  if (small.size === 0) return false;
  // One content word is too thin on its own — it must be about the same person or place too.
  if (small.size === 1 && sharedNames === 0) return false;
  let hit = 0;
  for (const w of Array.from(small)) if (large.has(w)) hit++;
  return hit / small.size >= SAME_NOTE_OVERLAP;
}

/**
 * Groups notes that say the same thing, keeping the first of each group and
 * the order the notes were recorded in. For display of older data recorded
 * before restatements were merged on write.
 */
export function groupSameNotes<T extends { note: string }>(notes: T[]): Array<{ note: T; same: T[] }> {
  const groups: Array<{ note: T; same: T[] }> = [];
  for (const n of notes) {
    const g = groups.find((x) => sameNoteContent(x.note.note, n.note));
    if (g) g.same.push(n);
    else groups.push({ note: n, same: [] });
  }
  return groups;
}

/**
 * Company transactions that involve the owner — business facts, not private
 * notes (the extractor records them under these keys; see its PRIVATE
 * MATTERS rule) — with the fact keys that record them.
 */
const BUSINESS_NOTE_FACTS: Array<{ note: RegExp; key: RegExp; canonical: string }> = [
  { note: /\bdividends?\b/i, key: /^dividend/i, canonical: "dividendsDeclared" },
  { note: /\bpersonal(?:ly)? (?:guarant|indemni)|\bpersonal indemnifier\b/i, key: /^personalGuarantee|guarantee|indemnit/i, canonical: "personalGuarantees" },
  {
    note: /\bshareholder loans?\b|\bdue (?:to|from) (?:the )?(?:majority )?(?:shareholders?|owner)\b|\bloans? (?:to|from) (?:the )?(?:owner|shareholder)/i,
    key: /^shareholderLoan|^dueTo|^dueFrom/i,
    canonical: "shareholderLoans",
  },
  {
    // A related-party lease or contract; premises owned by the owner's
    // holding company; a relative on the payroll or keeping the books.
    note: /\brelated[- ]part(?:y|ies)\b|\b(?:owned|controlled) by (?:an? |the )?(?:entity controlled by (?:the )?)?(?:majority )?(?:shareholder|owner)|\b(?:shareholder|owner)\b[^;]{0,20}\bcontrols\b[^;]{0,60}\bwhich owns\b|\bowned by\b[^;]{0,30}\b(?:holdco|holding compan(?:y|ies))\b|\b(?:family member|wife|husband|spouse|son|daughter|brother|sister)\b[^.;]{0,40}\b(?:employed|on (?:the )?payroll|does (?:the )?books|keeps (?:the )?books|bookkeep\w*)/i,
    key: /relatedParty/i,
    canonical: "relatedPartyTransactions",
  },
  { note: /\b(?:unaudited|audited|not audited|review engagement|compilation(?: engagement| only| report)?)\b/i, key: /^audit/i, canonical: "auditStatus" },
  // Who owns what share of the company ("Luis confirmed 15% ownership stake").
  { note: /\b\d{1,3}(?:\.\d+)?\s?%\s+(?:ownership|equity|stake|of the (?:shares|company))\b|\bownership stake\b/i, key: /^ownership|^shareholders?$|^shareholderStructure/i, canonical: "ownershipStructure" },
];

/** A negotiation position is a private note even when it names a guarantee or a dividend. */
const NEGOTIATION_RE = /\bnegotiat|\bfloor\b|\bbottom[- ]line\b|\bwalk[- ]?away\b|\blowest\b|\bwon'?t (?:go|accept) (?:below|lower|less)|\bprice expectation/i;

/**
 * The business fact a private note really is — a company transaction with
 * the owner (see BUSINESS_NOTE_FACTS) — with the key it belongs under and
 * the keys of that fact's family, or null. A negotiation position never is.
 */
export function businessFactForNote(note: string): { canonical: string; family: RegExp } | null {
  if (NEGOTIATION_RE.test(note)) return null;
  const rule = BUSINESS_NOTE_FACTS.find((r) => r.note.test(note));
  return rule ? { canonical: rule.canonical, family: rule.key } : null;
}

/** Amounts in a note that identify it ("$60,000" → "60000"; years and small numbers skipped). */
function noteAmounts(text: string): string[] {
  const out: string[] = [];
  for (const m of Array.from(text.matchAll(/\d[\d,]*(?:\.\d+)?/g))) {
    const d = m[0].replace(/,/g, "");
    if (/^(19|20)\d{2}$/.test(d) || d.replace(/\D/g, "").length < 3) continue;
    out.push(d);
  }
  return out;
}

/**
 * True when `note` is a company transaction with the owner (a dividend, a
 * personal guarantee of company debt, a related-party lease, the audit
 * status…) that the same source ALSO recorded as a fact, and every figure
 * the note names is in that fact. Such a note is the fact filed twice; the
 * fact is what the financial analysis and due diligence read. A note naming
 * a figure the fact lacks is kept — it says something the fact doesn't.
 */
/** Share of a note's content words a fact must hold to be the same statement. */
const RECORDED_OVERLAP = 0.5;

export function noteRecordedAsFact(note: string, facts: Record<string, unknown>): boolean {
  const amounts = noteAmounts(note);
  for (const rule of BUSINESS_NOTE_FACTS) {
    if (!rule.note.test(note)) continue;
    for (const [key, value] of Object.entries(facts)) {
      if (key.startsWith("_") || !rule.key.test(key)) continue;
      const text = typeof value === "string" ? value : value && typeof value === "object" ? JSON.stringify(value) : "";
      if (!text.trim()) continue;
      const digits = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
      if (!amounts.every((a) => new RegExp(`(^|[^\\d.])${a.replace(".", "\\.")}(?![\\d])`).test(digits))) continue;
      // And the fact says most of what the note says ("…not included in
      // the sale assets" adds to a fact that only gives the rent).
      const said = noteContent(note).words;
      const factWords = noteContent(text).words;
      let hit = 0;
      for (const w of Array.from(said)) if (factWords.has(w)) hit++;
      if (said.size === 0 || hit / said.size >= RECORDED_OVERLAP) return true;
    }
  }
  return false;
}
