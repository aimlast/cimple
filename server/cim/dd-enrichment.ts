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
import { isMediaLayout } from "@shared/cim-media";
import Anthropic from "@anthropic-ai/sdk";
import { cimSections, cimSectionOverrides, type CimSection, type Deal } from "@shared/schema";
import { db } from "../db";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";
import { splitFactsForCim, factValueText } from "../information/cim-facts";
import { buildCimFinancials, pickAnalysisForCim, renderCimFinancialsBlock, type CimFinancials } from "./cim-financials";
import { isKnownFigure, knownFiguresFrom, normalizeForLookup, parseFigures, type Figure } from "./figure-check";
import { keepOutFromNotes, screenFactsForCim, type KeepOut } from "./sensitive-facts";
import { keepOutFor } from "./keep-out";
import type { ResolvedDiscrepancyNote } from "./resolved-block";
import { earningsCanon, screenEarningsFacts } from "./earnings-canon";
import { currentResolvedNotes, resolvedNotes, settleResolvedFacts } from "./resolved-block";
import { stampSourceDetails } from "../documents/merge-policy";

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
  const safe = screenEarningsFacts(screenFactsForCim(confirmed, keepOut).safe, canon, (k) => k).safe;

  const customerFacts = safe.filter(([k]) => CUSTOMER_KEY.test(k));
  if (customerFacts.length > 0) {
    parts.push(`## Real customer and supplier data (the only names you may reveal)\n${customerFacts.map(([k, v]) => `- ${k}: ${factValueText(v)}`).join("\n")}`);
  }

  if (input.addbackVerification) {
    const av = input.addbackVerification;
    const addbacks = (av.addbacks as any[]) || [];
    if (addbacks.length > 0) {
      parts.push(`## Add-back verification\nStatus: ${av.status}\n${addbacks.map((ab: any) =>
        `- ${ab.label}: ${ab.verificationStatus} (${ab.matchedTransactions?.length || 0} supporting transactions)`
      ).join("\n")}`);
    }
  }

  const fin = renderCimFinancialsBlock(financials);
  if (fin) parts.push(`## Verified financials (from the financial statements)\n${fin}`);

  const financialDocs = (input.documents ?? []).filter((d) =>
    d.visibility !== "broker_only" && (d.category === "financials" || d.category === "tax_returns" || d.category === "bank_statements"),
  );
  if (financialDocs.length > 0) {
    parts.push(`## Supporting documents on file\n${financialDocs.map((d) => `- ${d.name} (${d.category})`).join("\n")}`);
  }

  const context = parts.join("\n\n") || "No additional DD data available.";
  const factsText = safe.map(([k, v]) => `${k}: ${factValueText(v)}`).join("\n");
  return { context, knownText: `${factsText}\n${context}` };
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
    financials: buildCimFinancials(pickAnalysisForCim(analyses)),
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

function namesIn(text: string): string[] {
  return Array.from(stripDdMarkers(text).matchAll(NAME_RE)).map((m) => m[1].trim());
}

/**
 * Check a DD enrichment against its base section. Problems (empty = safe):
 *  - a figure of the base section changed or disappeared (DD never changes
 *    an approved figure);
 *  - a new figure that isn't in the facts or the DD context;
 *  - a new name (company, person) that isn't on file — no invented entities;
 *  - internal process wording ("per confirmed facts", "teaser", …).
 */
export function validateDdOverride(
  base: { layoutData: unknown; content: string },
  enriched: { layoutData: unknown; contentOverride: string },
  knownText: string,
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
    if (baseNames.has(norm) || knownNorm.includes(norm)) continue;
    const words = norm.trim().split(" ").filter((w) => w.length >= 4);
    if (words.length > 0 && words.every((w) => knownNorm.includes(` ${w} `))) continue;
    problems.push(`named "${name}", which isn't on file`);
  }
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
  const problems = validateDdOverride({ layoutData, content }, clean, inputs.knownText);
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
  return result.warning ? { warning: result.warning } : {};
}

/** After a full DD run: clear the stale mark of every section not edited since `startedAt`. */
export async function markDdFresh(dealId: string, startedAt: Date): Promise<void> {
  await db
    .update(cimSections)
    .set({ ddStaleAt: null })
    .where(and(eq(cimSections.dealId, dealId), lt(cimSections.ddStaleAt, startedAt)));
}
