/**
 * angle-keep-out — the deep check's outreach angle never draws on an item
 * the seller or the broker's notes keep from buyers.
 *
 * The angle opens a pre-NDA email to a buyer. It was checked for identity
 * only (isBlindSafe), so "shortlisted in an RFP with a 26-store independent
 * grocery chain" passed although the fact behind it says "(RFP shortlist,
 * confidential)" — the very item the CIM keep-out holds back. The model
 * still reads every fact (the broker-facing why-fit and watch-outs may use
 * them all); only the angle is held to the keep-out.
 *
 * Deterministic: an angle is dropped when it names a held party, carries a
 * confidentiality marker, uses a word that appears ONLY in held clauses
 * (never in the facts buyers may see) — a description of the item, not just
 * its name — states a figure found only in held clauses ("could add
 * $2-2.5M a year", "26-store"), or, when a held clause is a deal not yet won
 * (an RFP, a shortlist, a potential contract) and no fact buyers may see
 * describes one, speaks of a pending new contract or customer at all
 * ("close to landing a new supermarket customer", "in the running for a
 * large new retail account") — the paraphrases that share no word with the
 * clause. Pure.
 */
import { screenFactsForCim, mentionsHeldName, hasConfidentialNote, type KeepOut } from "../cim/sensitive-facts";
import { numberTokens, tokensMatch, type NumTok } from "../cim/discrepancy-filter";

export interface AngleGuard {
  /** Parties to hold everywhere (the held clauses' and the review's). */
  names: string[];
  /** Word stems found in held clauses and nowhere in the facts buyers may see. */
  heldOnly: string[];
  /** The held clauses, for the model's instructions. */
  clauses: string[];
  /** Figures (not years) stated in held clauses and in no fact buyers may see. */
  heldFigures?: NumTok[];
  /** A held clause is a deal not yet won, and no fact buyers may see describes one. */
  heldProspect?: boolean;
}

/** A clause about a deal not yet won. */
const PROSPECT_CLAUSE_RE = /\b(?:potential|pending|prospective|proposed|possible|rfp|rfq|shortlist\w*|short-list\w*|tender\w*|bid|bidding|negotiat\w*|in talks|talks with|pursuing|letter of intent|loi)\b/i;

/** An angle (or fact) speaking of a pending new contract or customer. */
const PROSPECT_WORDS = "pending|potential|prospective|possible|shortlist\\w*|short-listed|in the running|close to (?:landing|winning|signing|closing)|about to (?:land|win|sign)|expect(?:s|ed|ing)? to (?:land|win|sign)|bid(?:ding)? (?:for|on)|rfp|tender\\w*|negotiat\\w*|in talks|could (?:win|land|sign)";
const DEAL_NOUNS = "contract|customer|client|account|retailer|chain|award|deal";
const PROSPECT_DEAL_RE = new RegExp(
  `\\b(?:${PROSPECT_WORDS})\\b(?:\\W+[\\w$.]+){0,6}?\\W+(?:${DEAL_NOUNS})s?\\b|\\bnew\\s+(?:[\\w-]+\\s+){0,3}(?:${DEAL_NOUNS})s?\\b(?:\\W+\\w+){0,6}?\\W+(?:${PROSPECT_WORDS})\\b`,
  "i",
);

/** "$2–2.5M" → "$2M to $2.5M": a range's first figure takes the second's scale. */
function spreadRanges(text: string): string {
  return text.replace(/(\$?)(\d[\d,]*(?:\.\d+)?)\s*[-–—]\s*\$?(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|million|thousand|b|billion)\b/gi, "$1$2$4 to $1$3$4");
}

/** Figures worth matching: no years, nothing under 10 (a "2" is in every sentence). */
function figuresOf(text: string): NumTok[] {
  return numberTokens(spreadRanges(text), { keepSourceLabel: true }).filter((t) => !t.year && Math.abs(t.value) >= 10);
}

/** Common words that say nothing about which item a sentence describes. */
const PLAIN = new Set(
  "about above after again also among annual annually around based because been being below between both business buyer buyers confidential confidentiality could currently deal does during each either every from further have having into just like made main major more most much must near never next only opportunity other over own potential potentially regional same should since some such than that their them then there these they this those through under until very well were what when where which while will with within without would year years your".split(" "),
);

function stem(w: string): string {
  if (w.length > 6 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 5 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 5 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function stems(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    if (w.length < 4 || PLAIN.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}

function plain(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.map(plain).join(" ");
  if (typeof v === "object") return Object.values(v as Record<string, unknown>).map(plain).join(" ");
  return String(v);
}

/** What an outreach angle must stay clear of, for a deal's facts and keep-out review. */
export function outreachAngleGuard(info: Record<string, unknown> | null | undefined, keepOut?: KeepOut): AngleGuard {
  const pairs = Object.entries(info ?? {}).filter(([k]) => !k.startsWith("_"));
  const screened = screenFactsForCim(pairs, keepOut);
  const clauses = Array.from(new Set([...screened.confidential.flatMap((c) => c.clauses), ...(keepOut?.clauses ?? []).map((c) => c.text)]));
  const safe = stems(screened.safe.map(([k, v]) => `${k} ${plain(v)}`).join(" "));
  const heldOnly = new Set<string>();
  for (const c of clauses) for (const s of Array.from(stems(c))) if (!safe.has(s)) heldOnly.add(s);
  const safeText = screened.safe.map(([, v]) => plain(v)).join(" \n ");
  const safeFigures = figuresOf(safeText);
  const heldFigures = clauses
    .flatMap((c) => figuresOf(c))
    .filter((t) => !safeFigures.some((o) => tokensMatch({ ...t, approx: false }, { ...o, approx: false })));
  const heldProspect = clauses.some((c) => PROSPECT_CLAUSE_RE.test(c)) && !PROSPECT_DEAL_RE.test(safeText);
  return {
    names: Array.from(new Set([...screened.heldNames, ...(keepOut?.names ?? [])])),
    heldOnly: Array.from(heldOnly),
    clauses,
    heldFigures,
    heldProspect,
  };
}

/** True when the angle stays clear of everything held from buyers. */
export function angleKeepsOut(angle: string, guard: AngleGuard): boolean {
  if (guard.names.length > 0 && mentionsHeldName(angle, guard.names)) return false;
  if (hasConfidentialNote(angle)) return false;
  if (guard.heldProspect && PROSPECT_DEAL_RE.test(angle)) return false;
  const heldFigures = guard.heldFigures ?? [];
  if (heldFigures.length > 0 && figuresOf(angle).some((t) => heldFigures.some((h) => tokensMatch(t, h)))) return false;
  if (guard.heldOnly.length === 0) return true;
  const held = new Set(guard.heldOnly);
  return !Array.from(stems(angle)).some((s) => held.has(s));
}
