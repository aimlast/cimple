/**
 * traces.ts — the add-backs the broker kept, as things to find in the books
 * (gl spec §6.5). One gl_addback_traces row per add-back, keyed by its
 * normalised label: the analysis gives its add-backs new ids on every run,
 * the broker's decisions carry by label (analyzer.ts carryForwardNormalization),
 * and so do traces.
 *
 *   planTraces(normalization, existing, opts)  pure: what to create / change / remove
 *   syncTraces(dealId)                         under the GL lock; skipped when the
 *                                              analysis and fiscal-year end haven't changed
 *
 * Per add-back:
 *   proof        ledger (default) · payroll (owner and family pay: pay slips
 *                first) · one_off (the entry + the invoice or letter) ·
 *                statement (amortization, interest, income taxes — nothing
 *                to find; the DD page cites the statements)
 *   claims       fiscal year → cents (owner pay: the owner's ACTUAL pay —
 *                the excess and market-salary halves are one line)
 *   sellerLabel  a plain name for the seller ("Your pay as owner",
 *                "Meals & entertainment") — never how it is treated
 *   sellerHint   what the seller is looking for ("Restaurant and
 *                entertainment charges")
 *   share        a portion (half of meals): the entries are the WHOLE cost
 *
 * The broker's own edits (proof, the seller's label and hint, the share, the
 * buyers' reason) are never overwritten by a re-sync.
 */
import { createHash } from "node:crypto";
import type { GlAddbackTrace, InsertGlAddbackTrace } from "@shared/schema";
import { fiscalYearKey } from "@shared/fiscal-year";
import { isDistributionLine } from "../financial/normalization-rules";
import { personsIn } from "./match";
import { screenForBuyers } from "./screen";
import { addbackKeyFor, payDocWords, type PayCountry } from "@shared/gl-copy";

/** The analysis add-back as traces read it (server/financial/shape.ts UiAddback). */
export interface NormAddback {
  id: string;
  label: string;
  description?: string;
  category: string;
  amounts: Record<string, number>;
  approved: boolean;
  approvedOverride?: boolean;
  privateEvidence?: boolean;
  ownerCompPart?: "excess" | "market";
  ownerActualComp?: Record<string, number>;
}
export interface NormLike {
  years?: string[];
  addbacks?: NormAddback[];
}

export type GlProof = "ledger" | "payroll" | "one_off" | "statement";

const baseLabel = (label: string) => label.replace(/\s+—\s+market salary$/i, "").trim();
/** One rule with the client (shared/gl-copy addbackKeyFor). */
export const addbackKeyOf = (label: string) => addbackKeyFor(label);

export const INTERIM_LEFT_OUT_REASON = "Year-to-date figures can't be matched to a full year of the ledger";
export const REOPENED_AMOUNT = "Your broker updated this amount — please check the entries still fit.";
export const REOPENED_COST = "Your broker updated this cost — please check the entries still fit.";

// ── Which add-backs are traced ───────────────────────────────────────────

/** An add-back the analysis counts: approved, and a private-only one only on the broker's own approval (addback-seed.ts countsAsAddback). */
export function countsAsAddback(a: Pick<NormAddback, "approved" | "privateEvidence" | "approvedOverride"> | null | undefined): boolean {
  return !!a && a.approved === true && (!a.privateEvidence || a.approvedOverride === true);
}

/** Dividends and distributions are never add-backs (normalization-rules isDistributionLine). */
const isDistribution = (a: NormAddback) => isDistributionLine({ label: a.label, amounts: a.amounts, description: a.description });

export interface TraceCandidate {
  addbackKey: string;
  analysisAddbackId: string;
  label: string;
  category: string;
  description: string;
  ownerPay: boolean;
  privateEvidence: boolean;
  /** The analysis's year label → dollars. */
  amounts: Record<string, number>;
}

