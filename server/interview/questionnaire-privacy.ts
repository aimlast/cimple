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

/** Whose matter: the owner, a relative, the writer — never "patients" or "pets". */
const WHOSE = String.raw`(?:my|his|her|owner'?s|founder'?s|seller'?s|wife'?s|husband'?s|spouse'?s|partner'?s|son'?s|daughter'?s|mother'?s|father'?s|mom'?s|dad'?s)`;
/** What a clinic, vet or physio business calls a room, a role or a service line, not a person's operation. */
const NOT_A_PERSON_AFTER = String.raw`(?!\s+(?:room|rooms|suite|suites|table|tables|tech|techs|technician|technicians|assistant|assistants|centre|center|department|wing|theat(?:re|er)|schedule|volume|volumes|revenue|capacity|equipment|count|counts|fees?|codes?|mix|services?|program|programs|lead|leads|team|patients?|cases?|days?))`;

/**
 * Personal matters that never belong in a sales document: health, family
 * and marital circumstances, bereavement, personal money trouble. Worded
 * around a PERSON — the owner, a relative, "I" — because clinical words are
 * business vocabulary for a dental, vet, physio or medical practice ("Sam
 * Ortiz — Surgery technician", "Rehab and hydrotherapy lead", "fund a second
 * surgery room", "dementia care", "two-stroke engines", "health inspection"
 * don't match).
 */
export const PRIVATE_MATTER_RE = new RegExp(
  [
    String.raw`\bheart (?:attack|procedure|surgery|condition|issues?|problems?|event|episode|scare)`,
    String.raw`\bcardiac (?:event|episode|arrest|issues?|condition|problems?|scare|surgery|procedure)\b`,
    String.raw`\bstents?\b`, String.raw`\bbypass surgery\b`,
    // "had / needs / is recovering from (a / his / back) surgery", "my surgery" — not "a second surgery room".
    String.raw`\b(?:had|has had|having|underwent|undergoing|undergo|needs?|needed|recover(?:ing|ed)? from|scheduled for|awaiting|booked for)\s+(?:(?:a|an|my|his|her|major|minor|emergency|back|knee|hip|heart|open-heart|shoulder|spinal|brain|cancer|another|second|more|further)\s+){0,3}surger(?:y|ies)\b${NOT_A_PERSON_AFTER}`,
    String.raw`\b${WHOSE}\s+(?:\w+\s+)?surger(?:y|ies)\b${NOT_A_PERSON_AFTER}`,
    String.raw`\b(?:has|had|have|with|battling|fighting|beat|survived|surviving|treatment for|diagnosed with|recover(?:ing|ed)? from)\s+(?:\w+\s+)?cancer\b`,
    String.raw`\bcancer (?:diagnosis|scare|survivor)\b`, String.raw`\b${WHOSE}\s+(?:\w+\s+)?(?:cancer|tumou?r)\b`,
    String.raw`\b(?:on|started|starting|finished|finishing|undergoing|doing|through|during)\s+chemo(?:therapy)?\b`,
    String.raw`\b(?:i|he|she|i'?m|i'?ve|i was|he was|she was|was|got|been|recently)\s+(?:recently\s+)?diagnosed\b`, String.raw`\b${WHOSE}\s+diagnosis\b`,
    String.raw`\b${WHOSE}\s+(?:\w+\s+)?illness\b`, String.raw`\b(?:fell|became|been|got|is|was)\s+(?:seriously\s+|very\s+)?ill\b`, String.raw`\bterminal(?:ly)? ill\b`,
    String.raw`\b(?:had|suffered|has had|survived|recovering from|recovered from|after)\s+(?:a\s+|his\s+|her\s+|my\s+)?(?:minor\s+|major\s+|mild\s+|small\s+)?stroke\b`, String.raw`\b${WHOSE}\s+stroke\b`,
    String.raw`\b(?:has|had|early[- ]onset|diagnosed with|${WHOSE}\s+(?:\w+\s+)?)(?:dementia|alzheimer'?s?|parkinson'?s?)\b`,
    String.raw`\b${WHOSE}\s+mental health\b`, String.raw`\b(?:${WHOSE}\s+|with\s+|battling\s+|suffer(?:s|ed|ing)?\s+(?:from\s+)?)depression\b`,
    String.raw`\b${WHOSE}\s+burn-?out\b`, String.raw`\b(?:i'?m|i am|feeling|felt|he'?s|she'?s)\s+(?:\w+\s+)?burn(?:ed|t)[- ]?out\b`,
    String.raw`\baddiction\b`, String.raw`\b(?:went|gone|going|checked|go)\s+(?:in)?to rehab\b`, String.raw`\bentered rehab\b`, String.raw`\b(?:drug|alcohol)\s+rehab\b`,
    String.raw`\b(?:i'?m|i am|she'?s|she is|wife is|partner is|daughter is)\s+(?:\w+\s+)?pregnant\b`,
    String.raw`\bdivorc`, String.raw`\bmarital\b`, String.raw`\bseparat(?:ed|ion) from\b`, String.raw`\bwidow`,
    String.raw`\bpassed away\b`, String.raw`\bbereave`,
    String.raw`\bchild custody\b`, String.raw`\bcustody (?:battle|dispute|fight|hearing|arrangement|case)\b`, String.raw`\bcustody of (?:my|his|her|our|the) (?:kids|children|son|daughter|grandchildren)\b`,
    String.raw`\bpersonal bankruptcy\b`,
    String.raw`\bhealth (?:issues?|scare|event|problems?|concerns?|reasons?|condition|challenges?|crisis)\b`,
    String.raw`\b(?:his|her|my|owner'?s|founder'?s|seller'?s|wife'?s|husband'?s|spouse'?s|partner'?s) health\b`,
    String.raw`\bmedical (?:reasons?|leave|condition|issues?)\b`, String.raw`\b${WHOSE}\s+medical (?:procedure|treatment)\b`,
    String.raw`\bdoctor'?s? (?:advice|orders|advised|told)\b`,
    String.raw`\b(?:19|20)\d{2} (?:medical |cardiac )?procedure\b(?!\s+(?:count|counts|volume|volumes|mix|codes?|fees?|revenue))`,
  ].join("|"),
  "i",
);

