/**
 * Seller Communication Profile Generator (EQ Profiler)
 *
 * Analyzes all available data about a seller BEFORE the interview starts
 * and generates a structured communication profile. This profile is injected
 * into the interview system prompt so the AI agent can adapt its tone,
 * pacing, and approach to the specific seller.
 *
 * Uses Claude Sonnet for analysis of unstructured data (broker notes,
 * emails, transcripts, questionnaire responses, scraped data).
 */

import Anthropic from "@anthropic-ai/sdk";
import { storage } from "../storage";
import { agentConfig } from "./config/load-config";

// =====================
// Types
// =====================

export interface SellerCommunicationProfile {
  /** How the seller naturally communicates */
  communicationStyle: "direct" | "conversational" | "formal" | "guarded" | "enthusiastic";

  /** Current emotional posture toward the sale */
  emotionalState: "motivated" | "reluctant" | "anxious" | "grieving" | "neutral" | "excited";

  /** Primary reason for selling */
  sellingReason:
    | "retirement"
    | "burnout"
    | "health"
    | "life_event"
    | "opportunistic"
    | "partnership_dispute"
    | "growth_beyond_capability";

  /** Experience level with business transactions */
  sophistication: "first_time_seller" | "some_experience" | "serial_entrepreneur";

  /** How emotionally attached the seller is to the business */
  businessAttachment: "high" | "medium" | "low";

  /** How much time pressure the seller feels */
  timeOrientation: "patient" | "moderate" | "urgent";

  /** Family dynamics relevant to the sale */
  familyInvolvement: "family_business" | "spouse_involved" | "solo_operator" | "partner_business";

  /** Topics to approach carefully (e.g., health, family conflict, financial stress) */
  sensitiveTopics: string[];

  /** Personal insights that help the interviewer connect (e.g., proud of team, loves the craft) */
  personalInsights: string[];

  /** Narrative summary of who this seller is and why they are selling */
  sellerStory: string;

  /** Contextual notes about the industry and how it shapes the seller's perspective */
  industryContext: string;

  /** 0-1: how much data was available to build this profile */
  confidenceScore: number;

  /** Which data sources contributed to this profile */
  dataSources: string[];

  /** ISO timestamp of when this profile was generated */
  generatedAt: string;

  /** Broker corrections applied on top of the AI-generated profile */
  brokerOverrides?: Record<string, any>;

  /**
   * PROFILE_PRIVACY_VERSION of the rules the profile was built under — see
   * sellerProfileNeedsRebuild. Older profiles may carry the broker's private
   * material (a negotiation floor, family names from a CRM note, the
   * broker's listed price).
   */
  privacyVersion?: number;

  /** The documents rows whose text (or name) the profile was built from. */
  sourceDocumentIds?: string[];
}

/**
 * Profiles built under the current privacy rules carry this version:
 * v2 — no broker-only source text; v3 — also no broker's listed price, and
 * the rows read are recorded (sourceDocumentIds) so a row the broker later
 * makes private invalidates the profile.
 */
export const PROFILE_PRIVACY_VERSION = 3;

/**
 * True when a stored profile's free text (seller story, sensitive topics,
 * personal insights, industry context) may carry material the seller must
 * never hear, so it must stay out of the interview prompt until rebuilt:
 * - it was built under older rules — whatever the deal holds TODAY (the
 *   broker-only source it quoted may since have been deleted), or
 * - a row it was built from has since been made broker-only.
 */
export function sellerProfileNeedsRebuild(
  profile: Partial<SellerCommunicationProfile> | null | undefined,
  documents: Array<{ id?: string; visibility?: string | null }>,
): boolean {
  if (!profile) return false;
  if ((profile.privacyVersion ?? 0) < PROFILE_PRIVACY_VERSION) return true;
  const read = new Set(Array.isArray(profile.sourceDocumentIds) ? profile.sourceDocumentIds : []);
  return documents.some((d) => !!d.id && read.has(d.id) && d.visibility === "broker_only");
}

const BROKER_EDITABLE_PROFILE_FIELDS = [
  "communicationStyle", "emotionalState", "sellingReason", "sophistication",
  "businessAttachment", "timeOrientation", "familyInvolvement",
] as const;

/**
 * A rebuilt profile keeps what the broker set by hand on the old one: their
 * notes (brokerOverrides) and the style fields they corrected.
 */
export function carryBrokerProfileEdits(
  profile: SellerCommunicationProfile,
  prior: Record<string, unknown> | null,
): SellerCommunicationProfile {
  const overrides = prior?.brokerOverrides;
  if (!overrides || typeof overrides !== "object") return profile;
  const out: SellerCommunicationProfile = { ...profile, brokerOverrides: overrides as Record<string, any> };
  for (const field of BROKER_EDITABLE_PROFILE_FIELDS) {
    const o = (overrides as Record<string, any>)[field];
    const value = o && typeof o === "object" && "brokerValue" in o ? o.brokerValue : o;
    if (typeof value === "string" && value) (out as any)[field] = value;
  }
  return out;
}

