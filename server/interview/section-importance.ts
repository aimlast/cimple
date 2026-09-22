/**
 * section-importance — how much each CIM section matters to buyers of THIS
 * business.
 *
 * Base levels live in data/section-importance.json. Once a deal's industry is
 * known, a supporting agent re-ranks them for that industry (permits become
 * critical for a restaurant or cannabis retailer, seasonality for landscaping,
 * lease terms for anything location-bound) and the result is stored on
 * deals.sectionImportance. The labels drive what sellers and brokers see on
 * questions and sections, and which sections must be covered before the
 * interview may end on the agent's own initiative.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { storage } from "../storage";
import { agentConfig } from "./config/load-config";
import { CIM_SECTIONS } from "@shared/schema";
import type { Deal, SectionImportanceEntry, SectionImportanceLevel, SectionImportanceMap } from "@shared/schema";

const __dirname = dirname(fileURLToPath(import.meta.url));

const LEVELS: SectionImportanceLevel[] = ["critical", "important", "helpful"];

const BASE: Record<string, SectionImportanceEntry> = (() => {
  const raw = JSON.parse(readFileSync(join(__dirname, "data", "section-importance.json"), "utf-8"));
  const out: Record<string, SectionImportanceEntry> = {};
  for (const section of CIM_SECTIONS) {
    const e = raw[section.key];
    out[section.key] = e && LEVELS.includes(e.level)
      ? { level: e.level, reason: String(e.reason || "") }
      : { level: "important", reason: "" };
  }
  return out;
})();

/** Base ranking — used until the industry-specific one exists. */
export function baseSectionImportance(): SectionImportanceMap {
  return { industry: "", computedAt: new Date(0).toISOString(), source: "base", sections: { ...BASE } };
}

/** Sections that must not be left "missing" when the agent wants to end. */
export function criticalSectionKeys(map: SectionImportanceMap | null | undefined): Set<string> {
  const keys = new Set<string>();
  const sections = map?.sections ?? BASE;
  for (const [key, entry] of Object.entries(sections)) if (entry.level === "critical") keys.add(key);
  // Base criticals are a floor — an industry ranking can promote, not demote,
  // the handful of sections no CIM is credible without.
  for (const [key, entry] of Object.entries(BASE)) if (entry.level === "critical") keys.add(key);
  return keys;
}

/** The stored ranking if it matches the deal's current industry, else base. */
export function getSectionImportance(deal: Pick<Deal, "industry" | "sectionImportance">): SectionImportanceMap {
  const stored = deal.sectionImportance as SectionImportanceMap | null | undefined;
  if (stored?.sections && stored.source === "ai" && industryKey(stored.industry) === industryKey(deal.industry)) {
    return stored;
  }
  return baseSectionImportance();
}

function industryKey(s: string | null | undefined): string {
  return (s || "").trim().toLowerCase();
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RANK_TOOL = {
  name: "rank_sections",
  description: "Rank how much each CIM section matters to buyers of this specific business.",
  input_schema: {
    type: "object" as const,
    required: ["sections"],
    properties: {
      sections: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "level", "reason"],
          properties: {
            key: { type: "string", description: "CIM section key, exactly as listed." },
            level: { type: "string", enum: LEVELS, description: "critical = buyers walk away or reprice without it; important = materially affects interest or price; helpful = nice to have." },
            reason: { type: "string", description: "One buyer-facing sentence, at most 15 words, specific to this industry. Plain language a seller understands." },
          },
        },
      },
    },
  },
};

/** In-flight computations, so concurrent turns don't rank the same deal twice. */
const inflight = new Map<string, Promise<SectionImportanceMap>>();

/**
 * Re-rank the sections for the deal's industry with the supporting model and
 * persist the result. Falls back to (and returns) the base ranking on any
 * failure — the interview never waits on or breaks because of this.
 */
