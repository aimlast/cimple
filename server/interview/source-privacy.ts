/**
 * source-privacy — what the seller interview may read, re-checked against
 * the deal's CURRENT sources on every read.
 *
 * Three kinds of material were reaching the seller's interview even though
 * nothing broker-only was in the facts the interview reads:
 *
 *  1. The broker's own normalisation work typed (or confirmed) as a fact:
 *     "sde: $1,312,000 (adjusted EBITDA + owner add-backs)", "FY2024 SDE per
 *     the broker recast (add-backs: …)", "offered around 4x EBITDA". A fact
 *     the broker (or the system) wrote carries the broker's work, not the
 *     seller's words — the agent told a seller what "the broker's recast"
 *     adds back. Such a fact (or the clause of a narrative fact that says
 *     it) is left out of the interview unless the seller stated it.
 *  2. Snapshots taken while a source was shared: the stored source review's
 *     conflicts and the deferral-ledger items minted from them quote a
 *     document by name and figure. When the broker later makes that source
 *     broker-only (or deletes it) they must vanish at once — not after a
 *     background rebuild.
 *  3. A discrepancy the broker resolved to the value of a broker-only side:
 *     the fact is written as the broker's with `hiddenFromSeller`, so the
 *     seller view treats it like the private source it came from (the CIM
 *     still uses it — it is the broker's call).
 *
 * Pure.
 */
import type { Document } from "@shared/schema";
import { privateSourceMatcher } from "./seller-view";
import { sourceLabel, type SourceConflict } from "./source-context";
import type { DeferralEntry } from "./deferral-ledger";
import type { FieldSource } from "./info-merger";

type DocLike = Pick<Document, "id" | "name" | "visibility"> &
  Partial<Pick<Document, "sourceKind" | "sourceMeta" | "createdAt">>;

// =====================
// 1. The broker's normalisation work
// =====================

/** Fact keys that hold the broker's normalisation work (SDE, adjusted EBITDA, add-backs, recast, valuation, multiples, the working-capital peg). */
export const BROKER_WORK_KEY_RE =
  /^(?:sde(?:\d{4}|ByYear|History)?|adjusted\w*|normali[sz]ed\w*|(?:owner)?add[_-]?backs?\w*|recast\w*|valuation\w*|\w*multiple\w*|opinionOfValue|workingCapitalPeg|\w*discretionary(?:Earnings|CashFlow)\w*)$/i;

/**
 * Wording that carries the broker's normalisation work or the broker's own
 * material: a recast, add-backs, normalised / adjusted earnings, SDE,
 * valuation and multiples ("around 4x EBITDA"), a working-capital peg — or
 * a reference to the broker's notes ("per the broker", "CRM").
 */
export const BROKER_WORK_TEXT_RE =
  /\b(?:re-?cast|add[- ]?backs?|normali[sz](?:e|ed|es|ing|ation)|adjusted\s+(?:ebitda|earnings|sde|net income|cash flow|profit)|sde|seller'?s discretionary|discretionary (?:earnings|cash flow)|valuation|opinion of value|(?:ebitda|sde|earnings|revenue|cash[- ]flow|profit)\s+multiples?|multiples? of|working[- ]capital peg|peg)\b|\b\d+(?:\.\d+)?\s?(?:x|×|times)\s+(?:ebitda|sde|earnings|cash flow|adjusted|profit)\b/i;

/** Source kinds that are the seller's own words (spoken, typed or written by them). */
const SELLER_SAID_KINDS: ReadonlySet<string> = new Set(["interview", "call", "video_call", "questionnaire", "email"]);
/** Source kinds whose value is the broker's (or the system's) own writing. */
const BROKER_WRITTEN_KINDS: ReadonlySet<string> = new Set(["broker", "system"]);

/**
 * Text that cites the broker's own material ("per the broker", "Morgan's
 * notes" aside — "broker's recast", "CRM notes", "site visit"). Narrower than
 * mentionsPrivateSource: a bare "CRM" is the seller's own software here.
 */
const BROKER_MATERIAL_RE =
  /\b(?:broker(?:'s|’s|s')?\s+(?:note|notes|recast|estimate|estimates|valuation|meeting|call notes|memo|file|files|analysis|numbers?|figures?|view|opinion|model|calc\w*|adjust\w*|normali[sz]\w*)|per (?:the )?broker|site[- ]visit(?:\s+notes?)?|private notes?|broker[- ]only|crm (?:note|notes|record|entry|activity))\b|\(broker\b[^)]*\)/i;

