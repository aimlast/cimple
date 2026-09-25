/**
 * outline-extract — "Match my existing CIM".
 *
 * Reads the text of a broker's past CIM and returns its ordered section
 * outline plus a few notes on how it reads, with the supporting model
 * (tool-forced JSON). The outline is structure only: the business, people
 * and numbers in the old CIM are another client's confidential data and are
 * never kept — the prompt asks for generic section descriptions, and the
 * uploaded file is deleted by the caller as soon as its text is read.
 */
import Anthropic from "@anthropic-ai/sdk";
import { agentConfig } from "../interview/config/load-config";
import { CIM_LAYOUT_KEYS } from "@shared/cim-layouts";
import { sanitizeOutline, type CimSectionOutline } from "@shared/cim-theme";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

/** Enough of a long CIM for its structure (headings sit throughout). */
const MAX_CHARS = 60_000;

const OUTLINE_TOOL = {
  name: "cim_outline",
  description: "The section structure of a Confidential Information Memorandum.",
  input_schema: {
    type: "object" as const,
    required: ["isCim", "sections", "toneNotes"],
    properties: {
      isCim: {
        type: "boolean",
        description: "True if the text is a CIM / confidential business overview / offering memorandum (or close enough to have a usable section structure).",
      },
      sections: {
        type: "array",
        description: "The document's main sections in order, as a reader would list them in a table of contents. Skip the cover, table of contents and page furniture; include the disclaimer only if it is a real section. 6–30 entries.",
        items: {
          type: "object",
          required: ["title"],
          properties: {
            title: { type: "string", description: "The section heading, generalised so it fits any business (\"Company Overview\", not \"About Smith Plumbing\")." },
            notes: { type: "string", description: "One short line on what the section covers, in generic terms. Never include names, places, customers or figures from this document." },
            layoutHint: {
              type: "string",
              enum: [...CIM_LAYOUT_KEYS],
              description: "Only when the section is obviously a table, chart, list or timeline: the closest layout.",
            },
          },
        },
      },
      toneNotes: {
        type: "string",
        description: "2–4 sentences on how the document reads (voice, formality, length of sections, use of bullets vs prose, how numbers are presented). No names or figures.",
      },
    },
  },
} as const;

export class NotACimError extends Error {}

export async function extractCimOutline(text: string, sourceName: string): Promise<CimSectionOutline> {
  const body = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (body.length < 200) throw new NotACimError("That file has almost no readable text. If it's a scanned PDF, export it again with text.");
  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 3000,
    temperature: 0,
    tools: [OUTLINE_TOOL] as never,
    tool_choice: { type: "tool", name: "cim_outline" },
    system: [
      "You read a business broker's past Confidential Information Memorandum and extract its STRUCTURE so the brokerage's future CIMs can follow the same section order.",
      "Return the main sections in document order with generalised titles. The document belongs to a different client: never copy business names, people, places, customers, or figures into your output.",
    ].join(" "),
    messages: [{ role: "user", content: `File: ${sourceName}\n\n${body.slice(0, MAX_CHARS)}` }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  const input = (block && block.type === "tool_use" ? block.input : {}) as { isCim?: boolean; sections?: unknown; toneNotes?: unknown };
  if (input.isCim === false) throw new NotACimError("That doesn't look like a CIM — we couldn't find a section structure in it.");
  const outline = sanitizeOutline({ sections: input.sections, toneNotes: input.toneNotes, sourceName });
  if (!outline || outline.sections.length < 3) throw new NotACimError("We couldn't find enough sections in that file to follow.");
  return outline;
}
