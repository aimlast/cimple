/**
 * DD (Due Diligence) CIM Enrichment Engine
 *
 * Enriches normal CIM sections with previously withheld sensitive information:
 * - Customer names revealed in charts (replacing "Customer A" etc.)
 * - Addback verification details shown inline
 * - Financial comparison against bank statements / T2s
 * - Revenue verification commentary
 *
 * The DD version uses the same layout/format but highlights what's new:
 * newly revealed or newly added spans inside FREE-TEXT fields are wrapped in
 * the sentinel pair `[[dd]]…[[/dd]]`, which the client renders as a brass
 * highlight (client/src/components/cim/richText.tsx). Labels, values, chart
 * names and table cells are revealed without markers — a sentinel inside a
 * chart label would render literally. `sanitizeDdOutput` enforces that
 * split on whatever the model returns, and strips the legacy literal "[DD]"
 * tag so it never reaches a buyer.
 *
 * Guard rails (QA harvest 2026-09-26 — a DD run replaced approved figures,
 * invented a contractor and wrote "per confirmed facts"): the writer sees
 * only what a DD buyer may see (buildDdContext), and every result is
 * validated against its base section (validateDdOverride). A rejected
 * enrichment keeps the named version and tells the broker why.
 *
 * Editing a section no longer deletes its DD version: it is marked stale
 * (cim_sections.dd_stale_at), a DD buyer gets the current named content for
 * it, and refreshSectionDd() redoes just that section.
 */
import { and, eq, inArray, isNull, lt, notInArray } from "drizzle-orm";
import { isMediaLayout, isRegionWord, REGION_NAMES } from "@shared/cim-media";
import { isBroadRegionWord, isCommonWord } from "@shared/blind-vocabulary";
import { addbackEvidenceLine } from "@shared/addback-support";
import Anthropic from "@anthropic-ai/sdk";
import { cimSections, cimSectionOverrides, type CimSection, type Deal } from "@shared/schema";
import { db } from "../db";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";
import { splitFactsForCim, factValueText } from "../information/cim-facts";
import { cimFinancialsFor, renderCimFinancialsBlock, type CimFinancials } from "./cim-financials";
import { isBridgeAddback } from "../financial/addback-seed";
import { isDistributionLine } from "../financial/normalization-rules";
import { isKnownFigure, knownFiguresFrom, normalizeForLookup, parseFigures, parseFiguresAt, type Figure } from "./figure-check";
import { keepOutFromNotes, mentionsHeldPerson, neutralBridgeLabel, screenConfidentialText, screenFactsForCim, type KeepOut } from "./sensitive-facts";
import { keepOutFor } from "./keep-out";
import type { ResolvedDiscrepancyNote } from "./resolved-block";
import { earningsCanon, screenEarningsFacts } from "./earnings-canon";
import { currentResolvedNotes, resolvedNotes, settleResolvedFacts } from "./resolved-block";
import { stampSourceDetails } from "../documents/merge-policy";
import { describeAiFailure } from "../ai-retry";
import { recordPublishedDd } from "./published-versions";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000 });

export const DD_OPEN = "[[dd]]";
export const DD_CLOSE = "[[/dd]]";

/** Fields whose strings may carry `[[dd]]` markers — mirrors PROSE_KEYS in richText.tsx. */
const PROSE_KEYS = new Set([
  "body", "description", "caption", "footnote", "footnotes", "notes", "pullQuote",
  "highlights", "summary", "tagline", "content", "normalizedCaption", "normalizedFootnotes",
  "ownerDependency",
]);

const LEGACY_DD_TAG = /\[DD(?::\s*[^\]]*)?\]\s*/g;
const DD_MARK = /\[\[\/?dd\]\]/g;

/** Remove every DD sentinel and legacy tag — for any consumer that wants plain text (chatbot, search). */
export function stripDdMarkers(text: string | null | undefined): string {
  if (!text) return "";
  return text.replace(LEGACY_DD_TAG, "").replace(DD_MARK, "");
}

/** Balance stray sentinels so a lone opener can't highlight to the end of the text. */
function balanceDdMarkers(text: string): string {
  const cleaned = text.replace(LEGACY_DD_TAG, "");
  const opens = (cleaned.match(/\[\[dd\]\]/g) || []).length;
  const closes = (cleaned.match(/\[\[\/dd\]\]/g) || []).length;
  if (opens === closes) return cleaned;
  // Unbalanced: drop the markers rather than guess the span.
  return cleaned.replace(DD_MARK, "");
}

/** Deep-walk layoutData: prose fields keep (balanced) markers, everything else is plain. */
export function sanitizeDdLayoutData<T>(value: T, parentKey = "", depth = 0): T {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") {
    return (PROSE_KEYS.has(parentKey) ? balanceDdMarkers(value) : stripDdMarkers(value)) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeDdLayoutData(v, parentKey, depth + 1)) as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeDdLayoutData(v, k, depth + 1);
    }
    return out as T;
  }
  return value;
}

export interface DdEnrichmentResult {
  cimSectionId: string;
  layoutData: any;
  contentOverride: string;
  /** Set when the enrichment was rejected and the named version kept (why, for the broker). */
  warning?: string;
  /**
   * Why no enriched version came back: "api" = the AI service failed (credits,
   * overload, timeout); "unusable" = no usable answer (truncated, no tool
   * call) — both worth retrying, so an existing DD version is left as it is;
   * "rejected" = the answer broke the DD rules (the named version is the
   * DD version).
   */
  failed?: "api" | "unusable" | "rejected";
  /** The AI service's error when failed = "api" (to say why — credits out won't come right by retrying). */
  aiError?: { status?: number; message: string };
}

/** A failure worth retrying: the section's current DD version must not be replaced by the named copy. */
export function ddRetryable(r: Pick<DdEnrichmentResult, "failed">): boolean {
  return r.failed === "api" || r.failed === "unusable";
}

/** What the DD writer may use — built once per run (loadDdInputs / buildDdContext). */
export interface DdInputs {
  /** The prompt's DD context. */
  context: string;
  /** Everything a revealed name or figure may come from (facts + context). */
  knownText: string;
  /**
   * Names the CIM must never mention (keep-out requests, confidential
   * clauses): a DD version that names one is rejected. Absent = none.
   */
  heldNames?: string[];
}

type DdDocument = { name: string; category: string; visibility?: string | null };

// ── Context ──────────────────────────────────────────────────────────────

const CUSTOMER_KEY = /customer|client|account|payer|supplier|vendor|concentration/i;

/**
 * The DD writer's context. Only what a due-diligence buyer may see:
 *   - facts the CIM may state (splitFactsForCim "confirmed": no CRM-only
 *     leads, no "_" bookkeeping or private notes), screened for personal
 *     health details;
 *   - the financial analysis as computed rows (cim-financials) — never the
 *     analyzer's raw JSON or its internal clarifying questions;
 *   - add-back verification results;
 *   - names of shared financial documents (a broker-only source never
 *     appears, not even by name).
 */
export function buildDdContext(input: {
  extractedInfo?: Record<string, unknown> | null;
  financials?: CimFinancials | null;
  addbackVerification?: any;
  documents?: DdDocument[];
  /** The broker's resolved discrepancies (their earnings decisions outrank the analysis bridge). */
  resolved?: ResolvedDiscrepancyNote[];
  /** Items that must not reach buyers (keep-out.ts); the private-note rules when absent. */
  keepOut?: KeepOut | null;
}): DdInputs {
  const parts: string[] = [];
  const { confirmed } = splitFactsForCim(input.extractedInfo ?? {});
  // Confidential clauses held out (screenFactsForCim), and no second adjusted
  // EBITDA / SDE: the broker's figure, else the bridge's (earnings-canon.ts).
  const canon = earningsCanon(input.financials, null, { extractedInfo: input.extractedInfo, resolved: input.resolved });
  const financials = canon ? canon.financials : input.financials ?? null;
  const keepOut = input.keepOut ?? keepOutFromNotes(input.extractedInfo);
  const screened = screenFactsForCim(confirmed, keepOut);
  // The people and parties the seller or broker asked to keep out of the
  // CIM (and those a confidential clause is about). The facts above are
  // screened; the add-back labels, the statement lines and document names
  // below are built from other data, so they are screened here too — a DD
  // Financial Overview named the owner's wife through "Salary paid to
  // Maria Chen (owner's wife): verified" (free round 2, C2).
  const heldNames = screened.heldNames;
  const safe = screenEarningsFacts(screened.safe, canon, (k) => k).safe;

  const customerFacts = safe.filter(([k]) => CUSTOMER_KEY.test(k));
  if (customerFacts.length > 0) {
    parts.push(`## Real customer and supplier data (the only names you may reveal)\n${customerFacts.map(([k, v]) => `- ${k}: ${factValueText(v)}`).join("\n")}`);
  }

  if (input.addbackVerification) {
    const av = input.addbackVerification;
    // Only lines the CIM's analysis adds back: a dividend, a rejected line
    // or a clawback the rules took out is never presented as an add-back.
    const bridge = financials?.bridge;
    const bridgeLabels = bridge ? [...bridge.addbacks, ...bridge.sdeOnly].map((a) => a.label) : null;
    const addbacks = ((av.addbacks as any[]) || []).filter((ab: any) =>
      ab && typeof ab.label === "string" && (bridgeLabels ? isBridgeAddback(ab.label, bridgeLabels) : !isDistributionLine({ label: ab.label, amounts: ab.yearAmounts ?? {} })),
    );
    if (addbacks.length > 0) {
      // Claimed vs what the ledger shows: a partly supported add-back is never "matched".
      // (A held person's name never appears in a label — heldLabel.)
      parts.push(`## Add-back verification\nStatus: ${av.status}\n${addbacks.map((ab: any) =>
        addbackEvidenceLine({ ...ab, label: typeof ab.label === "string" ? heldLabel(ab.label, heldNames) : ab.label })
      ).join("\n")}`);
    }
  }

  const fin = withoutHeldLines(renderCimFinancialsBlock(financialsWithoutHeldNames(financials, heldNames)), heldNames);
  if (fin) parts.push(`## Verified financials (from the financial statements)\n${fin}`);

  const financialDocs = (input.documents ?? []).filter((d) =>
    d.visibility !== "broker_only" && (d.category === "financials" || d.category === "tax_returns" || d.category === "bank_statements") && !mentionsHeldPerson(d.name, heldNames),
  );
  if (financialDocs.length > 0) {
    parts.push(`## Supporting documents on file\n${financialDocs.map((d) => `- ${d.name} (${d.category})`).join("\n")}`);
  }

  const context = parts.join("\n\n") || "No additional DD data available.";
  const factsText = safe.map(([k, v]) => `${k}: ${factValueText(v)}`).join("\n");
  return { context, knownText: `${factsText}\n${context}`, heldNames };
}