export function citesBrokerMaterial(text: string | null | undefined): boolean {
  return !!text && BROKER_MATERIAL_RE.test(text);
}

/** Text that carries the broker's normalisation work or cites the broker's own material. */
export function isBrokerWorkText(text: string | null | undefined): boolean {
  return !!text && (BROKER_WORK_TEXT_RE.test(text) || BROKER_MATERIAL_RE.test(text));
}

/**
 * The clauses of a narrative value: sentences, then "; " before a new
 * clause (a figure list "$342,000; $370,000" stays in its clause).
 * Parentheses never split.
 */
function clauses(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "(" || c === "[") depth++;
    if ((c === ")" || c === "]") && depth > 0) depth--;
    cur += c;
    if (depth > 0) continue;
    const rest = text.slice(i + 1);
    const sentenceEnd =
      c === "." && /^\s+[A-Z(]/.test(rest) && !/\b(?:inc|ltd|co|corp|st|dr|mr|mrs|ms|no|vs|approx|e\.g|i\.e|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/i.test(cur);
    // "; FY2023 $6.8M" continues a list of figures — not a new clause.
    const clauseEnd = c === ";" && /^\s+(?!(?:FY|Q[1-4]\b|H[12]\b)\s?\d|(?:19|20)\d\d\b)[A-Za-z(]/.test(rest);
    const lineEnd = c === "\n";
    if (sentenceEnd || clauseEnd || lineEnd) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A narrative value with every clause that carries the broker's work left
 * out; null when nothing of substance is left. Returns the value unchanged
 * when no clause does.
 */
export function redactBrokerWork(text: string): string | null {
  const parts = clauses(text);
  const kept = parts.filter((p) => !isBrokerWorkText(p));
  if (kept.length === parts.length) return text;
  const joined = kept
    .map((p) => p.trim())
    .join(" ")
    .replace(/\s*;\s*$/, "")
    .replace(/^[\s;,.]+/, "")
    .trim();
  return /[A-Za-z0-9]{3,}/.test(joined) ? joined : null;
}

export type BrokerWorkScreen = { kind: "keep" } | { kind: "private" } | { kind: "redacted"; value: string };

/**
 * How the seller interview may show one fact (or one alternate) given who
 * wrote it. The seller's own words are always shown; a value the broker or
 * the system wrote (or one with no recorded source) is screened for the
 * broker's normalisation work: under a normalisation key (sde, addbacks,
 * adjustedEbitda…) it is private whole; elsewhere only the clauses that say
 * it are dropped. Documents the seller can see are the seller's material.
 */
export function screenBrokerWork(key: string, value: unknown, src: Partial<FieldSource> | null | undefined): BrokerWorkScreen {
  const kind = String(src?.source ?? "");
  if (SELLER_SAID_KINDS.has(kind)) return { kind: "keep" };
  if (src && !BROKER_WRITTEN_KINDS.has(kind)) return { kind: "keep" };
  const baseKey = key.split(".")[0];
  if (BROKER_WORK_KEY_RE.test(baseKey)) return { kind: "private" };
  if (typeof value === "string") {
    const redacted = redactBrokerWork(value);
    if (redacted === value) return { kind: "keep" };
    return redacted === null ? { kind: "private" } : { kind: "redacted", value: redacted };
  }
  if (value !== null && typeof value === "object") {
    return isBrokerWorkText(JSON.stringify(value)) ? { kind: "private" } : { kind: "keep" };
  }
  return { kind: "keep" };
}

/** A list of short items ("a; b; c") with every item that carries the broker's work left out. */
export function scrubBrokerWorkItems(text: string): string {
  if (!isBrokerWorkText(text)) return text;
  return redactBrokerWork(text) ?? "";
}

// =====================
// 2. Stored snapshots vs the current sources
// =====================

const LEAD_KINDS: ReadonlySet<string> = new Set(["crm", "website", "social"]);
/** Labels a fact line carries when no document backs it (the seller speaking). */
const SELLER_LABELS: ReadonlySet<string> = new Set([
  "the seller in the interview",
  "the seller's intake questionnaire",
  "said on a call with the broker",
  "said on a video call with the broker",
]);
const norm = (s: string) => s.trim().toLowerCase().replace(/…$/, "").replace(/\s+/g, " ");

/**
 * Decides, against the deal's CURRENT documents, whether a source label (as
 * the review and the ledger quote it — "document: 2024 P&L.pdf", "said on a
 * call (Mar 3, 2026)", "the seller in the interview") still names a source
 * the seller can see. Fail closed: a label naming a broker-only row, a lead
 * (CRM), a row that no longer exists, or nothing recognisable is not.
 */
export function sellerVisibleSources(documents: DocLike[]) {
  const docs = new Map(documents.map((d) => [d.id, d as never]));
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const d of documents) {
    const shared = d.visibility !== "broker_only" && !LEAD_KINDS.has(String(d.sourceKind ?? ""));
    const kind = String(d.sourceKind || "document");
    const labels = [
      `document: ${d.name}`,
      d.name,
      sourceLabel({ source: kind as FieldSource["source"], documentId: d.id }, docs),
    ].map(norm);
    (shared ? visible : hidden).push(...labels);
  }
  const namesPrivate = privateSourceMatcher(documents);
  const matches = (list: string[], label: string) => list.some((l) => l === label || (label.length >= 12 && l.startsWith(label)));
  const labelVisible = (raw: string): boolean => {
    const label = norm(raw);
    if (!label) return false;
    if (matches(hidden, label) && !matches(visible, label)) return false;
    if (matches(visible, label)) return true;
    return SELLER_LABELS.has(label);
  };
  const docVisible = (id: string | undefined): boolean => {
    if (!id) return false;
    const d = documents.find((x) => x.id === id);
    return !!d && d.visibility !== "broker_only" && !LEAD_KINDS.has(String(d.sourceKind ?? ""));
  };
  /** One side of a stored conflict. */
  const sideVisible = (side: { value: string; source: string; documentId?: string }): boolean => {
    // (The label is judged by what it names, below; the value by what it cites.)
    if (namesPrivate(`${side.value} — ${side.source}`) || citesBrokerMaterial(side.value)) return false;
    if (side.documentId) return docVisible(side.documentId);
    return labelVisible(side.source);
  };
  return { labelVisible, sideVisible, docVisible, namesPrivate };
}

/**
 * The stored source review's conflicts that still stand on seller-visible
 * sources — every side re-checked against the current documents (a source
 * made broker-only or deleted since the review drops its conflicts at once).
 */
export function visibleReviewConflicts(conflicts: SourceConflict[], documents: DocLike[]): SourceConflict[] {
  const { sideVisible } = sellerVisibleSources(documents);
  return conflicts.filter((c) => Array.isArray(c.values) && c.values.length > 0 && c.values.every((v) => v && sideVisible(v)));
}

/** The document a review side names, when exactly one current document carries that label. */
export function documentForLabel(label: string, documents: DocLike[]): string | undefined {
  const docs = new Map(documents.map((d) => [d.id, d as never]));
  const want = norm(label);
  const hits = documents.filter((d) => {
    const kind = String(d.sourceKind || "document");
    return [`document: ${d.name}`, d.name, sourceLabel({ source: kind as FieldSource["source"], documentId: d.id }, docs)]
      .map(norm)
      .some((l) => l === want);
  });
  return hits.length === 1 ? hits[0].id : undefined;
}

/** `"value" (label)` pairs of a minted "sources disagree: …" reason. */
function reasonSides(reason: string): { value: string; source: string }[] {
  const out: { value: string; source: string }[] = [];
  const re = /"((?:[^"\\]|\\.)*)" \((.*?)\)(?= vs "|\s*$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(reason)) !== null) out.push({ value: m[1], source: m[2] });
  return out;
}

