/**
 * outline — the broker's plain-language edits to what an interview covers.
 *
 * Before (or during) the interview a broker can see the plan — the CIM
 * sections with their buyer importance plus the industry-specific areas — and
 * change it by telling Cimple what they want ("also cover the franchise
 * renewal and the two government contracts; skip seasonality"). A supporting
 * agent turns that into a concrete proposal (new topics with what to capture,
 * sections to exclude or restore, emphasis notes); the broker reviews and
 * applies it. Nothing changes until they click Apply.
 *
 * Applied outlines feed the interview agent (mandatory custom topics,
 * excluded sections never asked about, emphasis honoured) and coverage /
 * readiness ignore excluded sections. Base-critical sections cannot be
 * excluded — the CIM isn't credible without them — the proposal says so.
 */
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { agentConfig } from "./config/load-config";
import { getSectionImportance, criticalSectionKeys } from "./section-importance";
import { coverageAdjustmentsForDeal, fieldLabel } from "./interview-plan";
import { SECTION_FIELD_MAP } from "./knowledge-base";
import { CIM_SECTIONS } from "@shared/schema";
import type { Deal, InterviewOutline, OutlineCustomTopic, OutlineEmphasis, SectionImportanceLevel } from "@shared/schema";

const LEVELS: SectionImportanceLevel[] = ["critical", "important", "helpful"];
const HISTORY_CAP = 20;
/** The CIM isn't credible without these — never removable from the checklist. */
const UNREMOVABLE_ITEMS = new Set(["askingPrice", "annualRevenue"]);

function camelKey(s: string): string {
  // Already a camelCase key (the model usually supplies one) — keep its casing.
  if (/^[a-z][A-Za-z0-9]{1,47}$/.test(s.trim())) return s.trim();
  const words = s.replace(/[^A-Za-z0-9 ]+/g, " ").trim().split(/\s+/).filter(Boolean).slice(0, 6);
  return words.map((w, i) => (i === 0 ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())).join("").slice(0, 48);
}

export function emptyOutline(): InterviewOutline {
  return { updatedAt: new Date(0).toISOString(), customTopics: [], excludedSections: [], emphasis: [], history: [] };
}

export function getInterviewOutline(deal: Pick<Deal, "interviewOutline">): InterviewOutline {
  const stored = deal.interviewOutline as InterviewOutline | null | undefined;
  if (!stored || typeof stored !== "object") return emptyOutline();
  return {
    updatedAt: stored.updatedAt ?? new Date(0).toISOString(),
    customTopics: Array.isArray(stored.customTopics) ? stored.customTopics : [],
    excludedSections: Array.isArray(stored.excludedSections) ? stored.excludedSections : [],
    emphasis: Array.isArray(stored.emphasis) ? stored.emphasis : [],
    addedItems: Array.isArray(stored.addedItems) ? stored.addedItems : [],
    removedItems: Array.isArray(stored.removedItems) ? stored.removedItems : [],
    history: Array.isArray(stored.history) ? stored.history : [],
  };
}

/** True when the broker changed anything — the prompt block is only rendered then. */
export function outlineHasContent(o: InterviewOutline): boolean {
  return o.customTopics.length > 0 || o.excludedSections.length > 0 || o.emphasis.length > 0 || (o.removedItems?.length ?? 0) > 0;
}

