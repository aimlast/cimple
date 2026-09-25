import type { Deal, Document, Task, InterviewSession, ExtractedInfo, Discrepancy } from "@shared/schema";
import { CIM_SECTIONS } from "@shared/schema";
import type { SectionImportanceLevel, SectionImportanceMap } from "@shared/schema";
import { getSectionImportance, renderSectionImportanceForPrompt } from "./section-importance";
import { getInterviewOutline, renderOutlineForPrompt } from "./outline";
import { coverageAdjustmentsForDeal } from "./interview-plan";
import type { InterviewOutline } from "@shared/schema";
import type { SellerCommunicationProfile } from "./eq-profiler";
import { getFieldSources, isSourceKind, repairCharIndexedValue, type FieldSource } from "./info-merger";

// =====================
// Types
// =====================

export interface KnowledgeBase {
  // Business identity
  business: {
    name: string;
    industry: string;
    subIndustry: string | null;
    description: string | null;
    location: LocationContext | null;
  };

  // Everything we know, organized by CIM section
  sectionCoverage: SectionCoverage[];
  /** Per-section buyer importance for this deal (base or industry-ranked). */
  sectionImportance: SectionImportanceMap;
  /** Broker's plain-language adjustments to the interview plan. */
  outline: InterviewOutline;
  /** Who is running this session — the seller alone, or a broker with the seller on a call. */
  conductedBy: "seller" | "broker_with_seller";

  // Industry-specific context (populated once industry + location are known)
  industryContext: IndustryContext | null;

  // Seller Communication Profile — EQ profiler output (generated pre-interview)
  sellerProfile: SellerCommunicationProfile | null;

  // What the seller told us in the questionnaire before the interview
  questionnaireData: Record<string, unknown> | null;

  // Operational systems the seller uses (guides retrieval instructions)
  operationalSystems: OperationalSystems | null;

  // Documents uploaded for this deal
  documents: DocumentSummary[];

  // Outstanding tasks (follow-ups, skipped questions, doc requests)
  outstandingTasks: TaskSummary[];

  // Prior interview sessions (if resuming)
  priorSessionSummary: PriorSessionSummary | null;

  // Raw extracted info (the flat key-value store from the schema)
  extractedInfo: Partial<ExtractedInfo>;

  // Publicly scraped data — UNVERIFIED, must be confirmed with seller during interview
  scrapedData: Record<string, string> | null;
  scrapeSource: "website" | "internet_search" | "website_and_internet" | null;

  // Discrepancies the broker routed to the interview ("Ask the seller").
  // The agent must probe these naturally as priority topics — answers flow
  // back through normal extraction. Optional because KBs persisted before
  // this field existed (and test fixtures) lack it.
  askSellerDiscrepancies?: AskSellerDiscrepancy[];

  // Open entries from the durable deferral ledger (session-manager sets this
  // per turn). Rendered into the dynamic prompt so the agent always sees its
  // outstanding items and can circle back. Optional for old callers/fixtures.
  openDeferrals?: Array<{
    topic: string;
    reason: string;
    whereInfoLives: string;
    createdAtTurn: number;
    /** Seller explicitly declined — hard-blocked from re-asking */
    declined?: boolean;
  }>;

  // Per-field confidence from the interview session (_confidenceLevels).
  // Fields WITHOUT an entry were sourced from documents/questionnaire and
  // must be presented as already-known (verify, never re-ask). Optional for
  // old callers/fixtures.
  fieldConfidence?: Record<string, string>;

  // Where each known fact came from, as the bracketed label the agent sees
  // ("from document: 2024 P&L.pdf", "from the broker's CRM notes — …").
  // Built from extractedInfo._fieldSources. Optional for old callers/fixtures.
  factSourceLabels?: Record<string, string>;
}

export interface AskSellerDiscrepancy {
  field: string;
  valueA: string | null; // e.g. "898,079 — Workbook (internal statements)"
  valueB: string | null; // e.g. "$980,830 — Seller interview"
  severity: string;
  explanation: string | null;
  suggestedResolution: string | null;
  /** One side came from a broker-only source (CRM note, private email/file):
   *  confirm the figure with the seller, never mention or quote that source. */
  privateSource?: boolean;
}

export interface LocationContext {
  country: string | null;
  stateProvince: string | null;
  municipality: string | null;
  raw: string | null; // The original location string if we can't parse it
}

export interface SectionCoverage {
  key: string;
  title: string;
  order: number;
  status: "well_covered" | "partial" | "missing";
  /** How much this section matters to buyers of this business. */
  importance: SectionImportanceLevel;
  importanceReason: string;
  // Which extracted fields map to this section and their current values
  fields: Array<{
    fieldName: string;
    /** Human label (industry checklist items and broker-added items). */
    label?: string;
    /** Came from the industry checklist or the broker, not the generic map. */
    industrySpecific?: boolean;
    critical?: boolean;
    value: string | null;
    confidence: "confirmed" | "inferred" | "approximate" | "unknown";
  }>;
}

