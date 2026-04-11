/**
 * AI Interview Test Harness
 *
 * Simulates full seller interviews without needing a database.
 * Uses claude-sonnet-4-5 for test sellers and claude-opus-4-5 for the interview agent.
 *
 * Usage: ANTHROPIC_API_KEY=sk-... npx tsx server/interview/test-harness.ts
 */

import Anthropic from "@anthropic-ai/sdk";
import { buildInterviewSystemPrompt } from "./system-prompt";
import { INTERVIEW_RESPONSE_TOOL, type InterviewResponse, type InterviewReasoning } from "./response-schema";
import { mergeExtractedFields, updateIndustryContext } from "./info-merger";
import type { KnowledgeBase, IndustryContext, SectionCoverage, LocationContext } from "./knowledge-base";
import { CIM_SECTIONS, type ExtractedInfo } from "../../shared/schema";

// =====================
// Config
// =====================

const INTERVIEW_MODEL = "claude-opus-4-5";
const SELLER_MODEL = "claude-sonnet-4-5";
const MAX_TURNS = 30;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error("Error: ANTHROPIC_API_KEY environment variable required");
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });

// =====================
// Test Seller Personas
// =====================

interface SellerPersona {
  name: string;
  businessName: string;
  industry: string;
  subIndustry: string | null;
  location: { country: string; stateProvince: string; municipality: string };
  systemPrompt: string;
  questionnaireData: Record<string, unknown> | null;
}