/** What the agent proposes in response to one instruction. Applied verbatim on Apply. */
export interface OutlineProposal {
  /** Plain-language recap of the change, 1–2 sentences. */
  summary: string;
  addTopics: OutlineCustomTopic[];
  /** Custom-topic keys to drop. */
  removeTopics: string[];
  /** CIM section keys to exclude from this interview. */
  excludeSections: string[];
  /** CIM section keys to bring back. */
  restoreSections: string[];
  /** Section notes to set (replace existing note for that key). */
  emphasis: OutlineEmphasis[];
  /** Emphasis keys to clear. */
  clearEmphasis: string[];
  /** Specific data points to add to a section's checklist. */
  addItems: { sectionKey: string; label: string; key?: string }[];
  /** Checklist item keys to drop from this interview. */
  removeItems: string[];
  /** Previously removed item keys to bring back. */
  restoreItems: string[];
  /** Things the instruction asked for that were not done, with why (e.g. excluding a critical section). */
  refused: { request: string; why: string }[];
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const PROPOSE_TOOL = {
  name: "propose_outline_changes",
  description: "Translate the broker's instruction into concrete changes to the interview outline.",
  input_schema: {
    type: "object" as const,
    required: ["summary", "addTopics", "removeTopics", "excludeSections", "restoreSections", "emphasis", "clearEmphasis", "addItems", "removeItems", "restoreItems", "refused"],
    properties: {
      summary: { type: "string", description: "1–2 plain sentences recapping exactly what will change." },
      addTopics: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "title", "description", "importance", "capture"],
          properties: {
            key: { type: "string", description: "snake_case identifier, unique, e.g. franchise_agreement" },
            title: { type: "string", description: "Short title as a broker would say it (2–5 words)." },
            description: { type: "string", description: "One sentence: why buyers care about this for THIS business." },
            importance: { type: "string", enum: LEVELS },
            capture: { type: "array", items: { type: "string" }, description: "2–5 concrete facts the interview must capture (each ≤ 12 words)." },
          },
        },
      },
      removeTopics: { type: "array", items: { type: "string" }, description: "Existing custom-topic keys to remove." },
      excludeSections: { type: "array", items: { type: "string" }, description: "Standard CIM section keys to leave out of this interview." },
      restoreSections: { type: "array", items: { type: "string" }, description: "Previously excluded section keys to bring back." },
      emphasis: {
        type: "array",
        items: { type: "object", required: ["key", "note"], properties: { key: { type: "string" }, note: { type: "string", description: "≤ 20 words of guidance for the interviewer on this section." } } },
        description: "Per-section guidance (go deeper / specific angle). Use this — not a new topic — when the request is already covered by a standard section.",
      },
      clearEmphasis: { type: "array", items: { type: "string" } },
      addItems: {
        type: "array",
        description: "Specific data points to add to an existing section's checklist (one concrete fact each, e.g. 'Number of chairs in use'). Prefer this over a custom topic when the fact belongs in a standard section.",
        items: { type: "object", required: ["sectionKey", "label"], properties: { sectionKey: { type: "string" }, label: { type: "string", description: "2–9 words" }, key: { type: "string", description: "camelCase key" } } },
      },
      removeItems: { type: "array", items: { type: "string" }, description: "Checklist item keys (as listed) the broker wants skipped." },
      restoreItems: { type: "array", items: { type: "string" }, description: "Previously removed item keys to bring back." },
      refused: {
        type: "array",
        items: { type: "object", required: ["request", "why"], properties: { request: { type: "string" }, why: { type: "string" } } },
      },
    },
  },
};

/**
 * Ask the supporting model to turn an instruction into a proposal. Validated
 * and normalised here so Apply can trust it; critical sections are never
 * excluded (moved to `refused`).
 */
