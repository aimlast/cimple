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

/** Screen fact pairs for the CIM writer: returns the safe pairs and what was cut. */
export function screenFactsForCim(pairs: Array<[string, unknown]>): { safe: Array<[string, unknown]>; held: HeldFact[] } {
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
