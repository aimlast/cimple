import Anthropic from "@anthropic-ai/sdk";
import type { CimLayoutSection, CimDocument, LayoutType } from "./layout-types.js";
import {
  getCimLayout,
  layoutSpecsForPrompt,
  normalizeLayoutType,
  plannerLayouts,
} from "@shared/cim-layouts";
import { agentConfig } from "../interview/config/load-config";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 600_000, // 10 min headroom across the batched generation calls
});

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
}

/**
 * Shared, cached prefix: identical bytes for the manifest call and every
 * section call, so Anthropic's prompt cache serves it after the first call.
 */
function buildSharedSystem(params: CimLayoutParams): SystemBlock {
  const knowledgeBase = buildKnowledgeBase(params);
  return {
    type: "text",
    text: `${DESIGN_AGENT_RULES}\n\n# DEAL KNOWLEDGE BASE\n\n${knowledgeBase}`,
    cache_control: { type: "ephemeral" },
  };
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

  // ── Phase 1: plan the document ─────────────────────────────────────────
  onProgress?.({ phase: "planning", total: 0, done: 0 });
  const manifest = await generateManifest(sharedSystem);
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

  // Validate and normalise. A layout type outside the registry has no
  // renderer — it would reach buyers as a blank or raw-data block — so it
  // degrades to a narrative section.
  let sections: CimLayoutSection[] = generated.map((s, i) => ({
    sectionKey: s.sectionKey || `section_${i + 1}`,
    sectionTitle: s.sectionTitle || `Section ${i + 1}`,
    order: s.order ?? i + 1,
    layoutType: normalizeLayoutType(s.layoutType) as LayoutType,
    layoutData: s.layoutData || {},
    aiDraftContent: s.aiDraftContent,
    aiLayoutReasoning: s.aiLayoutReasoning || "",
    tags: Array.isArray(s.tags) ? s.tags : [],
    isVisible: s.isVisible !== false,
    brokerApproved: false,
    brokerEditedContent: undefined,
    layoutOverride: undefined,
  }));

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
  return section;
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
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 6000,
    system: [sharedSystem, { type: "text", text: task }] as never,
    tools: [BUILDER_TOOL] as never,
    tool_choice: { type: "tool", name: "cim_section" },
    messages: [{ role: "user", content: userMessage }],
  });
  if (response.stop_reason === "max_tokens") return null;
  const block = response.content.find((b) => b.type === "tool_use");
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
  return result;
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
  return result;
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

async function generateManifest(sharedSystem: SystemBlock): Promise<ManifestEntry[]> {
  const attempt = async (): Promise<ManifestEntry[] | null> => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system: [
        sharedSystem,
        {
          type: "text",
          text: "# TASK\nPlan this CIM document. Output ONLY the section manifest via the cim_manifest tool — no layoutData yet. Be bespoke to this business: the section list should tell this business's story to a sophisticated buyer, including the industry-specific sections the rules require.",
        },
      ] as never,
      tools: [MANIFEST_TOOL] as never,
      tool_choice: { type: "tool", name: "cim_manifest" },
      messages: [{ role: "user", content: "Produce the section manifest for this deal." }],
    });
    if (response.stop_reason === "max_tokens") return null;
    const block = response.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") return null;
    const input = block.input as { sections?: unknown };
    if (!Array.isArray(input.sections) || input.sections.length === 0) return null;
    return (input.sections as ManifestEntry[]).filter(
      (s) => s && typeof s.sectionKey === "string" && typeof s.layoutType === "string",
    );
  };

  const first = await attempt();
  if (first && first.length > 0) return first;
  console.warn("[layout-engine] Manifest generation failed — retrying once");
  const second = await attempt();
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