/** "document: NAME" mentions in free text. */
function documentMentions(text: string): string[] {
  return Array.from(text.matchAll(/document: ([^"()\n;]+?)(?=["()\n;]|\s+vs\b|\s+says\b|\s+shows\b|$)/gi)).map((m) => m[1].trim());
}

/**
 * The deferral ledger as the seller interview may read it, re-checked
 * against the CURRENT sources. The ledger is durable (it outlives sessions),
 * so an item minted while a source was shared keeps quoting it:
 *  - a source conflict ("reconcile …", "sources disagree: …") whose side is
 *    no longer seller-visible is dropped while open, and loses its quotes
 *    once resolved (kept, so it is never minted again);
 *  - a flagged risk from a source no longer seller-visible likewise;
 *  - any other item whose reason or where-it-lives names the broker's own
 *    material, or a document that is no longer seller-visible, keeps its
 *    topic but loses that text.
 * Pure; returns a new list (unchanged entries are the same objects).
 */
export function screenLedgerForSeller(ledger: DeferralEntry[], documents: DocLike[]): DeferralEntry[] {
  const { sideVisible, labelVisible, namesPrivate } = sellerVisibleSources(documents);
  const privateText = (t: string | undefined) => !!t && (namesPrivate(t) || citesBrokerMaterial(t) || documentMentions(t).some((n) => !labelVisible(`document: ${n}`)));
  const out: DeferralEntry[] = [];
  for (const e of ledger) {
    const reason = e.reason ?? "";
    let stale = false;
    if (/^reconcile\s/i.test(e.topic) && /^sources disagree:/i.test(reason)) {
      const sides = reasonSides(reason.replace(/^sources disagree:\s*/i, ""));
      stale = sides.length === 0 || !sides.every(sideVisible);
    } else if (/^risk:\s/i.test(e.topic) && /^flagged in /i.test(reason)) {
      stale = !labelVisible(reason.replace(/^flagged in\s+/i, ""));
    }
    if (stale) {
      if (e.status === "open") continue;
      out.push({ ...e, reason: "", whereInfoLives: "" });
      continue;
    }
    if (privateText(reason) || privateText(e.whereInfoLives)) {
      out.push({ ...e, reason: privateText(reason) ? "" : reason, whereInfoLives: privateText(e.whereInfoLives) ? "" : e.whereInfoLives });
      continue;
    }
    out.push(e);
  }
  return out;
}

