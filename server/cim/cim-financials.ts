/**
 * cim-financials — the deal's financial analysis as the CIM writer must use it.
 *
 * Without this the writer rebuilt statements and EBITDA bridges from loose
 * facts and made up whatever didn't add up (Pacific, 2026-09-26: opex $26.5M
 * on $31M revenue, invented add-backs, a bridge forced to the headline
 * figure). The broker-reviewed analysis — or the latest completed one — is
 * rendered as an "AUTHORITATIVE FINANCIALS" block whose every total is
 * computed here, in code, from the analysis rows: the writer copies figures,
 * it never adds them up.
 *
 * Pure: no database, no AI. Consumers: layout-engine (knowledge base),
 * dd-enrichment (DD context), figure-check (the numbers it may accept).
 */
import type { FinancialAnalysis } from "@shared/schema";
import {
  computePnlNetIncome,
  normalizeFinancialAnalysisRow,
  type UiAddback,
  type UiNormalization,
  type UiReclassifiedTable,
  type UiWorkingCapital,
} from "../financial/shape";

type AnalysisLike = Pick<FinancialAnalysis, "id" | "version" | "status" | "brokerReviewedAt"> & {
  reclassifiedPnl?: unknown;
  normalization?: unknown;
  workingCapital?: unknown;
  reclassifiedBalanceSheet?: unknown;
};

/**
 * The analysis the CIM uses: the newest one the broker reviewed, else the
 * newest completed one. Draft, running and failed runs are never used.
 */
export function pickAnalysisForCim<T extends AnalysisLike>(analyses: T[] | null | undefined): T | null {
  const list = [...(analyses ?? [])].sort((a, b) => (b.version ?? 0) - (a.version ?? 0));
  const reviewed = list.find((a) => a.status === "reviewed" || (!!a.brokerReviewedAt && a.status === "completed"));
  if (reviewed) return reviewed;
  return list.find((a) => a.status === "completed") ?? null;
}

export interface CimPnlYear {
  revenue: number;
  cogs: number | null;
  grossProfit: number | null;
  /** Operating expenses including owner compensation. */
  operatingExpenses: number;
  ownerCompensation: number;
  nonRecurring: number;
  /** Revenue − COGS − operating expenses − non-recurring (before other income, D&A, interest, taxes). */
  ebitda: number;
  otherIncome: number;
  otherExpense: number;
  depreciation: number;
  interest: number;
  taxes: number;
  /** Net income as the statement rows compute it. */
  netIncomeFromRows: number | null;
  /** Net income as reported (the normalization's starting point). */
  netIncomeReported: number | null;
}

export interface CimBridgeLine {
  label: string;
  amounts: Record<string, number>;
}

export interface CimFinancials {
  analysisId: string;
  version: number;
  reviewed: boolean;
  years: string[];
  pnl: Record<string, CimPnlYear> | null;
  /** Statement line items by category (as reclassified). */
  lines: Array<{ category: string; name: string; values: Record<string, number> }>;
  bridge: {
    metric: "sde" | "ebitda";
    years: string[];
    netIncome: Record<string, number>;
    addbacks: CimBridgeLine[];
    adjusted: Record<string, number>;
    /**
     * SDE mode, when the add-backs split into EBITDA ones and SDE-only ones
     * (the owner's market salary): adjusted EBITDA, the bridge's subtotal
     * after the first `ebitdaLineCount` lines. Null otherwise.
     */
    adjustedEbitda?: Record<string, number> | null;
    ebitdaLineCount?: number;
    /** EBITDA mode: approved owner-specific (SDE-only) add-backs, and SDE with them. */
    sdeOnly: CimBridgeLine[];
    sde: Record<string, number> | null;
  } | null;
  workingCapital: UiWorkingCapital | null;
}

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

