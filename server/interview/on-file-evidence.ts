/**
 * on-file-evidence — which of the interview's open items does the deal's
 * file ALREADY answer?
 *
 * The root of most re-asks (QA round V, Great Lakes: 11 of 21 questions asked
 * for something on file) was not the model ignoring the ALREADY ANSWERED list
 * — it was the prompt contradicting itself. The industry checklist listed
 * "robotAutomationLevel: NOT YET CAPTURED" (and STILL NEEDED ordered it
 * asked) while the facts held robotCount "21 robots"; "unionRisk" was open
 * while the Zoom call had the failed 61–39 vote; the scrap rates, the top-5
 * share and the payer mix sat in document tables that were never extracted
 * into facts at all; flagged risks the seller had already explained on a
 * call stayed on the "must be asked" agenda. The checklist's own "answered by"
 * link was set once, when the checklist was built, and only against the
 * facts of that moment.
 *
 * This pass reads the whole seller-visible file — every source's text,
 * earlier interview sessions, the facts — against the items the interview
 * still considers open (checklist and generic fields, flagged risks, source
 * conflicts, seller-only topics) and says which are answered, where, and in
 * what words. The interview then shows them as on file (never NOT YET
 * CAPTURED), drops them from the wrap-up agenda, and the re-ask guard knows
 * them. A partial answer says what is still missing, so only that is asked.
 *
 * Trust: every entry must quote its source (the quote is checked against the
 * source text), every figure in the answer must appear in that source, and
 * items that need the seller's own account only count from a call, an email
 * or an earlier session. Privacy: only seller-visible, non-lead sources and
 * the interview's own view of the facts are read (sellerInterviewView), so
 * nothing here can carry the broker's CRM notes or private files.
 *
 * Built in the background (the supporting model, tool-forced JSON) and
 * stored on deals.interview_evidence, keyed to a fingerprint of the sources
 * and earlier sessions; rebuilt when they change or new items appear.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { storage } from "../storage";
import { agentConfig } from "./config/load-config";
import type { Deal, Document, InterviewSession } from "@shared/schema";
import { getFieldSources, isFactKey, repairCharIndexedValue } from "./info-merger";

type DocLike = Pick<Document, "id" | "name" | "visibility"> &
  Partial<Pick<Document, "sourceKind" | "extractedText" | "extractedData" | "createdAt" | "updatedAt">>;
type SessionLike = Pick<InterviewSession, "id" | "messages"> & Partial<Pick<InterviewSession, "startedAt" | "status">>;

export type EvidenceTargetKind = "field" | "risk" | "topic" | "conflict";

/** One open item the interview would otherwise ask about. */
export interface EvidenceTarget {
  /** "field:<key>", "risk:<label>", "topic:<label>", "conflict:<key>". */
  id: string;
  kind: EvidenceTargetKind;
  /** Field name / risk label / topic label / conflict key. */
  key: string;
  /** What is needed, in words. */
  label: string;
  /** Only the seller's own words count (a call, an email, an earlier session) — never a document. */
  sellerAccount: boolean;
  /** Sources that can't answer it (a flagged risk: the sources that flag it — the flag isn't its own explanation). */
  excludeSources?: string[];
}

/** What the file says about one item. */
export interface OnFileEntry {
  answer: string;
  /** Only part of the item is on file — `missing` says what is still open. */
  partial?: boolean;
  missing?: string;
  /** The source's label as the agent sees it ("Injection molding press list", "interview session 1"). */
  source: string;
  /** document / call / video_call / email / questionnaire / session / fact. */
  sourceKind: string;
  /** Document id or session id (none for a fact). */
  sourceId?: string;
  factKey?: string;
  /** FACTS: the source row the fact's value came from when it was read (it must stay seller-visible). */
  factSourceId?: string;
  quote?: string;
}

export interface OnFileEvidence {
  version: number;
  fingerprint: string;
  computedAt: string;
  /** How long the build took (ms) — what the next build is expected to take. */
  buildMs?: number;
  status: "ready" | "failed";
  /** Target ids this build looked at (answered or not). */
  checked: string[];
  entries: Record<string, OnFileEntry>;
}

/** An entry as the interview uses it (with its target). */
export interface OnFileItem extends OnFileEntry {
  id: string;
  kind: EvidenceTargetKind;
  key: string;
  label: string;
}

/**
 * 1: first version. 2: FACTS entries carry the source row their value came
 * from (factSourceId). A version-1 build is rebuilt; until then its fact
 * entries are "legacy" (see makeStands).
 */
export const EVIDENCE_VERSION = 2;

const LEAD_KINDS = new Set(["crm", "website", "social"]);
/** The seller (or their staff) speaking or writing. */
const SAID_KINDS = new Set(["call", "video_call", "email", "questionnaire", "session"]);
const readable = (d: DocLike) =>
  d.visibility !== "broker_only" && !LEAD_KINDS.has(String(d.sourceKind)) &&
  ((typeof d.extractedText === "string" && d.extractedText.trim().length > 0) || !!d.extractedData);