// =====================
// 3. A resolution to a broker-only side's value
// =====================

/** The figures a value states, scaled ("$1.94M" → 1,940,000); years left out. */
function figures(text: string): number[] {
  const out: number[] = [];
  const re = /(?<![A-Za-z0-9])(\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|million|thousand|b|billion)?(?![A-Za-z0-9])(\s*%)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let n = parseFloat(m[2].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    const suffix = (m[3] || "").toLowerCase();
    if (!m[1] && !suffix && !m[4] && n >= 1900 && n <= 2099 && Number.isInteger(n)) continue;
    const mult: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
    if (suffix) n *= mult[suffix] ?? 1;
    out.push(m[4] ? -n : n);
  }
  return out;
}

/** Two values say the same thing (the same text, or the same headline figure). */
export function sameResolvedValue(a: string, b: string): boolean {
  const x = a.trim().toLowerCase().replace(/\s+/g, " ");
  const y = b.trim().toLowerCase().replace(/\s+/g, " ");
  if (!x || !y) return false;
  if (x === y) return true;
  const fx = figures(a);
  const fy = figures(b);
  if (fx.length === 0 || fy.length === 0) return false;
  return Math.sign(fx[0]) === Math.sign(fy[0]) && Math.abs(fx[0] - fy[0]) / Math.max(Math.abs(fx[0]), Math.abs(fy[0]), 1e-9) <= 0.005;
}

/**
 * True when the broker resolved a discrepancy to the value of a side that is
 * the broker's own material (a CRM note, a broker-only file, text citing the
 * broker's recast) — and not to a value the seller-visible side also states.
 * `privateSide` / `publicSide` are the two sides' bare values.
 */
export function resolvedFromPrivateSide(resolved: string, privateSides: string[], publicSides: string[]): boolean {
  if (!resolved.trim() || privateSides.length === 0) return false;
  if (publicSides.some((v) => sameResolvedValue(resolved, v))) return false;
  return privateSides.some((v) => sameResolvedValue(resolved, v));
}