function pnlByYear(table: UiReclassifiedTable, reported: Record<string, number>): Record<string, CimPnlYear> {
  const computedNi = computePnlNetIncome(table);
  const out: Record<string, CimPnlYear> = {};
  for (const year of table.years) {
    const cat = (c: string) => {
      const vals = table.rows.filter((r) => r.category === c && typeof r.values?.[year] === "number").map((r) => r.values[year]);
      return { has: vals.length > 0, total: sum(vals) };
    };
    const revenue = cat("Revenue");
    if (!revenue.has) continue;
    const cogs = cat("COGS");
    const opex = cat("Operating Expenses");
    const owner = cat("Owner Compensation");
    const nonRec = cat("Non-Recurring");
    const abs = (x: { total: number }) => Math.abs(x.total);
    const cogsAbs = cogs.has ? abs(cogs) : null;
    const operatingExpenses = abs(opex) + abs(owner);
    out[year] = {
      revenue: revenue.total,
      cogs: cogsAbs,
      grossProfit: cogsAbs === null ? null : revenue.total - cogsAbs,
      operatingExpenses,
      ownerCompensation: abs(owner),
      nonRecurring: abs(nonRec),
      ebitda: revenue.total - (cogsAbs ?? 0) - operatingExpenses - abs(nonRec),
      otherIncome: cat("Other Income").total,
      otherExpense: abs(cat("Other Expense")),
      depreciation: abs(cat("Depreciation")),
      interest: abs(cat("Interest")),
      taxes: abs(cat("Taxes")),
      netIncomeFromRows: typeof computedNi[year] === "number" ? computedNi[year] : null,
      netIncomeReported: typeof reported[year] === "number" ? reported[year] : null,
    };
  }
  return out;
}

function bridgeOf(n: UiNormalization) {
  const metric = n.metric === "ebitda" ? "ebitda" : "sde";
  // An add-back that rests only on the broker's private notes reaches a
  // buyer-facing bridge only once the broker has approved it themselves.
  const approved = (n.addbacks ?? []).filter((a: UiAddback) => a.approved && (!a.privateEvidence || a.approvedOverride === true));
  // SDE mode lists the add-backs that count for adjusted EBITDA first, then
  // the SDE-only ones (the owner's market salary — financial analysis
  // convention: SDE = adjusted EBITDA + the market salary), so the bridge
  // passes through adjusted EBITDA on its way to SDE.
  const ebitdaLines = approved.filter((a) => a.type !== "sde");
  const sdeLines = approved.filter((a) => a.type === "sde");
  const applies = metric === "sde" ? [...ebitdaLines, ...sdeLines] : ebitdaLines;
  const sdeOnly = metric === "ebitda" ? sdeLines : [];
  const split = metric === "sde" && ebitdaLines.length > 0 && sdeLines.length > 0;
  const years = n.years?.length ? n.years : Object.keys(n.netIncome ?? {}).sort();
  const total = (base: Record<string, number>, rows: UiAddback[]) => {
    const out: Record<string, number> = {};
    for (const y of years) {
      if (typeof base[y] !== "number") continue;
      out[y] = base[y] + sum(rows.map((r) => r.amounts?.[y] ?? 0));
    }
    return out;
  };
  const adjusted = total(n.netIncome ?? {}, applies);
  const line = (a: UiAddback): CimBridgeLine => ({ label: a.label, amounts: { ...a.amounts } });
  return {
    metric,
    years,
    netIncome: { ...(n.netIncome ?? {}) },
    addbacks: applies.map(line),
    adjusted,
    // Same arithmetic as the analysis's stored canonical figures
    // (normalization-rules computeCanonicalEarnings): adjusted EBITDA = net
    // income + every approved add-back that isn't SDE-only.
    adjustedEbitda: split ? total(n.netIncome ?? {}, ebitdaLines) : null,
    ebitdaLineCount: split ? ebitdaLines.length : undefined,
    sdeOnly: sdeOnly.map(line),
    sde: sdeOnly.length > 0 ? total(adjusted, sdeOnly) : null,
  } as CimFinancials["bridge"];
}