/** The add-backs to trace, owner-pay pairs merged at the owner's actual pay (pure; addback-seed.ts rules). */
export function traceCandidates(norm: NormLike | null | undefined): TraceCandidate[] {
  const all = Array.isArray(norm?.addbacks) ? norm!.addbacks! : [];
  const out: TraceCandidate[] = [];
  const merged = new Set<NormAddback>();
  for (const a of all) {
    if (!a || merged.has(a)) continue;
    if (a.ownerCompPart) {
      const excess = a.ownerCompPart === "excess" ? a : all.find((x) => x.ownerCompPart === "excess" && `${x.id}_market` === a.id);
      const market = a.ownerCompPart === "market" ? a : all.find((x) => x.ownerCompPart === "market" && x.id === `${a.id}_market`);
      const parts = [excess, market].filter((x): x is NormAddback => !!x);
      parts.forEach((x) => merged.add(x));
      if (!parts.some(countsAsAddback)) continue;
      const actual = excess?.ownerActualComp && Object.keys(excess.ownerActualComp).length > 0
        ? excess.ownerActualComp
        : Object.fromEntries(Array.from(new Set(parts.flatMap((x) => Object.keys(x.amounts ?? {})))).map((y) => [y, parts.reduce((s, x) => s + (Number(x.amounts?.[y]) || 0), 0)]));
      const head = excess ?? a;
      out.push({
        addbackKey: addbackKeyOf(head.label),
        analysisAddbackId: head.id,
        label: baseLabel(head.label),
        category: "owner_comp",
        description: head.description ?? "",
        ownerPay: true,
        privateEvidence: parts.some((x) => !!x.privateEvidence),
        amounts: Object.fromEntries(Object.entries(actual).map(([y, v]) => [y, Number(v)])),
      });
      continue;
    }
    if (!countsAsAddback(a) || isDistribution(a)) continue;
    out.push({
      addbackKey: addbackKeyOf(a.label),
      analysisAddbackId: a.id,
      label: (a.label ?? "").trim(),
      category: a.category || "other",
      description: a.description ?? "",
      ownerPay: a.category === "owner_comp",
      privateEvidence: !!a.privateEvidence,
      amounts: a.amounts ?? {},
    });
  }
  // One trace per key (a label repeated in an analysis is one cost).
  const byKey = new Map<string, TraceCandidate>();
  for (const c of out) if (c.addbackKey && !byKey.has(c.addbackKey)) byKey.set(c.addbackKey, c);
  return Array.from(byKey.values());
}

// ── Per add-back rules ───────────────────────────────────────────────────

const STATEMENT_WORDS = /\b(depreciation|amorti[sz]ation|interest|income tax(?:es)?)\b/i;
const PAY_WORDS = /\b(salary|salaries|wages?|pay|compensation|remuneration)\b/i;
const RELATED_WORDS = /\b(related[\s-]party|spouse|wife|husband|son|daughter|family|relative)\b/i;
const ONE_OFF_WORDS = /\b(one[\s-]?time|non[\s-]?recurring|settlement|severance)\b/i;

/** What proof to ask for (D4). */
export function proofFor(a: Pick<TraceCandidate, "label" | "category" | "ownerPay">): GlProof {
  const cat = a.category || "other";
  if (cat === "non_cash") return "statement";
  if ((cat === "other" || cat === "non_cash") && STATEMENT_WORDS.test(a.label)) return "statement";
  if (a.ownerPay || cat === "owner_comp") return "payroll";
  if (PAY_WORDS.test(a.label) && (RELATED_WORDS.test(a.label) || personsIn(a.label).length > 0)) return "payroll";
  if (cat === "one_time" || cat === "non_recurring" || ONE_OFF_WORDS.test(a.label)) return "one_off";
  return "ledger";
}

