/**
 * merge-conflicts.ts — turns the material conflicts a fact merge saw (see
 * merge-policy.ts MergeConflict) into discrepancy rows with source "merge",
 * so a spoken "$2.3M" against the statements' "$1,820,000", or a call's
 * "about 2029" against the lease's "August 31, 2028", is put in front of the
 * broker instead of sitting silently in the alternates — and keeps those
 * rows true for as long as they are open.
 *
 * Conventions (shared with the discrepancy engine / panel):
 *  - factKey is the extractedInfo key, factYear the year of a by-year map;
 *  - interviewValue holds the seller-side / spoken value (interview, call,
 *    video call, email, questionnaire), documentValue the document side;
 *    when neither or both sides are spoken, documentValue is the value kept
 *    on file;
 *  - sideSources records each side's kind, row and whether it is
 *    broker-only. Explanations never quote a broker-only source's title.
 *
 * Raising (recordMergeConflicts): only real disputes — never two measures,
 * two definitions, a part against the whole, two periods or the same figure
 * written as its parts (conflict-measures.ts falseConflictReason) — and
 * never a conflict the deal already has in ANY row (a merge row, the
 * discrepancy check's, the financial analysis', open or settled), however
 * the rows name the fact or order the values (sameConflict). So
 * re-ingesting or reprocessing is quiet, and a conflict the broker resolved
 * is never re-opened. A restated dispute brings its open row to the current
 * wording (rewordPatch), so the row stays true instead of lapsing.
 *
 * Lifecycle (supersedeStaleMergeRows): an open merge row whose source was
 * deleted, whose values no source on the deal states any more, whose fact
 * moved on, which the rules above now clear, or which repeats another row
 * is superseded (never deleted) — so it neither blocks CIM generation nor
 * reaches the seller. A row with the seller (ask_seller, seller_responded)
 * lapses only when a source was deleted or the rules clear it.
 */
import { storage } from "../storage";
import type { Discrepancy, Document, DocumentSourceMeta, InsertDiscrepancy } from "@shared/schema";
import { fieldLabel } from "../interview/interview-plan";
import { isDocumentAuthoritativeField, isPeriodFigure, materiallyDifferent, settleConflicts, HEADLINE_MAPS, type MergeConflict } from "./merge-policy";
import {
  getFieldAlternates,
  getFieldCorroborations,
  getFieldSources,
  numbersMateriallyConflict,
  repairCharIndexedValue,
  typedNumericValues,
  type FieldSource,
} from "../interview/info-merger";
import { falseConflictReason, isTaxVsBook, shareClaimsConflict, type ConflictSideInfo } from "./conflict-measures";

const SPOKEN_KINDS: ReadonlySet<string> = new Set(["interview", "call", "video_call", "email", "questionnaire"]);
const LEAD_KINDS: ReadonlySet<string> = new Set(["crm", "website", "social"]);
const HEADLINE_FIGURE = /^(annualRevenue|revenueByYear|sde|sdeByYear|ebitda|ebitdaByYear|adjustedEbitda|adjustedEbitdaByYear|netIncome|netIncomeByYear|grossProfit|grossProfitByYear)$/;
/** Statuses in which a merge row is still in front of the broker (or the seller). */
const LIVE_STATUSES: ReadonlySet<string> = new Set(["open", "ask_seller", "seller_responded"]);

const KIND_TEXT: Record<string, string> = {
  interview: "the seller in the interview",
  call: "a call",
  video_call: "a video call",
  email: "an email",
  questionnaire: "the intake questionnaire",
  document: "a document",
  crm: "your CRM note",
  website: "the website",
  social: "social media",
  broker: "your edit",
  system: "an earlier record",
};

/** A source row as the conflict rules need it. */
export type ConflictDoc = Pick<Document, "id" | "name"> & Partial<Pick<Document, "subcategory" | "sourceMeta" | "visibility">>;

