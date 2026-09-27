/**
 * A broker's edit of a financial analysis (PATCH /financial-analysis/:id),
 * turned into the row to save. Pure — the route loads and saves.
 *
 *  - Broker decisions are marked (a reclassified row, a toggled add-back, a
 *    chosen metric) so a re-run carries them forward (analyzer
 *    carryForwardBrokerEdits).
 *  - EBITDA / SDE are recomputed in code from the edited add-backs and dated
 *    when they move (cim-financials stampEarningsChange).
 *  - Everything computed from an edited table is computed again: a
 *    reclassified balance sheet reruns the working-capital rules (lines,
 *    year-end history, peg), so the CIM's NWC history and its peg keep
 *    tying — before, moving "Customer deposits" into current liabilities
 *    changed the history the CIM recomputes but left the stored peg and
 *    as-of NWC as they were. An add-back edit rewrites the notes and
 *    insights that state EBITDA/SDE so they state the new figures.
 */
import { normalizeFinancialAnalysisRow, type UiInsights, type UiNormalization, type UiReclassifiedTable, type UiWorkingCapital } from "./shape";
import {
  applyWorkingCapitalRules,
  clarifyOwnerPayAddbacks,
  earningsCorrections,
  earningsShiftCorrections,
  flagEarningsNotes,
  flagEarningsStatements,
  revenueByYear,
  withCanonicalEarnings,
} from "./normalization-rules";
import { stampEarningsChange } from "../cim/cim-financials";

export const BROKER_EDITABLE_FIELDS = [
  "brokerNotes", "normalization", "comps", "insights",
  "clarifyingQuestions", "reclassifiedPnl", "reclassifiedBalanceSheet",
  "reclassifiedCashFlow", "workingCapital",
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function applyBrokerAnalysisEdit(
  existing: Record<string, any>,
  body: Record<string, any>,
  now: Date = new Date(),
): Record<string, any> {
  const updates: Record<string, any> = {};
  for (const field of BROKER_EDITABLE_FIELDS) {
    if (body[field] !== undefined) updates[field] = body[field];
  }
  // Mark broker decisions so a re-run can carry them into the next version
  // (see financial/analyzer carryForwardBrokerEdits). The client sends whole
  // blobs; diffing against the stored row is the only place that knows
  // which change was the broker's rather than the AI's.
  const stored = normalizeFinancialAnalysisRow(existing);
  for (const tableField of ["reclassifiedPnl", "reclassifiedBalanceSheet", "reclassifiedCashFlow"] as const) {
    const incoming = updates[tableField];
    const prior = stored[tableField] as { rows?: Array<{ id: string; category: string; categoryOverride?: boolean }> } | null;
    if (!incoming || !Array.isArray(incoming.rows) || !prior?.rows) continue;
    const priorById = new Map(prior.rows.map((r) => [r.id, r]));
    incoming.rows = incoming.rows.map((row: any) => {
      if (!row || typeof row !== "object") return row;
      const before = priorById.get(row.id);
      if (before && (before.categoryOverride || before.category !== row.category)) {
        return { ...row, categoryOverride: true };
      }
      return row;
    });
  }
  if (updates.normalization && typeof updates.normalization === "object") {
    const incoming = updates.normalization as { metric?: string; metricOverride?: boolean; addbacks?: any[] };
    const prior = stored.normalization as { metric?: string; metricOverride?: boolean; addbacks?: Array<{ id: string; approved: boolean; approvedOverride?: boolean; custom?: boolean }> } | null;
    if (prior) {
      if (prior.metricOverride || (prior.metric && incoming.metric && prior.metric !== incoming.metric)) {
        incoming.metricOverride = true;
      }
      const priorById = new Map((prior.addbacks ?? []).map((a) => [a.id, a]));
      if (Array.isArray(incoming.addbacks)) {
        incoming.addbacks = incoming.addbacks.map((ab: any) => {
          if (!ab || typeof ab !== "object") return ab;
          const before = priorById.get(ab.id);
          const custom = ab.custom === true || before?.custom === true || (typeof ab.id === "string" && ab.id.startsWith("custom_"));
          const approvedOverride = before ? before.approvedOverride === true || before.approved !== ab.approved : false;
          return { ...ab, ...(custom ? { custom: true } : {}), ...(approvedOverride ? { approvedOverride: true } : {}) };
        });
      }
    }
  }

  // Working capital follows the balance sheet it is computed from — unless
  // the broker edited the working capital itself in the same save.
  if (updates.reclassifiedBalanceSheet !== undefined && updates.workingCapital === undefined && !same(updates.reclassifiedBalanceSheet, stored.reclassifiedBalanceSheet)) {
    const wc = stored.workingCapital as UiWorkingCapital | null;
    if (wc) updates.workingCapital = applyWorkingCapitalRules(wc, updates.reclassifiedBalanceSheet as UiReclassifiedTable);
  }

  // The figures stated in words follow the add-backs: notes and insights
  // are revised against the recomputed EBITDA / SDE (a re-flag also clears
  // a check the edit settled).
  const normalizationChanged = updates.normalization !== undefined && !same(updates.normalization, stored.normalization);
  const pnlChanged = updates.reclassifiedPnl !== undefined && !same(updates.reclassifiedPnl, stored.reclassifiedPnl);
  const revenue = revenueByYear((updates.reclassifiedPnl ?? stored.reclassifiedPnl) as UiReclassifiedTable | null);
  // What the notes and insights pin down, read once before either is revised,
  // and the analysis's own figures as they were before this edit moved them.
  const corrections = [
    ...earningsShiftCorrections(stored.normalization as UiNormalization | null, (updates.normalization ?? stored.normalization) as UiNormalization | null, revenue),
    ...earningsCorrections(
      withCanonicalEarnings((updates.normalization ?? stored.normalization) as UiNormalization | null),
      stored.insights as UiInsights | null,
      { revenue },
    ),
  ];
  if (updates.normalization && typeof updates.normalization === "object") {
    let n: UiNormalization | null = withCanonicalEarnings(updates.normalization as UiNormalization);
    if (normalizationChanged) {
      n = withCanonicalEarnings(flagEarningsNotes(n, { revenue, corrections }));
      const flagged = n;
      if (flagged && Array.isArray(flagged.notes)) n = { ...flagged, notes: flagged.notes.map((x) => clarifyOwnerPayAddbacks(x, flagged)) };
    }
    // Dated when those figures move: an earnings decision the broker made
    // before no longer overrules the bridge (cim/earnings-canon.ts).
    updates.normalization = stampEarningsChange(existing.normalization, n, now);
  }
  if ((normalizationChanged || pnlChanged) && updates.insights === undefined && stored.insights) {
    const n = (updates.normalization ?? stored.normalization) as UiNormalization | null;
    const { insights } = flagEarningsStatements(stored.insights as UiInsights, n, { revenue, corrections });
    if (insights && !same(insights, stored.insights)) updates.insights = insights;
  }

  if (body.brokerReviewed) {
    updates.brokerReviewedAt = now;
    updates.status = "reviewed";
  }
  return updates;
}