/** The profile's category fields (the ones a prompt renders as labels). */
export const PROFILE_CATEGORY_FIELDS = BROKER_EDITABLE_PROFILE_FIELDS;
export type ProfileCategoryField = (typeof PROFILE_CATEGORY_FIELDS)[number];

/**
 * A profile as the interview may read it. `pendingRebuild` marks a stale
 * profile reduced to what the broker set by hand: its category fields are
 * optional because a stale profile's own values may have been inferred from
 * the broker's private notes.
 */
export type InterviewSellerProfile = Omit<SellerCommunicationProfile, ProfileCategoryField> &
  Partial<Pick<SellerCommunicationProfile, ProfileCategoryField>> & { pendingRebuild?: boolean };

/** The category values the broker set by hand on this profile (brokerOverrides). */
function brokerSetCategories(profile: SellerCommunicationProfile): Partial<Pick<SellerCommunicationProfile, ProfileCategoryField>> {
  const overrides = profile.brokerOverrides;
  const out: Record<string, string> = {};
  if (!overrides || typeof overrides !== "object") return out;
  for (const field of PROFILE_CATEGORY_FIELDS) {
    const o = (overrides as Record<string, any>)[field];
    const value = o && typeof o === "object" && "brokerValue" in o ? o.brokerValue : o;
    if (typeof value === "string" && value) out[field] = value;
  }
  return out;
}

/**
 * The profile as the interview agent may see it.
 *
 * A profile that needs a rebuild (built under older privacy rules, or from a
 * row the broker has since made private) may have taken ANY of its content
 * from the broker's private notes — not only the free text (a seller story
 * quoting a CRM note) but the categories too: "Selling reason: health" from
 * a note about a heart episode, "Family involvement: spouse involved" from a
 * note about the wife doing the books. Until the background rebuild lands,
 * such a profile keeps only what the broker set by hand on it (their style
 * corrections are their own instructions for the interview) — every
 * AI-derived category, the free text and the list of sources it read are
 * dropped, deterministically, whatever the deal holds today.
 *
 * Any other profile loses pricing and negotiation text (including anything
 * the broker typed into it).
 */
export function profileSafeForInterview(
  profile: SellerCommunicationProfile | null,
  documents: Array<{ id?: string; visibility?: string | null }>,
): InterviewSellerProfile | null {
  if (!profile) return null;
  if (!sellerProfileNeedsRebuild(profile, documents)) return stripNegotiationText(profile);
  const base: Record<string, unknown> = { ...profile };
  for (const field of PROFILE_CATEGORY_FIELDS) delete base[field];
  return {
    ...(base as Omit<SellerCommunicationProfile, ProfileCategoryField>),
    ...brokerSetCategories(profile),
    sensitiveTopics: [],
    personalInsights: [],
    sellerStory: "",
    industryContext: "",
    dataSources: [],
    pendingRebuild: true,
  };
}

// A profile is about HOW to talk with the seller. Pricing and negotiation
// never belong in it: a sentence or item that talks about a price, an offer
// or a bottom line next to a dollar figure is dropped, whatever the model
// wrote (the inputs no longer carry the broker's price or private notes —
// this is the backstop).
const NEGOTIATION_RE = /\b(price|pricing|floor|offer|offers|negotiat\w*|walk[- ]away|bottom[- ]line|lowest|minimum|accept|take less|settle|valuation|worth)\b/i;
const MONEY_RE = /\$\s?\d|\b\d[\d,.]*\s?(k|m|mm|million|thousand)\b/i;
const isNegotiationText = (t: string) => NEGOTIATION_RE.test(t) && MONEY_RE.test(t);

/** Drops pricing/negotiation sentences and items from a profile's free text. */
export function stripNegotiationText(profile: SellerCommunicationProfile): SellerCommunicationProfile {
  // Sentences end at . ! ? followed by a space ("$1.8M" is one token).
  const sentences = (text: string) =>
    text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() && !isNegotiationText(s)).join(" ").trim();
  return {
    ...profile,
    sellerStory: sentences(profile.sellerStory || ""),
    industryContext: sentences(profile.industryContext || ""),
    sensitiveTopics: (profile.sensitiveTopics || []).filter((t) => !isNegotiationText(String(t))),
    personalInsights: (profile.personalInsights || []).filter((t) => !isNegotiationText(String(t))),
  };
}

// =====================
// Anthropic client
// =====================

// Lazy-init so env vars are resolved at call time, not module load time.
let _anthropic: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return _anthropic;
}

const PROFILER_MODEL = agentConfig.models.supportingAgents;

// =====================
// Tool definition for structured output
// =====================

