/**
 * What Cimple knows about a room document (vdr spec §9.6). No AI.
 *
 *  - privateMattersFor (pass 2): the §4.9 "Private matters" flag, broker
 *    only — a fact from this document Cimple kept OUT of the CIM.
 *  - documentFacts: the facts whose recorded source is this document (a
 *    year of a by-year map counts only for the years it stated).
 *  - buyerKeyFigures: the same, screened for buyers — only facts the CIM
 *    may use (cimSafeFacts: no broker-only source), minus personal details,
 *    staff-private matters and confidentiality holds (screenFactsForCim with
 *    the rules-only keep-out — opening a document never calls the AI), minus
 *    anything naming a held person; figures only, at most 6.
 *  - documentCimLinks: CIM pages that print this document's figures.
 *  - brokerChecks: what it was checked against — dd's checks when the dd
 *    stream is merged, else the discrepancies involving it, plus other
 *    documents that state the same figure.
 */
import type { BuyerQuestion, Deal, Discrepancy, Document } from "@shared/schema";
import { collectStrings } from "@shared/blind-guard";
import { heldPrivateForDeal } from "../cim/held-private";
import { isKnownFigure, knownFiguresFrom, parseFigures, type Figure } from "../cim/figure-check";
import { cimSafeFacts } from "../information/cim-facts";
import { hasSensitiveDetail, keepOutFromNotes, mentionsHeldPerson, screenFactsForCim } from "../cim/sensitive-facts";
import { yearSource, type FieldSource } from "../interview/info-merger";

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

// ── Facts from one document ────────────────────────────────────────────────

export type DocFact = { key: string; label: string; value: unknown; text: string };

/** "otherCurrentAssets" → "Other current assets". */
export function factLabel(key: string): string {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .toLowerCase()
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A value as one line: year maps newest first ("2024: $1.9M · 2023: $1.7M"). */
export function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.replace(/\s+/g, " ").trim();
  if (typeof v === "number") return Number.isInteger(v) && Math.abs(v) >= 1000 ? v.toLocaleString("en-US") : String(v);
  if (typeof v === "boolean") return v ? "Yes" : "No";
  if (Array.isArray(v)) return v.map(valueText).filter(Boolean).join(", ");
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    entries.sort(([a], [b]) => (/^\d{4}$/.test(a) && /^\d{4}$/.test(b) ? Number(b) - Number(a) : a.localeCompare(b)));
    return entries.map(([k, x]) => `${k}: ${valueText(x)}`).join(" · ");
  }
  return String(v);
}

/** The facts whose recorded source is this document (§9.6). */
export function documentFacts(info: Info | null | undefined, documentId: string): DocFact[] {
  if (!info) return [];
  const sources = (info._fieldSources ?? {}) as Record<string, FieldSource>;
  const out: DocFact[] = [];
  for (const [key, value] of Object.entries(info)) {
    if (key.startsWith("_") || value === null || value === undefined || value === "") continue;
    const src = sources[key];
    if (!src) continue;
    if (src.years && value && typeof value === "object" && !Array.isArray(value)) {
      const sub: Record<string, unknown> = {};
      for (const [y, v] of Object.entries(value as Record<string, unknown>)) {
        if (yearSource(src, y)?.documentId === documentId) sub[y] = v;
      }
      if (Object.keys(sub).length > 0) out.push({ key, label: factLabel(key), value: sub, text: valueText(sub) });
      continue;
    }
    if (src.documentId === documentId) out.push({ key, label: factLabel(key), value, text: valueText(value) });
  }
  return out;
}

/** Figures worth matching: money and percentages, and amounts (not years or small counts). */
function strongFigures(text: string): Figure[] {
  return parseFigures(text).filter((f) => {
    if (f.kind === "percent") return f.value !== 0;
    if (Number.isInteger(f.value) && f.value >= 1900 && f.value <= 2100 && !f.text.includes(",") && f.kind === "plain") return false;
    return Math.abs(f.value) >= 1000;
  });
}

const hasFigure = (text: string) => strongFigures(text).length > 0 || /\b\d[\d,.]*\b/.test(text);

/** Identifiers that look like numbers (a business number, a NAICS code, a phone) are never "figures". */
const IDENTIFIER_KEY = /number|code|naics|phone|postal|zip|fax|licen[cs]e|registration|account|sin\b|bn\b|\bid$/i;

