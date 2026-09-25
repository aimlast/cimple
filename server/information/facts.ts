/**
 * Broker edits to a deal's collected information (extractedInfo).
 *
 * Every change is written with provenance {source:"broker", at, note?} — the
 * highest authority, so no later document, email or re-extraction replaces
 * it — and the value it displaced is kept as an alternate, never lost.
 *
 * Underscore bookkeeping (never shown to the CIM or the seller):
 *   _brokerSuppressed   keys the broker deleted; non-broker merges skip them
 *   _brokerDeleted      what was deleted (value + source) so it can be restored
 *   _brokerSectionOf    CIM section a broker-added fact belongs to (display)
 *   _brokerFactLabels   the broker's own label for a fact they added
 *
 * All writes go through mutateDealInfo: the deal is re-read immediately
 * before the change is applied and saved, so an interview turn or a document
 * finishing in the meantime is never overwritten with a stale snapshot.
 */
import { storage } from "../storage";
import {
  canonicalFieldName,
  getFieldSources,
  setFieldSource,
  getFieldAlternates,
  recordAlternate,
  parseAlternateValue,
  repairCharIndexedValue,
  getSuppressedKeys,
  describeSource,
  sourceRank,
  BROKER_SUPPRESSED_KEY,
  FIELD_ALTERNATES_KEY,
  type FieldSource,
} from "../interview/info-merger";
import { GENERIC_FIELD_LABELS } from "../interview/interview-plan";
import type { Discrepancy } from "@shared/schema";

export const BROKER_DELETED_KEY = "_brokerDeleted";
export const BROKER_SECTION_OF_KEY = "_brokerSectionOf";
export const BROKER_FACT_LABELS_KEY = "_brokerFactLabels";

export class FactError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

type Info = Record<string, unknown>;

function objectAt(info: Info, key: string): Record<string, unknown> {
  const raw = info[key];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
}

function isPlainMap(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function unsuppress(info: Info, key: string): void {
  const list = getSuppressedKeys(info).filter((k) => k !== key);
  if (list.length > 0) info[BROKER_SUPPRESSED_KEY] = list;
  else delete info[BROKER_SUPPRESSED_KEY];
}

function dropAlternateValue(info: Info, key: string, serialized: string): void {
  const alts = { ...getFieldAlternates(info) } as Record<string, unknown[]>;
  if (!Array.isArray(alts[key])) return;
  alts[key] = alts[key].filter((a) => (a as { value?: string }).value !== serialized);
  if (alts[key].length === 0) delete alts[key];
  info[FIELD_ALTERNATES_KEY] = alts;
}

const serialize = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/**
 * Text the broker typed for a fact whose current value is a map (revenue by
 * year): "2024: $2.1M" lines become a map again; anything else stays text.
 */
export function coerceBrokerValue(current: unknown, input: unknown): unknown {
  if (isPlainMap(input)) return input;
  const text = String(input ?? "").trim();
  if (!isPlainMap(current)) return text;
  const lines = text.split(/\n|·|;/).map((l) => l.trim()).filter(Boolean);
  const map: Record<string, string> = {};
  for (const line of lines) {
    const m = line.match(/^([^:]{1,40}):\s*(.+)$/);
    if (!m) return text;
    map[m[1].trim()] = m[2].trim();
  }
  return Object.keys(map).length > 0 ? map : text;
}

/** Writes a broker value (edit, resolution, chosen alternate) keeping the displaced one. */
export function setBrokerFact(info: Info, key: string, value: unknown, extra: Partial<FieldSource> = {}): void {
  const current = info[key];
  const curSrc = getFieldSources(info)[key];
  const empty = current === null || current === undefined || current === "";
  if (!empty && serialize(current) !== serialize(value)) {
    recordAlternate(info, key, current, curSrc ?? { source: "system", note: "Recorded before sources were tracked" });
  }
  info[key] = value;
  setFieldSource(info, key, { source: "broker", at: new Date().toISOString(), ...extra });
  dropAlternateValue(info, key, serialize(value));
  unsuppress(info, key);
  const deleted = objectAt(info, BROKER_DELETED_KEY);
  if (deleted[key]) {
    delete deleted[key];
    info[BROKER_DELETED_KEY] = deleted;
  }
}

/** Broker edits a fact's value. */
export function editFact(info: Info, key: string, input: unknown): void {
  if (key.startsWith("_")) throw new FactError("That isn't an editable fact");
  const value = coerceBrokerValue(repairCharIndexedValue(info[key]), input);
  if (value === "" || (isPlainMap(value) && Object.keys(value).length === 0)) {
    throw new FactError("Enter a value — or delete the fact instead");
  }
  setBrokerFact(info, key, value);
}

/** camelCase key from a label ("Number of dental chairs" → numberOfDentalChairs). */
export function keyFromLabel(label: string): string {
  const words = label.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 6);
  const key = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join("")
    .slice(0, 48);
  return /^[a-z]/.test(key) ? key : `fact${key}`;
}