/** A value for dedupe: its first figure to 2 significant digits ("$6.1M" = "$6,105,400" = "$6.11M"), else its words. */
function valueBucket(v: string | null | undefined): string {
  const t = (v ?? "").toLowerCase().replace(/\s+/g, " ").trim();
  const n = typedNumericValues(t)[0];
  return n ? `#${n.kind}:${Number(n.value.toPrecision(2))}` : t;
}

/** The headline and its by-year map are one fact for dedupe (ebitda ≡ ebitdaByYear). */
function factFamily(factKey: string): string {
  return HEADLINE_MAPS.find((p) => p.head === factKey)?.map ?? factKey;
}

/** Every key of a fact's family: the key, its headline and its by-year map. */
function familyKeys(factKey: string): string[] {
  const pair = HEADLINE_MAPS.find((p) => p.head === factKey || p.map === factKey);
  return pair ? [pair.head, pair.map] : [factKey];
}

// ─── Same conflict? ──────────────────────────────────────────────────────────

const GENERIC_KEY_WORDS = new Set(["total", "annual", "amount", "value", "by", "year", "the", "of", "and", "per", "fy", "number", "count", "details", "detail", "info", "percentage", "percent"]);

/** Content words of a fact key or a row's field label ("leaseExpiry", "Lease expiry (2024)", "revenue2023"). */
function keyWords(keyOrLabel: string): Set<string> {
  const words = keyOrLabel
    .replace(/ByYear$/, "")
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((w) => w.length > 2 && !GENERIC_KEY_WORDS.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w));
  return new Set(words);
}

const yearsIn = (v: string) => Array.from(new Set(v.match(/\b(?:19|20)\d{2}\b/g) ?? []));
const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9%.$]+/g, " ").trim();

/**
 * How `v` matches one of `others`: "figure" when its first figure is among
 * theirs, "date" when a year it names is, "text" when the words are the
 * same (or one contains the other), else null.
 */
function valueMatch(v: string | null | undefined, others: Array<string | null | undefined>): "figure" | "date" | "text" | null {
  const text = (v ?? "").trim();
  if (!text) return null;
  const pool = others.map((o) => (o ?? "").trim()).filter(Boolean);
  const first = typedNumericValues(text)[0];
  if (first) {
    const hit = pool.some((o) => typedNumericValues(o).some((t) => t.kind === first.kind &&
      Math.abs(t.value - first.value) <= Math.max(Math.abs(t.value), Math.abs(first.value)) * 0.005));
    return hit ? "figure" : null;
  }
  const ys = yearsIn(text);
  if (ys.length > 0) return pool.some((o) => yearsIn(o).some((y) => ys.includes(y))) ? "date" : null;
  const n = norm(text);
  return pool.some((o) => {
    const m = norm(o);
    return m === n || (Math.min(m.length, n.length) >= 12 && (m.includes(n) || n.includes(m)));
  }) ? "text" : null;
}

/**
 * True when `row` records the same dispute as the pair (a, b) for `factKey`:
 * each value matches a different side of the row (a resolved row's chosen
 * value counts as a side), in either order — and the row is about the same
 * fact (same family, or a legacy label sharing a word with the key), or both
 * values matched by their figures. "$4.5M vs $1.82M" raised under
 * annualRevenue and under revenueByYear 2024 is one dispute; so is the
 * financial analysis' "Owner compensation: $260K vs $268K (T4 salary $180K
 * + …)" and a merge "Owner salary: $180K vs $260K".
 */
