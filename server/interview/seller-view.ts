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
 *   - the broker's own normalisation work written as a fact (SDE, adjusted
 *     EBITDA, add-backs, a recast, valuation / multiple talk — see
 *     source-privacy.ts screenBrokerWork): a value the broker wrote under
 *     such a key, or the clauses (sub-clauses) of a narrative fact that say
 *     it. The seller's own words are never screened; a value recorded before
 *     sources were tracked loses only what cites the broker's material.
 *   - a fact the broker resolved to a private source's figure
 *     (FieldSource.hiddenFromSeller).
 *
 * A value the BROKER settled that can't be shown is never replaced by a
 * value the broker superseded (that told the agent a contradicted deal
 * structure was settled): the key is listed under HELD_BY_BROKER_KEY
 * instead, and the interview treats it as settled by the broker — nothing
 * to quote, nothing to ask (see withHeldFacts / knowledge-base.ts).
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
  resolvedYearSources,
  summariseMapSource,
  sourceRowLookup,
  FIELD_SOURCES_KEY,
  FIELD_ALTERNATES_KEY,
  FIELD_CORROBORATIONS_KEY,
  BROKER_PRIVATE_NOTES_KEY,
  type FieldAlternate,
  type FieldSource,
  type PrivateNoteSource,
} from "./info-merger";
import { screenBrokerWork, isBrokerWorkText, isBrokerSettledSource } from "./source-privacy";

type Info = Record<string, unknown>;
type DocLike = Pick<Document, "id" | "visibility">;