/** 29,180,000 → 4 ("2918"); 200,000 → 1; 56,023 → 5. */
function significantDigits(v: number): number {
  return String(Math.round(Math.abs(v))).replace(/0+$/, "").length;
}

const HEADLINE = [/revenue|sales/i, /net income|net earnings|profit/i, /ebitda|sde|earnings/i, /gross (profit|margin)/i, /taxable income/i, /total assets|equity/i, /cash/i, /debt|loan/i];
/** Headline figures first (revenue, net income, EBITDA…), then other money, then counts, then the rest. */
export function keyFigureRank(f: { key: string; text: string }): number {
  const h = HEADLINE.findIndex((re) => re.test(f.key.replace(/([a-z])([A-Z])/g, "$1 $2")));
  const money = /\$\s?\d/.test(f.text);
  if (h >= 0 && money) return h;
  if (money) return 20;
  if (strongFigures(f.text).length > 0) return 30;
  if (/\d/.test(f.text)) return 40;
  return 50;
}
const figureRank = keyFigureRank;

/** The names a buyer-facing text must never mention: held parties and staff with a private matter. */
export function heldNamesFor(deal: Pick<Deal, "id" | "extractedInfo" | "cimGeneration">): string[] {
  const info = ((deal.extractedInfo ?? {}) as Info) || {};
  const names = new Set<string>(keepOutFromNotes(info).names ?? []);
  try {
    for (const h of heldPrivateForDeal(deal as Deal)) if (!h.included && h.person) names.add(h.person);
  } catch { /* the rules-only names still hold */ }
  return Array.from(names);
}

/**
 * The buyer-safe key figures of a document (§9.6): at most 6 short facts
 * with a figure, never from a broker-only source, never a held or sensitive
 * clause, never naming a held person.
 */
export function buyerKeyFigures(deal: Pick<Deal, "id" | "extractedInfo" | "cimGeneration">, documentId: string, brokerOnlyDocIds: ReadonlySet<string> = new Set()): Array<{ label: string; value: string }> {
  return buyerSafeFacts(deal, documentId, brokerOnlyDocIds, { figuresOnly: true, limit: 6, maxLen: 160 });
}

/** A document's facts screened for buyers (and for the description model's input, ≤ 25). */
export function buyerSafeFacts(
  deal: Pick<Deal, "id" | "extractedInfo" | "cimGeneration">,
  documentId: string,
  brokerOnlyDocIds: ReadonlySet<string>,
  opts: { figuresOnly: boolean; limit: number; maxLen: number },
): Array<{ label: string; value: string }> {
  try {
    const info = ((deal.extractedInfo ?? {}) as Info) || {};
    const facts = documentFacts(info, documentId);
    if (facts.length === 0) return [];
    const safe = cimSafeFacts(info, { brokerOnlyDocIds });
    const pairs = Object.entries(safe).filter(([k]) => !k.startsWith("_"));
    const screened = screenFactsForCim(pairs, keepOutFromNotes(info));
    const safeByKey = new Map(screened.safe);
    const held = new Set<string>(screened.heldNames);
    for (const h of heldPrivateForDeal(deal as Deal)) {
      if (h.included) continue;
      if (h.person) held.add(h.person);
    }
    const heldKeys = new Set(heldPrivateForDeal(deal as Deal).filter((h) => !h.included).map((h) => h.key));
    const heldNames = Array.from(held);
    const out: DocFact[] = [];
    for (const f of facts) {
      if (!safeByKey.has(f.key) || heldKeys.has(f.key)) continue;
      const v = safeByKey.get(f.key);
      // The safe value may have lost years / clauses: keep only this document's part of it.
      let value: unknown = v;
      if (f.value && typeof f.value === "object" && !Array.isArray(f.value) && v && typeof v === "object" && !Array.isArray(v)) {
        const sub: Record<string, unknown> = {};
        for (const y of Object.keys(f.value as Record<string, unknown>)) if (y in (v as Record<string, unknown>)) sub[y] = (v as Record<string, unknown>)[y];
        if (Object.keys(sub).length === 0) continue;
        value = sub;
      }
      const text = valueText(value);
      if (!text || text.length > opts.maxLen || (opts.figuresOnly && !hasFigure(text))) continue;
      if (hasSensitiveDetail(text) || mentionsHeldPerson(`${f.label} ${text}`, heldNames)) continue;
      out.push({ ...f, value, text });
    }
    return out.sort((a, b) => figureRank(a) - figureRank(b)).slice(0, opts.limit).map((f) => ({ label: f.label, value: f.text }));
  } catch (err: any) {
    console.warn(`[vdr] key figures couldn't be read for document ${documentId}:`, err?.message ?? err);
    return [];
  }
}