/** Per-deal additions/removals to the generic section fields (industry checklist + broker edits). */
export interface CoverageFieldAdjustments {
  add?: Record<string, { key: string; label: string; critical?: boolean; alias?: string | null }[]>;
  remove?: ReadonlySet<string>;
}

export interface IndustryContext {
  industry: string;
  subIndustry: string | null;
  location: LocationContext | null;
  // These are generated by the AI on the first turn once industry is identified.
  // We store them so the system prompt can reference them on subsequent turns.
  industrySpecificAreas: string[];
  // Industry topics already adequately covered — accumulated across turns.
  // Optional because sessions persisted before this field existed lack it.
  coveredIndustryTopics?: string[];
  regulatoryNotes: string[];
}

export interface OperationalSystems {
  accounting: string | null;
  crm: string | null;
  pos: string | null;
  erp: string | null;
  payroll: string | null;
  other: string[];
}

export interface DocumentSummary {
  id: string;
  name: string;
  category: string;
  subcategory: string | null;
  status: string;
  isProcessed: boolean;
  hasExtractedText: boolean;
  hasExtractedData: boolean;
}

export interface TaskSummary {
  id: string;
  type: string;
  title: string;
  description: string | null;
  relatedField: string | null;
  status: string;
  priority: string;
  aiAttempts: number | null;
  aiExplanation: string | null;
}

export interface PriorSessionSummary {
  sessionId: string;
  questionsAsked: number | null;
  questionsAnswered: number | null;
  questionsSkipped: number | null;
  lastActivityAt: Date;
  status: string;
}

// =====================
// Section-to-field mapping
// =====================

// Maps each CIM section to the extractedInfo fields that populate it.
// This is how we determine coverage per section.
export const SECTION_FIELD_MAP: Record<string, string[]> = {
  overview: [
    "businessName", "industry", "companyHistory", "yearsOperating",
    "entityType", "brandIdentity", "missionStatement", "coreValues",
    "ownershipHistory", "industryPerception", "customerPerception", "accolades",
  ],
  strengths: [
    "competitiveAdvantage", "uniqueSellingProposition", "strengths",
  ],
  growth_potential: [
    "growthOpportunities", "expansionPlans",
  ],
  target_market: [
    "targetMarket", "primaryMarket", "secondaryMarket",
    "b2bBreakdown", "customerDemographics", "customerBase",
  ],
  permits_licenses: [
    "permitsLicenses", "complianceRequirements",
  ],
  seasonality: [
    "seasonality", "peakPeriods", "slowPeriods",
  ],
  revenue_sources: [
    "revenueStreams", "keyProducts", "customerConcentration",
    "annualRevenue", "revenueGrowth", "operatingMargins",
  ],
  real_estate: [
    "leaseDetails", "propertyInfo", "realEstateIncluded",
  ],
  employees: [
    "employees", "employeeStructure", "keyEmployees", "ownerInvolvement",
    "managementTeam",
  ],
  operations: [
    "suppliers", "supplyChain", "technologySystems", "operationalSystems",
  ],
  buyer_profile: [
    "idealBuyer",
  ],
  training_support: [
    "trainingSupport", "transitionPlan",
  ],
  reason_for_sale: [
    "reasonForSale",
  ],
  financials: [
    "annualRevenue", "revenueGrowth", "operatingMargins",
    "workingCapital", "debt",
  ],
  asking_price: [
    "askingPrice", "saleType", "assetsIncluded", "inventory",
  ],
};

/**
 * Every extractedInfo field that participates in section coverage. Used by
 * the questionnaire seeder to decide which (canonicalised) intake answers are
 * worth copying into extractedInfo.
 */
export const KNOWN_EXTRACTED_FIELDS: ReadonlySet<string> = new Set(
  Object.values(SECTION_FIELD_MAP).flat(),
);

// =====================
// Knowledge base assembly
// =====================

