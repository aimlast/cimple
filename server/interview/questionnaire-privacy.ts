/**
 * Intake answers, split into what may become a CIM fact and what is private.
 *
 * The seller types free text in the intake questionnaire ("Retiring after my
 * 2024 heart procedure; my son would rather partner than carry the
 * guarantees"). Seeding copied such answers straight into extractedInfo as
 * facts, so the health detail reached the buyer-facing CIM. Every answer
 * that could carry a personal matter — reason for sale, transition, the
 * owner's role, anything longer than a phrase — is now split by the
 * supporting model (tool-forced JSON) into:
 *   - publicValue: the business facts, literally true and neutral ("Owner
 *     retiring after 34 years; the next generation prefers to partner with
 *     a larger platform") — this becomes the fact;
 *   - privateNotes: the personal detail ("Owner had a heart procedure in
 *     2024") — these join the broker-private notes (never in a CIM).
 * A deterministic keyword backstop (PRIVATE_MATTER_RE) guards both sides:
 * when the model is unavailable, an answer that names a health, family or
 * personal-finance matter goes to the private notes whole; and a publicValue
 * the model returned that still names one is not used.
 *
 * Results are cached on the deal (`_questionnaireScreen`, keyed by field,
 * with a hash of the answer — never the answer itself) so the model runs
 * once per answer, not on every intake autosave or interview start.
 */
import { createHash } from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { agentConfig } from "./config/load-config";
import { questionnaireFacts } from "./questionnaire-facts";
import {
  getFieldSources,
  getFieldAlternates,
  isUntrackedSource,
  FIELD_SOURCES_KEY,
  FIELD_ALTERNATES_KEY,
} from "./info-merger";

export const QUESTIONNAIRE_SCREEN_KEY = "_questionnaireScreen";

/** How one intake answer was split. */
export interface QuestionnaireScreenEntry {
  /** Hash of the answer this split belongs to (a changed answer is split again). */
  hash: string;
  /** The fact to record — null when nothing in the answer is safe to show buyers. */
  publicValue: string | null;
  privateNotes: string[];
  method: "model" | "keyword";
  at: string;
}

export type QuestionnaireScreen = Record<string, QuestionnaireScreenEntry>;

/** Answers that typically carry personal context — always screened. */
const SENSITIVE_KEYS = new Set([
  "reasonForSale", "transitionPlan", "trainingSupport", "ownerInvolvement", "ownerRole", "idealBuyer",
  "managementTeam", "keyEmployees", "employeeStructure", "sellerGoals", "timeline", "additionalNotes", "notes",
]);

/** Longer than a phrase: free text that could say anything. */
const FREE_TEXT_WORDS = 12;

/**
 * Personal matters that never belong in a sales document: health, family
 * and marital circumstances, bereavement, personal money trouble. Worded
 * to avoid business vocabulary ("healthcare", "medical clinic", "health
 * inspection" don't match).
 */
export const PRIVATE_MATTER_RE = new RegExp(
  [
    String.raw`\bheart (?:attack|procedure|surgery|condition|issues?|problems?|event|episode|scare)`,
    String.raw`\bcardiac\b`, String.raw`\bstents?\b`, String.raw`\bbypass surgery\b`, String.raw`\bsurger(?:y|ies)\b`,
    String.raw`\bcancer\b`, String.raw`\btumou?rs?\b`, String.raw`\bchemo(?:therapy)?\b`, String.raw`\bdiagnos(?:is|ed)\b`,
    String.raw`\billness\b`, String.raw`\bterminal(?:ly)? ill\b`, String.raw`\bstroke\b`, String.raw`\bdementia\b`,
    String.raw`\balzheimer`, String.raw`\bparkinson`, String.raw`\bmental health\b`, String.raw`\bdepression\b`,
    String.raw`\bburn-?out\b`, String.raw`\baddiction\b`, String.raw`\brehab\b`, String.raw`\bpregnan`,
    String.raw`\bdivorc`, String.raw`\bmarital\b`, String.raw`\bseparat(?:ed|ion) from\b`, String.raw`\bwidow`,
    String.raw`\bpassed away\b`, String.raw`\bbereave`, String.raw`\bcustody\b`, String.raw`\bpersonal bankruptcy\b`,
    String.raw`\bhealth (?:issues?|scare|event|problems?|concerns?|reasons?|condition|challenges?|crisis)\b`,
    String.raw`\b(?:his|her|my|their|owner'?s|founder'?s|wife'?s|husband'?s|spouse'?s|partner'?s) health\b`,
    String.raw`\bmedical (?:reasons?|leave|condition|issues?|procedure|treatment)\b`,
    String.raw`\bdoctor'?s? (?:advice|orders|advised|told)\b`, String.raw`\b(?:19|20)\d{2} (?:medical |cardiac )?procedure\b`,
  ].join("|"),
  "i",
);

