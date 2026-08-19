/**
 * Defines the structured response schema for the interview agent.
 * This is used as a Claude tool definition so the model returns
 * structured JSON alongside its conversational message.
 */

// =====================
// TypeScript types
// =====================

export interface InterviewResponse {
  /** The conversational message shown to the seller */
  message: string;

  /**
   * One-sentence buyer-rationale for the question just asked — shown behind a
   * "Why we ask this" affordance so the seller understands the purpose
   * without the message itself getting preachy.
   */
  whyItMatters?: string;

  /** Pre-populated answer options the seller can click to respond */
  suggestedAnswers: string[];

  /** New or updated extracted fields from this turn */
  extractedFields: Record<string, ExtractedField>;

  /** Internal reasoning (not shown to the seller) */
  reasoning: InterviewReasoning;

  /**
   * BROKER-PRIVATE notes — sensitive facts the broker needs for context but
   * which must NEVER appear in any CIM or be repeated to the seller
   * unprompted (health, litigation detail, family circumstances, staff
   * departures the seller asked kept quiet). Stored outside the CIM-feeding
   * fields. The public-safe framing goes in extractedFields instead.
   */
  privateNotes?: { note: string; reason: string }[];

  /** Tasks to create for deferred/unresolvable items */
  newTasks: NewTask[];

  /** Whether the interview should end after this turn */
  shouldEnd: boolean;

  /** If ending, why */
  endReason?: string;
}

export interface ExtractedField {
  value: string;
  confidence: "confirmed" | "inferred" | "approximate";
  source: "seller_statement" | "document" | "questionnaire";
  /**
   * Grounding constraint — how this value relates to what the seller actually
   * said this turn. "verbatim" = the seller stated it (possibly reworded);
   * "computed" = arithmetic on numbers the seller gave; "inferred" = a
   * reasonable derivation. Only "verbatim" values may carry confidence
   * "confirmed" — the normalizer enforces this mechanically.
   */
  basis?: "verbatim" | "computed" | "inferred";
}

/** A topic the agent set aside this turn, with enough context to circle back. */
export interface NewDeferral {
  /** Short stable topic label, e.g. "customer_concentration" or "lease terms" */
  topic: string;
  /** Why it was deferred (seller declined, needs lookup, seller dodged, etc.) */
  reason: string;
  /** Where the information lives (system, document, person), if known */
  whereInfoLives: string;
}

export interface InterviewReasoning {
  /** Which CIM section area we're currently exploring */
  currentTopic: string;

  /** Status of the current topic */
  topicStatus: "exploring" | "probing" | "moving_on" | "circling_back" | "dodged";

  /** Topics deferred THIS TURN (appended to the durable server-side ledger) */
  newDeferrals: NewDeferral[];

  /** Previously deferred topics that were RESOLVED this turn (ledger keys/labels) */
  resolvedDeferrals: string[];

  /** Topics not yet covered that you plan to reach — planning, NOT deferrals */
  plannedTopics: string[];

  /** What the agent plans to ask next and why */
  nextIntent: string;

  /**
   * Re-ask guard — before composing the question, the model names the
   * ALREADY ANSWERED keys closest to it and states the delta it is asking
   * for. Forces attention onto the on-file facts at generation time.
   */
  priorCheck: string;

  /** Industry context — identified once, persists across turns */
  industryContext: {
    identified: boolean;
    industry: string;
    subIndustry: string;
    location: string;
    /** Industry-specific areas to cover (beyond standard CIM sections) */
    activeIndustryTopics: string[];
    /** Industry-specific areas already well covered */
    coveredIndustryTopics: string[];
    /** Location-specific regulatory notes */
    regulatoryNotes: string[];
  };
}

export interface NewTask {
  type: "document_request" | "follow_up" | "skipped_question";
  title: string;
  /** Full context for the broker about what was asked and why it matters */
  description: string;
  /** The extractedInfo field this relates to, if any */
  relatedField: string;
  /** What the seller said about why they couldn't provide this */
  sellerExplanation: string;
}

// =====================
// Claude tool definition
// =====================

/**
 * The tool definition passed to Claude's API so it returns
 * structured interview responses via tool_use.
 */
