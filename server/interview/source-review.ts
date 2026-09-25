/**
 * source-review — the supporting model reads the deal's SELLER-VISIBLE
 * sources side by side and lists the facts they disagree on, so the
 * interview can reconcile them with the seller.
 *
 * The mechanical checks (source-context.ts) only see two values stored under
 * the same fact key. The conflicts that matter most rarely line up that
 * neatly: "backlog $4.2M" said on a call vs "$3.1M signed" in the WIP report,
 * "Seton breaks even" vs a location P&L showing a loss, "Maplecrest is about
 * a quarter" vs 41% in the customer report. This pass finds those.
 *
 * Privacy: the input is built from the interview's own view of the facts
 * (sellerInterviewView — nothing a broker-only source asserted) and from
 * seller-visible documents only, so nothing it returns can quote the
 * broker's CRM notes or private files. Every figure in a returned value must
 * appear in that input, or the conflict is dropped (no invented numbers).
 *
 * Built in the background (Sonnet, tool-forced) and stored on
 * deals.interview_source_review, keyed to a fingerprint of the sources; it is
 * rebuilt when a source is added, removed or re-read.
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "crypto";
import { storage } from "../storage";
import { agentConfig } from "./config/load-config";
import type { Deal, Document } from "@shared/schema";
import { sellerInterviewView } from "./seller-view";
import {
  getFieldSources,
  getFieldAlternates,
  isFactKey,
  repairCharIndexedValue,
} from "./info-merger";
import { sourceLabel, CRITICAL_CONFLICT_RE, headlineNumber, valuesMateriallyDiffer, differentMeasure, dealAsOfYear, type SourceConflict } from "./source-context";

type DocLike = Pick<Document, "id" | "name" | "visibility"> &
  Partial<Pick<Document, "sourceKind" | "sourceMeta" | "createdAt" | "extractedData" | "extractedText" | "isProcessed" | "updatedAt">>;

export interface SourceReview {
  fingerprint: string;
  computedAt: string;
  status: "ready" | "failed";
  conflicts: SourceConflict[];
}

const LEAD_KINDS = new Set(["crm", "website", "social"]);
/** The seller speaking or writing (not a document). */
const SAID_KINDS = new Set(["interview", "call", "video_call", "email", "questionnaire"]);
const reviewable = (d: DocLike) =>
  d.visibility !== "broker_only" && !LEAD_KINDS.has(String(d.sourceKind)) && !!d.extractedData;

/** Version of the review's input and validation rules (2: the seller's own words in full; adjusted/reported, older periods and inferred values dropped). */
const REVIEW_VERSION = 2;

/** Fingerprint of the sources the review reads — changes when one is added, removed or re-read. */
export function sourcesFingerprint(documents: DocLike[]): string {
  const parts = documents
    .filter(reviewable)
    .map((d) => `${d.id}:${typeof d.extractedText === "string" ? d.extractedText.length : 0}:${JSON.stringify(d.extractedData ?? null).length}`)
    .sort();
  // The review's rules are part of the key: a review built under older
  // validation (it let adjusted-vs-reported EBITDA through) is rebuilt.
  return createHash("sha1").update(`${REVIEW_VERSION}|${parts.join("|")}`).digest("hex").slice(0, 16);
}

/** The stored review's conflicts (whatever its age — a stale one is rebuilt in the background). */
export function reviewConflictsForDeal(deal: Pick<Deal, "id"> & { interviewSourceReview?: unknown }, _documents: DocLike[]): SourceConflict[] {
  const review = deal.interviewSourceReview as SourceReview | null | undefined;
  if (!review || review.status !== "ready" || !Array.isArray(review.conflicts)) return [];
  return review.conflicts.map((c) => ({ ...c, origin: "review" as const }));
}

