/**
 * Supporting-model helpers for the buyer profile page: a short broker-facing
 * summary of the buyer, and a draft email the broker edits and sends.
 * Both are broker-facing only; the email draft is blind-safe whenever it
 * mentions a listing (pre-NDA rules — codename, industry, region, bands).
 */
import Anthropic from "@anthropic-ai/sdk";
import { agentConfig } from "../interview/config/load-config";
import type { BlindDealSummary } from "./blind-deal-summary";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export const aiAvailable = () => !!process.env.ANTHROPIC_API_KEY;

const SUMMARY_TOOL: Anthropic.Tool = {
  name: "buyer_summary",
  description: "A short broker-facing summary of one buyer.",
  input_schema: {
    type: "object",
    properties: {
      summary: {
        type: "string",
        description: "3-5 plain sentences: who they are; what they want (industries, size, location, deal type); how serious they look (funds, proof of funds, timeline, decisions); how they've engaged with this broker's listings. Facts only.",
      },
    },
    required: ["summary"],
  },
};

export async function generateBuyerSummary(input: unknown): Promise<string | null> {
  if (!aiAvailable()) return null;
  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 700,
    temperature: 0.2,
    tools: [SUMMARY_TOOL],
    tool_choice: { type: "tool", name: "buyer_summary" },
    system: [
      "You brief a business broker on one of their buyers, from the record below (the broker's own data: the buyer's profile, NDA answers, CRM notes, and activity on the broker's listings).",
      "Write 3-5 sentences in plain English, in this order: who they are; what they want; how serious they look; how they've engaged. Use only what the record says — never invent budgets, intentions or history, and say plainly when something is unknown (e.g. 'no proof of funds on file').",
      "If liquidFundsIsRange is true, the funds figure is a range the buyer asked to keep approximate — quote the range, never a precise number.",
      "No praise, no hedging filler, no advice, no headings or bullet points. Refer to listings by the deal name given.",
    ].join(" "),
    messages: [{ role: "user", content: `<buyer_record>\n${JSON.stringify(input, null, 1).slice(0, 24000)}\n</buyer_record>` }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  const text = block && block.type === "tool_use" ? String((block.input as any)?.summary ?? "").trim() : "";
  return text || null;
}

const EMAIL_TOOL: Anthropic.Tool = {
  name: "buyer_email",
  description: "A draft email from the broker to one buyer.",
  input_schema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Under 70 characters." },
      body: { type: "string", description: "Plain text. Short paragraphs separated by blank lines. Signed with the broker's name." },
    },
    required: ["subject", "body"],
  },
};

export interface EmailDraftInput {
  brokerName: string;
  brokerCompany: string | null;
  buyer: { firstName: string; company: string | null; buyerType: string | null; targetIndustries: string[]; targetLocations: string[]; lookingFor: string | null };
  /** Blind-safe listing facts when the email is about one of the broker's deals. */
  deal: BlindDealSummary | null;
  /** What the buyer has already done on that deal (never names the business). */
  dealContext: { hasAccess: boolean; ndaSigned: boolean; decision: string | null } | null;
  instructions: string | null;
  /** Names that must never appear (business / legal / owner names) — a draft containing one is discarded. */
  forbidden: string[];
}

export async function draftBuyerEmail(input: EmailDraftInput): Promise<{ subject: string; body: string }> {
  const fallback = () => {
    const d = input.deal;
    const sign = `${input.brokerName}${input.brokerCompany ? `\n${input.brokerCompany}` : ""}`;
    if (d) {
      return {
        subject: `A ${d.industry || "business"} opportunity${d.region ? ` in ${d.region}` : ""}`,
        body: `Hi ${input.buyer.firstName},\n\nI wanted to flag ${d.codename}: a ${d.industry || "business"}${d.region ? ` in ${d.region}` : ""}${d.revenueBand ? ` with revenue in the ${d.revenueBand} range` : ""}. Given what you're looking for, I think it's worth a look.\n\nIf you'd like a closer look, just reply and I'll set up secure access to the full confidential overview.\n\nBest,\n${sign}`,
      };
    }
    return {
      subject: "Checking in on your search",
      body: `Hi ${input.buyer.firstName},\n\nI wanted to check in on your acquisition search. Has anything changed in what you're looking for — industry, size or location?\n\nJust reply and I'll keep an eye out for the right fit.\n\nBest,\n${sign}`,
    };
  };
  if (!aiAvailable()) return fallback();
  try {
    const response = await anthropic.messages.create({
      model: agentConfig.models.supportingAgents,
      max_tokens: 900,
      temperature: 0.5,
      tools: [EMAIL_TOOL],
      tool_choice: { type: "tool", name: "buyer_email" },
      system: [
        "You draft a short, warm, professional email from a business broker to one of their buyers. The broker will edit it and send it themselves.",
        input.deal
          ? "It is about one of the broker's listings. It must be BLIND-SAFE: never state or hint at the business name, owner, street, city, customers or any exact figure. Refer to it only by the codename given and the industry, region and size ranges provided."
          : "It is a relationship email (no specific listing): check in on their search, or follow the broker's instructions.",
        "About 80-150 words, 2-4 short paragraphs, no bullet lists unless the broker asks, no hype, no invented facts, no asking price. End with a clear, low-pressure next step. Sign off with the broker's name exactly as given.",
      ].join(" "),
      messages: [{ role: "user", content: JSON.stringify({
        broker: { name: input.brokerName, company: input.brokerCompany },
        buyer: input.buyer,
        listing: input.deal,
        buyerStatusOnListing: input.dealContext,
        brokerInstructions: input.instructions || null,
      }, null, 1) }],
    });
    const block = response.content.find((b) => b.type === "tool_use");
    const out = (block && block.type === "tool_use" ? block.input : {}) as { subject?: string; body?: string };
    if (out.subject && out.body) {
      const all = `${out.subject}\n${out.body}`.toLowerCase();
      const leak = input.deal ? input.forbidden.find((n) => n.length >= 4 && all.includes(n.toLowerCase())) : undefined;
      if (!leak) return { subject: out.subject.slice(0, 200), body: out.body.slice(0, 8000) };
      console.warn("[buyer-profile] email draft named the business — discarded for the blind-safe template");
    }
  } catch (err) {
    console.warn("[buyer-profile] email draft failed — using template:", err instanceof Error ? err.message : err);
  }
  return fallback();
}
