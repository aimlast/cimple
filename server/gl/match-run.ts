/**
 * match-run.ts — proposals for every add-back that needs proof, and each
 * add-back's reconciliation (gl spec §7.2, §7.5).
 *
 * proposeForTraces(dealId, traceIds | null, { ai }) under the GL lock:
 * every non-statement, not-removed add-back (sent or not) × each claimed
 * year a ready ledger covers. Skipped when nothing it depends on changed
 * (proposalFingerprint). Only `proposed` links are replaced — a seller's or
 * broker's confirmed or rejected entry is never touched or proposed again.
 * The rules cost $0; when they aren't confident on a SENT add-back and an
 * AI ranker is installed (pass 3, with its daily budgets), it is queued.
 *
 * recomputeTraces(dealId, ids) writes each add-back's `computed` (the
 * broker's view: every ledger counts, private ones flagged) and the
 * seller's "We found these in your books" summary (seller-visible entries
 * only).
 */
import { createHash } from "node:crypto";
import type { GlAddbackTrace, GlTraceLink, InsertGlTraceLink } from "@shared/schema";
import { claimedYears, reconcileTrace, targetCents } from "@shared/gl-reconcile";
import { glStore } from "./store";
import { withGlLock } from "./lock";
import { loadGlContext, brokerReconcileCtx, ownerNamesText, type GlDealContext } from "./context";
import {
  costSummary, entryKey, hintWords, personsIn, proposeYear, termsFor, wholeAccountCandidates,
  type AccountYearTotal, type MatchContext, type MatchEntry, type MatchTrace, type Person,
} from "./match";
import type { AccountClass } from "./tie-out";

export type AiMode = "none" | "broker" | "seller";

/** The AI ranking step (pass 3 installs it, with its budgets). Called for sent add-backs the rules left unconfident. */
export type GlRanker = (args: { dealId: string; traceId: string; years: string[]; ai: Exclude<AiMode, "none"> }) => Promise<void>;
let ranker: GlRanker | null = null;
export function setGlRanker(fn: GlRanker | null): void {
  ranker = fn;
}

const PERIODS = [1, 2, 4, 12, 24, 26, 52];

function asMatchTrace(t: GlAddbackTrace): MatchTrace {
  return { id: t.id, label: t.label, category: t.category, proof: t.proof, sellerHint: t.sellerHint, sharePct: t.sharePct, claims: (t.claims as Record<string, number>) ?? {} };
}

/** The years an add-back is looked for in: claimed, not left out, covered by a ready ledger. */
export function yearsToPropose(t: GlAddbackTrace, yearsAll: ReadonlySet<string>): string[] {
  const left = (t.leftOut as { years?: string[] } | null)?.years ?? [];
  return claimedYears({ claims: (t.claims as Record<string, number>) ?? {} }).filter((y) => !left.includes(y) && yearsAll.has(y));
}

function fingerprintFor(t: GlAddbackTrace, c: GlDealContext, decided: string[], usedElsewhere: string[]): string {
  return createHash("sha1")
    .update(JSON.stringify({
      v: 1,
      claims: t.claims, share: t.sharePct, label: t.label, hint: t.sellerHint, proof: t.proof, left: t.leftOut,
      ledgers: c.ready.map((l) => [l.id, l.rowCount, l.duplicateCount]).sort(), fye: c.fye,
      decided: decided.sort(), elsewhere: usedElsewhere.sort(), classes: c.tracing.accountClasses ?? {},
    }))
    .digest("hex")
    .slice(0, 24);
}

/** People an add-back is about: named in its label; for owner pay with no name, the owner(s) the facts name. */
export function personsFor(t: Pick<GlAddbackTrace, "label" | "category" | "proof">, ownerText: string): Person[] {
  const own = personsIn(t.label);
  if (own.length > 0) return own;
  if (t.category === "owner_comp") return personsIn(ownerText).slice(0, 3);
  return [];
}

function snapshotRow(dealId: string, traceId: string, e: MatchEntry, confidence: string, reason: string): InsertGlTraceLink {
  return {
    traceId, dealId, fiscalYear: e.fiscalYear, ledgerId: e.ledgerId, rowNo: e.rowNo,
    txnDate: e.txnDate, account: e.account, name: e.name, memo: e.memo, amountCents: e.amountCents,
    state: "proposed", proposedBy: "rules", confidence, reason,
  } as InsertGlTraceLink;
}

