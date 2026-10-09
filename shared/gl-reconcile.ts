/**
 * gl-reconcile.ts — does what was ticked add up to the add-back? (gl spec
 * §7.5, §4.1). Pure; the server stores the result on each trace
 * (gl_addback_traces.computed) and the seller's page uses the same rules
 * for its reconcile bar the moment a box is ticked.
 *
 * Per fiscal year:
 *   target   = the claim, or claim ÷ share for a portion (half of meals
 *              is added back → the entries are the WHOLE meals cost)
 *   found    = |Σ confirmed ledger entries| (net — a refund offsets)
 *   document = Σ amounts typed against supporting documents (a T4)
 *   diff     = found + document − target
 *
 *   found          |diff| ≤ max(2% of target, $250)
 *   close          |diff| ≤ 15% of target
 *   short / over   otherwise
 *   document       a supporting document carries the year (within 15%)
 *   not_started    nothing confirmed yet
 *   not_in_ledger  the seller said so, or no ledger covers the year
 *   statement      comes straight from the financial statements (proof "statement")
 *   left_out       the broker left the year out (or it isn't a full year)
 *
 * Totals and statuses are always worked out here, never taken from a model.
 */
import type { GlCostSummary, GlTraceComputed, GlYearStatus } from "./gl-types";

export const FOUND_TOLERANCE = 0.02;
export const FOUND_FLOOR_CENTS = 25_000;
export const CLOSE_TOLERANCE = 0.15;

export type GlProof = "ledger" | "payroll" | "one_off" | "statement";

/** A link as reconciliation needs it (a ledger entry or a supporting document). */
export interface ReconcileLink {
  fiscalYear: string;
  state: string; // proposed | confirmed | rejected | orphaned
  amountCents: number;
  ledgerId: string | null;
  documentId: string | null;
  docAmountCheck?: string | null;
  confidence?: string | null;
  account?: string | null;
}

export interface ReconcileTraceInput {
  proof: GlProof | string;
  sharePct: number | null;
  claims: Record<string, number>;
  leftOut: { years: string[]; reason: string } | null;
  notInLedger: { reason: string; at: string; years?: string[] } | null;
}

export interface ReconcileContext {
  /** Fiscal years some ready ledger (in this audience) covers. */
  ledgerYears: ReadonlySet<string>;
  /** Any ready ledger exists in this audience (no ledger at all = "not started", not "not in this ledger"). */
  hasLedger: boolean;
  /** Ledgers that count for this audience; links to any other ledger are ignored. null = every ledger. */
  countedLedgerIds?: ReadonlySet<string> | null;
  /** Broker-audience ledgers (for the broker's `privateOnly` flag). */
  brokerOnlyLedgerIds?: ReadonlySet<string>;
  /** Documents that count for this audience (null = every document). */
  countedDocumentIds?: ReadonlySet<string> | null;
}

/** The whole cost a portion is taken from (claim ÷ share), in cents. */
export function targetCents(claimCents: number, sharePct: number | null | undefined): number {
  const pct = Number(sharePct);
  if (!Number.isFinite(pct) || pct <= 0 || pct >= 100) return claimCents;
  return Math.round(claimCents / (pct / 100));
}

/** found / close / short / over for a supported amount against a target (pure). */
export function amountStatus(supportedCents: number, target: number): "found" | "close" | "short" | "over" {
  const diff = supportedCents - target;
  const abs = Math.abs(diff);
  const t = Math.abs(target);
  if (abs <= Math.max(t * FOUND_TOLERANCE, FOUND_FLOOR_CENTS)) return "found";
  if (abs <= t * CLOSE_TOLERANCE) return "close";
  return diff < 0 ? "short" : "over";
}

export type GlYearComputed = GlTraceComputed["byYear"][string];

const counts = (l: ReconcileLink, ctx: ReconcileContext) =>
  l.ledgerId ? !ctx.countedLedgerIds || ctx.countedLedgerIds.has(l.ledgerId) : l.documentId ? !ctx.countedDocumentIds || ctx.countedDocumentIds.has(l.documentId) : false;

