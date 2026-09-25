import type { Deal, Document, Task, InterviewSession, ExtractedInfo, Discrepancy, ConversationMessage } from "@shared/schema";
import { CIM_SECTIONS } from "@shared/schema";
import type { SectionImportanceLevel, SectionImportanceMap } from "@shared/schema";
import { getSectionImportance, renderSectionImportanceForPrompt } from "./section-importance";
import { getInterviewOutline, renderOutlineForPrompt } from "./outline";
import { coverageAdjustmentsForDeal } from "./interview-plan";
import type { InterviewOutline } from "@shared/schema";
import { profileSafeForInterview, type SellerCommunicationProfile, type InterviewSellerProfile } from "./eq-profiler";
import { getFieldSources, isSourceKind, repairCharIndexedValue, isFactKey, type FieldSource } from "./info-merger";
import { sellerInterviewView, privateSourceMatcher } from "./seller-view";
import { resolvedNotes, overlayResolvedFacts, type ResolvedDiscrepancyNote as ResolvedNote } from "../cim/resolved-block";
import {
  buildSourceDigests,
  buildFlaggedRisks,
  detectAlternateConflicts,
  crossSourceFigureConflicts,
  mergeDiscrepancyConflicts,
  buildPriorExchanges,
  dealAsOfYear,
  type SourceDigest,
  type FlaggedRisk,
  type SourceConflict,
  type PriorExchange,
} from "./source-context";
import { reviewConflictsForDeal } from "./source-review";
import { claimConflicts } from "./claim-conflicts";

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

  // Seller Communication Profile — EQ profiler output (generated pre-interview),
  // as the interview may read it (see profileSafeForInterview).
  sellerProfile: InterviewSellerProfile | null;

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
    /** Carried over from an earlier session (its turn number is from that sitting). */
    earlierSession?: boolean;
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

  // What each seller-visible source says (summary + key facts), so the agent
  // knows what a call or document covers beyond the extracted facts.
  sourceDigests?: SourceDigest[];
  // Risks the seller-visible sources flag — asked or deferred before ending.
  flaggedRisks?: FlaggedRisk[];
  // Values that disagree across seller-visible sources — reconciled neutrally.
  sourceConflicts?: SourceConflict[];
  // Earlier sessions' questions and answers (never asked again).
  priorExchanges?: PriorExchange[];
  // Discrepancies the broker settled — final values.
  resolvedValues?: ResolvedDiscrepancyNote[];
  // What still blocks a wrap-up (critical gaps, seller-only topics,
  // unreconciled critical conflicts, open flagged risks). Set per turn.
  wrapUpBlockers?: string[];
  // Document requests the server dropped because the document is on file.
  droppedDocRequests?: string[];
}

/** A settled discrepancy as the interview sees it (resolvedPrivately: the final value is withheld — it came from the broker's own material). */
export type ResolvedDiscrepancyNote = ResolvedNote & { resolvedPrivately?: boolean };

