import Anthropic from "@anthropic-ai/sdk";
import type { CimLayoutSection, CimDocument, LayoutType } from "./layout-types.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 600_000, // 10 min headroom across the batched generation calls
});

const MODEL = "claude-sonnet-4-5";

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

export async function generateCimLayout(params: {
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
}): Promise<CimDocument> {

  const knowledgeBase = buildKnowledgeBase(params);
  const warnings: string[] = [];

  // Shared, cached prefix: identical bytes for the manifest call and every
  // section call, so Anthropic's prompt cache serves it after the first call.
  const sharedSystem: SystemBlock = {
    type: "text",
    text: `${DESIGN_AGENT_RULES}\n\n# DEAL KNOWLEDGE BASE\n\n${knowledgeBase}`,
    cache_control: { type: "ephemeral" },
  };

  // ── Phase 1: plan the document ─────────────────────────────────────────
  const manifest = await generateManifest(sharedSystem);

  // ── Phase 2: generate each section's content in parallel batches ──────
  const BATCH_SIZE = 5;
  const generated: CimLayoutSection[] = [];
  for (let i = 0; i < manifest.length; i += BATCH_SIZE) {
    const batch = manifest.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((entry) => generateSection(sharedSystem, entry, manifest, warnings)),
    );
    generated.push(...results);
  }

  // Validate and normalise
  let sections: CimLayoutSection[] = generated.map((s, i) => ({
    sectionKey: s.sectionKey || `section_${i + 1}`,
    sectionTitle: s.sectionTitle || `Section ${i + 1}`,
    order: s.order ?? i + 1,
    layoutType: (s.layoutType || "unknown") as LayoutType,
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
            layoutType: { type: "string", description: "One of the layout types from the spec." },
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
  entry: ManifestEntry,
  manifest: ManifestEntry[],
  warnings: string[],
): Promise<CimLayoutSection> {
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
          content: `Generate section ${entry.order}: "${entry.sectionTitle}" (sectionKey: ${entry.sectionKey})\nLayout type: ${entry.layoutType}\nBrief: ${entry.contentBrief}\n\nProduce layoutData exactly matching the ${entry.layoutType} shape from the spec, populated with real values from the knowledge base. Use the interactive flags (expandable, relatedSections, normalizedRows) where the rules call for them.`,
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

cover_page: { businessName, tagline?, industry?, location?, askingPrice?, revenue?, ebitda?, preparedBy?, date?, confidentialLabel? }

metric_grid: { metrics: [{label, value, unit?, trend?, delta?, highlight?, footnote?}], columns?: 2|3|4, title? }
— Use for: KPIs, key financial figures, key operational metrics, snapshot stats

bar_chart: { data: [{name, value, secondaryValue?, color?}], xLabel?, yLabel?, secondaryLabel?, unit?, title?, stacked? }
— Use for: revenue by year, revenue by stream, seasonality by month, headcount growth

horizontal_bar_chart: { data: [{name, value, unit?}], yLabel?, unit?, title?, showPercentages? }
— Use for: revenue by customer, revenue by product line, time allocation, % breakdowns where labels are long

pie_chart: { data: [{name, value, color?}], totalLabel?, unit?, title? }
— Use for: ownership breakdown, customer concentration, revenue mix (when ≤6 categories)

donut_chart: { data: [{name, value, color?}], totalLabel?, unit?, title?, centerLabel?, centerValue? }
— Use for: same as pie_chart but when you want to show a central metric

line_chart: { data: [{name, [seriesKey]: value}], series: [{key, label, color?}], xLabel?, yLabel?, unit?, title? }
— Use for: revenue trend over years, EBITDA trend, growth over time

timeline: { events: [{date?, year?, title, description?, highlight?, category?}], title? }
— Use for: company history, milestones, expansion history, ownership transitions

financial_table: { headers: string[], rows: [{label, values: string[], isTotal?, isSectionHeader?, indent?, bold?}], caption?, currency?, footnotes? }
— Use for: P&L summary, SDE normalization, balance sheet highlights, asking price build-up

comparison_table: { leftLabel, rightLabel, rows: [{label, left, right, highlight?}], title? }
— Use for: business vs. industry benchmarks, current vs. prior year, pre-sale vs. post-sale

callout_list: { items: [{title, description?, icon?, highlight?, badge?}], columns?: 1|2|3, style?: "card"|"list"|"icon-row", title? }
— Use for: USPs, growth opportunities, competitive advantages, buyer requirements, key differentiators

icon_stat_row: { stats: [{icon?, label, value, unit?, description?}], title? }
— Use for: compact stats that don't warrant a full metric grid — operational facts, headcounts, key numbers

prose_highlight: { body, pullQuote?, highlights?: string[], subheading? }
— Use for: company narrative, reason for sale, owner story, transition plan — anything deeply human

two_column: { left: {title?, content, layoutType?}, right: {title?, content, layoutType?}, title? }
— Use for: pairing complementary information — narrative + stats, overview + highlights

org_chart: { nodes: [{id, name, role, reportsTo?, isKeyPerson?, isOwner?, yearsAtCompany?, notes?}], title?, totalHeadcount?, ownerDependency? }
— Use for: team structure, management hierarchy, key personnel

location_card: { locations: [{label?, address?, sqft?, leaseType?, leaseExpiry?, monthlyRent?, annualRent?, renewalOptions?, notes?}], totalSqft?, title? }
— Use for: physical location details, lease terms, real estate included in sale

stat_callout: { primaryValue, primaryLabel, secondaryStats?: [{label, value}], description?, accentColor? }
— Use for: one standout number that defines the business — leading metric on a major section

numbered_list: { items: [{title, description?}], title?, ordered? }
— Use for: process steps, reasons to buy, ranked priorities, ordered action items

scorecard: { items: [{label, score, benchmark?, description?}], title?, maxScore? }
— Use for: business health assessment, risk factors, readiness indicators

waterfall_chart: { items: [{label, value, type?: "start"|"add"|"subtract"|"total"}], title?, unit?, currency? }
— Use for: SDE normalization build-up, EBITDA walk, asking price build-up — any stepped financial calculation. Shows starting point, each addback/adjustment as green (add) or red (subtract) steps, and final total. Excellent for showing how you get from net income to adjusted SDE/EBITDA.

divider: { label?, style?: "line"|"section-break"|"page-break" }
— Use for: visual separation between major document sections

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

11. If BUYER ENGAGEMENT DATA is provided in the knowledge base, use it to favour layout types that have historically held buyer attention for similar content in this industry. All else being equal, prefer the layout type with higher avg_time_seconds for a given section type.`;

/**
 * buildKnowledgeBase
 * Serialises all collected deal data into a structured string for the AI prompt.
 */
function buildKnowledgeBase(params: Parameters<typeof generateCimLayout>[0]): string {
  const parts: string[] = [];

  parts.push(`BUSINESS: ${params.businessName}`);
  parts.push(`INDUSTRY: ${params.industry}`);
  if (params.askingPrice) parts.push(`ASKING PRICE: ${params.askingPrice}`);

  if (params.extractedInfo && Object.keys(params.extractedInfo).length > 0) {
    parts.push("\n--- INTERVIEW DATA ---");
    for (const [key, value] of Object.entries(params.extractedInfo)) {
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
