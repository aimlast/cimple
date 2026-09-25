/**
 * Deal columns that are also facts — kept as ONE value.
 *
 * The asking price lives in two places: the deal row (`deals.askingPrice`,
 * set in the Overview's Valuation step and read by the deal list, buyer
 * matching, the buyer dashboard and CIM generation) and the fact
 * `extractedInfo.askingPrice` with provenance (the Information tab, the
 * interview's "already answered" block, the readiness score). They used to
 * drift apart: a broker correction on the Information tab never reached the
 * list, matching or the CIM, and a Valuation entry never reached the tab.
 *
 * The rule now:
 *   - every broker change to the fact (edit, add, delete, restore, chosen
 *     alternate, resolved discrepancy — all of them go through
 *     mutateDealInfo) writes the column in the same update;
 *   - every write of the column (Valuation step, deal creation) goes through
 *     the fact as a broker value (see setMirroredDealFact in facts.ts);
 *   - two copies that disagree from before this rule are reconciled the next
 *     time the deal's information is read on the Information tab or changed:
 *     a broker-sourced fact wins (the column follows); otherwise the column —
 *     the broker's own entry — becomes the broker fact, and the other value
 *     stays visible as an alternate (never lost).
 *
 * Only the broker's value ever reaches the column. A value the seller gave
 * in the interview stays a fact (the deal list and matching fall back to it
 * when no price is set), but it is never written onto the deal as the
 * broker's listed asking price.
 *
 * The seller interview never sees the price from the deal row (see
 * interviewFactView): it keeps collecting the seller's own expectation,
 * which is kept next to the broker's price as another value.
 */
import type { Deal } from "@shared/schema";
import {
  getFieldSources,
  getFieldAlternates,
  getSuppressedKeys,
  parseAlternateValue,
  sourceRank,
  typedNumericValues,
  type FieldSource,
} from "../interview/info-merger";

type Info = Record<string, unknown>;

/** Deal column ↔ fact key (same name). Extend with care: the column must be nullable text. */
export const MIRRORED_FACT_COLUMNS = ["askingPrice"] as const;
export type MirroredFactColumn = (typeof MIRRORED_FACT_COLUMNS)[number];
export type MirrorColumnPatch = Partial<Record<MirroredFactColumn, string | null>>;

/** The note on a broker fact that came from the deal row rather than the Information tab. */
export const MIRROR_NOTES = {
  valuation: "Set in Valuation",
  created: "Entered when the deal was created",
  reconciled: "Asking price on the deal",
} as const;

/** A fact value as column text: trimmed string, or null for nothing. */
export function columnText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  return null; // maps/arrays never mirror into a text column
}

function amountOf(text: string): number | null {
  const n = typedNumericValues(text).find((t) => t.kind === "currency")?.value;
  if (n && n > 0) return n;
  const plain = Number(text.replace(/[$,\s]/g, ""));
  return Number.isFinite(plain) && plain > 0 ? plain : null;
}

/** Same asking price? "$1,850,000" and "1850000" are the same value. */
export function sameValue(a: string | null, b: string | null): boolean {
  if (!a || !b) return !a && !b;
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const x = amountOf(a);
  const y = amountOf(b);
  return x !== null && y !== null && Math.abs(x - y) < 0.5;
}

const isBrokerFact = (info: Info, key: string) => getFieldSources(info)[key]?.source === "broker";

/**
 * Brings the two copies into line before a change is applied. Mutates `info`
 * when the column becomes the broker fact; returns the column updates when
 * the fact wins. Pure apart from `info`; `setBrokerFact` is injected to keep
 * this module free of facts.ts (which imports it).
 */
export function reconcileMirroredFacts(
  deal: Pick<Deal, MirroredFactColumn>,
  info: Info,
  setBrokerFact: (info: Info, key: string, value: unknown, extra?: { note?: string }) => void,
): { columnPatch: MirrorColumnPatch; infoChanged: boolean } {
  const columnPatch: MirrorColumnPatch = {};
  let infoChanged = false;
  for (const key of MIRRORED_FACT_COLUMNS) {
    const col = columnText(deal[key]);
    const fact = columnText(info[key]);
    if (sameValue(col, fact)) continue;
    if (!fact) {
      if (!col) continue;
      // The broker deleted the fact → the column goes too.
      if (getSuppressedKeys(info).includes(key)) columnPatch[key] = null;
      else {
        setBrokerFact(info, key, col, { note: MIRROR_NOTES.reconciled });
        infoChanged = true;
      }
      continue;
    }
    if (isBrokerFact(info, key)) {
      columnPatch[key] = fact; // the broker's fact on file wins
    } else if (col) {
      // The column is the broker's own entry: it outranks the seller's or a
      // document's value, which stays as an alternate.
      setBrokerFact(info, key, col, { note: MIRROR_NOTES.reconciled });
      infoChanged = true;
    }
    // No column and a non-broker fact: nothing to mirror.
  }
  return { columnPatch, infoChanged };
}

