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

  /** Pre-populated answer options the seller can click to respond */
  suggestedAnswers: string[];

  /** New or updated extracted fields from this turn */
  extractedFields: Record<string, ExtractedField>;

  /** Internal reasoning (not shown to the seller) */
  reasoning: InterviewReasoning;

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
}

export interface InterviewReasoning {
  /** Which CIM section area we're currently exploring */
  currentTopic: string;

  /** Status of the current topic */
  topicStatus: "exploring" | "probing" | "moving_on" | "circling_back";

  /** Topics we've deferred to revisit later */
  deferredTopics: string[];

  /** What the agent plans to ask next and why */
  nextIntent: string;

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
      suggestedAnswers: {
        type: "array",
        items: { type: "string" },
        description: "3–5 short, clickable answer options for the question you just asked. The seller can tap one to pre-fill their reply, then edit it before sending. Rules: (1) Keep each option brief — 2 to 8 words. (2) Base them on your industry knowledge and what you already know about this specific business. (3) Cover the most common realistic answers for this type of question in this industry. (4) For yes/no questions include both options. (5) If the question is open-ended and numerical (e.g. exact revenue figures), return an empty array — do not guess numbers. (6) Always make the options feel specific to this business and industry, not generic placeholders.",
      },
      extractedFields: {
        type: "object",
        description: "Key-value map of newly extracted or updated information from this turn. Keys should match the extractedInfo schema fields (e.g., 'employees', 'leaseDetails', 'keyProducts'). Only include fields where the seller provided NEW or CHANGED information in this turn.",
        additionalProperties: {
          type: "object",
          required: ["value", "confidence", "source"],
          properties: {
            value: {
              type: "string",
              description: "The extracted information value.",
            },
            confidence: {
              type: "string",
              enum: ["confirmed", "inferred", "approximate"],
              description: "How confident we are in this data. 'confirmed' = seller explicitly stated it. 'inferred' = reasonably derived from what they said. 'approximate' = seller gave a rough estimate.",
            },
            source: {
              type: "string",
              enum: ["seller_statement", "document", "questionnaire"],
              description: "Where this information came from. Almost always 'seller_statement' during an interview.",
            },
          },
        },
      },
      reasoning: {
        type: "object",
        required: ["currentTopic", "topicStatus", "deferredTopics", "nextIntent", "industryContext"],
        description: "Your internal reasoning about the interview state. This is NOT shown to the seller.",
        properties: {
          currentTopic: {
            type: "string",
            description: "Which CIM section or topic area you're currently exploring (e.g., 'employees', 'real_estate', 'industry_specific:liquor_licensing').",
          },
          topicStatus: {
            type: "string",
            enum: ["exploring", "probing", "moving_on", "circling_back"],
            description: "What you're doing with the current topic. 'exploring' = initial questions. 'probing' = pushing for more detail on a vague answer. 'moving_on' = this topic is covered or deferred. 'circling_back' = revisiting a previously deferred topic.",
          },
          deferredTopics: {
            type: "array",
            items: { type: "string" },
            description: "Topics you've set aside to revisit later. Include context about why they were deferred.",
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
