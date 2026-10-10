/**
 * seller-view.ts — exactly what the seller's books page may show (gl spec
 * §9.1). A WHITELIST: per cost its seller label, hint, proof, share in words,
 * claimed amount per year, status and found amount; the seller's own notes;
 * the broker's question. Never the analysis label, category, description,
 * the buyers' reason, the broker's note or verdict, private-evidence or
 * unsent add-backs, market salary, SDE/EBITDA, or any ledger private to the
 * broker. Pure (the route loads, this shapes).
 */
import type { GlAddbackTrace, GlTracing, GlTraceLink } from "@shared/schema";
import type { GlLedgerView, GlCostSummary, GlYearStatus } from "@shared/gl-types";
import { reconcileTrace, targetCents, type ReconcileContext } from "@shared/gl-reconcile";
import { payDocWords, sellerChipWords, type PayCountry } from "@shared/gl-copy";
import { costSummary } from "./match";
import { glAssistantState } from "./rank-ai";

export type SellerGlState =
  | "not_requested" | "requested" | "in_progress" | "question" | "reopened" | "waiting_for_accountant" | "waiting_for_broker" | "withdrawn" | "done";

export interface SellerCostYear {
  year: string;
  yearLabel: string;
  claimedCents: number;
  /** What the entries should add up to (the whole cost for a portion). */
  targetCents: number;
  status: GlYearStatus;
  foundCents: number;
  documentCents: number;
  diffCents: number;
  chip: string;
  /** The seller's ledger covers this year. */
  inLedger: boolean;
}

export interface SellerCost {
  id: string;
  sellerLabel: string;
  sellerHint: string | null;
  proof: "ledger" | "payroll" | "one_off";
  /** "Your broker counts half of it as personal." — never the treatment. */
  shareWords: string | null;
  years: SellerCostYear[];
  summary: GlCostSummary | null;
  sellerStatus: string;
  reopenedNote: string | null;
  question: { text: string; askedAt: string; answer: string | null } | null;
  note: string | null;
  notInLedger: string | null;
  /** Cimple's assistant is looking for more entries for this cost right now (the card says so; nothing else about the assistant reaches the seller). */
  assistantLooking: boolean;
}

export interface SellerBooksView {
  state: SellerGlState;
  total: number;
  done: number;
  message: string | null;
  costs: SellerCost[];
  confirmation: { at: string; name: string | null } | null;
  accountant: { name: string; status: "pending" | "sent" | "declined" } | null;
  cantGetLedger: { reason: string } | null;
  otherCosts: Array<{ id: string; text: string; at: string; entries: number }>;
  payDoc: { slips: string; short: string; box: string | null };
}

const SHARE_WORDS: Record<number, string> = { 50: "half", 25: "a quarter", 75: "three quarters", 33: "a third", 67: "two thirds" };
export function shareWords(pct: number | null | undefined): string | null {
  if (!pct || pct <= 0 || pct >= 100) return null;
  return `Your broker counts ${SHARE_WORDS[pct] ?? `${pct}%`} of it as personal.`;
}

const DONE_STATUSES = new Set(["done", "not_in_ledger", "disputed"]);

/** The costs the seller sees: sent, not removed, not from the statements, not private evidence unless the broker sent it. */
export function sellerVisibleTraces(traces: GlAddbackTrace[]): GlAddbackTrace[] {
  return traces.filter((t) => !!t.sentAt && !t.removedAt && t.proof !== "statement");
}

/** Where the seller is in the step (drives the progress card). Pure. */
export function sellerGlState(
  tracing: Pick<GlTracing, "requestedAt" | "withdrawnAt" | "sellerDoneAt" | "accountantRequest" | "reviewedAt"> | null | undefined,
  costs: Array<Pick<GlAddbackTrace, "sellerStatus" | "reopenedNote" | "question" | "reviewedAt">>,
  hasSellerLedger: boolean,
): SellerGlState {
  if (!tracing?.requestedAt) return "not_requested";
  if (tracing.withdrawnAt) return "withdrawn";
  if (costs.length > 0 && costs.every((c) => !!c.reviewedAt)) return "done";
  if (costs.some((c) => c.question && !(c.question as { answer?: string }).answer)) return "question";
  if (costs.some((c) => c.reopenedNote && c.sellerStatus !== "done")) return "reopened";
  const acc = tracing.accountantRequest as { sentAt?: string; declinedAt?: string } | null;
  if (acc && !acc.declinedAt && !hasSellerLedger && !tracing.sellerDoneAt) return "waiting_for_accountant";
  if (tracing.sellerDoneAt) return "waiting_for_broker";
  if (costs.some((c) => c.sellerStatus !== "not_started")) return "in_progress";
  return "requested";
}

