/**
 * sensitive-facts — personal health and family-medical details never reach
 * the CIM writer.
 *
 * The interview and document paths route such details to the broker's
 * private notes, but a fact can still carry one (Pacific, 2026-09-26: the
 * intake form's reason for selling said "following a 2024 heart procedure",
 * and the CIM printed it in three sections). Before generation every text
 * the writer sees is screened: the clause that carries the detail is cut
 * ("retiring after 34 years following a 2024 heart procedure" → "retiring
 * after 34 years"), a fact that can't be cut cleanly is held back entirely,
 * and the broker gets a warning naming the fact so they can decide.
 *
 * Deliberately narrow: business uses of the same words ("extended health &
 * dental benefits", "Health Canada licence", "occupational health and
 * safety", "oral surgery" services) are not personal details and pass.
 *
 * Also here: facts that carry their own confidentiality note ("RFP
 * shortlist, confidential", "don't put this in writing") — see
 * holdConfidentialFacts below.
 */
import { SELLER_KEEP_OUT_REASON_RE, carriesPrivateDetail, getSellerKeepOut, type SellerKeepOutEntry } from "../interview/seller-keep-out";

const PERSON = String.raw`(?:his|her|my|their|the owner'?s|owner'?s|founder'?s|seller'?s|vendor'?s|wife'?s|husband'?s|spouse'?s|partner'?s|son'?s|daughter'?s|father'?s|mother'?s)`;

const CONDITION = String.raw`(?:health|illness|diagnosis|cancer|stroke|cardiac|chemo\w*|dementia|alzheimer'?s?|parkinson'?s?|depression|burn-?out|hospitali[sz]ation)`;

const PATTERNS: RegExp[] = [
  /\bheart\s+(?:attack|procedure|surgery|condition|issues?|problems?|scare|trouble|operation|failure)\b/i,
  /\b(?:stents?|angioplasty|bypass surgery|pacemaker)\b/i,
  /\bterminal(?:ly)?\s+ill|\b(?:ill|poor|failing|declining|deteriorating)\s+health\b/i,
  /\bhealth\s+(?:event|scare|crisis|reasons?|concerns?|issues?|problems?|condition|setback|challenges?)\b/i,
  /\bdiagnosed with\b/i,
  new RegExp(String.raw`\b${PERSON}\s+(?:\w+\s+)?${CONDITION}\b`, "i"),
  new RegExp(
    String.raw`\b(?:had|underwent|undergoing|recovering from|recovery from|following|after|suffered|since)\s+(?:a|an|his|her|my|their)?\s*(?:\d{4}\s+)?(?:minor\s+|major\s+|emergency\s+|mild\s+|serious\s+)?(?:surgery|medical procedure|heart|illness|diagnosis|hospitali[sz]ation|stroke|cancer|chemo\w*|cardiac\s+\w+|dementia|alzheimer'?s?|parkinson'?s?)\b`,
    "i",
  ),
  /\b(?:divorc(?:e|ed|ing)|marital\s+(?:breakdown|issues?|separation|dispute))\b/i,
];

/** Business phrases that contain a pattern word but are not personal. */
const BUSINESS_USES = /\b(?:health (?:and|&) safety|health canada|health authority|health inspection|health (?:and|&) dental|extended health|health benefits?|health plan|health insurance|healthcare|health care|occupational health|public health|health region|health services|oral surgery|surgical (?:suite|centre|center)|day surgery centre)\b/gi;

/** True when the text carries a personal health / family-medical detail. */
export function hasSensitiveDetail(text: string): boolean {
  if (!text) return false;
  const t = text.replace(BUSINESS_USES, " ");
  return PATTERNS.some((re) => re.test(t));
}

const CONNECTOR = /\s*(?:,\s*)?\b(?:following|after|due to|because of|owing to|as a result of|since|given|prompted by|after (?:his|her|my|their)|combined with|and)\b\s*/gi;

/**
 * The text with its sensitive clauses removed, or null when nothing clean
 * is left. Sentences / semicolon clauses carrying the detail are dropped;
 * inside one, the tail from the connector before the detail is cut.
 */
