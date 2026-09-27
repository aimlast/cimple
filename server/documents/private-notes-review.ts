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
import { noteContent, isHousekeepingNote, sameNoteContent } from "@shared/private-notes";
import { agentConfig } from "../interview/config/load-config";
import {
  BROKER_PRIVATE_NOTES_KEY,
  BROKER_SUPPRESSED_KEY,
  getPrivateNotes,
  privateNoteSources,
  privateNoteText,
  isSourceKind,
  isSuppressed,
  setFieldSource,
  getFieldSources,
  getFieldAlternates,
  isFactKey,
  type BrokerPrivateNote,
  type FieldSource,
  type PrivateNoteSource,
} from "../interview/info-merger";
import { isBrokerProcessKey } from "./merge-policy";
import { withDealFactsLock } from "./facts-lock";
import {
  AGE_PHRASE_RE,
  COVER_FILLER,
  COVER_SYNONYMS,
  GENERIC_TIE_WORDS,
  chatterReason,
  isOpenQuestionNote,
  isSensitiveNote,
  statesBrokerTerms,
  multiplesOf,
  stripNoteCommentary,
  withoutDocLabels,
} from "./private-notes-classify";

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
const FACT_CLASSES: Array<{
  key: RegExp;
  subject: RegExp;
  /** The keys the final pass writes a note of this class under — the first one free. */
  keys: string[];
  /**
   * Every fact key of this kind, whatever its spelling ("insurancePolicies",
   * "lifeInsurance", "officerLifeInsurance", "dividendsDeclaredByYear"): while
   * one is on file, the final pass writes no second fact of the kind — the
   * note is either said by what is on file, or stays a note.
   */
  family: RegExp;
  /**
   * The class's own vocabulary that reads as a stance anywhere else: a
   * shareholders' agreement "waives" and "agrees", an age is "years old".
   * Taken out before the promotable screens, for this class only.
   */
  allow?: RegExp;
}> = [
  { key: /^dividends?(?:Declared|Paid|History|ByYear)?$/, subject: /\bdividends?\b/i, keys: ["dividendsDeclared", "dividendHistory"], family: /dividend/i },
  { key: /^(?:personalGuarantees?|guarantees?)$/, subject: /\bguarant(?:ee|or)\w*\b/i, keys: ["personalGuarantees"], family: /guarant/i },
  { key: /^relatedParty(?:Transactions?|Lease|Leases|Arrangements?)?$/, subject: /\brelated[- ]party\b|\b(?:owned|controlled) by\b[^.;]{0,60}\b(?:shareholder|owner|holdco|holding)|\bfamily member\b[^.;]{0,40}\bemployed\b/i, keys: ["relatedPartyTransactions"], family: /^relatedParty/i },
  {
    key: /^shareholders?(?:Agreement|Agreements|AgreementTerms|AgreementAmendments?)$/,
    subject: /\bshareholders?'? ?agreement\b|\busa\b|\bfirst refusal\b/i,
    keys: ["shareholdersAgreement", "shareholdersAgreementAmendments"],
    family: /^(?:shareholders?Agreement|usa[A-Z]|unanimousShareholder)/i,
    allow: /\b(?:agrees?|agreed|waives?|waived|consents?|consented|forces?|forced|drag[- ]along|tag[- ]along)\b/gi,
  },
  // The share classes and capital. Who the directors are is its own fact
  // (below): "Directors who approved statements: …" is no share structure,
  // and "includes a non-operating director" is about pay, not the board.
  { key: /^(?:shareStructure|shareClasses|shareCapital|capitalStructure)$/, subject: /\b(?:class [a-z] (?:shares?|dividends?|structure|common|preferred)|shares? (?:issued|class)|share (?:structure|capital|classes))\b/i, keys: ["shareStructure", "shareClasses"], family: /^(?:share(?:Structure|Classes|Capital)|capitalStructure|authori[sz]edShares|issuedShares)/i },
  { key: /^(?:directors|boardOfDirectors)$/, subject: /\b(?:[Dd]irectors?|[Bb]oard(?: of [Dd]irectors)?)\b(?:\s+who\s[^:;.]{0,50})?\s*(?::|are|is|include[sd]?)\s+[A-Z]/, keys: ["directors"], family: /^(?:directors?|boardOfDirectors|board)$/i },
  {
    key: /^(?:ownershipStructure|ownership)$/,
    subject: /\bowns?\b[^.;]{0,30}?\d+(?:\.\d+)?\s?%|\b\d+(?:\.\d+)?\s?%\s+(?:of (?:the )?)?(?:voting |common |non-voting |class [a-z] )*(?:shares|equity|ownership|stake|interest)\b/i,
    keys: ["ownershipStructure"],
    family: /^(?:ownership\w*|shareholders|shareholding\w*)$/i,
  },
  { key: /^customer(?:NonRenewal|NonRenewals|Notice|Notices|Loss|Losses|Churn|Terminations?|Departures?)$/, subject: /\b(?:non-?renewal|notice|terminat\w*|cancel\w*|churn\w*|leaving|lost|lose|losing|not renew\w*)\b/i, keys: ["customerNonRenewal"], family: /^customer(?:NonRenewal|Notice|Loss|Churn|Termination|Departure)/i },
  { key: /^(?:insurance|insuranceCoverage|insurancePolicies|lifeInsurance|keyPersonInsurance|buySellInsurance|corporateLifeInsurance)$/, subject: /\binsurance\b|\bpolic(?:y|ies)\b/i, keys: ["insuranceCoverage", "buySellInsurance"], family: /insurance/i },
  { key: /^(?:auditStatus|financialStatementType|financialStatementBasis|reviewEngagement|assuranceLevel)$/, subject: /\b(?:audit\w*|unaudited|review engagement|compil\w*|notice to reader)\b/i, keys: ["auditStatus", "financialStatementType"], family: /^(?:auditStatus|financialStatement(?:Type|Basis|Level)|reviewEngagement|assuranceLevel)$/i },
  { key: /^(?:excludedAssets?|assetsExcluded)$/, subject: /\bexclu(?:ded|des?|sion) from (?:the |any )?sale\b|\bnot (?:included|part of|in) (?:the )?sale\b|\bowner keeps\b/i, keys: ["excludedAssets"], family: /^(?:excludedAssets?|assetsExcluded)$/i },
  { key: /^(?:litigation|legalProceedings|pendingLitigation|lawsuits?)$/, subject: /\b(?:litigation|lawsuit|sued|suing|court|claim filed|statement of claim)\b/i, keys: ["litigation"], family: /litigation|legalProceedings|lawsuit/i },
  { key: /^(?:keyEmployeeContracts?|employmentContracts?|employmentAgreements?)$/, subject: /\bemployment (?:contract|agreement)s?\b/i, keys: ["keyEmployeeContracts"], family: /employ\w*(?:Contract|Agreement)/i },
  { key: /^(?:shareholderLoans?|dueFromShareholders?|dueToShareholders?|dueFromRelatedParties|dueToRelatedParties)$/, subject: /\b(?:shareholder loans?|due (?:to|from) (?:shareholders?|holdco|related)|loans? (?:to|from) (?:the )?(?:shareholder|owner))\b/i, keys: ["shareholderLoans"], family: /^(?:shareholderLoans?|due(?:To|From)(?:Shareholders?|RelatedParties))/i },
  { key: /^(?:marketRentOpinion|marketRent|rentAppraisal)$/, subject: /\bmarket (?:net )?rent\b|\brent(?:al)? (?:opinion|appraisal)\b/i, keys: ["marketRentOpinion"], family: /^(?:marketRent\w*|rentAppraisal)$/i },
  { key: /^associatedCorporations?$/, subject: /\bassociated (?:with|corporations?|compan(?:y|ies))\b/i, keys: ["associatedCorporations"], family: /^associatedCorporations?$/i },
  // The owner's age said on its own ("Seller is 64 years old"). Anything
  // else personal in the note keeps it a note.
  { key: /^(?:ownerAge|sellerAge)$/, subject: AGE_PHRASE_RE, keys: ["ownerAge"], family: /^(?:ownerAge|sellerAge)$/i, allow: new RegExp(AGE_PHRASE_RE.source, "gi") },
];