export function mentionsPrivateMatter(text: string): boolean {
  return PRIVATE_MATTER_RE.test(text);
}

export function answerHash(value: string): string {
  return createHash("sha256").update(value.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 24);
}

/** True when an intake answer must be split before it becomes a fact. */
export function needsScreen(key: string, value: string): boolean {
  if (SENSITIVE_KEYS.has(key)) return true;
  if (value.trim().split(/\s+/).length > FREE_TEXT_WORDS) return true;
  return mentionsPrivateMatter(value);
}

export function getQuestionnaireScreen(info: Record<string, unknown>): QuestionnaireScreen {
  const raw = info[QUESTIONNAIRE_SCREEN_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as QuestionnaireScreen) : {};
}

/** The deterministic split, used when the model is unavailable. */
export function keywordSplit(value: string): Pick<QuestionnaireScreenEntry, "publicValue" | "privateNotes" | "method"> {
  return mentionsPrivateMatter(value)
    ? { publicValue: null, privateNotes: [value.trim()], method: "keyword" }
    : { publicValue: value.trim(), privateNotes: [], method: "keyword" };
}

/**
 * A model split, checked: a publicValue that still names a private matter is
 * not used (the whole answer goes private), and empty notes are dropped.
 */
export function checkedSplit(value: string, split: { publicValue?: unknown; privateNotes?: unknown }): Pick<QuestionnaireScreenEntry, "publicValue" | "privateNotes" | "method"> {
  const pub = typeof split.publicValue === "string" ? split.publicValue.trim() : "";
  const notes = Array.isArray(split.privateNotes)
    ? split.privateNotes.map((n) => String(n ?? "").trim()).filter(Boolean).slice(0, 5)
    : [];
  if (pub && mentionsPrivateMatter(pub)) return { publicValue: null, privateNotes: [value.trim()], method: "keyword" };
  // The model found nothing private in an answer the backstop flags: trust the backstop.
  if (notes.length === 0 && mentionsPrivateMatter(value)) return keywordSplit(value);
  return { publicValue: pub || null, privateNotes: notes, method: "model" };
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 45_000 });

const SPLIT_TOOL = {
  name: "privacy_split",
  description: "For each intake answer, give the part that may appear in a sales document and the private detail.",
  input_schema: {
    type: "object" as const,
    required: ["answers"],
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "publicValue", "privateNotes"],
          properties: {
            key: { type: "string" },
            publicValue: {
              type: "string",
              description: "The answer's business content, literally true, in the seller's own facts and a neutral tone. Empty string when nothing in it may be shown to buyers.",
            },
            privateNotes: {
              type: "array",
              items: { type: "string" },
              description: "Each personal detail as one short factual note for the broker (e.g. 'Owner had a heart procedure in 2024'). Empty when there is none.",
            },
          },
        },
      },
    },
  },
};

const SPLIT_SYSTEM = [
  "You screen a business seller's intake answers before they become facts in a Confidential Information Memorandum that buyers read.",
  "PRIVATE (goes only in privateNotes, never in publicValue): health and medical matters of the owner, family or staff; family, marital and relationship circumstances; bereavement; personal money trouble outside the company; the seller's bottom-line price or other negotiation positions; anything the seller marks private.",
  "PUBLIC (stays in publicValue): every business fact — retirement, years in business, who will stay and for how long, succession, transition support, ownership percentages, company structure, guarantees of company debt, related-party property, growth plans.",
  "publicValue must stay literally true: remove the private detail, never replace it with an invented reason (write 'Owner retiring after 34 years', never 'pursuing new opportunities'). Keep the seller's facts and figures; don't add any. If an answer has no private detail, return it unchanged as publicValue with no notes.",
].join(" ");