const SELLER_PERSONAS: SellerPersona[] = [
  {
    name: "Mike - Construction Company Owner",
    businessName: "Pinnacle Contracting Ltd.",
    industry: "Construction",
    subIndustry: "Commercial General Contractor",
    location: { country: "Canada", stateProvince: "Ontario", municipality: "Hamilton" },
    questionnaireData: {
      businessName: "Pinnacle Contracting Ltd.",
      industry: "Construction",
      yearsInBusiness: "18",
      employees: "32",
      Location: "Hamilton, Ontario, Canada",
    },
    systemPrompt: `You are Mike, a 58-year-old construction company owner selling his business. You own Pinnacle Contracting Ltd., a commercial general contractor in Hamilton, Ontario, Canada. You've run it for 18 years. You have 32 employees.

PERSONALITY: Cooperative, honest, and willing to share. But you are NOT tech-savvy and NOT financially sophisticated. You think in terms of "jobs" not "projects," "guys" not "headcount." You use plain, blunt language. You sometimes ramble about war stories from job sites.

KNOWLEDGE LEVEL:
- You know your business inside and out operationally — you've been on every job site
- You're fuzzy on exact financial numbers — your accountant handles that. You know rough revenue ("about $8 million last year, maybe a bit more") but not margins or EBITDA
- You know your bonding capacity ("we're bonded up to $5 million per job") but couldn't explain how surety works
- You have a great safety record but don't know your exact EMR number ("it's good, we haven't had a lost-time injury in 3 years")
- You know your key employees well and talk about them by name
- You know your equipment — you own some, lease some, and can describe what's in the yard
- You don't really understand what a CIM is or what buyers want. You need things explained in plain terms
- Your lease is "I think it's up in a couple years, I'd have to check with my wife, she handles that stuff"
- When asked about customer concentration, you'd say "we do a lot of work for Mohawk College and the city, probably half our revenue"
- Your accounting is done by an external firm. You use Sage for job costing but your bookkeeper runs it

BEHAVIOR RULES:
- Answer questions directly but sometimes add extra context or stories
- If asked something you don't know, say so honestly: "I'd have to ask my accountant" or "I'm not sure about the exact number"
- If the interviewer uses jargon, ask what they mean or give a confused response
- You sometimes go off on tangents about specific jobs or employees
- You're a bit nervous about the sale — it's your baby. Occasionally express concern about your employees
- Give approximate numbers, not exact ones. "About 8 million" not "$8,247,000"
- You don't know what NAICS codes are
- When asked about growth opportunities, you'd mention that you turned down a bunch of municipal work last year because you were at capacity`,
  },
  {
    name: "Sandra - Restaurant Owner",
    businessName: "Sandra's Kitchen & Bar",
    industry: "Restaurant",
    subIndustry: "Full Service Restaurant",
    location: { country: "USA", stateProvince: "Texas", municipality: "Austin" },
    questionnaireData: {
      businessName: "Sandra's Kitchen & Bar",
      industry: "Restaurant / Food Service",
      yearsInBusiness: "7",
      Location: "Austin, TX",
    },
    systemPrompt: `You are Sandra, a 44-year-old restaurant owner selling Sandra's Kitchen & Bar in Austin, Texas. It's a full-service restaurant and bar, 7 years old. You want to sell because you're burned out and going through a divorce — but you're cagey about saying that directly.

PERSONALITY: Guarded and evasive about financials and the reason for sale. You give vague answers and try to paint a rosy picture. You minimize problems. You deflect hard questions with "it's fine" or "that's not really an issue." You're charming but slippery.

KNOWLEDGE LEVEL:
- You know the restaurant well but avoid concrete numbers, especially about money
- You claim "good revenue" but won't give specifics easily. When pushed, you'll eventually say "somewhere around $1.5 million"
- You downplay food costs ("pretty standard, nothing crazy") and labour costs ("we run lean")
- Your liquor license is in your personal name — this is actually a complication you don't fully understand
- You have no idea about your lease transfer provisions. You've "always just paid rent and it's been fine"
- You have 22 employees (you'll say "about 20"). High turnover but you say "that's just the industry"
- You use Toast POS but you don't really check the reports. Your manager does "the numbers stuff"
- When asked about health inspections, you get defensive: "we've never had a problem"
- Your actual food cost is 38% (high) and labour is 35% (also high) but you genuinely don't know these numbers
- You have a patio that adds significant seasonal revenue but you'll describe it casually, not as a strategic asset
- You serve 300 covers on a busy weekend night but would say "we get pretty packed on weekends"

BEHAVIOR RULES:
- Be vague by default. Only get specific when the interviewer explains why the information matters and pushes 2-3 times
- Deflect questions about finances: "I mean, we do well" or "I'd have to look at that"
- Get slightly defensive if pushed too hard: "look, the restaurant is doing great, I don't see why we need to get into all that"
- Eventually relent when the interviewer explains things clearly — you're not hostile, just guarded
- Your reason for sale: start with "I'm ready for something new." If pushed, say "personal reasons." Only with real empathy would you admit "I'm going through some changes in my personal life"
- Don't volunteer information. Wait to be asked
- If asked about something you don't know (lease details, specific financials), blame it on your accountant or lawyer
- Occasionally mention that Austin is a great food scene and the restaurant has "a loyal following"`,
  },
  {
    name: "Dr. Priya Sharma - Medical Practice Owner",
    businessName: "Lakeview Family Health Centre",
    industry: "Healthcare",
    subIndustry: "Family Medicine Practice",
    location: { country: "Canada", stateProvince: "British Columbia", municipality: "Kelowna" },
    questionnaireData: {
      businessName: "Lakeview Family Health Centre",
      industry: "Healthcare - Family Medicine",
      yearsInBusiness: "12",
      employees: "8 (2 physicians, 1 nurse practitioner, 3 medical office assistants, 1 office manager, 1 part-time bookkeeper)",
      Location: "Kelowna, BC, Canada",
      annualRevenue: "Approximately $2.8M",
      reasonForSale: "Relocating to be closer to family",
    },
    systemPrompt: `You are Dr. Priya Sharma, a 52-year-old family physician selling your medical practice, Lakeview Family Health Centre, in Kelowna, BC, Canada. You've run it for 12 years. You are relocating to Toronto to be closer to aging parents.

PERSONALITY: Extremely organized, detail-oriented, and forthcoming. You're the ideal interview subject — you give precise, comprehensive answers and sometimes volunteer information before being asked. You think analytically and anticipate what buyers would want to know.

KNOWLEDGE LEVEL:
- You know every detail of your practice: exact patient panel size (3,200 active patients), payer mix (95% MSP billing, 5% private services like cosmetic procedures and occupational health), and revenue breakdown
- Annual revenue: $2.8M. You know your overhead ratio (62%), your take-home, and your associate physicians' compensation structure
- You have 8 employees: 2 associate physicians (both on fee-split arrangements — 70/30), 1 nurse practitioner, 3 MOAs, 1 office manager, 1 part-time bookkeeper
- You use OSCAR EMR (you know this is important for buyers and have already prepared a data migration plan)
- Your building is leased — 3 years remaining on a 10-year lease. $4,200/month. Landlord has already indicated willingness to assign or extend for a new owner
- You've already consulted with a healthcare lawyer about the regulatory requirements for practice transfer in BC: College of Physicians and Surgeons of BC notification, MSP billing number transitions, patient notification requirements
- You know your biggest risk is physician retention: one associate has been with you 8 years (stable), the other is newer (2 years)
- You can articulate your competitive advantage: walk-in availability, same-day appointments, extended hours, and a growing telehealth component (started during COVID, now 15% of visits)
- You have no debt against the practice. Equipment is fully owned, last major purchase was a $45,000 ultrasound machine 3 years ago
- You've been approached by two corporate buyers already (Telus Health and a local physician group) but prefer a sole practitioner buyer for continuity of care

BEHAVIOR RULES:
- Provide detailed, precise answers with specific numbers
- Volunteer related information proactively: "And you'll probably want to know about..."
- Occasionally ask the interviewer smart questions: "Would buyers want to see our patient satisfaction surveys?"
- Reference specific documents you can provide: "I have that in a spreadsheet I can send"
- Think aloud about what a buyer would want: "From a buyer's perspective, the key risk would be..."
- Be patient and cooperative throughout
- If asked something you don't know, identify exactly who does know and how to get it
- Correct misconceptions about medical practice sales if the interviewer oversimplifies`,
  },
  {
    name: "Tom - Retail Store Owner",
    businessName: "Tom's Outdoor Adventure",
    industry: "Retail",
    subIndustry: "Outdoor Recreation Retail",
    location: { country: "USA", stateProvince: "Colorado", municipality: "Boulder" },
    questionnaireData: {
      businessName: "Tom's Outdoor Adventure",
      industry: "Retail",
      yearsInBusiness: "15",
      Location: "Boulder, CO",
    },
    systemPrompt: `You are Tom, a 61-year-old retail store owner selling Tom's Outdoor Adventure in Boulder, Colorado. It's an outdoor recreation retail store — hiking, camping, climbing, skiing gear. You've run it for 15 years. You want to retire and travel.

PERSONALITY: Enthusiastic and talkative, but doesn't understand what buyers care about. You focus on the wrong things — how much you love the business, the cool brands you carry, your personal relationships with customers. You don't understand financial concepts and think the business is worth more than it probably is because "Boulder is a great market."

KNOWLEDGE LEVEL:
- You know your products and customers well but not your business metrics
- You think revenue is "around $2 million" but you haven't looked at financials recently. Actual is $1.8M and declining slightly due to online competition
- You have 8 employees (mix of full-time and seasonal). You pay "competitive wages" but don't know your exact labour cost percentage
- You carry $400K in inventory but describe it as "well-stocked." You don't understand inventory turns as a concept
- Your lease is $6,500/month, comes up for renewal in 18 months. You haven't thought about transferability
- You have no e-commerce presence. When asked, you say "we've thought about it" but haven't acted. You think people "want the in-store experience"
- You don't know your gross margin. You know you mark things up "usually around 40-50%" but that's retail markup, not margin
- You carry brands like Patagonia, The North Face, Black Diamond — but you don't understand that brand authorization may not transfer to a new owner
- Seasonal business: 60% of revenue is October-March (ski season) but you'd describe it as "we're busy year-round, just busier in winter"
- You think your "reputation" and "community involvement" are the biggest selling points. You sponsor local climbing events
- Your biggest competitor is REI and online retailers. You differentiate on "personal service" and "expertise"
- You use QuickBooks but your bookkeeper does it all. You "just check the bank account"

BEHAVIOR RULES:
- Be enthusiastic and talk a lot, but about the wrong things (stories about customers, how great Boulder is, cool products)
- When asked a specific business question, give a vague answer and pivot to something you're more comfortable talking about
- Show genuine confusion about financial concepts. "EBITDA? I've heard of that but I don't really know what it is"
- Overstate the value of intangible assets: "the brand is worth a lot" and "people come here because of the experience"
- Be unaware of risks: don't bring up online competition as a threat unless directly asked
- When told something matters to buyers, be surprised: "Really? I wouldn't have thought that matters"
- You're not evasive — you just genuinely don't know business metrics and don't think they're as important as the "story" of the business
- If asked about growth, talk about adding new brands or hosting more events — not about e-commerce, which is the obvious play
- Be cooperative but need a lot of coaching about what information actually matters`,
  },
];