/** True when `key` is a fact a private note may become and `text` is about it (and promotable at all). */
export function isPromotableFact(key: string, text: string): boolean {
  return FACT_CLASSES.some((c) => c.key.test(key) && c.subject.test(text) && isPromotableNote(c.allow ? text.replace(c.allow, " ") : text));
}

/** The keys the model may move a note into (for its instructions). */
export const PROMOTABLE_FACT_KEYS = "dividendsDeclared, personalGuarantees, relatedPartyTransactions, shareholdersAgreement, shareStructure, ownershipStructure, directors, customerNonRenewal, insuranceCoverage, auditStatus, excludedAssets, litigation, keyEmployeeContracts, shareholderLoans, marketRentOpinion, associatedCorporations, ownerAge";

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

/** A year ("2022", "2025"): only the same year is the same figure (0.5% of 2022 is ten years). */
const isYearFigure = (v: number) => Number.isInteger(v) && v >= 1900 && v <= 2100;
const hasValue = (pool: number[], v: number) =>
  pool.some((p) => (isYearFigure(v) || isYearFigure(p) ? p === v : Math.abs(p - v) <= Math.max(Math.abs(p), Math.abs(v)) * 0.005));

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
  if (cur !== undefined && cur !== null && cur !== "") {
    // A value this very promotion wrote before the check (credited to the
    // same shared source, never since edited) is cleaned too: whatever it
    // says beyond the shared wording goes.
    const prior = getFieldSources(info)[key];
    if (typeof cur === "string" && prior?.note === MOVED_FROM_NOTES && prior.documentId === src.documentId) {
      const clean = promotedValue(key, cur, note);
      if (clean !== cur) {
        info[key] = clean;
        setFieldSource(info, key, { ...prior, excerpt: note.slice(0, 300), at: new Date().toISOString() });
      }
      return true;
    }
    return factCoversNote(cur, note);
  }
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
  /** What the final deterministic pass did. */
  final?: FinalPassReport;
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
  // (a reprocess that no longer re-reads it as a note never loses it). A
  // value it already wrote is re-checked there too (applyPromotion cleans
  // its own earlier write, and leaves any other value alone).
  for (const dec of Object.values(review.items)) {
    if (dec.d !== "fact" || !dec.documentId || !dec.text) continue;
    applyPromotion(next, dec.key, dec.value, dec.text, promotionSource({ sources: [{ documentId: dec.documentId }] }, docs));
  }
  if (out.length > 0) next[BROKER_PRIVATE_NOTES_KEY] = out;
  else delete next[BROKER_PRIVATE_NOTES_KEY];
  // Last, across every pass: chatter out, facts out, twins together.
  const { info: final, report } = finalizeNotes(next, docs);
  const finalNotes = getPrivateNotes(final);
  const changed = JSON.stringify(finalNotes) !== JSON.stringify(notes) ||
    Array.from(new Set([...Object.keys(final), ...Object.keys(info)]))
      .some((k) => k !== BROKER_PRIVATE_NOTES_KEY && JSON.stringify(final[k]) !== JSON.stringify(info[k]));
  return { info: final, changed, pending, final: report };
}

