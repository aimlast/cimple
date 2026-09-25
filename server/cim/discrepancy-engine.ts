/**
 * Discrepancy Verification Engine
 *
 * Cross-references what the seller said (interview, calls, emails, the intake
 * questionnaire) against what the documents show, to find inconsistencies
 * that must be resolved before CIM generation.
 *
 * Example: "You mentioned revenue of $2M but your P&L shows $1.7M"
 *
 * The input is built from provenance (buildDiscrepancyInput), not from the
 * merged facts as one blob:
 *  - CLAIMS are values a seller-side source asserted (interview, call, video
 *    call, email, questionnaire); EVIDENCE is what a shared document states.
 *    A fact is never compared with the document it came from.
 *  - The values that lost the merge (alternates) are where real conflicts
 *    sit; claim-vs-evidence pairs that differ are handed over as the primary
 *    candidates.
 *  - Each document contributes the passages relevant to the claims, not its
 *    first 3,000 characters.
 *  - Broker-private material (broker-only files, CRM notes) never enters as
 *    a document. A CRM value may still be compared, as a clearly private
 *    side: the row records it in sideSources (brokerOnly) and its text never
 *    names or quotes it, so routing it to the seller's interview stays safe.
 * Every finding then passes a deterministic filter (discrepancy-filter.ts)
 * that drops equal values, missing-document items and adjusted-vs-reported
 * comparisons.
 */
import Anthropic from "@anthropic-ai/sdk";
import {
  isFactKey,
  getFieldSources,
  getFieldAlternates,
  isUntrackedSource,
  serializeFactValue,
  yearSource,
  sourceRowLookup,
  type FieldSource,
} from "../interview/info-merger";
import { agentConfig } from "../interview/config/load-config";
import { GENERIC_FIELD_LABELS } from "../interview/interview-plan";
import { sliceRelevantText } from "../financial/analyzer";
import { filterDiscrepancyItems, isMissingSide, sidesEquivalent, numberTokens, tokensMatch, type NumTok } from "./discrepancy-filter";
import type { DiscrepancySideSources, DiscrepancySideSource } from "@shared/discrepancy-sides";
import { scrubPrivateText } from "./discrepancy-privacy";
import { HEADLINE_MAPS } from "../documents/merge-policy";
import type { SourceKind } from "@shared/schema";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, timeout: 600_000 });

/** The model call — returns the report_discrepancies tool input. Swappable for tests. */
type CheckModel = (system: string, user: string) => Promise<unknown>;
const defaultCheckModel: CheckModel = async (system, user) => {
  const message = await anthropic.messages.create({
    model: agentConfig.models.supportingAgents,
    max_tokens: 8000,
    temperature: 0,
    tools: [DISCREPANCY_TOOL],
    tool_choice: { type: "tool", name: DISCREPANCY_TOOL.name },
    system,
    messages: [{ role: "user", content: user }],
  });
  if (message.stop_reason === "max_tokens") throw new Error("The discrepancy check output was cut off — run it again.");
  const block = message.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("The discrepancy check returned no result — run it again.");
  return block.input;
};
let checkModel: CheckModel = defaultCheckModel;
export function _setCheckModelForTests(fn: CheckModel | null) {
  checkModel = fn ?? defaultCheckModel;
}

export interface DiscrepancyItem {
  field: string;
  /** The real fact key this conflict is about (resolution writes here). */
  factKey: string | null;
  /** Fiscal year for a per-year map fact (revenueByYear). */
  factYear: string | null;
  interviewValue: string;
  documentValue: string;
  documentId: string;
  documentName: string;
  sideSources: DiscrepancySideSources;
  severity: "critical" | "significant" | "minor";
  category: "financial" | "operational" | "legal" | "factual";
  aiExplanation: string;
  suggestedResolution: string;
  /** Id of a previously raised (still open) discrepancy this finding corresponds to. */
  existingId?: string;
}

/** What the checker needs to know about discrepancies already on the deal. */
export interface ExistingDiscrepancy {
  id: string;
  field: string;
  status: string;
  severity: string;
  factKey?: string | null;
  factYear?: string | null;
  interviewValue?: string | null;
  documentValue?: string | null;
  resolvedValue?: string | null;
}

export interface CheckDocument {
  id: string;
  name: string;
  category: string | null;
  extractedText: string | null;
  extractedData: any;
  sourceKind?: string | null;
  visibility?: string | null;
}

const SEVERITIES = new Set(["critical", "significant", "minor"]);
const CATEGORIES = new Set(["financial", "operational", "legal", "factual"]);