export function sameConflict(
  factKey: string,
  a: string,
  b: string,
  row: Pick<Discrepancy, "field" | "interviewValue" | "documentValue" | "resolvedValue"> & Partial<Pick<Discrepancy, "factKey">>,
): boolean {
  const I = row.interviewValue ?? "";
  const D = row.documentValue ?? "";
  const R = row.resolvedValue ?? "";
  const tries: Array<[string[], string[]]> = [[[I], [D]], [[D], [I]]];
  if (R.trim()) tries.push([[R], [I, D]], [[I, D], [R]]);
  let matched: Array<"figure" | "date" | "text"> | null = null;
  for (const [xa, xb] of tries) {
    const ma = valueMatch(a, xa);
    const mb = ma ? valueMatch(b, xb) : null;
    if (ma && mb) { matched = [ma, mb]; break; }
  }
  const kw = new Set(familyKeys(factKey).flatMap((k) => Array.from(keyWords(k))));
  const rowWords = keyWords(`${row.factKey ?? ""} ${row.field ?? ""}`);
  const related = (!!row.factKey && factFamily(row.factKey) === factFamily(factKey)) || Array.from(rowWords).some((w) => kw.has(w));
  if (!matched) {
    // Two long values that differ only in a date ("…moved in 2022; lease runs
    // to 2029" vs "…moved in 2022. Lease runs to August 31, 2027…") are the
    // row's dispute when the years that tell them apart are the row's sides.
    if (!related) return false;
    const ya = yearsIn(a);
    const yb = yearsIn(b);
    const da = ya.filter((y) => !yb.includes(y));
    const db = yb.filter((y) => !ya.includes(y));
    if (da.length === 0 || db.length === 0) return false;
    const hit = (ys: string[], vs: string[]) => vs.some((v) => yearsIn(v).some((y) => ys.includes(y)));
    return (hit(da, [I]) && hit(db, [D, R])) || (hit(da, [D]) && hit(db, [I, R])) || (hit(da, [R]) && hit(db, [I, D]));
  }
  if (related) return true;
  return matched.every((m) => m === "figure");
}

const periodYearOf = (p?: string) => (p && /^\d{4}/.test(p) ? p.slice(0, 4) : undefined);

/**
 * Share disputes between the value on file and its other values ("medical
 * is about a third of revenue" kept as another value next to "Medical 24%
 * of 2024 sales"): a merge only compares the two values meeting at each
 * step, so a claim that lost to one source, before the value on file was
 * replaced by another, is never compared with the new one. Leads,
 * broker-only values and inferred ones are left out.
 */
export function shareDisputesOnFile(info: Record<string, unknown>): MergeConflict[] {
  const sources = getFieldSources(info);
  const alts = getFieldAlternates(info);
  const out: MergeConflict[] = [];
  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("_") || typeof value !== "string" || !/%|percent|\b(?:half|third|quarter|fifth|tenth)\b/i.test(value)) continue;
    const src = sources[key];
    if (!src || src.brokerOnly || LEAD_KINDS.has(String(src.source))) continue;
    for (const a of alts[key] ?? []) {
      if (!a || typeof a.value !== "string" || a.brokerOnly || a.valueInferred || LEAD_KINDS.has(String(a.source)) || a.source === "system") continue;
      if (a.documentId && a.documentId === src.documentId) continue;
      const { value: other, ...altSrc } = a;
      if (!shareClaimsConflict(value, other, periodYearOf(src.period), periodYearOf(a.period))) continue;
      out.push({ factKey: key, winner: { value, src }, loser: { value: other, src: altSrc as FieldSource } });
    }
  }
  return out;
}

// ─── One conflict → one row ──────────────────────────────────────────────────

export interface DiscrepancyDraft extends Omit<InsertDiscrepancy, "dealId"> {}

/**
 * Pure: the discrepancy row for one conflict (without dealId). `docName`
 * resolves a documents row to its title (never used for broker-only rows).
 */