const SELLER_PROFILE_TOOL = {
  name: "seller_communication_profile",
  description:
    "Return a structured Seller Communication Profile based on your analysis of all available data about this seller.",
  input_schema: {
    type: "object" as const,
    required: [
      "communicationStyle",
      "emotionalState",
      "sellingReason",
      "sophistication",
      "businessAttachment",
      "timeOrientation",
      "familyInvolvement",
      "sensitiveTopics",
      "personalInsights",
      "sellerStory",
      "industryContext",
    ],
    properties: {
      communicationStyle: {
        type: "string",
        enum: ["direct", "conversational", "formal", "guarded", "enthusiastic"],
        description:
          "How the seller naturally communicates. 'direct' = to the point, prefers efficiency. 'conversational' = likes to chat, tells stories, needs rapport. 'formal' = professional language, structured responses. 'guarded' = cautious, gives short answers, needs trust-building. 'enthusiastic' = energetic, proud of their business, likes to share.",
      },
      emotionalState: {
        type: "string",
        enum: ["motivated", "reluctant", "anxious", "grieving", "neutral", "excited"],
        description:
          "Current emotional posture toward the sale. 'motivated' = ready and wants to move forward. 'reluctant' = has reservations, may need convincing. 'anxious' = worried about the process or outcome. 'grieving' = emotionally difficult to let go. 'neutral' = pragmatic, business-as-usual. 'excited' = looking forward to what comes next.",
      },
      sellingReason: {
        type: "string",
        enum: [
          "retirement",
          "burnout",
          "health",
          "life_event",
          "opportunistic",
          "partnership_dispute",
          "growth_beyond_capability",
        ],
        description:
          "Primary reason for selling. Choose the most likely based on all available signals. 'life_event' covers divorce, relocation, family emergency. 'opportunistic' = market timing or unsolicited offer. 'growth_beyond_capability' = business has outgrown the owner's capacity.",
      },
      sophistication: {
        type: "string",
        enum: ["first_time_seller", "some_experience", "serial_entrepreneur"],
        description:
          "Experience level with business transactions. 'first_time_seller' = never sold a business before, may not understand the process. 'some_experience' = has been through acquisitions, partnerships, or partial sales. 'serial_entrepreneur' = has bought/sold multiple businesses.",
      },
      businessAttachment: {
        type: "string",
        enum: ["high", "medium", "low"],
        description:
          "How emotionally attached the seller is to the business. 'high' = founder identity is tied to the business, will struggle with letting go. 'medium' = cares but ready to move on. 'low' = purely transactional.",
      },
      timeOrientation: {
        type: "string",
        enum: ["patient", "moderate", "urgent"],
        description:
          "How much time pressure the seller feels. 'patient' = no rush, willing to wait for the right deal. 'moderate' = has a timeline but flexible. 'urgent' = needs to close quickly (health, financial pressure, life event).",
      },
      familyInvolvement: {
        type: "string",
        enum: ["family_business", "spouse_involved", "solo_operator", "partner_business"],
        description:
          "Family dynamics relevant to the sale. 'family_business' = multiple family members work in or own the business. 'spouse_involved' = spouse has opinions or stake in the sale. 'solo_operator' = owner operates independently. 'partner_business' = non-family business partner(s) involved.",
      },
      sensitiveTopics: {
        type: "array",
        items: { type: "string" },
        description:
          "Topics the interviewer should approach carefully. Examples: 'health issues driving the sale', 'family conflict about selling', 'financial stress or debt', 'recent death of a partner', 'divorce proceedings', 'employee layoff concerns', 'legal issues'. Be specific about WHY each topic is sensitive based on the data.",
      },
      personalInsights: {
        type: "array",
        items: { type: "string" },
        description:
          "Personal details that help the interviewer build rapport. Examples: 'built the business from scratch 25 years ago', 'extremely proud of their team and company culture', 'loves the craft/trade itself', 'has a succession plan for key employees', 'worried about what buyers will do to the brand'. These should be specific to this seller, not generic.",
      },
      sellerStory: {
        type: "string",
        description:
          "A 3-5 sentence narrative summary of who this seller is, what the business means to them, and why they are selling. Written in third person. This is the most important field — it gives the interview agent a human picture of who they are talking to. Should synthesize all available signals into a cohesive story.",
      },
      industryContext: {
        type: "string",
        description:
          "2-3 sentences about how this seller's industry shapes their perspective. For example, a restaurant owner may be exhausted by the hours; a construction company owner may be proud of their safety record; a medical practice owner may worry about patient continuity. This helps the interviewer use industry-relevant language.",
      },
    },
  },
} as const;

// =====================
// Data gathering
// =====================

interface GatheredData {
  brokerNotes: string | null;
  emailContent: string | null;
  transcriptContent: string | null;
  questionnaireData: string | null;
  scrapedData: string | null;
  businessName: string;
  industry: string;
  subIndustry: string | null;
}

/**
 * Gathers all available data sources for a deal.
 * Each source is converted to a text representation suitable for the analysis prompt.
 */
