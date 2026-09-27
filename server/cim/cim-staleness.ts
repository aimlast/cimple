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

/** Does the section text state this value (the same figure, or the same short wording)? */
function shows(sectionText: string, sectionFigs: Fig[], before: string): boolean {
  const figs = figuresIn(before);
  if (figs.length > 0) return figs.some((v) => sectionFigs.some((s) => sameFig(s, v)));
  // Short wording ("Month-to-month", "Nisku, Alberta") — long narrative facts
  // are rewritten by the writer and can't be matched word for word.
  const t = before.trim().toLowerCase();
  return t.length >= 4 && t.length <= 60 && sectionText.toLowerCase().includes(t);
}

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
    const facts = changes.filter((c) => c.before && shows(text, figs, c.before)).map((c) => c.label);
    if (facts.length > 0) stale.push({ id: s.id, title: s.sectionTitle, facts: Array.from(new Set(facts)) });
  }
  return { changes, sections: stale, notesChanged: then.notesKey !== now.notesKey };
}

/** Two wordings of the same figures ("$4.8M" → "$4,800,000") are not a change a section needs. */
function sameFigures(a: string, b: string): boolean {
  const fa = figuresIn(a), fb = figuresIn(b);
  return fa.length > 0 && fa.length === fb.length && fa.every((v, i) => sameFig(v, fb[i]));
}