// Input budgets (characters): ~60K tokens in all for a large deal.
const PER_SOURCE = 22_000;
const SOURCES_BUDGET = 170_000;
const SESSIONS_BUDGET = 50_000;
const FACTS_BUDGET = 36_000;
const BATCH_SIZE = 24;
const MAX_TARGETS = 96;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const flat = (s: string) => s.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();

function sessionsInOrder(sessions: SessionLike[], currentSessionId: string | null | undefined): SessionLike[] {
  return [...sessions]
    .filter((s) => s.id !== currentSessionId && (Array.isArray(s.messages) ? s.messages : []).some((m: any) => m?.role === "user"))
    .sort((a, b) => new Date(String(a.startedAt ?? 0)).getTime() - new Date(String(b.startedAt ?? 0)).getTime());
}

/**
 * Fingerprint of what the evidence is read from: the seller-visible sources
 * and the earlier sessions (the session in progress is left out — its
 * answers are in the agent's own transcript, and a rebuild on every turn
 * would cost a long call per answer).
 */
export function evidenceFingerprint(documents: DocLike[], sessions: SessionLike[], currentSessionId: string | null | undefined): string {
  const docs = documents
    .filter(readable)
    .map((d) => `${d.id}:${typeof d.extractedText === "string" ? d.extractedText.length : 0}:${JSON.stringify(d.extractedData ?? null).length}`)
    .sort();
  const sess = sessionsInOrder(sessions, currentSessionId).map((s) => `${s.id}:${(s.messages as unknown[]).length}`);
  return createHash("sha1").update(`${EVIDENCE_VERSION}|${docs.join("|")}|${sess.join("|")}`).digest("hex").slice(0, 16);
}

/** The stored evidence (any age), or null. */
export function storedEvidence(deal: { interviewEvidence?: unknown }): OnFileEvidence | null {
  const e = deal.interviewEvidence as OnFileEvidence | null | undefined;
  if (!e || e.status !== "ready" || !e.entries || typeof e.entries !== "object") return null;
  return e;
}

type StandCtx = {
  documents?: DocLike[];
  view?: Record<string, unknown>;
  sessionIds?: string[];
  /** The entries come from a version-1 build (no factSourceId recorded). */
  legacy?: boolean;
};

/** Content words (4+ letters) of a text, lower-cased, with a plain plural "s" dropped. */
function contentWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[a-z][a-z'-]{3,}/g) ?? []) out.add(w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  return out;
}

/** At least half of the answer's content words are in the value — it still says this. */
function wordsSupported(answer: string, value: string): boolean {
  const mine = Array.from(contentWords(answer));
  if (mine.length === 0) return true;
  const theirs = contentWords(value);
  return mine.filter((w) => theirs.has(w)).length * 2 >= mine.length;
}

/**
 * Does a stored entry still stand? A document entry whose source is gone or
 * now broker-only does not; a session entry whose session is gone does not;
 * a fact entry stands only while the interview's view still holds that fact,
 * the value still states the entry's figures, and the source row the value
 * came from is still seller-visible — so a fact whose source was made
 * broker-only stops being quoted at once (the view falls back to another
 * value), not after a background rebuild. Pure.
 */
function makeStands(ctx: StandCtx): (e: OnFileEntry) => boolean {
  const docs = ctx.documents ? new Map(ctx.documents.map((d) => [d.id, d])) : null;
  const sessions = ctx.sessionIds ? new Set(ctx.sessionIds) : null;
  const visible = (id: string) => {
    const d = docs?.get(id);
    return !!d && d.visibility !== "broker_only" && !LEAD_KINDS.has(String(d.sourceKind));
  };
  return (e) => {
    if (!e || typeof e.answer !== "string" || !e.answer.trim()) return false;
    if (e.sourceKind === "fact") {
      if (docs && e.factSourceId && !visible(e.factSourceId)) return false;
      if (ctx.view) {
        const v = e.factKey ? ctx.view[e.factKey] : undefined;
        if (!e.factKey || !isSubstantive(v)) return false;
        const text = typeof v === "string" ? v : JSON.stringify(repairCharIndexedValue(v));
        if (!figuresSupported(e.answer, text)) return false;
        // A version-1 entry doesn't say which source it was read from, so a
        // figureless one ("Westline Foods is the anchor customer") would
        // stand on any value — even one another source now supplies because
        // its own went broker-only. It stands only while the value still says
        // it (until the rebuild the version bump brings replaces it).
        if (ctx.legacy && !e.factSourceId && !wordsSupported(e.answer, text)) return false;
      }
      return true;
    }
    if (e.sourceKind === "session") return !(sessions && e.sourceId && !sessions.has(e.sourceId));
    return !(docs && e.sourceId && !visible(e.sourceId));
  };
}