export function discrepancyForConflict(c: MergeConflict, docName: (id: string) => string | undefined): DiscrepancyDraft {
  const w = c.winner;
  const l = c.loser;
  const spokenW = SPOKEN_KINDS.has(String(w.src.source));
  const spokenL = SPOKEN_KINDS.has(String(l.src.source));
  const [interviewSide, documentSide] = spokenW && !spokenL ? [w, l] : spokenL && !spokenW ? [l, w] : [l, w];
  const sideSource = (s: FieldSource) => ({
    kind: s.source,
    ...(s.documentId ? { documentId: s.documentId } : {}),
    ...(s.brokerOnly ? { brokerOnly: true } : {}),
  });
  const describe = (s: FieldSource) => {
    const kind = KIND_TEXT[String(s.source)] ?? "a source";
    if (!s.documentId || s.brokerOnly) return kind;
    const name = docName(s.documentId);
    return name ? `${kind} ("${name}")` : kind;
  };
  const label = `${fieldLabel(c.factKey.replace(/ByYear$/, ""))}${c.factYear ? ` (${c.factYear})` : ""}`;
  const lead = LEAD_KINDS.has(String(w.src.source)) || LEAD_KINDS.has(String(l.src.source));
  // Two different kinds of document (the statements vs a management report,
  // a tax return's revenue vs the statements') often define a figure
  // differently — worth a look, rarely an error.
  const docTypes = w.src.source === "document" && l.src.source === "document" && !!w.src.specialist !== !!l.src.specialist;
  const taxVsBook = isTaxVsBook(
    c.factKey,
    { value: w.value, kind: w.src.source, title: w.src.documentId ? docName(w.src.documentId) : undefined },
    { value: l.value, kind: l.src.source, title: l.src.documentId ? docName(l.src.documentId) : undefined },
  );
  const bigGap = numbersMateriallyConflict(w.value, l.value, 0.1);
  // Two shares of one thing ("a third of revenue" vs "24% of sales") is a real claim disputed.
  const shareDispute = shareClaimsConflict(w.value, l.value);
  const severity = lead || docTypes || taxVsBook
    ? "minor"
    : HEADLINE_FIGURE.test(c.factKey) && bigGap
      ? "critical"
      : isDocumentAuthoritativeField(c.factKey) || isPeriodFigure(c.factKey) || shareDispute
        ? "significant"
        : "minor";
  const category = isPeriodFigure(c.factKey) || shareDispute
    ? "financial"
    : /lease|rent|landlord|shareholder|director|officer|incorporat|licen|permit|entityType|legalName/i.test(c.factKey)
      ? "legal"
      : /employee|staff|customer|supplier|equipment|asset|fleet|certif/i.test(c.factKey)
        ? "operational"
        : "factual";
  const why = w.src.source === l.src.source
    ? "it is the more recent of the two"
    : isDocumentAuthoritativeField(c.factKey) && w.src.source === "document"
      ? "a document is the authority on this figure"
      : w.src.specialist
        ? "it comes from the source dedicated to this"
        : "that source ranks higher";
  return {
    field: label,
    interviewValue: interviewSide.value,
    documentValue: documentSide.value,
    documentId: documentSide.src.documentId ?? null,
    documentName: documentSide.src.documentId && !documentSide.src.brokerOnly ? docName(documentSide.src.documentId) ?? null : null,
    severity,
    category,
    source: "merge",
    factKey: c.factKey,
    factYear: c.factYear ?? null,
    sideSources: { interview: sideSource(interviewSide.src), document: sideSource(documentSide.src) },
    aiExplanation: `${describe(w.src)} and ${describe(l.src)} give different values for ${label}. The value from ${describe(w.src)} is on file because ${why}; the other is kept as another value.`,
    suggestedResolution: "Confirm which value is right, or enter the correct one.",
    status: "open",
  } as DiscrepancyDraft;
}

function docTitle(d: ConflictDoc | undefined): string | undefined {
  return d ? [d.name, d.subcategory].filter(Boolean).join(" · ") : undefined;
}

function docPeriod(d: ConflictDoc | undefined): string | undefined {
  const meta = (d?.sourceMeta as DocumentSourceMeta | null | undefined) ?? null;
  return meta?.periodEnd ?? undefined;
}

/** Why a conflict the merge collected is not a real dispute (conflict-measures.ts), or null. */
export function mergeConflictFalseReason(c: MergeConflict, docs: Map<string, ConflictDoc>): string | null {
  const side = (s: MergeConflict["winner"]): ConflictSideInfo => ({
    value: s.value,
    kind: String(s.src.source),
    title: s.src.documentId ? docTitle(docs.get(s.src.documentId)) : undefined,
    period: s.src.period,
  });
  return falseConflictReason(c.factKey, side(c.winner), side(c.loser));
}