/**
 * After a broker change (every mutateDealInfo caller is one: edit, add,
 * delete, restore, chosen alternate, resolved discrepancy): when the change
 * touched a mirrored fact, the column follows — but only a BROKER value ever
 * reaches it. When the fact is now the seller's or a document's (e.g. the
 * broker restored a deleted interview figure), that isn't the broker's
 * listed price: the column is cleared rather than set to it (kept only when
 * it already holds the same amount). Null when the broker deleted the fact.
 * Returns only real differences.
 */
export function columnPatchAfterChange(
  deal: Pick<Deal, MirroredFactColumn>,
  before: Info,
  after: Info,
): MirrorColumnPatch {
  const patch: MirrorColumnPatch = {};
  for (const key of MIRRORED_FACT_COLUMNS) {
    const next = columnText(after[key]);
    const touched =
      JSON.stringify(before[key] ?? null) !== JSON.stringify(after[key] ?? null) ||
      JSON.stringify(getFieldSources(before)[key] ?? null) !== JSON.stringify(getFieldSources(after)[key] ?? null);
    if (!touched) continue;
    const col = columnText(deal[key]);
    const target = !next || isBrokerFact(after, key) ? next : sameValue(col, next) ? col : null;
    if (col !== target) patch[key] = target;
  }
  return patch;
}

/* ─── What the seller interview sees ─────────────────────────────────── */

const DEAL_ROW_NOTES: ReadonlySet<string> = new Set(Object.values(MIRROR_NOTES));

/**
 * True when the fact is the broker's price from the deal row (Valuation
 * step, deal creation, or lined up from the column) — as opposed to a value
 * the broker typed or chose on the Information tab.
 */
export function isDealRowFact(info: Info, key: string): boolean {
  const src = getFieldSources(info)[key];
  return src?.source === "broker" && typeof src.note === "string" && DEAL_ROW_NOTES.has(src.note);
}

/**
 * The deal's facts as the seller interview reads them. The broker's listed
 * asking price from the deal row is the broker's pricing decision, not
 * something the seller has said: before the two copies were kept as one
 * value it never reached the interview, and it still doesn't — the agent
 * keeps asking for (and recording) the seller's OWN expectation and never
 * quotes the broker's price to the seller. In its place the interview sees
 * the best value from any other source (the seller's own answer, the intake
 * form, a document), which the precedence rules kept as an alternate — so a
 * seller who already answered is never asked again.
 *
 * Returns `info` itself when nothing is hidden. Read-only: never save it.
 */
export function interviewFactView<T extends Info>(info: T): T {
  let out: Info = info;
  for (const key of MIRRORED_FACT_COLUMNS) {
    if (!isDealRowFact(info, key)) continue;
    if (out === info) out = { ...info };
    const best = (getFieldAlternates(info)[key] ?? [])
      .filter((a) => a && typeof a.value === "string" && a.value.trim() !== "" && a.source !== "broker")
      .sort((a, b) => sourceRank(b.source) - sourceRank(a.source) || String(b.at ?? "").localeCompare(String(a.at ?? "")))[0];
    const sources: Record<string, FieldSource> = { ...getFieldSources(out) };
    if (best) {
      const { value, ...src } = best;
      out[key] = parseAlternateValue(value);
      sources[key] = src;
    } else {
      delete out[key];
      delete sources[key];
    }
    out._fieldSources = sources;
  }
  return out as T;
}

/**
 * The broker's listed asking price: the broker-sourced fact, else the deal
 * column. Never a seller's or a document's figure — this is what the CIM and
 * buyer-facing surfaces may state as "the asking price".
 */
export function listedAskingPrice(deal: Pick<Deal, "askingPrice" | "extractedInfo">): string | null {
  const info = (deal.extractedInfo as Info | null) || {};
  const fact = columnText(info.askingPrice);
  if (fact && isBrokerFact(info, "askingPrice")) return fact;
  return columnText(deal.askingPrice);
}

/**
 * The asking price for broker-facing figures (deal list, matching): the
 * listed price, else whatever price is on file (e.g. the seller's
 * expectation from the interview).
 */
export function effectiveAskingPrice(deal: Pick<Deal, "askingPrice" | "extractedInfo">): string | null {
  const listed = listedAskingPrice(deal);
  if (listed) return listed;
  const info = (deal.extractedInfo as Info | null) || {};
  return columnText(info.askingPrice);
}
