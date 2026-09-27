/**
 * private-notes-classify.ts — the wording rules the final notes pass
 * (private-notes-review.ts finalizeNotes) reads a note with. Pure, no I/O,
 * no model.
 *
 * After a reprocess, a deal kept 35 private notes (Ridgeline) when it has
 * about 15 matters: the model's review is asked per new wording and the
 * earlier pass's notes stay as they were, so nothing looks across passes
 * once more at the end. What was left over is of four kinds, and each has
 * a plain, recognisable wording:
 *  - model commentary about the note itself ("— process notes, recorded in
 *    actionItems/followUpNeeded", "— deal process detail, not a business
 *    fact", "— contact/process timeline only");
 *  - document mechanics ("Minute book extract prepared June 2025 for the
 *    corporation's advisers; marked confidential"), logistics ("Heather to
 *    send FY22-24 + T2s once Gord OKs"), the broker's engagement status, a
 *    request for a document the deal now has ("need to ask for WIP report");
 *  - business facts the facts already hold, or that belong there;
 *  - the same matter noted twice by two passes.
 * A note that names anything sensitive — health, family, a privacy
 * instruction, a negotiation position or someone's worry — is never
 * dropped by these rules (it may still be merged with its twin, keeping
 * every detail).
 */

/** Labels a source puts on itself — never a privacy instruction about the business. */
const DOC_LABEL_RE =
  /\b(?:(?:document|extract|file|statement|return|report|copy|it)s?\s+)?(?:is\s+|was\s+)?(?:marked|stamped|labell?ed)\s+(?:as\s+)?["'“]?(?:private\s+(?:and|&)\s+)?confidential["'”]?|\b(?:sin|ssn|ein|bn|business number|social insurance number)s?\s*(?:#|no\.?|number)?\s*(?:is\s+|are\s+|was\s+)?(?:redacted|masked|withheld|removed)\b/gi;

/** A note's text without the labels a source stamps on itself ("marked confidential", "SIN redacted"). */
export function withoutDocLabels(text: string): string {
  return text.replace(DOC_LABEL_RE, " ").replace(/\s*[,;]\s*(?=[,;]|$)/g, "").replace(/\s{2,}/g, " ").trim().replace(/^[,;:\s-]+|[,;:\s-]+$/g, "");
}

/**
 * Sensitive: health, family, privacy instructions, negotiation positions,
 * someone's worry. Such a note is never dropped as chatter or as a fact on
 * file (read after the source's own labels are taken out).
 */
const SENSITIVE_RE = new RegExp(
  [
    // health
    String.raw`\b(?:health|heart|cardiac|stent|cancer|tumou?r|diagnos\w*|illness|ill|sick\w*|surger\w*|stroke|doctor|hospital\w*|therap\w*|pregnan\w*|disab\w*|medical|medication|mental|dementia|alzheimer\w*|parkinson\w*)\b`,
    // family and private life
    String.raw`\b(?:divorc\w*|separat(?:ed|ion)|marri\w*|wife|husband|spouse|sons?|daughters?|grand\w*|kids?|children|famil\w*|mother|father|mom|dad|brother|sister|widow\w*|in-laws?|relocat\w*|retir\w*)\b`,
    // privacy instructions
    String.raw`\b(?:personal(?:ly)?|private(?:ly)?|confidential\w*|secret\w*|off the record|discreet\w*|don'?t (?:want|put|share|tell|mention|include)|do not (?:put|share|tell|mention|include|disclose)|not (?:in|for) (?:the |any )?(?:cim|brochure|marketing|materials?|document|buyers?)|keep (?:it |this |that |him |her )?(?:out|quiet|private|between)|(?:not|nobody|no one)\b[^.;]{0,40}\b(?:knows?|told|aware|informed))\b`,
    String.raw`\bonly [A-Z]\w+[^.;]{0,50}\bknows?\b`,
    // negotiation positions and feelings
    String.raw`\b(?:floor|walk[- ]?away|bottom[- ]?line|would (?:accept|take|go)|price expectations?|lowball|insulting|negotiat\w*|stress\w*|worr\w*|embarrass\w*|afraid|upset|angry|emotional)\b`,
  ].join("|"),
  "i",
);

export function isSensitiveNote(text: string): boolean {
  return SENSITIVE_RE.test(withoutDocLabels(text));
}

/**
 * The broker's own terms and relationships — a fee and its kind, commission,
 * exclusivity, the engagement's length, who referred the seller, a prior
 * approach or offer. CLAUDE.md: broker-process info (referral, fees, prior
 * approaches) belongs in the private notes, so a note stating any of it is
 * never chatter and never "already a fact" — whether or not it names a
 * figure ("success fee, modest work fee, 12-month term"; "Referral from Ravi
 * Kaur (accountant)"). A note that only says such terms exist ("fee
 * arrangement referenced but not detailed") states nothing and may go.
 */
const BROKER_TERMS_RE =
  /\b(?:success fees?|work fees?|flat fees?|monthly fees?|up-?front fees?|minimum fees?|fees? (?:of|is|are|at|will be)|retainers?|commissions?|exclusiv\w*|tail (?:period|clause|provision)|\d+[- ]months? (?:term|engagement|exclusiv\w*|listing|mandate)|referr(?:al|als|ed)|approach(?:ed|es)?|offers?|offered|lowball\w*|insulting)\b/i;
/** Who introduced the seller: "intro'd by Gary", "introduced by Heather Kwan" (a person, not "by email"). */
const INTRODUCED_BY_RE = /\b(?:[Ii]ntroduced|[Ii]ntro'?d)\s+(?:us\s+|him\s+|her\s+|them\s+)?(?:by|through|via)\s+(?!e-?mail|phone|text|call|zoom|teams)[A-Z][a-z]+/;
const TERMS_ABSENT_RE = /\bnot (?:disclosed|detailed|specified|mentioned|provided|referenced|stated|included|discussed)\b/i;

/** True when a note states the broker's own terms or relationships (kept as a note, whatever else it says). */
export function statesBrokerTerms(text: string): boolean {
  const t = stripNoteCommentary(text).text || text;
  return (BROKER_TERMS_RE.test(t) || INTRODUCED_BY_RE.test(t)) && !TERMS_ABSENT_RE.test(t);
}

/**
 * The broker's open question about a claim: "needs verification", "need to
 * check", "unconfirmed", "TBC". A fact that states the claim does not state
 * the doubt — such a note is never "already a fact".
 */
const OPEN_QUESTION_RE =
  /\b(?:needs?\s+(?:to\s+be\s+)?(?:verif\w*|confirm\w*|check\w*|follow[- ]?up)|needs? to (?:check|ask|verify|confirm|see)|to be (?:verified|confirmed|checked)|verify|unverified|unconfirmed|not (?:yet )?(?:verified|confirmed)|tbc|follow[- ]?up (?:on|with|needed)|check (?:with|whether|if))\b/i;

export function isOpenQuestionNote(text: string): boolean {
  return OPEN_QUESTION_RE.test(text);
}

/** A money figure or a share: a note naming one is about terms or figures, never chatter. */
const AMOUNT_RE = /\$\s?\d|\d\s?%|\b\d[\d,.]*\s?(?:k|m|mm|million|thousand|billion)\b|\bpercent\b|\bcommission\b|\bexclusiv\w*/i;

// ─── Model commentary about the note itself ─────────────────────────────────

/**
 * A clause the extraction model appended about the note rather than about
 * the business: "this is a company transaction matter, recorded in business
 * fields", "process notes, recorded in actionItems/followUpNeeded", "deal
 * process detail, not a business fact", "contact/process timeline only".
 */
const COMMENTARY_CLAUSE_RE =
  /^(?:this is (?:a |an )?[a-z /-]{0,40}?\b(?:matter|detail|fact|note|item)s?\b|(?:(?:deal|broker|contact)\/?\s?)?process(?:\/[a-z]+)? (?:notes?|details?|timeline|matter)\b|recorded (?:in|as|under)\b|not a (?:business )?fact\b|(?:contact|process)[a-z/ ]{0,24}\bonly\b|flag (?:this|it) (?:for|to) (?:potential |prospective |any )?buyers?\b)/i;
/** The commentary says the note is process material, not the business. */
const PROCESS_COMMENTARY_RE = /\bprocess (?:notes?|details?|timeline|matter)\b|\bnot a (?:business )?fact\b|\btimeline only\b/i;

function clausesOf(text: string): string[] {
  return text.split(/\s+[—–]\s+|\s+-{1,2}\s+|;\s+/).map((c) => c.trim()).filter(Boolean);
}

/**
 * The note without the model's commentary about it, and whether that
 * commentary declares the note process material. A note that is nothing but
 * commentary comes back empty.
 */
export function stripNoteCommentary(text: string): { text: string; declaredProcess: boolean } {
  const clauses = clausesOf(text.trim());
  const kept: string[] = [];
  let declaredProcess = false;
  for (const c of clauses) {
    const bare = c.replace(/^[,.:\s]+|[.\s]+$/g, "");
    if (COMMENTARY_CLAUSE_RE.test(bare)) {
      if (PROCESS_COMMENTARY_RE.test(bare)) declaredProcess = true;
      continue;
    }
    kept.push(c);
  }
  if (kept.length === clauses.length) return { text: text.trim(), declaredProcess: false };
  return { text: kept.join("; ").replace(/[;\s]+$/, "").trim(), declaredProcess };
}

// ─── Chatter ─────────────────────────────────────────────────────────────────

/** A document itself: who prepared, dated, stamped or sent it. */
const DOC_MECHANICS_RE =
  /^(?:the |this |a |an )?(?:[\w'&.-]+\s){0,4}?(?:minute book(?: extract)?|extract|statements?|tax returns?|returns?|reports?|documents?|files?|e-?mails?|threads?|letters?|spreadsheets?|workbooks?|lists?|schedules?|transcripts?|attachments?)\b[^.;]{0,80}?\b(?:prepared|dated|marked|stamped|sent|received|issued|attached|forwarded|redacted|masked|uploaded|shared)\b/i;

/** Scheduling and document logistics: who sends what, when a call is. */
const LOGISTICS_RE =
  /\b(?:to send|will send|to provide|will provide|to forward|will forward|to (?:be )?signed|once [A-Z]\w+ (?:oks?|okays?|approves?|signs?|confirms?)|(?:call|meeting) (?:booked|scheduled|set)|booked for|scheduled for|next steps?|follow[- ]up (?:call|meeting|e-?mail))\b/i;
const LOGISTICS_OBJECT_RE = /\b(?:statements?|t[245]s?|returns?|reports?|documents?|files?|copies|copy|e-?mails?|call|meeting|paper(?:work)?|letter|agreement|financials|fy\s?\d{2}(?:[-–]\d{2})?)\b/i;

/** The broker's own engagement with the seller (signed, confirmed, under discussion) — status, not terms. */
const ENGAGEMENT_RE = /\b(?:engag(?:ed|ement)(?: letter| paper| terms)?|board resolution\b[^.;]{0,60}\b(?:broker|advis\w*|engag\w*)|listing agreement)\b/i;
const ENGAGEMENT_BROKER_RE = /\b(?:broker(?:age)?|advis(?:or|er)s?|advise|engag\w*)\b/i;

/** A request for a document to verify something: "need to ask for WIP report to verify". */
const DOC_REQUEST_RE =
  /\b(?:need(?:s)? to|to|must|should|will|have to)\s+(?:ask|request|get|obtain|see|check|pull)\b(?:\s+(?:him|her|them|the seller|gord))?(?:\s+for)?\s+(?:the |a |an |his |their )?([A-Za-z0-9&/'-]{2,}(?:\s+[A-Za-z0-9&/'-]{2,}){0,2}?)\s+(?:report|statement|list|schedule|return|aging|ageing|agreement|lease|summary|breakdown)s?\b/i;

export interface ChatterContext {
  /** The deal's source rows' titles. */
  docNames: string[];
  /** True when a figure a note names is on record in the facts (or their other values). */
  figureOnRecord: (n: number) => boolean;
  /** Every figure a text names (the notes' own reading of numbers). */
  figuresOf: (text: string) => number[];
  /** True when a text names something about the company, the deal or its figures (a lease, customers, salaries…). */
  substantive: (text: string) => boolean;
  /**
   * True when one fact holds both figures — as its value and as another
   * source's value (the disagreement is on file, shown with the fact).
   * Absent: no note is dropped as "a discrepancy on file".
   */
  oneFactHolds?: (a: number, b: number) => boolean;
}

/**
 * Why a note's wording is no private note at all — only chatter about the
 * process or a source — or null. Never for anything sensitive, and never
 * for a figure or a share (except a document request whose claim is on
 * record elsewhere). `isHousekeeping` is the shared rule set
 * (withoutHousekeeping in shared/private-notes.ts).
 */
export function chatterReason(raw: string, ctx: ChatterContext, isHousekeeping: (t: string) => boolean): string | null {
  const { text: bare, declaredProcess } = stripNoteCommentary(raw);
  // A document's own confidentiality line ("Minute book extract prepared June
  // 2025 for corporation's advisers; confidential") is its stamp, not a
  // privacy instruction about the business.
  const stripped = DOC_MECHANICS_RE.test(bare) ? bare.replace(TRAILING_STAMP_RE, "").trim() : bare;
  if (!stripped) return "only commentary about the note";
  if (isSensitiveNote(stripped)) return null;
  // Fees, referral, a prior approach: the broker's business, kept (even when
  // the model's own commentary calls it "process").
  if (statesBrokerTerms(raw)) return null;
  const text = withoutDocLabels(stripped);
  if (!text) return "only a document label";
  const amount = AMOUNT_RE.test(text);
  if (!amount && isHousekeeping(text)) return "housekeeping";
  if (!amount && declaredProcess) return "process material (its own words say so)";
  // Mechanics, logistics and engagement status only while the note names
  // nothing of substance ("Employee list sent by Donna shows 3 on WCB claims" stays).
  const plain = !amount && !ctx.substantive(text);
  // (Read with its label too: "Extract marked confidential and prepared for the corporation's advisers only".)
  if (plain && (DOC_MECHANICS_RE.test(text) || DOC_MECHANICS_RE.test(stripped))) return "about a document, not the business";
  if (plain && LOGISTICS_RE.test(text) && LOGISTICS_OBJECT_RE.test(text)) return "scheduling or document logistics";
  if (plain && ENGAGEMENT_RE.test(text) && ENGAGEMENT_BROKER_RE.test(text)) return "the broker's engagement status";
  const req = text.match(DOC_REQUEST_RE);
  if (req) {
    const words = req[1].toLowerCase().split(/\s+/).filter((w) => w.length >= 2 && !/^(?:the|a|an|his|their|updated|latest|current|full)$/.test(w));
    const have = words.length > 0 && ctx.docNames.some((name) => {
      const n = ` ${name.toLowerCase().replace(/[^a-z0-9&]+/g, " ")} `;
      return words.every((w) => n.includes(` ${w.replace(/[^a-z0-9&]+/g, "")} `));
    });
    if (have && ctx.figuresOf(text).every((n) => ctx.figureOnRecord(n))) return "asked for a document the deal now has";
  }
  // The broker's own to-do list ("Broker's to-do list: seller interview in
  // Cimple, run financial analysis, resolve discrepancies…") — only when every
  // item on it is a step of the broker's process. "Next steps — Luis may
  // leave if the buyer is a competitor" is a key-person risk under a to-do
  // heading, and stays.
  if (!amount && isProcessTodoList(text)) return "the broker's to-do list";
  // A placeholder that states nothing yet ("Revenue and EBITDA figures to be confirmed (TBC)").
  if (!amount && PLACEHOLDER_NOTE_RE.test(text)) return "a placeholder — it states nothing yet";
  // A discrepancy both of whose figures one fact holds ("Backlog discrepancy
  // to resolve: $3.1M per WIP report vs $4.2M mentioned by Gord"): the fact
  // shows both values. Only for one figure set against another ("… vs …");
  // "Gord's add-back list differs from the accountant's: truck $14,000,
  // cottage $9,000" names two items, not two values of one fact, and stays.
  if (DISCREPANCY_NOTE_RE.test(text) && ctx.oneFactHolds) {
    const pair = opposedFigures(text, ctx);
    if (pair && ctx.figuresOf(text).every((n) => ctx.figureOnRecord(n)) && ctx.oneFactHolds(pair[0], pair[1])) {
      return "a discrepancy whose figures are both on file";
    }
  }
  return null;
}

/** The figures a note sets against each other: the last before "vs" / "versus" / "compared with" and the first after, or null. */
function opposedFigures(text: string, ctx: ChatterContext): [number, number] | null {
  const m = text.match(/\s(?:vs\.?|versus|compared (?:with|to)|against)\s/i);
  if (!m || m.index === undefined) return null;
  const before = ctx.figuresOf(text.slice(0, m.index));
  const after = ctx.figuresOf(text.slice(m.index + m[0].length));
  if (before.length === 0 || after.length === 0) return null;
  const a = before[before.length - 1];
  const b = after[0];
  return a === b ? null : [a, b];
}

/**
 * A step of the broker's own process — the interview, the financial
 * analysis, resolving discrepancies, the CIM, the NDA, a call, a document
 * request — as a short item with nothing else in it.
 */
const PROCESS_STEP_RE =
  /^(?:(?:and|then|also|next)\s+)*(?:(?:to\s+)?(?:run|do|hold|book|schedule|set up|send|get|request|finish|complete|start|resolve|review|draft|prepare|build|write|generate|publish|sign|collect|gather|upload|arrange)\s+(?:the\s+|an?\s+)?)?(?:seller(?:'s)?\s+)?(?:(?:ai\s+)?interview|financial analysis|analysis|discrepanc\w*|cim|teaser|nda|valuation|engagement(?: letter| paper)?|listing(?: agreement)?|(?:follow[- ]up\s+)?(?:call|meeting)|site visit|document request|docs|documents|paperwork|buyer (?:list|outreach)|t[245]s?|tax returns?|(?:financial |bank )?statements|financials)\b[^,;]{0,24}$/i;

/** "To-do: …", "Next steps — …" whose every item is a step of the broker's process. */
export function isProcessTodoList(text: string): boolean {
  const head = text.match(TODO_LIST_RE);
  if (!head) return false;
  const body = text.slice(head[0].length).replace(/\([^)]*\)/g, " ").replace(/[.\s]+$/, "").trim();
  if (!body) return true;
  const items = body.split(/\s*(?:[,;]|\s[—–-]\s|\bthen\b)\s*/i).map((x) => x.trim()).filter(Boolean);
  return items.length > 0 && items.every((x) => PROCESS_STEP_RE.test(x));
}

/** A trailing confidentiality stamp: "…; confidential", "— strictly confidential." */
const TRAILING_STAMP_RE = /[\s;,.—–-]+(?:marked\s+)?(?:strictly\s+)?(?:private\s+(?:and|&)\s+)?confidential\.?\s*$/i;
/** "Broker's to-do list:", "To-do:", "Next steps —", "Action items:". */
const TODO_LIST_RE = /^(?:(?:the\s+)?broker'?s?\s+|my\s+|our\s+)?(?:to-?do(?:\s+list)?|next\s+steps?|action\s+items?)\s*[:—–-]/i;
/** "<something> figures to be confirmed (TBC)", "Numbers TBD", "Details to follow". */
const PLACEHOLDER_NOTE_RE =
  /^(?:the\s+)?(?:[\w&'’/-]+[\s,]+){0,6}?(?:figures?|numbers?|financials?|details?|amounts?|terms)\s+(?:are\s+|is\s+|still\s+)?(?:to be confirmed|to be determined|tbc|tbd|to follow|to come|pending)\b\s*(?:\((?:tbc|tbd)\))?[\s.]*$/i;
/** A note about two values that disagree. */
const DISCREPANCY_NOTE_RE = /\bdiscrepanc\w*|\bconflict(?:s|ing)?\b|\bdoesn'?t (?:match|tie)\b|\bmismatch\w*|\bdiffer(?:s|ence|ent figures?)?\b|\bvs\.?\s+\$/i;

// ─── Coverage words ──────────────────────────────────────────────────────────

/**
 * Words that say the same thing when a note is compared with a fact: an
 * owner's stake is shares or equity, "unaudited" is about the audit, "64
 * years old" is an age.
 */
export const COVER_SYNONYMS: Record<string, string> = {
  own: "equity", owns: "equity", ownership: "equity", stake: "equity", share: "equity", shareholding: "equity", equity: "equity",
  unaudited: "audit", audited: "audit", audit: "audit", compil: "compilation", compilation: "compilation",
  old: "age", aged: "age", age: "age",
  premium: "insurance", policie: "insurance", policy: "insurance",
};

/** Words that carry nothing when a note is compared with a fact. */
export const COVER_FILLER = new Set([
  "perform", "procedure", "provide", "include", "done", "made", "place", "record", "per", "currently", "current",
  "business", "company", "corporation", "seller", "owner", "total", "amount", "value", "figure",
]);

/** A figure written as a multiple ("~3x earnings", "3.5x"): the notes' number reader skips it. */
export function multiplesOf(text: string): number[] {
  return Array.from(text.matchAll(/(\d+(?:\.\d+)?)\s?x\b/gi)).map((m) => Number(m[1]));
}

/** Content words too common in a deal's notes to tie two notes together. */
export const GENERIC_TIE_WORDS = new Set([
  "sale", "sell", "buyer", "business", "company", "deal", "price", "year", "month", "time", "work", "need", "check",
  "note", "shop", "plan", "want", "know", "say", "use", "can", "get", "make", "keep", "take", "give", "new", "old",
]);

/** The owner's age stated on its own ("Seller is 64 years old", "age 64"). */
export const AGE_PHRASE_RE = /\b(\d{2})\s*(?:years?|yrs?)[- ]old\b|\bage[ds]?\s*(?:of\s*)?(\d{2})\b/i;
