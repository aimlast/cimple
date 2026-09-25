/**
 * The deal's facts as the CIM writers may use them.
 *
 * - Only real business facts: "_" bookkeeping (provenance, broker-private
 *   notes) and per-source notes (a source's summary, red flags, the seller's
 *   worries, the broker's to-dos — SOURCE_META_KEYS) are never CIM input.
 * - Split by provenance: facts from the seller, the broker, the intake form,
 *   documents, emails and call transcripts are the fact base; facts that
 *   only came from second-hand or public sources — the broker's CRM notes,
 *   the business's website, social media — are UNCONFIRMED LEADS until the
 *   seller or broker confirms them (an interview answer or a document
 *   replaces them automatically; a broker edit makes them "broker").
 */
import { getFieldSources, isFactKey, repairCharIndexedValue, type SourceKind } from "../interview/info-merger";

/** Source kinds whose facts are leads, not verified facts. */
export const LEAD_SOURCE_KINDS: ReadonlySet<SourceKind> = new Set<SourceKind>(["crm", "website", "social"]);

export interface CimFactSplit {
  /** Facts the CIM may state as fact. */
  confirmed: Array<[string, unknown]>;
  /** Facts only a CRM note, the website or social media asserted. */
  leads: Array<[string, unknown]>;
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

/** True when the fact's recorded source is a lead (CRM / website / social). */
export function isLeadFact(info: Record<string, unknown>, key: string): boolean {
  const src = getFieldSources(info)[key];
  return !!src && LEAD_SOURCE_KINDS.has(src.source);
}

export function splitFactsForCim(info: Record<string, unknown> | null | undefined): CimFactSplit {
  const out: CimFactSplit = { confirmed: [], leads: [] };
  if (!info) return out;
  for (const [key, raw] of Object.entries(info)) {
    if (!isFactKey(key)) continue;
    const value = repairCharIndexedValue(raw);
    if (!hasValue(value)) continue;
    (isLeadFact(info, key) ? out.leads : out.confirmed).push([key, value]);
  }
  return out;
}

/** A fact value as prompt text — maps as "2023: $1.7M · 2024: $1.9M", never "[object Object]". */
export function factValueText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(factValueText).filter(Boolean).join("; ");
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${factValueText(v)}`)
      .join(" · ");
  }
  return String(value);
}

/** Heading + instruction for the leads block, shared by both CIM writers. */
export const CIM_LEADS_HEADING =
  "UNCONFIRMED LEADS (from the broker's CRM notes, the business's website or social media — NOT confirmed by the seller). " +
  "Never state these as fact and never use them as figures. Use one only as soft context consistent with the confirmed data, " +
  "or leave it out; if a section depends on one, say it is to be confirmed.";
