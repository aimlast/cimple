/**
 * The deal's facts exactly as the seller interview may read them — ONE view,
 * used both to build the agent's prompt (assembleKnowledgeBase) and as the
 * baseline an interview turn merges against (processTurn), so what counts as
 * "already on file" / "a change" is always what the agent was shown.
 *
 * Left out of the view (never in the agent's prompt, so never said, quoted or
 * alluded to — and never counted as answered):
 *   - anything a broker-only source asserted: the broker's CRM notes, private
 *     emails and files (documents.visibility = 'broker_only') — facts,
 *     alternates, corroborations, years of a map fact, private notes. A CRM
 *     source whose row is gone is treated as broker-only too. Where another
 *     (seller-side) source stated a value for the same fact, that value is
 *     shown instead; otherwise the fact is simply not on the interview's file
 *     and the agent asks the seller openly.
 *   - the broker's listed asking price from the deal row (see
 *     interviewFactView): the seller's own expectation is shown instead.
 *   - broker-private notes that only a broker-only source states.
 *
 * Read-only: never save the result.
 */
import type { Document } from "@shared/schema";
import { interviewFactView } from "../information/deal-mirror";
import {
  getFieldSources,
  getFieldAlternates,
  getFieldCorroborations,
  getPrivateNotes,
  privateNoteSources,
  parseAlternateValue,
  repairCharIndexedValue,
  sourceRank,
  isRowBackedSource,
  FIELD_SOURCES_KEY,
  FIELD_ALTERNATES_KEY,
  FIELD_CORROBORATIONS_KEY,
  BROKER_PRIVATE_NOTES_KEY,
  type FieldAlternate,
  type FieldSource,
  type PrivateNoteSource,
} from "./info-merger";

type Info = Record<string, unknown>;
type DocLike = Pick<Document, "id" | "visibility">;

/** Decides, for one deal, whether a source entry is broker-private. */
export function brokerPrivacy(documents: DocLike[]) {
  const visibility = new Map(documents.map((d) => [d.id, d.visibility]));
  /** A value asserted by a broker-only row (or a CRM row that no longer exists). */
  const isPrivateSource = (src: Partial<FieldSource> | null | undefined): boolean => {
    if (!src) return false;
    if (src.documentId && visibility.get(src.documentId) === "broker_only") return true;
    // CRM material is the broker's by default; one whose row is gone can't
    // be shown to have been shared.
    return src.source === "crm" && (!src.documentId || !visibility.has(src.documentId));
  };
  /** A private-note source the agent may hold: the seller in a session, or a shared row that exists. */
  const isSellerSideNoteSource = (s: PrivateNoteSource): boolean => {
    if (s.brokerOnly) return false;
    if (!s.documentId) return true;
    const vis = visibility.get(s.documentId);
    return vis !== undefined && vis !== "broker_only";
  };
  return { isPrivateSource, isSellerSideNoteSource };
}

const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

// Words that make up fallback source titles ("Email", "CRM note", "Pipedrive
// activity", "Call notes") — a title made only of these names no particular
// source, so finding the word in a value proves nothing.
const GENERIC_TITLE_WORDS = new Set([
  "email", "emails", "e", "mail", "crm", "note", "notes", "call", "calls", "activity", "activities", "record", "records",
  "pipedrive", "hubspot", "salesforce", "deal", "person", "organization", "organisation", "org", "document", "documents",
  "doc", "file", "files", "untitled", "memo", "transcript", "message", "messages", "thread", "private", "broker", "meeting",
  "source", "text", "pasted", "upload", "uploaded", "re", "fwd", "fw", "from", "the", "a", "an", "and", "with", "of", "to", "on",
]);

/**
 * Does a discrepancy side's text name a broker-only source? Financial-analysis
 * values carry their source's name as a label ("$1.6M — CRM note — call
 * with owner"), so a side is private when it names a broker-only row.
 *  - A distinctive title (any word beyond the generic ones, 4+ characters)
 *    counts wherever it appears as whole words.
 *  - A generic title ("Email", "CRM note") counts only when it IS the side's
 *    source label ("… — Email"), never because the value mentions the word
 *    ("Revenue from email campaigns — 2024 P&L" is not private).
 */
export function privateSourceMatcher(documents: Array<Pick<Document, "visibility"> & { name?: string | null }>) {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, " ").trim();
  const distinctive: string[] = [];
  const generic: string[] = [];
  for (const doc of documents) {
    if (doc.visibility !== "broker_only") continue;
    const name = norm(doc.name || "");
    if (!name) continue;
    const words = name.split(/[^a-z0-9à-ÿ]+/).filter(Boolean);
    if (name.length >= 4 && words.some((w) => !GENERIC_TITLE_WORDS.has(w))) distinctive.push(name);
    else generic.push(name);
  }
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const distinctiveRes = distinctive.map((n) => new RegExp(`(^|[^a-z0-9à-ÿ])${escape(n)}($|[^a-z0-9à-ÿ])`, "i"));
  return (text: string | null | undefined): boolean => {
    if (!text) return false;
    const t = norm(text);
    if (distinctiveRes.some((re) => re.test(t))) return true;
    return generic.some((n) => t === n || t.endsWith(` — ${n}`) || t.endsWith(` - ${n}`) || t.endsWith(` – ${n}`) || t.endsWith(`(${n})`));
  };
}

