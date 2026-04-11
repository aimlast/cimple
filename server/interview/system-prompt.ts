import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type { KnowledgeBase } from "./knowledge-base";
import { renderKnowledgeBaseForPrompt } from "./knowledge-base";
import { getInterviewInsightsForIndustry, renderInsightsForPrompt } from "./learning-loop";

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

// Load all prompt sections once at module load time.
// On local dev, changes to .md files take effect on server restart.
// In production, files are bundled at deploy time.
const ROLE_AND_IDENTITY = loadPrompt("role-identity.md");
const CONVERSATION_RULES = loadPrompt("conversation-rules.md");
const EMOTIONAL_INTELLIGENCE = loadPrompt("emotional-intelligence.md");
const HANDLING_DIFFICULTY = loadPrompt("handling-difficulty.md");
const INDUSTRY_INTELLIGENCE = loadPrompt("industry-intelligence.md");
const BOUNDARIES = loadPrompt("boundaries.md");
const RESPONSE_FORMAT = loadPrompt("response-format.md");

// =====================
// System prompt builder
// =====================

/**
 * Builds the full system prompt for the interview agent.
 * Assembled fresh on every turn so it always reflects the latest knowledge base.
 * The static sections are loaded from .md files in server/interview/prompts/.
 * The dynamic knowledge base context is rendered from the current deal state.
 */
export async function buildInterviewSystemPrompt(kb: KnowledgeBase): Promise<string> {
  const parts: string[] = [
    ROLE_AND_IDENTITY,
    CONVERSATION_RULES,
    EMOTIONAL_INTELLIGENCE,
    HANDLING_DIFFICULTY,
    INDUSTRY_INTELLIGENCE,
    BOUNDARIES,
    RESPONSE_FORMAT,
  ];

  // Inject learned patterns from past interviews in this industry
  try {
    const insights = await getInterviewInsightsForIndustry(kb.business.industry);
    if (insights && insights.sampleCount > 0) {
      parts.push("\n---\n");
      parts.push(renderInsightsForPrompt(insights));
    }
  } catch {
    // Non-critical — continue without insights
  }

  parts.push(
    "\n---\n",
    "# CURRENT KNOWLEDGE BASE",
    "Everything below is what we currently know about this deal. Use it to guide your questions.\n",
    renderKnowledgeBaseForPrompt(kb),
  );

  return parts.join("\n");
}
