/**
 * figure-copy — every word the figure notes and the due-diligence checks put
 * in front of buyers and brokers (stream "dd", spec §4–§5). Plain language;
 * worked-out notes are fixed templates whose only causal claim is arithmetic.
 * Blind variants use category words only (FIGURE_LINES[].blindWord), never an
 * analysis line label.
 */
import { dollars, percentOf, signedDollars } from "./figure-compare";

// ── Buyer copy ───────────────────────────────────────────────────────────

export const DD_BADGE = "Due-diligence version";
/**
 * The DD version's one-line description for brokers (CIM tab Versions card,
 * "What each buyer sees"). D15 removed "verification notes" from the DD CIM.
 * INTEGRATOR: teaser's CimTab DD card ("…customer names and verification
 * notes.") takes this line (checker r1 F8).
 */
export const DD_VERSION_DETAIL = "The Full CIM plus figure checks against the tax returns, the documents behind them and customer names.";
export const DD_BANNER_TITLE = "Due-diligence version.";
export const DD_BANNER_POINTER = "Figures are checked against the company's tax returns and other records. Hover or click a figure to see how it compares and why.";
export const DD_BANNER_TOUCH = "Figures are checked against the company's tax returns and other records. Tap a figure to see how it compares and why.";
export const DD_BANNER_DOCS = "Source documents open in the data room.";
export const DD_BANNER_LINK = "How the figures check out →";
export const KEY_HAS_NOTE = "Has a note";

export const ASK_BROKER_DIFFERENCE = "Ask the broker about this difference";
export const ASK_ABOUT_FIGURE = "Ask about this figure";
export const SEND_TO_BROKER = "Send to the broker";
export const SENT_TO_BROKER = "Sent to the broker. The answer will appear in Questions.";
export const GROUPED_DIFFERENTLY_BLANK = "Grouped differently on the tax return";

export const COMPARE_CIM_ONLY = "CIM figures only";
export const COMPARE_SIDE_BY_SIDE = "Side by side with the tax returns";
export const COMPARE_ONLY_DIFFERENCES = "Only figures that differ";
export const COMPARE_BLANK_FOOTNOTE = "Blank: no tax return on file for that year, or no line to compare.";
export const COL_THIS_CIM = "This CIM";

export const NOTES_LIST_TITLE = (n: number) => `Notes on these figures (${n})`;
export const PAGE_SOURCES_TITLE = "Sources for this page:";
export const KEY_TERMS_TITLE = "From the documents";
export const MORE_COUNT = (n: number) => `+${n} more`;

export const SOURCE_CHECK_TITLE = "How the figures check out";
export const SOURCE_CHECK_INTRO =
  "Each figure in this CIM was compared with the company's other records. Matching figures are ticked; differences are highlighted with the reason on file. This compares the company's own records; it is not an audit.";
export const SOURCE_CHECK_TABLE = "CIM vs tax returns";
export const SOURCE_CHECK_GL_LINK = "The general ledger is compared with the statements on “Where each add-back is in the books”.";

/** "27 figures checked · 24 match · 2 grouped differently · 1 differs (with a reason)". */
export function sourceCheckSummary(s: { checked: number; matching: number; regrouped: number; differing: number; explained: number }): string {
  const parts = [`${s.checked} ${s.checked === 1 ? "figure" : "figures"} checked`, `${s.matching} ${s.matching === 1 ? "matches" : "match"}`];
  if (s.regrouped > 0) parts.push(`${s.regrouped} grouped differently`);
  if (s.differing > 0) {
    const reason = s.explained === s.differing ? " (with a reason)" : s.explained > 0 ? ` (${s.explained} with a reason)` : "";
    parts.push(`${s.differing} ${s.differing === 1 ? "differs" : "differ"}${reason}`);
  }
  return parts.join(" · ");
}

/** "Differs by +$33,000 (12.3%)". */
export function differsBy(base: number, other: number): string {
  const d = Math.abs(other) - Math.abs(base);
  const pct = percentOf(d, base, "difference");
  return `Differs by ${signedDollars(d)}${pct ? ` (${pct})` : ""}`;
}

/** "Up $1,378,500 (33%) from FY2022" / "Down …". */
export function changeLine(from: number, to: number, fromYear: string): string {
  const d = to - from;
  const pct = percentOf(d, from, "change");
  return `${d >= 0 ? "Up" : "Down"} ${dollars(d)}${pct ? ` (${pct})` : ""} from FY${fromYear}`;
}

