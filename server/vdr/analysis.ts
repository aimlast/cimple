/**
 * What Cimple knows about a room document (vdr spec §9.6). No AI.
 *
 * Pass 2 ships `privateMattersFor` (the §4.9 "Private matters" flag, broker
 * only): a fact from this document that Cimple kept OUT of the CIM — a note
 * routed to the broker's private notes, or a staff-private matter held back
 * whose source is this document. The broker must tick "I've checked it"
 * before sharing such a document. (Cimple's notes — key figures, CIM links,
 * checks — arrive with the drawer's notes in pass 3.)
 */
import type { Deal } from "@shared/schema";
import { heldPrivateForDeal } from "../cim/held-private";

type Info = Record<string, unknown>;

function noteSources(n: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (typeof n.documentId === "string") out.push(n.documentId);
  if (Array.isArray(n.alsoFrom)) for (const s of n.alsoFrom) if (s && typeof (s as Record<string, unknown>).documentId === "string") out.push((s as Record<string, string>).documentId);
  return out;
}

function short(s: string, n = 90): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}

/** The documents a fact came from (its source, any year's source). */
function factDocuments(info: Info, key: string): Set<string> {
  const out = new Set<string>();
  const src = ((info._fieldSources ?? {}) as Record<string, Record<string, unknown>>)[key];
  if (!src) return out;
  if (typeof src.documentId === "string") out.add(src.documentId);
  const years = src.years as Record<string, unknown> | undefined;
  if (years && typeof years === "object") {
    for (const y of Object.values(years)) {
      if (typeof y === "string") out.add(y);
      else if (y && typeof (y as Record<string, unknown>).documentId === "string") out.add((y as Record<string, string>).documentId);
    }
  }
  return out;
}

/** Every listed document's private matters, read once (the held-private screen runs once per call). Never throws. */
export function privateMattersByDocument(deal: Deal, documentIds: ReadonlyArray<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (documentIds.length === 0) return map;
  const wanted = new Set(documentIds);
  const add = (id: string, text: string) => {
    if (!wanted.has(id)) return;
    const list = map.get(id) ?? [];
    if (!list.includes(text) && list.length < 5) list.push(text);
    map.set(id, list);
  };
  try {
    const info = ((deal.extractedInfo ?? {}) as Info) || {};
    const notes = Array.isArray(info._brokerPrivateNotes) ? (info._brokerPrivateNotes as Array<Record<string, unknown>>) : [];
    for (const n of notes) {
      if (typeof n?.note !== "string") continue;
      for (const id of noteSources(n)) add(id, short(n.note));
    }
    for (const held of heldPrivateForDeal(deal)) {
      if (held.included) continue;
      for (const id of Array.from(factDocuments(info, held.key))) add(id, short(held.description || held.label || held.text));
    }
  } catch (err: any) {
    console.warn(`[vdr] private matters couldn't be read for deal ${deal.id}:`, err?.message ?? err);
  }
  return map;
}

/** Short broker-only descriptions of what Cimple kept out of the CIM from one document. */
export function privateMattersFor(deal: Deal, documentId: string): string[] {
  return privateMattersByDocument(deal, [documentId]).get(documentId) ?? [];
}