/** The stored entries that still stand for the interview (see makeStands). Pure. */
export function onFileItems(
  deal: { interviewEvidence?: unknown },
  targets: EvidenceTarget[],
  ctx: StandCtx = {},
): OnFileItem[] {
  const stored = storedEvidence(deal);
  if (!stored) return [];
  const stands = makeStands({ ...ctx, legacy: (stored.version ?? 1) < 2 });
  const out: OnFileItem[] = [];
  for (const t of targets) {
    const e = stored.entries[t.id];
    if (!e || !stands(e)) continue;
    if (t.sellerAccount && !SAID_KINDS.has(e.sourceKind) && e.sourceKind !== "fact") continue;
    out.push({ ...e, id: t.id, kind: t.kind, key: t.key, label: t.label });
  }
  return out;
}

function isSubstantive(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 1;
  return true;
}

// =====================
// The model's input
// =====================

interface SourceBlock { id: string; label: string; kind: string; docId?: string; sessionId?: string; text: string }

/** Source blocks: seller-visible documents and transcripts, then earlier sessions (the seller's answers). */
export function evidenceSources(documents: DocLike[], sessions: SessionLike[], currentSessionId: string | null | undefined): SourceBlock[] {
  const blocks: SourceBlock[] = [];
  let budget = SOURCES_BUDGET;
  let n = 0;
  for (const d of documents) {
    if (!readable(d) || budget <= 0) continue;
    const kind = String(d.sourceKind || "document");
    const data = (d.extractedData as Record<string, unknown> | null) || {};
    const raw = typeof d.extractedText === "string" && d.extractedText.trim()
      ? d.extractedText
      : ["summary", "keyFacts"].map((k) => (typeof data[k] === "string" ? String(data[k]) : "")).filter(Boolean).join("\n");
    const text = clip(flat(raw), Math.min(PER_SOURCE, budget));
    if (!text) continue;
    budget -= text.length;
    n++;
    blocks.push({ id: `S${n}`, label: d.name, kind, docId: d.id, text });
  }
  let sBudget = SESSIONS_BUDGET;
  sessionsInOrder(sessions, currentSessionId).forEach((s, i) => {
    if (sBudget <= 0) return;
    const msgs = (Array.isArray(s.messages) ? s.messages : []) as { role: string; content: string }[];
    const lines: string[] = [];
    for (let k = 0; k < msgs.length; k++) {
      if (msgs[k].role !== "user") continue;
      const q = msgs[k - 1]?.role === "ai" ? clip(flat(String(msgs[k - 1].content ?? "")).replace(/\n/g, " "), 300) : "";
      lines.push(`${q ? `Interviewer: ${q}\n` : ""}Owner: ${flat(String(msgs[k].content ?? "")).replace(/\n/g, " ")}`);
    }
    const text = clip(lines.join("\n"), sBudget);
    sBudget -= text.length;
    blocks.push({ id: `P${i + 1}`, label: `interview session ${i + 1}`, kind: "session", sessionId: s.id, text });
  });
  return blocks;
}

const KIND_WORDS: Record<string, string> = {
  document: "document",
  call: "call transcript (spoken)",
  video_call: "video call transcript (spoken)",
  email: "email (written by the people named)",
  questionnaire: "the owner's intake questionnaire",
  session: "earlier interview session (the owner's own answers)",
};

/** Facts on file (the interview's view), one line each — the items themselves left out. */
export function evidenceFacts(view: Record<string, unknown>, skipKeys: ReadonlySet<string>): string {
  const sources = getFieldSources(view);
  const lines: string[] = [];
  let budget = FACTS_BUDGET;
  for (const [key, raw] of Object.entries(view)) {
    if (!isFactKey(key) || skipKeys.has(key) || !isSubstantive(raw)) continue;
    const src = String(sources[key]?.source ?? "");
    if (LEAD_KINDS.has(src) && !sources[key]?.acceptedByBroker) continue;
    const v = repairCharIndexedValue(raw);
    const text = clip((typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " "), 220);
    const line = `- ${key}: ${text}`;
    if (budget - line.length < 0) break;
    budget -= line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

function targetLine(t: EvidenceTarget, n: number): string {
  const what =
    t.kind === "field" ? `data point "${t.label}" (key ${t.key})`
    : t.kind === "risk" ? `RISK flagged in the file: "${t.label}" — answered only if the file already explains what happened and where it stands now (usually the owner on a call, in an email or an earlier session); the flag itself is not an answer`
    : t.kind === "conflict" ? `CONFLICT between sources: ${t.label} — answered only if the owner has already explained which is right or why they differ`
    : `the owner's own account of: ${t.label}`;
  return `[T${n}] ${what}${t.sellerAccount ? " — OWNER'S ACCOUNT ONLY (a call, an email or an earlier session; never a document)" : ""}`;
}

const EVIDENCE_TOOL = {
  name: "items_on_file",
  description: "List the items the file already answers, fully or partly.",
  input_schema: {
    type: "object" as const,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "status", "answer", "sourceId", "quote"],
          properties: {
            id: { type: "string", description: "The item id, e.g. T12." },
            status: { type: "string", enum: ["yes", "partly"] },
            answer: { type: "string", description: "What the source states, ≤ 30 words, in its own figures — never calculated, estimated or inferred. When two sources give different values, give both, each with its source." },
            missing: { type: "string", description: "For 'partly': what the item asks that the file does not state (≤ 15 words)." },
            sourceId: { type: "string", description: "The source that states it: S3, P1, or FACTS." },
            factKey: { type: "string", description: "For FACTS: the fact key." },
            quote: { type: "string", description: "≤ 30 consecutive words copied exactly from that source (or that fact's value) that state it." },
          },
        },
      },
    },
  },
};