export function normalizeDiscrepancyFieldKey(field: string): string {
  return (field || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Deterministic backstop for the model's existingId: the same fact key (and
 * year), the same normalized field key, or a shared meaningful word in the
 * field plus a shared value.
 */
export function isSameDiscrepancy(
  item: { field: string; factKey?: string | null; factYear?: string | null; interviewValue?: string | null; documentValue?: string | null },
  existing: ExistingDiscrepancy,
): boolean {
  if (item.factKey && existing.factKey && item.factKey === existing.factKey && (item.factYear ?? null) === (existing.factYear ?? null)) return true;
  if (normalizeDiscrepancyFieldKey(item.field) === normalizeDiscrepancyFieldKey(existing.field)) return true;
  if (item.factKey && normalizeDiscrepancyFieldKey(item.factKey) === normalizeDiscrepancyFieldKey(existing.field)) return true;
  const norm = (v: string | null | undefined) => {
    if (!v) return "";
    const idx = v.indexOf(" — ");
    return (idx > 0 ? v.slice(0, idx) : v).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  };
  const itemValues = new Set([norm(item.interviewValue), norm(item.documentValue)].filter(Boolean));
  const existingValues = [norm(existing.interviewValue), norm(existing.documentValue), norm(existing.resolvedValue)].filter(Boolean);
  // A headline and its by-year map are one fact (the merge raises "ebitda",
  // the check may say "ebitdaByYear" 2024): the same pair of values is the same conflict.
  const family = (k: string) => HEADLINE_MAPS.find((p) => p.head === k)?.map ?? k;
  if (
    item.factKey && existing.factKey && family(item.factKey) === family(existing.factKey) &&
    (!item.factYear || !existing.factYear || item.factYear === existing.factYear) &&
    existingValues.some((v) => itemValues.has(v))
  ) return true;
  const tokens = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9]+/g, " ").split(" ").filter((t) => t.length >= 3));
  const a = tokens(item.field);
  const b = tokens(existing.field);
  let shared = 0;
  a.forEach((t) => { if (b.has(t)) shared++; });
  if (shared === 0) return false;
  const jaccard = shared / (a.size + b.size - shared);
  return existingValues.some((v) => itemValues.has(v)) || jaccard >= 0.5;
}

// ── Input from provenance ──────────────────────────────────────────────

export type SideClass = "claim" | "evidence" | "private" | "settled" | "skip";

export interface SourceRef {
  ref: string;
  cls: SideClass;
  kind: SourceKind;
  documentId?: string;
  label: string;
}

export interface FactEntry {
  key: string;
  year?: string;
  value: string;
  ref: string;
}

export interface ConflictCandidate {
  factKey: string;
  factYear?: string;
  claim: FactEntry;
  evidence: FactEntry;
  /** conflictScore of the pair — how squarely the document speaks to the claim. */
  score?: number;
}

export interface DiscrepancyInput {
  refs: SourceRef[];
  claims: FactEntry[];
  privateClaims: FactEntry[];
  evidence: FactEntry[];
  settled: FactEntry[];
  candidates: ConflictCandidate[];
  evidenceDocs: CheckDocument[];
  factKeys: string[];
}

const CLAIM_KINDS = new Set(["interview", "questionnaire", "call", "video_call", "email"]);
const KIND_LABEL: Record<string, string> = {
  interview: "Seller interview",
  questionnaire: "Seller questionnaire",
  call: "Call with the seller",
  video_call: "Video call with the seller",
  email: "Email from the seller",
  document: "Document",
  crm: "Broker CRM note",
  broker: "Broker edit",
};

/** A shared document that states facts (not a transcript, email, CRM note or website). */
export function isEvidenceDocument(d: Pick<CheckDocument, "sourceKind" | "visibility" | "category">): boolean {
  const kind = d.sourceKind || "document";
  return kind === "document" && d.visibility !== "broker_only" && d.category !== "transcripts";
}

/** Note on alternates the resolution itself records — not a source's own statement. */
const RESOLUTION_ALTERNATE_NOTE = "Conflicting value (discrepancy)";

const PROMPT_VALUE_MAX = 400;

function valueText(v: unknown): string {
  if (v === null || v === undefined) return "";
  return serializeFactValue(v).replace(/\s+/g, " ").trim();
}

type NumKind = "year" | "pct" | "money" | "duration" | string;
function tokenKind(t: NumTok): NumKind | null {
  if (t.year) return "year";
  if (t.pct) return "pct";
  if (t.raw.includes("$")) return "money";
  if (t.durationYears) return "duration";
  return t.unitWord ? `unit:${t.unitWord}` : null;
}

