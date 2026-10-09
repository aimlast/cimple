/**
 * The buyer-facing description of a room document (vdr spec §9.8, V12) —
 * the ONLY model call in the data room. Sonnet, tool-forced, batches of ≤ 5.
 *
 *  - Asked for once per document (`buyerSummaryAt` null): at set-up, when a
 *    document is placed later, when the Share dialog opens for one without a
 *    description. Never on re-reads, re-shares or moves. "Draft again" is the
 *    broker's click (aiLimiter + the cap).
 *  - The queue is persisted (`buyer_summary_status = 'pending'`), so a
 *    restart neither loses nor repeats a draft; it runs every 10 s in the
 *    scheduler block (never under DISABLE_SCHEDULERS=1).
 *  - Per-deal daily cap: 60 documents. Beyond it items stay pending until
 *    the next day.
 *  - Inputs: title, type, period, pages, the extraction's summary and key
 *    facts screened for sensitive and confidential clauses and held names,
 *    and the document's buyer-safe facts. NEVER red flags, private notes,
 *    action items or seller concerns. Ledgers are never sent.
 *  - Guards on the output: every figure traced to the document's served text
 *    or its facts; no sensitive detail; no held person; no opinion or advice
 *    words; length caps. A failed guard → the basic line (source "basic").
 *    A model failure (or no AI on this server) → the basic line (source
 *    "unavailable"). Nothing reaches a buyer until the broker accepts it.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Deal, Document, VdrItem } from "@shared/schema";
import { VDR_LIMITS, documentTypeLabel, isLedgerDoc, periodEndLabel } from "@shared/vdr";
import { isKnownFigure, knownFiguresFrom, parseFigures } from "../cim/figure-check";
import { hasSensitiveDetail, mentionsHeldPerson, screenConfidentialText, screenText } from "../cim/sensitive-facts";
import { buyerSafeFacts, heldNamesFor } from "./analysis";
import { dbVdrStore, logVdrQuietly, type VdrStore } from "./store";

export const SUMMARY_TOOL: Anthropic.Tool = {
  name: "write_document_notes",
  description: "Short buyer-facing descriptions of documents in a business-sale data room.",
  input_schema: {
    type: "object",
    required: ["documents"],
    properties: {
      documents: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          required: ["itemId", "summary", "keyPoints"],
          properties: {
            itemId: { type: "string" },
            summary: { type: "string", description: "≤ 70 words. What the document is and what it shows. Plain language. No opinions, no advice, no valuation, no risks." },
            keyPoints: { type: "array", maxItems: 4, items: { type: "string", description: "≤ 20 words; any figure exactly as printed in the inputs" } },
          },
        },
      },
    },
  },
};

export const SUMMARY_SYSTEM = [
  "You describe a document in a business-sale data room for a buyer who will read the document itself.",
  "Describe, don't judge. Use only the inputs.",
  "Never mention people's health, family, pay disputes or anything marked private.",
  "Never give opinions, red flags, valuations or advice.",
  "Quote any figure exactly as it appears in the inputs; if a figure isn't in the inputs, leave it out.",
].join(" ");

export type SummaryModelInput = { system: string; user: string; tool: Anthropic.Tool };
/** Returns the tool's input object (`{ documents: [...] }`). */
export type SummaryModel = (i: SummaryModelInput) => Promise<unknown>;

let testModel: SummaryModel | null = null;
/** Tests replace the model (recorded tool outputs). */
export function _setSummaryModelForTests(m: SummaryModel | null): void {
  testModel = m;
}

/** Is there a model to call? (No key, or "disabled", → never a network call.) */
export function summaryAiConfigured(): boolean {
  if (testModel) return true;
  const k = process.env.ANTHROPIC_API_KEY;
  return !!k && k !== "disabled";
}

async function liveModel(i: SummaryModelInput): Promise<unknown> {
  if (!summaryAiConfigured()) throw new Error("No AI on this server");
  const { agentConfig } = await import("../interview/config/load-config");
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const r = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 1200,
    temperature: 0.2,
    system: i.system,
    tools: [i.tool],
    tool_choice: { type: "tool", name: i.tool.name },
    messages: [{ role: "user", content: i.user }],
  });
  const block = r.content.find((b) => b.type === "tool_use");
  return block && block.type === "tool_use" ? block.input : null;
}

const model = (): SummaryModel => testModel ?? liveModel;

// ── Inputs ─────────────────────────────────────────────────────────────────

export type SummaryDocInput = {
  itemId: string;
  title: string;
  documentType: string | null;
  periodEnd: string | null;
  pages: number | null;
  summary: string | null;
  keyFacts: string | null;
  facts: Array<{ label: string; value: string }>;
};

