/**
 * live-claims — a figure or claim the seller volunteers THIS turn, checked
 * against the file while the interviewer drafts its reply.
 *
 * The conflict checks that run before a turn only compare sources already
 * on file, and the mechanical spoken-figure check (source-context.ts) skips
 * percentages and anything not worded like the document. So a seller saying
 * "we run about 1.8% scrap" (quality summary: 2.9% in 2024), "450 molds on
 * the racks are customer-owned" (customer list: about 1,150) or "twenty-six
 * trucks on the road" (fleet list: 24 service vans + 2 owner vehicles) went
 * unprobed and the next question moved on (QA round V).
 *
 * Here the supporting model reads the seller's message next to the parts of
 * the file it touches — facts, on-file items, source passages, settled
 * values — and reports only the same measure stated differently. Every
 * figure it reports must appear where it says; seller-visible material
 * only (the facts are the interview's view; broker-only sources are never
 * searched). Started when the turn starts, in parallel with the interview
 * call, so it usually costs the seller no time; the re-ask gate raises any
 * conflict the draft doesn't (reaskCorrection puts it first).
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Document } from "@shared/schema";
import { agentConfig } from "./config/load-config";
import { getFieldSources, isFactKey, repairCharIndexedValue } from "./info-merger";
import { QUESTION_STOP, searchWord, sourceLabel } from "./source-context";
import type { OnFileFact, ReaskFinding } from "./reask-guard";
import { NUMBER_RE } from "./on-file-evidence";

type DocLike = Pick<Document, "id" | "name" | "visibility"> &
  Partial<Pick<Document, "sourceKind" | "sourceMeta" | "createdAt" | "extractedData" | "extractedText" | "updatedAt">>;

const LEAD_KINDS = new Set(["crm", "website", "social"]);

const FIGURE_RE = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen|half|third|quarter)\b/i;

/** The sentences of a seller message that state a figure. */
export function claimSentences(message: string): string[] {
  return message
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?;])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 8 && !/\?\s*$/.test(s) && FIGURE_RE.test(s))
    .slice(0, 8);
}

export interface LiveClaimInput {
  sellerMessage: string;
  /** The question the seller is answering (context for what the figures are about). */
  lastQuestion?: string;
  /** The interview's view of the facts. */
  info: Record<string, unknown>;
  onFile?: OnFileFact[];
  documents: DocLike[];
  /** Values the broker settled ("key: value"). */
  settled?: string[];
}

interface Material { id: string; label: string; text: string; key?: string }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// =====================
// What the claims touch in the file
// =====================