const EVIDENCE_SYSTEM = [
  "You check a business-sale file to find which of an interviewer's open items it ALREADY answers. Asking the owner something the file answers makes them repeat themselves; but a false 'yes' makes the interviewer skip something a buyer needs — so be exact.",
  "For each item, look through every source: documents (including tables and spreadsheet rows), call and email transcripts, the earlier interview sessions, and the facts list. Answer 'yes' when a source states the answer to the item itself — the figure, count, list, name, date, terms, yes/no, or the owner's account — however it is worded. Answer 'partly' when it states only part of what the item asks, and say what is missing. Leave an item out when nothing states it: a passing mention of the topic is not an answer, and neither is something you would have to calculate or infer.",
  "Items marked OWNER'S ACCOUNT ONLY count only from what the owner (or their staff) said or wrote — a call, an email, the intake questionnaire or an earlier interview session — never from a document or the facts list.",
  "Return only items that are answered (yes or partly). In the answer, give figures exactly as the source states them — never add, subtract, total, average or convert them. The quote is consecutive words copied from that one source (for a table, the row as it appears); if you need two places, join them with '...'.",
].join(" ");

let client: Anthropic | null = null;
const anthropic = () => (client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2 }));

/**
 * The model's raw results for one batch of items (unvalidated). Streamed:
 * `onStarted` fires when the response begins — the moment the file's prompt
 * cache is written and the other batches can read it.
 */
async function modelBatch(materials: string, items: string, onStarted?: () => void): Promise<unknown[]> {
  const stream = anthropic().messages.stream(
    {
      model: agentConfig.models.supportingAgents,
      max_tokens: 5000,
      temperature: 0,
      tools: [EVIDENCE_TOOL],
      tool_choice: { type: "tool", name: "items_on_file" },
      system: EVIDENCE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            // The file is the same for every batch — cached after the first.
            { type: "text", text: materials, cache_control: { type: "ephemeral" } },
            { type: "text", text: `ITEMS TO CHECK:\n${items}` },
          ],
        },
      ],
    },
    { timeout: 240_000 },
  );
  if (onStarted) {
    let started = false;
    stream.on("streamEvent", () => {
      if (started) return;
      started = true;
      onStarted();
    });
  }
  const response = await stream.finalMessage();
  const block = response.content.find((b) => b.type === "tool_use");
  const results = ((block && block.type === "tool_use" ? block.input : {}) as { results?: unknown }).results;
  return Array.isArray(results) ? results : [];
}

// =====================
// Validation (pure)
// =====================

