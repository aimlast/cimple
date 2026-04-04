/**
 * Public data scraper — fetches a business's website and uses Claude Sonnet
 * to extract structured business information into the deal's knowledge base.
 */

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ScrapeResult {
  fieldsExtracted: string[];
  fieldCount: number;
  websiteUrl: string;
}

// ─────────────────────────────────────────────
// HTML → plain text
// ─────────────────────────────────────────────

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 14000); // Keep within Claude's context budget
}

// ─────────────────────────────────────────────
// Fetch website text
// ─────────────────────────────────────────────

async function fetchPageText(url: string): Promise<string> {
  const fullUrl = url.startsWith("http") ? url : `https://${url}`;

  const res = await fetch(fullUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(12000),
    redirect: "follow",
  });

  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${fullUrl}`);

  const html = await res.text();
  return htmlToText(html);
}

// Try to also fetch an /about page for richer content
async function fetchWithAbout(baseUrl: string): Promise<string> {
  const base = baseUrl.startsWith("http") ? baseUrl : `https://${baseUrl}`;
  const origin = new URL(base).origin;

  let combined = await fetchPageText(base);

  try {
    const aboutText = await fetchPageText(`${origin}/about`);
    combined += "\n\n" + aboutText;
  } catch {
    // About page may not exist — that's fine
  }

  return combined.slice(0, 16000);
}

// ─────────────────────────────────────────────
// Claude extraction
// ─────────────────────────────────────────────

async function extractBusinessInfo(
  websiteText: string,
  businessName: string,
  industry: string,
): Promise<Record<string, string>> {
  const prompt = `You are extracting structured business information from a company's public website to use in a business sale document (CIM/Confidential Information Memorandum).

Business Name: ${businessName}
Industry: ${industry}

Website content:
---
${websiteText}
---

Extract all available business information and return a JSON object. Only include fields where the website clearly provides the information — do not guess, infer, or fabricate anything.

Use these exact field names where applicable:
- businessDescription: what the business does, in 2–4 sentences
- yearFounded: year the business was founded (number as string)
- yearsOperating: how many years in operation
- numberOfLocations: number of locations (as string)
- locationSite: city, province/state, country
- keyProducts: main products or services offered (comma-separated or brief list)
- revenueStreams: how the business makes money
- targetMarket: who their customers are
- competitiveAdvantage: what makes them different from competitors
- uniqueSellingProposition: their main value proposition
- brandIdentity: how they position their brand
- awards: any awards, certifications, or recognition mentioned
- managementTeam: key people mentioned (names and roles)
- employees: employee count or range if mentioned
- website: the website URL

Return ONLY a valid JSON object. Omit any field where the website does not clearly provide the information. Do not include placeholder text.`;

  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No response from extraction model");
  }

  // Parse JSON — handle markdown code fences if present
  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse extraction response as JSON");

  const raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

  // Filter to string values only and remove empty strings
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.trim()) {
      cleaned[key] = value.trim();
    } else if (typeof value === "number") {
      cleaned[key] = String(value);
    }
  }

  return cleaned;
}

// ─────────────────────────────────────────────
// Main export
// ─────────────────────────────────────────────

export async function scrapeDeal(dealId: string, overrideUrl?: string): Promise<ScrapeResult> {
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  // Resolve the URL: override → deal field → extracted info → questionnaire
  const websiteUrl =
    overrideUrl ||
    deal.websiteUrl ||
    (deal.extractedInfo as Record<string, string> | null)?.website ||
    (deal.questionnaireData as Record<string, string> | null)?.website;

  if (!websiteUrl) {
    throw new Error("No website URL available. Please enter the business website URL.");
  }

  // Fetch and extract
  const websiteText = await fetchWithAbout(websiteUrl);
  const extracted = await extractBusinessInfo(websiteText, deal.businessName, deal.industry);

  // Merge into deal's extractedInfo — scraped fields fill gaps, don't overwrite confirmed interview data
  const existingInfo = (deal.extractedInfo as Record<string, string>) || {};
  const merged: Record<string, string> = { ...existingInfo };

  for (const [key, value] of Object.entries(extracted)) {
    if (!merged[key]) {
      merged[key] = value;
    }
  }

  await storage.updateDeal(dealId, {
    extractedInfo: merged,
    websiteUrl: overrideUrl || deal.websiteUrl || websiteUrl,
    scrapedAt: new Date(),
  });

  return {
    fieldsExtracted: Object.keys(extracted),
    fieldCount: Object.keys(extracted).length,
    websiteUrl: overrideUrl || deal.websiteUrl || websiteUrl,
  };
}