// =====================
// Section-to-field mapping (copied from knowledge-base.ts to avoid import issues)
// =====================

const SECTION_FIELD_MAP: Record<string, string[]> = {
  overview: [
    "businessName", "industry", "companyHistory", "yearsOperating",
    "entityType", "brandIdentity", "missionStatement", "coreValues",
    "ownershipHistory", "industryPerception", "customerPerception", "accolades",
  ],
  strengths: ["competitiveAdvantage", "uniqueSellingProposition", "strengths"],
  growth_potential: ["growthOpportunities", "expansionPlans"],
  target_market: [
    "targetMarket", "primaryMarket", "secondaryMarket",
    "b2bBreakdown", "customerDemographics", "customerBase",
  ],
  permits_licenses: ["permitsLicenses", "complianceRequirements"],
  seasonality: ["seasonality", "peakPeriods", "slowPeriods"],
  revenue_sources: [
    "revenueStreams", "keyProducts", "customerConcentration",
    "annualRevenue", "revenueGrowth", "operatingMargins",
  ],
  real_estate: ["leaseDetails", "propertyInfo", "realEstateIncluded"],
  employees: [
    "employees", "employeeStructure", "keyEmployees", "ownerInvolvement",
    "managementTeam",
  ],
  operations: ["suppliers", "supplyChain", "technologySystems", "operationalSystems"],
  buyer_profile: ["idealBuyer"],
  training_support: ["trainingSupport", "transitionPlan"],
  reason_for_sale: ["reasonForSale"],
  financials: [
    "annualRevenue", "revenueGrowth", "operatingMargins",
    "workingCapital", "debt",
  ],
  asking_price: ["askingPrice", "saleType", "assetsIncluded", "inventory"],
};

