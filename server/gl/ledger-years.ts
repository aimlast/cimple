/**
 * ledger-years.ts — each ledger's per-fiscal-year summary (gl_ledgers.years)
 * worked out again from its entries, after the deal's fiscal-year end
 * changed and the entries moved years (D26).
 */
import type { GlLedger } from "@shared/schema";
import type { GlYearSummary } from "@shared/gl-types";
import { glStore } from "./store";

export async function recomputeLedgerYears(dealId: string, fye: string): Promise<void> {
  const store = glStore();
  const sums = await store.ledgerYearSummaries(dealId);
  const byLedger = new Map<string, Record<string, GlYearSummary>>();
  for (const s of sums) {
    const y = byLedger.get(s.ledgerId) ?? {};
    y[s.fiscalYear] = { lines: s.lines, debitCents: s.debitCents, creditCents: s.creditCents, accounts: s.accounts, firstDate: s.firstDate, lastDate: s.lastDate };
    byLedger.set(s.ledgerId, y);
  }
  for (const l of await store.listLedgers(dealId)) {
    if (l.status !== "ready") continue;
    await store.updateLedger(l.id, { years: byLedger.get(l.id) ?? {}, fiscalYearEndUsed: fye } as Partial<GlLedger>);
  }
}
