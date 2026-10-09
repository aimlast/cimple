/**
 * The extraction call of live filing (specs/together.md §5.4): one Sonnet
 * call per part of the conversation, tool-forced ("file_answers"), with the
 * rules and the checklist as two cached system blocks and the new lines in
 * the user message.
 *
 * What the model sees of the deal is the SELLER-SAFE view only (the same
 * values the seller's own AI interview reads — the `screen` board), so a
 * broker-only figure can never be "what the seller said" (D3). The broker's
 * own computations (SDE, adjusted earnings, a peg) are listed as "(not
 * filed from a call)".
 *
 * Test seam: `_setCaptureModelForTests(fn)`. A local replay server loads the
 * recorded outputs of TOGETHER_CAPTURE_STUB instead (capture-stub.ts); the
 * real client is used only when live filing runs in production.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { CoverageBoard, CoverageItem } from "@shared/coverage-board";
import { agentConfig } from "../interview/config/load-config";
import { GENERIC_ASKS } from "../interview/coverage-asks";

// ─────────────────────────────────────────────────────────────────────────
// The catalogue (what can be filed, and what's on file — seller-safe)
// ─────────────────────────────────────────────────────────────────────────

export interface CatalogueItem {
  itemId: string;
  sectionKey: string;
  sectionTitle: string;
  label: string;
  members: Array<{ key: string; label: string; writable: boolean }>;
  answers: string;
  onFile: string | null;
  estimate: boolean;
  status: CoverageItem["status"];
  origin: CoverageItem["origin"];
  critical: boolean;
  ask: string;
}

export interface CaptureCatalogue {
  items: CatalogueItem[];
  /** Conflicts sent to the seller (label only — nothing is filed for them). */
  routed: string[];
  /** writable member key → item id. */
  byKey: Map<string, string>;
  /** Item ids + members (a change re-renders the cached text). */
  structureKey: string;
}

const ONFILE_MAX = 80;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** The catalogue from the screen board (statuses from the broker view, every value seller-safe). Pure. */
export function catalogueFromBoard(board: CoverageBoard): CaptureCatalogue {
  const items: CatalogueItem[] = [];
  const byKey = new Map<string, string>();
  for (const s of board.sections) {
    for (const i of s.items) {
      const onFile = i.privateValue || i.moneyTalk ? null : i.value;
      items.push({
        itemId: i.id,
        sectionKey: s.key,
        sectionTitle: s.title,
        label: i.label,
        members: i.members.map((m) => ({ key: m.key, label: m.label, writable: m.writable })),
        answers: GENERIC_ASKS[i.id]?.answers ?? "",
        onFile: onFile ? clip(onFile.replace(/\s+/g, " "), ONFILE_MAX) : null,
        estimate: !!i.estimate,
        status: i.status,
        origin: i.origin,
        critical: i.critical,
        ask: i.ask,
      });
      for (const m of i.members) if (m.writable && !byKey.has(m.key)) byKey.set(m.key, i.id);
    }
  }
  const structureKey = items.map((i) => `${i.itemId}=${i.members.map((m) => `${m.key}${m.writable ? "" : "!"}`).join(",")}`).join("|");
  return { items, routed: board.routed.map((r) => r.label), byKey, structureKey };
}