// =====================
// Fake Knowledge Base Builder
// =====================

function buildMockKnowledgeBase(persona: SellerPersona, extractedInfo: Partial<ExtractedInfo>, industryContext: IndustryContext | null): KnowledgeBase {
  const sectionCoverage = buildSectionCoverage(extractedInfo);

  return {
    business: {
      name: persona.businessName,
      industry: persona.industry,
      subIndustry: persona.subIndustry,
      description: null,
      location: {
        country: persona.location.country,
        stateProvince: persona.location.stateProvince,
        municipality: persona.location.municipality,
        raw: null,
      },
    },
    sectionCoverage,
    industryContext,
    questionnaireData: persona.questionnaireData,
    operationalSystems: null,
    documents: [],
    outstandingTasks: [],
    priorSessionSummary: null,
    extractedInfo,
    sellerProfile: null,
    scrapedData: null,
    scrapeSource: null,
  };
}

function buildSectionCoverage(extractedInfo: Partial<ExtractedInfo>): SectionCoverage[] {
  return CIM_SECTIONS.map((section) => {
    const fieldNames = SECTION_FIELD_MAP[section.key] || [];
    const fields = fieldNames.map((fieldName) => {
      const value = extractedInfo[fieldName as keyof ExtractedInfo] ?? null;
      return {
        fieldName,
        value: value as string | null,
        confidence: (value ? "confirmed" : "unknown") as "confirmed" | "inferred" | "approximate" | "unknown",
      };
    });

    const populatedCount = fields.filter((f) => f.value !== null).length;
    const totalCount = fields.length;

    let status: SectionCoverage["status"];
    if (totalCount === 0 || populatedCount === 0) {
      status = "missing";
    } else if (populatedCount >= totalCount * 0.6) {
      status = "well_covered";
    } else {
      status = "partial";
    }

    return { key: section.key, title: section.title, order: section.order, status, fields };
  });
}

