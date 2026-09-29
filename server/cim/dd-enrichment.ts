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
import { and, eq, isNull, lt } from "drizzle-orm";
import { isMediaLayout, isRegionWord, REGION_NAMES } from "@shared/cim-media";
import { isBroadRegionWord, isCommonWord } from "@shared/blind-vocabulary";
import Anthropic from "@anthropic-ai/sdk";
import { cimSections, cimSectionOverrides, type CimSection, type Deal } from "@shared/schema";
import { db } from "../db";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";
import { splitFactsForCim, factValueText } from "../information/cim-facts";
import { cimFinancialsFor, renderCimFinancialsBlock, type CimFinancials } from "./cim-financials";
import { isBridgeAddback } from "../financial/addback-seed";
import { isDistributionLine } from "../financial/normalization-rules";
import { isKnownFigure, knownFiguresFrom, normalizeForLookup, parseFigures, type Figure } from "./figure-check";
import { keepOutFromNotes, mentionsHeldPerson, neutralBridgeLabel, screenConfidentialText, screenFactsForCim, type KeepOut } from "./sensitive-facts";
import { keepOutFor } from "./keep-out";
import type { ResolvedDiscrepancyNote } from "./resolved-block";
import { earningsCanon, screenEarningsFacts } from "./earnings-canon";
import { currentResolvedNotes, resolvedNotes, settleResolvedFacts } from "./resolved-block";
import { stampSourceDetails } from "../documents/merge-policy";
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
      parts.push(`## Add-back verification\nStatus: ${av.status}\n${addbacks.map((ab: any) =>
        `- ${heldLabel(ab.label, heldNames)}: ${ab.verificationStatus} (${ab.matchedTransactions?.length || 0} supporting transactions)`
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

function namesIn(text: string): string[] {
  return Array.from(stripDdMarkers(text).matchAll(NAME_RE))
    .map((m) => {
      // "The Receivables Ledger": the opening "The" belongs to the sentence, not the name.
      const words = m[1].trim().replace(/[.,;:]+$/, "").split(/\s+/);
      while (words.length > 0 && FUNCTION_WORDS.has(words[0].toLowerCase())) words.shift();
      return words.join(" ");
    })
    .filter((n) => n.includes(" "));
}

// ── Revealed labels and names ────────────────────────────────────────────

/** Row fields that name what the row is (a chart slice, a table row, a card). */
const LABEL_KEYS = ["name", "label", "title", "customer", "client", "company", "supplier", "vendor"];
/** Row fields that hold the row's own figure. */
const ROW_VALUE_KEYS = ["value", "secondaryValue", "percent", "percentage", "share", "amount", "revenue"];

/** An anonymised or generic label ("Customer A", "Top 5 customers", "Other") — not a name. */
const GENERIC_ROW_LABEL =
  /^(?:customer|client|supplier|vendor|account|payer|carrier|contractor|distributor)s?\s+(?:[a-z]|\d{1,2}|#\d{1,2})$|\bothers?\b|\bremaining\b|\ball other|\brest of\b|\btop \d+|\blong tail\b|^\d/i;

interface ChangedLabel {
  label: string;
  /** What the same field said in the base section ("" for a new row). */
  baseLabel: string;
  /** The row the label names (its figures are the label's). */
  row: Record<string, unknown>;
}

/**
 * Labels the enrichment changed or added, row by row (charts, tables, cards):
 * a revealed customer name sits here, where the prose check can't see it.
 */
function changedLabels(base: unknown, next: unknown, out: ChangedLabel[] = [], depth = 0): ChangedLabel[] {
  if (depth > 8 || next == null) return out;
  if (Array.isArray(next)) {
    const b = Array.isArray(base) ? base : [];
    next.forEach((row, i) => {
      if (row && typeof row === "object" && !Array.isArray(row)) {
        const r = row as Record<string, unknown>;
        const br = (b[i] && typeof b[i] === "object" ? b[i] : {}) as Record<string, unknown>;
        for (const k of LABEL_KEYS) {
          const v = r[k];
          if (typeof v === "string" && v.trim() && stripDdMarkers(v).trim() !== stripDdMarkers(String(br[k] ?? "")).trim()) {
            out.push({ label: stripDdMarkers(v).trim(), baseLabel: stripDdMarkers(String(br[k] ?? "")).trim(), row: r });
          }
        }
      }
      changedLabels(b[i], row, out, depth + 1);
    });
    return out;
  }
  if (typeof next === "object") {
    const b = (base && typeof base === "object" ? base : {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(next as Record<string, unknown>)) changedLabels(b[k], v, out, depth + 1);
  }
  return out;
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
  return [...head.split(/\s+[-—–]\s+|\s*[—–]\s*|:\s+|\s+\/\s+|\s*\|\s*/), ...asides]
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
  return /\d/.test(l) || FUNCTION_WORDS.has(l) || LEGAL_WORD.test(l) || isCommonWord(l) || isRegionWord(l) || isBroadRegionWord(l);
}

/**
 * Capitalised words in a descriptive label part ("anchor account since
 * 2011", "Largest account, served by Sysco") that aren't on file: the
 * one-word name a two-word pattern can't see.
 */
function unknownCapitals(part: string, baseWords: Set<string>, knownWords: Set<string>): string[] {
  const out: string[] = [];
  for (const tok of part.match(/[A-Za-z][A-Za-z0-9&'’-]*/g) ?? []) {
    if (!/^[A-Z]/.test(tok) || tok.length < 3) continue;
    if (/^[A-Z0-9&-]+$/.test(tok) && tok.length <= 5) continue; // an acronym (MSA, YTD, CRA)
    const w = tok.replace(/['’]s$/i, "").toLowerCase();
    if (baseWords.has(w) || knownWords.has(w) || ordinaryWord(w)) continue;
    out.push(tok.replace(/['’]s$/i, ""));
  }
  return out;
}

/** Is the name written in the file (whole, as a phrase — not just its first word)? */
function onFile(name: string, knownNorm: string): boolean {
  const norm = normalizeForLookup(name).trim();
  return !norm || knownNorm.includes(` ${norm} `);
}

const figureClose = (a: number, b: number) => Math.abs(a - b) <= Math.max(0.05, Math.abs(b) * 0.005);

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
function statedFigureFor(name: string, knownText: string): number[] {
  const out: number[] = [];
  const clauses = stripDdMarkers(knownText).split(/[;\n]|(?<=[.!?])\s+/);
  const re = new RegExp(String.raw`(?<![\p{L}\p{N}])${name.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(String.raw`\s+`)}(?![\p{L}\p{N}])`, "giu");
  const figs = (t: string) => parseFigures(t).filter((f) => f.kind !== "plain");
  for (const clause of clauses) {
    for (const m of Array.from(clause.matchAll(re))) {
      const at = m.index ?? 0;
      const after = figs(mentionWindow(clause.slice(at + m[0].length)));
      if (after.length > 0) {
        out.push(...after.map((f) => f.value));
        continue;
      }
      const before = figs(clause.slice(Math.max(0, at - 40), at));
      if (before.length > 0) out.push(before[before.length - 1].value);
    }
  }
  return Array.from(new Set(out));
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
function rowFigures(row: Record<string, unknown>): number[] {
  const texts: string[] = [];
  for (const k of ROW_VALUE_KEYS) if (row[k] != null && row[k] !== "") texts.push(String(row[k]));
  if (Array.isArray(row.values)) for (const v of row.values) if (v != null && v !== "") texts.push(String(v));
  const out: number[] = [];
  for (const t of texts) {
    const n = Number(String(t).replace(/[,$%\s]/g, ""));
    if (/^\s*-?[\d,.]+\s*%?\s*$/.test(t) && Number.isFinite(n)) out.push(n);
    else out.push(...parseFigures(t).map((f) => f.value));
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
  for (const m of Array.from(rawText.matchAll(WORD))) {
    const tok = m[0];
    if (tok === "[[dd]]") { afterOpen = true; continue; }
    if (tok === "[[/dd]]") continue;
    if (/^[.!?:]$/.test(tok)) { prev = tok; continue; }
    const sentenceStart = /^[.!?:]$/.test(prev);
    const checked = afterOpen || !sentenceStart;
    afterOpen = false;
    prev = tok;
    if (!checked || !/^[A-Z]/.test(tok) || tok.length < 3) continue;
    const w = tok.replace(/['’]s$/i, "").toLowerCase();
    if (baseWords.has(w) || knownWords.has(w) || ordinaryWord(w)) continue;
    if (/^[A-Z0-9&-]+$/.test(tok) && tok.length <= 5) continue; // an acronym (EBITDA, CRA, HST)
    out.add(tok.replace(/['’]s$/i, ""));
  }
  return Array.from(out);
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
    const words = norm.trim().split(" ").filter((w) => w.length >= 4);
    if (words.length > 0 && words.every((w) => knownNorm.includes(` ${w} `))) continue;
    problems.push(`named "${name}", which isn't on file`);
  }
  // 3a. A name it reveals in the prose ([[dd]] … [[/dd]]) is on file as a
  // whole — "Brightway Logistics" built from two words the file uses for
  // two different parties is an invented name, as it is in a label.
  const spans = Array.from(newText.matchAll(/\[\[dd\]\]([\s\S]*?)\[\[\/dd\]\]/g)).map((m) => m[1]).join(" | "); // never one name across two spans
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
  for (const { label, baseLabel, row } of changedLabels(base.layoutData, enriched.layoutData)) {
    const parts = labelParts(label);
    const reveal = [...parts, ...labelParts(baseLabel)].some((p) => GENERIC_ROW_LABEL.test(p));
    const names: string[] = [];
    for (const part of parts) {
      if (GENERIC_ROW_LABEL.test(part) || !/[A-Za-z]{2,}/.test(part)) continue;
      if (!isNameLike(part)) {
        // A description ("anchor account since 2011"): only a capitalised word in it can name someone.
        for (const w of unknownCapitals(part, baseWords, knownWords)) flag(w);
        continue;
      }
      if (onFile(part, knownNorm) || baseNames.has(normalizeForLookup(part))) {
        names.push(part);
        continue;
      }
      if (isPlaceOrPublicBody(part)) continue;
      // A heading in title case ("Bank Deposits", "Verified Add-backs") names nothing — unless it took the place of "Customer A".
      if (!reveal && part.split(/\s+/).every((w) => NAME_CONNECTORS.has(w.toLowerCase()) || ordinaryWord(w) || lowerWords.has(w.toLowerCase()))) continue;
      flag(part);
    }
    const shown = rowFigures(row);
    for (const name of names) {
      const stated = statedFigureFor(name, knownText);
      if (stated.length > 0 && shown.length > 0 && !shown.some((v) => stated.some((s) => figureClose(Math.abs(v), Math.abs(s))))) {
        problems.push(`shows "${name}" at ${shown.map((v) => v.toLocaleString("en-US")).join(" / ")}, but the file gives it ${stated.map((v) => v.toLocaleString("en-US")).join(" / ")}`);
      }
    }
  }
  // 3c. One-word names in the prose it added.
  const proseNew = [...proseTexts(enriched.layoutData), enriched.contentOverride || ""].join("\n");
  for (const w of unknownSingleNames(proseNew, baseWords, knownWords)) flag(w);
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
  const keep = (warning?: string): DdEnrichmentResult => ({ cimSectionId: String(section.id), layoutData, contentOverride: content, ...(warning ? { warning } : {}) });

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
    return keep(`DD version of "${section.sectionTitle}" couldn't be written — it shows the named CIM.`);
  }
  if (!parsed || !parsed.layoutData || typeof parsed.layoutData !== "object") {
    return keep(`DD version of "${section.sectionTitle}" couldn't be written — it shows the named CIM.`);
  }

  const clean = sanitizeDdOutput(parsed.layoutData, typeof parsed.contentOverride === "string" ? parsed.contentOverride : content);
  const problems = validateDdOverride({ layoutData, content }, clean, inputs.knownText, inputs.heldNames ?? []);
  if (problems.length > 0) {
    console.warn(`[dd-enrichment] section ${section.id} rejected: ${problems.join("; ")}`);
    return keep(`DD version of "${section.sectionTitle}" kept as the named CIM — the enrichment ${problems.slice(0, 3).join("; ")}.`);
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
