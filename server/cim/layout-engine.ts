import Anthropic from "@anthropic-ai/sdk";
import type { CimLayoutSection, CimDocument, LayoutType } from "./layout-types.js";
import {
  getCimLayout,
  layoutSpecsForPrompt,
  normalizeLayoutType,
  plannerLayouts,
} from "@shared/cim-layouts";
import { agentConfig } from "../interview/config/load-config";
import { getFieldSources, isFactKey } from "../interview/info-merger";
import { splitFactsForCim, factValueText, isLeadFact, CIM_LEADS_HEADING } from "../information/cim-facts";
import { normalizeLocationMap, normText } from "@shared/cim-media";
import type { CimSectionOutline } from "@shared/cim-theme";
import { renderResolvedBlock, type ResolvedDiscrepancyNote } from "./resolved-block";
import { analysisHeadlines, renderCimFinancialsBlock, type CimFinancials } from "./cim-financials";
import { checkSectionFigures, figureWarningText, knownFiguresFrom, parseFigures, type KnownFigures } from "./figure-check";
import { screenFactsForCim, screenText, type HeldFact } from "./sensitive-facts";
import { repairInferredYears } from "./fact-dates";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 600_000, // 10 min headroom across the batched generation calls
});

/**
 * Every model call here is STREAMED: a long non-streaming call sits idle on
 * the socket for minutes and was dropped mid-planning ("Connection error.",
 * Pacific 2026-09-26), failing the whole job. A transport failure (dropped
 * connection, timeout, overload) is retried once before it counts.
 */
type MessagesClient = { messages: { stream: (body: any) => { finalMessage: () => Promise<any> } } };
let client: MessagesClient = anthropic as unknown as MessagesClient;
let transportRetryDelayMs = 3000;
/** Tests swap in a fake client (and a short retry delay). */
export function _setAnthropicForTests(fake: MessagesClient | null, retryDelayMs = 3000) {
  client = fake ?? (anthropic as unknown as MessagesClient);
  transportRetryDelayMs = retryDelayMs;
}

export function isTransportError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // includes APIConnectionTimeoutError
  const status = (err as { status?: number })?.status;
  if (status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529) return true;
  const msg = String((err as Error)?.message ?? "");
  return /connection error|econnreset|socket hang up|timed? ?out|terminated|overloaded|network/i.test(msg);
}

async function callModel(body: Record<string, unknown>, what: string): Promise<any> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.messages.stream(body).finalMessage();
    } catch (err) {
      if (attempt >= 1 || !isTransportError(err)) throw err;
      console.warn(`[layout-engine] ${what}: transport error (${(err as Error)?.message}) — retrying once`);
      await new Promise((r) => setTimeout(r, transportRetryDelayMs));
    }
  }
}

// Supporting-agent model (Sonnet). Every call in this file shares one cached
// system prefix, so they must all use the same model.
const MODEL = agentConfig.models.supportingAgents;

/**
 * generateCimLayout
 *
 * Takes the full knowledge base for a deal and generates a completely
 * bespoke CIM document blueprint. The AI decides:
 *   - How many sections the CIM needs
 *   - What each section is called and covers
 *   - The best visual format for each piece of content
 *   - The structured data to populate each section
 *
 * TWO-PHASE PIPELINE. The original implementation generated the entire
 * document (14-22 fully-populated sections) in ONE 16K-token response.
 * Data-rich deals — exactly the flagship deals brokerages care about —
 * routinely blew that limit mid-JSON: the tail sections (financials and
 * transaction, generated last) silently vanished behind a "success" toast,
 * or the broker got a raw JSON-repair error.
 *
 * Now:
 *   Phase 1 — one small call plans the document: a manifest of sections
 *             (key, title, layout type, one-line brief). ~1-2K tokens,
 *             structurally immune to truncation.
 *   Phase 2 — each section's full layoutData is generated in parallel
 *             batches, one small call per section, with the manifest as
 *             sibling context. A section that fails after retry degrades
 *             to a prose fallback and is reported in document.warnings —
 *             sections are never silently dropped.
 *
 * All calls share one cached system prefix (rules + layout specs + the
 * deal knowledge base), so phase 2 reads the prompt from Anthropic's
 * cache instead of re-paying for it per section.
 */
export interface EngagementInsightInput {
  sectionType: string;
  layoutType: string;
  avgTimeSpentSeconds: number;
  sampleCount: number;
}

interface ManifestEntry {
  sectionKey: string;
  sectionTitle: string;
  order: number;
  layoutType: string;
  tags: string[];
  aiLayoutReasoning: string;
  /** One-line description of what this section must cover */
  contentBrief: string;
}

type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

export interface CimLayoutParams {
  dealId: string;
  businessName: string;
  industry: string;
  askingPrice?: string | null;
  extractedInfo: Record<string, unknown>;
  /** Broker-resolved discrepancies — rendered as the "RESOLVED — FINAL VALUES" block. */
  resolvedDiscrepancies?: ResolvedDiscrepancyNote[] | null;
  scrapedData?: Record<string, unknown> | null;
  questionnaireData?: Record<string, unknown> | null;
  operationalSystems?: Record<string, unknown> | null;
  employeeChart?: unknown[] | null;
  cimContent?: Record<string, string> | null; // existing text content from phase 3
  brokerBranding?: {
    companyName?: string;
    primaryColor?: string;
  } | null;
  engagementInsights?: EngagementInsightInput[] | null;
  /**
   * The design template's section outline ("Match my existing CIM"): the
   * planner follows this order and these titles; toneNotes guide the writer.
   */
  sectionOutline?: CimSectionOutline | null;
  /**
   * The deal's financial analysis (the broker-reviewed one, else the latest
   * completed), with every total computed — cim-financials.ts. Statement
   * tables and bridges are copied from it.
   */
  financials?: CimFinancials | null;
  /** "Today" for the writer and the cover date. Defaults to now (tests pin it). */
  today?: Date;
  /**
   * For interview facts that state a "Month YYYY": the seller's own words on
   * the turn that recorded the fact, and when — so a year the seller never
   * said is taken out before the writer sees it (fact-dates.ts).
   */
  factSourceWords?: Record<string, { words: string; at: string }> | null;
}

/**
 * Shared, cached prefix: identical bytes for the manifest call and every
 * section call, so Anthropic's prompt cache serves it after the first call.
 */
interface SharedSystem extends SystemBlock {
  /** Every number / name the writer was given — the figure check's reference. */
  known: KnownFigures;
  /** Warnings raised while assembling the knowledge base (held personal details, figure conflicts). */
  kbWarnings: string[];
  today: Date;
}

function buildSharedSystem(params: CimLayoutParams): SharedSystem {
  const kb = assembleKnowledgeBase(params);
  return {
    type: "text",
    text: `${DESIGN_AGENT_RULES}\n\n# DEAL KNOWLEDGE BASE\n\n${kb.text}`,
    cache_control: { type: "ephemeral" },
    // Figures are checked against the source blocks only — never against
    // leads, earlier AI drafts or the unverified scrape.
    known: knownFiguresFrom(kb.sourceText),
    kbWarnings: kb.warnings,
    today: params.today ?? new Date(),
  };
}

/** The API block only (the extra fields are ours). */
function apiBlock(s: SystemBlock): SystemBlock {
  return { type: s.type, text: s.text, ...(s.cache_control ? { cache_control: s.cache_control } : {}) };
}

/** Progress callback for generateCimLayout — fired as the run advances. */
export interface LayoutProgress {
  phase: "planning" | "writing";
  /** Sections planned; 0 while planning. */
  total: number;
  /** Sections finished writing. */
  done: number;
  /** Title of the section that just finished (writing phase only). */
  lastTitle?: string;
}