const REVIEW_TOOL = {
  name: "source_conflicts",
  description: "List the facts on which the deal's sources materially disagree.",
  input_schema: {
    type: "object" as const,
    required: ["conflicts"],
    properties: {
      conflicts: {
        type: "array",
        items: {
          type: "object",
          required: ["key", "topic", "a", "b", "critical"],
          properties: {
            key: { type: "string", description: "The FACT KEY this is about — reuse an existing key from the facts list when one fits, else a short camelCase key (e.g. signedBacklog, setonLocationProfit)." },
            topic: { type: "string", description: "Plain words, 3–8 words: what the two sources disagree about." },
            a: {
              type: "object", required: ["value", "source"],
              properties: {
                value: { type: "string", description: "What the first source says, in its own words/figures (short)." },
                source: { type: "string", description: "The first source's label exactly as given in the input (e.g. 'said on a call (Mar 3, 2026)', 'document: WIP report.xlsx')." },
              },
            },
            b: {
              type: "object", required: ["value", "source"],
              properties: {
                value: { type: "string" },
                source: { type: "string" },
              },
            },
            critical: { type: "boolean", description: "True for revenue, earnings/SDE/EBITDA, owner pay, customer concentration, lease term or expiry, key-employee tenure, headcount, backlog, debt." },
          },
        },
      },
    },
  },
};

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const REVIEW_SYSTEM = [
  "You check a business-sale file for places where its sources disagree, so an interviewer can ask the seller which is right.",
  "Compare what the seller SAID (interview, calls, emails, the intake) with what the documents WRITE. List only MATERIAL conflicts about the same fact: different figures (more than ~3% apart), dates, counts, names or yes/no answers — e.g. a figure the owner said on a call vs the document that shows another; a claim the owner made ('breaks even', 'no customer over about a quarter', 'the lease runs to 2034') that a document's figures contradict. Look for those claims in the call and email summaries as well as the facts list.",
  "Do NOT list: values for different fiscal years or periods, or an older document vs a newer one where the business changed in between (a cleanroom expanded in 2023); rounding; a total vs a subset when both are labelled (all staff vs drivers); reported vs adjusted figures (adjusted EBITDA vs reported EBITDA are different measures — never a conflict); the same fact worded differently; anything you would have to calculate, estimate or infer (never derive a headcount from payroll, benefits or 401(k) figures). Each side must be a figure or statement that source literally makes. At most 6, most important first. Quote each side briefly in its own figures, with its source label exactly as given. If nothing conflicts, return an empty list.",
].join(" ");
const inflight = new Map<string, Promise<SourceReview | null>>();

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const numbersIn = (s: string) => (s.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((n) => n.replace(/,/g, "").replace(/\.0+$/, ""));

/**
 * The figures a text states, scaled — "$3.1M", "$3,100,000" and "3,100K" are
 * the same figure; so are "41%" and "41.0%". Spelled amounts in a transcript
 * ("four-point-two million") count too.
 */
function scaledFigures(text: string): number[] {
  const out: number[] = [];
  const t = text
    .replace(/\b(one|two|three|four|five|six|seven|eight|nine)[- ]point[- ](one|two|three|four|five|six|seven|eight|nine|zero)\b/gi, (_m, a: string, b: string) => `${WORD_DIGITS[a.toLowerCase()]}.${WORD_DIGITS[b.toLowerCase()]}`);
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|million|thousand|b|billion)?(?![a-z])/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    const suf = (m[2] || "").toLowerCase();
    const mult: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
    out.push(n);
    if (suf) out.push(n * (mult[suf] ?? 1));
  }
  return out;
}
/** Words in a value that say nothing about what it measures. */
const VALUE_NOISE = new Set(["about", "approximately", "around", "roughly", "total", "totals", "plus", "with", "from", "said", "year", "years", "annual", "current", "currently", "only", "over", "under", "more", "less", "than", "each", "per", "including", "after", "before", "since"]);
const WORD_DIGITS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
/** Every figure in `value` appears in `source` (as written or scaled: $3.1M ≈ $3,100,000). */
function figuresPresent(value: string, source: string): boolean {
  const have = scaledFigures(source);
  const want = scaledFigures(value);
  // One figure per number in the value: its scaled form if it has a suffix, else as written.
  const nums = value.match(/(\d[\d,]*(?:\.\d+)?)\s*(k|m|mm|million|thousand|b|billion)?(?![a-z])/gi) ?? [];
  return nums.every((raw) => {
    const [n] = scaledFigures(raw).slice(-1);
    if (n === undefined) return true;
    return have.some((h) => Math.abs(h - n) <= Math.max(1e-9, Math.abs(n) * 0.005)) || want.length === 0;
  });
}