/** The fixed basis line under a note. */
export type NoteBasis = "computed" | "document" | "owner" | "conversation" | "broker";
export function basisLabel(basis: NoteBasis, opts: { twoDocuments?: boolean; documentPhrase?: string | null } = {}): string {
  switch (basis) {
    case "computed": return opts.twoDocuments ? "Worked out from the two documents." : "Worked out from the figures.";
    case "document": return opts.documentPhrase ? `From the ${opts.documentPhrase}` : "From the company's documents";
    case "owner": return "From the owner";
    case "conversation": return "From a conversation with the owner";
    case "broker": return "From the broker";
  }
}

/** Blind CIM basis: words only, never a document's name. */
export function blindBasisLabel(basis: NoteBasis): string {
  return basis === "document" ? "From the company's documents" : basisLabel(basis);
}

// ── Worked-out notes (§4.6) ───────────────────────────────────────────────

/**
 * A label as it reads mid-sentence: "Dry van truckload" → "dry van truckload",
 * but a name stays as written ("Comfort Club memberships", "Port of Vancouver
 * drayage", "HVAC service").
 */
export function lowerFirst(s: string): string {
  if (!/^[A-Z][a-z]/.test(s)) return s;
  const rest = s.split(/\s+/).slice(1);
  if (rest.some((w) => /^[A-Z][a-z]/.test(w))) return s;
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** A line label without its asides: "Direct labour (incl. benefits & payroll burden)" → "Direct labour". */
export function shortLabel(s: string): string {
  const cut = s.replace(/\s*\([^)]*\)/g, "").replace(/\s+/g, " ").trim();
  return cut.length >= 3 ? cut : s;
}

