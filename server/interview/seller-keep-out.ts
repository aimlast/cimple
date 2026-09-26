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
 * - PRIV-V-2: the request lasted only for that interview session and for the
 *   one fact the classifier hinted at. It is now recorded on the deal
 *   (`_sellerKeepOut`): every fact in the seller's own words that carries the
 *   detail is cut, a reprocess re-applies the cut, and the CIM keep-out
 *   (server/cim/sensitive-facts.ts keepOutFromNotes) treats it as an explicit
 *   hold whatever source states the detail.
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
// "customer" or "bank". Never a term of their own: banning one would drop
// ordinary answers (RV-INT-3).
const GENERIC_TERMS = new Set(
  (
    "health healthy healthcare medical medicine medication doctor doctors physician physicians nurse patient patients diagnosis diagnoses diagnosed diagnose " +
    "treatment treatments therapy therapist condition conditions illness sick sickness hospital clinic clinical care surgery test tests results " +
    "family personal private privately confidential secret sensitive wife husband spouse partner partners son sons daughter daughters kids children child " +
    "mother father mom mum dad brother sister parents parent " +
    "reason reasons sale sell selling sold business company owner owners money finances financial finance revenue profit income cash " +
    "customer customers client clients contract contracts deal deals bid bids tender offer offers rfp rfps loi nda cim cra hst gst ceo cfo " +
    "competitor competitors competition claim claims lawsuit lawsuits litigation legal lawyer court dispute debt debts loan loans bank lender " +
    "staff employee employees worker workers team manager problem problems issue issues situation matter stuff thing things news plan plans " +
    "year years month months week weeks today tomorrow yesterday last next time " +
    "january february march april may june july august september october november december monday tuesday wednesday thursday friday saturday sunday " +
    "book document detail details part record"
  ).split(/\s+/),
);

const STOP = new Set(
  (
    "the a an and or but of in on at to for with by from as is are was were be been being it its this that these those his her their my our your he she they we i you me him them us about into over under after before than then there here what which who whom whose will would can could should just also very really " +
    // the request's own words ("keep this private: …", "honestly, leave that out")
    "keep kept keeping leave left please thanks honestly actually basically sure okay want wants don't dont put write mention share include between record side part real true"
  ).split(/\s+/),
);

const wordsOf = (s: string) => (s.toLowerCase().replace(/[’‘]/g, "'").match(/[a-z0-9$][a-z0-9$'-]*/g) ?? []).map((w) => w.replace(/'s$/, ""));

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

/** The detail's own distinctive words (its terms aside). */
function detailWords(detail: string): Set<string> {
  return new Set(wordsOf(detail).filter((w) => w.length >= 4 && !STOP.has(w) && !GENERIC_TERMS.has(w)).map((w) => w.slice(0, 6)));
}

/**
 * Does a text carry the private detail? One of its specific terms, or — with
 * no term to go by — most of the detail's own distinctive words (never a
 * single shared word).
 */
export function carriesPrivateDetail(text: string, entry: Pick<SellerKeepOutEntry, "detail" | "terms">): boolean {
  if (!text) return false;
  if (entry.terms.some((t) => termRegex(t)?.test(text) ?? false)) return true;
  const dw = detailWords(entry.detail);
  if (dw.size < 2) return false;
  const have = new Set(wordsOf(text).map((w) => w.slice(0, 6)));
  const shared = Array.from(dw).filter((w) => have.has(w)).length;
  return shared >= Math.max(2, Math.ceil(dw.size * 0.6));
}

const sentencesOf = (t: string) => t.split(/(?<=[.;!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/**
 * The value without the sentences that carry the detail: "" when nothing
 * else is left, null when it doesn't carry it. Whole sentences only — a list
 * is never cut in the middle ("55% X, 30% Y, 15% Z" is kept or goes whole).
 */
export function cutPrivateDetail(value: string, entry: Pick<SellerKeepOutEntry, "detail" | "terms">): string | null {
  if (!carriesPrivateDetail(value, entry)) return null;
  const parts = sentencesOf(value);
  if (parts.length <= 1) return "";
  const kept = parts.filter((s) => !carriesPrivateDetail(s, entry));
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

/**
 * Re-applies the seller's keep-out requests to the facts (mutates) — after a
 * reprocess, a call transcript's re-read brings its facts back with the
 * detail. Returns the keys cut (never their values).
 */
export function applySellerKeepOutToFacts(info: Record<string, unknown>): string[] {
  const cuts = planKeepOutCuts(info, getSellerKeepOut(info));
  if (cuts.length === 0) return [];
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