/**
 * Splits the given intake answers with the supporting model. Returns null when
 * the call fails (the caller then uses the keyword backstop and retries later).
 */
export async function splitAnswersWithModel(
  answers: Array<{ key: string; value: string }>,
): Promise<Record<string, Pick<QuestionnaireScreenEntry, "publicValue" | "privateNotes" | "method">> | null> {
  if (answers.length === 0) return {};
  try {
    const response = await anthropic.messages.create({
      model: agentConfig.models.supportingAgents,
      max_tokens: 2500,
      temperature: 0,
      system: SPLIT_SYSTEM,
      tools: [SPLIT_TOOL],
      tool_choice: { type: "tool", name: SPLIT_TOOL.name },
      messages: [{
        role: "user",
        content: `Intake answers (field: answer):\n${answers.map((a) => `- ${a.key}: ${a.value.slice(0, 2000)}`).join("\n")}`,
      }],
    });
    const block = response.content.find((b) => b.type === "tool_use");
    const out = ((block && block.type === "tool_use" ? block.input : {}) as { answers?: Array<{ key?: string; publicValue?: unknown; privateNotes?: unknown }> }).answers ?? [];
    const result: Record<string, Pick<QuestionnaireScreenEntry, "publicValue" | "privateNotes" | "method">> = {};
    for (const a of answers) {
      const got = out.find((o) => o && o.key === a.key);
      // An answer the model skipped falls back to the backstop.
      result[a.key] = got ? checkedSplit(a.value, got) : keywordSplit(a.value);
    }
    return result;
  } catch (err) {
    console.warn("[questionnaire-privacy] split failed; using the keyword backstop:", (err as Error).message);
    return null;
  }
}

/**
 * Removes an intake answer stored before it was screened (mutates): the fact
 * itself when it still holds the raw answer from the questionnaire (or from
 * before sources were tracked), and any "other value" entry holding it.
 * Returns true when anything changed.
 */
export function scrubUnscreenedAnswer(info: Record<string, unknown>, key: string, answer: string): boolean {
  const raw = answer.trim();
  let changed = false;
  const cur = info[key];
  const src = getFieldSources(info)[key];
  if (typeof cur === "string" && cur.trim() === raw && (!src || src.source === "questionnaire" || isUntrackedSource(src))) {
    delete info[key];
    const sources = { ...getFieldSources(info) };
    delete sources[key];
    info[FIELD_SOURCES_KEY] = sources;
    changed = true;
  }
  const alts = getFieldAlternates(info);
  if (Array.isArray(alts[key]) && alts[key].some((a) => String(a?.value ?? "").trim() === raw)) {
    const next = { ...alts };
    const kept = alts[key].filter((a) => String(a?.value ?? "").trim() !== raw);
    if (kept.length > 0) next[key] = kept;
    else delete next[key];
    info[FIELD_ALTERNATES_KEY] = next;
    changed = true;
  }
  return changed;
}

type IntakeDeal = { questionnaireData?: unknown; operationalSystems?: unknown; employeeChart?: unknown; extractedInfo: unknown };

/** Intake answers that need a split and have no model split on file for their current wording. */
export function unscreenedAnswers(deal: IntakeDeal): Array<{ key: string; value: string }> {
  const screen = getQuestionnaireScreen((deal.extractedInfo || {}) as Record<string, unknown>);
  return questionnaireFacts(deal)
    .filter(([key, value]) => needsScreen(key, value) && screen[key]?.hash !== answerHash(value))
    .map(([key, value]) => ({ key, value }));
}

/**
 * Model splits for the deal's intake answers that don't have one yet, ready
 * to be cached by seedExtractedInfoFromQuestionnaire. Empty when there is
 * nothing to split or the model is unavailable (then the keyword backstop
 * applies, and the next seeding tries the model again).
 */
export async function screenQuestionnaireAnswers(deal: IntakeDeal): Promise<QuestionnaireScreen> {
  const pending = unscreenedAnswers(deal);
  if (pending.length === 0) return {};
  const split = await splitAnswersWithModel(pending);
  if (!split) return {};
  const at = new Date().toISOString();
  const out: QuestionnaireScreen = {};
  for (const { key, value } of pending) {
    const s = split[key];
    if (s && s.method === "model") out[key] = { hash: answerHash(value), ...s, at };
  }
  return out;
}