/** Decides, for one deal, whether a source entry is broker-private. */
export function brokerPrivacy(documents: DocLike[]) {
  const visibility = new Map(documents.map((d) => [d.id, d.visibility]));
  /** A value asserted by a broker-only row (or a CRM row that no longer exists). */
  const isPrivateSource = (src: Partial<FieldSource> | null | undefined): boolean => {
    if (!src) return false;
    if (src.brokerOnly === true) return true;
    // The broker's figure taken from their private material (a resolution
    // to a CRM note's value) — private like the source it came from.
    if (src.hiddenFromSeller === true) return true;
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
export function privateSourceMatcher(
  documents: Array<Pick<Document, "visibility"> & { name?: string | null }>,
  /** Free text with no source label (an explanation): only a distinctive title counts. */
  opts: { distinctiveOnly?: boolean } = {},
) {
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
  const genericRes = generic.map((n) => new RegExp(`(^|[^a-z0-9à-ÿ])${escape(n)}($|[^a-z0-9à-ÿ])`, "i"));
  return (text: string | null | undefined): boolean => {
    if (!text) return false;
    const t = norm(text);
    if (distinctiveRes.some((re) => re.test(t))) return true;
    if (opts.distinctiveOnly) return false;
    // A generic title ("Email", "CRM note") is judged on the side's SOURCE
    // label — the part after the last " — " ("$1.6M — Email (Mar 3)") — so
    // "email campaigns" in a value doesn't hide it. With no source label the
    // whole text is checked: when in doubt the value is hidden, never shown.
    const parts = t.split(/\s[—–-]\s/);
    const label = parts.length > 1 ? parts[parts.length - 1] : t;
    return genericRes.some((re) => re.test(label));
  };
}

/** Note on the values a discrepancy resolution ruled out (server/information/facts.ts). */
const RULED_OUT_NOTE = "Conflicting value (discrepancy)";

/**
 * Best alternate for `altKey`: highest-ranked source, then newest. A value
 * the broker ruled out when settling a discrepancy is never promoted: when
 * the broker settled on their own private figure, the fact is simply not on
 * the interview's file (the knowledge base says it is settled).
 */
function bestAlternate(list: FieldAlternate[] | undefined): FieldAlternate | undefined {
  return (list ?? [])
    .filter((a) => a && typeof a.value === "string" && a.value.trim() !== "" && a.note !== RULED_OUT_NOTE)
    .sort((a, b) => sourceRank(b.source) - sourceRank(a.source) || String(b.at ?? "").localeCompare(String(a.at ?? "")))[0];
}

/**
 * View-only key: facts (or "key (year)" entries of a map fact) the broker
 * settled whose value the interview may not see. Never saved.
 */
export const HELD_BY_BROKER_KEY = "_heldByBroker";
/** What a held fact reads as wherever "is it on file?" is asked (coverage, the re-ask guard). */
export const HELD_BY_BROKER_VALUE = "(on file — settled by the broker)";

/** The view's held entries ("saleType", "sdeByYear (2024)"). */
export function heldByBroker(view: Record<string, unknown>): string[] {
  const v = view[HELD_BY_BROKER_KEY];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

/**
 * The view with every fully held fact present as HELD_BY_BROKER_VALUE (the
 * broker's source) — for the questions "is this on file?" (section
 * coverage, the re-ask guard), so a fact the broker settled is never
 * treated as a gap to ask about. Not for anything that quotes values.
 */
export function withHeldFacts<T extends Record<string, unknown>>(view: T): T {
  const held = heldByBroker(view).filter((k) => !k.includes(" ("));
  if (held.length === 0) return view;
  const out: Record<string, unknown> = { ...view };
  const sources: Record<string, FieldSource> = { ...getFieldSources(view) };
  for (const k of held) {
    if (out[k] === undefined) out[k] = HELD_BY_BROKER_VALUE;
    if (!sources[k]) sources[k] = { source: "broker" } as FieldSource;
  }
  out[FIELD_SOURCES_KEY] = sources;
  return out as T;
}

export function sellerInterviewView<T extends Info>(info: T, documents: DocLike[]): T {
  const { isPrivateSource, isSellerSideNoteSource } = brokerPrivacy(documents);
  const lookup = sourceRowLookup(documents);
  const out: Info = { ...info };

  // 1. Other values on file (alternates, corroborations): broker-only ones
  //    go first, so nothing below can promote one into view.
  const cleanList = (raw: unknown): Record<string, FieldAlternate[]> => {
    const kept: Record<string, FieldAlternate[]> = {};
    if (!isMap(raw)) return kept;
    for (const [k, list] of Object.entries(raw)) {
      const ok = (Array.isArray(list) ? list : []).flatMap((a): FieldAlternate[] => {
        if (!a || isPrivateSource(a as FieldAlternate)) return [];
        // The broker's normalisation work as another value (an SDE the
        // broker typed) goes too; a narrative keeps its other clauses.
        const screened = screenBrokerWork(k, (a as FieldAlternate).value, a as FieldAlternate);
        if (screened.kind === "private") return [];
        return [screened.kind === "redacted" ? { ...(a as FieldAlternate), value: screened.value } : (a as FieldAlternate)];
      });
      if (ok.length > 0) kept[k] = ok;
    }
    return kept;
  };
  const alternates = cleanList(getFieldAlternates(info));
  if (info[FIELD_ALTERNATES_KEY] !== undefined) out[FIELD_ALTERNATES_KEY] = alternates;
  const corroborations = cleanList(getFieldCorroborations(info));
  if (Object.keys(corroborations).length > 0) out[FIELD_CORROBORATIONS_KEY] = corroborations;
  else delete out[FIELD_CORROBORATIONS_KEY];

  // 2. Broker-private notes: only those a seller-side source states, credited
  //    to it and in ITS words — a note consolidated from several sources
  //    (private-notes-review.ts) may carry a broker-only source's detail.
  if (Array.isArray(info[BROKER_PRIVATE_NOTES_KEY])) {
    const safe = getPrivateNotes(info).flatMap((n) => {
      const src = privateNoteSources(n).find(isSellerSideNoteSource);
      if (!src) return [];
      // (A note about the broker's normalisation work — "Morgan plans a
      // recast", "compensation add-back mentioned" — isn't the seller's
      // sensitive fact; it only invites add-back talk. Judged on the words
      // the interview would actually read: the seller-side source's own.)
      const shown = src.wording ?? n.note;
      if (isBrokerWorkText(shown)) return [];
      return [{ ...src, note: shown }];
    });
    if (safe.length > 0) out[BROKER_PRIVATE_NOTES_KEY] = safe;
    else delete out[BROKER_PRIVATE_NOTES_KEY];
  }

  // 3. The broker's deal-row asking price → the best seller-side value.
  const viewed: Info = interviewFactView(out);
  const sources: Record<string, FieldSource> = { ...getFieldSources(viewed) };
  const alts: Record<string, FieldAlternate[]> = { ...getFieldAlternates(viewed) };

  // 4. Facts a broker-only source asserted → the best seller-side value, or
  //    gone; facts the broker settled that can't be shown → held.
  const held: string[] = [];
  const hold = (key: string) => {
    held.push(key);
    // (Its other values are what the broker settled against — not shown.)
    for (const k of Object.keys(alts)) if (k === key || k.startsWith(`${key}.`)) delete alts[k];
    const corr = viewed[FIELD_CORROBORATIONS_KEY];
    if (isMap(corr) && corr[key] !== undefined) {
      const { [key]: _gone, ...restCorr } = corr as Record<string, unknown>;
      viewed[FIELD_CORROBORATIONS_KEY] = restCorr;
    }
  };
  for (const key of Object.keys(viewed)) {
    if (key.startsWith("_")) continue;
    const src = sources[key];
    const value = repairCharIndexedValue(viewed[key]);
    if (src?.years && isMap(value)) {
      // Map fact (revenue by year): each year belongs to its contributor.
      const map = { ...value };
      // Each year read through its own source (info-merger yearSource): a
      // broker-only / CRM year inside a map of statement figures is private.
      const years = resolvedYearSources(src, map, lookup);
      let changed = false;
      const heldYears: string[] = [];
      for (const y of Object.keys(map)) {
        const ys = years[y];
        const privateYear = isPrivateSource(ys);
        const screened = privateYear ? null : screenBrokerWork(key, map[y], ys);
        if (screened?.kind === "keep") continue;
        changed = true;
        if (screened?.kind === "redacted") {
          map[y] = screened.value;
          continue;
        }
        delete years[y];
        // A year the broker settled stays settled — never a value the
        // broker replaced (see HELD_BY_BROKER_KEY).
        if (!privateYear || isBrokerSettledSource(ys)) {
          heldYears.push(y);
          delete map[y];
          delete alts[`${key}.${y}`];
          continue;
        }
        const alt = bestAlternate(alts[`${key}.${y}`]);
        if (alt) {
          map[y] = parseAlternateValue(alt.value);
          const { value: _v, ...altSrc } = alt;
          years[y] = altSrc as FieldSource;
        } else delete map[y];
      }
      if (!changed) continue;
      if (Object.keys(map).length === 0) {
        delete viewed[key];
        delete sources[key];
        if (heldYears.length > 0) hold(key);
        continue;
      }
      for (const y of heldYears) held.push(`${key} (${y})`);
      viewed[key] = map;
      sources[key] = summariseMapSource(years) ?? { ...src };
      continue;
    }
    const privateSrc = isPrivateSource(src);
    if (!privateSrc) {
      // The broker's normalisation work: a whole fact under an SDE /
      // add-back / recast key, or only the (sub-)clauses of a narrative
      // that say it.
      const screened = screenBrokerWork(key, value, src);
      if (screened.kind === "keep") continue;
      if (screened.kind === "redacted") {
        viewed[key] = screened.value;
        continue;
      }
    }
    // A value the broker settled (typed, or resolved to a private side's
    // figure) — or one wholly the broker's work — is held: never replaced by
    // a value the broker superseded ("Asset sale implied" from an early call
    // in place of the broker's "Share sale").
    if (!privateSrc || isBrokerSettledSource(src)) {
      delete viewed[key];
      delete sources[key];
      hold(key);
      continue;
    }
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
  if (held.length > 0) viewed[HELD_BY_BROKER_KEY] = held;
  else delete viewed[HELD_BY_BROKER_KEY];
  return viewed as T;
}
