/**
 * CRM Buyer Prefill
 *
 * Given a search query (name, email, or company), fetch the matching person
 * from the broker's connected CRM, along with any notes, deal history, and
 * custom fields. Then use Claude Sonnet to parse the free-form text into
 * structured buyer-approval fields (category, financial capability,
 * background, partners, NDA status, competitor flags, etc.).
 *
 * Supported:
 *   - Pipedrive persons + notes (primary)
 *   - HubSpot / Salesforce (stubs)
 *
 * If no CRM is connected, returns an empty prefill (form starts blank).
 */
import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import type {
  BuyerCategory, BuyerFinancialCapability, BuyerPartner, Integration,
} from "@shared/schema";
import { BUYER_CATEGORIES } from "@shared/schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

export interface PrefillResult {
  found: boolean;
  source: "pipedrive" | "hubspot" | "salesforce" | "manual";
  fields: {
    buyerName?: string;
    buyerTitle?: string;
    buyerEmail?: string;
    buyerPhone?: string;
    buyerCompany?: string;
    buyerCompanyUrl?: string;
    linkedinUrl?: string;
    otherProfileUrls?: string[];
    category?: BuyerCategory;
    background?: string;
    financialCapability?: BuyerFinancialCapability;
    partners?: BuyerPartner[];
    isCompetitor?: boolean;
    competitorDetails?: string;
    ndaSigned?: boolean;
    ndaNotes?: string;
  };
  crmRecordId?: string;
  rawData?: any;
  files?: Array<{ id: number | string; name: string; fileName?: string; fileType?: string; fileSize?: number; url?: string; addedAt?: string }>;
  warnings?: string[];
}

export interface BuyerSearchResult {
  id: string;
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  title?: string;
  source: "pipedrive" | "hubspot" | "salesforce";
}

// ── Pipedrive helpers ───────────────────────────────────────────────────

async function pipedriveSearchPerson(token: string, query: string): Promise<any | null> {
  const url = `https://api.pipedrive.com/v1/persons/search?term=${encodeURIComponent(query)}&fields=email,name&limit=1&api_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = await res.json() as any;
  return data?.data?.items?.[0]?.item || null;
}

async function pipedriveSearchPersons(token: string, query: string, limit = 8): Promise<any[]> {
  const url = `https://api.pipedrive.com/v1/persons/search?term=${encodeURIComponent(query)}&fields=email,name,phone&limit=${limit}&api_token=${token}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data?.data?.items || []).map((i: any) => i.item).filter(Boolean);
}

async function pipedriveGetFiles(token: string, personId: number): Promise<any[]> {
  const res = await fetch(`https://api.pipedrive.com/v1/files?person_id=${personId}&api_token=${token}`);
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data?.data || []).map((f: any) => ({
    id: f.id,
    name: f.name || f.file_name,
    fileName: f.file_name,
    fileType: f.file_type,
    fileSize: f.file_size,
    url: f.url,
    addedAt: f.add_time,
  }));
}

async function pipedriveGetPerson(token: string, personId: number): Promise<any | null> {
  const res = await fetch(`https://api.pipedrive.com/v1/persons/${personId}?api_token=${token}`);
  if (!res.ok) return null;
  return (await res.json() as any)?.data || null;
}

async function pipedriveGetNotes(token: string, personId: number): Promise<string[]> {
  const res = await fetch(`https://api.pipedrive.com/v1/notes?person_id=${personId}&api_token=${token}`);
  if (!res.ok) return [];
  const data = await res.json() as any;
  return (data?.data || []).map((n: any) => (n.content || "").replace(/<[^>]*>/g, " "));
}

// ── Claude structured parse ─────────────────────────────────────────────

async function parseWithClaude(rawContext: string): Promise<PrefillResult["fields"]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return {};
  }

  const categoryList = BUYER_CATEGORIES.map((c) => `  - ${c.value}: ${c.label} (${c.description})`).join("\n");

  const prompt = `You are helping a business broker pre-populate a buyer approval form from messy CRM data. Extract whatever structured information you can from the context below. Return ONLY valid JSON with this exact shape — use null for anything you cannot determine:

{
  "buyerName": string | null,
  "buyerTitle": string | null,
  "buyerEmail": string | null,
  "buyerPhone": string | null,
  "buyerCompany": string | null,
  "buyerCompanyUrl": string | null,
  "linkedinUrl": string | null,
  "otherProfileUrls": string[],
  "category": "one of the values below" | null,
  "background": string | null,
  "financialCapability": {
    "liquidFunds": string | null,
    "annualIncome": string | null,
    "investmentSizeTarget": string | null,
    "hasProofOfFunds": boolean | null,
    "sourceOfFunds": string | null,
    "prequalifiedForFinancing": boolean | null,
    "notes": string | null
  },
  "partners": [{ "name": string, "role": string | null, "email": string | null, "phone": string | null, "company": string | null, "linkedinUrl": string | null, "background": string | null }],
  "isCompetitor": boolean,
  "competitorDetails": string | null,
  "ndaSigned": boolean,
  "ndaNotes": string | null
}

Category values (pick the single best fit):
${categoryList}

Guidance:
- "background" should be a concise 1-3 sentence summary the broker can review at a glance.
- If the context mentions a direct or indirect competitor, set isCompetitor=true and category=direct_competitor or indirect_competitor accordingly.
- If the context mentions proof of funds, pre-qualification, SBA loans, personal capital, family office backing, etc., populate financialCapability accordingly.
- Partners = explicitly named co-investors, operating partners, or co-buyers. Do not include the primary buyer here.
- Do not invent data. If something is not present, use null or an empty array.

CRM context:
---
${rawContext.slice(0, 12000)}
---

Return only the JSON object, no prose, no markdown fences.`;

  try {
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-5",
      max_tokens: 2000,
      temperature: 0,
      messages: [{ role: "user", content: prompt }],
    });
    const text = response.content
      .filter((b: any) => b.type === "text")
      .map((b: any) => b.text)
      .join("");
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    const parsed = JSON.parse(jsonMatch[0]);
    // Strip nulls to avoid clobbering form defaults
    for (const k of Object.keys(parsed)) {
      if (parsed[k] === null) delete parsed[k];
    }
    if (parsed.financialCapability) {
      for (const k of Object.keys(parsed.financialCapability)) {
        if (parsed.financialCapability[k] === null) delete parsed.financialCapability[k];
      }
    }
    return parsed;
  } catch (err) {
    console.error("[buyer-prefill] Claude parse failed:", err);
    return {};
  }
}