// ─── The final pass (deterministic) ─────────────────────────────────────────

export interface FinalPassReport {
  /** Notes that were no note at all (process chatter, document mechanics…), with why. */
  chatter: Array<{ note: string; why: string }>;
  /** Notes a fact on file already states (key). */
  covered: Array<{ note: string; key: string }>;
  /** Notes moved into the facts (key). */
  promoted: Array<{ note: string; key: string }>;
  /** Notes folded into another note about the same matter. */
  merged: number;
}

/** Every text a note holds: its own, and each source's words. */
function noteTexts(n: BrokerPrivateNote): string[] {
  const out: string[] = [];
  for (const t of [n.note, ...privateNoteSources(n).map((s) => s.wording ?? "")]) {
    const v = (t ?? "").trim();
    if (v && !out.some((o) => privateNoteText(o) === privateNoteText(v))) out.push(v);
  }
  return out;
}

/** A value as text (a by-year map as "2024: $…; 2023: $…"). */
function factText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v && typeof v === "object" && !Array.isArray(v)) return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k}: ${factText(x)}`).join("; ");
  if (Array.isArray(v)) return v.map(factText).join("; ");
  return "";
}

/** A note's words for comparing with a fact: stemmed, with the coverage synonyms, no filler. */
function coverWords(text: string, lower = false): Set<string> {
  const c = noteContent(lower ? text.toLowerCase() : text);
  const out = new Set<string>();
  for (const w of Array.from(c.words)) {
    const syn = COVER_SYNONYMS[w] ?? COVER_SYNONYMS[w.replace(/(?:ed|ing|ation|s)$/, "")] ?? w;
    if (!COVER_FILLER.has(syn)) out.add(syn);
  }
  return out;
}

/** "64 years old" / "aged 64" read as "age 64" (so it meets an ownerAge fact). */
function normaliseAge(text: string): string {
  return text.replace(new RegExp(AGE_PHRASE_RE.source, "gi"), (_m, a, b) => ` age ${a ?? b} `);
}

/** A note's text as compared with the facts: no commentary, no source labels. */
function coverNoteText(raw: string): string {
  return normaliseAge(withoutDocLabels(stripNoteCommentary(raw).text));
}

type FactEntry = { key: string; text: string; lower: string; numbers: number[]; words: Set<string> };

function factEntries(info: Info): FactEntry[] {
  const out: FactEntry[] = [];
  for (const [key, v] of Object.entries(info)) {
    if (!isFactKey(key) || v === null || v === undefined || v === "") continue;
    const text = factText(v);
    if (!text.trim()) continue;
    const keyWords = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/ByYear$/, "").toLowerCase();
    const words = coverWords(`x ${text} ${keyWords}`, true);
    // The key's own words count as the fact's ("Associated with McAllister …"
    // meets associatedCorporations even when its value never says "associated").
    out.push({ key, text, lower: ` ${`${text} ${keyWords}`.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `, numbers: numberValues(text), words });
  }
  return out;
}

/** A figure as written, with the precision its writing gives it ("$1.4M" → ±$50K; "$251,000" → ±$500). */
interface WrittenFigure { value: number; unit: number; year: boolean; money: boolean }

function writtenFigures(raw: string): WrittenFigure[] {
  const text = digitsForWords(raw);
  const out: WrittenFigure[] = [];
  const mult: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
  const re = /(\$\s?)?(\d[\d,]*)(?:\.(\d+))?\s*(k|mm|m|million|thousand|b|billion)?(?![a-z])\s*(%|percent\b)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const whole = m[2].replace(/,/g, "");
    const k = m[4] ? mult[m[4].toLowerCase()] ?? 1 : 1;
    const value = parseFloat(`${whole}${m[3] ? `.${m[3]}` : ""}`) * k;
    if (Number.isNaN(value)) continue;
    const trailing = m[3] ? 0 : Math.min(whole.match(/0*$/)?.[0].length ?? 0, 3);
    const unit = m[3] ? k * Math.pow(10, -m[3].length) : m[4] ? k : Math.pow(10, trailing);
    const money = !!m[1] || !!m[4] || !!m[5];
    out.push({ value, unit, year: !money && !m[3] && isYearFigure(value), money });
  }
  return out;
}

/**
 * True when a pool of figures states the note's figure at the precision the
 * note wrote it: a year only as that year; "$251,000" is not "$250,000";
 * "$1.4M" is "$1,398,000".
 */
function statesFigure(pool: number[], f: WrittenFigure): boolean {
  if (f.year) return pool.some((p) => p === f.value);
  return pool.some((p) => Math.abs(p - f.value) <= f.unit / 2 + 1e-9);
}

/**
 * The fact on file that already says what a note's text says, or null: one
 * fact holds every figure (at the note's own precision; a year exactly) and
 * every name of the note, and at least half of its words. A note too thin
 * to judge (no figure, no name, under three words) is never covered.
 * `opts.moneyOnly`: only money, shares and years must be there (a note's
 * day of the month or share count may be missing) — for a fact of the
 * note's own kind (familyCovers), with a third of the words.
 */
function coveringFact(raw: string, facts: FactEntry[], common: Set<string>, opts: { moneyOnly?: boolean; minShare?: number } = {}): string | null {
  const text = coverNoteText(raw);
  if (!text) return null;
  const figs = writtenFigures(text).filter((f) => !opts.moneyOnly || f.money || f.year);
  const names = Array.from(properNames(text, common));
  const words = Array.from(coverWords(text)).filter((w) => !names.includes(w));
  if (figs.length === 0 && names.length === 0 && words.length < 3) return null;
  // Someone named with a figure, both in the fact ("Luis Ortega … 15%"):
  // a third of the other words is enough.
  const anchored = names.length > 0 && figs.some((f) => !f.year);
  const share = opts.minShare ?? (anchored ? 1 / 3 : 0.5);
  for (const f of facts) {
    if (!figs.every((x) => statesFigure(f.numbers, x))) continue;
    if (!names.every((n) => f.lower.includes(` ${n} `))) continue;
    const hit = words.filter((w) => f.words.has(w)).length;
    if (words.length === 0 || hit / words.length >= share) return f.key;
  }
  return null;
}

/**
 * The fact of the note's own kind on file that says it (every money figure,
 * share, year and name; a third of its words), or null. A note whose kind
 * is already a fact is never written as a second one (promotionKey); this
 * decides whether it goes or stays a note.
 */
function familyCovers(text: string, info: Info, common: Set<string>): string | null {
  const keys = new Set(familyKeysOnFile(info, text));
  if (keys.size === 0) return null;
  const family = factEntries(info).filter((f) => keys.has(f.key));
  const one = coveringFact(text, family, common, { moneyOnly: true, minShare: 1 / 3 });
  if (one || family.length < 2) return one;
  // The facts of its kind together: the minute book's dividend note ("Class
  // D dividend of $60,000 declared December 16, 2024 payable only to Gord
  // McAllister…") is said by dividendsDeclared (amount, date, class) and
  // dividendDetails (to whom) between them.
  // (Reported under the family's fact that shares the most of the note's words.)
  const noteWords = coverWords(coverNoteText(text));
  const lead = [...family].sort((x, y) =>
    Array.from(noteWords).filter((w) => y.words.has(w)).length - Array.from(noteWords).filter((w) => x.words.has(w)).length)[0];
  const joined: FactEntry = {
    key: lead.key,
    text: family.map((f) => f.text).join("; "),
    lower: family.map((f) => f.lower).join(" "),
    numbers: family.flatMap((f) => f.numbers),
    words: new Set(family.flatMap((f) => Array.from(f.words))),
  };
  return coveringFact(text, [joined], common, { moneyOnly: true, minShare: 1 / 3 });
}

/** Capitalised words that are nobody's name. */
const NOT_NAMES = new Set(["seller", "owner", "broker", "buyer", "buyers", "the", "this", "that", "class", "note", "notes", "private", "confidential", "cim", "email", "call", "fy", "ltd", "inc", "llp", "corp"]);

/**
 * People, places and companies a text names: capitalised words (McAllister
 * too) the deal's notes never use in lower case — wherever they stand, the
 * start of a clause included ("Acquisition interest: Jackpine …").
 */
function properNames(text: string, common: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const m of Array.from(text.matchAll(/\b[A-Z][A-Za-z'’-]{2,}\b/g))) {
    const w = m[0].toLowerCase().replace(/['’]s$/, "");
    if (!common.has(w) && !NOT_NAMES.has(w)) out.add(w);
  }
  return out;
}

/**
 * A wording a fact on file may stand in for: nothing sensitive and nothing
 * personal, negotiated, process-related or anyone's stance — the same screen
 * a note passes before it may become a fact (an age said on its own
 * excepted). "Luis confirmed 15% ownership stake" may; "…but wants to sell
 * it" may not, whatever the fact says.
 */
function coverable(text: string): boolean {
  const t = withoutDocLabels(stripNoteCommentary(text).text);
  if (!t || isSensitiveNote(t)) return false;
  // The broker's terms and relationships, and the broker's own open question
  // ("no employment contract — needs verification"): a fact stating the
  // claim says neither.
  if (statesBrokerTerms(text) || isOpenQuestionNote(t)) return false;
  return isPromotableNote(t.replace(new RegExp(AGE_PHRASE_RE.source, "gi"), " "));
}

/** The note's shared (seller-visible) document / email / call sources, with their words. */
function sharedPromotionSources(n: BrokerPrivateNote, docs: Map<string, ReviewDoc>): Array<{ documentId: string; kind: string; text: string }> {
  const out: Array<{ documentId: string; kind: string; text: string }> = [];
  for (const s of privateNoteSources(n)) {
    const src = promotionSource({ sources: [s] }, docs);
    if (src) out.push({ ...src, text: (s.wording ?? n.note).trim() });
  }
  return out;
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== "";

/**
 * The facts on file of the kinds `text` is about (its FACT_CLASSES
 * families): "dividendsDeclared" for a note about a dividend, whatever key
 * the extraction used ("dividendsDeclaredByYear", "dividendsPaidDetail").
 */
function familyKeysOnFile(info: Info, text: string): string[] {
  const classes = FACT_CLASSES.filter((c) => c.subject.test(text));
  return Object.keys(info).filter((k) => isFactKey(k) && filled(info[k]) && classes.some((c) => c.family.test(k)));
}

/**
 * The fact of the note's own kind on file that is about the same matter,
 * whatever else it says, or null: it states the note's money figures
 * ("$60,000" — the FY2024 dividend on dividendsDeclared), or it uses most of
 * the note's words for no other year ("Corporate-owned buy-sell life
 * insurance policies in place (premiums $16,000)" for the note giving the
 * prior year's $15,000). A fact about another year's dividend ("$40,000 …
 * 2022 and 2021") is another matter.
 */
function sameMatterOnFile(text: string, info: Info, common: Set<string>): string | null {
  const keys = new Set(familyKeysOnFile(info, text));
  if (keys.size === 0) return null;
  const body = coverNoteText(text);
  const figs = writtenFigures(body);
  const money = figs.filter((f) => f.money && !f.year);
  const years = figs.filter((f) => f.year).map((f) => f.value);
  const names = properNames(body, common);
  const words = Array.from(coverWords(body)).filter((w) => !names.has(w));
  for (const f of factEntries(info)) {
    if (!keys.has(f.key)) continue;
    if (money.length > 0 && money.every((x) => statesFigure(f.numbers, x))) return f.key;
    const factYears = f.numbers.filter(isYearFigure);
    if (years.length > 0 && factYears.length > 0 && !years.some((y) => factYears.includes(y))) continue;
    if (words.length >= 3 && words.filter((w) => f.words.has(w)).length / words.length >= 0.6) return f.key;
  }
  return null;
}

/**
 * The first free key of the class `text` is about, when the text may be that
 * fact — and none while a fact of that kind about the same matter is on file
 * under any key (sameMatterOnFile): a second fact about one matter
 * (dividendHistory beside dividendsDeclared, insuranceCoverage beside
 * insurancePolicies) reaches the CIM twice. Such a note is either said by
 * the fact on file (familyCovers) or stays a note.
 */
function promotionKey(info: Info, text: string, common: Set<string> = new Set()): string | null {
  const classes = FACT_CLASSES.filter((c) => c.subject.test(text));
  // The broker deleted a fact of this kind: nothing like it is written back under another name.
  const suppressed = Array.isArray(info[BROKER_SUPPRESSED_KEY]) ? (info[BROKER_SUPPRESSED_KEY] as unknown[]).map(String) : [];
  if (classes.some((c) => suppressed.some((k) => c.key.test(k) || c.keys.includes(k)))) return null;
  if (sameMatterOnFile(text, info, common)) return null;
  for (const c of classes) {
    for (const key of c.keys) {
      if (isBrokerProcessKey(key) || isSuppressed(info, key)) continue;
      const cur = info[key];
      if (cur !== undefined && cur !== null && cur !== "") continue;
      if (isPromotableFact(key, text)) return key;
    }
  }
  return null;
}

/** Texts joined into one note that keeps every figure, name and most words of each (restatements add nothing). */
function joinNoteTexts(texts: string[]): string {
  const sorted = Array.from(new Set(texts.map((t) => t.trim()).filter(Boolean))).sort((a, b) => b.length - a.length || a.localeCompare(b));
  const kept: string[] = [];
  for (const t of sorted) {
    if (kept.length > 0) {
      const pool = kept.join(" ");
      const nums = numberValues(t);
      const poolNums = numberValues(pool);
      const c = noteContent(t);
      const pc = noteContent(pool);
      const lower = ` ${pool.toLowerCase().replace(/[^a-z0-9]+/g, " ")} `;
      const names = Array.from(c.names).every((nm) => lower.includes(` ${nm} `));
      const words = Array.from(c.words);
      const covered = words.filter((w) => pc.words.has(w) || lower.includes(` ${w} `)).length;
      if (nums.every((v) => hasValue(poolNums, v)) && names && (words.length === 0 || covered / words.length >= 0.8)) continue;
    }
    kept.push(t.replace(/[.;\s]+$/, ""));
  }
  return kept.join("; ");
}

/** One note from a group of notes about one matter: every source keeps its own words. */
function mergeNoteGroup(group: BrokerPrivateNote[]): BrokerPrivateNote {
  const text = joinNoteTexts(group.map((n) => n.note));
  const seen = new Set<string>();
  const list: PrivateNoteSource[] = [];
  for (const n of group) {
    for (const s of privateNoteSources(n)) {
      const words = (s.wording ?? n.note).trim();
      const id = `${originId(s)}|${privateNoteText(words)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      list.push(privateNoteText(words) === privateNoteText(text) ? bare(s) : { ...bare(s), wording: words });
    }
  }
  list.sort((a, b) => Number(!!a.wording) - Number(!!b.wording));
  return { note: text, ...list[0], ...(list.length > 1 ? { alsoFrom: list.slice(1) } : {}) };
}

