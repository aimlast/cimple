/**
 * interview-plan — the industry-specific data checklist for a deal.
 *
 * The generic CIM fields (SECTION_FIELD_MAP) are the same for every business;
 * what differs by industry is the specific data a buyer needs — chair count
 * and insurance mix for a dental practice, backlog and bonding capacity for a
 * contractor, liquor licence transferability for a bar. That knowledge lives
 * in prompts/industry-intelligence.md; this module turns the deal's slice of
 * it into concrete data points per CIM section, each with a camelCase key the
 * interview records its answer under, so the broker can see (and edit) exactly
 * what the interview is trying to get and what's already on file.
 *
 * Built once per industry with the supporting model and stored on
 * deals.interviewPlan; rebuilt if the deal's industry changes.
 */
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { agentConfig } from "./config/load-config";
import { buildIndustryKnowledge, matchIndustrySection } from "./industry-loader";
import { SECTION_FIELD_MAP, type CoverageFieldAdjustments } from "./knowledge-base";
import { getInterviewOutline } from "./outline";
import { CIM_SECTIONS } from "@shared/schema";
import type { Deal, InterviewPlan, InterviewPlanItem } from "@shared/schema";

const MAX_ITEMS_PER_SECTION = 8;
/** Labels asking for a quantity — their "already on file" match must contain a number. */
const QUANTITATIVE_RE = /%|\b(number|count|how many|rate|ratio|per (day|month|year|visit)|average|total|share|split|percentage|revenue|production|value|age of|years?)\b/i;

/** Labels for the generic fields so the outline reads as English, not keys. */
export const GENERIC_FIELD_LABELS: Record<string, string> = {
  businessName: "Business name",
  industry: "Industry",
  companyHistory: "Company history",
  yearsOperating: "Years in operation",
  entityType: "Legal entity type",
  brandIdentity: "Brand identity",
  missionStatement: "Mission statement",
  coreValues: "Core values",
  ownershipHistory: "Ownership history",
  industryPerception: "Reputation in the industry",
  customerPerception: "Reputation with customers",
  accolades: "Awards and recognition",
  competitiveAdvantage: "Competitive advantage",
  uniqueSellingProposition: "What makes it different",
  strengths: "Key strengths",
  growthOpportunities: "Growth opportunities",
  expansionPlans: "Expansion plans",
  targetMarket: "Target market",
  primaryMarket: "Primary market",
  secondaryMarket: "Secondary market",
  b2bBreakdown: "Business vs consumer split",
  customerDemographics: "Customer demographics",
  customerBase: "Customer base",
  permitsLicenses: "Permits and licences",
  complianceRequirements: "Compliance requirements",
  seasonality: "Seasonality",
  peakPeriods: "Peak periods",
  slowPeriods: "Slow periods",
  revenueStreams: "Revenue streams",
  keyProducts: "Key products / services",
  customerConcentration: "Customer concentration",
  annualRevenue: "Annual revenue",
  revenueGrowth: "Revenue growth",
  operatingMargins: "Operating margins",
  leaseDetails: "Lease terms",
  propertyInfo: "Property details",
  realEstateIncluded: "Real estate included in sale",
  employees: "Number of employees",
  employeeStructure: "Staff structure",
  keyEmployees: "Key employees",
  ownerInvolvement: "Owner's day-to-day role",
  managementTeam: "Management team",
  suppliers: "Key suppliers",
  supplyChain: "Supply chain",
  technologySystems: "Technology / software",
  operationalSystems: "Operational systems",
  idealBuyer: "Ideal buyer",
  trainingSupport: "Training offered to the buyer",
  transitionPlan: "Transition plan",
  reasonForSale: "Reason for sale",
  revenueByYear: "Revenue by year",
  ebitda: "EBITDA",
  sde: "Seller's discretionary earnings (SDE)",
  netIncome: "Net income",
  grossProfit: "Gross profit",
  addbacks: "Add-backs",
  workingCapital: "Working capital",
  debt: "Debt",
  askingPrice: "Asking price",
  saleType: "Share vs asset sale",
  assetsIncluded: "Assets included",
  inventory: "Inventory",
};

