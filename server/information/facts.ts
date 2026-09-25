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
  displaceCorroborations,
  isRowBackedSource,
  isUntrackedSource,
  isFactKey,
  resolvedYearSources,
  summariseMapSource,
  BROKER_SUPPRESSED_KEY,
  FIELD_ALTERNATES_KEY,
  LEGACY_SOURCE_NOTE,
  type FieldSource,
} from "../interview/info-merger";
import { GENERIC_FIELD_LABELS, fieldLabel } from "../interview/interview-plan";
import { KNOWN_EXTRACTED_FIELDS } from "../interview/knowledge-base";
import { withDealFactsLock } from "../documents/facts-lock";
import { LEAD_SOURCE_KINDS, WEBSITE_ACCEPTED_NOTE } from "./cim-facts";
import {
  reconcileMirroredFacts,
  columnPatchAfterChange,
  columnText,
  sameValue,
  isReconciledNote,
  type MirroredFactColumn,
} from "./deal-mirror";
import type { Deal, Discrepancy } from "@shared/schema";
import { humanizeFieldKey } from "@shared/discrepancy-sides";
import { numberTokens, tokensMatch } from "../cim/discrepancy-filter";

export const BROKER_DELETED_KEY = "_brokerDeleted";
export const BROKER_SECTION_OF_KEY = "_brokerSectionOf";
export const BROKER_FACT_LABELS_KEY = "_brokerFactLabels";

