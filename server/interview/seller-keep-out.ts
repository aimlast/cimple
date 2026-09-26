/**
 * seller-keep-out — what the seller asked to keep out of the sale document,
 * scoped to the disclosure itself and kept for good.
 *
 * A privacy request ("keep that out of the book") names a detail: the wife's
 * diagnosis, an unannounced RFP, a customer about to leave. Two things went
 * wrong with it (review round V):
 * - RV-INT-3: the classifier's "sensitive terms" were used as a ban on
 *   single words, prefix-matched — "health" cut "extended health insurance"
 *   out of a physio clinic's payer mix (leaving 30% + 15%), and every later
 *   answer mentioning "Healthcare staffing" was silently dropped. Terms are
 *   now accepted only when the seller actually said them, they are part of
 *   the detail, and they are specific (never an everyday business word).
 *   Round 2: even a specific term is not the detail on its own — the owner's
 *   wife's "MS" is not the clinic's "stroke, MS and Parkinson's programs".
 *   A text carries the detail only where the term comes WITH the detail's
 *   own context ("wife … MS", "heart attack in March", "Kestrel Systems"),
 *   or where it says most of the detail in other words.
 * - PRIV-V-2: the request lasted only for that interview session and for the
 *   one fact the classifier hinted at. It is now recorded on the deal
 *   (`_sellerKeepOut`): every fact in the seller's own words that carries the
 *   detail is cut, a reprocess re-applies the cut, and the CIM keep-out
 *   (server/cim/sensitive-facts.ts keepOutFromNotes) treats it as an explicit
 *   hold whatever source states the detail. Nothing is lost silently: what a
 *   cut takes out of a fact on file goes to the deleted-facts history
 *   (restorable by the broker).
 *
 * Pure helpers; nothing here logs a detail (PRIV-V-3).
 */
import { termRegex } from "./fact-guards";
import { getFieldSources, isLiveSellerKind } from "./info-merger";

/** Deal-level record of the seller's keep-out requests. */
export const SELLER_KEEP_OUT_KEY = "_sellerKeepOut";
/** The reason on the broker-private note a privacy request writes. */
export const SELLER_KEEP_OUT_REASON = "the seller asked that this stay out of the sale document";
/** How a note written for a privacy request is recognised (older rows too). */
export const SELLER_KEEP_OUT_REASON_RE = /stay out of the sale document|seller asked (?:that )?(?:this|it) (?:be )?kept (?:private|out)/i;
/**
 * The reason on a note that keeps a whole answer the privacy guard held back
 * ("pipeline: Three open bids: Kestrel …, city of Red Deer …"). It is the
 * broker's record of what the seller said, NOT a keep-out request of its own:
 * read as one, its public half would hold the document's own statements of
 * the same things out of the CIM (and its first capitalised word — "Three" —
 * would be held as a party).
 */
export const HELD_BACK_NOTE_REASON = "held back from the facts because it carries a detail the seller asked to keep private — the rest of it may still be used";

export interface SellerKeepOutEntry {
  /** The private detail, as the broker's note words it. */
  detail: string;
  /** Specific words / phrases that carry it (distinctivePrivateTerms). */
  terms: string[];
  turn?: number;
  sessionId?: string;
  at?: string;
}

// Words that are everyday business vocabulary somewhere — a health clinic's
// "patient" and "diagnosis", a contractor's "bid" and "contract", anyone's
// "customer", "bank", "location" or "closing". Never a term of their own:
// banning one would drop ordinary answers (RV-INT-3).
const GENERIC_TERMS = new Set(
  (
    "health healthy healthcare medical medicine medication doctor doctors physician physicians nurse patient patients diagnosis diagnoses diagnosed diagnose " +
    "treatment treatments therapy therapist condition conditions illness sick sickness hospital clinic clinics clinical care surgery test tests results " +
    "family personal private privately confidential secret sensitive wife husband spouse partner partners son sons daughter daughters kids children child " +
    "mother father mom mum dad brother sister parents parent " +
    "reason reasons sale sell selling sold business company owner owners money finances financial finance revenue profit income cash " +
    "customer customers client clients contract contracts deal deals bid bids tender offer offers rfp rfps loi nda cim cra hst gst ceo cfo " +
    "competitor competitors competition claim claims lawsuit lawsuits litigation legal lawyer court dispute debt debts loan loans bank lender " +
    "staff employee employees worker workers team manager problem problems issue issues situation matter stuff thing things news plan plans " +
    "location locations site sites store stores shop shops branch branches office offices unit units building premises space " +
    "first second third fourth new old other another main closing close closed closure closures opening open opened expansion expand expanding " +
    "move moving relocation relocate lease leases landlord rent price pricing asking buyer buyers purchase acquisition merger " +
    "service services product products program programs line lines equipment vehicle vehicles route routes supplier suppliers vendor vendors " +
    "year years month months week weeks today tomorrow yesterday last next time spring summer fall autumn winter " +
    "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday " +
    "book document detail details part record"
  ).split(/\s+/),
);