const DEBT_KEY = /debt|loan|borrowing/i;

/** Every current-portion amount the deal states (its own keys, and "current portion $274,000" inside a debt value). */
function currentPortions(info: Record<string, unknown>): number[] {
  const out: number[] = [];
  const add = (v: unknown) => {
    const text = typeof v === "string" ? v : v && typeof v === "object" ? Object.values(v as Record<string, unknown>).map(String).join(" ") : "";
    for (const t of typedNumericValues(text)) if (t.kind === "currency") out.push(t.value);
  };
  for (const [k, v] of Object.entries(info)) {
    if (k.startsWith("_")) continue;
    if (/currentPortion/i.test(k)) add(v);
    else if (DEBT_KEY.test(k) && typeof v === "string") {
      for (const m of Array.from(v.matchAll(/current portion[^$\d;]{0,20}(\$?\s?\d[\d,]*(?:\.\d+)?\s?(?:k|m|million)?)/gi))) add(m[1].startsWith("$") ? m[1] : `$${m[1]}`);
    }
  }
  return out;
}

/**
 * Why two debt figures are not one fact disputed given what else the deal
 * states, or null: the gap between them is a current portion on file — one
 * is the total debt, the other the long-term portion after the current
 * portion ("$1,342,000" vs "$1,068,000" with "current portion $274,000").
 */
export function factsFalseReason(factKey: string, a: string, b: string, info: Record<string, unknown>): string | null {
  if (!DEBT_KEY.test(factKey)) return null;
  const x = typedNumericValues(a).find((t) => t.kind === "currency")?.value;
  const y = typedNumericValues(b).find((t) => t.kind === "currency")?.value;
  if (!x || !y || x === y) return null;
  const gap = Math.abs(x - y);
  if (currentPortions(info).some((p) => Math.abs(p - gap) <= Math.max(p, gap) * 0.005)) return "one is the total debt, the other the long-term portion after the current portion";
  return null;
}

/** Rows a new conflict is weighed against: every row except merge rows already superseded (those may come back). */
function comparableRows(rows: Discrepancy[]): Discrepancy[] {
  return rows.filter((d) => !(d.source === "merge" && d.status === "superseded"));
}

/**
 * Persists the conflicts a merge collected as open "merge" discrepancies —
 * only real disputes, and none the deal already has in any row (see the
 * module comment). Returns how many were created.
 */
export async function recordMergeConflicts(
  dealId: string,
  collected: MergeConflict[],
  documents: ConflictDoc[],
  /** The facts as saved — only conflicts still standing against them are raised. */
  finalInfo?: Record<string, unknown>,
): Promise<number> {
  const conflicts = finalInfo ? settleConflicts(finalInfo, [...collected, ...shareDisputesOnFile(finalInfo)]) : collected;
  if (conflicts.length === 0) return 0;
  const docs = new Map(documents.map((d) => [d.id, d]));
  const rows = comparableRows(await storage.getDiscrepanciesByDeal(dealId));
  const names = (id: string) => docs.get(id)?.name;
  let created = 0;
  const refreshed = new Set<string>();
  for (const c of conflicts) {
    if (mergeConflictFalseReason(c, docs)) continue;
    if (finalInfo && factsFalseReason(c.factKey, c.winner.value, c.loser.value, finalInfo)) continue;
    const matches = rows.filter((r) => sameConflict(c.factKey, c.winner.value, c.loser.value, r));
    if (matches.length > 0) {
      // The same dispute, re-read in new words (a re-extraction rewords a
      // lease date or a narrative on almost every reprocess): an OPEN merge
      // row takes the current wording, so the lifecycle below still finds
      // its values on file and the dispute never vanishes for a cycle. A row
      // the broker routed to the seller, or settled, keeps what it showed.
      const draft = discrepancyForConflict(c, names);
      for (const r of matches) {
        if (r.source !== "merge" || r.status !== "open" || refreshed.has(r.id)) continue;
        const patch = rewordPatch(r, draft, finalInfo, docs);
        if (!patch) continue;
        await storage.updateDiscrepancy(r.id, patch);
        Object.assign(r, patch);
        refreshed.add(r.id);
      }
      continue;
    }
    const row = await storage.createDiscrepancy({ dealId, ...discrepancyForConflict(c, names) } as InsertDiscrepancy);
    rows.push(row);
    created++;
  }
  return created;
}

