/**
 * analysis-edit.ts — "Use what the ledger shows" (gl spec §6.10), and the
 * financial-analysis PATCH it goes through.
 *
 *   saveBrokerAnalysisEdit(existing, body)   the body of PATCH
 *       /api/deals/:dealId/financial-analysis/:id, factored out with no
 *       behaviour change (applyBrokerAnalysisEdit → save) so a change made
 *       here runs exactly like a Normalization-tab edit: broker decisions
 *       marked, EBITDA/SDE recomputed and dated (stampEarningsChange), the
 *       earnings canon, CIM staleness, per-section approvals, the kept copy.
 *   ledgerAmountImpact(...)                  the dry run the confirmation
 *       dialog shows: the add-back's old → new amount, adjusted EBITDA and
 *       SDE before → after, the CIM pages that show a figure that changes,
 *       and whether live buyers keep the current copy.
 * Not for owner pay ("Change owner pay on the Normalization tab").
 */
import { storage } from "../storage";
import type { FinancialAnalysis, GlAddbackTrace } from "@shared/schema";
import { addbackKeyFor } from "@shared/gl-copy";
import { targetCents } from "@shared/gl-reconcile";

/** The PATCH's body, as a function (no behaviour change). */
export async function saveBrokerAnalysisEdit(existing: FinancialAnalysis, body: Record<string, unknown>) {
  const { applyBrokerAnalysisEdit } = await import("../financial/broker-edit");
  const updates = applyBrokerAnalysisEdit(existing as Record<string, any>, body ?? {}, new Date());
  return storage.updateFinancialAnalysis(existing.id, updates);
}

export interface LedgerAmountImpact {
  addback: { label: string; year: string; from: number; to: number };
  adjustedEbitda: { from: number | null; to: number | null };
  sde: { from: number | null; to: number | null };
  sections: Array<{ id: string; title: string }>;
  liveBuyersKeepCopy: boolean;
}

export class LedgerAmountError extends Error {
  constructor(message: string, readonly status = 409) {
    super(message);
  }
}

/** Every string and number inside a section's served content. */
function figuresIn(value: unknown, out: number[] = [], depth = 0): number[] {
  if (depth > 12 || value == null) return out;
  if (typeof value === "number" && Number.isFinite(value)) out.push(value);
  else if (typeof value === "string") {
    for (const m of Array.from(value.matchAll(/\$?\s?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)\s?(k|K|m|M|million|thousand)?\b/g))) {
      const n = Number(m[1].replace(/,/g, ""));
      const scale = !m[2] ? 1 : /^k|thousand/i.test(m[2]) ? 1e3 : 1e6;
      if (Number.isFinite(n)) out.push(n * scale);
    }
  } else if (Array.isArray(value)) for (const v of value) figuresIn(v, out, depth + 1);
  else if (typeof value === "object") for (const v of Object.values(value as Record<string, unknown>)) figuresIn(v, out, depth + 1);
  return out;
}

const near = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * 0.0005) || (Math.abs(b) >= 10_000 && Math.abs(a - Math.round(b / 1000) * 1000) < 1 && Math.abs(a - b) < 500);

/** The analysis's new normalization with the add-back's year set to what the ledger shows, and the impact (no write). */
export async function ledgerAmountImpact(dealId: string, trace: GlAddbackTrace, year: string): Promise<{ impact: LedgerAmountImpact; analysis: FinancialAnalysis; normalization: Record<string, any> }> {
  if (trace.proof === "payroll" || trace.category === "owner_comp") throw new LedgerAmountError("Change owner pay on the Normalization tab.");
  if (trace.proof === "statement") throw new LedgerAmountError("This add-back comes straight from the financial statements.");
  const y = (trace.computed as any)?.byYear?.[year] as { foundCents: number; documentCents: number } | undefined;
  if (!y || y.foundCents + y.documentCents <= 0) throw new LedgerAmountError(`Nothing is ticked for ${year} yet.`);
  const { pickAnalysisForCim } = await import("../cim/cim-financials");
  const { normalizeFinancialAnalysisRow } = await import("../financial/shape");
  const { withCanonicalEarnings } = await import("../financial/normalization-rules");
  const picked = pickAnalysisForCim(await storage.getFinancialAnalysesByDeal(dealId)) as FinancialAnalysis | null;
  if (!picked) throw new LedgerAmountError("Run the financial analysis first.");
  const a = normalizeFinancialAnalysisRow(picked as Record<string, any>) as FinancialAnalysis;
  const norm = JSON.parse(JSON.stringify(a.normalization ?? null)) as Record<string, any> | null;
  if (!norm || !Array.isArray(norm.addbacks)) throw new LedgerAmountError("The analysis has no add-backs.");
  const label = ((trace.yearLabels as Record<string, string> | null) ?? {})[year] ?? year;
  const ab = norm.addbacks.find((x: any) => !x.ownerCompPart && addbackKeyFor(x.label) === trace.addbackKey);
  if (!ab) throw new LedgerAmountError("This add-back isn't in the analysis any more.", 404);
  const from = Number(ab.amounts?.[label] ?? 0);
  // A portion: the share of what the ledger shows (half of $22,000 of meals → $11,000).
  const foundDollars = (y.foundCents + y.documentCents) / 100;
  const pct = trace.sharePct && trace.sharePct > 0 && trace.sharePct < 100 ? trace.sharePct : 100;
  const to = Math.round((foundDollars * pct) / 100);
  void targetCents;
  if (Math.round(from) === to) throw new LedgerAmountError("The add-back already matches what the ledger shows.");
  const before = withCanonicalEarnings(a.normalization as any) as any;
  ab.amounts = { ...(ab.amounts ?? {}), [label]: to };
  const after = withCanonicalEarnings(norm as any) as any;
  const fromE = before?.computed?.adjustedEbitda?.[label] ?? null;
  const toE = after?.computed?.adjustedEbitda?.[label] ?? null;
  const fromS = before?.computed?.sde?.[label] ?? null;
  const toS = after?.computed?.sde?.[label] ?? null;
  const watch = [from, fromE, fromS].filter((n): n is number => typeof n === "number" && n !== 0);
  const sections = (await storage.getCimSectionsByDeal(dealId))
    .filter((s: any) => s.isVisible !== false)
    .filter((s: any) => {
      const figs = figuresIn([s.layoutData, s.brokerEditedContent, s.aiDraftContent]);
      return watch.some((w) => figs.some((f) => near(f, w)));
    })
    .map((s: any) => ({ id: s.id, title: s.sectionTitle }));
  const deal = await storage.getDeal(dealId);
  return {
    analysis: picked,
    normalization: norm,
    impact: {
      addback: { label: trace.label, year: label, from, to },
      adjustedEbitda: { from: fromE, to: toE },
      sde: { from: fromS, to: toS },
      sections,
      liveBuyersKeepCopy: !!deal?.isLive,
    },
  };
}