function plainText(v: unknown): string {
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v.filter((x) => typeof x === "string").join("; ");
  return "";
}

/** What the model may read about one document (never red flags, private notes, action items or seller concerns). */
export function summaryInputFor(deal: Pick<Deal, "id" | "extractedInfo" | "cimGeneration">, item: Pick<VdrItem, "id" | "title" | "prepared">, doc: Pick<Document, "id" | "name" | "extractedData" | "sourceMeta">, brokerOnlyDocIds: ReadonlySet<string>, heldNames: readonly string[]): SummaryDocInput {
  const ed = (doc.extractedData ?? null) as Record<string, unknown> | null;
  const meta = (doc.sourceMeta ?? null) as Record<string, unknown> | null;
  const screen = (t: string) => {
    const s = screenConfidentialText(screenText(t), heldNames).replace(/\s+/g, " ").trim();
    return s ? s.slice(0, 1200) : null;
  };
  const p = item.prepared ?? null;
  return {
    itemId: item.id,
    title: item.title,
    documentType: documentTypeLabel(doc),
    periodEnd: periodEndLabel(ed?._periodEnd ?? meta?.periodEnd),
    pages: p?.pages?.length ?? p?.sheets?.length ?? null,
    summary: ed?.summary ? screen(plainText(ed.summary)) : null,
    keyFacts: ed?.keyFacts ? screen(plainText(ed.keyFacts)) : null,
    facts: buyerSafeFacts(deal, doc.id, brokerOnlyDocIds, { figuresOnly: false, limit: 25, maxLen: 240 }),
  };
}

// ── Guards ─────────────────────────────────────────────────────────────────

const JUDGEMENT = /\b(red flags?|recommend\w*|we advise|you should|valuation|undervalued|overvalued|bargain|risky|concerning|worrying|attractive|impressive|strong performance|weak performance)\b/i;
const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

/** Figures the output must trace to (money, percentages, amounts — not years or small counts). */
function checkable(text: string) {
  return parseFigures(text).filter((f) => {
    if (f.kind === "percent") return true;
    if (f.kind === "money") return f.value !== 0;
    if (Number.isInteger(f.value) && f.value >= 1900 && f.value <= 2100 && !f.text.includes(",")) return false;
    return Math.abs(f.value) >= 1000 || f.text.includes(",");
  });
}

export type GuardResult = { ok: true; summary: string; points: string[] } | { ok: false; reason: string };

/** The checks a drafted description must pass before the broker even sees it as a draft. */
export function guardSummary(out: unknown, knownText: string, heldNames: readonly string[]): GuardResult {
  const o = (out && typeof out === "object" ? out : {}) as Record<string, unknown>;
  const summary = typeof o.summary === "string" ? o.summary.replace(/\s+/g, " ").trim() : "";
  if (!summary) return { ok: false, reason: "empty" };
  if (words(summary) > 70 || summary.length > 600) return { ok: false, reason: "too long" };
  const raw = Array.isArray(o.keyPoints) ? o.keyPoints : [];
  if (raw.length > 4) return { ok: false, reason: "too many points" };
  const points: string[] = [];
  for (const p of raw) {
    if (typeof p !== "string") return { ok: false, reason: "bad point" };
    const t = p.replace(/\s+/g, " ").trim();
    if (!t) continue;
    if (words(t) > 20 || t.length > 160) return { ok: false, reason: "point too long" };
    points.push(t);
  }
  const all = [summary, ...points].join("\n");
  const known = knownFiguresFrom(knownText);
  for (const f of checkable(all)) if (!isKnownFigure(f, known)) return { ok: false, reason: `figure ${f.text} not in the document` };
  if (hasSensitiveDetail(all)) return { ok: false, reason: "sensitive detail" };
  if (mentionsHeldPerson(all, heldNames)) return { ok: false, reason: "held person" };
  if (JUDGEMENT.test(all)) return { ok: false, reason: "judgement words" };
  return { ok: true, summary, points };
}

// ── The queue ──────────────────────────────────────────────────────────────

export type SummaryDeps = {
  store: VdrStore;
  getDeal: (id: string) => Promise<Deal | undefined | null>;
  now: () => Date;
};

export function defaultSummaryDeps(): SummaryDeps {
  return {
    store: dbVdrStore,
    getDeal: async (id) => (await import("../storage")).storage.getDeal(id),
    now: () => new Date(),
  };
}

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** Drafts left today for a deal (the cap). */
export function remainingToday(room: { summaryBudgetDay: string | null; summaryBudgetUsed: number } | null, now: Date): number {
  if (!room) return 0;
  const used = room.summaryBudgetDay === dayOf(now) ? room.summaryBudgetUsed ?? 0 : 0;
  return Math.max(0, VDR_LIMITS.summaryDailyCap - used);
}