/** Optional context assembleKnowledgeBase can use (older callers pass none). */
export interface KnowledgeBaseExtras {
  /** Every interview session of the deal — earlier sessions become a digest. */
  sessions?: InterviewSession[];
  /** The session this knowledge base is for (excluded from the digest). */
  currentSessionId?: string | null;
  /** Open discrepancy rows (conflicts the fact merge raised). */
  openDiscrepancies?: Discrepancy[];
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
    /** On file only from a lead (CRM note, website, social) the broker hasn't accepted. */
    unverified?: boolean;
  }>;
  /** Checklist/generic items the section asks for. */
  totalItems?: number;
  /** Of those, items with no verified value yet. */
  openItems?: number;
  /** Of those, items marked critical (industry checklist). */
  openCriticalItems?: number;
  /** Items on file only as unverified leads. */
  unverifiedItems?: number;
  /** Items the seller (interview, call, questionnaire) or the broker stated. */
  sellerSourcedItems?: number;
  /** Items backed by a written document (statements, reports) or set by the broker. */
  documentedItems?: number;
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
  // The keys the document pipeline actually writes (revenueByYear, ebitda,
  // sde, …) belong here — without them a deal with three years of
  // statements read "Financial Summary still needs work".
  financials: [
    "annualRevenue", "revenueByYear", "revenueGrowth",
    "ebitda", "sde", "netIncome", "grossProfit", "operatingMargins",
    "addbacks", "workingCapital", "debt",
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

/**
 * The generic fields of a section are partly ALTERNATIVES, not a quota: one
 * full seasonality answer covers "seasonality / peak / slow periods", and any
 * one profitability measure answers "is it profitable?". Coverage counts
 * these groups, not keys (a rich answer no longer counts double to make up
 * for it). A group is answered by any of its keys, or by one of its extra
 * alias keys the pipeline writes under another name (totalDebt for debt…).
 * Sections not listed treat every field as its own group; industry
 * checklist items are always their own group.
 */
const SECTION_FIELD_GROUPS: Record<string, { keys: string[]; aliases?: string[] }[]> = {
  overview: [
    { keys: ["businessName"] },
    { keys: ["industry"] },
    { keys: ["companyHistory", "yearsOperating", "ownershipHistory"], aliases: ["yearFounded", "foundedYear", "yearEstablished"] },
    { keys: ["entityType"] },
    { keys: ["brandIdentity", "missionStatement", "coreValues"] },
    { keys: ["industryPerception", "customerPerception", "accolades"], aliases: ["reputation", "onlineReviews", "reviews"] },
  ],
  strengths: [{ keys: ["competitiveAdvantage", "uniqueSellingProposition", "strengths"] }],
  growth_potential: [{ keys: ["growthOpportunities", "expansionPlans"] }],
  target_market: [{ keys: ["targetMarket", "primaryMarket", "secondaryMarket", "b2bBreakdown", "customerDemographics", "customerBase"] }],
  permits_licenses: [{ keys: ["permitsLicenses", "complianceRequirements"], aliases: ["licenses", "certifications"] }],
  seasonality: [{ keys: ["seasonality", "peakPeriods", "slowPeriods"] }],
  revenue_sources: [
    { keys: ["revenueStreams", "keyProducts"], aliases: ["revenueMix", "serviceLines"] },
    { keys: ["customerConcentration"], aliases: ["topCustomers", "largestCustomer"] },
    { keys: ["annualRevenue", "revenueGrowth", "operatingMargins"], aliases: ["revenueByYear"] },
  ],
  real_estate: [{ keys: ["leaseDetails", "propertyInfo", "realEstateIncluded"], aliases: ["leaseExpiry", "monthlyRent", "annualRent"] }],
  employees: [
    { keys: ["employees"], aliases: ["employeeCount", "headcount"] },
    { keys: ["employeeStructure", "keyEmployees", "managementTeam"] },
    { keys: ["ownerInvolvement"], aliases: ["ownerRole", "ownerHours"] },
  ],
  operations: [
    { keys: ["suppliers", "supplyChain"] },
    { keys: ["technologySystems", "operationalSystems"] },
  ],
  buyer_profile: [{ keys: ["idealBuyer"] }],
  training_support: [{ keys: ["trainingSupport", "transitionPlan"] }],
  reason_for_sale: [{ keys: ["reasonForSale"] }],
  financials: [
    { keys: ["annualRevenue"] },
    { keys: ["revenueByYear", "revenueGrowth"] },
    { keys: ["ebitda", "sde", "netIncome", "grossProfit", "operatingMargins"], aliases: ["adjustedEbitda", "grossMargin", "netProfit", "ebitdaMargin"] },
    { keys: ["addbacks"], aliases: ["normalizationAdjustments", "ownerCompensation"] },
    { keys: ["workingCapital", "debt"], aliases: ["totalDebt", "longTermDebt", "totalAssets", "currentAssets", "currentLiabilities", "netWorkingCapital"] },
  ],
  asking_price: [
    { keys: ["askingPrice"] },
    { keys: ["saleType"], aliases: ["dealStructure"] },
    { keys: ["assetsIncluded", "inventory"], aliases: ["equipmentList", "ffe"] },
  ],
};

/** Source kinds that are leads, not facts, until the broker accepts them. */
const LEAD_SOURCE_KINDS: ReadonlySet<string> = new Set(["crm", "website", "social"]);
/** A lead answers a group only this much (it is a lead the CIM writers won't state as fact). */
const LEAD_CREDIT = 0.25;
/** Source kinds that are the seller (or the broker) speaking for the business. */
const SELLER_SOURCE_KINDS: ReadonlySet<string> = new Set(["interview", "call", "video_call", "questionnaire", "broker"]);

// =====================
// Knowledge base assembly
// =====================

export function assembleKnowledgeBase(
  deal: Deal,
  documents: Document[],
  tasks: Task[],
  latestSession: InterviewSession | null,
  resolvedDiscrepancies: Discrepancy[] = [],
  extras: KnowledgeBaseExtras = {},
): KnowledgeBase {
  // The facts exactly as the interview may read them (see seller-view.ts):
  // nothing a broker-only source asserted (the broker's CRM notes, private
  // emails and files — facts, other values, private notes), and not the
  // broker's listed asking price from the deal row (the agent keeps asking
  // for the seller's own expectation when there is none). processTurn
  // merges each turn against this same view.
  const baseExtractedInfo = sellerInterviewView(
    ((deal.extractedInfo as Partial<ExtractedInfo>) || {}) as Record<string, unknown>,
    documents,
  ) as Partial<ExtractedInfo>;
  const questionnaireData = deal.questionnaireData as Record<string, unknown> | null;

  // Which side of a discrepancy (and which text written from it) came from
  // the broker's own material. Fail closed: a side is private when the row's
  // recorded side source says so (discrepancies.side_sources — brokerOnly, a
  // CRM kind, or a broker-only row), when it names a broker-only source
  // (legacy rows), or when its text cites the broker's own material ("per
  // broker note", "CRM notes and site visit", "(broker normalized)").
  const privacy = discrepancyPrivacy(documents);

  // Discrepancies the broker settled: a row naming a real fact key overlays
  // that fact (per-year rows update that year); every settled row is also
  // listed as a final value, so a narrative fact still repeating the losing
  // value reads as outdated (server/cim/resolved-block.ts — the same rules
  // the CIM writer uses). A label-named row no longer adds a pseudo-fact.
  // (ask_seller rows have no resolvedValue — they become priority topics.)
  // Privacy: a losing value from a private side is never listed, and a final
  // value that came FROM a private side (the broker's recast, a CRM note's
  // figure) is neither listed nor overlaid — the agent only learns that the
  // item is settled (resolvedPrivately), never the figure or where it came from.
  const resolvedValues: ResolvedDiscrepancyNote[] = [];
  for (const d of resolvedDiscrepancies) {
    if (d.status === "ask_seller") continue;
    const [note] = resolvedNotes([d]);
    if (!note) continue;
    const p = privacy(d);
    const privateValues = [p.privateA ? d.interviewValue : null, p.privateB ? d.documentValue : null].filter((v): v is string => !!v);
    const publicValues = [p.privateA ? null : d.interviewValue, p.privateB ? null : d.documentValue].filter((v): v is string => !!v);
    const fromPrivate =
      PRIVATE_MATERIAL_RE.test(note.resolvedValue) ||
      p.namesPrivateSource(note.resolvedValue) ||
      (privateValues.some((v) => sameFigure(note.resolvedValue, v)) && !publicValues.some((v) => sameFigure(note.resolvedValue, v)));
    const field = PRIVATE_MATERIAL_RE.test(note.field) ? safeFieldLabel(note.field, note.factKey) : note.field;
    if (fromPrivate) {
      resolvedValues.push({ ...note, field, resolvedValue: "", supersededValues: [], resolvedPrivately: true });
      continue;
    }
    resolvedValues.push({
      ...note,
      field,
      supersededValues: note.supersededValues.filter(
        (v) => !privateValues.some((pv) => pv.trim() === v.trim()) && !PRIVATE_MATERIAL_RE.test(v) && !p.namesPrivateSource(v),
      ),
    });
  }
  const extractedInfo = overlayResolvedFacts(
    baseExtractedInfo as Record<string, unknown>,
    resolvedValues.filter((n) => !n.resolvedPrivately),
  ) as Partial<ExtractedInfo>;

  // Discrepancies the broker explicitly routed to the interview. One side
  // from a broker-only source (a CRM note, a private email): the agent never
  // sees that side's value, or the explanation built from it — it asks the
  // seller for the figure without hinting at it. Any private side hides the
  // explanation and suggested approach too — they are written from both sides.
  const askSellerDiscrepancies: AskSellerDiscrepancy[] = resolvedDiscrepancies
    .filter((d) => d.status === "ask_seller")
    .map((d) => {
      const { privateA, privateB, explanationPrivate } = privacy(d);
      const privateSource = privateA || privateB || explanationPrivate;
      // The field label itself can carry a source note ("Employees (CRM notes)").
      const field = PRIVATE_MATERIAL_RE.test(d.field) ? safeFieldLabel(d.field, d.factKey) : d.field;
      return {
        field,
        valueA: privateA ? null : d.interviewValue,
        valueB: privateB ? null : d.documentValue,
        severity: d.severity,
        explanation: privateSource ? null : d.aiExplanation,
        suggestedResolution: privateSource ? null : d.suggestedResolution,
        ...(privateSource ? { privateSource: true } : {}),
      };
    });

  // Per-field confidence lives on the session (interview turns write it) —
  // used to label coverage fields honestly instead of hardcoding "confirmed".
  const sessionMeta = (latestSession?.extractedInfo as Record<string, unknown> | null) || {};
  const confidenceLevels = (sessionMeta._confidenceLevels as Record<string, string> | undefined) ?? undefined;

  // The real source of every known fact, labelled for the agent. (Facts from
  // broker-only sources aren't in the view at all; a CRM note the broker
  // shared is labelled so the agent confirms it without citing the CRM.)
  const factSourceLabels = buildFactSourceLabels(baseExtractedInfo as Record<string, unknown>, documents, confidenceLevels);
  for (const n of resolvedValues) {
    if (n.factKey && !n.year && !n.resolvedPrivately) factSourceLabels[n.factKey] = "confirmed by the broker";
  }

  // Sources: digests, flagged risks, conflicts (seller-visible only — the
  // view above already dropped broker-only alternates), earlier sessions.
  const sourceConflicts = dedupeConflicts([
    ...detectAlternateConflicts(baseExtractedInfo as Record<string, unknown>, documents),
    ...claimConflicts(documents, baseExtractedInfo as Record<string, unknown>, {
      // (Names only pick which lines of a seller-visible document to read —
      // nothing from the full facts is shown.)
      ownerNames: ownerNamesOf(deal, ((deal.extractedInfo as Record<string, unknown>) || {})),
      asOf: dealAsOfYear(documents),
    }),
    ...crossSourceFigureConflicts(documents),
    ...mergeDiscrepancyConflicts(extras.openDiscrepancies ?? [], documents),
    ...reviewConflictsForDeal(deal, documents),
  ])
    // A conflict the broker already settled is not re-opened with the seller
    // ("Alderbrook under 20%" vs 22% after the broker resolved it at 22%).
    .filter((c) => !settledByBroker(c, resolvedDiscrepancies.filter((d) => d.status !== "ask_seller")));
  const currentSessionId = extras.currentSessionId ?? null;
  const priorSession =
    (extras.sessions ?? [])
      .filter((x) => x.id !== currentSessionId && ((x.messages as ConversationMessage[] | null) ?? []).some((m) => m.role === "user"))
      .sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime())[0] ??
    // Legacy callers: a latestSession that is not the current one is a prior session.
    (latestSession && currentSessionId && latestSession.id !== currentSessionId ? latestSession : null);
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
      location: parseLocation(deal, questionnaireData, baseExtractedInfo),
    },
    sectionCoverage: buildSectionCoverage(extractedInfo, confidenceLevels, sectionImportance, outline.excludedSections, coverageAdjustmentsForDeal(deal)),
    sectionImportance,
    outline,
    conductedBy: sessionMeta._conductedBy === "broker_with_seller" ? "broker_with_seller" : "seller",
    industryContext: null, // Set by the AI on first turn, stored on session
    // A profile built before broker-only sources were excluded keeps only
    // its style fields until it is rebuilt (its free text could quote them).
    sellerProfile: profileSafeForInterview((deal.sellerProfile as SellerCommunicationProfile | null) || null, documents),
    questionnaireData,
    operationalSystems: parseOperationalSystems(deal),
    // Broker-only sources are never named to the seller.
    documents: documents.filter((d) => d.visibility !== "broker_only").map(summarizeDocument),
    outstandingTasks: tasks
      .filter((t) => t.status === "pending" || t.status === "in_progress")
      // A follow-up whose field the seller has since answered is done —
      // listing it made the agent raise it again.
      .filter((t) => !t.relatedField || !sellerAnswered(extractedInfo as Record<string, unknown>, t.relatedField))
      .map(summarizeTask),
    priorSessionSummary: priorSession ? summarizeSession(priorSession) : null,
    extractedInfo,
    scrapedData: (deal.scrapedData as Record<string, string> | null) || null,
    scrapeSource: (deal.scrapeSource as "website" | "internet_search" | "website_and_internet" | null) || null,
    askSellerDiscrepancies,
    fieldConfidence: confidenceLevels,
    factSourceLabels,
    sourceDigests: buildSourceDigests(documents),
    flaggedRisks: buildFlaggedRisks(documents),
    sourceConflicts,
    priorExchanges: extras.sessions ? buildPriorExchanges(extras.sessions, currentSessionId) : [],
    resolvedValues,
  };
}