/** One fiscal year of one add-back (pure). */
export function reconcileYear(trace: ReconcileTraceInput, year: string, links: ReconcileLink[], ctx: ReconcileContext): GlYearComputed {
  const claimedCents = Math.round(Number(trace.claims[year] ?? 0));
  const target = targetCents(claimedCents, trace.sharePct);
  const mine = links.filter((l) => l.fiscalYear === year && counts(l, ctx));
  const confirmedEntries = mine.filter((l) => l.ledgerId && l.state === "confirmed");
  const confirmedDocs = mine.filter((l) => l.documentId && l.state === "confirmed");
  const proposed = mine.filter((l) => l.ledgerId && l.state === "proposed").length;
  const foundCents = Math.abs(confirmedEntries.reduce((s, l) => s + Number(l.amountCents || 0), 0));
  const documentCents = confirmedDocs.reduce((s, l) => s + Math.abs(Number(l.amountCents || 0)), 0);
  const diffCents = foundCents + documentCents - target;
  const privateOnly =
    confirmedEntries.length > 0 && !!ctx.brokerOnlyLedgerIds && confirmedEntries.every((l) => ctx.brokerOnlyLedgerIds!.has(l.ledgerId!));
  const base = { claimedCents, targetCents: target, foundCents, documentCents, diffCents, confirmed: confirmedEntries.length + confirmedDocs.length, proposed, privateOnly };

  if (trace.proof === "statement") return { ...base, status: "statement" };
  if (trace.leftOut?.years?.includes(year)) return { ...base, status: "left_out", reason: trace.leftOut.reason };

  const nothing = confirmedEntries.length === 0 && confirmedDocs.length === 0;
  if (nothing) {
    const sellerSaidNo = !!trace.notInLedger && (!trace.notInLedger.years || trace.notInLedger.years.length === 0 || trace.notInLedger.years.includes(year));
    if (sellerSaidNo) return { ...base, status: "not_in_ledger", reason: `seller_${trace.notInLedger!.reason}` };
    if (ctx.hasLedger && !ctx.ledgerYears.has(year)) return { ...base, status: "not_in_ledger", reason: "not_in_this_ledger" };
    return { ...base, status: "not_started" };
  }

  const amount = amountStatus(foundCents + documentCents, target);
  if (confirmedDocs.length > 0 && documentCents > 0 && (amount === "found" || amount === "close")) {
    // A document carries the year. Only a document whose typed amount was seen on it counts
    // without the broker's look ("Check the document" otherwise).
    const unchecked = confirmedDocs.some((l) => l.docAmountCheck !== "found_in_document");
    // When the ledger entries alone already add up, the year is found in the books.
    if (foundCents > 0 && amountStatus(foundCents, target) === "found") return { ...base, status: "found" };
    return { ...base, status: "document", ...(unchecked ? { reason: "check_document" } : {}) };
  }
  return { ...base, status: amount };
}

/** The order "worst first" for an add-back's overall status (§7.5). */
const RANK: Record<GlYearStatus, number> = {
  not_started: 0, not_in_ledger: 1, short: 2, over: 2, document: 3, close: 4, found: 5, statement: 6, left_out: 7,
};

/** The worst year that isn't left out (statement when every year is from the statements). */
export function overallStatus(byYear: Record<string, Pick<GlYearComputed, "status">>): GlYearStatus {
  const ys = Object.values(byYear).map((y) => y.status);
  if (ys.length === 0) return "not_started";
  const counted = ys.filter((s) => s !== "left_out");
  if (counted.length === 0) return "left_out";
  return counted.reduce((worst, s) => (RANK[s] < RANK[worst] ? s : worst), counted[0]);
}

/** The verdict pre-selected for "Mark reviewed" (§7.5). */
export function suggestedVerdict(byYear: Record<string, Pick<GlYearComputed, "status" | "confirmed" | "reason">>): "found" | "partly_found" | "not_found" {
  const ys = Object.values(byYear).filter((y) => y.status !== "left_out" && y.status !== "statement");
  if (ys.length === 0) return "found";
  const good = (y: (typeof ys)[number]) => y.status === "found" || y.status === "close" || (y.status === "document" && y.reason !== "check_document");
  if (ys.every(good)) return "found";
  if (ys.some((y) => y.confirmed > 0)) return "partly_found";
  return "not_found";
}

/** Every claimed fiscal year of an add-back, oldest first (left-out labels without a key aren't years). */
export function claimedYears(trace: Pick<ReconcileTraceInput, "claims">): string[] {
  return Object.keys(trace.claims ?? {}).filter((y) => /^\d{4}$/.test(y)).sort();
}

/** The whole add-back (pure). `summary` comes from the matcher (match.ts costSummary) — passed through. */
export function reconcileTrace(
  trace: ReconcileTraceInput,
  links: ReconcileLink[],
  ctx: ReconcileContext,
  summary: GlCostSummary | null = null,
  now: Date = new Date(),
): GlTraceComputed {
  const byYear: GlTraceComputed["byYear"] = {};
  for (const y of claimedYears(trace)) byYear[y] = reconcileYear(trace, y, links, ctx);
  return { byYear, overall: overallStatus(byYear), suggestedVerdict: suggestedVerdict(byYear), summary, updatedAt: now.toISOString() };
}

/** The seller's reconcile bar words, live as boxes are ticked (§3.3 C). */
export function reconcileWords(foundCents: number, target: number): { status: "found" | "close" | "short" | "over"; words: string } {
  const status = amountStatus(foundCents, target);
  const diff = foundCents - target;
  const money = (c: number) => `$${Math.round(Math.abs(c) / 100).toLocaleString("en-US")}`;
  if (status === "found") return { status, words: "Adds up" };
  if (status === "close") return { status, words: diff < 0 ? `Close — ${money(diff)} short` : `Close — ${money(diff)} over` };
  if (status === "short") return { status, words: `${money(diff)} short` };
  return { status, words: `${money(diff)} more than the cost` };
}