export class FactError extends Error {
  constructor(message: string, public status = 400, public details?: Record<string, unknown>) {
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
  // A legacy character-indexed value is kept (as an alternate) repaired,
  // never as the soup — adopting it later must not re-corrupt the fact.
  const current = repairCharIndexedValue(info[key]);
  const curSrc = getFieldSources(info)[key];
  const empty = current === null || current === undefined || current === "";
  if (!empty && serialize(current) !== serialize(value)) {
    recordAlternate(info, key, current, curSrc ?? { source: "system", note: LEGACY_SOURCE_NOTE });
  }
  info[key] = value;
  setFieldSource(info, key, { source: "broker", at: new Date().toISOString(), ...extra });
  displaceCorroborations(info, key, value);
  dropAlternateValue(info, key, serialize(value));
  unsuppress(info, key);
  const deleted = objectAt(info, BROKER_DELETED_KEY);
  if (deleted[key]) {
    delete deleted[key];
    info[BROKER_DELETED_KEY] = deleted;
  }
}

/**
 * The broker sets ONE entry of a map fact (a single year of revenue) — by
 * choosing another source's figure or resolving a discrepancy. Only that
 * year becomes the broker's (no document delete or re-extraction can take
 * it away); every other year keeps its own full source (a CRM year stays a
 * CRM year — it is never promoted to "broker-confirmed" by the broker's
 * choice on another year). The map's recorded source is the summary of its
 * years (see summariseMapSource). The displaced figure is kept as that
 * year's alternate under its real kind.
 */
export function setBrokerMapEntry(info: Info, parent: string, sub: string, value: unknown, note: string): void {
  const repaired = repairCharIndexedValue(info[parent]);
  if (repaired !== undefined && repaired !== null && repaired !== "" && !isPlainMap(repaired)) {
    throw new FactError("That fact isn't a list of values by year — edit the whole fact instead");
  }
  const map: Record<string, unknown> = isPlainMap(repaired) ? { ...repaired } : {};
  const prevSrc = getFieldSources(info)[parent];
  const legacy: FieldSource = { source: "system", note: LEGACY_SOURCE_NOTE };
  // Every year's own source (older bare-id entries read as their row).
  const years: Record<string, FieldSource> = prevSrc
    ? resolvedYearSources(prevSrc, map)
    : Object.fromEntries(Object.keys(map).map((y) => [y, legacy]));
  const previous = map[sub];
  const altKey = `${parent}.${sub}`;
  if (previous !== undefined && previous !== null && previous !== "" && serialize(previous) !== serialize(value)) {
    const prevYearSrc = years[sub] && !isUntrackedSource(years[sub]) ? years[sub] : legacy;
    recordAlternate(info, altKey, previous, prevYearSrc);
  }
  map[sub] = value;
  years[sub] = { source: "broker", at: new Date().toISOString(), note };
  displaceCorroborations(info, altKey, value);
  dropAlternateValue(info, altKey, serialize(value));
  info[parent] = map;
  const summary = summariseMapSource(years);
  if (summary) setFieldSource(info, parent, summary);
  unsuppress(info, parent);
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

/** The key a known field would be stored under for this label, or null for an ad-hoc label. */
export function knownFieldForLabel(label: string): string | null {
  const clean = label.trim();
  // A known field's own label ("Annual revenue").
  const byLabel = Object.entries(GENERIC_FIELD_LABELS).find(([, l]) => l.toLowerCase() === clean.toLowerCase())?.[0];
  if (byLabel) return byLabel;
  const raw = keyFromLabel(clean);
  const key = canonicalFieldName(raw);
  // An alias of a known field ("Revenue" → annualRevenue, "Headcount" → employees).
  if (key !== raw) return key;
  if (GENERIC_FIELD_LABELS[key] || KNOWN_EXTRACTED_FIELDS.has(key)) return key;
  return null;
}

/** 409 payload when the broker adds a fact that is already on file under a known field. */
export interface ExistingFactConflict {
  existingKey: string;
  existingLabel: string;
  currentValue: string;
}

/**
 * Broker adds a new fact to a section. Returns the key it was stored under.
 * A label that names a field already on file ("Revenue" while annualRevenue
 * holds a value) is refused with 409 and the existing fact — the broker
 * updates that one instead of a second copy (annualRevenue2) that coverage,
 * the deal card and the CIM would never read. Ad-hoc labels that happen to
 * collide still get their own numbered key.
 */
export function addFact(info: Info, label: string, value: unknown, sectionKey: string | null): string {
  const cleanLabel = label.trim().slice(0, 120);
  if (!cleanLabel) throw new FactError("Give the fact a name");
  const text = String(value ?? "").trim();
  if (!text) throw new FactError("Enter a value");
  // Reuse a canonical key when the label names a known field ("Annual revenue", "Revenue").
  const known = knownFieldForLabel(cleanLabel);
  const hasValue = (k: string) => info[k] !== undefined && info[k] !== null && info[k] !== "";
  if (known && hasValue(known)) {
    const existingLabel = GENERIC_FIELD_LABELS[known] ?? (info[BROKER_FACT_LABELS_KEY] as Record<string, string> | undefined)?.[known] ?? fieldLabel(known);
    const current = info[known];
    const details: ExistingFactConflict = {
      existingKey: known,
      existingLabel,
      currentValue: typeof current === "string" ? current : serialize(current),
    };
    throw new FactError(`${existingLabel} is already on file — update it instead of adding a second one`, 409, details as unknown as Record<string, unknown>);
  }
  const base = known ?? canonicalFieldName(keyFromLabel(cleanLabel), Object.keys(info));
  let key = base;
  // A different fact already lives under this key — never overwrite it silently.
  for (let n = 2; hasValue(key) && !known; n++) key = `${base}${n}`;
  setBrokerFact(info, key, text);
  if (!known && !GENERIC_FIELD_LABELS[key]) {
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

/**
 * A fact the broker deleted has a value again — the seller re-stated it
 * live, or the broker accepted a website value. The deleted entry is
 * retired: its value becomes an alternate (still one click to adopt) instead
 * of the fact being listed as both live and deleted.
 */
export function retireDeletedEntry(info: Info, key: string): void {
  const deleted = objectAt(info, BROKER_DELETED_KEY);
  const entry = deleted[key] as { value: unknown; source: FieldSource | null } | undefined;
  if (!entry) return;
  const value = repairCharIndexedValue(entry.value);
  const now = repairCharIndexedValue(info[key]);
  if (value !== undefined && value !== null && value !== "" && serialize(value) !== serialize(now)) {
    recordAlternate(info, key, value, entry.source ?? { source: "system", note: LEGACY_SOURCE_NOTE });
  }
  delete deleted[key];
  if (Object.keys(deleted).length > 0) info[BROKER_DELETED_KEY] = deleted;
  else delete info[BROKER_DELETED_KEY];
}

/** Undo a delete. If a value arrived since, the restored one becomes an alternate. */
export function restoreFact(info: Info, key: string): void {
  const deleted = objectAt(info, BROKER_DELETED_KEY);
  const entry = deleted[key] as { value: unknown; source: FieldSource | null } | undefined;
  if (!entry) throw new FactError("Nothing to restore for that fact", 404);
  unsuppress(info, key);
  const current = info[key];
  const src: FieldSource = entry.source ?? { source: "system", note: LEGACY_SOURCE_NOTE };
  const restored = repairCharIndexedValue(entry.value); // never restore character soup
  if (current === undefined || current === null || current === "") {
    info[key] = restored;
    if (entry.source) setFieldSource(info, key, entry.source);
  } else if (serialize(repairCharIndexedValue(current)) !== serialize(restored)) {
    recordAlternate(info, key, restored, src);
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
  const chosen = repairCharIndexedValue(parseAlternateValue(alt.value));
  const dot = altKey.indexOf(".");
  if (dot > 0) {
    // One year of a map: the broker's pick is theirs — no longer tied to
    // either document, so deleting the rejected (or the chosen) source
    // never takes it away.
    setBrokerMapEntry(info, altKey.slice(0, dot), altKey.slice(dot + 1), chosen, note);
    return;
  }
  setBrokerFact(info, altKey, chosen, { note });
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
 * "website" and `acceptedByBroker` — ranked as the website (the interview,
 * a document or a broker edit still replaces it), but the broker vouched for
 * it, so the CIM writers use it as a fact rather than an unconfirmed lead. If a
 * stronger source already holds the fact, it's kept as an alternate instead.
 */
export function acceptWebsiteFact(info: Info, field: string, value: string): { key: string; addedAs: "fact" | "alternate" } {
  const result = acceptWebsiteValue(info, websiteFactKey(field), value);
  // The broker is bringing a deleted fact back: the deleted value stays
  // available as another value instead of a separate "deleted" entry that
  // would show the fact as both live and deleted.
  retireDeletedEntry(info, result.key);
  return result;
}

function acceptWebsiteValue(info: Info, key: string, value: string): { key: string; addedAs: "fact" | "alternate" } {
  unsuppress(info, key);
  const src: FieldSource = {
    source: "website",
    at: new Date().toISOString(),
    note: WEBSITE_ACCEPTED_NOTE,
    acceptedByBroker: true,
  };
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
    // The same value from a lead (a CRM note): the broker has now vouched
    // for it — the CIM may state it — while it keeps its real source.
    else if (LEAD_SOURCE_KINDS.has(cur.source) && !cur.acceptedByBroker) setFieldSource(info, key, { ...cur, acceptedByBroker: true });
    return { key, addedAs: "fact" };
  }
  const cur = getFieldSources(info)[key];
  if (cur && sourceRank(cur.source) <= sourceRank("website")) {
    recordAlternate(info, key, current, cur);
    info[key] = value;
    setFieldSource(info, key, src);
    displaceCorroborations(info, key, value);
    return { key, addedAs: "fact" };
  }
  recordAlternate(info, key, value, src);
  return { key, addedAs: "alternate" };
}

/** Where a discrepancy resolution lands: a fact, or one year of a map fact. */
export interface DiscrepancyTarget {
  key: string;
  /** Year (sub-key) of a map fact — "2024" of revenueByYear. */
  sub?: string;
}

/**
 * "2024 Revenue", "FY2024 revenue", "Revenue 2024", "Total sales (2024)" →
 * "2024". The financial analysis names its per-year figures this way.
 */
export function revenueYearOfField(field: string): string | null {
  const t = (field || "").trim();
  const metric = String.raw`(?:(?:total|gross|annual)\s+)?(?:revenues?|sales)`;
  const year = String.raw`(?:FY\s*)?((?:19|20)\d{2})`;
  const m =
    t.match(new RegExp(`^${year}\\s+${metric}$`, "i")) ??
    t.match(new RegExp(`^${metric}\\s*[,:(\\-–—]?\\s*${year}\\s*\\)?$`, "i"));
  return m ? m[1] : null;
}

/**
 * Free-text discrepancy field → the fact it is about, or null when it names
 * no fact the deal has or the CIM knows ("2024 SDE", a routed question's
 * full text…). A resolution with no target stays a resolution (the
 * read-time overlays still apply it) — it never mints a junk fact such as
 * "fact2024Revenue" or "whatWereTheOwnerSWages".
 */
export function discrepancyFactTarget(field: string, info: Info): DiscrepancyTarget | null {
  const trimmed = (field || "").trim();
  if (!trimmed) return null;
  const year = revenueYearOfField(trimmed);
  if (year) {
    const cur = repairCharIndexedValue(info.revenueByYear);
    // The seller's own free-text revenue history is never turned into a map.
    if (cur === undefined || cur === null || cur === "" || isPlainMap(cur)) return { key: "revenueByYear", sub: year };
    return null;
  }
  const byLabel = Object.entries(GENERIC_FIELD_LABELS).find(([, l]) => l.toLowerCase() === trimmed.toLowerCase())?.[0];
  if (byLabel) return { key: byLabel };
  const factKeys = Object.keys(info).filter(isFactKey);
  const raw = /^[a-z][A-Za-z0-9]*$/.test(trimmed) ? trimmed : keyFromLabel(trimmed);
  const key = canonicalFieldName(raw, factKeys);
  if (factKeys.includes(key) || GENERIC_FIELD_LABELS[key] || KNOWN_EXTRACTED_FIELDS.has(key) || key === "revenueByYear") return { key };
  return null;
}

/** @deprecated use discrepancyFactTarget — kept for older callers (the parent fact key). */
export function discrepancyFactKey(field: string, info: Info): string | null {
  return discrepancyFactTarget(field, info)?.key ?? null;
}

/** "$1,894,000 — 2024 P&L" → "$1,894,000" (the financial analysis appends where a value came from). */
function bareDiscrepancyValue(v: string): string {
  const idx = v.indexOf(" — ");
  return (idx > 0 ? v.slice(0, idx) : v).trim();
}

/** The kind of source a financial-analysis value label names ("… — Seller interview"). */
function kindFromValueLabel(v: string): FieldSource["source"] {
  const label = v.indexOf(" — ") > 0 ? v.slice(v.indexOf(" — ") + 3).toLowerCase() : "";
  if (/interview|seller said|told/.test(label)) return "interview";
  if (/questionnaire|intake/.test(label)) return "questionnaire";
  if (/e-?mail/.test(label)) return "email";
  return "document";
}

/**
 * The broker chose to keep a resolution as a note, not linked to any fact
 * (stored as the discrepancy's factKey). Nothing is written for it, and it
 * no longer asks "Which fact should this update?".
 */
export const NO_FACT_KEY = "_none";

/** Returned when a resolution names no fact — the broker is asked which fact it updates. */
export const NEEDS_MAPPING = "needs_mapping" as const;

/**
 * Returned when the fact is a description the resolved figure is only part
 * of ("Staff structure: 24 licensed technicians, 5 plumbers, …" resolved as
 * "22 licensed technicians"): overwriting would throw the rest away, so
 * nothing is written — the broker updates it through "facts that still say
 * the old value" (a minimal rewrite, reviewed before it's saved).
 */
export const NARRATIVE_FACT = "narrative" as const;

export function isNarrativeTarget(info: Info, target: DiscrepancyTarget, resolved: string): boolean {
  if (target.sub) return false;
  const cur = repairCharIndexedValue(info[target.key]);
  return typeof cur === "string" && cur.length > 160 && resolved.length < cur.length * 0.4;
}

const FACT_KEY_SHAPE = /^[a-z][A-Za-z0-9]*$/;

/**
 * Where a resolution lands: the row's own factKey (chosen from the deal's
 * real keys by the engine, the analysis, the merge — or by the broker in
 * the picker) wins; legacy rows fall back to reading the field label.
 */
export function resolutionTarget(
  info: Info,
  d: Pick<Discrepancy, "field"> & Partial<Pick<Discrepancy, "factKey" | "factYear">>,
): DiscrepancyTarget | typeof NO_FACT_KEY | null {
  const factKey = (d.factKey || "").trim();
  if (factKey === NO_FACT_KEY) return NO_FACT_KEY;
  if (factKey && FACT_KEY_SHAPE.test(factKey) && isFactKey(factKey)) {
    const year = (d.factYear || "").trim().replace(/^FY\s*/i, "");
    const cur = repairCharIndexedValue(info[factKey]);
    const mapLike = cur === undefined || cur === null || cur === "" ? factKey === "revenueByYear" || /ByYear$/.test(factKey) : isPlainMap(cur);
    if (year && mapLike) return { key: factKey, sub: year };
    return { key: factKey };
  }
  return discrepancyFactTarget(d.field, info);
}

/**
 * A model-chosen fact key must hold the figure in question: the fact is
 * empty, or states one side's value (or a figure from it). "22 licensed
 * technicians" resolved into employees = "36 employees plus owner" is the
 * wrong fact — the broker is asked instead of the headcount being lost.
 */
export function targetRelatesToSides(
  info: Info,
  target: DiscrepancyTarget,
  d: Pick<Discrepancy, "interviewValue" | "documentValue" | "source">,
): boolean {
  const raw = repairCharIndexedValue(info[target.key]);
  const cur = target.sub && isPlainMap(raw) ? raw[target.sub] : raw;
  if (cur === undefined || cur === null || cur === "") return true;
  const text = typeof cur === "string" ? cur : JSON.stringify(cur);
  const sides = [d.interviewValue, d.documentValue].map((v) => bareDiscrepancyValue(v || "")).filter(Boolean);
  if (sides.length === 0) return true; // nothing to compare against (an answered question)
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%.]+/g, " ").trim();
  if (sides.some((v) => norm(text).includes(norm(v)) || norm(v).includes(norm(text)))) return true;
  const curNums = numberTokens(text, { keepSourceLabel: true }).filter((t) => !t.year);
  return sides.some((v) => numberTokens(v).filter((t) => !t.year).some((s) => curNums.some((c) => tokensMatch(c, s))));
}

/** The side a discrepancy value came from, as a fact source kind. */
function sideKind(d: Partial<Pick<Discrepancy, "sideSources" | "source">>, side: "interview" | "document", raw: string): FieldSource["source"] {
  const sides = (d.sideSources && typeof d.sideSources === "object" ? d.sideSources : {}) as Record<string, { kind?: string } | undefined>;
  const kind = sides[side]?.kind;
  if (kind && ["interview", "call", "video_call", "questionnaire", "email", "document", "crm", "website", "social"].includes(kind)) {
    return kind as FieldSource["source"];
  }
  if (d.source === "financial_analysis") return kindFromValueLabel(raw);
  return side === "interview" ? "interview" : "document";
}

/**
 * Pure part of writing a discrepancy resolution into the deal's facts.
 * Returns the fact key written ("revenueByYear.2024" for one year of a map);
 * NEEDS_MAPPING when the discrepancy names no fact (nothing is written — the
 * broker is asked which fact it updates, never left with a silent no-op);
 * NARRATIVE_FACT when the fact is a description the figure is only part of
 * (nothing is overwritten — the broker reviews a minimal rewrite instead);
 * null when there is nothing to write (no resolved value, or the broker
 * chose to keep it as a note only).
 */
export function applyResolutionToInfo(
  info: Info,
  d: Pick<Discrepancy, "field" | "resolvedValue" | "interviewValue" | "documentValue" | "documentId" | "source"> &
    Partial<Pick<Discrepancy, "factKey" | "factYear" | "sideSources">>,
  opts: { brokerChoseFact?: boolean } = {},
): string | typeof NEEDS_MAPPING | typeof NARRATIVE_FACT | null {
  const resolved = (d.resolvedValue || "").trim();
  if (!resolved) return null;
  const target = resolutionTarget(info, d);
  if (target === NO_FACT_KEY) return null;
  if (!target) return NEEDS_MAPPING;
  if (!opts.brokerChoseFact && d.factKey && d.source !== "merge" && !targetRelatesToSides(info, target, d)) return NEEDS_MAPPING;
  if (isNarrativeTarget(info, target, resolved)) return NARRATIVE_FACT;
  const labelled = d.source === "financial_analysis";
  const note = "Resolved discrepancy";
  const altKey = target.sub ? `${target.key}.${target.sub}` : target.key;
  if (target.sub) setBrokerMapEntry(info, target.key, target.sub, resolved, note);
  else setBrokerFact(info, target.key, coerceBrokerValue(info[target.key], resolved), { note });
  // The conflicting values the broker ruled on stay visible as alternates —
  // bare figures (the " — source" label stripped) under their real kind.
  const sides = (d.sideSources && typeof d.sideSources === "object" ? d.sideSources : {}) as Record<string, { documentId?: string } | undefined>;
  const conflicting: Array<{ raw: string | null; src: FieldSource }> = [
    {
      raw: d.interviewValue,
      src: {
        source: sideKind(d, "interview", d.interviewValue || ""),
        ...(sides.interview?.documentId ? { documentId: sides.interview.documentId } : {}),
        note: "Conflicting value (discrepancy)",
      },
    },
    {
      raw: d.documentValue,
      src: {
        source: sideKind(d, "document", d.documentValue || ""),
        ...(d.documentId || sides.document?.documentId ? { documentId: d.documentId || sides.document!.documentId } : {}),
        note: "Conflicting value (discrepancy)",
      },
    },
  ];
  for (const { raw, src } of conflicting) {
    if (!raw || !raw.trim()) continue;
    const value = labelled ? bareDiscrepancyValue(raw) : raw.trim();
    if (value && value !== resolved) recordAlternate(info, altKey, value, src);
  }
  return altKey;
}

export interface FactTargetOption {
  key: string;
  label: string;
  /** Short preview of the value on file. */
  value: string;
}

/**
 * Facts a resolution could update, best matches first — for the "Which fact
 * should this update?" picker. Scored on shared words between the
 * discrepancy's label and the fact's key/label, plus a figure from either
 * side appearing in the fact's current value.
 */
export function suggestFactTargets(
  info: Info,
  d: Pick<Discrepancy, "field"> & Partial<Pick<Discrepancy, "interviewValue" | "documentValue" | "resolvedValue">>,
  limit = 6,
): { suggestions: FactTargetOption[]; all: FactTargetOption[] } {
  const stem = (w: string) => w.replace(/(?:ies|es|s)$/, "");
  const words = (s: string) =>
    new Set(s.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map(stem));
  // Measure words say how, not what ("revenue percentage" of WHICH customer?).
  const GENERIC = new Set(["revenue", "percentage", "percent", "total", "value", "number", "count", "amount", "annual", "year", "claimed", "calculated", "actual", "stated", "vs", "and", "the", "for"].map(stem));
  // A subject word that names a fact under another word.
  const SYNONYMS: Record<string, string[]> = {
    percentage: ["concentration"], share: ["concentration"], percent: ["concentration"],
    headcount: ["employee", "staff"], staff: ["employee"], employee: ["staff", "headcount"],
    van: ["fleet", "vehicle"], truck: ["fleet", "vehicle"], vehicle: ["fleet"],
    member: ["membership", "subscriber"], expiry: ["lease"], renewal: ["lease"],
  };
  const subject = words(d.field || "");
  const distinctive = new Set(Array.from(subject).filter((w) => !GENERIC.has(w)));
  const synonyms = new Set(Array.from(subject).flatMap((w) => (SYNONYMS[w] ?? []).map(stem)));
  // Figures as written ("18%", "$1,312,000", "2,900") — a fact that states one is likely the target.
  const figures = [d.interviewValue, d.documentValue, d.resolvedValue]
    .flatMap((v) => (v ? bareDiscrepancyValue(v).match(/\$?\d[\d,.]*\d%?|\$?\d%?/g) ?? [] : []))
    .filter((n) => n.replace(/\D/g, "").length >= 2 && !/^(?:19|20)\d\d$/.test(n));
  const labels = objectAt(info, BROKER_FACT_LABELS_KEY) as Record<string, string>;
  const all: Array<FactTargetOption & { score: number }> = [];
  for (const [key, raw] of Object.entries(info)) {
    if (!isFactKey(key) || raw === null || raw === undefined || raw === "") continue;
    const label = labels[key] || factDisplayLabel(info, key);
    const text = typeof raw === "string" ? raw : JSON.stringify(raw);
    const kw = words(`${key} ${label}`);
    const valueWords = words(text);
    let score = 0;
    kw.forEach((w) => {
      if (distinctive.has(w)) score += 3;
      else if (subject.has(w)) score += 1;
      if (synonyms.has(w)) score += 2;
    });
    score += Math.min(2, Array.from(distinctive).filter((w) => valueWords.has(w)).length);
    if (figures.some((f) => text.includes(f))) score += 2;
    all.push({ key, label, value: text.replace(/\s+/g, " ").slice(0, 120), score });
  }
  all.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
  const strip = ({ score: _s, ...o }: FactTargetOption & { score: number }) => o;
  return {
    suggestions: all.filter((o) => o.score >= 2).slice(0, limit).map(strip),
    all: [...all].sort((a, b) => a.label.localeCompare(b.label)).map(strip),
  };
}

/** A fact's broker-facing name: the broker's own label, the known label, or its key in words ("sde" → "SDE"). */
export function factDisplayLabel(info: Info, key: string): string {
  const labels = objectAt(info, BROKER_FACT_LABELS_KEY) as Record<string, string>;
  return labels[key] || GENERIC_FIELD_LABELS[key] || humanizeFieldKey(key);
}

/**
 * Re-read-then-merge write: loads the deal's CURRENT extractedInfo, applies
 * the mutation, saves. Keeps each broker action atomic against interview
 * turns and document ingestion running at the same time. Deal columns that
 * mirror a fact (deals.askingPrice) are written in the same update.
 */
export async function mutateDealInfo<T>(dealId: string, fn: (info: Info) => T): Promise<T> {
  // Same per-deal queue as document ingestion and the interview turn's
  // save: no two read-modify-writes of the facts interleave.
  return withDealFactsLock(dealId, async () => {
    const deal = await storage.getDeal(dealId);
    if (!deal) throw new FactError("Deal not found", 404);
    const info = { ...((deal.extractedInfo as Info | null) || {}) };
    // Deal columns that are also facts (the asking price) are one value: line
    // the two copies up first, then let the column follow whatever the broker
    // changed — in the same update (see deal-mirror.ts).
    const { columnPatch } = reconcileMirroredFacts(deal, info, setBrokerFact);
    const before = structuredClone(info);
    const result = fn(info);
    const after = columnPatchAfterChange({ ...deal, ...columnPatch }, before, info);
    await storage.updateDeal(dealId, { extractedInfo: info, ...columnPatch, ...after } as any);
    return result;
  });
}

/**
 * A deal column that mirrors a fact was set outside the Information tab
 * (Valuation step, deal creation): record it as the broker's fact — the
 * column follows through mutateDealInfo. Empty clears the fact (restorable).
 */
export async function setMirroredDealFact(dealId: string, key: MirroredFactColumn, value: unknown, note: string): Promise<void> {
  await setMirroredDealFacts(dealId, { [key]: value }, note);
}

/**
 * Several deal columns set at once (deal creation, the deal's details form):
 * each becomes the broker's fact in one update — the business name, the
 * industry, the asking price. A value a document or CRM note gave stays as
 * another value.
 */
export async function setMirroredDealFacts(
  dealId: string,
  values: Partial<Record<MirroredFactColumn, unknown>>,
  note: string,
): Promise<void> {
  const entries = Object.entries(values) as Array<[MirroredFactColumn, unknown]>;
  if (entries.length === 0) return;
  await mutateDealInfo(dealId, (info) => {
    for (const [key, value] of entries) {
      const text = columnText(value);
      if (!text) {
        if (columnText(info[key])) deleteFact(info, key);
        continue;
      }
      const src = getFieldSources(info)[key];
      // Already the broker's value — unless it was only just lined up from the
      // column a moment ago (then give it the real reason: Valuation, creation).
      if (sameValue(columnText(info[key]), text) && src?.source === "broker" && !isReconciledNote(src.note)) continue;
      setBrokerFact(info, key, text, { note });
    }
  });
}

/**
 * The deal as broker surfaces read it (the Information tab, the readiness
 * score): a deal whose asking-price copies drifted apart before the mirror
 * rule gets them lined up IN MEMORY — the same result mutateDealInfo saves
 * on the broker's next change — so every broker screen shows one value while
 * reading the deal never writes to it (no save, no "last activity" bump).
 * Returns the deal itself when nothing needs lining up. Never save it.
 */
export function brokerFactsView<D extends Pick<Deal, MirroredFactColumn | "extractedInfo">>(deal: D): D {
  const info = structuredClone((deal.extractedInfo as Info | null) || {});
  const { columnPatch, infoChanged } = reconcileMirroredFacts(deal, info, setBrokerFact);
  if (!infoChanged && Object.keys(columnPatch).length === 0) return deal;
  return { ...deal, ...columnPatch, extractedInfo: info };
}

/**
 * PATCH /api/discrepancies/:id (resolve) → the resolved value becomes the
 * fact on file. Returns the key written, NEEDS_MAPPING (ask the broker which
 * fact), or null (nothing to write). A NEEDS_MAPPING result saves nothing.
 */
export async function applyDiscrepancyResolution(
  d: Discrepancy,
  opts: { brokerChoseFact?: boolean } = {},
): Promise<string | typeof NEEDS_MAPPING | typeof NARRATIVE_FACT | null> {
  const deal = await storage.getDeal(d.dealId);
  if (!deal) throw new FactError("Deal not found", 404);
  // Decide first without writing: a label that maps to nothing (or a
  // description the figure is only part of) must not bump the deal (or take
  // the facts lock) for a no-op.
  const info = (deal.extractedInfo as Info | null) || {};
  const probe = resolutionTarget(info, d);
  const resolved = (d.resolvedValue || "").trim();
  if (probe === NO_FACT_KEY || !resolved) return null;
  if (!probe) return NEEDS_MAPPING;
  if (!opts.brokerChoseFact && d.factKey && d.source !== "merge" && !targetRelatesToSides(info, probe, d)) return NEEDS_MAPPING;
  if (isNarrativeTarget(info, probe, resolved)) return NARRATIVE_FACT;
  return mutateDealInfo(d.dealId, (info) => applyResolutionToInfo(info, d, opts));
}