/**
 * A named person's health ("Dave's health", "Maria's surgery") — case
 * sensitive: a capitalised name, not "the company's health".
 */
const NAMED_PERSON_HEALTH_RE =
  /\b(?!(?:Company|Business|Clinic|Practice|Firm|Store|Shop|Plant|Industry|Market|Economy|Hospital|Patient|Client|Customer)['’]s)[A-Z][a-z]+['’]s (?:\w+ )?(?:health|surger(?:y|ies)|illness|stroke|diagnosis|cancer|medical|recovery)\b/;

/**
 * Wording that is usually a person's health but can be a clinical service
 * line ("two-disc back surgery spring 2023" vs "we specialise in knee
 * surgery"). Used only where no model has judged the answer (the keyword
 * split, when the model is unavailable) — never to overrule the model.
 */
const LIKELY_PRIVATE_RE =
  /\b(?:back|knee|hip|heart|shoulder|spinal|spine|disc|two-disc|neck|brain|eye|cataract|open-heart|cardiac|bypass)\s+surger(?:y|ies)\b|\bsurger(?:y|ies)\s+(?:in\s+|last\s+|this\s+|early\s+|late\s+)?(?:spring|summer|fall|autumn|winter|january|february|march|april|may|june|july|august|september|october|november|december|(?:19|20)\d{2})\b/i;

/** An unambiguous personal matter — strong enough to overrule the model's split. */
export function mentionsPrivateMatter(text: string): boolean {
  return PRIVATE_MATTER_RE.test(text) || NAMED_PERSON_HEALTH_RE.test(text);
}

/** A personal matter or wording that usually is one — the fail-safe test when no model has read the answer. */
export function mayMentionPrivateMatter(text: string): boolean {
  return mentionsPrivateMatter(text) || LIKELY_PRIVATE_RE.test(text);
}

export function answerHash(value: string): string {
  return createHash("sha256").update(value.trim().replace(/\s+/g, " ")).digest("hex").slice(0, 24);
}

/** True when an intake answer must be split before it becomes a fact. */
export function needsScreen(key: string, value: string): boolean {
  if (SENSITIVE_KEYS.has(key)) return true;
  if (value.trim().split(/\s+/).length > FREE_TEXT_WORDS) return true;
  return mayMentionPrivateMatter(value);
}

export function getQuestionnaireScreen(info: Record<string, unknown>): QuestionnaireScreen {
  const raw = info[QUESTIONNAIRE_SCREEN_KEY];
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as QuestionnaireScreen) : {};
}

/**
 * Sentences, semicolon clauses, lines and ", and …" / ", but …" clauses of
 * an answer — never split inside parentheses ("Dave's health (two-disc back
 * surgery spring 2023; can no longer run the loader) and retirement" is one
 * clause).
 */