/** The review's input: seller-visible sources and the interview's view of the facts. */
export function buildReviewInput(deal: Pick<Deal, "extractedInfo">, documents: DocLike[]): string {
  const docs = new Map(documents.map((d) => [d.id, d]));
  const view = sellerInterviewView(((deal.extractedInfo as Record<string, unknown>) || {}), documents);
  const sources = getFieldSources(view);
  const alternates = getFieldAlternates(view);
  // What the seller SAID (interview, calls, emails, the intake) — each with
  // what a document wrote for the same fact. Values the broker set are
  // settled and left out; document-only facts are in the source digests.
  const factLines: string[] = [];
  for (const [key, raw] of Object.entries(view)) {
    if (!isFactKey(key)) continue;
    const v = repairCharIndexedValue(raw);
    if (v === null || v === undefined || v === "") continue;
    const src = sources[key];
    const kind = String(src?.source ?? "");
    const said = SAID_KINDS.has(kind);
    const alts = (alternates[key] ?? []).filter((a) => a && !LEAD_KINDS.has(String(a.source)) && a.source !== "broker");
    const saidAlts = alts.filter((a) => SAID_KINDS.has(String(a.source)));
    if (!said && saidAlts.length === 0) continue;
    if (kind === "broker") continue;
    const text = typeof v === "string" ? v : JSON.stringify(v);
    factLines.push(`- ${key}: ${clip(text.replace(/\s+/g, " "), 180)} [${sourceLabel(src, docs)}]`);
    for (const alt of alts.slice(0, 4)) {
      factLines.push(`    other value: ${clip(String(alt.value).replace(/\s+/g, " "), 160)} [${sourceLabel(alt, docs)}]`);
    }
    if (factLines.length > 220) break;
  }
  const docLines: string[] = [];
  // The seller's own words in full (calls, video calls, emails — capped): a
  // claim like "no one operator is more than about a quarter" often never
  // makes it into the extracted facts or the summary.
  let transcriptBudget = TRANSCRIPT_BUDGET;
  for (const d of documents) {
    if (!reviewable(d)) continue;
    const data = (d.extractedData as Record<string, unknown>) || {};
    const kind = String(d.sourceKind || "document");
    const label = kind === "document" ? `document: ${d.name}` : sourceLabel({ source: kind as never, documentId: d.id }, docs);
    const bits = ["summary", "keyFacts", "redFlags", "sellerConcerns"]
      .map((k) => (typeof data[k] === "string" && (data[k] as string).trim() ? `${k}: ${clip((data[k] as string).replace(/\s+/g, " "), 500)}` : ""))
      .filter(Boolean);
    if (SAID_KINDS.has(kind) && typeof d.extractedText === "string" && d.extractedText.trim() && transcriptBudget > 0) {
      const text = clip(d.extractedText.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim(), Math.min(TRANSCRIPT_PER_SOURCE, transcriptBudget));
      transcriptBudget -= text.length;
      bits.push(`full text:\n${text}`);
    }
    // The label alone on the header line (a title can hold parentheses of its own).
    if (bits.length) docLines.push(`### ${label}\nsource title: ${d.name}\n${bits.join("\n")}`);
  }
  return `WHAT THE SELLER SAID, WITH OTHER VALUES ON FILE (key: value [source]):\n${factLines.join("\n") || "(none)"}\n\nSOURCES (calls and emails are what was said; documents are what is written):\n${docLines.join("\n\n") || "(none)"}`;
}

/** Transcript text sent to the review: per source, and in total (≈ 15K tokens). */
const TRANSCRIPT_PER_SOURCE = 16_000;
const TRANSCRIPT_BUDGET = 60_000;