/** Figures a note's words tie it to another note by (no years; multiples like "3x" count). */
function tieFigures(texts: string[]): number[] {
  const out: number[] = [];
  for (const t of texts) {
    for (const n of [...numberValues(t), ...multiplesOf(t)]) if (!(Number.isInteger(n) && n >= 1900 && n <= 2100)) out.push(n);
  }
  return out;
}

/**
 * True when two notes are about one matter: two of their texts say the same
 * thing (sameNoteContent), or both name someone or something no other note
 * names and share a figure or a good part of their words ("Grandkids in
 * Kelowna" and "wants to spend time with grandkids in Kelowna"; the Jackpine
 * approach at ~3x in two notes).
 */
function sameMatter(a: string[], b: string[], rare: Set<string>, common: Set<string>): boolean {
  for (const x of a) for (const y of b) if (sameNoteContent(x, y)) return true;
  const namesA = new Set(a.flatMap((t) => Array.from(properNames(t, common))));
  const namesB = new Set(b.flatMap((t) => Array.from(properNames(t, common))));
  // One person's deal matter noted twice in other words ("will consult with
  // wife before deciding on equity rollover" / "would consider rolling some
  // or all of his 15% into new owner"): the same person and the same deal
  // topic, however common the name is on the deal.
  const topicsA = dealTopics(a);
  if (topicsA.size > 0) {
    const topicsB = dealTopics(b);
    const shared = Array.from(topicsA).filter((t) => topicsB.has(t));
    // The company's own matter (the premises leased from the owner's holdco) needs no name in common.
    if (shared.some((t) => COMPANY_TOPICS.has(t))) return true;
    if (shared.length > 0 && Array.from(namesA).some((n) => namesB.has(n))) return true;
  }
  if (!Array.from(namesA).some((n) => namesB.has(n) && rare.has(n))) return false;
  const fa = tieFigures(a);
  const fb = tieFigures(b);
  if (fa.some((v) => hasValue(fb, v))) return true;
  const words = (ts: string[]) => new Set(ts.flatMap((t) => Array.from(noteContent(t).words)).filter((w) => !GENERIC_TIE_WORDS.has(w)));
  const wa = words(a);
  const wb = words(b);
  const [small, large] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  if (small.size === 0) return false;
  const hit = Array.from(small).filter((w) => large.has(w)).length;
  return hit >= 1 && hit / small.size >= 0.3;
}

