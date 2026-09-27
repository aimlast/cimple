// Offline harness for processTurn / startOrResumeSession: the interview model,
// the database and storage are replaced in memory, so a whole turn — guards,
// governance, merge, save — runs with scripted model replies and no network.
// Used by tests/interview/process-turn.test.ts.
import Anthropic from "@anthropic-ai/sdk";
import { db } from "../../server/db";
import { storage } from "../../server/storage";
import { interviewSessions, type ConversationMessage } from "@shared/schema";

export interface ScriptedReply {
  message: string;
  shouldEnd?: boolean;
  endReason?: string;
  whyItMatters?: string;
  importance?: string;
  targetSection?: string;
  extractedFields?: Record<string, { value: string; confidence: string; source?: string; basis?: string }>;
  retractedFields?: { field: string; reason: string }[];
  newDeferrals?: { topic: string; reason: string; whereInfoLives: string }[];
  nextIntent?: string;
  currentTopic?: string;
  suggestedAnswers?: string[];
  /** Streamed only: the connection breaks after this share (0–1) of the tool input. */
  streamBreaksAt?: number;
  /** Streamed only: the response ends with this stop reason (e.g. "max_tokens"). */
  stopReason?: string;
  /** The model writes shouldEnd / endReason after the tail instead of in schema order. */
  endLast?: boolean;
  /** The model writes the tail (extractedFields…) before the chips and "why we ask this". */
  chipsLast?: boolean;
}

export function toolInput(r: ScriptedReply) {
  // Fields in the tool schema's order — the end decision right after the
  // chips — unless the reply is scripted to write it last (endLast) or to
  // write its facts and reasoning before the chips (chipsLast).
  const end = { shouldEnd: r.shouldEnd ?? false, endReason: r.endReason };
  const labels = {
    whyItMatters: r.whyItMatters,
    importance: r.importance,
    targetSection: r.targetSection,
    suggestedAnswers: r.suggestedAnswers ?? ["Yes", "No", "Not sure"],
  };
  const tail = {
    extractedFields: Object.fromEntries(
      Object.entries(r.extractedFields ?? {}).map(([k, f]) => [k, { source: "seller_statement", basis: "verbatim", ...f }]),
    ),
    retractedFields: r.retractedFields ?? [],
    reasoning: {
      currentTopic: r.currentTopic ?? "overview",
      topicStatus: "exploring",
      newDeferrals: r.newDeferrals ?? [],
      resolvedDeferrals: [],
      plannedTopics: [],
      priorCheck: "none related",
      nextIntent: r.nextIntent ?? "",
      industryContext: { identified: false, industry: "", subIndustry: "", location: "", activeIndustryTopics: [], coveredIndustryTopics: [], regulatoryNotes: [] },
    },
  };
  const bookkeeping = { privateNotes: [], newTasks: [] };
  if (r.chipsLast) return { message: r.message, ...tail, ...labels, ...end, ...bookkeeping };
  return r.endLast
    ? { message: r.message, ...labels, ...tail, ...bookkeeping, ...end }
    : { message: r.message, ...labels, ...end, ...tail, ...bookkeeping };
}

export interface Harness {
  deal: any;
  sessions: any[];
  tasks: any[];
  /** Replies the model gives, in order (interview_response calls only). */
  script: ScriptedReply[];
  /** Every interview-model call: the last user content it was sent. */
  calls: string[];
  /** Every interview-model call: its system prompt text. */
  systems: string[];
  /** Seller-intent classifier replies, in order (partial SellerIntent tool inputs). */
  intents: Record<string, unknown>[];
  intentCalls: number;
  logs: string[];
  /** Streamed interview calls: each delta delivered (call index, characters so far, of total). */
  streamed: Array<{ call: number; upTo: number; of: number }>;
}

