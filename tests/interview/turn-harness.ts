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
}

export function toolInput(r: ScriptedReply) {
  return {
    message: r.message,
    whyItMatters: r.whyItMatters,
    importance: r.importance,
    targetSection: r.targetSection,
    suggestedAnswers: r.suggestedAnswers ?? ["Yes", "No", "Not sure"],
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
    privateNotes: [],
    newTasks: [],
    shouldEnd: r.shouldEnd ?? false,
    endReason: r.endReason,
  };
}

export interface Harness {
  deal: any;
  sessions: any[];
  tasks: any[];
  /** Replies the model gives, in order (interview_response calls only). */
  script: ScriptedReply[];
  /** Every interview-model call: the last user content it was sent. */
  calls: string[];
  logs: string[];
}

export function installHarness(deal: any, opts: { messages?: ConversationMessage[]; sessionMeta?: Record<string, unknown>; documents?: any[] } = {}): Harness {
  const h: Harness = {
    deal,
    sessions: [],
    tasks: [],
    script: [],
    calls: [],
    logs: [],
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
    if (tool !== "interview_response") throw new Error(`unexpected model call (${tool ?? "no tool"})`);
    const last = params.messages[params.messages.length - 1];
    h.calls.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
    const next = h.script.shift();
    if (!next) throw new Error("harness: no scripted reply left");
    return { content: [{ type: "tool_use", id: "t", name: "interview_response", input: toolInput(next) }], stop_reason: "tool_use" };
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
    const c: any = {
      where: () => c,
      orderBy: () => c,
      limit: () => c,
      then: (res: any, rej: any) => Promise.resolve(rows()).then(res, rej),
    };
    return c;
  };
  d.select = () => ({ from: (table: any) => chain(() => (table === interviewSessions ? h.sessions : [])) });
  d.update = (table: any) => ({
    set: (values: any) => ({
      where: async () => {
        if (table !== interviewSessions) return;
        // One session in play at a time in these tests: update the newest.
        const target = h.sessions[h.sessions.length - 1];
        if (target) Object.assign(target, values);
      },
    }),
  });
  d.insert = (table: any) => ({
    values: (values: any) => ({
      returning: async () => {
        if (table !== interviewSessions) return [];
        const row = { id: `sess-${h.sessions.length + 1}`, lastActivityAt: new Date(), completedAt: null, ...values };
        h.sessions.push(row);
        return [row];
      },
    }),
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