async function generateSection(
  sharedSystem: SystemBlock,
  rawEntry: ManifestEntry,
  manifest: ManifestEntry[],
  warnings: string[],
): Promise<CimLayoutSection> {
  // Only registered layouts have renderers; anything else becomes a narrative.
  const entry: ManifestEntry = { ...rawEntry, layoutType: normalizeLayoutType(rawEntry.layoutType) };
  const siblingList = manifest
    .map((m) => `${m.order}. ${m.sectionTitle} (${m.layoutType}) — ${m.contentBrief}`)
    .join("\n");

  const attempt = async (): Promise<{ layoutData: Record<string, unknown>; aiDraftContent?: string } | null> => {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 6000,
      system: [
        sharedSystem,
        {
          type: "text",
          text: `# TASK\nGenerate the full content for ONE section of this CIM via the cim_section tool.\n\nThe complete document plan (do not duplicate content that belongs to sibling sections):\n${siblingList}`,
        },
      ] as never,
      tools: [SECTION_TOOL] as never,
      tool_choice: { type: "tool", name: "cim_section" },
      messages: [
        {
          role: "user",
          content: `Generate section ${entry.order}: "${entry.sectionTitle}" (sectionKey: ${entry.sectionKey})\nLayout type: ${entry.layoutType}\nLayout shape: ${getCimLayout(entry.layoutType)?.aiSpec ?? entry.layoutType}\nBrief: ${entry.contentBrief}\n\nProduce layoutData exactly matching the ${entry.layoutType} shape from the spec, populated with real values from the knowledge base. Use the interactive flags (expandable, relatedSections, normalizedRows) where the rules call for them.`,
        },
      ],
    });
    if (response.stop_reason === "max_tokens") return null;
    const block = response.content.find((b) => b.type === "tool_use");
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
    } catch { /* fall through to fallback */ }
  }

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
      aiLayoutReasoning: "Fallback: automatic generation failed for this section.",
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
16. icon_stat_row and metric_grid values carry their unit: put "%" / "yrs" / currency in the value string or the unit field — a bare "94" for a retention rate is wrong.`;

/**
 * buildKnowledgeBase
 * Serialises all collected deal data into a structured string for the AI prompt.
 */
function buildKnowledgeBase(params: Parameters<typeof generateCimLayout>[0]): string {
  const parts: string[] = [];

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
  const jurisdiction = collectJurisdiction(params);
  if (jurisdiction.length > 0) {
    parts.push("\nJURISDICTION (all regulatory / licensing references must match):");
    for (const line of jurisdiction) parts.push(line);
  }

  if (params.extractedInfo && Object.keys(params.extractedInfo).length > 0) {
    parts.push("\n--- INTERVIEW DATA ---");
    for (const [key, value] of Object.entries(params.extractedInfo)) {
      // "_"-prefixed keys are broker-private / session-meta (e.g.
      // _brokerPrivateNotes) and must NEVER feed CIM generation.
      if (key.startsWith("_")) continue;
      if (value && String(value).trim()) {
        parts.push(`${formatKey(key)}: ${value}`);
      }
    }
  }

  if (params.cimContent && Object.keys(params.cimContent).length > 0) {
    parts.push("\n--- DRAFTED CONTENT (Phase 3) ---");
    for (const [key, value] of Object.entries(params.cimContent)) {
      if (value && String(value).trim()) {
        parts.push(`[${formatKey(key)}]\n${value}`);
      }
    }
  }

  if (params.scrapedData && Object.keys(params.scrapedData).length > 0) {
    parts.push("\n--- PUBLIC DATA (scraped/verified) ---");
    for (const [key, value] of Object.entries(params.scrapedData)) {
      if (value && String(value).trim()) {
        parts.push(`${formatKey(key)}: ${value}`);
      }
    }
  }

  if (params.questionnaireData && Object.keys(params.questionnaireData).length > 0) {
    parts.push("\n--- SELLER QUESTIONNAIRE ---");
    for (const [key, value] of Object.entries(params.questionnaireData)) {
      if (value && String(value).trim()) {
        parts.push(`${formatKey(key)}: ${value}`);
      }
    }
  }

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

  if (params.brokerBranding?.companyName) {
    parts.push(`\n--- PREPARED BY ---\n${params.brokerBranding.companyName}`);
  }

  if (params.engagementInsights && params.engagementInsights.length > 0) {
    parts.push("\n--- BUYER ENGAGEMENT DATA (use to bias layout choices) ---");
    parts.push("The following layouts have been measured for buyer engagement in similar deals in this industry.");
    parts.push("Higher avg_time_seconds = buyers read more carefully. Use high-performing layouts for important content.");
    const top = [...params.engagementInsights]
      .sort((a, b) => b.avgTimeSpentSeconds - a.avgTimeSpentSeconds)
      .slice(0, 15);
    for (const insight of top) {
      parts.push(`${insight.sectionType} → ${insight.layoutType}: avg ${insight.avgTimeSpentSeconds}s (n=${insight.sampleCount})`);
    }
  }

  return parts.join("\n");
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

function collectCanonicalFigures(params: CimLayoutParams): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const sources: Array<Record<string, unknown> | null | undefined> = [params.extractedInfo, params.questionnaireData];
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      if (key.startsWith("_") || !isScalar(value)) continue;
      const bare = key.replace(/[^a-z]/gi, "");
      const hit = FIGURE_PATTERNS.find((p) => p.test.test(bare));
      if (!hit || seen.has(hit.label)) continue;
      seen.add(hit.label);
      out.push(`${hit.label}: ${value}${hit.label === "SDE" ? "  (this is SDE — label it SDE, not EBITDA)" : ""}`);
    }
  }
  if (params.askingPrice && !seen.has("Asking price")) out.push(`Asking price: ${params.askingPrice}`);
  return out;
}

const JURISDICTION_KEYS = /^(country|province|state|stateprovince|region|city|municipality|location|locations|headquarters|hq|address|jurisdiction)$/i;

function collectJurisdiction(params: CimLayoutParams): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const sources: Array<Record<string, unknown> | null | undefined> = [params.questionnaireData, params.extractedInfo, params.scrapedData];
  for (const src of sources) {
    if (!src) continue;
    for (const [key, value] of Object.entries(src)) {
      if (key.startsWith("_") || !isScalar(value)) continue;
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
