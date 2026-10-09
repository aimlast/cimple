/**
 * ai — the one model call that writes "why" notes for a deal's figures
 * (spec D8, §9.5). claude-sonnet-4-5 (the supporting-agent model), tool-forced,
 * temperature 0, ≤ 10 candidates a call. The evidence block is prompt-cached,
 * so a build's second call reads it cheaply.
 *
 * The model may only give a reason a cited passage states or directly shows,
 * quoting it word for word; anything else comes back "no_reason_on_file".
 * Everything it returns goes through guards.ts before anything is stored.
 *
 * Tests install a stub client (_setFigureNotesClientForTests); nothing here
 * is ever called with the key disabled in a test.
 */
import Anthropic from "@anthropic-ai/sdk";
import { agentConfig } from "../../interview/config/load-config";
import { withAiRetry } from "../../ai-retry";
import { dollars, percentOf } from "@shared/figure-compare";
import type { FigureCandidate } from "./candidates";
import type { FigureEvidence } from "./evidence";
import type { RawFigureNote } from "./guards";

/** The slice of the SDK this module uses. */
export interface FigureNotesClient {
  messages: { create(params: any): Promise<{ content: Array<{ type: string; name?: string; input?: unknown }>; usage?: unknown }> };
}

let testClient: FigureNotesClient | null = null;
let liveClient: FigureNotesClient | null = null;

/** Tests: install a stub (null restores the real client). */
export function _setFigureNotesClientForTests(c: FigureNotesClient | null): void {
  testClient = c;
}

/** Is a model reachable here (a test stub, or a real key)? A disabled key never makes a call. */
export function figureAiAvailable(): boolean {
  if (testClient) return true;
  const key = process.env.ANTHROPIC_API_KEY;
  return !!key && key !== "disabled";
}

/** Throws the same way a rejected key does (the build records "the AI service refused Cimple's key"). */
export function assertFigureAiAvailable(): void {
  if (!figureAiAvailable()) throw Object.assign(new Error("The AI key is switched off here."), { status: 401 });
}

function client(): FigureNotesClient {
  if (testClient) return testClient;
  if (!liveClient) liveClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) as unknown as FigureNotesClient;
  return liveClient;
}

export const FIGURE_REASONS_TOOL = {
  name: "figure_reasons",
  description: "Notes for the candidates, one per candidate.",
  input_schema: {
    type: "object",
    required: ["notes"],
    properties: {
      notes: {
        type: "array",
        items: {
          type: "object",
          required: ["candidateId", "status"],
          properties: {
            candidateId: { type: "string" },
            status: { type: "string", enum: ["explained", "no_reason_on_file"] },
            text: { type: "string", maxLength: 320 },
            blindText: { type: ["string", "null"], maxLength: 320 },
            sources: {
              type: "array",
              maxItems: 3,
              items: {
                type: "object",
                required: ["ref", "quote"],
                properties: { ref: { type: "string", pattern: "^[IFDR][0-9]{1,3}$" }, quote: { type: "string", maxLength: 240 } },
              },
            },
          },
        },
      },
    },
  },
} as const;

const RULES = `You write short notes that explain why a figure in a business's confidential memorandum changed, or why two of the company's records show different amounts. Buyers read them.

Rules:
- Only give a reason that a cited passage states or directly shows.
- Quote the exact words (12–200 characters) of each passage you cite.
- If nothing gives a reason, return no_reason_on_file. A wrong reason is worse than none.
- At most two sentences, plain language, no selling words.
- Use only figures from the candidate or the quotes.
- Never describe how the memorandum was made; never mention a broker, an interview, a call, a CRM, Cimple or "the analysis".
- Never name an employee; use the role.
- blindText is the same note using only general words for the line (e.g. "rent", "operating expenses"), with no business, person, customer, supplier, landlord, street or city names, or null if that isn't possible.`;