export function stripSensitiveDetail(text: string): string | null {
  if (!hasSensitiveDetail(text)) return text;
  const parts = text.split(/(?<=[.;!?])\s+|\s*;\s*|\n+/);
  const kept: string[] = [];
  for (const part of parts) {
    if (!hasSensitiveDetail(part)) {
      if (part.trim()) kept.push(part.trim());
      continue;
    }
    // Cut at the last connector before the first sensitive match.
    let cut: string | null = null;
    const connectors = Array.from(part.matchAll(CONNECTOR));
    for (let i = connectors.length - 1; i >= 0; i--) {
      const head = part.slice(0, connectors[i].index).trim().replace(/[,:–—-]+$/, "").trim();
      if (head.split(/\s+/).length >= 3 && !hasSensitiveDetail(head)) {
        cut = head;
        break;
      }
    }
    if (cut) kept.push(cut);
  }
  const joined = kept
    .map((s) => s.replace(/[;,\s]+$/, ""))
    .filter(Boolean)
    .join("; ")
    .trim();
  if (!joined || hasSensitiveDetail(joined)) return null;
  return joined;
}

export interface HeldFact {
  key: string;
  /** "trimmed" = the detail was cut and the rest kept; "held" = the whole fact was held back. */
  action: "trimmed" | "held";
}

/** Walk a fact value (string, list or map), stripping sensitive details. */
function screenValue(value: unknown): { value: unknown; changed: boolean; dropped: boolean } {
  if (typeof value === "string") {
    if (!hasSensitiveDetail(value)) return { value, changed: false, dropped: false };
    const s = stripSensitiveDetail(value);
    return s === null ? { value: null, changed: true, dropped: true } : { value: s, changed: true, dropped: false };
  }
  if (Array.isArray(value)) {
    let changed = false;
    const out: unknown[] = [];
    for (const v of value) {
      const r = screenValue(v);
      changed ||= r.changed;
      if (!r.dropped) out.push(r.value);
    }
    return { value: out, changed, dropped: out.length === 0 && value.length > 0 };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = screenValue(v);
      changed ||= r.changed;
      if (!r.dropped) out[k] = r.value;
    }
    return { value: out, changed, dropped: Object.keys(out).length === 0 };
  }
  return { value, changed: false, dropped: false };
}

/**
 * Screen fact pairs for the CIM writer: personal details cut (`held`), and
 * clauses marked confidential held out with the names they concern
 * (`confidential`, `heldNames` — every buyer-facing path: writer and DD).
 * `keepOut` adds what the broker's private notes and the AI review found
 * (keep-out.ts keepOutFor).
 */
export function screenFactsForCim(
  pairs: Array<[string, unknown]>,
  keepOut?: KeepOut,
): {
  safe: Array<[string, unknown]>;
  held: HeldFact[];
  confidential: ConfidentialHold[];
  heldNames: string[];
} {
  const personal = screenPersonal(pairs);
  const conf = holdConfidentialFacts(personal.safe, plainText, keepOut);
  return { safe: conf.safe, held: personal.held, confidential: conf.holds, heldNames: conf.heldNames };
}

function plainText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(plainText).join(" ");
  return String(v);
}

function screenPersonal(pairs: Array<[string, unknown]>): { safe: Array<[string, unknown]>; held: HeldFact[] } {
  const safe: Array<[string, unknown]> = [];
  const held: HeldFact[] = [];
  for (const [key, value] of pairs) {
    const r = screenValue(value);
    if (!r.changed) {
      safe.push([key, value]);
      continue;
    }
    if (r.dropped) {
      held.push({ key, action: "held" });
      continue;
    }
    held.push({ key, action: "trimmed" });
    safe.push([key, r.value]);
  }
  return { safe, held };
}

/** Free text (earlier drafts, notes): sensitive sentences removed. */
export function screenText(text: string): string {
  if (!hasSensitiveDetail(text)) return text;
  return text
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split(/(?<=[.!?])\s+/)
        .map((s) => (hasSensitiveDetail(s) ? stripSensitiveDetail(s) ?? "" : s))
        .filter(Boolean)
        .join(" "),
    )
    .filter(Boolean)
    .join("\n\n");
}