/** A label without the held names in it (unchanged when it names none). */
function heldLabel(label: string, heldNames: readonly string[], type = ""): string {
  return mentionsHeldPerson(label, heldNames) ? neutralBridgeLabel(label, heldNames, type) : label;
}

/** The analysis's rows with no held name in a line or add-back label (the bridge keeps every step). */
export function financialsWithoutHeldNames(fin: CimFinancials | null | undefined, heldNames: readonly string[]): CimFinancials | null {
  if (!fin || heldNames.length === 0) return fin ?? null;
  const bridge = fin.bridge
    ? {
        ...fin.bridge,
        addbacks: fin.bridge.addbacks.map((a) => ({ ...a, label: heldLabel(a.label, heldNames) })),
        sdeOnly: fin.bridge.sdeOnly.map((a) => ({ ...a, label: heldLabel(a.label, heldNames) })),
      }
    : fin.bridge;
  return {
    ...fin,
    lines: fin.lines.map((l) => ({ ...l, name: heldLabel(l.name, heldNames) })),
    bridge,
    bridgeWithheld: fin.bridgeWithheld && mentionsHeldPerson(fin.bridgeWithheld, heldNames) ? screenConfidentialText(fin.bridgeWithheld, heldNames) : fin.bridgeWithheld,
  };
}

/** A rendered block with any line that still names a held party left out (a backstop — labels are neutral already). */
function withoutHeldLines(text: string, heldNames: readonly string[]): string {
  if (!text || heldNames.length === 0) return text;
  return text.split("\n").filter((line) => !mentionsHeldPerson(line, heldNames)).join("\n");
}

/** Load a deal's DD inputs: shared documents only, the CIM's financial analysis, verified add-backs. */
export async function loadDdInputs(deal: Pick<Deal, "id" | "extractedInfo">): Promise<DdInputs> {
  const [addbackVerification, analyses, docs, resolved] = await Promise.all([
    storage.getAddbackVerificationByDeal(deal.id),
    storage.getFinancialAnalysesByDeal(deal.id),
    storage.getDocumentsByDeal(deal.id),
    storage.getResolvedDiscrepancies(deal.id),
  ]);
  // The same facts the named CIM was written from (generation-jobs
  // buildLayoutParams): the broker's resolved values overlaid, and every
  // source stamped with its row's visibility so a broker-only fact or year
  // on an older deal is recognised and withheld. A resolution a later edit
  // replaced (settleResolvedFacts: superseded) neither overlays a fact nor
  // sets the DD's earnings figure (earnings-canon ranks resolutions first).
  const settled = settleResolvedFacts((deal.extractedInfo as Record<string, unknown>) || {}, resolvedNotes(resolved));
  const extractedInfo = stampSourceDetails(settled.facts, docs);
  return buildDdContext({
    extractedInfo,
    financials: cimFinancialsFor(analyses, docs),
    addbackVerification,
    documents: docs.map((d) => ({ name: d.name, category: d.category || "other", visibility: (d as { visibility?: string | null }).visibility ?? null })),
    resolved: currentResolvedNotes(settled.notes),
    keepOut: await keepOutFor(deal.id, extractedInfo),
  });
}

// ── Validation ───────────────────────────────────────────────────────────

/** Wording about Cimple's own process that must never reach a buyer. */
const INTERNAL_WORDING =
  /\b(?:confirmed facts?|per (?:the )?(?:broker|facts|knowledge base|analysis|interview)|knowledge base|teaser|dd context|clarifying questions?|internal (?:note|review)|broker[- ]only|crm|the seller (?:said|told us|claimed|stated)|initially estimated|previously (?:stated|estimated))\b/i;

function textsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || value == null) return out;
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number") out.push(String(value));
  else if (Array.isArray(value)) value.forEach((v) => textsOf(v, out, depth + 1));
  else if (typeof value === "object") Object.values(value as Record<string, unknown>).forEach((v) => textsOf(v, out, depth + 1));
  return out;
}

function figuresIn(text: string): Figure[] {
  return parseFigures(stripDdMarkers(text)).filter(
    (f) => f.kind !== "plain" || Math.abs(f.value) >= 1000 || f.text.includes(","),
  ).filter((f) => !(f.kind === "plain" && Number.isInteger(f.value) && f.value >= 1900 && f.value <= 2100 && !f.text.includes(",")));
}

const NAME_RE = /\b([A-Z][A-Za-z0-9&'’.-]*(?:\s+(?:of|and|&|the|de|du)?\s*[A-Z][A-Za-z0-9&'’.-]*)+)/g;

/**
 * Words that open a sentence or a revealed span without naming anything —
 * "[[dd]]The largest customer …", "[[dd]]These figures …", "[[dd]]Our
 * review …" were each rejected as an unknown name (free round 2 check).
 */
const FUNCTION_WORDS = new Set(`
a an the this that these those our its their his her my your we they it he she there here
in on at for by with from as to of and or but nor so yet while when where which what who whom whose
since during under over after before between through within without across against among per via upon into onto about
each every all both either neither some any no not none most more many much few several other another such same
also however although though because if unless until once further moreover additionally meanwhile overall
based according including excluding following
`.split(/\s+/).filter(Boolean));

/**
 * Tax and labour authorities a DD section may name when it says what a
 * figure was checked against ("the Canada Revenue Agency's Notice of
 * Assessment") — public bodies, never one of the deal's counterparties.
 * Folded as normalizeForLookup folds.
 */
const PUBLIC_BODIES = [
  "canada revenue agency", "revenue canada", "revenu quebec", "internal revenue service", "service canada",
  "statistics canada", "employment and social development canada", "workplace safety and insurance board",
  "worksafebc", "wsib", "cnesst", "department of labor", "ministry of finance", "franchise tax board",
  // Taxes and official records a DD note checks figures against ("Harmonized Sales Tax filings are current").
  "harmonized sales tax", "harmonised sales tax", "goods and services tax", "provincial sales tax", "quebec sales tax",
  "retail sales tax", "employer health tax", "canada pension plan", "employment insurance", "notice of assessment",
  "notice of reassessment", "record of employment", "general ledger", "trial balance", "statement of account",
].map((b) => ` ${b} `);
const REGION_PHRASES = new Set(REGION_NAMES.map((n) => normalizeForLookup(n)));

/** A place or a public body ("Ontario", "British Columbia", "Canada Revenue Agency"), not a counterparty. */
function isPlaceOrPublicBody(name: string): boolean {
  const norm = normalizeForLookup(name);
  if (norm.trim() === "") return false;
  // A body's full name, or two or more of its words ("Canada Revenue") — never one word of it ("Service").
  if (REGION_PHRASES.has(norm) || PUBLIC_BODIES.some((b) => b === norm || (norm.trim().includes(" ") && b.includes(norm)))) return true;
  return norm.trim().split(" ").every((w) => isRegionWord(w) || isBroadRegionWord(w) || FUNCTION_WORDS.has(w));
}

/** Short forms written with a full stop inside a name ("St. Lawrence", "Dr. Park", "J. Smith", "U.S. Foods"). */
const NAME_ABBREVIATION = /^(?:[A-Za-z]|(?:[A-Za-z]\.)+[A-Za-z]|mr|mrs|ms|mx|dr|st|ste|mt|ft|pt|prof|hon|rev|messrs)$/i;