/** The analysis → CIM financials, every total computed here. Null when it has nothing usable. */
export function buildCimFinancials(analysis: AnalysisLike | null | undefined): CimFinancials | null {
  if (!analysis) return null;
  const row = normalizeFinancialAnalysisRow({ ...(analysis as Record<string, unknown>) }) as Record<string, any>;
  const table = row.reclassifiedPnl as UiReclassifiedTable | null;
  const norm = row.normalization as UiNormalization | null;
  const hasTable = !!table && Array.isArray(table.rows) && table.rows.length > 0 && Array.isArray(table.years);
  const hasNorm = !!norm && Array.isArray(norm.addbacks);
  const wc = row.workingCapital as UiWorkingCapital | null;
  const hasWc = !!wc && (Array.isArray(wc.currentAssets) || Array.isArray(wc.currentLiabilities));
  if (!hasTable && !hasNorm && !hasWc) return null;
  const pnl = hasTable ? pnlByYear(table!, norm?.netIncome ?? {}) : null;
  const years = Array.from(new Set([...(hasTable ? table!.years : []), ...(hasNorm ? norm!.years ?? [] : [])])).sort();
  return {
    analysisId: String(analysis.id),
    version: analysis.version ?? 1,
    reviewed: analysis.status === "reviewed" || !!analysis.brokerReviewedAt,
    years,
    pnl: pnl && Object.keys(pnl).length > 0 ? pnl : null,
    lines: hasTable
      ? table!.rows
          .filter((r) => r.category !== "Excluded")
          .map((r) => ({ category: r.category, name: r.name, values: { ...r.values } }))
      : [],
    bridge: hasNorm ? bridgeOf(norm!) : null,
    workingCapital: hasWc ? wc : null,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────

/** "$1,234,567" / "($78,000)" — exact dollars, the form every section copies. */
export function money(n: number): string {
  const s = `$${Math.round(Math.abs(n)).toLocaleString("en-US")}`;
  return n < 0 ? `(${s})` : s;
}

function pct(part: number, whole: number): string | null {
  if (!whole) return null;
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function yearRow(label: string, years: string[], get: (y: string) => number | null | undefined, extra?: (y: string) => string | null): string | null {
  const cells = years.map((y) => {
    const v = get(y);
    if (typeof v !== "number") return null;
    const e = extra?.(y);
    return `${y} ${money(v)}${e ? ` (${e})` : ""}`;
  });
  if (cells.every((c) => c === null)) return null;
  return `${label}: ${cells.filter(Boolean).join(" · ")}`;
}

export const CIM_FINANCIALS_HEADING = "AUTHORITATIVE FINANCIALS";

/**
 * The knowledge-base block. Statement and bridge sections copy these rows
 * and totals verbatim; a figure that isn't here or in the facts is left out.
 */
export function renderCimFinancialsBlock(fin: CimFinancials | null | undefined): string {
  if (!fin) return "";
  const out: string[] = [];
  out.push(
    `--- ${CIM_FINANCIALS_HEADING} (financial analysis v${fin.version}${fin.reviewed ? ", reviewed by the broker" : ""}, built from the uploaded financial statements; every total below is already computed) ---`,
  );
  out.push(
    "Use these for every financial table, EBITDA/SDE bridge (waterfall), earnings chart and statement figure. Copy line names, amounts and totals exactly. Never add, subtract, estimate or re-derive a figure, and never add a year or line that is not listed. Where a statement figure differs from a fact elsewhere in the knowledge base, these statement figures win inside tables and bridges.",
  );
  const pnl = fin.pnl;
  if (pnl) {
    const years = Object.keys(pnl).sort();
    out.push(`\nINCOME STATEMENT SUMMARY (fiscal years ${years.join(", ")}):`);
    const hasNonRecurring = years.some((y) => pnl[y].nonRecurring > 0);
    const rows = [
      yearRow("Revenue", years, (y) => pnl[y].revenue, (y) => {
        const i = years.indexOf(y);
        return i > 0 ? `${pnl[years[i - 1]].revenue ? ((pnl[y].revenue / pnl[years[i - 1]].revenue - 1) * 100).toFixed(1) : "?"}% vs prior year` : null;
      }),
      yearRow("Cost of sales / direct costs", years, (y) => pnl[y].cogs),
      yearRow("Gross profit", years, (y) => pnl[y].grossProfit, (y) => (pnl[y].grossProfit === null ? null : `${pct(pnl[y].grossProfit!, pnl[y].revenue)} gross margin`)),
      yearRow(
        hasNonRecurring
          ? "Operating expenses (recurring, incl. owner compensation; the one-time items below are NOT in this total)"
          : "Operating expenses (incl. owner compensation)",
        years,
        (y) => pnl[y].operatingExpenses,
      ),
      yearRow("  of which owner compensation", years, (y) => (pnl[y].ownerCompensation ? pnl[y].ownerCompensation : null)),
      yearRow("One-time / non-recurring expenses", years, (y) => (pnl[y].nonRecurring ? pnl[y].nonRecurring : null)),
      // One grouped total, so a table that folds the one-time items into its
      // expenses has a real figure to print instead of summing its own.
      hasNonRecurring
        ? yearRow("Total operating expenses incl. one-time items", years, (y) => pnl[y].operatingExpenses + pnl[y].nonRecurring)
        : null,
      yearRow(
        hasNonRecurring
          ? "EBITDA before other income (as reported, unadjusted; = gross profit − operating expenses − one-time items)"
          : "EBITDA before other income (as reported, unadjusted; = gross profit − operating expenses)",
        years,
        (y) => pnl[y].ebitda,
        (y) => `${pct(pnl[y].ebitda, pnl[y].revenue)} margin`,
      ),
      yearRow("Other income", years, (y) => (pnl[y].otherIncome ? pnl[y].otherIncome : null)),
      yearRow("Other expense", years, (y) => (pnl[y].otherExpense ? pnl[y].otherExpense : null)),
      yearRow("Depreciation & amortization", years, (y) => (pnl[y].depreciation ? pnl[y].depreciation : null)),
      yearRow("Interest", years, (y) => (pnl[y].interest ? pnl[y].interest : null)),
      yearRow("Income taxes", years, (y) => (pnl[y].taxes ? pnl[y].taxes : null)),
      yearRow("Net income (as reported)", years, (y) => pnl[y].netIncomeReported ?? pnl[y].netIncomeFromRows),
    ].filter(Boolean) as string[];
    out.push(...rows);
    const untied = years.filter((y) => {
      const r = pnl[y].netIncomeReported;
      const c = pnl[y].netIncomeFromRows;
      return typeof r === "number" && typeof c === "number" && Math.abs(r - c) > Math.max(100, Math.abs(r) * 0.005);
    });
    if (untied.length > 0) {
      out.push(`Note: the statement rows do not tie to reported net income for ${untied.join(", ")}. Show the reported net income; do not print a net income you work out from the rows.`);
    }
    if (fin.lines.length > 0) {
      out.push("\nSTATEMENT LINE ITEMS (as reclassified):");
      for (const l of fin.lines) {
        const cells = years.filter((y) => typeof l.values[y] === "number").map((y) => `${y} ${money(Math.abs(l.values[y]))}`);
        if (cells.length) out.push(`[${l.category}] ${l.name}: ${cells.join(" · ")}`);
      }
    }
  }

  const b = fin.bridge;
  if (b && Object.keys(b.netIncome).length > 0) {
    const years = b.years.filter((y) => typeof b.netIncome[y] === "number");
    const label = b.metric === "ebitda" ? "Adjusted EBITDA" : "SDE";
    out.push(`\n${label.toUpperCase()} BRIDGE (normalization — the broker-approved add-backs; a waterfall starts at net income, applies each line in this order and ends at the total, which is already computed):`);
    out.push(yearRow("Net income (start)", years, (y) => b.netIncome[y]) ?? "");
    b.addbacks.forEach((a, i) => {
      if (b.adjustedEbitda && i === b.ebitdaLineCount) {
        out.push(yearRow("= Adjusted EBITDA (subtotal; the lines below are SDE-only — the owner's market salary)", years, (y) => b.adjustedEbitda![y]) ?? "");
      }
      const r = yearRow(`${a.label}`, years, (y) => (typeof a.amounts[y] === "number" ? a.amounts[y] : 0));
      if (r) out.push(`+ ${r}`);
    });
    out.push(yearRow(`= ${label} (total)`, years, (y) => b.adjusted[y]) ?? "");
    out.push("Negative amounts are deductions (shown in parentheses). Only the lines above are add-backs; never add another, change an amount, or plug a line to reach a different total.");
    if (b.sde && b.sdeOnly.length > 0) {
      out.push(`Owner-specific add-backs (SDE only — NOT part of ${label}):`);
      for (const a of b.sdeOnly) {
        const r = yearRow(a.label, years, (y) => (typeof a.amounts[y] === "number" ? a.amounts[y] : 0));
        if (r) out.push(`+ ${r}`);
      }
      out.push(yearRow("= SDE (Adjusted EBITDA + owner-specific add-backs)", years, (y) => b.sde![y]) ?? "");
    }
  }

  const wc = fin.workingCapital;
  if (wc) {
    out.push(`\nWORKING CAPITAL${wc.asOfPeriod ? ` (as of ${wc.asOfPeriod})` : ""}:`);
    for (const i of wc.currentAssets ?? []) out.push(`Current asset — ${i.name}: ${money(i.amount)}`);
    for (const i of wc.currentLiabilities ?? []) out.push(`Current liability — ${i.name}: ${money(i.amount)}`);
    if (typeof wc.netWorkingCapital === "number") out.push(`Net working capital: ${money(wc.netWorkingCapital)}`);
    const history = Object.entries(wc.history ?? {});
    if (history.length > 1) out.push(`Year-end net working capital: ${history.map(([y, v]) => `${y} ${money(v)}`).join(" · ")}`);
    if (typeof wc.pegAmount === "number") out.push(`Working capital peg (target): ${money(wc.pegAmount)}${wc.pegBasis ? ` — ${wc.pegBasis}` : ""}`);
  }
  return out.filter((l) => l !== "").join("\n");
}

/** The bridge year by year, for the figure check's waterfall test (figure-check KnownBridge). */
export function knownBridges(fin: CimFinancials | null | undefined): Array<{ year: string; label: string; start: number; steps: number[]; totals: number[] }> {
  const b = fin?.bridge;
  if (!b) return [];
  const label = b.metric === "ebitda" ? "Adjusted EBITDA" : "SDE";
  return b.years
    .filter((y) => typeof b.netIncome[y] === "number" && typeof b.adjusted[y] === "number")
    .map((y) => ({
      year: y,
      label,
      start: b.netIncome[y],
      steps: [...b.addbacks, ...b.sdeOnly].map((a) => a.amounts?.[y] ?? 0).filter((x) => x !== 0),
      totals: [
        b.adjusted[y],
        ...(b.sde && typeof b.sde[y] === "number" ? [b.sde[y]] : []),
        ...(b.adjustedEbitda && typeof b.adjustedEbitda[y] === "number" ? [b.adjustedEbitda[y]] : []),
      ],
    }));
}

/**
 * Headline figures from the analysis, for the conflict check against the
 * facts' canonical figures: latest-year revenue and the adjusted metric.
 */
export function analysisHeadlines(fin: CimFinancials | null | undefined): Array<{ label: "Revenue" | "EBITDA" | "SDE"; year: string; value: number }> {
  if (!fin) return [];
  const out: Array<{ label: "Revenue" | "EBITDA" | "SDE"; year: string; value: number }> = [];
  if (fin.pnl) {
    const y = Object.keys(fin.pnl).sort().pop();
    if (y) out.push({ label: "Revenue", year: y, value: fin.pnl[y].revenue });
  }
  const b = fin.bridge;
  if (b) {
    const y = Object.keys(b.adjusted).sort().pop();
    if (y) out.push({ label: b.metric === "ebitda" ? "EBITDA" : "SDE", year: y, value: b.adjusted[y] });
    if (b.adjustedEbitda) {
      const ye = Object.keys(b.adjustedEbitda).sort().pop();
      if (ye) out.push({ label: "EBITDA", year: ye, value: b.adjustedEbitda[ye] });
    }
    if (b.sde) {
      const ys = Object.keys(b.sde).sort().pop();
      if (ys) out.push({ label: "SDE", year: ys, value: b.sde[ys] });
    }
  }
  return out;
}
