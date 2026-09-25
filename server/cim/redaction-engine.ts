/**
 * Blind CIM Redaction Engine
 *
 * Processes CIM sections through Claude to replace ALL identifying information
 * with fictitious but realistic placeholders, producing a "blind" CIM version.
 *
 * Redacts: business name, location, employee names, customer names, vendor names,
 * specific addresses, phone numbers, and any other identifying details.
 * Preserves: all financial figures, percentages, operational metrics, industry terms.
 */
import Anthropic from "@anthropic-ai/sdk";
import { blindIdentifiers } from "@shared/blind-identifiers";
import type { CimSection } from "@shared/schema";
import { isMediaLayout, mediaTextSkeleton, type MediaLayoutKey } from "@shared/cim-media";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000 });

export interface RedactionResult {
  cimSectionId: string;
  layoutData: any;
  contentOverride: string;
  /** The section title with identifying details removed. */
  sectionTitle: string;
}

type RedactionDeal = {
  businessName: string;
  industry?: string | null;
  extractedInfo?: Record<string, any> | null;
};

/** Every string the redactor must never let through for this deal. */
export function knownIdentifiersFor(deal: RedactionDeal): string[] {
  const extractedInfo = deal.extractedInfo || {};
  return Array.from(new Set([
    ...blindIdentifiers(deal),
    extractedInfo.contactEmail,
    extractedInfo.contactPhone,
    extractedInfo.address,
    extractedInfo.leaseAddress,
  ].filter((v): v is string => typeof v === "string" && v.length > 0)));
}

/**
 * Generate blind (redacted) overrides for all CIM sections of a deal.
 * Callers pass the deal's codename (server/cim/codenames.ts keeps it stable
 * and unique per brokerage); a random pick is only a last-resort fallback.
 */
export async function generateBlindOverrides(
  sections: CimSection[],
  deal: RedactionDeal,
  options: {
    /** The deal's codename — reused so outreach and the CIM always agree. */
    codename?: string | null;
  } = {},
): Promise<{ codename: string; overrides: RedactionResult[] }> {
  const knownIdentifiers = knownIdentifiersFor(deal);
  const { pickCodename } = await import("./codenames");
  const codename = options.codename || pickCodename(new Set());

  const overrides: RedactionResult[] = [];

  // Process in batches of 3 to avoid rate limits but maintain speed
  for (let i = 0; i < sections.length; i += 3) {
    const batch = sections.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map((section) => redactSection(section, knownIdentifiers, codename, deal.industry)),
    );
    overrides.push(...batchResults);
  }

  return { codename, overrides };
}

/** Redact one section (throws if the AI call itself fails). */
export async function redactOneSection(
  section: CimSection,
  deal: RedactionDeal,
  codename: string,
): Promise<RedactionResult> {
  return redactSection(section, knownIdentifiersFor(deal), codename, deal.industry);
}

/**
 * The prose the renderer actually shows for this section — the redacted copy
 * must be of the same text, or the Blind CIM reads differently from Normal.
 * Narrative: broker edit → layoutData.body → AI draft. Elsewhere the broker
 * edit or AI draft (two-column keeps its prose column in layoutData).
 */
function displayedProse(section: CimSection): string {
  const data = (section.layoutData as Record<string, unknown> | null) || {};
  if (section.layoutType === "prose_highlight") {
    return section.brokerEditedContent || (typeof data.body === "string" ? data.body : "") || section.aiDraftContent || "";
  }
  return section.brokerEditedContent || section.aiDraftContent || "";
}

async function redactSection(
  section: CimSection,
  knownIdentifiers: string[],
  codename: string,
  industry?: string | null,
): Promise<RedactionResult> {
  // Media blocks: the AI only ever sees (and returns) their words. Which
  // photos/videos a blind buyer gets, and the map's region, are decided
  // deterministically from the real data (shared/cim-media.ts).
  const media = isMediaLayout(section.layoutType);
  const layoutData = media
    ? mediaTextSkeleton(section.layoutType as MediaLayoutKey, section.layoutData)
    : (section.layoutData as any) || {};
  const content = media ? "" : displayedProse(section);

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5",
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: `You are redacting a CIM (Confidential Information Memorandum) section to create a "blind" version for initial marketing before NDA.

## Rules
1. Replace the business name with "${codename}" everywhere
2. Replace ALL location references (city, state, address, zip) with generic equivalents (e.g. "Major Metropolitan Area, [State]")
3. Replace employee names with role-based identifiers (e.g. "Operations Manager" not "John Smith")
4. Replace customer names with "Customer A", "Customer B", etc.
5. Replace vendor/supplier names with "Supplier A", "Supplier B", etc.
6. Replace specific addresses and phone numbers with "[Address Withheld]" and "[Contact Info Withheld]"
7. KEEP all financial figures, percentages, years, metrics, and industry terminology intact
8. KEEP the same JSON structure for layoutData — only change string values that contain identifying info
9. Be thorough — buyers should not be able to identify the business from the blind version
10. Redact the section title too, keeping it a natural heading (return it unchanged if it holds nothing identifying)

## Known identifiers to watch for:
${knownIdentifiers.map(id => `- "${id}"`).join("\n")}

## Section to redact:
Title: ${section.sectionTitle}
Layout type: ${section.layoutType}
Industry: ${industry || "unknown"}

### layoutData (JSON):
${JSON.stringify(layoutData, null, 2)}

### Content text:
${content}

## Output format
Respond with ONLY a JSON object (no markdown, no explanation):
{
  "sectionTitle": "<redacted title>",
  "layoutData": <redacted layoutData with same structure>,
  "contentOverride": "<redacted content text>"
}`,
      },
    ],
  });

  // Deterministic net: known identifiers → codename. Used for any field the
  // model left out, so a missing field can never fall back to the raw text.
  // (An empty pattern would match between every character — guard it.)
  const nameRegex = knownIdentifiers.length > 0
    ? new RegExp(knownIdentifiers.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi")
    : null;
  const scrub = (t: string) => (nameRegex ? t.replace(nameRegex, codename) : t);
  const scrubbedData = () => JSON.parse(scrub(JSON.stringify(layoutData)));

  try {
    const text = message.content[0].type === "text" ? message.content[0].text : "";
    // Extract JSON from response (handle possible markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);
    const redactedData = parsed.layoutData && typeof parsed.layoutData === "object" ? parsed.layoutData : scrubbedData();

    return {
      cimSectionId: String(section.id),
      // Second pass with the known-identifier net in case the model missed one.
      layoutData: JSON.parse(scrub(JSON.stringify(redactedData))),
      contentOverride: scrub(typeof parsed.contentOverride === "string" && (parsed.contentOverride || !content)
        ? parsed.contentOverride
        : content),
      sectionTitle: scrub(typeof parsed.sectionTitle === "string" && parsed.sectionTitle.trim()
        ? parsed.sectionTitle.trim()
        : section.sectionTitle || ""),
    };
  } catch {
    // Fallback: naive string replacement
    return {
      cimSectionId: String(section.id),
      layoutData: scrubbedData(),
      contentOverride: scrub(content),
      sectionTitle: scrub(section.sectionTitle || ""),
    };
  }
}