async function gatherDataSources(dealId: string): Promise<{
  data: GatheredData;
  sources: string[];
  confidenceScore: number;
  /** Rows whose text or name went into the analysis prompt. */
  documentIds: string[];
}> {
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  const sources: string[] = [];
  let availableSourceCount = 0;
  const totalPossibleSources = 5; // broker notes, emails, transcripts, questionnaire, scraped data

  // 1. Broker notes — from deal description and any other free-text fields
  let brokerNotes: string | null = null;
  const notesParts: string[] = [];

  if (deal.description && deal.description.trim().length > 0) {
    notesParts.push(`Deal Description:\n${deal.description}`);
  }
  // Not the broker's listed asking price: it is the broker's pricing
  // decision, which the interview never shows the seller (see
  // interviewFactView) — and the profile goes into the interview's prompt.
  const documentIds = new Set<string>();

  // Broker-only sources (CRM notes and activities, private emails) are the
  // broker's own notes — negotiation positions, private judgements, family
  // details the seller never shared with us. The profile goes into the
  // interview agent's prompt, and broker-only content must never reach the
  // seller through it, so NONE of it is read here. A CRM note the broker
  // explicitly shared is fine.
  let dealDocs: Awaited<ReturnType<typeof storage.getDocumentsByDeal>> = [];
  try {
    dealDocs = (await storage.getDocumentsByDeal(dealId)).filter((d) => d.visibility !== "broker_only");
  } catch {
    dealDocs = [];
  }
  const crmText = dealDocs
    .filter((d) => d.sourceKind === "crm" && d.extractedText && d.extractedText.trim())
    .map((d) => (documentIds.add(d.id), `--- ${d.name} ---\n${d.extractedText!.trim()}`))
    .join("\n\n")
    .slice(0, 12_000);
  if (crmText) {
    notesParts.push(
      `CRM notes the broker shared about the seller and the business (personal matters here — health, family, money — ` +
        `belong under sensitive topics: never something the interviewer raises):\n${crmText}`,
    );
  }

  if (notesParts.length > 0) {
    brokerNotes = notesParts.join("\n\n");
    sources.push("broker_notes");
    availableSourceCount++;
  }

  // 2. Email communications — the text of email sources on the deal (pasted,
  // uploaded or imported from the CRM), else the addresses from integrationEmails
  let emailContent: string | null = null;
  const emailText = dealDocs
    .filter((d) => d.sourceKind === "email" && d.extractedText && d.extractedText.trim())
    .map((d) => (documentIds.add(d.id), `--- ${d.name} ---\n${d.extractedText!.trim()}`))
    .join("\n\n")
    .slice(0, 12_000);
  if (emailText) {
    emailContent = `Emails on file:\n${emailText}`;
    sources.push("emails");
    availableSourceCount++;
  }
  try {
    const emails = await storage.getIntegrationEmailsByDeal(dealId);
    if (emails.length > 0 && !emailContent) {
      const emailSummary = emails
        .map((e) => `[${e.label || "Unknown"}] ${e.emailAddress}`)
        .join("\n");
      emailContent = `Email contacts associated with this deal:\n${emailSummary}`;
      sources.push("integration_emails");
      availableSourceCount++;
    }
  } catch {
    // Integration emails table may not have data — continue gracefully
  }

  // 3. Documents — look for transcripts specifically
  let transcriptContent: string | null = null;
  try {
    const docs = dealDocs; // shared sources only (see above)
    const transcripts = docs.filter((d) => d.category === "transcripts");

    if (transcripts.length > 0) {
      const transcriptTexts = transcripts
        .filter((t) => t.extractedText && t.extractedText.trim().length > 0)
        .map((t) => (documentIds.add(t.id), `--- Transcript: ${t.name} ---\n${t.extractedText}`))
        .join("\n\n");

      if (transcriptTexts.length > 0) {
        transcriptContent = transcriptTexts;
        sources.push("call_transcripts");
        availableSourceCount++;
      }
    }

    // Also check for any documents with extracted data that contain seller communications
    const docsWithData = docs.filter(
      (d) => d.category !== "transcripts" && d.extractedData && typeof d.extractedData === "object"
    );
    if (docsWithData.length > 0 && !emailContent) {
      // Supplement email content with document-extracted data if no direct emails
      const docSummary = docsWithData
        .map((d) => (documentIds.add(d.id), `[${d.category}] ${d.name}: processed`))
        .join("\n");
      if (!emailContent) {
        emailContent = `Processed documents on file:\n${docSummary}`;
        sources.push("processed_documents");
      }
    }
  } catch {
    // Continue gracefully if document queries fail
  }

  // 4. Questionnaire data
  let questionnaireData: string | null = null;
  if (deal.questionnaireData && typeof deal.questionnaireData === "object") {
    const qData = deal.questionnaireData as Record<string, unknown>;
    if (Object.keys(qData).length > 0) {
      questionnaireData = JSON.stringify(qData, null, 2);
      sources.push("seller_questionnaire");
      availableSourceCount++;
    }
  }

  // 5. Scraped data
  let scrapedData: string | null = null;
  if (deal.scrapedData && typeof deal.scrapedData === "object") {
    const sData = deal.scrapedData as Record<string, unknown>;
    if (Object.keys(sData).length > 0) {
      scrapedData = JSON.stringify(sData, null, 2);
      sources.push("internet_scrape");
      availableSourceCount++;
    }
  }

  // Calculate confidence score based on how many sources we have
  // Weighted: transcripts and questionnaire are most valuable for personality profiling
  let confidenceScore = 0;
  if (brokerNotes) confidenceScore += 0.15;
  if (emailContent) confidenceScore += 0.1;
  if (transcriptContent) confidenceScore += 0.35; // Transcripts are gold for personality signals
  if (questionnaireData) confidenceScore += 0.25; // Direct seller input
  if (scrapedData) confidenceScore += 0.15;

  // Ensure minimum confidence if we have at least broker notes
  if (availableSourceCount === 1 && brokerNotes) {
    confidenceScore = Math.max(confidenceScore, 0.2);
  }

  // Cap at 0.95 — we can never be 100% sure from text analysis alone
  confidenceScore = Math.min(confidenceScore, 0.95);

  return {
    data: {
      brokerNotes,
      emailContent,
      transcriptContent,
      questionnaireData,
      scrapedData,
      businessName: deal.businessName,
      industry: deal.industry,
      subIndustry: deal.subIndustry || null,
    },
    sources,
    confidenceScore,
    documentIds: Array.from(documentIds),
  };
}