/** Deal matters a note about one person can be about, each in its usual words. */
const DEAL_TOPICS: Array<[string, RegExp]> = [
  ["rollover", /\broll(?:s|ed|ing)?\s+(?:over\s+)?(?:some|all|part|his|her|their|a|an|\d)|\brollover\b|\bretain(?:s|ed|ing)?\s+(?:an?\s+|some\s+|his\s+|her\s+|their\s+)?(?:equity|shares|stake)\b|\bequity stake with (?:the )?new\b/i],
  ["non-compete", /\bnon-?compet\w*/i],
  ["retention", /\b(?:retention|stay)[- ](?:bonus\w*|agreement|package)\b/i],
  ["earn-out", /\bearn-?outs?\b/i],
  ["seller financing", /\bvendor take-?back\b|\bvtb\b|\bseller (?:financ\w*|note|paper)\b|\bcarry (?:some )?paper\b/i],
  // The premises leased from the owner's holding company.
  ["related-party lease", /\brelated[- ]party lease\b|\blease\b[^.;]{0,30}\b(?:holdco|holding compan(?:y|ies)|shareholder'?s? compan(?:y|ies))\b|\b(?:holdco|holding compan(?:y|ies))\b[^.;]{0,30}\blease\b/i],
];
/** Topics about the company itself, not one person: two notes on one need no name in common. */
const COMPANY_TOPICS: ReadonlySet<string> = new Set(["related-party lease"]);

function dealTopics(texts: string[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) for (const [topic, re] of DEAL_TOPICS) if (re.test(t)) out.add(topic);
  return out;
}

/** At most this many notes fold into one. */
const MAX_FOLD = 3;

/**
 * Pure and idempotent: the deal's notes after one deterministic look across
 * every pass — the step the model's per-wording review can't take, since it
 * never sees the earlier pass's notes again.
 *  1. A note that is no note at all goes: process chatter, a document's
 *     mechanics, logistics, the broker's engagement status, a request for a
 *     document the deal now has (private-notes-classify.ts chatterReason).
 *  2. A note a fact on file already states goes (every figure, every name,
 *     half its words, in one fact).
 *  3. A business fact hiding in a note from a shared document, email or
 *     call (a declared dividend, a shareholders' agreement term, the market
 *     rent opinion, an associated corporation, the owner's age) moves into
 *     the facts under the first free key of its class, credited to that
 *     source — only when every other source's words on the note say no
 *     more than the fact.
 *  4. Notes about one matter fold together, every figure and name kept and
 *     every source's own words on the note.
 * Nothing sensitive (health, family, a privacy instruction, a negotiation
 * position, a worry) is ever dropped by 1 or 2, and every rule applies to
 * EVERY wording a note holds — a note goes only when all of them do.
 */
export function finalizeNotes(info: Info, docs: Map<string, ReviewDoc>): { info: Info; report: FinalPassReport } {
  const report: FinalPassReport = { chatter: [], covered: [], promoted: [], merged: 0 };
  const notes = getPrivateNotes(info);
  if (notes.length === 0) return { info, report };
  const next: Info = { ...info };
  const common = commonWordsOf(notes.flatMap(noteTexts));
  let facts = factEntries(next);
  // Figures on record: the facts and every other value a source gave for them.
  const onRecord: number[] = facts.flatMap((f) => f.numbers);
  for (const list of Object.values(getFieldAlternates(next))) for (const a of list) onRecord.push(...numberValues(String(a?.value ?? "")));
  const ctx = {
    docNames: Array.from(docs.values()).map((d) => d.name),
    figureOnRecord: (n: number) => onRecord.some((p) => Math.abs(p - n) <= Math.max(Math.abs(p), Math.abs(n)) * 0.06),
    figuresOf: (t: string) => numberValues(t).filter((n) => !(Number.isInteger(n) && n >= 1900 && n <= 2100)),
    substantive: (t: string) => SUBSTANCE_RE.test(t),
  };
  const kept: BrokerPrivateNote[] = [];
  for (const n of notes) {
    const texts = noteTexts(n);
    // 1–2: every wording is chatter or already a fact.
    const verdicts = texts.map((t) => {
      const why = chatterReason(t, ctx, isHousekeepingNote);
      if (why) return { chatter: why };
      const key = coverable(t) ? coveringFact(t, facts, common) : null;
      return key ? { key } : null;
    });
    if (verdicts.every((v) => v !== null)) {
      const key = verdicts.find((v) => v && "key" in v) as { key: string } | undefined;
      if (key) report.covered.push({ note: n.note, key: key.key });
      else report.chatter.push({ note: n.note, why: (verdicts[0] as { chatter: string }).chatter });
      continue;
    }
    // 3: a business fact from a shared source.
    let promoted = false;
    for (const src of sharedPromotionSources(n, docs)) {
      const value = withoutDocLabels(stripNoteCommentary(src.text).text);
      if (!value || isSensitiveNote(value)) continue;
      const key = promotionKey(next, value, common);
      if (!key) continue;
      // An age is written as the age ("64 years old"), not as the sentence around it.
      const age = key === "ownerAge" ? value.match(AGE_PHRASE_RE) : null;
      const factValue = age ? `${age[1] ?? age[2]} years old` : value;
      const trial = factEntries({ [key]: factValue });
      const rest = texts.every((t) => privateNoteText(t) === privateNoteText(src.text) || chatterReason(t, ctx, isHousekeepingNote) !== null ||
        (coverable(t) && (coveringFact(t, trial, common) !== null || coveringFact(t, facts, common) !== null)));
      if (!rest) continue;
      if (!applyPromotion(next, key, factValue, value, { documentId: src.documentId, kind: src.kind })) continue;
      report.promoted.push({ note: n.note, key });
      facts = factEntries(next);
      promoted = true;
      break;
    }
    if (promoted) continue;
    // A fact of the note's kind is on file already (promotionKey writes no
    // second one): the note goes when that fact says it, else it stays.
    const famKey = texts.map((t) => (coverable(t) ? familyCovers(t, next, common) : null)).find((k): k is string => !!k);
    if (famKey && texts.every((t) => chatterReason(t, ctx, isHousekeepingNote) !== null || (coverable(t) && familyCovers(t, next, common) !== null))) {
      report.covered.push({ note: n.note, key: famKey });
      continue;
    }
    kept.push(n);
  }
  // 4: notes about one matter fold together.
  const textsOf = kept.map(noteTexts);
  const nameCount = new Map<string, number>();
  for (const ts of textsOf) {
    for (const nm of Array.from(new Set(ts.flatMap((t) => Array.from(properNames(t, common)))))) nameCount.set(nm, (nameCount.get(nm) ?? 0) + 1);
  }
  const rare = new Set(Array.from(nameCount.entries()).filter(([, c]) => c === 2).map(([nm]) => nm));
  const groupOf = kept.map((_, i) => i);
  const find = (i: number): number => (groupOf[i] === i ? i : (groupOf[i] = find(groupOf[i])));
  const size = new Map<number, number>();
  for (let i = 0; i < kept.length; i++) size.set(i, 1);
  for (let i = 0; i < kept.length; i++) {
    for (let j = i + 1; j < kept.length; j++) {
      const a = find(i);
      const b = find(j);
      if (a === b || (size.get(a) ?? 1) + (size.get(b) ?? 1) > MAX_FOLD) continue;
      if (!sameMatter(textsOf[i], textsOf[j], rare, common)) continue;
      groupOf[b] = a;
      size.set(a, (size.get(a) ?? 1) + (size.get(b) ?? 1));
    }
  }
  const out: BrokerPrivateNote[] = [];
  const emitted = new Set<number>();
  for (let i = 0; i < kept.length; i++) {
    const g = find(i);
    if (emitted.has(g)) continue;
    emitted.add(g);
    const members = kept.filter((_, k) => find(k) === g);
    if (members.length === 1) out.push(members[0]);
    else {
      out.push(mergeNoteGroup(members));
      report.merged += members.length - 1;
    }
  }
  if (out.length > 0) next[BROKER_PRIVATE_NOTES_KEY] = out;
  else delete next[BROKER_PRIVATE_NOTES_KEY];
  return { info: next, report };
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
/** A run requested while one was running: which sources' new wordings it is for ("all" = the whole deal). */
const rerun = new Map<string, Set<string> | "all">();

/** What a review run looks at: every new wording on the deal, or only those a few re-read sources gave. */
export interface ReviewScope {
  /**
   * Only these sources were re-read (a single-source "Read it again"): only
   * the new wordings they gave go to the model, and the whole-deal fold is
   * left to the next full review — a one-document re-read used to send the
   * whole deal's notes through three model passes.
   */
  onlyDocumentIds?: string[];
}

/** Pure: the new wordings a run asks the model about. */
export function wordingsInScope(pending: NoteItem[], scope: ReviewScope = {}): NoteItem[] {
  const ids = scope.onlyDocumentIds && scope.onlyDocumentIds.length > 0 ? new Set(scope.onlyDocumentIds) : null;
  return ids ? pending.filter((it) => it.sources.some((s) => !!s.documentId && ids.has(s.documentId))) : pending;
}

/**
 * Reviews the deal's private notes: known wordings get their recorded
 * decision, new ones go to the model (outside the facts lock), then the
 * notes are rebuilt under the lock from the notes as they are by then.
 * One run per deal at a time; a request during a run runs once more after
 * it, for everything that was asked meanwhile.
 */
export function reviewPrivateNotes(dealId: string, scope: ReviewScope = {}): Promise<ReviewResult> {
  const want: Set<string> | "all" = scope.onlyDocumentIds && scope.onlyDocumentIds.length > 0 ? new Set(scope.onlyDocumentIds) : "all";
  const inflight = running.get(dealId);
  if (inflight) {
    const had = rerun.get(dealId);
    rerun.set(dealId, had === "all" || want === "all" ? "all" : new Set([...Array.from(had ?? []), ...Array.from(want)]));
    return inflight;
  }
  const task = (async () => {
    let result: ReviewResult = { before: 0, after: 0, askedModel: false, pending: 0 };
    let next: Set<string> | "all" | undefined = want;
    while (next !== undefined) {
      rerun.delete(dealId);
      result = await reviewOnce(dealId, next === "all" ? {} : { onlyDocumentIds: Array.from(next) });
      next = rerun.get(dealId);
    }
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

async function reviewOnce(dealId: string, scope: ReviewScope = {}): Promise<ReviewResult> {
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
  const asked = wordingsInScope(first.pending, scope);
  for (let i = 0; i < asked.length && !modelFailed; i += BATCH) {
    const batch = asked.slice(i, i + BATCH);
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
  // (Not in a run about a few re-read sources: the fold is the whole deal's, for the next full review.)
  const scoped = !!scope.onlyDocumentIds && scope.onlyDocumentIds.length > 0;
  for (let round = 0; round < 2 && !modelFailed && !scoped; round++) {
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
    const f = applied.final;
    const last = f && (f.chatter.length || f.covered.length || f.promoted.length || f.merged)
      ? `; final pass: ${f.chatter.length} not notes, ${f.covered.length} already facts, ${f.promoted.length} moved to facts (${f.promoted.map((p) => p.key).join(", ")}), ${f.merged} folded`
      : "";
    console.log(`[private-notes] deal ${dealId}: ${before} → ${after} notes${how}${last}`);
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