/**
 * How squarely a document statement speaks to a claim: each quantity in the
 * claim scores 2 when the document states the same kind of quantity (a year,
 * a %, a dollar amount, "technicians") with a different value, 1 when it
 * states the same value. Zero means the document is about something else.
 */
export function conflictScore(claim: string, evidence: string): number {
  const ev = numberTokens(evidence);
  let score = 0;
  for (const t of numberTokens(claim)) {
    const kind = tokenKind(t);
    if (!kind) continue;
    const same = ev.filter((e) => tokenKind(e) === kind);
    if (same.length === 0) continue;
    score += same.some((e) => (kind === "year" ? e.value === t.value : tokensMatch(t, e))) ? 1 : 2;
  }
  return score;
}

/**
 * The claim's shares (%) and counted quantities ("24 technicians") are all
 * contradicted by the document's figures of the same kind.
 * Years and dollar amounts are left out: long statements are full of both.
 */
export function specificConflict(claim: string, evidence: string): boolean {
  const ev = numberTokens(evidence);
  const specific = numberTokens(claim).filter((t) => {
    const kind = tokenKind(t);
    return !!kind && (kind === "pct" || kind.startsWith("unit:")) && ev.some((e) => tokenKind(e) === kind);
  });
  // Every such figure disagrees — one that agrees means the two statements
  // are about the same thing and say it the same way.
  return specific.length > 0 && specific.every((t) => !ev.some((e) => tokenKind(e) === tokenKind(t) && tokensMatch(t, e)));
}

/**
 * The part of a long document statement that speaks to the claim — a window
 * around its first quantity of the same kind — so the model sees "to June
 * 30, 2029" rather than the first 200 characters of the lease summary.
 */
export function focusSnippet(claim: string, evidence: string, max = 220): string {
  const flat = evidence.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const kinds = new Set(numberTokens(claim).map(tokenKind).filter(Boolean));
  const hit = numberTokens(flat).find((e) => kinds.has(tokenKind(e)));
  const at = hit ? flat.toLowerCase().indexOf(hit.raw.toLowerCase()) : -1;
  if (at < 0) return `${flat.slice(0, max)}…`;
  const start = Math.max(0, at - Math.floor(max / 2));
  const end = Math.min(flat.length, start + max);
  return `${start > 0 ? "…" : ""}${flat.slice(start, end)}${end < flat.length ? "…" : ""}`;
}