export function fieldLabel(key: string): string {
  if (GENERIC_FIELD_LABELS[key]) return GENERIC_FIELD_LABELS[key];
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function industryKey(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}

/** The stored plan if it was built for the deal's current industry (and sub-industry, when recorded). */
export function getInterviewPlan(deal: Pick<Deal, "industry" | "interviewPlan"> & { subIndustry?: string | null }): InterviewPlan | null {
  const plan = deal.interviewPlan as InterviewPlan | null | undefined;
  if (!plan || plan.status !== "ready" || !Array.isArray(plan.items)) return null;
  if (industryKey(plan.industry) !== industryKey(deal.industry)) return null;
  // A plan records the deal's sub-industry it was built for; a broker edit
  // (Home Services → "Landscaping and snow") rebuilds it. Plans built before
  // this was recorded, or callers that don't load the column, keep theirs.
  if (plan.dealSubIndustry !== undefined && deal.subIndustry !== undefined
    && industryKey(plan.dealSubIndustry) !== industryKey(deal.subIndustry)) return null;
  return plan;
}

/**
 * The sub-industry to build the checklist for: the broker's own entry on the
 * deal first (a generic industry like "Home Services" only finds the
 * landscaping playbook through it), then the interview's identified one.
 * Null when neither — nor the industry alone — matches a playbook.
 */
export function planSubIndustry(
  deal: { industry?: string | null; subIndustry?: string | null },
  contextSub?: string | null,
): { matched: boolean; subIndustry: string | null } {
  const industry = (deal.industry || "").trim();
  if (!industry) return { matched: false, subIndustry: null };
  for (const sub of [deal.subIndustry, contextSub]) {
    if (sub && sub.trim() && matchIndustrySection(industry, sub) != null) return { matched: true, subIndustry: sub.trim() };
  }
  if (matchIndustrySection(industry, null) != null) return { matched: true, subIndustry: (deal.subIndustry || contextSub || "").trim() || null };
  return { matched: false, subIndustry: null };
}

/**
 * Coverage adjustments for a deal: industry checklist items + broker-added
 * items, minus broker-removed ones. Feeds buildSectionCoverage everywhere
 * coverage is computed, so the interview, readiness and outline agree.
 */
export function coverageAdjustmentsForDeal(deal: Pick<Deal, "industry" | "interviewPlan" | "interviewOutline"> & { subIndustry?: string | null }): CoverageFieldAdjustments {
  const plan = getInterviewPlan(deal);
  const outline = getInterviewOutline(deal);
  const add: Record<string, { key: string; label: string; critical?: boolean; alias?: string | null }[]> = {};
  for (const item of plan?.items ?? []) (add[item.sectionKey] ??= []).push({ key: item.key, label: item.label, critical: item.critical, alias: item.answeredByKey ?? null });
  for (const item of outline.addedItems ?? []) (add[item.sectionKey] ??= []).push({ key: item.key, label: item.label, critical: false });
  return { add, remove: new Set(outline.removedItems ?? []) };
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PLAN_TOOL = {
  name: "industry_checklist",
  description: "List the industry-specific data points to capture for each CIM section.",
  input_schema: {
    type: "object" as const,
    required: ["items"],
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          required: ["sectionKey", "key", "label", "critical"],
          properties: {
            sectionKey: { type: "string", description: "One of the CIM section keys listed." },
            key: { type: "string", description: "camelCase data key, specific and unique, e.g. activePatientCount, operatoryCount, insuranceRevenueShare, bondingCapacity, backlogValue." },
            label: { type: "string", description: "Plain label a broker understands, 2–9 words, e.g. 'Active patients (last 18–24 months)'." },
            critical: { type: "boolean", description: "True when the playbook marks it [CRITICAL] or it is a mandatory probe for this industry." },
            answeredByKey: { type: "string", description: "Key of a FACT ALREADY ON FILE whose value literally states the answer to this data point (e.g. the number, the yes/no, the term) — otherwise empty string. Being on the same topic is NOT enough; a lease description does not answer an operatory count. When in doubt, leave it empty: a false match makes the interview skip a question it should ask." },
          },
        },
      },
    },
  },
};

const VERIFY_TOOL = {
  name: "verify_matches",
  description: "For each numbered pair, decide whether the fact literally answers the data point.",
  input_schema: {
    type: "object" as const,
    required: ["verdicts"],
    properties: {
      verdicts: {
        type: "array",
        items: {
          type: "object",
          required: ["n", "answers"],
          properties: {
            n: { type: "integer" },
            answers: { type: "boolean", description: "true only if a buyer reading ONLY this fact would know the answer to the data point. Same topic is not enough; a floor plan does not state equipment age." },
          },
        },
      },
    },
  },
};

/**
 * Second, strict pass over proposed "already on file" matches. A false match
 * makes the interview skip a question it should ask, so only pairs the model
 * confirms individually survive; on any failure, no matches survive.
 */