export async function proposeOutlineChanges(deal: Deal, instruction: string): Promise<OutlineProposal> {
  const outline = getInterviewOutline(deal);
  const importance = getSectionImportance(deal);
  const critical = criticalSectionKeys(importance);
  const adjustments = coverageAdjustmentsForDeal({ ...deal, interviewOutline: { ...outline, removedItems: [] } });
  const removed = new Set(outline.removedItems ?? []);
  const sectionList = CIM_SECTIONS.map((s) => {
    const items = [
      ...(SECTION_FIELD_MAP[s.key] ?? []).map((k) => ({ key: k, label: fieldLabel(k) })),
      ...(adjustments.add?.[s.key] ?? []),
    ].map((i) => `${i.key}=${i.label}${removed.has(i.key) ? " [REMOVED]" : ""}`).join("; ");
    const imp = importance.sections[s.key];
    const flags = [
      imp ? imp.level : "important",
      critical.has(s.key) ? "cannot be excluded" : "",
      outline.excludedSections.includes(s.key) ? "CURRENTLY EXCLUDED" : "",
    ].filter(Boolean).join(", ");
    const note = outline.emphasis.find((e) => e.key === s.key)?.note;
    return `- ${s.key}: ${s.title} (${flags})${note ? ` — current note: "${note}"` : ""}\n    checklist: ${items || "(none)"}`;
  }).join("\n");
  const topicList = outline.customTopics.length
    ? outline.customTopics.map((t) => `- ${t.key}: ${t.title} [${t.importance}] — capture: ${t.capture.join("; ")}`).join("\n")
    : "(none)";

  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 2000,
    temperature: 0.2,
    tools: [PROPOSE_TOOL],
    tool_choice: { type: "tool", name: "propose_outline_changes" },
    system: [
      "You maintain the plan for an AI-led seller interview that feeds a Confidential Information Memorandum.",
      "The broker gives an instruction in plain language; produce the minimal set of concrete changes that fulfil it — nothing they did not ask for.",
      "Each section lists its checklist (key=label). When the broker asks to also get a specific fact, add it with addItems to the right section; when they say to skip or not bother with a specific fact, use removeItems with its key. If the request is already covered by a checklist item, set an emphasis note instead of adding a duplicate.",
      "Add a custom topic only for something the standard sections do not cover (a specific contract, an asset, a regulatory situation, a relationship). Give it 2–5 capture items phrased as facts to obtain, and an importance level based on how much buyers of this business would care.",
      "Sections marked 'cannot be excluded' must never appear in excludeSections; put such a request in `refused` with a one-sentence reason.",
      "Use only the section keys and topic keys listed. Keep the summary plain and specific.",
    ].join(" "),
    messages: [{
      role: "user",
      content: [
        `Business: ${deal.businessName}${deal.industry ? ` (${deal.industry})` : ""}${deal.description ? `\n${String(deal.description).slice(0, 300)}` : ""}`,
        `\nStandard CIM sections:\n${sectionList}`,
        `\nCustom topics already added:\n${topicList}`,
        `\nBroker's instruction:\n"""${instruction.trim().slice(0, 1500)}"""`,
      ].join("\n"),
    }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  const raw = (block && block.type === "tool_use" ? block.input : {}) as Partial<OutlineProposal>;
  return normaliseProposal(raw, outline, critical);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "topic";
}

function normaliseProposal(raw: Partial<OutlineProposal>, outline: InterviewOutline, critical: Set<string>): OutlineProposal {
  const sectionKeys = new Set<string>(CIM_SECTIONS.map((s) => s.key));
  const topicKeys = new Set(outline.customTopics.map((t) => t.key));
  const refused = Array.isArray(raw.refused)
    ? raw.refused.filter((r) => r && typeof r.request === "string").map((r) => ({ request: String(r.request), why: String(r.why || "") }))
    : [];

  const addTopics: OutlineCustomTopic[] = [];
  const seen = new Set<string>();
  for (const t of Array.isArray(raw.addTopics) ? raw.addTopics : []) {
    if (!t || typeof t.title !== "string" || !t.title.trim()) continue;
    let key = slug(typeof t.key === "string" && t.key ? t.key : t.title);
    while (seen.has(key) || topicKeys.has(key) || sectionKeys.has(key)) key = `${key}_2`;
    seen.add(key);
    addTopics.push({
      key,
      title: t.title.trim().slice(0, 80),
      description: String(t.description || "").trim().slice(0, 240),
      importance: LEVELS.includes(t.importance as SectionImportanceLevel) ? (t.importance as SectionImportanceLevel) : "important",
      capture: (Array.isArray(t.capture) ? t.capture : []).map((c) => String(c).trim()).filter(Boolean).slice(0, 5),
    });
  }

  const excludeSections: string[] = [];
  for (const k of Array.isArray(raw.excludeSections) ? raw.excludeSections : []) {
    if (!sectionKeys.has(k)) continue;
    if (critical.has(k)) {
      const title = CIM_SECTIONS.find((s) => s.key === k)?.title ?? k;
      refused.push({ request: `Remove "${title}"`, why: "Buyers walk away or reprice without this section, so it stays in every interview. You can add a note to keep it brief instead." });
      continue;
    }
    excludeSections.push(k);
  }

  // Checklist item edits.
  const sectionOf = new Map<string, string>();
  for (const s of CIM_SECTIONS) for (const k of SECTION_FIELD_MAP[s.key] ?? []) sectionOf.set(k, s.key);
  for (const it of outline.addedItems ?? []) sectionOf.set(it.key, it.sectionKey);
  const knownItem = (k: string) => sectionOf.has(k) || /^[a-z][A-Za-z0-9]{1,47}$/.test(k);
  const addItems: { sectionKey: string; label: string; key: string }[] = [];
  for (const it of Array.isArray(raw.addItems) ? raw.addItems : []) {
    if (!it || !sectionKeys.has(it.sectionKey) || typeof it.label !== "string" || !it.label.trim()) continue;
    const key = camelKey(typeof it.key === "string" && it.key ? it.key : it.label);
    if (!key || addItems.some((a) => a.key === key)) continue;
    addItems.push({ sectionKey: it.sectionKey, label: it.label.trim().slice(0, 90), key });
  }
  const removeItems: string[] = [];
  for (const k of Array.isArray(raw.removeItems) ? raw.removeItems : []) {
    if (typeof k !== "string" || !knownItem(k)) continue;
    if (UNREMOVABLE_ITEMS.has(k)) {
      refused.push({ request: `Skip "${fieldLabel(k)}"`, why: "Every CIM needs this figure, so it stays on the checklist." });
      continue;
    }
    removeItems.push(k);
  }
  const restoreItems = (Array.isArray(raw.restoreItems) ? raw.restoreItems : []).filter((k) => (outline.removedItems ?? []).includes(k));

  return {
    addItems,
    removeItems,
    restoreItems,
    summary: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "No changes.",
    addTopics,
    removeTopics: (Array.isArray(raw.removeTopics) ? raw.removeTopics : []).filter((k) => topicKeys.has(k)),
    excludeSections,
    restoreSections: (Array.isArray(raw.restoreSections) ? raw.restoreSections : []).filter((k) => outline.excludedSections.includes(k)),
    emphasis: (Array.isArray(raw.emphasis) ? raw.emphasis : [])
      .filter((e) => e && sectionKeys.has(e.key) && typeof e.note === "string" && e.note.trim())
      .map((e) => ({ key: e.key, note: e.note.trim().slice(0, 200) })),
    clearEmphasis: (Array.isArray(raw.clearEmphasis) ? raw.clearEmphasis : []).filter((k) => outline.emphasis.some((e) => e.key === k)),
    refused,
  };
}

/** Apply a (re-validated) proposal to the deal's outline and persist it. */
export async function applyOutlineProposal(deal: Deal, proposal: OutlineProposal, instruction: string): Promise<InterviewOutline> {
  const current = getInterviewOutline(deal);
  const critical = criticalSectionKeys(getSectionImportance(deal));
  const p = normaliseProposal(proposal, current, critical);

  const customTopics = current.customTopics
    .filter((t) => !p.removeTopics.includes(t.key))
    .concat(p.addTopics);
  const excluded = new Set(current.excludedSections);
  for (const k of p.excludeSections) excluded.add(k);
  for (const k of p.restoreSections) excluded.delete(k);
  const emphasis = new Map(current.emphasis.map((e) => [e.key, e.note]));
  for (const k of p.clearEmphasis) emphasis.delete(k);
  for (const e of p.emphasis) emphasis.set(e.key, e.note);
  // An emphasis note on an excluded section is meaningless — drop it.
  for (const k of Array.from(excluded)) emphasis.delete(k);

  // Broker-added items are simply dropped when removed; checklist/generic
  // items go on the removed list so they can be restored later.
  const brokerAdded = new Set((current.addedItems ?? []).map((i) => i.key));
  const addedItems = (current.addedItems ?? [])
    .filter((i) => !p.removeItems.includes(i.key))
    .concat(
      p.addItems
        .filter((a) => !!a.key && !(current.addedItems ?? []).some((i) => i.key === a.key))
        .map((a) => ({ sectionKey: a.sectionKey, label: a.label, key: a.key as string })),
    );
  const removedItems = new Set(current.removedItems ?? []);
  for (const k of p.removeItems) if (!brokerAdded.has(k)) removedItems.add(k);
  for (const k of p.restoreItems) removedItems.delete(k);
  for (const a of p.addItems) if (a.key) removedItems.delete(a.key);

  const next: InterviewOutline = {
    updatedAt: new Date().toISOString(),
    customTopics,
    excludedSections: Array.from(excluded),
    emphasis: Array.from(emphasis, ([key, note]) => ({ key, note })),
    addedItems,
    removedItems: Array.from(removedItems),
    history: [{ at: new Date().toISOString(), instruction: instruction.trim().slice(0, 500), summary: p.summary }, ...current.history].slice(0, HISTORY_CAP),
  };
  await storage.updateDeal(deal.id, { interviewOutline: next } as any);
  return next;
}

/** Direct edits (no AI): toggle a section, drop a topic, clear a note. */
export async function patchOutline(
  deal: Deal,
  patch: { excludeSection?: string; restoreSection?: string; removeTopic?: string; clearEmphasis?: string; removeItem?: string; restoreItem?: string },
): Promise<{ outline: InterviewOutline; refused?: string }> {
  const critical = criticalSectionKeys(getSectionImportance(deal));
  if (patch.excludeSection && critical.has(patch.excludeSection)) {
    const title = CIM_SECTIONS.find((s) => s.key === patch.excludeSection)?.title ?? patch.excludeSection;
    return { outline: getInterviewOutline(deal), refused: `"${title}" is critical for buyers of this business and stays in every interview.` };
  }
  if (patch.removeItem && UNREMOVABLE_ITEMS.has(patch.removeItem)) {
    return { outline: getInterviewOutline(deal), refused: `"${fieldLabel(patch.removeItem)}" is needed in every CIM and stays on the checklist.` };
  }
  const proposal: OutlineProposal = {
    summary: patch.excludeSection ? "Section removed from the interview."
      : patch.restoreSection ? "Section restored."
      : patch.removeTopic ? "Custom topic removed."
      : patch.removeItem ? "Data point removed from the checklist."
      : patch.restoreItem ? "Data point restored."
      : "Note cleared.",
    addItems: [],
    removeItems: patch.removeItem ? [patch.removeItem] : [],
    restoreItems: patch.restoreItem ? [patch.restoreItem] : [],
    addTopics: [],
    removeTopics: patch.removeTopic ? [patch.removeTopic] : [],
    excludeSections: patch.excludeSection ? [patch.excludeSection] : [],
    restoreSections: patch.restoreSection ? [patch.restoreSection] : [],
    emphasis: [],
    clearEmphasis: patch.clearEmphasis ? [patch.clearEmphasis] : [],
    refused: [],
  };
  return { outline: await applyOutlineProposal(deal, proposal, proposal.summary) };
}

/** Prompt block for the interview agent. Rendered only when the broker changed something. */
export function renderOutlineForPrompt(outline: InterviewOutline): string {
  if (!outlineHasContent(outline)) return "";
  const parts: string[] = ["## BROKER'S INTERVIEW OUTLINE (binding)"];
  if (outline.customTopics.length) {
    parts.push("Topics the broker added — cover every one of these before wrapping up; treat their importance like a CIM section's:");
    for (const t of outline.customTopics) {
      parts.push(`- [${t.importance.toUpperCase()}] ${t.title} (key: ${t.key})${t.description ? ` — ${t.description}` : ""}`);
      for (const c of t.capture) parts.push(`    · capture: ${c}`);
    }
    parts.push("Set targetSection to the topic key when asking about one, and list the topic title in reasoning.industryContext.coveredIndustryTopics once its capture items are answered.");
  }
  if (outline.emphasis.length) {
    parts.push("Broker's notes on standard sections:");
    for (const e of outline.emphasis) {
      const title = CIM_SECTIONS.find((s) => s.key === e.key)?.title ?? e.key;
      parts.push(`- ${title}: ${e.note}`);
    }
  }
  if ((outline.removedItems ?? []).length) {
    parts.push(`Data points the broker removed from the checklist — do NOT ask for them: ${(outline.removedItems ?? []).map((k) => fieldLabel(k)).join("; ")}.`);
  }
  if (outline.excludedSections.length) {
    const titles = outline.excludedSections.map((k) => CIM_SECTIONS.find((s) => s.key === k)?.title ?? k);
    parts.push(`Sections the broker removed from this interview — do NOT ask about them, even briefly: ${titles.join("; ")}.`);
  }
  return parts.join("\n");
}