export function installHarness(deal: any, opts: { messages?: ConversationMessage[]; sessionMeta?: Record<string, unknown>; documents?: any[] } = {}): Harness {
  const h: Harness = {
    deal,
    sessions: [],
    tasks: [],
    script: [],
    calls: [],
    systems: [],
    intents: [],
    intentCalls: 0,
    logs: [],
    streamed: [],
  };
  if (opts.messages) {
    h.sessions.push({
      id: "sess-1",
      dealId: deal.id,
      participantId: null,
      messages: opts.messages,
      extractedInfo: opts.sessionMeta ?? {},
      status: "active",
      questionsAsked: 0,
      questionsAnswered: 0,
      questionsSkipped: 0,
      lastActivityAt: new Date(),
      completedAt: null,
    });
  }

  // ── model ──
  const proto = (Anthropic as any).Messages.prototype;
  proto.create = async function (params: any) {
    const tool = params?.tools?.[0]?.name;
    // The seller-intent classifier: a scripted reading, or (none scripted)
    // a failure — the turn then runs on the instant patterns.
    if (tool === "seller_intent") {
      h.intentCalls++;
      const next = h.intents.shift();
      if (!next) throw new Error("harness: no scripted intent");
      return { content: [{ type: "tool_use", id: "i", name: "seller_intent", input: { stop: "none", continueRequest: false, sellerQuestion: "", retractions: [], corrections: [], privacyRequests: [], ...next } }], stop_reason: "tool_use" };
    }
    if (tool !== "interview_response") throw new Error(`unexpected model call (${tool ?? "no tool"})`);
    return { content: [{ type: "tool_use", id: "t", name: "interview_response", input: scripted(params) }], stop_reason: "tool_use" };
  };
  /** The next scripted interview reply (the call is recorded). */
  const scripted = (params: any) => {
    const last = params.messages[params.messages.length - 1];
    h.calls.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
    h.systems.push(Array.isArray(params.system) ? params.system.map((b: any) => b.text).join("\n") : String(params.system ?? ""));
    const next = h.script.shift();
    if (!next) throw new Error("harness: no scripted reply left");
    lastScripted = next;
    return toolInput(next);
  };
  let lastScripted: ScriptedReply | null = null;
  // A streamed interview call plays its scripted reply as the API streams a
  // tool call: the input JSON in small deltas (a caller may stop it early —
  // the stream gate, a head-only rewrite). Every delta is logged in
  // h.streamed with the call's index, so tests can see how far it ran.
  // Streamed supporting calls (the on-file evidence build, started in the
  // background when a session ends) fail the way an unavailable API does:
  // their finalMessage rejects and the caller's own error handling runs.
  proto.stream = function (params: any) {
    if (params?.tools?.[0]?.name === "interview_response") {
      const input = scripted(params);
      const { streamBreaksAt, stopReason } = lastScripted ?? {};
      const json = JSON.stringify(input);
      const call = h.calls.length - 1;
      let aborted = false;
      const stream: any = {
        async *[Symbol.asyncIterator]() {
          for (let i = 0; i < json.length; i += 24) {
            if (aborted) return;
            await new Promise((r) => setImmediate(r));
            if (streamBreaksAt !== undefined && i >= json.length * streamBreaksAt) throw new Error("harness: socket hang up");
            h.streamed.push({ call, upTo: Math.min(json.length, i + 24), of: json.length });
            yield { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: json.slice(i, i + 24) } };
          }
        },
        on: () => stream,
        abort: () => { aborted = true; },
        finalMessage: async () => ({ content: [{ type: "tool_use", id: "t", name: "interview_response", input }], stop_reason: stopReason ?? "tool_use" }),
      };
      return stream;
    }
    const result: Promise<any> = Promise.resolve().then(() => proto.create.call(this, params));
    result.catch(() => {});
    const fake: any = { on: () => fake, finalMessage: () => result, abort: () => {} };
    return fake;
  };

  // ── storage ──
  const s = storage as any;
  s.getDeal = async () => h.deal;
  s.getDocumentsByDeal = async () => opts.documents ?? [];
  s.getTasksByDeal = async () => h.tasks;
  s.getResolvedDiscrepancies = async () => [];
  s.getDiscrepanciesByDeal = async () => [];
  s.updateDiscrepancy = async () => undefined;
  s.updateDeal = async (_id: string, patch: any) => { h.deal = { ...h.deal, ...patch }; return h.deal; };
  s.createTask = async (t: any) => { const row = { id: `task-${h.tasks.length + 1}`, ...t }; h.tasks.push(row); return row; };

  // ── db (interview_sessions only; everything else reads as empty) ──
  const d = db as any;
  const chain = (rows: () => any[]) => {
    let ordered = false;
    // A where(eq(interviewSessions.id, …)) naming a known session reads that
    // one row (the interview reads a session by id); any other condition
    // (the deal's sessions) reads them all.
    let byId: string | null = null;
    const c: any = {
      where: (cond: any) => {
        const ids = new Set(h.sessions.map((s) => s.id));
        const found = (cond?.queryChunks ?? []).find((q: any) => q && typeof q.value === "string" && ids.has(q.value));
        if (found) byId = found.value;
        return c;
      },
      // (Every orderBy in the interview code is "most recent activity first".)
      orderBy: () => { ordered = true; return c; },
      limit: () => c,
      then: (res: any, rej: any) => {
        const all = byId ? rows().filter((r) => r.id === byId) : rows();
        return Promise.resolve(ordered ? [...all].sort((a, b) => new Date(b.lastActivityAt).getTime() - new Date(a.lastActivityAt).getTime()) : all).then(res, rej);
      },
    };
    return c;
  };
  // The session a where(eq(interviewSessions.id, …)) names, if the condition
  // carries one of the known ids; else the newest.
  const targetOf = (cond: any) => {
    const ids = new Set(h.sessions.map((s) => s.id));
    const found = (cond?.queryChunks ?? []).find((q: any) => q && typeof q.value === "string" && ids.has(q.value));
    return found ? h.sessions.find((s) => s.id === found.value) : h.sessions[h.sessions.length - 1];
  };
  d.select = () => ({ from: (table: any) => chain(() => (table === interviewSessions ? h.sessions : [])) });
  d.update = (table: any) => ({
    set: (values: any) => ({
      where: async (cond: any) => {
        if (table !== interviewSessions) return;
        const target = targetOf(cond);
        if (target) Object.assign(target, values);
      },
    }),
  });
  d.insert = (table: any) => ({
    values: (values: any) => {
      let row: any = null;
      const add = () => {
        if (table !== interviewSessions) return [];
        row ??= { id: `sess-${h.sessions.length + 1}`, lastActivityAt: new Date(), completedAt: null, ...values };
        if (!h.sessions.includes(row)) h.sessions.push(row);
        return [row];
      };
      return {
        returning: async () => add(),
        then: (res: any, rej: any) => Promise.resolve().then(() => { add(); }).then(res, rej),
      };
    },
  });

  // ── logs ──
  for (const level of ["log", "warn", "error"] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      h.logs.push(args.map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a))).join(" "));
      if (process.env.HARNESS_VERBOSE) orig(...args);
    };
  }
  return h;
}

export const ai = (content: string, extra: Partial<ConversationMessage> = {}): ConversationMessage =>
  ({ role: "ai", content, timestamp: new Date().toISOString(), ...extra }) as ConversationMessage;
export const seller = (content: string): ConversationMessage =>
  ({ role: "user", content, timestamp: new Date().toISOString() }) as ConversationMessage;

export function baseDeal(extra: Record<string, unknown> = {}): any {
  return {
    id: "deal-1",
    brokerId: "b1",
    sellerId: null,
    businessName: "Clearwater Physiotherapy",
    industry: null,
    subIndustry: null,
    location: "Calgary, AB",
    description: null,
    phase: "phase2_platform_intake",
    questionnaireData: null,
    operationalSystems: null,
    employeeChart: null,
    scrapedData: null,
    scrapeSource: null,
    sellerProfile: { communicationStyle: "direct", privacyVersion: 99 },
    sectionImportance: null,
    interviewOutline: null,
    interviewPlan: null,
    askingPrice: null,
    interviewCompleted: false,
    extractedInfo: {},
    ...extra,
  };
}