async function verifyMatches(pairs: { label: string; value: string }[]): Promise<boolean[]> {
  if (pairs.length === 0) return [];
  try {
    const list = pairs.map((p, i) => `${i + 1}. DATA POINT: ${p.label}\n   FACT ON FILE: ${p.value.replace(/\s+/g, " ").slice(0, 400)}`).join("\n");
    const response = await anthropic.messages.create({
      model: agentConfig.models.supportingAgents,
      max_tokens: 2000,
      temperature: 0,
      tools: [VERIFY_TOOL],
      tool_choice: { type: "tool", name: "verify_matches" },
      system: "You audit a due-diligence checklist. For each pair, answer true only if the fact on file actually states the answer to the data point (the number, the yes/no, the name, the term). If the fact is merely related, partial, or you would still need to ask the seller, answer false.",
      messages: [{ role: "user", content: list }],
    });
    const block = response.content.find((b) => b.type === "tool_use");
    const verdicts = ((block && block.type === "tool_use" ? block.input : {}) as { verdicts?: { n: number; answers: boolean }[] }).verdicts ?? [];
    const ok = new Array(pairs.length).fill(false);
    for (const v of verdicts) if (v.n >= 1 && v.n <= pairs.length) ok[v.n - 1] = v.answers === true;
    return ok;
  } catch (err) {
    console.warn("[interview-plan] match verification failed; dropping all matches:", (err as Error).message);
    return pairs.map(() => false);
  }
}

const inflight = new Map<string, Promise<InterviewPlan | null>>();

/**
 * Build the checklist for the deal's industry from its playbook slice and
 * persist it. Returns null (and stores a failed marker) on failure — the
 * interview carries on with the generic fields.
 */