async function takeBudget(deps: SummaryDeps, dealId: string, n: number): Promise<number> {
  const room = await deps.store.getRoom(dealId);
  const now = deps.now();
  const left = remainingToday(room, now);
  const k = Math.min(left, n);
  if (k > 0) {
    const used = room?.summaryBudgetDay === dayOf(now) ? room.summaryBudgetUsed ?? 0 : 0;
    await deps.store.updateRoom(dealId, { summaryBudgetDay: dayOf(now), summaryBudgetUsed: used + k });
  }
  return k;
}

/**
 * Asks for drafts (persisted `pending`), only for documents that never had
 * one. With no model on this server the basic line is used at once (no call
 * is ever made). Returns how many were queued.
 */
export async function requestSummaries(store: VdrStore, dealId: string, itemIds: ReadonlyArray<string>, now: Date = new Date()): Promise<number> {
  let n = 0;
  for (const id of Array.from(new Set(itemIds))) {
    const it = await store.getItem(id);
    if (!it || it.dealId !== dealId || it.removedAt || it.buyerSummaryAt || it.buyerSummaryStatus) continue;
    if (!summaryAiConfigured()) {
      await store.updateItem(id, { buyerSummaryStatus: "failed", buyerSummarySource: "unavailable", buyerSummaryAt: now });
      continue;
    }
    await store.updateItem(id, { buyerSummaryStatus: "pending" });
    n++;
  }
  if (n > 0) kickSummaryQueue();
  return n;
}

async function setBasic(store: VdrStore, item: VdrItem, source: "basic" | "unavailable", now: Date) {
  await store.updateItem(item.id, { buyerSummary: null, buyerSummaryPoints: null, buyerSummarySource: source, buyerSummaryStatus: "failed", buyerSummaryAt: now });
}

/** Drafts one batch (≤ 5 items of ONE deal, already marked pending). Returns how many were written. */
export async function draftBatch(deps: SummaryDeps, deal: Deal, items: ReadonlyArray<VdrItem>): Promise<{ drafted: number; basic: number }> {
  const now = deps.now();
  const docs = await deps.store.listDocuments(deal.id);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const brokerOnly = new Set(docs.filter((d) => d.visibility === "broker_only").map((d) => d.id));
  const heldNames = heldNamesFor(deal);
  let basic = 0;
  const send: Array<{ item: VdrItem; doc: Document; input: SummaryDocInput; known: string }> = [];
  for (const it of items) {
    const doc = it.documentId ? byId.get(it.documentId) ?? null : null;
    const p = it.prepared ?? null;
    // A ledger is never sent (gl writes its own line); a document Cimple can't open gets the basic line.
    if (!doc || doc.visibility === "broker_only" || isLedgerDoc(doc) || p?.kind === "ledger" || p?.kind === "ledger_pending" || p?.status === "failed") {
      await setBasic(deps.store, it, "basic", now);
      basic++;
      continue;
    }
    const input = summaryInputFor(deal, it, doc, brokerOnly, heldNames);
    const pageText = (await deps.store.getPageText(it.id)).map((r) => r.text).join("\n");
    const known = [pageText, ...input.facts.map((f) => `${f.label}: ${f.value}`)].join("\n");
    send.push({ item: it, doc, input, known });
  }
  if (send.length === 0) return { drafted: 0, basic };
  const user = `<documents>\n${JSON.stringify(send.map((s) => s.input), null, 1).slice(0, 60_000)}\n</documents>`;
  let out: unknown = null;
  try {
    out = await model()({ system: SUMMARY_SYSTEM, user, tool: SUMMARY_TOOL });
  } catch (err) {
    const { describeAiFailure } = await import("../ai-retry");
    console.warn(`[vdr] description drafts failed for deal ${deal.id}: ${describeAiFailure(err).reason}`);
    for (const s of send) await setBasic(deps.store, s.item, "unavailable", now);
    return { drafted: 0, basic: basic + send.length };
  }
  const list = Array.isArray((out as Record<string, unknown> | null)?.documents) ? ((out as Record<string, unknown>).documents as unknown[]) : [];
  let drafted = 0;
  for (const s of send) {
    // The broker may have written or accepted one meanwhile: never overwrite it.
    const fresh = await deps.store.getItem(s.item.id);
    if (!fresh || fresh.buyerSummaryStatus !== "pending") continue;
    const mine = list.find((d) => d && typeof d === "object" && (d as Record<string, unknown>).itemId === s.item.id);
    const g = mine ? guardSummary(mine, s.known, heldNames) : ({ ok: false, reason: "missing" } as const);
    if (!g.ok) {
      console.warn(`[vdr] description for item ${s.item.id} didn't pass its checks (${g.reason}) — basic line`);
      await setBasic(deps.store, s.item, "basic", now);
      basic++;
      continue;
    }
    await deps.store.updateItem(s.item.id, { buyerSummary: g.summary, buyerSummaryPoints: g.points, buyerSummarySource: "ai", buyerSummaryStatus: "drafted", buyerSummaryAt: now });
    await logVdrQuietly(deps.store, { dealId: deal.id, action: "summary_drafted", actorKind: "system", itemId: s.item.id });
    drafted++;
  }
  return { drafted, basic };
}

