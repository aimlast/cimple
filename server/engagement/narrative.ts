/**
 * The optional AI brief on one buyer ("Summarise this buyer"): a few plain
 * sentences a broker reads before calling — what the buyer focused on, what
 * they may want to discuss, and an opening line. Broker-triggered only
 * (POST …/engagement/buyers/:accessId/brief), cached per buyer and reading
 * state, so it costs about a cent and only when asked.
 *
 * Grounding: the model sees ONLY the deterministic facts (insights.ts —
 * status, signals with their evidence in seconds/pages, talking points, the
 * pages they read, their questions). It invents nothing and never grades.
 *
 * Blind safety: a buyer on a blind (teaser/full) CIM doesn't know who the
 * business is, and a broker may paste this into a note or an email to them.
 * So for a blind buyer the model is given the codename and the page titles
 * AS THAT BUYER SAW THEM (never the real titles or name), and the text must
 * pass shared/blind-guard.ts; if it doesn't, a deterministic summary built
 * from the same blind-safe facts is used instead (and checked the same way).
 *
 * The Anthropic client is injectable (setBriefClient) so tests never call
 * the API.
 */
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  formatReadingTime,
  viewerPageKey,
  READ_LABEL_TEXT,
  type BuyerBriefResponse,
  type DealReadingFacts,
  type FactPage,
} from "@shared/analytics-v2";
import { blindLeakTerms, findBlindLeaks } from "@shared/blind-guard";
import { agentConfig } from "../interview/config/load-config";
import { buyerInsight, whenText } from "./insights";

/** The slice of the Anthropic client the brief uses. */
export interface BriefClient {
  messages: { create(args: any): Promise<{ content: Array<{ type: string; input?: unknown; text?: string }> }> };
}

export class BriefUnavailableError extends Error {}
export class BriefNothingToSayError extends Error {}

let override: BriefClient | null = null;
let real: BriefClient | null = null;

/** Tests inject a stub (null restores the real client). */
export function setBriefClient(client: BriefClient | null): void {
  override = client;
}

function client(): BriefClient {
  if (override) return override;
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (!key || key === "disabled" || key === "unused") throw new BriefUnavailableError("AI is not configured");
  real ??= new Anthropic({ apiKey: key }) as unknown as BriefClient;
  return real;
}

export interface BriefDeal {
  id: string;
  businessName: string;
  blindCodename?: string | null;
  industry?: string | null;
  subIndustry?: string | null;
  extractedInfo?: unknown;
  employeeChart?: unknown;
}

const BRIEF_TOOL = {
  name: "buyer_brief",
  description: "A short pre-call brief on one buyer, for the broker.",
  input_schema: {
    type: "object" as const,
    required: ["brief"],
    properties: {
      brief: {
        type: "string",
        description: "3–5 short sentences of plain English, no bullet points, no headings. What the buyer focused on (with the reading times given), what they may want to discuss, and one suggested opening line for the call.",
      },
    },
  },
};

const CACHE_MAX = 300;
const CACHE_TTL_MS = 7 * 86_400_000;
const cache = new Map<string, { text: string; generatedAt: string; at: number }>();

/** Clear the cache (tests). */
export function clearBriefCache(): void {
  cache.clear();
}

/** The page list as this buyer saw it: blind buyers get the served (redacted) titles. */
function pagesAsSeen(pages: FactPage[], blind: boolean): FactPage[] {
  return blind ? pages.map((p) => ({ ...p, title: p.servedTitle || p.title, servedTitle: null })) : pages;
}

