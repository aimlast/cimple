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
  /** EBITDA before other income + other income − other expense − D&A − interest. */
  incomeBeforeTaxes: number;
  /** Net income as the statement rows compute it. */
  netIncomeFromRows: number | null;
  /** Net income as reported (the normalization's starting point). */
  netIncomeReported: number | null;
  /**
   * The rows didn't tie to reported net income, so operating expenses and
   * EBITDA were restated from reported net income (see restateFromReported).
   * `gap` = row EBITDA − restated EBITDA.
   */
  restated?: { gap: number; rowEbitda: number; rowOperatingExpenses: number; likelyCause: string | null };
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
    const rowsOf = (c: string) => table.rows.filter((r) => r.category === c && typeof r.values?.[year] === "number");
    const cat = (c: string) => {
      const vals = rowsOf(c).map((r) => r.values[year]);
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
    const dep = cat("Depreciation"), interest = cat("Interest"), taxes = cat("Taxes");
    const p: CimPnlYear = {
      revenue: revenue.total,
      cogs: cogsAbs,
      grossProfit: cogsAbs === null ? null : revenue.total - cogsAbs,
      operatingExpenses,
      ownerCompensation: abs(owner),
      nonRecurring: abs(nonRec),
      ebitda: revenue.total - (cogsAbs ?? 0) - operatingExpenses - abs(nonRec),
      otherIncome: cat("Other Income").total,
      otherExpense: abs(cat("Other Expense")),
      depreciation: abs(dep),
      interest: abs(interest),
      taxes: abs(taxes),
      incomeBeforeTaxes: 0,
      netIncomeFromRows: typeof computedNi[year] === "number" ? computedNi[year] : null,
      netIncomeReported: typeof reported[year] === "number" ? reported[year] : null,
    };
    // Below-the-line rows are on the analysis: the chain down to net income
    // can be stated, and restated from the reported figure when the rows
    // don't reach it.
    if (dep.has || interest.has || taxes.has) {
      restateFromReported(p, rowsOf("Non-Recurring").map((r) => ({ name: r.name, amount: Math.abs(r.values[year]) })));
    }
    p.incomeBeforeTaxes = p.ebitda + p.otherIncome - p.otherExpense - p.depreciation - p.interest;
    out[year] = p;
  }
  return out;
}

/**
 * Reported net income is the statements' own bottom line (it ties to the tax
 * return); the analysis's expense rows are a reclassification of them. When
 * the rows don't reach the reported figure, the difference is in the
 * expenses — a carve-out taken out of its parent line twice (Pacific FY2024:
 * "TMS migration consultants" $72,000 moved to one-time AND cut from the IT
 * line, so row EBITDA was $3,619,200 while the statements' operating income
 * is $3,547,200). The year is then restated from the reported figure:
 * EBITDA = net income + taxes + interest + D&A + other expense − other income,
 * and operating expenses = what's left of gross profit. Every row of the
 * printed chain then ties, and the broker is told why.
 */
function restateFromReported(p: CimPnlYear, oneTime: Array<{ name: string; amount: number }>): void {
  if (p.netIncomeReported === null || p.netIncomeFromRows === null) return;
  const tol = Math.max(100, Math.abs(p.netIncomeReported) * 0.005);
  if (Math.abs(p.netIncomeFromRows - p.netIncomeReported) <= tol) return;
  const ebitda = p.netIncomeReported + p.taxes + p.interest + p.depreciation + p.otherExpense - p.otherIncome;
  const gap = p.ebitda - ebitda;
  // Which one-time items add up to the gap (the likely double carve-out)?
  let likelyCause: string | null = null;
  const n = Math.min(oneTime.length, 10);
  for (let mask = 1; mask < 1 << n && !likelyCause; mask++) {
    const picked = oneTime.filter((_, i) => mask & (1 << i));
    if (Math.abs(sum(picked.map((x) => x.amount)) - Math.abs(gap)) <= tol) {
      likelyCause = picked.map((x) => `${x.name} (${money(x.amount)})`).join(" and ");
    }
  }
  // Only a gap the one-time items explain is known to sit in the expenses.
  // Any other gap could be anywhere (a missing other-income row, a tax
  // figure): the rows are left as they are and the year is flagged untied
  // (Lakeshore: the rows' $917,000 IS the statements' reported EBITDA).
  if (!likelyCause) return;
  p.restated = { gap, rowEbitda: p.ebitda, rowOperatingExpenses: p.operatingExpenses, likelyCause };
  p.operatingExpenses = p.operatingExpenses + gap;
  p.ebitda = ebitda;
  p.netIncomeFromRows = p.netIncomeReported;
}

