/**
 * Blind CIM Redaction Engine
 *
 * Processes CIM sections through Claude to replace ALL identifying information
 * with fictitious but realistic placeholders, producing a "blind" CIM version.
 *
 * Redacts: business name, location, employee names, customer names, vendor names,
 * specific addresses, phone numbers, and any other identifying details.
 * Preserves: all financial figures, percentages, operational metrics, industry terms.
 *
 * Fails closed (2026-09-25): a reply that is cut off, malformed or missing a
 * field — or a result that still names the business, a person, the city or
 * the street (shared/blind-guard.ts) — is a FAILURE, never a partially
 * scrubbed copy. The caller (blind-sync) keeps that section held back from
 * blind buyers and tells the broker. The old catch-all fallback did a naive
 * name replacement and committed it as the redacted section, which served
 * the owner's full name, the city and staff names to pre-NDA buyers.
 */
import Anthropic from "@anthropic-ai/sdk";
import { blindIdentifiers } from "@shared/blind-identifiers";
import { blindLeakTerms, collectStrings, findBlindLeaks, honorificNames } from "@shared/blind-guard";
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

/** One model reply: the text and why it stopped (anything but end_turn = incomplete). */
export interface RedactionModelReply {
  text: string;
  stopReason: string | null;
}
export type RedactionModel = (prompt: string, maxTokens: number) => Promise<RedactionModelReply>;

/** The production model call — streamed, so long sections never hit the SDK's non-streaming limits. */
const claudeRedactor: RedactionModel = async (prompt, maxTokens) => {
  const stream = anthropic.messages.stream({
    model: "claude-sonnet-4-5",
    max_tokens: maxTokens,
    messages: [{ role: "user", content: prompt }],
  });
  const message = await stream.finalMessage();
  const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  return { text, stopReason: message.stop_reason ?? null };
};

let model: RedactionModel = claudeRedactor;
/** Tests only: swap the model call (null restores Claude). */
export function setRedactionModelForTests(fn: RedactionModel | null): void {
  model = fn ?? claudeRedactor;
}

/** A redaction that must not be served — the section stays held back. */
export class RedactionFailedError extends Error {}

/** A broker-readable reason for a failed redaction (raw API errors stay in the server log). */
export function redactionErrorMessage(err: unknown): string {
  if (err instanceof RedactionFailedError) return err.message;
  return "the AI service couldn't be reached — try again in a minute";
}

/** Every string the redactor must never let through for this deal (shown to the model). */
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
 * Generate blind (redacted) overrides for the given CIM sections. Callers
 * pass the deal's codename (server/cim/codenames.ts keeps it stable and
 * unique per brokerage); a random pick is only a last-resort fallback.
 *
 * Per section: a redaction that fails is returned in `failures` and gets NO
 * override — that section is held back from blind buyers.
 */