export function buildDiscrepancyInput(info: Record<string, unknown>, documents: CheckDocument[]): DiscrepancyInput {
  const docs = new Map(documents.map((d) => [d.id, d]));
  const sources = getFieldSources(info);
  const alternates = getFieldAlternates(info);
  // Per-year entries are full FieldSources (or bare ids on older rows) —
  // always read them through yearSource, which resolves both.
  const lookup = sourceRowLookup(documents);
  const refs: SourceRef[] = [];
  const refByOrigin = new Map<string, SourceRef>();

  const refFor = (src: Partial<FieldSource> | null | undefined): SourceRef => {
    const doc = src?.documentId ? docs.get(src.documentId) : undefined;
    let cls: SideClass;
    let kind: SourceKind;
    if (isUntrackedSource(src)) {
      // Recorded before sources were tracked — almost always the seller's own answer.
      cls = "claim";
      kind = "interview";
    } else {
      kind = src!.source as SourceKind;
      if ((doc && doc.visibility === "broker_only") || src!.brokerOnly || kind === "crm") cls = "private";
      else if (kind === "broker") cls = "settled";
      else if (CLAIM_KINDS.has(kind)) cls = "claim";
      else if (kind === "document") cls = doc && !isEvidenceDocument(doc) ? (doc.visibility === "broker_only" ? "private" : "claim") : "evidence";
      else cls = "skip"; // website, social, system
    }
    const origin = doc ? `doc:${doc.id}` : `${kind}:${cls}`;
    const existing = refByOrigin.get(origin);
    if (existing) return existing;
    const label = doc
      ? `${cls === "private" ? "Broker-private file" : KIND_LABEL[kind] ?? "Source"}: ${doc.name}`
      : isUntrackedSource(src) ? "Seller (source not recorded)" : KIND_LABEL[kind] ?? kind;
    const ref: SourceRef = { ref: `S${refs.length + 1}`, cls, kind, ...(doc ? { documentId: doc.id } : {}), label };
    refs.push(ref);
    refByOrigin.set(origin, ref);
    return ref;
  };

  const claims: FactEntry[] = [];
  const privateClaims: FactEntry[] = [];
  const evidence: FactEntry[] = [];
  const settled: FactEntry[] = [];
  const byTarget = new Map<string, Array<{ entry: FactEntry; cls: SideClass }>>();
  const push = (entry: FactEntry, cls: SideClass, winner: boolean) => {
    const target = entry.year ? `${entry.key}.${entry.year}` : entry.key;
    const list = byTarget.get(target) ?? [];
    list.push({ entry, cls });
    byTarget.set(target, list);
    if (!winner) return;
    if (cls === "claim") claims.push(entry);
    else if (cls === "private") privateClaims.push(entry);
    else if (cls === "evidence") evidence.push(entry);
    else if (cls === "settled") settled.push(entry);
  };

  const factKeys: string[] = [];
  for (const [key, value] of Object.entries(info)) {
    if (!isFactKey(key) || value === null || value === undefined || value === "") continue;
    factKeys.push(key);
    const src = sources[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const [year, sub] of Object.entries(value as Record<string, unknown>)) {
        const text = valueText(sub);
        if (!text) continue;
        const ref = refFor(yearSource(src, year, lookup) ?? src);
        push({ key, year, value: text, ref: ref.ref }, ref.cls, true);
      }
      continue;
    }
    const ref = refFor(src);
    push({ key, value: valueText(value), ref: ref.ref }, ref.cls, true);
  }
  for (const [altKey, list] of Object.entries(alternates)) {
    const dot = altKey.indexOf(".");
    const key = dot > 0 ? altKey.slice(0, dot) : altKey;
    const year = dot > 0 ? altKey.slice(dot + 1) : undefined;
    if (!isFactKey(key) || !Array.isArray(list)) continue;
    for (const alt of list) {
      if (!alt || typeof alt.value !== "string" || !alt.value.trim() || alt.note === RESOLUTION_ALTERNATE_NOTE) continue;
      const ref = refFor(alt);
      push({ key, ...(year ? { year } : {}), value: alt.value.replace(/\s+/g, " ").trim(), ref: ref.ref }, ref.cls, false);
    }
  }

  // Claim-vs-evidence pairs for the same fact that don't say the same thing.
  const clsOf = new Map(refs.map((r) => [r.ref, r.cls]));
  const candidates: ConflictCandidate[] = [];
  byTarget.forEach((list) => {
    const claimSide = list.filter((x) => x.cls === "claim" || x.cls === "private");
    const evidenceSide = list.filter((x) => x.cls === "evidence");
    if (claimSide.length === 0 || evidenceSide.length === 0) return;
    // Two paragraphs that describe the same thing in other words aren't a
    // conflict candidate; figures, dates and short values are — and so are
    // two longer statements whose shares or counts all disagree ("no
    // operator over ~25%" vs a contracts summary putting Maplecrest at 41%).
    const comparable = (a: string, b: string) =>
      (a.length <= 80 && b.length <= 80) ||
      (Math.min(a.length, b.length) <= 160 && numberTokens(a).length > 0 && numberTokens(b).length > 0) ||
      (a.length <= 400 && specificConflict(a, b));
    for (const c of claimSide) {
      if (isMissingSide(c.entry.value)) continue;
      // Only a difference when no evidence value agrees with the claim.
      if (evidenceSide.some((e) => sidesEquivalent(c.entry.value, e.entry.value))) continue;
      const differing = evidenceSide.filter((e) => !isMissingSide(e.entry.value) && comparable(c.entry.value, e.entry.value));
      if (differing.length === 0) continue;
      // Pair the claim with the document statement about the same dimension
      // (a year against a year, a % against a %), not simply the first one:
      // "Expires: 2034" belongs against "lease … to June 30, 2029", not
      // against the premises address.
      const scored = differing
        .map((e) => ({ e, score: conflictScore(c.entry.value, e.entry.value) }))
        .sort((a, b) => b.score - a.score || a.e.entry.value.length - b.e.entry.value.length);
      const best = scored[0];
      // A long claim with figures that no document figure speaks to ("Lease
      // term ends June 30, 2029; …" against the premises address) is not a
      // candidate — the model would only be asked to compare unrelated text.
      const kinded = numberTokens(c.entry.value).some((t) => tokenKind(t) !== null);
      if (best.score === 0 && kinded && Math.max(c.entry.value.length, best.e.entry.value.length) > 80) continue;
      candidates.push({ factKey: c.entry.key, ...(c.entry.year ? { factYear: c.entry.year } : {}), claim: c.entry, evidence: best.e.entry, score: best.score });
    }
  });
  // Seller-side candidates first; private ones after.
  candidates.sort(
    (a, b) =>
      Number(clsOf.get(a.claim.ref) === "private") - Number(clsOf.get(b.claim.ref) === "private") ||
      (b.score ?? 0) - (a.score ?? 0) ||
      a.claim.value.length + a.evidence.value.length - (b.claim.value.length + b.evidence.value.length),
  );

  return {
    refs,
    claims,
    privateClaims,
    evidence,
    settled,
    candidates: candidates.slice(0, 60),
    evidenceDocs: documents.filter((d) => isEvidenceDocument(d) && (d.extractedText || d.extractedData)),
    factKeys,
  };
}