function bridgeOf(n: UiNormalization) {
  const metric = n.metric === "ebitda" ? "ebitda" : "sde";
  const approved = (n.addbacks ?? []).filter((a: UiAddback) => a.approved);
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
    const hasBelowTheLine = years.some((y) => pnl[y].depreciation || pnl[y].interest || pnl[y].taxes);
    const untied = untiedYears(fin);
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
      hasBelowTheLine
        ? yearRow("Income before income taxes (= EBITDA before other income + other income − other expense − D&A − interest)", years, (y) => (untied.includes(y) ? null : pnl[y].incomeBeforeTaxes))
        : null,
      yearRow("Income taxes", years, (y) => (pnl[y].taxes ? pnl[y].taxes : null)),
      yearRow("Net income (as reported)", years, (y) => pnl[y].netIncomeReported ?? pnl[y].netIncomeFromRows),
    ].filter(Boolean) as string[];
    out.push(...rows);
    if (hasBelowTheLine) {
      out.push(
        "A statement table that shows EBITDA and net income prints EVERY row between them in this order — other income, other expense, depreciation & amortization, interest, income before income taxes, income taxes — so each year adds up. Never leave out the other-income row.",
      );
    }
    const restated = years.filter((y) => pnl[y].restated);
    if (restated.length > 0) {
      out.push(
        `Note: for ${restated.join(", ")} the operating expenses and EBITDA above are stated from the reported net income (the analysis's expense lines don't add up to it). Use these totals; do not list individual expense lines for ${restated.join(", ")}.`,
      );
    }
    if (untied.length > 0) {
      out.push(
        `Note: for ${untied.join(", ")} the statement rows do not reach the reported net income, so the rows below EBITDA can't be shown as adding up. In a statement table, leave every ${untied.join(", ")} cell below EBITDA empty (net income included); never print a figure worked out from the rows.`,
      );
    }
    if (fin.lines.length > 0) {
      out.push("\nSTATEMENT LINE ITEMS (as reclassified):");
      // A restated year's expense lines don't sum to its restated total.
      const EXPENSE_CATS = new Set(["Operating Expenses", "Owner Compensation"]);
      for (const l of fin.lines) {
        const cells = years
          .filter((y) => typeof l.values[y] === "number" && !(pnl[y].restated && EXPENSE_CATS.has(l.category)))
          .map((y) => `${y} ${money(Math.abs(l.values[y]))}`);
        if (cells.length) out.push(`[${l.category}] ${l.name}: ${cells.join(" · ")}`);
      }
    }
    const growth = cimGrowth(fin);
    if (growth.length > 0) {
      out.push("\nGROWTH (computed from the rows above — a growth rate is quoted only with exactly this period; a two-year change is never \"year-over-year\"):");
      const byLabel = new Map<string, string[]>();
      for (const g of growth) {
        const cells = byLabel.get(g.label) ?? [];
        cells.push(`${g.from}→${g.to} ${g.pct >= 0 ? "+" : ""}${g.pct.toFixed(1)}%`);
        byLabel.set(g.label, cells);
      }
      for (const [label, cells] of Array.from(byLabel)) out.push(`${label}: ${cells.join(" · ")}`);
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
    if (typeof wc.pegAmount === "number") out.push(`Working capital peg (target): ${money(wc.pegAmount)}`);
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

export interface CimGrowth {
  /** "Revenue", a revenue line's name, "Adjusted EBITDA". */
  label: string;
  from: string;
  to: string;
  /** Percent change, e.g. 35.5. */
  pct: number;
}

/**
 * Growth the CIM may quote, each with its exact period: year over year and
 * first year → last year, for revenue, each revenue line and the adjusted
 * metric. A writer reading "35% warehouse growth" in a fact can see it is
 * FY2022→FY2024 (Pacific 2026-09-26 printed it as "year-over-year in FY2024").
 */
export function cimGrowth(fin: CimFinancials | null | undefined): CimGrowth[] {
  if (!fin) return [];
  const out: CimGrowth[] = [];
  const series = (label: string, values: Record<string, number>) => {
    const ys = Object.keys(values).filter((y) => typeof values[y] === "number" && values[y] > 0).sort();
    const add = (a: string, b: string) => out.push({ label, from: a, to: b, pct: (values[b] / values[a] - 1) * 100 });
    for (let i = 1; i < ys.length; i++) add(ys[i - 1], ys[i]);
    if (ys.length > 2) add(ys[0], ys[ys.length - 1]);
  };
  if (fin.pnl) {
    series("Revenue", Object.fromEntries(Object.entries(fin.pnl).map(([y, p]) => [y, p.revenue])));
    const lines = fin.lines.filter((l) => l.category === "Revenue");
    if (lines.length > 1) for (const l of lines) series(l.name, l.values);
  }
  const b = fin.bridge;
  if (b) {
    const adj = b.metric === "ebitda" ? b.adjusted : b.adjustedEbitda ?? null;
    if (adj) series("Adjusted EBITDA", adj);
    const sde = b.metric === "sde" ? b.adjusted : b.sde;
    if (sde) series("SDE", sde);
  }
  return out;
}

/** Years whose rows still don't reach the reported net income (a gap nothing explains). */
export function untiedYears(fin: CimFinancials | null | undefined): string[] {
  const pnl = fin?.pnl;
  if (!pnl) return [];
  return Object.keys(pnl)
    .sort()
    .filter((y) => {
      const r = pnl[y].netIncomeReported;
      const c = pnl[y].netIncomeFromRows;
      return typeof r === "number" && typeof c === "number" && Math.abs(r - c) > Math.max(100, Math.abs(r) * 0.005);
    });
}

/**
 * Broker warnings about the analysis rows: years restated from reported net
 * income (restateFromReported) and years that don't tie at all.
 */
export function restatementWarnings(fin: CimFinancials | null | undefined): string[] {
  const pnl = fin?.pnl;
  if (!pnl) return [];
  const untied = untiedYears(fin).map((y) => {
    const gap = (pnl[y].netIncomeFromRows ?? 0) - (pnl[y].netIncomeReported ?? 0);
    return `Financial analysis, ${y}: the Income Statement lines give net income of ${money(pnl[y].netIncomeFromRows ?? 0)}, but the reported net income is ${money(pnl[y].netIncomeReported ?? 0)} (${money(Math.abs(gap))} apart). The CIM's statement table shows ${y} only down to EBITDA. Correct the Income Statement on the Financials tab so it ties.`;
  });
  return Object.keys(pnl)
    .sort()
    .filter((y) => pnl[y].restated)
    .map((y) => {
      const r = pnl[y].restated!;
      const cause = r.likelyCause ? ` — most likely ${r.likelyCause} was taken out of its original expense line as well as listed as one-time` : "";
      return `Financial analysis, ${y}: the expense lines add up to EBITDA of ${money(r.rowEbitda)}, but the reported net income gives ${money(pnl[y].ebitda)} (a ${money(Math.abs(r.gap))} difference${cause}). The CIM states ${y} from the reported net income so every table adds up. Correct the Income Statement on the Financials tab to make the lines match.`;
    })
    .concat(untied);
}