/**
 * Pure: the update that brings an open merge row to a restated conflict's
 * current wording, or null when the row's own values still stand (it is
 * left exactly as it is) or nothing differs. Without the saved facts, any
 * difference in wording is taken.
 */
export function rewordPatch(
  row: Discrepancy,
  draft: DiscrepancyDraft,
  finalInfo: Record<string, unknown> | undefined,
  docs: Map<string, ConflictDoc>,
): Partial<InsertDiscrepancy> | null {
  if (row.interviewValue === draft.interviewValue && row.documentValue === draft.documentValue) return null;
  if (finalInfo && row.factKey && !staleMergeRowReason({ ...row, status: "open" }, finalInfo, docs)) return null;
  return {
    interviewValue: draft.interviewValue ?? null,
    documentValue: draft.documentValue ?? null,
    documentId: draft.documentId ?? null,
    documentName: draft.documentName ?? null,
    sideSources: draft.sideSources,
    aiExplanation: draft.aiExplanation ?? null,
    severity: draft.severity,
    category: draft.category,
    ...(draft.factKey && !row.factKey ? { factKey: draft.factKey } : {}),
    ...(draft.factYear && !row.factYear ? { factYear: draft.factYear, field: draft.field } : {}),
  } as Partial<InsertDiscrepancy>;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

interface SideSource { kind?: string; documentId?: string; brokerOnly?: boolean }

/** Every value the deal holds for a fact (on file, other values, corroborations), and the ones on file. */
function statedValues(info: Record<string, unknown>, factKey: string, factYear: string | null | undefined): { onFile: string[]; all: string[] } {
  const serial = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? "" : JSON.stringify(v));
  const alts = getFieldAlternates(info);
  const corr = getFieldCorroborations(info);
  const onFile: string[] = [];
  const all: string[] = [];
  for (const k of familyKeys(factKey)) {
    const v = repairCharIndexedValue(info[k]);
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const map = v as Record<string, unknown>;
      if (factYear && map[factYear] !== undefined) onFile.push(serial(map[factYear]));
    } else if (v !== undefined && v !== null && v !== "") onFile.push(serial(v));
    for (const altKey of [k, ...(factYear ? [`${k}.${factYear}`] : [])]) {
      for (const a of [...(alts[altKey] ?? []), ...(corr[altKey] ?? [])]) if (a && a.value !== undefined) all.push(String(a.value));
    }
  }
  return { onFile, all: [...onFile, ...all] };
}

function sameValue(v: string, pool: string[]): boolean {
  const b = valueBucket(v);
  const n = norm(v);
  return pool.some((p) => valueBucket(p) === b || norm(p) === n);
}

/**
 * Pure: why an open merge row no longer stands against the deal as it is
 * now, or null when it still does:
 *  - a side's source was deleted;
 *  - the rules now say the two values are not one fact disputed (two
 *    measures, definitions, periods, a part and its whole, the same figure);
 *  - the fact is gone, or a side's value is no longer stated by any source
 *    on the deal (its source was re-read and says something else now);
 *  - the value on file is neither side (the broker or a newer source moved
 *    the fact on) — for a row routed to the seller or answered by them,
 *    only the first two apply, so the seller's answer is never dropped.
 */