// ── Items that must not reach buyers ──────────────────────────────────────
//
// A fact can carry its own "keep this out" note: "potential new contract
// with Harvest Lane Markets … (RFP shortlist, confidential)" (Pacific
// 2026-09-26 — printed in two sections of the normal CIM, one of which even
// said the opportunity was confidential). And the instruction is often not
// in the fact at all but in the broker's private notes ("Harvest Lane
// Markets RFP marked CONFIDENTIAL — keep out of CIM"). A regex reading the
// extractor's wording missed most phrasings ("shortlist—confidential)",
// "(not to be disclosed to buyers)", "(unannounced; seller requested
// confidentiality)") and never looked at the notes.
//
// So the items to keep out are gathered from three places (KeepOut):
//  1. the facts' own notes, read by rules below (always on — the floor);
//  2. the broker's private notes that tell Cimple to keep a party or an item
//     out of the CIM, read by rules below (always on);
//  3. an AI review of every candidate clause and note (keep-out.ts), which
//     reads intent the way a person would — confidential FROM BUYERS, not the
//     sale kept quiet from staff, not a contract's confidentiality clause —
//     and whose answers are checked against the text before they are used.
// The clause that carries an item is held out of every buyer-facing CIM
// input, and the party it is about is held with it (a sentence elsewhere
// that names the same party is cut too), unless the note is about one
// attribute of a party ("Alderbrook pricing is confidential") — then only
// the clauses giving that attribute go. The broker is told what was held.

/**
 * The note itself, in any of the ways the extractor, the seller or the
 * broker write it. Never the document's own vocabulary ("Confidential
 * Information Memorandum", "confidentiality agreement / clauses",
 * "confidential customer data", "bound by confidentiality").
 */
const CONFIDENTIAL_NOTE = new RegExp(
  [
    // "(RFP shortlist, confidential)", "(shortlist—confidential)", "(confidential)", "(… - CONFIDENTIAL)"
    String.raw`\bconfidential\s*\)`,
    // "(confidential; seller asked …)", "(confidential until awarded)"
    String.raw`\(\s*(?:strictly\s+|highly\s+)?confidential\b`,
    String.raw`\bconfidential\s+until\b`,
    // "— confidential, seller asked …", "; confidential", "confidential —"
    String.raw`(?:^|[—–;]|\s-)\s*(?:strictly\s+|highly\s+)?confidential\s*(?:[,;:.)—–-]|$)`,
    String.raw`\bconfidential(?:ly)?\s*(?:[-—–:]\s|$)`,
    String.raw`\b(?:is|are|remains?|kept|keep (?:it|this|that)|strictly|highly|very|treat(?:ed)? as|marked|currently|still)\s+confidential\b(?!\s+(?:information|memorandum|data|agreements?|treatment|basis|clauses?|documents?))`,
    // "(seller requested confidentiality)", "asked for confidentiality"
    String.raw`\b(?:requested|requests|asked for|asks for|wants?|wanted|under)\s+(?:strict\s+)?confidentiality\b`,
    // "stay out of the CIM", "keep it out of the memorandum"
    String.raw`\b(?:stay|stays|staying|kept|keep|keeping|leave|left)\s+(?:it\s+|this\s+|that\s+|them\s+)?out\s+of\s+(?:the\s+)?(?:cim|memorandum|marketing|teaser|buyer)`,
    // "not to be disclosed to buyers", "not be shared", "never mention"
    String.raw`\b(?:not|never)\s+(?:to\s+)?(?:be\s+)?(?:disclosed|shared|mentioned|published|revealed|announced)\b`,
    String.raw`\b(?:do not|don'?t|not to|never|shouldn'?t|should not)\s+(?:put|write|share|mention|disclose|include|reveal)\s+(?:this|it|that|them)?\s*(?:in writing|with buyers|to buyers|in the cim|in the memorandum|publicly)`,
    String.raw`\bnot\s+(?:for|in)\s+(?:the\s+)?(?:cim|memorandum|buyers?|publication|marketing materials)\b`,
    String.raw`\b(?:off the record|in confidence|under wraps|unannounced|not (?:yet )?public(?:ly announced)?|keep (?:it|this|that) (?:quiet|between us|confidential))\b`,
  ].join("|"),
  "i",
);

/** "…kept confidential from staff", "sign confidentiality agreements", "bound only by confidentiality". */
const NOT_ABOUT_BUYERS = /\b(?:from|with|to)\s+(?:the\s+|other\s+|all\s+|his\s+|her\s+|their\s+)?(?:staff|employees?|team|workers|crew|technicians|drivers)\b|\bstaff (?:are|is) not aware\b|\bbound (?:only )?by confidentiality\b|\bconfidentiality (?:agreements?|clauses?|provisions?|obligations?|undertakings?)\b|\bnon-disclosure\b/i;