export function assembleKnowledgeBase(
  deal: Deal,
  documents: Document[],
  tasks: Task[],
  latestSession: InterviewSession | null,
  resolvedDiscrepancies: Discrepancy[] = [],
): KnowledgeBase {
  const baseExtractedInfo = (deal.extractedInfo as Partial<ExtractedInfo>) || {};
  const questionnaireData = deal.questionnaireData as Record<string, unknown> | null;

  // Overlay resolved discrepancy values — corrected values win over raw extractedInfo
  // so the interview agent never re-asks for or builds on stale numbers the broker
  // already reconciled against uploaded documents. (ask_seller rows have no
  // resolvedValue, so they never overlay — they become priority topics below.)
  const extractedInfo: Partial<ExtractedInfo> = { ...baseExtractedInfo };
  for (const d of resolvedDiscrepancies) {
    if (d.resolvedValue && d.field) {
      (extractedInfo as Record<string, unknown>)[d.field] = d.resolvedValue;
    }
  }

  // Discrepancies the broker explicitly routed to the interview
  const askSellerDiscrepancies: AskSellerDiscrepancy[] = resolvedDiscrepancies
    .filter((d) => d.status === "ask_seller")
    .map((d) => ({
      field: d.field,
      valueA: d.interviewValue,
      valueB: d.documentValue,
      severity: d.severity,
      explanation: d.aiExplanation,
      suggestedResolution: d.suggestedResolution,
      privateSource:
        (!!d.documentId && documents.some((doc) => doc.id === d.documentId && doc.visibility === "broker_only")) || undefined,
    }));

  // Per-field confidence lives on the session (interview turns write it) —
  // used to label coverage fields honestly instead of hardcoding "confirmed".
  const sessionMeta = (latestSession?.extractedInfo as Record<string, unknown> | null) || {};
  const confidenceLevels = (sessionMeta._confidenceLevels as Record<string, string> | undefined) ?? undefined;

  // The real source of every known fact, labelled for the agent. Broker-only
  // sources (CRM notes, private emails) are labelled so the agent confirms
  // the fact with the seller without ever citing or quoting the source.
  const factSourceLabels = buildFactSourceLabels(baseExtractedInfo as Record<string, unknown>, documents, confidenceLevels);
  for (const d of resolvedDiscrepancies) {
    if (d.resolvedValue && d.field) factSourceLabels[d.field] = "confirmed by the broker";
  }
  // Buyer importance per section — the industry-ranked map when one exists
  // for the deal's current industry, otherwise the base defaults.
  const sectionImportance = getSectionImportance(deal);
  const outline = getInterviewOutline(deal);

  return {
    business: {
      name: deal.businessName,
      industry: deal.industry,
      subIndustry: deal.subIndustry,
      description: deal.description,
      location: parseLocation(deal, questionnaireData),
    },
    sectionCoverage: buildSectionCoverage(extractedInfo, confidenceLevels, sectionImportance, outline.excludedSections, coverageAdjustmentsForDeal(deal)),
    sectionImportance,
    outline,
    conductedBy: sessionMeta._conductedBy === "broker_with_seller" ? "broker_with_seller" : "seller",
    industryContext: null, // Set by the AI on first turn, stored on session
    sellerProfile: (deal.sellerProfile as SellerCommunicationProfile | null) || null,
    questionnaireData,
    operationalSystems: parseOperationalSystems(deal),
    // Broker-only sources are never named to the seller.
    documents: documents.filter((d) => d.visibility !== "broker_only").map(summarizeDocument),
    outstandingTasks: tasks
      .filter((t) => t.status === "pending" || t.status === "in_progress")
      .map(summarizeTask),
    priorSessionSummary: latestSession ? summarizeSession(latestSession) : null,
    extractedInfo,
    scrapedData: (deal.scrapedData as Record<string, string> | null) || null,
    scrapeSource: (deal.scrapeSource as "website" | "internet_search" | "website_and_internet" | null) || null,
    askSellerDiscrepancies,
    fieldConfidence: confidenceLevels,
    factSourceLabels,
  };
}