/** The checklist as the model reads it (one line per item, grouped by section). Pure. */
export function renderCatalogue(cat: CaptureCatalogue): string {
  const out: string[] = ["THE CHECKLIST (file answers only under these member keys):"];
  let section = "";
  for (const i of cat.items) {
    if (i.sectionTitle !== section) {
      section = i.sectionTitle;
      out.push("", `## ${section}`);
    }
    const members = i.members.map((m) => (m.writable ? `${m.key} = ${m.label}` : `${m.key} (not filed from a call)`)).join(" | ");
    const onFile = i.onFile ? `${i.onFile}${i.estimate ? " (estimate)" : ""}` : "—";
    out.push(`${i.itemId} | ${i.label} | members: ${members}${i.answers ? ` | answers: ${i.answers}` : ""} | on file: ${onFile}`);
  }
  if (cat.routed.length > 0) {
    out.push("", "## Conflicts the broker is asking about (label only — nothing is filed for these)");
    for (const r of cat.routed) out.push(`- ${r}`);
  }
  return out.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────
// The rules (static, cached)
// ─────────────────────────────────────────────────────────────────────────

export const CAPTURE_RULES = `You are Cimple's note-taker on a live call between a business broker and the owner who is selling the business (the seller). You never speak. File what the SELLER says into the data points listed, accurately, and only what was actually said.

1. Only the seller's words become answers. A fact the broker states counts only when the seller then agrees in the NEW lines ("yes", "right", "that's correct", or says it again) — report it with speaker "broker_confirmed". A fact the broker states with no seller response goes in brokerUnconfirmed, never in answers. If the seller corrects the broker, the seller's version is the answer. Lines marked TYPED were typed by the broker: answers from them use speaker "typed".
2. Never fill in. No number, year, name or yes/no the transcript doesn't contain. "computed" only for plain arithmetic on numbers the seller said. Vague words ("a few", "most", "about forty") are filed as said, with confidence "approximate".
3. Every answer cites the line numbers it comes from and quotes the seller's exact words (at most 30 words).
4. "I don't know", "my bookkeeper has that", "I'll check" is not an answer: put it in notKnown with who has it.
5. A staff member's private matter (asking for equity or a raise, health, family, maybe leaving, a warning) and anything the seller asks to keep out ("don't put that in the book", "between us") go in private — never in answers.
6. Never file a valuation, a multiple, what earnings come to after adjustments, or tax or legal advice anyone gives. A price the seller says they want goes under askingPrice as their expectation. Keys marked "(not filed from a call)" are never used.
7. File each answer under the member key that matches what was said: a data point lists its members, each with its own meaning ("ebitda = EBITDA as the statements show it | netIncome = net income (after tax)"). Never put one measure under another's key. If the seller states something useful that fits no data point, put it in otherFacts (at most 3).
8. CONTEXT lines were already filed — use them only to understand the NEW lines ("yes, about forty"). Don't file them again unless the NEW lines change them; a changed figure is a new answer.
9. If the answer invites one natural follow-up (a figure without a year, "a couple of big customers"), give it in followUp as one short spoken question.
10. If a FOCUS line names a data point, the broker says the NEW lines answer it: file that answer if the seller's words give it, under the right member, and still file anything else as usual.
11. If nothing in the NEW lines answers anything, return empty lists.`;

// ─────────────────────────────────────────────────────────────────────────
// The tool
// ─────────────────────────────────────────────────────────────────────────

export const FILE_ANSWERS_TOOL = {
  name: "file_answers",
  description: "File what the seller said in the NEW lines into the checklist.",
  input_schema: {
    type: "object" as const,
    required: ["answers", "notKnown", "brokerUnconfirmed", "private", "withdrawn", "otherFacts"],
    properties: {
      answers: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "value", "quote", "lines", "speaker", "confidence", "basis"],
          properties: {
            key: { type: "string", description: "A writable member key from the checklist" },
            value: { type: "string", description: "What the seller said, in plain words, ≤ 400 chars" },
            quote: { type: "string" },
            lines: { type: "array", items: { type: "integer" } },
            speaker: { enum: ["seller", "broker_confirmed", "typed"] },
            confidence: { enum: ["confirmed", "approximate"] },
            basis: { enum: ["verbatim", "computed"] },
            complete: { type: "boolean" },
            stillMissing: { type: "string" },
          },
        },
      },
      notKnown: { type: "array", items: { type: "object", required: ["key", "quote"], properties: { key: { type: "string" }, whoHasIt: { type: "string" }, quote: { type: "string" } } } },
      brokerUnconfirmed: { type: "array", items: { type: "object", required: ["key", "value", "quote"], properties: { key: { type: "string" }, value: { type: "string" }, quote: { type: "string" } } } },
      private: {
        type: "array",
        items: {
          type: "object",
          required: ["note", "reason"],
          properties: { note: { type: "string" }, reason: { enum: ["staff_private", "seller_asked", "health_family", "other"] }, keepOutTerms: { type: "array", items: { type: "string" } } },
        },
      },
      withdrawn: { type: "array", items: { type: "object", required: ["key", "quote"], properties: { key: { type: "string" }, quote: { type: "string" } } } },
      otherFacts: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "label", "sectionKey", "value", "quote", "confidence"],
          properties: { key: { type: "string" }, label: { type: "string" }, sectionKey: { type: "string" }, value: { type: "string" }, quote: { type: "string" }, confidence: { enum: ["confirmed", "approximate"] } },
        },
      },
      followUp: { type: ["object", "null"], properties: { itemId: { type: "string" }, ask: { type: "string" } } },
      topicSections: { type: "array", items: { type: "string" } },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────
// The output (validated in code)
// ─────────────────────────────────────────────────────────────────────────

export interface CapturedAnswer {
  key: string;
  value: string;
  quote: string;
  lines: number[];
  speaker: "seller" | "broker_confirmed" | "typed";
  confidence: "confirmed" | "approximate";
  basis: "verbatim" | "computed";
  complete?: boolean;
  stillMissing?: string;
}