// =====================
// Evaluation Criteria
// =====================

interface EvalResult {
  persona: string;
  turns: number;
  sectionsWellCovered: number;
  sectionsPartial: number;
  sectionsMissing: number;
  totalFieldsCaptured: number;
  industryIdentified: boolean;
  industryTopicsAsked: string[];
  deferredTopics: string[];
  tasksCreated: number;
  issues: string[];
  transcript: Array<{ role: "seller" | "agent"; content: string; turn: number }>;
  rawResponses: InterviewResponse[];
}

function evaluateInterview(
  persona: SellerPersona,
  transcript: EvalResult["transcript"],
  extractedInfo: Partial<ExtractedInfo>,
  industryContext: IndustryContext | null,
  rawResponses: InterviewResponse[],
  tasksCreated: number,
): EvalResult {
  const coverage = buildSectionCoverage(extractedInfo);
  const issues: string[] = [];

  // Check: Did the agent identify the industry?
  const industryIdentified = industryContext !== null && industryContext.industry.length > 0;
  if (!industryIdentified) {
    issues.push("CRITICAL: Agent never identified the industry context");
  }

  // Check: Did the agent ask industry-specific questions?
  const allIndustryTopics = rawResponses.flatMap(r => [
    ...r.reasoning.industryContext.activeIndustryTopics,
    ...r.reasoning.industryContext.coveredIndustryTopics,
  ]);
  const uniqueIndustryTopics = [...new Set(allIndustryTopics)];
  if (uniqueIndustryTopics.length < 3) {
    issues.push(`WEAK: Only ${uniqueIndustryTopics.length} industry-specific topics identified (expected 5+)`);
  }

  // Check: Did the agent ever ask multiple questions at once?
  for (const resp of rawResponses) {
    const questionMarks = (resp.message.match(/\?/g) || []).length;
    if (questionMarks > 2) {
      issues.push(`FORM-LIKE: Agent asked ${questionMarks} questions in one message (turn)`);
    }
  }

  // Check: Did the agent explain why information matters?
  const explainPhrases = ["buyer", "due diligence", "valuation", "multiple", "risk", "matters because", "important because", "want to see", "want to know", "look for"];
  let explanationCount = 0;
  for (const resp of rawResponses) {
    if (explainPhrases.some(p => resp.message.toLowerCase().includes(p))) {
      explanationCount++;
    }
  }
  if (explanationCount < 3) {
    issues.push(`WEAK: Agent rarely explained why information matters to buyers (${explanationCount} times)`);
  }

  // Check: Did the agent give retrieval instructions when seller didn't know?
  const retrivalPhrases = ["quickbooks", "go to", "ask your", "check your", "look in", "your accountant", "you can find", "report"];
  let retrievalCount = 0;
  for (const resp of rawResponses) {
    if (retrivalPhrases.some(p => resp.message.toLowerCase().includes(p))) {
      retrievalCount++;
    }
  }

  // Check: Were deferred topics ever circled back to?
  const deferredTopics = rawResponses.flatMap(r => r.reasoning.deferredTopics);
  const circleBackCount = rawResponses.filter(r => r.reasoning.topicStatus === "circling_back").length;
  if (deferredTopics.length > 0 && circleBackCount === 0) {
    issues.push("WEAK: Agent deferred topics but never circled back to any");
  }

  // Check: Did the agent feel conversational vs form-like?
  const shortResponses = rawResponses.filter(r => r.message.length < 100).length;
  if (shortResponses > rawResponses.length * 0.7) {
    issues.push("FORM-LIKE: Majority of agent responses are very short (may feel robotic)");
  }

  const longResponses = rawResponses.filter(r => r.message.length > 600).length;
  if (longResponses > rawResponses.length * 0.3) {
    issues.push("VERBOSE: Agent is too wordy in >30% of responses");
  }

  // Check section coverage
  const wellCovered = coverage.filter(s => s.status === "well_covered").length;
  const partial = coverage.filter(s => s.status === "partial").length;
  const missing = coverage.filter(s => s.status === "missing").length;

  const totalFields = Object.values(extractedInfo).filter(v => v !== null && v !== undefined && v !== "").length;

  if (wellCovered < 5) {
    issues.push(`LOW COVERAGE: Only ${wellCovered}/15 sections well covered`);
  }

  return {
    persona: persona.name,
    turns: transcript.length,
    sectionsWellCovered: wellCovered,
    sectionsPartial: partial,
    sectionsMissing: missing,
    totalFieldsCaptured: totalFields,
    industryIdentified,
    industryTopicsAsked: uniqueIndustryTopics,
    deferredTopics: [...new Set(deferredTopics)],
    tasksCreated,
    issues,
    transcript,
    rawResponses,
  };
}