const STOP = new Set(
  (
    "the a an and or but of in on at to for with by from as is are was were be been being it its this that these those his her their my our your he she they we i you me him them us about into over under after before than then there here what which who whom whose will would can could should just also very really has have had do does did not no so if how when where why all any some one ours hers theirs " +
    // the request's own words ("keep this private: …", "honestly, leave that out")
    "keep kept keeping leave left please thanks honestly actually basically sure okay want wants don't dont put write mention share include between record side part real true"
  ).split(/\s+/),
);

// Words, lower-cased and possessive-free, hyphenated words split ("ex-manager").
const wordsOf = (s: string) => (s.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9$][a-z0-9$']*/g) ?? []).map((w) => w.replace(/'s?$/, ""));
const stem = (w: string) => w.slice(0, 6);

/** A term that is specific enough to stand for a private detail on its own. */
export function isDistinctiveTerm(term: string): boolean {
  const t = term.trim();
  if (!termRegex(t)) return false;
  // An acronym ("MS"): specific, matched by its case (termRegex).
  if (/^[A-Z]{2,4}$/.test(t)) return !GENERIC_TERMS.has(t.toLowerCase());
  const ws = wordsOf(t).filter((w) => !STOP.has(w));
  if (ws.length === 0) return false;
  // A phrase needs one specific word ("heart attack", "wrongful dismissal");
  // a single word needs to be one, and not a short fragment.
  const specific = ws.filter((w) => !GENERIC_TERMS.has(w) && !/^\d+$/.test(w));
  if (specific.length === 0) return false;
  return ws.length > 1 || specific[0].length >= 4;
}

/**
 * The classifier's sensitive terms that really stand for the detail: said by
 * the seller (this message or the one "that" points back to), part of the
 * detail itself, and specific (isDistinctiveTerm).
 */