function clausesOf(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    const rest = value.slice(i);
    const breakHere =
      depth === 0 &&
      (ch === ";" || ch === "\n" || (/[.!?]/.test(ch) && /^[.!?]\s/.test(rest)) || /^,\s+(?:and|but|plus|also|so)\s/i.test(rest));
    if (breakHere) {
      if (/[.!?]/.test(ch)) cur += ch;
      out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out
    .map((c) => c.replace(/^[,\s]*(?:and|but|plus|also|so)\s+/i, "").trim())
    .filter(Boolean);
}

/**
 * The deterministic split, used when the model is unavailable or its split
 * can't be trusted: a clause naming a personal matter goes to the private
 * notes, the rest of the answer stays the fact ("Retiring after 30 years,
 * and my wife was diagnosed with cancer" → "Retiring after 30 years" +
 * note). An answer naming none is kept whole.
 */
export function keywordSplit(value: string): Pick<QuestionnaireScreenEntry, "publicValue" | "privateNotes" | "method"> {
  const whole = value.trim();
  if (!mayMentionPrivateMatter(whole)) return { publicValue: whole, privateNotes: [], method: "keyword" };
  const clauses = clausesOf(whole);
  const priv = clauses.filter((c) => mayMentionPrivateMatter(c));
  const pub = clauses.filter((c) => !mayMentionPrivateMatter(c));
  // The match spans a clause break (or nothing splits): the whole answer is private.
  if (priv.length === 0) return { publicValue: null, privateNotes: [whole], method: "keyword" };
  const publicValue = pub.map((c) => c.replace(/[.!?]+$/, "").replace(/^[a-z]/, (x) => x.toUpperCase())).join(". ").trim();
  return { publicValue: publicValue || null, privateNotes: priv, method: "keyword" };
}

/** Figures in a text, normalised ("$1,200,000" → "1200000", "2009", "15%" → "15"). */
function figuresIn(text: string): string[] {
  return Array.from(text.matchAll(/\d[\d,]*(?:\.\d+)?/g)).map((m) => m[0].replace(/,/g, "").replace(/\.0+$/, ""));
}

/**
 * True when every figure in `publicValue` — a year, an age, an amount, a
 * count — is in the seller's own answer. The split prompt sees all intake
 * answers at once, and the model once wrote "running the business since
 * 2009" into the reason for sale, borrowing the incorporation year from
 * another answer (the business started in 2006).
 */
export function figuresFaithful(publicValue: string, answer: string): boolean {
  const said = new Set(figuresIn(answer));
  return figuresIn(publicValue).every((f) => said.has(f));
}

/**
 * A model split, checked: a publicValue that still names a private matter or
 * states a figure the answer doesn't is not used (the deterministic split
 * decides instead, keeping the model's notes); an answer the backstop flags
 * although the model found nothing private is split by the backstop too; and
 * empty notes are dropped.
 */
export function checkedSplit(value: string, split: { publicValue?: unknown; privateNotes?: unknown }): Pick<QuestionnaireScreenEntry, "publicValue" | "privateNotes" | "method"> {
  const pub = typeof split.publicValue === "string" ? split.publicValue.trim() : "";
  const notes = Array.isArray(split.privateNotes)
    ? split.privateNotes.map((n) => String(n ?? "").trim()).filter(Boolean).slice(0, 5)
    : [];
  const untrusted = (!!pub && (mentionsPrivateMatter(pub) || !figuresFaithful(pub, value))) || (notes.length === 0 && mentionsPrivateMatter(value));
  if (untrusted) {
    const k = keywordSplit(value);
    return { ...k, privateNotes: Array.from(new Set([...notes, ...k.privateNotes])) };
  }
  return { publicValue: pub || null, privateNotes: notes, method: "model" };
}

/** A model split on file that still passes today's checks (an older one may predate them). */
export function splitStillValid(answer: string, entry: QuestionnaireScreenEntry): boolean {
  if (entry.method !== "model") return true;
  return checkedSplit(answer, entry).method === "model";
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
  "Treat each answer on its own: its publicValue uses only that answer's words — never a fact, name, year or figure from another answer.",
  "Clinical words are business vocabulary for a dental, veterinary, physiotherapy or medical practice (a surgery technician, a rehab lead, a surgery suite, dementia care): only a person's own health is private.",
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
    .filter(([key, value]) => needsScreen(key, value) && (screen[key]?.hash !== answerHash(value) || !splitStillValid(value, screen[key])))
    .map(([key, value]) => ({ key, value }));
}

/**
 * Model splits for the deal's intake answers that don't have one yet, ready
 * to be cached by seedExtractedInfoFromQuestionnaire (checked: see
 * checkedSplit). Empty when there is nothing to split or the model is
 * unavailable (then the keyword backstop applies, and the next seeding
 * tries the model again).
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
    // A model split that failed its checks is cached as the keyword split it
    // fell back to — the model is not asked again for the same wording.
    if (s) out[key] = { hash: answerHash(value), ...s, at };
  }
  return out;
}