export function staleMergeRowReason(
  row: Discrepancy,
  info: Record<string, unknown>,
  docs: Map<string, ConflictDoc>,
): string | null {
  if (row.source !== "merge" || !LIVE_STATUSES.has(row.status)) return null;
  const sides = (row.sideSources as { interview?: SideSource; document?: SideSource } | null) || {};
  for (const s of [sides.interview, sides.document]) {
    if (s?.documentId && !docs.has(s.documentId)) return "a source it compares was removed";
  }
  if (row.documentId && !docs.has(row.documentId)) return "a source it compares was removed";
  if (!row.factKey) return null;
  const I = row.interviewValue ?? "";
  const D = row.documentValue ?? "";
  const side = (value: string, s?: SideSource): ConflictSideInfo => ({
    value,
    kind: s?.kind,
    title: s?.documentId ? docTitle(docs.get(s.documentId)) : undefined,
    period: s?.documentId ? docPeriod(docs.get(s.documentId)) : undefined,
  });
  const why = falseConflictReason(row.factKey, side(I, sides.interview), side(D, sides.document)) ?? factsFalseReason(row.factKey, I, D, info);
  if (why) return why;
  if (I && D && !materiallyDifferent(row.factKey, I, D)) return "the two values agree";
  // Routed to the seller, or answered by them: the seller's answer moving
  // the fact on is what the broker must review (the interview hands an
  // ask_seller row back as seller_responded, which re-locks a critical one),
  // never a reason to drop the row.
  if (row.status === "seller_responded" || row.status === "ask_seller") return null;
  const { onFile, all } = statedValues(info, row.factKey, row.factYear);
  if (onFile.length === 0) return "the fact is no longer on file";
  if ((I && !sameValue(I, all)) || (D && !sameValue(D, all))) return "a value it compares is no longer stated by any source";
  if (!sameValue(I, onFile) && !sameValue(D, onFile)) return "the fact on file has changed since";
  return null;
}

/**
 * Supersedes the deal's open merge rows that no longer stand (see
 * staleMergeRowReason) or repeat another row — an earlier merge row, a
 * settled one, or the discrepancy check's / financial analysis' row about
 * the same dispute. Reads the deal's facts and sources itself. Returns how
 * many rows were superseded.
 */
export async function supersedeStaleMergeRows(dealId: string): Promise<number> {
  const deal = await storage.getDeal(dealId);
  if (!deal) return 0;
  const info = (deal.extractedInfo as Record<string, unknown> | null) || {};
  const documents = await storage.getDocumentsByDeal(dealId);
  const rows = await storage.getDiscrepanciesByDeal(dealId);
  const ids = planMergeRowSupersession(rows, info, documents);
  for (const id of ids) await storage.updateDiscrepancy(id, { status: "superseded" });
  if (ids.length > 0) console.log(`[merge-conflicts] superseded ${ids.length} merge discrepanc${ids.length === 1 ? "y" : "ies"} on deal ${dealId}`);
  return ids.length;
}

/** Pure: the ids supersedeStaleMergeRows would supersede. */
export function planMergeRowSupersession(rows: Discrepancy[], info: Record<string, unknown>, documents: ConflictDoc[]): string[] {
  const docs = new Map(documents.map((d) => [d.id, d]));
  const ordered = [...rows].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt) || a.id.localeCompare(b.id));
  const out: string[] = [];
  // Weighed against every row a new conflict is (comparableRows): settled
  // rows, the check's and the analysis' rows, and earlier live merge rows.
  const kept: Discrepancy[] = comparableRows(ordered).filter((r) => !(r.source === "merge" && LIVE_STATUSES.has(r.status)));
  for (const r of ordered) {
    if (r.source !== "merge" || !LIVE_STATUSES.has(r.status)) continue;
    if (staleMergeRowReason(r, info, docs)) { out.push(r.id); continue; }
    // A row with the seller (routed or answered) stays even when another row repeats it.
    if (r.status === "open" && r.factKey &&
        kept.some((o) => sameConflict(r.factKey!, r.interviewValue ?? "", r.documentValue ?? "", o))) {
      out.push(r.id);
      continue;
    }
    kept.push(r);
  }
  return out;
}

/** Lifecycle hook for the places facts or sources change: never throws. */
export async function settleMergeRowsQuietly(dealId: string, where: string): Promise<void> {
  try {
    await supersedeStaleMergeRows(dealId);
  } catch (err) {
    console.error(`[${where}] settling merge discrepancies failed for ${dealId}:`, err);
  }
}