/** "a", "a and b", "a, b and c". */
export function listJoin(items: string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/** D6, components: "The tax return's interest line includes bank charges ($33,000), which the financial statements show on their own line." */
export function differenceComponentsText(input: { lineWord: string; components: Array<{ label: string; value: number }> }): string {
  const items = input.components.map((c) => `${lowerFirst(c.label)} (${dollars(c.value)})`);
  const one = input.components.length === 1;
  const plural = one && /s\b/i.test(input.components[0].label.split(/\s*[&(—–-]\s*/)[0].trim());
  const where = one ? (plural ? "their own line" : "its own line") : "their own lines";
  return `The tax return's ${input.lineWord} line includes ${listJoin(items)}, which the financial statements show on ${where}.`;
}

/** D6, components, Blind CIM: no line labels. */
export function differenceComponentsBlindText(input: { lineWord: string; total: number }): string {
  return `The tax return's ${input.lineWord} line includes ${dollars(input.total)} that the financial statements show on a separate line.`;
}

/** D6, grouping (operating expenses ↔ amortization + interest). Category words only, so it is the blind text too. */
export function groupingOpexText(input: { amortization: number | null; interest: number | null }): string {
  const parts: string[] = [];
  if (input.amortization) parts.push(`amortization (${dollars(input.amortization)})`);
  if (input.interest) parts.push(`interest (${dollars(input.interest)})`);
  const them = parts.length === 1 ? "it" : "them";
  return `The tax return's operating expenses also include ${listJoin(parts)}; the financial statements show ${them} below operating expenses.`;
}

/** D6, CIM vs statements (non-recurring): "Financial statements as issued: $5,766,500. This CIM shows …". */
export function cimVsStatementsText(input: { asIssued: number; items: string[] | null; total: number; count: number }): string {
  const what = input.items && input.items.length > 0
    ? `${listJoin(input.items.map(lowerFirst))} on their own line as one-time costs`
    : `${input.count} one-time ${input.count === 1 ? "cost" : "costs"} (${dollars(input.total)}) on their own line`;
  return `Financial statements as issued: ${dollars(input.asIssued)}. This CIM shows ${what}.`;
}

/** Blind wording of the same. */
export function cimVsStatementsBlindText(input: { asIssued: number; total: number; count: number }): string {
  return cimVsStatementsText({ ...input, items: null });
}

/** Restated comparative: no reason is claimed. */
export function restatedText(input: { year: string; lineWord: string; earlier: number; later: number }): string {
  const next = String(Number(input.year) + 1);
  return `The FY${next} statements show FY${input.year} ${input.lineWord} as ${dollars(input.later)}; the FY${input.year} statements showed ${dollars(input.earlier)}.`;
}

/** D7: "Up $1,378,500 (33%) from FY2022, mostly facility rent (+$1,120,500)." */
export function movementText(input: { from: number; to: number; fromYear: string; parts: Array<{ label: string; delta: number }> }): string {
  const head = changeLine(input.from, input.to, input.fromYear);
  const parts = input.parts.map((p) => `${lowerFirst(shortLabel(p.label))} (${signedDollars(p.delta)})`);
  return parts.length > 0 ? `${head}, mostly ${listJoin(parts)}.` : `${head}.`;
}

const COUNT_WORDS = ["no", "one", "two", "three"];
/** What a total's parts are called in the Blind CIM ("revenue streams", "expense lines"). */
const PART_NOUN: Record<string, [string, string]> = {
  revenue: ["revenue stream", "revenue streams"],
  "cost of sales": ["direct cost", "direct costs"],
  "operating expenses": ["expense line", "expense lines"],
};
/**
 * The generic category a cost line belongs to, for the Blind CIM ("occupancy
 * costs", "fuel", "professional fees") — a fixed vocabulary, never the line's
 * own label, so it can't carry a name. Null when the line fits none of them
 * (a revenue line, owner pay, anything unusual).
 */
export function blindCostCategory(label: string, opts: { expense?: boolean; category?: string | null } = {}): string | null {
  if (!opts.expense || /owner/i.test(`${label} ${opts.category ?? ""}`)) return null;
  const l = label.toLowerCase();
  if (/income tax/.test(l) || opts.category === "Taxes") {
    if (/deferred|future/.test(l)) return "deferred income taxes";
    if (/current/.test(l)) return "current income taxes";
    return "income taxes";
  }
  for (const [re, word] of BLIND_COST_WORDS) if (re.test(l)) return word;
  return null;
}
// Order matters: the first rule that matches wins, so a more specific word comes before a broader
// one (checker r2 R2-5): "Interest on long-term debt and bank indebtedness" is interest, not bank
// charges; "Licences, permits, tolls & fuel tax" is licences and fees, not fuel; "Dues, memberships
// & subscriptions" is licences and fees, not technology; "Tractor leases & equipment rentals" is
// equipment leases, not occupancy.
const BLIND_COST_WORDS: Array<[RegExp, string]> = [
  [/wage|salar|payroll|labou?r|benefit|staff|crew|technician|driver/, "wages and benefits"],
  [/subcontract|contractor|purchased transport|carrier|owner[- ]operator/, "subcontractors"],
  [/(?:equipment|tractor|truck|trailer|vehicle|forklift|machinery|fleet)s?\b.*\b(?:leases?|leasing|rentals?)\b|\b(?:leases?|leasing|rentals?)\b.*\b(?:equipment|tractor|truck|trailer|vehicle|forklift|machinery|fleet)/, "equipment leases"],
  [/\brent(?:s|al|als)?\b|\bleases?\b|occupancy|premises|facilit/, "occupancy costs"],
  [/software/, "technology and communications"],
  [/fuel tax|\btolls?\b|permit|licen[cs]/, "licences and fees"],
  [/fuel|diesel|gasoline/, "fuel"],
  [/professional|legal|accounting|audit|consult/, "professional fees"],
  [/insurance/, "insurance"],
  [/repair|maintenance/, "repairs and maintenance"],
  [/advertis|marketing|promotion/, "marketing"],
  [/interest/, "interest"],
  [/bank|merchant|card (?:fees|processing)|service charge/, "bank charges"],
  [/bad debt|write.?off|doubtful/, "bad debts"],
  [/depreciat|amorti/, "depreciation"],
  [/utilit|hydro|electricity/, "utilities"],
  [/\bdues\b|membership/, "licences and fees"],
  [/telephone|internet|software|subscription|computer/, "technology and communications"],
  [/travel|vehicle|\bauto\b|mileage/, "vehicle and travel costs"],
  [/office|postage|stationery/, "office costs"],
  [/material|parts|inventory|supplies/, "materials and supplies"],
  [/freight|shipping|courier/, "freight"],
  [/property tax|realty tax/, "property taxes"],
];

/**
 * D7, Blind CIM. The parts by their generic category when every part has one
 * and they tell the change apart: "Up $1,378,500 (33%) from FY2022, mostly
 * occupancy costs (+$1,120,500)." Otherwise the count of a total's own parts
 * where the word means something ("…, mostly from three revenue streams."),
 * else null — the Blind CIM then shows the figure without a note (never
 * "mostly from two lines").
 */
export function movementBlindText(input: {
  from: number; to: number; fromYear: string; partCount: number; blindWord: string;
  parts?: Array<{ word: string | null; delta: number }>;
}): string | null {
  const head = changeLine(input.from, input.to, input.fromYear);
  if (input.partCount <= 0) return `${head}.`;
  const parts = input.parts ?? [];
  if (parts.length > 0 && parts.every((p) => !!p.word)) {
    const merged = new Map<string, number>();
    for (const p of parts) merged.set(p.word!, (merged.get(p.word!) ?? 0) + p.delta);
    const words = Array.from(merged.keys());
    if (!(words.length === 1 && words[0] === input.blindWord)) {
      return `${head}, mostly ${listJoin(words.map((w) => `${w} (${signedDollars(merged.get(w)!)})`))}.`;
    }
  }
  const noun = PART_NOUN[input.blindWord];
  if (!noun) return null;
  return `${head}, mostly from ${COUNT_WORDS[input.partCount] ?? input.partCount} ${input.partCount === 1 ? noun[0] : noun[1]}.`;
}

/** The column / chip label for the other record: "Tax return (T2)", "Form 1120", "Management accounts". */
export function otherRecordLabel(kind: "tax_return" | "management" | "statements", taxForm?: string | null): string {
  if (kind === "management") return "Management accounts";
  if (kind === "statements") return "Financial statements as issued";
  return taxForm ? (/^t2$/i.test(taxForm) ? "Tax return (T2)" : `Form ${taxForm}`) : "Tax return";
}

/**
 * Which tax form a document is, from its type or name: "T2", "1120", "1120-S",
 * "1065", or null (an unknown tax return).
 */
export function taxFormOf(doc: { documentType?: string | null; name?: string | null }): string | null {
  const t = `${doc.documentType ?? ""} ${doc.name ?? ""}`;
  if (/\bT2\b/i.test(t)) return "T2";
  if (/\b1120[- ]?S\b/i.test(t)) return "1120-S";
  if (/\b1120\b/.test(t)) return "1120";
  if (/\b1065\b/.test(t)) return "1065";
  return null;
}

// ── Broker copy (preview, workspace) ───────────────────────────────────────

export const BROKER_NOT_SHOWN = "Not shown to buyers yet";
export const BROKER_PREVIEW_BAR = "Due-diligence buyers don't see these checks yet.";
export const BROKER_REVIEW_AND_SHOW = "Review and show to buyers";
export const BROKER_NO_OTHER_RECORDS = "No tax returns on file to compare with";
export const BROKER_CIM_MISMATCH = "Your CIM differs from the statements; buyers don't see checks on this figure";
/** D9a on a figure with no check shown (the Full / Blind preview): buyers read it plain. */
export const BROKER_CIM_MISMATCH_PLAIN = "Your CIM differs from the statements here; buyers see this figure without notes until you fix it";
/** D9a reaching a derived total (EBITDA, gross profit…) worked out from figures that disagree. */
export const BROKER_CIM_MISMATCH_DERIVED = "Worked out from figures that differ from the statements; buyers see it without notes until you fix them";
export const BROKER_NOT_LOCATED = "Cimple couldn't find this in the document";
export const BROKER_NO_REASON = "No reason on file";
export const BROKER_HINT_PREFIX = "Cimple's analysis suggests:";
export const BROKER_HINT_SUFFIX = "(not checked)";
export const BROKER_USE_HINT = "This is right, use it";
export const BROKER_ASK_SELLER = "Ask the seller";
export const BROKER_WRITE_REASON = "Write a reason";
export const BROKER_WRITE_NOTE = "Write a note";
export const BROKER_LAYER_FAILED = "The figure notes couldn't be loaded for this preview.";

/** "Cimple couldn't find $86,000 in the tax return's text. Check the document before showing this." */
export function notLocatedMessage(value: number, docWord: string, lineWord?: string | null): string {
  // A figure the broker typed must be on the document's own line for it (checker r2 R2-1).
  if (lineWord) return `Cimple couldn't find your figure, ${dollars(value)}, on the ${docWord}'s ${lineWord} line. Check the document before showing this.`;
  return `Cimple couldn't find ${dollars(value)} in the ${docWord}'s text. Check the document before showing this.`;
}

/** The D9a broker-only warning for one year. */
export function cimMismatchWarning(input: { year: string; items: Array<{ lineWord: string; cim: number; statements: number }> }): string {
  const cim = listJoin(input.items.map((i) => `${i.lineWord} of ${dollars(i.cim)}`));
  const st = listJoin(input.items.map((i) => dollars(i.statements)));
  return `Your CIM shows FY${input.year} ${cim}. The FY${input.year} statements say ${st}. Fix FY${input.year} on the Financials tab, or explain the difference, before buyers see checks on these figures.`;
}