/** The proposal run, without taking the lock (callers inside withGlLock). */
export async function proposeUnlocked(
  dealId: string,
  traceIds: string[] | null,
  opts: { ai: AiMode; force?: boolean } = { ai: "none" },
  ctx?: GlDealContext,
): Promise<{ proposed: string[]; unconfident: string[] }> {
  const c = ctx ?? (await loadGlContext(dealId));
  const store = glStore();
  const all = await store.listTraces(dealId);
  const live = all.filter((t) => !t.removedAt);
  const targets = live.filter((t) => t.proof !== "statement" && (!traceIds || traceIds.includes(t.id)));
  if (targets.length === 0) return { proposed: [], unconfident: [] };
  const links = await store.linksOfDeal(dealId);
  const byTrace = new Map<string, GlTraceLink[]>();
  for (const k of links) byTrace.set(k.traceId, [...(byTrace.get(k.traceId) ?? []), k]);
  const labelOf = new Map(live.map((t) => [t.id, t.sellerLabel]));

  const totals = c.ready.length ? await store.dealAccountTotals(dealId, Array.from(c.readyIds)) : [];
  const totalsByYear = new Map<string, AccountYearTotal[]>();
  for (const a of totals) totalsByYear.set(a.fiscalYear, [...(totalsByYear.get(a.fiscalYear) ?? []), a]);
  const distinct = new Map(totals.map((a) => [a.accountKey, a]));
  const numberedChart = distinct.size > 0 && Array.from(distinct.values()).filter((a) => a.accountNumber).length / distinct.size >= 0.6;
  const ownerText = ownerNamesText(c.deal);

  const proposed: string[] = [];
  const unconfident: string[] = [];
  for (const t of targets) {
    const mine = byTrace.get(t.id) ?? [];
    const decided = mine.filter((k) => k.ledgerId && (k.state === "confirmed" || k.state === "rejected")).map((k) => `${entryKey(k)}:${k.state}`);
    const usedElsewhereMap = new Map<string, string>();
    for (const k of links) {
      if (k.traceId !== t.id && k.ledgerId && k.state === "confirmed" && labelOf.has(k.traceId)) usedElsewhereMap.set(entryKey(k), labelOf.get(k.traceId)!);
    }
    const fp = fingerprintFor(t, c, decided, Array.from(usedElsewhereMap.keys()));
    if (!opts.force && t.proposalFingerprint === fp) continue;
    const mt = asMatchTrace(t);
    const persons = personsFor(t, ownerText);
    const mctx: MatchContext = {
      persons,
      confirmedAccounts: new Set(mine.filter((k) => k.state === "confirmed" && k.ledgerId && k.account).map((k) => (k.account ?? "").toLowerCase())),
      usedElsewhere: usedElsewhereMap,
      rejected: new Set(mine.filter((k) => k.state === "rejected" && k.ledgerId).map(entryKey)),
      classOverrides: (c.tracing.accountClasses ?? {}) as Record<string, AccountClass>,
      numberedChart,
    };
    // Confirmed entries' account keys (the snapshot keeps the account's name; its key is recomputed the same way).
    const confirmedKeys = new Set<string>();
    for (const k of mine.filter((x) => x.state === "confirmed" && x.ledgerId)) {
      const row = totals.find((a) => a.account === k.account);
      if (row) confirmedKeys.add(row.accountKey);
    }
    mctx.confirmedAccounts = confirmedKeys;

    const years = yearsToPropose(t, c.yearsAll);
    const rows: InsertGlTraceLink[] = [];
    let allConfident = years.length > 0;
    const terms = termsFor(mt);
    const extra = [...hintWords(mt.sellerHint, terms), ...persons.map((p) => p.last)];
    for (const y of years) {
      const target = targetCents(Number(mt.claims[y] ?? 0), mt.sharePct);
      const amounts = target ? PERIODS.map((p) => Math.round(Math.abs(target) / p)) : [];
      const candidates = await store.candidateRows({
        dealId, fiscalYear: y, ledgerIds: Array.from(c.readyIds), accountKeys: Array.from(confirmedKeys), terms: [...terms, ...extra], amounts, limit: 3000,
      });
      const wholes = wholeAccountCandidates(mt, y, totalsByYear.get(y) ?? [], mctx);
      const whole = wholes[0] ? { account: wholes[0], rows: (await store.accountRows(dealId, Array.from(c.readyIds), y, [wholes[0].accountKey])) as MatchEntry[] } : null;
      const r = proposeYear(mt, y, candidates as MatchEntry[], mctx, whole);
      if (!r.confident) allConfident = false;
      for (const p of r.proposals) rows.push(snapshotRow(dealId, t.id, p.entry, p.confidence, p.reason));
    }
    await store.replaceProposals(t.id, claimedYears({ claims: mt.claims }), rows);
    await store.updateTrace(t.id, { proposalFingerprint: fp } as Partial<GlAddbackTrace>);
    proposed.push(t.id);
    if (!allConfident && years.length > 0) {
      unconfident.push(t.id);
      if (ranker && opts.ai !== "none" && t.sentAt) {
        const fn = ranker;
        void fn({ dealId, traceId: t.id, years, ai: opts.ai }).catch((err) => console.warn(`[gl] AI ranking for ${t.id} failed:`, err));
      }
    }
  }
  if (proposed.length) await recomputeTraces(dealId, proposed, c);
  return { proposed, unconfident };
}

/** Proposals under the GL lock. */
export function proposeForTraces(dealId: string, traceIds: string[] | null, opts: { ai: AiMode; force?: boolean } = { ai: "none" }) {
  return withGlLock(dealId, () => proposeUnlocked(dealId, traceIds, opts));
}

/** Each add-back's reconciliation (broker view) + the seller's summary. No lock needed (one write per add-back). */
export async function recomputeTraces(dealId: string, traceIds: string[] | null = null, ctx?: GlDealContext): Promise<void> {
  const c = ctx ?? (await loadGlContext(dealId));
  const store = glStore();
  const [traces, links] = await Promise.all([store.listTraces(dealId), store.linksOfDeal(dealId)]);
  const rctx = brokerReconcileCtx(c);
  for (const t of traces) {
    if (t.removedAt || (traceIds && !traceIds.includes(t.id))) continue;
    const mine = links.filter((k) => k.traceId === t.id && k.state !== "orphaned");
    const input = {
      proof: t.proof,
      sharePct: t.sharePct,
      claims: (t.claims as Record<string, number>) ?? {},
      leftOut: (t.leftOut as { years: string[]; reason: string } | null) ?? null,
      notInLedger: (t.notInLedger as any) ?? null,
    };
    const summary = costSummary({ ...input, leftOut: input.leftOut }, mine, c.yearsSeller, c.sellerLedgerIds);
    const computed = reconcileTrace(input, mine, rctx, summary);
    await store.updateTrace(t.id, { computed } as Partial<GlAddbackTrace>);
  }
}