/** Recorded side of a discrepancy (discrepancies.side_sources). */
interface DiscrepancySide { kind?: string; documentId?: string; brokerOnly?: boolean }

/**
 * Text that cites the broker's own material (CRM notes, the broker's recast,
 * a site visit) — never shown to the seller, whatever the row's sources say.
 */
export const PRIVATE_MATERIAL_RE =
  /\b(?:crm|broker(?:'s|s')?\s+(?:note|notes|recast|estimate|estimates|valuation|meeting|call notes|analysis|normali[sz]ed|normali[sz]ation|adjusted|adjustments?|calc\w*|figures?|numbers?|view|opinion|model|working session)|per (?:the )?broker|pipedrive|hubspot|salesforce|site visit(?: notes?)?|working session)\b|\(broker\b[^)]*\)/i;
const PRIVATE_MATERIAL_GLOBAL_RE = new RegExp(PRIVATE_MATERIAL_RE.source, "gi");

/** A field label with any note about the broker's material removed ("Employees (CRM notes)" → "Employees"). */
function safeFieldLabel(field: string, factKey: string | null | undefined): string {
  return factKey || field.replace(/\s*\([^)]*\)/g, "").replace(PRIVATE_MATERIAL_GLOBAL_RE, "").replace(/\s+/g, " ").trim() || "a figure";
}