// =====================
// Prompt construction
// =====================

function buildAnalysisPrompt(data: GatheredData): string {
  const sections: string[] = [];

  sections.push(`You are analyzing available data about a business seller to build a communication profile BEFORE their interview begins.

The business is "${data.businessName}" in the ${data.industry}${data.subIndustry ? ` (${data.subIndustry})` : ""} industry.

Your job is to read all available data and infer WHO this seller is as a person — their communication style, emotional state, motivations, sensitivities, and personal story. The interview agent will use your profile to adapt its tone, pacing, and approach.

IMPORTANT GUIDELINES:
- Base your analysis ONLY on signals present in the data. Do not fabricate details.
- If data is sparse, make reasonable inferences but lean toward neutral/moderate values.
- For sensitiveTopics, only flag topics where you see actual evidence of sensitivity.
- For personalInsights, only include insights grounded in the data.
- The sellerStory should be a coherent narrative that synthesizes what you know — it is okay for it to be brief if data is limited.
- If you cannot determine a field with any confidence, choose the most neutral/common option.
- This profile tells the interviewer HOW to talk with the seller. Never put prices, offers, valuations or negotiation positions in it, and nothing the seller would be surprised to hear the interviewer knows.

Here is all available data about this seller:`);

  if (data.brokerNotes) {
    sections.push(`\n--- BROKER NOTES ---
The broker who listed this deal provided the following notes and description. Brokers often include their personal observations about the seller, the reason for sale, and the business context.

${data.brokerNotes}`);
  }

  if (data.emailContent) {
    sections.push(`\n--- EMAIL / COMMUNICATION DATA ---
The following email or communication data is associated with this deal. Look for tone, formality, responsiveness, and any personal details.

${data.emailContent}`);
  }

  if (data.transcriptContent) {
    sections.push(`\n--- CALL TRANSCRIPTS ---
These are transcripts from calls with the seller. This is the richest source for personality signals. Pay attention to:
- How the seller speaks (formal vs casual, verbose vs concise)
- Emotional cues (enthusiasm, hesitation, sadness, frustration)
- What they volunteer vs what they avoid
- How they talk about their employees, customers, and the business itself
- Any mentions of why they are selling, family involvement, health, timeline pressure
- Their level of business sophistication (do they use financial jargon? understand deal structure?)

${data.transcriptContent}`);
  }

  if (data.questionnaireData) {
    sections.push(`\n--- SELLER QUESTIONNAIRE RESPONSES ---
The seller completed a structured questionnaire. Their answers reveal both factual information and personality signals. Notice:
- How detailed or sparse their answers are (engagement level)
- Whether they volunteer extra context or stick to minimums
- Any emotional language or personal commentary
- Topics they skipped or gave vague answers to (possible sensitivities)

${data.questionnaireData}`);
  }

  if (data.scrapedData) {
    sections.push(`\n--- PUBLICLY SCRAPED DATA ---
This data was scraped from the business's website and public sources. It provides context about the business itself, which helps you understand what the seller has built and may be emotionally attached to.

${data.scrapedData}`);
  }

  if (
    !data.brokerNotes &&
    !data.emailContent &&
    !data.transcriptContent &&
    !data.questionnaireData &&
    !data.scrapedData
  ) {
    sections.push(`\nNO DATA AVAILABLE — Only the business name and industry are known. Generate a minimal profile with neutral defaults. Set all sensitive/personal fields to empty arrays and use generic but reasonable values for the structured fields based on common patterns in the ${data.industry} industry.`);
  }

  sections.push(`\nNow analyze all available data and return a structured Seller Communication Profile using the seller_communication_profile tool.`);

  return sections.join("\n");
}