export const INTERVIEW_RESPONSE_TOOL = {
  name: "interview_response",
  description: "Structure your response to the seller, including the conversational message, extracted information, reasoning about next steps, and any tasks to create.",
  input_schema: {
    type: "object" as const,
    required: ["message", "suggestedAnswers", "extractedFields", "reasoning", "newTasks", "shouldEnd"],
    properties: {
      message: {
        type: "string",
        description: "Your conversational message to the seller. This is what they see. Keep it warm, professional, and concise. One brief acknowledgment of their answer, then your next question.",
      },
      whyItMatters: {
        type: "string",
        description: "One sentence explaining why the question you just asked matters to buyers — e.g. 'Buyers discount heavily for owner-dependent operations, so demonstrating a capable team directly increases your valuation.' Shown to the seller only when they tap 'Why we ask this'. Keep it specific to this business and this question, never generic. Omit when the message isn't asking a question (e.g. wrap-up turns).",
      },
      suggestedAnswers: {
        type: "array",
        items: { type: "string" },
        description: "3–5 short, clickable answer options for the question you just asked. The seller can tap one to pre-fill their reply, then edit it before sending. Rules: (1) Keep each option brief — 2 to 8 words. (2) Base them on your industry knowledge and what you already know about this specific business. (3) All options must answer the SAME dimension of the question — if the question has two parts, suggest for the primary part only. (4) For yes/no questions include both options. (5) If the knowledge base already contains a value relevant to the question, options must be consistent with it — never guess at a number already on file. (6) For questions asking for an exact figure the seller would know precisely, never guess numbers — instead offer honest escape hatches ('Not sure, I'd have to check', 'My accountant would know'). (7) For predictably sensitive questions (reason for sale, health, family, litigation), one option must be a graceful deferral like 'I'd rather discuss that with my broker privately'. (8) Always make the options feel specific to this business and industry, not generic placeholders.",
      },
      extractedFields: {
        type: "object",
        description: "Key-value map of newly extracted or updated information from this turn. Keys should match the extractedInfo schema fields (e.g., 'employees', 'leaseDetails', 'keyProducts') — reuse an EXISTING key from the knowledge base whenever one covers the concept; only mint a new key for a genuinely new concept. Only include fields where the seller provided NEW or CHANGED information in this turn. GROUNDING (critical): a value may only assert what the seller actually stated. If the seller deflected, dodged, or answered a quantitative or yes/no question without the quantity or the yes/no, emit NO field for that topic — set reasoning.topicStatus to 'dodged' and add it to newDeferrals instead. Never write a claim the seller did not make.",
        additionalProperties: {
          type: "object",
          required: ["value", "confidence", "source", "basis"],
          properties: {
            value: {
              type: "string",
              description: "The extracted information value. Must be supported by what the seller actually said — never an assumption, never a charitable filling-in of a dodge.",
            },
            confidence: {
              type: "string",
              enum: ["confirmed", "inferred", "approximate"],
              description: "How confident we are in this data. 'confirmed' = seller explicitly stated it. 'inferred' = reasonably derived from what they said. 'approximate' = seller gave a rough estimate. Only basis 'verbatim' values may be 'confirmed'.",
            },
            source: {
              type: "string",
              enum: ["seller_statement", "document", "questionnaire"],
              description: "Where this information came from. Almost always 'seller_statement' during an interview.",
            },
            basis: {
              type: "string",
              enum: ["verbatim", "computed", "inferred"],
              description: "Grounding: 'verbatim' = the seller stated this (possibly reworded, meaning preserved). 'computed' = arithmetic on numbers the seller gave (e.g. converting dollars to a percentage). 'inferred' = derived from context. If you cannot honestly call it one of these, do not emit the field.",
            },
          },
        },
      },
      reasoning: {
        type: "object",
        required: ["currentTopic", "topicStatus", "newDeferrals", "resolvedDeferrals", "plannedTopics", "priorCheck", "nextIntent", "industryContext"],
        description: "Your internal reasoning about the interview state. This is NOT shown to the seller.",
        properties: {
          currentTopic: {
            type: "string",
            description: "Which CIM section or topic area you're currently exploring (e.g., 'employees', 'real_estate', 'industry_specific:liquor_licensing').",
          },
          topicStatus: {
            type: "string",
            enum: ["exploring", "probing", "moving_on", "circling_back", "dodged"],
            description: "What you're doing with the current topic. 'exploring' = initial questions. 'probing' = pushing for more detail on a vague answer. 'moving_on' = this topic is covered or deferred. 'circling_back' = revisiting a previously deferred topic. 'dodged' = the seller deflected without answering — capture NOTHING for it, add it to newDeferrals, and plan a later reframe.",
          },
          newDeferrals: {
            type: "array",
            description: "Topics deferred THIS TURN only. The server keeps a durable ledger — you'll see the open items in your prompt as OPEN DEFERRALS. Do NOT re-list already-open items here; only genuinely new deferrals.",
            items: {
              type: "object",
              required: ["topic", "reason", "whereInfoLives"],
              properties: {
                topic: {
                  type: "string",
                  description: "Short stable topic label, e.g. 'customer_concentration' or 'exact lease figures'.",
                },
                reason: {
                  type: "string",
                  description: "Why it was deferred: needs to look it up, seller dodged, sensitive, etc. If the seller explicitly REFUSED to share (privacy, broker-only), phrase the reason with the words 'declined to share' or 'only with their broker' — the server hard-blocks re-asking declined topics, so the distinction matters: a lookup gap gets circled back, a refusal never does.",
                },
                whereInfoLives: {
                  type: "string",
                  description: "Where the answer lives if known — a system (QuickBooks, Jobber), a document, or a person (accountant, office manager). Empty string if unknown.",
                },
              },
            },
          },
          resolvedDeferrals: {
            type: "array",
            items: { type: "string" },
            description: "Topic labels from the OPEN DEFERRALS list where the INFORMATION ITSELF was obtained this turn — the seller answered, or the value arrived via a document. The answer must appear in extractedFields. Creating a broker task, follow-up, or document request does NOT resolve a deferral: the topic stays open until the actual answer exists. The server marks them resolved on the ledger.",
          },
          plannedTopics: {
            type: "array",
            items: { type: "string" },
            description: "Topics not yet covered that you still plan to reach. This is your planning list — NEVER put not-yet-asked topics into newDeferrals; a deferral is only something that was raised and set aside.",
          },
          priorCheck: {
            type: "string",
            description: "RE-ASK GUARD — fill this in BEFORE composing your question. Name the ALREADY ANSWERED keys closest to the question you are about to ask, and state in a few words why your question asks for something NEW (a delta, a deepening, or an explicit confirmation) rather than repeating what is on file. Write 'none related' only if nothing on file touches the question. If you cannot articulate a genuine delta, change your question — asking a seller for a fact their documents or questionnaire already provided is the single most credibility-destroying mistake. This applies to suggestedAnswers too: never offer answer options for a fact already on file.",
          },
          nextIntent: {
            type: "string",
            description: "What you plan to ask next and why. This helps maintain continuity across turns.",
          },
          industryContext: {
            type: "object",
            required: ["identified", "industry", "subIndustry", "location", "activeIndustryTopics", "coveredIndustryTopics", "regulatoryNotes"],
            description: "Industry-specific context. Set 'identified' to true once you know the industry, sub-industry, and location. The activeIndustryTopics should list industry-specific areas that need to be covered beyond standard CIM sections.",
            properties: {
              identified: {
                type: "boolean",
                description: "Whether the industry, sub-industry, and location have been identified.",
              },
              industry: {
                type: "string",
                description: "The identified industry (e.g., 'Construction', 'Restaurant', 'Medical Practice').",
              },
              subIndustry: {
                type: "string",
                description: "The sub-industry if applicable (e.g., 'Commercial General Contractor', 'Fast Casual', 'Dental').",
              },
              location: {
                type: "string",
                description: "The business location (e.g., 'Ontario, Canada' or 'Texas, USA').",
              },
              activeIndustryTopics: {
                type: "array",
                items: { type: "string" },
                description: "Industry-specific question areas that still need to be covered. These are beyond standard CIM sections. E.g., for construction: ['bonding_capacity', 'bid_pipeline', 'subcontractor_relationships', 'safety_record']. Remove items as they are covered.",
              },
              coveredIndustryTopics: {
                type: "array",
                items: { type: "string" },
                description: "Industry-specific areas that have been adequately covered.",
              },
              regulatoryNotes: {
                type: "array",
                items: { type: "string" },
                description: "Location-specific regulatory requirements, permits, or licensing notes relevant to this industry in this jurisdiction.",
              },
            },
          },
        },
      },
      privateNotes: {
        type: "array",
        description: "BROKER-PRIVATE notes for sensitive facts the broker needs but which must NEVER enter a CIM or be repeated to the seller unprompted — health disclosures, litigation detail, family circumstances, a staff departure the seller asked kept quiet. Use this whenever a seller says 'don't put that in writing' about something the broker genuinely needs: tell the seller honestly 'that goes to your broker only, never the sale document' (NEVER promise total non-documentation), put the sensitive detail here, and put only the public-safe framing (e.g. 'personal circumstances') in extractedFields. Empty array when nothing sensitive arose.",
        items: {
          type: "object",
          required: ["note", "reason"],
          properties: {
            note: { type: "string", description: "The sensitive fact, stated plainly for the broker." },
            reason: { type: "string", description: "Why it is broker-private (e.g. 'seller asked this stay out of documents; health-related')." },
          },
        },
      },
      newTasks: {
        type: "array",
        description: "Tasks to create when information cannot be obtained during the interview. Each task gives the broker full context to follow up.",
        items: {
          type: "object",
          required: ["type", "title", "description", "relatedField", "sellerExplanation"],
          properties: {
            type: {
              type: "string",
              enum: ["document_request", "follow_up", "skipped_question"],
              description: "The type of task. 'follow_up' for information the seller needs to look up. 'document_request' for documents that should be collected. 'skipped_question' for questions the seller couldn't or wouldn't answer.",
            },
            title: {
              type: "string",
              description: "Short title for the task (e.g., 'Get lease agreement details').",
            },
            description: {
              type: "string",
              description: "Full context for the broker: what was asked, why it matters to buyers, what the seller said, and suggested next steps.",
            },
            relatedField: {
              type: "string",
              description: "The extractedInfo field this relates to (e.g., 'leaseDetails', 'employees'). Empty string if not applicable.",
            },
            sellerExplanation: {
              type: "string",
              description: "What the seller said about why they couldn't provide this information.",
            },
          },
        },
      },
      shouldEnd: {
        type: "boolean",
        description: "Whether the interview should end after this turn. Set to true when: (1) all critical sections are well covered, (2) the seller explicitly wants to stop, or (3) there is genuinely nothing productive left to ask.",
      },
      endReason: {
        type: "string",
        description: "If shouldEnd is true, explain why. E.g., 'All critical CIM sections are covered' or 'Seller requested to stop'.",
      },
    },
  },
} as const;