/** True when the text carries its own note that it must not reach buyers. */
export function hasConfidentialNote(text: string): boolean {
  return typeof text === "string" && CONFIDENTIAL_NOTE.test(text) && !NOT_ABOUT_BUYERS.test(text);
}

/**
 * A note about one attribute of a party ("Alderbrook pricing is
 * confidential", "the terms are confidential"): the attribute is held, not
 * the party.
 */
const ATTRIBUTE = /\b(pricing|prices?|rates?|terms|margins?|amounts?|discounts?|rebates?|fees?|salar(?:y|ies)|compensation|volumes?|clauses?|termination|details|figures?|numbers)\b/i;
function attributeOf(text: string): string | null {
  const m = new RegExp(String.raw`${ATTRIBUTE.source}[^.;()]{0,30}\b(?:is|are|remain|remains|kept|stay|stays|to be|must stay|must remain)\b[^.;()]{0,12}\b(?:confidential|private|out of)`, "i").exec(text);
  return m ? m[1].toLowerCase() : null;
}

/** Clauses of a fact: sentences and "; " parts. */
function clausesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])|\s*;\s*|\n+/).map((s) => s.trim()).filter(Boolean);
}

const PHRASE_STOP = /^(?:the|a|an|and|or|of|in|on|at|to|for|with|by|from|potential|new|rfp|nda|loi|cim|ceo|cfo|vp|gm|fy|q[1-4]|inc|ltd|llc|corp|co|confidential|keep|kept|marked|seller|owner|broker|buyer|buyers|note)$/i;