export interface SellerViewInput {
  tracing: GlTracing;
  traces: GlAddbackTrace[];
  links: GlTraceLink[];
  ctx: ReconcileContext;
  sellerLedgerYears: ReadonlySet<string>;
  sellerLedgerIds: ReadonlySet<string>;
  country: PayCountry;
}

/** The whitelist (pure). */
export function sellerBooksView(input: SellerViewInput): SellerBooksView {
  const sent = sellerVisibleTraces(input.traces);
  const before = !input.tracing.requestedAt || !!input.tracing.withdrawnAt;
  const visible = before ? [] : sent;
  const pay = payDocWords(input.country);
  const costs: SellerCost[] = visible.map((t) => {
    const claims = (t.claims as Record<string, number>) ?? {};
    const mine = input.links.filter((k) => k.traceId === t.id && k.state !== "orphaned");
    const leftOut = (t.leftOut as { years: string[]; reason: string } | null) ?? null;
    const r = reconcileTrace({ proof: t.proof, sharePct: t.sharePct, claims, leftOut, notInLedger: (t.notInLedger as any) ?? null }, mine, input.ctx);
    const years: SellerCostYear[] = Object.entries(r.byYear)
      .filter(([, y]) => y.status !== "left_out" && y.status !== "statement")
      .map(([year, y]) => ({
        year,
        yearLabel: ((t.yearLabels as Record<string, string> | null) ?? {})[year] ?? year,
        claimedCents: y.claimedCents,
        targetCents: targetCents(y.claimedCents, t.sharePct),
        status: y.status,
        foundCents: y.foundCents,
        documentCents: y.documentCents,
        diffCents: y.diffCents,
        chip: sellerChipWords(year, y, pay.short === "payroll summary" ? "payroll summary" : pay.short),
        inLedger: input.sellerLedgerYears.has(year),
      }));
    const q = t.question as { text: string; askedAt: string; answer?: string } | null;
    const nil = t.notInLedger as { reason: string } | null;
    return {
      id: t.id,
      sellerLabel: t.sellerLabel,
      sellerHint: t.sellerHint,
      proof: (t.proof === "payroll" || t.proof === "one_off" ? t.proof : "ledger") as SellerCost["proof"],
      shareWords: shareWords(t.sharePct),
      years,
      summary: costSummary({ proof: t.proof, sharePct: t.sharePct, claims, leftOut }, mine, input.sellerLedgerYears, input.sellerLedgerIds),
      sellerStatus: t.sellerStatus,
      reopenedNote: t.sellerStatus === "done" ? null : t.reopenedNote,
      question: q ? { text: q.text, askedAt: q.askedAt, answer: q.answer ?? null } : null,
      note: t.sellerNote,
      notInLedger: nil?.reason ?? null,
      assistantLooking: glAssistantState(t.id)?.state === "looking",
    };
  });
  const acc = input.tracing.accountantRequest as { name: string; sentAt?: string; declinedAt?: string } | null;
  const conf = input.tracing.sellerConfirmation as { at: string; name: string | null } | null;
  const cant = input.tracing.cantGetLedger as { reason: string } | null;
  const suggestions = ((input.tracing.sellerSuggestions as Array<{ id: string; text: string; at: string; entries?: unknown[]; status: string }> | null) ?? []).filter((s) => s.status !== "dismissed");
  return {
    state: sellerGlState(input.tracing, visible, input.sellerLedgerIds.size > 0),
    total: costs.length,
    done: costs.filter((c) => DONE_STATUSES.has(c.sellerStatus)).length,
    message: before ? null : input.tracing.sellerMessage,
    costs,
    confirmation: conf ? { at: conf.at, name: conf.name } : null,
    accountant: acc ? { name: acc.name, status: acc.declinedAt ? "declined" : acc.sentAt ? "sent" : "pending" } : null,
    cantGetLedger: cant ? { reason: cant.reason } : null,
    otherCosts: suggestions.map((s) => ({ id: s.id, text: s.text, at: s.at, entries: Array.isArray(s.entries) ? s.entries.length : 0 })),
    payDoc: pay,
  };
}

/** The keys a seller-view cost may carry — the unit test checks nothing else leaks. */
export const SELLER_COST_KEYS = ["id", "sellerLabel", "sellerHint", "proof", "shareWords", "years", "summary", "sellerStatus", "reopenedNote", "question", "note", "notInLedger", "assistantLooking"] as const;

/** One row of the seller's entries list (only what the seller's own ledger shows). */
export function sellerEntry(t: { ledgerId: string; rowNo: number; txnDate: string; account: string; name: string | null; memo: string | null; amountCents: number; fiscalYear: string }) {
  return { ledgerId: t.ledgerId, rowNo: t.rowNo, date: t.txnDate, account: t.account, name: t.name, memo: t.memo, amountCents: t.amountCents, fiscalYear: t.fiscalYear };
}