// =====================
// Default profile (fallback)
// =====================

function buildDefaultProfile(
  businessName: string,
  industry: string,
  subIndustry: string | null,
): SellerCommunicationProfile {
  return {
    communicationStyle: "conversational",
    emotionalState: "neutral",
    sellingReason: "retirement",
    sophistication: "first_time_seller",
    businessAttachment: "medium",
    timeOrientation: "moderate",
    familyInvolvement: "solo_operator",
    sensitiveTopics: [],
    personalInsights: [],
    sellerStory: `The owner of ${businessName} is preparing to sell their ${industry}${subIndustry ? ` (${subIndustry})` : ""} business. Limited information is available about their personal motivations and communication preferences at this time.`,
    industryContext: `${businessName} operates in the ${industry} industry. The interview agent should use industry-appropriate language and be attentive to sector-specific sensitivities as they emerge during the conversation.`,
    confidenceScore: 0.1,
    dataSources: [],
    generatedAt: new Date().toISOString(),
    privacyVersion: PROFILE_PRIVACY_VERSION,
    sourceDocumentIds: [],
  };
}

// =====================
// Core exports
// =====================

/**
 * Generates a Seller Communication Profile by analyzing all available data
 * sources for a deal. Uses Claude Sonnet with tool_use for structured output.
 *
 * Gracefully handles missing data — if only broker notes exist, it still
 * generates a profile with a lower confidence score. If no data at all,
 * returns a neutral default profile.
 */
export async function generateSellerProfile(
  dealId: string,
): Promise<SellerCommunicationProfile> {
  // Gather all available data
  const { data, sources, confidenceScore, documentIds } = await gatherDataSources(dealId);

  // If we have absolutely no data beyond business name/industry, return defaults
  if (sources.length === 0) {
    return buildDefaultProfile(data.businessName, data.industry, data.subIndustry);
  }

  // Build the analysis prompt
  const prompt = buildAnalysisPrompt(data);

  try {
    const response = await getAnthropicClient().messages.create(
      {
        model: PROFILER_MODEL,
        max_tokens: 2048,
        system:
          "You are an expert M&A psychologist and communication analyst. You analyze data about business sellers to build communication profiles that help interview agents adapt their approach. You are precise, empathetic, and grounded in evidence. Never fabricate details — only infer from what is present in the data.",
        tools: [SELLER_PROFILE_TOOL],
        tool_choice: { type: "tool", name: "seller_communication_profile" },
        messages: [{ role: "user", content: prompt }],
      },
      { timeout: 600_000 },
    );

    // Extract the structured response
    const toolUseBlock = response.content.find((block) => block.type === "tool_use");
    if (!toolUseBlock || toolUseBlock.type !== "tool_use") {
      console.warn(
        `[eq-profiler] Claude did not return a structured response for deal ${dealId}, using defaults`,
      );
      return buildDefaultProfile(data.businessName, data.industry, data.subIndustry);
    }

    const aiProfile = toolUseBlock.input as Record<string, unknown>;

    // Assemble the full profile with metadata
    const profile: SellerCommunicationProfile = {
      communicationStyle: validateEnum(
        aiProfile.communicationStyle as string,
        ["direct", "conversational", "formal", "guarded", "enthusiastic"],
        "conversational",
      ),
      emotionalState: validateEnum(
        aiProfile.emotionalState as string,
        ["motivated", "reluctant", "anxious", "grieving", "neutral", "excited"],
        "neutral",
      ),
      sellingReason: validateEnum(
        aiProfile.sellingReason as string,
        [
          "retirement",
          "burnout",
          "health",
          "life_event",
          "opportunistic",
          "partnership_dispute",
          "growth_beyond_capability",
        ],
        "retirement",
      ),
      sophistication: validateEnum(
        aiProfile.sophistication as string,
        ["first_time_seller", "some_experience", "serial_entrepreneur"],
        "first_time_seller",
      ),
      businessAttachment: validateEnum(
        aiProfile.businessAttachment as string,
        ["high", "medium", "low"],
        "medium",
      ),
      timeOrientation: validateEnum(
        aiProfile.timeOrientation as string,
        ["patient", "moderate", "urgent"],
        "moderate",
      ),
      familyInvolvement: validateEnum(
        aiProfile.familyInvolvement as string,
        ["family_business", "spouse_involved", "solo_operator", "partner_business"],
        "solo_operator",
      ),
      sensitiveTopics: Array.isArray(aiProfile.sensitiveTopics)
        ? (aiProfile.sensitiveTopics as string[])
        : [],
      personalInsights: Array.isArray(aiProfile.personalInsights)
        ? (aiProfile.personalInsights as string[])
        : [],
      sellerStory:
        typeof aiProfile.sellerStory === "string" && aiProfile.sellerStory.length > 0
          ? aiProfile.sellerStory
          : `The owner of ${data.businessName} is selling their ${data.industry} business.`,
      industryContext:
        typeof aiProfile.industryContext === "string" && aiProfile.industryContext.length > 0
          ? aiProfile.industryContext
          : `${data.businessName} operates in the ${data.industry} industry.`,
      confidenceScore,
      dataSources: sources,
      generatedAt: new Date().toISOString(),
      privacyVersion: PROFILE_PRIVACY_VERSION,
      sourceDocumentIds: documentIds,
    };

    return stripNegotiationText(profile);
  } catch (err) {
    console.error(`[eq-profiler] Failed to generate profile for deal ${dealId}:`, err);
    // Return a default profile rather than crashing the interview startup
    const fallback = buildDefaultProfile(data.businessName, data.industry, data.subIndustry);
    fallback.dataSources = sources;
    fallback.sourceDocumentIds = documentIds;
    fallback.confidenceScore = Math.max(confidenceScore * 0.5, 0.1);
    return fallback;
  }
}