export interface CaptureOutput {
  answers: CapturedAnswer[];
  notKnown: Array<{ key: string; whoHasIt?: string; quote: string }>;
  brokerUnconfirmed: Array<{ key: string; value: string; quote: string }>;
  private: Array<{ note: string; reason: "staff_private" | "seller_asked" | "health_family" | "other"; keepOutTerms?: string[] }>;
  withdrawn: Array<{ key: string; quote: string }>;
  otherFacts: Array<{ key: string; label: string; sectionKey: string; value: string; quote: string; confidence: "confirmed" | "approximate"; lines?: number[] }>;
  followUp: { itemId?: string; ask: string } | null;
  topicSections: string[];
}

const str = (v: unknown, max = 400) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * Validates the tool's input. Returns null when its shape is unusable (the
 * pipeline retries once, then counts it as bad output). Pure.
 */
export function parseCaptureOutput(raw: unknown): CaptureOutput | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.answers)) return null;
  const answers: CapturedAnswer[] = [];
  for (const a of arr(r.answers)) {
    const x = (a ?? {}) as Record<string, unknown>;
    const key = str(x.key, 64);
    const value = str(x.value, 400);
    if (!key || !value) continue;
    const speaker = x.speaker === "broker_confirmed" || x.speaker === "typed" ? x.speaker : "seller";
    answers.push({
      key,
      value,
      quote: str(x.quote, 300),
      lines: arr(x.lines).filter((n): n is number => typeof n === "number" && Number.isInteger(n)).slice(0, 20),
      speaker,
      confidence: x.confidence === "approximate" ? "approximate" : "confirmed",
      basis: x.basis === "computed" ? "computed" : "verbatim",
      ...(typeof x.complete === "boolean" ? { complete: x.complete } : {}),
      ...(str(x.stillMissing, 160) ? { stillMissing: str(x.stillMissing, 160) } : {}),
    });
  }
  const followRaw = r.followUp as Record<string, unknown> | null | undefined;
  const followAsk = followRaw && typeof followRaw === "object" ? str(followRaw.ask, 240) : "";
  return {
    answers,
    notKnown: arr(r.notKnown).map((x) => x as Record<string, unknown>).filter((x) => str(x?.key, 64)).map((x) => ({ key: str(x.key, 64), ...(str(x.whoHasIt, 80) ? { whoHasIt: str(x.whoHasIt, 80) } : {}), quote: str(x.quote, 300) })),
    brokerUnconfirmed: arr(r.brokerUnconfirmed).map((x) => x as Record<string, unknown>).filter((x) => str(x?.key, 64) && str(x?.value)).map((x) => ({ key: str(x.key, 64), value: str(x.value), quote: str(x.quote, 300) })),
    private: arr(r.private).map((x) => x as Record<string, unknown>).filter((x) => str(x?.note, 600)).map((x) => ({
      note: str(x.note, 600),
      reason: (["staff_private", "seller_asked", "health_family", "other"] as const).find((k) => k === x.reason) ?? "other",
      ...(Array.isArray(x.keepOutTerms) ? { keepOutTerms: arr(x.keepOutTerms).map((t) => str(t, 60)).filter(Boolean).slice(0, 8) } : {}),
    })),
    withdrawn: arr(r.withdrawn).map((x) => x as Record<string, unknown>).filter((x) => str(x?.key, 64)).map((x) => ({ key: str(x.key, 64), quote: str(x.quote, 300) })),
    otherFacts: arr(r.otherFacts).map((x) => x as Record<string, unknown>).filter((x) => str(x?.key, 64) && str(x?.value)).slice(0, 3).map((x) => ({
      key: str(x.key, 64),
      label: str(x.label, 80),
      sectionKey: str(x.sectionKey, 40),
      value: str(x.value),
      quote: str(x.quote, 300),
      confidence: x.confidence === "approximate" ? "approximate" : "confirmed",
      ...(Array.isArray(x.lines) ? { lines: arr(x.lines).filter((n): n is number => typeof n === "number").slice(0, 20) } : {}),
    })),
    followUp: followAsk ? { ...(str(followRaw?.itemId, 140) ? { itemId: str(followRaw?.itemId, 140) } : {}), ask: followAsk } : null,
    topicSections: arr(r.topicSections).map((t) => str(t, 40)).filter(Boolean).slice(0, 6),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// The user message
// ─────────────────────────────────────────────────────────────────────────

export interface CaptureLine {
  seq: number;
  /** "Broker", "Seller", "Speaker 2", "TYPED (broker)" */
  who: string;
  text: string;
}

export interface CaptureInput {
  speakersLine: string;
  changed: string[];
  focus: { itemId: string; label: string } | null;
  context: CaptureLine[];
  lines: CaptureLine[];
}

/** The dynamic message (~300–700 tokens). Pure. */
export function buildCaptureUser(input: CaptureInput): string {
  const out: string[] = [`SPEAKERS: ${input.speakersLine}`];
  if (input.changed.length > 0) out.push(`CHANGED SINCE THE CALL STARTED: ${input.changed.slice(0, 20).join(" · ")}`);
  if (input.focus) out.push(`FOCUS: ${input.focus.itemId} — "${input.focus.label}"`);
  if (input.context.length > 0) {
    out.push("CONTEXT (already filed):");
    for (const l of input.context) out.push(`[${l.seq}] ${l.who}: ${l.text}`);
  }
  out.push("NEW (file these):");
  for (const l of input.lines) out.push(`[${l.seq}] ${l.who}: ${l.text}`);
  return out.join("\n");
}

/** The two cached system blocks. */
export function buildCaptureSystem(catalogueText: string): Array<{ type: "text"; text: string; cache_control: { type: "ephemeral" } }> {
  return [
    { type: "text", text: CAPTURE_RULES, cache_control: { type: "ephemeral" } },
    { type: "text", text: catalogueText, cache_control: { type: "ephemeral" } },
  ];
}

// ─────────────────────────────────────────────────────────────────────────
// The call
// ─────────────────────────────────────────────────────────────────────────

export interface CaptureUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  ms: number;
  model: string;
}

