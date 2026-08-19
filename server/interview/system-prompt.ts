import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { KnowledgeBase } from "./knowledge-base";
import { renderKnowledgeBaseForPrompt } from "./knowledge-base";
import { getInterviewInsightsForIndustry, renderInsightsForPrompt } from "./learning-loop";
import { buildIndustryKnowledge, matchIndustrySection } from "./industry-loader";

// Resolve paths relative to this file (works in both CJS and ESM/esbuild)
const __dir = typeof __dirname !== "undefined"
  ? __dirname
  : dirname(fileURLToPath(import.meta.url));

const PROMPTS_DIR = join(__dir, "prompts");

// =====================
// Prompt file loader
// =====================

function loadPrompt(filename: string): string {
  try {
    return readFileSync(join(PROMPTS_DIR, filename), "utf-8").trim();
  } catch {
    throw new Error(`Failed to load prompt file: ${filename}. Make sure server/interview/prompts/${filename} exists.`);
  }
}

// Load the static prompt sections once at module load time.
// On local dev, changes to .md files take effect on server restart.
// In production, files are bundled at deploy time.
// NOTE: industry-intelligence.md is NOT loaded whole here — it is sliced to the
// deal's industry at build time via industry-loader (see buildIndustryKnowledge).
const ROLE_AND_IDENTITY = loadPrompt("role-identity.md");
const CONVERSATION_RULES = loadPrompt("conversation-rules.md");
const EMOTIONAL_INTELLIGENCE = loadPrompt("emotional-intelligence.md");
const HANDLING_DIFFICULTY = loadPrompt("handling-difficulty.md");
const BOUNDARIES = loadPrompt("boundaries.md");
const RESPONSE_FORMAT = loadPrompt("response-format.md");

// =====================
// System prompt builder
// =====================

/**
 * A system content block in the Anthropic messages format. Marking a block with
 * cache_control caches the prompt prefix up to and including that block.
 */
export type SystemBlock = {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
};

/**
 * Builds the interview agent's system prompt as two content blocks:
 *
 *  1. A STATIC block — role, rules, EQ, difficulty handling, the sliced
 *     industry playbook for THIS deal, boundaries, and response format. This is
 *     byte-identical across every turn of the same interview, so it is marked
 *     with cache_control and served from Anthropic's prompt cache after turn 1
 *     (large latency + cost win, since the prefix is the bulk of the tokens).
 *
 *  2. A DYNAMIC block — learned cross-interview insights and the current
 *     knowledge base, which change every turn and so must not be cached.
 *
 * Only the deal's industry section is included (via industry-loader), not the
 * whole 62K-token corpus — this is the single biggest lever on interview
 * quality: the relevant intelligence is no longer drowned out.
 */
export async function buildInterviewSystemBlocks(kb: KnowledgeBase): Promise<SystemBlock[]> {
  // Prefer the IDENTIFIED industry over the deal's label: a deal created as
  // generic "Consulting" whose interview reveals construction-safety work
  // must get the specific playbook, not the generic one. This busts the
  // prompt cache once, on the turn identification lands — correct trade.
  // ...but only when the identified free-text label actually resolves to a
  // playbook section — otherwise a model-phrased label ("Beauty services")
  // would silently downgrade a deal whose broker label ("Salon & spa")
  // matched, losing the industry intelligence entirely.
  const identified = kb.industryContext?.industry ? kb.industryContext : null;
  const identifiedResolves =
    identified && matchIndustrySection(identified.industry, identified.subIndustry) !== null;
  const industryKnowledge = identifiedResolves
    ? buildIndustryKnowledge(identified!.industry, identified!.subIndustry)
    : buildIndustryKnowledge(kb.business.industry, kb.business.subIndustry);

  const staticPrefix = [
    ROLE_AND_IDENTITY,
    CONVERSATION_RULES,
    EMOTIONAL_INTELLIGENCE,
    HANDLING_DIFFICULTY,
    industryKnowledge,
    BOUNDARIES,
    RESPONSE_FORMAT,
  ].join("\n\n");

  const dynamicParts: string[] = [];

  // Today's date — MUST stay in the dynamic block (it changes daily; baking it
  // into the cached prefix would both bust the cache at midnight and, worse,
  // let a stale anchor write wrong years into the knowledge base when the
  // model resolves "last year" / "three years ago").
  const today = new Date().toISOString().slice(0, 10);
  dynamicParts.push(
    `# TODAY'S DATE: ${today}`,
    `Resolve every relative date the seller gives ("last year", "three years ago", "since COVID") against this date — never against your training data's sense of "now" — and capture resolved years with confidence "approximate" unless the seller states the year explicitly.`,
    "\n---\n",
  );

  // Learned patterns from past interviews in this industry (may change between
  // interviews, so kept out of the cached prefix).
  try {
    const insights = await getInterviewInsightsForIndustry(kb.business.industry);
    if (insights && insights.sampleCount > 0) {
      dynamicParts.push(renderInsightsForPrompt(insights));
      dynamicParts.push("\n---\n");
    }
  } catch {
    // Non-critical — continue without insights
  }

  // Broker-routed discrepancies get a top-level directive so the agent treats
  // them as mandatory coverage, not optional context (details render inside
  // the knowledge base section below).
  const askSellerCount = (kb.askSellerDiscrepancies ?? []).length;
  if (askSellerCount > 0) {
    dynamicParts.push(
      `# MANDATORY THIS SESSION: ${askSellerCount} broker-flagged discrepanc${askSellerCount === 1 ? "y" : "ies"}`,
      `The broker routed specific data conflicts to this interview (see "PRIORITY: DISCREPANCIES" in the knowledge base below). Work each one into the conversation naturally and capture the seller's clarification before wrapping up.`,
      "\n---\n",
    );
  }

  dynamicParts.push(
    "# CURRENT KNOWLEDGE BASE",
    "Everything below is what we currently know about this deal. Use it to guide your questions.\n",
    renderKnowledgeBaseForPrompt(kb),
  );

  return [
    { type: "text", text: staticPrefix, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamicParts.join("\n") },
  ];
}

/**
 * String form of the system prompt, for callers (tests, diagnostics) that want
 * a single string rather than the cached content-block array.
 */
export async function buildInterviewSystemPrompt(kb: KnowledgeBase): Promise<string> {
  const blocks = await buildInterviewSystemBlocks(kb);
  return blocks.map((b) => b.text).join("\n");
}
