/**
 * cim-staleness — which parts of a written CIM the facts have moved away from.
 *
 * The cover, key numbers and every section store their figures when they are
 * written. A later correction — the broker drops the asking price on the
 * Information tab, resolves a revenue discrepancy to the statement's figure,
 * adds a "keep this out of the CIM" note — changed nothing in the CIM, and
 * nothing told the broker (Lakeshore scenario, 2026-09-26: buyers kept
 * seeing $4.8M after the price went to $4.5M).
 *
 * At generation a snapshot of the facts the writer used is kept on the
 * deal's generation status (`factsAt`). Later, the current facts are
 * compared with it: each changed fact is named, and each section that still
 * shows the fact's OLD value (its figures, or its short wording) is listed
 * for the broker to regenerate. Pure except writerFactsSnapshot (one read).
 *
 * The view room also shows the cover's and key numbers' asking price from
 * the listed price at view time (shared/cim-buyer-view.ts withListedAskingPrice),
 * so a price change reaches buyers even before anything is regenerated.
 */
import { createHash } from "node:crypto";
import type { Deal } from "@shared/schema";
import { storage } from "../storage";
import { brokerFactsView } from "../information/facts";
import { listedAskingPrice } from "../information/deal-mirror";
import { factValueText } from "../information/cim-facts";
import { isFactKey } from "../interview/info-merger";
import { resolvedNotes, settleResolvedFacts } from "./resolved-block";
import { parseFigures } from "./figure-check";

/** What the writer was given, reduced to what a comparison needs. */
export interface FactsSnapshot {
  /** Fact key → its text (capped). */
  values: Record<string, string>;
  askingPrice: string | null;
  /** Fingerprint of the broker's private notes and the seller's keep-out requests. */
  notesKey: string;
}

const VALUE_CAP = 600;
/** Longer wording without figures can't be matched in a section: only a fingerprint is kept ("#…"), enough to see it changed. */
const WORDS_CAP = 80;

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** A key as a broker reads it ("annualRevenue" → "Annual revenue"). */
export function factLabel(key: string): string {
  if (key === "askingPrice") return "Asking price";
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_-]+/g, " ").trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Pure: the snapshot of a set of writer facts. */
export function factsSnapshotOf(info: Record<string, unknown>, askingPrice: string | null): FactsSnapshot {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(info)) {
    if (!isFactKey(key)) continue;
    const text = factValueText(value).trim();
    if (!text) continue;
    values[key] = /\d/.test(text) || text.length <= WORDS_CAP ? text.slice(0, VALUE_CAP) : `#${hash(text)}`;
  }
  const notes = JSON.stringify([info._brokerPrivateNotes ?? null, info._sellerKeepOut ?? null]);
  return { values, askingPrice: askingPrice?.trim() || null, notesKey: hash(notes) };
}

/**
 * A deal as the browser gets it: the facts snapshot (`cimGeneration.factsAt`,
 * up to ~600 characters per fact) stays on the server — GET /api/deals sent
 * it for every deal. Pure; returns the same object when there is nothing to drop.
 */
export function withoutFactsSnapshot<D extends { cimGeneration?: unknown }>(deal: D): D {
  const g = deal.cimGeneration as Record<string, unknown> | null | undefined;
  if (!g || typeof g !== "object" || !("factsAt" in g)) return deal;
  const { factsAt: _f, ...rest } = g;
  return { ...deal, cimGeneration: rest };
}

/** The facts the writer would be given now (the same view generation-jobs builds). */
export async function writerFactsSnapshot(deal: Deal): Promise<FactsSnapshot> {
  const settled = settleResolvedFacts(
    (brokerFactsView(deal).extractedInfo as Record<string, unknown>) || {},
    resolvedNotes(await storage.getResolvedDiscrepancies(deal.id)),
  );
  return factsSnapshotOf(settled.facts, listedAskingPrice(deal));
}

export interface FactChange {
  key: string;
  label: string;
  before: string | null;
  after: string | null;
}

export interface StaleSection {
  id: string;
  title: string;
  /** Labels of the changed facts whose old value the section still shows. */
  facts: string[];
}

export interface CimStaleness {
  changes: FactChange[];
  sections: StaleSection[];
  /** Private notes / keep-out requests changed: what they cover may be in the CIM. */
  notesChanged: boolean;
}

type SectionRef = { id: string; sectionTitle: string; layoutData?: unknown; aiDraftContent?: string | null; brokerEditedContent?: string | null; isVisible?: boolean | null };

type Fig = { value: number; pct: boolean };

/** The figures (amounts and %) a text states — not years or small counts. */
function figuresIn(text: string): Fig[] {
  return parseFigures(text)
    .filter((f) => f.kind !== "plain" || /,/.test(f.text) || Math.abs(f.value) >= 1000)
    .filter((f) => !(f.kind === "plain" && Number.isInteger(f.value) && f.value >= 1900 && f.value <= 2100 && !f.text.includes(",")))
    .map((f) => ({ value: f.value, pct: f.kind === "percent" }));
}