/** Names in a held clause: runs of Capitalised words ("Harvest Lane Markets"), not a lone sentence-opening word. */
export function namesIn(clause: string): string[] {
  const out: string[] = [];
  const re = /\b[A-Z][a-zA-Z'&.-]+(?:\s+(?:of\s+|and\s+|&\s+)?[A-Z][a-zA-Z'&.-]+)*/g;
  for (const m of Array.from(clause.matchAll(re))) {
    const words = m[0].split(/\s+/).filter((w) => !PHRASE_STOP.test(w.replace(/[.'-]+$/, "")));
    if (words.length === 0) continue;
    if (words.length === 1 && (m.index === 0 || words[0].length < 4)) continue;
    if (/^[A-Z0-9&.-]+$/.test(words.join(""))) continue; // acronyms, CONFIDENTIAL
    out.push(words.join(" "));
  }
  return out;
}

export interface ConfidentialHold {
  key: string;
  /** The clause(s) held back, for the broker's warning. */
  clauses: string[];
}

/**
 * What must stay out of buyer-facing text, beyond the facts' own notes:
 * clauses an AI review found (by fact key), parties to hold everywhere, and
 * (party, attribute) pairs where only that attribute is confidential.
 */
export interface KeepOut {
  clauses: Array<{ key: string; text: string }>;
  names: string[];
  pairs: Array<{ name: string; attribute: string }>;
}

const lower = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** Does a part of a fact carry an item the review said to keep out? */
function reviewHolds(key: string, part: string, keepOut: KeepOut | undefined): boolean {
  if (!keepOut) return false;
  const p = lower(part);
  if (p.length < 4) return false;
  for (const c of keepOut.clauses) {
    if (c.key !== key) continue;
    const t = lower(c.text);
    if (t.length >= 4 && (p.includes(t) || t.includes(p))) return true;
  }
  return keepOut.pairs.some((x) => mentionsHeldName(part, [x.name]) && new RegExp(String.raw`\b${escapeRe(x.attribute).replace(/s$/, "")}`, "i").test(part));
}

/**
 * Hold confidential clauses out of the fact pairs. Returns the pairs with
 * those clauses removed (a fact with nothing left is dropped), what was
 * held, and the held names — the party each held clause is about (not the
 * business's own region, named in many facts), plus the parties the broker's
 * notes and the review name.
 */
export function holdConfidentialFacts(
  pairs: Array<[string, unknown]>,
  valueText: (v: unknown) => string,
  keepOut?: KeepOut,
): {
  safe: Array<[string, unknown]>;
  holds: ConfidentialHold[];
  heldNames: string[];
} {
  const holds: ConfidentialHold[] = [];
  const first: Array<[string, unknown]> = [];
  const attributeHolds: string[] = [];
  for (const [key, value] of pairs) {
    const r = holdInValue(value, [], (part) => hasConfidentialNote(part) || reviewHolds(key, part, keepOut));
    if (r.clauses.length === 0) {
      first.push([key, value]);
      continue;
    }
    holds.push({ key, clauses: r.clauses });
    for (const c of r.clauses) if (attributeOf(c)) attributeHolds.push(c);
    if (!r.dropped) first.push([key, r.value]);
  }

  // The party a note is about is the clause's first name ("Harvest Lane
  // Markets"); other names in it are held only when no other fact uses them
  // (the region it sits in is not confidential). A note about one attribute
  // ("Alderbrook pricing is confidential") holds no party.
  const allText = first.map(([, v]) => valueText(v).toLowerCase());
  const usedElsewhere = (name: string) => allText.filter((t) => t.includes(name.toLowerCase())).length;
  const fromClauses = holds.flatMap((h) =>
    h.clauses
      .filter((c) => !attributeHolds.includes(c))
      .flatMap((c) => namesIn(c).filter((name, i) => (i === 0 ? usedElsewhere(name) < 3 : usedElsewhere(name) === 0))),
  );
  const heldNames = Array.from(new Set([...fromClauses, ...(keepOut?.names ?? [])]));
  if (heldNames.length === 0) return { safe: first, holds, heldNames };

  // A clause elsewhere that names a held party goes too ("… potential new
  // customer wins such as the Harvest Lane Markets opportunity").
  const safe: Array<[string, unknown]> = [];
  for (const [key, value] of first) {
    const r = holdInValue(value, heldNames, () => false);
    if (r.clauses.length === 0) {
      safe.push([key, value]);
      continue;
    }
    const existing = holds.find((h) => h.key === key);
    if (existing) existing.clauses.push(...r.clauses);
    else holds.push({ key, clauses: r.clauses });
    if (!r.dropped) safe.push([key, r.value]);
  }
  return { safe, holds, heldNames };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The held name a text mentions (whole words, any case), if any. */
export function mentionsHeldName(text: string, heldNames: readonly string[]): string | null {
  if (!text || heldNames.length === 0) return null;
  for (const name of heldNames) {
    const re = new RegExp(String.raw`(?<![\p{L}\p{N}])${escapeRe(name).replace(/\s+/g, "\\s+")}(?![\p{L}\p{N}])`, "iu");
    if (re.test(text)) return name;
  }
  return null;
}

function holdInValue(value: unknown, heldNames: readonly string[], note: (part: string) => boolean): { value: unknown; clauses: string[]; dropped: boolean } {
  const isHeld = (s: string) => note(s) || !!mentionsHeldName(s, heldNames);
  if (typeof value === "string") {
    const parts = clausesOf(value);
    if (!parts.some(isHeld)) return { value, clauses: [], dropped: false };
    const kept = parts.filter((p) => !isHeld(p));
    const held = parts.filter((p) => isHeld(p));
    return kept.length === 0 ? { value: null, clauses: held, dropped: true } : { value: kept.join("; "), clauses: held, dropped: false };
  }
  if (Array.isArray(value)) {
    const clauses: string[] = [];
    const out: unknown[] = [];
    for (const v of value) {
      const r = holdInValue(v, heldNames, note);
      clauses.push(...r.clauses);
      if (!r.dropped) out.push(r.value);
    }
    return { value: out, clauses, dropped: out.length === 0 && value.length > 0 };
  }
  if (value && typeof value === "object") {
    const clauses: string[] = [];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = holdInValue(v, heldNames, note);
      clauses.push(...r.clauses);
      if (!r.dropped) out[k] = r.value;
    }
    return { value: out, clauses, dropped: Object.keys(out).length === 0 };
  }
  return { value, clauses: [], dropped: false };
}

/** Free text (earlier drafts, the scrape): sentences with a confidentiality note or a held name removed. */
export function screenConfidentialText(text: string, heldNames: readonly string[]): string {
  if (!text) return text;
  if (!hasConfidentialNote(text) && !mentionsHeldName(text, heldNames)) return text;
  return text
    .split(/\n{2,}/)
    .map((para) =>
      para
        .split(/(?<=[.!?])\s+/)
        .filter((s) => !hasConfidentialNote(s) && !mentionsHeldName(s, heldNames))
        .join(" "),
    )
    .filter((p) => p.trim())
    .join("\n\n");
}

// ── The broker's private notes ────────────────────────────────────────────

/** A note telling Cimple to keep something out of buyer materials. */
const NOTE_KEEP_OUT = new RegExp(
  [
    String.raw`\b(?:keep|kept|keeping|leave|left|stay|stays|staying)\s+(?:it\s+|this\s+|that\s+|them\s+)?out\s+of\s+(?:the\s+)?(?:cim|memorandum|marketing|teaser|buyer)`,
    String.raw`\bnot\s+(?:to\s+be\s+|be\s+)?(?:in|for|included in|put in|mentioned in|shown in|shared with|disclosed to|disclosed in)\s+(?:the\s+|any\s+)?(?:cim|buyers?|memorandum|teaser|marketing)`,
    String.raw`\b(?:don'?t|do not|never|must not)\s+(?:share|disclose|mention|include|put|reveal|show)\b[^.;]{0,40}\b(?:buyers?|cim|memorandum|teaser|in writing)\b`,
    String.raw`\bconfidential\b[^.;]{0,40}\b(?:rfp|bid|tender|negotiation|offer|loi|acquisition|shortlist|opportunity|deal|contract|pursuit)\b`,
    String.raw`\b(?:rfp|bid|tender|negotiation|offer|loi|acquisition|shortlist|opportunity|deal|contract|pursuit)\b[^.;]{0,60}\b(?:marked\s+)?confidential\b`,
  ].join("|"),
  "i",
);

/**
 * The private notes' text: `_brokerPrivateNotes` entries ({ note }) or
 * strings, plus each source's own wording when it differs from the note's.
 * The notes review (documents/private-notes-review.ts) folds restatements of
 * one matter into one note and keeps every source's words in `wording` — a
 * source's "keep it out of the CIM" must still hold when the merged note's
 * text doesn't repeat it.
 */
export function privateNoteTexts(info: Record<string, unknown> | null | undefined): string[] {
  const raw = info?._brokerPrivateNotes;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: unknown) => {
    if (typeof t !== "string" || !t.trim()) return;
    const k = t.trim().toLowerCase().replace(/\s+/g, " ");
    if (seen.has(k)) return;
    seen.add(k);
    out.push(t);
  };
  for (const n of raw) {
    if (typeof n === "string") {
      add(n);
      continue;
    }
    if (!n || typeof n !== "object") continue;
    const e = n as { note?: unknown; wording?: unknown; alsoFrom?: unknown };
    // A note the seller's privacy request wrote carries the request itself
    // (PRIV-V-2: its reason was dropped here, and the detail alone — "Shortlisted
    // for the Kestrel Systems RFP" — reads as no instruction to anyone).
    // Personal matters are left to the health screen (their names are family).
    const instruct = (t: unknown) =>
      isSellerKeepOutNote(n) && typeof t === "string" && !hasSensitiveDetail(t) ? `${t.trim().replace(/[.\s]+$/, "")} — the seller asked to keep this out of the CIM` : t;
    add(instruct(e.note));
    add(instruct(e.wording));
    if (Array.isArray(e.alsoFrom)) for (const s of e.alsoFrom) if (s && typeof s === "object") add(instruct((s as { wording?: unknown }).wording));
  }
  return out;
}

/** A private note written for the seller's request to keep something out of the sale document. */
function isSellerKeepOutNote(n: unknown): boolean {
  if (!n || typeof n !== "object") return false;
  const e = n as { reason?: unknown; alsoFrom?: unknown };
  const says = (r: unknown) => typeof r === "string" && SELLER_KEEP_OUT_REASON_RE.test(r);
  return says(e.reason) || (Array.isArray(e.alsoFrom) && e.alsoFrom.some((s) => !!s && typeof s === "object" && says((s as { reason?: unknown }).reason)));
}

/**
 * The seller's keep-out requests as explicit holds (PRIV-V-2): every fact
 * clause that carries a requested detail — whichever source states it — is
 * held out of every CIM input, and the party a business item is about (its
 * first name: "Kestrel Systems") is held everywhere with it.
 */
function sellerKeepOutHolds(info: Record<string, unknown>, facts: string): KeepOut {
  const out: KeepOut = { clauses: [], names: [], pairs: [] };
  const requests: SellerKeepOutEntry[] = [...getSellerKeepOut(info)];
  const notes = Array.isArray(info._brokerPrivateNotes) ? (info._brokerPrivateNotes as unknown[]) : [];
  for (const n of notes) {
    if (!isSellerKeepOutNote(n)) continue;
    const text = (n as { note?: unknown }).note;
    if (typeof text === "string" && text.trim() && !requests.some((r) => r.detail.trim().toLowerCase() === text.trim().toLowerCase())) requests.push({ detail: text, terms: [] });
  }
  for (const req of requests) {
    if (!hasSensitiveDetail(req.detail)) {
      for (const name of namesIn(req.detail).slice(0, 1)) {
        if (mentionsHeldName(facts, [name]) && holdableParty(info, name)) out.names.push(name);
      }
    }
    for (const [key, value] of Object.entries(info)) {
      if (key.startsWith("_")) continue;
      for (const c of clausesOf(plainTextDeep(value))) if (carriesPrivateDetail(c, req)) out.clauses.push({ key, text: c });
    }
  }
  return out;
}

/** Every string in a value, one per line (lists and maps too). */
function plainTextDeep(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(plainTextDeep).join("\n");
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(plainTextDeep).join("\n");
  return String(v);
}

/**
 * The floor of the keep-out review, by rules: parties that the broker's
 * private notes say to keep out of the CIM and that the facts mention
 * ("Harvest Lane Markets RFP … marked CONFIDENTIAL — keep out of CIM"). A
 * note about keeping the sale quiet from staff is not about buyers; a note
 * about one attribute ("Alderbrook pricing — keep out of CIM") holds that
 * attribute, not the party.
 */
export function keepOutFromNotes(info: Record<string, unknown> | null | undefined): KeepOut {
  const out: KeepOut = { clauses: [], names: [], pairs: [] };
  const facts = Object.entries(info ?? {})
    .filter(([k]) => !k.startsWith("_"))
    .map(([, v]) => plainText(v))
    .join("\n");
  for (const note of privateNoteTexts(info)) {
    if (!NOTE_KEEP_OUT.test(note) || NOT_ABOUT_BUYERS.test(note)) continue;
    const attribute = attributeOf(note) ?? (new RegExp(String.raw`^[^.;]{0,60}?${ATTRIBUTE.source}`, "i").exec(note)?.[1]?.toLowerCase() ?? null);
    // The party a note is about is its first name ("Harvest Lane Markets RFP:
    // shortlisted for 26-store Fraser Valley grocery chain …" is about Harvest
    // Lane, not the Fraser Valley).
    for (const name of namesIn(note).slice(0, 1)) {
      if (!mentionsHeldName(facts, [name]) || !holdableParty(info, name)) continue;
      if (attribute) out.pairs.push({ name, attribute });
      else out.names.push(name);
    }
  }
  const seller = sellerKeepOutHolds(info ?? {}, facts);
  out.clauses.push(...seller.clauses);
  out.names = Array.from(new Set([...out.names, ...seller.names]));
  return out;
}

/**
 * May a party be held everywhere? Not one the file is built around: a party
 * named across many facts (the top customer, the owner, the business itself)
 * is no unannounced side item, and holding it would gut the CIM — such a
 * note holds its own clause only.
 */
export function holdableParty(info: Record<string, unknown> | null | undefined, name: string): boolean {
  let keys = 0;
  let free = 0;
  for (const [k, v] of Object.entries(info ?? {})) {
    if (k.startsWith("_")) continue;
    const t = plainText(v);
    if (!mentionsHeldName(t, [name])) continue;
    keys++;
    // Named in a plain statement ("primarily Fraser Valley and Greater
    // Vancouver"), not in the pending item itself: part of the business's
    // own story (a region, a customer), which a note about an RFP there doesn't make secret.
    if (clausesOf(t).some((c) => mentionsHeldName(c, [name]) && !PENDING_ITEM.test(c))) free++;
    if (keys > 4 || free >= 2) return false;
  }
  return true;
}

/** Wording of a pending or confidential item (an RFP, a bid, a potential contract). */
const PENDING_ITEM = /confiden|\brfp\b|\bbid\b|tender|shortlist|negotiat|\bloi\b|letter of intent|pursuit|prospect|pipeline|opportunit|potential|pending|proposal/i;

/** Two keep-out results together. */
export function mergeKeepOut(...parts: Array<KeepOut | null | undefined>): KeepOut {
  const out: KeepOut = { clauses: [], names: [], pairs: [] };
  for (const p of parts) {
    if (!p) continue;
    out.clauses.push(...p.clauses);
    out.names.push(...p.names);
    out.pairs.push(...p.pairs);
  }
  out.names = Array.from(new Set(out.names));
  return out;
}