// ── Where the CIM uses a document ──────────────────────────────────────────

export type SectionText = { id: string; title: string; text: string };

/** A CIM section's words and figures, for matching (prose + layout data). */
export function sectionText(s: { id: string; sectionTitle: string; brokerEditedContent?: string | null; aiDraftContent?: string | null; layoutData?: unknown }): SectionText {
  const body = [s.brokerEditedContent || s.aiDraftContent || "", ...collectStrings(s.layoutData ?? null)].join("\n");
  return { id: s.id, title: s.sectionTitle, text: body.replace(/\[\[\/?dd\]\]/g, "") };
}

/**
 * CIM pages that print one of this document's figures (§9.6): up to 4,
 * most matches first; a page needs a distinctive amount ($56,023 — not a
 * round $200,000) or two of the document's facts, so a stray "45%" or a
 * round number never links a page.
 */
export function documentCimLinks(facts: ReadonlyArray<DocFact>, sections: ReadonlyArray<SectionText>): { links: Array<{ sectionId: string; title: string; matches: number }>; inCim: Set<string> } {
  const byFact = facts.filter((f) => !IDENTIFIER_KEY.test(f.key)).map((f) => ({ key: f.key, figures: strongFigures(f.text) })).filter((x) => x.figures.length > 0);
  const inCim = new Set<string>();
  const links: Array<{ sectionId: string; title: string; matches: number }> = [];
  if (byFact.length === 0) return { links, inCim };
  for (const s of sections) {
    const known = knownFiguresFrom(s.text);
    let matches = 0;
    let big = false;
    for (const f of byFact) {
      const hit = f.figures.filter((fig) => isKnownFigure(fig, known));
      if (hit.length > 0) {
        // Percentages and round amounts are common on any page: they never link a page on their own.
        if (hit.some((h) => h.kind !== "percent")) matches += 1;
        inCim.add(f.key);
        // A distinctive amount ($56,023 — not a round $200,000 that any page might print) links on its own.
        if (hit.some((h) => h.kind !== "percent" && Math.abs(h.value) >= 10_000 && significantDigits(h.value) >= 3)) big = true;
      }
    }
    if (big || matches >= 2) links.push({ sectionId: s.id, title: s.title, matches });
  }
  return { links: links.sort((a, b) => b.matches - a.matches).slice(0, 4), inCim };
}

// ── Checks (broker) ─────────────────────────────────────────────────────────

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (d: Date | string | null | undefined) => {
  if (!d) return "";
  const x = new Date(d);
  return `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}`;
};

function sideDocIds(d: Discrepancy): string[] {
  const out: string[] = [];
  if (d.documentId) out.push(d.documentId);
  const sides = (d.sideSources ?? {}) as Record<string, { documentId?: string } | undefined>;
  for (const s of Object.values(sides)) if (s && typeof s.documentId === "string") out.push(s.documentId);
  return out;
}

/**
 * What a document was checked against, for the broker (§5.4): differences
 * involving it (resolved: with the recorded reason; open: a pointer to the
 * Financials tab) and other documents that state the same figure.
 */