// =====================
// Interview Simulation
// =====================

async function simulateInterview(persona: SellerPersona): Promise<EvalResult> {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`STARTING INTERVIEW: ${persona.name}`);
  console.log(`Business: ${persona.businessName} (${persona.industry})`);
  console.log(`${"=".repeat(60)}\n`);

  let extractedInfo: Partial<ExtractedInfo> = {};
  let industryContext: IndustryContext | null = null;
  let confidenceLevels: Record<string, string> = {};
  const transcript: EvalResult["transcript"] = [];
  const rawResponses: InterviewResponse[] = [];
  let tasksCreated = 0;

  // Conversation history for both agents
  const agentMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
  const sellerMessages: Array<{ role: "user" | "assistant"; content: string }> = [];

  // Step 1: Generate opening message from interview agent
  const kb = buildMockKnowledgeBase(persona, extractedInfo, industryContext);
  const systemPrompt = await buildInterviewSystemPrompt(kb);

  const hasQuestionnaireData = persona.questionnaireData && Object.keys(persona.questionnaireData).length > 0;
  let openingInstruction: string;
  if (hasQuestionnaireData) {
    openingInstruction = `This is the start of the interview. The seller has completed a questionnaire. Welcome them, acknowledge you've reviewed their answers, and start with a question that builds on something they already told you — or explores an area their questionnaire didn't cover well.`;
  } else {
    openingInstruction = `This is the start of the interview. You don't have much background yet. Welcome the seller warmly, briefly explain the purpose of the interview, and start with a broad opening question.`;
  }

  console.log("  Generating opening message...");
  const openingResponse = await anthropic.messages.create({
    model: INTERVIEW_MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    tools: [INTERVIEW_RESPONSE_TOOL],
    tool_choice: { type: "tool", name: "interview_response" },
    messages: [
      { role: "user", content: `[SYSTEM: ${openingInstruction}]\n\nGenerate your opening message to the seller. The business is "${persona.businessName}".` },
    ],
  });

  const openingBlock = openingResponse.content.find(b => b.type === "tool_use");
  if (!openingBlock || openingBlock.type !== "tool_use") {
    throw new Error("No tool use in opening");
  }

  const openingResult = openingBlock.input as unknown as InterviewResponse;
  rawResponses.push(openingResult);

  // Process opening extracted fields and industry context
  if (Object.keys(openingResult.extractedFields).length > 0) {
    const mergeResult = mergeExtractedFields(extractedInfo as Record<string, string>, openingResult.extractedFields, confidenceLevels);
    extractedInfo = mergeResult.merged;
    confidenceLevels = mergeResult.updatedConfidence;
  }

  if (openingResult.reasoning.industryContext.identified) {
    industryContext = updateIndustryContext(industryContext, openingResult.reasoning, kb.business.location);
  }

  transcript.push({ role: "agent", content: openingResult.message, turn: 0 });
  console.log(`  AGENT: ${openingResult.message.substring(0, 120)}...`);

  // Initialize conversation histories
  agentMessages.push(
    { role: "user", content: `[SYSTEM: ${openingInstruction}]\n\nGenerate your opening message to the seller. The business is "${persona.businessName}".` },
    { role: "assistant", content: JSON.stringify(openingResult) }, // Simplified — we just need context continuity
  );

  // Step 2: Run the conversation loop
  let currentAgentMessage = openingResult.message;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    // Generate seller response
    sellerMessages.push({ role: "user", content: currentAgentMessage });

    console.log(`\n  --- Turn ${turn} ---`);
    console.log("  Generating seller response...");

    const sellerResponse = await anthropic.messages.create({
      model: SELLER_MODEL,
      max_tokens: 1024,
      system: persona.systemPrompt + `\n\nIMPORTANT: You are in a conversation with an M&A advisor who is interviewing you about your business. Respond naturally as this character would. Keep your responses to 1-4 sentences typically — like a real conversation, not an essay. If the advisor asks something you don't know, say so. If they ask something personal or sensitive, respond as your character would.`,
      messages: sellerMessages,
    });

    const sellerText = sellerResponse.content
      .filter(b => b.type === "text")
      .map(b => b.type === "text" ? b.text : "")
      .join("");

    transcript.push({ role: "seller", content: sellerText, turn });
    sellerMessages.push({ role: "assistant", content: sellerText });
    console.log(`  SELLER: ${sellerText.substring(0, 120)}...`);

    // Generate interview agent response
    const updatedKb = buildMockKnowledgeBase(persona, extractedInfo, industryContext);
    const updatedSystemPrompt = await buildInterviewSystemPrompt(updatedKb);

    // Build clean conversation for the agent (without the system bootstrap message)
    const cleanAgentMessages: Array<{ role: "user" | "assistant"; content: string }> = [];
    // Add all prior exchanges
    for (let i = 0; i < transcript.length; i++) {
      const entry = transcript[i];
      if (entry.role === "agent") {
        cleanAgentMessages.push({ role: "assistant", content: entry.content });
      } else {
        cleanAgentMessages.push({ role: "user", content: entry.content });
      }
    }

    console.log("  Generating agent response...");
    const agentResponse = await anthropic.messages.create({
      model: INTERVIEW_MODEL,
      max_tokens: 2048,
      system: updatedSystemPrompt,
      tools: [INTERVIEW_RESPONSE_TOOL],
      tool_choice: { type: "tool", name: "interview_response" },
      messages: cleanAgentMessages,
    });

    const agentBlock = agentResponse.content.find(b => b.type === "tool_use");
    if (!agentBlock || agentBlock.type !== "tool_use") {
      console.log("  WARNING: Agent did not return structured response, ending interview");
      break;
    }

    const agentResult = agentBlock.input as unknown as InterviewResponse;
    rawResponses.push(agentResult);

    // Process extracted fields
    if (Object.keys(agentResult.extractedFields).length > 0) {
      const mergeResult = mergeExtractedFields(
        extractedInfo as Record<string, string>,
        agentResult.extractedFields,
        confidenceLevels,
      );
      extractedInfo = mergeResult.merged;
      confidenceLevels = mergeResult.updatedConfidence;
    }

    // Update industry context
    industryContext = updateIndustryContext(industryContext, agentResult.reasoning, updatedKb.business.location);

    // Count tasks
    tasksCreated += agentResult.newTasks.length;

    transcript.push({ role: "agent", content: agentResult.message, turn });
    console.log(`  AGENT: ${agentResult.message.substring(0, 120)}...`);
    console.log(`  [Reasoning: topic=${agentResult.reasoning.currentTopic}, status=${agentResult.reasoning.topicStatus}, fields=${Object.keys(agentResult.extractedFields).length}]`);

    currentAgentMessage = agentResult.message;

    // Check for end
    if (agentResult.shouldEnd) {
      console.log(`\n  INTERVIEW ENDED: ${agentResult.endReason}`);
      break;
    }
  }

  // Evaluate
  return evaluateInterview(persona, transcript, extractedInfo, industryContext, rawResponses, tasksCreated);
}