/**
 * A matched run of capitalised words cut where a sentence ends inside it:
 * NAME_RE lets a word carry a full stop (for "St." and "Inc."), so "The
 * owner is Helen Park. The master agreement …" matched "Helen Park. The"
 * and "… Maplecrest Senior Living. Linda Chu manages …" one name made of
 * two — each then read as an invented name (free round 2 check, C5 step
 * 3a). A full stop ends the name unless it closes a short form that sits
 * inside names ("St. Lawrence") and the next word isn't a sentence opener.
 * A legal ending ("Inc.", "LLP.") always ends it.
 */
function namePhrases(run: string): string[] {
  const words = run.trim().split(/\s+/);
  const out: string[][] = [[]];
  words.forEach((w, i) => {
    out[out.length - 1].push(w);
    if (!w.endsWith(".") || i === words.length - 1) return;
    const core = w.replace(/\.+$/, "");
    const next = words[i + 1].replace(/[^A-Za-z]/g, "").toLowerCase();
    if (!NAME_ABBREVIATION.test(core) || FUNCTION_WORDS.has(next)) out.push([]);
  });
  return out.map((ws) => ws.join(" "));
}

function namesIn(text: string): string[] {
  // One line (a label, a cell, a paragraph) at a time: text joined from a
  // chart's rows is one label per line, never one name across two.
  return stripDdMarkers(text)
    .split(/\n|\s\|\s/)
    .flatMap((line) => Array.from(line.matchAll(NAME_RE)).flatMap((m) => namePhrases(m[1])))
    .map((phrase) => {
      // "The Receivables Ledger": the opening "The" belongs to the sentence, not the name.
      const words = phrase.trim().replace(/[.,;:]+$/, "").split(/\s+/).filter(Boolean);
      // "Serving Ontario", "Verified Add-backs": an inflected verb opens a clause, not a name.
      while (words.length > 0 && (FUNCTION_WORDS.has(words[0].toLowerCase()) || inflectedOrdinary(words[0]))) words.shift();
      return words.join(" ");
    })
    .filter((n) => n.includes(" "));
}

// ── Revealed labels and names ────────────────────────────────────────────

/** Row fields that name what the row is (a chart slice, a table row, a card). */
const LABEL_KEYS = ["name", "label", "title", "customer", "client", "company", "supplier", "vendor"];
/** Row fields that hold the row's own figure. */
const ROW_VALUE_KEYS = ["value", "secondaryValue", "percent", "percentage", "share", "amount", "revenue", "left", "right"];

/** An anonymised or generic label ("Customer A", "Top 5 customers", "Other") — not a name. */
const GENERIC_ROW_LABEL =
  /^(?:customer|client|supplier|vendor|account|payer|carrier|contractor|distributor)s?\s+(?:[a-z]|\d{1,2}|#\d{1,2})$|\bothers?\b|\bremaining\b|\ball other|\brest of\b|\btop \d+|\blong tail\b|^\d/i;

interface ChangedLabel {
  label: string;
  /** What the same field said in the base section ("" for a new row). */
  baseLabel: string;
  /** The row the label names (its figures are the label's). */
  row: Record<string, unknown>;
  /** The unit its figures are in, from the row or the chart around it ("%", "$"). */
  unit: string;
  /** Labels of one chart or table share a group (their figures are compared with each other). */
  group: number;
}

let labelGroups = 0;

/** The unit a chart, table or row declares ("%", "$", "USD"), else the one around it. */
const unitOf = (o: Record<string, unknown>, around: string): string =>
  typeof o.unit === "string" && o.unit.trim() ? o.unit : typeof o.currency === "string" && o.currency.trim() ? o.currency : around;

/**
 * Labels the enrichment changed or added, row by row (charts, tables, cards)
 * and column by column (a table's headers): a revealed customer name sits
 * here, where the prose check can't see it. A changed column header names
 * the column's cells ("Customer A" -> "Brightway Foods" over the 31% column
 * was a swap the row check never saw — free round 2 check, C5).
 */
function changedLabels(base: unknown, next: unknown, out: ChangedLabel[] = [], depth = 0, unit = ""): ChangedLabel[] {
  if (depth > 8 || next == null) return out;
  if (Array.isArray(next)) {
    const b = Array.isArray(base) ? base : [];
    const group = ++labelGroups;
    next.forEach((row, i) => {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        const r = row as Record<string, unknown>;
        const br = (b[i] && typeof b[i] === "object" ? b[i] : {}) as Record<string, unknown>;
        for (const k of LABEL_KEYS) {
          const v = r[k];
          if (typeof v === "string" && v.trim() && stripDdMarkers(v).trim() !== stripDdMarkers(String(br[k] ?? "")).trim()) {
            out.push({ label: stripDdMarkers(v).trim(), baseLabel: stripDdMarkers(String(br[k] ?? "")).trim(), row: r, unit: unitOf(r, unit), group });
          }
        }
      }
      changedLabels(b[i], row, out, depth + 1, unit);
    });
    return out;
  }
  if (typeof next === "object") {
    const o = next as Record<string, unknown>;
    const b = (base && typeof base === "object" ? base : {}) as Record<string, unknown>;
    const here = unitOf(o, unit);
    columnLabels(b, o, here, out);
    for (const [k, v] of Object.entries(o)) changedLabels(b[k], v, out, depth + 1, here);
  }
  return out;
}

/**
 * Column headers a table's enrichment changed: a financial_table's
 * `headers[j]` names every row's `values[j-1]`; a comparison_table's
 * leftLabel / rightLabel name every row's `left` / `right`.
 */
function columnLabels(base: Record<string, unknown>, next: Record<string, unknown>, unit: string, out: ChangedLabel[]): void {
  const rows = Array.isArray(next.rows) ? (next.rows as unknown[]).filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && !Array.isArray(r)) : [];
  if (rows.length === 0) return;
  const group = ++labelGroups;
  const text = (v: unknown) => stripDdMarkers(typeof v === "string" ? v : "").trim();
  const push = (label: unknown, baseLabel: unknown, cells: unknown[]) => {
    if (!text(label) || text(label) === text(baseLabel)) return;
    out.push({ label: text(label), baseLabel: text(baseLabel), row: { values: cells.filter((c) => c != null && c !== "") }, unit, group });
  };
  if (Array.isArray(next.headers)) {
    const bh = Array.isArray(base.headers) ? (base.headers as unknown[]) : [];
    (next.headers as unknown[]).forEach((h, j) => {
      if (j > 0) push(h, bh[j], rows.map((r) => (Array.isArray(r.values) ? r.values[j - 1] : undefined)));
    });
  }
  for (const side of ["left", "right"] as const) push(next[`${side}Label`], base[`${side}Label`], rows.map((r) => r[side]));
}

const LEGAL_ENDING = /\b(?:co-op|incorporated|inc|ltd|limited|llc|llp|lp|plc|corp|corporation|company|co)\b\.?/gi;
/** A legal ending on its own ("Inc", "Ltd") — part of a name, never one. */
const LEGAL_WORD = /^(?:co-op|incorporated|inc|ltd|limited|llc|llp|lp|plc|corp|corporation|company|co)\.?$/;

/**
 * The parts of a row label that may each name something: the head and every
 * aside. "Acme Logistics (MSA to 2027)" → ["Acme Logistics", "MSA to 2027"];
 * "Customer A (Sysco)", "Customer A – Sysco", "Customer A: Sysco", "Sysco /
 * Customer A" → ["Customer A", "Sysco"]. Legal endings are dropped. Round 1
 * kept only the head, so "Customer A (Sysco)" — the natural way to reveal a
 * name — read as the generic "Customer A", and an invented or mis-paired
 * name behind it went through (free round 2, C5).
 */
function labelParts(label: string): string[] {
  const asides: string[] = [];
  const head = label.replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (_m, a: string | undefined, b: string | undefined) => {
    asides.push(a ?? b ?? "");
    return " | ";
  });
  // ", " too: "Customer A, Acme Logistics" is the generic label and the name, not one name (free round 2 check).
  return [...head.split(/\s+[-—–]\s+|\s*[—–]\s*|:\s+|,\s+|\s+\/\s+|\s*\|\s*/), ...asides]
    .map((p) => p.replace(LEGAL_ENDING, " ").replace(/\s+/g, " ").trim().replace(/^[.,;:]+|[.,;:]+$/g, "").trim())
    .filter(Boolean);
}

const NAME_CONNECTORS = new Set(["of", "and", "&", "the", "de", "du", "des", "la", "le", "et", "for"]);

/** Written as a name — every word capitalised (or a number): "Brightway Foods", "3M Canada", "Sysco". */
function isNameLike(part: string): boolean {
  const words = part.split(/\s+/).filter((w) => !NAME_CONNECTORS.has(w.toLowerCase()));
  return words.length > 0 && words.every((w) => /^[A-Z0-9]/.test(w)) && words.some((w) => /^[A-Z]/.test(w));
}