export async function generateCimLayout(
  params: CimLayoutParams,
  onProgress?: (p: LayoutProgress) => void,
): Promise<CimDocument> {

  const warnings: string[] = [];
  const sharedSystem = buildSharedSystem(params);
  warnings.push(...sharedSystem.kbWarnings);

  // ── Phase 1: plan the document ─────────────────────────────────────────
  onProgress?.({ phase: "planning", total: 0, done: 0 });
  const manifest = await generateManifest(sharedSystem, params.sectionOutline ?? null);
  onProgress?.({ phase: "writing", total: manifest.length, done: 0 });

  // ── Phase 2: generate each section's content in parallel batches ──────
  const BATCH_SIZE = 5;
  const generated: CimLayoutSection[] = [];
  let finished = 0;
  for (let i = 0; i < manifest.length; i += BATCH_SIZE) {
    const batch = manifest.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((entry) =>
        generateSection(sharedSystem, entry, manifest, warnings).then((section) => {
          finished += 1;
          onProgress?.({ phase: "writing", total: manifest.length, done: finished, lastTitle: entry.sectionTitle });
          return section;
        }),
      ),
    );
    generated.push(...results);
  }

  // ── Phase 3: every figure must trace to the deal's data ────────────────
  // A section whose figures or names can't be traced is rewritten once with
  // the exact problems; whatever is still off is reported to the broker.
  await checkAndRepairFigures(sharedSystem, manifest, generated, warnings);

  // Validate and normalise. A layout type outside the registry has no
  // renderer — it would reach buyers as a blank or raw-data block — so it
  // degrades to a narrative section.
  let sections: CimLayoutSection[] = generated.map((s, i) => ({
    sectionKey: s.sectionKey || `section_${i + 1}`,
    sectionTitle: s.sectionTitle || `Section ${i + 1}`,
    order: s.order ?? i + 1,
    layoutType: normalizeLayoutType(s.layoutType) as LayoutType,
    layoutData: finalizeLayoutData(normalizeLayoutType(s.layoutType), (s.layoutData || {}) as Record<string, unknown>, sharedSystem.today) as CimLayoutSection["layoutData"],
    aiDraftContent: s.aiDraftContent,
    aiLayoutReasoning: s.aiLayoutReasoning || "",
    tags: Array.isArray(s.tags) ? s.tags : [],
    isVisible: s.isVisible !== false,
    brokerApproved: false,
    brokerEditedContent: undefined,
    layoutOverride: undefined,
    ...(s.figureWarnings?.length ? { figureWarnings: s.figureWarnings } : {}),
  }));

  // A map must show a real address from the deal's facts — never one the AI
  // made up. Ungrounded locations are dropped, and an empty map with them.
  sections = sections
    .map((s) => (s.layoutType === "location_map" ? { ...s, layoutData: groundLocationMap(s.layoutData, params) } : s))
    .filter((s) => s.layoutType !== "location_map" || ((s.layoutData as { locations?: unknown[] }).locations?.length ?? 0) > 0);
  sections.forEach((s, i) => { s.order = i + 1; });

  // Ensure cover_page is first
  const coverIdx = sections.findIndex(s => s.layoutType === "cover_page");
  if (coverIdx > 0) {
    const [cover] = sections.splice(coverIdx, 1);
    sections.unshift(cover);
    sections.forEach((s, i) => { s.order = i + 1; });
  }

  if (warnings.length > 0) {
    console.warn(`[layout-engine] Generated with ${warnings.length} warning(s):`, warnings);
  }

  return {
    dealId: params.dealId,
    sections,
    generatedAt: new Date().toISOString(),
    version: 1,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Keep only map locations whose address is in the deal's facts (its street
 * number(s) and street name appear there). The AI is told to copy addresses
 * verbatim; this makes sure a guessed or completed one never reaches a buyer.
 */
export function groundLocationMap(layoutData: unknown, params: Pick<CimLayoutParams, "extractedInfo" | "scrapedData" | "questionnaireData">): Record<string, unknown> {
  const map = normalizeLocationMap(layoutData);
  const facts = normText(JSON.stringify([params.extractedInfo ?? {}, params.scrapedData ?? {}, params.questionnaireData ?? {}]));
  const grounded = (address: string) => {
    const street = address.split(/[,\n]/)[0] || "";
    const numbers = street.match(/\d+/g) || [];
    const words = (street.match(/[A-Za-z]{4,}/g) || []).map((w) => w.toLowerCase());
    return numbers.length > 0 && numbers.every((n) => facts.includes(n)) && words.some((w) => facts.includes(w));
  };
  return { ...map, locations: map.locations.filter((l) => !!l.address && grounded(l.address)) } as unknown as Record<string, unknown>;
}