/** Best alternate for `altKey`: highest-ranked source, then newest. */
function bestAlternate(list: FieldAlternate[] | undefined): FieldAlternate | undefined {
  return (list ?? [])
    .filter((a) => a && typeof a.value === "string" && a.value.trim() !== "")
    .sort((a, b) => sourceRank(b.source) - sourceRank(a.source) || String(b.at ?? "").localeCompare(String(a.at ?? "")))[0];
}

export function sellerInterviewView<T extends Info>(info: T, documents: DocLike[]): T {
  const { isPrivateSource, isSellerSideNoteSource } = brokerPrivacy(documents);
  const out: Info = { ...info };

  // 1. Other values on file (alternates, corroborations): broker-only ones
  //    go first, so nothing below can promote one into view.
  const cleanList = (raw: unknown): Record<string, FieldAlternate[]> => {
    const kept: Record<string, FieldAlternate[]> = {};
    if (!isMap(raw)) return kept;
    for (const [k, list] of Object.entries(raw)) {
      const ok = (Array.isArray(list) ? list : []).filter((a) => a && !isPrivateSource(a as FieldAlternate)) as FieldAlternate[];
      if (ok.length > 0) kept[k] = ok;
    }
    return kept;
  };
  const alternates = cleanList(getFieldAlternates(info));
  if (info[FIELD_ALTERNATES_KEY] !== undefined) out[FIELD_ALTERNATES_KEY] = alternates;
  const corroborations = cleanList(getFieldCorroborations(info));
  if (Object.keys(corroborations).length > 0) out[FIELD_CORROBORATIONS_KEY] = corroborations;
  else delete out[FIELD_CORROBORATIONS_KEY];

  // 2. Broker-private notes: only those a seller-side source states, credited to it.
  if (Array.isArray(info[BROKER_PRIVATE_NOTES_KEY])) {
    const safe = getPrivateNotes(info).flatMap((n) => {
      const src = privateNoteSources(n).find(isSellerSideNoteSource);
      return src ? [{ note: n.note, ...src }] : [];
    });
    if (safe.length > 0) out[BROKER_PRIVATE_NOTES_KEY] = safe;
    else delete out[BROKER_PRIVATE_NOTES_KEY];
  }

  // 3. The broker's deal-row asking price → the best seller-side value.
  const viewed: Info = interviewFactView(out);
  const sources: Record<string, FieldSource> = { ...getFieldSources(viewed) };
  const alts: Record<string, FieldAlternate[]> = { ...getFieldAlternates(viewed) };

  // 4. Facts a broker-only source asserted → the best seller-side value, or gone.
  for (const key of Object.keys(viewed)) {
    if (key.startsWith("_")) continue;
    const src = sources[key];
    const value = repairCharIndexedValue(viewed[key]);
    if (src?.years && isMap(value)) {
      // Map fact (revenue by year): each year belongs to its contributor.
      const map = { ...value };
      const years = { ...src.years };
      let changed = false;
      for (const y of Object.keys(map)) {
        const contributor = years[y] ?? (isRowBackedSource(src) ? src.documentId : undefined);
        const privateYear = contributor
          ? isPrivateSource({ source: src.source, documentId: contributor })
          : isPrivateSource(src);
        if (!privateYear) continue;
        changed = true;
        delete years[y];
        const alt = bestAlternate(alts[`${key}.${y}`]);
        if (alt) map[y] = parseAlternateValue(alt.value);
        else delete map[y];
      }
      if (!changed) continue;
      if (Object.keys(map).length === 0) {
        delete viewed[key];
        delete sources[key];
        continue;
      }
      viewed[key] = map;
      const next: FieldSource = { ...src, years };
      if (Object.keys(years).length === 0) delete next.years;
      if (isPrivateSource(src)) delete next.documentId;
      sources[key] = next;
      continue;
    }
    if (!isPrivateSource(src)) continue;
    const alt = bestAlternate(alts[key]);
    if (alt) {
      const { value: altValue, ...altSrc } = alt;
      viewed[key] = parseAlternateValue(altValue);
      sources[key] = altSrc as FieldSource;
      const rest = (alts[key] ?? []).filter((a) => a !== alt);
      if (rest.length > 0) alts[key] = rest;
      else delete alts[key];
    } else {
      delete viewed[key];
      delete sources[key];
    }
  }
  viewed[FIELD_SOURCES_KEY] = sources;
  if (viewed[FIELD_ALTERNATES_KEY] !== undefined || Object.keys(alts).length > 0) viewed[FIELD_ALTERNATES_KEY] = alts;
  return viewed as T;
}