/** Lower-case words and figures of a text: PDF/spreadsheet glue undone ("material)3.9%3.4%" → "material 3.9% 3.4%"). */
function tokensOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/(\d),(?=\d{3}\b)/g, "$1") // 36,058,217 → 36058217
    .replace(/\$/g, " ")
    .replace(/([a-z)])(\d)/g, "$1 $2")
    .replace(/(%)(\d)/g, "$1 $2")
    .replace(/(\d)([a-z(])/g, "$1 $2")
    .split(/[^a-z0-9.%']+/)
    .map((w) => w.replace(/^[.']+|[.']+$/g, ""))
    .filter(Boolean);
}
const QUOTE_STOP = new Set("the and for with that this are was were has have had its our not but from they their them about into over under per you your just there than then what when which who will would could also some any all one".split(" "));
/** The words of a quote that carry its content (numbers always). */
const contentTokens = (text: string) => tokensOf(text).filter((w) => /\d/.test(w) || (w.length >= 3 && !QUOTE_STOP.has(w)));

/**
 * True when the quote is in the text. Verbatim after normalising, or — for
 * table rows the model reads across cells, and "…" joins — each fragment's
 * content words (≥ 70%, every figure among them) found together within a
 * few lines of the text.
 */
export function quoteInText(quote: string, text: string): boolean {
  const flatQ = tokensOf(quote).join(" ");
  const flatT = ` ${tokensOf(text).join(" ")} `;
  if (flatQ.split(" ").length >= 3 && flatT.includes(` ${flatQ} `)) return true;
  const fragments = quote.split(/\.{3}|…/).map((f) => f.trim()).filter((f) => contentTokens(f).length >= 2);
  if (fragments.length === 0) return false;
  const src = tokensOf(text);
  // PDF tables glue cells into one run of digits ("36,058,21761.9%"): a
  // figure also counts when its digits appear in the text with separators removed.
  const compact = text.toLowerCase().replace(/[,\s$]/g, "");
  const WINDOW = 45;
  return fragments.every((f) => {
    const want = Array.from(new Set(contentTokens(f)));
    let best = 0;
    for (let i = 0; i < src.length; i++) {
      if (!want.includes(src[i])) continue;
      const around = src.slice(Math.max(0, i - WINDOW), i + WINDOW);
      const win = new Set(around);
      let spoken: number[] | null = null;
      const present = (w: string) => {
        if (win.has(w)) return true;
        if (!/\d/.test(w)) return false;
        // (A table's year header can sit far above the row — a year anywhere in the text counts.)
        if (/^(?:19|20)\d{2}$/.test(w)) return src.includes(w);
        if (w.replace(/[^\d.%]/g, "").length >= 3 && compact.includes(w.replace(/[^\d.%]/g, ""))) return true;
        spoken ??= spokenNumbers(around.join(" "));
        return spoken.includes(Number(w.replace(/[%$]/g, "")));
      };
      // Every figure of the fragment must be there; most of its words too.
      if (want.some((w) => /\d/.test(w) && !present(w))) continue;
      best = Math.max(best, want.filter(present).length / want.length);
      if (best >= 0.7) break;
    }
    return best >= 0.7;
  });
}

const UNITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES: Record<string, number> = { hundred: 100, thousand: 1e3, million: 1e6, billion: 1e9 };

/**
 * Numbers spelled out in speech: "three hundred eighty thousand" → 380000,
 * "eleven point two" → 11.2, "sixty-one to thirty-nine" → 61, 39, "a million
 * and a half" → 1500000, and the price shorthand "seventeen fifty" → 17.5
 * (and 1750). Pure.
 */
export function spokenNumbers(text: string): number[] {
  const words = text.toLowerCase().replace(/-/g, " ").split(/[^a-z]+/).filter(Boolean);
  const small = (w: string | undefined) => (w === undefined ? null : w in UNITS ? UNITS[w] : w in TENS ? TENS[w] : null);
  const isStart = (k: number) => small(words[k]) !== null || (words[k] === "a" && words[k + 1] in SCALES && words[k + 1] !== "hundred");
  const out: number[] = [];
  let prev: { value: number; end: number } | null = null;
  let i = 0;
  while (i < words.length) {
    if (!isStart(i)) { i++; continue; }
    let total = 0;
    let current = 0;
    let lastScale = 1;
    let j = i;
    if (words[j] === "a") { current = 1; j++; }
    for (; j < words.length; j++) {
      const w = words[j];
      const v = small(w);
      if (v !== null) {
        if (current === 0 && !(total > 0 && v === 0)) { current = v; continue; }
        const rem = current % 100;
        if (current >= 100 && rem === 0 && v < 100) { current += v; continue; } // "three hundred eighty"
        if (rem >= 20 && rem % 10 === 0 && v > 0 && v < 10) { current += v; continue; } // "sixty one"
        break; // a new number ("seventeen fifty", "sixty one to thirty nine")
      }
      if (w === "hundred") { current = (current || 1) * 100; lastScale = 100; continue; }
      if (w in SCALES) { total += (current || 1) * SCALES[w]; current = 0; lastScale = SCALES[w]; continue; }
      if (w === "and" && words[j + 1] === "a" && words[j + 2] === "half") { total += 0.5 * lastScale; j += 2; continue; }
      if (w === "and" && small(words[j + 1]) !== null && (current >= 100 || total > 0)) continue;
      if (w === "point" && small(words[j + 1]) !== null && small(words[j + 1])! < 10) {
        current += small(words[j + 1])! / 10;
        j++;
        continue;
      }
      break;
    }
    const value = total + current;
    out.push(value);
    // Money shorthand: "seventeen fifty" ($17.50, or 1750); "three eighty-five" (385 — thousand).
    if (prev && prev.end === i && value >= 10 && value < 100 && Number.isInteger(value) && Number.isInteger(prev.value)) {
      if (prev.value >= 10 && prev.value < 100) out.push(prev.value + value / 100, prev.value * 100 + value);
      else if (prev.value >= 1 && prev.value < 10) out.push(prev.value * 100 + value, (prev.value * 100 + value) * 1000);
    }
    prev = { value, end: j };
    i = Math.max(j, i + 1);
  }
  return out;
}

/**
 * A number as written: thousands groups only when they really are groups
 * ("62,480", "1,150,000"). A spreadsheet row reads as cells — "Jan
 * 2024,5311,8311" is 2024, 5311 and 8311, "TOTAL,62480,104300" is 62480 and
 * 104300 (read as one run of digits, no figure in such a row could ever be
 * found). Never starts inside another number.
 */
export const NUMBER_RE = /(?<![\d.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s*(k|m|mm|million|thousand|b|billion)?(?![a-z])/gi;
const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };

/** The figures a text states, as written and scaled ($3.1M ≈ 3,100,000), plus spelled ones. */
function figures(text: string): number[] {
  const out: number[] = [];
  const re = new RegExp(NUMBER_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    out.push(n);
    const suf = (m[2] || "").toLowerCase();
    if (suf && SCALE[suf]) out.push(n * SCALE[suf]);
  }
  return [...out, ...spokenNumbers(text)];
}

/**
 * Every figure in the answer appears in the file (as written, scaled or
 * spelled), to the precision the answer writes it: "62,480" must be 62,480
 * (a figure half a percent away somewhere else in a large file is not
 * support), "$3.1M" covers 3.05–3.15M, "$73" covers $72.99. A year is exempt
 * — a call says "last year" where the answer names 2024.
 */
export function figuresSupported(answer: string, source: string | number[]): boolean {
  const have = typeof source === "string" ? figures(source) : source;
  const re = new RegExp(NUMBER_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer)) !== null) {
    if (!m[2] && /^(?:19|20)\d{2}$/.test(m[1])) continue;
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    const scale = SCALE[(m[2] || "").toLowerCase()] ?? 1;
    const decimals = (m[1].split(".")[1] ?? "").length;
    // Half a unit of the last digit written, at the written scale.
    const tolerance = (0.5 * 10 ** -decimals) * scale + 1e-9;
    const want = n * scale;
    if (!have.some((h) => Math.abs(h - want) <= tolerance)) return false;
  }
  return true;
}

/** A value reasoned to, not read ("suggests", "likely", "implied by"). */
const INFERENCE_RE = /\b(suggest(?:s|ing)?|impl(?:y|ies|ied)|inferred?|likely|presumably|probably implies|estimated from|works out to|calculated|computed|derived|equates? to|translates? to|based on (?:typical|industry))\b/i;

/**
 * Checks the model's results against the input and returns the entries that
 * stand, keyed by target id. Pure.
 */
export function validateEvidence(
  raw: unknown[],
  targets: Map<string, EvidenceTarget>,
  sources: Map<string, SourceBlock>,
  facts: Record<string, unknown>,
  /** Filled with why each rejected result was dropped (diagnostics). */
  rejects?: string[],
): Record<string, OnFileEntry> {
  const out: Record<string, OnFileEntry> = {};
  // Every figure in an answer must be somewhere in the file (its own source, or the one it quotes alongside).
  let figurePool: number[] | null = null;
  const pool = () => (figurePool ??= figures(Array.from(sources.values()).map((b) => b.text).join("\n")));
  const drop = (why: string, x: Record<string, unknown>) => { rejects?.push(`${why}: ${String(x.id)} ${String(x.sourceId)} «${String(x.quote ?? "").slice(0, 80)}» → ${String(x.answer ?? "").slice(0, 80)}`); };
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    const id = String(x.id ?? "").replace(/^\[|\]$/g, "").trim();
    const t = targets.get(id);
    if (!t) { drop("unknown item", x); continue; }
    const status = x.status === "partly" ? "partly" : x.status === "yes" ? "yes" : null;
    const answer = typeof x.answer === "string" ? x.answer.replace(/\s+/g, " ").trim() : "";
    const quote = typeof x.quote === "string" ? x.quote.replace(/\s+/g, " ").trim() : "";
    const sourceId = String(x.sourceId ?? "").replace(/^\[|\]$/g, "").trim().toUpperCase();
    if (!status || answer.length < 3 || INFERENCE_RE.test(answer)) { drop("no status/inferred", x); continue; }
    let entry: OnFileEntry | null = null;
    if (sourceId === "FACTS") {
      if (t.sellerAccount) { drop("seller account from facts", x); continue; }
      const key = typeof x.factKey === "string" ? x.factKey.trim() : "";
      const v = key ? facts[key] : undefined;
      if (!key || !isFactKey(key) || !isSubstantive(v)) { drop("no such fact", x); continue; }
      const text = typeof v === "string" ? v : JSON.stringify(repairCharIndexedValue(v));
      if (!figuresSupported(answer, text)) { drop("figure not in fact", x); continue; }
      const factSourceId = getFieldSources(facts)[key]?.documentId;
      entry = { answer: clip(answer, 260), source: `on file as ${key}`, sourceKind: "fact", factKey: key, ...(factSourceId ? { factSourceId } : {}) };
    } else {
      const allowed = (b: SourceBlock) => (!t.sellerAccount || SAID_KINDS.has(b.kind)) && !(t.excludeSources ?? []).includes(b.label);
      let s = sources.get(sourceId);
      if (!s) { drop("no such source", x); continue; }
      // A quote the model credited to the wrong source (session 1 for
      // session 2, one call for another) is credited to where it really is.
      if (quote && (!allowed(s) || !quoteInText(quote, s.text))) {
        s = Array.from(sources.values()).find((b) => allowed(b) && quoteInText(quote, b.text)) ?? s;
      }
      if (!allowed(s)) { drop(t.sellerAccount && !SAID_KINDS.has(s.kind) ? "seller account from a document" : "the flagging source itself", x); continue; }
      if (!quote || !quoteInText(quote, s.text)) { drop("quote not in source", x); continue; }
      if (!figuresSupported(answer, pool())) { drop("figure not in the file", x); continue; }
      entry = {
        answer: clip(answer, 260),
        source: s.label,
        sourceKind: s.kind,
        ...(s.docId ? { sourceId: s.docId } : s.sessionId ? { sourceId: s.sessionId } : {}),
        quote: clip(quote, 240),
      };
    }
    if (status === "partly") {
      entry.partial = true;
      const missing = typeof x.missing === "string" ? x.missing.replace(/\s+/g, " ").trim() : "";
      if (!missing) continue; // a partial answer that can't say what's missing is no guide
      entry.missing = clip(missing, 140);
    }
    // A full answer beats a partial one for the same item.
    const prev = out[t.id];
    if (prev && !prev.partial && entry.partial) continue;
    out[t.id] = entry;
  }
  return out;
}