/** One candidate as the model reads it. */
export function candidateLine(c: FigureCandidate & { id?: string }, id: string): string {
  if (c.kind === "movement" && c.fromYear && typeof c.fromValue === "number") {
    const d = Math.abs(c.value) - Math.abs(c.fromValue);
    const pct = percentOf(d, c.fromValue, "change");
    return `${id}: ${c.lineLabel} — FY${c.fromYear} ${dollars(c.fromValue)} → FY${c.year} ${dollars(c.value)} (${d >= 0 ? "up" : "down"} ${dollars(d)}${pct ? `, ${pct}` : ""}). Why did it change?`;
  }
  const other = typeof c.other === "number" ? dollars(c.other) : "—";
  return `${id}: ${c.lineLabel}, FY${c.year} — the financial statements show ${dollars(c.value)}; the ${c.otherKind === "management" ? "management accounts show" : "tax return shows"} ${other}. Why do they differ?`;
}

export function evidenceBlock(evidence: FigureEvidence): string {
  const lines: string[] = ["Evidence you may cite (quote word for word):"];
  for (const r of Array.from(evidence.refs.values())) {
    const what = r.kind === "document" ? `document: ${r.meta.label ?? "a company document"}`
      : r.kind === "transcript" ? "the owner, in conversation"
      : r.kind === "discrepancy" ? "a settled difference between records"
      : "the owner";
    lines.push(`[${r.id}] (${what})\n${r.text}`);
  }
  return lines.join("\n\n");
}

/** The request for one call (pure; the tests read it). */
export function figureNotesRequest(candidates: Array<FigureCandidate & { id: string }>, evidence: FigureEvidence): any {
  const cands = candidates.map((c) => candidateLine(c, c.id)).join("\n");
  const hints = evidence.hints.length > 0
    ? `Where a reason may be found (you cannot cite these):\n${evidence.hints.map((h) => `- ${h}`).join("\n")}`
    : "";
  return {
    model: agentConfig.models.supportingAgents,
    max_tokens: 4000,
    temperature: 0,
    tools: [FIGURE_REASONS_TOOL],
    tool_choice: { type: "tool", name: FIGURE_REASONS_TOOL.name },
    messages: [{
      role: "user",
      content: [
        { type: "text", text: RULES },
        { type: "text", text: evidenceBlock(evidence), cache_control: { type: "ephemeral" } },
        { type: "text", text: `Candidates:\n${cands}${hints ? `\n\n${hints}` : ""}` },
      ],
    }],
  };
}

/** The notes the model returned for these candidates (malformed entries dropped). */
export function parseFigureReasons(content: Array<{ type: string; name?: string; input?: unknown }>, ids: Set<string>): RawFigureNote[] {
  const block = content.find((b) => b.type === "tool_use" && b.name === FIGURE_REASONS_TOOL.name);
  const notes = (block?.input as { notes?: unknown } | undefined)?.notes;
  if (!Array.isArray(notes)) throw Object.assign(new Error("The model returned no notes."), { name: "NoUsableAnswer" });
  const out: RawFigureNote[] = [];
  for (const n of notes) {
    if (!n || typeof n !== "object") continue;
    const r = n as Record<string, unknown>;
    const id = String(r.candidateId ?? "");
    if (!ids.has(id)) continue;
    const status = r.status === "explained" ? "explained" : "no_reason_on_file";
    out.push({
      candidateId: id,
      status,
      text: typeof r.text === "string" ? r.text : null,
      blindText: typeof r.blindText === "string" ? r.blindText : null,
      sources: Array.isArray(r.sources)
        ? (r.sources as unknown[]).flatMap((s) => (s && typeof s === "object" && typeof (s as any).ref === "string" && typeof (s as any).quote === "string" ? [{ ref: (s as any).ref, quote: (s as any).quote }] : []))
        : [],
    });
  }
  return out;
}

/** One call: the notes for up to 10 candidates. Throws on an API failure (the build records it; nothing is changed). */
export async function writeFigureNotes(candidates: Array<FigureCandidate & { id: string }>, evidence: FigureEvidence): Promise<RawFigureNote[]> {
  if (candidates.length === 0) return [];
  assertFigureAiAvailable();
  const req = figureNotesRequest(candidates.slice(0, 10), evidence);
  const res = await withAiRetry(() => client().messages.create(req), [2000, 6000]);
  return parseFigureReasons(res.content ?? [], new Set(candidates.map((c) => c.id)));
}
