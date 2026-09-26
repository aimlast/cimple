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
 */
export function screenFactsForCim(pairs: Array<[string, unknown]>): {
  safe: Array<[string, unknown]>;
  held: HeldFact[];
  confidential: ConfidentialHold[];
  heldNames: string[];
} {
  const personal = screenPersonal(pairs);
  const conf = holdConfidentialFacts(personal.safe, plainText);
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

// ── Facts the seller or broker marked confidential ────────────────────────
//
// A fact can carry its own "keep this out" note: "potential new contract
// with Harvest Lane Markets … (RFP shortlist, confidential)" (Pacific
// 2026-09-26 — printed in two sections of the normal CIM, one of which even
// said the opportunity was confidential). The clause that carries the note is
// held out of every buyer-facing CIM input, the names it mentions are held
// with it (so a sentence elsewhere that names the same party is cut too), and
// the broker is told what was held.

/**
 * The note itself: "(…, confidential)", "is confidential", "confidential —",
 * "don't put this in writing", "off the record", "not for the CIM / buyers".
 * Never the document's own vocabulary ("Confidential Information
 * Memorandum", "confidentiality agreement", "confidential customer data").
 */
const CONFIDENTIAL_NOTE = new RegExp(
  [
    String.raw`\(\s*(?:[^()]*[,;:]\s*)?(?:strictly\s+|highly\s+|very\s+)?confidential\s*\)`,
    String.raw`\b(?:is|are|remains?|kept|keep (?:it|this|that)|strictly|highly|very|treat(?:ed)? as|marked|currently|still)\s+confidential\b(?!\s+(?:information|memorandum|data|agreement|treatment|basis))`,
    String.raw`\bconfidential(?:ly)?\s*(?:[-—–:]\s|$)`,
    String.raw`\b(?:do not|don'?t|not to|never|shouldn'?t|should not)\s+(?:put|write|share|mention|disclose|include)\s+(?:this|it|that|them)?\s*(?:in writing|with buyers|to buyers|in the cim|in the memorandum|publicly)`,
    String.raw`\bnot\s+(?:for|in)\s+(?:the\s+)?(?:cim|memorandum|buyers?|publication|marketing materials)\b`,
    String.raw`\b(?:off the record|in confidence|keep (?:it|this|that) (?:quiet|between us|confidential))\b`,
  ].join("|"),
  "i",
);

/** True when the text carries its own confidentiality note. */
export function hasConfidentialNote(text: string): boolean {
  return typeof text === "string" && CONFIDENTIAL_NOTE.test(text);
}

/** Clauses of a fact: sentences and "; " parts. */
function clausesOf(text: string): string[] {
  return text.split(/(?<=[.!?])\s+(?=[A-Z0-9])|\s*;\s*|\n+/).map((s) => s.trim()).filter(Boolean);
}

const PHRASE_STOP = /^(?:the|a|an|and|or|of|in|on|at|to|for|with|by|from|potential|new|rfp|nda|loi|cim|ceo|cfo|vp|gm|fy|q[1-4]|inc|ltd|llc|corp|co)$/i;

/** Names in a held clause: runs of Capitalised words ("Harvest Lane Markets"), not a lone sentence-opening word. */
export function namesIn(clause: string): string[] {
  const out: string[] = [];
  const re = /\b[A-Z][a-zA-Z'&.-]+(?:\s+(?:of\s+|and\s+|&\s+)?[A-Z][a-zA-Z'&.-]+)*/g;
  for (const m of Array.from(clause.matchAll(re))) {
    const words = m[0].split(/\s+/).filter((w) => !PHRASE_STOP.test(w.replace(/[.'-]+$/, "")));
    if (words.length === 0) continue;
    if (words.length === 1 && (m.index === 0 || words[0].length < 4)) continue;
    if (/^[A-Z0-9&.-]+$/.test(words.join(""))) continue; // acronyms
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
 * Hold confidential clauses out of the fact pairs. Returns the pairs with
 * those clauses removed (a fact with nothing left is dropped), what was
 * held, and the held names — distinctive names from the held clauses that the
 * rest of the facts don't use freely (the business's own region, named in
 * many facts, isn't treated as confidential).
 */
export function holdConfidentialFacts(pairs: Array<[string, unknown]>, valueText: (v: unknown) => string): {
  safe: Array<[string, unknown]>;
  holds: ConfidentialHold[];
  heldNames: string[];
} {
  const holds: ConfidentialHold[] = [];
  const first: Array<[string, unknown]> = [];
  for (const [key, value] of pairs) {
    const r = holdInValue(value);
    if (r.clauses.length === 0) {
      first.push([key, value]);
      continue;
    }
    holds.push({ key, clauses: r.clauses });
    if (!r.dropped) first.push([key, r.value]);
  }
  if (holds.length === 0) return { safe: pairs, holds, heldNames: [] };

  // The party a note is about is the clause's first name ("Harvest Lane
  // Markets"); other names in it are held only when no other fact uses them
  // (the region it sits in is not confidential).
  const allText = first.map(([, v]) => valueText(v).toLowerCase());
  const usedElsewhere = (name: string) => allText.filter((t) => t.includes(name.toLowerCase())).length;
  const heldNames = Array.from(
    new Set(
      holds.flatMap((h) =>
        h.clauses.flatMap((c) => namesIn(c).filter((name, i) => (i === 0 ? usedElsewhere(name) < 3 : usedElsewhere(name) === 0))),
      ),
    ),
  );
  if (heldNames.length === 0) return { safe: first, holds, heldNames };

  // A clause elsewhere that names a held party goes too ("… potential new
  // customer wins such as the Harvest Lane Markets opportunity").
  const safe: Array<[string, unknown]> = [];
  for (const [key, value] of first) {
    const r = holdInValue(value, heldNames);
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

function holdInValue(value: unknown, heldNames: readonly string[] = []): { value: unknown; clauses: string[]; dropped: boolean } {
  const isHeld = (s: string) => hasConfidentialNote(s) || !!mentionsHeldName(s, heldNames);
  if (typeof value === "string") {
    if (!isHeld(value)) return { value, clauses: [], dropped: false };
    const parts = clausesOf(value);
    const kept = parts.filter((p) => !isHeld(p));
    const held = parts.filter((p) => isHeld(p));
    return kept.length === 0 ? { value: null, clauses: held, dropped: true } : { value: kept.join("; "), clauses: held, dropped: false };
  }
  if (Array.isArray(value)) {
    const clauses: string[] = [];
    const out: unknown[] = [];
    for (const v of value) {
      const r = holdInValue(v, heldNames);
      clauses.push(...r.clauses);
      if (!r.dropped) out.push(r.value);
    }
    return { value: out, clauses, dropped: out.length === 0 && value.length > 0 };
  }
  if (value && typeof value === "object") {
    const clauses: string[] = [];
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = holdInValue(v, heldNames);
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