export function brokerChecks(
  doc: Pick<Document, "id" | "name">,
  facts: ReadonlyArray<DocFact>,
  discrepancies: ReadonlyArray<Discrepancy>,
  otherDocs: ReadonlyArray<Pick<Document, "id" | "name" | "extractedData" | "visibility">>,
): Array<{ tone: "match" | "resolved" | "open"; text: string }> {
  const out: Array<{ tone: "match" | "resolved" | "open"; text: string }> = [];
  for (const d of discrepancies) {
    if (d.status === "superseded" || !sideDocIds(d).includes(doc.id)) continue;
    const label = factLabel(d.factKey || d.field);
    const year = d.factYear ? ` ${d.factYear}` : "";
    if (d.status === "resolved" || d.status === "accepted") {
      const why = (d.brokerNotes && d.brokerNotes.trim()) || (d.resolvedValue ? `kept ${d.resolvedValue}` : "resolved");
      const vs = d.documentValue && d.interviewValue ? `: ${d.documentValue} vs ${d.interviewValue}` : "";
      out.push({ tone: "resolved", text: `${label}${year}${vs}. Resolved ${day(d.resolvedAt)}: ${short(why, 160)}.` });
    } else {
      out.push({ tone: "open", text: `Open difference: ${label}${year}. See the Financials tab.` });
    }
  }
  // The same figure stated by another (shared) document.
  let matches = 0;
  for (const f of facts) {
    if (matches >= 4) break;
    if (IDENTIFIER_KEY.test(f.key)) continue;
    const figs = strongFigures(f.text).filter((x) => x.kind === "money" || (x.kind === "plain" && x.text.includes(",") && Math.abs(x.value) >= 1000));
    if (figs.length === 0) continue;
    for (const other of otherDocs) {
      if (other.id === doc.id || other.visibility === "broker_only") continue;
      const ed = (other.extractedData ?? null) as Record<string, unknown> | null;
      const ov = ed?.[f.key];
      if (ov === undefined || ov === null) continue;
      const known = knownFiguresFrom(valueText(ov));
      if (figs.some((g) => isKnownFigure(g, known))) {
        out.push({ tone: "match", text: `${f.label} matches ${other.name}.` });
        matches++;
        break;
      }
    }
  }
  return out;
}

/** The broker's list of questions buyers asked about one document. */
export function documentQuestions(
  questions: ReadonlyArray<Pick<BuyerQuestion, "id" | "question" | "status" | "vdrItemId" | "vdrPage" | "vdrTeamMemberId" | "buyerAccessId" | "createdAt" | "isPublished" | "answerScope">>,
  itemId: string,
  who: (q: { buyerAccessId: string | null; vdrTeamMemberId: string | null }) => string,
): Array<{ id: string; question: string; who: string; page: number | null; status: string; statusLabel: string; at: string }> {
  const LABEL: Record<string, string> = { pending_broker: "Needs your answer", pending_seller: "With the seller", published: "Answered", declined: "Declined" };
  return questions
    .filter((q) => q.vdrItemId === itemId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, 50)
    .map((q) => ({
      id: q.id,
      question: q.question,
      who: who({ buyerAccessId: q.buyerAccessId ?? null, vdrTeamMemberId: q.vdrTeamMemberId ?? null }),
      page: q.vdrPage ?? null,
      status: q.status,
      statusLabel: q.status === "published" && q.answerScope === "room" ? "Answered · shown to its readers" : LABEL[q.status] ?? "Waiting",
      at: new Date(q.createdAt).toISOString(),
    }));
}

/**
 * The CIM sections one buyer is served (what buildBuyerCim gives their
 * level, from the kept copy while an update waits for review). [] when the
 * CIM is held or anything fails — a page link is a nicety, never a leak path.
 */
export async function servedSectionsFor(deal: Deal, accessLevel: string): Promise<SectionText[]> {
  try {
    const { buildBuyerCim, cimHeldFromBuyers } = await import("@shared/cim-buyer-view");
    if (cimHeldFromBuyers(deal as any)) return [];
    const { buyerCimRows, servedBlindCodename } = await import("../cim/published-snapshot");
    const { loadMediaAssets } = await import("../cim/media-store");
    const { listedAskingPrice } = await import("../information/deal-mirror");
    const [rows, media, codename] = await Promise.all([buyerCimRows(deal as any, accessLevel), loadMediaAssets(deal.id), servedBlindCodename(deal as any)]);
    if (rows.missing) return [];
    const cim = buildBuyerCim({
      deal: (codename ? { ...deal, blindCodename: codename } : deal) as any,
      accessLevel,
      sections: rows.sections,
      overrides: rows.overrides,
      media,
      askingPrice: listedAskingPrice(deal),
      published: rows.published,
    });
    return cim.sections.filter((s: any) => !s.locked).map((s: any) => sectionText({ id: s.id, sectionTitle: s.sectionTitle, brokerEditedContent: s.brokerEditedContent, aiDraftContent: s.aiDraftContent, layoutData: s.layoutData }));
  } catch (err: any) {
    console.warn(`[vdr] served sections couldn't be read for deal ${deal.id}:`, err?.message ?? err);
    return [];
  }
}
