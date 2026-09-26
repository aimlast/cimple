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
 * confidentiality marker, or uses a word that appears ONLY in held clauses
 * (never in the facts buyers may see) — a description of the item, not just
 * its name. Pure.
 */
import { screenFactsForCim, mentionsHeldName, hasConfidentialNote, type KeepOut } from "../cim/sensitive-facts";

export interface AngleGuard {
  /** Parties to hold everywhere (the held clauses' and the review's). */
  names: string[];
  /** Word stems found in held clauses and nowhere in the facts buyers may see. */
  heldOnly: string[];
  /** The held clauses, for the model's instructions. */
  clauses: string[];
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
  return { names: Array.from(new Set([...screened.heldNames, ...(keepOut?.names ?? [])])), heldOnly: Array.from(heldOnly), clauses };
}

/** True when the angle stays clear of everything held from buyers. */
export function angleKeepsOut(angle: string, guard: AngleGuard): boolean {
  if (guard.names.length > 0 && mentionsHeldName(angle, guard.names)) return false;
  if (hasConfidentialNote(angle)) return false;
  if (guard.heldOnly.length === 0) return true;
  const held = new Set(guard.heldOnly);
  return !Array.from(stems(angle)).some((s) => held.has(s));
}