export async function generateBlindOverrides(
  sections: CimSection[],
  deal: RedactionDeal,
  options: {
    /** The deal's codename — reused so outreach and the CIM always agree. */
    codename?: string | null;
  } = {},
): Promise<{ codename: string; overrides: RedactionResult[]; failures: { cimSectionId: string; error: string }[] }> {
  const codename = options.codename || (await import("./codenames")).pickCodename(new Set());

  const overrides: RedactionResult[] = [];
  const failures: { cimSectionId: string; error: string }[] = [];

  // Process in batches of 3 to avoid rate limits but maintain speed
  for (let i = 0; i < sections.length; i += 3) {
    const batch = sections.slice(i, i + 3);
    const settled = await Promise.allSettled(batch.map((section) => redactOneSection(section, deal, codename)));
    settled.forEach((r, j) => {
      if (r.status === "fulfilled") overrides.push(r.value);
      else {
        failures.push({ cimSectionId: String(batch[j].id), error: redactionErrorMessage(r.reason) });
        console.error(`[redaction] section ${batch[j].id} failed:`, (r.reason as Error)?.message ?? r.reason);
      }
    });
  }

  return { codename, overrides, failures };
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

/** Stands in for a narrative's body when it is the same text as the content (sent once, not twice). */
const SAME_AS_CONTENT = "[[SAME AS CONTENT TEXT]]";

/** Output budget for a section: the model rewrites everything it is sent, once. */
export function redactionMaxTokens(inputChars: number): number {
  // ~3 characters per token for English prose/JSON, plus headroom.
  return Math.min(32_000, Math.max(4096, Math.ceil(inputChars / 3) + 1500));
}

type ParsedReply = { sectionTitle?: unknown; layoutData?: unknown; contentOverride?: unknown };

/** Parse the model's JSON reply; throws on anything incomplete. */
function parseReply(reply: RedactionModelReply): ParsedReply {
  if (reply.stopReason !== "end_turn") {
    throw new RedactionFailedError(
      reply.stopReason === "max_tokens"
        ? "the section was too long for one pass"
        : `the reply stopped early (${reply.stopReason ?? "unknown"})`,
    );
  }
  const text = reply.text.replace(/```(?:json)?/gi, "").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new RedactionFailedError("the reply held no JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new RedactionFailedError("the reply was not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new RedactionFailedError("the reply was not a JSON object");
  return parsed as ParsedReply;
}

/**
 * Redact one section. Never returns partially redacted text: throws
 * RedactionFailedError when the model's reply is incomplete or malformed, or
 * when the result still contains an identifying term after one corrective
 * retry. (It also throws if the AI call itself fails.)
 */
export async function redactOneSection(
  section: CimSection,
  deal: RedactionDeal,
  codename: string,
): Promise<RedactionResult> {
  const knownIdentifiers = knownIdentifiersFor(deal);
  // Media blocks: the AI only ever sees (and returns) their words. Which
  // photos/videos a blind buyer gets, and the map's region, are decided
  // deterministically from the real data (shared/cim-media.ts).
  const media = isMediaLayout(section.layoutType);
  const baseData: Record<string, any> = media
    ? mediaTextSkeleton(section.layoutType as MediaLayoutKey, section.layoutData)
    : ((section.layoutData as Record<string, any> | null) || {});
  const content = media ? "" : displayedProse(section);
  // A narrative whose body IS the content text: send it once, not twice
  // (echoing it twice doubled the output and cut long sections off).
  const bodyIsContent =
    section.layoutType === "prose_highlight" && !!content && typeof baseData.body === "string" && baseData.body === content;
  const layoutData = bodyIsContent ? { ...baseData, body: SAME_AS_CONTENT } : baseData;
  const hasLayoutData = !!layoutData && typeof layoutData === "object" && Object.keys(layoutData).length > 0;

  // What must be gone from the result: the deal's identifying facts, plus
  // any honorific-named person in this section's own text ("Dr. Marcus Lee").
  const ownText = [section.sectionTitle || "", content, ...collectStrings(layoutData)].join("\n");
  const terms = blindLeakTerms(deal, { codename, extraPeople: honorificNames(ownText) });
  const watchList = Array.from(new Set([...knownIdentifiers, ...terms.map((t) => t.text)]));

  // Deterministic net on the model's output: known names → codename
  // (longest first; an empty pattern would match everywhere — guard it).
  const nameRegex = knownIdentifiers.length > 0
    ? new RegExp(
        [...knownIdentifiers].sort((a, b) => b.length - a.length).map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"),
        "gi",
      )
    : null;
  const scrub = (t: string) => (nameRegex ? t.replace(nameRegex, codename) : t);

  const basePrompt = `You are redacting a CIM (Confidential Information Memorandum) section to create a "blind" version for initial marketing before NDA.

## Rules
1. Replace the business name with "${codename}" everywhere
2. Replace ALL location references (city, town, street, address, postal/zip code, plaza or building names) with generic equivalents (e.g. "Major Metropolitan Area, [Province/State]"). The province/state and country may stay.
3. Replace every person's name (owner, employees, associates, advisors) with a role-based identifier (e.g. "the Owner", "Operations Manager" — not "John Smith" or "Dr. Smith")
4. Replace customer names with "Customer A", "Customer B", etc.
5. Replace vendor/supplier names with "Supplier A", "Supplier B", etc.
6. Replace specific addresses and phone numbers with "[Address Withheld]" and "[Contact Info Withheld]"
7. KEEP all financial figures, percentages, years, metrics, and industry terminology intact
8. KEEP the same JSON structure for layoutData — only change string values that contain identifying info${bodyIsContent ? `\n   (layoutData.body is "${SAME_AS_CONTENT}" — return it exactly like that; that text is the "Content text" below)` : ""}
9. Be thorough — buyers should not be able to identify the business from the blind version
10. Redact the section title too, keeping it a natural heading (return it unchanged if it holds nothing identifying)

## Known identifiers — none of these may appear in your output:
${watchList.map((id) => `- "${id}"`).join("\n") || "- (none on file)"}

## Section to redact:
Title: ${section.sectionTitle}
Layout type: ${section.layoutType}
Industry: ${deal.industry || "unknown"}

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
}`;

  let maxTokens = redactionMaxTokens(JSON.stringify(layoutData).length + content.length + (section.sectionTitle || "").length);
  let feedback = "";
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const reply = await model(basePrompt + feedback, maxTokens);
    let parsed: ParsedReply;
    try {
      parsed = parseReply(reply);
    } catch (err) {
      lastError = (err as Error).message;
      if (reply.stopReason === "max_tokens") maxTokens = Math.min(64_000, maxTokens * 2);
      continue;
    }

    // Every part must come back: a missing field is a failure, never the raw text.
    if (content && typeof parsed.contentOverride !== "string") {
      lastError = "the reply left out the section text";
      continue;
    }
    if (hasLayoutData && (!parsed.layoutData || typeof parsed.layoutData !== "object" || Array.isArray(parsed.layoutData))) {
      lastError = "the reply left out the section data";
      continue;
    }
    const contentOverride = scrub(typeof parsed.contentOverride === "string" ? parsed.contentOverride : "");
    let redactedData: Record<string, any> = hasLayoutData ? JSON.parse(scrub(JSON.stringify(parsed.layoutData))) : {};
    if (bodyIsContent) redactedData = { ...redactedData, body: contentOverride };
    const title = typeof parsed.sectionTitle === "string" && parsed.sectionTitle.trim()
      ? parsed.sectionTitle.trim()
      : section.sectionTitle || "";
    const result: RedactionResult = {
      cimSectionId: String(section.id),
      layoutData: redactedData,
      contentOverride,
      sectionTitle: scrub(title),
    };

    // Fail closed: nothing identifying may survive.
    const leaks = findBlindLeaks([result.sectionTitle, result.contentOverride, result.layoutData], terms);
    if (leaks.length === 0) return result;
    lastError = `the blind version still named ${leaks.slice(0, 3).map((l) => `"${l}"`).join(", ")}`;
    feedback = `\n\n## Your previous attempt was rejected\nIt still contained: ${leaks.map((l) => `"${l}"`).join(", ")}. Remove every one of them (and any other identifying detail) this time.`;
  }
  throw new RedactionFailedError(`"${section.sectionTitle || "Untitled section"}" — ${lastError}`);
}