/** A portion added back ("Meals & entertainment (50% personal use estimate)" → 50, the owner's estimate). */
export function shareFor(a: Pick<TraceCandidate, "label" | "description" | "category">, useDescription = false): { pct: number; basis: "estimate" } | null {
  if (a.category === "owner_comp") return null;
  const fromLabel = a.label.match(/(\d{1,3})\s*%/);
  const m = fromLabel ?? (useDescription ? (a.description ?? "").match(/(\d{1,3})\s*%\s*(?:personal|discretionary|of (?:the )?(?:cost|total))/i) : null);
  if (!m) return null;
  const pct = Number(m[1]);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return null;
  return { pct, basis: "estimate" };
}

const TREATMENT_PAREN = /\s*\(([^)]*)\)/g;
const TREATMENT_WORDS = /%|estimate|one[\s-]?time|non[\s-]?recurring|personal use|discretionary|normali[sz]|add[\s-]?back|recast|portion|share|excess/i;

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The seller's name for the cost (§6.5) — no treatment words. */
export function sellerLabelFor(a: Pick<TraceCandidate, "label" | "category" | "ownerPay">, proof: GlProof): string {
  if (a.ownerPay || a.category === "owner_comp") return "Your pay as owner";
  if (proof === "payroll") {
    const p = personsIn(a.label)[0];
    if (p) return `${titleCase(p.first)} ${titleCase(p.last)}'s pay`;
    return RELATED_WORDS.test(a.label) ? "Your family member's pay" : "Pay";
  }
  let label = a.label.trim();
  const parens = Array.from(label.matchAll(TREATMENT_PAREN)).map((m) => m[1]);
  label = label.replace(TREATMENT_PAREN, (m, inner: string) => (TREATMENT_WORDS.test(inner) ? "" : m)).trim();
  label = label.replace(/^excess\s+/i, "").trim();
  // "Insurance (owner life insurance)" → "Owner life insurance": the parenthetical names the cost better.
  const lastWord = label.replace(/\([^)]*\)/g, "").trim().split(/\s+/).pop()?.toLowerCase() ?? "";
  const descriptive = parens.find((p) => !TREATMENT_WORDS.test(p) && lastWord && p.toLowerCase().includes(lastWord));
  if (descriptive) label = titleCase(descriptive.trim());
  label = label.replace(/\s+[-–—]\s*$/, "").replace(/\s{2,}/g, " ").trim();
  return titleCase(label || a.label.trim()).slice(0, 120);
}

/** What the seller is looking for (§6.5). */
export function sellerHintFor(a: Pick<TraceCandidate, "label" | "category" | "ownerPay">, proof: GlProof, country: PayCountry = null): string {
  const l = a.label.toLowerCase();
  const pay = payDocWords(country);
  if (proof === "payroll") {
    if (a.ownerPay || a.category === "owner_comp") return `Your ${pay.slips === "year-end payroll summary" ? "year-end payroll summary" : `${pay.slips} or year-end payroll summary`}`;
    const p = personsIn(a.label)[0];
    const who = p ? `${titleCase(p.first)}'s` : "Their";
    return `${who} ${pay.slips === "year-end payroll summary" ? "year-end payroll summary" : `${pay.slips} or year-end payroll summary`}`;
  }
  if (proof === "one_off") return "The payment, and the letter or invoice";
  if (/\b(vehicle|auto|car|truck|fuel|lease)\b/.test(l)) return "Fuel, insurance, lease or loan payments and repairs for the vehicle(s)";
  if (/\b(meal|meals|entertain\w*|restaurant)\b/.test(l)) return "Restaurant and entertainment charges";
  if (/\binsurance\b/.test(l)) return "The premium payments for this policy";
  if (/\b(golf|club|membership|dues)\b/.test(l)) return "Membership dues and club charges";
  if (/\bconsult\w*/.test(l)) return "The consultant's invoices";
  return "The entries that make up this cost";
}

