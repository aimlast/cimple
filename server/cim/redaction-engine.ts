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
import type { CimSection } from "@shared/schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

interface RedactionResult {
  cimSectionId: string;
  layoutData: any;
  contentOverride: string;
}

/**
 * Generate blind (redacted) overrides for all CIM sections of a deal.
 */
export async function generateBlindOverrides(
  sections: CimSection[],
  deal: {
    businessName: string;
    industry?: string | null;
    extractedInfo?: Record<string, any> | null;
  },
): Promise<RedactionResult[]> {
  // Build a mapping of known identifiers to help the AI
  const extractedInfo = deal.extractedInfo || {};
  const knownIdentifiers: string[] = [
    deal.businessName,
    extractedInfo.locations,
    extractedInfo.ownerName,
    extractedInfo.contactEmail,
    extractedInfo.contactPhone,
    extractedInfo.address,
  ].filter(Boolean);

  // Generate a project codename
  const codenames = [
    "Project Maple", "Project Horizon", "Project Summit", "Project Coastal",
    "Project Pinnacle", "Project Meridian", "Project Evergreen", "Project Atlas",
  ];
  const codename = codenames[Math.floor(Math.random() * codenames.length)];

  const results: RedactionResult[] = [];

  // Process in batches of 3 to avoid rate limits but maintain speed
  for (let i = 0; i < sections.length; i += 3) {
    const batch = sections.slice(i, i + 3);
    const batchResults = await Promise.all(
      batch.map((section) => redactSection(section, knownIdentifiers, codename, deal.industry)),
    );
    results.push(...batchResults);
  }

  return results;
}

async function redactSection(
  section: CimSection,
  knownIdentifiers: string[],
  codename: string,
  industry?: string | null,
): Promise<RedactionResult> {
  const layoutData = section.layoutData as any || {};
  const content = section.brokerEditedContent || section.aiDraftContent || "";

  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-5-20250514",
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
  "layoutData": <redacted layoutData with same structure>,
  "contentOverride": "<redacted content text>"
}`,
      },
    ],
  });

  try {
    const text = message.content[0].type === "text" ? message.content[0].text : "";
    // Extract JSON from response (handle possible markdown wrapping)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No JSON in response");
    const parsed = JSON.parse(jsonMatch[0]);

    return {
      cimSectionId: String(section.id),
      layoutData: parsed.layoutData || layoutData,
      contentOverride: parsed.contentOverride || content,
    };
  } catch {
    // Fallback: naive string replacement
    const nameRegex = new RegExp(
      knownIdentifiers.map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
      "gi",
    );
    return {
      cimSectionId: String(section.id),
      layoutData: JSON.parse(JSON.stringify(layoutData).replace(nameRegex, codename)),
      contentOverride: content.replace(nameRegex, codename),
    };
  }
}