/** A word that names nothing: everyday, a function word, a place, or one carrying digits ("FY2024"). */
function ordinaryWord(w: string): boolean {
  const l = w.toLowerCase().replace(/['’]s$/, "");
  if (/\d/.test(l) || FUNCTION_WORDS.has(l) || LEGAL_WORD.test(l) || STANDARD_ACRONYMS.has(l) || isCommonWord(l) || isRegionWord(l) || isBroadRegionWord(l)) return true;
  // Inflections only of the verbs and nouns a DD note is written in — "Browning" or "Manning" isn't "brown" or "man".
  return wordForms(l).some((f) => DD_VOCABULARY.has(f));
}

/**
 * The words a due-diligence note is written in — what was checked, against
 * what, and when — that the everyday-word list doesn't carry: "[[dd]]Verified
 * against …", "Reviewed by …", "December year-end statements …" each read
 * as an invented name (free round 2 check, C5 residual). Base forms; the
 * inflections come from wordForms.
 */
const DD_VOCABULARY = new Set(`
verify confirm reconcile audit prepare trace agree inspect examine validate sample obtain receive compare assess
harmonize corroborate substantiate document disclose normalize adjust accrue amortize depreciate capitalize file remit
statement ledger notice assessment reassessment filing invoice receipt deposit schedule summary register aging ageing
reconciliation certificate engagement compilation schedule remittance payable workpaper subledger journal
figure amount balance total variance discrepancy difference margin return book books
controller bookkeeper auditor accountant treasurer
review check test match support provide serve base report record list price bill pay own operate manage lease rent
supply deliver install repair maintain process sell hire train grow expand sign renew extend require state show
january february march april may june july august september october november december
monday tuesday wednesday thursday friday saturday sunday
`.split(/\s+/).filter(Boolean));

/** A word and the plain forms it may be inflected from ("verified" → "verify", "reconciled" → "reconcile", "reviewing" → "review"). */
function wordForms(l: string): string[] {
  const out = [l];
  const add = (s: string) => { if (s.length >= 3) out.push(s); };
  if (l.endsWith("ied")) add(`${l.slice(0, -3)}y`);
  if (l.endsWith("ed")) { add(l.slice(0, -2)); add(l.slice(0, -1)); if (/(.)\1ed$/.test(l)) add(l.slice(0, -3)); }
  if (l.endsWith("ing")) { add(l.slice(0, -3)); add(`${l.slice(0, -3)}e`); if (/(.)\1ing$/.test(l)) add(l.slice(0, -4)); }
  if (l.endsWith("ies")) add(`${l.slice(0, -3)}y`);
  if (l.endsWith("es")) add(l.slice(0, -2));
  if (l.length > 3 && l.endsWith("s")) add(l.slice(0, -1));
  if (l.endsWith("ments")) add(l.slice(0, -5));
  else if (l.endsWith("ment")) add(l.slice(0, -4));
  if (l.endsWith("ly")) add(l.slice(0, -2));
  return out;
}

/** An inflected verb form of an ordinary word ("Serving", "Verified", "Based") — it opens a clause, never a name. */
function inflectedOrdinary(w: string): boolean {
  const l = w.toLowerCase();
  return /(?:ed|ing)$/.test(l) && ordinaryWord(l);
}

/**
 * Capitalised words in a descriptive label part ("anchor account since
 * 2011", "Largest account, served by Sysco") that aren't on file: the
 * one-word name a two-word pattern can't see.
 */
function unknownCapitals(part: string, baseWords: Set<string>, knownWords: Set<string>, lowercaseToo = false): string[] {
  const out: string[] = [];
  for (const tok of part.match(/[A-Za-z][A-Za-z0-9&'’-]*/g) ?? []) {
    if (tok.length < 3) continue;
    if (!/^[A-Z]/.test(tok)) {
      // In a revealed row, a name written in lower case ("Customer A (sysco)") names someone too.
      if (lowercaseToo && !describesOnly(tok, baseWords, knownWords)) out.push(tok);
      continue;
    }
    if (/^[A-Z0-9&-]+$/.test(tok) && tok.length <= 5) continue; // an acronym (MSA, YTD, CRA)
    const w = tok.replace(/['’]s$/i, "").toLowerCase();
    if (baseWords.has(w) || knownWords.has(w) || ordinaryWord(w)) continue;
    out.push(tok.replace(/['’]s$/i, ""));
  }
  return out;
}

/**
 * Words that describe a revealed row rather than name it — "Customer A
 * (Anchor Client)", "Customer A (Largest Account)", "(FY2024)": the row
 * still reads "Customer A", and the aside says what kind of account it is.
 */
const ROW_DESCRIPTORS = new Set(`
anchor key largest biggest second third flagship principal primary major main top lead leading national regional provincial
municipal federal government public institutional commercial residential industrial retail wholesale recurring contract
contracted exclusive preferred strategic legacy longstanding long standing founding repeat direct indirect account client
customer distributor partner since fy ytd ltm multi site year years term renewal renewed msa master service agreement
annual monthly anchor-tenant tenant new existing former formerly previously now renamed trading operating dba aka
current active inactive single sole group
`.split(/\s+/).filter(Boolean));

/** Every piece of a word ("multi-year", "long-standing") is ordinary, descriptive, or the file's own. */
function describesOnly(tok: string, baseWords: Set<string>, knownWords: Set<string>): boolean {
  return tok
    .toLowerCase()
    .replace(/['’]s$/, "")
    .split(/[-'’]/)
    .filter(Boolean)
    .every((w) => w.length < 3 || /\d/.test(w) || ROW_DESCRIPTORS.has(w) || baseWords.has(w) || knownWords.has(w) || ordinaryWord(w));
}

/** Is the name written in the file (whole, as a phrase — not just its first word)? */
function onFile(name: string, knownNorm: string): boolean {
  const norm = normalizeForLookup(name).trim();
  return !norm || knownNorm.includes(` ${norm} `);
}

/** A figure with what it measures: a share, an amount, or a bare number (which may be either). */
interface KindedFigure {
  value: number;
  kind: "money" | "percent" | "plain";
  /** Half the unit of its last written digit ("$3.0M" -> 50,000): it says no more precisely than that. */
  tolerance: number;
}

/** A share compares with a share and an amount with an amount; a bare number with either. */
const sameKind = (a: KindedFigure, b: KindedFigure) => a.kind === "plain" || b.kind === "plain" || a.kind === b.kind;

/**
 * Two figures agree to the precision each is written with: the file's "about
 * $3.0M (31%)" gives Acme 3,000,000 +/- 50,000, so a DD chart showing
 * 3,040,000 agrees (it was rejected at a fixed 0.5% — free round 2 check).
 */
const figureClose = (a: KindedFigure, b: KindedFigure) =>
  Math.abs(Math.abs(a.value) - Math.abs(b.value)) <= Math.max(0.05, Math.abs(b.value) * 0.005, a.tolerance, b.tolerance);

/** A word after a name that turns to the next party ("…; second Brightway Foods 18%", "others 12%"). */
const NEXT_PARTY = /^(?:second|third|fourth|fifth|next|other|others|remaining|rest|followed|while|whereas|versus|vs|compared)(?:$|-)/i;

/**
 * The text that belongs to a name's mention: from the name up to where the
 * clause turns to another party — a capitalised name, "second", "others",
 * "followed by" — outside brackets. "Acme Logistics (31% of 2024 revenue,
 * $3,040,000)" gives Acme its share and its dollars; "Acme 31%, Brightway
 * 18%" gives Acme only 31%.
 */
function mentionWindow(after: string): string {
  let depth = 0;
  for (const m of Array.from(after.matchAll(/[()]|[A-Za-z][A-Za-z0-9&'’-]*/g))) {
    const tok = m[0];
    if (tok === "(") { depth++; continue; }
    if (tok === ")") { depth = Math.max(0, depth - 1); continue; }
    if (depth > 0) continue;
    const newName = /^[A-Z]/.test(tok) && tok.length >= 3 && !(/^[A-Z0-9&-]+$/.test(tok) && tok.length <= 5) && !ordinaryWord(tok);
    if (newName || NEXT_PARTY.test(tok)) return after.slice(0, m.index);
  }
  return after;
}

/**
 * The shares and amounts the file states for a name ("Acme Logistics 31%",
 * "31% — Acme Logistics", "Acme Logistics (31% of revenue, $3,040,000)"):
 * per mention, every such figure between it and the next party in the same
 * clause, else the last one before it. Counts and years don't pair ("Acme,
 * a client for 12 years"). Empty when the file gives the name no figure.
 * Round 1 kept only the first figure after each mention, so a faithful DD
 * dollar chart ("Acme Logistics 3,040,000") was rejected as "the file gives
 * it 31" (free round 2 check).
 */
function statedFigureFor(name: string, knownText: string): KindedFigure[] {
  const out: KindedFigure[] = [];
  const clauses = stripDdMarkers(knownText).split(/[;\n]|(?<=[.!?])\s+/);
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}])${name.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(String.raw`\s+`)}(?![\p{L}\p{N}])`, "giu");
  // Shares and amounts; a bare number only when it is written as an amount ("3,040,000"), never a count or a year.
  const figs = (t: string) =>
    parseFigures(t).filter((f) => f.kind !== "plain" || (/,\d{3}/.test(f.text) && !(f.value >= 1900 && f.value <= 2100)));
  for (const clause of clauses) {
    for (const m of Array.from(clause.matchAll(re))) {
      const at = m.index ?? 0;
      const after = figs(mentionWindow(clause.slice(at + m[0].length)));
      if (after.length > 0) {
        out.push(...after);
        continue;
      }
      const before = figs(clause.slice(Math.max(0, at - 40), at));
      if (before.length > 0) out.push(before[before.length - 1]);
    }
  }
  // A fact written as a pair of keys — "topCustomer: Acme Logistics" and
  // "topCustomerShare: 31%": the share is the name's (a swap over such a
  // file went unseen — free round 2 check, C5).
  if (out.length === 0) {
    const lines = stripDdMarkers(knownText).split("\n").map((l) => l.match(/^\s*([A-Za-z_][\w.]*)\s*:\s*(.+)$/)).filter((m): m is RegExpMatchArray => !!m);
    for (const [, key, value] of lines) {
      re.lastIndex = 0;
      if (!re.test(value) || value.replace(re, "").replace(/[\s.,;()-]+/g, "").length > 3) continue; // the value IS the name
      for (const [, k2, v2] of lines) {
        if (k2 !== key && k2.toLowerCase().startsWith(key.toLowerCase()) && /^(?:share|percent|percentage|pct|revenue|sales|amount|value|billings)/i.test(k2.slice(key.length))) {
          out.push(...figs(v2));
        }
      }
    }
  }
  const seen = new Set<string>();
  return out
    .map((f) => ({ value: f.value, kind: f.kind, tolerance: f.tolerance }))
    .filter((f) => !seen.has(`${f.kind}:${f.value}`) && !!seen.add(`${f.kind}:${f.value}`));
}

/** The prose fields of a section's data (where [[dd]] spans may sit). */
function proseTexts(value: unknown, parentKey = "", out: string[] = [], depth = 0): string[] {
  if (depth > 8 || value == null) return out;
  if (typeof value === "string") {
    if (PROSE_KEYS.has(parentKey)) out.push(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => proseTexts(v, parentKey, out, depth + 1));
  } else if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) proseTexts(v, k, out, depth + 1);
  }
  return out;
}

/** Every figure a row shows (its value fields, and a table row's cells). */
function rowFigures(row: Record<string, unknown>, unit = ""): KindedFigure[] {
  const texts: string[] = [];
  for (const k of ROW_VALUE_KEYS) if (row[k] != null && row[k] !== "") texts.push(String(row[k]));
  if (Array.isArray(row.values)) for (const v of row.values) if (v != null && v !== "") texts.push(String(v));
  // A bare number is in the chart's unit: 31 in a "%" chart is a share, 3040000 in a "$" chart an amount.
  const unitKind: KindedFigure["kind"] = /%|percent/i.test(unit) ? "percent" : /\$|usd|cad|dollar|eur|gbp/i.test(unit) ? "money" : "plain";
  const out: KindedFigure[] = [];
  for (const t of texts) {
    const n = Number(String(t).replace(/[,$%\s]/g, ""));
    if (/^\s*-?\$?\s*-?[\d,.]+\s*%?\s*$/.test(t) && Number.isFinite(n)) {
      out.push({ value: n, kind: /%/.test(t) ? "percent" : /\$/.test(t) ? "money" : unitKind, tolerance: 0 });
    } else {
      out.push(...parseFigures(t).map((f) => ({ value: f.value, kind: f.kind === "plain" ? unitKind : f.kind, tolerance: f.tolerance })));
    }
  }
  return out;
}

/**
 * Capitalised words the enrichment added to its prose that aren't on file:
 * a one-word customer ("Sysco") slips past the two-word name pattern. Words
 * at the start of a sentence are ordinary capitals — except the first word
 * of a revealed [[dd]] span, which is exactly where a name goes.
 */
function unknownSingleNames(rawText: string, baseWords: Set<string>, knownWords: Set<string>): string[] {
  const out = new Set<string>();
  const WORD = /\[\[dd\]\]|\[\[\/dd\]\]|[A-Za-z][A-Za-z0-9&'’-]*|[.!?:]/g;
  let prev = "."; // start of text = start of a sentence
  let afterOpen = false;
  let inSpan = false;
  for (const m of Array.from(rawText.matchAll(WORD))) {
    const tok = m[0];
    if (tok === "[[dd]]") { afterOpen = true; inSpan = true; continue; }
    if (tok === "[[/dd]]") { inSpan = false; continue; }
    if (/^[.!?:]$/.test(tok)) { prev = tok; continue; }
    const sentenceStart = /^[.!?:]$/.test(prev);
    const checked = afterOpen || !sentenceStart;
    afterOpen = false;
    prev = tok;
    if (!checked || !/^[A-Z]/.test(tok) || tok.length < 3) continue;
    const w = tok.replace(/['’]s$/i, "").toLowerCase();
    if (baseWords.has(w) || knownWords.has(w) || ordinaryWord(w)) continue;
    // An acronym (CRA, HST, T4) is an ordinary term — except one a revealed span
    // names that neither the file nor the finance vocabulary knows: "[[dd]]the
    // LCBO[[/dd]]" is a customer (free round 2 check, C5).
    if (/^[A-Z0-9&-]+$/.test(tok) && tok.length <= 5 && (!inSpan || STANDARD_ACRONYMS.has(w))) continue;
    out.add(tok.replace(/['’]s$/i, ""));
  }
  return Array.from(out);
}

/** Acronyms of finance, tax, payroll and reporting a DD note uses without naming anyone (lowercase). */
const STANDARD_ACRONYMS = new Set(`
cra irs hst gst pst qst rst eht cpp qpp ei wsib wcb roe noa t1 t2 t3 t4 t4a t5 t5018 w2 w9 k1 ein bn sin ssn
sde ebitda ebit ebt nwc wc ar ap gl p&l pl bs cf coa capex opex cogs roi roa roe kpi kpis ytd ltm ttm fy fye mtd qtd yoy
cpa ca cga cma cfo ceo coo cto vp hr it ops qa qc sop sops msa sla slas sow nda loi apa spa lpa psa rfp rfq po pos
gaap ifrs aspe ifrs sox aml kyc pipeda hipaa iso osha whmis ul csa ce fda ohip odsp nihb
us usa usd cad eur gbp llc llp lp ltd inc plc ulc corp co
b2b b2c oem mro erp crm pms emr ehr sku skus edi api saas
`.split(/\s+/).filter(Boolean).map((a) => a.toLowerCase()));

/** Wording that ties a figure to a party as its share or amount of the business ("accounts for 31%", "31% of revenue"). */
const CLAIM_BEFORE =
  /(?:accounts?(?:ed)?\s+for|accounting\s+for|represent(?:s|ed|ing)?|makes?\s+up|made\s+up|contribut\w*|comprise[sd]?|generat\w*|billed|brings?\s+in|share\s+of|worth|at)\s*(?:about|approximately|roughly|nearly|around|over|under|some|just\s+(?:over|under)|~)?\s*$/i;
const CLAIM_AFTER = /^\s*(?:of\s+(?:the\s+)?(?:[\w'’-]+\s+){0,3}?(?:revenue|revenues|sales|billings|volume|income|business|turnover))/i;

/**
 * A name revealed in the prose with a share or amount the file gives
 * another party: "Customer A ([[dd]]Brightway Foods[[/dd]]) accounts for
 * 31% of revenue" when the file gives Brightway 18%. Labels had this check;
 * prose didn't (free round 2 check, C5). Only a figure worded as the party's
 * share or amount of the business is compared, and only against the file's
 * figures of the same kind — "Acme's volume grew 12%" is not a share.
 */
function proseMispairings(texts: string[], knownText: string, knownNorm: string): string[] {
  const out: string[] = [];
  for (const raw of texts) {
    if (!raw.includes(DD_OPEN)) continue;
    const plain = stripDdMarkers(raw);
    for (const m of Array.from(raw.matchAll(/\[\[dd\]\]([\s\S]*?)\[\[\/dd\]\]/g))) {
      const span = stripDdMarkers(m[1]).trim();
      const whole = span.replace(/^(?:the|our)\s+/i, "").replace(/[.,;:]+$/, "");
      const candidates = new Set(namesIn(span));
      if (whole && whole.split(/\s+/).length <= 5 && isNameLike(whole)) candidates.add(whole);
      // Where the span sits in the plain text: the markers before it are gone there.
      const at = stripDdMarkers(raw.slice(0, m.index ?? 0)).length;
      const spanEnd = at + stripDdMarkers(m[0]).length;
      const sentenceEnd = plain.slice(spanEnd).search(/(?<=[.!?])\s+(?=[A-Z])|\n/);
      const after = mentionWindow(plain.slice(spanEnd, sentenceEnd < 0 ? undefined : spanEnd + sentenceEnd));
      const claimed = parseFiguresAt(after)
        .filter((f) => f.kind !== "plain" && (CLAIM_BEFORE.test(after.slice(Math.max(0, f.index - 40), f.index)) || CLAIM_AFTER.test(after.slice(f.end))))
        .map((f) => ({ value: f.value, kind: f.kind, tolerance: f.tolerance }) as KindedFigure);
      if (claimed.length === 0) continue;
      for (const name of Array.from(candidates)) {
        const inside = plain.slice(at, spanEnd);
        if (!onFile(name, knownNorm) || !inside.includes(name)) continue;
        const stated = statedFigureFor(name, knownText).filter((s) => claimed.some((c) => sameKind(c, s) && c.kind === s.kind));
        if (stated.length > 0 && !claimed.some((c) => stated.some((s) => c.kind === s.kind && figureClose(c, s)))) {
          out.push(`shows "${name}" at ${claimed.map((c) => c.value.toLocaleString("en-US")).join(" / ")}, but the file gives it ${stated.map((s) => s.value.toLocaleString("en-US")).join(" / ")}`);
        }
      }
    }
  }
  return out;
}

/**
 * The words of a text, lowercase, with fact keys split into their words
 * ("taxFilings" → "tax", "filings") and each word's plain form beside it
 * ("filings" → "filing"): a revealed span opening with "Filings …" is a
 * word the file uses, not a name.
 */
const wordSet = (text: string) => {
  const plain = stripDdMarkers(text);
  const split = plain.replace(/([a-z])([A-Z])/g, "$1 $2"); // "McDonald" stays whole in the plain form
  const words = `${plain}\n${split}`.toLowerCase().match(/[a-z][a-z0-9&'’-]*/g) ?? [];
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    if (w.length > 4 && w.endsWith("s")) out.add(w.slice(0, -1));
  }
  return out;
};

/**
 * Check a DD enrichment against its base section. Problems (empty = safe):
 *  - a figure of the base section changed or disappeared (DD never changes
 *    an approved figure);
 *  - a new figure that isn't in the facts or the DD context;
 *  - a new name (company, person) that isn't on file — no invented entities,
 *    one word or several, in prose or as a chart / table label;
 *  - a revealed name shown with a figure the file doesn't give it (the
 *    right names paired with the wrong shares);
 *  - a name the seller or broker asked to keep out of the CIM (`heldNames`);
 *  - internal process wording ("per confirmed facts", "teaser", …).
 */
export function validateDdOverride(
  base: { layoutData: unknown; content: string },
  enriched: { layoutData: unknown; contentOverride: string },
  knownText: string,
  heldNames: readonly string[] = [],
): string[] {
  const problems: string[] = [];
  const baseText = [...textsOf(base.layoutData), base.content || ""].join("\n");
  const newText = [...textsOf(enriched.layoutData), enriched.contentOverride || ""].join("\n");

  // 1. Every base figure survives unchanged.
  const remaining = figuresIn(newText);
  for (const f of figuresIn(baseText)) {
    const i = remaining.findIndex((g) => g.kind === f.kind && Math.abs(g.value - f.value) <= 1e-9 * Math.max(1, Math.abs(f.value)));
    if (i >= 0) remaining.splice(i, 1);
    else problems.push(`changed or removed the figure ${f.text}`);
  }
  // 2. Figures it added must come from the deal's data.
  const known = knownFiguresFrom(`${knownText}\n${baseText}`);
  for (const g of remaining) {
    if (!isKnownFigure(g, known)) problems.push(`added a figure with no source (${g.text})`);
  }
  // 3. No invented names.
  const knownNorm = normalizeForLookup(`${knownText}\n${baseText}`);
  const baseNames = new Set(namesIn(baseText).map((n) => normalizeForLookup(n)));
  for (const name of Array.from(new Set(namesIn(newText)))) {
    const norm = normalizeForLookup(name);
    if (baseNames.has(norm) || knownNorm.includes(norm) || isPlaceOrPublicBody(name)) continue;
    // "Anchor Client", "Largest Account", "HST and T4": a kind of account or a finance term, not a name.
    if (name.split(/\s+/).every((w) => NAME_CONNECTORS.has(w.toLowerCase()) || ROW_DESCRIPTORS.has(w.toLowerCase()) || STANDARD_ACRONYMS.has(w.toLowerCase()) || /\d/.test(w))) continue;
    const words = norm.trim().split(" ").filter((w) => w.length >= 4);
    if (words.length > 0 && words.every((w) => knownNorm.includes(` ${w} `))) continue;
    problems.push(`named "${name}", which isn't on file`);
  }
  // 3a. A name it reveals in the prose ([[dd]] … [[/dd]]) is on file as a
  // whole — "Brightway Logistics" built from two words the file uses for
  // two different parties is an invented name, as it is in a label.
  const spans = Array.from(newText.matchAll(/\[\[dd\]\]([\s\S]*?)\[\[\/dd\]\]/g)).map((m) => m[1]).join(" | "); // never one name across two spans (namesIn splits at " | ")
  for (const name of Array.from(new Set(namesIn(spans)))) {
    const bare = name.replace(LEGAL_ENDING, " ").replace(/\s+/g, " ").trim();
    if (!bare.includes(" ") || onFile(bare, knownNorm) || baseNames.has(normalizeForLookup(bare)) || isPlaceOrPublicBody(bare)) continue;
    if (bare.split(/\s+/).every((w) => NAME_CONNECTORS.has(w.toLowerCase()) || ordinaryWord(w))) continue; // "Notice of Assessment"
    if (!problems.includes(`named "${name}", which isn't on file`)) problems.push(`named "${name}", which isn't on file`);
  }
  // 3b. Labels it changed (a revealed customer in a chart or table row):
  // every part of the label that names something — the head and any aside,
  // "Customer A (Sysco)" — is on file as written, and a revealed name
  // carries the figure the file gives it. A row whose label was generic
  // ("Customer A") is a reveal: the name it now shows must be on file,
  // however ordinary its words.
  const flagged = new Set(problems.map((p) => p.match(/^named "(.+)", which/)?.[1] ?? "").filter(Boolean));
  const flag = (name: string) => {
    if (!flagged.has(name)) problems.push(`named "${name}", which isn't on file`);
    flagged.add(name);
  };
  const baseWords = wordSet(baseText);
  // Words the file writes in lower case — ordinary words there ("verified", "add-backs"), never part of a name.
  const lowerWords = new Set((stripDdMarkers(`${knownText}\n${baseText}`).match(/(?<![A-Za-z0-9&'’-])[a-z][a-z0-9&'’-]*/g) ?? []));
  const knownWords = wordSet(knownText);
  /** Revealed names whose figures the file gives only in another measure (amounts for a share chart), by chart. */
  const byOrder: Array<{ name: string; group: number; shown: KindedFigure; stated: KindedFigure }> = [];
  for (const { label, baseLabel, row, unit, group } of changedLabels(base.layoutData, enriched.layoutData)) {
    const parts = labelParts(label);
    const reveal = [...parts, ...labelParts(baseLabel)].some((p) => GENERIC_ROW_LABEL.test(p));
    // The label still reads "Customer A": its other parts describe the account unless they name someone.
    const keepsGeneric = parts.some((p) => GENERIC_ROW_LABEL.test(p));
    const names: string[] = [];
    for (const part of parts) {
      if (GENERIC_ROW_LABEL.test(part) || !/[A-Za-z]{2,}/.test(part)) continue;
      if (!isNameLike(part)) {
        // A description ("anchor account since 2011"): only a capitalised word in it can name someone —
        // or, in a revealed row, any word that isn't ordinary ("Customer A (sysco)").
        for (const w of unknownCapitals(part, baseWords, knownWords, reveal)) flag(w);
        continue;
      }
      if (onFile(part, knownNorm) || baseNames.has(normalizeForLookup(part))) {
        names.push(part);
        continue;
      }
      if (isPlaceOrPublicBody(part)) continue;
      if (keepsGeneric && part.split(/\s+/).every((w) => NAME_CONNECTORS.has(w.toLowerCase()) || ROW_DESCRIPTORS.has(w.toLowerCase()) || /\d/.test(w))) continue;
      // A heading in title case ("Bank Deposits", "Verified Add-backs") names nothing — unless it took the place of "Customer A".
      if (!reveal && part.split(/\s+/).every((w) => NAME_CONNECTORS.has(w.toLowerCase()) || ordinaryWord(w) || lowerWords.has(w.toLowerCase()))) continue;
      flag(part);
    }
    const shown = rowFigures(row, unit);
    for (const name of names) {
      const stated = statedFigureFor(name, knownText);
      if (stated.length === 0 || shown.length === 0) continue;
      const comparable = stated.filter((s) => shown.some((v) => sameKind(v, s)));
      if (comparable.length > 0) {
        if (!shown.some((v) => comparable.some((s) => sameKind(v, s) && figureClose(v, s)))) {
          problems.push(`shows "${name}" at ${shown.map((v) => v.value.toLocaleString("en-US")).join(" / ")}, but the file gives it ${comparable.map((v) => v.value.toLocaleString("en-US")).join(" / ")}`);
        }
      } else if (stated.length === 1) {
        // The file gives Acme $3,040,000 and the chart its share: can't compare, but the order must hold.
        byOrder.push({ name, group, shown: shown[0], stated: stated[0] });
      }
    }
  }
  // 3b'. Names shown in a chart in a measure the file doesn't give them in
  // (shares where the file has amounts): each is on file, but the larger
  // party in the file must not be the smaller one in the chart — a swap.
  for (const a of byOrder) {
    for (const b of byOrder) {
      if (a.group !== b.group || a.name === b.name || a.stated.kind !== b.stated.kind || a.shown.kind !== b.shown.kind) continue;
      if (figureClose(a.stated, b.stated) || figureClose(a.shown, b.shown)) continue;
      if (a.stated.value > b.stated.value && a.shown.value < b.shown.value) {
        problems.push(`shows "${a.name}" below "${b.name}", but the file gives "${a.name}" more (${a.stated.value.toLocaleString("en-US")} vs ${b.stated.value.toLocaleString("en-US")})`);
      }
    }
  }
  // 3c. One-word names in the prose it added.
  const proseNew = [...proseTexts(enriched.layoutData), enriched.contentOverride || ""].join("\n");
  for (const w of unknownSingleNames(proseNew, baseWords, knownWords)) flag(w);
  // 3c'. A name revealed in the prose carries the share the file gives it.
  for (const p of proseMispairings([...proseTexts(enriched.layoutData), enriched.contentOverride || ""], knownText, knownNorm)) {
    if (!problems.includes(p)) problems.push(p);
  }
  // 3d. Never a name the seller or broker asked to keep out.
  const held = mentionsHeldPerson(stripDdMarkers(newText), heldNames);
  if (held) problems.push(`named "${held}", whom the CIM must leave out`);
  // 4. No internal wording.
  const internal = stripDdMarkers(newText).match(INTERNAL_WORDING);
  if (internal && !INTERNAL_WORDING.test(stripDdMarkers(baseText))) problems.push(`used internal wording ("${internal[0]}")`);
  return problems;
}

// ── Generation ───────────────────────────────────────────────────────────

const DD_TOOL = {
  name: "dd_section",
  description: "The due-diligence version of one CIM section.",
  input_schema: {
    type: "object" as const,
    required: ["layoutData", "contentOverride"],
    properties: {
      layoutData: { type: "object", description: "The section's layoutData with the same structure, enriched." },
      contentOverride: { type: "string", description: "The section's prose, enriched (the original text when there is nothing to add)." },
    },
  },
} as const;

/**
 * Generate DD-enriched overrides for CIM sections. A section whose
 * enrichment fails validation keeps its named version (with a warning).
 */
export async function generateDdOverrides(
  sections: CimSection[],
  deal: { businessName: string; industry?: string | null },
  inputs: DdInputs,
): Promise<DdEnrichmentResult[]> {
  const results: DdEnrichmentResult[] = [];
  for (let i = 0; i < sections.length; i += 3) {
    const batch = sections.slice(i, i + 3);
    const batchResults = await Promise.all(batch.map((section) => enrichSection(section, inputs, deal)));
    results.push(...batchResults);
  }
  return results;
}

/** Shape the stored override: balanced markers in prose, plain text elsewhere, no legacy tags. */
export function sanitizeDdOutput(layoutData: any, contentOverride: string): { layoutData: any; contentOverride: string } {
  return {
    layoutData: sanitizeDdLayoutData(layoutData),
    contentOverride: balanceDdMarkers(contentOverride || ""),
  };
}

/** Swappable for tests. */
type DdClient = { messages: { create: (body: any) => Promise<any> } };
let ddClient: DdClient = anthropic as unknown as DdClient;
export function _setDdClientForTests(c: DdClient | null) {
  ddClient = c ?? (anthropic as unknown as DdClient);
}

/** Enrich one section. Never throws: on any failure the named version is kept. */
export async function enrichSection(
  section: CimSection,
  inputs: DdInputs,
  deal: { businessName: string; industry?: string | null },
): Promise<DdEnrichmentResult> {
  const layoutData = section.layoutData as any || {};
  const content = section.brokerEditedContent || section.aiDraftContent || "";
  const keep = (warning?: string, failed?: DdEnrichmentResult["failed"]): DdEnrichmentResult => ({
    cimSectionId: String(section.id), layoutData, contentOverride: content, ...(warning ? { warning } : {}), ...(failed ? { failed } : {}),
  });

  // Cover pages and dividers carry nothing to enrich — skip the model call so
  // they can't come back with stray markers or a reworded title.
  // Media blocks (photos, videos, maps) are served from their own data in
  // every version — nothing to enrich, and their references must not change.
  if (section.layoutType === "cover_page" || section.layoutType === "divider" || isMediaLayout(section.layoutType)) {
    return keep();
  }

  let parsed: { layoutData?: unknown; contentOverride?: unknown } | null = null;
  try {
    const message = await ddClient.messages.create({
      model: agentConfig.models.supportingAgents,
      max_tokens: 6000,
      tools: [DD_TOOL],
      tool_choice: { type: "tool", name: "dd_section" },
      messages: [
        {
          role: "user",
          content: `You are writing the Due Diligence version of one CIM section. The buyer reading it has signed an LOI; the DD version reveals previously withheld detail and adds verification notes.

## What to do
1. If this section contains anonymized references (Customer A, Supplier A, a regional grocery distributor, etc.), replace them with the real names — ONLY names listed in the DD context below. If the context doesn't give the name, keep the anonymized wording.
2. If this section is financial and the DD context has verification data (verified financials, add-back verification, supporting documents), add a short inline note on how the figures were verified.
3. MARK WHAT IS NEW. Wrap every newly revealed or newly added span of text in ${DD_OPEN} and ${DD_CLOSE}, e.g. "Revenue is concentrated with ${DD_OPEN}Acme Logistics (31%)${DD_CLOSE}."
   - Markers ONLY inside free-text fields: body, description, caption, footnote(s), notes, pullQuote, highlights, summary, and the content text.
   - NEVER put markers in labels, values, names, titles, chart data, table cells or metric values — reveal those plainly.
   - Never write a literal "[DD]" tag. Keep markers balanced.
4. Keep the same layoutData JSON structure — only enrich string values. Plain text only (no markdown).

## Hard rules — a violation discards your version
- NEVER change, round, re-derive or remove any figure already in the section (amounts, percentages, counts, dates). Every existing number stays exactly as written.
- Never add a figure that is not in the DD context.
- Never invent a company, person, contractor or product. Reveal only names given in the DD context.
- Never describe how this document was prepared: no "confirmed facts", "per the broker", "knowledge base", "teaser", "initially estimated", "the seller said", "CRM" or similar.
- If there is nothing to add, return the section unchanged.

## Business: ${deal.businessName}
## Industry: ${deal.industry || "unknown"}

## DD context (the only extra information you may use)
${inputs.context}

## Section
Title: ${section.sectionTitle}
Layout type: ${section.layoutType}

### layoutData (JSON)
${JSON.stringify(layoutData, null, 2)}

### Content text
${content}

Return the enriched section via the dd_section tool.`,
        },
      ],
    });
    const block = (message?.content ?? []).find((b: { type: string }) => b.type === "tool_use");
    if (message?.stop_reason !== "max_tokens" && block?.input && typeof block.input === "object") parsed = block.input;
  } catch (err) {
    console.warn(`[dd-enrichment] section ${section.id} failed:`, (err as Error)?.message);
    const e = err as { status?: unknown; message?: unknown };
    return {
      ...keep(`DD version of "${section.sectionTitle}" couldn't be written (the AI service failed) — its current DD version was kept. Refresh it later.`, "api"),
      aiError: { status: typeof e?.status === "number" ? e.status : undefined, message: String(e?.message ?? "").slice(0, 300) },
    };
  }
  if (!parsed || !parsed.layoutData || typeof parsed.layoutData !== "object") {
    return keep(`DD version of "${section.sectionTitle}" couldn't be written — its current DD version was kept. Refresh it later.`, "unusable");
  }

  const clean = sanitizeDdOutput(parsed.layoutData, typeof parsed.contentOverride === "string" ? parsed.contentOverride : content);
  const problems = validateDdOverride({ layoutData, content }, clean, inputs.knownText, inputs.heldNames ?? []);
  if (problems.length > 0) {
    console.warn(`[dd-enrichment] section ${section.id} rejected: ${problems.join("; ")}`);
    return keep(`DD version of "${section.sectionTitle}" kept as the named CIM — the enrichment ${problems.slice(0, 3).join("; ")}.`, "rejected");
  }
  return { cimSectionId: String(section.id), layoutData: clean.layoutData, contentOverride: clean.contentOverride };
}

/**
 * Refresh ONE section's DD version (after an edit). Replaces only that
 * section's DD row, and clears its stale mark only if the section hasn't
 * changed again meanwhile. Returns the warning when the named version was
 * kept, or throws "changed" when the section moved on during the run.
 */
export async function refreshSectionDd(section: CimSection, deal: Deal): Promise<{ warning?: string }> {
  const inputs = await loadDdInputs(deal);
  const result = await enrichSection(section, inputs, deal);
  // The AI service failed: the section's DD version (and its stale mark)
  // stay exactly as they were — never replaced by the named copy and marked
  // fresh, which hid it from "Refresh DD".
  if (ddRetryable(result)) throw new DdUnavailableError(result.aiError);
  const stamp = section.ddStaleAt ? new Date(section.ddStaleAt) : null;
  const committed = await db.transaction(async (tx) => {
    const cleared = await tx
      .update(cimSections)
      .set({ ddStaleAt: null })
      .where(and(eq(cimSections.id, section.id), stamp ? eq(cimSections.ddStaleAt, stamp) : isNull(cimSections.ddStaleAt)))
      .returning({ id: cimSections.id });
    if (cleared.length === 0) return false;
    await tx.delete(cimSectionOverrides).where(and(eq(cimSectionOverrides.cimSectionId, section.id), eq(cimSectionOverrides.mode, "dd")));
    await tx.insert(cimSectionOverrides).values({
      dealId: section.dealId,
      cimSectionId: section.id,
      mode: "dd",
      layoutData: result.layoutData,
      contentOverride: result.contentOverride,
    });
    return true;
  });
  if (!committed) throw new Error("changed");
  // Approved as it stands: the DD version a live CIM's DD buyers keep (shared/cim-published.ts).
  if (section.brokerApproved) await recordPublishedDd(section.dealId);
  return result.warning ? { warning: result.warning } : {};
}

/** After a full DD run: clear the stale mark of every section not edited since `startedAt`. */
export async function markDdFresh(dealId: string, startedAt: Date): Promise<void> {
  await db
    .update(cimSections)
    .set({ ddStaleAt: null })
    .where(and(eq(cimSections.dealId, dealId), lt(cimSections.ddStaleAt, startedAt)));
}

// ── The full DD run ("Generate" / "Refresh" on the CIM tab) ──────────────
//
// Runs in the background (a multi-minute request with no guard against a
// second click used to be the only way), one run per deal — shared with the
// builder's "Refresh DD" so the two never overlap. An AI failure never
// replaces a good DD version: a section whose enrichment failed on the
// service keeps its current DD version and stale mark, only sections that
// were actually written are marked fresh, and a run where nothing could be
// written changes nothing at all. (During an outage the old route deleted
// every DD version, inserted the plain named copies, marked them fresh —
// so "Refresh DD" skipped them — and said "Due-diligence version ready".)

/** Thrown by refreshSectionDd when the AI service failed: nothing was changed. */
export class DdUnavailableError extends Error {
  constructor(aiError?: unknown) {
    const why = aiError ? describeAiFailure(aiError) : null;
    super(`The AI service is unavailable${why ? ` (${why.reason})` : ""} — the section's DD version was kept. ${why ? `${why.advice[0].toUpperCase()}${why.advice.slice(1)}` : "Try again in a few minutes"}.`);
    this.name = "DdUnavailableError";
  }
}

/** Deals with a DD run in progress (the full run or the builder's refresh-all). */
export const ddRunning = new Set<string>();

export interface DdRunSummary {
  /** The run's start (the generate-dd response carries it, so the page can tell this run's result from an older one). */
  startedAt: string;
  finishedAt: string;
  /** Set when the run changed nothing (the AI service failed, or it crashed). */
  error?: string;
  /** Sections whose DD version was written this run. */
  written: number;
  /** Sections the AI couldn't write — their DD version (if any) was kept. */
  notWritten: number;
  warnings: string[];
}
const lastRuns = new Map<string, DdRunSummary>();

/** The last full DD run for the deal (kept in memory, for the CIM tab). */
export function lastDdRun(dealId: string): DdRunSummary | null {
  return lastRuns.get(dealId) ?? null;
}

/** Writes a run's results. Swappable for tests. */
export type DdRunWriter = (
  dealId: string,
  allSectionIds: string[],
  written: DdEnrichmentResult[],
  startedAt: Date,
  /** Sections the AI couldn't write this run (their DD version, if any, is kept). */
  notWrittenIds?: string[],
) => Promise<void>;

const dbRunWriter: DdRunWriter = async (dealId, allSectionIds, written, startedAt, notWrittenIds = []) => {
  const ids = written.map((w) => w.cimSectionId);
  await db.transaction(async (tx) => {
    // The written sections' old DD rows, and rows of sections since deleted.
    if (ids.length > 0) {
      await tx.delete(cimSectionOverrides).where(and(eq(cimSectionOverrides.dealId, dealId), eq(cimSectionOverrides.mode, "dd"), inArray(cimSectionOverrides.cimSectionId, ids)));
    }
    if (allSectionIds.length > 0) {
      await tx.delete(cimSectionOverrides).where(and(eq(cimSectionOverrides.dealId, dealId), eq(cimSectionOverrides.mode, "dd"), notInArray(cimSectionOverrides.cimSectionId, allSectionIds)));
    }
    if (written.length > 0) {
      await tx.insert(cimSectionOverrides).values(
        written.map((w) => ({ dealId, cimSectionId: w.cimSectionId, mode: "dd", layoutData: w.layoutData, contentOverride: w.contentOverride })),
      );
      // Fresh = written this run and not edited while it ran.
      await tx.update(cimSections).set({ ddStaleAt: null }).where(and(inArray(cimSections.id, ids), lt(cimSections.ddStaleAt, startedAt)));
    }
    // A section the AI couldn't write keeps its previous DD version — built
    // from the inputs before this run (a full re-run usually follows new
    // documents or a re-run analysis). It is marked out of date as of the
    // run's start: the builder then offers to refresh it ("Refresh DD", the
    // section's own button), and DD buyers see the current named content
    // instead of the old enrichment until it is (review F2-FINAL-3: it used
    // to stay "fresh", so only another full paid run could redo it). A mark
    // already there (an edit, before or during the run) is left as it is.
    if (notWrittenIds.length > 0) {
      await tx
        .update(cimSections)
        .set({ ddStaleAt: startedAt })
        .where(and(eq(cimSections.dealId, dealId), inArray(cimSections.id, notWrittenIds), isNull(cimSections.ddStaleAt)));
    }
  });
  // For sections approved as they stand, this is the DD version a live
  // CIM's DD buyers keep through a later unapproved change (published-versions.ts; never throws).
  if (written.length > 0) await recordPublishedDd(dealId);
};
/** The database writer itself (tests run it against a recording transaction). */
export const _dbRunWriterForTests: DdRunWriter = dbRunWriter;
let runWriter: DdRunWriter = dbRunWriter;
export function _setDdRunWriterForTests(writer: DdRunWriter | null) {
  runWriter = writer ?? dbRunWriter;
}

/** Pure: what a finished run writes, and whether it may write at all. */
export function planDdRun(results: DdEnrichmentResult[], sections: Array<Pick<CimSection, "id" | "layoutType">>): {
  write: DdEnrichmentResult[];
  notWritten: DdEnrichmentResult[];
  error: string | null;
} {
  const attempted = new Set(
    sections.filter((s) => s.layoutType !== "cover_page" && s.layoutType !== "divider" && !isMediaLayout(s.layoutType)).map((s) => String(s.id)),
  );
  const notWritten = results.filter(ddRetryable);
  const write = results.filter((r) => !ddRetryable(r));
  const attemptedCount = results.filter((r) => attempted.has(r.cimSectionId)).length;
  if (attemptedCount > 0 && notWritten.length >= attemptedCount) {
    const cause = notWritten.find((r) => r.aiError)?.aiError;
    const why = cause ? describeAiFailure(cause) : null;
    return {
      write: [],
      notWritten,
      error: `The AI service failed${why ? ` (${why.reason})` : ""} while writing the due-diligence version (${notWritten.length} of ${attemptedCount} sections). Nothing was changed — ${why?.advice ?? "try again in a few minutes"}.`,
    };
  }
  return { write, notWritten, error: null };
}

async function runFullDd(deal: Deal, sections: CimSection[], inputs: DdInputs, startedAt: Date): Promise<DdRunSummary> {
  const results = await generateDdOverrides(sections, { businessName: deal.businessName, industry: deal.industry }, inputs);
  const plan = planDdRun(results, sections);
  const warnings = results.map((r) => r.warning).filter((w): w is string => !!w);
  const started = startedAt.toISOString();
  if (plan.error) return { startedAt: started, finishedAt: new Date().toISOString(), error: plan.error, written: 0, notWritten: plan.notWritten.length, warnings };
  await runWriter(deal.id, sections.map((s) => String(s.id)), plan.write, startedAt, plan.notWritten.map((r) => r.cimSectionId));
  return { startedAt: started, finishedAt: new Date().toISOString(), written: plan.write.length, notWritten: plan.notWritten.length, warnings };
}

/**
 * Start the full DD run in the background (the caller loaded the inputs, so
 * their errors — e.g. a stale financial analysis — are answered at once).
 * Throws "running" when a DD run is already in progress for the deal.
 * Returns the run's promise for tests (the route doesn't wait for it).
 */
export function startFullDdGeneration(deal: Deal, sections: CimSection[], inputs: DdInputs, startedAt: Date): { done: Promise<DdRunSummary> } {
  if (ddRunning.has(deal.id)) throw new Error("running");
  ddRunning.add(deal.id);
  const done = runFullDd(deal, sections, inputs, startedAt)
    .catch((err): DdRunSummary => {
      console.error(`[dd-enrichment] DD run for deal ${deal.id} failed:`, err);
      return {
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
        error: "The due-diligence version couldn't be written. Nothing was changed — try again.",
        written: 0,
        notWritten: 0,
        warnings: [],
      };
    })
    .then((summary) => {
      lastRuns.set(deal.id, summary);
      ddRunning.delete(deal.id);
      return summary;
    });
  return { done };
}