export async function computeSectionImportance(
  deal: Pick<Deal, "id" | "industry" | "businessName" | "description">,
  context?: { subIndustry?: string | null; location?: string | null; industrySpecificAreas?: string[] },
): Promise<SectionImportanceMap> {
  const industry = (deal.industry || "").trim();
  if (!industry) return baseSectionImportance();
  const existing = inflight.get(deal.id);
  if (existing) return existing;

  const task = (async () => {
    try {
      const list = CIM_SECTIONS.map((s) => `- ${s.key}: ${s.title} (base: ${BASE[s.key].level})`).join("\n");
      const ctx = [
        `Industry: ${industry}`,
        context?.subIndustry ? `Sub-industry: ${context.subIndustry}` : null,
        context?.location ? `Location: ${context.location}` : null,
        deal.description ? `Description: ${String(deal.description).slice(0, 400)}` : null,
        context?.industrySpecificAreas?.length ? `Industry-specific areas already identified: ${context.industrySpecificAreas.join("; ")}` : null,
      ].filter(Boolean).join("\n");

      const response = await anthropic.messages.create({
        model: agentConfig.models.supportingAgents,
        max_tokens: 1500,
        temperature: 0.2,
        tools: [RANK_TOOL],
        tool_choice: { type: "tool", name: "rank_sections" },
        system: [
          "You are a senior M&A advisor who has sold hundreds of small and mid-sized businesses.",
          "Rank how much each CIM section matters to serious buyers of the business described, for THIS industry — not generically.",
          "Rules: at most 7 sections may be critical; the base level is a starting point, promote or demote only when the industry genuinely changes buyer behaviour",
          "(e.g. permits/licences are critical where licences are hard to transfer — liquor, cannabis, healthcare, trucking; seasonality is critical for landscaping/snow, tourism, tax prep; real estate is critical for location-bound retail and restaurants; training is important where the owner holds a licence or key relationships).",
          "Return every section key exactly once.",
        ].join(" "),
        messages: [{ role: "user", content: `Business:\n${ctx}\n\nSections:\n${list}` }],
      });
      const block = response.content.find((b) => b.type === "tool_use");
      const input = (block && block.type === "tool_use" ? block.input : null) as { sections?: { key: string; level: string; reason: string }[] } | null;
      const sections: Record<string, SectionImportanceEntry> = { ...BASE };
      let applied = 0;
      for (const item of input?.sections ?? []) {
        if (!(item.key in BASE) || !LEVELS.includes(item.level as SectionImportanceLevel)) continue;
        // Base criticals are a floor: the ranking may promote sections, never
        // demote the handful no CIM is credible without (keeps the label the
        // broker sees consistent with what governs interview completion).
        const level = BASE[item.key].level === "critical" ? "critical" : (item.level as SectionImportanceLevel);
        sections[item.key] = { level, reason: String(item.reason || BASE[item.key].reason).slice(0, 160) };
        applied++;
      }
      if (applied === 0) throw new Error("ranking returned no usable sections");
      const map: SectionImportanceMap = {
        industry,
        subIndustry: context?.subIndustry ?? null,
        computedAt: new Date().toISOString(),
        source: "ai",
        sections,
      };
      await storage.updateDeal(deal.id, { sectionImportance: map } as any);
      console.log(`[section-importance] ranked ${applied} sections for deal ${deal.id} (${industry}); critical: ${Object.entries(sections).filter(([, e]) => e.level === "critical").map(([k]) => k).join(", ")}`);
      return map;
    } catch (err: any) {
      console.warn(`[section-importance] ranking failed for deal ${deal.id}, using base:`, err?.message || err);
      return baseSectionImportance();
    } finally {
      inflight.delete(deal.id);
    }
  })();
  inflight.set(deal.id, task);
  return task;
}

/** Start a ranking in the background if the deal has an industry but no matching ranking. */
export function ensureSectionImportance(
  deal: Pick<Deal, "id" | "industry" | "businessName" | "description" | "sectionImportance">,
  context?: Parameters<typeof computeSectionImportance>[1],
): void {
  if (!deal.industry) return;
  const current = getSectionImportance(deal);
  if (current.source === "ai") return;
  void computeSectionImportance(deal, context);
}

/** Prompt block: the agent's priorities for this business. */
export function renderSectionImportanceForPrompt(map: SectionImportanceMap): string {
  const byLevel: Record<SectionImportanceLevel, string[]> = { critical: [], important: [], helpful: [] };
  for (const section of CIM_SECTIONS) {
    const e = map.sections[section.key] ?? BASE[section.key];
    byLevel[e.level].push(`${section.key} — ${section.title}${e.reason ? ` (${e.reason})` : ""}`);
  }
  return [
    `## Section priorities for this business${map.source === "ai" ? ` (ranked for ${map.industry})` : " (base ranking — industry not yet confirmed)"}`,
    `CRITICAL — buyers walk away or reprice without these; cover them first and never end with one still missing:`,
    ...byLevel.critical.map((l) => `  - ${l}`),
    `IMPORTANT — materially affects interest or price:`,
    ...byLevel.important.map((l) => `  - ${l}`),
    `HELPFUL — nice to have; ask only once the above are covered or when it comes up naturally:`,
    ...byLevel.helpful.map((l) => `  - ${l}`),
    `For every question set "targetSection" to the section key it fills and "importance" to that section's level (you may raise a single question to "critical" when it is an industry-mandatory probe).`,
  ].join("\n");
}
