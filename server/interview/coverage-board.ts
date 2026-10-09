/**
 * The coverage board, built on the server (specs/together.md §3).
 *
 * One function family computes items, statuses, counts, the headline percent
 * and the quality label for every surface (shared/coverage-board.ts has the
 * types and the pure display helpers):
 *
 *   loadCoverageInputs(deal)          — the deal's documents (metadata only),
 *                                       interview sessions (meta only), open
 *                                       discrepancies, marks, document requests
 *   boardFromCoverage(inputs, aud)    — pure: the board for an audience
 *   buildCoverageBoard(deal, {aud})   — both
 *
 * Coverage is RECORDED coverage (what computeDealReadiness and the seller's
 * progress page read): on-file evidence (a passage that answers an item no
 * fact records yet) makes an item Partial, never On file. The quality label
 * is exactly computeCimReadiness over that coverage — the Overview's "Solid
 * 84" for the broker, the seller page's label for the seller.
 *
 * Audiences: broker reads brokerFactsView; seller reads the seller-safe view
 * the interview reads (statuses and counts only — no values, sources,
 * reasons or notes); screen ("Seller can see this screen") takes statuses
 * from the broker view and every value, reason and source from the
 * seller-safe view — anything only the broker can see reads "On file —
 * private to you".
 *
 * Never calls a model and never starts a background job.
 */
import { createHash } from "crypto";
import { desc, eq } from "drizzle-orm";
import {
  CIM_SECTIONS,
  documents as documentsTable,
  interviewSessions,
  type CoverageMarkRow,
  type Deal,
  type DealDocumentRequirement,
  type Discrepancy,
  type Document,
} from "@shared/schema";
import {
  boardVersion,
  isNotKnownValue,
  percentCollected,
  sectionCounts,
  summarise,
  summaryOf,
  type CoverageAudience,
  type CoverageBoard,
  type CoverageItem,
  type CoverageItemDetail,
  type CoverageItemMark,
  type CoverageItemSource,
  type CoverageMarkKind,
  type CoverageMember,
  type CoverageReason,
  type CoverageReference,
  type CoverageSection,
  type CoverageSummary,
  type DocumentNeeded,
  type RoutedQuestion,
} from "@shared/coverage-board";
import { computeCimReadiness } from "@shared/cim-readiness";
import {
  SECTION_FIELD_GROUPS,
  PRIVATE_MATERIAL_RE,
  buildSectionCoverage,
  discrepancyPrivacy,
  isSubstantiveValue,
  sellerCoverageFacts,
  type SectionCoverage,
} from "./knowledge-base";
import { GENERIC_ASKS, MEMBER_LABELS, SHARED_KEY_HOME, FALLBACK_WHY, lowerFirst, planItemAsk, templateAsk } from "./coverage-asks";
import { coverageAdjustmentsForDeal, fieldLabel, getInterviewPlan, isPlanBuilding, planSubIndustry } from "./interview-plan";
import { getInterviewOutline } from "./outline";
import { getSectionImportance } from "./section-importance";
import {
  HIGH_STAKES_FIELDS,
  describeSource,
  getFieldAlternates,
  getFieldSources,
  isBrokerCallNote,
  isBrokerSessionSource,
  isRowBackedSource,
  isSourceKind,
  repairCharIndexedValue,
  type FieldSource,
} from "./info-merger";
import { onFileItems, type EvidenceTarget, type OnFileItem } from "./on-file-evidence";
import { parseLedger, type DeferralEntry } from "./deferral-ledger";
import { BROKER_WORK_KEY_RE } from "./source-privacy";
import { isDocumentAuthoritativeField } from "../documents/merge-policy";
import { whoHoldsTheAnswer } from "./fact-guards";
import { contextSessions } from "./session-mode";
import { brokerFactsView } from "../information/facts";

// ─────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────

/** Document metadata the board reads (never extracted text or data). */
export type CoverageDoc = Pick<Document, "id" | "name" | "visibility"> &
  Partial<Pick<Document, "sourceKind" | "sourceMeta" | "createdAt" | "category" | "subcategory" | "status">>;

/** An interview session's metadata (never its messages). */
export interface CoverageSessionMeta {
  id: string;
  status?: string | null;
  lastActivityAt?: Date | string | null;
  startedAt?: Date | string | null;
  extractedInfo?: unknown;
}

/** dd's "questions about the numbers" (shared/figure-explain.ts, INTEGRATION §2.5), adapted to board items. */
export interface ExplainBoardItem {
  id: string;
  sectionKey: "financials";
  label: string;
  writeKey: string;
  memberKeys: string[];
  critical: false;
  origin: "figures";
  ask: string;
  why: string;
}

export interface CoverageMarkLike {
  id?: string;
  itemId: string;
  sectionKey?: string | null;
  kind: string;
  note?: string | null;
  valueHash?: string | null;
  sittingId?: string | null;
  createdAt?: Date | string | null;
  clearedAt?: Date | string | null;
}

/** What a filing in a live session recorded per key (pass 3: together_chunks). */
export interface SittingFiling { at: string; sittingId: string; chunkId?: string }

export interface CoverageInputs {
  deal: Deal;
  documents: CoverageDoc[];
  /** brokerFactsView(deal).extractedInfo — what every broker surface reads. */
  brokerFacts: Record<string, unknown>;
  /** sellerCoverageFacts(...) — the seller-safe coverage view the interview reads. */
  sellerFacts: Record<string, unknown>;
  /** The session computeDealReadiness reads (latest by activity): confidence + ledger for broker/screen. */
  brokerSession: CoverageSessionMeta | null;
  /** The session the seller's progress page reads (contextSessions()[0]). */
  sellerSession: CoverageSessionMeta | null;
  sessionIds?: string[];
  /** Discrepancies with status open | ask_seller | seller_responded. */
  openDiscrepancies: Discrepancy[];
  marks: CoverageMarkLike[];
  requirements: Array<Pick<DealDocumentRequirement, "id" | "documentName" | "isRequired" | "status"> & Partial<Pick<DealDocumentRequirement, "source">> & { neededBy?: Date | string | null }>;
  figureItems?: ExplainBoardItem[];
  sittingFilings?: Record<string, SittingFiling>;
  now?: Date;
}

