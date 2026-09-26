/**
 * private-notes-review.ts — keeps a deal's broker-private notes to what they
 * should be: one note per matter, nothing that is no note at all, and no
 * business fact hiding in them.
 *
 * Every source that mentions the owner's heart episode (the CRM note, the
 * intro call, the video call, the interview) states it in its own words,
 * and every reprocess re-reads each source in new words — word overlap
 * (addPrivateNote / sameNoteContent) folds only near-identical wording, so
 * one deal grew from 43 to 57 notes on a reprocess. Here the supporting
 * model reads the notes once per NEW wording and decides, per wording:
 *  - "group": it is the same matter as other notes → one note, whose text
 *    the model writes keeping every distinct detail; every source keeps its
 *    own words on the note (shown under it), so a merge never loses what a
 *    source said;
 *  - "drop": document housekeeping or logistics ("EIN is masked in
 *    document", "Call booked for Thursday") — no note;
 *  - "fact": a material business fact (a customer's non-renewal notice, a
 *    dividend declared, an amended shareholder agreement) → moved into the
 *    facts, credited to its source.
 * The decisions are kept per wording on deals.private_notes_review and
 * re-applied deterministically on every run (applyNotesReview), so a
 * reprocess that re-states known notes changes nothing and asks nothing;
 * only wordings never seen before go to the model.
 *
 * Deterministic safety, whatever the model says:
 *  - a consolidated note must contain every figure and name of every note
 *    it replaces, and invent none — else the notes stay apart;
 *  - a note is dropped only when it names nothing personal, no negotiation
 *    or broker-process matter and no amount;
 *  - a fact is created only from a shared document / email / call source
 *    (never the interview, the questionnaire or a broker-only source), never
 *    from anything personal, private, negotiated or about the broker's
 *    process, and never over a value already on file or one the broker
 *    deleted;
 *  - a merged note's own text is shown to the seller side only through the
 *    seller-side source's own words (seller-view.ts), so a broker-only
 *    detail merged into a note never reaches the interview.
 */
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import type { Document } from "@shared/schema";
import { noteContent } from "@shared/private-notes";
import { agentConfig } from "../interview/config/load-config";
import {
  BROKER_PRIVATE_NOTES_KEY,
  getPrivateNotes,
  privateNoteSources,
  privateNoteText,
  isSourceKind,
  isSuppressed,
  setFieldSource,
  type BrokerPrivateNote,
  type FieldSource,
  type PrivateNoteSource,
} from "../interview/info-merger";
import { isBrokerProcessKey } from "./merge-policy";
import { withDealFactsLock } from "./facts-lock";

type Info = Record<string, unknown>;
export type ReviewDoc = Pick<Document, "id" | "name" | "visibility" | "sourceKind">;

export type NoteDecision =
  | { d: "group"; g: string }
  | { d: "drop"; why?: string }
  | { d: "fact"; key: string; value: string; documentId?: string; kind?: string; text?: string };

export interface ReviewGroup {
  /** The consolidated note. */
  text: string;
  /** The sources (origins) whose words it was written from — it is used only while all are still on the deal. */
  origins: string[];
}

/** Bumped when the decision rules change: older reviews are redone from scratch. */
export const REVIEW_VERSION = 3;

export interface NotesReview {
  v: number;
  items: Record<string, NoteDecision>;
  groups: Record<string, ReviewGroup>;
  nextId: number;
  /** The notes (group ids) the last fold was asked about. */
  foldedFor?: string;
  at?: string;
}

export function emptyReview(): NotesReview {
  return { v: REVIEW_VERSION, items: {}, groups: {}, nextId: 1 };
}

export function readReview(raw: unknown): NotesReview {
  const r = raw as Partial<NotesReview> | null | undefined;
  if (!r || r.v !== REVIEW_VERSION || typeof r.items !== "object" || typeof r.groups !== "object") return emptyReview();
  return {
    v: REVIEW_VERSION, items: { ...r.items }, groups: { ...r.groups }, nextId: Number(r.nextId) || 1,
    ...(typeof r.foldedFor === "string" ? { foldedFor: r.foldedFor } : {}),
    ...(r.at ? { at: r.at } : {}),
  };
}

/** Note on a fact's source when it was moved out of the private notes. */
export const MOVED_FROM_NOTES = "Moved from the private notes";

// ─── Guards ──────────────────────────────────────────────────────────────────

