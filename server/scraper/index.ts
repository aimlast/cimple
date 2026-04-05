/**
 * Public data scraper — finds a business online and uses Claude Sonnet to extract
 * structured info into the deal's scrapedData field (unverified).
 *
 * Fallback chain:
 *   1. Use websiteUrl if provided or already on the deal
 *   2. Search DuckDuckGo for the business name + location, fetch top results
 *
 * Scraped data is stored separately from extractedInfo and is clearly labelled as
 * UNVERIFIED in the AI interview knowledge base. The interview agent confirms each
 * item with the seller before it moves into the confirmed knowledge base.
 */

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { agentConfig } from "../interview/config/load-config";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface ScrapeResult {
  fieldsExtracted: string[];
  fieldCount: number;
  source: "website" | "internet_search" | "website_and_internet";
  sourceUrls: string[];
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
    .trim();
}

// ─────────────────────────────────────────────
// Fetch a single page → plain text
// ─────────────────────────────────────────────

async function fetchPageText(url: string, timeoutMs = 10000): Promise<string> {
  const fullUrl = url.startsWith("http") ? url : `https://${url}`;
  const res = await fetch(fullUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
      Accept: "text/html,application/xhtml+xml,*/*",
    },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = await res.text();
  return htmlToText(html).slice(0, 12000);
}

// ─────────────────────────────────────────────
// Fetch website (homepage + /about)
// ─────────────────────────────────────────────

async function fetchWebsite(url: string): Promise<{ text: string; urls: string[] }> {
  const base = url.startsWith("http") ? url : `https://${url}`;
  const origin = (() => { try { return new URL(base).origin; } catch { return base; } })();

  let text = await fetchPageText(base);
  const urls = [base];

  // Also try /about for richer business description
  try {
    const aboutText = await fetchPageText(`${origin}/about`, 6000);
    text += "\n\n" + aboutText;
    urls.push(`${origin}/about`);
  } catch {
    // /about may not exist — fine
  }

  return { text: text.slice(0, 16000), urls };
}

// ─────────────────────────────────────────────
// DuckDuckGo internet search fallback
// ─────────────────────────────────────────────

const DDG_SKIP_DOMAINS = [
  "duckduckgo.com", "google.com", "bing.com", "yahoo.com",
  "facebook.com", "instagram.com", "twitter.com", "x.com",
  "tiktok.com", "pinterest.com", "reddit.com",
  "linkedin.com", // blocks scraping
];

function shouldSkipUrl(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return DDG_SKIP_DOMAINS.some((d) => hostname.includes(d));
  } catch {
    return true;
  }
}

async function searchInternet(
  businessName: string,
  location?: string | null,
): Promise<{ text: string; urls: string[] }> {
  const query = `"${businessName}"${location ? ` ${location}` : ""} business`;
  const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

  let searchHtml = "";
  try {
    const res = await fetch(searchUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; CimpleScraper/1.0)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(10000),
    });
    searchHtml = await res.text();
  } catch (err) {
    throw new Error(`Could not reach DuckDuckGo: ${(err as Error).message}`);
  }

  // Extract result URLs from DuckDuckGo HTML (encoded as uddg= parameter)
  const urlPattern = /uddg=(https?[^&"]+)/g;
  const foundUrls: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = urlPattern.exec(searchHtml)) !== null) {
    const decoded = decodeURIComponent(match[1]);
    if (!shouldSkipUrl(decoded) && !foundUrls.includes(decoded)) {
      foundUrls.push(decoded);
    }
    if (foundUrls.length >= 4) break;
  }

  // Also get the text snippets from the search results page itself
  const snippetText = htmlToText(searchHtml).slice(0, 4000);

  // Fetch the top 2 result pages for richer content
  let pageTexts = "";
  for (const pageUrl of foundUrls.slice(0, 2)) {
    try {
      const t = await fetchPageText(pageUrl, 8000);
      pageTexts += `\n\n[Source: ${pageUrl}]\n${t}`;
    } catch {
      // Skip pages that fail to load
    }
  }

  const combined = (snippetText + pageTexts).slice(0, 16000);

  if (!combined.trim()) {
    throw new Error(
      `No public information found for "${businessName}"${location ? ` in ${location}` : ""}. Try adding their website URL manually.`,
    );
  }

  return { text: combined, urls: foundUrls };
}