const sameFig = (a: Fig, b: Fig) => a.pct === b.pct && Math.abs(a.value - b.value) <= Math.max(0.5, Math.abs(a.value) * 0.0005);

/**
 * Does the section text state an OLD value of this fact — a figure the old
 * value has and the new one doesn't, or the old short wording? A fact with
 * several values (revenue by year) changes in one of them: a section showing
 * only the unchanged FY2023 revenue is not stale when FY2024 moved.
 */
function showsOld(sectionText: string, sectionFigs: Fig[], before: string, after: string | null): boolean {
  const figs = figuresIn(before);
  if (figs.length > 0) {
    const afterFigs = after && !after.startsWith("#") ? figuresIn(after) : [];
    const gone = figs.filter((v) => !afterFigs.some((a) => sameFig(a, v)));
    return gone.some((v) => sectionFigs.some((s) => sameFig(s, v)));
  }
  // Short wording ("Month-to-month", "Nisku, Alberta") — long narrative facts
  // are rewritten by the writer and can't be matched word for word.
  const t = before.trim().toLowerCase();
  if (!(t.length >= 4 && t.length <= 60 && sectionText.toLowerCase().includes(t))) return false;
  // A section that already shows the new wording (which contains the old) is up to date.
  const n = (after ?? "").trim().toLowerCase();
  return !(n && n.includes(t) && sectionText.toLowerCase().includes(n));
}

/**
 * A figure worked out from the asking price — "Asking Price / SDE 9.4×",
 * "asking price as a multiple of SDE", "3.8× FY2024 SDE", "List price per sq
 * ft". The view room shows the listed price itself, but a multiple can't be
 * recomputed there: a price change makes the section stale.
 */
const PRICE_DERIVED = /\b(?:asking|list(?:ing|ed)?)\s+price\b[^"\n]{0,40}?(?:\/|\bmultiple\b|\bper\b|\bto\s+(?:sde|ebitda|revenue|earnings))|\bprice\s*(?:\/|to)\s*(?:sde|ebitda|revenue|earnings|adjusted)|\b(?:sde|ebitda|earnings|revenue)\s+multiple\b|\bmultiple\s+of\s+(?:fy\s?\d{4}\s+)?(?:sde|ebitda|adjusted|earnings|revenue|seller)|\d(?:\.\d+)?\s*[x×]\s+(?:fy\s?\d{4}\s+)?(?:sde|ebitda|adjusted|seller|earnings|revenue)/i;

/**
 * Pure: what changed between the facts a CIM was written from and now, and
 * which sections still show an old value. A changed fact whose new value
 * the section already shows isn't reported for it.
 */
export function cimStaleness(then: FactsSnapshot | null | undefined, now: FactsSnapshot, sections: SectionRef[]): CimStaleness {
  if (!then) return { changes: [], sections: [], notesChanged: false };
  const changes: FactChange[] = [];
  const keys = new Set([...Object.keys(then.values), ...Object.keys(now.values)]);
  keys.delete("askingPrice"); // the listed price below
  for (const key of Array.from(keys)) {
    const before = then.values[key] ?? null;
    const after = now.values[key] ?? null;
    if ((before ?? "") === (after ?? "")) continue;
    // A rewording with the same figures ("$4.8M" → "$4,800,000") changes nothing a buyer reads.
    if (before && after && sameFigures(before, after)) continue;
    // A fingerprinted (long, figure-free) value is named as changed, not quoted.
    const shown = (v: string | null) => (v && v.startsWith("#") ? null : v);
    changes.push({ key, label: factLabel(key), before: shown(before), after: shown(after) });
  }
  if ((then.askingPrice ?? "") !== (now.askingPrice ?? "") && !(then.askingPrice && now.askingPrice && sameFigures(then.askingPrice, now.askingPrice))) {
    changes.unshift({ key: "askingPrice", label: "Asking price", before: then.askingPrice, after: now.askingPrice });
  }
  const stale: StaleSection[] = [];
  for (const s of sections) {
    const text = [s.sectionTitle, JSON.stringify(s.layoutData ?? {}), s.aiDraftContent ?? "", s.brokerEditedContent ?? ""].join("\n");
    const figs = figuresIn(text);
    const facts = changes
      .filter((c) => (c.before && showsOld(text, figs, c.before, c.after)) || (c.key === "askingPrice" && PRICE_DERIVED.test(text)))
      .map((c) => c.label);
    if (facts.length > 0) stale.push({ id: s.id, title: s.sectionTitle, facts: Array.from(new Set(facts)) });
  }
  return { changes, sections: stale, notesChanged: then.notesKey !== now.notesKey };
}

/** Two wordings of the same figures ("$4.8M" → "$4,800,000") are not a change a section needs. */
function sameFigures(a: string, b: string): boolean {
  const fa = figuresIn(a), fb = figuresIn(b);
  return fa.length > 0 && fa.length === fb.length && fa.every((v, i) => sameFig(v, fb[i]));
}