function shortDate(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return typeof value === "string" ? value : null;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

/**
 * The bracketed source label for each known fact, e.g. "from the seller in
 * the interview — confirmed", "from document: 2024 Compilation.pdf",
 * "from an email, Mar 3, 2026", "from the website — unverified".
 */
export function buildFactSourceLabels(
  info: Record<string, unknown>,
  documents: Pick<Document, "id" | "name" | "createdAt" | "sourceKind" | "sourceMeta" | "visibility">[],
  confidenceLevels?: Record<string, string>,
): Record<string, string> {
  const sources = getFieldSources(info);
  const docs = new Map(documents.map((d) => [d.id, d]));
  const out: Record<string, string> = {};
  for (const key of Object.keys(info)) {
    if (key.startsWith("_")) continue;
    const conf = confidenceLevels?.[key];
    out[key] = describeFactSource(sources[key], docs, conf);
  }
  return out;
}

function describeFactSource(
  src: FieldSource | undefined,
  docs: Map<string, Pick<Document, "id" | "name" | "createdAt" | "sourceKind" | "sourceMeta" | "visibility">>,
  conf: string | undefined,
): string {
  const withConf = (base: string) => (conf ? `${base} — ${conf}` : base);
  if (!src || !isSourceKind(src.source)) {
    // Untracked legacy value: the seller's interview answer when the session
    // has a confidence for it, otherwise something on file before this interview.
    return conf ? `seller ${conf}` : "on file before this interview";
  }
  const doc = src.documentId ? docs.get(src.documentId) : undefined;
  const brokerOnly = doc?.visibility === "broker_only";
  const docDate = shortDate((doc?.sourceMeta as { date?: string } | null)?.date ?? doc?.createdAt ?? src.at ?? null);
  switch (src.source) {
    case "interview":
      return withConf("from the seller in the interview");
    case "call":
      return doc ? `from a call transcript with the seller${docDate ? `, ${docDate}` : ""}` : withConf("from a call with the broker");
    case "video_call":
      return doc ? `from a video-call transcript with the seller${docDate ? `, ${docDate}` : ""}` : withConf("from a video call with the broker");
    case "questionnaire":
      return "from the seller's intake questionnaire";
    case "broker":
      return "confirmed by the broker";
    case "crm":
      return "from the broker's CRM notes — confirm with the seller; never mention the CRM or quote it";
    case "website":
      return "from the website — unverified";
    case "social":
      return "from social media — unverified";
    case "email":
      if (brokerOnly) return "from the broker's private notes — confirm with the seller; never mention or quote the source";
      return `from an email${docDate ? `, ${docDate}` : ""}`;
    case "document":
    default:
      if (brokerOnly) return "from the broker's private notes — confirm with the seller; never mention or quote the source";
      return doc ? `from document: ${doc.name}` : "from an uploaded document";
  }
}

// =====================
// Rendering for system prompt injection
// =====================

export function renderKnowledgeBaseForPrompt(kb: KnowledgeBase): string {
  const parts: string[] = [];

  // Broker-routed discrepancies — highest-priority topics for this interview
  if ((kb.askSellerDiscrepancies ?? []).length > 0) {
    parts.push(`## 🔴 PRIORITY: DISCREPANCIES THE BROKER NEEDS CLARIFIED`);
    parts.push(`Our financial analysis found conflicting values across the deal's sources (documents, tax returns, workbook, prior statements). The broker has asked YOU to clarify these with the seller during this interview.`);
    parts.push(``);
    parts.push(`HOW TO HANDLE THESE (critical):`);
    parts.push(`- Raise each one naturally at a relevant moment — NEVER read them out as a list, and NEVER sound accusatory. The seller usually has an innocent explanation (gross vs net, timing, different basis of accounting).`);
    parts.push(`- Frame it as making sure the CIM is accurate: "I want to make sure we present this correctly — I've seen slightly different revenue figures in the documents..."`);
    parts.push(`- When the seller explains, capture the corrected/confirmed value as a normal extracted field so it flows into the knowledge base.`);
    parts.push(`- These take priority over routine gap-filling questions. Cover them before ending the interview.`);
    parts.push(``);
    for (const d of kb.askSellerDiscrepancies!) {
      parts.push(`- ${d.field} [${d.severity}]`);
      if (d.valueA) parts.push(`    Value 1: ${d.valueA}`);
      if (d.valueB) parts.push(`    Value 2: ${d.valueB}`);
      if (d.explanation) parts.push(`    Why it matters: ${d.explanation}`);
      if (d.suggestedResolution) parts.push(`    Suggested approach: ${d.suggestedResolution}`);
      if (d.privateSource) parts.push(`    ⚠ One value comes from the broker's private notes (CRM). Ask the seller to confirm the figure in your own words — never mention the CRM, the broker's notes or any document, and never quote the explanation above.`);
    }
    parts.push(``);
  }

  // Scraped data — shown first so the agent is primed to verify it
  if (kb.scrapedData && Object.keys(kb.scrapedData).length > 0) {
    const sourceLabel = kb.scrapeSource === "website"
      ? "the business's public website"
      : kb.scrapeSource === "website_and_internet"
        ? "the business's public website and public internet search results (reviews, directories, news, social media)"
        : "public internet search results (directories, news, review sites)";

    parts.push(`## ⚠️ PUBLICLY FOUND DATA — UNVERIFIED`);
    parts.push(`The following was found on ${sourceLabel} BEFORE the interview. It has NOT been confirmed by the seller.`);
    parts.push(``);
    parts.push(`YOUR JOB: Verify these facts naturally during the interview. Do not list them all at once.`);
    parts.push(`Weave verification into conversation: "I noticed on your website that you've been in business since 2010 — is that right?" or "I saw online that you have two locations — can you confirm that?"`);
    parts.push(`When the seller confirms → extract the field as confirmed. When they correct → use their version. When they say it's wrong → note it and use their answer.`);
    parts.push(``);
    for (const [key, value] of Object.entries(kb.scrapedData)) {
      parts.push(`- ${key}: "${value}"  [UNVERIFIED — confirm with seller]`);
    }
    parts.push(``);
  }

  // ALREADY-KNOWN facts — every populated extractedInfo key, whatever its
  // source. Doc-extracted values used to render only inside section coverage
  // (and ad-hoc doc keys not at all), so the agent treated them as background
  // and re-asked them — sellers noticed every time. This block makes every
  // known fact first-class with a hard do-not-re-ask imperative.
  {
    const known = Object.entries(kb.extractedInfo).filter(
      ([k, v]) => !k.startsWith("_") && isSubstantiveValue(v),
    );
    if (known.length > 0) {
      const conf = kb.fieldConfidence ?? {};
      parts.push(`## ⛔ ALREADY ANSWERED — DO NOT RE-ASK. CONFIRM OR DEEPEN ONLY.`);
      parts.push(`Every fact below is already on file (from uploaded documents, emails, calls, the questionnaire, the broker, or earlier conversation) — each is labelled with where it came from. Before EVERY question you ask, scan this list:`);
      parts.push(`- If the fact you need is here, do NOT ask for it. Cite it and ask only for what is genuinely new (the delta): "Your P&L shows a 72/28 Shopify/Amazon split — has that shifted this year?"`);
      parts.push(`- Values that did not come from the seller in this interview (documents, emails, call transcripts, the questionnaire, the broker, or anything marked "on file before this interview") came in separately: treat them as ALREADY PROVIDED. You may verify one naturally in passing, never re-ask it as an open question.`);
      parts.push(`- Values marked "unverified" or "confirm with the seller" are leads, not facts: confirm them naturally in passing (still never as an open re-ask). When a label says never to mention or quote its source, don't — ask as if you simply want to confirm the detail.`);
      parts.push(`- Your suggestedAnswers must be consistent with these values — never offer a guess at a number already on file.`);
      parts.push(`- When capturing new fields, REUSE these exact key names when the concept matches; only mint a new key for a genuinely new concept.`);
      parts.push(``);
      const sourceLabels = kb.factSourceLabels ?? {};
      for (const [key, rawValue] of known) {
        const value = repairCharIndexedValue(rawValue);
        const sessionConf = conf[key];
        const label = sourceLabels[key]
          ?? (sessionConf ? `seller ${sessionConf}` : "from documents/questionnaire");
        parts.push(`- ${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}  [${label}]`);
      }
      parts.push(``);
    }
  }

  // Open deferral ledger — the agent's own outstanding items, durable across
  // turns. Without this the model forgot its deferrals and never circled back.
  if ((kb.openDeferrals ?? []).length > 0) {
    parts.push(`## OPEN DEFERRALS (your outstanding items — durable ledger)`);
    parts.push(`These topics were raised and set aside earlier in THIS interview (the turn number shows when — never describe one as coming from a prior session). They are NOT resolved. A deferral only resolves when the information itself is obtained — creating a broker task or document request keeps it OPEN. Circle back when a natural opening appears: if the seller likely knows the answer but was hesitant (rather than the data living purely in a document), make ONE later conversational re-attempt with a lower-stakes reframe — especially if the seller invites it ("anything else?"). When one is resolved, list its topic in reasoning.resolvedDeferrals.`);
    for (const d of kb.openDeferrals!) {
      const where = d.whereInfoLives ? ` (info lives: ${d.whereInfoLives})` : "";
      const why = d.reason ? ` — ${d.reason}` : "";
      const ban = d.declined
        ? ` ⛔ DECLINED by the seller — do NOT re-ask this session under any circumstances (not even as the closing question); the broker will handle it. Only if the seller re-opens it themselves may you follow up.`
        : "";
      parts.push(`- [turn ${d.createdAtTurn}] ${d.topic}${why}${where}${ban}`);
    }
    parts.push(``);
  }

  // Broker-private notes — the agent must remember what it promised to keep
  // out of documents, so it never re-asks or contradicts itself. Never quoted
  // back to the seller unprompted, never in any CIM.
  const privateNotes = (kb.extractedInfo as Record<string, unknown>)._brokerPrivateNotes;
  if (Array.isArray(privateNotes) && privateNotes.length > 0) {
    parts.push(`## BROKER-PRIVATE NOTES (already recorded — broker's eyes only, NEVER in a CIM)`);
    parts.push(
      `You already hold these sensitive facts. Do not re-ask about them, do not repeat them to the seller unprompted, and never let them into CIM-facing fields.`,
    );
    for (const n of privateNotes as { note: string; reason?: string }[]) {
      parts.push(`- ${n.note}${n.reason ? ` (${n.reason})` : ""}`);
    }
    parts.push(``);
  }

  // Business identity
  parts.push(`## Business Profile`);
  parts.push(`- Name: ${kb.business.name}`);
  parts.push(`- Industry: ${kb.business.industry}${kb.business.subIndustry ? ` (${kb.business.subIndustry})` : ""}`);
  if (kb.business.description) {
    parts.push(`- Description: ${kb.business.description}`);
  }
  if (kb.business.location) {
    const loc = kb.business.location;
    const locParts = [loc.municipality, loc.stateProvince, loc.country].filter(Boolean);
    if (locParts.length > 0) {
      parts.push(`- Location: ${locParts.join(", ")}`);
    } else if (loc.raw) {
      parts.push(`- Location: ${loc.raw}`);
    }
  }

  // Seller Communication Profile (EQ profiler output)
  if (kb.sellerProfile) {
    parts.push("");
    parts.push(`## Seller Communication Profile`);
    parts.push(`This profile was generated from broker notes, prior communications, and available data about the seller.`);
    parts.push(`Use it to adapt your tone, pacing, and approach. Do NOT reference this profile directly to the seller.`);
    parts.push(``);
    parts.push(`- Communication style: ${kb.sellerProfile.communicationStyle}`);
    parts.push(`- Emotional state: ${kb.sellerProfile.emotionalState}`);
    parts.push(`- Selling reason: ${kb.sellerProfile.sellingReason}`);
    parts.push(`- Seller sophistication: ${kb.sellerProfile.sophistication}`);
    parts.push(`- Business attachment: ${kb.sellerProfile.businessAttachment}`);
    parts.push(`- Time orientation: ${kb.sellerProfile.timeOrientation}`);
    parts.push(`- Family involvement: ${kb.sellerProfile.familyInvolvement}`);

    if (kb.sellerProfile.sensitiveTopics.length > 0) {
      parts.push(`\nSensitive topics — handle with extreme care, never bring up directly:`);
      kb.sellerProfile.sensitiveTopics.forEach((t) => parts.push(`  - ${t}`));
    }

    if (kb.sellerProfile.personalInsights.length > 0) {
      parts.push(`\nPersonal insights — use for subtle, natural personalization (never as compliments):`);
      kb.sellerProfile.personalInsights.forEach((i) => parts.push(`  - ${i}`));
    }

    if (kb.sellerProfile.sellerStory) {
      parts.push(`\nSeller background story:`);
      parts.push(kb.sellerProfile.sellerStory);
    }

    if (kb.sellerProfile.industryContext) {
      parts.push(`\nIndustry-specific seller behavior context:`);
      parts.push(kb.sellerProfile.industryContext);
    }
    parts.push(``);
  }

  // Questionnaire data (what the seller already provided before the interview)
  if (kb.questionnaireData && Object.keys(kb.questionnaireData).length > 0) {
    parts.push("");
    parts.push(`## Pre-Interview Questionnaire Answers`);
    parts.push(`The seller already provided these answers in the intake questionnaire. DO NOT re-ask for this information — confirm it or build on it.`);
    for (const [key, value] of Object.entries(kb.questionnaireData)) {
      if (value !== null && value !== undefined && value !== "") {
        parts.push(`- ${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`);
      }
    }
  }

  // Operational systems (for retrieval instructions)
  if (kb.operationalSystems) {
    const systems = kb.operationalSystems;
    const knownSystems: string[] = [];
    if (systems.accounting) knownSystems.push(`Accounting: ${systems.accounting}`);
    if (systems.crm) knownSystems.push(`CRM: ${systems.crm}`);
    if (systems.pos) knownSystems.push(`POS: ${systems.pos}`);
    if (systems.erp) knownSystems.push(`ERP: ${systems.erp}`);
    if (systems.payroll) knownSystems.push(`Payroll: ${systems.payroll}`);
    if (systems.other.length > 0) knownSystems.push(`Other: ${systems.other.join(", ")}`);

    if (knownSystems.length > 0) {
      parts.push("");
      parts.push(`## Seller's Operational Systems`);
      parts.push(`Use these to give specific retrieval instructions when the seller doesn't know where to find information.`);
      knownSystems.forEach((s) => parts.push(`- ${s}`));
    }
  }

  // Section priorities + coverage
  parts.push("");
  parts.push(renderSectionImportanceForPrompt(kb.sectionImportance));
  const outlineBlock = renderOutlineForPrompt(kb.outline);
  if (outlineBlock) {
    parts.push("");
    parts.push(outlineBlock);
  }
  parts.push("");
  parts.push(`## CIM Section Coverage`);
  parts.push(`This shows what information we have for each CIM section. Focus on "missing" and "partial" sections — critical ones first. Items with a label in brackets are this industry's specific data points (or ones the broker added): when the seller answers one, record it in extractedFields under EXACTLY that key (e.g. operatoryCount), so the broker's checklist ticks it off.`);

  for (const section of kb.sectionCoverage) {
    const icon = section.status === "well_covered" ? "[COVERED]"
      : section.status === "partial" ? "[PARTIAL]"
      : "[MISSING]";

    parts.push(`\n### ${icon} ${section.title} — ${section.importance.toUpperCase()}`);

    if (section.fields.length === 0) {
      parts.push(`  No data captured yet.`);
      continue;
    }

    for (const field of section.fields) {
      const name = field.label ? `${field.fieldName} (${field.label}${field.critical ? " — CRITICAL for this industry" : ""})` : field.fieldName;
      if (field.value) {
        parts.push(`  - ${name}: ${field.value} (${field.confidence})`);
      } else {
        parts.push(`  - ${name}: NOT YET CAPTURED`);
      }
    }
  }

  // Documents
  if (kb.documents.length > 0) {
    parts.push("");
    parts.push(`## Uploaded Documents`);
    parts.push(`These documents have been uploaded for this deal. Do NOT ask the seller to upload documents they've already provided. Facts extracted from processed documents already appear in the ALREADY ANSWERED list above — asking the seller for them reads as "you didn't look at what I sent you" and destroys trust.`);
    for (const doc of kb.documents) {
      const status = doc.isProcessed ? "processed" : doc.status;
      const extracted = doc.hasExtractedData || doc.hasExtractedText ? " — contents extracted into the knowledge base" : "";
      parts.push(`- ${doc.name} (${doc.category}${doc.subcategory ? `/${doc.subcategory}` : ""}) — ${status}${extracted}`);
    }
  }

  // Outstanding tasks
  if (kb.outstandingTasks.length > 0) {
    parts.push("");
    parts.push(`## Outstanding Tasks & Deferred Questions`);
    parts.push(`These items were flagged in previous sessions. Consider addressing them when the moment is right.`);
    for (const task of kb.outstandingTasks) {
      parts.push(`- [${task.type}] ${task.title}: ${task.description || "No details"}${task.relatedField ? ` (field: ${task.relatedField})` : ""}`);
      if (task.aiExplanation) {
        parts.push(`  Context: ${task.aiExplanation}`);
      }
    }
  }

  // Industry-specific context (set after first turn identifies industry)
  if (kb.industryContext) {
    parts.push("");
    parts.push(`## Industry-Specific Intelligence`);
    parts.push(`Industry: ${kb.industryContext.industry}${kb.industryContext.subIndustry ? ` — ${kb.industryContext.subIndustry}` : ""}`);

    if (kb.industryContext.industrySpecificAreas.length > 0) {
      parts.push(`\nKey industry-specific areas to cover for this business:`);
      kb.industryContext.industrySpecificAreas.forEach((area) => parts.push(`- ${area}`));
    }

    if ((kb.industryContext.coveredIndustryTopics ?? []).length > 0) {
      parts.push(`\nIndustry-specific areas ALREADY COVERED (do not re-ask):`);
      kb.industryContext.coveredIndustryTopics!.forEach((topic) => parts.push(`- ${topic}`));
    }

    if (kb.industryContext.regulatoryNotes.length > 0) {
      parts.push(`\nLocation-specific regulatory requirements:`);
      kb.industryContext.regulatoryNotes.forEach((note) => parts.push(`- ${note}`));
    }
  }

  // Prior session context
  if (kb.priorSessionSummary) {
    const ps = kb.priorSessionSummary;
    parts.push("");
    parts.push(`## Prior Interview Session`);
    parts.push(`A previous interview session exists (status: ${ps.status}).`);
    parts.push(`- Questions asked: ${ps.questionsAsked ?? 0}`);
    parts.push(`- Questions answered: ${ps.questionsAnswered ?? 0}`);
    parts.push(`- Questions skipped: ${ps.questionsSkipped ?? 0}`);
    parts.push(`You are resuming this interview. Review the conversation history and continue from where it left off. Do not repeat questions that were already answered.`);
  }

  return parts.join("\n");
}

// =====================
// Internal helpers
// =====================

// Values that read as "an answer exists" to a null-check but carry no usable
// information. A field holding one of these must NOT count toward coverage —
// otherwise the progress bar fills up on non-answers and the interview can
// look "done" while the CIM has nothing to say.
const NON_ANSWERS = new Set([
  "n/a", "na", "none", "unknown", "not sure", "unsure", "tbd", "idk",
  "don't know", "dont know", "no idea", "-", "?", "...",
]);

/**
 * True when a stored value carries real information. Numeric answers ("9",
 * "$1.2M") are substantive at any length; text must be more than a couple of
 * characters and not a known non-answer.
 */
export function isSubstantiveValue(value: unknown): boolean {
  if (typeof value !== "string") return value != null && value !== "";
  const v = value.trim().toLowerCase();
  if (v.length === 0 || NON_ANSWERS.has(v)) return false;
  return /\d/.test(v) || v.length >= 3;
}

/**
 * Sections that may only be credited by their own designated core field. The
 * asking_price section used to flip to "partial" when adjacent fields (e.g.
 * equipment → assetsIncluded) were populated — even though no asking-price
 * information had ever been mentioned — which both lied to the broker and let
 * completion governance treat the section as covered. A section listed here
 * stays "missing" until its core field itself is populated.
 */
const SECTION_CORE_FIELDS: Record<string, string[]> = {
  asking_price: ["askingPrice"],
  financials: ["annualRevenue"],
};

export function buildSectionCoverage(
  extractedInfo: Partial<ExtractedInfo>,
  /** Per-field confidence from the interview session (_confidenceLevels).
   *  Fields the interview hasn't touched (docs/questionnaire-sourced) have
   *  no entry and are labeled "inferred" — not "confirmed" — so the agent
   *  knows to verify them rather than treat them as seller-confirmed. */
  confidenceLevels?: Record<string, string>,
  importanceMap?: SectionImportanceMap,
  /** CIM section keys the broker removed from this interview — left out entirely. */
  excludedSections: string[] = [],
  /** Industry checklist items and broker edits for this deal. */
  adjustments?: CoverageFieldAdjustments,
): SectionCoverage[] {
  return CIM_SECTIONS.filter((section) => !excludedSections.includes(section.key)).map((section) => {
    const importance = importanceMap?.sections[section.key];
    const core = SECTION_CORE_FIELDS[section.key] ?? [];
    const generic = (SECTION_FIELD_MAP[section.key] || [])
      .filter((f) => core.includes(f) || !adjustments?.remove?.has(f))
      .map((f) => ({ key: f, label: undefined as string | undefined, extra: false, critical: false }));
    const seen = new Set(generic.map((g) => g.key));
    const extras = (adjustments?.add?.[section.key] ?? [])
      .filter((x) => !seen.has(x.key) && !adjustments?.remove?.has(x.key) && (seen.add(x.key), true))
      .map((x) => ({ key: x.key, label: x.label as string | undefined, extra: true, critical: !!x.critical, alias: x.alias ?? null }));
    const fields = [...generic.map((g) => ({ ...g, alias: null as string | null })), ...extras].map(({ key: fieldName, label, extra, critical, alias }) => {
      // A checklist item may already be answered by a fact stored under a
      // general key (e.g. associate agreements inside keyEmployees).
      const own = extractedInfo[fieldName as keyof ExtractedInfo] ?? null;
      const raw = isSubstantiveValue(own) ? own : alias ? (extractedInfo[alias as keyof ExtractedInfo] ?? null) : own;
      // Quality gate: junk placeholders don't count as answers
      const value = isSubstantiveValue(raw) ? (raw as string) : null;
      const sessionConf = confidenceLevels?.[fieldName];
      const confidence: "confirmed" | "inferred" | "approximate" | "unknown" =
        !value ? "unknown"
        : sessionConf === "confirmed" || sessionConf === "approximate" ? sessionConf
        : "inferred";
      return { fieldName, value, confidence, ...(label ? { label } : {}), ...(extra ? { industrySpecific: true, critical } : {}) };
    });

    const populatedCount = fields.filter((f) => f.value !== null).length;
    const totalCount = fields.length;
    // Richness weighting: the mapped fields are alternatives, not a quota —
    // one substantial value (a full lease description with term, rate, and
    // options) covers its section better than three stubs. A rich field
    // counts double so exhaustively-answered sections stop reading "partial"
    // (QA-observed: three fully-detailed leases stuck at partial all run).
    const effectiveCount = fields.reduce(
      (n, f) => n + (f.value === null ? 0 : f.value.length >= 120 ? 2 : 1),
      0,
    );

    const coreFields = SECTION_CORE_FIELDS[section.key];
    const coreMissing =
      coreFields !== undefined &&
      !fields.some((f) => coreFields.includes(f.fieldName) && f.value !== null);

    let status: SectionCoverage["status"];
    if (totalCount === 0 || populatedCount === 0 || coreMissing) {
      status = "missing";
    } else if (effectiveCount >= totalCount * 0.6) {
      status = "well_covered";
    } else {
      status = "partial";
    }

    return {
      key: section.key,
      title: section.title,
      importance: importance?.level ?? "important",
      importanceReason: importance?.reason ?? "",
      order: section.order,
      status,
      fields,
    };
  });
}

function parseLocation(deal: Deal, questionnaireData: Record<string, unknown> | null): LocationContext | null {
  // Try to extract location from questionnaire data first
  if (questionnaireData) {
    const country = questionnaireData["Country"] || questionnaireData["country"];
    const state = questionnaireData["State"] || questionnaireData["state"]
      || questionnaireData["Province"] || questionnaireData["province"]
      || questionnaireData["State/Province"] || questionnaireData["stateProvince"];
    const city = questionnaireData["City"] || questionnaireData["city"]
      || questionnaireData["Municipality"] || questionnaireData["municipality"];
    const location = questionnaireData["Location"] || questionnaireData["location"];

    if (country || state || city) {
      return {
        country: country ? String(country) : null,
        stateProvince: state ? String(state) : null,
        municipality: city ? String(city) : null,
        raw: null,
      };
    }

    if (location) {
      return { country: null, stateProvince: null, municipality: null, raw: String(location) };
    }
  }

  // Broker-entered location from deal creation ("Calgary, AB") — available
  // before the seller has answered anything, so jurisdiction-specific
  // questions load from the first turn.
  if (deal.location && deal.location.trim()) {
    return { country: null, stateProvince: null, municipality: null, raw: deal.location.trim() };
  }

  // Try extractedInfo
  const extractedInfo = deal.extractedInfo as Partial<ExtractedInfo> | null;
  if (extractedInfo?.locations) {
    return { country: null, stateProvince: null, municipality: null, raw: extractedInfo.locations };
  }

  return null;
}

function parseOperationalSystems(deal: Deal): OperationalSystems | null {
  const systems = deal.operationalSystems as Record<string, unknown> | null;
  if (!systems) return null;

  return {
    accounting: systems.accounting ? String(systems.accounting) : null,
    crm: systems.crm ? String(systems.crm) : null,
    pos: systems.pos ? String(systems.pos) : null,
    erp: systems.erp ? String(systems.erp) : null,
    payroll: systems.payroll ? String(systems.payroll) : null,
    other: Array.isArray(systems.other) ? systems.other.map(String) : [],
  };
}

function summarizeDocument(doc: Document): DocumentSummary {
  return {
    id: doc.id,
    name: doc.name,
    category: doc.category,
    subcategory: doc.subcategory,
    status: doc.status,
    isProcessed: doc.isProcessed ?? false,
    hasExtractedText: !!doc.extractedText,
    hasExtractedData: !!doc.extractedData,
  };
}

function summarizeTask(task: Task): TaskSummary {
  return {
    id: task.id,
    type: task.type,
    title: task.title,
    description: task.description,
    relatedField: task.relatedField,
    status: task.status,
    priority: task.priority,
    aiAttempts: task.aiAttempts,
    aiExplanation: task.aiExplanation,
  };
}

function summarizeSession(session: InterviewSession): PriorSessionSummary {
  return {
    sessionId: session.id,
    questionsAsked: session.questionsAsked,
    questionsAnswered: session.questionsAnswered,
    questionsSkipped: session.questionsSkipped,
    lastActivityAt: session.lastActivityAt,
    status: session.status,
  };
}
