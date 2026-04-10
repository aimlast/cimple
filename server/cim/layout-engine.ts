import Anthropic from "@anthropic-ai/sdk";
import type { CimLayoutSection, CimDocument, LayoutType } from "./layout-types.js";

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  timeout: 600_000, // 10 min — layout generation produces large (16K token) responses
});

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
 * No two CIMs should look the same unless the businesses are identical.
 */
export interface EngagementInsightInput {
  sectionType: string;
  layoutType: string;
  avgTimeSpentSeconds: number;
  sampleCount: number;
}

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

  const systemPrompt = `You are Cimple's CIM Design Agent. Your job is to transform a business's collected information into a bespoke, visually compelling Confidential Information Memorandum document blueprint.

You are NOT generating a template. You are generating a bespoke document for this specific business.

YOUR OUTPUT IS A JSON ARRAY of section objects. Each section has:
- sectionKey: unique snake_case identifier you invent (e.g. "revenue_breakdown", "backlog_pipeline", "lease_summary")
- sectionTitle: professional display title
- order: integer starting at 1
- layoutType: the visual format (see list below)
- layoutData: the structured data to render (varies by layoutType — see spec below)
- aiDraftContent: prose content string (for prose-heavy layouts, required for prose_highlight and two_column)
- aiLayoutReasoning: 1–2 sentences explaining why you chose this layout for this content
- tags: array of category tags
- isVisible: true
- brokerApproved: false

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

divider: { label?, style?: "line"|"section-break"|"page-break" }
— Use for: visual separation between major document sections

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

IMPORTANT: Your output must be valid JSON. Only output the JSON array — no markdown, no explanation, no wrapper object.`;

  const userPrompt = `Generate a bespoke CIM layout for this business:

${knowledgeBase}

Output a JSON array of CimLayoutSection objects. Be bespoke. Use the data available. Create sections that make this business's story compelling to a sophisticated buyer.`;

  // Use streaming to keep the TCP connection alive during long generations.
  // Without streaming, idle socket timeouts (ETIMEDOUT) kill the connection
  // before the full 16K-token response arrives.
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5",
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: "user", content: userPrompt }],
  });
  const response = await stream.finalMessage();

  const rawContent = response.content[0];
  if (rawContent.type !== "text") {
    throw new Error("Layout engine returned non-text response");
  }

  // Parse the JSON — strip any accidental markdown fencing
  const jsonText = rawContent.text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();

  let sections: CimLayoutSection[];
  try {
    sections = JSON.parse(jsonText);
  } catch (e) {
    // Try to extract JSON array from the response
    const match = jsonText.match(/\[[\s\S]*\]/);
    if (!match) {
      throw new Error(`Layout engine returned unparseable response: ${jsonText.slice(0, 200)}`);
    }
    try {
      sections = JSON.parse(match[0]);
    } catch (e2) {
      // Attempt repair: truncate at last complete top-level array element.
      // Strategy: find every `},` at nesting depth 1 (i.e. the comma between
      // top-level objects in the array), then try parsing up through the last
      // one that succeeds.
      const src = match[0];
      const sectionEnds: number[] = [];
      let depth = 0;
      for (let i = 0; i < src.length; i++) {
        const ch = src[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
          depth--;
          if (depth === 1) sectionEnds.push(i); // closing brace of a top-level object
        }
      }
      let repaired = false;
      // Try from the last section end backwards until one parses
      for (let k = sectionEnds.length - 1; k >= 0; k--) {
        const candidate = src.slice(0, sectionEnds[k] + 1) + "\n]";
        try {
          sections = JSON.parse(candidate);
          repaired = true;
          console.log(`[layout-engine] JSON repaired: truncated to ${sections.length} sections (from ~${sectionEnds.length} detected)`);
          break;
        } catch (_) { /* try previous boundary */ }
      }
      if (!repaired) {
        throw new Error(`Layout engine JSON repair failed: ${(e2 as Error).message}. Raw (first 500): ${jsonText.slice(0, 500)}`);
      }
    }
  }

  // Validate and normalise
  sections = sections.map((s, i) => ({
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

  return {
    dealId: params.dealId,
    sections,
    generatedAt: new Date().toISOString(),
    version: 1,
  };
}

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