/** The significant figures a value states, scaled ("$3.9M" → 3,900,000; "$1,312K" → 1,312,000); years and labels ("FY24") left out. */
function significantFigures(text: string): number[] {
  const out: number[] = [];
  const re = /(?<![A-Za-z0-9])(\$)?\s*(\d[\d,]*(?:\.\d+)?)\s*(k|mm|m|million|thousand|b|billion)?(?![A-Za-z0-9])(\s*%)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    let n = parseFloat(m[2].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    const suffix = (m[3] || "").toLowerCase();
    if (!m[1] && !suffix && !m[4] && n >= 1900 && n <= 2099 && Number.isInteger(n)) continue; // a year
    const mult: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
    if (suffix) n *= mult[suffix] ?? 1;
    if (n >= 100 || m[4]) out.push(m[4] ? -n : n); // percentages kept apart (negative)
  }
  return out;
}

/** Two values share a significant figure ("$3,900,000" and "$3.9M (…)"; "$1,312,000 …" and "FY24 SDE $1,312K …"). */
function sameFigure(a: string, b: string): boolean {
  const xs = significantFigures(a);
  const ys = significantFigures(b);
  return xs.some((x) => ys.some((y) => Math.sign(x) === Math.sign(y) && Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y)) <= 0.005));
}

/**
 * Privacy of a discrepancy's two sides and of the text written from them.
 * Fail closed — see assembleKnowledgeBase.
 */
export function discrepancyPrivacy(documents: Array<Pick<Document, "id" | "visibility"> & { name?: string | null }>) {
  const namesPrivateSource = privateSourceMatcher(documents);
  const mentionsPrivateTitle = privateSourceMatcher(documents, { distinctiveOnly: true });
  const brokerOnlyDoc = (id: string | null | undefined) =>
    !!id && documents.some((doc) => doc.id === id && doc.visibility === "broker_only");
  const privateSide = (side: DiscrepancySide | undefined) =>
    !!side && (side.brokerOnly === true || side.kind === "crm" || brokerOnlyDoc(side.documentId));
  return (d: Pick<Discrepancy, "interviewValue" | "documentValue" | "documentId" | "documentName" | "aiExplanation" | "suggestedResolution" | "sideSources">) => {
    const sides = (d.sideSources as { interview?: DiscrepancySide; document?: DiscrepancySide } | null) || {};
    // documentId backs the second value (documentValue).
    const privateA =
      privateSide(sides.interview) || namesPrivateSource(d.interviewValue) || PRIVATE_MATERIAL_RE.test(d.interviewValue ?? "");
    const privateB =
      privateSide(sides.document) ||
      namesPrivateSource(d.documentValue) ||
      brokerOnlyDoc(d.documentId) ||
      PRIVATE_MATERIAL_RE.test(d.documentValue ?? "") ||
      PRIVATE_MATERIAL_RE.test(d.documentName ?? "");
    const explanationPrivate =
      PRIVATE_MATERIAL_RE.test(d.aiExplanation ?? "") ||
      PRIVATE_MATERIAL_RE.test(d.suggestedResolution ?? "") ||
      mentionsPrivateTitle(d.aiExplanation) ||
      mentionsPrivateTitle(d.suggestedResolution);
    return { privateA, privateB, explanationPrivate, namesPrivateSource };
  };
}

