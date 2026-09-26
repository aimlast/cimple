/**
 * value-hygiene — what a recorded fact's VALUE may not carry.
 *
 * A correction's history is not part of the fact: "Approximately 4,300
 * active patient charts (corrected from earlier 3,900 figure)" (round A,
 * Clearwater) put the retracted figure next to the right one, where a CIM
 * writer reading the value can pick it up. The seller-intent path already
 * keeps the old value as an alternate for the broker; the value keeps only
 * what is true now.
 *
 * Only notes about the CONVERSATION are taken out — a correction, a
 * revision of what was said earlier. A fact's own history stays ("Rent
 * revised from $4,000 to $4,500 in 2024" is about the rent, not about the
 * interview). Pure.
 */

/** Words that make a note about an earlier statement in this conversation. */
const EARLIER_STATEMENT =
  String.raw`(?:earlier|previous(?:ly)?|prior|initial(?:ly)?|original(?:ly)?|first|before|last (?:time|session)|at first)\b[^()\[\];]{0,60}?\b(?:figure|number|estimate|count|amount|statement|answer|value|guess|said|stated|mentioned|given|quoted|reported|recorded|noted|told)`;
const ABOUT_EARLIER_RE = new RegExp(EARLIER_STATEMENT, "i");
/** "corrected from …", "correction: …", "(revised down from the earlier …)". */
const CORRECTION_LEAD_RE =
  /^(?:(?:seller|owner|they|he|she)\s+)?(?:corrected|correcting|correction|revised|revising|updated|updating|amended|changed|clarified|restated)\b|^(?:not|rather than|instead of)\b|^(?:seller|owner|they|he|she)\s+(?:initially|originally|first|earlier|previously)\b|^(?:previously|originally|initially|earlier)\b/i;

function isCorrectionNote(note: string): boolean {
  const n = note.trim().replace(/^[(\[]|[)\]]$/g, "").trim();
  if (!n) return false;
  if (/^corrected (?:down |up |upward |downward )?from\b/i.test(n) || (/^correct(?:ing|ion)\b/i.test(n) && /\d/.test(n))) return true;
  return CORRECTION_LEAD_RE.test(n) && ABOUT_EARLIER_RE.test(n);
}

/**
 * The value without notes about how it was corrected in the conversation
 * — parenthetical ("(corrected from earlier 3,900 figure)") or a trailing
 * clause ("…; revised from the earlier estimate of 3,900", "… — not 3,900
 * as first stated"). A value that is nothing but such a note is returned
 * as it was (the merge guards decide what to do with it).
 */
export function stripCorrectionNotes(value: string): string {
  if (!value || !/correct|revis|updat|amend|chang|clarif|restat|previous|original|initial|earlier|first|not\b|rather than|instead of/i.test(value)) return value;
  let out = value.replace(/\s*[(\[]([^()\[\]]{3,160})[)\]]/g, (m, inner: string) => (isCorrectionNote(inner) ? "" : m));
  // A trailing clause after ";", "—", "–", or ", ".
  out = out.replace(/(?:\s*;\s*|\s+[—–-]\s+|,\s+)([^;—–]{3,160})$/, (m, tail: string) => (isCorrectionNote(tail) ? "" : m));
  out = out.replace(/\s{2,}/g, " ").replace(/\s+([.,;])/g, "$1").trim();
  return out.replace(/[A-Za-z0-9]/g, "").length === out.length ? value : out;
}