/** Words from the claim keys ("leaseExpiry" → lease, expiry) — steers which passages of each document are sent. */
function claimKeywords(input: DiscrepancyInput): string[] {
  const words = new Set<string>();
  for (const e of [...input.claims, ...input.privateClaims]) {
    e.key
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z]+/)
      .filter((w) => w.length >= 4)
      .forEach((w) => words.add(w));
  }
  return Array.from(words).slice(0, 80);
}

const DOC_TEXT_TOTAL = 60_000;

function renderEntry(e: FactEntry): string {
  const v = e.value.length > PROMPT_VALUE_MAX ? `${e.value.slice(0, PROMPT_VALUE_MAX)}…` : e.value;
  return `- ${e.key}${e.year ? ` [${e.year}]` : ""} = ${v}  (${e.ref})`;
}

/** Keys a finding may name: facts on file, plus the canonical keys the CIM knows. */
function validFactKey(key: unknown, input: DiscrepancyInput): string | null {
  if (typeof key !== "string") return null;
  const k = key.trim();
  if (!k || !/^[a-z][A-Za-z0-9]*$/.test(k)) return null;
  if (input.factKeys.includes(k) || GENERIC_FIELD_LABELS[k] || k === "revenueByYear") return k;
  return null;
}

const DISCREPANCY_TOOL = {
  name: "report_discrepancies",
  description: "Report the real conflicts between what the seller said and what the documents show.",
  input_schema: {
    type: "object" as const,
    properties: {
      discrepancies: {
        type: "array",
        items: {
          type: "object",
          properties: {
            field: { type: "string", description: "Short broker-readable name of what conflicts, e.g. 'Lease expiry', 'Largest customer share'." },
            factKey: { type: "string", description: "The exact fact key from the lists this conflict is about (empty if none fits)." },
            factYear: { type: "string", description: "Fiscal year, only for a per-year fact shown with [year]." },
            claimValue: { type: "string", description: "What the seller-side source says — the value only, no source name." },
            claimSource: { type: "string", description: "Source ref of the claim, e.g. S3." },
            evidenceValue: { type: "string", description: "What the document shows — the value only, no source name." },
            evidenceSource: { type: "string", description: "Source ref of the document, e.g. S7." },
            severity: { type: "string", enum: ["critical", "significant", "minor"] },
            category: { type: "string", enum: ["financial", "operational", "legal", "factual"] },
            explanation: { type: "string" },
            suggestedResolution: { type: "string" },
            existingId: { type: "string", description: "Only when this is the same conflict as a STILL OPEN discrepancy — its id." },
            candidateId: { type: "string", description: "The conflict candidate this reports (C1, C2, …), if it came from one." },
          },
          required: ["field", "claimValue", "claimSource", "evidenceValue", "evidenceSource", "severity", "category", "explanation", "suggestedResolution"],
        },
      },
      dismissedCandidates: {
        type: "array",
        description: "Every conflict candidate you did NOT report, with a short reason (different things, same value, …).",
        items: {
          type: "object",
          properties: { id: { type: "string" }, reason: { type: "string" } },
          required: ["id", "reason"],
        },
      },
      clearedIds: { type: "array", items: { type: "string" }, description: "Ids of STILL OPEN discrepancies the documents now agree with." },
    },
    required: ["discrepancies", "dismissedCandidates", "clearedIds"],
  },
};

/**
 * Run a discrepancy check between seller-provided info and document-extracted data.
 *
 * `existing` — discrepancies already on the deal. Resolved ones are shown to
 * the model as settled (never re-raise) and dropped again on the way out as a
 * backstop; open ones are re-evaluated by id so the caller can refresh them in
 * place instead of creating duplicates.
 *
 * Throws when the model call or its output fails — a failed check must never
 * be recorded as a clean one.
 */