/** A value the model reasoned its way to rather than quoted ("suggest ~100 employees based on typical…", "implied by the 401(k) match"). */
const INFERENCE_RE = /\b(suggest|suggests|suggesting|implies|imply|implied|inferred|infer|indicat\w*|based on|typical(?:ly)?|would (?:be|mean|indicate)|likely|presumably|estimated|estimate from|works out to|back(?:ed)? into|calculated|computed|derived|equates? to|translates? to)\b/i;
/** Words that make a figure-less side a checkable claim ("breaks even", "no customer over 20%"). */
const CLAIM_RE = /\b(break(?:s)? even|pays? (?:its|it'?s) own way|profitable|loss|no (?:one|customer|single)|none|never|all|every|majority|most|under|over|less than|more than|about (?:a|one) (?:quarter|third|half)|half|quarter|third|doubled|tripled|flat|growing|declin\w*)\b/i;

/** The input text each source label stands for (its document block, or its fact lines). */
function textBySource(input: string): Map<string, string> {
  const out = new Map<string, string>();
  const add = (label: string, text: string) => {
    const k = label.trim().toLowerCase();
    out.set(k, `${out.get(k) ?? ""}\n${text}`);
  };
  for (const line of input.split("\n")) {
    const m = line.match(/\[([^\]]+)\]\s*$/);
    if (m) add(m[1], line);
  }
  for (const block of input.split(/\n(?=### )/)) {
    const m = block.match(/^### (.+)$/m);
    if (m) add(m[1], block);
  }
  return out;
}

/**
 * Validates the model's conflicts against the input: both sides present and
 * different; each side quotes its OWN source (every figure in the value is in
 * that source's text) rather than reasoning its way to a number; sources are
 * distinct; the two sides aren't simply different years. Pure.
 */
export function validateReviewConflicts(raw: unknown, input: string, asOf?: number): SourceConflict[] {
  const list = Array.isArray(raw) ? raw : [];
  const bySource = textBySource(input);
  const quotes = (side: { value: string; source: string }) => {
    if (INFERENCE_RE.test(side.value)) return false;
    const nums = numbersIn(side.value);
    const own = bySource.get(side.source.trim().toLowerCase().replace(/…$/, "")) ??
      Array.from(bySource.entries()).find(([k]) => k.startsWith(side.source.trim().toLowerCase().replace(/…$/, "")))?.[1];
    // Fail closed: a side whose source can't be found in the input can't be
    // checked (a figure present anywhere else in the file proves nothing).
    if (!own) return false;
    const ownNumbers = numbersIn(own);
    return nums.every((n) => ownNumbers.includes(n)) || figuresPresent(side.value, own);
  };
  // ("FY2022" names 2022; a figure's digits are not a year.)
  const years = (s: string): string[] => s.match(/(?<![\d$,.])(?:19|20)\d{2}(?![\d,])/g) ?? [];
  // The period a side speaks to: years in its value, else in its document's
  // title ("tax year 2023"). A call or email with no year in the value speaks
  // to when it was said (its date) — "as of" that year.
  const period = (side: { value: string; source: string }) => {
    const own = years(side.value);
    return own.length > 0 ? own : /^document:/i.test(side.source.trim()) ? years(side.source) : [];
  };

  const out: SourceConflict[] = [];
  for (const c of list) {
    if (!c || typeof c !== "object") continue;
    const r = c as Record<string, any>;
    const a = r.a && typeof r.a.value === "string" && typeof r.a.source === "string" ? r.a : null;
    const b = r.b && typeof r.b.value === "string" && typeof r.b.source === "string" ? r.b : null;
    if (!a || !b || typeof r.key !== "string" || !r.key.trim()) continue;
    if (a.value.trim().toLowerCase() === b.value.trim().toLowerCase()) continue;
    if (a.source.trim().toLowerCase() === b.source.trim().toLowerCase()) continue;
    if (!quotes(a) || !quotes(b)) continue;
    // The broker's value is settled — never something to reconcile with the seller.
    if (/^the broker$/i.test(a.source.trim()) || /^the broker$/i.test(b.source.trim())) continue;
    // Said vs WRITTEN only: exactly one side is a document (two things the
    // seller said are handled as the interview goes).
    if (/^document:/i.test(a.source.trim()) === /^document:/i.test(b.source.trim())) continue;
    // Both sides about the fact named: a side with words shares one with the
    // key or with the other side ("42 total" employees vs "140+ customers
    // invoiced" is two different counts).
    const topicWords = (t: string) => new Set((t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !VALUE_NOISE.has(w)).map((w) => w.slice(0, 5)));
    const kw = topicWords(r.key);
    const aw = topicWords(a.value);
    const bw = topicWords(b.value);
    const relates = (x: Set<string>, y: Set<string>) => x.size < 2 || Array.from(x).some((w) => kw.has(w) || y.has(w));
    if (!relates(aw, bw) || !relates(bw, aw)) continue;
    // The same figure on both sides is agreement, not a conflict ("$1,398,000" vs "$1,398,000 (2024)").
    const na = numbersIn(a.value).filter((n) => !/^(?:19|20)\d{2}$/.test(n));
    const nb = numbersIn(b.value).filter((n) => !/^(?:19|20)\d{2}$/.test(n));
    if (na.some((n) => nb.includes(n))) continue;
    // A total vs a labelled subset ("36 employees" vs "28 licensed field
    // technicians, managers, apprentices") — both sides describe different things.
    if (a.value.length <= 110 && b.value.length <= 110 && headlineNumber(a.value) && headlineNumber(b.value) && !valuesMateriallyDiffer(r.key, a.value, b.value)) continue;
    // Rounding ("16 years" vs "15.9 years tenure") is agreement too.
    const ha = headlineNumber(a.value);
    const hb = headlineNumber(b.value);
    if (ha && hb && ha.percent === hb.percent && Math.abs(ha.value - hb.value) / Math.max(Math.abs(ha.value), Math.abs(hb.value), 1e-9) <= 0.04) continue;
    // A side with no figure must at least make a checkable claim.
    if ((na.length === 0) !== (nb.length === 0) && !CLAIM_RE.test(na.length === 0 ? a.value : b.value)) continue;
    // Different periods (a 2023 return vs a 2024 figure) are two facts, not a conflict.
    const ya = period(a);
    const yb = period(b);
    if (ya.length > 0 && yb.length > 0 && !ya.some((y) => yb.includes(y))) continue;
    // A period older than the deal's latest statements vs a figure said
    // now ("38 presses" on a call vs 34 in the FY2022 statements; total debt
    // in an email vs the 2023 return when FY2024 is on file): the business
    // changed in between — reconcile against the latest year only.
    const stale = (dated: string[], otherYears: string[]) =>
      dated.length > 0 && otherYears.length === 0 && asOf !== undefined && Math.max(...dated.map(Number)) < asOf;
    if (stale(ya, yb) || stale(yb, ya)) continue;
    // Adjusted vs reported (EBITDA), gross vs net, year-to-date vs a full
    // year: different measures of the same thing, not a conflict.
    if (differentMeasure(`${r.key} ${a.value} ${a.source}`, `${r.key} ${b.value} ${b.source}`)) continue;
    const key = r.key.replace(/[^A-Za-z0-9]/g, "").replace(/^[A-Z]/, (x: string) => x.toLowerCase()).slice(0, 48);
    if (!key) continue;
    out.push({
      key,
      topic: typeof r.topic === "string" && r.topic.trim() ? clip(r.topic.trim(), 80) : key,
      values: [
        { value: clip(a.value.trim(), 160), source: clip(a.source.trim(), 90) },
        { value: clip(b.value.trim(), 160), source: clip(b.source.trim(), 90) },
      ],
      critical: r.critical === true || CRITICAL_CONFLICT_RE.test(key),
      origin: "review",
    });
  }
  return out.slice(0, 8);
}

/** The supporting model's raw list of conflicts for a review input (unvalidated). */
export async function reviewModelConflicts(input: string): Promise<unknown> {
  const response = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 4000,
    temperature: 0,
    tools: [REVIEW_TOOL],
    tool_choice: { type: "tool", name: "source_conflicts" },
    system: REVIEW_SYSTEM,
    messages: [{ role: "user", content: input }],
  });
  const block = response.content.find((b) => b.type === "tool_use");
  return ((block && block.type === "tool_use" ? block.input : {}) as { conflicts?: unknown }).conflicts;
}

async function computeSourceReview(deal: Deal, documents: DocLike[], fingerprint: string): Promise<SourceReview | null> {
  const input = buildReviewInput(deal, documents);
  try {
    const conflicts = validateReviewConflicts(await reviewModelConflicts(input), input, dealAsOfYear(documents));
    const review: SourceReview = { fingerprint, computedAt: new Date().toISOString(), status: "ready", conflicts };
    await storage.updateDeal(deal.id, { interviewSourceReview: review } as any);
    console.log(`[source-review] ${conflicts.length} source conflict(s) for deal ${deal.id}`);
    return review;
  } catch (err: any) {
    console.warn(`[source-review] failed for deal ${deal.id}:`, err?.message || err);
    const failed: SourceReview = { fingerprint, computedAt: new Date().toISOString(), status: "failed", conflicts: [] };
    await storage.updateDeal(deal.id, { interviewSourceReview: failed } as any).catch(() => {});
    return null;
  }
}

/**
 * Starts a review in the background when the deal has none for its current
 * sources. A failed review is retried at most hourly. Returns the running
 * promise (callers usually don't wait).
 */
export function ensureSourceReview(deal: Deal, documents: DocLike[]): Promise<SourceReview | null> | null {
  if (!documents.some(reviewable)) return null;
  const fingerprint = sourcesFingerprint(documents);
  const stored = (deal as Deal & { interviewSourceReview?: SourceReview | null }).interviewSourceReview;
  if (stored?.fingerprint === fingerprint) {
    if (stored.status === "ready") return null;
    if (Date.now() - new Date(stored.computedAt).getTime() < 60 * 60 * 1000) return null;
  }
  const running = inflight.get(deal.id);
  if (running) return running;
  const task = computeSourceReview(deal, documents, fingerprint).finally(() => inflight.delete(deal.id));
  inflight.set(deal.id, task);
  return task;
}