// ─────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────

const VALUE_DISPLAY_MAX = 280;
const LEAD_KINDS = new Set(["crm", "website", "social"]);
const OPEN_DISCREPANCY = new Set(["open", "ask_seller", "seller_responded"]);
const ADDBACK_KEY_RE = /^(?:owner)?add[_-]?backs?\w*$/i;

/** A member the board may file or edit: everything but the broker's own computations (SDE, adjusted earnings, a peg…). The seller's add-back list is writable. */
export function isWritableMember(key: string): boolean {
  return !BROKER_WORK_KEY_RE.test(key) || ADDBACK_KEY_RE.test(key);
}

/** Coverage values as text; a map fact (revenue by year) reads "2024: $1.2M; 2023: …". */
export function coverageValueText(v: unknown): string | null {
  if (!isSubstantiveValue(v)) return null;
  if (typeof v === "string") return v;
  const repaired = repairCharIndexedValue(v);
  if (repaired && typeof repaired === "object" && !Array.isArray(repaired)) {
    return Object.entries(repaired as Record<string, unknown>).map(([k, x]) => `${k}: ${String(x)}`).join("; ");
  }
  return typeof repaired === "object" ? JSON.stringify(repaired) : String(repaired);
}

/** The hash a "confirmed" mark keeps of the value it confirmed (it lapses when the value changes). */
export function valueHash(value: string): string {
  return createHash("sha1").update(value.replace(/\s+/g, " ").trim()).digest("hex");
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function confidenceOf(session: CoverageSessionMeta | null): Record<string, string> | undefined {
  const meta = (session?.extractedInfo as Record<string, unknown> | null | undefined) || {};
  return (meta._confidenceLevels as Record<string, string> | undefined) ?? undefined;
}

function ledgerOf(session: CoverageSessionMeta | null): DeferralEntry[] {
  const meta = (session?.extractedInfo as Record<string, unknown> | null | undefined) || {};
  return parseLedger(meta._deferralLedger);
}

/** Open guard / reconcile entries on the ledger, by lower-cased key. */
function ledgerFlags(ledger: DeferralEntry[]): Map<string, "number" | "date"> {
  const out = new Map<string, "number" | "date">();
  for (const e of ledger) {
    if (e.status !== "open") continue;
    const t = e.topic.trim().toLowerCase();
    let m = t.match(/^verify ([a-z0-9_]+) date$/i);
    if (m) { if (!out.has(m[1])) out.set(m[1], "date"); continue; }
    m = t.match(/^(?:verify|reconcile) ([a-z0-9_]+)$/i);
    if (m) out.set(m[1], out.get(m[1]) ?? "number");
  }
  return out;
}

function activeMarks(marks: CoverageMarkLike[]): CoverageMarkLike[] {
  return marks.filter((m) => !m.clearedAt);
}

function toIso(d: Date | string | null | undefined): string {
  if (!d) return new Date(0).toISOString();
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? new Date(0).toISOString() : t.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────
// Building the board
// ─────────────────────────────────────────────────────────────────────────

interface Draft {
  item: CoverageItem;
  /** Full shown value (untruncated) — the confirmed-mark hash. */
  fullValue: string | null;
  /** The source of the shown value. */
  src: FieldSource | undefined;
}

interface ItemShape {
  id: string;
  sectionKey: string;
  label: string;
  members: CoverageMember[];
  aliases: string[];
  readKeys: string[];
  critical: boolean;
  origin: CoverageItem["origin"];
  ask: string;
  why: string;
  /** Coverage fields of the members (statuses come from these). */
  fields: SectionCoverage["fields"];
}

/** The items and reference rows of every section (shape only — no statuses). Pure. */
export function boardShape(
  coverage: SectionCoverage[],
  deal: Pick<Deal, "industry" | "interviewPlan" | "interviewOutline"> & { subIndustry?: string | null },
): { sections: Array<{ coverage: SectionCoverage; items: ItemShape[]; references: CoverageReference[] }> } {
  const plan = getInterviewPlan(deal);
  const outline = getInterviewOutline(deal);
  const addedOrigin = new Map((outline.addedItems ?? []).map((a) => [a.key, a.origin === "noted" ? "noted" : "broker"] as const));
  const planKeys = new Map((plan?.items ?? []).map((i) => [i.key, i]));
  /** key → id of the item that counts it (first in CIM order). */
  const countedBy = new Map<string, string>();
  const pendingRefs: Array<{ ref: CoverageReference; key: string }> = [];
  const out: Array<{ coverage: SectionCoverage; items: ItemShape[]; references: CoverageReference[] }> = [];

  for (const section of coverage) {
    const fieldByKey = new Map(section.fields.map((f) => [f.fieldName, f]));
    const grouped = new Set<string>();
    const items: ItemShape[] = [];
    const references: CoverageReference[] = [];

    for (const g of SECTION_FIELD_GROUPS[section.key] ?? []) {
      const present = g.keys.filter((k) => fieldByKey.has(k));
      if (present.length === 0) continue;
      present.forEach((k) => grouped.add(k));
      const memberKeys = present.filter((k) => !SHARED_KEY_HOME[k] || SHARED_KEY_HOME[k] === section.key);
      const ask = GENERIC_ASKS[`${section.key}:${g.keys[0]}`];
      if (memberKeys.length === 0) {
        const home = SHARED_KEY_HOME[present[0]];
        pendingRefs.push({
          key: present[0],
          ref: { id: `${section.key}:ref:${present[0]}`, sectionKey: section.key, label: ask?.label ?? fieldLabel(present[0]), homeSectionKey: home, homeItemId: "" },
        });
        continue;
      }
      const aliases = (g.aliases ?? []).filter((a) => !SHARED_KEY_HOME[a] || SHARED_KEY_HOME[a] === section.key);
      const id = `${section.key}:${memberKeys[0]}`;
      for (const k of [...memberKeys, ...aliases]) if (!countedBy.has(k)) countedBy.set(k, id);
      items.push({
        id,
        sectionKey: section.key,
        label: ask?.label ?? fieldLabel(memberKeys[0]),
        members: memberKeys.map((k) => ({ key: k, label: MEMBER_LABELS[k] ?? lowerFirst(fieldLabel(k)), writable: isWritableMember(k) })),
        aliases,
        readKeys: [...memberKeys, ...aliases],
        critical: memberKeys.some((k) => !!fieldByKey.get(k)?.critical),
        origin: "generic",
        ask: ask?.ask ?? templateAsk(fieldLabel(memberKeys[0])),
        why: ask?.why ?? (section.importanceReason || FALLBACK_WHY),
        fields: memberKeys.map((k) => fieldByKey.get(k)!).filter(Boolean),
      });
    }

    for (const f of section.fields) {
      if (grouped.has(f.fieldName)) continue;
      const key = f.fieldName;
      const already = countedBy.get(key);
      const label = f.label ?? fieldLabel(key);
      if (already) {
        references.push({ id: `${section.key}:ref:${key}`, sectionKey: section.key, label, homeSectionKey: already.split(":")[0], homeItemId: already });
        continue;
      }
      const planItem = planKeys.get(key);
      const added = addedOrigin.get(key);
      const origin: CoverageItem["origin"] = added ?? (planItem ? "industry" : f.industrySpecific ? "industry" : "generic");
      const alias = planItem?.answeredByKey ?? null;
      const id = `${section.key}:${key}`;
      countedBy.set(key, id);
      const generic = GENERIC_ASKS[id];
      const phrased =
        origin === "industry"
          ? planItemAsk(plan, key, label, section.importanceReason)
          : generic
            ? { ask: generic.ask, why: generic.why }
            : { ask: templateAsk(label), why: section.importanceReason || FALLBACK_WHY };
      items.push({
        id,
        sectionKey: section.key,
        label: generic?.label ?? label,
        members: [{ key, label: MEMBER_LABELS[key] ?? lowerFirst(label), writable: isWritableMember(key) }],
        aliases: alias && alias !== key ? [alias] : [],
        readKeys: alias && alias !== key ? [key, alias] : [key],
        critical: !!f.critical,
        origin,
        ask: phrased.ask,
        why: phrased.why,
        fields: [f],
      });
    }
    out.push({ coverage: section, items, references });
  }

  // Reference rows point at the item that counts the key.
  for (const { ref, key } of pendingRefs) {
    const home = countedBy.get(key);
    ref.homeItemId = home ?? `${ref.homeSectionKey}:${key}`;
    const target = out.find((s) => s.coverage.key === ref.sectionKey);
    target?.references.push(ref);
  }
  return { sections: out };
}

function sourceOf(facts: Record<string, unknown>, key: string | null): FieldSource | undefined {
  return key ? getFieldSources(facts)[key] : undefined;
}

function sourceLabelFor(src: FieldSource | undefined, docName: (id: string) => string | undefined): CoverageItemSource | null {
  if (!src) return null;
  const kind = isSourceKind(src.source) ? src.source : "unknown";
  return {
    kind,
    label: describeSource(src, docName),
    ...(src.documentId ? { documentId: src.documentId } : {}),
    ...(src.at ? { at: src.at } : {}),
    ...(src.excerpt ? { excerpt: clip(src.excerpt, 200) } : {}),
    ...(src.speaker ? { speaker: src.speaker } : {}),
  };
}

/** The best value among an item's members and aliases: a verified one first, else any. */
function bestValue(
  shape: ItemShape,
  facts: Record<string, unknown>,
  confidence: Record<string, string> | undefined,
): { key: string; text: string; lead: boolean; confidence: string | undefined } | null {
  const sources = getFieldSources(facts);
  const isLead = (k: string) => {
    const s = sources[k];
    return !!s && LEAD_KINDS.has(String(s.source)) && !s.acceptedByBroker;
  };
  const candidates: Array<{ key: string; text: string; lead: boolean; confidence: string | undefined }> = [];
  for (const k of [...shape.members.map((m) => m.key), ...shape.aliases]) {
    const text = coverageValueText(facts[k]);
    if (text === null) continue;
    const src = sources[k];
    // (A live capture's own confidence on its row wins — knowledge-base.ts §3.4;
    // a value a session together wrote never reads an older session's confidence.)
    const conf = src && isRowBackedSource(src) && src.confidence ? src.confidence : src?.sittingId ? src.confidence ?? "confirmed" : confidence?.[k];
    candidates.push({ key: k, text, lead: isLead(k), confidence: conf });
  }
  return candidates.find((c) => !c.lead) ?? candidates[0] ?? null;
}

function marksFor(marks: CoverageMarkLike[], itemId: string): CoverageMarkLike[] {
  return marks.filter((m) => m.itemId === itemId);
}

function sideLabel(
  side: { kind?: string; documentId?: string } | undefined,
  docName: (id: string) => string | undefined,
  fallback: string,
): string {
  if (!side?.kind) return fallback;
  return describeSource({ source: side.kind as FieldSource["source"], documentId: side.documentId }, docName);
}

/**
 * Statuses, reasons and values for an item from one view of the facts.
 * `marksAllowed` filters which marks count for the audience.
 */
function itemStatus(
  shape: ItemShape,
  ctx: {
    facts: Record<string, unknown>;
    confidence: Record<string, string> | undefined;
    ledger: Map<string, "number" | "date">;
    evidence: Map<string, OnFileItem>;
    discrepancies: Discrepancy[];
    privacy: ReturnType<typeof discrepancyPrivacy>;
    marks: CoverageMarkLike[];
    audience: CoverageAudience;
    docName: (id: string) => string | undefined;
  },
): Draft {
  const best = bestValue(shape, ctx.facts, ctx.confidence);
  const src = best ? sourceOf(ctx.facts, best.key) : undefined;
  const itemMarks = marksFor(ctx.marks, shape.id);
  const markOf = (kind: CoverageMarkKind) => itemMarks.find((m) => m.kind === kind);
  const base: CoverageItem = {
    id: shape.id,
    sectionKey: shape.sectionKey,
    label: shape.label,
    members: shape.members,
    readKeys: shape.readKeys,
    valueKey: best?.key ?? null,
    critical: shape.critical,
    origin: shape.origin,
    status: "missing",
    reason: null,
    value: best ? clip(best.text, VALUE_DISPLAY_MAX) : null,
    source: sourceLabelFor(src, ctx.docName),
    ask: shape.ask,
    why: shape.why,
    marks: itemMarks.map((m) => ({ kind: m.kind as CoverageMarkKind, ...(m.note ? { note: m.note } : {}), at: toIso(m.createdAt) })),
  };
  const draft = (patch: Partial<CoverageItem>): Draft => ({ item: { ...base, ...patch }, fullValue: best?.text ?? null, src });

  // 1. No recorded value.
  if (!best) {
    const ev = shape.readKeys.map((k) => ctx.evidence.get(k)).find(Boolean);
    if (ev) {
      return draft({
        status: "partial",
        reason: ev.partial
          ? { code: "partly_on_file", onFile: clip(ev.answer, 160), missing: clip(ev.missing ?? "", 120) }
          : { code: "in_source", sourceLabel: ev.source, private: false },
      });
    }
    const nk = markOf("not_known");
    if (nk) return draft({ status: "partial", reason: { code: "not_known", ...(nk.note ? { whoHasIt: nk.note } : {}) } });
    return draft({ status: "missing" });
  }

  // 2. A recorded non-answer ("Owner does not know … Denise would have it").
  if (isNotKnownValue(best.text)) {
    const who = whoHoldsTheAnswer(best.text);
    return draft({ status: "partial", reason: { code: "not_known", ...(who ? { whoHasIt: who } : {}) } });
  }

  // 3. An open discrepancy names a read key.
  const readSet = new Set(shape.readKeys);
  for (const d of ctx.discrepancies) {
    if (!d.factKey || !readSet.has(d.factKey)) continue;
    const p = ctx.privacy(d);
    const privateSide = p.privateA || p.privateB || p.explanationPrivate;
    if (ctx.audience === "seller" && privateSide) continue;
    if (d.status === "ask_seller") return draft({ status: "verify", reason: { code: "routed" }, conflictId: d.id });
    const sides = (d.sideSources as { interview?: { kind?: string; documentId?: string }; document?: { kind?: string; documentId?: string } } | null) || {};
    return draft({
      status: "verify",
      conflictId: d.id,
      reason: {
        code: "conflict",
        privateSide,
        ...(d.interviewValue ? { a: clip(d.interviewValue, 56) } : {}),
        aSource: sideLabel(sides.interview, ctx.docName, "what was said"),
        ...(d.documentValue ? { b: clip(d.documentValue, 56) } : {}),
        bSource: sideLabel(sides.document, ctx.docName, d.documentName || "a document"),
      },
    });
  }

  // The broker's "confirmed" mark, while the value is the one confirmed.
  const confirmed = markOf("confirmed");
  const confirmedNow = !!confirmed?.valueHash && confirmed.valueHash === valueHash(best.text);
  const onFileConfirmed = (): Draft => draft({ status: "on_file", confirmedByYou: true, ...(isBrokerCallNote(src) ? { yourNote: true } : {}) });

  // 4. Only a lead holds it.
  if (best.lead) {
    if (confirmedNow) return onFileConfirmed();
    const kind = String(src?.source) as "crm" | "website" | "social";
    return draft({ status: "verify", reason: { code: "lead", leadKind: LEAD_KINDS.has(kind) ? kind : "crm" } });
  }
  // 5. The broker's own AI-session notes hold it.
  if (isBrokerSessionSource(src) && !isBrokerCallNote(src)) {
    if (confirmedNow) return onFileConfirmed();
    return draft({ status: "verify", reason: { code: "broker_notes" } });
  }
  // 6. A guard flag.
  const flag = shape.readKeys.map((k) => ctx.ledger.get(k.toLowerCase())).find(Boolean) ?? src?.verify;
  if (flag) {
    if (confirmedNow) return onFileConfirmed();
    return draft({ status: "verify", reason: { code: "guard", detail: flag as "number" | "date" | "legal" } });
  }
  // 7. The broker marked it to check later.
  if (ctx.audience !== "seller" && markOf("verify_later")) {
    if (confirmedNow) return onFileConfirmed();
    return draft({ status: "verify", reason: { code: "marked" } });
  }
  // 8. A seller estimate on a figure buyers lean on.
  if (best.confidence === "approximate") {
    const highStakes = HIGH_STAKES_FIELDS.has(best.key) || isDocumentAuthoritativeField(best.key) || ADDBACK_KEY_RE.test(best.key);
    if (highStakes) {
      if (confirmedNow) return onFileConfirmed();
      return draft({ status: "verify", reason: { code: "estimate" } });
    }
    return draft({ status: "on_file", estimate: true, ...(isBrokerCallNote(src) ? { yourNote: true } : {}), ...(confirmedNow ? { confirmedByYou: true } : {}) });
  }
  // 9. On file.
  return draft({ status: "on_file", ...(isBrokerCallNote(src) ? { yourNote: true } : {}), ...(confirmedNow ? { confirmedByYou: true } : {}) });
}

/** Evidence (a passage that answers an item no fact records) by field key. */
function evidenceByKey(
  deal: Pick<Deal, "interviewEvidence">,
  coverage: SectionCoverage[],
  documents: CoverageDoc[],
  view: Record<string, unknown>,
  sessionIds: string[] | undefined,
): Map<string, OnFileItem> {
  const targets: EvidenceTarget[] = [];
  const seen = new Set<string>();
  for (const s of coverage) {
    for (const f of s.fields) {
      if (f.value !== null && !f.unverified) continue;
      if (seen.has(f.fieldName)) continue;
      seen.add(f.fieldName);
      targets.push({ id: `field:${f.fieldName}`, kind: "field", key: f.fieldName, label: f.label ?? fieldLabel(f.fieldName), sellerAccount: false });
    }
  }
  const items = onFileItems(deal as { interviewEvidence?: unknown }, targets, {
    documents: documents as Parameters<typeof onFileItems>[2] extends { documents?: infer D } ? NonNullable<D> : never,
    view,
    ...(sessionIds ? { sessionIds } : {}),
  });
  return new Map(items.filter((i) => i.kind === "field").map((i) => [i.key, i]));
}

/** The board's plan state, as the outline reports it (no build is started here). */
export function planState(deal: Pick<Deal, "id" | "industry" | "interviewPlan"> & { subIndustry?: string | null }): CoverageBoard["plan"] {
  const plan = getInterviewPlan(deal);
  const lastBuildFailed = (deal.interviewPlan as { status?: string } | null)?.status === "failed";
  const playbookMatches = planSubIndustry(deal).matched && !lastBuildFailed;
  return {
    status: plan ? "ready" : isPlanBuilding(deal.id) ? "building" : !deal.industry ? "no_industry" : playbookMatches ? "building" : "unavailable",
    industry: plan ? (plan.subIndustry || plan.industry) : deal.industry ?? null,
  };
}

/** The coverage board for an audience. Pure (given its inputs). */
export function boardFromCoverage(inputs: CoverageInputs, audience: CoverageAudience): CoverageBoard {
  const { deal } = inputs;
  const sellerAud = audience === "seller";
  const statusFacts = sellerAud ? inputs.sellerFacts : inputs.brokerFacts;
  const statusSession = sellerAud ? inputs.sellerSession : inputs.brokerSession;
  const confidence = confidenceOf(statusSession);
  const importance = getSectionImportance(deal);
  const outline = getInterviewOutline(deal);
  const adjustments = coverageAdjustmentsForDeal(deal);
  const coverage = buildSectionCoverage(statusFacts as any, confidence, importance, outline.excludedSections, adjustments);
  const readiness = computeCimReadiness(coverage);
  const docNames = new Map(inputs.documents.map((d) => [d.id, d.name]));
  const docName = (id: string) => docNames.get(id);
  const privacy = discrepancyPrivacy(inputs.documents);
  const marks = activeMarks(inputs.marks);
  const discrepancies = inputs.openDiscrepancies.filter((d) => OPEN_DISCREPANCY.has(d.status));
  const ledger = ledgerFlags(ledgerOf(statusSession));
  const evidence = evidenceByKey(deal, coverage, inputs.documents, statusFacts, inputs.sessionIds);
  const shape = boardShape(coverage, deal);

  // Seller-safe view for the screen audience's values.
  const sellerConfidence = confidenceOf(inputs.sellerSession);

  const sections: CoverageSection[] = [];
  const readKeyOwner = new Map<string, string>();
  for (const s of shape.sections) {
    const items: CoverageItem[] = [];
    for (const it of s.items) {
      const d = itemStatus(it, {
        facts: statusFacts,
        confidence,
        ledger,
        evidence,
        discrepancies,
        privacy,
        marks,
        audience,
        docName,
      });
      for (const k of it.readKeys) if (!readKeyOwner.has(k)) readKeyOwner.set(k, it.id);
      let item = d.item;
      const filing = inputs.sittingFilings?.[d.item.valueKey ?? ""];
      if (filing) item = { ...item, filedAt: filing.at, filedInSittingId: filing.sittingId, ...(filing.chunkId ? { filedByChunkId: filing.chunkId } : {}) };
      if (audience === "screen") item = screenItem(item, it, d, inputs.sellerFacts, sellerConfidence, docName);
      if (audience === "seller") item = sellerItem(item);
      items.push(item);
    }
    // dd's questions about the numbers: broker and screen only, never counted.
    let figureQuestions = 0;
    if (!sellerAud && s.coverage.key === "financials") {
      for (const fq of inputs.figureItems ?? []) {
        const keys = [fq.writeKey, ...fq.memberKeys.filter((k) => k !== fq.writeKey)];
        const filed = keys.find((k) => coverageValueText(statusFacts[k]) !== null);
        const value = filed ? coverageValueText(statusFacts[filed]) : null;
        const fqItem: CoverageItem = {
          id: `financials:${fq.writeKey}`,
          sectionKey: "financials",
          label: fq.label,
          members: [{ key: fq.writeKey, label: fq.label, writable: true }],
          readKeys: keys,
          valueKey: filed ?? null,
          critical: false,
          origin: "figures",
          status: filed ? "on_file" : "missing",
          reason: null,
          value: audience === "screen" ? null : value ? clip(value, VALUE_DISPLAY_MAX) : null,
          source: null,
          ask: fq.ask,
          why: fq.why,
          marks: [],
        };
        if (!filed) figureQuestions += 1;
        items.push(fqItem);
      }
    }
    sections.push({
      key: s.coverage.key,
      title: s.coverage.title,
      order: s.coverage.order,
      importance: s.coverage.importance,
      importanceReason: s.coverage.importanceReason,
      items,
      references: sellerAud ? [] : s.references,
      counts: sectionCounts(items),
      figureQuestions,
    });
  }

  const totals = summarise(sections);
  const routed: RoutedQuestion[] = sellerAud
    ? []
    : discrepancies
        .filter((d) => d.status === "ask_seller" && !(d.factKey && readKeyOwner.has(d.factKey)))
        .map((d) => {
          const p = privacy(d);
          const raw = d.field || (d.factKey ? fieldLabel(d.factKey) : "A figure to check");
          const label = PRIVATE_MATERIAL_RE.test(raw) || (audience === "screen" && (p.privateA || p.privateB)) ? (d.factKey ? fieldLabel(d.factKey) : "A figure to check") : raw;
          const asked = marks.find((m) => m.itemId === `routed:${d.id}` && m.kind === "asked");
          return {
            discrepancyId: d.id,
            label,
            ask: `Two figures on file for ${lowerFirst(label)} don't match — which one is right, and why?`,
            ...(asked ? { raisedInSitting: { at: toIso(asked.createdAt) } } : {}),
          };
        });
  const documentsNeeded: DocumentNeeded[] = sellerAud
    ? []
    : inputs.requirements
        .filter((r) => r.status === "missing" || r.status === "unavailable")
        .map((r) => ({
          requirementId: r.id,
          name: r.documentName,
          required: !!r.isRequired,
          sellerSaysNoCopy: r.status === "unavailable",
          ...(r.source === "buyer_request" ? { buyerAsked: true } : {}),
          ...(r.neededBy ? { neededBy: toIso(r.neededBy) } : {}),
          promised: marks.some((m) => m.itemId === `doc:${r.id}` && m.kind === "doc_promised"),
        }));

  const board: CoverageBoard = {
    dealId: deal.id,
    audience,
    generatedAt: (inputs.now ?? new Date()).toISOString(),
    version: boardVersion(sections),
    sections,
    totals,
    percentCollected: percentCollected(totals),
    quality: audience === "broker" ? { label: readiness.label, score: readiness.score, summary: readiness.summary } : { label: readiness.label },
    routed,
    documents: documentsNeeded,
    plan: planState(deal),
  };
  if (audience === "broker") board.removed = removedOf(deal, coverage);
  return board;
}

/** What the broker took off the checklist (broker audience only). */
function removedOf(deal: Deal, coverage: SectionCoverage[]): NonNullable<CoverageBoard["removed"]> {
  const outline = getInterviewOutline(deal);
  const adjustments = coverageAdjustmentsForDeal({ ...deal, interviewOutline: { ...outline, removedItems: [] } } as Deal);
  const labels = new Map<string, { label: string; sectionKey: string }>();
  for (const s of CIM_SECTIONS) {
    for (const g of SECTION_FIELD_GROUPS[s.key] ?? []) for (const k of g.keys) if (!labels.has(k)) labels.set(k, { label: fieldLabel(k), sectionKey: s.key });
    for (const x of adjustments.add?.[s.key] ?? []) if (!labels.has(x.key)) labels.set(x.key, { label: x.label, sectionKey: s.key });
  }
  void coverage;
  return {
    items: (outline.removedItems ?? []).map((k) => ({ key: k, label: labels.get(k)?.label ?? fieldLabel(k), sectionKey: labels.get(k)?.sectionKey ?? "" })),
    sections: outline.excludedSections.map((k) => ({ key: k, title: CIM_SECTIONS.find((s) => s.key === k)?.title ?? k })),
  };
}

/**
 * "Seller can see this screen": the broker's status, but every value, source
 * and reason from the seller-safe view. Money talk (add-backs, SDE, adjusted
 * earnings) shows neither value nor reason; a value the seller-safe view
 * doesn't hold reads "On file — private to you".
 */
function screenItem(
  item: CoverageItem,
  shape: ItemShape,
  d: Draft,
  sellerFacts: Record<string, unknown>,
  sellerConfidence: Record<string, string> | undefined,
  docName: (id: string) => string | undefined,
): CoverageItem {
  // Money talk: the add-backs item, or a value under the broker's own
  // computations (SDE, adjusted earnings, a peg) — never shown or explained.
  const moneyTalk = shape.members.some((m) => ADDBACK_KEY_RE.test(m.key)) || (!!item.valueKey && BROKER_WORK_KEY_RE.test(item.valueKey));
  const sellerBest = bestValue(shape, sellerFacts, sellerConfidence);
  const sellerSrc = sellerBest ? getFieldSources(sellerFacts)[sellerBest.key] : undefined;
  const marks = item.marks.filter((m) => m.kind !== "note").map(({ note: _n, ...m }) => m as CoverageItemMark);
  const out: CoverageItem = { ...item, marks, source: null, value: null };
  delete out.suggestion;
  if (moneyTalk) {
    out.moneyTalk = true;
    out.reason = null;
    return out;
  }
  // The reason, with nothing private in it.
  out.reason = screenReason(item.reason, sellerBest?.text ?? null);
  if (item.status === "missing") return out;
  if (!d.fullValue) return out;
  if (!sellerBest || sellerBest.lead) {
    out.privateValue = true;
    return out;
  }
  out.value = clip(sellerBest.text, VALUE_DISPLAY_MAX);
  out.valueKey = sellerBest.key;
  out.source = sourceLabelFor(sellerSrc, docName);
  // (The seller's own words from a session together were said aloud to the broker — shown;
  // any other source's wording is not.)
  if (out.source && !sellerSrc?.sittingId) delete out.source.excerpt;
  return out;
}

function screenReason(reason: CoverageReason | null, sellerValue: string | null): CoverageReason | null {
  if (!reason) return null;
  switch (reason.code) {
    case "conflict":
      return reason.privateSide ? { code: "conflict", privateSide: true } : reason;
    case "not_known": {
      // Who holds it — only when the seller-safe value says so.
      const who = sellerValue && isNotKnownValue(sellerValue) ? whoHoldsTheAnswer(sellerValue) : "";
      return { code: "not_known", ...(who ? { whoHasIt: who } : {}) };
    }
    case "in_source":
      return { code: "in_source", sourceLabel: "", private: true };
    default:
      return reason;
  }
}

/** The seller audience: statuses only — no values, sources, reasons, asks or notes; broker-added labels hidden. */
function sellerItem(item: CoverageItem): CoverageItem {
  const hidden = item.origin === "broker" || item.origin === "noted";
  return {
    id: item.id,
    sectionKey: item.sectionKey,
    label: hidden ? "" : item.label,
    members: [],
    readKeys: [],
    valueKey: null,
    critical: item.critical,
    origin: item.origin,
    status: item.status,
    reason: null,
    value: null,
    source: null,
    ask: "",
    why: "",
    marks: item.marks.filter((m) => m.kind === "confirmed" || m.kind === "not_known").map((m) => ({ kind: m.kind, at: m.at })),
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Popover detail
// ─────────────────────────────────────────────────────────────────────────

export function itemDetail(inputs: CoverageInputs, audience: Exclude<CoverageAudience, "seller">, itemId: string): CoverageItemDetail | null {
  const board = boardFromCoverage(inputs, audience);
  const item = board.sections.flatMap((s) => s.items).find((i) => i.id === itemId);
  if (!item) return null;
  const facts = audience === "broker" ? inputs.brokerFacts : inputs.sellerFacts;
  const docNames = new Map(inputs.documents.map((d) => [d.id, d.name]));
  const altsAll = getFieldAlternates(facts);
  const alts = item.valueKey && !item.moneyTalk && !item.privateValue ? altsAll[item.valueKey] ?? [] : [];
  const otherValues = alts
    .filter((a) => audience === "broker" || !LEAD_KINDS.has(String(a.source)))
    .slice(0, 3)
    .map((a) => ({ value: clip(String(a.value), 200), source: describeSource(a, (id) => docNames.get(id)) }));
  const members = item.members.map((m) => ({ key: m.key, label: m.label, writable: m.writable, onFile: coverageValueText(facts[m.key]) !== null }));
  const note = audience === "broker" ? item.marks.find((m) => m.kind === "note")?.note ?? null : null;
  const full = item.valueKey && item.value ? coverageValueText(facts[item.valueKey]) : null;
  return { item, otherValues, members, note, fullValue: item.privateValue || item.moneyTalk ? null : full };
}

// ─────────────────────────────────────────────────────────────────────────
// Loading
// ─────────────────────────────────────────────────────────────────────────

export interface CoverageLoaders {
  documentsMeta(dealId: string): Promise<CoverageDoc[]>;
  sessionsMeta(dealId: string): Promise<CoverageSessionMeta[]>;
  discrepancies(dealId: string): Promise<Discrepancy[]>;
  resolvedDiscrepancies(dealId: string): Promise<Discrepancy[]>;
  marks(dealId: string): Promise<CoverageMarkLike[]>;
  requirements(dealId: string): Promise<CoverageInputs["requirements"]>;
  figureItems(dealId: string): Promise<ExplainBoardItem[]>;
  brokerFacts(deal: Deal): Record<string, unknown>;
}

async function defaultDocumentsMeta(dealId: string): Promise<CoverageDoc[]> {
  const { db } = await import("../db");
  return db
    .select({
      id: documentsTable.id,
      name: documentsTable.name,
      visibility: documentsTable.visibility,
      sourceKind: documentsTable.sourceKind,
      sourceMeta: documentsTable.sourceMeta,
      createdAt: documentsTable.createdAt,
      category: documentsTable.category,
      subcategory: documentsTable.subcategory,
      status: documentsTable.status,
    })
    .from(documentsTable)
    .where(eq(documentsTable.dealId, dealId))
    .orderBy(desc(documentsTable.createdAt)) as Promise<CoverageDoc[]>;
}

async function defaultSessionsMeta(dealId: string): Promise<CoverageSessionMeta[]> {
  const { db } = await import("../db");
  return db
    .select({
      id: interviewSessions.id,
      status: interviewSessions.status,
      lastActivityAt: interviewSessions.lastActivityAt,
      startedAt: interviewSessions.startedAt,
      extractedInfo: interviewSessions.extractedInfo,
    })
    .from(interviewSessions)
    .where(eq(interviewSessions.dealId, dealId))
    .orderBy(desc(interviewSessions.lastActivityAt));
}

/** The deal's active coverage marks (one small indexed query — server/together/marks.ts). */
export async function loadActiveMarks(dealId: string): Promise<CoverageMarkRow[]> {
  const { activeMarks } = await import("../together/marks");
  return activeMarks(dealId);
}

export const defaultCoverageLoaders: CoverageLoaders = {
  documentsMeta: defaultDocumentsMeta,
  sessionsMeta: defaultSessionsMeta,
  discrepancies: async (dealId) => {
    const { storage } = await import("../storage");
    return (await storage.getDiscrepanciesByDeal(dealId)).filter((d) => OPEN_DISCREPANCY.has(d.status));
  },
  resolvedDiscrepancies: async (dealId) => {
    const { storage } = await import("../storage");
    return storage.getResolvedDiscrepancies(dealId);
  },
  marks: loadActiveMarks,
  requirements: async (dealId) => {
    const { storage } = await import("../storage");
    return storage.getDocumentRequirementsByDeal(dealId);
  },
  figureItems: async (dealId) => {
    const { loadFigureBoardItems } = await import("../together/figure-board");
    return loadFigureBoardItems(dealId);
  },
  brokerFacts: (deal) => ((brokerFactsView(deal).extractedInfo as Record<string, unknown> | null) || {}),
};

/** Everything the board reads for a deal (metadata only — never extracted text). */
export async function loadCoverageInputs(deal: Deal, loaders: Partial<CoverageLoaders> = {}): Promise<CoverageInputs> {
  const L = { ...defaultCoverageLoaders, ...loaders };
  const [documents, sessions, discrepancies, resolved, marks, requirements, figureItems] = await Promise.all([
    L.documentsMeta(deal.id),
    L.sessionsMeta(deal.id),
    L.discrepancies(deal.id),
    L.resolvedDiscrepancies(deal.id),
    L.marks(deal.id).catch(() => [] as CoverageMarkLike[]),
    L.requirements(deal.id).catch(() => [] as CoverageInputs["requirements"]),
    L.figureItems(deal.id).catch(() => [] as ExplainBoardItem[]),
  ]);
  return coverageInputsFrom({ deal, documents, sessions, openDiscrepancies: discrepancies, resolvedDiscrepancies: resolved, marks, requirements, figureItems, brokerFacts: L.brokerFacts(deal) });
}

/** Inputs from what a caller already loaded (the seller progress route). Pure. */
export function coverageInputsFrom(args: {
  deal: Deal;
  documents: CoverageDoc[];
  sessions: CoverageSessionMeta[];
  openDiscrepancies: Discrepancy[];
  resolvedDiscrepancies: Discrepancy[];
  marks: CoverageMarkLike[];
  requirements?: CoverageInputs["requirements"];
  figureItems?: ExplainBoardItem[];
  brokerFacts: Record<string, unknown>;
  sittingFilings?: Record<string, SittingFiling>;
  now?: Date;
}): CoverageInputs {
  const sorted = [...args.sessions].sort((a, b) => new Date(String(b.lastActivityAt ?? 0)).getTime() - new Date(String(a.lastActivityAt ?? 0)).getTime());
  return {
    deal: args.deal,
    documents: args.documents,
    brokerFacts: args.brokerFacts,
    sellerFacts: sellerCoverageFacts(args.deal, args.documents, args.resolvedDiscrepancies),
    brokerSession: sorted[0] ?? null,
    sellerSession: contextSessions(sorted)[0] ?? null,
    sessionIds: sorted.map((s) => s.id),
    openDiscrepancies: args.openDiscrepancies.filter((d) => OPEN_DISCREPANCY.has(d.status)),
    marks: args.marks,
    requirements: args.requirements ?? [],
    figureItems: args.figureItems ?? [],
    sittingFilings: args.sittingFilings ?? sittingFilingsFrom(args.brokerFacts),
    ...(args.now ? { now: args.now } : {}),
  };
}

/**
 * Keys a session together wrote (the broker's call notes now; live capture's
 * chunks add their ids in pass 3): the value's source carries the sitting.
 * Drives "Filed this session", "Just filed" and the end summary. Pure.
 */
export function sittingFilingsFrom(facts: Record<string, unknown>): Record<string, SittingFiling> {
  const out: Record<string, SittingFiling> = {};
  for (const [key, src] of Object.entries(getFieldSources(facts))) {
    const sittingId = (src as { sittingId?: unknown }).sittingId;
    if (typeof sittingId !== "string" || !sittingId) continue;
    const chunkId = (src as { chunkId?: unknown }).chunkId;
    out[key] = { at: String(src.at ?? ""), sittingId, ...(typeof chunkId === "string" && chunkId ? { chunkId } : {}) };
  }
  return out;
}

export async function buildCoverageBoard(deal: Deal, opts: { audience: CoverageAudience }, loaders: Partial<CoverageLoaders> = {}): Promise<CoverageBoard> {
  return boardFromCoverage(await loadCoverageInputs(deal, loaders), opts.audience);
}

/**
 * The seller-side summary an interview turn returns (the seller's header):
 * built from what the turn already loaded — the knowledge base's
 * seller-safe facts and the session's confidence and ledger — plus the
 * deal's marks (one small query, made by the caller).
 */
export function sellerSummaryFromTurn(args: {
  deal: Deal;
  documents: CoverageDoc[];
  /** withHeldFacts(kb.extractedInfo) — the turn's coverage view. */
  coverageView: Record<string, unknown>;
  confidence: Record<string, string> | undefined;
  ledger: unknown;
  openDiscrepancies: Discrepancy[];
  marks: CoverageMarkLike[];
  sessionIds?: string[];
}): CoverageSummary {
  const session: CoverageSessionMeta = { id: "turn", extractedInfo: { _confidenceLevels: args.confidence, _deferralLedger: args.ledger } };
  const board = boardFromCoverage(
    {
      deal: args.deal,
      documents: args.documents,
      brokerFacts: {},
      sellerFacts: args.coverageView,
      brokerSession: null,
      sellerSession: session,
      ...(args.sessionIds ? { sessionIds: args.sessionIds } : {}),
      openDiscrepancies: args.openDiscrepancies,
      marks: args.marks,
      requirements: [],
    },
    "seller",
  );
  return summaryOf(board);
}

/**
 * Keys whose value the broker confirmed (an active "confirmed" mark whose
 * hash still matches the value) — read by the interview (§7.6): their guard
 * ledger entries read as resolved and the fact reads as confirmed. The
 * mark's note holds the key it confirmed.
 */
export function confirmedKeys(marks: CoverageMarkLike[], facts: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const m of activeMarks(marks)) {
    if (m.kind !== "confirmed" || !m.note || !m.valueHash) continue;
    const text = coverageValueText(facts[m.note]);
    if (text !== null && valueHash(text) === m.valueHash) out.push(m.note);
  }
  return out;
}

/** Active marks of a deal, failing soft (the interview never fails on them). */
export async function activeMarksForDeal(dealId: string): Promise<CoverageMarkLike[]> {
  try {
    return await loadActiveMarks(dealId);
  } catch {
    return [];
  }
}