// =====================
// Build
// =====================

const inflight = new Map<string, Promise<OnFileEvidence | null>>();
/** When each running build started, and how long it is expected to take. */
const inflightTiming = new Map<string, { startedAt: number; expectedMs: number }>();
/** A first build's expected duration (a large deal's file, batches in parallel). */
const DEFAULT_BUILD_MS = 75_000;
const lastStart = new Map<string, number>();
/** A deal's build doesn't restart more often than this (new items between builds wait). */
const MIN_REBUILD_MS = 90_000;

/**
 * Builds the evidence for these targets and stores it. Returns null on
 * failure (a failed marker is stored; the interview carries on without).
 */
export async function computeOnFileEvidence(
  deal: Pick<Deal, "id" | "extractedInfo"> & { interviewEvidence?: unknown },
  args: { documents: DocLike[]; sessions: SessionLike[]; currentSessionId?: string | null; view: Record<string, unknown>; targets: EvidenceTarget[] },
): Promise<OnFileEvidence | null> {
  const fingerprint = evidenceFingerprint(args.documents, args.sessions, args.currentSessionId);
  const targets = args.targets.slice(0, MAX_TARGETS);
  const t0 = Date.now();
  try {
    const blocks = evidenceSources(args.documents, args.sessions, args.currentSessionId);
    const sources = new Map(blocks.map((b) => [b.id, b]));
    const skip = new Set(targets.filter((t) => t.kind === "field").map((t) => t.key));
    const materials = [
      "SOURCES (seller-visible documents, call and email transcripts):",
      ...blocks.filter((b) => b.id.startsWith("S")).map((b) => `\n[${b.id}] ${KIND_WORDS[b.kind] ?? b.kind} — "${b.label}"\n${b.text}`),
      "\nEARLIER INTERVIEW SESSIONS (the owner's own answers):",
      ...blocks.filter((b) => b.id.startsWith("P")).map((b) => `\n[${b.id}] ${b.label}\n${b.text}`),
      `\nFACTS ON FILE [FACTS] (key: value):\n${evidenceFacts(args.view, skip) || "(none)"}`,
    ].join("\n");
    const byId = new Map<string, EvidenceTarget>();
    const lines = targets.map((t, i) => {
      byId.set(`T${i + 1}`, t);
      return targetLine(t, i + 1);
    });
    const batches: string[][] = [];
    for (let i = 0; i < lines.length; i += BATCH_SIZE) batches.push(lines.slice(i, i + BATCH_SIZE));
    const raw: unknown[] = [];
    if (batches.length > 0) {
      // The first batch writes the prompt cache; the rest start the moment
      // its response begins (the cache is readable from then on) and run
      // alongside it — the build takes about one batch, not two in a row
      // (it was ~135s on Great Lakes, while a new session's opening waited).
      let startRest!: () => void;
      const firstStarted = new Promise<void>((resolve) => { startRest = resolve; });
      const first = modelBatch(materials, batches[0].join("\n"), startRest);
      // (A first batch that fails before it starts still lets the rest try.)
      first.catch(() => startRest());
      const rest = firstStarted.then(() =>
        Promise.all(batches.slice(1).map((b) => modelBatch(materials, b.join("\n")).catch(() => [] as unknown[]))),
      );
      raw.push(...(await first));
      for (const r of await rest) raw.push(...r);
    }
    // (Keyed by the target's own id — "field:robotAutomationLevel".)
    const rejects: string[] = [];
    const entries = validateEvidence(raw, byId, sources, args.view, rejects);
    if (process.env.ON_FILE_EVIDENCE_DEBUG) for (const r of rejects) console.log(`[on-file-evidence] dropped — ${r}`);
    const evidence: OnFileEvidence = {
      version: EVIDENCE_VERSION,
      fingerprint,
      computedAt: new Date().toISOString(),
      buildMs: Date.now() - t0,
      status: "ready",
      checked: targets.map((t) => t.id),
      entries,
    };
    await storage.updateDeal(deal.id, { interviewEvidence: evidence } as any);
    const full = Object.values(entries).filter((e) => !e.partial).length;
    console.log(`[on-file-evidence] ${full} of ${targets.length} open item(s) answered on file (${Object.keys(entries).length - full} partly; ${raw.length - Object.keys(entries).length} proposed answer(s) failed the quote/figure check) for deal ${deal.id} in ${Math.round((Date.now() - t0) / 1000)}s`);
    return evidence;
  } catch (err: any) {
    console.warn(`[on-file-evidence] build failed for deal ${deal.id}:`, err?.message || err);
    // A failed rebuild keeps what the deal already had — only the entries
    // that still stand (a source made broker-only since takes its entries,
    // fact entries included, with it; they are not kept for the retry hour).
    const prior = storedEvidence(deal);
    const stands = makeStands({ documents: args.documents, view: args.view, sessionIds: args.sessions.map((s) => s.id), legacy: !!prior && (prior.version ?? 1) < 2 });
    const failed: OnFileEvidence = prior
      ? { ...prior, entries: Object.fromEntries(Object.entries(prior.entries).filter(([, e]) => stands(e))), failedAt: new Date().toISOString() } as OnFileEvidence
      : { version: EVIDENCE_VERSION, fingerprint, computedAt: new Date().toISOString(), status: "failed", checked: [], entries: {} };
    await storage.updateDeal(deal.id, { interviewEvidence: failed } as any).catch(() => {});
    return null;
  }
}

