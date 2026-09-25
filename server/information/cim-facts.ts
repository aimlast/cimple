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
 *   replaces them automatically; a broker edit makes them "broker"; a
 *   website claim the broker accepted into the facts is a fact).
 */
import { getFieldSources, isFactKey, repairCharIndexedValue, WEBSITE_ACCEPTED_SOURCE_NOTE, type FieldSource, type SourceKind } from "../interview/info-merger";

/** Note the website "Accept into facts" action writes on the source. */
export const WEBSITE_ACCEPTED_NOTE = WEBSITE_ACCEPTED_SOURCE_NOTE;

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

/**
 * The broker accepted this value into the facts ("Accept into facts" on a
 * website claim). Rows written before the flag existed are recognised by the
 * note the accept action has always written.
 */
export function brokerAcceptedSource(src: FieldSource | undefined): boolean {
  if (!src) return false;
  return src.acceptedByBroker === true || (src.source === "website" && src.note === WEBSITE_ACCEPTED_NOTE);
}

/**
 * True when the fact's recorded source is a lead (CRM / website / social)
 * that the broker hasn't vouched for.
 */
export function isLeadFact(info: Record<string, unknown>, key: string): boolean {
  const src = getFieldSources(info)[key];
  return !!src && LEAD_SOURCE_KINDS.has(src.source) && !brokerAcceptedSource(src);
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