/** Words that say nothing about what a figure measures. */
const CLAIM_STOP = new Set(
  ("honestly about around roughly approximately approx maybe probably think guess call just really pretty much every day days week year years " +
    "the and for with that this our ours we're we've we'd have has had got get gets run runs running all per into onto from over under " +
    "there here they them their these those what which who when where would could should will been being also only some any most more less " +
    "said says say told know like well yeah yes okay sure right now today currently current usually typically generally overall total totals " +
    "one two three four five six seven eight nine ten eleven twelve twenty thirty forty fifty sixty seventy eighty ninety hundred thousand million billion half dozen quarter " +
    "percent point plus minus least give take close nearly almost basically kind sort lot lots bit thing things stuff way ways side area part " +
    "business company firm shop place").split(" "),
);
/** Nouns counted or measured the same way ("26 trucks" vs "24 service vans"; "molds" vs "tools"). */
const WORD_FAMILY: Record<string, string> = {
  truck: "vehicle", van: "vehicle", vehicle: "vehicle", tractor: "vehicle", fleet: "vehicle", car: "vehicle", unit: "vehicle",
  employee: "staff", staff: "staff", people: "staff", headcount: "staff", worker: "staff", person: "staff", fte: "staff", team: "staff",
  mold: "mold", mould: "mold", tool: "mold", tooling: "mold",
  customer: "customer", client: "customer", account: "customer",
  location: "location", clinic: "location", store: "location", branch: "location", site: "location",
  technician: "technician", tech: "technician",
  prescription: "prescription", rx: "prescription", script: "prescription",
  revenue: "revenue", sale: "revenue", topline: "revenue", turnover: "revenue",
  scrap: "scrap", regrind: "scrap", reject: "scrap", defect: "scrap",
};
/** A word as the claim retrieval compares it: singular, family-mapped. */
function claimWord(raw: string): string {
  const w = searchWord(raw);
  return WORD_FAMILY[w] ?? w;
}
/** The content words of a text (hyphenated words split: "customer-owned" → customer, owned). */
export function claimWords(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.match(/[A-Za-z][A-Za-z'’]*/g) ?? []) {
    const lower = raw.toLowerCase().replace(/['’]s$/, "");
    if (lower.length < 3 && !/^rx$/i.test(lower)) continue;
    if (CLAIM_STOP.has(lower) || QUESTION_STOP.has(lower)) continue;
    out.add(claimWord(lower));
  }
  return out;
}
const HAS_FIGURE_RE = /\d|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|dozen|half)\b/i;

interface ClaimChunk { docId: string; docName: string; text: string; words: Set<string> }

/** Figure-bearing windows (one or two lines/sentences) of the seller-visible sources. */
export function claimChunks(documents: DocLike[]): ClaimChunk[] {
  const out: ClaimChunk[] = [];
  for (const d of documents) {
    if (d.visibility === "broker_only" || LEAD_KINDS.has(String(d.sourceKind))) continue;
    const text = typeof d.extractedText === "string" ? d.extractedText : "";
    if (!text.trim()) continue;
    const parts = text
      .replace(/\r/g, "")
      .split(/\n+|(?<=[.!?])\s+/)
      .map((x) => x.replace(/\s+/g, " ").trim())
      .filter((x) => x.length > 3);
    for (let i = 0; i < parts.length; i++) {
      // A line and the one after it (a table's label row and its figures, a
      // speaker's sentence and its follow-on).
      const win = [parts[i], parts[i + 1]].filter(Boolean).join(" ").slice(0, 360);
      if (!HAS_FIGURE_RE.test(win)) continue;
      out.push({ docId: d.id, docName: d.name, text: win, words: claimWords(win) });
    }
  }
  return out;
}

/**
 * The source passages a claim is most likely about: figure-bearing windows
 * ranked by the claim's words they share, rarer words counting more (a
 * word few passages use — "scrap", "customer-owned", "trucks" — pins the
 * topic; "business" doesn't). Two shared words, or one rare one. Pure.
 */
export function rankClaimPassages(claim: string, chunks: ClaimChunk[], limit = 3): ClaimChunk[] {
  const want = claimWords(claim);
  if (want.size === 0 || chunks.length === 0) return [];
  const df = new Map<string, number>();
  for (const c of chunks) c.words.forEach((w) => { if (want.has(w)) df.set(w, (df.get(w) ?? 0) + 1); });
  const n = chunks.length;
  const rare = Math.max(3, Math.ceil(n * 0.04));
  const percent = /%|percent/i.test(claim);
  const scored: { c: ClaimChunk; score: number }[] = [];
  for (const c of chunks) {
    let score = 0;
    let shared = 0;
    let rareHit = false;
    want.forEach((w) => {
      if (!c.words.has(w)) return;
      shared++;
      const f = df.get(w) ?? 1;
      score += Math.log(1 + n / f);
      if (f <= rare && w.length >= 4) rareHit = true;
    });
    if (!(rareHit || shared >= 2)) continue;
    if (percent && /%|percent/i.test(c.text)) score += 1;
    scored.push({ c, score });
  }
  scored.sort((a, b) => b.score - a.score);
  // One passage per document first, then the next best.
  const picked: ClaimChunk[] = [];
  const docs = new Set<string>();
  for (const x of scored) {
    if (picked.length >= limit) break;
    if (docs.has(x.c.docId)) continue;
    docs.add(x.c.docId);
    picked.push(x.c);
  }
  for (const x of scored) {
    if (picked.length >= limit) break;
    if (!picked.includes(x.c)) picked.push(x.c);
  }
  return picked;
}

/** Money facts a spoken money figure may be about. */
const MONEY_FACT_RE = /revenue|sales|sde|discretionary|ebitda|netIncome|netProfit|profit|earnings|ownerComp|ownerSalary|ownerPay|ownerBenefit|cashFlow/i;
/**
 * The headline money facts, always offered for a money claim — what an owner
 * means by "the business clears about a million and a half for me" shares no
 * word with "sde: $1,312,000".
 */
const HEADLINE_MONEY_RE = /^(?:sde|sellerDiscretionaryEarnings|ownerBenefit|ownerCashFlow|adjustedEbitda|ebitda|netIncome|annualRevenue|revenue|totalRevenue|ownerCompensation)$/i;
const MONEY_CLAIM_RE = /\$|\b\d[\d,.]*\s*(?:k|m|mm)\b|\b(?:thousand|million|grand|dollars?|bucks)\b/i;

/** The parts of the file the claims touch: facts and on-file items, source passages, settled values. */
export function claimMaterial(input: LiveClaimInput, claims: string[]): Material[] {
  const words = claimWords(`${claims.join(" ")} ${input.lastQuestion ?? ""}`);
  const out: Material[] = [];
  const sources = getFieldSources(input.info);
  const docs = new Map(input.documents.map((d) => [d.id, d]));
  const money = claims.some((c) => MONEY_CLAIM_RE.test(c));
  const facts: { score: number; m: Omit<Material, "id"> }[] = [];
  for (const [key, raw] of Object.entries(input.info)) {
    if (!isFactKey(key) || raw === null || raw === undefined || raw === "") continue;
    const src = sources[key];
    const kind = String(src?.source ?? "");
    // Leads aren't facts; the broker's own values are never quoted back to
    // the seller as a contradiction (they can be the broker's private work).
    if (["crm", "website", "social"].includes(kind) && !src?.acceptedByBroker) continue;
    if (kind === "broker") continue;
    const v = repairCharIndexedValue(raw);
    const text = (typeof v === "string" ? v : JSON.stringify(v)).replace(/\s+/g, " ");
    if (!HAS_FIGURE_RE.test(text)) continue;
    const keyWords = claimWords(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2"));
    const valueWords = claimWords(text.slice(0, 300));
    let s = 0;
    keyWords.forEach((w) => { if (words.has(w)) s += 2; });
    valueWords.forEach((w) => { if (words.has(w) && !keyWords.has(w)) s++; });
    if (money && MONEY_FACT_RE.test(key)) s += 1.5;
    if (money && HEADLINE_MONEY_RE.test(key)) s = Math.max(s, 2.5);
    if (s >= 2) facts.push({ score: s, m: { label: `fact ${key} [${sourceLabel(src, docs)}]`, text: clip(text, 260), key } });
  }
  facts.sort((a, b) => b.score - a.score).slice(0, 8).forEach((f) => out.push({ id: `M${out.length + 1}`, ...f.m }));
  let onFileAdded = 0;
  for (const f of input.onFile ?? []) {
    if (onFileAdded >= 5) break;
    if (!HAS_FIGURE_RE.test(f.answer)) continue;
    const kw = claimWords(`${f.key.replace(/([a-z0-9])([A-Z])/g, "$1 $2")} ${f.label} ${f.answer}`);
    let s = 0;
    kw.forEach((w) => { if (words.has(w)) s++; });
    if (s >= 1 && Array.from(kw).some((w) => words.has(w) && w.length >= 5)) {
      out.push({ id: `M${out.length + 1}`, label: `on file [${f.source}]`, text: clip(`${f.label}: ${f.answer}`, 260), key: f.key });
      onFileAdded++;
    }
  }
  const chunks = claimChunks(input.documents);
  const seen = new Set<string>();
  for (const c of claims) {
    for (const hit of rankClaimPassages(c, chunks, 3)) {
      const k = `${hit.docId}|${hit.text.slice(0, 80)}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ id: `M${out.length + 1}`, label: `passage from "${hit.docName}"`, text: hit.text });
    }
    if (out.length >= 24) break;
  }
  for (const s of (input.settled ?? []).slice(0, 6)) out.push({ id: `M${out.length + 1}`, label: "settled by the broker", text: clip(s, 200) });
  return out;
}

const TOOL = {
  name: "claim_conflicts",
  description: "List the owner's statements the file states differently.",
  input_schema: {
    type: "object" as const,
    required: ["conflicts"],
    properties: {
      conflicts: {
        type: "array",
        items: {
          type: "object",
          required: ["said", "onFile", "materialId", "topic"],
          properties: {
            said: { type: "string", description: "The owner's figure or claim, in their words (short)." },
            onFile: { type: "string", description: "What the file states for the same thing, copied from the material (short)." },
            materialId: { type: "string", description: "The material item it comes from, e.g. M3." },
            topic: { type: "string", description: "3–6 words: what both are about." },
            key: { type: "string", description: "A camelCase fact key for it (the material's key when it has one)." },
          },
        },
      },
    },
  },
};

const SYSTEM = [
  "A business owner just answered an interviewer. Check each figure in the owner's message against the MATERIAL from the deal's file.",
  "Report a conflict only when the material states a figure for the SAME measure — the same thing, the same scope, the same period — that is materially different (more than about 5% apart). Both sides must be figures.",
  "Do report a count that includes items the file lists separately or excludes (the owner's '26 trucks' vs the fleet list's 24 service vans plus 2 owner vehicles; '3,100 members' vs 2,900 active plus 214 suspended) — the document for buyers must state the right one.",
  "Do NOT report: different measures (a total vs a labelled subset, gross vs net, adjusted vs reported, a rate vs an amount, one segment vs the whole), different years or periods (an older year vs 'now' is a change, not a conflict), rounding or an approximate figure within about 5%, anything you would have to calculate or infer, or what the owner is only estimating about the future. When in doubt, leave it out. At most 2.",
].join(" ");

let client: Anthropic | null = null;

/** The model's raw conflicts (unvalidated). Exported for tests to replace. */
export type LiveClaimModel = (message: string, lastQuestion: string, material: Material[], timeoutMs: number) => Promise<unknown[] | null>;

export const modelLiveClaims: LiveClaimModel = async (message, lastQuestion, material, timeoutMs) => {
  client ??= new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 1 });
  const call = client.messages.create(
    {
      model: agentConfig.models.supportingAgents,
      max_tokens: 700,
      temperature: 0,
      tools: [TOOL],
      tool_choice: { type: "tool", name: "claim_conflicts" },
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: `${lastQuestion ? `THE INTERVIEWER ASKED: ${lastQuestion}\n\n` : ""}THE OWNER SAID: ${message}\n\nMATERIAL FROM THE FILE:\n${material.map((m) => `[${m.id}] ${m.label}: ${m.text}`).join("\n")}`,
        },
      ],
    },
    { timeout: timeoutMs },
  );
  call.catch(() => {});
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs));
  try {
    const res = await Promise.race([call, timeout]);
    if (!res) {
      console.warn("[live-claims] timed out — nothing checked");
      return null;
    }
    const block = res.content.find((b) => b.type === "tool_use");
    const list = ((block && block.type === "tool_use" ? block.input : {}) as { conflicts?: unknown }).conflicts;
    return Array.isArray(list) ? list : [];
  } catch (err: any) {
    console.warn("[live-claims] failed — nothing checked:", err?.message || err);
    return null;
  }
};

const SPELLED: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90, hundred: 100 };
/** Numbers a text states, digits or spelled ("twenty-six" → 26, "a million and a half" → 1.5 million scaled). */
export function statedNumbers(text: string): number[] {
  const out: number[] = [];
  const re = new RegExp(NUMBER_RE.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const n = parseFloat(m[1].replace(/,/g, ""));
    if (Number.isNaN(n)) continue;
    out.push(n);
    const suf = (m[2] || "").toLowerCase();
    const mult: Record<string, number> = { k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, billion: 1e9 };
    if (suf && mult[suf]) out.push(n * mult[suf]);
  }
  const sp = /\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[- ](one|two|three|four|five|six|seven|eight|nine)\b|\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/gi;
  while ((m = sp.exec(text)) !== null) {
    out.push(m[1] ? SPELLED[m[1].toLowerCase()] + SPELLED[m[2].toLowerCase()] : SPELLED[m[3].toLowerCase()]);
  }
  if (/\ba million and a half\b|\bmillion and a half\b/i.test(text)) out.push(1.5e6);
  return out;
}

/** Every figure in `value` is among `pool` (±0.5%); a year is exempt (a table's header names it). */
function figuresIn(value: string, pool: number[]): boolean {
  const want = statedNumbers(value);
  if (want.length === 0) return true;
  const raw = (value.match(new RegExp(NUMBER_RE.source, "gi")) ?? []).filter((r) => !/^(?:19|20)\d{2}$/.test(r.trim()));
  if (raw.length === 0 && want.every((n) => n >= 1900 && n <= 2099)) return true;
  const targets = raw.length > 0 ? raw.map((r) => statedNumbers(r).slice(-1)[0]).filter((n): n is number => n !== undefined) : want;
  return targets.every((n) => pool.some((h) => Math.abs(h - n) <= Math.max(1e-9, Math.abs(n) * 0.005)));
}

/** What kind of figure a text states: a share, money, or a count. */
export function figureKind(text: string): "percent" | "money" | "count" {
  if (/%|\bpercent\b|\bper ?cent\b/i.test(text)) return "percent";
  if (/\$|\bdollars?\b|\b\d[\d,.]*\s*(?:k|m|mm)\b/i.test(text)) return "money";
  return "count";
}

/**
 * Validates the model's conflicts: the material item exists, the file's
 * side quotes it (its figures are in that item), the owner's side is in the
 * message, and the two sides differ. Pure.
 */
export function validateLiveClaims(raw: unknown[], message: string, material: Material[]): ReaskFinding[] {
  const byId = new Map(material.map((m) => [m.id, m]));
  const out: ReaskFinding[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const x = r as Record<string, unknown>;
    const said = typeof x.said === "string" ? x.said.trim() : "";
    const onFile = typeof x.onFile === "string" ? x.onFile.trim() : "";
    const m = byId.get(String(x.materialId ?? "").replace(/^\[|\]$/g, "").trim().toUpperCase());
    if (!said || !onFile || !m) continue;
    if (said.toLowerCase() === onFile.toLowerCase()) continue;
    if (!figuresIn(onFile, statedNumbers(m.text))) continue;
    if (!figuresIn(said, statedNumbers(message))) continue;
    // Figures on both sides, of the same kind (a share vs a share, money vs
    // money, a count vs a count) — a figure against a sentence ("$30–40K a
    // year from our own molds" vs "nearly all molds are customer-owned") is
    // two different things. (Narrative claims are the pre-turn review's job.)
    const nonYear = (t: string) => statedNumbers(t).filter((n) => !(n >= 1900 && n <= 2099 && Number.isInteger(n)));
    const a = nonYear(said);
    const b = nonYear(onFile);
    if (a.length === 0 || b.length === 0) continue;
    if (figureKind(said) !== figureKind(onFile)) continue;
    // A figure both sides share is agreement ("$5 million revolver" vs "$5,000,000 revolving line").
    if (a.some((n) => b.some((k) => Math.abs(n - k) <= Math.max(1e-9, Math.abs(n) * 0.04)))) continue;
    const key = (typeof x.key === "string" && x.key.trim() ? x.key.trim() : m.key ?? String(x.topic ?? "figure"))
      .replace(/[^A-Za-z0-9]/g, "").replace(/^[A-Z]/, (c) => c.toLowerCase()).slice(0, 48) || "figure";
    out.push({
      kind: "conflict",
      detail: `${key}: the seller just said "${clip(said, 140)}", but ${m.label} states "${clip(onFile, 160)}"`,
      key,
      onFileValue: onFile,
    });
    if (out.length >= 2) break;
  }
  return out;
}

/** Runs the live claim check for one seller message; [] when there is nothing to check or no verdict in time. */
export async function checkLiveClaims(input: LiveClaimInput, opts: { timeoutMs?: number; model?: LiveClaimModel } = {}): Promise<ReaskFinding[]> {
  const claims = claimSentences(input.sellerMessage);
  if (claims.length === 0) return [];
  const material = claimMaterial(input, claims);
  if (material.length === 0) return [];
  const raw = await (opts.model ?? modelLiveClaims)(input.sellerMessage, input.lastQuestion ?? "", material, opts.timeoutMs ?? 20_000);
  if (!raw) return [];
  const found = validateLiveClaims(raw, input.sellerMessage, material);
  if (found.length > 0) console.log(`[live-claims] ${found.map((f) => f.detail.slice(0, 120)).join(" | ")}`);
  return found;
}