export async function runDiscrepancyCheck(
  deal: {
    id: string;
    businessName: string;
    industry?: string | null;
    extractedInfo: Record<string, any>;
    questionnaireData?: Record<string, any> | null;
  },
  documents: CheckDocument[],
  existing: ExistingDiscrepancy[] = [],
  opts: { today?: Date } = {},
): Promise<{ items: DiscrepancyItem[]; clearedIds: string[]; dropped: number }> {
  const input = buildDiscrepancyInput(deal.extractedInfo || {}, documents);
  if (input.evidenceDocs.length === 0) {
    return { items: [], clearedIds: [], dropped: 0 }; // Nothing to cross-reference
  }

  // Resolved values are the broker's settled truth.
  const live = existing.filter((d) => d.status !== "superseded");
  const settled = live.filter((d) => d.status === "resolved" || d.status === "accepted");
  const unsettled = live.filter((d) => d.status !== "resolved" && d.status !== "accepted");
  const renderExisting = (d: ExistingDiscrepancy) =>
    `- [${d.id}] ${d.field}${d.factKey ? ` (fact ${d.factKey}${d.factYear ? ` ${d.factYear}` : ""})` : ""} (${d.severity}) — seller: ${d.interviewValue ?? "—"} | document: ${d.documentValue ?? "—"}${d.resolvedValue ? ` → resolved value: ${d.resolvedValue}` : ""}`;
  const existingSection = live.length === 0
    ? ""
    : `
## Previously raised discrepancies
${settled.length > 0 ? `RESOLVED by the broker — settled; never raise these again under this field name or any other wording:\n${settled.map(renderExisting).join("\n")}` : ""}
${unsettled.length > 0 ? `STILL OPEN — re-evaluate each against the documents. If it still conflicts, include it with its "existingId"; if the sources now agree, put its id in "clearedIds". Do not silently omit any of them:\n${unsettled.map(renderExisting).join("\n")}` : ""}
`;

  const keywords = claimKeywords(input);
  const perDoc = Math.max(2500, Math.min(8000, Math.floor(DOC_TEXT_TOTAL / Math.max(1, input.evidenceDocs.length))));
  const refByDoc = new Map(input.refs.filter((r) => r.documentId).map((r) => [r.documentId!, r.ref]));
  const docSections = input.evidenceDocs.map((d) => {
    const ref = refByDoc.get(d.id);
    const facts = input.evidence.filter((e) => e.ref === ref);
    const text = d.extractedText ? sliceRelevantText(d.extractedText, perDoc, keywords) : "";
    return `### ${ref ?? "(no facts)"} — ${d.name} (${d.category || "uncategorized"}, document ID: ${d.id})
${facts.length > 0 ? `Facts it states:\n${facts.map(renderEntry).join("\n")}\n` : ""}${text ? `Relevant text:\n${text}` : ""}`;
  });
  const refLines = input.refs
    .filter((r) => r.cls !== "skip")
    .map((r) => `- ${r.ref}: ${r.label}${r.cls === "private" ? " — BROKER-PRIVATE" : r.cls === "settled" ? " — final" : ""}`);
  const candidateLines = input.candidates.map(
    (c, i) => `- C${i + 1} ${c.factKey}${c.factYear ? ` [${c.factYear}]` : ""}: "${focusSnippet(c.evidence.value, c.claim.value, 200)}" (${c.claim.ref}) vs "${focusSnippet(c.claim.value, c.evidence.value, 220)}" (${c.evidence.ref})`,
  );

  const system = [
    "You are a due diligence verification agent for an M&A deal. You compare what the seller said with what the documents show and report only REAL conflicts.",
    "Report a conflict only when two identifiable sources state different values for the same thing. Never report missing data or a document that wasn't provided. Never report two ways of saying the same value (a monthly vs an annual amount, a start year vs years of tenure, '23' vs '23 employees', rounding).",
    "Never compare an adjusted/normalized earnings figure (adjusted EBITDA, SDE, recast) with a reported one — they are different metrics.",
    "Never compare a part with a whole or a different period: one division's or segment's revenue (long-term care, dispensary only) with total revenue, one location with the company, one year with another. A value that is plainly mislabelled in the facts (a segment figure filed as total revenue) is not a seller conflict — skip it.",
    "Material conflicts to look for especially: revenue, EBITDA/SDE, owner compensation and add-backs claimed vs supported; customer concentration (a seller's 'about a quarter' vs a document's 41% IS a conflict); lease expiry, term and renewal options (a different year IS a conflict — and a lease 'expiring 2034' when the lease runs to 2029 with an unexercised option to 2034 IS a conflict: the lease expires in 2029 unless the option is exercised); headcount by role (licensed technicians, drivers, full-time vs part-time); fleet or equipment counts; tenure and dates; contract terms; licences.",
    "Every conflict candidate (C1, C2, …) needs a decision: report it (with its candidateId) or list it in dismissedCandidates with the reason. A candidate is a real conflict when the two values state the same thing differently; dismiss it when they describe different things or agree.",
    "Report only conflicts. A finding you would explain as a clarification, a timing detail or 'not a conflict' is not a discrepancy — leave it out.",
    "Severity: critical = financial >10% or a core business claim that doesn't match; significant = 5–10% or an operational inconsistency; minor = small date or rounding differences.",
    "factKey is the fact whose value IS the conflicting figure (the broker's resolution replaces that value), chosen from the fact keys shown. A part of a broader fact is not that fact — licensed technicians are not total employees, one customer's share is not the revenue mix — leave factKey empty then. For a per-year fact shown with [year], give factYear.",
    "claimSource and evidenceSource are the S-refs shown. The claim side is the seller-side or BROKER-PRIVATE source; the evidence side is always a document.",
    "BROKER-PRIVATE sources are the broker's own notes. You may compare them, but the explanation and suggestedResolution must NEVER quote their value or name them (no 'CRM', 'broker note', 'site visit', 'recast'): describe only what the document shows and what needs confirming — this text may be read to the seller.",
    "Write values plainly (the value only, no source name) and explanations in plain broker English.",
  ].join("\n");

  const user = `## Business: ${deal.businessName}
## Industry: ${deal.industry || "unknown"}

## Sources
${refLines.join("\n") || "(none)"}

## What the seller said (claims)
${input.claims.map(renderEntry).join("\n") || "(none)"}
${input.privateClaims.length > 0 ? `\n## Broker-private notes (compare, never quote or name in the explanation)\n${input.privateClaims.map(renderEntry).join("\n")}\n` : ""}
## Settled by the broker (final — never flag)
${input.settled.map(renderEntry).join("\n") || "(none)"}

## Conflict candidates (the same fact, different values from a claim and a document — check each first)
${candidateLines.join("\n") || "(none)"}

## Documents (what the documents show)
${docSections.join("\n\n---\n\n")}
${existingSection}
Report the real conflicts with the report_discrepancies tool.`;

  const parsed = (await checkModel(system, user)) as { discrepancies?: any[]; clearedIds?: unknown[] };

  const rawItems: any[] = Array.isArray(parsed?.discrepancies) ? parsed.discrepancies : [];
  const isUuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
  const existingIds = new Set(live.map((d) => d.id));
  const refMap = new Map(input.refs.map((r) => [r.ref, r]));
  const docMap = new Map(documents.map((d) => [d.id, d]));
  const candidateById = (id: unknown) => {
    const m = typeof id === "string" ? id.trim().match(/^C(\d+)$/i) : null;
    return m ? input.candidates[Number(m[1]) - 1] : undefined;
  };

  const toSide = (r: SourceRef | undefined): DiscrepancySideSource | undefined =>
    r
      ? {
          kind: r.kind,
          ...(r.documentId ? { documentId: r.documentId } : {}),
          ...(r.cls === "private" ? { brokerOnly: true } : {}),
          // A private side carries no name — the panel says "Your private notes".
          ...(r.cls === "private" ? {} : { label: r.documentId ? docMap.get(r.documentId)?.name ?? r.label : r.label }),
        }
      : undefined;

  const mapped: DiscrepancyItem[] = [];
  for (const raw of rawItems) {
    if (!raw || !raw.field || !raw.explanation) continue;
    const fromCandidate = candidateById(raw.candidateId);
    let claimRef = refMap.get(String(raw.claimSource ?? "").trim()) ?? (fromCandidate ? refMap.get(fromCandidate.claim.ref) : undefined);
    let evidenceRef = refMap.get(String(raw.evidenceSource ?? "").trim()) ?? (fromCandidate ? refMap.get(fromCandidate.evidence.ref) : undefined);
    let claimValue = String(raw.claimValue ?? "").trim() || (fromCandidate?.claim.value ?? "");
    let evidenceValue = String(raw.evidenceValue ?? "").trim() || (fromCandidate ? focusSnippet(fromCandidate.claim.value, fromCandidate.evidence.value) : "");
    // The model swapped the sides — the document is always the evidence.
    if (claimRef?.cls === "evidence" && evidenceRef && evidenceRef.cls !== "evidence") {
      [claimRef, evidenceRef] = [evidenceRef, claimRef];
      [claimValue, evidenceValue] = [evidenceValue, claimValue];
    }
    // Two documents disagreeing is the financial analysis's job; a claim
    // compared with its own document is no conflict.
    if (claimRef && claimRef.cls === "evidence") continue;
    // The evidence side must be a shared document. When the model cites the
    // broker's own edit (or nothing usable), fall back to the document that
    // disagreed for the same fact, if the candidates have one.
    if (!evidenceRef || evidenceRef.cls !== "evidence") {
      const key = typeof raw.factKey === "string" ? raw.factKey.trim() : "";
      const cand = fromCandidate
        ?? input.candidates.find((c) => c.factKey === key && (!claimRef || c.claim.ref === claimRef.ref))
        ?? input.candidates.find((c) => c.factKey === key);
      const fallback = cand ? refMap.get(cand.evidence.ref) : undefined;
      if (fallback) {
        evidenceRef = fallback;
        if (!evidenceValue) evidenceValue = cand!.evidence.value;
      } else if (evidenceRef && evidenceRef.cls === "settled") {
        continue; // the broker already decided this fact
      }
    }
    if (claimRef && evidenceRef && claimRef.documentId && claimRef.documentId === evidenceRef.documentId) continue;
    const factKey = validFactKey(raw.factKey, input);
    const factYear = factKey && typeof raw.factYear === "string" && /^(?:FY\s*)?\d{4}$|^[A-Za-z0-9 ]{2,12}$/.test(raw.factYear.trim()) ? raw.factYear.trim() : null;
    const evidenceDoc = evidenceRef?.documentId ? docMap.get(evidenceRef.documentId) : undefined;
    const sideSources: DiscrepancySideSources = {};
    const claimSide = toSide(claimRef);
    const evidenceSide = toSide(evidenceRef);
    if (claimSide) sideSources.interview = claimSide;
    if (evidenceSide) sideSources.document = evidenceSide;
    const scrubbed = scrubPrivateText({
      field: String(raw.field),
      interviewValue: claimValue,
      documentValue: evidenceValue,
      aiExplanation: String(raw.explanation),
      suggestedResolution: String(raw.suggestedResolution ?? ""),
      sideSources,
    });
    mapped.push({
      field: String(raw.field).trim().slice(0, 200),
      factKey,
      factYear,
      interviewValue: scrubbed.interviewValue,
      documentValue: scrubbed.documentValue,
      documentId: evidenceDoc?.id ?? "",
      documentName: evidenceDoc?.name ?? "",
      sideSources: scrubbed.sideSources,
      severity: SEVERITIES.has(raw.severity) ? raw.severity : "significant",
      category: CATEGORIES.has(raw.category) ? raw.category : "factual",
      aiExplanation: scrubbed.aiExplanation,
      suggestedResolution: scrubbed.suggestedResolution,
      existingId: isUuid(raw.existingId) && existingIds.has(raw.existingId) ? raw.existingId : undefined,
    });
  }

  const { kept, dropped } = filterDiscrepancyItems(mapped, opts.today ?? new Date());
  // Backstop: a settled conflict never comes back, whatever the model called it.
  const items = kept.filter((item) => {
    const byId = item.existingId ? settled.find((d) => d.id === item.existingId) : undefined;
    return !byId && !settled.some((d) => isSameDiscrepancy(item, d));
  });

  // An open row the model re-raised but the filter dropped (equal values,
  // a missing document) is cleared too — it was never a conflict.
  const droppedExisting = dropped.map((d) => d.item.existingId).filter((id): id is string => !!id);
  const clearedIds: string[] = Array.from(new Set([
    ...(Array.isArray(parsed?.clearedIds) ? parsed.clearedIds : []).filter((id: unknown): id is string => isUuid(id) && existingIds.has(id)),
    ...droppedExisting,
  ]));

  // Candidates the model neither reported nor dismissed — logged, so a
  // silently skipped conflict is visible in the server log.
  const decided = new Set<string>([
    ...rawItems.map((r) => String(r?.candidateId ?? "").trim().toUpperCase()),
    ...(Array.isArray((parsed as any)?.dismissedCandidates) ? (parsed as any).dismissedCandidates : []).map((d: any) => String(d?.id ?? "").trim().toUpperCase()),
  ]);
  const undecided = input.candidates.map((_, i) => `C${i + 1}`).filter((id) => !decided.has(id));
  if (undecided.length > 0) console.info(`[discrepancy-check] ${deal.id}: ${undecided.length} of ${input.candidates.length} candidates got no decision (${undecided.join(", ")})`);

  return { items, clearedIds, dropped: dropped.length };
}