/** One pass of the queue: one batch of one deal (≤ 5, within the deal's cap). Returns how many it handled. */
export async function runPendingSummaries(deps: SummaryDeps = defaultSummaryDeps()): Promise<number> {
  const pending = await deps.store.itemsWithPendingSummaries(200);
  const deals = Array.from(new Set(pending.map((p) => p.dealId)));
  for (const dealId of deals) {
    // Wait for the document to be prepared (its served text is what figures are checked against).
    const ready = pending.filter((p) => p.dealId === dealId && !!p.prepared && p.prepared.status !== "pending");
    if (ready.length === 0) continue;
    const deal = await deps.getDeal(dealId);
    if (!deal) continue;
    const k = await takeBudget(deps, dealId, Math.min(5, ready.length));
    if (k === 0) continue; // today's cap reached: they stay pending until tomorrow
    const r = await draftBatch(deps, deal, ready.slice(0, k));
    return r.drafted + r.basic;
  }
  return 0;
}

/**
 * "Draft again" (the broker's click): one document now, within the cap.
 * Returns what happened in plain words for the drawer.
 */
export async function redraftOne(deps: SummaryDeps, deal: Deal, itemId: string): Promise<{ ok: boolean; status: string | null; message: string }> {
  const it = await deps.store.getItem(itemId);
  if (!it || it.dealId !== deal.id || it.removedAt) return { ok: false, status: null, message: "Not found" };
  if (!it.prepared || it.prepared.status === "pending") return { ok: false, status: it.buyerSummaryStatus ?? null, message: "Cimple is still preparing this document. Try again in a minute." };
  if (!summaryAiConfigured()) return { ok: false, status: it.buyerSummaryStatus ?? null, message: "Cimple can't write descriptions on this server right now. Write your own." };
  const k = await takeBudget(deps, deal.id, 1);
  if (k === 0) return { ok: false, status: it.buyerSummaryStatus ?? null, message: "Cimple has written today's descriptions for this deal. Try again tomorrow or write your own." };
  await deps.store.updateItem(itemId, { buyerSummaryStatus: "pending" });
  const fresh = (await deps.store.getItem(itemId))!;
  const r = await draftBatch(deps, deal, [fresh]);
  const after = await deps.store.getItem(itemId);
  if (r.drafted > 0) return { ok: true, status: "drafted", message: "Cimple wrote a new description. Buyers see it once you choose Use this." };
  return {
    ok: false,
    status: after?.buyerSummaryStatus ?? null,
    message: after?.buyerSummarySource === "unavailable"
      ? "Cimple couldn't write a description right now, so the basic line is shown. Write your own or try again later."
      : "Cimple's draft didn't pass its checks, so a basic description is shown. Write your own or draft again.",
  };
}

// ── The timer (scheduler block only) ───────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let kickPending = false;

async function tick() {
  if (running) { kickPending = true; return; }
  running = true;
  try {
    let n = 1;
    // Drain a few batches per tick while there's work, without hogging the process.
    for (let i = 0; i < 4 && n > 0; i++) n = await runPendingSummaries();
  } catch (err: any) {
    console.warn("[vdr] description queue:", err?.message ?? err);
  } finally {
    running = false;
    if (kickPending) { kickPending = false; setTimeout(() => void tick(), 1000); }
  }
}

/** Nudges the queue (only when it was started — never under DISABLE_SCHEDULERS=1). */
export function kickSummaryQueue(): void {
  if (!timer) return;
  setTimeout(() => void tick(), 500);
}

/** Starts the 10-second queue (server/index.ts, inside the DISABLE_SCHEDULERS gate). Resumes pending drafts after a restart. */
export function startSummaryQueue(): void {
  if (timer || process.env.DISABLE_SCHEDULERS === "1") return;
  timer = setInterval(() => void tick(), 10_000);
  timer.unref?.();
  setTimeout(() => void tick(), 15_000).unref?.();
}
