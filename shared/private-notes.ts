/**
 * Broker-private notes — when two notes say the same thing.
 *
 * Every source that mentions the owner's heart episode (the CRM note, the
 * intro call, the video call, the interview) used to add its own note in its
 * own words, so one deal carried the same health note four times. Two notes
 * are the same note when their content words overlap by at least
 * SAME_NOTE_OVERLAP (overlap coefficient: shared words ÷ words of the
 * shorter note), after dropping filler ("owner", "seller", "had",
 * "disclosed"…) and folding synonyms (cardiac → heart, surgery → procedure).
 * Notes that name different figures ($60K vs $80K, 2023 vs 2024) are never
 * the same note.
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
  wife: "spouse", husband: "spouse", spouse: "spouse", partner: "spouse",
  kids: "children", kid: "children", child: "children", children: "children", son: "children", daughter: "children",
  grandkids: "grandchildren", grandchildren: "grandchildren", grandson: "grandchildren", granddaughter: "grandchildren",
  divorce: "divorce", divorced: "divorce", divorcing: "divorce", separation: "divorce", separated: "divorce",
  retire: "retire", retiring: "retire", retired: "retire", retirement: "retire",
  relocate: "move", relocating: "move", relocation: "move", move: "move", moving: "move",
  guarantee: "guarantee", guarantees: "guarantee", guaranteed: "guarantee", guarantor: "guarantee",
  dividend: "dividend", dividends: "dividend",
  floor: "price", bottom: "price", minimum: "price", lowest: "price", walk: "price", walkaway: "price",
};

/** Specific personal matters: two notes naming the same one are about the same thing. */
const TOPIC_STEMS: ReadonlySet<string> = new Set(["heart", "cancer", "divorce", "stroke", "dementia", "alzheimer", "parkinson", "grandchildren"]);

/**
 * Document housekeeping the extractor sometimes files as a "private note" —
 * a sample/fictional label, a confidentiality stamp. Neither a fact nor a note.
 */
export function isHousekeepingNote(note: string): boolean {
  return (
    /\b(sample|fictional|demonstration|demo|placeholder)\b[^.]{0,60}\b(document|business|company|data)\b/i.test(note) ||
    /\b(document|extract|file|statement)s?\b[^.]{0,40}\b(marked|stamped|labell?ed)\b[^.]{0,20}\bconfidential\b/i.test(note)
  );
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
}

/** The content words, names and figures of a note. */
export function noteContent(note: string): NoteContent {
  const words = new Set<string>();
  const names = new Set<string>();
  const numbers = new Set<string>();
  const text = note.replace(/[’']s\b/g, "");
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
    if (wasFirst && /^[A-Z]/.test(tok) && !SYNONYMS[lower]) continue;
    if (!wasStart && /^[A-Z][a-z]+$/.test(tok) && !SYNONYMS[lower]) { names.add(lower); continue; }
    words.add(stem(lower));
  }
  return { words, names, numbers };
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