// =====================
// Report Generation
// =====================

function printReport(results: EvalResult[]): void {
  console.log(`\n\n${"#".repeat(60)}`);
  console.log(`# INTERVIEW TEST RESULTS`);
  console.log(`${"#".repeat(60)}\n`);

  for (const result of results) {
    console.log(`\n${"─".repeat(50)}`);
    console.log(`PERSONA: ${result.persona}`);
    console.log(`${"─".repeat(50)}`);
    console.log(`  Turns: ${result.turns}`);
    console.log(`  Fields captured: ${result.totalFieldsCaptured}`);
    console.log(`  Coverage: ${result.sectionsWellCovered} well / ${result.sectionsPartial} partial / ${result.sectionsMissing} missing`);
    console.log(`  Industry identified: ${result.industryIdentified}`);
    console.log(`  Industry topics tracked: ${result.industryTopicsAsked.length} (${result.industryTopicsAsked.join(", ")})`);
    console.log(`  Deferred topics: ${result.deferredTopics.length} (${result.deferredTopics.join(", ")})`);
    console.log(`  Tasks created: ${result.tasksCreated}`);

    if (result.issues.length > 0) {
      console.log(`\n  ISSUES:`);
      for (const issue of result.issues) {
        console.log(`    ⚠ ${issue}`);
      }
    } else {
      console.log(`\n  ✓ No issues detected`);
    }
  }

  // Summary
  const totalIssues = results.flatMap(r => r.issues);
  const criticalIssues = totalIssues.filter(i => i.startsWith("CRITICAL"));
  const weakIssues = totalIssues.filter(i => i.startsWith("WEAK"));
  const formIssues = totalIssues.filter(i => i.startsWith("FORM"));

  console.log(`\n${"═".repeat(50)}`);
  console.log(`SUMMARY`);
  console.log(`${"═".repeat(50)}`);
  console.log(`  Total interviews: ${results.length}`);
  console.log(`  Total issues: ${totalIssues.length}`);
  console.log(`    Critical: ${criticalIssues.length}`);
  console.log(`    Weak: ${weakIssues.length}`);
  console.log(`    Form-like: ${formIssues.length}`);
  console.log(`  Avg fields captured: ${(results.reduce((s, r) => s + r.totalFieldsCaptured, 0) / results.length).toFixed(1)}`);
  console.log(`  Avg sections well covered: ${(results.reduce((s, r) => s + r.sectionsWellCovered, 0) / results.length).toFixed(1)}/15`);
}

// =====================
// Main
// =====================

async function main() {
  const personaArg = process.argv[2]; // Optional: run specific persona by index or name
  let personas = SELLER_PERSONAS;

  if (personaArg) {
    const idx = parseInt(personaArg);
    if (!isNaN(idx) && idx >= 0 && idx < SELLER_PERSONAS.length) {
      personas = [SELLER_PERSONAS[idx]];
    } else {
      const match = SELLER_PERSONAS.find(p => p.name.toLowerCase().includes(personaArg.toLowerCase()));
      if (match) personas = [match];
    }
  }

  console.log(`Running ${personas.length} interview simulation(s)...`);
  console.log(`Interview agent: ${INTERVIEW_MODEL}`);
  console.log(`Seller simulator: ${SELLER_MODEL}`);

  const results: EvalResult[] = [];

  for (const persona of personas) {
    try {
      const result = await simulateInterview(persona);
      results.push(result);
    } catch (error: any) {
      console.error(`\nERROR with ${persona.name}: ${error.message}`);
      if (error.message?.includes("credit balance")) {
        console.error("API credits depleted. Cannot continue.");
        break;
      }
    }
  }

  if (results.length > 0) {
    printReport(results);
  }
}

main().catch(console.error);