/**
 * Renders the Seller Communication Profile as a human-readable markdown section
 * suitable for injection into the interview system prompt.
 *
 * Written as context for the interview agent, not as raw data.
 */
export function renderProfileForPrompt(profile: SellerCommunicationProfile): string {
  const lines: string[] = [];

  lines.push("## Seller Communication Profile");
  lines.push("");
  lines.push(
    `> **Confidence:** ${Math.round(profile.confidenceScore * 100)}% — based on ${profile.dataSources.length > 0 ? profile.dataSources.join(", ") : "no prior data"}`,
  );
  lines.push("");

  // Seller story — the most important piece
  lines.push("### Who you are talking to");
  lines.push("");
  lines.push(profile.sellerStory);
  lines.push("");

  // Communication approach
  lines.push("### How to communicate with this seller");
  lines.push("");

  const styleGuidance: Record<string, string> = {
    direct:
      "This seller prefers direct, efficient communication. Get to the point quickly. Avoid excessive small talk or over-explaining. They respect competence and brevity.",
    conversational:
      "This seller enjoys conversation and storytelling. Build rapport through genuine interest. Let them tell their story before narrowing in on specifics. They respond well to warmth and patience.",
    formal:
      "This seller communicates formally and professionally. Use polished language, structured questions, and respectful tone. Avoid casual language or overly familiar phrasing.",
    guarded:
      "This seller is cautious and may give short answers initially. Build trust gradually. Do not push too hard on sensitive topics early. Acknowledge their concerns and explain why information is needed before asking for it.",
    enthusiastic:
      "This seller is energetic and proud of their business. Channel their enthusiasm — let them share what they are proud of. Then guide the conversation to areas they may be less eager to discuss.",
  };
  lines.push(
    `- **Communication style:** ${profile.communicationStyle} — ${styleGuidance[profile.communicationStyle]}`,
  );

  const emotionalGuidance: Record<string, string> = {
    motivated: "Ready to move forward. Match their energy and keep momentum.",
    reluctant:
      "Has reservations about selling. Be empathetic, do not pressure. Help them see the value of thorough preparation regardless of their final decision.",
    anxious:
      "Worried about the process or outcome. Provide reassurance and explain what happens at each step. Normalize their concerns.",
    grieving:
      "Emotionally difficult to let go. Be patient and gentle. Acknowledge what they have built. Do not rush through emotional topics.",
    neutral: "Pragmatic and business-like. Straightforward approach works well.",
    excited:
      "Looking forward to the next chapter. Positive energy, but ensure they stay thorough and do not rush past important details.",
  };
  lines.push(
    `- **Emotional state:** ${profile.emotionalState} — ${emotionalGuidance[profile.emotionalState]}`,
  );

  const sophisticationGuidance: Record<string, string> = {
    first_time_seller:
      "Explain M&A concepts and processes as you go. Do not assume they know what SDE, EBITDA, or earn-outs mean. Frame the interview as helping them present their business in the best light.",
    some_experience:
      "Familiar with transactions but may not know all the details. Use M&A terminology where appropriate but define less common terms.",
    serial_entrepreneur:
      "Experienced with buying and selling businesses. Can handle technical M&A language. Focus on efficiency and depth rather than education.",
  };
  lines.push(
    `- **Sophistication:** ${profile.sophistication} — ${sophisticationGuidance[profile.sophistication]}`,
  );

  const timeGuidance: Record<string, string> = {
    patient: "No rush. Take time to be thorough.",
    moderate: "Has a general timeline. Keep the interview moving but do not feel pressured.",
    urgent:
      "Under time pressure. Be efficient. Prioritize the most critical information first and flag what can be gathered later.",
  };
  lines.push(`- **Time orientation:** ${profile.timeOrientation} — ${timeGuidance[profile.timeOrientation]}`);

  lines.push(
    `- **Business attachment:** ${profile.businessAttachment} — ${profile.businessAttachment === "high" ? "Deeply connected to the business. Treat it with the respect they feel it deserves." : profile.businessAttachment === "medium" ? "Cares about the business but ready to move on." : "Purely transactional. Focus on facts and efficiency."}`,
  );

  const reasonLabels: Record<string, string> = {
    retirement: "Retirement",
    burnout: "Burnout / fatigue",
    health: "Health concerns",
    life_event: "Life event (divorce, relocation, family change)",
    opportunistic: "Opportunistic (market timing or unsolicited offer)",
    partnership_dispute: "Partnership dispute",
    growth_beyond_capability: "Business has outgrown the owner's capacity",
  };
  lines.push(`- **Selling reason:** ${reasonLabels[profile.sellingReason] || profile.sellingReason}`);

  const familyLabels: Record<string, string> = {
    family_business: "Family business — other family members are involved. Be mindful of family dynamics.",
    spouse_involved: "Spouse is involved in or has opinions about the sale. Decision-making may be shared.",
    solo_operator: "Solo operator — decisions are theirs alone.",
    partner_business: "Has business partner(s). Alignment between partners may be a factor.",
  };
  lines.push(`- **Family involvement:** ${familyLabels[profile.familyInvolvement]}`);
  lines.push("");

  // Industry context
  lines.push("### Industry context");
  lines.push("");
  lines.push(profile.industryContext);
  lines.push("");

  // Sensitive topics — critical for the interviewer
  if (profile.sensitiveTopics.length > 0) {
    lines.push("### Sensitive topics (approach with care)");
    lines.push("");
    for (const topic of profile.sensitiveTopics) {
      lines.push(`- ${topic}`);
    }
    lines.push("");
  }

  // Personal insights — rapport builders
  if (profile.personalInsights.length > 0) {
    lines.push("### Personal insights (use for rapport)");
    lines.push("");
    for (const insight of profile.personalInsights) {
      lines.push(`- ${insight}`);
    }
    lines.push("");
  }

  // Broker overrides notice
  if (profile.brokerOverrides && Object.keys(profile.brokerOverrides).length > 0) {
    lines.push("### Broker corrections applied");
    lines.push("");
    lines.push(
      "The broker has reviewed and corrected parts of this profile. The values above reflect those corrections.",
    );
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Updates an existing Seller Communication Profile with broker corrections.
 * Loads the deal, applies overrides, and returns the updated profile.
 *
 * Broker overrides take precedence over AI-generated values. The original
 * AI values are preserved in the brokerOverrides field for audit.
 */
export async function updateProfileWithBrokerOverrides(
  dealId: string,
  overrides: Partial<SellerCommunicationProfile>,
): Promise<SellerCommunicationProfile> {
  // Load the existing profile from the deal
  const deal = await storage.getDeal(dealId);
  if (!deal) throw new Error(`Deal ${dealId} not found`);

  // Retrieve existing profile or generate a fresh one
  let profile: SellerCommunicationProfile;
  const existingProfile = (deal as any).sellerProfile as SellerCommunicationProfile | null;

  if (existingProfile && typeof existingProfile === "object" && existingProfile.generatedAt) {
    profile = existingProfile;
  } else {
    profile = await generateSellerProfile(dealId);
  }

  // Track what the broker is overriding
  const previousOverrides = profile.brokerOverrides || {};
  const newOverrides: Record<string, any> = { ...previousOverrides };

  // Apply each override, recording the original AI value
  for (const [key, value] of Object.entries(overrides)) {
    if (key === "brokerOverrides" || key === "confidenceScore" || key === "dataSources" || key === "generatedAt") {
      // Do not allow overriding metadata fields
      continue;
    }
    if (value !== undefined) {
      // Record the original AI value before overriding
      if (!(key in newOverrides)) {
        newOverrides[key] = { originalValue: (profile as any)[key], brokerValue: value };
      } else {
        newOverrides[key] = { ...newOverrides[key], brokerValue: value };
      }
      (profile as any)[key] = value;
    }
  }

  profile.brokerOverrides = newOverrides;

  // Boost confidence slightly when broker provides corrections — human input is valuable
  profile.confidenceScore = Math.min(profile.confidenceScore + 0.1, 0.98);

  return profile;
}

// =====================
// Utilities
// =====================

/**
 * Validates that a string value is one of the allowed enum values.
 * Returns the default if the value is invalid or missing.
 */
function validateEnum<T extends string>(value: string | undefined | null, allowed: T[], defaultValue: T): T {
  if (value && allowed.includes(value as T)) {
    return value as T;
  }
  return defaultValue;
}