// ─────────────────────────────────────────────
// Claude Sonnet extraction
// ─────────────────────────────────────────────

async function extractBusinessInfo(
  sourceText: string,
  businessName: string,
  industry: string,
  source: "website" | "internet_search" | "website_and_internet",
): Promise<Record<string, string>> {
  const sourceNote =
    source === "website"
      ? "the business's official website"
      : source === "website_and_internet"
        ? "the business's official website combined with public internet search results (reviews, directories, news, social media)"
        : "public internet search results (may include directory listings, news, review sites)";

  const prompt = `You are extracting structured business information from ${sourceNote} to pre-populate a business sale document (CIM). This data will be shown to the AI interviewer as UNVERIFIED — the seller will confirm or correct it during their interview.

Business Name: ${businessName}
Industry: ${industry}

Content:
---
${sourceText}
---

Extract all clearly available business information. Return a JSON object using only these field names. Only include fields where the content clearly states the information — do not infer, guess, or fabricate.

Fields to extract (use exact names):
- businessDescription: 2–4 sentence summary of what the business does
- yearFounded: year founded (4-digit year as string)
- yearsOperating: years in business
- numberOfLocations: number of locations/outlets
- locationSite: city, region, country
- website: official website URL if found
- keyProducts: main products or services (brief)
- revenueStreams: how the business generates revenue
- targetMarket: description of their customer base
- competitiveAdvantage: what differentiates them
- uniqueSellingProposition: their main value proposition
- brandIdentity: how they position their brand/tone
- awards: awards, certifications, or notable recognition
- managementTeam: key people with names and roles
- employees: employee count or range

Return ONLY a valid JSON object. Omit fields where the source does not clearly provide the information. Do not include placeholder or fabricated text.`;

  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 1500,
    messages: [{ role: "user", content: prompt }],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") throw new Error("No response from extraction model");

  const jsonMatch = textBlock.text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Could not parse extraction response as JSON");

  const raw = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

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

  // Resolve website URL
  const websiteUrl =
    overrideUrl ||
    deal.websiteUrl ||
    (deal.extractedInfo as Record<string, string> | null)?.website ||
    (deal.questionnaireData as Record<string, string> | null)?.website;

  const location =
    (deal.questionnaireData as Record<string, string> | null)?.location ||
    (deal.extractedInfo as Record<string, string> | null)?.locationSite ||
    null;

  let rawText: string;
  let sourceUrls: string[];
  let source: "website" | "internet_search" | "website_and_internet";

  // Always search the internet for broader info (reviews, social media, news, etc.)
  let internetResult: { text: string; urls: string[] } | null = null;
  try {
    internetResult = await searchInternet(deal.businessName, location);
  } catch {
    // Internet search may fail — continue with website only if available
  }

  if (websiteUrl && internetResult) {
    // Both website and internet search available — merge them
    source = "website_and_internet";
    const websiteResult = await fetchWebsite(websiteUrl);
    rawText = (websiteResult.text + "\n\n" + internetResult.text).slice(0, 24000);
    sourceUrls = [...websiteResult.urls, ...internetResult.urls];
  } else if (websiteUrl) {
    // Website only (internet search failed)
    source = "website";
    const websiteResult = await fetchWebsite(websiteUrl);
    rawText = websiteResult.text;
    sourceUrls = websiteResult.urls;
  } else if (internetResult) {
    // Internet search only (no website URL)
    source = "internet_search";
    rawText = internetResult.text;
    sourceUrls = internetResult.urls;
  } else {
    throw new Error(
      `No public information found for "${deal.businessName}". Try adding their website URL manually.`,
    );
  }

  // Extract structured info using Claude Sonnet
  const extracted = await extractBusinessInfo(rawText, deal.businessName, deal.industry, source);

  // Store in scrapedData (NOT extractedInfo — needs seller verification during interview)
  await storage.updateDeal(dealId, {
    scrapedData: extracted,
    scrapeSource: source,
    scrapedAt: new Date(),
    // Also save the website URL if we found one via scraping
    ...(websiteUrl ? { websiteUrl: overrideUrl || deal.websiteUrl || websiteUrl } : {}),
    ...(extracted.website && !websiteUrl ? { websiteUrl: extracted.website } : {}),
  });

  return {
    fieldsExtracted: Object.keys(extracted),
    fieldCount: Object.keys(extracted).length,
    source,
    sourceUrls,
  };
}