/** Personal, private or negotiated: never a fact, never dropped. */
const PERSONAL_RE =
  /\b(?:health|heart|cardiac|stent|cancer|tumou?r|diagnos\w*|illness|ill|sick\w*|surger\w*|stroke|doctor|hospital\w*|therap\w*|pregnan\w*|disab\w*|divorc\w*|separat(?:ed|ion)|marri\w*|wife|husband|spouse|sons?|daughters?|grand\w*|kids?|children|family|mother|father|mom|dad|brother|sister|widow\w*|age[ds]?|years? old|personal(?:ly)?|private(?:ly)?|confidential\w*|secret\w*|don'?t (?:want|put|share|tell|mention)|do not (?:put|share|tell|mention|include)|not (?:in|for) (?:the |any )?(?:cim|brochure|document|buyers?)|off the record|stress\w*|worr\w*|negotiat\w*|floor|walk[- ]?away|bottom[- ]line|price expectations?|expects?|expectation|number is|would (?:accept|take|go)|motivat\w*|retir\w*|relocat\w*|not (?:yet )?(?:aware|informed|told)|only [A-Z]\w+(?:,? (?:and )?[A-Z]\w+)* knows?|lawyer|estate|will and|tax (?:advice|planning)|capital gains)\b/i;
/** The broker's own process (how the deal came in, terms, earlier approaches): kept as a note. */
const PROCESS_RE =
  /\b(?:broker\w*|advis(?:or|er)s?|referr\w*|referred|fees?|commission\w*|engag\w*|retainer|exclusiv\w*|listing|lead source|approach\w*|offers?|offered|lowball|insulting|pricing strategy|strategy|buyer universe|ask(?:ing)? (?:price )?\$)/i;

/**
 * Someone's stance, plan or wish ("Karen thinks $42M is low", "would carry
 * some paper", "open to rolling 10-15%", "asked that no one be told"): a
 * position, never a fact about the company.
 */
const STANCE_RE =
  /\b(?:wants?|wanted|wanting|won'?t|will not|would(?:n'?t)?|willing|open to|prefers?|preferred|preference|thinks?|thought|believes?|feels?|hopes?|plans? to|intends?|considering|may (?:roll|see|consider|stay|want|sell|accept)|might|not ready|reluctant|flexible|acceptable|agreed|agrees|floated|says|said|told|tells|asked|asks|requested|requests|insists?|refuses?|doubtful|uncertain|concern(?:ed|s)?|views?|perspective|disagree\w*|dismissive|downplay\w*|biased|aligned|embarrass\w*|relief|joke\w*|push(?:es|ed|ing)? (?:to|for|hardest)|pushed hardest|on board|at (?:the )?(?:seller|owner|buyer)'?s? request|per the (?:seller|owner))\b/i;
/** "… per Luis": someone's account (case-sensitive — "per share" is no one's). */
const PER_PERSON_RE = /\bper [A-Z][a-z]+\b/;
/**
 * Deal terms, pricing, the sale process and who may know about it: the
 * broker's and the seller's business, never the company's facts.
 */
const DEAL_RE =
  /\b(?:vtb|vendor (?:take-?back|financing|note)|seller (?:note|financing|paper)|carry (?:some )?paper|earn-?outs?|roll(?:s|ing|ed)? (?:over|equity|\d)|rollover|asking|list(?:ing)? (?:at|price)|multiple|valuation|worth|fair (?:price|value)|price (?:talk|expectation|range|point)|deal (?:structure|process|owner|probability)|probability|nwc peg|peg|stay bonus\w*|retention bonus\w*|flight risk|iois?|lois?|qoe|data room|dd room|teaser|nda|cim|blind|codename|code name|for sale|(?:the )?sale process|know(?:s|n)? (?:about )?(?:the )?sale|(?:not|nobody|no one|no other)\b[^.;]{0,40}\b(?:know|told|aware)|to be told|out of (?:any|the)|not (?:appear|be (?:in|disclosed|mentioned))|keep\w* (?:it |this |[a-z]+'s name )?(?:out|quiet|private)|excluded buyers?|target buyers?|buyers? (?:will|would|may) (?:ask|want|pay)|timeline|timing|close by|closing date|transition (?:period|plan)|mandate)\b/i;

/** True when a note may be moved into the facts: nothing personal, private, negotiated, no stance and nothing about the deal process. */
export function isPromotableNote(text: string): boolean {
  return !PERSONAL_RE.test(text) && !PROCESS_RE.test(text) && !STANCE_RE.test(text) && !PER_PERSON_RE.test(text) && !DEAL_RE.test(text);
}

/**
 * The only facts a private note may become — standard disclosures a buyer's
 * due diligence needs — each with the words the note must use. A note moves
 * out only when the key is one of these and the note is about that subject.
 */
const FACT_CLASSES: Array<{ key: RegExp; subject: RegExp }> = [
  { key: /^dividends?(?:Declared|Paid|History|ByYear)?$/, subject: /\bdividends?\b/i },
  { key: /^(?:personalGuarantees?|guarantees?)$/, subject: /\bguarant(?:ee|or)\w*\b/i },
  { key: /^relatedParty(?:Transactions?|Lease|Leases|Arrangements?)?$/, subject: /\brelated[- ]party\b|\b(?:owned|controlled) by\b[^.;]{0,60}\b(?:shareholder|owner|holdco|holding)|\bfamily member\b[^.;]{0,40}\bemployed\b/i },
  { key: /^shareholders?(?:Agreement|Agreements|AgreementTerms|AgreementAmendments?)$/, subject: /\bshareholders?'? ?agreement\b|\busa\b|\bfirst refusal\b/i },
  { key: /^(?:shareStructure|shareClasses|shareCapital|capitalStructure|directors|boardOfDirectors)$/, subject: /\b(?:class [a-z] (?:shares?|dividends?|structure)|shares? (?:issued|class)|share (?:structure|capital)|directors?|board of directors|board (?:resolution|approv\w*))\b/i },
  { key: /^customer(?:NonRenewal|NonRenewals|Notice|Notices|Loss|Losses|Churn|Terminations?|Departures?)$/, subject: /\b(?:non-?renewal|notice|terminat\w*|cancel\w*|churn\w*|leaving|lost|lose|losing|not renew\w*)\b/i },
  { key: /^(?:insurance|insurancePolicies|lifeInsurance|keyPersonInsurance|buySellInsurance|corporateLifeInsurance)$/, subject: /\binsurance\b|\bpolic(?:y|ies)\b/i },
  { key: /^(?:auditStatus|financialStatementType|financialStatementBasis|reviewEngagement|assuranceLevel)$/, subject: /\b(?:audit\w*|unaudited|review engagement|compil\w*|notice to reader)\b/i },
  { key: /^(?:excludedAssets?|assetsExcluded)$/, subject: /\bexclu(?:ded|des?|sion) from (?:the |any )?sale\b|\bnot (?:included|part of|in) (?:the )?sale\b|\bowner keeps\b/i },
  { key: /^(?:litigation|legalProceedings|pendingLitigation|lawsuits?)$/, subject: /\b(?:litigation|lawsuit|sued|suing|court|claim filed|statement of claim)\b/i },
  { key: /^(?:keyEmployeeContracts?|employmentContracts?|employmentAgreements?)$/, subject: /\bemployment (?:contract|agreement)s?\b/i },
  { key: /^(?:shareholderLoans?|dueFromShareholders?|dueToShareholders?|dueFromRelatedParties|dueToRelatedParties)$/, subject: /\b(?:shareholder loans?|due (?:to|from) (?:shareholders?|holdco|related)|loans? (?:to|from) (?:the )?(?:shareholder|owner))\b/i },
];

/** True when `key` is a fact a private note may become and `text` is about it (and promotable at all). */
export function isPromotableFact(key: string, text: string): boolean {
  if (!isPromotableNote(text)) return false;
  return FACT_CLASSES.some((c) => c.key.test(key) && c.subject.test(text));
}

/** The keys the model may move a note into (for its instructions). */
export const PROMOTABLE_FACT_KEYS = "dividendsDeclared, personalGuarantees, relatedPartyTransactions, shareholdersAgreement, shareStructure, directors, customerNonRenewal, insurancePolicies, auditStatus, excludedAssets, litigation, keyEmployeeContracts, shareholderLoans";

/** Substance about the company, the deal or its figures: a note naming it is never dropped as housekeeping. */
const SUBSTANCE_RE =
  /\b(?:shares?|sharehold\w*|equity|director\w*|salar\w*|wages?|add-?backs?|audit\w*|unaudited|review engagement|compilation|dividend\w*|loans?|debt|lease\w*|rent|customer\w*|contract\w*|timeline|timing|clos(?:e|ing)|price|valuation|guarantee\w*|verif\w*|tbc|unconfirmed|rollover|vtb|financ\w*|insurance|litigation|lawsuit|dispute\w*|gift\w*|transfer\w*|resign\w*|revenue|ebitda|sde|profit|margin|backlog|employee\w*|staff|key (?:person|people|employee)|retention)\b/i;
/** The broker's process: kept as a note — unless the note only says something is absent ("fee not disclosed in this thread"). */
const PROCESS_KEEP_RE = /\b(?:referr\w*|referred|fees?|commission\w*|engag\w*|retainer|exclusiv\w*|approach\w*|offers?|offered|lowball|insulting)\b/i;
const ONLY_ABSENCE_RE = /\bnot (?:disclosed|detailed|specified|mentioned|provided|referenced|stated|included)\b/i;

/** True when a note may be dropped as housekeeping (nothing personal, no substance, no amount). */
export function isDroppableNote(text: string): boolean {
  if (PERSONAL_RE.test(text) || SUBSTANCE_RE.test(text)) return false;
  if (PROCESS_KEEP_RE.test(text) && !ONLY_ABSENCE_RE.test(text)) return false;
  if (/\$\s?\d|\d\s?%|\b\d[\d,.]*\s?(?:k|m|million|thousand)\b/i.test(text)) return false;
  return true;
}

/** Spelled small numbers ("two grandchildren", "three years") — "one" is left alone ("no one", "one-third"). */
const SPELLED: Record<string, string> = {
  two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10", eleven: "11", twelve: "12",
  twenty: "20", thirty: "30", forty: "40", fifty: "50", sixty: "60",
};

function digitsForWords(text: string): string {
  return text.replace(/\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|sixty)\b/gi, (w) => SPELLED[w.toLowerCase()]);
}

/** Every number a text names, as a value ("$6.5M" = "6,500,000"; "15-20%" → 15, 20; "2024"; "two" → 2). */
export function numberValues(raw: string): number[] {
  const text = digitsForWords(raw);
  const out: number[] = [];
  const mult: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|million|thousand|b|billion)?(?![a-z])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    out.push(n * (m[2] ? mult[m[2].toLowerCase()] ?? 1 : 1));
  }
  return out;
}

const hasValue = (pool: number[], v: number) => pool.some((p) => Math.abs(p - v) <= Math.max(Math.abs(p), Math.abs(v)) * 0.005);

/**
 * Words the deal's notes also use in lower case ("engaged", "advisor") —
 * capitalised mid-sentence they are a heading, not a name.
 */
export function commonWordsOf(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const w of t.match(/\b[a-z][a-z'-]{2,}\b/g) ?? []) out.add(w);
  return out;
}

/** What a consolidated note drops or invents compared with the notes it covers ([] = nothing). */
export function missingDetails(text: string, members: string[], common: Set<string> = new Set(), opts: { coverageOnly?: boolean } = {}): string[] {
  const out: string[] = [];
  const own = numberValues(text);
  const all = members.flatMap(numberValues);
  for (const m of members) {
    for (const [raw] of Array.from(digitsForWords(m).matchAll(/\$?\d[\d,]*(?:\.\d+)?\s*(?:k|mm|m|million|thousand|b|billion)?%?/gi))) {
      const v = numberValues(raw);
      if (v.length > 0 && !v.every((x) => hasValue(own, x))) out.push(raw.trim());
    }
  }
  if (!opts.coverageOnly) for (const v of own) if (!hasValue(all, v)) out.push(`(not in any note: ${v})`);
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const m of members) {
    for (const name of Array.from(noteContent(m).names)) {
      if (common.has(name) || lower.includes(` ${name} `)) continue;
      out.push(name);
    }
  }
  return Array.from(new Set(out));
}

/**
 * True when `text` keeps every figure and name each of `members` states and
 * names no figure none of them states — a consolidated note loses nothing
 * and invents nothing. (Every source's own words stay on the note as well.)
 */
export function keepsEveryDetail(text: string, members: string[], common: Set<string> = new Set()): boolean {
  return missingDetails(text, members, common).length === 0;
}

/** The figures and names `text` states that none of `members` does ([] = it invents nothing). */
export function inventedDetails(text: string, members: string[], common: Set<string> = new Set()): string[] {
  const out: string[] = [];
  const all = members.flatMap(numberValues);
  for (const v of numberValues(text)) if (!hasValue(all, v)) out.push(String(v));
  const pool = ` ${members.join(" ").toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
  for (const name of Array.from(noteContent(text).names)) {
    if (common.has(name) || pool.includes(` ${name} `)) continue;
    out.push(name);
  }
  return out;
}

/** Words that carry no content of their own (a rewording may add or drop them). */
const FILLER_WORDS = new Set("the and for with from that this was were are has have had its their them they which who whom whose also into onto upon per been being will would than then there these those".split(" "));
function contentWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z][a-z']*/g) ?? [])
    .map((w) => w.replace(/'s$|'$/, ""))
    .filter((w) => w.length >= 3 && !FILLER_WORDS.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(?:es|s)$/, "") : w));
}

/**
 * The value a note moved into the facts is written as. The fact is credited
 * to the note's SHARED source (seller-visible), so it may say nothing that
 * shared wording doesn't: the model's value is used only when it keeps
 * every figure and name, invents none, adds no content word or name (a
 * clause taken from a broker-only note, a CRM detail, a health detail) and
 * passes the promotable screens itself; else the note's own words. Pure.
 */
export function promotedValue(key: string, value: string | null | undefined, note: string, common: Set<string> = new Set()): string {
  const v = (value ?? "").replace(/\s+/g, " ").trim();
  if (!v || v === note.trim()) return note;
  if (!keepsEveryDetail(v, [note], common) || inventedDetails(v, [note], common).length > 0) return note;
  if (!isPromotableFact(key, v)) return note;
  const have = new Set(contentWords(note));
  return contentWords(v).every((w) => have.has(w)) ? v : note;
}

// ─── Items: one per wording ──────────────────────────────────────────────────

export interface NoteItem {
  key: string;
  text: string;
  /** The sources that state it in these words (without `wording`). */
  sources: PrivateNoteSource[];
  /** At least one source is seller-side (the interview, a shared row). */
  shared: boolean;
}

/** A source's identity without its wording: the row, the questionnaire, or the seller's sessions. */
function originId(s: PrivateNoteSource): string {
  return s.documentId ? `doc:${s.documentId}` : s.questionnaire ? "questionnaire" : "session";
}

function bare(s: PrivateNoteSource): PrivateNoteSource {
  const { wording: _w, ...rest } = s;
  return rest;
}

function isSellerSide(s: PrivateNoteSource, docs: Map<string, ReviewDoc>): boolean {
  if (s.brokerOnly) return false;
  if (!s.documentId) return true;
  const d = docs.get(s.documentId);
  return !!d && d.visibility !== "broker_only";
}

/** Every distinct wording on the deal's notes, with the sources that state it, in order. */
export function collectNoteItems(info: Info, docs: Map<string, ReviewDoc>): NoteItem[] {
  const items = new Map<string, NoteItem>();
  for (const n of getPrivateNotes(info)) {
    for (const s of privateNoteSources(n)) {
      const text = (s.wording ?? n.note).trim();
      if (!text) continue;
      const key = privateNoteText(text);
      const it = items.get(key) ?? { key, text, sources: [], shared: false };
      const src = bare(s);
      if (!it.sources.some((x) => originId(x) === originId(src))) it.sources.push(src);
      it.shared = it.shared || isSellerSide(src, docs);
      items.set(key, it);
    }
  }
  return Array.from(items.values());
}

// ─── Applying the decisions (pure) ───────────────────────────────────────────

/**
 * Several wordings from one source for one matter (a reprocess re-reads the
 * source in new words each time): a wording adds nothing when its figures,
 * names and most of its words are in the others that source gave.
 */
function pruneRestatements(list: Array<{ src: PrivateNoteSource; text: string }>, noteText: string): Array<{ src: PrivateNoteSource; text: string }> {
  const byOrigin = new Map<string, Array<{ src: PrivateNoteSource; text: string }>>();
  for (const x of list) {
    const o = originId(x.src);
    byOrigin.set(o, [...(byOrigin.get(o) ?? []), x]);
  }
  const keep = new Set<{ src: PrivateNoteSource; text: string }>();
  for (const group of Array.from(byOrigin.values())) {
    const sorted = [...group].sort((a, b) =>
      Number(privateNoteText(b.text) === privateNoteText(noteText)) - Number(privateNoteText(a.text) === privateNoteText(noteText)) ||
      b.text.length - a.text.length);
    const keptTexts: string[] = [];
    for (const x of sorted) {
      if (keptTexts.length > 0) {
        const nums = numberValues(x.text);
        const pool = keptTexts.flatMap(numberValues);
        const c = noteContent(x.text);
        const kc = keptTexts.map((t) => noteContent(t));
        const names = Array.from(c.names).every((nm) => kc.some((k) => k.names.has(nm)));
        const words = Array.from(c.words);
        const covered = words.filter((w) => kc.some((k) => k.words.has(w))).length;
        if (nums.every((v) => hasValue(pool, v)) && names && (words.length === 0 || covered / words.length >= 0.8)) continue;
      }
      keptTexts.push(x.text);
      keep.add(x);
    }
  }
  return list.filter((x) => keep.has(x));
}

/** One note from its wordings: `text` is the note, each source keeps its own words when they differ. */
function buildNote(text: string, members: NoteItem[]): BrokerPrivateNote {
  const raw = members.flatMap((m) => m.sources.map((s) => ({ src: s, text: m.text })));
  const seen = new Set<string>();
  const unique = raw.filter((x) => {
    const id = `${originId(x.src)}|${privateNoteText(x.text)}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  const list = pruneRestatements(unique, text);
  // A source whose own words are the note goes first (its words need no wording).
  list.sort((a, b) => Number(privateNoteText(b.text) === privateNoteText(text)) - Number(privateNoteText(a.text) === privateNoteText(text)));
  const sources: PrivateNoteSource[] = list.map((x) =>
    privateNoteText(x.text) === privateNoteText(text) ? bare(x.src) : { ...bare(x.src), wording: x.text });
  return { note: text, ...sources[0], ...(sources.length > 1 ? { alsoFrom: sources.slice(1) } : {}) };
}

/** The shared source a fact moved out of a note is credited to, or null. */
function promotionSource(it: Pick<NoteItem, "sources">, docs: Map<string, ReviewDoc>): { documentId: string; kind: string } | null {
  for (const s of it.sources) {
    if (!s.documentId || s.brokerOnly) continue;
    const d = docs.get(s.documentId);
    if (!d || d.visibility === "broker_only") continue;
    const kind = isSourceKind(d.sourceKind) ? d.sourceKind : "document";
    if (kind === "document" || kind === "email" || kind === "call" || kind === "video_call") return { documentId: d.id, kind };
  }
  return null;
}

/** True when the value on file already says what the note says (its figures and most of its words). */
function factCoversNote(value: unknown, note: string): boolean {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
  const pool = numberValues(text);
  if (!numberValues(note).every((v) => hasValue(pool, v))) return false;
  const said = Array.from(noteContent(note).words);
  const fact = noteContent(text).words;
  return said.length === 0 || said.filter((w) => fact.has(w)).length / said.length >= 0.5;
}

/**
 * Moves a note into the facts (mutates `info`): writes `key` when it is
 * empty and not deleted by the broker, credited to the note's shared
 * source. True when the note is now a fact (written, or already on file).
 */
function applyPromotion(info: Info, key: string, value: string, note: string, src: { documentId: string; kind: string } | null): boolean {
  if (!src || !isPromotableFact(key, note) || isBrokerProcessKey(key)) return false;
  if (isSuppressed(info, key)) return false;
  const cur = info[key];
  if (cur !== undefined && cur !== null && cur !== "") return factCoversNote(cur, note);
  // Checked again here: a decision stored before the check (re-applied on
  // every reprocess) never writes more than the shared note says.
  info[key] = promotedValue(key, value, note);
  setFieldSource(info, key, {
    source: src.kind as FieldSource["source"],
    documentId: src.documentId,
    brokerOnly: false,
    note: MOVED_FROM_NOTES,
    excerpt: note.slice(0, 300),
    at: new Date().toISOString(),
  });
  return true;
}

export interface AppliedReview {
  info: Info;
  changed: boolean;
  /** Wordings no decision covers yet (for the model). */
  pending: NoteItem[];
}

/** For each note on file, the wordings (item keys) it holds — a wording in two notes counts in the first. */
function wordingsByNote(notes: BrokerPrivateNote[]): string[][] {
  const seen = new Set<string>();
  return notes.map((n) => {
    const keys: string[] = [];
    for (const s of privateNoteSources(n)) {
      const text = (s.wording ?? n.note).trim();
      if (!text) continue;
      const key = privateNoteText(text);
      if (seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
    return keys;
  });
}

/**
 * Pure: the deal's notes (and facts) with the review's decisions applied.
 * Wordings without a decision stay as they are on file: a note none of
 * whose wordings is decided is kept exactly as it is, and undecided
 * wordings that share a note stay together — so a review the model couldn't
 * make (no credits, an outage) never pulls folded notes apart.
 */
export function applyNotesReview(info: Info, review: NotesReview, docs: Map<string, ReviewDoc>): AppliedReview {
  const notes = getPrivateNotes(info);
  const next: Info = { ...info };
  const items = collectNoteItems(info, docs);
  const byKey = new Map(items.map((it) => [it.key, it]));
  const pending: NoteItem[] = [];
  const out: BrokerPrivateNote[] = [];
  const emitted = new Set<string>();
  const decision = (it: NoteItem) => review.items[it.key];
  const noteKeys = wordingsByNote(notes);
  const noteOf = new Map<string, number>();
  noteKeys.forEach((keys, i) => keys.forEach((k) => noteOf.set(k, i)));
  const pendingNotes = new Set<number>();
  for (const it of items) {
    const dec = decision(it);
    if (!dec) {
      pending.push(it);
      const i = noteOf.get(it.key);
      if (i === undefined || pendingNotes.has(i)) continue;
      pendingNotes.add(i);
      const keys = noteKeys[i];
      const undecided = keys.map((k) => byKey.get(k)).filter((m): m is NoteItem => !!m && !decision(m));
      // Nothing about this note is decided yet: it stays exactly as it is.
      if (undecided.length === keys.length) out.push(notes[i]);
      else {
        const own = undecided.find((m) => m.key === privateNoteText(notes[i].note));
        out.push(buildNote(own ? own.text : [...undecided].sort((x, y) => y.text.length - x.text.length)[0].text, undecided));
      }
      continue;
    }
    if (dec.d === "drop" && isDroppableNote(it.text)) continue;
    if (dec.d === "fact" && applyPromotion(next, dec.key, dec.value, it.text, promotionSource(it, docs))) continue;
    if (dec.d === "group" && review.groups[dec.g]) {
      if (emitted.has(dec.g)) continue;
      emitted.add(dec.g);
      const members = items.filter((i) => {
        const d = decision(i);
        return d?.d === "group" && d.g === dec.g;
      });
      const g = review.groups[dec.g];
      const present = new Set(members.flatMap((m) => m.sources.map(originId)));
      // The consolidated words only while every source they were written from is still here.
      const text = g.origins.every((o) => present.has(o))
        ? g.text
        : [...members].sort((x, y) => y.text.length - x.text.length)[0].text;
      out.push(buildNote(text, members));
      continue;
    }
    out.push(buildNote(it.text, [it]));
  }
  // A fact moved out of a note stays a fact while its source is on the deal
  // (a reprocess that no longer re-reads it as a note never loses it).
  for (const dec of Object.values(review.items)) {
    if (dec.d !== "fact" || !dec.documentId || !dec.text) continue;
    const cur = next[dec.key];
    if (cur !== undefined && cur !== null && cur !== "") continue;
    applyPromotion(next, dec.key, dec.value, dec.text, promotionSource({ sources: [{ documentId: dec.documentId }] }, docs));
  }
  if (out.length > 0) next[BROKER_PRIVATE_NOTES_KEY] = out;
  else delete next[BROKER_PRIVATE_NOTES_KEY];
  const changed = JSON.stringify(out) !== JSON.stringify(notes) ||
    Object.keys(next).some((k) => k !== BROKER_PRIVATE_NOTES_KEY && JSON.stringify(next[k]) !== JSON.stringify(info[k]));
  return { info: next, changed, pending };
}

/**
 * Pure: decisions for undecided wordings that were folded (addPrivateNote:
 * the same content in other words — typically a source re-read in new
 * words) into a note with a decided wording: they follow that wording into
 * its note, or out of the notes with it when that is safe for their own
 * words. Returns a new review; the model is asked only about the rest.
 */
export function adoptFoldedWordings(info: Info, review: NotesReview, docs: Map<string, ReviewDoc>): NotesReview {
  const out: NotesReview = { ...review, items: { ...review.items }, groups: { ...review.groups } };
  const items = new Map(collectNoteItems(info, docs).map((it) => [it.key, it]));
  for (const keys of wordingsByNote(getPrivateNotes(info))) {
    const decided = keys.map((k) => out.items[k]).filter((d): d is NoteDecision => !!d);
    if (decided.length === 0) continue;
    const group = decided.find((d): d is Extract<NoteDecision, { d: "group" }> => d.d === "group" && !!out.groups[d.g]);
    const drop = decided.find((d) => d.d === "drop");
    const fact = decided.find((d): d is Extract<NoteDecision, { d: "fact" }> => d.d === "fact");
    for (const k of keys) {
      if (out.items[k]) continue;
      const it = items.get(k);
      if (!it) continue;
      if (group) {
        out.items[k] = { d: "group", g: group.g };
        continue;
      }
      if (drop && isDroppableNote(it.text)) {
        out.items[k] = { d: "drop", why: "restates a note that is no note" };
        continue;
      }
      const src = fact ? promotionSource(it, docs) : null;
      if (fact && src && isPromotableFact(fact.key, it.text)) {
        out.items[k] = { d: "fact", key: fact.key, value: promotedValue(fact.key, fact.value, it.text), documentId: src.documentId, kind: src.kind, text: it.text };
      }
    }
  }
  return out;
}

// ─── The model's placements → decisions ─────────────────────────────────────

export interface ModelPlacement {
  groups?: Array<{ id?: string; merge?: string[]; text?: string; notes?: string[] }>;
  notNotes?: Array<{ note?: string; kind?: string; factKey?: string; factValue?: string }>;
}

export interface CurrentGroup {
  id: string;
  text: string;
  members: NoteItem[];
}

/** A consolidation the model proposed whose text dropped or invented a detail: repaired once, else not made. */
export interface RejectedGroup {
  /** Existing notes it folds together (the first keeps its id). */
  targets: string[];
  existing: NoteItem[];
  fresh: NoteItem[];
  text: string;
  missing: string[];
}

function groupSetter(out: NotesReview) {
  return (id: string | undefined, text: string, members: NoteItem[]) => {
    const gid = id ?? `g${out.nextId++}`;
    out.groups[gid] = { text, origins: Array.from(new Set(members.flatMap((m) => m.sources.map(originId)))) };
    out.items[privateNoteText(text)] = { d: "group", g: gid };
    for (const m of members) out.items[m.key] = { d: "group", g: gid };
    return gid;
  };
}

/**
 * Pure: records the model's placement of the `batch` wordings (ids N1…) into
 * `review` (returns a new review), enforcing the safety rules in the module
 * comment. Wordings the model left out, or placed unsafely, become notes of
 * their own; consolidations whose text loses or invents a detail are
 * returned as `rejects` (for one repair, then settleRejects).
 */
export function recordPlacements(
  review: NotesReview,
  placement: ModelPlacement,
  batch: NoteItem[],
  current: CurrentGroup[],
  docs: Map<string, ReviewDoc>,
  common: Set<string> = new Set(),
): { review: NotesReview; rejects: RejectedGroup[] } {
  const out: NotesReview = { ...review, items: { ...review.items }, groups: { ...review.groups } };
  const setGroup = groupSetter(out);
  const byId = new Map(batch.map((it, i) => [`N${i + 1}`, it]));
  const placed = new Set<string>();
  const rejects: RejectedGroup[] = [];
  for (const nn of placement.notNotes ?? []) {
    const it = nn.note ? byId.get(nn.note) : undefined;
    if (!it || placed.has(it.key)) continue;
    if (nn.kind === "housekeeping" && isDroppableNote(it.text)) {
      out.items[it.key] = { d: "drop", why: "housekeeping" };
      placed.add(it.key);
      continue;
    }
    if (nn.kind === "business_fact" && nn.factKey) {
      const src = promotionSource(it, docs);
      const key = nn.factKey.replace(/[^A-Za-z0-9]/g, "").replace(/^[A-Z]/, (c) => c.toLowerCase());
      if (src && isPromotableFact(key, it.text) && !isBrokerProcessKey(key)) {
        const value = promotedValue(key, nn.factValue ?? "", it.text, common);
        out.items[it.key] = { d: "fact", key, value, documentId: src.documentId, kind: src.kind, text: it.text };
        placed.add(it.key);
        continue;
      }
    }
    // Not safely droppable or movable: it stays a note (placed below if the model grouped it, else alone).
  }
  const currentById = new Map(current.map((g) => [g.id, { ...g }]));
  for (const g of placement.groups ?? []) {
    const fresh = Array.from(new Set(g.notes ?? [])).map((id) => byId.get(id)).filter((x): x is NoteItem => !!x && !placed.has(x.key));
    const targets = Array.from(new Set([g.id, ...(g.merge ?? [])].filter((id): id is string => !!id && currentById.has(id))));
    if (fresh.length === 0 && targets.length < 2) continue;
    const existing = targets.flatMap((id) => currentById.get(id)!.members);
    const all = [...existing, ...fresh];
    const text = (g.text ?? "").replace(/\s+/g, " ").trim().slice(0, 700);
    for (const m of fresh) placed.add(m.key);
    const missing = text ? missingDetails(text, all.map((m) => m.text), common) : ["(no text)"];
    if (missing.length > 0) {
      rejects.push({ targets, existing, fresh, text, missing });
      continue;
    }
    const gid = setGroup(targets[0], text, all);
    for (const id of targets.slice(1)) currentById.delete(id);
    currentById.set(gid, { id: gid, text, members: all });
  }
  for (const it of batch) if (!placed.has(it.key)) setGroup(undefined, it.text, [it]);
  return { review: out, rejects };
}

/**
 * Pure: settles rejected consolidations with the model's repaired texts
 * (`repaired[i]` for `rejects[i]`). The notes the model put together stay
 * together — only the wording of the note is at stake, and every source's
 * own words stay under it: a text that keeps every detail; else the notes'
 * own words joined, while that stays a short note; else the model's words
 * when they invent nothing; else the fullest single wording.
 */
export function settleRejects(
  review: NotesReview,
  rejects: RejectedGroup[],
  repaired: Array<string | undefined>,
  common: Set<string> = new Set(),
): NotesReview {
  const out: NotesReview = { ...review, items: { ...review.items }, groups: { ...review.groups } };
  const setGroup = groupSetter(out);
  rejects.forEach((r, i) => {
    const all = [...r.existing, ...r.fresh];
    const texts = all.map((m) => m.text);
    const fixed = (repaired[i] ?? "").replace(/\s+/g, " ").trim().slice(0, 700);
    if (fixed && keepsEveryDetail(fixed, texts, common)) {
      setGroup(r.targets[0], fixed, all);
      return;
    }
    const joined = coverText(texts, common);
    if (joined.length <= MAX_JOINED) {
      setGroup(r.targets[0], joined, all);
      return;
    }
    const summary = [fixed, r.text].find((x) => !!x && inventedDetails(x, texts, common).length === 0);
    setGroup(r.targets[0], summary ?? [...texts].sort((x, y) => y.length - x.length)[0], all);
  });
  return out;
}

const MAX_JOINED = 480;

/**
 * Pure: one text holding every detail of `texts` in their own words — the
 * longest, then each other that names a figure or name not yet covered
 * (restatements add nothing and are left out).
 */
export function coverText(texts: string[], common: Set<string> = new Set()): string {
  const sorted = Array.from(new Set(texts.map((t) => t.trim()).filter(Boolean))).sort((a, b) => b.length - a.length);
  const kept: string[] = [];
  for (const t of sorted) {
    if (kept.length > 0 && missingDetails(kept.join("; "), [t], common, { coverageOnly: true }).length === 0) continue;
    kept.push(t.replace(/[.\s]+$/, ""));
  }
  return kept.join("; ");
}

/** The notes on file grouped as the review has them (for the model). */
export function currentGroups(items: NoteItem[], review: NotesReview): CurrentGroup[] {
  const out = new Map<string, CurrentGroup>();
  for (const it of items) {
    const dec = review.items[it.key];
    if (dec?.d !== "group" || !review.groups[dec.g]) continue;
    const g = out.get(dec.g) ?? { id: dec.g, text: review.groups[dec.g].text, members: [] };
    g.members.push(it);
    out.set(dec.g, g);
  }
  return Array.from(out.values());
}

// ─── The model ───────────────────────────────────────────────────────────────

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const REVIEW_TOOL: Anthropic.Tool = {
  name: "review_private_notes",
  description: "Place every NEW note: into an existing note (same matter), into a new consolidated note, or out of the notes (housekeeping / business fact). Existing notes about one matter may be folded together.",
  input_schema: {
    type: "object",
    properties: {
      groups: {
        type: "array",
        description: "Consolidated notes. Use an existing id (G…) to add to that note; omit id for a new note.",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Existing note id (G…) this becomes, or omit for a new note" },
            merge: { type: "array", items: { type: "string" }, description: "Other EXISTING note ids (G…) about the same matter, folded into this one" },
            text: { type: "string", description: "The whole note: short, factual, keeps EVERY figure, date, name, qualifier and privacy instruction of every note it covers" },
            notes: { type: "array", items: { type: "string" }, description: "The NEW note ids (N…) that belong here" },
          },
          required: ["text", "notes"],
        },
      },
      notNotes: {
        type: "array",
        items: {
          type: "object",
          properties: {
            note: { type: "string", description: "NEW note id (N…)" },
            kind: { type: "string", enum: ["housekeeping", "business_fact"] },
            factKey: { type: "string", description: "business_fact only: camelCase fact key" },
            factValue: { type: "string", description: "business_fact only: the fact, keeping every figure and date" },
          },
          required: ["note", "kind"],
        },
      },
    },
    required: ["groups", "notNotes"],
  },
};

const SYSTEM = [
  "You tidy a business broker's PRIVATE notes about one business for sale. The notes come from many sources (calls, emails, CRM notes, documents, the seller's interview) and repeat each other in different words; the broker wants ONE note per matter — a deal usually has 8 to 18 matters, so most new notes belong in an existing note.",
  "A private note is: a personal matter of the owner, their family or staff (health, family, age, personal plans); the seller's negotiation position or expectations (price, terms, seller financing, rollover, timing, what they will or won't accept); the broker's own process and strategy (referral source, engagement and fees, earlier approaches and offers, pricing strategy, buyer universe, who knows about the sale); caveats about how reliable figures are; anything a source says must stay confidential.",
  "Notes marked [broker-only] come from the broker's own sources; merge them with [shared] notes about the same matter.",
  "Place every NEW note (N…) exactly once:",
  "1) Same matter as an existing note (G…) → list it under that id and rewrite that note's text to include what it adds. Same matter as other NEW notes → one new note. When two EXISTING notes are about one matter, fold them (id = one, merge = the others). Different wordings of one matter from different sources ARE one note (\"Gord had a cardiac episode last Oct\" = \"Seller had a cardiac event in October 2024 (stent placed); asked to keep it out of any brochure\"); so are all notes on the seller's financing terms, all on the broker's engagement, all on the grandchildren / relocation. Different matters stay separate: two different people's matters are two notes.",
  "2) Every note text keeps EVERY distinct detail of the notes it covers: every figure and date (as digits), every person's and place's name, every qualifier and every instruction to keep something private. Never generalise or drop a detail, never add one. Short and factual — no source names, no \"noted as\", no commentary.",
  "3) kind housekeeping: not a note at all — document mechanics or labels (\"sample document\", \"EIN is masked\", \"IDs only\", \"not a real company\"), who prepared or sent a document, scheduling and next steps (a call booked, documents to send), remarks that something is not mentioned in a source. Never housekeeping when it says anything personal, a negotiation position, a figure, a caveat or how the deal came to the broker.",
  `4) kind business_fact: a material fact about the COMPANY a buyer's due diligence needs, that is not personal, not anyone's view, wish or position, not a deal term (price, financing, earn-out, rollover, timing), not the broker's process and not marked private — a customer's notice of non-renewal, a shareholder-agreement term or amendment, share classes, directors, dividends declared, a related-party arrangement, an asset excluded from the sale, insurance policies, the audit / review / compilation status, a key employee without an employment contract, litigation, shareholder loans. factKey must be one of: ${PROMOTABLE_FACT_KEYS}. factValue keeps every figure and date. When in doubt, keep it as a note.`,
  "5) When there are no new notes, only fold existing notes that are about one matter; leave the others out of your answer.",
].join("\n");

async function askModel(batch: NoteItem[], current: CurrentGroup[], facts: string): Promise<ModelPlacement> {
  const side = (it: NoteItem) => (it.shared ? "shared" : "broker-only");
  const existing = current.map((g) => `${g.id}: ${g.text}`).join("\n");
  const fresh = batch.map((it, i) => `N${i + 1} [${side(it)}]: ${it.text}`).join("\n");
  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 12000,
    temperature: 0,
    tools: [REVIEW_TOOL],
    tool_choice: { type: "tool", name: "review_private_notes" },
    system: SYSTEM,
    messages: [{
      role: "user",
      content: [
        `EXISTING NOTES:\n${existing || "(none)"}`,
        batch.length > 0 ? `\nNEW NOTES TO PLACE:\n${fresh}` : "\nNEW NOTES TO PLACE: (none) — fold the existing notes that are about one matter (id + merge), with the whole note's text.",
        `\nFACT KEYS ALREADY ON FILE (do not move a note into one of these unless it says the same thing):\n${facts || "(none)"}`,
      ].join("\n"),
    }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  return ((block && block.type === "tool_use" ? block.input : {}) as ModelPlacement) ?? {};
}

const REPAIR_TOOL: Anthropic.Tool = {
  name: "repair_notes",
  description: "Rewrite each consolidated note so it keeps every detail listed.",
  input_schema: {
    type: "object",
    properties: {
      notes: {
        type: "array",
        items: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" } },
          required: ["id", "text"],
        },
      },
    },
    required: ["notes"],
  },
};

/** One repair round: each rejected note with what it dropped or invented → corrected texts. */
async function askRepair(rejects: RejectedGroup[]): Promise<Array<string | undefined>> {
  const body = rejects.map((r, i) => [
    `R${i + 1}. Notes it covers:`,
    ...[...r.existing, ...r.fresh].map((m) => `  - ${m.text}`),
    `  Draft: ${r.text || "(none)"}`,
    `  The draft drops or invents: ${r.missing.join("; ")}`,
  ].join("\n")).join("\n\n");
  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 6000,
    temperature: 0,
    tools: [REPAIR_TOOL],
    tool_choice: { type: "tool", name: "repair_notes" },
    system: "Each draft consolidates several private notes about one matter but lost or invented details. Rewrite each as one short, factual note that keeps EVERY figure and date (as digits) and every person's and place's name from the notes it covers, and adds nothing they don't say.",
    messages: [{ role: "user", content: body }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  const list = ((block && block.type === "tool_use" ? block.input : {}) as { notes?: Array<{ id?: string; text?: string }> }).notes ?? [];
  return rejects.map((_, i) => list.find((x) => x.id === `R${i + 1}`)?.text);
}

const BATCH = 100;

export interface ReviewResult {
  before: number;
  after: number;
  askedModel: boolean;
  pending: number;
}

const running = new Map<string, Promise<ReviewResult>>();
const rerun = new Set<string>();

/**
 * Reviews the deal's private notes: known wordings get their recorded
 * decision, new ones go to the model (outside the facts lock), then the
 * notes are rebuilt under the lock from the notes as they are by then.
 * One run per deal at a time; a request during a run runs once more after it.
 */
export function reviewPrivateNotes(dealId: string): Promise<ReviewResult> {
  const inflight = running.get(dealId);
  if (inflight) {
    rerun.add(dealId);
    return inflight;
  }
  const task = (async () => {
    let result: ReviewResult = { before: 0, after: 0, askedModel: false, pending: 0 };
    do {
      rerun.delete(dealId);
      result = await reviewOnce(dealId);
    } while (rerun.has(dealId));
    return result;
  })().finally(() => running.delete(dealId));
  running.set(dealId, task);
  return task;
}

/** Above this many notes, notes on file about one matter are folded together (once per set of notes). */
const FOLD_ABOVE = 16;

/** The set of notes a fold was last asked about: the same set is never asked about again. */
function foldKey(groups: CurrentGroup[]): string {
  return groups.map((g) => g.id).sort().join(",");
}

/** Places a batch of new wordings (or, with none, folds the notes on file); returns the review with the model's decisions. */
async function placeBatch(
  dealId: string,
  review: NotesReview,
  batch: NoteItem[],
  current: CurrentGroup[],
  facts: string,
  docs: Map<string, ReviewDoc>,
  common: Set<string>,
): Promise<NotesReview> {
  const placement = await askModel(batch, current, facts);
  const placed = recordPlacements(review, placement, batch, current, docs, common);
  let repaired: Array<string | undefined> = [];
  if (placed.rejects.length > 0) {
    repaired = await askRepair(placed.rejects).catch((err) => {
      console.error(`[private-notes] repair failed for deal ${dealId}:`, (err as Error)?.message ?? err);
      return [];
    });
  }
  const repairedOk = placed.rejects.filter((r, k) => {
    const text = repaired[k];
    return !!text && keepsEveryDetail(text, [...r.existing, ...r.fresh].map((m) => m.text), common);
  }).length;
  console.log(`[private-notes] deal ${dealId}: ${batch.length} new wordings, ${current.length} notes → ${(placement.groups ?? []).length} notes proposed, ${(placement.notNotes ?? []).length} not notes; ${placed.rejects.length} lost a detail (${repairedOk} repaired)`);
  return settleRejects(placed.review, placed.rejects, repaired, common);
}

async function reviewOnce(dealId: string): Promise<ReviewResult> {
  const deal = await storage.getDeal(dealId);
  if (!deal) return { before: 0, after: 0, askedModel: false, pending: 0 };
  const docs = new Map((await storage.getDocumentsByDeal(dealId)).map((d) => [d.id, d as ReviewDoc]));
  const info = (deal.extractedInfo as Info | null) || {};
  const stored = readReview((deal as { privateNotesReview?: unknown }).privateNotesReview);
  // A source re-read in new words: its restatements follow the note they fold into.
  let review = adoptFoldedWordings(info, stored, docs);
  let first = applyNotesReview(info, review, docs);
  let askedModel = false;
  let modelFailed = false;
  const facts = () => Object.entries(first.info)
    .filter(([k, v]) => !k.startsWith("_") && v !== null && v !== undefined && v !== "")
    .slice(0, 160)
    .map(([k, v]) => `- ${k}: ${String(typeof v === "object" ? JSON.stringify(v) : v).replace(/\s+/g, " ").slice(0, 100)}`)
    .join("\n");
  const allItems = collectNoteItems(info, docs);
  const common = commonWordsOf(allItems.map((i) => i.text));
  for (let i = 0; i < first.pending.length && !modelFailed; i += BATCH) {
    const batch = first.pending.slice(i, i + BATCH);
    try {
      review = await placeBatch(dealId, review, batch, currentGroups(allItems, review), facts(), docs, common);
      askedModel = true;
    } catch (err) {
      // The model unavailable: these wordings stay exactly as they are on file and are reviewed next time.
      console.error(`[private-notes] review failed for deal ${dealId}:`, (err as Error)?.message ?? err);
      modelFailed = true;
    }
  }
  // Still many notes: fold the ones about one matter — asked once per set of
  // notes (at most twice in a row, while a fold still brings the count down).
  for (let round = 0; round < 2 && !modelFailed; round++) {
    first = applyNotesReview(info, review, docs);
    const groups = currentGroups(allItems, review);
    const count = getPrivateNotes(first.info).length;
    if (first.pending.length > 0 || count <= FOLD_ABOVE || review.foldedFor === foldKey(groups)) break;
    try {
      review = await placeBatch(dealId, review, [], groups, facts(), docs, common);
      review.foldedFor = foldKey(currentGroups(allItems, review));
      askedModel = true;
    } catch (err) {
      console.error(`[private-notes] fold failed for deal ${dealId}:`, (err as Error)?.message ?? err);
      break;
    }
    if (getPrivateNotes(applyNotesReview(info, review, docs).info).length >= count) break;
  }
  const reviewChanged = JSON.stringify(review) !== JSON.stringify(stored);
  if (reviewChanged) review.at = new Date().toISOString();
  return withDealFactsLock(dealId, async () => {
    const latest = await storage.getDeal(dealId);
    if (!latest) return { before: 0, after: 0, askedModel, pending: 0 };
    const now = (latest.extractedInfo as Info | null) || {};
    const before = getPrivateNotes(now).length;
    const applied = applyNotesReview(now, review, docs);
    if (applied.changed || reviewChanged) {
      await storage.updateDeal(dealId, {
        ...(applied.changed ? { extractedInfo: applied.info } : {}),
        ...(reviewChanged ? { privateNotesReview: review } : {}),
      } as any);
    }
    const after = getPrivateNotes(applied.info).length;
    const how = modelFailed ? " (model unavailable — undecided notes left as they were)" : askedModel ? " (reviewed new wordings)" : " (no new wordings)";
    console.log(`[private-notes] deal ${dealId}: ${before} → ${after} notes${how}`);
    return { before, after, askedModel, pending: applied.pending.length };
  });
}

const timers = new Map<string, ReturnType<typeof setTimeout>>();

/** Reviews the deal's notes a few seconds from now (several sources finishing together → one review). */
export function scheduleNotesReview(dealId: string, delayMs = 8000): void {
  const t = timers.get(dealId);
  if (t) clearTimeout(t);
  const timer = setTimeout(() => {
    timers.delete(dealId);
    reviewPrivateNotes(dealId).catch((err) => console.error(`[private-notes] review failed for ${dealId}:`, err));
  }, delayMs);
  timer.unref?.(); // never keeps a script or test process alive
  timers.set(dealId, timer);
}