/** A fact the seller (or the broker) has stated — not only a document or lead. */
export function sellerAnswered(info: Record<string, unknown>, key: string): boolean {
  if (!isSubstantiveValue(info[key])) return false;
  const src = getFieldSources(info)[key];
  return !!src && ["interview", "call", "video_call", "questionnaire", "broker"].includes(String(src.source));
}

/** The owner's names on file (facts and the deal's seller contact) — to find their pay in the tax returns. */
function ownerNamesOf(deal: Deal, info: Record<string, unknown>): string[] {
  const raw = [
    info.ownerName, info.owner, info.sellerName, info.owners,
    (deal as { sellerContact?: { name?: string } | null }).sellerContact?.name,
    (deal as { sellerName?: string | null }).sellerName,
  ];
  const names = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") continue;
    for (const w of v.replace(/\b(Dr|Mr|Mrs|Ms)\.?\s/g, " ").match(/\b[A-Z][a-z]{2,}\b/g) ?? []) names.add(w);
  }
  return Array.from(names);
}

/**
 * True when a resolved discrepancy already settles this conflict: it names
 * the same fact key, or it is about the same thing (a shared name or two
 * topic words) and carries one of the conflict's figures.
 */
export function settledByBroker(
  c: SourceConflict,
  rows: Array<Pick<Discrepancy, "field" | "factKey" | "interviewValue" | "documentValue" | "resolvedValue">>,
): boolean {
  const figures = (t: string) =>
    (t.replace(/(?<!\d)(?:19|20)\d{2}(?!\d)/g, " ").match(/\d[\d,]*(?:\.\d+)?/g) ?? [])
      .map((n) => parseFloat(n.replace(/,/g, "")))
      .filter((n) => !Number.isNaN(n) && n >= 2);
  const words = (t: string) =>
    new Set((t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !SETTLE_NOISE.has(w)).map((w) => w.slice(0, 5)));
  const cValues = c.values.map((v) => v.value).join(" ");
  const cFigures = figures(cValues);
  const cWords = words(`${c.key} ${c.topic}`);
  const cNames = Array.from(new Set((cValues.match(/\b[A-Z][a-z]{3,}\b/g) ?? []).map((w) => w.toLowerCase())));
  return rows.some((r) => {
    const key = (r.factKey || r.field || "").trim();
    if (key && key.toLowerCase() === c.key.toLowerCase()) return true;
    const rText = `${r.field} ${r.interviewValue ?? ""} ${r.documentValue ?? ""} ${r.resolvedValue ?? ""}`;
    const rWords = words(`${r.field} ${r.factKey ?? ""}`);
    const rLower = rText.toLowerCase();
    let sharedWords = 0;
    cWords.forEach((w) => { if (rWords.has(w)) sharedWords++; });
    const sharedName = cNames.some((n) => new RegExp(`\\b${n}\\b`).test(rLower));
    if (!sharedName && sharedWords < 2) return false;
    const rFigures = figures(rText);
    return cFigures.some((x) => rFigures.some((y) => Math.abs(x - y) / Math.max(x, y) <= 0.01));
  });
}
const SETTLE_NOISE = new Set(["with", "from", "that", "this", "said", "call", "email", "document", "about", "approximately", "percent", "percentage", "total", "value", "count", "number"]);