// ── Main entry ──────────────────────────────────────────────────────────

export async function searchBuyersInCrm(brokerId: string, query: string): Promise<BuyerSearchResult[]> {
  if (!query || query.trim().length < 2) return [];
  try {
    const integrations = await storage.getIntegrationsByBroker(brokerId);
    const pipedrive = integrations.find((i) => i.provider === "pipedrive" && i.status === "connected");
    if (pipedrive?.accessToken) {
      const items = await pipedriveSearchPersons(pipedrive.accessToken, query);
      return items.map((p: any) => ({
        id: String(p.id),
        name: p.name || "",
        email: Array.isArray(p.emails) ? p.emails[0] : p.primary_email || undefined,
        phone: Array.isArray(p.phones) ? p.phones[0] : undefined,
        company: p.organization?.name || undefined,
        source: "pipedrive" as const,
      }));
    }
    return [];
  } catch (err) {
    console.error("[buyer-prefill] search failed:", err);
    return [];
  }
}

export async function prefillBuyerFromCrm(brokerId: string, query: string): Promise<PrefillResult> {
  try {
    const integrations = await storage.getIntegrationsByBroker(brokerId);
    const pipedrive = integrations.find((i) => i.provider === "pipedrive" && i.status === "connected");

    if (pipedrive) return await prefillPipedrive(pipedrive, query);

    // Stubs
    const hubspot = integrations.find((i) => i.provider === "hubspot" && i.status === "connected");
    if (hubspot) {
      return { found: false, source: "hubspot", fields: {}, warnings: ["HubSpot prefill not yet implemented"] };
    }
    const salesforce = integrations.find((i) => i.provider === "salesforce" && i.status === "connected");
    if (salesforce) {
      return { found: false, source: "salesforce", fields: {}, warnings: ["Salesforce prefill not yet implemented"] };
    }

    return { found: false, source: "manual", fields: {}, warnings: ["No CRM connected"] };
  } catch (err: any) {
    console.error("[buyer-prefill] Error:", err);
    return { found: false, source: "manual", fields: {}, warnings: [err?.message || "Unknown error"] };
  }
}

async function prefillPipedrive(integration: Integration, query: string): Promise<PrefillResult> {
  const token = integration.accessToken;
  if (!token) {
    return { found: false, source: "pipedrive", fields: {}, warnings: ["Pipedrive access token missing"] };
  }

  const person = await pipedriveSearchPerson(token, query);
  if (!person) {
    return { found: false, source: "pipedrive", fields: {}, warnings: [`No Pipedrive contact matched "${query}"`] };
  }

  const details = await pipedriveGetPerson(token, person.id) || person;
  const [notes, files] = await Promise.all([
    pipedriveGetNotes(token, person.id),
    pipedriveGetFiles(token, person.id),
  ]);

  // Build free-form context string for Claude
  const ctxParts: string[] = [];
  ctxParts.push(`Pipedrive Person Record:`);
  ctxParts.push(`Name: ${details.name || ""}`);
  if (details.primary_email?.[0]?.value) ctxParts.push(`Email: ${details.primary_email[0].value}`);
  if (details.phone?.[0]?.value) ctxParts.push(`Phone: ${details.phone[0].value}`);
  if (details.org_name || details.org_id?.name) ctxParts.push(`Company: ${details.org_name || details.org_id.name}`);
  if (details.job_title) ctxParts.push(`Title: ${details.job_title}`);
  if (details.cc_email) ctxParts.push(`CC Email: ${details.cc_email}`);
  for (const k of Object.keys(details)) {
    if (typeof details[k] === "string" && details[k].length > 10 && !["name", "cc_email"].includes(k)) {
      ctxParts.push(`${k}: ${details[k]}`);
    }
  }
  if (notes.length > 0) {
    ctxParts.push(`\nNotes:`);
    notes.forEach((n, i) => ctxParts.push(`(${i + 1}) ${n}`));
  }
  if (files.length > 0) {
    ctxParts.push(`\nAttached Files:`);
    files.forEach((f, i) => ctxParts.push(`(${i + 1}) ${f.name || f.fileName}`));
  }

  const rawContext = ctxParts.join("\n");
  const parsedFields = await parseWithClaude(rawContext);

  // Merge: prefer parsed fields, fall back to direct Pipedrive values
  const fields: PrefillResult["fields"] = {
    buyerName: parsedFields.buyerName || details.name || undefined,
    buyerEmail: parsedFields.buyerEmail || details.primary_email?.[0]?.value || undefined,
    buyerPhone: parsedFields.buyerPhone || details.phone?.[0]?.value || undefined,
    buyerCompany: parsedFields.buyerCompany || details.org_name || details.org_id?.name || undefined,
    buyerTitle: parsedFields.buyerTitle || details.job_title || undefined,
    ...parsedFields,
  };

  return {
    found: true,
    source: "pipedrive",
    fields,
    crmRecordId: String(person.id),
    rawData: { person: details, notes, files },
    files,
  };
}