/** True when the stored evidence is current for these sources and items. */
export function evidenceCurrent(
  deal: { interviewEvidence?: unknown },
  fingerprint: string,
  targets: EvidenceTarget[],
): boolean {
  const e = deal.interviewEvidence as (OnFileEvidence & { failedAt?: string }) | null | undefined;
  if (!e) return false;
  if (e.status === "failed" || e.failedAt) {
    // Retried at most hourly.
    const at = new Date(e.failedAt ?? e.computedAt).getTime();
    if (Date.now() - at < 60 * 60 * 1000) return true;
    return false;
  }
  if (e.version !== EVIDENCE_VERSION || e.fingerprint !== fingerprint) return false;
  const checked = new Set(e.checked ?? []);
  // New open items (a rebuilt checklist, a broker-added item, a new risk) are checked too.
  return targets.slice(0, MAX_TARGETS).every((t) => checked.has(t.id));
}

/**
 * Starts a build in the background when the stored evidence isn't current.
 * Returns the running promise (callers usually don't wait), or null.
 */
export function ensureOnFileEvidence(
  deal: Pick<Deal, "id" | "extractedInfo"> & { interviewEvidence?: unknown },
  args: { documents: DocLike[]; sessions: SessionLike[]; currentSessionId?: string | null; view: Record<string, unknown>; targets: EvidenceTarget[] },
): Promise<OnFileEvidence | null> | null {
  if (args.targets.length === 0) return null;
  if (!args.documents.some(readable) && sessionsInOrder(args.sessions, args.currentSessionId).length === 0) return null;
  const running = inflight.get(deal.id);
  if (running) return running;
  const fingerprint = evidenceFingerprint(args.documents, args.sessions, args.currentSessionId);
  if (evidenceCurrent(deal, fingerprint, args.targets)) return null;
  // Only new items (same sources): not more often than MIN_REBUILD_MS.
  const stored = storedEvidence(deal);
  if (stored && stored.fingerprint === fingerprint && Date.now() - (lastStart.get(deal.id) ?? 0) < MIN_REBUILD_MS) return null;
  lastStart.set(deal.id, Date.now());
  const task = computeOnFileEvidence(deal, args).finally(() => {
    inflight.delete(deal.id);
    inflightTiming.delete(deal.id);
  });
  inflight.set(deal.id, task);
  const previous = (deal.interviewEvidence as OnFileEvidence | null | undefined)?.buildMs;
  inflightTiming.set(deal.id, { startedAt: Date.now(), expectedMs: typeof previous === "number" && previous > 0 ? previous : DEFAULT_BUILD_MS });
  return task;
}

/** True while a build for this deal is running. */
export function isEvidenceBuilding(dealId: string): boolean {
  return inflight.has(dealId);
}

/**
 * How long the running build is still expected to take (ms; 0 when it is
 * due now), or null when none is running. A session opening waits for a
 * build only when it is about to land.
 */
export function evidenceBuildRemainingMs(dealId: string, now = Date.now()): number | null {
  const t = inflightTiming.get(dealId);
  if (!t || !inflight.has(dealId)) return null;
  return Math.max(0, t.startedAt + t.expectedMs - now);
}