/** "September 2026" — the cover's date, always the month the CIM is written. */
export function coverMonth(today: Date): string {
  return today.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * Fields the system owns, applied to whatever the AI returned. The cover's
 * "Prepared by" is presentation-only — the renderer shows the brokerage
 * from its brand settings; an AI-filled value once credited the seller's
 * accountant (and named it on the blind cover). Its date is the month the
 * CIM was written, never one the AI made up.
 */
export function finalizeLayoutData(layoutType: string, layoutData: Record<string, unknown>, today: Date): Record<string, unknown> {
  if (layoutType !== "cover_page") return layoutData;
  const { preparedBy: _preparedBy, ...rest } = layoutData as Record<string, unknown> & { preparedBy?: unknown };
  return { ...rest, date: coverMonth(today) };
}

/**
 * Figure-check a set of freshly written sections; a flagged section is
 * rewritten once with the exact problems. Sections still flagged carry
 * `figureWarnings` and one line each in `warnings`.
 */
async function checkAndRepairFigures(
  sharedSystem: SharedSystem,
  manifest: ManifestEntry[],
  sections: CimLayoutSection[],
  warnings: string[],
): Promise<void> {
  const flagged = sections
    .map((s, i) => ({ i, issues: isFallback(s) ? [] : checkSectionFigures(s, sharedSystem.known) }))
    .filter((f) => f.issues.length > 0);
  if (flagged.length > 0) {
    console.log(`[layout-engine] figure check: ${flagged.length} section(s) flagged, rewriting once — ${flagged.map((f) => `"${sections[f.i].sectionTitle}" (${f.issues.length})`).join(", ")}`);
  }
  const BATCH_SIZE = 5;
  for (let b = 0; b < flagged.length; b += BATCH_SIZE) {
    await Promise.all(
      flagged.slice(b, b + BATCH_SIZE).map(async ({ i, issues }) => {
        const section = sections[i];
        const entry = manifest.find((m) => m.sectionKey === section.sectionKey);
        let final = issues;
        if (entry) {
          const repaired = await writeSectionContent(sharedSystem, { ...entry, layoutType: section.layoutType }, manifest, repairFeedback(issues)).catch(() => null);
          if (repaired) {
            const candidate = { ...section, layoutData: repaired.layoutData, aiDraftContent: repaired.aiDraftContent };
            const after = checkSectionFigures(candidate, sharedSystem.known);
            // Keep whichever version has fewer untraced figures.
            if (after.length <= issues.length) {
              sections[i] = candidate;
              final = after;
            }
          }
        }
        if (final.length > 0) {
          sections[i] = { ...sections[i], figureWarnings: final };
          warnings.push(figureWarningText(section.sectionTitle, final));
        }
      }),
    );
  }
}

function isFallback(s: CimLayoutSection): boolean {
  return s.aiLayoutReasoning === FALLBACK_REASONING;
}

function repairFeedback(issues: string[]): string {
  return [
    "Your previous draft of this section failed the figure check:",
    ...issues.map((m) => `- ${m}`),
    "Rewrite it. Every figure must be copied from the knowledge base (AUTHORITATIVE FINANCIALS for statement lines, totals and bridges; CANONICAL FIGURES and the facts otherwise). Where the knowledge base has no figure, leave the cell empty (\"\") or drop that row, year or chart item — never estimate, compute or round to a new number. Name only customers and suppliers exactly as the knowledge base names them; otherwise describe them without a name.",
  ].join("\n");
}

/**
 * The figure check for one section against the deal's current knowledge
 * base — used after single-section writes (regenerate, add, convert).
 */
export function sectionFigureWarnings(
  params: CimLayoutParams,
  section: { sectionTitle: string; layoutType: string; layoutData: unknown; tags?: unknown },
): string[] {
  const kb = assembleKnowledgeBase(params);
  return checkSectionFigures(section, knownFiguresFrom(kb.sourceText));
}

/** The subset of a stored section needed to rebuild one of its siblings. */
export interface ExistingSectionRef {
  sectionKey: string;
  sectionTitle: string;
  order: number;
  layoutType: string;
  tags?: unknown;
  aiLayoutReasoning?: string | null;
}

/** A section to (re)write: an existing one, or a new one the broker is adding. */
export interface SectionTarget {
  sectionKey: string;
  sectionTitle: string;
  order: number;
  layoutType: string;
  tags?: unknown;
  aiLayoutReasoning?: string | null;
}

/**
 * writeOneSection — shared by "Regenerate this section" and the CIM builder's
 * "Add section → write it from the deal's information".
 *
 * Builds a manifest from the current document with `target` in its place
 * (replacing the existing section with the same key, or inserted at
 * target.order when it is new), then generates just that one section with
 * the rest of the document as sibling context. Nothing else is touched.
 *
 * Throws if the section could not be generated — the caller keeps whatever it
 * had. A write must never silently land a placeholder.
 */
export async function writeOneSection(
  params: CimLayoutParams,
  existing: ExistingSectionRef[],
  target: SectionTarget,
  options: { brief?: string } = {},
): Promise<CimLayoutSection> {
  const sharedSystem = buildSharedSystem(params);
  const layoutType = normalizeLayoutType(target.layoutType);
  const tagsOf = (t: unknown) => (Array.isArray(t) ? (t as string[]) : []);
  const others: ManifestEntry[] = existing
    .filter((s) => s.sectionKey !== target.sectionKey)
    .map((s) => ({
      sectionKey: s.sectionKey,
      sectionTitle: s.sectionTitle,
      order: s.order,
      layoutType: s.layoutType,
      tags: tagsOf(s.tags),
      aiLayoutReasoning: s.aiLayoutReasoning || "",
      contentBrief: `${s.sectionTitle}${tagsOf(s.tags).length ? ` (${tagsOf(s.tags).join(", ")})` : ""}`,
    }));
  const isNew = !existing.some((s) => s.sectionKey === target.sectionKey);
  const brief = options.brief?.trim();
  const entry: ManifestEntry = {
    sectionKey: target.sectionKey,
    sectionTitle: target.sectionTitle,
    order: target.order,
    layoutType,
    tags: tagsOf(target.tags),
    aiLayoutReasoning: target.aiLayoutReasoning || (isNew ? "Added by the broker in the CIM builder." : ""),
    contentBrief: brief
      ? brief
      : isNew
        ? `Write the "${target.sectionTitle}" section from the knowledge base. Cover what a buyer needs to know about this topic; do not repeat what sibling sections already cover.`
        : `Rebuild "${target.sectionTitle}" from the knowledge base with the same scope it has today.`,
  };
  // Siblings keep their order; the target sits at its slot (after the
  // sibling already holding that number).
  const manifest = [...others, entry].sort(
    (a, b) => a.order - b.order || (a === entry ? 1 : b === entry ? -1 : 0),
  );

  const warnings: string[] = [];
  const section = await generateSection(sharedSystem, entry, manifest, warnings);
  if (warnings.length > 0) {
    throw new Error(
      isNew
        ? "The AI couldn't write this section. Try again, or start it blank."
        : "The section could not be regenerated. The existing version was kept — please try again.",
    );
  }
  const checked = [section];
  await checkAndRepairFigures(sharedSystem, manifest, checked, []);
  const out = checked[0];
  return { ...out, layoutData: finalizeLayoutData(out.layoutType, (out.layoutData || {}) as Record<string, unknown>, sharedSystem.today) as any };
}

/**
 * regenerateCimSection
 *
 * Rebuilds ONE section of an existing CIM with the same knowledge base and
 * the current document as sibling context, leaving every other section
 * untouched. Used by the per-section "Regenerate" action — "Regenerate All"
 * is the only thing that should ever rebuild the whole document.
 *
 * Throws if the section could not be generated (the caller keeps the old
 * section) — a regenerate must never silently replace content with a
 * placeholder.
 */
export async function regenerateCimSection(
  params: CimLayoutParams,
  existing: ExistingSectionRef[],
  target: ExistingSectionRef,
  options: { layoutType?: string; brief?: string } = {},
): Promise<CimLayoutSection> {
  if (!existing.some((s) => s.sectionKey === target.sectionKey)) {
    throw new Error("Section is not part of the current CIM.");
  }
  return writeOneSection(
    params,
    existing,
    { ...target, layoutType: options.layoutType || target.layoutType },
    { brief: options.brief },
  );
}

// ── Rewrite / convert one section (CIM builder) ─────────────────────────────

export const REWRITE_TONES = ["concise", "detailed", "persuasive", "formal", "plain_english"] as const;
export type RewriteTone = (typeof REWRITE_TONES)[number];
export type RewriteLength = "shorter" | "same" | "longer";

const TONE_GUIDE: Record<RewriteTone, string> = {
  concise: "Concise — tight sentences, no padding, lead with the point.",
  detailed: "Detailed — add specifics from the knowledge base (figures, examples, context) where they strengthen the section.",
  persuasive: "Persuasive — frame strengths for a buyer: why this matters to an acquirer, what it de-risks. Stay factual; no hype words.",
  formal: "Formal — the register of a professional offering memorandum.",
  plain_english: "Plain English — short words, no jargon; a first-time buyer must understand every sentence.",
};

const LENGTH_GUIDE: Record<RewriteLength, string> = {
  shorter: "Make it noticeably shorter (roughly 40-60% of the current length). Keep the most important facts.",
  same: "Keep roughly the same length.",
  longer: "Make it longer (roughly 1.5-2x) by adding real detail from the knowledge base — never filler, never invented facts.",
};

/** The section as it stands today, for rewrite/convert prompts. */
export interface SectionContentRef {
  sectionKey: string;
  sectionTitle: string;
  layoutType: string;
  layoutData: unknown;
  /** The prose the renderer shows today (broker edit → body → AI draft). */
  prose: string;
}

const BUILDER_TOOL = {
  name: "cim_section",
  description: "The full content for one CIM section.",
  input_schema: {
    type: "object" as const,
    required: ["layoutData"],
    properties: {
      layoutData: {
        type: "object",
        description: "The structured data for this section's layout type, exactly matching the shape in the layout spec.",
      },
      aiDraftContent: {
        type: "string",
        description: "The section's prose as one plain-text string (paragraphs separated by a blank line). Required for prose_highlight (the same text as layoutData.body) and two_column (the prose column); optional elsewhere.",
      },
    },
  },
} as const;

type SectionContent = { layoutData: Record<string, unknown>; aiDraftContent?: string };

async function callBuilderTool(sharedSystem: SystemBlock, task: string, userMessage: string): Promise<SectionContent | null> {
  const response = await callModel({
    model: MODEL,
    max_tokens: 10000,
    system: [apiBlock(sharedSystem), { type: "text", text: task }],
    tools: [BUILDER_TOOL],
    tool_choice: { type: "tool", name: "cim_section" },
    messages: [{ role: "user", content: userMessage }],
  }, "builder");
  if (response.stop_reason === "max_tokens") return null;
  const block = response.content.find((b: { type: string }) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") return null;
  const input = block.input as { layoutData?: unknown; aiDraftContent?: unknown };
  if (!input.layoutData || typeof input.layoutData !== "object" || Array.isArray(input.layoutData)) return null;
  return {
    layoutData: input.layoutData as Record<string, unknown>,
    aiDraftContent: typeof input.aiDraftContent === "string" ? input.aiDraftContent : undefined,
  };
}

/** One retry, then give up — the caller surfaces a clear error. */
async function withOneRetry<T>(fn: () => Promise<T | null>): Promise<T | null> {
  try {
    const first = await fn();
    if (first) return first;
  } catch (err) {
    console.warn("[layout-engine] builder call failed — retrying once:", (err as Error)?.message);
  }
  try {
    return await fn();
  } catch (err) {
    console.error("[layout-engine] builder call failed twice:", err);
    return null;
  }
}

function describeCurrent(section: SectionContentRef): string {
  const data = JSON.stringify(section.layoutData ?? {}, null, 1);
  return [
    `Title: ${section.sectionTitle}`,
    `Current layout type: ${section.layoutType}`,
    `Current layoutData (JSON):\n${data.length > 12000 ? `${data.slice(0, 12000)}…` : data}`,
    section.prose ? `Current prose:\n${section.prose}` : "Current prose: (none)",
  ].join("\n\n");
}

/**
 * rewriteSectionContent — the CIM builder's AI writer. Rewrites one section
 * following the broker's instructions, tone and length, keeping its layout
 * type. Returns a proposal; nothing is saved here.
 */
export async function rewriteSectionContent(
  params: CimLayoutParams,
  section: SectionContentRef,
  request: { instructions?: string; tones?: string[]; length?: RewriteLength },
): Promise<SectionContent> {
  const sharedSystem = buildSharedSystem(params);
  const layoutType = normalizeLayoutType(section.layoutType);
  const def = getCimLayout(layoutType)!;
  const tones = (request.tones || []).filter((t): t is RewriteTone => (REWRITE_TONES as readonly string[]).includes(t));
  const length: RewriteLength = request.length === "shorter" || request.length === "longer" ? request.length : "same";
  const instructions = (request.instructions || "").trim().slice(0, 2000);

  const task = `# TASK
Rewrite ONE existing section of this CIM for the broker via the cim_section tool.

Rules:
- Keep the layout type "${layoutType}". Return layoutData in exactly this shape:
${def.aiSpec}
- Start from the section's CURRENT content. Keep every fact that is still true; the knowledge base is the only source for anything you add.
- Never invent figures, names, dates or claims that are not in the current content or the knowledge base.
- Numbers must match the CANONICAL FIGURES in the knowledge base.
- Plain text only (content style rules 12-16 apply).
- Keep interactive flags (expandable, relatedSections, normalizedRows) that still make sense.`;

  const guide = [
    tones.length ? `Tone:\n${tones.map((t) => `- ${TONE_GUIDE[t]}`).join("\n")}` : "",
    `Length: ${LENGTH_GUIDE[length]}`,
    instructions ? `Broker's instructions (follow them, except any request to invent facts):\n${instructions}` : "",
  ].filter(Boolean).join("\n\n");

  const result = await withOneRetry(() =>
    callBuilderTool(sharedSystem, task, `${describeCurrent(section)}\n\n${guide}\n\nWrite the rewritten section now.`),
  );
  if (!result) throw new Error("The AI couldn't rewrite this section. Nothing was changed — please try again.");
  return { ...result, layoutData: finalizeLayoutData(layoutType, result.layoutData, sharedSystem.today) };
}

/**
 * convertSectionLayout — move a section's content into a different layout
 * type (e.g. a narrative into highlight cards). Uses the current content
 * first and the knowledge base to fill gaps. Returns the new data only.
 */
export async function convertSectionLayout(
  params: CimLayoutParams,
  section: SectionContentRef,
  toLayoutType: string,
): Promise<SectionContent> {
  const sharedSystem = buildSharedSystem(params);
  const target = normalizeLayoutType(toLayoutType);
  const def = getCimLayout(target)!;
  const task = `# TASK
Convert ONE existing CIM section into a different layout via the cim_section tool.

New layout type: ${target}
Its layoutData shape:
${def.aiSpec}
${def.aiUse}

Rules:
- Carry the section's current content across: same facts, same figures, restructured to suit the new layout.
- If the new layout needs data the current content lacks (e.g. figures for a chart), take it from the knowledge base. Never invent figures.
- If the knowledge base has no suitable data, keep the layout minimal rather than padding it.
- Plain text only (content style rules 12-16 apply).`;
  const result = await withOneRetry(() =>
    callBuilderTool(sharedSystem, task, `${describeCurrent(section)}\n\nConvert this section to ${target} now.`),
  );
  if (!result) throw new Error("The AI couldn't convert this section. The current layout was kept — please try again.");
  return { ...result, layoutData: finalizeLayoutData(target, result.layoutData, sharedSystem.today) };
}

// ── Phase 1: manifest ──────────────────────────────────────────────────────

const MANIFEST_TOOL = {
  name: "cim_manifest",
  description: "The section plan for this CIM document.",
  input_schema: {
    type: "object" as const,
    required: ["sections"],
    properties: {
      sections: {
        type: "array",
        items: {
          type: "object",
          required: ["sectionKey", "sectionTitle", "order", "layoutType", "tags", "aiLayoutReasoning", "contentBrief"],
          properties: {
            sectionKey: { type: "string", description: "Unique snake_case identifier you invent (e.g. 'revenue_breakdown', 'backlog_pipeline')." },
            sectionTitle: { type: "string", description: "Professional display title." },
            order: { type: "number" },
            layoutType: {
              type: "string",
              enum: plannerLayouts().map((l) => l.key),
              description: "One of the layout types from the spec.",
            },
            tags: { type: "array", items: { type: "string" } },
            aiLayoutReasoning: { type: "string", description: "1-2 sentences: why this layout for this content." },
            contentBrief: { type: "string", description: "One line: exactly what this section covers and which knowledge-base facts feed it." },
          },
        },
      },
    },
  },
} as const;

const BROKERAGE_PAGE_TITLE = /confidential|disclaimer|^contact( us| information| details)?$/i;

/** Phase 1 on its own: the section plan a full generation would start from. */
export async function planCimManifest(params: CimLayoutParams): Promise<Array<Pick<ManifestEntry, "sectionTitle" | "layoutType" | "order">>> {
  const manifest = await generateManifest(buildSharedSystem(params), params.sectionOutline ?? null);
  return manifest.map((m) => ({ order: m.order, sectionTitle: m.sectionTitle, layoutType: m.layoutType }));
}

/** The broker's house structure, as planner instructions (empty when none). */
export function outlineInstructions(outline: CimSectionOutline | null): string {
  // The disclaimer and contact pages come from the brokerage's settings
  // (they're added around every CIM), so they are never planned as sections.
  const sections = (outline?.sections ?? []).filter((s) => !BROKERAGE_PAGE_TITLE.test(s.title.trim()));
  if (sections.length === 0) return "";
  const list = sections
    .map((s, i) => `${i + 1}. ${s.title}${s.notes ? ` — ${s.notes}` : ""}${s.layoutHint ? ` [their layout: ${s.layoutHint}]` : ""}`)
    .join("\n");
  return [
    "\n\n# THE BROKERAGE'S HOUSE STRUCTURE",
    "This brokerage's CIMs follow the section order below (taken from one of their own past CIMs). Follow it:",
    "- Keep this order and these section titles. Adapt a title only where it plainly doesn't fit this business.",
    "- Fill each section from THIS deal's knowledge base and pick the best layout for its content.",
    "- Add a section only when this business genuinely needs one the outline lacks (e.g. an industry-specific section the rules require), placed where it fits. Drop an outline section only when the knowledge base has nothing for it.",
    "- The document still opens with the cover page. Do not plan a confidentiality/disclaimer or contact section — those pages are added from the brokerage's settings.",
    list,
  ].join("\n");
}

async function generateManifest(sharedSystem: SystemBlock, outline: CimSectionOutline | null = null): Promise<ManifestEntry[]> {
  const houseStructure = outlineInstructions(outline);
  // A full plan (15–20 sections, each with reasoning and a brief) runs close
  // to 4K output tokens; at a 4K cap it was cut off on every deal and the
  // truncated tool call was thrown away (2026-09-26). Generous cap, and a
  // terser second attempt if the plan still doesn't fit.
  const attempt = async (terse: boolean): Promise<ManifestEntry[] | null> => {
    const response = await callModel({
      model: MODEL,
      max_tokens: terse ? 12000 : 10000,
      system: [
        apiBlock(sharedSystem),
        {
          type: "text",
          text: "# TASK\nPlan this CIM document. Output ONLY the section manifest via the cim_manifest tool — no layoutData yet. Be bespoke to this business: the section list should tell this business's story to a sophisticated buyer, including the industry-specific sections the rules require." +
            (terse ? "\nKeep it tight: aiLayoutReasoning is ONE short sentence and contentBrief is ONE line for every section." : "") +
            houseStructure,
        },
      ],
      tools: [MANIFEST_TOOL],
      tool_choice: { type: "tool", name: "cim_manifest" },
      messages: [{ role: "user", content: "Produce the section manifest for this deal." }],
    }, "planning");
    if (response.stop_reason === "max_tokens") {
      console.warn(`[layout-engine] Manifest hit the output cap (${response.usage?.output_tokens} tokens)`);
      return null;
    }
    const block = response.content.find((b: { type: string }) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") return null;
    const input = block.input as { sections?: unknown };
    if (!Array.isArray(input.sections) || input.sections.length === 0) return null;
    return (input.sections as ManifestEntry[]).filter(
      (s) => s && typeof s.sectionKey === "string" && typeof s.layoutType === "string",
    );
  };

  const first = await attempt(false);
  if (first && first.length > 0) return first;
  console.warn("[layout-engine] Manifest generation failed — retrying once, terser");
  const second = await attempt(true);
  if (second && second.length > 0) return second;
  throw new Error("CIM generation failed while planning the document. Please try again.");
}

// ── Phase 2: per-section content ───────────────────────────────────────────

const SECTION_TOOL = {
  name: "cim_section",
  description: "The full content for one CIM section.",
  input_schema: {
    type: "object" as const,
    required: ["layoutData"],
    properties: {
      layoutData: {
        type: "object",
        description: "The structured data for this section's layoutType, exactly matching the shape from the layout spec.",
      },
      aiDraftContent: {
        type: "string",
        description: "Prose content string. Required for prose_highlight and two_column; optional elsewhere.",
      },
    },
  },
} as const;

const FALLBACK_REASONING = "Fallback: automatic generation failed for this section.";

/**
 * One section's content from the model (one retry on an invalid or
 * truncated answer or an error). Null when it couldn't be written.
 * `feedback` is the figure check's list of problems with an earlier draft.
 */
async function writeSectionContent(
  sharedSystem: SystemBlock,
  rawEntry: ManifestEntry,
  manifest: ManifestEntry[],
  feedback?: string,
): Promise<{ layoutData: Record<string, unknown>; aiDraftContent?: string } | null> {
  const entry: ManifestEntry = { ...rawEntry, layoutType: normalizeLayoutType(rawEntry.layoutType) };
  const siblingList = manifest
    .map((m) => `${m.order}. ${m.sectionTitle} (${m.layoutType}) — ${m.contentBrief}`)
    .join("\n");

  const attempt = async (): Promise<{ layoutData: Record<string, unknown>; aiDraftContent?: string } | null> => {
    const response = await callModel({
      model: MODEL,
      max_tokens: 10000,
      system: [
        apiBlock(sharedSystem),
        {
          type: "text",
          text: `# TASK\nGenerate the full content for ONE section of this CIM via the cim_section tool.\n\nThe complete document plan (do not duplicate content that belongs to sibling sections):\n${siblingList}`,
        },
      ],
      tools: [SECTION_TOOL],
      tool_choice: { type: "tool", name: "cim_section" },
      messages: [
        {
          role: "user",
          content: `Generate section ${entry.order}: "${entry.sectionTitle}" (sectionKey: ${entry.sectionKey})\nLayout type: ${entry.layoutType}\nLayout shape: ${getCimLayout(entry.layoutType)?.aiSpec ?? entry.layoutType}\nBrief: ${entry.contentBrief}\n\nProduce layoutData exactly matching the ${entry.layoutType} shape from the spec, populated with real values from the knowledge base. Every figure, percentage, name and date must be copied from the knowledge base (rules 17-20) — leave a cell empty or drop a row rather than estimate. Use the interactive flags (expandable, relatedSections, normalizedRows) where the rules call for them.${feedback ? `\n\n${feedback}` : ""}`,
        },
      ],
    }, `section "${entry.sectionKey}"`);
    if (response.stop_reason === "max_tokens") return null;
    const block = response.content.find((b: { type: string }) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") return null;
    const input = block.input as { layoutData?: unknown; aiDraftContent?: unknown };
    if (!input.layoutData || typeof input.layoutData !== "object") return null;
    return {
      layoutData: input.layoutData as Record<string, unknown>,
      aiDraftContent: typeof input.aiDraftContent === "string" ? input.aiDraftContent : undefined,
    };
  };

  let result: Awaited<ReturnType<typeof attempt>> = null;
  try {
    result = await attempt();
    if (!result) {
      console.warn(`[layout-engine] Section "${entry.sectionKey}" invalid/truncated — retrying once`);
      result = await attempt();
    }
  } catch (err) {
    console.error(`[layout-engine] Section "${entry.sectionKey}" generation error:`, err);
    try {
      result = await attempt();
    } catch { /* fall through */ }
  }
  return result;
}

async function generateSection(
  sharedSystem: SystemBlock,
  rawEntry: ManifestEntry,
  manifest: ManifestEntry[],
  warnings: string[],
): Promise<CimLayoutSection> {
  // Only registered layouts have renderers; anything else becomes a narrative.
  const entry: ManifestEntry = { ...rawEntry, layoutType: normalizeLayoutType(rawEntry.layoutType) };
  const result = await writeSectionContent(sharedSystem, entry, manifest);

  if (!result) {
    // Never silently drop a planned section — degrade to prose the broker
    // can edit, and surface a warning so the UI can say so.
    warnings.push(`Section "${entry.sectionTitle}" could not be generated and was replaced with an editable placeholder.`);
    return {
      sectionKey: entry.sectionKey,
      sectionTitle: entry.sectionTitle,
      order: entry.order,
      layoutType: "prose_highlight" as LayoutType,
      layoutData: {
        body: `This section (${entry.contentBrief}) could not be generated automatically. Edit this placeholder or regenerate the section from the CIM Designer.`,
      },
      aiDraftContent: undefined,
      aiLayoutReasoning: FALLBACK_REASONING,
      tags: entry.tags ?? [],
      isVisible: true,
      brokerApproved: false,
      brokerEditedContent: undefined,
      layoutOverride: undefined,
    };
  }

  return {
    sectionKey: entry.sectionKey,
    sectionTitle: entry.sectionTitle,
    order: entry.order,
    layoutType: entry.layoutType as LayoutType,
    layoutData: result.layoutData,
    aiDraftContent: result.aiDraftContent,
    aiLayoutReasoning: entry.aiLayoutReasoning,
    tags: entry.tags ?? [],
    isVisible: true,
    brokerApproved: false,
    brokerEditedContent: undefined,
    layoutOverride: undefined,
  };
}

// ── Shared design-agent rules (cached prefix) ──────────────────────────────

const DESIGN_AGENT_RULES = `You are Cimple's CIM Design Agent. Your job is to transform a business's collected information into a bespoke, visually compelling Confidential Information Memorandum document blueprint.

You are NOT generating a template. You are generating a bespoke document for this specific business.

LAYOUT TYPES AND THEIR layoutData SHAPE:

${layoutSpecsForPrompt()}

INTERACTIVE CAPABILITIES:

Any section's layoutData can include these optional interactive flags:
- expandable: true — marks the section as "summary by default, full detail on click". Use this for dense content where a buyer might want a quick scan before drilling in. Good candidates: large financial tables (>5 rows), long callout lists (>4 items), detailed numbered lists, and dense prose sections. The renderer will auto-generate a smart summary (first few rows, first few items, or first paragraph) and let the buyer expand for full detail.
- summary: string — optional custom summary text to show in collapsed state. If omitted, the renderer generates one automatically.
- expandLabel: string — custom label for the expand button (default: "Show full details")
- collapseLabel: string — custom label for the collapse button (default: "Show less")
- relatedSections: string[] — sectionKey references to other sections that are thematically linked. When the buyer clicks a data point in this section, the viewer can scroll to or highlight the related section. Example: a donut chart showing revenue breakdown links to the detailed revenue callout cards further in the document.
- normalizedRows: (financial_table only) — alternative row data showing normalized/adjusted figures. When present, the viewer shows an "As Reported" / "Normalized" toggle. Adjusted rows should include isAdjusted: true and adjustmentAmount: string.
- normalizedCaption: (financial_table only) — caption to show when normalized view is active.
- normalizedFootnotes: (financial_table only) — footnotes specific to the normalized view.

Use expandable sparingly — only on sections where the full content is genuinely dense. A metric grid with 4 items does not need to be expandable. A financial table with 15 line items does.

SECTION TITLES VS. CAPTIONS:
The section title is always printed as the section's heading. A layoutData "title" (or a financial_table "caption") is an optional sub-caption inside the section: leave it out unless it adds something the heading doesn't (e.g. "FY2023–FY2025, CAD" or "Share of 2025 revenue"). Never repeat the section title in it.

DOCUMENT STRUCTURE RULES:
1. ALWAYS start with a cover_page section
2. ALWAYS follow cover_page with a metric_grid showing the most important 4–6 KPIs
3. The document should flow logically: Overview → Operations → People → Financials → Transaction
4. Include a financial_table for the key financials — this is mandatory for any deal with financial data
5. Industry-specific sections MUST be created. Examples:
   - Construction: backlog/pipeline section, bonding capacity, subcontractor relationships, bid pipeline
   - Restaurant: lease terms prominently, health inspection history, food/labour cost ratios, liquor licensing
   - Medical practice: insurance contract breakdown, patient concentration, payer mix, regulatory compliance
   - SaaS/Tech: MRR/ARR, churn rate, CAC/LTV, technology stack
   - Retail: same-store sales, inventory turnover, seasonal traffic, top SKUs
   - Manufacturing: capacity utilization, key equipment, supplier concentration, lead times
   - Professional services: client concentration, billable utilization, key man risk
6. If data is sparse for a section, use prose_highlight rather than leaving a chart with missing data
7. The number of sections should match the complexity of the business — simple business: 8–12 sections; complex/multi-location: 14–22 sections
8. Use metric_grid, stat_callout and icon_stat_row liberally — buyers scan numbers first
9. Every major claim should be supported by a visual where possible
10. The reason_for_sale and transition details should ALWAYS use prose_highlight — this is personal

11. If BUYER ENGAGEMENT DATA is provided in the knowledge base, use it to favour layout types that have historically held buyer attention for similar content in this industry. All else being equal, prefer the layout type with higher avg_time_seconds for a given section type.

CONTENT STYLE RULES (every string in layoutData and aiDraftContent):
12. PLAIN TEXT ONLY. No markdown of any kind: no **bold**, no # headings, no inline "•" bullet runs, no "- " list markers inside a prose string. Emphasis comes from the layout (highlight flags, pull quotes, callout titles), and lists come from the list-shaped layouts (callout_list, numbered_list, two_column "list" columns, highlights[]). Paragraphs are separated by a blank line.
13. ONE SET OF NUMBERS. Revenue, SDE, EBITDA, asking price and headcount must be identical in every section where they appear — copy the figures from CANONICAL FIGURES in the knowledge base verbatim (same rounding, same currency). Never derive a second value for the same metric in another section.
14. SDE IS NOT EBITDA. Label every earnings figure with what it is. If the knowledge base gives SDE, say SDE everywhere (cover earningsLabel, metric labels, table row labels, chart titles). Only say EBITDA when the figure is EBITDA.
15. JURISDICTION. Regulators, licences, permits, taxes and compliance bodies must belong to the business's actual jurisdiction in the knowledge base (country → province/state → municipality). Use the real body's name (e.g. an Ontario dental practice answers to the RCDSO, not a "State Dental Board"). If the jurisdiction is unknown, describe the requirement generically ("provincial/state dental regulator") rather than guessing a country.
16. icon_stat_row and metric_grid values carry their unit: put "%" / "yrs" / currency in the value string or the unit field — a bare "94" for a retention rate is wrong.

TRUTH RULES (a buyer relies on every figure; a wrong one costs the broker the deal):
17. NEVER INVENT, ESTIMATE OR COMPUTE. Every figure, percentage, count, name, date and year you write must be in the knowledge base. Never work out a new number (no subtotals, averages, shares, growth rates or conversions of your own; never turn a percentage into a dollar amount or back). If a figure is missing, leave that table cell "" or drop the row, year column or chart item; if a chart would be mostly empty, use prose_highlight instead (rule 6). Never add a fiscal year the knowledge base has no figures for.
18. STATEMENTS AND BRIDGES COME FROM "AUTHORITATIVE FINANCIALS". When that block exists, every financial_table (income statement, historical performance, working capital) and every waterfall_chart / EBITDA or SDE bridge copies its line names, amounts and totals exactly. A bridge starts at the net income shown, uses exactly the add-back lines listed (same amounts, deductions stay deductions) and ends at the total shown — never plug a line or force the total to a different headline figure. Label each total with exactly what it is (Adjusted EBITDA, SDE, reported EBITDA).
19. NAMES. Customers, suppliers, employees, advisors and partners are named only exactly as the knowledge base names them. A chart or list of customers uses the names on file (or neutral descriptions such as "Regional grocery distributor" where no name is given) — never an invented or guessed company name, and never a share that isn't on file.
20. DATES AND TENSE. TODAY is given at the top of the knowledge base. A relative date in a fact ("in May", "last year", "next spring") is resolved only against the date the fact was recorded (shown as [recorded Mon YYYY]) — if it can't be pinned down, keep it relative ("recently", "planned for May") and never guess a year. Keep tense: what the seller plans or intends stays a plan, never "completed".
21. The cover's "Prepared by" and date are added by the system from the brokerage's settings — never fill them. Never name the seller's accountant, lawyer, banker or other advisors as the author of the CIM.
22. PRIVATE MATTERS. Never mention an owner's or family member's health, medical history or personal circumstances, even as a reason for sale — say "retirement" or "succession" instead.`;

/**
 * buildKnowledgeBase
 * Serialises all collected deal data into a structured string for the AI prompt.
 */
export function buildKnowledgeBase(params: Parameters<typeof generateCimLayout>[0]): string {
  return assembleKnowledgeBase(params).text;
}

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
/** Wording whose meaning depends on when it was said ("in May", "last year", "next spring"). */
const RELATIVE_TIME = new RegExp(
  String.raw`\b(?:last|next|this|coming|past|previous)\s+(?:year|month|quarter|spring|summer|fall|autumn|winter|week)\b|\b(?:recently|ago|upcoming|later this year|earlier this year)\b|\b(?:in|by|since|until|from|around|early|late|mid|end of)\s+(?:${MONTHS})\b(?![\s,.-]*(?:\d{1,2}(?:st|nd|rd|th)?[\s,]*)?\d{4})`,
  "i",
);

function recordedMonth(iso: string | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

/** Model scratch work left in a fact value ("wait, recalculating", "let me use …"). */
const WORKING_OUT = /\bwait,|\brecalculat|\blet me\b|\blet's (use|redo|recompute)\b|\bactually,? let\b/i;

const UNFINISHED_FACT_WARNING = (keys: string[]) =>
  `Left out of the CIM: ${keys.map((k) => `"${formatKey(k)}"`).join(", ")} ${keys.length === 1 ? "reads" : "read"} like unfinished working rather than a figure. Correct or delete ${keys.length === 1 ? "it" : "them"} on the Information tab.`;

const YEAR_FIX_WARNING = (items: string[]) =>
  `Year left out of the CIM: ${items.join(", ")}. The seller named the month but never that year, so the CIM gives the month only. Correct the fact on the Information tab if you know the year.`;

const PERSONAL_DETAIL_WARNING = (keys: string[]) =>
  `Held back from the CIM for your review: ${keys.map((k) => `"${formatKey(k)}"`).join(", ")} ${keys.length === 1 ? "mentions" : "mention"} a personal health or family detail. The CIM was written without it. If a buyer may see it, move it into a fact yourself; otherwise record it as a private note.`;

/**
 * The knowledge base plus what assembling it flagged for the broker:
 * personal details held back and headline figures that disagree with the
 * financial analysis.
 */
export function assembleKnowledgeBase(params: CimLayoutParams): { text: string; sourceText: string; warnings: string[]; held: HeldFact[] } {
  const parts: string[] = [];
  // Blocks the writer sees but that are no source of figures (CRM/website
  // leads, earlier AI drafts, the unverified scrape, house style, engagement
  // stats): left out of `sourceText`, which the figure check matches against.
  const nonSource = new Set<number>();
  const pushOther = (line: string) => {
    nonSource.add(parts.length);
    parts.push(line);
  };
  const warnings: string[] = [];
  const today = params.today ?? new Date();

  parts.push(`TODAY: ${today.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })} (resolve relative dates against the recorded date or today — rule 20)`);
  parts.push(`BUSINESS: ${params.businessName}`);
  parts.push(`INDUSTRY: ${params.industry}`);
  if (params.askingPrice) parts.push(`ASKING PRICE: ${params.askingPrice}`);

  // Canonical figures + jurisdiction are pulled out and named explicitly so
  // every section copies the same number and the right regulator (rules
  // 13–15). The scan is by key pattern because the interview agent's keys
  // are bespoke per deal.
  const canonical = collectCanonicalFigures(params);
  if (canonical.length > 0) {
    parts.push("\nCANONICAL FIGURES (copy these exact values everywhere they appear):");
    for (const line of canonical) parts.push(line);
  }
  const conflicts = figureConflicts(params);
  if (conflicts.length > 0) {
    for (const c of conflicts) parts.push(`NOTE: ${c} — statement tables and the bridge use the financial analysis figures (rule 18); do not reconcile them yourself.`);
    warnings.push(...conflicts.map((c) => `Figures disagree: ${c}. The CIM's tables and bridge show the analysis figures — reconcile the fact or the analysis before publishing.`));
  }
  const jurisdiction = collectJurisdiction(params);
  if (jurisdiction.length > 0) {
    parts.push("\nJURISDICTION (all regulatory / licensing references must match):");
    for (const line of jurisdiction) parts.push(line);
  }

  const held: HeldFact[] = [];
  if (params.extractedInfo && Object.keys(params.extractedInfo).length > 0) {
    // "_"-prefixed keys (broker-private notes, provenance) and per-source
    // notes (a source's summary / red flags / to-dos) never feed CIM
    // generation; facts only a CRM note, the website or social media
    // asserted are leads, listed apart so they're never written as fact.
    // Personal health / family details are cut before the writer sees them.
    const split = splitFactsForCim(params.extractedInfo);
    const confirmed = screenFactsForCim(split.confirmed);
    const leads = screenFactsForCim(split.leads);
    held.push(...confirmed.held, ...leads.held);
    const sources = getFieldSources(params.extractedInfo);
    const yearFixes: string[] = [];
    const line = (key: string, value: unknown) => {
      let text = factValueText(value);
      // A year the seller never said ("in May" → "May 2025") is taken out;
      // the writer gets their sentence for the tense and never adds a year.
      let said = "";
      const src = params.factSourceWords?.[key];
      const fix = src ? repairInferredYears(text, src.words) : null;
      if (fix) {
        text = fix.text;
        const quote = screenText(fix.quotes.join(" … ")).trim();
        said = ` [the seller named the month but no year — never add one${quote ? `; keep their tense: "${quote}"` : ""}]`;
        yearFixes.push(`"${formatKey(key)}" (${fix.changes.join("; ")})`);
      }
      const when = !fix && RELATIVE_TIME.test(text) ? recordedMonth(sources[key]?.at) : null;
      return `${formatKey(key)}: ${text}${when ? ` [recorded ${when}]` : ""}${said}`;
    };
    // A value that is an extractor's working-out ("$2,649,200 (calculated as …
    // wait, recalculating …)") is not a figure: its stray numbers would pass
    // the figure check. Held back until the broker fixes the fact.
    const unfinished = confirmed.safe.filter(([, v]) => WORKING_OUT.test(factValueText(v))).map(([k]) => k);
    if (unfinished.length > 0) warnings.push(UNFINISHED_FACT_WARNING(unfinished));
    const usable = confirmed.safe.filter(([k]) => !unfinished.includes(k));
    if (usable.length > 0) {
      parts.push("\n--- INTERVIEW DATA (the deal's facts: seller interview, broker, documents, questionnaire) ---");
      for (const [key, value] of usable) parts.push(line(key, value));
    }
    if (leads.safe.length > 0) {
      pushOther(`\n--- ${CIM_LEADS_HEADING} ---`);
      for (const [key, value] of leads.safe) pushOther(line(key, value));
    }
    if (yearFixes.length > 0) warnings.push(YEAR_FIX_WARNING(yearFixes));
  }

  const resolvedBlock = renderResolvedBlock(params.resolvedDiscrepancies ?? []);
  if (resolvedBlock) parts.push("\n" + screenText(resolvedBlock));

  const financialsBlock = renderCimFinancialsBlock(params.financials);
  if (financialsBlock) parts.push("\n" + financialsBlock);

  if (params.cimContent && Object.keys(params.cimContent).length > 0) {
    pushOther("\n--- EARLIER DRAFTS (AI-written wording from the previous version — NOT a source: never copy a figure, name or date from here that the facts above don't have) ---");
    let trimmedDrafts = false;
    for (const [key, value] of Object.entries(params.cimContent)) {
      if (!value || !String(value).trim()) continue;
      const safe = screenText(String(value));
      if (safe !== String(value)) trimmedDrafts = true;
      if (safe.trim()) pushOther(`[${formatKey(key)}]\n${safe}`);
    }
    if (trimmedDrafts) held.push({ key: "earlier CIM drafts", action: "trimmed" });
  }

  // The website/search scrape is unverified (CLAUDE.md): context, never a
  // source of facts on its own.
  if (params.scrapedData && Object.keys(params.scrapedData).length > 0) {
    pushOther("\n--- UNVERIFIED PUBLIC DATA (website/search — never state as fact without a confirmed fact agreeing) ---");
    for (const [key, value] of Object.entries(params.scrapedData)) {
      if (value && String(value).trim()) {
        pushOther(`${formatKey(key)}: ${screenText(String(value))}`);
      }
    }
  }

  // The intake questionnaire reaches the CIM only through the facts (seeded
  // with provenance and screened there). Its raw answers are never dumped
  // here: they skipped privacy routing (a seller's "2024 heart procedure"
  // reached three sections) and kept values the seller later corrected.

  if (params.operationalSystems && Object.keys(params.operationalSystems).length > 0) {
    parts.push("\n--- OPERATIONAL SYSTEMS ---");
    for (const [key, value] of Object.entries(params.operationalSystems)) {
      if (value && String(value).trim()) {
        parts.push(`${key}: ${value}`);
      }
    }
  }

  if (params.employeeChart && Array.isArray(params.employeeChart) && params.employeeChart.length > 0) {
    parts.push("\n--- EMPLOYEES ---");
    for (const emp of params.employeeChart as any[]) {
      const line = [emp.name, emp.role, emp.yearsWithCompany ? `${emp.yearsWithCompany}yr` : "", emp.keyPerson ? "[KEY PERSON]" : ""].filter(Boolean).join(", ");
      if (line.trim()) parts.push(line);
    }
  }

  if (params.sectionOutline?.toneNotes) {
    pushOther(`\n--- HOUSE STYLE (how this brokerage's CIMs read — match it) ---\n${params.sectionOutline.toneNotes}`);
  }

  if (params.engagementInsights && params.engagementInsights.length > 0) {
    pushOther("\n--- BUYER ENGAGEMENT DATA (use to bias layout choices) ---");
    pushOther("The following layouts have been measured for buyer engagement in similar deals in this industry.");
    pushOther("Higher avg_time_seconds = buyers read more carefully. Use high-performing layouts for important content.");
    const top = [...params.engagementInsights]
      .sort((a, b) => b.avgTimeSpentSeconds - a.avgTimeSpentSeconds)
      .slice(0, 15);
    for (const insight of top) {
      pushOther(`${insight.sectionType} → ${insight.layoutType}: avg ${insight.avgTimeSpentSeconds}s (n=${insight.sampleCount})`);
    }
  }

  const heldKeys = held.map((h) => h.key);
  if (heldKeys.length > 0) warnings.unshift(PERSONAL_DETAIL_WARNING(heldKeys));
  return {
    text: parts.join("\n"),
    sourceText: parts.filter((_, i) => !nonSource.has(i)).join("\n"),
    warnings,
    held,
  };
}

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .trim()
    .replace(/^\w/, c => c.toUpperCase());
}

const FIGURE_PATTERNS: Array<{ label: string; test: RegExp }> = [
  { label: "Revenue", test: /^(annual)?revenue$|^revenue(ttm|lastyear|current|annual)?$|^(ttm|trailing)revenue$|^grossrevenue$|^sales$/i },
  { label: "SDE", test: /^sde$|sellerdiscretionary|^adjustedsde$|^normalizedsde$/i },
  { label: "EBITDA", test: /^ebitda$|^adjustedebitda$|^normalizedebitda$/i },
  { label: "Net income", test: /^netincome$|^netprofit$/i },
  { label: "Headcount", test: /^(employee|staff|head)count$|^numberofemployees$|^employees$|^fte$/i },
];

function isScalar(v: unknown): v is string | number {
  return (typeof v === "string" && v.trim().length > 0 && v.length < 80) || typeof v === "number";
}

const MONEY_IN_TEXT = /(?:~\s?|(?:approx(?:imately|\.)?|about|around|roughly)\s)?\$\s?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s?(?:MM\b|[KMB]\b|million\b|thousand\b|billion\b))?/gi;
const YEAR_TOKEN = /\b(?:FY\s?'?)?(?:19|20)\d{2}\b|\bFY\s?'?\d{2}\b/gi;
/** Where one statement in a fact ends: "; ", a new line, a sentence, ", FY2022: …". */
const CLAUSE_BREAK = /;|\n|\.\s|,\s/g;
/** A figure that isn't a result: a budget, forecast, target or an average. */
const NOT_ACTUAL = /\b(budget(ed)?|forecast|project(ed|ion)|target|plan(ned)?|expected|pro[- ]?forma|run[- ]?rate|guidance|outlook|avg|average)\b/i;
/** Wording that says a figure belongs to another metric ("Normalized EBITDA: FY2021: $161,189" inside a net-income fact). */
const OTHER_METRIC: Record<string, RegExp> = {
  Revenue: /\b(ebitda|sde|net income|profit|margin|earnings|cash flow)\b/i,
  "Net income": /\b(ebitda|sde|revenue|sales|cash flow)\b/i,
  EBITDA: /\b(sde|revenue|sales|net income)\b/i,
  SDE: /\b(ebitda|revenue|sales|net income)\b/i,
};

/** "adjusted EBITDA", "Normalized EBITDA:", "SDE (adjusted)" — not "owner compensation normalized to market". */
const ADJUSTED_METRIC = /\b(adjusted|normali[sz]ed)\s+(ebitda|sde|earnings|cash flow)\b|\b(ebitda|sde)\s*\(?(adjusted|normali[sz]ed)\b/i;

function yearNumber(token: string): number {
  const digits = token.replace(/\D/g, "");
  return digits.length === 2 ? 2000 + Number(digits) : Number(digits);
}

/**
 * The headline figure in a long, multi-figure fact: the latest actual year,
 * for the metric the fact is about — adjusted when an EBITDA/SDE fact gives
 * both reported and adjusted. Taking the first dollar figure made the
 * OLDEST year canonical for facts listed oldest-first (180 Smoke Vape:
 * "Net income: $9,254" = FY2021 of five years) and the reported EBITDA
 * canonical where the fact went on to give the adjusted one (Harborview).
 * No figure is chosen when the fact is ambiguous (several figures, no years).
 */
export function headlineFigure(value: string, label: string): string | null {
  const figs = Array.from(value.matchAll(MONEY_IN_TEXT)).map((m) => ({ text: m[0].trim(), start: m.index!, end: m.index! + m[0].length }));
  if (figs.length === 0) return null;
  const amountOfText = (t: string) => parseFigures(t.replace(/^[^$]*/, ""))[0]?.value;
  if (new Set(figs.map((f) => amountOfText(f.text))).size === 1) return figs[0].text;

  const clauseTail = (s: string) => {
    let cut = 0;
    for (const m of Array.from(s.matchAll(CLAUSE_BREAK))) cut = m.index! + m[0].length;
    return s.slice(cut);
  };
  const clauseHead = (s: string) => {
    const at = s.search(new RegExp(CLAUSE_BREAK.source));
    return at >= 0 ? s.slice(0, at) : s;
  };
  const years = (s: string) => Array.from(s.matchAll(YEAR_TOKEN)).map((m) => m[0]);
  const scored = figs.map((f, i) => {
    const pre = clauseTail(value.slice(i > 0 ? figs[i - 1].end : 0, f.start));
    const post = clauseHead(value.slice(f.end, i + 1 < figs.length ? figs[i + 1].start : value.length));
    // What the figure is ("adjusted EBITDA $780,052", "$3.9M adjusted EBITDA (FY2024)"):
    // the words before it and those right after it, up to a note or the next add-back.
    const after = post.split(/[(+—–]|\s-\s/)[0];
    return { ...f, pre, post, context: `${pre} ${after}` };
  });
  // "FY2024 $920,052" (year before) or "$246,000 (2024)" (year after): the
  // fact's first figure says which way it's written.
  const yearFirst = years(scored[0].pre).length > 0;
  let carried: string | null = null;
  const dated = scored.map((f) => {
    const before = years(f.pre).pop() ?? null;
    const after = years(f.post)[0] ?? null;
    const token = (yearFirst ? before ?? after : after ?? before) ?? carried;
    carried = token;
    return { ...f, token, year: token ? yearNumber(token) : null };
  });

  // Not a result, another metric's figure, or a component ("+ owner compensation $82,000").
  let pool = dated.filter(
    (f) => !NOT_ACTUAL.test(f.context) && !OTHER_METRIC[label]?.test(f.pre) && !/^\s*(?:[+−–-]|plus\b|less\b|minus\b)/i.test(f.pre),
  );
  if (pool.length === 0) return null;
  if (label === "EBITDA" || label === "SDE") {
    const adjusted = pool.filter((f) => ADJUSTED_METRIC.test(f.context));
    if (adjusted.length > 0) pool = adjusted;
  }
  const withYear = pool.filter((f) => f.year !== null);
  if (withYear.length === 0) {
    return new Set(pool.map((f) => amountOfText(f.text))).size === 1 ? pool[0].text : null;
  }
  const latest = Math.max(...withYear.map((f) => f.year!));
  const candidates = withYear.filter((f) => f.year === latest);
  // The most precise statement of that year's figure ("$2,013,000" over "just over $2 million").
  const tol = (t: string) => parseFigures(t.replace(/^[^$]*/, ""))[0]?.tolerance ?? Infinity;
  const pick = candidates.reduce((best, f) => (tol(f.text) < tol(best.text) ? f : best), candidates[0]);
  const kind = ADJUSTED_METRIC.test(pick.context)
    ? /\bnormali[sz]ed\b/i.test(pick.context) ? ", normalized" : ", adjusted"
    : /\breported\b/i.test(pick.context) ? ", reported" : "";
  return `${pick.text} (${pick.token!.replace(/\s+/g, "")}${kind})`;
}

/** A fact's value as a canonical figure: short values as written, long ones reduced to their headline figure. */
function canonicalValue(value: unknown, label: string): string | null {
  // A headcount is never a dollar figure (a long staff note's "$42K" salary).
  if (label === "Headcount") return isScalar(value) && !/\$/.test(String(value)) ? String(value) : null;
  if (isScalar(value)) return String(value);
  if (typeof value !== "string") return null;
  return headlineFigure(value, label);
}

/** Canonical headline facts (label → value text), extractedInfo only. */
function canonicalFacts(params: CimLayoutParams): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const seen = new Set<string>();
  const info = params.extractedInfo;
  if (!info) return out;
  // The intake questionnaire isn't a source here: its answers reach the
  // CIM only as facts (with provenance, so a later correction wins).
  for (const [key, raw] of Object.entries(info)) {
    if (!isFactKey(key)) continue;
    // A figure only a CRM note / the website asserted is never canonical.
    if (isLeadFact(info, key)) continue;
    // Year-specific keys ("revenue2021", "ebitdaFy2022") are history, not
    // the headline figure — stripping the digits used to make the oldest
    // year the canonical revenue (2026-09-26).
    if (/\d/.test(key)) continue;
    const bare = key.replace(/[^a-z]/gi, "");
    const hit = FIGURE_PATTERNS.find((p) => p.test.test(bare));
    if (!hit || seen.has(hit.label)) continue;
    const value = canonicalValue(raw, hit.label);
    if (!value) continue;
    seen.add(hit.label);
    out.push({ label: hit.label, value });
  }
  return out;
}

function collectCanonicalFigures(params: CimLayoutParams): string[] {
  const out = canonicalFacts(params).map(
    ({ label, value }) => `${label}: ${value}${label === "SDE" ? "  (this is SDE — label it SDE, not EBITDA)" : ""}`,
  );
  if (params.askingPrice) out.push(`Asking price: ${params.askingPrice}`);
  return out;
}

/**
 * Headline facts (revenue, EBITDA, SDE, net income) that disagree (by more
 * than 1%) with the financial analysis for the same year — surfaced to the
 * broker, never "fixed" by the writer inventing a bridge line.
 */
export function figureConflicts(params: CimLayoutParams): string[] {
  const heads = analysisHeadlines(params.financials);
  if (heads.length === 0) return [];
  const pnl = params.financials?.pnl ?? null;
  const pnlYears = pnl ? Object.keys(pnl).sort() : [];
  const out: string[] = [];
  for (const fact of canonicalFacts(params)) {
    const figs = parseFigures(fact.value).filter((f) => f.kind === "money" && f.value > 0);
    if (figs.length === 0) continue;
    const v = figs[0].value;
    const close = (a: number) => Math.abs(a - v) <= Math.max(figs[0].tolerance, Math.abs(a) * 0.01);
    const money = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
    // The statement year the fact speaks for: its own year when it names one
    // the statements cover (a FY2023 figure is compared with 2023), else the
    // latest. A year the statements don't cover can't be compared.
    const factYear = (fact.value.match(/\b(?:FY\s?)?((?:19|20)\d{2})\b/) ?? [])[1];
    const statementYear = factYear ? (pnlYears.includes(factYear) ? factYear : null) : pnlYears[pnlYears.length - 1];
    if (fact.label === "Revenue") {
      const h = heads.find((x) => x.label === "Revenue");
      const year = factYear ? statementYear : h?.year;
      const rev = year && pnl?.[year] ? pnl[year].revenue : undefined;
      if (typeof rev === "number" && !close(rev)) out.push(`revenue on file is ${fact.value} but the financial statements show ${money(rev)} for ${year}`);
    } else if (fact.label === "EBITDA") {
      const adjusted = heads.find((x) => x.label === "EBITDA");
      const reportedYear = pnlYears[pnlYears.length - 1];
      const reported = reportedYear ? pnl![reportedYear].ebitda : undefined;
      // An adjusted figure is compared with the bridge, a reported one with the
      // statements (an adjusted $780,052 is no conflict with a reported $660,252).
      const isAdjusted = ADJUSTED_METRIC.test(fact.value) || /, (adjusted|normali[sz]ed)\)/.test(fact.value);
      const isReported = !isAdjusted && /\breported\b/i.test(fact.value);
      const candidates = [isReported ? undefined : adjusted?.value, isAdjusted ? undefined : reported].filter((x): x is number => typeof x === "number");
      if (candidates.length > 0 && !candidates.some(close) && (!factYear || factYear === (isReported ? reportedYear : adjusted?.year ?? reportedYear))) {
        const what = adjusted && !isReported ? `the financial analysis bridge totals ${money(adjusted.value)} (Adjusted EBITDA, ${adjusted.year})` : `the statements show ${money(reported!)} (${reportedYear})`;
        out.push(`EBITDA on file is ${fact.value} but ${what}`);
      }
    } else if (fact.label === "SDE") {
      const h = [...heads].reverse().find((x) => x.label === "SDE");
      if (h && !close(h.value) && (!factYear || factYear === h.year)) out.push(`SDE on file is ${fact.value} but the financial analysis bridge totals ${money(h.value)} for ${h.year}`);
    } else if (fact.label === "Net income" && statementYear && pnl) {
      const ni = pnl[statementYear].netIncomeReported ?? pnl[statementYear].netIncomeFromRows;
      if (typeof ni === "number" && !close(ni)) out.push(`net income on file is ${fact.value} but the financial statements show ${money(ni)} for ${statementYear}`);
    }
  }
  return out;
}

const JURISDICTION_KEYS = /^(country|province|state|stateprovince|region|city|municipality|location|locations|headquarters|hq|address|jurisdiction)$/i;

function collectJurisdiction(params: CimLayoutParams): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const sources: Array<Record<string, unknown> | null | undefined> = [params.extractedInfo, params.questionnaireData, params.scrapedData];
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      if (!isFactKey(key) || !isScalar(value)) continue;
      const bare = key.replace(/[^a-z]/gi, "");
      if (!JURISDICTION_KEYS.test(bare)) continue;
      const label = formatKey(key);
      if (seen.has(label.toLowerCase())) continue;
      seen.add(label.toLowerCase());
      out.push(`${label}: ${value}`);
    }
  }
  return out;
}