/** Broker adds a new fact to a section. Returns the key it was stored under. */
export function addFact(info: Info, label: string, value: unknown, sectionKey: string | null): string {
  const cleanLabel = label.trim().slice(0, 120);
  if (!cleanLabel) throw new FactError("Give the fact a name");
  const text = String(value ?? "").trim();
  if (!text) throw new FactError("Enter a value");
  // Reuse a canonical key when the label names a known field ("Annual revenue").
  const byLabel = Object.entries(GENERIC_FIELD_LABELS).find(([, l]) => l.toLowerCase() === cleanLabel.toLowerCase())?.[0];
  const base = byLabel ?? canonicalFieldName(keyFromLabel(cleanLabel), Object.keys(info));
  let key = base;
  // A different fact already lives under this key — never overwrite it silently.
  for (let n = 2; info[key] !== undefined && info[key] !== null && info[key] !== "" && !byLabel; n++) key = `${base}${n}`;
  setBrokerFact(info, key, text);
  if (!byLabel && !GENERIC_FIELD_LABELS[key]) {
    const labels = objectAt(info, BROKER_FACT_LABELS_KEY);
    labels[key] = cleanLabel;
    info[BROKER_FACT_LABELS_KEY] = labels;
  }
  if (sectionKey) {
    const sections = objectAt(info, BROKER_SECTION_OF_KEY);
    sections[key] = sectionKey;
    info[BROKER_SECTION_OF_KEY] = sections;
  }
  return key;
}

/**
 * Broker deletes a fact: removed from the deal, remembered (value + source)
 * for Restore, and suppressed so re-extraction and new sources don't bring it
 * back. The seller re-stating it live in the interview lifts the suppression.
 */
export function deleteFact(info: Info, key: string): void {
  if (key.startsWith("_")) throw new FactError("That isn't a fact");
  const current = info[key];
  if (current === undefined || current === null || current === "") throw new FactError("That fact isn't on file", 404);
  const sources = { ...getFieldSources(info) };
  const deleted = objectAt(info, BROKER_DELETED_KEY);
  deleted[key] = { value: current, source: sources[key] ?? null, at: new Date().toISOString() };
  info[BROKER_DELETED_KEY] = deleted;
  delete info[key];
  delete sources[key];
  info["_fieldSources"] = sources;
  const suppressed = getSuppressedKeys(info);
  if (!suppressed.includes(key)) info[BROKER_SUPPRESSED_KEY] = [...suppressed, key];
}

/** Undo a delete. If a value arrived since, the restored one becomes an alternate. */
export function restoreFact(info: Info, key: string): void {
  const deleted = objectAt(info, BROKER_DELETED_KEY);
  const entry = deleted[key] as { value: unknown; source: FieldSource | null } | undefined;
  if (!entry) throw new FactError("Nothing to restore for that fact", 404);
  unsuppress(info, key);
  const current = info[key];
  const src: FieldSource = entry.source ?? { source: "system", note: "Recorded before sources were tracked" };
  if (current === undefined || current === null || current === "") {
    info[key] = entry.value;
    if (entry.source) setFieldSource(info, key, entry.source);
  } else if (serialize(current) !== serialize(entry.value)) {
    recordAlternate(info, key, entry.value, src);
  }
  delete deleted[key];
  if (Object.keys(deleted).length > 0) info[BROKER_DELETED_KEY] = deleted;
  else delete info[BROKER_DELETED_KEY];
}

/**
 * Adopt one of the other values sources gave. `altKey` is the fact key, or
 * "map.subKey" for one entry of a map fact (a single year of revenue).
 */
export function useAlternate(info: Info, altKey: string, index: number): void {
  const alts = getFieldAlternates(info);
  const list = alts[altKey];
  if (!Array.isArray(list) || !list[index]) throw new FactError("That value is no longer available", 404);
  const alt = list[index];
  const note = `Chose ${describeSource(alt)}`;
  const dot = altKey.indexOf(".");
  if (dot > 0) {
    const parent = altKey.slice(0, dot);
    const sub = altKey.slice(dot + 1);
    const map = objectAt(info, parent);
    const previous = map[sub];
    map[sub] = parseAlternateValue(alt.value);
    const altsCopy = { ...alts } as Record<string, unknown[]>;
    altsCopy[altKey] = list.filter((_, i) => i !== index);
    if (previous !== undefined && previous !== null && previous !== "") {
      const prevSrc = getFieldSources(info)[parent];
      altsCopy[altKey].push({ ...(prevSrc ?? { source: "system" }), value: serialize(previous) });
    }
    if (altsCopy[altKey].length === 0) delete altsCopy[altKey];
    info[FIELD_ALTERNATES_KEY] = altsCopy;
    info[parent] = map;
    setFieldSource(info, parent, { ...(getFieldSources(info)[parent] ?? { source: "broker" }), source: "broker", at: new Date().toISOString(), note });
    unsuppress(info, parent);
    return;
  }
  setBrokerFact(info, altKey, parseAlternateValue(alt.value), { note });
}