export function distinctivePrivateTerms(terms: readonly string[], saidText: string, detail: string): string[] {
  const out: string[] = [];
  for (const raw of terms) {
    const t = typeof raw === "string" ? raw.trim() : "";
    const re = termRegex(t);
    if (!re || !isDistinctiveTerm(t)) continue;
    if (!re.test(saidText) || !re.test(detail)) continue;
    if (!out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

/** The detail's content words (stems), everyday ones included. */
function contentStems(text: string): Set<string> {
  return new Set(wordsOf(text).filter((w) => !STOP.has(w) && (w.length >= 3 || /^\d{2,}$/.test(w))).map(stem));
}

/** The detail's own distinctive words (its everyday words aside). */
function distinctiveStems(detail: string): Set<string> {
  return new Set(wordsOf(detail).filter((w) => w.length >= 4 && !STOP.has(w) && !GENERIC_TERMS.has(w)).map(stem));
}

// How close the detail's context must be to a term (in words).
const CONTEXT_WINDOW = 8;

/**
 * A term that comes with the detail's own context in this piece of text:
 * one of the detail's other words within a few words of it ("his wife was
 * diagnosed with MS", "a heart attack in March", "Kestrel Systems"). A
 * detail that is nothing but the term needs no context.
 */
function termInContext(unit: string, term: string, detail: string): boolean {
  const re = termRegex(term);
  if (!re) return false;
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  const hits = Array.from(unit.replace(/[’‘]/g, "'").matchAll(g));
  if (hits.length === 0) return false;
  const own = new Set(wordsOf(term).map(stem));
  const context = new Set(Array.from(contentStems(detail)).filter((w) => !own.has(w)));
  if (context.size === 0) return true;
  const toks = Array.from(unit.toLowerCase().replace(/[’‘]/g, "'").matchAll(/[a-z0-9$][a-z0-9$']*/g)).map((m) => ({
    w: stem(m[0].replace(/'s?$/, "")),
    at: m.index ?? 0,
  }));
  for (const h of hits) {
    const start = h.index ?? 0;
    const end = start + h[0].length;
    const first = toks.findIndex((t) => t.at >= start);
    let last = first;
    while (last + 1 < toks.length && toks[last + 1].at < end) last++;
    if (first < 0) continue;
    for (let i = Math.max(0, first - CONTEXT_WINDOW); i <= Math.min(toks.length - 1, last + CONTEXT_WINDOW); i++) {
      if (i >= first && i <= last) continue;
      if (context.has(toks[i].w)) return true;
    }
  }
  return false;
}

/** The pieces a text is judged and cut by: its sentences and semicolon clauses. */
export function keepOutUnitsOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'(“$])|(?<=;)\s*|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A clause that carries on from the one before it in lower case and points
// back to it ("Wife is sick; owner wants to care for her").
const POINTS_BACK_RE = /^[a-z][^]*\b(?:he|she|her|hers|him|his|they|them|their|it|its|this|that|these|those)\b/;

/**
 * Which pieces of a text carry the detail: the pieces that say it, and a
 * lower-case clause right after one that points back to it — cut loose, "owner
 * wants to care for her" still gives the detail away. A clause that stands on
 * its own ("…; top customer is Alberta Health Services (18%)", "…; expansion
 * into Red Deer") is its own piece.
 */
export function privatePiecesOf(
  text: string,
  entry: Pick<SellerKeepOutEntry, "detail" | "terms">,
  opts: { loose?: boolean } = {},
): Array<{ text: string; held: boolean }> {
  const pieces = keepOutUnitsOf(text).map((t) => ({ text: t, held: carriesPrivateDetail(t, entry, opts) }));
  for (let i = 1; i < pieces.length; i++) {
    if (!pieces[i].held && pieces[i - 1].held && POINTS_BACK_RE.test(pieces[i].text)) pieces[i].held = true;
  }
  return pieces;
}

/**
 * Does a text carry the private detail? Somewhere in it one of the specific
 * terms comes with the detail's own context (termInContext), or — with no
 * term to go by — it holds most of the detail's distinctive words (never a
 * single shared word). `loose` (a value the seller gave in the very message
 * that asked for privacy): it may also say the detail in everyday words —
 * half or more of the detail's content words ("Lawsuit filed by an
 * ex-manager over his dismissal" for "A former manager has filed a wrongful
 * dismissal lawsuit").
 */
export function carriesPrivateDetail(
  text: string,
  entry: Pick<SellerKeepOutEntry, "detail" | "terms">,
  opts: { loose?: boolean } = {},
): boolean {
  if (!text) return false;
  const units = keepOutUnitsOf(text);
  if (entry.terms.some((t) => units.some((u) => termInContext(u, t, entry.detail)))) return true;
  const have = new Set(wordsOf(text).map(stem));
  const dw = distinctiveStems(entry.detail);
  if (dw.size >= 2) {
    const shared = Array.from(dw).filter((w) => have.has(w)).length;
    if (shared >= Math.max(2, Math.ceil(dw.size * 0.6))) return true;
  }
  if (opts.loose) {
    const cw = contentStems(entry.detail);
    if (cw.size >= 2) {
      const shared = Array.from(cw).filter((w) => have.has(w)).length;
      if (shared >= Math.max(2, Math.ceil(cw.size * 0.5))) return true;
    }
  }
  return false;
}

/**
 * The value without the sentences that carry the detail: "" when nothing
 * else is left, null when it doesn't carry it. Whole sentences only — a list
 * is never cut in the middle ("55% X, 30% Y, 15% Z" is kept or goes whole).
 */
export function cutPrivateDetail(value: string, entry: Pick<SellerKeepOutEntry, "detail" | "terms">, opts: { loose?: boolean } = {}): string | null {
  if (!carriesPrivateDetail(value, entry, opts)) return null;
  const pieces = privatePiecesOf(value, entry, opts);
  if (pieces.length <= 1) return "";
  const kept = pieces.filter((p) => !p.held).map((p) => p.text);
  if (kept.length === pieces.length) return "";
  return kept.join(" ").replace(/[;,\s]+$/, "").trim();
}

export function getSellerKeepOut(info: Record<string, unknown> | null | undefined): SellerKeepOutEntry[] {
  const raw = info?.[SELLER_KEEP_OUT_KEY];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e): e is SellerKeepOutEntry => !!e && typeof e === "object" && typeof (e as SellerKeepOutEntry).detail === "string")
    .map((e) => ({ ...e, terms: Array.isArray(e.terms) ? e.terms.filter((t) => typeof t === "string" && isDistinctiveTerm(t)) : [] }));
}

/** Records keep-out requests on the deal (mutates); the same detail isn't doubled. */
export function addSellerKeepOut(info: Record<string, unknown>, entries: readonly SellerKeepOutEntry[]): boolean {
  if (entries.length === 0) return false;
  const list = getSellerKeepOut(info);
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  let changed = false;
  for (const e of entries) {
    if (!e.detail.trim()) continue;
    const same = list.find((x) => norm(x.detail) === norm(e.detail));
    if (same) {
      const terms = Array.from(new Set([...same.terms, ...e.terms]));
      if (terms.length !== same.terms.length) { same.terms = terms; changed = true; }
      continue;
    }
    list.push({ ...e, terms: [...e.terms] });
    changed = true;
  }
  if (changed) info[SELLER_KEEP_OUT_KEY] = list.slice(-40);
  return changed;
}

export interface KeepOutCut {
  key: string;
  from: string;
  /** "" = the whole fact was the detail. */
  to: string;
}

/**
 * The facts in the seller's own words (interview, call, video call) that
 * carry a kept-out detail, and what each keeps. Document facts are left to
 * the CIM keep-out: the seller withdrew nothing a document says.
 */
export function planKeepOutCuts(
  info: Record<string, unknown>,
  entries: readonly SellerKeepOutEntry[],
  opts: { skip?: ReadonlySet<string> } = {},
): KeepOutCut[] {
  if (entries.length === 0) return [];
  const sources = getFieldSources(info);
  const cuts: KeepOutCut[] = [];
  for (const [key, v] of Object.entries(info)) {
    if (key.startsWith("_") || typeof v !== "string" || !v.trim() || opts.skip?.has(key)) continue;
    if (!isLiveSellerKind(sources[key]?.source)) continue;
    let value = v;
    for (const e of entries) {
      const rest = cutPrivateDetail(value, e);
      if (rest !== null) value = rest;
      if (value === "") break;
    }
    if (value !== v) cuts.push({ key, from: v, to: value });
  }
  return cuts;
}

const BROKER_DELETED_KEY = "_brokerDeleted"; // server/information/facts.ts — the history the Information tab lists

/**
 * Records what a keep-out cut took out of a fact on file in the deleted-facts
 * history — the broker sees it (and can restore it), so a good answer that
 * happened to hold the detail is never lost without a trace. Mutates.
 */
export function recordKeepOutCut(
  info: Record<string, unknown>,
  cut: { key: string; from: unknown; to: string },
  ctx: { turn?: number; at?: string } = {},
): void {
  const deleted = { ...((info[BROKER_DELETED_KEY] as Record<string, unknown> | undefined) ?? {}) };
  deleted[cut.key] = {
    value: cut.from,
    source: getFieldSources(info)[cut.key] ?? null,
    at: ctx.at ?? new Date().toISOString(),
    note:
      (cut.to === ""
        ? "Held out of the facts: it carried a detail the seller asked to keep out of the sale document"
        : "The part carrying a detail the seller asked to keep out of the sale document was taken out; this is the full answer as it was") +
      (ctx.turn !== undefined ? ` (interview turn ${ctx.turn})` : ""),
  };
  info[BROKER_DELETED_KEY] = deleted;
}

/**
 * Re-applies the seller's keep-out requests to the facts (mutates) — after a
 * reprocess, a call transcript's re-read brings its facts back with the
 * detail. Returns the keys cut (never their values).
 */
export function applySellerKeepOutToFacts(info: Record<string, unknown>): string[] {
  const cuts = planKeepOutCuts(info, getSellerKeepOut(info));
  if (cuts.length === 0) return [];
  for (const c of cuts) recordKeepOutCut(info, c);
  const sources = { ...getFieldSources(info) };
  for (const c of cuts) {
    if (c.to === "") {
      delete info[c.key];
      delete sources[c.key];
    } else {
      info[c.key] = c.to;
    }
  }
  info["_fieldSources"] = sources;
  return cuts.map((c) => c.key);
}
