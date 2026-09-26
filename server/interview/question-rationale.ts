/**
 * question-rationale — every question the seller sees carries a "Why we ask
 * this" that belongs to it, and the section chip beside it names the section
 * the question actually fills.
 *
 * The interview model writes both, but not reliably: the round-V run shipped
 * 8 question turns with no rationale (the model left it out, or the fit
 * check dropped one written for the previous question) and labelled a
 * direct-billing question, a vehicle-lease question and a real-estate
 * question "asking_price". So after the reply is final:
 *   1. the model's rationale is kept when it fits the question (word check
 *      in turn-guard.whyItMattersFits, no legal rule stated as fact, no
 *      add-back call) and its section when the question's words support it;
 *   2. otherwise the supporting model writes the rationale and/or picks the
 *      section for the question as asked (one short tool-forced call, only on
 *      those turns, bounded by a timeout);
 *   3. if that fails, a plain per-section rationale and the best keyword
 *      section stand in — never an empty "Why we ask this".
 */
import Anthropic from "@anthropic-ai/sdk";
import { agentConfig } from "./config/load-config";
import { whyItMattersFits } from "./turn-guard";
import { findLegalAssertions } from "./fact-guards";
import { assertsNormalisation, mentionsNormalisation } from "./reply-guards";

/** Words that tie a question to a CIM section (interview section keys). */
const SECTION_WORDS: Record<string, RegExp> = {
  overview: /\b(?:histor\w*|founded|found(?:ing)?|started|origin|incorporat\w*|entity|corporate structure|share(?:holder)?s?|ownership (?:structure|history)|brand|reputation|mission|lawsuits?|litigation|claims? against|legal (?:action|proceedings?|disputes?))\b/i,
  strengths: /\b(?:advantage|differentiat\w*|strengths?|competitors?|competition|compete|moat|unique|stand out|set(?:s)? (?:you|it) apart|reputation for)\b/i,
  growth_potential: /\b(?:grow(?:th)?|expan\w*|opportunit\w*|untapped|upside|new (?:markets?|services?|locations?|product lines?)|add(?:ing)? (?:a )?(?:location|service|line)|scale)\b/i,
  target_market: /\b(?:customer (?:base|mix|demographics?|types?|segments?)|market(?:s)?\b|segments?|who (?:buys|are your customers)|b2b|b2c|residential|commercial|referral sources?|patients? (?:come|find)|demographics?)\b/i,
  permits_licenses: /\b(?:licen[cs]\w*|permits?|certif\w*|accredit\w*|registration|regulat\w*|inspection|complian\w*|tickets?|red seal|college|audits?|iso|iatf|bond(?:ing|ed)?|surety|safety (?:record|program)|wcb|wsib|worksafe\w*|environmental|phase (?:i|1|one)|health (?:inspection|department)|insurance (?:coverage|policy|premium|claims?))\b/i,
  seasonality: /\b(?:season\w*|summer|winter|spring|fall|peak|slow (?:months?|periods?|season)|busiest|quiet(?:est)? (?:months?|period)|month[- ]to[- ]month swings?)\b/i,
  revenue_sources: /\b(?:revenue (?:mix|streams?|split|sources?|by)|sales mix|recurring|contracts?|concentration|largest (?:customer|client|account)|top (?:customers|clients|accounts)|pricing|price increases?|rates?|billing|direct[- ]bill\w*|insurers?|payers?|backlog|pipeline|bids?|volumes?|memberships?|renewals?|service agreements?|maintenance plans?|prescriptions?|rx)\b/i,
  real_estate: /\b(?:lease|leases|leased|landlord|rent|building|property|premises|square f(?:ee|oo)t|sq\.? ?ft|facility|real estate|own the (?:building|property|land)|site|zoning)\b/i,
  employees: /\b(?:employees?|staff|team|managers?|management|payroll|wages?|salar(?:y|ies)|hir(?:e|ing)|turnover|retention|technicians?|techs?|associates?|physios?|pharmacists?|union\w*|key (?:people|person|employee)|contractors?|headcount|shifts?|org(?:anization(?:al)?)? chart|succession|who runs)\b/i,
  operations: /\b(?:suppliers?|vendors?|equipment|fleet|trucks?|vehicles?|machines?|machinery|software|systems?|inventory|process(?:es)?|workflow|capacity|maintenance|crm|erp|pos|scheduling|booking|tooling|production|logistics|carriers?)\b/i,
  buyer_profile: /\b(?:ideal buyer|kind of buyer|type of buyer|who (?:should|would|could) buy|buyers? you(?:'d| would) (?:prefer|rule out|sell to)|sell to (?:a )?(?:competitor|strategic|family|employee))\b/i,
  training_support: /\b(?:transition|training|stay on|stick around|handover|hand-?off|after (?:the )?(?:sale|closing)|consult(?:ing)?|non-?compete|introduce (?:the )?(?:buyer|new owner))\b/i,
  reason_for_sale: /\b(?:why (?:are you |you'?re )?sell\w*|reason (?:for|you'?re|you are) sell\w*|retir\w*|next chapter|step(?:ping)? (?:back|away)|exit)\b/i,
  financials: /\b(?:revenue|ebitda|sde|profit\w*|margins?|cash flow|debt|loans?|working capital|receivables?|payables?|capex|capital (?:expenditures?|spending)|taxes|t2|p&l|financial\w*|expenses?|costs?|owner'?s? comp\w*|dividends?|add-?backs?|bank|line of credit|net income|gross)\b/i,
  asking_price: /\b(?:asking price|price (?:expectation|in mind)|valuation|what (?:it'?s|the business is) worth|deal (?:terms|structure)|financing|vendor (?:take-?back|financing)|vtb|earn-?out|asset sale|share sale|stock sale|included in the (?:sale|price|deal)|come with the (?:sale|business)|sell (?:the building|the property|it) (?:with|separately)|down payment)\b/i,
};

/** How strongly the question's words point at each section. */
export function sectionScores(question: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, re] of Object.entries(SECTION_WORDS)) {
    const g = new RegExp(re.source, "gi");
    out[key] = (question.match(g) ?? []).length;
  }
  return out;
}

/** The best-supported section among `keys` (null when nothing points anywhere). */
export function bestSection(question: string, keys: string[]): string | null {
  const scores = sectionScores(question);
  let best: string | null = null;
  let top = 0;
  for (const k of keys) if ((scores[k] ?? 0) > top) { best = k; top = scores[k] ?? 0; }
  return best;
}

/**
 * True when the label isn't a section of this deal, or when nothing in the
 * question points at it while something points at another section ("Do you
 * direct-bill the insurers?" labelled asking_price). A question whose words
 * point nowhere keeps the model's label — no call for it.
 */
export function sectionUnsupported(question: string, section: string | undefined, keys: string[]): boolean {
  if (!section || !keys.includes(section)) return true;
  if (!SECTION_WORDS[section]) return false;
  const scores = sectionScores(question);
  return (scores[section] ?? 0) === 0 && keys.some((k) => k !== section && (scores[k] ?? 0) > 0);
}

/** The plain rationale used when nothing better can be had. */
const FALLBACK_BY_SECTION: Record<string, string> = {
  overview: "Buyers start by understanding what the business is and how it came to be — it frames everything else they read.",
  strengths: "What sets the business apart is what a buyer is really paying for, so they'll want it described in specifics.",
  growth_potential: "Buyers pay for upside they can see a path to — concrete opportunities make that case.",
  target_market: "Buyers judge how durable demand is by who the customers are and how they find you.",
  permits_licenses: "Licences, certifications and inspections that don't transfer cleanly can delay or derail a closing, so buyers check them early.",
  seasonality: "Seasonal swings shape the working capital a buyer needs, so they'll want to know the pattern.",
  revenue_sources: "Buyers look closely at where the revenue comes from and how dependable each source is.",
  real_estate: "Premises terms decide whether a buyer can keep operating where you are, so they're reviewed early.",
  employees: "Buyers want to know the business runs well without the owner — the team is how they judge that.",
  operations: "How the day-to-day runs tells a buyer what they're taking over and what it will take to keep it running.",
  buyer_profile: "Knowing who you'd like to sell to helps your broker reach the right buyers first.",
  training_support: "A clear handover plan reassures buyers that customers and staff will stay through the change.",
  reason_for_sale: "Every buyer asks why the owner is selling — a clear answer removes a common source of doubt.",
  financials: "Buyers and their lenders rely on verified numbers, so each figure needs to be pinned down and explained.",
  asking_price: "Price and terms decide which buyers engage, so your broker needs your expectations early.",
};
const OPEN_QUESTION_RATIONALE =
  "Anything you raise now can be presented on your terms, rather than surfacing later in a buyer's due diligence.";

export function fallbackRationale(section: string | undefined, question: string): string {
  if (/\b(?:anything else|anything (?:about|you)[^?]{0,60}(?:haven'?t|not yet|we missed)|before we wrap)\b/i.test(question)) return OPEN_QUESTION_RATIONALE;
  return (section && FALLBACK_BY_SECTION[section]) || "Buyers will ask about this in due diligence, so a clear answer now saves time and questions later.";
}

const RATIONALE_TOOL = {
  name: "question_label",
  description: "Label one interview question.",
  input_schema: {
    type: "object" as const,
    required: ["targetSection", "whyItMatters"],
    properties: {
      targetSection: { type: "string", description: "The key of the CIM section the answer to this question fills — exactly one key from the list." },
      whyItMatters: { type: "string", description: "One sentence (at most 30 words) telling the business owner why buyers care about the answer to THIS question." },
    },
  },
};

let client: Anthropic | null = null;
/** How long the label call may take (it runs while the turn saves). */
export const RATIONALE_TIMEOUT_MS = 4_500;

export interface RationaleInput {
  /** The final message the seller sees. */
  message: string;
  whyItMatters?: string;
  targetSection?: string;
  prevAiMessage?: string | null;
  /** Section keys → titles, for the deal. */
  sections: Record<string, string>;
  /** "Physiotherapy clinic in Calgary, AB" — keeps the rationale specific. */
  businessLine: string;
  /** The vocabulary note for the business's country, if known. */
  vocabulary?: string;
  timeoutMs?: number;
}
export interface RationaleResult {
  whyItMatters?: string;
  targetSection?: string;
  /** What happened, for logs: kept / model / fallback / none. */
  how: string;
}

/** Validates a rationale for the seller's screen (legal rule as fact, add-back calls, length). */
function usableRationale(text: unknown): text is string {
  if (typeof text !== "string") return false;
  const t = text.trim();
  return t.length >= 20 && t.length <= 320 && !t.includes("?") && findLegalAssertions(t).length === 0 && !assertsNormalisation(t) && !mentionsNormalisation(t);
}

type LabelCall = (input: RationaleInput, need: { rationale: boolean; section: boolean }) => Promise<{ whyItMatters?: string; targetSection?: string } | null>;

const modelLabel: LabelCall = async (input, need) => {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const keys = Object.keys(input.sections);
  const call = client.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 300,
    temperature: 0,
    tools: [RATIONALE_TOOL],
    tool_choice: { type: "tool", name: "question_label" },
    system:
      "An interviewer is helping a business owner prepare the confidential memorandum buyers will read. You label ONE question the interviewer just asked. " +
      "targetSection: the section the ANSWER fills — pick by what the question asks about, not by words it happens to mention. " +
      "whyItMatters: one plain sentence to the owner on why buyers care about this specific answer, for this kind of business. No praise, no figures, no valuation multiples, " +
      "never state a law or regulation as fact, and never say whether an item is added back or how earnings are normalized (don't use the words add-back, SDE or normalize at all). " +
      (input.vocabulary ? `${input.vocabulary} ` : "") +
      "If the candidate rationale already explains THIS question, return it unchanged.",
    messages: [
      {
        role: "user",
        content:
          `BUSINESS: ${input.businessLine}\n\nQUESTION (as the owner sees it): ${input.message}\n\n` +
          `CANDIDATE RATIONALE: ${input.whyItMatters ?? "(none)"}\n` +
          `CANDIDATE SECTION: ${input.targetSection ?? "(none)"}\n\n` +
          `SECTIONS:\n${keys.map((k) => `- ${k}: ${input.sections[k]}`).join("\n")}\n\n` +
          `Needed: ${[need.rationale ? "a rationale for this question" : "", need.section ? "the right section" : ""].filter(Boolean).join(" and ")}.`,
      },
    ],
  });
  call.catch(() => {});
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), input.timeoutMs ?? RATIONALE_TIMEOUT_MS));
  try {
    const res = await Promise.race([call, timeout]);
    if (!res) {
      console.warn("[question-rationale] timed out — using the fallback");
      return null;
    }
    const block = res.content.find((b) => b.type === "tool_use");
    const out = (block && block.type === "tool_use" ? block.input : {}) as { whyItMatters?: unknown; targetSection?: unknown };
    return {
      whyItMatters: typeof out.whyItMatters === "string" ? out.whyItMatters.trim() : undefined,
      targetSection: typeof out.targetSection === "string" ? out.targetSection.trim() : undefined,
    };
  } catch (err: any) {
    console.warn("[question-rationale] failed — using the fallback:", err?.message || err);
    return null;
  }
};

/**
 * The rationale and section for a question turn (see the file comment). A
 * turn that asks nothing gets neither. `label` is injectable for tests.
 */
export async function ensureQuestionRationale(input: RationaleInput, label: LabelCall = modelLabel): Promise<RationaleResult> {
  const keys = Object.keys(input.sections);
  if (!input.message.includes("?")) return { how: "none" };
  const questionText = (input.message.match(/[^.!?\n]*\?/g) ?? []).join(" ") || input.message;
  const rationaleOk =
    usableRationale(input.whyItMatters) && whyItMattersFits(input.message, input.whyItMatters, false, input.prevAiMessage);
  // The section is judged on the question (and the sentence leading into it).
  const sectionOk = !!input.targetSection && keys.includes(input.targetSection) && !sectionUnsupported(input.message, input.targetSection, keys);
  if (rationaleOk && sectionOk) return { whyItMatters: input.whyItMatters!.trim(), targetSection: input.targetSection, how: "kept" };

  const got = await label(input, { rationale: !rationaleOk, section: !sectionOk }).catch(() => null);
  const modelSection = got?.targetSection && keys.includes(got.targetSection) ? got.targetSection : undefined;
  const section = sectionOk ? input.targetSection : modelSection ?? bestSection(input.message, keys) ?? (input.targetSection && keys.includes(input.targetSection) ? input.targetSection : undefined);
  const why = rationaleOk
    ? input.whyItMatters!.trim()
    : usableRationale(got?.whyItMatters)
      ? got!.whyItMatters!.trim()
      : fallbackRationale(section, questionText);
  const how =
    `${rationaleOk ? "kept" : usableRationale(got?.whyItMatters) ? "model" : "fallback"} rationale, ${sectionOk ? "kept" : modelSection ? "model" : "keyword"} section` +
    (!rationaleOk && got?.whyItMatters && !usableRationale(got.whyItMatters) ? ` (refused: "${String(got.whyItMatters).slice(0, 120)}")` : !rationaleOk && !got ? " (no answer from the labeller)" : "");
  return { whyItMatters: why, targetSection: section, how };
}