/** The facts the model is given — nothing else. Deterministic text, also the cache key. */
export function briefFacts(deal: BriefDeal, facts: DealReadingFacts, accessId: string): { text: string; blind: boolean; dealName: string; fallback: string } | null {
  const buyer = facts.buyers.find((b) => b.accessId === accessId);
  if (!buyer || buyer.visits.length === 0) return null;
  const blind = buyer.mode === "blind";
  const now = new Date(facts.now);
  const pages = pagesAsSeen(facts.pages, blind);
  const insight = buyerInsight(buyer, { now, pages, buyers: facts.buyers });
  const dealName = blind ? (deal.blindCodename || "the business") : deal.businessName;
  const read = pages
    .map((p) => ({ p, r: buyer.pages[viewerPageKey(p.pageId, p.part)] }))
    .filter((x) => x.r && x.r.attentionMs >= 3_000)
    .sort((a, b) => b.r!.attentionMs - a.r!.attentionMs)
    .slice(0, 8)
    .map(({ p, r }) => {
      const label = insight.pageLabels[viewerPageKey(p.pageId, p.part)];
      return `- page ${p.label} "${p.title}": ${formatReadingTime(r!.attentionMs)}${label ? ` (${READ_LABEL_TEXT[label]})` : ""}${r!.visits > 1 ? `, over ${r!.visits} visits` : ""}`;
    });
  const visits = [...buyer.visits].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
  const lines = [
    `CIM: ${dealName}${blind ? " (the buyer has the anonymous, blind version)" : ""}`,
    `Buyer: ${buyer.name}${buyer.company ? `, ${buyer.company}` : ""}${buyer.buyerType ? ` (${buyer.buyerType.replace(/_/g, " ")})` : ""}`,
    `Status: ${insight.statusLabel}. ${insight.why}`,
    `Visits: ${visits.length} — first ${whenText(Date.parse(visits[0].startedAt), now)}, last ${whenText(Date.parse(visits[visits.length - 1].lastSeenAt), now)}; ${formatReadingTime(visits.reduce((s, v) => s + v.activeMs, 0))} active in all.`,
    `Decision: ${buyer.decision === "under_review" ? "none yet" : buyer.decision.replace(/_/g, " ")}`,
    "Pages they spent most time on:",
    ...(read.length ? read : ["- (no page read for more than a few seconds)"]),
    "What stands out:",
    ...(insight.signals.length ? insight.signals.slice(0, 6).map((s) => `- ${s.evidence}`) : ["- nothing notable yet"]),
    "Suggested talking points:",
    ...(insight.talkingPoints.length ? insight.talkingPoints.map((t) => `- ${t.text}`) : ["- none"]),
    ...(buyer.questions.length ? ["Their questions:", ...buyer.questions.slice(0, 5).map((q) => `- "${q.text.replace(/\s+/g, " ").slice(0, 200)}"${q.answered ? " (answered)" : " (not answered yet)"}`)] : []),
  ];
  const fallback = [insight.why, ...insight.talkingPoints.map((t) => t.text)].join(" ");
  return { text: lines.join("\n"), blind, dealName, fallback };
}

function systemPrompt(dealName: string, blind: boolean): string {
  return [
    "You brief a business broker before they call a buyer who has been reading their CIM (confidential information memorandum).",
    "Use ONLY the reading facts given. Never invent numbers, pages, questions or facts about the buyer or the business.",
    "Write 3–5 short sentences of plain English for a busy, non-technical broker: what the buyer focused on (quote the reading times as given, in seconds and minutes), what they may want to discuss, and one suggested opening line.",
    "Be suggestive, never diagnostic: say \"they may want to go through the add-backs\", never \"they are worried about the add-backs\". Never grade or score the buyer and never use percentages.",
    `Refer to the business only as "${dealName}".`,
    blind
      ? `This buyer has the blind (anonymous) CIM. Never guess, name or hint at the real business, its owner, staff, customers, street or city — only "${dealName}" and the page titles exactly as given.`
      : "",
  ].filter(Boolean).join("\n");
}

/**
 * The brief for one buyer: cached per (buyer, facts); throws
 * BriefNothingToSayError when the buyer hasn't read anything,
 * BriefUnavailableError when AI isn't configured.
 */
export async function buyerBrief(deal: BriefDeal, facts: DealReadingFacts, accessId: string): Promise<BuyerBriefResponse> {
  const input = briefFacts(deal, facts, accessId);
  if (!input) throw new BriefNothingToSayError("nothing to summarise");
  const model = agentConfig.models.supportingAgents;
  const key = `${accessId}:${crypto.createHash("sha256").update(`${model}\n${input.text}`).digest("hex").slice(0, 32)}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { accessId, text: hit.text, generatedAt: hit.generatedAt, cached: true };

  const response = await client().messages.create({
    model,
    max_tokens: 600,
    temperature: 0.2,
    system: systemPrompt(input.dealName, input.blind),
    tools: [BRIEF_TOOL],
    tool_choice: { type: "tool", name: BRIEF_TOOL.name },
    messages: [{ role: "user", content: `Reading facts:\n${input.text}` }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  const raw = (block?.input as { brief?: unknown } | undefined)?.brief;
  let text = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 1200) : "";
  if (text.length < 20) text = input.fallback;

  if (input.blind) {
    const terms = blindLeakTerms(deal as any, { codename: deal.blindCodename ?? null });
    if (findBlindLeaks(text, terms).length > 0) {
      console.warn("[engagement] brief held back by the blind check; using the plain summary");
      text = input.fallback;
      if (findBlindLeaks(text, terms).length > 0) throw new BriefUnavailableError("blind check failed");
    }
  }

  const generatedAt = new Date().toISOString();
  cache.set(key, { text, generatedAt, at: Date.now() });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string);
  return { accessId, text, generatedAt, cached: false };
}