/** Claims by fiscal year (cents), the analysis's own labels kept, and labels that aren't one full year. */
export function claimsOf(amounts: Record<string, number>): { claims: Record<string, number>; yearLabels: Record<string, string>; interim: string[] } {
  const claims: Record<string, number> = {};
  const yearLabels: Record<string, string> = {};
  const interim: string[] = [];
  for (const [label, v] of Object.entries(amounts ?? {})) {
    const n = Number(v);
    if (!Number.isFinite(n) || n === 0) continue;
    const key = fiscalYearKey(label);
    if (!key) {
      interim.push(label);
      continue;
    }
    claims[key] = (claims[key] ?? 0) + Math.round(n * 100);
    yearLabels[key] = label;
  }
  return { claims, yearLabels, interim };
}

// ── The plan ─────────────────────────────────────────────────────────────

export interface PlanOptions {
  info?: Record<string, unknown> | null;
  country?: PayCountry;
  analysisId?: string | null;
  now?: Date;
}

export interface TracePlan {
  inserts: Array<InsertGlAddbackTrace & { dealId?: string; addbackKey: string }>;
  updates: Array<{ id: string; patch: Partial<GlAddbackTrace>; reopened: boolean; matchingChanged: boolean }>;
  removed: string[];
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The share the label alone would give (to tell a broker's edit from the automatic one). */
const autoShare = (label: string) => shareFor({ label, description: "", category: "" });

/**
 * What a sync changes (pure). Analysis-owned fields follow the analysis;
 * the broker's edits stay; a sent cost the seller had finished whose amount,
 * share or name changed is reopened for them.
 */
export function planTraces(norm: NormLike | null | undefined, existing: GlAddbackTrace[], opts: PlanOptions = {}): TracePlan {
  const plan: TracePlan = { inserts: [], updates: [], removed: [] };
  const byKey = new Map(existing.map((t) => [t.addbackKey, t]));
  const seen = new Set<string>();
  for (const c of traceCandidates(norm)) {
    seen.add(c.addbackKey);
    const { claims, yearLabels, interim } = claimsOf(c.amounts);
    const ex = byKey.get(c.addbackKey);
    const autoProof = proofFor(c);
    if (!ex) {
      const share = shareFor(c, true);
      const reason = screenForBuyers(c.description, opts.info ?? null);
      plan.inserts.push({
        addbackKey: c.addbackKey,
        analysisId: opts.analysisId ?? null,
        analysisAddbackId: c.analysisAddbackId,
        label: c.label,
        category: c.category,
        proof: autoProof,
        sharePct: autoProof === "statement" || autoProof === "payroll" ? null : share?.pct ?? null,
        shareBasis: autoProof === "statement" || autoProof === "payroll" ? null : share ? "estimate" : null,
        claims,
        yearLabels,
        sellerLabel: sellerLabelFor(c, autoProof),
        sellerHint: autoProof === "statement" ? null : sellerHintFor(c, autoProof, opts.country ?? null),
        privateEvidence: c.privateEvidence,
        buyerReason: reason,
        leftOut: interim.length ? { years: interim, reason: INTERIM_LEFT_OUT_REASON } : null,
      } as any);
      continue;
    }
    const proof = (ex.proofByBroker ? ex.proof : autoProof) as GlProof;
    const prevAuto = { category: ex.category ?? "other", label: ex.label, ownerPay: ex.category === "owner_comp" };
    const prevProof = (ex.proofByBroker ? proofFor(prevAuto) : ex.proof) as GlProof;
    const patch: Partial<GlAddbackTrace> = {};
    if (ex.analysisId !== (opts.analysisId ?? null)) patch.analysisId = opts.analysisId ?? null;
    if (ex.analysisAddbackId !== c.analysisAddbackId) patch.analysisAddbackId = c.analysisAddbackId;
    if (ex.label !== c.label) patch.label = c.label;
    if (ex.category !== c.category) patch.category = c.category;
    if (!ex.proofByBroker && ex.proof !== autoProof) patch.proof = autoProof;
    if (!sameJson(ex.claims, claims)) patch.claims = claims;
    if (!sameJson(ex.yearLabels, yearLabels)) patch.yearLabels = yearLabels;
    if (ex.privateEvidence !== c.privateEvidence) patch.privateEvidence = c.privateEvidence;
    if (ex.removedAt) patch.removedAt = null;
    // The seller's label and hint follow the analysis unless the broker wrote their own.
    const brokerLabel = ex.sellerLabel !== sellerLabelFor(prevAuto, prevProof);
    if (!brokerLabel) {
      const next = sellerLabelFor(c, proof);
      if (next !== ex.sellerLabel) patch.sellerLabel = next;
    }
    const brokerHint = (ex.sellerHint ?? null) !== (prevProof === "statement" ? null : sellerHintFor(prevAuto, prevProof, opts.country ?? null));
    if (!brokerHint) {
      const next = proof === "statement" ? null : sellerHintFor(c, proof, opts.country ?? null);
      if (next !== (ex.sellerHint ?? null)) patch.sellerHint = next;
    }
    // The share: kept when the broker set it (documented, or not what the old label said).
    const prevShare = autoShare(ex.label);
    const brokerShare = ex.shareBasis === "documented" || (ex.sharePct ?? null) !== (prevShare?.pct ?? null);
    if (!brokerShare && proof !== "statement" && proof !== "payroll") {
      const next = autoShare(c.label);
      if ((next?.pct ?? null) !== (ex.sharePct ?? null)) {
        patch.sharePct = next?.pct ?? null;
        patch.shareBasis = next ? "estimate" : null;
      }
    }
    if (ex.buyerReason === null || ex.buyerReason === undefined) {
      const reason = screenForBuyers(c.description, opts.info ?? null);
      if (reason) patch.buyerReason = reason;
    }
    // Labels that aren't a full year are left out automatically; the broker's own left-out years stay.
    const autoLeft = ex.leftOut?.reason === INTERIM_LEFT_OUT_REASON;
    if (interim.length) {
      const nextLeft = autoLeft || !ex.leftOut
        ? { years: interim, reason: INTERIM_LEFT_OUT_REASON }
        : { years: Array.from(new Set([...ex.leftOut.years, ...interim])), reason: ex.leftOut.reason };
      if (!sameJson(ex.leftOut, nextLeft)) patch.leftOut = nextLeft;
    } else if (autoLeft) {
      patch.leftOut = null;
    }
    const amountChanged = "claims" in patch || "sharePct" in patch;
    const nameChanged = "sellerLabel" in patch;
    const reopened = !!ex.sentAt && ex.sellerStatus === "done" && (amountChanged || nameChanged);
    if (reopened) {
      patch.sellerStatus = "in_progress";
      patch.reopenedNote = amountChanged ? REOPENED_AMOUNT : REOPENED_COST;
    }
    // The broker's review was of the old amount.
    if (amountChanged && ex.reviewedAt) patch.reviewedAt = null;
    const matchingChanged = amountChanged || "proof" in patch || "label" in patch || "sellerHint" in patch || "removedAt" in patch;
    if (Object.keys(patch).length > 0) plan.updates.push({ id: ex.id, patch, reopened, matchingChanged });
  }
  for (const t of existing) {
    if (!seen.has(t.addbackKey) && !t.removedAt) plan.removed.push(t.id);
  }
  return plan;
}

// ── IO ───────────────────────────────────────────────────────────────────

/** The fingerprint that lets an identical sync be skipped. */
export function syncFingerprint(analysis: { id: string; updatedAt?: unknown } | null, fye: string): string {
  const at = analysis?.updatedAt ? new Date(analysis.updatedAt as string).toISOString() : "";
  return createHash("sha1").update(`${analysis?.id ?? "none"}|${at}|${fye}`).digest("hex").slice(0, 20);
}