/** Scraped website fields → the fact key "Accept into facts" writes. */
export function websiteFactKey(field: string): string {
  const MAP: Record<string, string> = {
    awards: "accolades",
    locationSite: "locations",
    numberOfLocations: "numberOfLocations",
    businessDescription: "businessDescription",
    website: "websiteUrl",
  };
  return MAP[field] ?? canonicalFieldName(field);
}

/**
 * Broker accepts a scraped website value. It lands as a fact with source
 * "website" (public, unverified — the interview still confirms it). If a
 * stronger source already holds the fact, it's kept as an alternate instead.
 */
export function acceptWebsiteFact(info: Info, field: string, value: string): { key: string; addedAs: "fact" | "alternate" } {
  const key = websiteFactKey(field);
  unsuppress(info, key);
  const src: FieldSource = { source: "website", at: new Date().toISOString(), note: "Accepted by you from the website" };
  const current = info[key];
  const empty = current === null || current === undefined || current === "";
  if (empty) {
    info[key] = value;
    setFieldSource(info, key, src);
    return { key, addedAs: "fact" };
  }
  if (serialize(current) === value) {
    const cur = getFieldSources(info)[key];
    if (!cur) setFieldSource(info, key, src);
    return { key, addedAs: "fact" };
  }
  const cur = getFieldSources(info)[key];
  if (cur && sourceRank(cur.source) <= sourceRank("website")) {
    recordAlternate(info, key, current, cur);
    info[key] = value;
    setFieldSource(info, key, src);
    return { key, addedAs: "fact" };
  }
  recordAlternate(info, key, value, src);
  return { key, addedAs: "alternate" };
}

/** Free-text discrepancy field ("Annual Revenue", "annualRevenue") → fact key. */
export function discrepancyFactKey(field: string, info: Info): string | null {
  const trimmed = (field || "").trim();
  if (!trimmed) return null;
  const byLabel = Object.entries(GENERIC_FIELD_LABELS).find(([, l]) => l.toLowerCase() === trimmed.toLowerCase())?.[0];
  if (byLabel) return byLabel;
  const raw = /^[a-z][A-Za-z0-9]*$/.test(trimmed) ? trimmed : keyFromLabel(trimmed);
  return canonicalFieldName(raw, Object.keys(info).filter((k) => !k.startsWith("_")));
}

/** Pure part of writing a discrepancy resolution into the deal's facts. */
export function applyResolutionToInfo(info: Info, d: Pick<Discrepancy, "field" | "resolvedValue" | "interviewValue" | "documentValue" | "documentId" | "source">): string | null {
  const key = discrepancyFactKey(d.field, info);
  const resolved = (d.resolvedValue || "").trim();
  if (!key || !resolved) return null;
  setBrokerFact(info, key, coerceBrokerValue(info[key], resolved), { note: "Resolved discrepancy" });
  // The conflicting values the broker ruled on stay visible as alternates.
  if (d.interviewValue && d.interviewValue.trim() !== resolved) {
    recordAlternate(info, key, d.interviewValue.trim(), {
      source: d.source === "financial_analysis" ? "document" : "interview",
      note: "Conflicting value (discrepancy)",
    });
  }
  if (d.documentValue && d.documentValue.trim() !== resolved) {
    recordAlternate(info, key, d.documentValue.trim(), {
      source: "document",
      ...(d.documentId ? { documentId: d.documentId } : {}),
      note: "Conflicting value (discrepancy)",
    });
  }
  return key;
}

/**
 * Re-read-then-merge write: loads the deal's CURRENT extractedInfo, applies
 * the mutation, saves. Keeps each broker action atomic against interview
 * turns and document ingestion running at the same time.
 */
export async function mutateDealInfo<T>(dealId: string, fn: (info: Info) => T): Promise<T> {
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new FactError("Deal not found", 404);
  const info = { ...((deal.extractedInfo as Info | null) || {}) };
  const result = fn(info);
  await storage.updateDeal(dealId, { extractedInfo: info } as any);
  return result;
}

/** PATCH /api/discrepancies/:id (resolve) → the resolved value becomes the fact on file. */
export async function applyDiscrepancyResolution(d: Discrepancy): Promise<string | null> {
  return mutateDealInfo(d.dealId, (info) => applyResolutionToInfo(info, d));
}