export async function computeInterviewPlan(
  deal: Pick<Deal, "id" | "industry" | "businessName" | "description" | "extractedInfo"> & { subIndustry?: string | null },
  context?: { subIndustry?: string | null },
): Promise<InterviewPlan | null> {
  const industry = (deal.industry || "").trim();
  if (!industry) return null;
  const target = planSubIndustry(deal, context?.subIndustry);
  if (!target.matched) return null;
  const subIndustry = target.subIndustry;
  const dealSubIndustry = deal.subIndustry === undefined ? undefined : (deal.subIndustry ?? null);
  const existing = inflight.get(deal.id);
  if (existing) return existing;

  const task = (async () => {
    try {
      const playbook = buildIndustryKnowledge(industry, subIndustry);
      const sections = CIM_SECTIONS.map((s) => {
        const generic = (SECTION_FIELD_MAP[s.key] || []).map((f) => fieldLabel(f)).join("; ");
        return `- ${s.key}: ${s.title} (already covered generically: ${generic || "nothing"})`;
      }).join("\n");
      // Facts already on file, so items they answer are shown as known.
      const info = (deal.extractedInfo as Record<string, unknown> | null) || {};
      const onFile = Object.entries(info)
        .filter(([k, v]) => !k.startsWith("_") && v !== null && v !== undefined && String(v).trim() !== "")
        .slice(0, 120)
        .map(([k, v]) => `- ${k}: ${String(typeof v === "object" ? JSON.stringify(v) : v).replace(/\s+/g, " ").slice(0, 160)}`)
        .join("\n");
      const response = await anthropic.messages.create({
        model: agentConfig.models.supportingAgents,
        max_tokens: 6000,
        temperature: 0.2,
        tools: [PLAN_TOOL],
        tool_choice: { type: "tool", name: "industry_checklist" },
        system: [
          "You turn an industry due-diligence playbook into a concrete data checklist for a CIM interview.",
          "For the business described, list the INDUSTRY-SPECIFIC data points the interview must capture, assigned to the CIM section they belong in.",
          `Rules: only data points specific to this industry/sub-industry — never repeat the generic items already listed per section; each is ONE concrete fact (a number, a yes/no, a term, a list), not a topic; at most ${MAX_ITEMS_PER_SECTION} per section; prefer the playbook's [CRITICAL] fields and MANDATORY PROBES and mark those critical; pick the sub-industry that matches this business and ignore the others; keys are camelCase and self-explanatory; labels and keys name the data point only — never a value, name or figure from the facts on file (the interviewer reads them to the seller).`,
          `Conditional probes: many playbook items name the businesses they apply to ("movers and passenger operators", "any lane touching California", "for franchises", "consumer-facing"). Leave an item OUT when its condition doesn't hold for this business as described (a B2B freight carrier gets no consumer-complaint item; a carrier with no California lanes gets no CARB item). When unsure whether the condition holds, keep it but do not mark it critical.`,
        ].join(" "),
        messages: [{
          role: "user",
          content: [
            `Business: ${deal.businessName} — ${industry}${subIndustry ? ` (${subIndustry})` : ""}`,
            deal.description ? `Description: ${String(deal.description).slice(0, 400)}` : "",
            `\nCIM sections:\n${sections}`,
            `\nFACTS ALREADY ON FILE (key: value):\n${onFile || "(none yet)"}`,
            `\nIndustry playbook:\n${playbook}`,
          ].filter(Boolean).join("\n"),
        }],
      });
      const block = response.content.find((b) => b.type === "tool_use");
      const raw = ((block && block.type === "tool_use" ? block.input : {}) as { items?: Partial<InterviewPlanItem>[] }).items ?? [];
      const sectionKeys = new Set<string>(CIM_SECTIONS.map((s) => s.key));
      const genericKeys = new Set(Object.values(SECTION_FIELD_MAP).flat().map((k) => k.toLowerCase()));
      const seen = new Set<string>();
      const perSection = new Map<string, number>();
      const items: InterviewPlanItem[] = [];
      for (const r of raw) {
        if (!r || typeof r.key !== "string" || typeof r.label !== "string" || !sectionKeys.has(String(r.sectionKey))) continue;
        const key = r.key.replace(/[^A-Za-z0-9]/g, "").replace(/^[A-Z]/, (c) => c.toLowerCase()).slice(0, 48);
        if (!key || seen.has(key.toLowerCase()) || genericKeys.has(key.toLowerCase())) continue;
        const n = perSection.get(r.sectionKey!) ?? 0;
        if (n >= MAX_ITEMS_PER_SECTION) continue;
        perSection.set(r.sectionKey!, n + 1);
        seen.add(key.toLowerCase());
        let alias = typeof r.answeredByKey === "string" && r.answeredByKey.trim() && r.answeredByKey.trim() in info ? r.answeredByKey.trim() : null;
        // Quantitative items can only be answered by a value that contains a number.
        if (alias && QUANTITATIVE_RE.test(r.label) && !/\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|half|none|zero)\b/i.test(String(info[alias]))) alias = null;
        items.push({ key, label: r.label.trim().slice(0, 90), sectionKey: r.sectionKey!, critical: r.critical === true, answeredByKey: alias });
      }
      if (items.length === 0) throw new Error("checklist came back empty");
      const matched = items.filter((i) => i.answeredByKey);
      const verdicts = await verifyMatches(matched.map((i) => ({ label: i.label, value: String(info[i.answeredByKey!]) })));
      matched.forEach((item, idx) => { if (!verdicts[idx]) item.answeredByKey = null; });
      const plan: InterviewPlan = { industry, subIndustry, ...(dealSubIndustry !== undefined ? { dealSubIndustry } : {}), computedAt: new Date().toISOString(), status: "ready", items };
      await storage.updateDeal(deal.id, { interviewPlan: plan } as any);
      console.log(`[interview-plan] ${items.length} industry data points for deal ${deal.id} (${industry})`);
      return plan;
    } catch (err: any) {
      console.warn(`[interview-plan] build failed for deal ${deal.id}:`, err?.message || err);
      await storage.updateDeal(deal.id, {
        interviewPlan: { industry, subIndustry, ...(dealSubIndustry !== undefined ? { dealSubIndustry } : {}), computedAt: new Date().toISOString(), status: "failed", items: [] },
      } as any).catch(() => {});
      return null;
    } finally {
      inflight.delete(deal.id);
    }
  })();
  inflight.set(deal.id, task);
  return task;
}

/** True while a build for this deal is running. */
export function isPlanBuilding(dealId: string): boolean {
  return inflight.has(dealId);
}

/** Start a build in the background when the deal has an industry but no current checklist. */
export function ensureInterviewPlan(
  deal: Pick<Deal, "id" | "industry" | "businessName" | "description" | "interviewPlan" | "extractedInfo"> & { subIndustry?: string | null },
  context?: { subIndustry?: string | null },
): void {
  if (!deal.industry || getInterviewPlan(deal) || inflight.has(deal.id)) return;
  // Don't hammer a failing build: retry at most once an hour.
  const stored = deal.interviewPlan as InterviewPlan | null | undefined;
  if (stored?.status === "failed" && industryKey(stored.industry) === industryKey(deal.industry)
    && (stored.dealSubIndustry === undefined || deal.subIndustry === undefined || industryKey(stored.dealSubIndustry) === industryKey(deal.subIndustry))
    && Date.now() - new Date(stored.computedAt).getTime() < 60 * 60 * 1000) return;
  void computeInterviewPlan(deal, context);
}