/** One conflict per fact key (the first source wins: alternates, then merge, then review). */
function dedupeConflicts(list: SourceConflict[]): SourceConflict[] {
  const seen = new Set<string>();
  const out: SourceConflict[] = [];
  for (const c of list) {
    const k = c.key.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(c);
  }
  return out.slice(0, 10);
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
      if (d.privateSource) parts.push(`    ⚠ The other value is held privately by the broker and is not shown to you. Ask the seller for the right figure in your own words — never suggest a figure, and never mention the broker's notes, a CRM or any document.`);
    }
    parts.push(``);
  }

  // Conflicts between the deal's own sources — the agent must not repeat
  // either value as settled (it used to tell a seller "you're at 3,100
  // members" while the membership report on file showed 2,900 active).
  const conflicts = kb.sourceConflicts ?? [];
  if (conflicts.length > 0) {
    parts.push(`## ⚖️ CONFLICTS TO RECONCILE WITH THE SELLER`);
    parts.push(`The deal's sources disagree on these. Top priority after anything the broker routed above. For each: raise it neutrally at a natural moment ("I have two figures for X — A from <source> and B from <source>; which is right, and what explains the difference?"), never as a list and never accusingly. One per turn at most, and not back-to-back — a run of "I want to reconcile…" questions reads like an audit; weave them between other topics (critical ones first). Until the seller settles it, NEVER state either value as fact, and attribute each value only to the source shown — never say "your documents show" for a figure that came from a call. Capture the seller's answer under the fact key shown and list "reconcile <key>" in reasoning.resolvedDeferrals once it's settled.`);
    for (const c of conflicts) {
      parts.push(`- reconcile ${c.key}${c.critical ? " [CRITICAL — must be reconciled or deferred before the interview ends]" : ""}: ${c.values.map((v) => `"${v.value}" (${v.source})`).join(" vs ")}`);
    }
    parts.push(``);
  }

  // Risks the sources flag — what a buyer's diligence asks about first.
  const risks = kb.flaggedRisks ?? [];
  if (risks.length > 0) {
    parts.push(`## 🚩 RISKS FLAGGED IN THE SOURCES`);
    parts.push(`The deal's own documents, calls and emails flag these. Each must be asked about (what happened, where it stands now, what a buyer should know) or explicitly deferred before the interview ends — they come right after the conflicts, ahead of routine gap-filling. Ask about the substance in the seller's terms; don't read the flag back as an accusation. When one is covered, list "risk: <label>" in reasoning.resolvedDeferrals.`);
    for (const r of risks) {
      parts.push(`- risk: ${r.label} — "${r.text}" (flagged in: ${r.sources.slice(0, 2).join("; ")}${r.sources.length > 2 ? "…" : ""})`);
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
    // Per-source notes (a source's summary, red flags, the broker's action
    // items…) are not business facts and never listed as "known".
    const known = Object.entries(kb.extractedInfo).filter(
      ([k, v]) => isFactKey(k) && isSubstantiveValue(v),
    );
    if (known.length > 0) {
      const conf = kb.fieldConfidence ?? {};
      parts.push(`## ⛔ ALREADY ANSWERED — DO NOT RE-ASK. CONFIRM OR DEEPEN ONLY.`);
      parts.push(`Every fact below is already on file (from uploaded documents, emails, calls, the questionnaire, the broker, or earlier conversation) — each is labelled with where it came from. Before EVERY question you ask, scan this list:`);
      parts.push(`- If the fact you need is here, do NOT ask for it. Cite it and ask only for what is genuinely new (the delta): "Your P&L shows a 72/28 Shopify/Amazon split — has that shifted this year?"`);
      parts.push(`- Values the SELLER gave (in this interview or an earlier session, on a call, in an email, in the questionnaire) are settled: do not ask them again, and do not ask the seller to "confirm" them either — confirming what they already told you is a re-ask. Only a value that came from a document (and is not in a conflict below) may be confirmed, once, in passing. The broker's values are final.`);
      parts.push(`- Values marked "unverified" or "confirm with the seller" are leads, not facts: confirm them naturally in passing (still never as an open re-ask). When a label says never to mention or quote its source, don't — ask as if you simply want to confirm the detail.`);
      parts.push(`- Your suggestedAnswers must be consistent with these values — never offer a guess at a number already on file.`);
      parts.push(`- When capturing new fields, REUSE these exact key names when the concept matches; only mint a new key for a genuinely new concept.`);
      parts.push(``);
      const sourceLabels = kb.factSourceLabels ?? {};
      const conflictByKey = new Map((kb.sourceConflicts ?? []).map((c) => [c.key, c]));
      for (const [key, rawValue] of known) {
        const value = repairCharIndexedValue(rawValue);
        const sessionConf = conf[key];
        const label = sourceLabels[key]
          ?? (sessionConf ? `seller ${sessionConf}` : "from documents/questionnaire");
        const conflict = conflictByKey.get(key);
        const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
        const shown = norm(typeof value === "string" ? value : JSON.stringify(value));
        const other = conflict
          ? conflict.values.filter((v) => !shown.startsWith(norm(v.value).replace(/…$/, ""))).map((v) => `${v.source} says "${v.value}"`).join("; ")
          : "";
        parts.push(`- ${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : String(value)}  [${label}${other ? ` — BUT ${other}: in conflict, not settled` : ""}]`);
      }
      parts.push(``);
    }
  }

  // Values the broker settled — final. Anything else on file that repeats
  // a replaced value is outdated.
  if ((kb.resolvedValues ?? []).length > 0) {
    parts.push(`## SETTLED BY THE BROKER — final values (never re-ask, re-open or contradict)`);
    for (const n of kb.resolvedValues!) {
      const what = n.year ? `${n.factKey ?? n.field} (${n.year})` : (n.factKey ?? n.field);
      if (n.resolvedPrivately) {
        // The final figure came from the broker's own material: the agent
        // knows only that it is settled — nothing to quote, nothing to re-open.
        parts.push(`- ${what}: settled by the broker (the final figure is with the broker — don't quote a figure for it, don't ask the seller to re-state it, and don't mention where it came from)`);
        continue;
      }
      const old = n.supersededValues.length ? ` — replaces ${n.supersededValues.map((v) => `"${v}"`).join(", ")} (outdated)` : "";
      parts.push(`- ${what}: ${n.resolvedValue}${old}`);
    }
    parts.push(``);
  }

  // Earlier sessions — the seller was asked these already. Before this the
  // next session saw only counts and re-asked answered questions.
  if ((kb.priorExchanges ?? []).length > 0) {
    parts.push(`## PREVIOUS SESSIONS — ALREADY DISCUSSED`);
    parts.push(`The seller answered these in earlier sessions. Never ask any of them again (not reworded, not "just to confirm"); build on the answers. A topic the seller deferred ("I'll check", "ask my accountant") may be followed up once, framed as a follow-up to that earlier conversation.`);
    for (const x of kb.priorExchanges!) {
      parts.push(`- [session ${x.session}] Q: ${x.question} → A: ${x.answer}`);
    }
    parts.push(``);
  }

  // Open deferral ledger — the agent's own outstanding items, durable across
  // turns. Without this the model forgot its deferrals and never circled back.
  // (Conflicts and flagged risks shown in their own blocks above are left out.)
  const shownAbove = [
    ...(kb.sourceConflicts ?? []).map((c) => `reconcile ${c.key}`.toLowerCase()),
    ...(kb.flaggedRisks ?? []).map((r) => `risk: ${r.label}`.toLowerCase()),
  ];
  const ledgerItems = (kb.openDeferrals ?? []).filter((d) => !shownAbove.includes(d.topic.toLowerCase()));
  if (ledgerItems.length > 0) {
    parts.push(`## OPEN DEFERRALS (your outstanding items — durable ledger)`);
    parts.push(`These topics were raised and set aside earlier (the turn number shows when in THIS session; "earlier session" means a previous sitting). They are NOT resolved. A deferral only resolves when the information itself is obtained — creating a broker task or document request keeps it OPEN. Circle back when a natural opening appears: if the seller likely knows the answer but was hesitant (rather than the data living purely in a document), make ONE later conversational re-attempt with a lower-stakes reframe — especially if the seller invites it ("anything else?"). When one is resolved, list its topic in reasoning.resolvedDeferrals.`);
    for (const d of ledgerItems) {
      const where = d.whereInfoLives ? ` (info lives: ${d.whereInfoLives})` : "";
      const why = d.reason ? ` — ${d.reason}` : "";
      const ban = d.declined
        ? ` ⛔ DECLINED by the seller — do NOT re-ask this session under any circumstances (not even as the closing question); the broker will handle it. Only if the seller re-opens it themselves may you follow up.`
        : "";
      parts.push(`- [${d.earlierSession ? "earlier session" : `turn ${d.createdAtTurn}`}] ${d.topic}${why}${where}${ban}`);
    }
    parts.push(``);
  }

  // What still stands between this interview and a wrap-up (the server
  // won't let it end on its own before these are covered or deferred).
  if ((kb.wrapUpBlockers ?? []).length > 0) {
    parts.push(`## STILL NEEDED BEFORE THE INTERVIEW CAN WRAP UP`);
    parts.push(`Each must be discussed with the seller or explicitly deferred (with where the answer lives) before you set shouldEnd. Weave them in by priority — never as a list. The seller asking to stop still ends the interview.`);
    for (const b of kb.wrapUpBlockers!) parts.push(`- ${b}`);
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
    // A profile awaiting its rebuild carries only what the broker set by
    // hand — no AI-derived category (it may have come from private notes).
    if (kb.sellerProfile.pendingRebuild) {
      parts.push(`(Profile being refreshed: only the broker's own settings are shown. Read the seller from the conversation itself.)`);
    }
    const category: Array<[string, string | undefined]> = [
      ["Communication style", kb.sellerProfile.communicationStyle],
      ["Emotional state", kb.sellerProfile.emotionalState],
      ["Selling reason", kb.sellerProfile.sellingReason],
      ["Seller sophistication", kb.sellerProfile.sophistication],
      ["Business attachment", kb.sellerProfile.businessAttachment],
      ["Time orientation", kb.sellerProfile.timeOrientation],
      ["Family involvement", kb.sellerProfile.familyInvolvement],
    ];
    for (const [label, value] of category) if (value) parts.push(`- ${label}: ${value}`);

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
        parts.push(`  - ${name}: ${field.value} (${field.unverified ? "unverified lead — confirm with the seller" : field.confidence})`);
      } else {
        parts.push(`  - ${name}: NOT YET CAPTURED`);
      }
    }
  }

  // Documents — and what each one says. The agent used to see only file
  // names and asked for anything extraction missed ("Who is Megan?" with
  // the org chart on file).
  if (kb.documents.length > 0) {
    parts.push("");
    parts.push(`## Uploaded Documents & Sources — what each one says`);
    parts.push(`These sources are on file for this deal. Do NOT ask the seller to upload or send anything listed here. Their facts appear in the ALREADY ANSWERED list above, and the digest under each says what else it covers — a question answered by a source here reads as "you didn't look at what I sent you". When you need more than a digest gives, cite the source and ask only for what's new ("The org chart has Megan as quality manager — does she run the IATF audits herself?"). Call and email digests say who said what; a statement by someone other than the seller is theirs, not the seller's.`);
    const digests = new Map((kb.sourceDigests ?? []).map((d) => [d.id, d]));
    for (const doc of kb.documents) {
      const status = doc.isProcessed ? "processed" : doc.status;
      const digest = digests.get(doc.id);
      parts.push(`- ${doc.name} (${digest?.kind ?? doc.category}${digest?.date ? `, ${digest.date}` : ""}) — ${status}`);
      if (digest?.summary) parts.push(`    Says: ${digest.summary}`);
      if (digest?.keyFacts) parts.push(`    Key facts: ${digest.keyFacts}`);
    }
  }

  // Outstanding tasks — already recorded; the agent must not re-create them.
  if (kb.outstandingTasks.length > 0 || (kb.droppedDocRequests ?? []).length > 0) {
    parts.push("");
    parts.push(`## Open follow-ups already recorded`);
    parts.push(`These follow-ups and document requests already exist for the broker — do NOT create them again (newTasks) and don't ask the seller for them again unless they bring it up. If the seller answers one, capture the answer as usual; if one turns out not to apply (e.g. "there is no such clause"), list its title in reasoning.resolvedDeferrals.`);
    for (const task of kb.outstandingTasks) {
      parts.push(`- [${task.type}] ${task.title}: ${task.description || "No details"}${task.relatedField ? ` (field: ${task.relatedField})` : ""}`);
    }
    for (const d of kb.droppedDocRequests ?? []) {
      parts.push(`- NOT requested — already on file: ${d}`);
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
    parts.push(`The seller has done an earlier session (status: ${ps.status}; ${ps.questionsAsked ?? 0} questions asked, ${ps.questionsAnswered ?? 0} answered). This is a new sitting: that conversation is NOT in your message history — its questions and answers are listed under PREVIOUS SESSIONS above, and everything the seller said there is already in the ALREADY ANSWERED list. Continue from there; never repeat a question that was answered.`);
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
    const sources = getFieldSources(extractedInfo as Record<string, unknown>);
    // A value is a lead (not a fact) when a CRM note, the website or social
    // media is its only source and the broker hasn't accepted it — the CIM
    // writers treat those as unconfirmed, so the score must too.
    const isLead = (key: string): boolean => {
      const src = sources[key];
      return !!src && LEAD_SOURCE_KINDS.has(String(src.source)) && !src.acceptedByBroker;
    };
    const fields = [...generic.map((g) => ({ ...g, alias: null as string | null })), ...extras].map(({ key: fieldName, label, extra, critical, alias }) => {
      // A checklist item may already be answered by a fact stored under a
      // general key (e.g. associate agreements inside keyEmployees).
      const own = extractedInfo[fieldName as keyof ExtractedInfo] ?? null;
      const usesAlias = !isSubstantiveValue(own) && !!alias;
      const raw = usesAlias ? (extractedInfo[alias as keyof ExtractedInfo] ?? null) : own;
      // Quality gate: junk placeholders don't count as answers
      const value = isSubstantiveValue(raw) ? stringifyCoverageValue(raw) : null;
      const valueKey = usesAlias ? alias! : fieldName;
      const unverified = value !== null && isLead(valueKey);
      const sessionConf = confidenceLevels?.[fieldName];
      const confidence: "confirmed" | "inferred" | "approximate" | "unknown" =
        !value ? "unknown"
        : unverified ? "inferred"
        : sessionConf === "confirmed" || sessionConf === "approximate" ? sessionConf
        : "inferred";
      const sellerSourced = value !== null && !unverified &&
        (SELLER_SOURCE_KINDS.has(String(sources[valueKey]?.source)) || sessionConf === "confirmed" || sessionConf === "approximate");
      return {
        fieldName, value, confidence,
        ...(label ? { label } : {}),
        ...(extra ? { industrySpecific: true, critical } : {}),
        ...(unverified ? { unverified: true } : {}),
        _seller: sellerSourced,
        _documented: value !== null && !unverified && ["document", "broker"].includes(String(sources[valueKey]?.source ?? "")),
      };
    });

    // Groups of alternatives (see SECTION_FIELD_GROUPS); anything not in a
    // group — industry checklist and broker-added items included — is its
    // own group. A group counts 1 when any member (or alias) holds a
    // verified value, LEAD_CREDIT when only a lead does.
    const fieldByKey = new Map(fields.map((f) => [f.fieldName, f]));
    const grouped = new Set<string>();
    const groups: { members: typeof fields; aliases: string[] }[] = [];
    for (const g of SECTION_FIELD_GROUPS[section.key] ?? []) {
      const members = g.keys.map((k) => fieldByKey.get(k)).filter((f): f is (typeof fields)[number] => !!f);
      if (members.length === 0) continue;
      members.forEach((m) => grouped.add(m.fieldName));
      groups.push({ members, aliases: g.aliases ?? [] });
    }
    for (const f of fields) if (!grouped.has(f.fieldName)) groups.push({ members: [f], aliases: [] });
    const groupScore = (g: (typeof groups)[number]): number => {
      if (g.members.some((m) => m.value !== null && !m.unverified)) return 1;
      const aliasValues = g.aliases.filter((a) => isSubstantiveValue(extractedInfo[a as keyof ExtractedInfo]));
      if (aliasValues.some((a) => !isLead(a))) return 1;
      if (g.members.some((m) => m.value !== null) || aliasValues.length > 0) return LEAD_CREDIT;
      return 0;
    };
    const score = groups.reduce((n, g) => n + groupScore(g), 0);
    const anyValue = groups.some((g) => groupScore(g) > 0);

    const coreFields = SECTION_CORE_FIELDS[section.key];
    const coreValue = coreFields ? fields.filter((f) => coreFields.includes(f.fieldName) && f.value !== null) : [];
    const coreMissing = coreFields !== undefined && coreValue.length === 0;
    const coreLeadOnly = coreFields !== undefined && coreValue.length > 0 && coreValue.every((f) => f.unverified);
    // A buyer-critical checklist item with nothing verified keeps the
    // section from reading "well covered", however much else is on file.
    const openCritical = fields.filter((f) => f.critical && (f.value === null || f.unverified));

    let status: SectionCoverage["status"];
    if (groups.length === 0 || !anyValue || coreMissing) {
      status = "missing";
    } else if (score >= groups.length * 0.6 && openCritical.length === 0 && !coreLeadOnly) {
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
      fields: fields.map(({ _seller, _documented, ...f }) => f),
      totalItems: fields.length,
      openItems: fields.filter((f) => f.value === null || f.unverified).length,
      openCriticalItems: openCritical.length,
      unverifiedItems: fields.filter((f) => f.unverified).length,
      sellerSourcedItems: fields.filter((f) => f._seller).length,
      documentedItems: fields.filter((f) => f._documented).length,
    };
  });
}

/** Coverage values are shown as text; map facts (revenue by year) read as "2024: $1.2M; 2023: …". */
function stringifyCoverageValue(v: unknown): string {
  if (typeof v === "string") return v;
  const repaired = repairCharIndexedValue(v);
  if (repaired && typeof repaired === "object" && !Array.isArray(repaired)) {
    return Object.entries(repaired as Record<string, unknown>).map(([k, x]) => `${k}: ${String(x)}`).join("; ");
  }
  return typeof repaired === "object" ? JSON.stringify(repaired) : String(repaired);
}

function parseLocation(
  deal: Deal,
  questionnaireData: Record<string, unknown> | null,
  /** The interview's view of the facts (never a broker-only source's). */
  facts: Partial<ExtractedInfo>,
): LocationContext | null {
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
  if (facts?.locations) {
    return { country: null, stateProvince: null, municipality: null, raw: facts.locations };
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