export interface CaptureModelRequest {
  system: ReturnType<typeof buildCaptureSystem>;
  user: string;
  /** The NEW lines (a recorded stub cites them by their words). */
  lines: CaptureLine[];
  focusItemId: string | null;
}

export type CaptureModel = (req: CaptureModelRequest) => Promise<{ toolInput: unknown; usage?: Partial<CaptureUsage> }>;

/** Errors the pipeline reads: overloaded / 5xx / timeout / 429 retry; credit runs out; bad output. */
export class CaptureError extends Error {
  constructor(message: string, readonly kind: "unavailable" | "credit" | "bad_output") {
    super(message);
  }
}

let modelOverride: CaptureModel | null = null;

/** Test seam (and the local replay's recorded model). */
export function _setCaptureModelForTests(fn: CaptureModel | null): void {
  modelOverride = fn;
}

export function captureModelInstalled(): boolean {
  return modelOverride !== null;
}

let client: Anthropic | null = null;

const realModel: CaptureModel = async (req) => {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 0 });
  const started = Date.now();
  try {
    const res = await client.messages.create({
      model: agentConfig.models.supportingAgents,
      temperature: 0,
      max_tokens: 1500,
      system: req.system,
      tools: [FILE_ANSWERS_TOOL as unknown as Anthropic.Tool],
      tool_choice: { type: "tool", name: FILE_ANSWERS_TOOL.name },
      messages: [{ role: "user", content: req.user }],
    });
    const block = res.content.find((b) => b.type === "tool_use");
    const u = res.usage as unknown as Record<string, number | undefined>;
    return {
      toolInput: block && block.type === "tool_use" ? block.input : null,
      usage: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        ms: Date.now() - started,
        model: agentConfig.models.supportingAgents,
      },
    };
  } catch (err) {
    const e = err as { status?: number; message?: string; error?: { error?: { message?: string } } };
    const msg = String(e?.error?.error?.message ?? e?.message ?? err);
    if (e?.status === 400 && /credit balance/i.test(msg)) throw new CaptureError("Out of credit", "credit");
    throw new CaptureError(msg.slice(0, 200), "unavailable");
  }
};

/** One extraction call: the parsed output, or a CaptureError. */
export async function runCapture(req: CaptureModelRequest): Promise<{ output: CaptureOutput; usage: CaptureUsage }> {
  const model = modelOverride ?? realModel;
  const started = Date.now();
  let res: Awaited<ReturnType<CaptureModel>>;
  try {
    res = await model(req);
  } catch (err) {
    if (err instanceof CaptureError) throw err;
    throw new CaptureError(String((err as Error)?.message ?? err).slice(0, 200), "unavailable");
  }
  const output = parseCaptureOutput(res.toolInput);
  if (!output) throw new CaptureError("The model's answer wasn't usable", "bad_output");
  return {
    output,
    usage: {
      input: res.usage?.input ?? 0,
      output: res.usage?.output ?? 0,
      cacheRead: res.usage?.cacheRead ?? 0,
      cacheWrite: res.usage?.cacheWrite ?? 0,
      ms: res.usage?.ms ?? Date.now() - started,
      model: res.usage?.model ?? (modelOverride ? "stub" : agentConfig.models.supportingAgents),
    },
  };
}
